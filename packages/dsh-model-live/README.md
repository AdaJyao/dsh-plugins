# dsh-model-live · 模型调用实时监视

DSH（DeepSeek Harness）插件：**实时**显示每一次模型调用，并把模型相关数据（上下文窗口、最大输出、
输入模态、推理档位、缓存命中、实测速率）一并摆出来。

- **悬浮挂件**（`shell.overlay`，order 96）：默认贴在**聊天区左上角**（侧栏右缘 +16px，纵向约占窗口高度
  9%），进行中的调用一眼可见；可拖动，单击展开明细。默认位置在挂载时**实测侧栏宽度**，所以拖动过侧栏也不会错位。
  展开后从上到下是：**进行中**（模型显示名 + 本地/云端徽标 + 实时 tok/s + 上下文进度条）→
  **最近调用**（时刻 · 具体模型 + 本地/云端徽标 · 耗时·token·速度）→ **按模型**（每个模型的进行中/累计、
  平均速度、最近调用时刻，进行中的排前面）→ 累计统计 → 连接方式。
  **「本地 / 云端」徽标**（0.3.3 起）按 provider 前缀识别本地推理服务（`spark-local`、`ollama` …），
  让"这条调用到底跑在哪台机器上"一眼可辨 —— 云端 API 与本地模型混在一张表里时，光看模型名分不出来。
- **设置页**（`settings.section`，order 136，「模型调用监控」）：进行中明细、最近调用表、
  模型数据表、模型目录、累计统计。

## 三个观测源

| 源 | 看得见谁 | 怎么做的 |
|---|---|---|
| ① **本进程**：`llm/stream` 瀑布 | 这个 DSH 进程里的每一次模型调用（含子代理、标题生成） | 在链路最外层包一层**只读**异步生成器：chunk 原样透传（同一对象），只在两侧计数 |
| ② **外部进程**：`$DSH_HOME/sessions` 会话日志 | **别的 DSH 进程**里的调用 —— 例如 `dsh --profile headless` 拉起的执行者会话 | 增量 Tail `sessions/<工作区>/<会话 id>/session.jsonl.zstd`（多帧 zstd，只读新字节），由 `request/context` / `assistant/chunk`（含打包行 `text-chunks` 等）/ `assistant/message` 重建每次调用 |
| ③ **模型运行时日志**：**独立服务** `dsh-runtime-log` | **模型自己怎么说的** —— 加载、上下文尺寸、槽位、每次推理的提示/生成耗时与 tok/s、报错 | 服务经 SSH **只读增量拉取**模型主机上的日志，本插件只读它的 `/api/state`（HTTP）。采集与 DSH 解耦：DSH 启停、插件停用都不影响采集；服务自带网页，不用 DSH 也能看 |

**为什么必须有两个源**：本部署的**本地模型（ollama）调用大多跑在 headless 执行者进程里**，
与 web 进程共用同一个 `$DSH_HOME`。只订阅瀑布的话，界面里就只有云端 API 的调用 ——
这正是"插件只显示云端调用、看不到本地模型"的原因。

①②两条源的记录会自动去重（同会话 + 同模型 + 结束时间落在 5 秒容差内即视为同一次调用，
以本进程的实时记录为准），所以同一次调用不会被算两次。界面里用「来源」列区分：
`本进程` / `外部·<工作区名>`。③不产生"调用"记录，它进的是设置页里的
「模型运行时日志」面板（按来源分标签，可看到 llama.cpp 与 Ollama 服务端各自的日志）。

### ③ 的独立服务（本部署）

采集器在 **`/vol1/1000/DeepSeek herness/project/dsh-runtime-log`**：独立进程 + 自带网页
（`http://<NAS>:18610/`）+ 用户级 cron 看护（`@reboot` + 每分钟 guard）。它负责 SSH 拉取，
本插件只是消费者；服务不可达时面板如实标注，另外两个源照常工作。
服务地址可用环境变量 `DSH_RUNTIME_LOG_URL` 覆盖（默认 `http://127.0.0.1:18610`），
用 `DSH_MODEL_LIVE_RUNTIME=0` 可整体关掉这一路。

它默认采集的目标：

| 源 id | 文件 | 是什么 |
|---|---|---|
| `spark-x25` | `C:\llama\logs\spark-x25.log` | Spark-X2.5-4B（llama.cpp）的 stdout —— llama.cpp 主要写 stderr，这个文件通常是空的 |
| `spark-x25-err` | `C:\llama\logs\spark-x25.err.log` | Spark-X2.5-4B 的 stderr：模型加载、slot 分配、每次 `print_timing`（含 tok/s） |
| `ollama-server` | `%LOCALAPPDATA%\Ollama\server.log` | Ollama 服务端：模型加载/卸载、请求、GIN 访问日志、错误 |

主机、路径、端口、节奏都在那个服务的 `config.json` 里改（支持多主机：每个源可单独指定 `sshHost`）。

## 数据从哪来

| 数据 | 来源 | 说明 |
|---|---|---|
| 每次模型调用（本进程） | 内核 `llm/stream` 瀑布 | 见上表 ① |
| 每次模型调用（其它进程） | 会话日志增量回读 | 见上表 ②；回填窗口默认 6 小时 |
| 模型加载/槽位/推理耗时、模型自报 tok/s、运行时报错 | 远端日志文件增量拉取 | 见上表 ③；默认 5 秒一拍，只取新增字节 |
| 首包/首字延迟、耗时、chunk 数 | 上述分片流 | 首个 chunk / 首个非空 text·reasoning delta 的时间戳 |
| 输入·输出·缓存读·思考 token | `usage` 分片 | provider 真实回报值；未回报前速率按字符数估算并标 `~` |
| 模型显示名、上下文窗口、最大输出、输入模态、推理档位 | `llm.resolveModelInfo(provider, model)` | 与模型选择器同源，按模型缓存 |
| 提供方清单 | `llm.listProviders()` | |
| 模型目录（端点实际广告的模型） | `llm.listModels(provider)` | 按需加载，60 秒缓存 |

## 传输

- `GET  /_dsh/model-live/events` — SSE：结构变化推 `snapshot`，进行中推 `tick`（300ms 节奏），
  20 秒一次 `ping` 心跳；**空闲时零流量**。
- `POST /_dsh/model-live/state` — 同一份快照（浏览器在 SSE 不可达时自动降级为 1.5 秒轮询）。
- `POST /_dsh/model-live/catalog` — 提供方模型目录（`{ provider }` 可选，缺省全部提供方）。
- `POST /_dsh/model-live/clear` — 只清本插件的内存记录，不碰会话、日志或任何文件。

路由挂在 `/_dsh/` 之下是**刻意**的：该前缀已在 fnOS 门户网关 `bridge.mjs` 的改写表内，
直连 `127.0.0.1:23006` 与经门户 `/app/dsh-qddev` 都可达，无需改网关。

## 只读承诺

1. 不注入、不改写、不缓存请求；`llm/stream` 的下游异常原样抛回内核，中断/取消语义不变。
2. 观测逻辑全部包在 try/catch 中：即便本插件出错，模型调用照常进行。
3. 不落盘：统计只存在于 Host 内存，DSH 重启即清零；没有任何凭据、密钥或对话内容被读取或外发。
4. 不做任何计费断言：token 是 provider 回报的原始计数，成本估算不在本插件范围内。

## 安装

```bash
# 1. 构建浏览器半边（零依赖，产物 = client/dist/index.js）
node client/build.mjs

# 2. 打包
npm pack
```

然后在 DSH 的插件市场里安装该 tgz；或按本机既有的市场同构路径安装
（实体 → profile symlink → profile bundles → plugin-state.json），见 `spec.json`。

## 自检

```bash
# Host 半边：分片原样透传（同一对象）、异常原样抛回、五种状态、usage 归类、四个路由与 SSE 帧序
node test/simulate.mjs

# Host + Client 进程内端到端：真代码 + 假 ctx / EventSource / React / 合成会话日志
node test/e2e-inprocess.mjs

# 会话日志观测（第二观测源）：直接扫真实 `$DSH_HOME/sessions`，找回别的进程里的本地模型调用
node test/session-log-scan.mjs

# 运行时日志客户端（第三观测源）：读独立服务的 /api/state（含降级与节流）
node test/runtime-client.mjs

# 采集器本身的自检在独立服务仓库里：
#   node "/vol1/1000/DeepSeek herness/project/dsh-runtime-log/test/collector-test.mjs"
```

## 已知取舍

- 速率带 `~` 表示**估算**（provider 尚未回报 usage 时按 2.5 字符/token 折算）；收到 usage 后变精确值。
- 平均速率的生成窗口不足 200ms 时返回 `—`（样本太小，算出来的是噪声）。
- 只保留最近 120 次调用（超出丢最老的），快照里只带最近 30 条。
- 「最近调用」= 内核视角的每一次 `llm/stream` 调用，包含标题生成、子代理等内部调用；
  用「会话」列区分（`sessionId` 前 8 位）；「最近调用」与「按模型」两个区块都会标出**具体模型**与本地/云端。
- 「本地/云端」是**前缀启发式**（`^(ollama|spark|llama|lm-?studio|vllm|local|koboldcpp|text-generation)`），
  认不出来的一律按"云端"显示：宁可少标，也不要把不认识的 provider 错标成本地。
- 累计统计里的「外部进程调用 N 次」指的是**别的 DSH 进程**（例如 headless 执行者），
  **不等于**"本地模型调用"——实测里外部进程调用绝大多数仍是云端模型；本地模型的条数看「本地模型调用」那一行。
- 会话日志来源（外部进程）**没有首包延迟**：日志里没有"请求发出"的时刻，耗时从**首个分片**起算
  （因此比实时观测的耗时略短），首字延迟照常可得。
- 外部进程的调用只有**结束后**才会出现在列表里：日志按批次落盘，进行中的调用在磁盘上还不完整。
- 会话日志只读：不写、不改、不删；每个 tick 每个文件最多读 512KB（默认 2 秒一拍），
  文件被截断则重置该文件的增量状态。
- 运行时日志源依赖**独立服务 + NAS → 模型主机的 SSH 免密**。服务挂了或拉不到时只在面板上
  标「采集异常」/「独立服务不可达」，不影响前两个源；每台主机只跑一条 ssh、单次 25 秒超时。
- 运行时日志的 `tok/s` 是**模型自报**的（llama.cpp 的 `print_timing`），与插件按
  usage/字符数算出来的速率是两套口径，可能不完全一致 —— 面板里标明来源，便于对照。

## 许可

MIT
