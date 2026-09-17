'use strict';
/**
 * 纯逻辑层（移植自 dsh-codearts-auth 的 lib/buddy.js）：JWT 解析、凭据装配、
 * /v3/config 模型目录解析。无网络、无存储，便于单测。
 */
const {
    HTTP_HEADER_DOMAIN,
    HTTP_HEADER_ENTERPRISE_ID,
    HTTP_HEADER_TENANT_ID,
} = require('./product');

/**
 * 去掉字符串中的控制字符（含 CR/LF/Tab），并把连续空白折叠为单个空格。
 *
 * 必要性（原插件实证）：CodeBuddy 的 `scope` 字段有时返回多行文本
 * （"profile\n    offline_access\n    email"）。这些换行会被凭据 JSON 原样携带，
 * 破坏结构并让后续 JSON.parse 失败，表现为「有效期/昵称等字段丢失」。
 */
function stripControlChars(value) {
    return String(value).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function readStringField(data, key) {
    if (typeof data !== 'object' || data === null) return '';
    const value = data[key];
    if (typeof value === 'string') return stripControlChars(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

function readNumberField(data, key) {
    if (typeof data !== 'object' || data === null) return undefined;
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
    return undefined;
}

/** 解码 JWT payload；非 JWT 或解析失败返回 null。 */
function jwtPayload(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

/** 从 JWT 读 `exp`（秒）并换算为毫秒。 */
function jwtExpiresAtMs(token) {
    const payload = jwtPayload(token);
    return payload && typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
}

/** 从 JWT 读 `iat`（秒）并换算为毫秒。 */
function jwtIssuedAtMs(token) {
    const payload = jwtPayload(token);
    return payload && typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat * 1000 : undefined;
}

/**
 * 从 JWT payload 读取昵称：`login/account` 响应常不含昵称，真正的昵称只在 access_token 里。
 * 回退链：nickname → preferred_username → name。
 */
function jwtNickname(token) {
    const payload = jwtPayload(token);
    if (!payload) return '';
    const value = payload.nickname ?? payload.preferred_username ?? payload.name;
    return typeof value === 'string' ? stripControlChars(value) : '';
}

/** 从 JWT 读 `sub`。 */
function jwtSubject(token) {
    const payload = jwtPayload(token);
    return payload && typeof payload.sub === 'string' ? payload.sub : '';
}

/**
 * 从凭据解析过期毫秒时间戳（兼容毫秒时间戳/秒级时间戳/ISO 8601）。
 *
 * 实测：`/v2/plugin/auth/token` **不返回绝对的 expiresAt**，只给相对 expiresIn。
 * 因此 expires_at 为空时回退到 access_token 这个 JWT 的 `exp` —— 它同样是权威的过期时刻。
 */
function credentialExpiresAtMs(credential) {
    if (typeof credential !== 'object' || credential === null) return undefined;
    const raw = credential.expires_at;
    if (typeof raw === 'string' && raw.length > 0) {
        if (/^\d+$/.test(raw)) {
            const value = Number(raw);
            return value > 1000000000000 ? value : value * 1000;
        }
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return jwtExpiresAtMs(credential.access_token);
}

/** 凭据是否已过期；无法解析过期时间时不判定过期。 */
function isExpired(credential) {
    const expiresAt = credentialExpiresAtMs(credential);
    return expiresAt === undefined ? false : Date.now() >= expiresAt;
}

/** 凭据是否携带可静默续期的 refresh_token。 */
function isRefreshable(credential) {
    return !!credential && typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0;
}

/**
 * 相对秒数换算为绝对毫秒时间戳字符串。
 * 基准取 access_token 的 JWT `iat`（优先，权威）或当前时刻。
 */
function absoluteExpiryMs(record, absoluteKey, relativeKey, accessToken) {
    const absolute = readStringField(record, absoluteKey);
    if (absolute.length > 0) {
        const asNumber = /^\d+$/.test(absolute) ? Number(absolute) : Date.parse(absolute);
        if (Number.isFinite(asNumber)) {
            const ms = asNumber > 1000000000000 ? asNumber : asNumber * 1000;
            return String(ms);
        }
        return absolute;
    }
    const relativeSeconds = readNumberField(record, relativeKey);
    if (relativeSeconds === undefined) return '';
    const baseMs = jwtIssuedAtMs(accessToken) ?? Date.now();
    return String(baseMs + relativeSeconds * 1000);
}

/** 解析 `/v2/plugin/auth/token` 的 data 字段。 */
function parseTokenData(data) {
    const record = typeof data === 'object' && data !== null ? data : {};
    const tokenType = readStringField(record, 'tokenType');
    const accessToken = readStringField(record, 'accessToken');
    return {
        accessToken,
        refreshToken: readStringField(record, 'refreshToken'),
        expiresAt: absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken),
        refreshExpiresAt: absoluteExpiryMs(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken),
        tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
        scope: readStringField(record, 'scope'),
        domain: readStringField(record, 'domain'),
    };
}

/** 解析 `/v2/plugin/login/account` 的 data 字段。 */
function parseAccountData(data) {
    const record = typeof data === 'object' && data !== null ? data : {};
    const accountType = readStringField(record, 'type');
    return {
        uid: readStringField(record, 'uid'),
        nickname: readStringField(record, 'nickname'),
        enterpriseId: readStringField(record, 'enterpriseId'),
        accountType: accountType.length > 0 ? accountType : 'personal',
    };
}

/**
 * 组合令牌与账户数据为可持久化凭据。
 * 昵称回退：account.nickname → JWT.nickname → JWT.preferred_username。
 */
function buildCredential(token, account) {
    const nickname = account.nickname.length > 0 ? account.nickname : jwtNickname(token.accessToken);
    return {
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        expires_at: token.expiresAt,
        refresh_expires_at: token.refreshExpiresAt,
        token_type: token.tokenType,
        scope: token.scope,
        domain: token.domain,
        user_id: account.uid.length > 0 ? account.uid : jwtSubject(token.accessToken),
        nickname,
        enterprise_id: account.enterpriseId,
        account_type: account.accountType,
    };
}

/** 构造基础请求头（X-Domain + User-Agent + 可选企业头）。 */
function credentialRequestHeaders(credential, product) {
    const headers = {
        [HTTP_HEADER_DOMAIN]: credential.domain || product.apiDomain,
        'User-Agent': product.userAgent,
    };
    if (credential.enterprise_id) {
        headers[HTTP_HEADER_ENTERPRISE_ID] = credential.enterprise_id;
        headers[HTTP_HEADER_TENANT_ID] = credential.enterprise_id;
    }
    return headers;
}

/** 构造带 Bearer 令牌的认证请求头。 */
function credentialAuthHeaders(credential, product) {
    return {
        ...credentialRequestHeaders(credential, product),
        Authorization: `Bearer ${credential.access_token}`,
    };
}

// ── 模型目录解析 ──

/** 已知模型 ID → 展示名（/v3/config 不返回展示名时的本地兜底）。 */
const MODEL_DISPLAY_NAMES = {
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
    'hy4-preview': 'Hy4 Preview',
    'hy4-preview-x': 'Hy4 Preview X',
    'hy3': 'Hy3',
    'hy3-x': 'Hy3 X',
    'glm-5.3': 'GLM-5.3',
    'glm-5.3-flash': 'GLM-5.3 Flash',
    'glm-5.2': 'GLM-5.2',
    'glm-5.1': 'GLM-5.1',
    'glm-5v-turbo': 'GLM-5V Turbo',
    'kimi-k3-1': 'Kimi K3-1',
    'kimi-k2.7': 'Kimi K2.7',
    'kimi-k2.6': 'Kimi K2.6',
    'minimax-m3': 'MiniMax M3',
};

function displayNameForModel(id) {
    return MODEL_DISPLAY_NAMES[id] ?? id;
}

/** 承载「可选对话模型」清单的 agent 名，按优先级排列（企业端点用 cli，/v3/config 用 craft）。 */
const PREFERRED_AGENT_NAMES = ['cli', 'craft'];

/**
 * 判断 data.models 中的条目是否为「可供用户选择的对话模型」。
 * 排除：补全/NES 专用（nes- / completion- / codewise- 前缀、supportsExtra）、
 * 输出上限 ≤256 的补全模型、带 text-to-image 标签的生成式模型。
 */
function isChatModel(id, meta) {
    if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return false;
    if (meta && meta.supportsExtra === true) return false;
    const maxOutput = meta && meta.maxOutputTokens;
    if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256) return false;
    const tags = meta && meta.tags;
    if (Array.isArray(tags) && tags.some(tag => tag === 'text-to-image')) return false;
    return true;
}

/** 提取单个 data.models[] 条目的上下文窗口、图片能力与思考等级。 */
function parseModelMeta(record) {
    if (record === undefined) return {};
    const meta = {};
    const limit = record.maxInputTokens;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) meta.contextWindow = limit;
    if (typeof record.supportsImages === 'boolean') meta.supportsImages = record.supportsImages;
    const reasoning = record.reasoning;
    if (typeof reasoning === 'object' && reasoning !== null) {
        if (Array.isArray(reasoning.supportedEfforts)) {
            const efforts = reasoning.supportedEfforts.filter(e => typeof e === 'string' && e.length > 0);
            if (efforts.length > 0) meta.reasoningEfforts = efforts;
        }
        if (typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort.length > 0) {
            meta.defaultReasoningEffort = reasoning.defaultEffort;
        }
    }
    return meta;
}

/** 从 productFeaturesConfig.ModelTrialBanner 提取试用模型 id。 */
function trialModelIds(data) {
    const features = data.productFeaturesConfig;
    if (typeof features !== 'object' || features === null) return [];
    const banner = features.ModelTrialBanner;
    if (typeof banner !== 'object' || banner === null) return [];
    if (!Array.isArray(banner.banners)) return [];
    const ids = [];
    for (const item of banner.banners) {
        if (typeof item !== 'object' || item === null) continue;
        if (typeof item.targetModelId === 'string' && item.targetModelId.length > 0) ids.push(item.targetModelId);
    }
    return ids;
}

/**
 * 从 /v3/config（或企业模型端点，同结构）响应解析可用对话模型。
 *
 * 三层优先级：craft/cli agent 引用的模型 → data.models 中其余可对话模型 → 试用横幅模型。
 * （国际版 craft 只引用 5 个抽象别名，其余可用模型只出现在 data.models 里，故必须补齐。）
 */
function parseModelsFromConfig(body) {
    if (typeof body !== 'object' || body === null) return [];
    const data = body.data;
    if (typeof data !== 'object' || data === null) return [];

    const metaById = new Map();
    if (Array.isArray(data.models)) {
        for (const model of data.models) {
            if (typeof model === 'object' && model !== null && typeof model.id === 'string') {
                metaById.set(model.id, model);
            }
        }
    }

    const parsed = [];
    const seen = new Set();
    const push = (id) => {
        if (id === 'auto' || seen.has(id) || !isChatModel(id, metaById.get(id))) return;
        seen.add(id);
        const meta = metaById.get(id);
        const remoteName = meta && typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : undefined;
        parsed.push({ id, name: remoteName ?? displayNameForModel(id), ...parseModelMeta(meta) });
    };

    for (const agentName of PREFERRED_AGENT_NAMES) {
        let found = false;
        if (!Array.isArray(data.agents)) break;
        for (const agent of data.agents) {
            if (typeof agent !== 'object' || agent === null) continue;
            if (agent.name !== agentName) continue;
            if (Array.isArray(agent.models)) {
                for (const model of agent.models) {
                    if (typeof model === 'string') push(model);
                }
            }
            found = true;
            break;
        }
        if (found) break;
    }

    for (const id of metaById.keys()) push(id);

    for (const id of trialModelIds(data)) {
        if (id === 'auto' || seen.has(id)) continue;
        seen.add(id);
        parsed.push({ id, name: displayNameForModel(id), ...parseModelMeta(metaById.get(id)) });
    }

    return parsed;
}

module.exports = {
    stripControlChars,
    jwtPayload,
    jwtExpiresAtMs,
    jwtNickname,
    jwtSubject,
    credentialExpiresAtMs,
    isExpired,
    isRefreshable,
    parseTokenData,
    parseAccountData,
    buildCredential,
    credentialRequestHeaders,
    credentialAuthHeaders,
    displayNameForModel,
    parseModelsFromConfig,
};
