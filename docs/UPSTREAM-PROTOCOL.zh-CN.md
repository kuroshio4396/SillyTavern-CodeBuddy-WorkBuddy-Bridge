# 上游协议实测结论

记录通过实测确认的 CodeBuddy（中国版）/ WorkBuddy（国际版）接口事实。

**这些都是上游行为，不是本插件的配置项** —— 换模型、换账号、重登都不会改变它们。
代理层已经内建处理，但排错时知道这些能省很多时间。

---

## 一、两条渠道同源同协议

| | CodeBuddy（中国版） | WorkBuddy（国际版） |
|---|---|---|
| endpoint | `https://copilot.tencent.com` | `https://www.workbuddy.ai` |
| platform | `ide` | `workbuddy-ai` |
| clientVersion | `1.106.1` | `5.5.2` |
| 品牌头 `X-Product`（对话） | `CodeBuddy` | `WorkBuddy` |
| UA | `CodeBuddyIDE/1.106.1` | `WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2` |
| 每日签到 | ✅ 有 | ❌ 无 |
| 要求首条消息是 system | ❌ 无此约束 | ✅ **要求** |

差异全部收敛在 `server-plugin/lib/product.js` 的「产品配置对象」里，
新增渠道只需往 `ALL_PRODUCTS` 加一项。

---

## 二、对话端点

路径：`POST /v2/chat/completions`

### 约束 1：只支持流式

```
请求带 stream:false
→ HTTP 400  {"code":11101,"msg":"Non-stream chat request is currently not supported"}
```

**处理**：代理对上游**永远**发送 `stream:true`。当客户端要非流式时，
代理把 SSE 聚合成一个完整的 `chat.completion` 再回传
（`lib/proxy.js` 的 `aggregateUpstreamCompletion`）。

聚合实现的两个坑：

- **必须用 `node:string_decoder` 的 `StringDecoder` 增量解码**。
  如果直接对每个 TCP 分片调用 `toString('utf8')`，多字节汉字被切断时会产出 `\uFFFD` 乱码。
  自测里有一项专门把 SSE 切成 **7 字节**小块来守这条。
- **`tool_calls` 要按 `index` 归并**。`function.name` 与 `function.arguments`
  都会分片到达，不能简单拼接数组。

### 约束 2：WorkBuddy 要求 `messages[0].role === 'system'`

实测矩阵：

| 首条消息 | CodeBuddy | WorkBuddy |
|---|---|---|
| 仅 `user` | ✅ 200 | ❌ 400 `code=11128` |
| `system` + `user` | ✅ 200 | ✅ 200 |
| `user` 在前、`system` 在后 | ✅ 200 | ❌ 400 `code=11128` |
| 仅 `assistant` | ❌ 400 `code=11151` | ❌ 400 `code=11133` |

失败文案长这样 —— **注意它把协议错误包装成了安全审查**：

```json
{"code":11128,"msg":"first message is not system prompt",
 "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}
```

**处理**：按产品能力位 `requiresLeadingSystemMessage`，在队首补一条**空** system
（`lib/proxy.js` 的 `ensureLeadingSystemMessage`）。

首条 system 的**内容**上游并不挑：

| 首条 system 的形式 | 结果 |
|---|---|
| `content: ""` | ✅ 200 |
| `content: " "` | ✅ 200 |
| `content: null` | ✅ 200 |
| 缺 `content` 键 | ✅ 200 |

所以补空串即可，**不需要伪造提示词**，也不会影响模型行为。

### 其他错误码

| code | 含义 | 处理 |
|---|---|---|
| `11101` | 非流式请求不支持 | 代理已改为永远流式 |
| `11102` | 该模型后端未开放 | 换模型 |
| `11128` | 首条不是 system（WorkBuddy） | 代理已自动兜底 |
| `11133` | 请求参数被模型提供方拒绝（如以 assistant 开头） | 检查会话历史 |
| `11151` | 存在内容为空的消息 | 检查会话历史 |
| `11217` | token 尚未就绪（登录流程中） | 稍等重试 |
| `12151` | 账号尚未就绪 | 稍等重试 |

---

## 三、登录流程（设备授权码轮询）

```
POST /v2/plugin/auth/state      → 拿 state + 官方登录页 URL
   ↓ 用户在浏览器完成授权（必须真人）
轮询 GET .../auth/token         → 拿到 access_token / refresh_token
POST /v2/plugin/login/account    → 拿账号信息
```

- **登录页 URL 由服务端下发**，本地不要重建（重建会丢 `state` 参数）。
- WorkBuddy 的登录 URL 需要额外追加 `version=5.5.2` 与 `loginSessionId`。
- 客户端**不起回调服务器**，所以只能轮询，无法脚本化。

续期：

```
POST /v2/plugin/auth/token/refresh
```

- `refresh_token` 走 **`X-Refresh-Token` 请求头**，不是 body。
- 代理在凭据**到期前 1 小时**自动续期；失败按 10 分钟 / 1 分钟退避重试。
- `refresh_token` 失效是**终态**，调度器停止续期并提示重新登录。

---

## 四、积分 / 计费端点

| 用途 | 路径 | 适用 |
|---|---|---|
| 查询余额 | `POST /v2/billing/meter/get-user-resource` | 两条渠道通用 |
| 签到状态 | `POST /v2/billing/meter/checkin-activity-status` | 仅中国版 |
| 领取签到 | `POST /v2/billing/meter/daily-checkin` | 仅中国版 |

要点：

1. **全是 POST + 空 JSON body `{}`**，并且要带 `Content-Length`。
2. **`X-Product` 用部署类型 `'SaaS'`**，与对话端点的 `attributionName`（`CodeBuddy` / `WorkBuddy`）
   **刻意不一致** —— 计费看部署类型，用量归因看产品名。两处都有代码注释标注。
3. 响应是**双层嵌套**，解析路径为 `data.Response.Data.Accounts[]`。
4. 余额取 **`CycleCapacityRemainPrecise`**（本周期口径的精确字符串，如 `"247.87"`），
   而不是被截断的整数 `CycleCapacityRemain`（`247`）。
5. **失效包不计入总额**：`Status === 3` 或 `ExpiredTime` 已过的条目被排除，单独累计为 `expiredTotal`。
   服务端会把失效包一起返回，并进总额会让数字虚高。
6. **不能用 `checkin-status`** —— 它返回占位数据（`active:false`、`checkin_dates:null`），
   必须用 `checkin-activity-status` 才是权威状态源。
7. 领取是**幂等**的：重复领取返回 HTTP 400 + `code 10001`，应判定为「今天已签到」而不是失败。
   其他码：`1002` / `1003` → 无资格（`inactive`）。

---

## 五、模型目录

三层回退：

```
1. 远端权益（GET /v3/config，scope=personal）
2. 内置兜底目录（product.js 的 *_FALLBACK_MODELS）
3. 磁盘缓存
```

内置兜底目录**只收录实测可用的模型** —— 远端列表里另有一批返回 `11102` 的条目，
列进下拉只会让用户选中后报错。

UA 按模型族分档（GPT / Gemini / Claude 用国际版 UA，GLM / hy / kimi / minimax 用中国版 UA），
未命中规则时回退到产品默认 UA，保证新模型上线时请求头仍含品牌字样。

---

## 六、请求头族

缺任一个都会让后台「使用端」归因显示为 `-`：

```
Authorization: Bearer <access_token>
X-Domain / X-Enterprise-Id / X-Tenant-Id
X-Product / X-Product-Code
X-IDE-Name / X-IDE-Type / X-IDE-Version
```

---

## 七、已知边界

- 协议为**逆向实测**所得，上游变更即可能失效。
- 上游是**编码向端点**，对角色扮演类提示词会做审查或改写 —— 这是上游限制，实现层面绕不开。
- ST 的 Custom 源只有一个 `custom_url` 槽位，因此只能用模型名前缀做路由。
