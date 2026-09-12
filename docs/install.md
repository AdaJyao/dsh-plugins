# 安装与排错

## 从哪装

| 场景 | 怎么做 |
|---|---|
| 只想用 | 下载 [`releases/`](../releases/) 里对应的 `<插件名>-<版本>.tgz`，跑 `scripts/install-plugin.sh <tgz>` |
| 改一点 | `cd packages/<插件>`，`npm run build`（如果它有客户端半边），`npm pack`，再按上面装 |
| 完全手工 | 把 `packages/<插件>` 整个目录拷进 `$DSH_HOME/plugins/<name>/<version>/`，再做四处登记 |

## DSH 插件的四处登记

DSH 加载一个插件靠四样东西，少一样就会出现"装了但没反应"：

| # | 位置 | 作用 |
|---|---|---|
| ① | `$DSH_HOME/plugins/<name>/<version>/` | **插件实体**（就是包内容：lib/ client/dist/ cordis.patch.yml package.json） |
| ② | `$DSH_HOME/profiles/<profile>/node_modules/<name>` → 实体目录 | 软链，给 Node 解析用 |
| ③ | `$DSH_HOME/profiles/<profile>/package.json` → `dsh.profile.bundles[]` | **花名册**，启动时按这个列表加载 |
| ④ | `$DSH_HOME/plugin-state.json` → `plugins["<name>"]` | 市场/设置页的账面状态（`enabled: false` 就是停用） |

**改完必须重启 DSH web**：花名册没有热更新。`scripts/install-plugin.sh` 会自动备份 ③④ 两个文件到
`$DSH_HOME/plugin-install-backup/<时间戳>/`，回滚就是拷回去 + 删实体与软链。

## 常见故障

| 现象 | 多半是 |
|---|---|
| 设置页看不到插件 | ③ 花名册没加，或者没重启 |
| 浏览器里没界面、控制台报 module not found | 客户端 bundle 缺 `window.__ModuleLoader__.load(...)` 外壳，或 `package.json` 里没写 `dsh.client` |
| Host 半边报 `Cannot find module` | 实体目录缺依赖 —— 打包时要自带依赖（本仓库三个插件零依赖，无此问题） |
| 挂件能显示但数据是 `—` | 该插件依赖的外部服务没跑（例如 `dsh-model-live` 的"模型自报速度"依赖独立的运行时日志服务），插件本身没问题 |
| 装了之后 DSH 起不来 | 直接看 DSH 自己的启动日志；回滚见上一节 |

## 卸载

1. `$DSH_HOME/plugin-state.json` 里删掉该插件条目（或者先把 `enabled` 置 false 观察一版）
2. `$DSH_HOME/profiles/<profile>/package.json` 的 `bundles[]` 里删掉名字
3. 删软链与实体目录
4. 重启 DSH web
