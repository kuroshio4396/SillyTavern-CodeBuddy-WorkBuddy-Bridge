'use strict';
/**
 * 认证网络流程（移植自 dsh-codearts-auth 的 lib/buddy-oauth.js）。
 *
 * 轮询式登录：fetchAuthState → 用户浏览器授权 → 轮询 token → 轮询 account。
 * 不起本地回调服务器 —— 这也是它能塞进 SillyTavern 插件的原因。
 */
const crypto = require('node:crypto');

const {
    AUTH_STATE_PATH,
    AUTH_TOKEN_PATH,
    LOGIN_ACCOUNT_PATH,
    AUTH_REFRESH_PATH,
    CONFIG_PATH,
    ENTERPRISE_MODELS_SCOPE,
    LOGIN_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    STATE_REQUEST_TIMEOUT_MS,
    REQUEST_TIMEOUT_MS,
    CODE_TOKEN_NOT_READY,
    CODE_ACCOUNT_NOT_READY,
    HTTP_HEADER_DOMAIN,
    HTTP_HEADER_NO_AUTHORIZATION,
    HTTP_HEADER_NO_USER_ID,
    HTTP_HEADER_NO_ENTERPRISE_ID,
    HTTP_HEADER_NO_DEPARTMENT_INFO,
    HTTP_HEADER_REFRESH_TOKEN,
    HTTP_HEADER_AUTH_REFRESH_SOURCE,
    HTTP_HEADER_PRODUCT,
    HTTP_HEADER_PRODUCT_CODE,
    AUTH_REFRESH_SOURCE,
    REFRESH_LEAD_MS,
    REFRESH_RETRY_MS,
    REFRESH_ABNORMAL_NETWORK_RETRY_MS,
    CODEBUDDY,
} = require('./product');

const http = require('node:http');
const https = require('node:https');

const {
    buildCredential,
    credentialRequestHeaders,
    credentialAuthHeaders,
    isRefreshable,
    parseAccountData,
    parseModelsFromConfig,
    parseTokenData,
} = require('./buddy');

/** refresh_token 已失效/被拒绝时抛出；调度器据此停止续期。 */
class RefreshTokenExpiredError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RefreshTokenExpiredError';
    }
}

/** HTTP 状态码 → 语义化英文短句（原插件把中文"网络异常"加在末尾，这里拆分干净）。 */
function responseCode(body) {
    if (typeof body !== 'object' || body === null) return 0;
    return typeof body.code === 'number' ? body.code : 0;
}

function responseMessage(body) {
    if (typeof body !== 'object' || body === null) return '';
    return typeof body.message === 'string' ? body.message : '';
}

function responseData(body) {
    if (typeof body !== 'object' || body === null) return undefined;
    const data = body.data;
    return data === null ? undefined : data;
}

/**
 * 发起一次控制面请求，返回 { status, body }。网络失败抛出。
 *
 * 用 node:http/https 而非 fetch：为了给每次请求精确的超时与 abort，
 * 并且避免 ST 进程里可能存在的全局 fetch 拦截/代理设置影响。
 *
 * `body` 可省略。计费端点是 `POST` + 空 JSON 体（`{}`），此时必须带
 * `Content-Length`，否则部分网关会挂起等 body。
 */
function rawRequest(method, url, headers, timeoutMs, body) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            reject(new Error(`非法 URL: ${url}`));
            return;
        }
        let payload;
        if (body !== undefined && body !== null) {
            const text = typeof body === 'string' ? body : JSON.stringify(body);
            payload = Buffer.from(text, 'utf8');
        }
        const finalHeaders = { ...headers };
        if (payload) {
            finalHeaders['Content-Length'] = String(payload.length);
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            method,
            headers: finalHeaders,
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let body = null;
                try {
                    body = JSON.parse(text);
                } catch {
                    body = null;
                }
                resolve({ status: res.statusCode || 0, body, text });
            });
            res.on('error', reject);
        });
        req.on('timeout', () => {
            req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** 等待指定的毫秒数（unref 以免拖住 ST 进程退出）。 */
function sleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

/**
 * POST /v2/plugin/auth/state?platform=<product.platform> → { state, authUrl }
 * 无需认证。
 */
async function fetchAuthState(product = CODEBUDDY, options = {}) {
    const url = `${product.endpoint}${AUTH_STATE_PATH}?platform=${product.platform}`;
    const headers = {
        [HTTP_HEADER_DOMAIN]: product.apiDomain,
        [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
        [HTTP_HEADER_NO_USER_ID]: 'true',
        [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
        [HTTP_HEADER_NO_DEPARTMENT_INFO]: 'true',
        'User-Agent': product.userAgent,
    };
    const { status, body } = await rawRequest('POST', url, headers, options.timeoutMs ?? STATE_REQUEST_TIMEOUT_MS);
    if (status !== 200) {
        throw new Error(`auth/state HTTP ${status}: ${responseMessage(body)}`);
    }
    const data = responseData(body);
    if (typeof data !== 'object' || data === null) {
        throw new Error(`auth/state 响应缺少 data 字段: ${JSON.stringify(body)}`);
    }
    const state = typeof data.state === 'string' ? data.state : '';
    const authUrl = typeof data.authUrl === 'string' ? data.authUrl : '';
    if (state.length === 0) throw new Error('auth/state 响应缺少 state 字段');
    if (authUrl.length === 0) throw new Error('auth/state 响应缺少 authUrl 字段');
    return { state, authUrl };
}

/**
 * GET /v2/plugin/auth/token?state=... 轮询获取 token。
 * 错误码 11217 = 未就绪 → 继续轮询；网络错误同样继续，不中断登录流程。
 */
async function loopGetToken(state, options = {}) {
    const product = options.product ?? CODEBUDDY;
    const url = `${product.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`;
    const headers = {
        [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
        'User-Agent': product.userAgent,
    };
    const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    for (;;) {
        if (Date.now() >= deadline) throw new Error('获取 token 超时（5 分钟）');
        if (options.isCancelled?.()) throw new Error('登录已取消');
        await sleep(interval);
        let result;
        try {
            result = await rawRequest('GET', url, headers, REQUEST_TIMEOUT_MS);
        } catch {
            continue;
        }
        const { status, body } = result;
        if (status === 200) {
            const data = responseData(body);
            if (data !== undefined) return parseTokenData(data);
            continue;
        }
        const code = responseCode(body);
        if (code === CODE_TOKEN_NOT_READY) continue;
        throw new Error(`auth/token HTTP ${status} code=${code}: ${responseMessage(body)}`);
    }
}

/** GET /v2/plugin/login/account?state=... 轮询获取账户信息（需 Bearer token）。 */
async function getAccount(state, token, options = {}) {
    const product = options.product ?? CODEBUDDY;
    const url = `${product.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`;
    const headers = {
        [HTTP_HEADER_DOMAIN]: token.domain || product.apiDomain,
        Authorization: `Bearer ${token.accessToken}`,
        [HTTP_HEADER_NO_USER_ID]: 'true',
        [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
        'User-Agent': product.userAgent,
    };
    const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    for (;;) {
        if (Date.now() >= deadline) throw new Error('获取账户信息超时（5 分钟）');
        if (options.isCancelled?.()) throw new Error('登录已取消');
        await sleep(interval);
        let result;
        try {
            result = await rawRequest('GET', url, headers, REQUEST_TIMEOUT_MS);
        } catch {
            continue;
        }
        const { status, body } = result;
        if (status === 200) {
            const data = responseData(body);
            if (data !== undefined) return parseAccountData(data);
            continue;
        }
        const code = responseCode(body);
        if (code === CODE_ACCOUNT_NOT_READY) continue;
        throw new Error(`login/account HTTP ${status} code=${code}: ${responseMessage(body)}`);
    }
}

/**
 * POST /v2/plugin/auth/token/refresh 静默续期。
 * refresh_token 走 `X-Refresh-Token` 头（不是 body）。
 */
async function refreshToken(credential, product = CODEBUDDY) {
    if (!isRefreshable(credential)) {
        throw new RefreshTokenExpiredError('无 refresh_token，请重新登录');
    }
    const url = `${product.endpoint}${AUTH_REFRESH_PATH}`;
    const headers = {
        ...credentialRequestHeaders(credential, product),
        [HTTP_HEADER_DOMAIN]: product.apiDomain,
        'User-Agent': product.userAgent,
        Authorization: `Bearer ${credential.access_token}`,
        [HTTP_HEADER_REFRESH_TOKEN]: credential.refresh_token,
        [HTTP_HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
    };
    const { status, body } = await rawRequest('POST', url, headers, REQUEST_TIMEOUT_MS);
    if (status !== 200) {
        const code = responseCode(body);
        const message = responseMessage(body);
        // 终态判定：HTTP/业务码 401/403，或 message 明确 expired/invalid。
        // 不做终态判定就会让失效凭据被无限重试。
        const expired = status === 401 || status === 403 || code === 401 || code === 403
            || message.includes('expired') || message.includes('invalid');
        if (expired) {
            throw new RefreshTokenExpiredError(message.length > 0 ? message : `HTTP ${status}`);
        }
        throw new Error(`刷新 token HTTP ${status} code=${code}: ${message}`);
    }
    const data = responseData(body);
    if (data === undefined) throw new Error('刷新 token 响应缺少 data 字段');
    return parseTokenData(data);
}

/** 构造模型请求头（三处复用：企业端点、/v3/config、断言）。 */
function modelsRequestHeaders(credential, product) {
    return {
        ...credentialAuthHeaders(credential, product),
        [HTTP_HEADER_DOMAIN]: product.apiDomain,
        'User-Agent': product.userAgent,
        // X-Product 是**归属名**，不是部署类型 —— 历史实现发成 SaaS 导致后台归因不到产品。
        [HTTP_HEADER_PRODUCT]: product.attributionName,
        [HTTP_HEADER_PRODUCT_CODE]: product.productCode,
    };
}

/** 拉取企业模型端点；成功且解析出模型时返回列表，否则返回 undefined（交给上层回退）。 */
async function requestScopedModels(credential, product) {
    const url = `${product.endpoint}/console/enterprises/${ENTERPRISE_MODELS_SCOPE}/models`;
    try {
        const { status, body } = await rawRequest('GET', url, modelsRequestHeaders(credential, product), REQUEST_TIMEOUT_MS);
        if (status !== 200) return undefined;
        const models = parseModelsFromConfig(body);
        // 空列表视为「该端点不可用于本账号」，让上层回退，避免一次空响应就清空选择器。
        return models.length > 0 ? models : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 拉取远端模型目录：企业端点 → /v3/config → []（由调用方回退内置表）。
 * 三层回退保证任何一层可用都能给出模型列表。
 */
async function fetchRemoteModels(credential, product = CODEBUDDY) {
    if (!credential || credential.access_token.length === 0) return [];
    const scoped = await requestScopedModels(credential, product);
    if (scoped !== undefined) return scoped;
    try {
        const { status, body } = await rawRequest('GET', `${product.endpoint}${CONFIG_PATH}`, modelsRequestHeaders(credential, product), REQUEST_TIMEOUT_MS);
        if (status !== 200) return [];
        return parseModelsFromConfig(body);
    } catch {
        return [];
    }
}

/**
 * 为 WorkBuddy 的登录 URL 追加 version 与 loginSessionId。
 * 只追加参数，不重建 URL —— platform/state/路径全部来自服务端下发的 authUrl。
 */
function decorateLoginUrl(authUrl, product) {
    if (!product.appendSessionParams) return authUrl;
    try {
        const url = new URL(authUrl);
        if (product.pluginVersion !== undefined && product.pluginVersion.length > 0) {
            url.searchParams.set('version', product.pluginVersion);
        }
        url.searchParams.set('loginSessionId', crypto.randomUUID());
        return url.toString();
    } catch {
        return authUrl;
    }
}

/**
 * 完整登录流程（不含浏览器打开 —— 由 ST 前端 window.open 完成）。
 * 返回 { credential, expires, loginUrl, refreshable }。
 */
async function runLoginFlow(state, options = {}) {
    const product = options.product ?? CODEBUDDY;
    const pollOptions = {
        product,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        isCancelled: options.isCancelled,
    };
    const token = await loopGetToken(state, pollOptions);
    const account = await getAccount(state, token, pollOptions);
    const credential = buildCredential(token, account);
    return { credential };
}

// ── 续期调度 ──

/** 判定是否为「异常网络」类错误（对齐原插件的 isAbnormalNetwork）。 */
function isAbnormalNetworkError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|proxy|unresolved host|getaddrinfo|socket hang up|timeout|超时/i.test(message);
}

/** 判定 refresh_token 是否已失效（终态）：结构化判定而非 instanceof，避免跨模块 identity 不同。 */
function isRefreshTokenExpired(error) {
    if (!(error instanceof Error)) return false;
    if (error.name === 'RefreshTokenExpiredError') return true;
    return /refresh[_ ]?token/i.test(error.message);
}

/**
 * 计算首次刷新触发前的毫秒数（对齐原插件 getFirstRefreshTime）：
 * 无有效过期时间或距过期 ≤1h → 0（立即刷新）；否则触发点 = now + 1h，再叠加 0-59 秒随机偏移。
 */
function computeFirstRefreshDelayMs(expiresAtMs, nowMs = Date.now(), leadMs = REFRESH_LEAD_MS) {
    if (!Number.isFinite(expiresAtMs)) return 0;
    const leadTrigger = nowMs + leadMs;
    if (leadTrigger >= expiresAtMs) return 0;
    const trigger = new Date(leadTrigger);
    trigger.setSeconds(Math.floor(60 * Math.random()));
    const delay = trigger.getTime() - nowMs;
    return delay > 0 ? delay : 0;
}

/**
 * 静默刷新调度器：一次触发 + 失败重试（refresh_token 失效则停止）。
 *
 * generation 代号：stop()/arm() 都会推进它，让在途 run() 失败后放弃重试武装，
 * 避免登出后调度器「复活」。
 */
class RefreshScheduler {
    constructor(refreshFn, onError = () => { }) {
        this.refreshFn = refreshFn;
        this.onError = onError;
        this.timer = undefined;
        this.pending = false;
        this.generation = 0;
    }

    arm(expiresAtMs, nowMs = Date.now()) {
        this.generation++;
        this.clearTimer();
        const delay = computeFirstRefreshDelayMs(expiresAtMs, nowMs);
        this.timer = setTimeout(() => { void this.run(); }, delay);
        this.timer.unref?.();
        return delay;
    }

    clearTimer() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    stop() {
        this.generation++;
        this.clearTimer();
    }

    async refreshNow() {
        this.stop();
        await this.run();
    }

    async run() {
        if (this.pending) return;
        this.pending = true;
        const generation = this.generation;
        try {
            await this.refreshFn();
        } catch (error) {
            this.onError(error);
            if (generation !== this.generation) return;
            if (isRefreshTokenExpired(error)) return;
            this.clearTimer();
            const retry = isAbnormalNetworkError(error)
                ? REFRESH_ABNORMAL_NETWORK_RETRY_MS
                : REFRESH_RETRY_MS;
            this.timer = setTimeout(() => { void this.run(); }, retry);
            this.timer.unref?.();
        } finally {
            this.pending = false;
        }
    }
}

module.exports = {
    RefreshTokenExpiredError,
    RefreshScheduler,
    fetchAuthState,
    loopGetToken,
    getAccount,
    refreshToken,
    fetchRemoteModels,
    decorateLoginUrl,
    runLoginFlow,
    computeFirstRefreshDelayMs,
    isRefreshTokenExpired,
    isAbnormalNetworkError,
    rawRequest,
    sleep,
};
