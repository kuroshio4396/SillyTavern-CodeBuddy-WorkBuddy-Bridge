'use strict';
/**
 * 模型目录服务 + 模型 id 路由解析。
 *
 * 为什么需要「命名空间」：SillyTavern 的 custom 源只有**一个** URL 槽位，
 * 但我们要同时暴露 CodeBuddy 与 WorkBuddy 两条渠道。解法是给模型 id 加渠道前缀：
 *
 *     codebuddy/hy3            → https://copilot.tencent.com
 *     workbuddy/gpt-5.6-sol    → https://www.workbuddy.ai
 *     hy3（无前缀）             → 走配置的 defaultChannel
 *
 * 目录三层回退（照搬原插件）：企业模型端点 → /v3/config → 内置兜底表。
 */
const { ALL_PRODUCTS, productById, resolveUserAgent } = require('./product');
const { fetchRemoteModels } = require('./oauth');

class ModelCatalog {
    /**
     * @param {{ credentials: import('./credentials').CredentialStore, store: import('./store').ConfigStore }} deps
     */
    constructor(deps) {
        this.credentials = deps.credentials;
        this.store = deps.store;
        /** @type {Map<string, {at:number, models:any[], source:string}>} */
        this.cache = new Map();
    }

    /** 清空某渠道（或全部）的缓存。 */
    invalidate(channelId) {
        if (channelId === undefined) {
            this.cache.clear();
            return;
        }
        this.cache.delete(channelId);
    }

    /**
     * 取某渠道的原始（未加前缀、未过滤）模型目录。
     * @returns {Promise<{models:any[], source:'remote'|'fallback', fetchedAt:number}>}
     */
    async rawList(channelId, { force = false } = {}) {
        const product = productById(channelId);
        if (!product) return { models: [], source: 'fallback', fetchedAt: Date.now() };

        const ttl = this.store.get().modelCacheTtlMs ?? 600000;
        const cached = this.cache.get(channelId);
        if (!force && cached && Date.now() - cached.at < ttl) {
            return { models: cached.models, source: cached.source, fetchedAt: cached.at };
        }

        let models = [];
        let source = 'fallback';
        const credential = this.credentials.get(channelId);
        if (credential && this.credentials.has(channelId)) {
            try {
                models = await fetchRemoteModels(credential, product);
            } catch (error) {
                console.error(`[cbwb-bridge] 拉取 ${channelId} 远端模型失败：`, error.message);
                models = [];
            }
            if (models.length > 0) source = 'remote';
        }
        if (models.length === 0) {
            models = product.fallbackModels || [];
            source = 'fallback';
        }

        this.cache.set(channelId, { at: Date.now(), models, source });
        return { models, source, fetchedAt: Date.now() };
    }

    /**
     * 暴露给外部的模型条目（含渠道前缀、应用黑名单）。
     * @returns {Promise<Array<{exposedId:string, upstreamId:string, channel:string, name:string, contextWindow?:number, supportsImages?:boolean, reasoningEfforts?:string[], defaultReasoningEffort?:string, hidden:boolean, source:string}>>}
     */
    async listAll({ force = false } = {}) {
        const config = this.store.get();
        const usePrefix = config.useModelPrefix !== false;
        const out = [];

        for (const product of ALL_PRODUCTS) {
            const { models, source } = await this.rawList(product.id, { force });
            const hiddenSet = this.store.hiddenFor(product.id);
            for (const model of models) {
                out.push({
                    exposedId: usePrefix ? `${product.id}/${model.id}` : model.id,
                    upstreamId: model.id,
                    channel: product.id,
                    channelName: product.displayName,
                    name: model.name || model.id,
                    contextWindow: model.contextWindow,
                    supportsImages: model.supportsImages,
                    reasoningEfforts: model.reasoningEfforts,
                    defaultReasoningEffort: model.defaultReasoningEffort,
                    hidden: hiddenSet.has(model.id),
                    source,
                });
            }
        }
        return out;
    }

    /** 只返回未被隐藏的模型（给 ST 的 /v1/models 用）。 */
    async listVisible(options = {}) {
        return (await this.listAll(options)).filter(model => !model.hidden);
    }

    /**
     * 解析客户端传来的 model 字段 → 实际路由。
     *
     * 解析顺序：
     * 1. 命中已知渠道前缀（`codebuddy/xxx` / `workbuddy/xxx`）→ 该渠道 + 去掉前缀的模型名；
     * 2. 无前缀但能唯一匹配某渠道目录里的模型 id → 该渠道；
     * 3. 兜底 → defaultChannel + 原始 model 字符串（允许用户手输任意模型名）。
     *
     * 返回 null 表示无法路由（渠道不存在或无凭据）。
     */
    async resolve(modelId) {
        const raw = typeof modelId === 'string' ? modelId.trim() : '';
        const config = this.store.get();
        const fallbackChannel = productById(config.defaultChannel) ? config.defaultChannel : 'codebuddy';

        const slash = raw.indexOf('/');
        if (slash > 0) {
            const maybeChannel = raw.slice(0, slash);
            if (productById(maybeChannel)) {
                return { channel: maybeChannel, product: productById(maybeChannel), upstreamModel: raw.slice(slash + 1) };
            }
        }

        if (raw.length > 0) {
            const matches = [];
            for (const product of ALL_PRODUCTS) {
                const { models } = await this.rawList(product.id);
                if (models.some(model => model.id === raw)) matches.push(product.id);
            }
            // 唯一匹配才自动定渠道；两个渠道都有同名模型时用 defaultChannel 消歧。
            if (matches.length === 1) {
                return { channel: matches[0], product: productById(matches[0]), upstreamModel: raw };
            }
            if (matches.length > 1 && matches.includes(fallbackChannel)) {
                return { channel: fallbackChannel, product: productById(fallbackChannel), upstreamModel: raw };
            }
        }

        return { channel: fallbackChannel, product: productById(fallbackChannel), upstreamModel: raw };
    }

    /**
     * 组装发往上游的对话请求所需的身份信息（头 + UA）。
     * UA 必须按**上游模型名**分档，而不是带前缀的暴露名。
     */
    describeRoute(route) {
        return {
            channel: route.channel,
            displayName: route.product.displayName,
            upstreamModel: route.upstreamModel,
            userAgent: resolveUserAgent(route.product, route.upstreamModel),
        };
    }
}

module.exports = { ModelCatalog };
