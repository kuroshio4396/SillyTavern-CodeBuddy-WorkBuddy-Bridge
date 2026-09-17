/**
 * cbwb-bridge 独立冒烟测试（不需要启动 SillyTavern）。
 * 从 plugins/cbwb-bridge/ 起，require('express') 会向上找到 ST 自带的 node_modules。
 * 跑完即删。
 */
'use strict';
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 用隔离的数据目录，避免自测把真实 config.json 的 proxyPort 改掉
// （自测会因 8791 被占用而顺延到 8792，若共用目录就会写坏线上配置）。
const SANDBOX_DIR = path.join(os.tmpdir(), `cbwb-selftest-${process.pid}`);
fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
fs.mkdirSync(SANDBOX_DIR, { recursive: true });
process.env.CBWB_BRIDGE_DATA_DIR = SANDBOX_DIR;

const PLUGIN = path.join(__dirname, 'index.js');
const plugin = require(PLUGIN);

const app = express();
app.use(express.json({ limit: '50mb' }));

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
    if (condition) {
        pass++;
        console.log(`  PASS  ${name}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`);
    }
}

(async () => {
    // 先故意占住默认端口：这样插件必须走「顺延」分支，顺便验证顺延**不会写回配置**
    // （写回会把 ST 的 custom_url 与实际端口搞脱节）。抢不到就跳过该项。
    const net = require('node:net');
    let blocker = null;
    try {
        blocker = net.createServer();
        await new Promise((resolve, reject) => {
            blocker.once('error', reject);
            blocker.listen(8791, '127.0.0.1', resolve);
        });
    } catch {
        blocker = null;
    }
    const shiftTest = blocker !== null;
    console.log(shiftTest
        ? '\n[0] 端口顺延（已占住 8791）'
        : '\n[0] 端口顺延 —— SKIP（8791 已被占用，抢不到，无法构造顺延场景）');

    const router = express.Router();
    await plugin.init(router);
    app.use('/api/plugins/cbwb-bridge', router);

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const apiPort = server.address().port;
    const api = (p) => `http://127.0.0.1:${apiPort}${p}`;

    console.log('\n[1] 管理接口');
    const ping = await (await fetch(api('/api/plugins/cbwb-bridge/ping'))).json();
    check('GET /ping 返回 ok', ping.ok === true, ping);
    check('插件 id 正确', ping.plugin === 'cbwb-bridge', ping);
    const proxyPort = ping.proxy;
    const v1 = `http://127.0.0.1:${proxyPort}/v1`;

    const status = await (await fetch(api('/api/plugins/cbwb-bridge/status'))).json();
    check('GET /status 返回 ok', status.ok === true);
    check('状态含两个渠道', !!status.channels?.codebuddy && !!status.channels?.workbuddy, Object.keys(status.channels || {}));
    check('未登录时 loggedIn=false', status.channels.codebuddy.loggedIn === false);
    check('状态含代理端口', Number.isInteger(status.proxy?.port), status.proxy);
    check('localBaseUrl 指向 127.0.0.1', /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(status.proxy?.localBaseUrl || ''), status.proxy?.localBaseUrl);

    const modelsApi = await (await fetch(api('/api/plugins/cbwb-bridge/models'))).json();
    check('GET /models 返回模型清单', modelsApi.ok === true && Array.isArray(modelsApi.models));
    check('模型含两个渠道前缀', modelsApi.models.some(m => m.channel === 'codebuddy') && modelsApi.models.some(m => m.channel === 'workbuddy'));

    console.log('\n[2] 代理端点');
    const health = await (await fetch(`${v1}/health`)).json();
    check('GET /v1/health 返回 ok', health.ok === true, health);

    const listRes = await fetch(`${v1}/models`);
    const list = await listRes.json();
    check('GET /v1/models HTTP 200', listRes.status === 200, listRes.status);
    check('GET /v1/models 是 list 结构', list.object === 'list' && Array.isArray(list.data));
    check('含 codebuddy/ 前缀模型', list.data.some(m => m.id.startsWith('codebuddy/')), list.data.slice(0, 3).map(m => m.id));
    check('含 workbuddy/ 前缀模型', list.data.some(m => m.id.startsWith('workbuddy/')), list.data.slice(0, 3).map(m => m.id));
    check('兜底目录里 CodeBuddy 有 hy3', list.data.some(m => m.id === 'codebuddy/hy3'));
    check('兜底目录里 WorkBuddy 有 gpt-5.6-sol', list.data.some(m => m.id === 'workbuddy/gpt-5.6-sol'));
    check('已过滤 auto', !list.data.some(m => m.upstream_id === 'auto'));
    check('条目带 owned_by', typeof list.data[0]?.owned_by === 'string', list.data[0]?.owned_by);

    console.log('\n[3] 未登录时的对话请求应被明确拒绝');
    const chatRes = await fetch(`${v1}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'codebuddy/hy3', messages: [{ role: 'user', content: 'ping' }], stream: true }),
    });
    const chatBody = await chatRes.json();
    check('未登录返回 401', chatRes.status === 401, chatRes.status);
    check('错误体是 OpenAI 风格', chatBody.error?.type === 'authentication_error', chatBody);
    check('错误提示指向面板登录', /登录/.test(chatBody.error?.message || ''), chatBody.error?.message);

    console.log('\n[4] 参数校验');
    const badModel = await fetch(`${v1}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [], stream: true }),
    });
    check('空模型名返回 401 或 400', [400, 401].includes(badModel.status), badModel.status);

    const badJson = await fetch(`${v1}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
    });
    check('非法 JSON 返回 400', badJson.status === 400, badJson.status);

    const notFound = await fetch(`${v1}/nope`);
    check('未知路径返回 404', notFound.status === 404, notFound.status);

    console.log('\n[5] 配置读写');
    const cfg = await (await fetch(api('/api/plugins/cbwb-bridge/config'))).json();
    check('GET /config 返回配置', cfg.ok === true && cfg.config?.proxyPort >= 1, cfg.config);
    if (shiftTest) {
        check('端口顺延到 8792', proxyPort === 8792, proxyPort);
        check('顺延**不写回** proxyPort（仍是配置里的 8791）', cfg.config.proxyPort === 8791, cfg.config.proxyPort);
        check('localBaseUrl 如实反映实际端口', cfg.config.localBaseUrl === `http://127.0.0.1:${proxyPort}/v1`, cfg.config.localBaseUrl);
    }
    const upd = await (await fetch(api('/api/plugins/cbwb-bridge/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultChannel: 'workbuddy' }),
    })).json();
    check('POST /config 切换默认渠道生效', upd.config?.defaultChannel === 'workbuddy', upd.config?.defaultChannel);
    // 恢复
    await fetch(api('/api/plugins/cbwb-bridge/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultChannel: 'codebuddy' }),
    });

    console.log('\n[6] 模型显隐（黑名单制）');
    const toggle = await (await fetch(api('/api/plugins/cbwb-bridge/models/toggle'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'codebuddy', id: 'hy3', hidden: true }),
    })).json();
    check('隐藏 hy3 生效', toggle.hidden?.includes('hy3'), toggle);
    const afterHide = await (await fetch(`${v1}/models`)).json();
    check('隐藏后 /v1/models 不再含 codebuddy/hy3', !afterHide.data.some(m => m.id === 'codebuddy/hy3'));
    await fetch(api('/api/plugins/cbwb-bridge/models/toggle'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'codebuddy', id: 'hy3', hidden: false }),
    });
    const afterShow = await (await fetch(`${v1}/models`)).json();
    check('取消隐藏后重新出现', afterShow.data.some(m => m.id === 'codebuddy/hy3'));

    console.log('\n[7] 登录接口（不实际授权，只验通路）');
    const loginStart = await fetch(api('/api/plugins/cbwb-bridge/login/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'nope' }),
    });
    check('未知渠道返回 400', loginStart.status === 400, loginStart.status);

    const badLogout = await fetch(api('/api/plugins/cbwb-bridge/logout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'nope' }),
    });
    check('未知渠道登出返回 400', badLogout.status === 400, badLogout.status);

    // 真实调用 auth/state（不需要凭据）——验证与上游协议通路
    const realLogin = await fetch(api('/api/plugins/cbwb-bridge/login/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'codebuddy' }),
    });
    const realLoginBody = await realLogin.json();
    if (realLogin.status === 200) {
        check('auth/state 拿到 state', typeof realLoginBody.state === 'string' && realLoginBody.state.length > 0);
        check('auth/state 拿到 authUrl', /^https?:\/\//.test(realLoginBody.authUrl || ''), realLoginBody.authUrl);
        check('authUrl 是服务端下发的登录页', /^https:\/\/(copilot\.tencent\.com|www\.codebuddy\.cn|www\.workbuddy\.ai)\//.test(realLoginBody.authUrl || ''), realLoginBody.authUrl);
        check('authUrl 未被本地重建（仍带 state 参数）', /[?&]state=/.test(realLoginBody.authUrl || ''), realLoginBody.authUrl);
        const loginStatus = await (await fetch(api(`/api/plugins/cbwb-bridge/login/status?state=${encodeURIComponent(realLoginBody.state)}`))).json();
        check('登录会话可查询', loginStatus.found === true && loginStatus.status === 'waiting', loginStatus);
        await fetch(api('/api/plugins/cbwb-bridge/login/cancel'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: realLoginBody.state }),
        });
        console.log('        （真实网络链路可用：已向 copilot.tencent.com 取到 state）');
    } else {
        console.log(`        SKIP  真实 auth/state 调用失败（HTTP ${realLogin.status}：${realLoginBody.error}）—— 不影响本地逻辑验收`);
    }

    // WorkBuddy 的 authUrl 必须被追加 version 与 loginSessionId（appendSessionParams=true）
    const wbLogin = await fetch(api('/api/plugins/cbwb-bridge/login/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'workbuddy' }),
    });
    const wbBody = await wbLogin.json();
    if (wbLogin.status === 200) {
        const url = new URL(wbBody.authUrl);
        check('WorkBuddy authUrl 追加 version=5.5.2', url.searchParams.get('version') === '5.5.2', wbBody.authUrl);
        check('WorkBuddy authUrl 追加 loginSessionId', !!url.searchParams.get('loginSessionId'), wbBody.authUrl);
        check('WorkBuddy authUrl 保留服务端 state', !!url.searchParams.get('state'), wbBody.authUrl);
        await fetch(api('/api/plugins/cbwb-bridge/login/cancel'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: wbBody.state }),
        });
        console.log('        （真实网络链路可用：已向 www.workbuddy.ai 取到 state）');
    } else {
        console.log(`        SKIP  WorkBuddy auth/state 调用失败（HTTP ${wbLogin.status}：${wbBody.error}）`);
    }

    console.log('\n[8] 积分 / 额度（纯解析）');
    const credits = require(path.join(__dirname, 'lib', 'credits.js'));

    // 真实结构：data.Response.Data.Accounts[]，双层嵌套
    const sample = {
        code: 0,
        data: {
            Response: {
                Data: {
                    Accounts: [
                        {
                            PackageName: 'CodeBuddy 专业版',
                            CapacityUnit: 'credit',
                            Status: 0,
                            CycleCapacityRemain: 247,
                            CycleCapacityRemainPrecise: '247.87',
                            CycleCapacitySizePrecise: '500.00',
                            CycleCapacityUsedPrecise: '252.13',
                            CycleEndTime: '2026-10-01 00:00:00',
                        },
                        { SubProductName: '试用包', Status: 0, CycleCapacityRemainPrecise: '7.80' },
                        { PackageCode: 'PKG-OLD', Status: 3, CycleCapacityRemainPrecise: '400.00', ExpiredTime: '2026-06-02 00:00:00' },
                        { PackageName: '时间已过的包', Status: 0, CycleCapacityRemainPrecise: '50.00', ExpiredTime: '2020-01-01 00:00:00' },
                    ],
                },
            },
        },
    };
    const parsed = credits.parseUserResource(sample);
    check('解析出 total', parsed && parsed.total === 255.67, parsed?.total);
    check('优先用 Precise 精确值（247.87 而非截断的 247）', parsed?.packages?.[0]?.remaining === 247.87, parsed?.packages?.[0]?.remaining);
    check('失效包不计入 total（Status=3）', parsed?.packages?.[2]?.active === false, parsed?.packages?.[2]?.active);
    check('失效包不计入 total（ExpiredTime 已过）', parsed?.packages?.[3]?.active === false, parsed?.packages?.[3]?.active);
    check('expiredTotal 单列失效余额', parsed?.expiredTotal === 450, parsed?.expiredTotal);
    check('包名回退链 PackageName→SubProductName→PackageCode',
        parsed?.packages?.[1]?.name === '试用包' && parsed?.packages?.[2]?.name === 'PKG-OLD',
        parsed?.packages?.map(p => p.name));
    check('缺 Precise 时回退整数（247 路径不可达则说明解析器写错）', credits.readPreciseNumber({ CycleCapacityRemain: 12 }, 'CycleCapacityRemain') === 12);

    check('业务码非 0 → null（区分「查不到」与「0 积分」）', credits.parseUserResource({ code: 1, data: {} }) === null);
    check('缺 data.Response.Data.Accounts → null', credits.parseUserResource({ code: 0, data: { Response: {} } }) === null);
    check('Accounts 不是数组 → null', credits.parseUserResource({ code: 0, data: { Response: { Data: { Accounts: 'x' } } } }) === null);

    const checkinSample = { code: 0, data: { active: true, today_checked_in: false, streak_days: 3, daily_credit: 100, activity_name: '每日签到', checkin_dates: ['2026-09-16'] } };
    const checkin = credits.parseCheckinStatus(checkinSample);
    check('签到状态解析：active / 未签到 / 连续天数', checkin?.active === true && checkin?.todayCheckedIn === false && checkin?.streakDays === 3, checkin);

    const claimed = credits.parseClaimResult(200, { code: 0, data: { credit: 100, streak_days: 4, is_streak_day: true } });
    check('领取成功解析出 credit 与连续天数', claimed.kind === 'claimed' && claimed.credit === 100 && claimed.streakDays === 4, claimed);
    const already = credits.parseClaimResult(400, { code: 10001, msg: '今天已签到，请明天再来' });
    check('重复领取（HTTP 400 + code 10001）判为已领取而非失败', already.kind === 'already-claimed', already);
    check('无资格（code 1002）判为 inactive', credits.parseClaimResult(200, { code: 1002 }).kind === 'inactive');
    check('code 0 但缺 data 判为 failed', credits.parseClaimResult(200, { code: 0 }).kind === 'failed');

    console.log('\n[9] 积分接口（沙箱内未登录）');
    const creditsApi = await (await fetch(api('/api/plugins/cbwb-bridge/credits'))).json();
    check('GET /credits 返回 ok', creditsApi.ok === true);
    check('两个渠道都有条目', !!creditsApi.channels?.codebuddy && !!creditsApi.channels?.workbuddy, Object.keys(creditsApi.channels || {}));
    check('未登录时 available=false', creditsApi.channels.codebuddy.available === false);
    check('未登录时 reason=not-logged-in（不是 0 积分）', creditsApi.channels.codebuddy.reason === 'not-logged-in', creditsApi.channels.codebuddy);
    check('条目带 displayName', typeof creditsApi.channels.codebuddy.displayName === 'string', creditsApi.channels.codebuddy.displayName);

    const single = await (await fetch(api('/api/plugins/cbwb-bridge/credits?channel=codebuddy'))).json();
    check('?channel= 只返回该渠道', Object.keys(single.channels).length === 1 && !!single.channels.codebuddy, Object.keys(single.channels));

    const badCreditsChannel = await fetch(api('/api/plugins/cbwb-bridge/credits?channel=nope'));
    check('未知渠道返回 400', badCreditsChannel.status === 400, badCreditsChannel.status);

    const claimWb = await fetch(api('/api/plugins/cbwb-bridge/credits/checkin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'workbuddy' }),
    });
    check('WorkBuddy 无签到活动 → 400', claimWb.status === 400, claimWb.status);

    const claimCb = await fetch(api('/api/plugins/cbwb-bridge/credits/checkin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'codebuddy' }),
    });
    const claimCbBody = await claimCb.json();
    check('CodeBuddy 未登录时领取被拒 → 400', claimCb.status === 400, claimCb.status);
    check('拒绝原因说明是未登录', /未登录/.test(claimCbBody.error || ''), claimCbBody.error);

    const claimBad = await fetch(api('/api/plugins/cbwb-bridge/credits/checkin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'nope' }),
    });
    check('未知渠道领取返回 400', claimBad.status === 400, claimBad.status);

    // 真实网络：用假凭据打真实计费端点，验证「端点存在且可达、请求头能被服务端接受」。
    // 拿到任何 HTTP 层响应即说明端点真实存在；reason==='network' 说明连不上（沙箱断网）——
    // 这是环境问题而非实现问题，所以只打印不判失败。
    const fakeBalance = await credits.fetchCreditBalance(
        { access_token: 'fake.invalid.token', user_id: '', enterprise_id: '', domain: '' },
        require(path.join(__dirname, 'lib', 'product.js')).CODEBUDDY,
    );
    if (fakeBalance.reason === 'network') {
        console.log(`        SKIP  计费端点连不上（${fakeBalance.message}）—— 环境网络问题，不影响本地逻辑验收`);
    } else {
        console.log(`        （真实计费端点可达：假凭据得到 ${fakeBalance.reason}${fakeBalance.code === undefined ? '' : ` code=${fakeBalance.code}`}）`);
    }

    console.log('\n[10] 非流式聚合（上游只支持流式，必须由代理聚合）');
    const { aggregateUpstreamCompletion } = require(path.join(__dirname, 'lib', 'proxy.js'));

    const mkStream = (text, chunkSize = 0) => new ReadableStream({
        start(controller) {
            const bytes = Buffer.from(text, 'utf8');
            if (chunkSize <= 0) {
                controller.enqueue(bytes);
            } else {
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    controller.enqueue(bytes.subarray(i, i + chunkSize));
                }
            }
            controller.close();
        },
    });
    const agg = (text, chunkSize) => aggregateUpstreamCompletion(
        { body: mkStream(text, chunkSize) }, 'fallback-model', new AbortController(),
    );

    const simpleSse = [
        'data: {"id":"abc","created":1700000000,"model":"hy3","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":""}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"想一想"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"content":"，世界"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        '',
        'data: [DONE]',
        '',
    ].join('\n') + '\n';

    const completion = await agg(simpleSse);
    check('聚合出 chat.completion 结构', completion.object === 'chat.completion' && Array.isArray(completion.choices), completion.object);
    check('正文被拼接完整', completion.choices[0].message.content === '你好，世界', completion.choices[0].message.content);
    check('思考内容被拼接（reasoning_content）', completion.choices[0].message.reasoning_content === '想一想', completion.choices[0].message.reasoning_content);
    check('finish_reason 透传', completion.choices[0].finish_reason === 'stop', completion.choices[0].finish_reason);
    check('usage 透传', completion.usage?.total_tokens === 15, completion.usage);
    check('id / model / created 透传', completion.id === 'abc' && completion.model === 'hy3' && completion.created === 1700000000,
        [completion.id, completion.model, completion.created]);

    // 同一个 SSE 拆成 7 字节的小块投喂 —— 行会被切成两半，必须靠行缓冲拼回
    const split = await agg(simpleSse, 7);
    check('SSE 被切成碎片也能正确聚合（行缓冲）', split.choices[0].message.content === '你好，世界', split.choices[0].message.content);

    const toolSse = [
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_","arguments":"{\\"a\\""}}]}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":":1}"}}]}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
    ].join('\n') + '\n';
    const toolCompletion = await agg(toolSse);
    const call = toolCompletion.choices[0].message.tool_calls?.[0];
    check('工具调用 id 保留', call?.id === 'call_1', call);
    check('工具调用 name 分片归并', call?.function?.name === 'get_weather', call?.function?.name);
    check('工具调用 arguments 分片归并', call?.function?.arguments === '{"a":1}', call?.function?.arguments);
    check('finish_reason=tool_calls 透传', toolCompletion.choices[0].finish_reason === 'tool_calls', toolCompletion.choices[0].finish_reason);

    const emptySse = 'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n';
    const noDone = await agg(emptySse);
    check('没有 [DONE] 也能正常收尾', noDone.choices[0].message.content === 'x', noDone.choices[0].message.content);
    check('缺 id 时自动生成', typeof noDone.id === 'string' && noDone.id.startsWith('chatcmpl-'), noDone.id);
    check('未给 finish_reason 时回退 stop', noDone.choices[0].finish_reason === 'stop', noDone.choices[0].finish_reason);

    console.log('\n[11] 首条 system 兜底（WorkBuddy 要求 messages[0] 必须是 system）');
    const { ensureLeadingSystemMessage } = require(path.join(__dirname, 'lib', 'proxy.js'));
    const productsForMsg = require(path.join(__dirname, 'lib', 'product.js'));
    const cbProduct = productsForMsg.CODEBUDDY;
    const wbProduct = productsForMsg.WORKBUDDY;

    check('WorkBuddy 声明了 requiresLeadingSystemMessage', wbProduct.requiresLeadingSystemMessage === true,
        wbProduct.requiresLeadingSystemMessage);
    check('CodeBuddy 未声明该能力（不误补）', !cbProduct.requiresLeadingSystemMessage,
        cbProduct.requiresLeadingSystemMessage);

    const userOnly = [{ role: 'user', content: 'hi' }];
    const patched = ensureLeadingSystemMessage(userOnly, wbProduct);
    check('WorkBuddy 首条为 user → 补一条 system',
        patched.length === 2 && patched[0].role === 'system', JSON.stringify(patched));
    check('补入的 system 是空内容（实测上游接受）', patched[0].content === '', patched[0].content);
    check('原有消息顺序不变', patched[1] === userOnly[0], patched[1]);
    check('不修改调用方传入的原数组', userOnly.length === 1, userOnly.length);

    const alreadySystem = [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }];
    check('WorkBuddy 首条已是 system → 原样返回（同一引用）',
        ensureLeadingSystemMessage(alreadySystem, wbProduct) === alreadySystem);

    const cbPatched = ensureLeadingSystemMessage(userOnly, cbProduct);
    check('CodeBuddy 首条为 user → 不补（该产品无此约束）', cbPatched === userOnly, cbPatched.length);

    check('空消息数组原样返回',
        Array.isArray(ensureLeadingSystemMessage([], wbProduct)) && ensureLeadingSystemMessage([], wbProduct).length === 0);
    check('非数组入参原样返回', ensureLeadingSystemMessage(undefined, wbProduct) === undefined);
    check('缺 product 时不补', ensureLeadingSystemMessage(userOnly, undefined) === userOnly);

    const afterSystem = [{ role: 'user', content: 'hi' }, { role: 'system', content: '你是助手' }];
    const late = ensureLeadingSystemMessage(afterSystem, wbProduct);
    check('system 排在后面也要补到最前（上游只看首条）',
        late.length === 3 && late[0].role === 'system' && late[2] === afterSystem[1], JSON.stringify(late));

    await plugin.exit();
    server.close();
    blocker?.close();
    fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });

    console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
    console.error('自测崩溃：', error);
    fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
    process.exit(2);
});
