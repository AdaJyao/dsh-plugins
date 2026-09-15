# dsh-tdai-memory

把 **DeepSeek Harness（DSH）** 接到 **TencentDB Agent Memory** 的桥接插件（Host-only，无界面）。

它做的三件事：

| 能力 | 说明 |
|---|---|
| **指引注入** | 向每个会话注入一小段「什么时候该查长期记忆」的规则（`systemPrompt.context`，name=`tdai-memory`，order=150） |
| **检索工具** | 注册三个**只读**工具：`tdai_memory_search`（L1 原子记忆）、`tdai_conversation_search`（L0 原文）、`tdai_persona_read`（L3 画像） |
| **自动归档** | 每个回合结束时，把成对的 user + assistant 原文 POST 到 Gateway 的 `/v2/conversation/add`；L1/L2/L3 的抽取由 Gateway 侧流水线异步完成 |

## 前置条件

1. 一个运行的 **TencentDB Agent Memory Gateway**（standalone 模式即可，默认 `127.0.0.1:8420`，
   本地 SQLite + sqlite-vec/FTS5，抽取用的 LLM 与 embedding 走任意 OpenAI 兼容端点）。
   上游项目：<https://github.com/TencentCloud/TencentDB-Agent-Memory>（MIT）。
   Hermes 插件包 `@tencentdb-agent-memory/memory-tencentdb` 里带 Gateway 源码，可直接跑：
   `node --import tsx/esm src/gateway/server.ts`。
2. DSH ≥ `0.1.1-rc.1`。
3. **零运行时依赖**：本插件只用 Node 内建能力（全局 `fetch` + `AbortSignal.timeout`）。

## 安装

```bash
# 方式 A：用 tgz（推荐）
export DSH_HOME=/path/to/dsh-home
scripts/install-plugin.sh releases/dsh-tdai-memory-1.0.0.tgz

# 方式 B：从源码
cd packages/dsh-tdai-memory && npm pack        # 产物按本仓库约定放进 releases/
```

安装脚本做四处登记（实体 / symlink / `dsh.profile.bundles` 花名册 / `plugin-state.json`），
并在动手前备份。**登记完必须重启 DSH web**——花名册是启动时读的，没有热更新。

## 配置

改 `cordis.patch.yml` 里这一行的 `config`（然后重新安装 + 重启）：

| 键 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8420` | Gateway 地址 |
| `apiKey` | `local` | v2 接口的 `Authorization: Bearer`；Gateway 端若设了 `TDAI_GATEWAY_API_KEY`，这里填同一个值 |
| `serviceId` | `default` | `X-TDAI-Service-Id` 头，standalone 的默认空间 |
| `guidance` | `true` | 是否注入记忆使用指引 |
| `capture` | `true` | 是否自动归档对话（关掉就只用工具、不往 Gateway 写） |

## 数据流与隐私（请先读这一段）

- **本插件会把对话原文发给 Gateway**：每个回合结束时，成对的 user + assistant 文本（单条截断到 8000 字符）
  通过 HTTP POST 到 `endpoint`。Gateway 默认是本机回环地址、数据落在本地 SQLite 与 Markdown 文件里，
  但**你要清楚"聊天内容离开了 DSH 进程"这件事**；不想写就把 `capture` 设为 `false`。
- 三个检索工具是只读的；注入的只是「怎么用记忆」的规则，**不是历史记忆本身**——
  模型需要时自己调工具召回，避免无关上下文与把历史误当新指令。
- `apiKey` 写在 `cordis.patch.yml` 里会进配置文件；standalone 默认值 `local` 不是密钥。
  真要暴露到回环之外，请在 Gateway 端启用鉴权并妥善保管这个值。

## 实现要点（都是踩过的坑）

1. **零 bare import**：插件实体在 `$DSH_HOME/plugins/<name>/<ver>/`，Node 按 realpath 继续解析，
   向上到文件系统根都没有 `node_modules`，DSH web 进程也一般没有 `NODE_PATH`。
   所以不能 `import '@deepseek-ai/dsh-tools'`；工具定义手写成 `tools.register({ name, description, parameters, output, execute })`
   （`register()` 只校验 `output {schema, render}` 与 JSON Schema 合法性）。
2. **必须用 `ctx.inject`**：实测在 `apply()` 里同步 `ctx.get('tools')` / `ctx.get('systemPrompt')` 都是
   `undefined`（服务晚于本插件挂载）。写成 `if (x !== undefined)` 会得到"装载成功但静默什么都不做"，
   而且没有任何报错。改用 `ctx.inject(['tools'], scope => ...)` 等待服务出现（与官方 `dsh-user-approval` 同款）。
3. **注释里别写 `*/`**：源码注释中若出现路径通配（例如 `dir/*/node_modules`）会**提前终止块注释**，
   `node --check` 报 `Unexpected token 'import'`，看起来很吓人其实是注释问题。
4. **日志用 `console`，不要用 `ctx.logger`**：`ctx.logger` 的输出不进进程 stdout，
   运维脚本 grep 不到，会误判成「插件没装载」。
5. **只采集真人消息**：`user/message` 的 `source.kind` 有 `user` / `plugin` /
   `agent-instructions` / `skill-catalog` / `goal` 等多种取值，只有 `user`（或缺失）才入库，
   否则系统注入会被当成用户的记忆。
6. **采集节奏以 `turn/end` 为主**：一次多轮对话里 `assistant/message` 数量远多于"带文本"的条数
   （多数只是工具调用），且 `user/message` 里有相当比例需要过滤。若"成对即归档"，
   会产生数倍于必要的采集调用与无谓的 LLM 抽取负载。另设安全阀：缓冲区 ≥ 10 条先落一次，
   防超长回合从不结束而丢数据。
7. **子代理不采集**：`session.header.origin === 'subagent'` 直接跳过。

## 验证

重启后 `$TRIM_PKGVAR/app.log` 应出现四行（前缀 `[dsh-tdai-memory]`）：

```
装载中 endpoint=http://127.0.0.1:8420 service=default
插件就绪 endpoint=http://127.0.0.1:8420 service=default
已注入记忆使用指引（systemPrompt.context）
已注册 3 个记忆检索工具（tdai_memory_search / tdai_conversation_search / tdai_persona_read）
```

再随便聊两句，同一日志里会出现 `captured N/M via=turn/end session=...`；
Gateway 侧能看到对应的 `POST /v2/conversation/add`。

## 卸载

删实体与软链、从 `dsh.profile.bundles` 与 `plugin-state.json` 里移除条目，然后重启 DSH web。
对照本仓库 `docs/install.md` 的四处登记表逐项清理即可。

## License

MIT（本插件自身）。它调用的上游 TencentDB Agent Memory 也是 MIT。
