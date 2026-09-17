'use strict';
/**
 * 产品配置与协议常量（移植自 dsh-codearts-auth 的 lib/product.js + lib/buddy.js）。
 *
 * CodeBuddy（中国）与 WorkBuddy（国际版）同源同协议，差异全部收敛为「产品配置对象」：
 * endpoint / platform / 品牌头 / UA / 模型池。新增渠道只需往 ALL_PRODUCTS 加一项。
 *
 * 协议事实来自对 dsh-codearts-auth 的实测复现（该参照实现不随本仓库分发）。
 */

// ── 端点与路径 ──
const AUTH_STATE_PATH = '/v2/plugin/auth/state';
const AUTH_TOKEN_PATH = '/v2/plugin/auth/token';
const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account';
const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const CONFIG_PATH = '/v3/config';
const ENTERPRISE_MODELS_SCOPE = 'personal';
const CHAT_COMPLETIONS_PATH = '/v2/chat/completions';

// ── 计费 / 积分端点（对齐 dsh-codearts-auth/lib/credits.js）──
/**
 * 积分余额查询端点。**两个产品通用**（实测：CodeBuddy 中国版与 WorkBuddy 国际版
 * 都实现该端点，请求头与响应结构完全一致，只有 baseURL 不同）。
 * 响应是双层嵌套：`data.Response.Data.Accounts[]`。
 */
const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource';
/**
 * 每日签到状态查询端点（**权威状态源**）。
 * 不能用 `checkin-status` —— 后者返回占位数据（active:false、checkin_dates:null），
 * 会让人误判为「活动未开启」。
 */
const CHECKIN_ACTIVITY_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
/** 每日签到领取端点。幂等：重复领取返回 HTTP 400 + code 10001。 */
const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
/** 计费请求超时（毫秒）。 */
const BILLING_REQUEST_TIMEOUT_MS = 30000;
/**
 * `X-Product` 在**计费端点**上的取值是「部署类型」SaaS，两个产品共用。
 *
 * ⚠️ 与对话端点不同：对话/模型端点的 `X-Product` 发的是**归属名**
 * （`product.attributionName`，如 CodeBuddy / WorkBuddy），见 proxy.js 与
 * oauth.js 的 modelsRequestHeaders。两处刻意不一致，因为服务端语义不同
 * （计费看部署类型，用量归因看产品名）。
 */
const BUDDY_DEPLOYMENT_TYPE = 'SaaS';
/**
 * 资源包 `Status` 字段表示「已过期」的取值（实测）。
 * 某 CodeBuddy 账号 5 个包中，两个带过去 `ExpiredTime` 的条目 Status 均为 3，
 * 三个有效条目为 0。其他未知取值一律当有效。
 */
const PACKAGE_STATUS_EXPIRED = 3;

// ── 轮询参数 ──
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const STATE_REQUEST_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 60000;

// ── 业务错误码 ──
const CODE_TOKEN_NOT_READY = 11217;
const CODE_ACCOUNT_NOT_READY = 12151;

// ── 请求头常量 ──
const HTTP_HEADER_DOMAIN = 'X-Domain';
const HTTP_HEADER_ENTERPRISE_ID = 'X-Enterprise-Id';
const HTTP_HEADER_TENANT_ID = 'X-Tenant-Id';
const HTTP_HEADER_NO_AUTHORIZATION = 'X-No-Authorization';
const HTTP_HEADER_NO_USER_ID = 'X-No-User-Id';
const HTTP_HEADER_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id';
const HTTP_HEADER_NO_DEPARTMENT_INFO = 'X-No-Department-Info';
const HTTP_HEADER_REFRESH_TOKEN = 'X-Refresh-Token';
const HTTP_HEADER_AUTH_REFRESH_SOURCE = 'X-Auth-Refresh-Source';
const HTTP_HEADER_PRODUCT = 'X-Product';
const HTTP_HEADER_PRODUCT_CODE = 'X-Product-Code';

/** 刷新来源标识（对齐 IDE 的 ide-main）。 */
const AUTH_REFRESH_SOURCE = 'ide-main';

// ── 续期调度常量（对齐 refresh.js）──
const REFRESH_LEAD_MS = 3_600_000;
const REFRESH_RETRY_MS = 600_000;
const REFRESH_ABNORMAL_NETWORK_RETRY_MS = 60_000;

// ── UA 分档字面量 ──
const WORKBUDDY_UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2';
const WORKBUDDY_UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2';

/**
 * CodeBuddy（中国版）内置兜底模型目录。
 * 只收录实测可用的模型 —— 远端 data.models 里另有一批返回 11102 的条目，列进去只会让用户选中后报错。
 */
const CODEBUDDY_FALLBACK_MODELS = [
    { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high' },
    { id: 'hy3', name: 'Hy3', contextWindow: 192000, supportsImages: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { id: 'hy3-x', name: 'Hy3', contextWindow: 192000, supportsImages: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high' },
    { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512000, supportsImages: true, reasoningEfforts: ['medium'] },
];

/** WorkBuddy 国际版内置兜底模型目录（顺序即 IDE 展示顺序，勿随意重排）。 */
const WORKBUDDY_FALLBACK_MODELS = [
    { id: 'default-model', name: 'Auto', contextWindow: 176000, supportsImages: true },
    { id: 'fast-model', name: 'Fast', contextWindow: 200000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'balanced-model', name: 'Balanced', contextWindow: 256000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'primary-model', name: 'Primary', contextWindow: 272000, supportsImages: true, reasoningEfforts: ['high'] },
    { id: 'deep-model', name: 'Deep', contextWindow: 176000, supportsImages: true },
    { id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high' },
    { id: 'hy3', name: 'Hy3', contextWindow: 192000, supportsImages: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['high'] },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high' },
    { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
    { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high' },
    { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1000000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256000, supportsImages: true, reasoningEfforts: ['medium'] },
];

/** CodeBuddy（腾讯，中国版），platform = ide。 */
const CODEBUDDY = {
    id: 'codebuddy',
    platform: 'ide',
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    displayName: 'CodeBuddy (腾讯)',
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
    userAgentByModelFamily: [],
    attributionName: 'CodeBuddy',
    clientVersion: '1.106.1',
    cliVersion: '2.137.1',
    defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
    appendSessionParams: false,
    /** 中国版有「每日签到领积分」活动（国际版内核里连相关字面量都不存在）。 */
    supportsCheckin: true,
    fallbackModels: CODEBUDDY_FALLBACK_MODELS,
};

/** WorkBuddy 国际版（WorkBuddy AI），platform = workbuddy-ai。 */
const WORKBUDDY = {
    id: 'workbuddy',
    platform: 'workbuddy-ai',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    displayName: 'WorkBuddy (国际版)',
    productCode: 'workbuddy',
    userAgent: WORKBUDDY_UA_INTL,
    userAgentByModelFamily: [
        { match: 'gpt-', ua: WORKBUDDY_UA_INTL },
        { match: 'gemini-', ua: WORKBUDDY_UA_INTL },
        { match: 'claude-', ua: WORKBUDDY_UA_INTL },
        { match: 'glm-', ua: WORKBUDDY_UA_CN },
        { match: 'hy', ua: WORKBUDDY_UA_CN },
        { match: 'kimi-', ua: WORKBUDDY_UA_CN },
        { match: 'minimax-', ua: WORKBUDDY_UA_CN },
    ],
    attributionName: 'WorkBuddy',
    clientVersion: '5.5.2',
    cliVersion: '5.5.2',
    defaultCredentialRef: 'WORKBUDDY_ACCESS_TOKEN',
    appendSessionParams: true,
    pluginVersion: '5.5.2',
    /**
     * 国际版**没有**签到能力（实测：内核里搜不到 checkin 相关字面量），
     * 但**积分余额查询是有的** —— 两者是彼此独立的能力，不要因为没签到
     * 就推断它也查不到余额。
     */
    supportsCheckin: false,
    /**
     * 国际版要求 `messages[0]` **必须是 system 角色**（实测）。
     * 否则上游返回 400 code=11128「first message is not system prompt」，
     * 文案还会被包装成「请求被安全策略拦截」，极具误导性。
     * 中国版没有这条限制（同样只发 user 也能正常返回）。
     *
     * 实测补充：首条 system 的 content 为空串 / null / 缺键都能通过，
     * 所以桥接层可以安全地补一条空 system 兜底，不需要伪造提示词。
     */
    requiresLeadingSystemMessage: true,
    fallbackModels: WORKBUDDY_FALLBACK_MODELS,
};

const ALL_PRODUCTS = [CODEBUDDY, WORKBUDDY];

/** 按 provider id 取产品配置。 */
function productById(id) {
    return ALL_PRODUCTS.find(product => product.id === id);
}

/**
 * 按模型 id 解析该产品应使用的 User-Agent（按模型族分档，先命中先返回）。
 * 未命中任何规则时回退到 product.userAgent —— 保证新模型上线时 UA 仍含品牌字样。
 */
function resolveUserAgent(product, model) {
    for (const rule of product.userAgentByModelFamily || []) {
        if (String(model).startsWith(rule.match)) {
            return rule.ua;
        }
    }
    return product.userAgent;
}

/** 该产品是否声明了某个 UA 分档（供调试/展示用）。 */
function uaFamilyOf(product, model) {
    for (const rule of product.userAgentByModelFamily || []) {
        if (String(model).startsWith(rule.match)) {
            return rule.match;
        }
    }
    return null;
}

module.exports = {
    AUTH_STATE_PATH,
    AUTH_TOKEN_PATH,
    LOGIN_ACCOUNT_PATH,
    AUTH_REFRESH_PATH,
    CONFIG_PATH,
    ENTERPRISE_MODELS_SCOPE,
    CHAT_COMPLETIONS_PATH,
    USER_RESOURCE_PATH,
    CHECKIN_ACTIVITY_STATUS_PATH,
    DAILY_CHECKIN_PATH,
    BILLING_REQUEST_TIMEOUT_MS,
    BUDDY_DEPLOYMENT_TYPE,
    PACKAGE_STATUS_EXPIRED,
    LOGIN_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    STATE_REQUEST_TIMEOUT_MS,
    REQUEST_TIMEOUT_MS,
    CODE_TOKEN_NOT_READY,
    CODE_ACCOUNT_NOT_READY,
    HTTP_HEADER_DOMAIN,
    HTTP_HEADER_ENTERPRISE_ID,
    HTTP_HEADER_TENANT_ID,
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
    WORKBUDDY,
    ALL_PRODUCTS,
    productById,
    resolveUserAgent,
    uaFamilyOf,
};
