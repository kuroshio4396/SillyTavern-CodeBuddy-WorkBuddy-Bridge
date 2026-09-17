'use strict';
/**
 * 桥接配置持久化（`<dataRoot>/cbwb-bridge/config.json`）。
 *
 * 这里只放**服务器侧**的设置：代理端口、默认渠道、模型黑名单。
 * 「custom_url 槽位快照」不在这里 —— 那份快照属于 SillyTavern 自己的设置，
 * 由 UI 扩展存进 `extension_settings.cbwb_bridge` 并交 ST 自己落盘（方案 A），
 * 这样服务器插件永远不需要碰 settings.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, ensureDir } = require('./credentials');

const FILE_VERSION = 1;

const DEFAULTS = Object.freeze({
    version: FILE_VERSION,
    /** OpenAI 兼容代理监听端口（仅绑定 127.0.0.1）。 */
    proxyPort: 8791,
    /** 模型 id 无前缀时走哪个渠道。 */
    defaultChannel: 'codebuddy',
    /** 模型 id 一律加 `codebuddy/` / `workbuddy/` 前缀（避免两个渠道同名模型撞车）。 */
    useModelPrefix: true,
    /** 黑名单制显隐：默认全显，只隐藏被显式关闭的模型 id。 */
    hiddenModels: { codebuddy: [], workbuddy: [] },
    /** 远端模型目录缓存有效期（毫秒）。 */
    modelCacheTtlMs: 600000,
    /**
     * 积分余额缓存有效期（毫秒）。
     * 面板会周期性刷新，这里做一层短缓存，避免把上游计费接口打爆。
     */
    creditsCacheTtlMs: 60000,
    /** 目标 custom_url 值（UI 扩展「接入」时写入 ST 设置的就是它）。 */
    localBaseUrl: 'http://127.0.0.1:8791/v1',
});

class ConfigStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = { ...DEFAULTS };
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                this.save();
                return;
            }
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                this.data = {
                    ...DEFAULTS,
                    ...parsed,
                    hiddenModels: { ...DEFAULTS.hiddenModels, ...(parsed.hiddenModels || {}) },
                };
            }
        } catch (error) {
            console.error('[cbwb-bridge] 读取配置失败（回退默认值）：', error.message);
            this.data = { ...DEFAULTS };
        }
    }

    save() {
        writeJsonAtomic(this.filePath, this.data);
    }

    get() {
        return this.data;
    }

    /** 合并式更新，只接受白名单字段，避免被 UI 写入任意键。 */
    update(patch) {
        const next = { ...this.data };
        if (patch === null || typeof patch !== 'object') return next;

        if (Number.isInteger(patch.proxyPort) && patch.proxyPort > 0 && patch.proxyPort < 65536) {
            next.proxyPort = patch.proxyPort;
        }
        if (typeof patch.defaultChannel === 'string' && ['codebuddy', 'workbuddy'].includes(patch.defaultChannel)) {
            next.defaultChannel = patch.defaultChannel;
        }
        if (typeof patch.useModelPrefix === 'boolean') {
            next.useModelPrefix = patch.useModelPrefix;
        }
        if (Number.isFinite(patch.modelCacheTtlMs) && patch.modelCacheTtlMs >= 60000) {
            next.modelCacheTtlMs = Math.floor(patch.modelCacheTtlMs);
        }
        if (Number.isFinite(patch.creditsCacheTtlMs) && patch.creditsCacheTtlMs >= 5000) {
            next.creditsCacheTtlMs = Math.floor(patch.creditsCacheTtlMs);
        }
        if (typeof patch.localBaseUrl === 'string' && /^https?:\/\//.test(patch.localBaseUrl)) {
            next.localBaseUrl = patch.localBaseUrl.replace(/\/+$/, '');
        }
        if (patch.hiddenModels && typeof patch.hiddenModels === 'object') {
            const hidden = { ...next.hiddenModels };
            for (const channel of ['codebuddy', 'workbuddy']) {
                const list = patch.hiddenModels[channel];
                if (Array.isArray(list)) {
                    hidden[channel] = list.filter(id => typeof id === 'string');
                }
            }
            next.hiddenModels = hidden;
        }

        this.data = next;
        this.save();
        return this.data;
    }

    /** 该渠道下被隐藏的模型 id 集合。 */
    hiddenFor(channelId) {
        const list = this.data.hiddenModels?.[channelId];
        return new Set(Array.isArray(list) ? list : []);
    }
}

module.exports = { ConfigStore, DEFAULTS, ensureDir };
