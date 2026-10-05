# dsh-pi-ai-vision

让 DSH 自动为 pi-ai 路由声明「模型支持图片」，**不用再逐个模型手改配置**。

- **Host-only**：没有界面、没有客户端半边。装了以后照常聊天，只是本地模型能收图了。
- **只补不删**：只往模型元数据上补 `inputModalities`，从不覆盖你手写的模态声明。
- **不阻塞请求**：能力端点走后台刷新，判定路径是同步的，端点挂了也不会拖慢任何一次调用。

## 它解决什么

`@deepseek-ai/dsh-llm-pi-ai` 解析模型输入模态的顺序是：

1. 模型条目的 `input`；
2. pi-ai 内置 catalog（只覆盖云端厂商）；
3. 路由的 `defaultInput`，**默认 `[text]`**。

本地 llama.cpp / LM Studio / vLLM 这类网关不在内置 catalog 里，所以模型条目只要没写
`input`，一律被判成纯文本，聊天界面直接拒绝图片附件：

    Model "xxx" does not support image input.   (MODEL_DOES_NOT_SUPPORT_IMAGES)

改配置当然能解决，但每加一个新模型都要再手写一次 `input: [text, image]`。本插件把这个
判断自动化了。

## 它怎么工作

在**两层**上补 `inputModalities`，两层缺一不可：

**A. `llm` 服务层**

| 方法 | 谁在用 |
|---|---|
| `resolveModelInfo` | `dsh-host-apiproxy` 的图片准入闸门（就是报「当前模型不支持图片」的那个） |
| `resolveModelInfoFor` | 运行时的模型能力查询 |
| `listModels` | 模型列表 / 设置页 |

**B. 适配器层** —— 每个受管路由的适配器实例的 `resolveModel`

真正组装请求的那条路是：

```
LlmRuntime.prepareCall → registration.adapter.prepareCall → adapter.resolveModel()
```

它返回的 `inputModalities` 直接进 `normalizeModelInfo`，**不经过** `llm.resolveModelInfo` /
`resolveModelInfoFor`。

> **为什么要两层**：只做 A，图片会被 apiproxy 放行，却在 dispatch 之前被
> `projectImagesForTextModel` 换成文本占位符
> （`[image omitted because this model accepts text only; …]`）—— 于是模型自己回一句
> 「我读不到图片」，看起来像插件完全没生效。只做 B，界面根本不让附图片。
> 这个坑是实测踩出来的：1.0.0 只做了 A，图片能发出去但模型收不到。

模态来源按优先级：

1. **显式覆盖** —— 本插件配置里的 `models` 表；
2. **能力端点** —— 路由的 `capabilityUrl`（同步读缓存，后台刷新，绝不阻塞请求）；
3. **模型名模式表** —— 保守兜底，可在配置里关掉。

任何一级给出「未知」时原样返回；上游明确说 `supportsVision: false` 时也**不做改动**——
手写在 provider 配置里的模态永远优先，插件不会跟你的显式声明打架。

> **为什么宁可漏判不可误判**：多声明的代价不是一次报错。图片会被先持久化进会话日志，然后被
> 提供方在轮次中途拒绝；此后该模型每一轮都会重发那张它处理不了的图，会话就卡死了，只能
> 换模型、fork 到图片之前，或开新会话。所以模式表里**故意不收录 gemma-3 这类同族混编**
> （gemma-3-1b 没有 mmproj，是纯文本；4b/12b/27b 才是多模态）。
>
> 同理，若能力端点与你的手写配置冲突，插件选择**退让**。

## 能力端点

任何能回答「这个模型收不收图」的 JSON 接口都行。判定规则：

- 模型数组：响应本身是数组，或 `models` / `data` / `list` / `items` / `result` 之一，
  或用 `modelsPath` 显式指定（支持点号路径）；
- 能力字段：`visionFields` 里第一个能解释的，缺省依次试
  `supportsVision`、`isMultimodal`、`supports_vision`、`vision`、`capabilities.vision`、`modalities`；
  布尔直接取用，数组看里面有没有 `image`。

以 **llama.cpp-hub** 为例，`GET /api/models/list`（无需鉴权）返回：

```json
{ "models": [ { "id": "gemma-4-e4b-it-q4_k_m", "supportsVision": true, "supportsAudio": true } ] }
```

## 配置

```yaml
- id: 'dsh-pi-ai-vision'
  name: 'dsh-pi-ai-vision'
  config:
    patternFallback: true          # 全局模式兜底开关，默认 true
    routes:
      llama:                       # 键 = pi-ai 路由 id
        capabilityUrl: http://192.168.31.222:8090/api/models/list
        modelsPath: models         # 模型数组在响应里的路径；缺省自动探测
        visionFields:              # 能力字段候选；缺省见上
          - supportsVision
          - isMultimodal
        timeoutMs: 8000            # 单次查询超时
        ttlMinutes: 10             # 兜底轮询间隔（适配器拓扑变化会立即刷新）
        apiKeyEnv: LLAMA_API_KEY   # 可选：从环境变量取 Bearer 令牌
        headers: {}                # 可选：额外请求头
        useBuiltinPatterns: true   # 是否叠加内置模式表
        patterns: []               # 追加模式（正则字符串）
        patternFallback: true      # 该路由单独的兜底开关
        models:                    # 显式覆盖，优先级最高
          my-special-model: [text, image]
```

路由值也可以直接写成字符串，等价于只给 `capabilityUrl`：

```yaml
    routes:
      llama: http://192.168.31.222:8090/api/models/list
```

## 验证

不启动 DSH 也能跑：

```bash
node test/selftest.mjs                      # 纯函数 + 用真实 cordis 跑端到端（本地桩端点）
node test/live-check.mjs                    # 对着真实端点打印判定表
node test/live-check.mjs http://其它地址:端口/api/models/list 路由id
```

自测输出示例：

    [  ] bartowski_Qwen2.5-1.5B-Instruct-GGUF_Q4_0    上游 supportsVision=false -> （不改动）
    [图] gemma-4-e4b-it-q4_k_m                        上游 supportsVision=true  -> text + image
    [  ] unsloth_gemma-3-1b-it-GGUF_Q4_0              上游 supportsVision=false -> （不做改动）

`selftest` 用安装里的**真实 cordis** 挂一个假 llm 服务 + 假适配器，跑完整链路
`apply() → 后台刷新 → llm 服务层接管 → 适配器层接管 → 卸载回滚`，共 26 项断言。

### 怎么确认它真的装上了

`ctx.logger` 的输出不进进程日志，所以从外面看不出插件有没有生效。为此插件在装载时会写一个
**只读状态文件**：

```
~/.dsh/pi-ai-vision/status.json
```

```json
{
  "plugin": "pi-ai-vision",
  "loadedAt": "2026-10-06T02:20:00.000Z",
  "updatedAt": "2026-10-06T02:30:00.000Z",
  "llmMethodsPatched": 3,
  "adaptersWrapped": 1,
  "capabilityCounts": { "llama": 24 },
  "visionModels": { "llama": ["gemma-4-e4b-it-q4_k_m", "…"] }
}
```

- `llmMethodsPatched` 应为 3，`adaptersWrapped` 至少 1 —— 两层都接管到了才算完整；
- `capabilityCounts` 是能力端点返回的模型数，`visionModels` 是判为支持视觉的名单；
- 文件不存在 = 插件没装载；`adaptersWrapped: 0` = 只接管了半层（就是 1.0.0 的 bug）。

设 `statusFile: false` 可关掉这个文件。

## 安装

### 下载即装（推荐）

到仓库根目录的 [`releases/`](../../releases/) 拿 `dsh-pi-ai-vision-<版本>.tgz`：

```bash
# Linux / fnOS / Docker：用仓库根目录的安装脚本
DSH_HOME=/path/to/dsh-home ../../scripts/install-plugin.sh releases/dsh-pi-ai-vision-1.0.1.tgz
```

### Windows

包内自带 `install.ps1`，做的是同一件事（实体 + 两个 profile 的 junction + 花名册），
并且每个 `package.json` 改动前都留时间戳备份：

```powershell
.\install.ps1 -DryRun          # 先看它要干什么
.\install.ps1                  # 装进 desktop 和 web 两个 profile
.\install.ps1 -Uninstall       # 摘干净
```

### 手工

把本目录整个拷到 `$DSH_HOME/plugins/dsh-pi-ai-vision/<版本>/`，再在
`$DSH_HOME/profiles/<profile>/node_modules/` 下建链接、把包名追加进该 profile
`package.json` 的 `dsh.profile.bundles[]`。

> **装完必须重启 DSH**：花名册是启动时读的，没有热更新。

## 已知边界

- **依赖非官方扩展点。** `dsh-llm` 只声明了 `llm/stream` 一个 waterfall，模态能力没有官方
  钩子，所以这里全是方法接管：`llm` 服务的三个方法名、适配器的 `resolveModel`、以及
  「写 `ctx.llm` 会穿透到共享 service 实例」「`llm.adapters` 是一个 `provider → { adapter }`
  的 Map」这两条 cordis / 内核行为。任一变化都会在 `status.json` 里暴露
  （`llmMethodsPatched` / `adaptersWrapped` 掉数），日志里也会有 `接管失败`。
  源码注释里还记了两个踩过的坑：cordis 的服务代理**每次读取都返回新的包装函数**（不能用
  恒等比较判断写入成功），以及适配器实例是**按 provider 共享**的（一个 `PiAiAdapter` 服务所有
  pi-ai 路由，所以要按实例去重、按 provider 参数决定改不改）。
- **只管模态，不管模型清单。** 往路由里新增模型仍然要在 provider 配置里加一条；本插件负责的是
  「这条新模型该不该收图」。
- **启动瞬间可能还没判定**：端点查询是后台推进的，此时退回模式表。正常使用（请求发生在启动
  之后）不受影响。
- 卸载后需要**重启** harness 才彻底失效（插件自身会回滚，见自测最后一项）。

## 与仓库里其它插件的关系

`dsh-model-live` / `dsh-api-balance` 是「给人看」的挂件，本插件是「把内核判错的地方纠正回来」的
补丁。它**不改会话内容、不注入请求、不落盘**；唯一的副作用是改写自己挂在 `llm` 服务上的三个
方法，卸载即还原。
