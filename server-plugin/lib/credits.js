'use strict';
/**
 * 积分 / 额度客户端（移植自 dsh-codearts-auth 的 lib/credits.js）。
 *
 * 三个端点，全部是 `POST` + 空 JSON 体（`{}`）：
 *
 *   余额查询  POST /v2/billing/meter/get-user-resource          两个产品通用
 *   签到状态  POST /v2/billing/meter/checkin-activity-status    仅中国版
 *   领取      POST /v2/billing/meter/daily-checkin              仅中国版
 *
 * 三条实测结论（不要凭直觉改）：
 *
 * 1. **余额查询两版都有**，签到只有中国版有。两者是独立能力 —— 不能因为
 *    国际版没有签到就推断它也查不到余额。
 *
 * 2. **状态查询必须用 `checkin-activity-status`**，不能用 `checkin-status`。后者
 *    返回占位数据（active:false / checkin_dates:null / claim_button_text:""），
 *    会让人误判成「活动未开启」。
 *
 * 3. **不需要 X-Device-Token（图灵盾）**。静态分析曾以为是主要门槛，实测不带
 *    该头也能查到状态并真实领取成功。
 *
 * 与源实现的一处刻意差异：这里把「失败」做成带 reason 的结果对象，而不是返回
 * null。面板要能把「查不到（网络/未登录）」与「余额为 0」区分开 —— 把网络故障
 * 显示成 0 积分会误导用户以为自己用完了额度。
 */
const {
    USER_RESOURCE_PATH,
    CHECKIN_ACTIVITY_STATUS_PATH,
    DAILY_CHECKIN_PATH,
    BILLING_REQUEST_TIMEOUT_MS,
    BUDDY_DEPLOYMENT_TYPE,
    PACKAGE_STATUS_EXPIRED,
    HTTP_HEADER_DOMAIN,
    HTTP_HEADER_PRODUCT,
    HTTP_HEADER_PRODUCT_CODE,
    HTTP_HEADER_ENTERPRISE_ID,
    HTTP_HEADER_TENANT_ID,
} = require('./product');

const { rawRequest } = require('./oauth');

/** 服务端「今天已签到」业务码（实测）。 */
const CODE_ALREADY_CLAIMED = 10001;
/** 静态分析列出的备选码表：1001=已领取 1002=无资格 1003=活动结束。 */
const CODE_ALREADY_CLAIMED_ALT = 1001;
const CODE_NO_QUALIFICATION = 1002;
const CODE_ACTIVITY_ENDED = 1003;

// ── 安全读取 JSON 字段 ──

function readString(source, key) {
    return typeof source?.[key] === 'string' ? source[key] : '';
}

function readBool(source, key) {
    return source?.[key] === true;
}

function readNumber(source, key) {
    const value = source?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readStringArray(source, key) {
    const value = source?.[key];
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

/**
 * 读取数值字段，优先取带 `Precise` 后缀的精确版本。
 *
 * 实测：`CapacityRemain` = 247（整数、截断），`CapacityRemainPrecise` = "247.87"
 * （字符串、两位小数）。IDE 显示的是后者，故精确值优先；缺失或无法解析时回退
 * 整数版，保证老响应格式仍能读出数字。
 */
function readPreciseNumber(source, baseKey) {
    const precise = source?.[`${baseKey}Precise`];
    if (typeof precise === 'string') {
        const parsed = Number.parseFloat(precise);
        if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof precise === 'number' && Number.isFinite(precise)) return precise;
    return readNumber(source, baseKey);
}

/**
 * 把额度规整为两位小数。
 *
 * 用乘法取整而不是 `toFixed` 后 parse：后者对负数与极大值行为不一致，且返回
 * 字符串会污染数值类型。服务端的精确值本身带浮点噪声（如 55.67000031），多包
 * 相加会把噪声显式化，展示到分即可。
 */
function roundCredits(value) {
    return Math.round(value * 100) / 100;
}

/** 由产品配置与凭据构造计费请求头。 */
function creditsRequestHeaders(credential, product) {
    const headers = {
        Authorization: `Bearer ${credential.access_token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // X-Domain 以**产品配置**为准，不优先用凭据里的 domain（那只是登录时域名的
        // 快照，跨产品迁移过的旧凭据会写错区域）。
        [HTTP_HEADER_DOMAIN]: product.apiDomain || credential.domain || '',
        // 计费端点这里发的是**部署类型** SaaS，不是归属名 —— 与对话端点不同。
        [HTTP_HEADER_PRODUCT]: BUDDY_DEPLOYMENT_TYPE,
        [HTTP_HEADER_PRODUCT_CODE]: product.productCode,
        'User-Agent': product.userAgent,
    };
    if (typeof credential.user_id === 'string' && credential.user_id.length > 0) {
        headers['X-User-Id'] = credential.user_id;
    }
    if (typeof credential.enterprise_id === 'string' && credential.enterprise_id.length > 0) {
        headers[HTTP_HEADER_ENTERPRISE_ID] = credential.enterprise_id;
        headers[HTTP_HEADER_TENANT_ID] = credential.enterprise_id;
    }
    return headers;
}

/** 一次计费请求；网络异常收敛成结果对象，不抛出。 */
async function postBilling(path, credential, product, options = {}) {
    try {
        const { status, body } = await rawRequest(
            'POST',
            `${product.endpoint}${path}`,
            creditsRequestHeaders(credential, product),
            options.timeoutMs ?? BILLING_REQUEST_TIMEOUT_MS,
            {},
        );
        return { ok: true, status, body };
    } catch (error) {
        // 保留原始消息（含超时/连接重置等信号），不吞诊断信息。
        return { ok: false, reason: 'network', message: error instanceof Error ? error.message : String(error) };
    }
}

/** 从 `get-user-resource` 的一个 Account 条目解析资源包。 */
function parseCreditPackage(entry) {
    const name = readString(entry, 'PackageName')
        || readString(entry, 'SubProductName')
        || readString(entry, 'PackageCode');
    const unit = readString(entry, 'CapacityUnit') || readString(entry, 'OriginUnit');
    const status = entry?.Status;
    const expiredTime = readString(entry, 'ExpiredTime');
    // 失效判定：Status 显式为已过期，或存在已过去的 ExpiredTime。
    const expiredAt = expiredTime.length > 0 ? Date.parse(expiredTime.replace(' ', 'T')) : Number.NaN;
    const active = status !== PACKAGE_STATUS_EXPIRED
        && !(Number.isFinite(expiredAt) && Date.now() >= expiredAt);
    return {
        name,
        unit,
        // 余额取**本周期**口径（CycleCapacityRemain），不是终身口径 CapacityRemain。
        remaining: readPreciseNumber(entry, 'CycleCapacityRemain'),
        total: readPreciseNumber(entry, 'CycleCapacitySize'),
        used: readPreciseNumber(entry, 'CycleCapacityUsed'),
        active,
        cycleStartTime: readString(entry, 'CycleStartTime'),
        cycleEndTime: readString(entry, 'CycleEndTime'),
        expiredTime,
    };
}

/**
 * 解析 `get-user-resource` 响应。
 *
 * `data` 是**双层嵌套**：`data.Response.Data.Accounts[]` —— 与签到端点的单层
 * `data` 不同，是本接口最容易解析错的地方，逐层校验。
 *
 * 只累加**有效**包的本周期余额：失效包里的额度服务端仍会返回，但不能用于扣费，
 * 并进总额会让数字虚高（实测某账号因此从 155.67 变成 655.67）。失效包的余额
 * 单独汇总为 expiredTotal，供面板提示「另有 N 已失效」。
 *
 * @returns {{total:number, packages:Array<any>, expiredTotal:number}|null}
 */
function parseUserResource(body) {
    if (typeof body !== 'object' || body === null) return null;
    if (body.code !== 0) return null;

    const outer = body.data;
    if (typeof outer !== 'object' || outer === null) return null;
    const response = outer.Response;
    if (typeof response !== 'object' || response === null) return null;
    const inner = response.Data;
    if (typeof inner !== 'object' || inner === null) return null;
    const accounts = inner.Accounts;
    if (!Array.isArray(accounts)) return null;

    const packages = [];
    for (const item of accounts) {
        if (typeof item !== 'object' || item === null) continue;
        packages.push(parseCreditPackage(item));
    }

    const total = roundCredits(packages.reduce((sum, pkg) => sum + (pkg.active ? pkg.remaining : 0), 0));
    const expiredTotal = roundCredits(packages.reduce((sum, pkg) => sum + (pkg.active ? 0 : pkg.remaining), 0));
    return { total, packages, expiredTotal };
}

/**
 * 查询账号积分余额。
 * @returns {Promise<{ok:true, total:number, packages:Array<any>, expiredTotal:number, fetchedAt:number}
 *   | {ok:false, reason:string, message:string, code?:number}>}
 */
async function fetchCreditBalance(credential, product) {
    const result = await postBilling(USER_RESOURCE_PATH, credential, product);
    if (!result.ok) return result;

    if (result.status !== 200) {
        const code = typeof result.body?.code === 'number' ? result.body.code : undefined;
        return {
            ok: false,
            reason: 'http',
            code,
            message: `HTTP ${result.status}${code === undefined ? '' : ` code=${code}`}`,
        };
    }
    if (result.body?.code !== 0) {
        return {
            ok: false,
            reason: 'business',
            code: typeof result.body?.code === 'number' ? result.body.code : undefined,
            message: readString(result.body, 'message') || readString(result.body, 'msg') || '业务码非 0',
        };
    }
    const parsed = parseUserResource(result.body);
    if (parsed === null) {
        return { ok: false, reason: 'shape', message: '响应结构不是预期的 data.Response.Data.Accounts' };
    }
    return { ok: true, ...parsed, fetchedAt: Date.now() };
}

/**
 * 解析签到状态响应。
 * @returns {{active:boolean, todayCheckedIn:boolean, streakDays:number, dailyCredit:number,
 *   todayCredit:number, isStreakDay:boolean, totalCredits:number, checkinDates:string[],
 *   activityName:string, endTime:string}|null}
 */
function parseCheckinStatus(body) {
    if (typeof body !== 'object' || body === null) return null;
    if (body.code !== 0) return null;
    const data = body.data;
    if (typeof data !== 'object' || data === null) return null;
    return {
        active: readBool(data, 'active'),
        todayCheckedIn: readBool(data, 'today_checked_in'),
        streakDays: readNumber(data, 'streak_days'),
        dailyCredit: readNumber(data, 'daily_credit'),
        todayCredit: readNumber(data, 'today_credit'),
        isStreakDay: readBool(data, 'is_streak_day'),
        totalCredits: readNumber(data, 'total_credits'),
        checkinDates: readStringArray(data, 'checkin_dates'),
        activityName: readString(data, 'activity_name'),
        endTime: readString(data, 'end_time'),
    };
}

/** 查询签到活动状态（仅 supportsCheckin 的产品）。 */
async function fetchCheckinStatus(credential, product) {
    const result = await postBilling(CHECKIN_ACTIVITY_STATUS_PATH, credential, product);
    if (!result.ok) return result;
    if (result.status !== 200) {
        return { ok: false, reason: 'http', message: `HTTP ${result.status}` };
    }
    if (result.body?.code !== 0) {
        return { ok: false, reason: 'business', message: readString(result.body, 'message') || '业务码非 0' };
    }
    const parsed = parseCheckinStatus(result.body);
    if (parsed === null) return { ok: false, reason: 'shape', message: '响应缺少 data' };
    return { ok: true, ...parsed };
}

/**
 * 解析领取响应。
 *
 * 判定**以响应体 code 为准**：重复领取是 HTTP 400 + code 10001，只看状态码会把
 * 幂等情况误报成失败。
 * @returns {{kind:'claimed'|'already-claimed'|'inactive'|'failed', credit?:number,
 *   streakDays?:number, isStreakDay?:boolean, delayedMessage?:string, code?:number, message:string}}
 */
function parseClaimResult(httpStatus, body) {
    const code = typeof body?.code === 'number' ? body.code : -1;
    const message = readString(body, 'msg') || readString(body, 'message');

    if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
        return { kind: 'already-claimed', code, message: message || '今天已签到' };
    }
    if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
        return { kind: 'inactive', code, message: message || '当前无领取资格' };
    }
    if (httpStatus !== 200 || code !== 0) {
        return { kind: 'failed', code, message: message || `HTTP ${httpStatus}` };
    }
    const data = body.data;
    if (typeof data !== 'object' || data === null) {
        return { kind: 'failed', code, message: '领取响应缺少 data 字段' };
    }
    const delayedMessage = readString(data, 'message');
    return {
        kind: 'claimed',
        code,
        message: '领取成功',
        credit: readNumber(data, 'credit'),
        streakDays: readNumber(data, 'streak_days'),
        isStreakDay: readBool(data, 'is_streak_day'),
        ...(delayedMessage.length > 0 ? { delayedMessage } : {}),
    };
}

/** 执行每日签到领取。 */
async function claimDailyCheckin(credential, product) {
    const result = await postBilling(DAILY_CHECKIN_PATH, credential, product);
    if (!result.ok) {
        return { kind: 'failed', code: -1, message: result.message };
    }
    return parseClaimResult(result.status, result.body);
}

module.exports = {
    CODE_ALREADY_CLAIMED,
    CODE_NO_QUALIFICATION,
    creditsRequestHeaders,
    readPreciseNumber,
    roundCredits,
    parseCreditPackage,
    parseUserResource,
    parseCheckinStatus,
    parseClaimResult,
    fetchCreditBalance,
    fetchCheckinStatus,
    claimDailyCheckin,
};
