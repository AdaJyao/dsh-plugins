# dsh-route-mode · 执行路由

**一句话**：在 DSH 输入框工具条上加三个按钮 —— **云端 / 本地 / 混合** —— 一键决定"这一轮由谁来干活"，
外加一个**只列 Ollama 本地模型**的模型选择器。

| 按钮 | 会话模型 | 云端模型这一轮的职责 |
|---|---|---|
| **云端** | 切回云端模型（记住你上一次的云端选择） | 直接执行任务。宿主注入显式授权，本会话不再强制走本地派单链路 |
| **本地** | **真的切到所选 Ollama 模型**（走官方 `session.selectModel`） | 不是云端在跑；本轮由本地模型直接产出 |
| **混合** | 保持云端模型 | 派单者 / 监督者 / 审核者：拆卡派单、机械验收、审核产物、打回重改；**交付物一律由本地 Ollama 模型产出** |

## 界面在哪

| 入口 | 槽位 | 内容 |
|---|---|---|
| 三按钮 | `conversation.input.left`（order 110） | 输入框内工具条，紧跟在 **FNOS 图标**（order 100）之后 |
| 本地模型选择器 | `conversation.input.right`（order 55） | 模型选择座位旁，`🖥` + 下拉框，**只列 `provider === 'ollama'` 的模型** |

当前生效的那个按钮高亮成品牌色；按钮右侧一行小字说明上一次操作的结果（空间不足时省略、悬停看全文）。
云端的判定是**实时的**：只要会话模型不是本地提供方（`ollama` / `spark-local`），就显示"云端"高亮。

## 「混合」模式往提示词里注入了什么

宿主半边注册一个 `systemPrompt.context`（`order: 320`），**只有用户点过按钮之后**（`touched=true`）才输出，
文本形如：

```
[执行路由 · 模式=混合]
用户已选择混合模式：你（云端模型）是派单者、监督者与审核者，交付物一律由本地 Ollama 模型产出（默认：<模型名>）。
1. 拆解任务并派单：写卡 → 入板 → 由监督链交给本地模型在 workspace 内执行；不要自己动手产出交付物。
2. 机械验收只认退出码；不通过则读交付物 / 看图 / 复跑 accept 审核产物，输出逐条问题清单打回重改。
3. 重改最多 3 轮、逐轮升档；通过后回写审计评论并汇报。
4. 勘察结论、拆卡与最终汇报仍由你负责，这些不占用本地模型。
```

`云端` / `本地` 两种模式各有对应的一段。

## 边界与副作用（**装之前请读**）

这是**有副作用**的插件，不是只读挂件：

1. **会改会话模型**：点「本地」会调用官方 `session.selectModel` 真的把会话模型换成 Ollama 模型 ——
   和自带模型选择器共用同一份状态，所以自带选择器也会同步显示。切回云端用的是本插件记住的上一次云端选择。
2. **会注入提示词**：按所选模式往 `systemPrompt.context` 注入一段指令，直接改变云端模型的行为。
   **没点过按钮的会话（`touched=false`）完全不注入**，插件装了不用就等于没装。
3. **内存台账**：每个会话一条 `{mode, touched, localModel, seq}`，上限 256 个会话（FIFO 淘汰）。
   **不落盘**、不改会话记录、不发起对外网络请求；**进程重启即清空**（会回到"没点过"的状态）。
4. **依赖**：会话模型切换依赖官方 client 服务 `ctx.modelDirectories`（由 `@deepseek-ai/dsh-client-ui-model-selection` 提供）。
   该服务缺失时三按钮仍在，但会明确提示"模型目录服务未就绪"，不会静默失败。
   本地模型列表来自宿主已配置的 `ollama` 提供方（`settings.yaml` 的 `llm-pi-ai.providers.ollama`）。

## Host↔Client 通道

静态插件没有 `harness` 全局，所以走 `webServer` HTTP 路由（前缀 `/_dsh/` 已在门户网关改写表内）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/_dsh/route-mode/state?sessionId=…` | 读某会话台账 |
| POST | `/_dsh/route-mode/state` `{sessionId}` | 同上 |
| POST | `/_dsh/route-mode/set` `{sessionId,mode,localModel}` | 写台账（`mode` 非法则忽略） |

回包统一 `{ ok: true, data }` / `{ ok: false, error: { message } }`；缺 `sessionId` 回 400，未知方法回 404。
用 curl 就能验证：`curl -s 'http://127.0.0.1:23006/_dsh/route-mode/state?sessionId=x'`。

## 安装

```bash
export DSH_HOME=/path/to/dsh-home
scripts/install-plugin.sh releases/dsh-route-mode-0.1.0.tgz
# 装完需要重启 DSH web（花名册只在启动时读）
```

## 自检

```bash
node test/inprocess.mjs      # Host 半边进程内自检，32 项：路由契约/台账/三种指令/跨会话隔离/参数校验
node client/build.mjs        # 生成 client/dist/index.js（装载外壳）
node --check lib/index.js && node --check client/dist/index.js
```

`test/inprocess.mjs` 不需要 DSH、不需要浏览器：它用假 ctx 装上 Host 半边，
直接驱动路由 handler 与提示词 `text()`，断言**跨会话不会串模式**、**没点过按钮就不注入**。

## 已知限制

- **每个会话各记一条模式**，互不干扰；但三按钮的高亮以**当前会话模型**为准，
  所以用自带选择器手动换模型时，高亮会立刻跟着翻转（有意为之：高亮反映"事实"而不是"上次点了什么"）。
- 提示词 `text()` 里**取不到会话 id 就一律不注入**（无 agent 的独立模型调用，例如生成标题）。
  0.1.0 曾在这里做「全台账恰好一个已点选会话就回退注入」的兜底，副作用是把会话的执行模式串进了非对话调用的提示词，
  0.1.1 删掉了它。代价是：若将来 `session.id` 的形态变化导致主路径失配，本插件会**静默不注入** ——
  所以 `sessionIdOf` 对 id 做了 `String()` 兜底，把失配面压到最小。
- 本地模型选择器只列 `ollama`；`spark-local`（本机 llama.cpp）**不在**列表里，但仍被识别为"本地"用于模式判定。

## 许可

MIT，见仓库根 [LICENSE](../../LICENSE)。
