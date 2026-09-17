'use strict';
/**
 * OpenAI 兼容代理 —— 挂在 127.0.0.1 的**独立 HTTP 监听**上。
 *
 * 为什么不放在 `/api/plugins/<id>` 下：
 * ST 的 CSRF 中间件在 server-main.js:202 注册，服务器插件在 :313 才挂载；
 * 浏览器调的 UI 接口带 X-CSRF-Token 所以能过，但 ST **服务端**去请求 custom_url
 * 时不会带这个头。所以对话代理必须是另一个监听，天然绕开 ST 的中间件栈。
 *
 * 对外暴露：
 *   GET  /v1/health               健康检查
 *   GET  /v1/models               合并两条渠道的模型列表
 *   POST /v1/chat/completions     对话（流式 / 非流式）
 *   POST /v1/completions          文本补全（把 prompt 包成 user 消息后转 chat）
 *
 * 只做最小改写：剥渠道前缀、组装品牌头、SSE 原样管道回传。
 * ST 的 custom 分支已经会读 `delta.reasoning_content`，思考内容无需转换。
 *
 * ⚠️ 上游**只支持流式对话**：带 `stream:false` 请求会得到
 * `HTTP 400 code=11101 Non-stream chat request is currently not supported`。
 * 所以发给上游的请求**永远是流式**；客户端若要非流式，由本代理聚合 SSE 后
 * 返回一个完整的 chat.completion（见 aggregateUpstreamCompletion）。
 *
 * ⚠️ WorkBuddy 国际版**要求 `messages[0]` 是 system**，否则 400 code=11128
 * （文案被包装成「请求被安全策略拦截」）。本代理按产品能力自动补一条空 system
 * 兜底（见 ensureLeadingSystemMessage）。中国版无此约束。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const {
    CHAT_COMPLETIONS_PATH,
    HTTP_HEADER_DOMAIN,
    HTTP_HEADER_ENTERPRISE_ID,
    HTTP_HEADER_TENANT_ID,
    HTTP_HEADER_PRODUCT,
    HTTP_HEADER_PRODUCT_CODE,
} = require('./product');
const { RefreshTokenExpiredError } = require('./oauth');

/** 单次请求体上限（ST 会把整段上下文塞进来，留足余量）。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** 首 token 超时：冷启动 + 长提示词预填充都算在内。 */
const FIRST_TOKEN_TIMEOUT_MS = 180000;
/** chunk 间空闲超时：网关会静默断流，不能让 reader 无限挂起。 */
const CHUNK_IDLE_TIMEOUT_MS = 90000;

function log(...args) {
    console.log('[cbwb-bridge]', ...args);
}
function logError(...args) {
    console.error('[cbwb-bridge]', ...args);
}

/** 读取请求体（带体积上限）。 */
function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                settled = true;
                reject(new Error(`请求体超过上限（${MAX_BODY_BYTES} 字节）`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
    });
}

function sendJson(res, status, payload) {
    if (res.writableEnded) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
    });
    res.end(text);
}

/** OpenAI 风格的错误体。 */
function sendError(res, status, message, type = 'upstream_error') {
    sendJson(res, status, { error: { message, type, code: status } });
}

/**
 * 从 system 提示词派生 prompt_cache_key。
 *
 * 原插件实证：带上该字段后服务端启用前缀缓存，同一段 8k token 前缀的
 * prompt_cache_hit_tokens 从 0 变为 7808，费用差约 17 倍。
 * ST 每轮都会重发全部上下文，正是前缀缓存的最佳场景；用 system 提示词哈希
 * 做 key，同一角色卡/同一预设的连续对话可持续命中。
 */
function derivePromptCacheKey(messages) {
    if (!Array.isArray(messages)) return undefined;
    const part = messages
        .filter(message => message && message.role === 'system')
        .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')))
        .join('\n');
    if (part.length === 0) return undefined;
    return crypto.createHash('sha1').update(part).digest('hex').slice(0, 32);
}

/**
 * 按产品能力补齐首条 system 消息。
 *
 * WorkBuddy 国际版要求 `messages[0].role === 'system'`，否则上游直接 400
 * （code=11128，文案被包装成「请求被安全策略拦截」）。ST 在「未启用系统提示词」
 * 「把系统提示词排在后面」等情形下会出现首条为 user / assistant，此时补一条
 * 空 system 兜底即可 —— 实测空串、null、缺 content 键上游都接受。
 *
 * 返回新数组（不改动调用方传入的原始消息序列）；无需补齐时原样返回。
 */
function ensureLeadingSystemMessage(messages, product) {
    if (!product?.requiresLeadingSystemMessage) return messages;
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (messages[0] && messages[0].role === 'system') return messages;
    return [{ role: 'system', content: '' }, ...messages];
}

/** 组装发往上游的品牌头族。缺任一个都会让后台「使用端」归因显示为 `-`。 */
function upstreamHeaders(route, credential, userAgent) {
    const product = route.product;
    const headers = {
        Authorization: `Bearer ${credential.access_token}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        [HTTP_HEADER_DOMAIN]: credential.domain || product.apiDomain,
        [HTTP_HEADER_PRODUCT_CODE]: product.productCode,
        // 用量归属头族：X-Product 是**归属名**（产品名），不是部署类型 SaaS。
        'X-Agent-Purpose': 'conversation',
        'X-IDE-Name': product.attributionName,
        'X-IDE-Type': product.attributionName,
        'X-IDE-Version': product.clientVersion,
        [HTTP_HEADER_PRODUCT]: product.attributionName,
        // UA 按模型族分档，用上游模型名（不带渠道前缀）判定。
        'User-Agent': userAgent,
    };
    if (credential.enterprise_id) {
        headers[HTTP_HEADER_ENTERPRISE_ID] = credential.enterprise_id;
        headers[HTTP_HEADER_TENANT_ID] = credential.enterprise_id;
    }
    return headers;
}

/** 上游错误体 → 可读文案 + OpenAI 风格 type。 */
function classifyUpstreamError(status, text) {
    let code = 0;
    let message = text || '';
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.code === 'number') code = parsed.code;
            if (typeof parsed.message === 'string' && parsed.message.length > 0) message = parsed.message;
        }
    } catch {
        // 非 JSON，保持原文
    }

    if (status === 429) {
        const reset = /reset[_\s-]?time["'\s:]*([0-9TZ:.\-+]+)/i.exec(text || '');
        const hint = reset ? `（额度重置时间：${reset[1]}）` : '';
        return { type: 'rate_limit_exceeded', message: `上游限流，请稍后重试${hint}：${message}` };
    }
    if (status === 402 || code === 402) {
        return { type: 'insufficient_quota', message: `额度不足或未开通：${message}` };
    }
    if (status === 401 || status === 403) {
        return { type: 'authentication_error', message: `凭据已失效，请在桥接面板重新登录：${message}` };
    }
    if (status >= 500) {
        return { type: 'upstream_error', message: `上游服务异常（HTTP ${status}）：${message}` };
    }
    return { type: 'invalid_request_error', message: `上游拒绝请求（HTTP ${status}${code ? ` code=${code}` : ''}）：${message}` };
}

/**
 * 把上游 SSE 流聚合成一个非流式 `chat.completion`。
 *
 * 上游不支持非流式（见文件头说明），所以客户端要非流式时只能这样转。
 *
     * 两个必须小心的点：
     * 1. **增量字段按 index 归并**，不能按出现顺序拼。工具调用的 `id` / `name`
     *    只在第一个分片出现，`arguments` 分多个分片到达；用 index 建 Map 才稳。
     * 2. **按行切分 SSE**，不能对每个 TCP chunk 直接 `JSON.parse` —— 一个 chunk
     *    里可能有半行，也可能有多行。这里维护行缓冲。
     *
     * 还有一个容易漏的点：**必须用增量解码器**。多字节字符（中文尤其常见）会被
     * TCP 分块从中间切断，若对每个 chunk 单独 `toString('utf8')`，半个字符会变成
     * `\uFFFD`，正文里就出现 `你��，世界`。`StringDecoder` 会把不完整的字节尾部
     * 留到下一次 write 再拼。
     */
    async function aggregateUpstreamCompletion(upstream, fallbackModel, controller) {
        const reader = upstream.body.getReader();
        const decoder = new StringDecoder('utf8');
    let id = '';
    let created = Math.floor(Date.now() / 1000);
    let model = fallbackModel;
    let content = '';
    let reasoning = '';
    let finishReason = null;
    let usage = null;
    /** @type {Map<number, {id:string, type:string, function:{name:string, arguments:string}}>} */
    const toolCalls = new Map();
    let buffer = '';

    let idleTimer = null;
    const armIdle = (ms) => {
        if (idleTimer) clearTimeout(idleTimer);
        // 半开的 SSE 连接会让 read() 永久挂起，必须主动断开。
        idleTimer = setTimeout(() => controller.abort(), ms);
    };
    armIdle(FIRST_TOKEN_TIMEOUT_MS);

    const applyChunk = (chunk) => {
        if (typeof chunk.id === 'string' && chunk.id.length > 0) id = chunk.id;
        if (typeof chunk.created === 'number') created = chunk.created;
        if (typeof chunk.model === 'string' && chunk.model.length > 0) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string') content += delta.content;
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
            for (const part of delta.tool_calls) {
                const index = typeof part.index === 'number' ? part.index : 0;
                const acc = toolCalls.get(index)
                    || { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (typeof part.id === 'string' && part.id.length > 0) acc.id = part.id;
                if (typeof part.type === 'string' && part.type.length > 0) acc.type = part.type;
                if (part.function) {
                    if (typeof part.function.name === 'string') acc.function.name += part.function.name;
                    if (typeof part.function.arguments === 'string') acc.function.arguments += part.function.arguments;
                }
                toolCalls.set(index, acc);
            }
        }
    };

    const feed = (text) => {
        buffer += text;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload.length === 0 || payload === '[DONE]') continue;
            try {
                applyChunk(JSON.parse(payload));
            } catch {
                // 半截或非 JSON 的块直接跳过，不让它毁掉整段结果
            }
        }
    };

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                feed(decoder.write(Buffer.from(value)));
                armIdle(CHUNK_IDLE_TIMEOUT_MS);
            }
            // 冲掉解码器里可能残留的半个字符（正常情况下是空的）
            const tail = decoder.end();
            if (tail.length > 0) feed(tail);
            if (buffer.length > 0) feed('\n');
        } finally {
            if (idleTimer) clearTimeout(idleTimer);
        }

    const message = { role: 'assistant', content };
    if (reasoning.length > 0) message.reasoning_content = reasoning;
    if (toolCalls.size > 0) {
        message.tool_calls = [...toolCalls.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(entry => entry[1]);
    }

    const completion = {
        id: id || `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finishReason || 'stop', logprobs: null }],
    };
    if (usage) completion.usage = usage;
    return completion;
}

/**
 * 代理服务。
 *
 * @param {{
 *   catalog: import('./models').ModelCatalog,
 *   credentials: import('./credentials').CredentialStore,
 *   store: import('./store').ConfigStore,
 *   refreshCredential: (channelId: string) => Promise<any>,
 * }} deps
 */
function createProxyServer(deps) {
    const { catalog, credentials, store, refreshCredential } = deps;

    // ── 路由处理 ──

    async function handleModels(res) {
        const models = await catalog.listVisible();
        const created = Math.floor(Date.now() / 1000);
        sendJson(res, 200, {
            object: 'list',
            data: models.map(model => ({
                id: model.exposedId,
                object: 'model',
                created,
                owned_by: model.channelName,
                // 以下为非标准补充字段：ST 会忽略，但排障时很有用
                name: model.name,
                channel: model.channel,
                upstream_id: model.upstreamId,
                context_length: model.contextWindow,
                supports_images: model.supportsImages,
                reasoning_efforts: model.reasoningEfforts,
                catalog_source: model.source,
            })),
        });
    }

    function handleHealth(res) {
        const config = store.get();
        sendJson(res, 200, {
            ok: true,
            service: 'cbwb-bridge',
            time: new Date().toISOString(),
            defaultChannel: config.defaultChannel,
            channels: {
                codebuddy: { loggedIn: credentials.has('codebuddy') },
                workbuddy: { loggedIn: credentials.has('workbuddy') },
            },
        });
    }

    /** 把上游响应原样管道回客户端（SSE，带首 token / 空闲双阶段超时）。 */
    async function pipeSse(upstream, res, controller) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const reader = upstream.body.getReader();
        let firstTokenReceived = false;
        let sawDone = false;
        let timedOut = false;
        let timer = null;

        const arm = (ms) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timedOut = true;
                // 半开的 SSE 连接会让 read() 永久挂起，必须主动断开。
                controller.abort();
            }, ms);
        };
        arm(FIRST_TOKEN_TIMEOUT_MS);

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                const text = Buffer.from(value).toString('utf8');
                if (text.includes('[DONE]')) sawDone = true;
                if (!firstTokenReceived && text.trim().length > 0) firstTokenReceived = true;
                if (!res.writableEnded) res.write(value);
                arm(CHUNK_IDLE_TIMEOUT_MS);
            }
        } catch (error) {
            if (timedOut) {
                logError('上游流式响应超时，已主动断开');
            } else if (!controller.signal.aborted) {
                logError('SSE 管道中断：', error?.message || String(error));
            }
            if (!res.writableEnded) {
                const timeoutMs = firstTokenReceived ? CHUNK_IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS;
                res.write(`data: ${JSON.stringify({
                    error: {
                        message: timedOut
                            ? `上游${firstTokenReceived ? '流式响应空闲超时' : '首 token 超时'}（${Math.round(timeoutMs / 1000)}s 无数据）`
                            : `上游流式连接中断：${error?.message || String(error)}`,
                        type: timedOut ? 'timeout' : 'stream_error',
                    },
                })}\n\n`);
            }
        } finally {
            if (timer) clearTimeout(timer);
        }

        if (!res.writableEnded) {
            if (!sawDone) res.write('data: [DONE]\n\n');
            res.end();
        }
    }

    /**
     * 发送一次上游 chat 请求；401/403 时静默续期一次并重试。
     * @returns {Promise<{response?: Response, refreshFailed?: Error}>}
     */
    async function callUpstream(route, credential, bodyText, signal) {
        const url = `${route.product.endpoint}${CHAT_COMPLETIONS_PATH}`;
        const userAgent = catalog.describeRoute(route).userAgent;
        const doFetch = (cred) => fetch(url, {
            method: 'POST',
            headers: upstreamHeaders(route, cred, userAgent),
            body: bodyText,
            signal,
        });

        let response = await doFetch(credential);
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            const failedText = await response.text().catch(() => '');
            log(`渠道 ${route.channel} 返回 ${response.status}，尝试静默续期后重试。上游原文：${failedText.slice(0, 300)}`);
            try {
                await refreshCredential(route.channel);
            } catch (error) {
                return { refreshFailed: error };
            }
            const refreshed = credentials.get(route.channel);
            if (!refreshed || !refreshed.access_token) {
                return { refreshFailed: new Error('续期后仍无可用凭据') };
            }
            response = await doFetch(refreshed);
        }
        return { response };
    }

    /**
     * 对话主流程（已解析的请求体）。
     * /v1/chat/completions 与 /v1/completions 共用。
     */
    async function handleChatBody(body, req, res) {
        const requestedModel = typeof body.model === 'string' ? body.model : '';
        const route = await catalog.resolve(requestedModel);
        if (!route || !route.product || route.upstreamModel.length === 0) {
            sendError(res, 400, `无法解析模型 "${requestedModel}"：渠道未知或模型名为空`, 'invalid_request_error');
            return;
        }

        const credential = credentials.get(route.channel);
        if (!credential || !credential.access_token) {
            sendError(
                res,
                401,
                `渠道 ${route.product.displayName} 尚未登录。请在 SillyTavern 的「CodeBuddy / WorkBuddy 桥接」面板中完成登录。`,
                'authentication_error',
            );
            return;
        }

        // ── 最小改写 ──
        const upstreamBody = { ...body, model: route.upstreamModel };
        delete upstreamBody.user; // ST 的 user 字段不是 OpenAI 语义，去掉避免上游困惑
        if (Array.isArray(upstreamBody.messages) && upstreamBody.prompt !== undefined) delete upstreamBody.prompt;
        // WorkBuddy 要求首条为 system（CodeBuddy 无此约束），缺失时补空 system 兜底。
        upstreamBody.messages = ensureLeadingSystemMessage(upstreamBody.messages, route.product);
        if (upstreamBody.prompt_cache_key === undefined) {
            const key = derivePromptCacheKey(upstreamBody.messages);
            if (key) upstreamBody.prompt_cache_key = key;
        }
        const wantsStream = upstreamBody.stream === true || upstreamBody.stream === 'true';
        // 上游只接受流式（非流式会 400 code=11101），所以对上游**永远**发 stream:true；
        // 客户端要非流式时，由下面的聚合分支把它转回一个完整响应。
        upstreamBody.stream = true;

        const controller = new AbortController();
        // 客户端断开 → 立刻中止上游请求，避免继续计费
        res.on('close', () => {
            if (!res.writableEnded) controller.abort();
        });

        let result;
        try {
            result = await callUpstream(route, credential, JSON.stringify(upstreamBody), controller.signal);
        } catch (error) {
            if (controller.signal.aborted) return;
            sendError(res, 502, `连接上游失败：${error?.message || String(error)}`, 'upstream_unreachable');
            return;
        }

        if (!result.response) {
            const detail = result.refreshFailed instanceof RefreshTokenExpiredError
                ? '自动续期失败（refresh_token 已失效），请在桥接面板重新登录。'
                : `自动续期失败：${result.refreshFailed?.message || '未知原因'}`;
            sendError(res, 401, `${route.product.displayName} ${detail}`, 'authentication_error');
            return;
        }

        const response = result.response;

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const { type, message } = classifyUpstreamError(response.status, text);
            logError(`渠道 ${route.channel} / 模型 ${route.upstreamModel} 失败：HTTP ${response.status} ${message}`);
            sendError(res, response.status, message, type);
            return;
        }

        if (!response.body) {
            sendError(res, 502, '上游返回了空响应体', 'empty_response');
            return;
        }

        if (wantsStream) {
            await pipeSse(response, res, controller);
            return;
        }

        // 非流式：把上流的 SSE 聚合成一个完整响应再返回
        let completion;
        try {
            completion = await aggregateUpstreamCompletion(response, route.upstreamModel, controller);
        } catch (error) {
            if (controller.signal.aborted) return;
            sendError(res, 502, `读取上游流式响应失败：${error?.message || String(error)}`, 'upstream_error');
            return;
        }
        sendJson(res, 200, completion);
    }

    /** POST /v1/chat/completions */
    async function handleChat(req, res) {
        let body;
        try {
            body = JSON.parse(await readRequestBody(req));
        } catch (error) {
            sendError(res, 400, `请求体不是合法 JSON：${error.message}`, 'invalid_request_error');
            return;
        }
        return handleChatBody(body, req, res);
    }

    /** POST /v1/completions：把 prompt 包成 user 消息后走 chat 流程。 */
    async function handleCompletions(req, res) {
        let body;
        try {
            body = JSON.parse(await readRequestBody(req));
        } catch (error) {
            sendError(res, 400, `请求体不是合法 JSON：${error.message}`, 'invalid_request_error');
            return;
        }
        const prompt = body.prompt;
        const messages = Array.isArray(prompt)
            ? prompt.map(text => ({ role: 'user', content: String(text) }))
            : [{ role: 'user', content: String(prompt ?? '') }];
        const converted = { ...body, messages };
        delete converted.prompt;
        return handleChatBody(converted, req, res);
    }

    const server = http.createServer((req, res) => {
        let pathname;
        try {
            pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
        } catch {
            sendError(res, 400, '非法请求路径', 'invalid_request_error');
            return;
        }
        const method = (req.method || 'GET').toUpperCase();

        // 只绑 127.0.0.1，但仍加一层来源校验，防止本机其它进程误用
        const remote = req.socket.remoteAddress || '';
        if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) {
            sendError(res, 403, 'cbwb-bridge 仅接受本机连接', 'forbidden');
            return;
        }

        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            });
            res.end();
            return;
        }
        if (method === 'GET' && (pathname === '/v1/health' || pathname === '/health')) {
            handleHealth(res);
            return;
        }
        if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
            handleModels(res).catch(error => sendError(res, 500, `模型列表获取失败：${error.message}`));
            return;
        }
        if (method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
            handleChat(req, res).catch(error => {
                logError('对话代理异常：', error?.stack || String(error));
                sendError(res, 500, `桥接内部错误：${error.message}`);
            });
            return;
        }
        if (method === 'POST' && (pathname === '/v1/completions' || pathname === '/completions')) {
            handleCompletions(req, res).catch(error => {
                logError('补全代理异常：', error?.stack || String(error));
                sendError(res, 500, `桥接内部错误：${error.message}`);
            });
            return;
        }

        sendError(res, 404, `未知路径：${method} ${pathname}`, 'not_found');
    });

    // SSE 长连接不能被 Node 的默认超时掐断
    server.keepAliveTimeout = 75000;
    server.headersTimeout = 120000;
    server.requestTimeout = 0;
    server.timeout = 0;

    let listeningPort = 0;

    /**
     * 启动监听，端口被占用时自动顺延（最多 +9）。
     * @returns {Promise<{port:number, url:string}>}
     */
    function start(preferredPort) {
        return new Promise((resolve, reject) => {
            const tryPort = (port, attemptsLeft) => {
                const onError = (error) => {
                    server.removeListener('error', onError);
                    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
                        log(`端口 ${port} 被占用，尝试 ${port + 1}`);
                        tryPort(port + 1, attemptsLeft - 1);
                        return;
                    }
                    reject(error);
                };
                server.once('error', onError);
                server.listen(port, '127.0.0.1', () => {
                    server.removeListener('error', onError);
                    listeningPort = server.address().port;
                    log(`OpenAI 兼容代理已监听 http://127.0.0.1:${listeningPort}/v1`);
                    resolve({ port: listeningPort, url: `http://127.0.0.1:${listeningPort}/v1` });
                });
            };
            tryPort(preferredPort, 9);
        });
    }

    function stop() {
        return new Promise(resolve => {
            if (!server.listening) {
                resolve();
                return;
            }
            const timer = setTimeout(() => server.closeAllConnections?.(), 500);
            timer.unref?.();
            server.close(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    return {
        start,
        stop,
        server,
        get port() {
            return listeningPort;
        },
        get url() {
            return `http://127.0.0.1:${listeningPort}/v1`;
        },
    };
}

module.exports = {
    createProxyServer,
    /** 导出纯函数以便单测（把上游 SSE 聚合成非流式响应）。 */
    aggregateUpstreamCompletion,
    /** 导出纯函数以便单测（按产品能力补齐首条 system 消息）。 */
    ensureLeadingSystemMessage,
};
