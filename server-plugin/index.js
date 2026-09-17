'use strict';
/**
 * cbwb-bridge —— SillyTavern 服务器插件
 *
 * 把 dsh-codearts-auth 的 CodeBuddy / WorkBuddy 渠道能力搬进 SillyTavern：
 *
 *   ┌ SillyTavern 进程 ──────────────────────────────────────────┐
 *   │  /api/plugins/cbwb-bridge/*   管理接口（登录/状态/模型/配置）│
 *   │  127.0.0.1:8791/v1            OpenAI 兼容代理（给 custom 源）│
 *   └────────────────────────────────────────────────────────────┘
 *
 * 代理必须是独立监听：ST 的 CSRF 中间件先于插件挂载注册，而 ST 服务端请求
 * custom_url 时不带 CSRF token，放在 /api/plugins 下会被 403。
 *
 * 数据目录：<dataRoot>/cbwb-bridge/
 *   credentials.json   凭据（独立存放，不碰 ST 的 secrets.json）
 *   config.json        代理端口 / 默认渠道 / 模型黑名单
 */
const fs = require('node:fs');
const path = require('node:path');

const { ALL_PRODUCTS, productById, CODEBUDDY } = require('./lib/product');
const { CredentialStore } = require('./lib/credentials');
const { ConfigStore } = require('./lib/store');
const { ModelCatalog } = require('./lib/models');
const { createProxyServer } = require('./lib/proxy');
const {
    RefreshTokenExpiredError,
    RefreshScheduler,
    fetchAuthState,
    decorateLoginUrl,
    runLoginFlow,
    refreshToken,
    computeFirstRefreshDelayMs,
} = require('./lib/oauth');
const { credentialExpiresAtMs } = require('./lib/buddy');
const {
    fetchCreditBalance,
    fetchCheckinStatus,
    claimDailyCheckin,
} = require('./lib/credits');

const PLUGIN_ID = 'cbwb-bridge';
const PLUGIN_VERSION = '1.1.0';
/** 登录会话最长保留时间（超过即从内存中清理）。 */
const PENDING_LOGIN_TTL_MS = 12 * 60 * 1000;

/** init() 期间装配的清理函数，由 exit() 调用。 */
let teardown = null;

const info = {
    id: PLUGIN_ID,
    name: 'CodeBuddy / WorkBuddy Bridge',
    description: '把 CodeBuddy（腾讯）与 WorkBuddy（国际版）以 OpenAI 兼容端点接入 SillyTavern，支持流式对话与思考内容。',
};

function log(...args) {
    console.log(`[${PLUGIN_ID}]`, ...args);
}
function logError(...args) {
    console.error(`[${PLUGIN_ID}]`, ...args);
}

/** 从 ST 根目录推导 dataRoot（读 config.yaml 的 dataRoot 字段，缺省 ./data）。 */
function resolveDataRoot(stRoot) {
    try {
        const yaml = fs.readFileSync(path.join(stRoot, 'config.yaml'), 'utf8');
        const match = /^\s*dataRoot:\s*(.+)$/m.exec(yaml);
        if (match) {
            const value = match[1].trim().replace(/^["']|["']$/g, '');
            if (value) return path.isAbsolute(value) ? value : path.resolve(stRoot, value);
        }
    } catch {
        // 读不到就用默认值
    }
    return path.join(stRoot, 'data');
}

async function init(router) {
    const pluginDir = __dirname;
    const stRoot = path.resolve(pluginDir, '..', '..');
    const dataDir = process.env.CBWB_BRIDGE_DATA_DIR || path.join(resolveDataRoot(stRoot), PLUGIN_ID);
    fs.mkdirSync(dataDir, { recursive: true });

    log(`数据目录：${dataDir}`);

    // ── 状态容器 ──
    const credentials = new CredentialStore(path.join(dataDir, 'credentials.json'));
    const store = new ConfigStore(path.join(dataDir, 'config.json'));
    const catalog = new ModelCatalog({ credentials, store });

    /** @type {Map<string, {at:number, data:any}>} 积分结果短缓存：channel → 上次查询 */
    const creditsCache = new Map();
    /** @type {Map<string, Promise<any>>} 积分查询并发去重 */
    const creditsInflight = new Map();

    /** @type {Map<string, RefreshScheduler>} */
    const schedulers = new Map();
    /** @type {Set<string>} refresh_token 已失效、需要重新登录的渠道 */
    const needsRelogin = new Set();
    /** @type {Map<string, any>} state → 登录会话 */
    const pendingLogins = new Map();
    /** @type {Map<string, Promise<any>>} 续期去重 */
    const refreshInflight = new Map();
    /** 每个渠道最近一次续期结果，供面板展示 */
    const refreshState = new Map();

    // ── 代理 ──
    const proxy = createProxyServer({
        catalog,
        credentials,
        store,
        refreshCredential: channel => refreshCredential(channel),
    });

    let proxyPort = Number(process.env.CBWB_BRIDGE_PORT) || store.get().proxyPort || 8791;

    // ── 续期 ──

    /**
     * 静默续期一个渠道的凭据（并发去重）。成功后写盘并重新武装调度器。
     * 失败抛错；refresh_token 失效时抛 RefreshTokenExpiredError（终态）。
     */
    function refreshCredential(channel) {
        if (refreshInflight.has(channel)) return refreshInflight.get(channel);

        const task = (async () => {
            const product = productById(channel);
            const current = credentials.get(channel);
            if (!product || !current) throw new RefreshTokenExpiredError(`${channel} 未登录`);

            const token = await refreshToken(current, product);
            const merged = {
                ...current,
                access_token: token.accessToken || current.access_token,
                // 续期响应通常轮换 refresh_token；没给就沿用旧的
                refresh_token: token.refreshToken || current.refresh_token,
                expires_at: token.expiresAt || current.expires_at,
                refresh_expires_at: token.refreshExpiresAt || current.refresh_expires_at,
                domain: token.domain || current.domain,
                token_type: token.type || current.token_type,
            };
            credentials.set(channel, merged);
            needsRelogin.delete(channel);
            refreshState.set(channel, { at: Date.now(), ok: true, error: null });
            log(`渠道 ${channel} 凭据已续期，新到期时间：${new Date(credentialExpiresAtMs(merged) ?? 0).toISOString()}`);
            armScheduler(channel);
            // 续期换号可能让模型池变化，下一轮列表请求自然会重新拉
            return merged;
        })()
            .catch((error) => {
                refreshState.set(channel, { at: Date.now(), ok: false, error: error?.message || String(error) });
                if (error instanceof RefreshTokenExpiredError) {
                    needsRelogin.add(channel);
                    schedulers.get(channel)?.stop();
                    logError(`渠道 ${channel} 的 refresh_token 已失效，已停止自动续期，请重新登录。`);
                }
                throw error;
            })
            .finally(() => {
                refreshInflight.delete(channel);
            });

        refreshInflight.set(channel, task);
        return task;
    }

    /** 为一个渠道武装续期定时器。 */
    function armScheduler(channel) {
        const product = productById(channel);
        const credential = credentials.get(channel);
        if (!product || !credential || needsRelogin.has(channel)) {
            schedulers.get(channel)?.stop();
            return;
        }
        let scheduler = schedulers.get(channel);
        if (!scheduler) {
            scheduler = new RefreshScheduler(
                () => refreshCredential(channel),
                error => logError(`渠道 ${channel} 续期失败：${error?.message || String(error)}`),
            );
            schedulers.set(channel, scheduler);
        }
        const expiresAt = credentialExpiresAtMs(credential);
        const delay = scheduler.arm(expiresAt);
        log(`渠道 ${channel} 续期调度已武装：${Math.round(delay / 1000)} 秒后首次触发（提前 1 小时刷新）`);
    }

    /** 取每个渠道的调度状态（给面板展示）。 */
    function schedulerInfo(channel) {
        const credential = credentials.get(channel);
        const expiresAt = credential ? credentialExpiresAtMs(credential) : undefined;
        const scheduler = schedulers.get(channel);
        return {
            armed: !!scheduler?.timer,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            expiresInMs: expiresAt ? expiresAt - Date.now() : null,
            needsRelogin: needsRelogin.has(channel),
            lastRefresh: refreshState.get(channel) || null,
        };
    }

    // ── 启动时按已有凭据武装调度 ──
    for (const product of ALL_PRODUCTS) {
        if (credentials.has(product.id)) {
            armScheduler(product.id);
        }
    }

    // 已到期窗口内的凭据立即刷新一次
    for (const product of ALL_PRODUCTS) {
        const credential = credentials.get(product.id);
        if (!credential) continue;
        const delay = computeFirstRefreshDelayMs(credentialExpiresAtMs(credential));
        if (delay === 0) {
            log(`渠道 ${product.id} 凭据处于续期窗口内，立即刷新`);
            refreshCredential(product.id).catch(error => logError(`启动续期失败（${product.id}）：`, error.message));
        }
    }

    // ── 代理启停 ──

    /**
     * 启动代理监听。
     *
     * `persistPort` 只在**用户显式指定端口**（POST /config）时为 true。
     *
     * 启动时允许端口顺延，但**不把顺延后的端口写回配置** —— 否则一次偶发的端口
     * 冲突（另一个 SillyTavern 实例占着 8791、或自测脚本临时占用）会把用户配置里
     * 的端口永久改掉，而 SillyTavern 的 `custom_url` 还指着旧端口，面板就会显示
     * 「未接入」。顺延的真实端口始终通过 `localBaseUrl` 如实回报。
     */
    async function startProxy({ persistPort = false } = {}) {
        try {
            const { port, url } = await proxy.start(proxyPort);
            const shifted = port !== proxyPort;
            proxyPort = port;
            if (shifted && !persistPort) {
                log(`端口 ${store.get().proxyPort} 被占用，本次顺延到 ${port}（不写回配置，下次启动仍优先尝试原端口）`);
            }
            if (persistPort && store.get().proxyPort !== port) {
                store.update({ proxyPort: port });
            }
            store.update({ localBaseUrl: url });
            return { running: true, port, url };
        } catch (error) {
            logError('代理启动失败：', error.message);
            return { running: false, port: proxyPort, url: null, error: error.message };
        }
    }

    async function restartProxy(nextPort) {
        await proxy.stop();
        const explicit = Number.isInteger(nextPort) && nextPort > 0;
        if (explicit) proxyPort = nextPort;
        return startProxy({ persistPort: explicit });
    }

    const proxyStatus = await startProxy();

    // ── 管理路由 ──

    /** 统一异常包装，避免任何一条管理接口把异常抛成 500 HTML。 */
    const wrap = (handler) => (req, res) => {
        Promise.resolve(handler(req, res)).catch(error => {
            logError(`管理接口 ${req.method} ${req.path} 失败：`, error?.stack || String(error));
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: error?.message || String(error) });
            }
        });
    };

    /** 组装单个渠道的完整状态。 */
    async function channelStatus(channelId) {
        const product = productById(channelId);
        const credential = credentials.get(channelId);
        const { models, source, fetchedAt } = await catalog.rawList(channelId);
        return {
            id: product.id,
            displayName: product.displayName,
            platform: product.platform,
            endpoint: product.endpoint,
            userAgent: product.userAgent,
            userAgentRules: (product.userAgentByModelFamily || []).map(rule => ({ match: rule.match, ua: rule.ua })),
            loggedIn: credentials.has(channelId),
            credential: credentials.publicView(channelId),
            schedule: schedulerInfo(channelId),
            models: {
                count: models.length,
                source,
                fetchedAt: new Date(fetchedAt).toISOString(),
                visible: models.filter(model => !store.hiddenFor(channelId).has(model.id)).length,
            },
            hasCredential: !!credential,
        };
    }

    /**
     * 取某渠道的积分余额（短缓存 + 并发去重）。
     *
     * 未登录时**不发请求**，直接返回结构化的「不可用」——面板据此显示「登录后可见」，
     * 而不是把失败渲染成 0 积分误导用户以为自己用完了额度。
     *
     * @returns {Promise<{available:boolean, total?:number, packages?:any[], expiredTotal?:number,
     *   fetchedAt?:number, checkin?:any, reason?:string, message?:string}>}
     */
    function creditsFor(channelId, { force = false } = {}) {
        const product = productById(channelId);
        if (!product) {
            return Promise.resolve({
                available: false,
                channel: channelId,
                displayName: channelId,
                reason: 'unknown-channel',
                message: `未知渠道：${channelId}`,
            });
        }
        // 未登录也要带 displayName —— 面板直接用这份数据渲染区块，
        // 不该依赖 /status 是否已经加载完成。
        const identity = { channel: channelId, displayName: product.displayName };
        if (!credentials.has(channelId)) {
            return Promise.resolve({ ...identity, available: false, reason: 'not-logged-in', message: '未登录' });
        }

        const ttl = store.get().creditsCacheTtlMs ?? 60000;
        const cached = creditsCache.get(channelId);
        if (!force && cached && Date.now() - cached.at < ttl) {
            return Promise.resolve(cached.data);
        }
        if (!force && creditsInflight.has(channelId)) {
            return creditsInflight.get(channelId);
        }

        const credential = credentials.get(channelId);
        const task = (async () => {
            const balance = await fetchCreditBalance(credential, product);
            const data = balance.ok
                ? {
                    ...identity,
                    available: true,
                    total: balance.total,
                    expiredTotal: balance.expiredTotal,
                    packages: balance.packages,
                    fetchedAt: balance.fetchedAt,
                }
                : {
                    ...identity,
                    available: false,
                    reason: balance.reason,
                    message: balance.message,
                    code: balance.code,
                };

            // 签到状态只有中国版有。它的失败绝不影响余额展示。
            if (product.supportsCheckin) {
                const checkin = await fetchCheckinStatus(credential, product);
                data.checkin = checkin.ok
                    ? {
                        available: true,
                        active: checkin.active,
                        todayCheckedIn: checkin.todayCheckedIn,
                        streakDays: checkin.streakDays,
                        dailyCredit: checkin.dailyCredit,
                        todayCredit: checkin.todayCredit,
                        isStreakDay: checkin.isStreakDay,
                        totalCredits: checkin.totalCredits,
                        checkinDates: checkin.checkinDates,
                        activityName: checkin.activityName,
                        endTime: checkin.endTime,
                    }
                    : { available: false, reason: checkin.reason, message: checkin.message };
            }

            creditsCache.set(channelId, { at: Date.now(), data });
            return data;
        })().finally(() => {
            creditsInflight.delete(channelId);
        });

        creditsInflight.set(channelId, task);
        return task;
    }

    /** GET /status —— 面板主数据源。 */
    router.get('/status', wrap(async (req, res) => {
        const config = store.get();
        const channels = {};
        for (const product of ALL_PRODUCTS) {
            channels[product.id] = await channelStatus(product.id);
        }
        // 清理过期登录会话
        pruneLogins();
        res.json({
            ok: true,
            plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION, dataDir },
            proxy: {
                ...proxyStatus,
                port: proxy.port,
                url: proxy.url,
                localBaseUrl: proxy.url,
            },
            config,
            channels,
            pendingLogins: [...pendingLogins.entries()].map(([state, entry]) => ({
                state,
                channel: entry.channel,
                status: entry.status,
                error: entry.error,
                startedAt: new Date(entry.startedAt).toISOString(),
            })),
        });
    }));

    /** GET /config */
    router.get('/config', wrap((req, res) => {
        res.json({ ok: true, config: store.get(), proxy: { port: proxy.port, url: proxy.url } });
    }));

    /** POST /config —— 更新配置；改端口会重启代理。 */
    router.post('/config', wrap(async (req, res) => {
        const patch = req.body && typeof req.body === 'object' ? req.body : {};
        const before = store.get();
        const updated = store.update(patch);

        let proxyRestarted = false;
        if (Number.isInteger(patch.proxyPort) && patch.proxyPort !== proxy.port) {
            await restartProxy(patch.proxyPort);
            proxyRestarted = true;
        }
        if (patch.defaultChannel !== undefined && patch.defaultChannel !== before.defaultChannel) {
            log(`默认渠道已切换为 ${updated.defaultChannel}`);
        }
        res.json({
            ok: true,
            config: updated,
            proxy: { port: proxy.port, url: proxy.url, restarted: proxyRestarted },
        });
    }));

    /** POST /models/refresh —— 强制重新拉取远端模型目录。 */
    router.post('/models/refresh', wrap(async (req, res) => {
        const channel = req.body?.channel;
        catalog.invalidate(typeof channel === 'string' ? channel : undefined);
        const channels = {};
        for (const product of ALL_PRODUCTS) {
            const { models, source, fetchedAt } = await catalog.rawList(product.id, { force: true });
            channels[product.id] = { count: models.length, source, fetchedAt: new Date(fetchedAt).toISOString() };
        }
        res.json({ ok: true, channels });
    }));

    /** GET /models —— 完整模型清单（含隐藏标记与渠道元数据）。 */
    router.get('/models', wrap(async (req, res) => {
        const models = await catalog.listAll();
        const filter = typeof req.query.channel === 'string' ? req.query.channel : undefined;
        const filtered = filter ? models.filter(model => model.channel === filter) : models;
        res.json({ ok: true, total: filtered.length, models: filtered });
    }));

    /** POST /models/toggle —— 黑名单制显隐。 */
    router.post('/models/toggle', wrap((req, res) => {
        const channel = req.body?.channel;
        const id = req.body?.id;
        const hidden = req.body?.hidden === true;
        if (!productById(channel) || typeof id !== 'string' || id.length === 0) {
            res.status(400).json({ ok: false, error: '需要 channel 与 id' });
            return;
        }
        const current = store.get().hiddenModels?.[channel] || [];
        const next = hidden
            ? [...new Set([...current, id])]
            : current.filter(existing => existing !== id);
        store.update({ hiddenModels: { [channel]: next } });
        res.json({ ok: true, channel, hidden: next });
    }));

    /** POST /models/hidden —— 一次性覆盖某渠道的隐藏清单。 */
    router.post('/models/hidden', wrap((req, res) => {
        const channel = req.body?.channel;
        const ids = req.body?.ids;
        if (!productById(channel) || !Array.isArray(ids)) {
            res.status(400).json({ ok: false, error: '需要 channel 与 ids 数组' });
            return;
        }
        store.update({ hiddenModels: { [channel]: ids.filter(id => typeof id === 'string') } });
        res.json({ ok: true, channel, hidden: store.get().hiddenModels[channel] });
    }));

    // ── 登录 ──

    function pruneLogins() {
        const now = Date.now();
        for (const [state, entry] of pendingLogins.entries()) {
            if (now - entry.startedAt > PENDING_LOGIN_TTL_MS) {
                entry.cancelled = true;
                pendingLogins.delete(state);
            }
        }
    }

    /**
     * POST /login/start { channel }
     *
     * 取 state + authUrl 返回给前端（前端 window.open），后端用同一 state 轮询。
     * 登录无法全自动：必须由真人在浏览器里完成授权。
     */
    router.post('/login/start', wrap(async (req, res) => {
        const channel = req.body?.channel;
        const product = productById(channel);
        if (!product) {
            res.status(400).json({ ok: false, error: `未知渠道：${channel}` });
            return;
        }

        // 同一渠道同时只允许一个登录会话
        for (const [state, entry] of [...pendingLogins.entries()]) {
            if (entry.channel === channel && entry.status === 'waiting') {
                entry.cancelled = true;
                pendingLogins.delete(state);
            }
        }

        let authState;
        try {
            authState = await fetchAuthState(product);
        } catch (error) {
            res.status(502).json({ ok: false, error: `获取登录 state 失败：${error.message}` });
            return;
        }

        const authUrl = decorateLoginUrl(authState.authUrl, product);
        const entry = {
            channel,
            authUrl,
            status: 'waiting',
            error: null,
            startedAt: Date.now(),
            cancelled: false,
        };
        pendingLogins.set(authState.state, entry);
        log(`渠道 ${channel} 登录会话已创建，等待浏览器授权：${authUrl}`);

        // 后台轮询：token → account → 落盘
        void (async () => {
            try {
                const { credential } = await runLoginFlow(authState.state, {
                    product,
                    isCancelled: () => entry.cancelled || !pendingLogins.has(authState.state),
                });
                credentials.set(channel, credential);
                needsRelogin.delete(channel);
                entry.status = 'done';
                catalog.invalidate(channel);
                creditsCache.delete(channel);
                armScheduler(channel);
                log(`渠道 ${channel} 登录成功：${credential.nickname || credential.user_id || '(未知账号)'}`);
            } catch (error) {
                entry.status = 'error';
                entry.error = error?.message || String(error);
                logError(`渠道 ${channel} 登录失败：`, entry.error);
            }
        })();

        res.json({
            ok: true,
            channel,
            state: authState.state,
            authUrl,
            // WorkBuddy 的 authUrl 被追加了 version/loginSessionId，提示前端不要自己拼
            message: '请在浏览器中完成授权，本页面会自动检测登录结果。',
        });
    }));

    /** GET /login/status?state=... —— 前端轮询登录结果。 */
    router.get('/login/status', wrap((req, res) => {
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const entry = pendingLogins.get(state);
        if (!entry) {
            res.json({ ok: true, found: false, status: 'unknown' });
            return;
        }
        res.json({
            ok: true,
            found: true,
            channel: entry.channel,
            status: entry.status,
            error: entry.error,
            authUrl: entry.authUrl,
            startedAt: new Date(entry.startedAt).toISOString(),
            credential: entry.status === 'done' ? credentials.publicView(entry.channel) : null,
        });
    }));

    /** POST /login/cancel { state } */
    router.post('/login/cancel', wrap((req, res) => {
        const state = req.body?.state;
        const entry = state ? pendingLogins.get(state) : undefined;
        if (entry) {
            entry.cancelled = true;
            pendingLogins.delete(state);
        }
        res.json({ ok: true, cancelled: !!entry });
    }));

    /** POST /logout { channel } */
    router.post('/logout', wrap((req, res) => {
        const channel = req.body?.channel;
        if (!productById(channel)) {
            res.status(400).json({ ok: false, error: `未知渠道：${channel}` });
            return;
        }
        schedulers.get(channel)?.stop();
        schedulers.delete(channel);
        credentials.clear(channel);
        needsRelogin.delete(channel);
        refreshState.delete(channel);
        catalog.invalidate(channel);
        creditsCache.delete(channel);
        log(`渠道 ${channel} 已登出`);
        res.json({ ok: true, channel, loggedIn: false });
    }));

    /** POST /refresh { channel } —— 手动触发一次续期，便于验证。 */
    router.post('/refresh', wrap(async (req, res) => {
        const channel = req.body?.channel;
        if (!productById(channel)) {
            res.status(400).json({ ok: false, error: `未知渠道：${channel}` });
            return;
        }
        try {
            await refreshCredential(channel);
            res.json({ ok: true, channel, schedule: schedulerInfo(channel) });
        } catch (error) {
            res.status(400).json({
                ok: false,
                channel,
                error: error?.message || String(error),
                terminal: error instanceof RefreshTokenExpiredError,
            });
        }
    }));

    // ── 积分 ──

    /**
     * GET /credits —— 积分余额（含签到状态）。
     * `?channel=` 限定单个渠道；`?force=1` 绕过服务端短缓存。
     */
    router.get('/credits', wrap(async (req, res) => {
        const force = req.query.force === '1' || req.query.force === 'true';
        const only = typeof req.query.channel === 'string' && req.query.channel.length > 0
            ? req.query.channel
            : undefined;
        if (only !== undefined && !productById(only)) {
            res.status(400).json({ ok: false, error: `未知渠道：${only}` });
            return;
        }
        const channels = {};
        for (const product of ALL_PRODUCTS) {
            if (only !== undefined && product.id !== only) continue;
            channels[product.id] = await creditsFor(product.id, { force });
        }
        res.json({ ok: true, channels, force });
    }));

    /**
     * POST /credits/checkin { channel } —— 领取每日积分（仅中国版有该活动）。
     *
     * **始终返回 HTTP 200 + `result.kind`**，因为「今天已签到」「无资格」都是正常的
     * 业务状态而非接口失败；把 kind 交给面板渲染比用 HTTP 状态码表达更准确。
     */
    router.post('/credits/checkin', wrap(async (req, res) => {
        const channel = req.body?.channel;
        const product = productById(channel);
        if (!product) {
            res.status(400).json({ ok: false, error: `未知渠道：${channel}` });
            return;
        }
        if (!product.supportsCheckin) {
            res.status(400).json({ ok: false, error: `${product.displayName} 没有每日签到活动。` });
            return;
        }
        if (!credentials.has(channel)) {
            res.status(400).json({ ok: false, error: `${product.displayName} 尚未登录，无法领取。` });
            return;
        }

        const result = await claimDailyCheckin(credentials.get(channel), product);
        // 领完立刻失效缓存，下次查询就是新余额
        creditsCache.delete(channel);
        log(`渠道 ${channel} 签到结果：${result.kind}${result.credit ? ` +${result.credit}` : ''} —— ${result.message}`);
        res.json({ ok: true, channel, result });
    }));

    /** GET /ping —— 前端探活。 */
    router.get('/ping', (req, res) => {
        res.json({ ok: true, plugin: PLUGIN_ID, version: PLUGIN_VERSION, proxy: proxy.port });
    });

    log(`插件已加载（v${PLUGIN_VERSION}）；管理接口 /api/plugins/${PLUGIN_ID}/*，代理 ${proxyStatus.url || '(未启动)'}`);

    // ── 退出钩子 ──
    // plugin-loader 在 await init() 返回后立刻读取 plugin.exit，
    // 所以这里必须把清理函数挂到模块导出上，而不是等宿主调用时才创建。
    teardown = async () => {
        for (const scheduler of schedulers.values()) scheduler.stop();
        await proxy.stop();
        log('插件已停止，代理监听已关闭');
    };
}

/** 由 ST 在关闭进程时调用（plugin-loader 的 exit 钩子）。 */
async function exit() {
    if (!teardown) return;
    const fn = teardown;
    teardown = null;
    try {
        await fn();
    } catch (error) {
        logError('退出清理失败：', error?.message || String(error));
    }
}

module.exports = { info, init, exit };
