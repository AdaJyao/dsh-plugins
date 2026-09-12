# dsh-api-balance

只读展示 DeepSeek API 账户余额的 DSH 插件：悬浮挂件 +「设置 → API 余额」页面。

## 它做什么

- **悬浮挂件**（`shell.overlay`）：`🐳 ¥52.14`。默认贴在**聊天区左侧、约窗口高度 1/3 处**（侧栏右缘 +16px；
  侧栏宽度在挂载时实测，拖动过侧栏也不会错位）。可拖到屏幕任意位置，单击展开明细（赠金 / 充值 / 账户状态 /
  更新于）。鼠标悬停显示完整 tooltip。
- **设置页**（`settings.section`）：一级导航里的中文名条目「API 余额」，展示余额、币种、查询节奏、数据接口与凭据来源。
- **只读**：没有任何充值、扣费或写操作，也不修改账户设置。

## 三条设计约束

1. **查询节奏与官方更新节奏一致**：对官方 `/user/balance` 的调用不快于每 5 分钟一次，且失败也计入该节奏（按 `attemptAt` 判定）。刷新页面、多开标签、多个界面同时轮询都不会额外打到官方接口。界面每 60 秒只重读 Host 缓存（本地 HTTP，不产生官方调用）。
2. **状态模型区分「尝试」与「成功读数」**：`lastAttempt` 决定展示形态（fresh / stale / error）与限速，`lastSuccess` 是失败时唯一能拿出来的事实。二者混用会导致「成功一次反而丢掉新值」，因此刻意分开。连续失败时界面保留上次成功读数并标黄，而不是把值丢光。
3. **密钥不落地**：API Key 由 Host 的 `credentials` 服务解析（`DEEPSEEK_API_KEY`），经 **stdin** 交给 `curl -K -` 的配置解析器 —— 不进 argv（`ps` 看不到）、不进子进程环境、不写文件、不下发到浏览器。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Host 半边：读凭据、调官方接口、限速缓存，经 webServer 路由 `/_dsh/api-balance/balance` 暴露给浏览器 |
| `client/index.js` | Client 半边源码（CJS 模块体，无 JSX） |
| `client/build.mjs` | 零依赖构建：套 `__ModuleLoader__` 装载外壳 → `client/dist/index.js` |
| `client/dist/index.js` | 实际被浏览器加载的 bundle（构建产物） |
| `cordis.patch.yml` | composition 行：把本插件 insert 进 profile |

## 路由为什么挂在 `/_dsh/` 下

静态插件没有 `harness` / `host` 全局，Host↔Client 走 webServer HTTP 路由。

当 DSH 部署在门户或反向代理之后时（例如某些 NAS 应用门户），网关通常只转发一组固定的路径前缀，而 `/_dsh/` 是其中常见的既有前缀之一。把路由挂在这个前缀下，可以让它在**直连端口**与**门户路径**两种访问方式下都可达，从而不必修改网关配置 —— 这也是选择它的唯一理由；若你的部署没有网关，任何前缀都一样。

## 构建

```bash
node client/build.mjs              # 产出 client/dist/index.js
node --check client/dist/index.js  # 语法自检
```

## 自检：挂件默认位置

默认位置 = `实测侧栏宽度 + 16px`（横向贴住聊天区左缘）× `窗口高度 × 33%`（纵向约三分之一处）。
侧栏宽度在挂载时实测，所以用户拖动过侧栏也不会错位；量不到时回退 280px。

```bash
# 参数：<bundle> <期望 left> <期望 top> [侧栏宽度=280] [窗口高度=1000]
node test/widget-position.mjs client/dist/index.js 296 330
node test/widget-position.mjs client/dist/index.js 256 264 240 800
```

该测试用可重渲染的迷你 React + 假 DOM 把**真实组件**跑起来，断言最终落到根节点上的
`style.left` / `style.top`（并断言不再使用 `right`/`bottom` 锚定、测量完成后不再是隐藏态）。

## 安装

### 方式一：用预打包 Release（推荐）

从 [Releases](https://github.com/AdaJyao/dsh-api-balance/releases) 下载与当前版本一致的 `dsh-api-balance-0.1.1.tgz`（`sha256sum` 可与 Release 说明核对），然后直接跳到下面「方式二」的第 3 步生成 `spec.json`。省掉构建与打包两步；若 Release 还没更新到该版本，请走方式二自行打包。

### 方式二：从源码自己打包

本仓库不含预打包的 `.tgz`，也不含带绝对路径的本地 `spec.json`（两者都在 `.gitignore` 内）。

```bash
# 1. 构建客户端 bundle
node client/build.mjs

# 2. 打成 npm 风格 tarball —— 必须单顶层目录 package/
rm -rf /tmp/pack && mkdir -p /tmp/pack/package
cp -r package.json cordis.patch.yml README.md LICENSE lib client /tmp/pack/package/
tar czf dsh-api-balance-0.1.1.tgz -C /tmp/pack package
sha256sum dsh-api-balance-0.1.1.tgz

# 3. 照 spec.example.json 生成 spec.json（填 tgz 绝对路径与 sha256），
#    交给部署自带的插件安装器落盘 —— 商店条目 + 实体 + profile symlink + bundles + plugin-state，
#    然后重启 DSH。
```

安装器要求：tarball 单顶层目录；`package.json` 必须声明 `dsh.bundle.patch`。

## HTTP 接口

`POST /_dsh/api-balance/balance`（请求体可省略）

```json
{ "ok": true, "data": {
  "ok": true, "at": 1757600000000, "attemptAt": 1757600000000, "stale": false, "error": null,
  "intervalMs": 300000, "isAvailable": true, "currency": "CNY",
  "totalBalance": "52.14", "grantedBalance": "0.00", "toppedUpBalance": "52.14",
  "keySource": "file"
} }
```

`data.ok=false` 表示本次查询失败：带 `stale: true` 时数据字段是上次成功读数，不带则是从未成功过。

## 卸载

市场 UI 卸载，或删除 profile bundles / `plugin-state.json` 条目 / 实体目录后重启。
