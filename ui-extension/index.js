/**
 * CodeBuddy / WorkBuddy 桥接 —— SillyTavern 前端扩展面板
 *
 * 职责：
 *  1. 调服务器插件（/api/plugins/cbwb-bridge/*）完成登录、查状态、管模型显隐；
 *  2. 把 SillyTavern 的 Custom (OpenAI-compatible) 源一键指向本地代理（方案 A：快照 + 一键切换）；
 *  3. 「恢复原连接」把原 custom_url / custom_model / source 原样还原。
 *
 * 本扩展不修改 SillyTavern 源码，只读写它自己的 oai_settings 与 extension_settings。
 */
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { chat_completion_sources, oai_settings } from '../../../openai.js';
// 注意：script.js 在 public 根目录（served as /script.js），不在 /scripts/ 下，
// 所以比其他两个模块多一层 ../。
import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'cbwb-bridge';
const SETTINGS_KEY = 'cbwb_bridge';
const API_BASE = '/api/plugins/cbwb-bridge';
/** 登录轮询上限（与服务端 5 分钟超时对齐）。 */
const LOGIN_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 1500;

/** 面板运行态（不落盘）。 */
const state = {
    status: null,
    models: [],
    /** channelId → 积分查询结果（来自服务端 /credits） */
    credits: {},
    /** 上次成功刷新积分的时刻 */
    creditsAt: 0,
    /** channelId → 登录轮询定时器（按渠道隔离，两个渠道可同时登录） */
    loginTimers: {},
    /** channelId → { state, authUrl, startedAt } */
    pendingByChannel: {},
};

// ── 工具 ──

function toast(level, message) {
    const text = `[桥接] ${message}`;
    if (typeof toastr !== 'undefined' && toastr[level]) {
        toastr[level](text);
    } else if (level === 'error') {
        console.error(text);
    } else {
        console.log(text);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getSettings() {
    let settings = extension_settings[SETTINGS_KEY];
    if (!settings || typeof settings !== 'object') {
        settings = {};
        extension_settings[SETTINGS_KEY] = settings;
    }
    if (settings.snapshot === undefined) settings.snapshot = null;
    if (typeof settings.preferredModel !== 'string') settings.preferredModel = '';
    return settings;
}

async function apiGet(path) {
    const response = await fetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers: getRequestHeaders({ omitContentType: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
}

async function apiPost(path, body) {
    const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
}

/** 给按钮加忙状态，避免重复点击。 */
async function withBusy($button, fn) {
    if ($button.hasClass('cbwb-busy')) return;
    $button.addClass('cbwb-busy');
    try {
        await fn();
    } finally {
        $button.removeClass('cbwb-busy');
    }
}

function formatTime(iso) {
    if (!iso) return '未知';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '未知';
    return date.toLocaleString();
}

function formatRemaining(ms) {
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '未知';
    if (ms <= 0) return '已过期';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 48) return `${hours} 小时 ${rest} 分`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function badge(text, kind) {
    return `<span class="cbwb-badge${kind ? ` cbwb-${kind}` : ''}">${escapeHtml(text)}</span>`;
}

/** 额度显示：两位小数（与服务端的两位小数规整口径一致）。 */
function formatCredits(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    return number.toFixed(2);
}

/** 额度单位：取第一个有效资源包声明的单位，没有就回落到 credit。 */
function creditUnit(credits) {
    const pkg = (credits?.packages || []).find(item => item.active && item.unit);
    return pkg?.unit || 'credit';
}

/** 未拿到额度时，把服务端给的 reason 翻译成用户能看懂的一句话。 */
function creditsUnavailableText(credits) {
    switch (credits?.reason) {
        case 'not-logged-in':
            return '未登录 —— 登录后即可看到剩余积分。';
        case 'unknown-channel':
            return credits.message || '未知渠道。';
        case 'network':
            return `查询失败（网络不通）：${credits.message || ''}`;
        case 'http':
            return `查询失败（${credits.message || 'HTTP 错误'}）—— 若持续出现，可能是凭据已失效，试试登出后重新登录。`;
        case 'business':
            return `查询失败（业务码 ${credits.code ?? '?'}）：${credits.message || ''}`;
        case 'shape':
            return `响应格式不符合预期：${credits.message || ''}`;
        default:
            return `暂时查不到剩余积分${credits?.message ? `：${credits.message}` : ''}`;
    }
}

// ── 面板渲染 ──

function renderProxy() {
    const status = state.status;
    const url = status?.proxy?.localBaseUrl || '-';
    $('#cbwb_proxy_url').text(url);
    $('.cbwb-proxy-url').text(url);

    const running = !!status?.proxy?.running;
    $('#cbwb_proxy_badge')
        .attr('class', `cbwb-badge ${running ? 'cbwb-ok' : 'cbwb-bad'}`)
        .text(running ? `运行中 · :${status.proxy.port}` : '未运行');

    if (status?.config?.defaultChannel) {
        $('#cbwb_default_channel').val(status.config.defaultChannel);
    }
}

function renderConnect() {
    const settings = getSettings();
    const localBaseUrl = state.status?.proxy?.localBaseUrl || '';
    const currentSource = oai_settings.chat_completion_source;
    const currentUrl = oai_settings.custom_url || '';
    const currentModel = oai_settings.custom_model || '';

    $('#cbwb_current_source').text(currentSource || '(未设置)');
    $('#cbwb_current_url').text(currentUrl || '(空)');
    $('#cbwb_current_model').text(currentModel || '(空)');

    const linked = currentSource === chat_completion_sources.CUSTOM && localBaseUrl && currentUrl === localBaseUrl;
    $('#cbwb_connect_badge')
        .attr('class', `cbwb-badge ${linked ? 'cbwb-ok' : 'cbwb-warn'}`)
        .text(linked ? '已接入本地桥接' : '未接入本地桥接');

    // 快照展示
    const snapshot = settings.snapshot;
    if (snapshot) {
        $('#cbwb_snapshot_body').html(
            `源 <code>${escapeHtml(snapshot.chat_completion_source || '(空)')}</code>　`
            + `URL <code>${escapeHtml(snapshot.custom_url || '(空)')}</code>　`
            + `模型 <code>${escapeHtml(snapshot.custom_model || '(空)')}</code><br>`
            + `<span style="opacity:.7">捕获于 ${escapeHtml(formatTime(snapshot.capturedAt))}</span>　`
            + `<a class="cbwb-resnapshot" style="cursor:pointer;text-decoration:underline">重设快照为当前配置</a>`,
        );
    } else {
        $('#cbwb_snapshot_body').text('尚未建立快照。首次点「接入本地桥接」时会自动记录原配置。');
    }

    // 警告
    const warnings = [];
    if (snapshot && snapshot.chat_completion_source === chat_completion_sources.CUSTOM
        && snapshot.custom_url && snapshot.custom_url !== localBaseUrl) {
        warnings.push(`⚠ 原连接也是 Custom 源（${snapshot.custom_url}）。接入后它会暂时失效，点「恢复原连接」可还原。`);
    }
    if (linked) {
        warnings.push('✓ 当前已指向本地代理，改完模型显隐后直接可用。');
    }
    $('#cbwb_apply_warn').text(warnings.join('\n'));
}

function renderChannelCard(channelId, channel) {
    const loggedIn = channel.loggedIn;
    const needsRelogin = channel.schedule?.needsRelogin;
    const credential = channel.credential;

    let statusBadge;
    if (needsRelogin) statusBadge = badge('需重新登录', 'bad');
    else if (loggedIn) statusBadge = badge('已登录', 'ok');
    else statusBadge = badge('未登录');

    const accountRows = loggedIn
        ? `
        <div class="cbwb-kv"><span class="cbwb-k">账号</span><span class="cbwb-v">${escapeHtml(credential?.nickname || '(无昵称)')} ${credential?.user_id ? `<code>${escapeHtml(credential.user_id)}</code>` : ''}</span></div>
        <div class="cbwb-kv"><span class="cbwb-k">凭据到期</span><span class="cbwb-v">${escapeHtml(formatTime(channel.schedule?.expiresAt))}<span style="opacity:.65">（剩余 ${escapeHtml(formatRemaining(channel.schedule?.expiresInMs))}）</span></span></div>
        <div class="cbwb-kv"><span class="cbwb-k">静默续期</span><span class="cbwb-v">${channel.schedule?.armed ? '已武装（提前 1 小时刷新）' : '未武装'}${credential?.has_refresh_token ? '' : ' · 无 refresh_token'}</span></div>
        <div class="cbwb-kv"><span class="cbwb-k">令牌尾号</span><span class="cbwb-v"><code>…${escapeHtml(credential?.token_tail || '')}</code></span></div>
        <div class="cbwb-kv"><span class="cbwb-k">剩余积分</span><span class="cbwb-v cbwb-credit-inline">${creditInlineHtml(channelId)}</span></div>`
        : `
        <div class="cbwb-kv"><span class="cbwb-k">说明</span><span class="cbwb-v">点「登录」后会打开浏览器授权页，本面板自动检测结果。</span></div>`;

    const lastRefresh = channel.schedule?.lastRefresh;
    const refreshRow = lastRefresh
        ? `<div class="cbwb-kv"><span class="cbwb-k">最近续期</span><span class="cbwb-v">${escapeHtml(formatTime(new Date(lastRefresh.at).toISOString()))} · ${lastRefresh.ok ? '成功' : `失败（${escapeHtml(lastRefresh.error || '')}）`}</span></div>`
        : '';

    return `
    <div class="cbwb-channel" data-channel="${escapeHtml(channelId)}">
        <div class="cbwb-card-head">
            <span class="cbwb-card-title">${escapeHtml(channel.displayName)}</span>
            ${statusBadge}
        </div>
        <div class="cbwb-kv"><span class="cbwb-k">端点</span><span class="cbwb-v"><code>${escapeHtml(channel.endpoint)}</code></span></div>
        <div class="cbwb-kv"><span class="cbwb-k">platform</span><span class="cbwb-v"><code>${escapeHtml(channel.platform)}</code>　UA 分档 ${escapeHtml(String((channel.userAgentRules || []).length))} 条</span></div>
        ${accountRows}
        ${refreshRow}
        <div class="cbwb-kv"><span class="cbwb-k">模型目录</span><span class="cbwb-v">${channel.models.count} 个（显示 ${channel.models.visible}）· 来源 ${channel.models.source === 'remote' ? '远端' : '内置兜底'}</span></div>
        <div class="cbwb-btn-row">
            <div class="menu_button cbwb-btn" data-act="login">${loggedIn ? '重新登录' : '登录'}</div>
            ${loggedIn ? '<div class="menu_button cbwb-btn" data-act="refresh">手动续期</div>' : ''}
            ${loggedIn ? '<div class="menu_button cbwb-btn" data-act="logout">登出</div>' : ''}
        </div>
        <div class="cbwb-login-pending" hidden></div>
    </div>`;
}

function renderChannels() {
    const channels = state.status?.channels || {};
    const order = ['codebuddy', 'workbuddy'];
    const html = order
        .filter(id => channels[id])
        .map(id => renderChannelCard(id, channels[id]))
        .join('');
    $('#cbwb_channels').html(html);

    // 恢复仍在等待的登录会话
    for (const [channelId, pending] of Object.entries(state.pendingByChannel)) {
        renderPending(channelId, pending);
    }

    // 接入用的模型下拉（默认只列两条渠道的前若干个，全部列出）
    const options = state.models
        .filter(model => !model.hidden)
        .map(model => `<option value="${escapeHtml(model.exposedId)}">${escapeHtml(model.exposedId)}　（${escapeHtml(model.name)}）</option>`)
        .join('');
    const $select = $('#cbwb_connect_model');
    const previous = getSettings().preferredModel || $select.val();
    $select.html(options);
    if (previous && state.models.some(model => model.exposedId === previous && !model.hidden)) {
        $select.val(previous);
    }

    // 卡片刚被重建，把积分那一行补回去
    updateChannelCreditRows();
}

/** 渠道卡里的「剩余积分」一行（紧凑）。 */
function creditInlineHtml(channelId) {
    const credits = state.credits[channelId];
    if (!credits) return '<span style="opacity:.6">查询中…</span>';
    if (!credits.available) return `<span style="opacity:.6">${escapeHtml(creditsUnavailableText(credits))}</span>`;
    const expired = credits.expiredTotal > 0
        ? `<span style="opacity:.6">（另有 ${escapeHtml(formatCredits(credits.expiredTotal))} 已失效）</span>`
        : '';
    const checkin = credits.checkin?.available && credits.checkin.active && !credits.checkin.todayCheckedIn
        ? `<span style="opacity:.75">　今日签到可领 +${escapeHtml(String(credits.checkin.dailyCredit ?? 0))}</span>`
        : '';
    return `<b>${escapeHtml(formatCredits(credits.total))}</b> <span style="opacity:.65">${escapeHtml(creditUnit(credits))}</span> ${expired}${checkin}`;
}

/** 渲染积分明细里的资源包列表。 */
function renderCreditPackages(credits) {
    const packages = credits.packages || [];
    if (packages.length === 0) return '<div class="cbwb-credit-sub">账户下没有资源包。</div>';
    const rows = packages.map(pkg => {
        const dead = pkg.active ? '' : ' cbwb-pkg-dead';
        const name = pkg.name || '(未命名资源包)';
        const remain = `${formatCredits(pkg.remaining)}${pkg.unit ? ` ${pkg.unit}` : ''}`;
        const totalPart = pkg.total > 0 ? ` / ${formatCredits(pkg.total)}` : '';
        const cycle = pkg.cycleEndTime ? `　有效期至 ${escapeHtml(pkg.cycleEndTime)}` : '';
        const deadTag = pkg.active ? '' : '　<span>已失效</span>';
        return `<div class="cbwb-pkg-row${dead}"><span class="cbwb-pkg-remain">${escapeHtml(remain)}${escapeHtml(totalPart)}</span>　${escapeHtml(name)}${cycle}${deadTag}</div>`;
    }).join('');
    return `<div class="cbwb-credit-pkg">${rows}</div>`;
}

/** 渲染签到区（仅中国版）。 */
function renderCheckin(channelId, credits) {
    const checkin = credits.checkin;
    if (!checkin) return '';
    if (!checkin.available) {
        // 签到查不到不影响余额展示，静默略过（网络抖动时不要把面板弄脏）
        return '';
    }
    if (!checkin.active) {
        return `<div class="cbwb-checkin"><span class="cbwb-checkin-text">${escapeHtml(checkin.activityName || '每日签到')}：当前无进行中的活动。</span></div>`;
    }

    const streaks = checkin.streakDays > 0 ? `连续 ${checkin.streakDays} 天` : '尚未开始连续';
    const text = checkin.todayCheckedIn
        ? `今日已签到${checkin.todayCredit > 0 ? `（+${checkin.todayCredit}）` : ''} · ${streaks}`
        : `今日未签到 · ${streaks}${checkin.dailyCredit > 0 ? ` · 可领 +${checkin.dailyCredit}` : ''}`;
    const action = checkin.todayCheckedIn
        ? badge('已签到', 'ok')
        : `<div class="menu_button cbwb-btn" data-act="claim" data-channel="${escapeHtml(channelId)}">领取每日积分</div>`;
    return `<div class="cbwb-checkin"><span class="cbwb-checkin-text">${escapeHtml(text)}</span>${action}</div>`;
}

function renderCredits() {
    const order = ['codebuddy', 'workbuddy'];
    const blocks = order.map(channelId => {
        const credits = state.credits[channelId];
        const displayName = credits?.displayName
            || state.status?.channels?.[channelId]?.displayName
            || channelId;
        if (!credits) {
            return `<div class="cbwb-credit-block"><div class="cbwb-credit-head"><span class="cbwb-credit-name">${escapeHtml(displayName)}</span><span class="cbwb-credit-total">—</span></div><div class="cbwb-credit-unavailable">查询中…</div></div>`;
        }
        if (!credits.available) {
            return `<div class="cbwb-credit-block"><div class="cbwb-credit-head"><span class="cbwb-credit-name">${escapeHtml(displayName)}</span><span class="cbwb-credit-total">—</span></div><div class="cbwb-credit-unavailable">${escapeHtml(creditsUnavailableText(credits))}</div></div>`;
        }
        const activeCount = (credits.packages || []).filter(pkg => pkg.active).length;
        const subParts = [`${activeCount} 个有效资源包`];
        if (credits.expiredTotal > 0) subParts.push(`另有 ${formatCredits(credits.expiredTotal)} 已失效（未计入）`);
        subParts.push(`更新于 ${new Date(credits.fetchedAt).toLocaleTimeString()}`);
        return `
        <div class="cbwb-credit-block" data-channel="${escapeHtml(channelId)}">
            <div class="cbwb-credit-head">
                <span class="cbwb-credit-name">${escapeHtml(displayName)}</span>
                <span class="cbwb-credit-total">${escapeHtml(formatCredits(credits.total))}<span class="cbwb-credit-unit">${escapeHtml(creditUnit(credits))}</span></span>
            </div>
            <div class="cbwb-credit-sub">${escapeHtml(subParts.join(' · '))}</div>
            <details class="cbwb-credit-detail">
                <summary>资源包明细（${(credits.packages || []).length}）</summary>
                ${renderCreditPackages(credits)}
            </details>
            ${renderCheckin(channelId, credits)}
        </div>`;
    }).join('');

    $('#cbwb_credits').html(blocks);

    const available = order.filter(id => state.credits[id]?.available).length;
    const loggedIn = order.filter(id => state.status?.channels?.[id]?.loggedIn).length;
    $('#cbwb_credits_badge')
        .attr('class', `cbwb-badge ${available > 0 ? 'cbwb-ok' : (loggedIn > 0 ? 'cbwb-bad' : '')}`)
        .text(available > 0 ? `${available} / ${order.length} 渠道已查到` : (loggedIn > 0 ? '查询失败' : '未登录'));

    updateChannelCreditRows();
}

/** 只更新渠道卡里的「剩余积分」文本，避免整卡重渲染打断用户操作。 */
function updateChannelCreditRows() {
    for (const channelId of ['codebuddy', 'workbuddy']) {
        const $cell = $(`.cbwb-channel[data-channel="${channelId}"] .cbwb-credit-inline`);
        if ($cell.length > 0) $cell.html(creditInlineHtml(channelId));
    }
}

/** 拉取积分（force 时绕过服务端短缓存）。 */
async function refreshCredits(force = false) {
    const data = await apiGet(`/credits${force ? '?force=1' : ''}`);
    state.credits = data.channels || {};
    state.creditsAt = Date.now();
    renderCredits();
    return state.credits;
}

function renderModels() {
    const models = state.models;
    $('#cbwb_models_badge').text(`共 ${models.length} 个 · 已隐藏 ${models.filter(model => model.hidden).length} 个`);

    const groups = [
        { id: 'codebuddy', title: 'CodeBuddy（腾讯）' },
        { id: 'workbuddy', title: 'WorkBuddy（国际版）' },
    ];

    const html = groups.map(group => {
        const list = models.filter(model => model.channel === group.id);
        if (list.length === 0) return '';
        const rows = list.map(model => {
            const meta = [];
            if (model.contextWindow) meta.push(`${Math.round(model.contextWindow / 1000)}k`);
            if (model.supportsImages) meta.push('视觉');
            return `
            <div class="cbwb-model-row">
                <input type="checkbox" data-channel="${escapeHtml(model.channel)}" data-id="${escapeHtml(model.upstreamId)}" ${model.hidden ? '' : 'checked'}>
                <span class="cbwb-model-id" title="${escapeHtml(model.exposedId)}">${escapeHtml(model.exposedId)}　<span style="opacity:.6">${escapeHtml(model.name)}</span></span>
                <span class="cbwb-model-meta">${escapeHtml(meta.join(' · '))}</span>
            </div>`;
        }).join('');
        return `<div class="cbwb-model-group-title">${escapeHtml(group.title)}（${list.length}）</div>${rows}`;
    }).join('');

    $('#cbwb_model_groups').html(html || '<div class="cbwb-hint cbwb-small">暂无模型。请先登录任一渠道，或点「重拉模型目录」。</div>');
}

/** 渲染某渠道的登录等待提示。 */
function renderPending(channelId, pending) {
    const $box = $(`.cbwb-channel[data-channel="${channelId}"] .cbwb-login-pending`);
    if ($box.length === 0) return;
    if (!pending) {
        $box.attr('hidden', true).empty();
        return;
    }
    $box.removeAttr('hidden').html(
        `<div>等待浏览器授权中… 若授权页没有自动打开，<a class="cbwb-reopen">点此手动打开</a>。</div>`
        + `<div style="opacity:.75;margin-top:3px;word-break:break-all">${escapeHtml(pending.authUrl || '')}</div>`
        + (pending.error ? `<div style="margin-top:3px">错误：${escapeHtml(pending.error)}</div>` : ''),
    );
    $box.data('authUrl', pending.authUrl || '');
}

// ── 数据加载 ──

async function refreshStatus() {
    const status = await apiGet('/status');
    state.status = status;

    // 同步服务端发现的等待中登录会话（已经在本地轮询的不重复启动）
    for (const pending of status.pendingLogins || []) {
        if (pending.status === 'waiting' && !state.loginTimers[pending.channel]) {
            state.pendingByChannel[pending.channel] = { state: pending.state, authUrl: '', channel: pending.channel };
            startLoginPolling(pending.state, pending.channel);
        }
    }

    renderProxy();
    renderConnect();
    renderChannels();

    if (status.channels?.codebuddy?.schedule?.needsRelogin || status.channels?.workbuddy?.schedule?.needsRelogin) {
        toast('warning', '有渠道的 refresh_token 已失效，请重新登录。');
    }
    return status;
}

async function refreshModels() {
    const data = await apiGet('/models');
    state.models = Array.isArray(data.models) ? data.models : [];
    renderModels();
    renderChannels();
    return state.models;
}

async function refreshAll(showToast = false) {
    try {
        await refreshStatus();
        await refreshModels();
        if (showToast) toast('success', '状态已刷新。');
    } catch (error) {
        toast('error', `刷新失败：${error.message}`);
    }
}

/** 刷新积分；失败只提示不抛，避免拖垮其它刷新流程。 */
async function refreshCreditsQuiet(force = false, showToast = false) {
    try {
        await refreshCredits(force);
        if (showToast) toast('success', '积分已刷新。');
    } catch (error) {
        if (showToast) toast('error', `积分查询失败：${error.message}`);
        else console.warn(`[${MODULE_NAME}] 积分查询失败：`, error);
    }
}

/** 领取每日积分（仅中国版有该活动）。 */
async function claimCheckin(channelId) {
    const data = await apiPost('/credits/checkin', { channel: channelId });
    const result = data.result || {};
    const streak = result.streakDays > 0 ? `，连续 ${result.streakDays} 天` : '';
    switch (result.kind) {
        case 'claimed':
            toast('success', `签到成功：+${result.credit ?? 0} 积分${streak}。`);
            break;
        case 'already-claimed':
            toast('info', result.message || '今天已经签到过了。');
            break;
        case 'inactive':
            toast('warning', result.message || '当前没有可领取的签到活动。');
            break;
        default:
            toast('error', `签到失败：${result.message || '未知原因'}`);
    }
    if (result.delayedMessage) toast('info', result.delayedMessage);
    // 领完立刻强制重查，让余额与签到状态同步
    await refreshCreditsQuiet(true);
}

// ── 登录 ──

function stopLoginPolling(channelId) {
    if (state.loginTimers[channelId]) {
        clearTimeout(state.loginTimers[channelId]);
    }
    state.loginTimers[channelId] = null;
}

function startLoginPolling(loginState, channelId) {
    stopLoginPolling(channelId);
    const startedAt = Date.now();

    const finish = (pending) => {
        stopLoginPolling(channelId);
        delete state.pendingByChannel[channelId];
        renderPending(channelId, pending || null);
    };

    const tick = async () => {
        if (Date.now() - startedAt > LOGIN_POLL_TIMEOUT_MS) {
            finish({ error: '等待授权超时（5 分钟），请重新发起登录。' });
            return;
        }
        try {
            const result = await apiGet(`/login/status?state=${encodeURIComponent(loginState)}`);
            if (result.status === 'done') {
                finish(null);
                toast('success', `${channelId} 登录成功。`);
                await refreshAll();
                // 新登录的账号应立即显示积分
                await refreshCreditsQuiet(true);
                return;
            }
            if (result.status === 'error') {
                finish({ authUrl: result.authUrl, error: result.error });
                toast('error', `${channelId} 登录失败：${result.error}`);
                return;
            }
            if (result.status === 'unknown') {
                finish({ error: '登录会话已在服务端失效，请重新发起。' });
                return;
            }
            // waiting：继续轮询
            state.pendingByChannel[channelId] = {
                state: loginState,
                authUrl: result.authUrl || state.pendingByChannel[channelId]?.authUrl || '',
                channel: channelId,
            };
            renderPending(channelId, state.pendingByChannel[channelId]);
            state.loginTimers[channelId] = setTimeout(tick, LOGIN_POLL_INTERVAL_MS);
        } catch (error) {
            renderPending(channelId, { error: `轮询失败：${error.message}` });
            state.loginTimers[channelId] = setTimeout(tick, LOGIN_POLL_INTERVAL_MS * 2);
        }
    };

    state.loginTimers[channelId] = setTimeout(tick, LOGIN_POLL_INTERVAL_MS);
}

async function startLogin(channelId) {
    const result = await apiPost('/login/start', { channel: channelId });
    state.pendingByChannel[channelId] = { state: result.state, authUrl: result.authUrl, channel: channelId };
    renderPending(channelId, state.pendingByChannel[channelId]);

    const opened = window.open(result.authUrl, '_blank');
    if (!opened) {
        toast('warning', '浏览器拦截了弹窗，请点面板里的「点此手动打开」。');
    } else {
        toast('info', '已打开授权页，请在浏览器里完成登录。');
    }
    startLoginPolling(result.state, channelId);
}

// ── 接入 / 恢复（方案 A） ──

/** 等待 SillyTavern 把模型下拉填好。 */
function waitForModelOptions(timeoutMs = 25000) {
    return new Promise(resolve => {
        const started = Date.now();
        const check = () => {
            const count = $('#model_custom_select_fill option').length || $('#model_custom_select option').length;
            if (count > 0) return resolve(true);
            if (Date.now() - started > timeoutMs) return resolve(false);
            setTimeout(check, 300);
        };
        check();
    });
}

function setCustomModel(model) {
    oai_settings.custom_model = model;
    $('#custom_model_id').val(model).trigger('input');
    const $option = $('#model_custom_select option').filter(function () { return $(this).val() === model; });
    if ($option.length > 0) {
        $('#model_custom_select').val(model);
    }
}

async function applyBridge() {
    const status = state.status || await refreshStatus();
    const localBaseUrl = status?.proxy?.localBaseUrl;
    if (!localBaseUrl) throw new Error('本地代理未运行，请检查服务器插件是否已加载。');

    const settings = getSettings();
    const targetModel = String($('#cbwb_connect_model').val() || settings.preferredModel || '');

    // 1) 快照原配置（只捕获一次，保留「原连接」语义）
    if (!settings.snapshot) {
        settings.snapshot = {
            chat_completion_source: oai_settings.chat_completion_source,
            custom_url: oai_settings.custom_url,
            custom_model: oai_settings.custom_model,
            capturedAt: new Date().toISOString(),
        };
        toast('info', `已记录原连接快照：${settings.snapshot.custom_url || '(空)'}`);
    }

    // 2) 切到 Custom 源
    oai_settings.chat_completion_source = chat_completion_sources.CUSTOM;
    $('#chat_completion_source').val(chat_completion_sources.CUSTOM).trigger('change');

    // 3) 写入本地代理地址（在 source change 之后再写，避免被 change 流程覆盖）
    oai_settings.custom_url = localBaseUrl;
    $('#custom_api_url_text').val(localBaseUrl).trigger('input');
    saveSettingsDebounced();

    // 4) 触发 Connect，让 SillyTavern 走 /status 拉取模型列表
    $('#api_button_openai').trigger('click');
    const ready = await waitForModelOptions();

    if (targetModel) {
        setCustomModel(targetModel);
        settings.preferredModel = targetModel;
    } else if (!oai_settings.custom_model) {
        // 没指定就让 ST 自己选第一个
        const first = $('#model_custom_select option').first().val();
        if (first) setCustomModel(String(first));
    }
    saveSettingsDebounced();

    renderConnect();
    toast('success', ready
        ? `已接入本地桥接：${localBaseUrl}`
        : `已接入本地桥接：${localBaseUrl}（模型下拉尚未就绪，可稍后点一次 Connect 刷新）`);
}

async function restoreBridge() {
    const settings = getSettings();
    const snapshot = settings.snapshot;
    if (!snapshot) throw new Error('没有可恢复的快照。');

    oai_settings.chat_completion_source = snapshot.chat_completion_source || chat_completion_sources.OPENAI;
    $('#chat_completion_source').val(oai_settings.chat_completion_source).trigger('change');

    oai_settings.custom_url = snapshot.custom_url || '';
    $('#custom_api_url_text').val(snapshot.custom_url || '').trigger('input');

    oai_settings.custom_model = snapshot.custom_model || '';
    $('#custom_model_id').val(snapshot.custom_model || '').trigger('input');

    saveSettingsDebounced();
    $('#api_button_openai').trigger('click');

    renderConnect();
    toast('success', `已恢复原连接：${snapshot.custom_url || snapshot.chat_completion_source}`);
}

// ── 事件绑定 ──

function bindEvents() {
    $('#cbwb_refresh_all').on('click', function () {
        void withBusy($(this), async () => {
            await refreshAll(true);
            await refreshCreditsQuiet(true);
        });
    });

    $('#cbwb_credits_refresh').on('click', function () {
        void withBusy($(this), () => refreshCreditsQuiet(true, true));
    });

    $('#cbwb_refresh_catalog').on('click', function () {
        void withBusy($(this), async () => {
            try {
                await apiPost('/models/refresh', {});
                await refreshModels();
                await refreshStatus();
                toast('success', '模型目录已重新拉取。');
            } catch (error) {
                toast('error', `重拉失败：${error.message}`);
            }
        });
    });

    $('#cbwb_copy_url').on('click', async function () {
        const url = state.status?.proxy?.localBaseUrl;
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            toast('success', `已复制：${url}`);
        } catch {
            toast('warning', `复制失败，请手动复制：${url}`);
        }
    });

    $('#cbwb_default_channel').on('change', function () {
        const channel = String($(this).val());
        void withBusy($(this), async () => {
            try {
                await apiPost('/config', { defaultChannel: channel });
                toast('success', `默认渠道已切换为 ${channel}。`);
            } catch (error) {
                toast('error', `切换失败：${error.message}`);
            }
        });
    });

    $('#cbwb_apply').on('click', function () {
        void withBusy($(this), async () => {
            try {
                await applyBridge();
            } catch (error) {
                toast('error', `接入失败：${error.message}`);
            }
        });
    });

    $('#cbwb_restore').on('click', function () {
        void withBusy($(this), async () => {
            try {
                await restoreBridge();
            } catch (error) {
                toast('error', `恢复失败：${error.message}`);
            }
        });
    });

    // 重设快照
    $(document).on('click', '.cbwb-resnapshot', () => {
        const settings = getSettings();
        settings.snapshot = {
            chat_completion_source: oai_settings.chat_completion_source,
            custom_url: oai_settings.custom_url,
            custom_model: oai_settings.custom_model,
            capturedAt: new Date().toISOString(),
        };
        saveSettingsDebounced();
        renderConnect();
        toast('success', '快照已重设为当前配置。');
    });

    // 渠道卡按钮（事件委托）
    $('#cbwb_channels').on('click', '[data-act]', function () {
        const $button = $(this);
        const channelId = $button.closest('.cbwb-channel').data('channel');
        const action = String($button.data('act'));

        void withBusy($button, async () => {
            try {
                if (action === 'login') {
                    await startLogin(channelId);
                } else if (action === 'logout') {
                    await apiPost('/logout', { channel: channelId });
                    toast('success', `${channelId} 已登出。`);
                    await refreshAll();
                } else if (action === 'refresh') {
                    const result = await apiPost('/refresh', { channel: channelId });
                    toast('success', `${channelId} 续期成功（剩余 ${formatRemaining(result.schedule?.expiresInMs)}）。`);
                    await refreshAll();
                }
            } catch (error) {
                toast('error', `操作失败：${error.message}`);
            }
        });
    });

    // 积分卡里的「领取每日积分」（事件委托，卡片会被整体重渲染）
    $('#cbwb_credits').on('click', '[data-act="claim"]', function () {
        const $button = $(this);
        const channelId = String($button.data('channel'));
        void withBusy($button, async () => {
            try {
                await claimCheckin(channelId);
            } catch (error) {
                toast('error', `签到失败：${error.message}`);
            }
        });
    });

    // 手动打开授权页
    $('#cbwb_channels').on('click', '.cbwb-reopen', function () {
        const url = $(this).closest('.cbwb-login-pending').data('authUrl')
            || state.pendingByChannel[$(this).closest('.cbwb-channel').data('channel')]?.authUrl;
        if (url) window.open(url, '_blank');
    });

    // 模型显隐开关
    $('#cbwb_model_groups').on('change', 'input[type="checkbox"]', function () {
        const $input = $(this);
        const channel = String($input.data('channel'));
        const id = String($input.data('id'));
        const hidden = !$input.prop('checked');
        void (async () => {
            try {
                await apiPost('/models/toggle', { channel, id, hidden });
                const target = state.models.find(model => model.channel === channel && model.upstreamId === id);
                if (target) target.hidden = hidden;
                renderChannels();
                $('#cbwb_models_badge').text(`共 ${state.models.length} 个 · 已隐藏 ${state.models.filter(model => model.hidden).length} 个`);
            } catch (error) {
                $input.prop('checked', !hidden);
                toast('error', `保存失败：${error.message}`);
            }
        })();
    });

    // 面板上的「接入后使用的模型」变化时记一下偏好
    $('#cbwb_connect_model').on('change', function () {
        getSettings().preferredModel = String($(this).val() || '');
        saveSettingsDebounced();
    });

    // Custom 源设置变化时刷新接入状态显示
    $('#custom_api_url_text, #custom_model_id').on('input', () => renderConnect());
    $('#chat_completion_source').on('change', () => renderConnect());
}

// ── 启动 ──

async function addPanel() {
    const html = await renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'settings');
    $('#extensions_settings2').append(html);
    bindEvents();
    await refreshAll();
    await refreshCreditsQuiet();
    // 每 60 秒静默刷新一次代理与渠道状态（登录轮询进行中就跳过，避免打扰）
    setInterval(() => {
        if (!Object.values(state.loginTimers).some(Boolean)) void refreshAll();
    }, 60000);
    // 积分单独用更长的周期（3 分钟）刷新：服务端还有一层 60 秒缓存，
    // 这样对上游计费接口的请求频率是可控的。
    setInterval(() => {
        if (!Object.values(state.loginTimers).some(Boolean)) void refreshCreditsQuiet();
    }, 180000);
}

jQuery(async () => {
    try {
        await addPanel();
        console.log(`[${MODULE_NAME}] 面板已加载`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] 面板加载失败：`, error);
    }
});
