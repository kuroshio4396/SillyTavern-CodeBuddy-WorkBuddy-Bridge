'use strict';
/**
 * 凭据持久化。
 *
 * 落盘位置：`<dataRoot>/cbwb-bridge/credentials.json`。
 *
 * 刻意**不写** ST 的 `secrets.json`：服务器插件拿不到用户上下文（没有 request.user），
 * 强行写入会造成多用户串号。桥接凭据只属于本机管理员，独立存放更安全。
 *
 * 同时刻意**不写 YAML**（原插件踩过：scope 字段含换行会被当成多行标量，破坏结构）——
 * 这里用 JSON，并在写入前清理控制字符。
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE_VERSION = 1;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
function writeJsonAtomic(filePath, data) {
    ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    try {
        fs.chmodSync(tmp, 0o600);
    } catch {
        // Windows 上 chmod 基本无效，忽略
    }
    fs.renameSync(tmp, filePath);
    try {
        fs.chmodSync(filePath, 0o600);
    } catch {
        // 同上
    }
}

class CredentialStore {
    /**
     * @param {string} filePath credentials.json 的绝对路径
     */
    constructor(filePath) {
        this.filePath = filePath;
        /** @type {Record<string, any>} channelId → credential */
        this.channels = {};
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) return;
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.channels && typeof parsed.channels === 'object') {
                this.channels = parsed.channels;
            }
        } catch (error) {
            console.error('[cbwb-bridge] 读取凭据失败（已忽略，将视为未登录）：', error.message);
            this.channels = {};
        }
    }

    save() {
        writeJsonAtomic(this.filePath, { version: FILE_VERSION, channels: this.channels, updatedAt: new Date().toISOString() });
    }

    /** @returns {any|undefined} */
    get(channelId) {
        return this.channels[channelId];
    }

    has(channelId) {
        const credential = this.channels[channelId];
        return !!credential && typeof credential.access_token === 'string' && credential.access_token.length > 0;
    }

    set(channelId, credential) {
        this.channels[channelId] = { ...credential, saved_at: new Date().toISOString() };
        this.save();
        return this.channels[channelId];
    }

    clear(channelId) {
        if (this.channels[channelId] !== undefined) {
            delete this.channels[channelId];
            this.save();
        }
    }

    /**
     * 擦除敏感字段的对外视图（给 UI 用）。绝不返回 refresh_token 与完整 access_token。
     */
    publicView(channelId) {
        const credential = this.channels[channelId];
        if (!credential) return null;
        return {
            nickname: credential.nickname || '',
            user_id: credential.user_id || '',
            account_type: credential.account_type || '',
            enterprise_id: credential.enterprise_id || '',
            expires_at: credential.expires_at || '',
            has_refresh_token: !!(credential.refresh_token && credential.refresh_token.length > 0),
            token_tail: typeof credential.access_token === 'string' && credential.access_token.length > 8
                ? credential.access_token.slice(-8)
                : '',
            saved_at: credential.saved_at || '',
        };
    }
}

module.exports = { CredentialStore, writeJsonAtomic, ensureDir };
