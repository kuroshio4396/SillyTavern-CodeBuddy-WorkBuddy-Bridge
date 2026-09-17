# 安全说明

## 这个插件会接触什么

| 数据 | 位置 | 敏感性 |
|---|---|---|
| 登录凭据（access / refresh token） | `<SillyTavern>/data/cbwb-bridge/credentials.json` | **高** —— 等同于你的账号登录态 |
| 桥接配置（端口、默认渠道、模型黑名单、接入快照） | `<SillyTavern>/data/cbwb-bridge/config.json` | 低 |
| 对话内容 | 不落盘，经本机代理解码后转发 | 中 —— 会发送给你自己的 CodeBuddy / WorkBuddy 账号 |

## 设计上的措施

1. **代理只绑定 `127.0.0.1`**，并在每个请求上校验来源地址，非本机连接一律 `403`。
   即使 `config.yaml` 里 `listen: true` 对外暴露了 ST，代理本身也不会对外可达。
2. **凭据文件按 `0600` 权限原子写**（先写临时文件再 rename），避免半写状态与权限外泄。
3. **不写 ST 的 `secrets.json`**。服务器插件拿不到用户上下文，强行写入会造成多用户串号。
4. **对外视图脱敏**：给前端的凭据信息只含 `token_tail`（access_token 末尾 8 位）与
   `has_refresh_token` 布尔值，**绝不返回**完整 `access_token` 或 `refresh_token`。
5. **不接受任何外部传入的凭据**。token 只能由本机浏览器完成官方授权流程后写入。
6. **本仓库不含任何密钥**。提交前已扫描确认无 token、密钥、个人路径与本机绝对路径。

## 使用者需要注意的

- `credentials.json` **等同于账号登录态**，不要提交到任何仓库、不要分享、不要放进同步盘公开目录。
  `.gitignore` 已经默认排除 `data/`、`credentials.json`、`config.json`。
- 若怀疑凭据泄漏，请在 CodeBuddy / WorkBuddy 客户端里**退出登录**（使 refresh_token 失效），
  然后删除 `data/cbwb-bridge/credentials.json` 并重新登录。
- 卸载时记得删除 `data/cbwb-bridge/`，否则凭据会留在磁盘上。
- 这个插件会把你发送的对话内容转发给上游（这是它的功能本身）。不要在对话里输入密钥、密码等敏感信息。

## 上游协议

本项目通过逆向实测复现了 CodeBuddy / WorkBuddy 客户端的官方协议（端点、请求头、计费口径）。
这是**非官方**实现，与腾讯 / WorkBuddy 无关：

- 上游一旦变更协议，插件即可能失效；
- 请遵守对应服务的使用条款，不要用于滥用、绕过配额或批量刷量；
- 由此产生的账号风险（限流、封禁等）由使用者自行承担。

## 报告问题

发现安全问题时，请**不要**开公开 issue 直接贴出可利用细节。
通过仓库的 Security → Report a vulnerability 私下报告，或在 issue 里只描述影响面、约私下沟通。
