# 排错手册

面向「装了但跑不起来 / 跑起来但报错」的场景。按症状查表，再看后面的原理说明。

## 一、症状速查

| 症状 | 最可能的原因 | 处置 |
|---|---|---|
| 启动日志里**没有** `[cbwb-bridge] 插件已加载` | `config.yaml` 的 `enableServerPlugins` 还是 `false` | 改成 `true` 后重启 ST |
| 启动日志报 `Address 127.0.0.1:8791 is already in use` | 有别的进程占着端口 | 关掉占用方；插件也会自动顺延到 8792 |
| 设置页里找不到「CodeBuddy / WorkBuddy 桥接」面板 | 扩展目录位置不对 | 确认路径是 `public/scripts/extensions/third-party/cbwb-bridge/`，且目录内有 `manifest.json`；刷新页面（`Ctrl+F5`） |
| 面板显示「本地代理 未运行」 | 插件没加载成功 | 看 ST 服务端控制台的启动日志 |
| 模型下拉是空的 | 没触发 Connect，或模型被全部隐藏 | 面板点「重拉模型目录」，或点 ST 的 Connect |
| 发消息报 `渠道 … 尚未登录` | 该渠道没有凭据 | 在面板点登录 |
| 发消息报 `自动续期失败（refresh_token 已失效）` | refresh_token 过期 | 重新登录 |
| 发消息报 `上游限流，请稍后重试` | 命中 429 | 等面板给出的重置时间，或换便宜档模型 |
| 报 `code=11102` | 该模型后端未开放 | 换模型 |
| 报 `code=11101` | 上游只支持流式 | 确认插件版本 ≥ 1.1.0 |
| 报 `code=11128` / 文案含「安全策略拦截」 | WorkBuddy 首条消息非 system | 确认插件版本 ≥ 1.1.0（已自动兜底） |
| 报 `code=11151 a message has empty content` | 会话历史里有空内容消息 | 清理该会话历史或新建会话 |
| 报 `code=11133 the request parameters were rejected` | 对话以 assistant 开头等畸形结构 | 检查会话历史首条角色 |
| 报 `上游首 token 超时` / `流式响应空闲超时` | 网关静默断流 | 直接重发；代理已主动断开，不会卡死 |
| 积分显示「查询失败」 | 见下方「积分排查」 | — |
| 点「接入本地桥接」没反应 | 前端未拿到 CSRF 令牌 | 刷新页面重试；看浏览器控制台 |
| ST 进程**自己退出**，控制台有 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | 不是插件的问题（见下） | 用 `Start.bat` 自己启动 ST |

## 二、ST 自身的两个行为（会被误当成插件 bug）

1. **ST 会把 401 改写成 400**。
   `src/util.js` 里有一段注释说明：为了避免浏览器弹出 Basic auth 重置框，ST 把所有 401 改写为 400，
   并把**原始响应体原样**交给客户端。所以桥接返回的 401（例如「尚未登录」），
   在 ST 里看起来是 `400 + 我们的 JSON`。**这是预期行为，不是 bug。**

2. **流式与非流式的错误处理不同**。
   - 流式走 `forwardFetchResponse`，完整透传响应体；
   - 非流式（`chat-completions.js` 附近）**只取 `statusText` 当错误消息**，详细原因被丢弃。

   所以排错时**优先看 ST 服务端控制台**，那里会打印代理返回的原文。
   在对话界面只看到一句 `Bad Request` 时，别急，去控制台看。

## 三、积分排查

面板会把服务端的 `reason` 翻成人话：

| 面板提示 | 含义 | 处理 |
|---|---|---|
| 未登录 —— 登录后即可看到剩余积分 | 该渠道没凭据 | 点登录 |
| 查询失败（网络不通） | 出不了网 / DNS 失败 | 检查系统代理与网络 |
| 查询失败（HTTP 4xx/5xx） | 多为 access_token 失效 | 点「手动续期」，不行就登出重登 |
| 查询失败（业务码 N） | 上游拒绝（如该账号未开通计费接口） | 记下业务码与消息 |
| 响应格式不符合预期 | 上游改了返回结构 | 需要更新 `lib/credits.js` 的解析逻辑 |

**为什么「查不到」不会显示成 0 积分？**
`fetchCreditBalance` 在失败时返回 `{ok:false, reason, ...}` 而不是 `null` / `0`，
这样前端能区分「真的没额度」和「没查到」。这是刻意设计。

## 四、`SAFE_DELETE_BULK_CONFIRM_REQUIRED` 导致 ST 退出

**这不是本插件的问题**，但症状很像，所以写在这里。

- **现象**：ST 运行一段时间后自己退出，控制台尾部有

  ```
  Uncaught exception: Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
      {"count":2294,"threshold":50,...}
      at node-safe-delete-shim.cjs (checkBulkDeleteGuard)  ← fs.unlinkSync
      at removeOldBackups (src/util.js)
      at backupUserSettings (src/endpoints/settings.js)
  ```

- **根因**：如果 ST 是被某个带「删除保护钩子」的环境启动的，钩子会按**同一进程内的累计删除次数**计数，
  第 51 次删除时抛未捕获异常，整个进程退出。
  而 ST 每次保存设置都会备份 `settings_<user>_<ts>.json`，并删掉超出 `backups.common.numberOfBackups`
  （默认 50）的旧份 —— 于是箱子满之后，每保存一次设置就触发一次删除。

- **处置**：**自己双击 `Start.bat` 启动 ST**。普通 shell 里没有这个钩子，完全不受影响。
  若是自动化环境无法避免，可对该进程设置 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 关闭钩子
  （不要写进 `config.yaml`）。

## 五、网络与端口

**先确认能直连上游**（这一步不过，后面全白做）：

```bash
curl -s -o /dev/null -w "HTTP:%{http_code}\n" --max-time 15 https://copilot.tencent.com/
curl -s -o /dev/null -w "HTTP:%{http_code}\n" --max-time 15 https://www.workbuddy.ai/
```

> 加 `--noproxy '*'` 可测「真直连」；不加则走系统代理。两者结论不同时以浏览器的实际行为为准。

**查端口占用（无 curl 时的 Python 版）**：

```bash
python -c "
import socket
for p in (8000, 8791, 8792):
    s = socket.socket(); s.settimeout(1)
    print(p, 'OPEN' if s.connect_ex(('127.0.0.1', p)) == 0 else 'CLOSED'); s.close()
"
```

**启动前一定先查端口**，否则会看到 `Address 127.0.0.1:8000 is already in use … Startup aborted`，
误以为启动失败（其实只是没起来第二个实例）。

## 六、恢复原状

1. 面板点 **「恢复原连接」**（把源 / `custom_url` / `custom_model` 还原成接入前的值）；
2. `config.yaml` 里 `enableServerPlugins` 改回 `false`；
3. 重启 ST。

想彻底清干净，再删掉：

```
<SillyTavern>/plugins/cbwb-bridge/
<SillyTavern>/public/scripts/extensions/third-party/cbwb-bridge/
<SillyTavern>/data/cbwb-bridge/
```
