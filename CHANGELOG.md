# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] — 2026-09-17

### 新增

- **积分 / 用量面板**：设置页新增独立的「积分 / 用量」卡片，两条渠道各一块。
  - 显示本周期剩余额度（取 `CycleCapacityRemainPrecise` 精确值）。
  - 可展开资源包明细（剩余 / 总量、有效期），已失效的包划除并标注「已失效」，**不计入总额**。
  - 渠道卡内另有一行紧凑的「剩余积分」。
  - CodeBuddy 支持每日签到状态展示与一键领取（幂等：重复领取被正确识别为「今天已签到」而非报错）。
  - 打开面板拉取一次，之后每 3 分钟自动刷新。
- 新增 `lib/credits.js`：积分余额、签到状态、签到领取的客户端与容错解析。
- 新增管理接口 `GET /api/plugins/cbwb-bridge/credits`（支持 `?channel=` 与 `?force=1`）
  与 `POST /api/plugins/cbwb-bridge/credits/checkin`。
- 积分查询带 60 秒短缓存与并发去重（`creditsCacheTtlMs`）。

### 修复

- **非流式对话请求必定失败**。上游只接受流式（`stream:false` → `400 code=11101`），
  而 ST 的「静默提示词」「总结」及部分扩展都走非流式。
  现在代理对上游**永远**发送 `stream:true`，客户端要非流式时把 SSE 聚合成完整的
  `chat.completion` 返回（新增纯函数 `aggregateUpstreamCompletion`）。
  - 聚合使用 `node:string_decoder` 的 `StringDecoder` 增量解码，避免多字节汉字被 TCP 分片切断时产生 `\uFFFD`。
  - `tool_calls` 按 `index` 归并，`function.name` / `arguments` 分片正确拼接。
  - 缺少 `[DONE]` 也能正常收尾。
- **WorkBuddy 首条消息必须是 `system`**。否则上游返回 `400 code=11128`，
  且失败文案被包装成「请求被安全策略拦截」，极易被误判为内容审查去错误排障。
  现在按产品能力位（`requiresLeadingSystemMessage`）自动在队首补一条空 `system`
  （实测空串 / `null` / 缺 `content` 键上游都接受）；CodeBuddy 无此约束，不做改动。
  新增纯函数 `ensureLeadingSystemMessage`。
- **端口顺延会污染配置**。此前若首选端口被占用，插件顺延后会把新端口写回 `proxyPort`，
  导致一次偶发冲突就让配置永久偏移，而 ST 的 `custom_url` 仍指向旧端口。
  现在顺延**只如实回报** `localBaseUrl`，仅在用户显式指定端口时才持久化。

### 测试

- 独立冒烟测试从 68 项扩展到 **91 项**，新增：
  - 端口顺延不写回配置的回归测试；
  - 积分解析（精确值优先、失效包排除、响应结构异常返回 `null` 而非 0、签到 / 领取解析）；
  - 积分接口（未登录返回 `available:false` + `reason`、未知渠道 400、国际版无签到返回 400）；
  - 非流式聚合（含 7 字节碎片切分、工具调用 index 归并、无 `[DONE]` 收尾）；
  - 首条 system 兜底（能力位、不修改入参、原引用返回、仅对声明该能力的产品生效）。

## [1.0.0] — 2026-09-17

### 新增

- 首个版本。
- 服务器插件：OpenAI 兼容代理（`127.0.0.1:8791/v1`），SSE 透传 + 首 token / 空闲双阶段超时 + 401 静默续期重试。
- 设备授权码轮询登录（CodeBuddy 中国版 / WorkBuddy 国际版），凭据 `0600` 原子写，到期前 1 小时自动续期。
- 模型目录三层回退（远端权益 → 内置兜底 → 缓存）与模型名前缀路由。
- 前端扩展面板：渠道登录与状态、模型显隐（黑名单制）、一键接入 / 恢复原连接、快照管理。
- 独立冒烟测试 68 项。
