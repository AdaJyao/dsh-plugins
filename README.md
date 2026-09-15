# DSH 插件合集 · dsh-plugins

**DeepSeek Harness（DSH）插件的一个仓库搞定**：每个插件独立成包、独立版本、可单独安装；
配套的预打包 tgz 放在 [`releases/`](releases/)，**下载即装**，不需要自己构建。

> 这个仓库是原来 `dsh-api-balance` 仓库的**合并升级版**：余额挂件搬进来了，后续新插件也都往这里加。
> 老仓库保留为历史入口，不再更新（见文末）。

## 插件一览

| 插件 | 版本 | 一句话 | 抓手 |
|---|---|---|---|
| [**dsh-model-live**](packages/dsh-model-live) | 0.3.3 | **模型调用实时监视**：每次调用的模型 / 耗时 / 首字延迟 / token / 速率，外加"模型自报"的实测速度与运行时日志 | 悬浮挂件（可拖动）+ 设置页 |
| [**dsh-api-balance**](packages/dsh-api-balance) | 0.1.1 | 只读展示 DeepSeek API 账户余额 | 悬浮挂件 + 设置页 |
| [**dsh-supervisor-tick**](packages/dsh-supervisor-tick) | 0.1.0 | DSH **进程内**定时器：每 120 秒跑一次外部看门狗脚本（给"监督者/执行者"工作流用） | 无界面（Host-only） |
| [**dsh-tdai-memory**](packages/dsh-tdai-memory) | 1.0.0 | 接 **TencentDB Agent Memory**：注入记忆使用指引 + 三个只读检索工具（L1/L0/L3）+ 回合结束自动归档 | 无界面（Host-only） |

前三个插件遵守同一条铁律：**只读、不改会话、不注入请求、不落盘**。装错了、停用了，只会少一块信息，不会影响 DSH 本身。

**`dsh-tdai-memory` 是例外，请单独看它的说明**：它会主动做两件有副作用的事——
① 往每个会话注入一段「怎么用长期记忆」的指引（`systemPrompt.context`）；
② 每个回合结束时，把成对的 user + assistant 原文 POST 给外部的 Memory Gateway（`capture: false` 可关）。
也就是说**聊天内容会离开 DSH 进程**（默认目标仍是本机回环地址、数据落本地 SQLite/Markdown）。
它的三个工具是只读的；不需要长期记忆的话别装，或者把 `capture` 关掉只留工具。

## 安装

### 方式 A：下载预打包 tgz（推荐）

到 [`releases/`](releases/) 拿对应的 `<插件名>-<版本>.tgz`，然后：

```bash
# DSH_HOME 一般是 /vol1/@appdata/<app>/dsh-home 或 ~/.dsh
export DSH_HOME=/path/to/dsh-home
scripts/install-plugin.sh releases/dsh-model-live-0.3.3.tgz
```

脚本做四件事（DSH 插件市场同构的四处登记，缺一不可），并在动手前备份：

1. 解包到 `$DSH_HOME/plugins/<name>/<version>/`
2. 在 `$DSH_HOME/profiles/<profile>/node_modules/` 建软链（Node 解析用）
3. 往该 profile 的 `package.json` → `dsh.profile.bundles[]` 里登记（**启动时据此加载**）
4. 往 `$DSH_HOME/plugin-state.json` 里记账（设置 → 插件 里能看到、能停用）

**登记完需要重启 DSH web**（花名册是启动时读的，没有热更新）：重启方式随部署而异，
常见是给守护进程发信号或重启那个应用；本机（fnOS 上的 DSH 应用）是写一个重启标志文件交给它的 supervisor。

### 方式 B：从源码装

```bash
cd packages/dsh-model-live
npm run build            # 生成 client/dist/index.js（零依赖手写打包，见 client/build.mjs）
npm pack                 # 产出 dsh-model-live-<version>.tgz
```

再把 tgz 按方式 A 装进去。**注意**：DSH 的插件实体目录里 Node 解析够不到 `profiles/node_modules`，
所以带依赖的插件必须把依赖一起打包进 tgz（本仓库三个插件都是零运行时依赖，直接 `npm pack` 即可）。

### 方式 C：离线/手工

DSH 的插件实体就是一个目录：把 `packages/<插件>` 整个拷到 `$DSH_HOME/plugins/<name>/<version>/`，
再做方式 A 里的第 2~4 步即可。目录内容与 npm 包完全一致。

## 仓库结构

```
.
├── packages/                 # 每个插件一个目录，结构 = npm 包结构
│   ├── dsh-model-live/
│   │   ├── lib/              #   Host 半边（跑在 DSH 进程里）
│   │   ├── client/           #   浏览器半边（index.js 源码 + build.mjs + dist 产物）
│   │   ├── test/             #   自检脚本（不依赖 DSH 也能跑）
│   │   ├── cordis.patch.yml  #   插件声明（webServer 路由等）
│   │   ├── package.json      #   dsh.bundle / dsh.client 元数据在这里
│   │   └── README.md         #   该插件的完整说明
│   ├── dsh-api-balance/
│   ├── dsh-supervisor-tick/
│   └── dsh-tdai-memory/      #   纯 Host、零依赖：接 TencentDB Agent Memory
├── releases/                 # 预打包 tgz（下载即装）
├── scripts/
│   ├── build-all.sh          # 全量构建 + 打包到 releases/
│   └── install-plugin.sh     # 把 tgz 装进指定 DSH_HOME（四处登记 + 备份）
└── docs/install.md           # 安装/排错细节
```

## 再加一个新插件

1. 在 `packages/` 下新建目录，`package.json` 里必须有：
   ```json
   { "name": "dsh-xxx", "version": "0.1.0", "type": "module", "main": "lib/index.js",
     "exports": { ".": "./lib/index.js", "./client": "./client/dist/index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
     "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
              "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] } } }
   ```
2. 只写 Host 半边就够的话，`dsh.client` 可以不写（如 `dsh-supervisor-tick`、`dsh-tdai-memory`）。
3. 写浏览器半边时，客户端 bundle 必须自带装载外壳：
   `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => module.exports })` —— 纯 JS 手写即可，
   参考 `packages/dsh-model-live/client/build.mjs`（20 行的零依赖打包脚本）。
4. 跑 `scripts/build-all.sh`，再在本仓库 README 的表格里加一行。

## 这几条是踩出来的（写插件前值得看一眼）

- **客户端 bundle 的装载外壳是硬要求**：少了 `__ModuleLoader__.load` 外壳，浏览器里就是白屏 + 控制台一句
  “module not found”，Host 半边再对也没用。
- **`package.json` 必须声明 `dsh.bundle.patch`**，否则市场/加载器不认这个包。
- **实体目录要自带依赖**（见方式 B 的注意）：打包时别指望 `profiles/node_modules`。
- **观察内核要用只读包装**：例如 `dsh-model-live` 是在 `llm/stream` 瀑布最外层套一层异步生成器，
  chunk 原样透传、只做计数 —— 这样对会话行为是零影响，异常/中断语义也保持内核原样。
- **别在 Host 里做重活**：定时器要 `.unref()`，磁盘/网络访问要有超时与 try/catch，插件永远不该拖垮 DSH。
- **服务是晚挂载的：`ctx.get()` 会拿到 `undefined`，要用 `ctx.inject`**（`dsh-tdai-memory` 实测踩到）：
  在 `apply()` 里同步读 `ctx.get('tools')` / `ctx.get('systemPrompt')` 都是 `undefined`。
  若照习惯写成 `if (x !== undefined) { …注册… }`，结果是**插件装载成功、却静默什么都不做、一条报错都没有**。
  正确写法是 `ctx.inject(['tools'], scope => { … })`（等依赖出现再执行，与官方 `dsh-user-approval` 同款）。
  `ctx.inject(['webServer'], …)` 在这个仓库里本来就是这么用的，同一条规律。
- **调试期别用 `ctx.logger` 当载入证据**：它的输出不进进程 stdout（`app.log`），
  用脚本校验"插件有没有装载"时会误判成没装。装到 `$TRIM_PKGVAR/app.log` 的只有 `console.log/error`。
- **源码注释里别出现 `*/`**：注释里写路径通配（例如 `dir/*/node_modules`）会**提前终止块注释**，
  随后 `node --check` 报 `Unexpected token 'import'` —— 看起来像语法错误，其实是注释被截断。
- **`dsh --profile web --help` 是个免费的免重启探针**：它会真的走一遍花名册装载，
  在插件 `apply()` 开头 `console.log` 一行就能确认有没有被加载、config 有没有传进来，
  不必为了验证一次改动静默重启线上进程。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

> 老仓库 [**AdaJyao/dsh-api-balance**](https://github.com/AdaJyao/dsh-api-balance) 已并入本仓库
> （`packages/dsh-api-balance`），保留作为历史入口，**不再单独更新**。
