/**
 * dsh-model-live — Client 端（web）
 *
 * 两个入口，共用同一份实时数据：
 *  - shell.overlay    右下角悬浮挂件：进行中的模型调用一眼可见，可拖动，单击展开
 *  - settings.section 设置页「模型调用监控」：进行中明细 + 最近调用 + 模型清单 + 模型目录
 *
 * 数据来源（Host 半边，见 lib/index.js）：
 *  - EventSource  GET  /_dsh/model-live/events   实时推送：snapshot（结构变化）/ tick（进行中增量）
 *  - fetch        POST /_dsh/model-live/state    SSE 不可达时的轮询兜底（1.5 秒一次）
 *  - fetch        POST /_dsh/model-live/catalog  提供方模型目录（按需加载）
 *  - fetch        POST /_dsh/model-live/clear    清空内存记录
 *
 * 静态插件（npm 包）没有 harness / host / styles 全局，所以：
 *  - CSS 用 document.createElement('style') 自己注入，并在插件卸载时移除
 *  - 定时器用原生 setInterval（浏览器半边就是普通页面代码）
 *
 * 本文件是 CJS 模块体，由 client/build.mjs 包进 __ModuleLoader__ 外壳后产出
 * client/dist/index.js —— 与官方 client 包的装载契约一致。
 */
const React = require('react')

/** 包名，必须与 package.json 的 name 一致（client-modules 按它对账）。 */
const PKG = 'dsh-model-live'
/** Host 路由前缀（挂在 /_dsh/ 下，门户网关改写表已覆盖）。 */
const ROUTE = '/_dsh/model-live'
/** 进行中调用的本地重绘节奏（毫秒）——让耗时/速率动起来。 */
const RENDER_MS = 250
/** SSE 首包看门狗：这么久没收到任何事件就判定不可用并转轮询。 */
const SSE_WATCHDOG_MS = 5000
/** 轮询兜底间隔。 */
const POLL_MS = 1500
/** 拖动与单击的区分阈值（像素，曼哈顿距离）。 */
const DRAG_SLOP = 4

const css = `
.dsh-mlv-widget{position:absolute;z-index:21;pointer-events:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px 11px;border-radius:14px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.35;font-variant-numeric:tabular-nums;user-select:none;touch-action:none;cursor:grab;transition:box-shadow .15s ease,background-color .15s ease}
.dsh-mlv-widget:hover{box-shadow:0 10px 28px rgba(0,0,0,.24)}
.dsh-mlv-widget--dragging{cursor:grabbing;box-shadow:0 14px 34px rgba(0,0,0,.3)}
.dsh-mlv-widget--wide{width:326px}
.dsh-mlv-head{display:flex;align-items:center;gap:7px;white-space:nowrap}
.dsh-mlv-icon{font-size:15px;line-height:1}
.dsh-mlv-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis}
.dsh-mlv-sub{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mlv-dot{width:7px;height:7px;border-radius:50%;flex:none;margin-left:auto;background:var(--dsw-alias-label-secondary)}
.dsh-mlv-dot--live{background:var(--dsw-alias-state-success-primary);animation:dsh-mlv-pulse 1.1s ease-in-out infinite}
.dsh-mlv-dot--ok{background:var(--dsw-alias-state-success-primary)}
.dsh-mlv-dot--warn{background:var(--dsw-alias-state-warn-primary)}
.dsh-mlv-dot--error{background:var(--dsw-alias-state-error-primary)}
@keyframes dsh-mlv-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dsh-mlv-rows{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-mlv-row{display:flex;justify-content:space-between;gap:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dsh-mlv-row>span:last-child{color:var(--dsw-alias-label-primary)}
.dsh-mlv-live{padding:6px 8px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:3px}
.dsh-mlv-liveTop{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.dsh-mlv-liveModel{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}
.dsh-mlv-liveRate{color:var(--dsw-alias-state-success-primary);font-weight:600}
.dsh-mlv-liveMeta{color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;gap:10px;flex-wrap:wrap}
.dsh-mlv-bar{height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dsh-mlv-barFill{height:100%;background:var(--dsw-alias-state-success-primary);transition:width .25s linear}
.dsh-mlv-hint{color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-mlv-err{color:var(--dsw-alias-state-error-primary)}
.dsh-mlv-page{display:flex;flex-direction:column;gap:12px;padding:2px;max-width:860px}
.dsh-mlv-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.dsh-mlv-pageHead{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.dsh-mlv-badge{margin-left:auto;font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-mlv-badge--live{color:var(--dsw-alias-state-success-primary)}
.dsh-mlv-badge--warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-mlv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:10px}
.dsh-mlv-stat{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:11px;background:var(--dsw-alias-bg-layer-2)}
.dsh-mlv-statLabel{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-mlv-statValue{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
.dsh-mlv-statSub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-mlv-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-mlv-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.dsh-mlv-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsh-mlv-table td{padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsh-mlv-table td.num,.dsh-mlv-table th.num{text-align:right;padding-right:12px}
.dsh-mlv-mono{font-variant-numeric:tabular-nums}
.dsh-mlv-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-mlv-warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-mlv-bad{color:var(--dsw-alias-state-error-primary)}
.dsh-mlv-dim{color:var(--dsw-alias-label-secondary)}
.dsh-mlv-note{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dsh-mlv-tag{flex:none;font-size:10px;line-height:1.5;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dsh-mlv-tag--local{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsh-mlv-tag--cloud{color:var(--dsw-alias-label-secondary)}
.dsh-mlv-recent{display:flex;align-items:baseline;gap:7px;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dsh-mlv-recent .t{flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-mlv-recent .m{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dsh-mlv-recent .v{flex:none;font-variant-numeric:tabular-nums}
.dsh-mlv-model{display:flex;align-items:baseline;gap:7px;white-space:nowrap;font-size:11.5px}
.dsh-mlv-model .m{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dsh-mlv-model .v{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-mlv-model--active .m{color:var(--dsw-alias-state-success-primary);font-weight:600}
.dsh-mlv-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-mlv-btn{font:inherit;font-size:12px;padding:4px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-mlv-btn:hover{background:var(--dsw-alias-bg-layer-1)}
.dsh-mlv-btn:disabled{opacity:.5;cursor:default}
.dsh-mlv-tags{display:flex;gap:5px;flex-wrap:wrap}
.dsh-mlv-tag{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-mlv-scroll{max-height:300px;overflow:auto}
.dsh-mlv-btn--on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l3);font-weight:600}
.dsh-mlv-log{max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:1px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5}
.dsh-mlv-logLine{display:flex;gap:8px;white-space:pre-wrap;word-break:break-all}
.dsh-mlv-logTime{color:var(--dsw-alias-label-secondary);flex:none}
.dsh-mlv-logSrc{color:var(--dsw-alias-label-secondary);flex:none;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mlv-logText{color:var(--dsw-alias-label-primary)}
.dsh-mlv-logLine--error .dsh-mlv-logText{color:var(--dsw-alias-state-error-primary)}
.dsh-mlv-logLine--warn .dsh-mlv-logText{color:var(--dsw-alias-state-warn-primary)}
`

/**
 * 注入本插件的样式表；返回移除函数。
 * @param {string} text - 原始 CSS 文本。
 * @returns {() => void} 移除该标签的清理函数。
 */
function insertCss(text) {
  const tag = document.createElement('style')
  tag.dataset.dshPlugin = PKG
  tag.textContent = text
  document.head.append(tag)
  return () => { tag.remove() }
}

/* ------------------------------ 格式化工具 ------------------------------ */

/**
 * 耗时：<1s 用毫秒，<60s 用秒，再长用分秒。
 * @param {number|null} ms - 毫秒。
 * @returns {string} 展示文本。
 */
function fmtDur(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return String(m) + 'm' + (s < 10 ? '0' : '') + String(s) + 's'
}

/**
 * token 数：千/百万缩写。
 * @param {number|null} n - 数量。
 * @returns {string} 展示文本。
 */
function fmtTok(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1000000).toFixed(2) + 'M'
}

/**
 * 速率文本；估算值加 ~ 前缀。
 * @param {number|null} tps - tok/s。
 * @param {boolean} estimated - 是否为估算。
 * @returns {string} 展示文本。
 */
function fmtTps(tps, estimated) {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return '—'
  return (estimated ? '~' : '') + (tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1)) + ' tok/s'
}

/**
 * 时钟（本地时区）。
 * @param {number|null} ms - 时间戳。
 * @param {boolean} withSeconds - 是否带秒。
 * @returns {string} 展示文本。
 */
function fmtClock(ms, withSeconds) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
  const base = pad(d.getHours()) + ':' + pad(d.getMinutes())
  return withSeconds ? base + ':' + pad(d.getSeconds()) : base
}

/**
 * 模型展示名：优先元数据里的显示名。
 * @param {object} row - 调用视图或模型行。
 * @returns {string} 展示文本。
 */
function fmtModel(row) {
  if (row === null || row === undefined) return '—'
  const name = typeof row.modelName === 'string' && row.modelName !== '' ? row.modelName : null
  const id = typeof row.model === 'string' ? row.model : ''
  if (name !== null && name !== id) return name + '（' + id + '）'
  return id === '' ? '—' : id
}

/**
 * 紧凑模型名：只用显示名（没有就退回 id），不带"（id）"后缀 —— 挂件一行放不下。
 * @param {object} row - 调用视图或模型行。
 * @returns {string} 展示文本。
 */
function fmtModelLabel(row) {
  if (row === null || row === undefined) return '—'
  const name = typeof row.modelName === 'string' && row.modelName !== '' ? row.modelName : null
  if (name !== null) return name
  if (typeof row.name === 'string' && row.name !== '') return row.name
  return typeof row.model === 'string' && row.model !== '' ? row.model : '—'
}

/**
 * 短模型名：挂件里用，超长截断。
 * @param {object} row - 调用视图。
 * @param {number} max - 最大字符数。
 * @returns {string} 展示文本。
 */
function fmtModelShort(row, max) {
  const text = fmtModelLabel(row)
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * 「本地 / 云端」徽标：光看模型名分不出这条调用跑在哪台机器上。
 * 判定用 Host 给的 local 标记（按 provider 前缀识别），缺省时按"云端"显示。
 * @param {object} row - 调用视图或模型行。
 * @returns {object} React 元素。
 */
function ModelTag(row) {
  const local = row !== null && row !== undefined && row.local === true
  return React.createElement('span', {
    className: 'dsh-mlv-tag ' + (local ? 'dsh-mlv-tag--local' : 'dsh-mlv-tag--cloud'),
    title: (local ? '本地推理服务' : '云端 API') + '：' + String(row === null || row === undefined ? '' : row.provider),
  }, local ? '本地' : '云端')
}

/**
 * 调用状态的中文标签与色调。
 * @param {string} status - active/ok/error/aborted/closed。
 * @returns {{label: string, tone: string}} 标签与 CSS 色调类名。
 */
function statusInfo(status) {
  switch (status) {
    case 'active': return { label: '进行中', tone: 'ok' }
    case 'ok': return { label: '完成', tone: 'ok' }
    case 'error': return { label: '失败', tone: 'bad' }
    case 'aborted': return { label: '已中断', tone: 'warn' }
    case 'closed': return { label: '已放弃', tone: 'dim' }
    default: return { label: status === undefined || status === null ? '—' : String(status), tone: 'dim' }
  }
}

/**
 * finish 原因的中文标签。
 * @param {string|null} kind - stop/tool-calls/max-tokens/error/aborted。
 * @returns {string} 展示文本。
 */
function finishLabel(kind) {
  switch (kind) {
    case 'stop': return '自然结束'
    case 'tool-calls': return '请求工具调用'
    case 'max-tokens': return '触顶 max tokens'
    case 'error': return '错误结束'
    case 'aborted': return '被中断'
    default: return kind === null || kind === undefined ? '—' : String(kind)
  }
}

/**
 * 调用来源：本进程实时观测，还是别的 DSH 进程（会话日志回读）。
 * 本地模型（ollama）在本部署里多跑在 `dsh --profile headless` 的执行者进程里，
 * 只有会话日志这条源能看见它们。
 * @param {object} row - 调用视图。
 * @returns {string} 展示文本。
 */
function sourceLabel(row) {
  if (row.source !== 'log') return '本进程'
  return row.workspace === null || row.workspace === undefined ? '外部会话' : '外部·' + row.workspace
}

/**
 * 上下文占用：token 数 / 窗口（带百分比）。
 * @param {object} row - 调用视图。
 * @returns {string} 展示文本。
 */
function fmtContext(row) {
  if (row.contextWindow === null || row.contextWindow === undefined) return '—'
  const window = fmtTok(row.contextWindow)
  if (row.contextTokens === null || row.contextTokens === undefined) return '窗口 ' + window
  const percent = typeof row.contextPercent === 'number' ? ' · ' + row.contextPercent.toFixed(1) + '%' : ''
  return fmtTok(row.contextTokens) + ' / ' + window + percent
}

/* ------------------------------ 实时数据源 ------------------------------ */

/**
 * 全局单例数据源：挂件与设置页共用一条连接。
 * SSE 为主，任何异常都降级为 1.5 秒一次的轮询 —— 两条路给出同一份快照。
 */
const store = {
  /** 最近一份完整快照。 */
  snapshot: null,
  /** 最近一次 tick（仅含进行中调用）。 */
  tick: null,
  /** 'connecting' | 'sse' | 'poll' */
  mode: 'connecting',
  /** 连接层错误文本。 */
  error: null,
  /** 最近一次收到数据的时间。 */
  lastAt: 0,
  /** 已连接的 SSE 次数（用于诊断展示）。 */
  reconnects: 0,
  /** 订阅者。 */
  listeners: new Set(),
  source: null,
  watchdog: null,
  pollTimer: null,
  started: false,
}

/** 通知订阅者重绘。 */
function notify() {
  const state = storeView()
  for (const listener of [...store.listeners]) {
    try {
      listener(state)
    } catch (error) {
      /* 单个订阅者出错不影响其它 */
      console.warn('[model-live] 订阅者异常', error)
    }
  }
}

/** 当前对外状态。 */
function storeView() {
  return {
    mode: store.mode,
    error: store.error,
    lastAt: store.lastAt,
    ready: store.snapshot !== null,
    snapshot: store.snapshot,
    active: activeOf(),
  }
}

/** 进行中列表：tick 比快照新时用 tick 的。 */
function activeOf() {
  if (store.tick !== null) return store.tick.active
  if (store.snapshot !== null) return store.snapshot.active
  return []
}

/**
 * 订阅状态变化。
 * @param {(state: object) => void} listener - 监听者。
 * @returns {() => void} 退订函数。
 */
function subscribe(listener) {
  store.listeners.add(listener)
  listener(storeView())
  return () => { store.listeners.delete(listener) }
}

/** 应用一份快照。 */
function applySnapshot(data, mode) {
  if (data === null || typeof data !== 'object') return
  store.snapshot = data
  store.tick = null
  if (mode !== undefined) store.mode = mode
  store.error = null
  store.lastAt = Date.now()
  notify()
}

/** 应用一次 tick（只在已有快照、且版本不旧时）。 */
function applyTick(data) {
  if (store.snapshot === null || data === null || typeof data !== 'object') return
  if (typeof data.revision === 'number' && typeof store.snapshot.revision === 'number' && data.revision < store.snapshot.revision) return
  store.tick = data
  store.lastAt = Date.now()
  notify()
}

/** 关掉 SSE 与看门狗。 */
function closeSource() {
  if (store.watchdog !== null) {
    clearTimeout(store.watchdog)
    store.watchdog = null
  }
  if (store.source !== null) {
    try { store.source.close() } catch (error) { /* 已关闭 */ }
    store.source = null
  }
}

/** 开始轮询兜底（幂等）。 */
function startPolling(reason) {
  closeSource()
  if (store.mode !== 'poll') {
    store.mode = 'poll'
    store.error = reason === undefined ? store.error : reason
    notify()
  }
  if (store.pollTimer !== null) return
  const pull = () => {
    rpc('state', {}).then((data) => {
      applySnapshot(data, 'poll')
    }, (error) => {
      store.error = String(error && error.message ? error.message : error)
      notify()
    })
  }
  pull()
  store.pollTimer = setInterval(pull, POLL_MS)
}

/** 建立 SSE 连接。 */
function openStream() {
  if (typeof EventSource !== 'function') {
    startPolling('浏览器不支持 EventSource')
    return
  }
  closeSource()
  let source
  try {
    source = new EventSource(ROUTE + '/events')
  } catch (error) {
    startPolling('无法建立事件流：' + String(error && error.message ? error.message : error))
    return
  }
  store.source = source
  store.mode = store.snapshot === null ? 'connecting' : 'sse'
  // 看门狗：连上但迟迟没有数据（被反代缓冲/拦截）就转轮询。
  store.watchdog = setTimeout(() => {
    store.watchdog = null
    if (store.lastAt === 0) startPolling('事件流无数据，已切换为轮询')
  }, SSE_WATCHDOG_MS)
  source.addEventListener('snapshot', (event) => {
    if (store.watchdog !== null) {
      clearTimeout(store.watchdog)
      store.watchdog = null
    }
    store.mode = 'sse'
    try {
      applySnapshot(JSON.parse(event.data), 'sse')
    } catch (error) {
      store.error = '事件流数据解析失败'
      notify()
    }
  })
  source.addEventListener('tick', (event) => {
    try {
      applyTick(JSON.parse(event.data))
    } catch (error) {
      /* 单次 tick 解析失败可忽略，下一拍会补上 */
    }
  })
  source.addEventListener('ping', () => {
    store.lastAt = Date.now()
  })
  source.onopen = () => {
    store.reconnects += 1
    store.error = null
    if (store.snapshot !== null) {
      store.mode = 'sse'
      notify()
    }
  }
  source.onerror = () => {
    // EventSource 会自行重连；若从未拿到数据，看门狗会兜底转轮询。
    if (store.lastAt === 0) return
    store.error = '事件流中断，正在重连…'
    notify()
  }
}

/** 首次启动数据源（页面生命周期内只跑一次）。 */
function ensureStarted() {
  if (store.started) return
  store.started = true
  openStream()
}

/**
 * 调一次 Host 路由。
 * @param {string} method - 路由方法名。
 * @param {object} [args] - JSON 参数。
 * @returns {Promise<object>} Host 回包的 data 字段。
 */
function rpc(method, args) {
  return fetch(ROUTE + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args === undefined ? {} : args),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}))
    if (res.ok && data && data.ok === true) return data.data
    const detail = data && data.error && data.error.message ? data.error.message : 'HTTP ' + res.status
    throw new Error(detail)
  })
}

/**
 * 订阅实时状态的 Hook。
 * @returns {object} storeView() 的结果。
 */
function useLive() {
  const [state, setState] = React.useState(storeView())
  React.useEffect(() => {
    ensureStarted()
    return subscribe(setState)
  }, [])
  return state
}

/**
 * 有进行中的调用时按固定节奏重绘，让耗时/速率连续变化。
 * @param {boolean} enabled - 是否需要连续重绘。
 */
function useTicker(enabled) {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    if (!enabled) return undefined
    const timer = setInterval(() => force((n) => n + 1), RENDER_MS)
    return () => clearInterval(timer)
  }, [enabled])
}

/** 当前时刻（用于进行中调用的耗时插值）。 */
function nowMs() {
  return Date.now()
}

/* ---------------------------- 挂件默认位置 ---------------------------- */

/** 贴住聊天区左缘的横向留白（像素）。 */
const WIDGET_LEFT_GAP = 16
/** 默认纵向位置：占窗口高度的比例（与设计稿一致，随窗口等比缩放）。 */
const WIDGET_TOP_RATIO = 0.09
/** 纵向兜底最小值：窗口很矮时不至于贴到顶栏上。 */
const WIDGET_MIN_TOP = 72

/**
 * 计算挂件的默认位置：贴在聊天区左上角。
 *
 * 浮层（.overlayLayer）覆盖整个应用框架，所以这里是窗口坐标系；侧边栏宽度用户可拖，
 * 因此**实测**框架第一列（侧栏列）的宽度而不是写死 280px —— 量不到才退回 280。
 * 纵向取窗口高度的比例，保证任何窗口尺寸下都落在同一个视觉位置。
 *
 * @param {HTMLElement} node - 挂件根节点（用来找到所在浮层与框架）。
 * @returns {{left: number, top: number}} 窗口系坐标（像素）。
 */
function defaultWidgetPos(node) {
  let sidebar = 280
  try {
    const layer = node.offsetParent || node.parentElement
    const frame = layer === null || layer === undefined ? null : layer.parentElement
    const column = frame === null ? null : frame.firstElementChild
    if (column !== null && typeof column.getBoundingClientRect === 'function') {
      const width = column.getBoundingClientRect().width
      if (width > 0 && width < 600) sidebar = width
    }
  } catch (error) {
    /* 量不到就用 280 */
  }
  const height = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 800
  return {
    left: Math.round(sidebar + WIDGET_LEFT_GAP),
    top: Math.max(WIDGET_MIN_TOP, Math.round(height * WIDGET_TOP_RATIO)),
  }
}

/* ------------------------------ 悬浮挂件 ------------------------------ */

/** 进行中/空闲两种形态共用的统计摘要行。 */
function summaryRows(totals, live, runtime) {
  const rows = []
  rows.push(row('calls', '累计调用', String(totals.calls) + (totals.failed > 0 ? '（失败 ' + String(totals.failed) + '）' : '')))
  rows.push(row('tokens', '累计 token', fmtTok(totals.totalTokens) + '（出 ' + fmtTok(totals.outputTokens) + '）'))
  rows.push(row('tps', '平均输出速度', fmtTok(totals.avgTps) === '—' ? '—' : String(totals.avgTps) + ' tok/s'))
  rows.push(row('ttft', '平均首包延迟', fmtDur(totals.avgTtftMs)))
  rows.push(row('cache', '缓存命中占比', totals.cacheHitPercent === null ? '—' : String(totals.cacheHitPercent) + '%'))
  // 这里以前写的是「本地模型多在此」——实测不成立：外部进程调用绝大多数仍是**云端**模型
  // （别的 DSH 进程/子会话），本地模型只占其中一小部分。改成按"进程"和"跑在哪"两件事分开说。
  if (totals.external > 0) rows.push(row('external', '外部进程调用', String(totals.external) + ' 次（别的 DSH 进程）'))
  if (totals.local > 0) {
    rows.push(row('local', '本地模型调用',
      String(totals.local) + ' 次' + (totals.localPercent === null || totals.localPercent === undefined ? '' : '（占 ' + String(totals.localPercent) + '%）')))
  }
  if (live > 0) rows.push(row('live', '进行中', String(live) + ' 个'))
  if (runtime !== null && runtime !== undefined) {
    const perf = runtime.perf
    const bits = []
    if (perf !== null && perf !== undefined) {
      if (perf.promptTps !== null && perf.promptTps !== undefined) bits.push('提示 ' + String(perf.promptTps))
      if (perf.generateTps !== null && perf.generateTps !== undefined) bits.push('生成 ' + String(perf.generateTps))
    }
    rows.push(row('runtime', '模型运行时',
      (runtime.running === true ? '采集中' : '独立服务未运行') +
      (bits.length === 0 ? '' : ' · 模型自报 ' + bits.join(' / ') + ' tok/s')))
  }
  return rows
}

/** 一行「标签 — 值」。 */
function row(key, label, value) {
  return React.createElement('div', { className: 'dsh-mlv-row', key },
    React.createElement('span', null, label),
    React.createElement('span', null, value))
}

/** 单条进行中调用的卡片。 */
function LiveRow(props) {
  const item = props.item
  const now = props.now
  const duration = Math.max(0, now - item.startedAt)
  const rate = item.tps === null ? null : item.tps
  const output = item.outputTokens === null ? '≈' + String(Math.round(item.textChars / 2.5)) + ' tok' : fmtTok(item.outputTokens) + ' tok'
  const meta = []
  meta.push('耗时 ' + fmtDur(duration))
  meta.push('首字 ' + fmtDur(item.firstTextMs === null ? item.ttftMs : item.firstTextMs))
  if (item.reasoningChars > 0) meta.push('思考 ' + fmtTok(Math.round(item.reasoningChars / 2.5)) + ' tok')
  if (item.toolNames.length > 0) meta.push('工具 ' + item.toolNames.join('/'))
  const width = item.contextPercent === null ? null : Math.min(100, Math.max(1, item.contextPercent))
  const children = [
    React.createElement('div', { className: 'dsh-mlv-liveTop', key: 'top' },
      React.createElement('span', { className: 'dsh-mlv-liveModel', title: fmtModel(item) + ' · ' + sourceLabel(item) }, fmtModelShort(item, 26)),
      ModelTag(item),
      React.createElement('span', { className: 'dsh-mlv-liveRate' }, rate === null ? '…' : fmtTps(rate, item.tpsEstimated))),
    React.createElement('div', { className: 'dsh-mlv-liveMeta', key: 'meta' },
      React.createElement('span', null, output),
      meta.map((text, index) => React.createElement('span', { key: 'm' + String(index) }, text))),
  ]
  if (width !== null) {
    children.push(React.createElement('div', { className: 'dsh-mlv-bar', key: 'bar' },
      React.createElement('div', { className: 'dsh-mlv-barFill', style: { width: String(width) + '%' } })))
  }
  return React.createElement('div', { className: 'dsh-mlv-live' }, children)
}

/** 右下角悬浮挂件：进行中调用一眼可见，单击展开明细。 */
function ModelLiveWidget() {
  const state = useLive()
  const [pos, setPos] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const nodeRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const active = state.active
  useTicker(active.length > 0 || open)

  // 首帧：量出默认位置（聊天区左上角）；之后展开/折叠改变尺寸时，把贴边的挂件夹回可视区。
  React.useLayoutEffect(() => {
    const node = nodeRef.current
    if (node === null) return
    if (pos === null) {
      setPos(defaultWidgetPos(node))
      return
    }
    const layer = node.offsetParent || node.parentElement
    if (layer === null || typeof layer.getBoundingClientRect !== 'function') return
    const bounds = layer.getBoundingClientRect()
    const self = node.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const left = Math.min(pos.left, Math.max(0, bounds.width - self.width))
    const top = Math.min(pos.top, Math.max(0, bounds.height - self.height))
    if (left !== pos.left || top !== pos.top) setPos({ left, top })
  }, [open, pos])

  const onPointerDown = (event) => {
    if (typeof event.button === 'number' && event.button !== 0) return
    const node = nodeRef.current
    if (node === null) return
    const self = node.getBoundingClientRect()
    const layer = node.offsetParent || node.parentElement
    const bounds = layer !== null && typeof layer.getBoundingClientRect === 'function' ? layer.getBoundingClientRect() : null
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: bounds === null ? self.left : self.left - bounds.left,
      top: bounds === null ? self.top : self.top - bounds.top,
      width: self.width,
      height: self.height,
      bounds,
      moved: false,
    }
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* 捕获失败不影响拖动 */ }
    }
    setDragging(true)
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
    drag.moved = true
    const bounds = drag.bounds
    const maxLeft = bounds !== null && bounds.width > 0 ? Math.max(0, bounds.width - drag.width) : null
    const maxTop = bounds !== null && bounds.height > 0 ? Math.max(0, bounds.height - drag.height) : null
    const rawLeft = drag.left + dx
    const rawTop = drag.top + dy
    setPos({
      left: maxLeft === null ? rawLeft : Math.min(Math.max(0, rawLeft), maxLeft),
      top: maxTop === null ? rawTop : Math.min(Math.max(0, rawTop), maxTop),
    })
  }

  const endDrag = (event, toggle) => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    setDragging(false)
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* 已释放 */ }
    }
    if (toggle && !drag.moved) setOpen((current) => !current)
  }

  const snapshot = state.snapshot
  const totals = snapshot === null ? null : snapshot.totals
  const models = snapshot === null ? [] : (snapshot.models === undefined || snapshot.models === null ? [] : snapshot.models)
  const lastError = snapshot !== null && snapshot.recent.length > 0 && snapshot.recent[0].status === 'error'
  const tone = active.length > 0 ? 'live' : (state.mode === 'connecting' || state.error !== null ? 'warn' : (lastError ? 'error' : 'ok'))

  let title = '模型调用监视：正在连接 Host…'
  let headline = '模型调用'
  let sub = state.error === null ? '连接中…' : state.error
  if (totals !== null) {
    if (active.length > 0) {
      const first = active[0]
      const rate = active.reduce((sum, item) => sum + (item.tps === null ? 0 : item.tps), 0)
      headline = active.length === 1 ? fmtModelShort(first, 22) : String(active.length) + ' 个模型调用进行中'
      sub = fmtDur(nowMs() - first.startedAt) + ' · ' +
        (rate > 0 ? fmtTps(rate, active.some((item) => item.tpsEstimated)) : fmtTok(Math.round((first.textChars + first.reasoningChars) / 2.5)) + ' tok')
    } else {
      headline = '共 ' + String(totals.calls) + ' 次调用'
      // 副标题写"最近一次调用的**具体模型**"：优先显示名，没有才退回 provider/model id。
      const lastName = totals.lastModelName !== null && totals.lastModelName !== undefined && totals.lastModelName !== ''
        ? totals.lastModelName
        : (totals.lastModel === null ? '' : totals.lastModel)
      sub = (totals.lastAt === null ? '暂无记录' : '最近 ' + fmtClock(totals.lastAt) + (lastName === '' ? '' : ' · ' + lastName)) +
        (totals.totalTokens === 0 ? '' : ' · ' + fmtTok(totals.totalTokens) + ' tok') +
        (totals.local > 0 ? ' · 本地 ' + String(totals.local) + ' 次' : '')
    }
    title = [
      '模型调用实时监视（数据源 llm/stream，只读）',
      '进行中：' + String(active.length) + ' 个',
      '累计：' + String(totals.calls) + ' 次，失败 ' + String(totals.failed) + '，中断 ' + String(totals.aborted),
      'token：输入 ' + fmtTok(totals.inputTokens) + ' / 输出 ' + fmtTok(totals.outputTokens) + ' / 缓存读 ' + fmtTok(totals.cacheReadTokens),
      '平均：耗时 ' + fmtDur(totals.avgMs) + '，首包 ' + fmtDur(totals.avgTtftMs) + '，速度 ' + (totals.avgTps === null ? '—' : String(totals.avgTps) + ' tok/s'),
      '拖动可移动，单击展开明细',
    ].join('\n')
  }

  const children = [
    React.createElement('div', { className: 'dsh-mlv-head', key: 'head' },
      React.createElement('span', { className: 'dsh-mlv-icon' }, '\uD83E\uDDE0'),
      React.createElement('span', { className: 'dsh-mlv-title' }, headline),
      React.createElement('span', { className: 'dsh-mlv-dot dsh-mlv-dot--' + tone })),
    React.createElement('div', { className: 'dsh-mlv-sub' }, sub),
  ]

  if (open && totals !== null) {
    const body = []
    if (active.length > 0) {
      body.push(React.createElement('div', { className: 'dsh-mlv-rows', key: 'live' },
        React.createElement('div', { className: 'dsh-mlv-hint' }, '进行中'),
        active.slice(0, 4).map((item) => React.createElement(LiveRow, { key: item.id, item, now: nowMs() }))))
    }
    if (snapshot.recent.length > 0) {
      // 每一行都写清"**具体是哪个模型**"：显示名 + 本地/云端徽标 + 这次的速度与耗时。
      // 早先这里只截 18 个字符的模型名、且和"来源"挤在一行，云端和本地调用混在一起时看不出区别。
      body.push(React.createElement('div', { className: 'dsh-mlv-rows', key: 'recent' },
        React.createElement('div', { className: 'dsh-mlv-hint' }, '最近调用'),
        snapshot.recent.slice(0, 5).map((item) => {
          const info = statusInfo(item.status)
          const rate = item.tps === null ? null : fmtTps(item.tps, item.tpsEstimated)
          return React.createElement('div', { className: 'dsh-mlv-recent', key: item.id, title: fmtModel(item) + ' · ' + sourceLabel(item) },
            React.createElement('span', { className: 't' }, fmtClock(item.startedAt, true)),
            React.createElement('span', { className: 'm' }, fmtModelShort(item, 22)),
            ModelTag(item),
            React.createElement('span', { className: 'v' },
              fmtDur(item.durationMs) + ' · ' +
              fmtTok(item.outputTokens === null ? Math.round(item.textChars / 2.5) : item.outputTokens) + ' tok · ' +
              (rate === null ? info.label : rate)))
        })))
    }
    if (models.length > 0) {
      // 「按模型」：把具体模型的实时状况摊开（进行中 / 累计 / 最近速度 / 最近调用时刻），
      // 只列最近有活动的几个，避免挂件变成一张大表。
      const rows = models
        .filter((item) => item.calls > 0 || item.active > 0)
        .sort((a, b) => ((b.active > 0 ? 1 : 0) - (a.active > 0 ? 1 : 0)) || ((b.lastAt === null ? 0 : b.lastAt) - (a.lastAt === null ? 0 : a.lastAt)))
        .slice(0, 4)
      if (rows.length > 0) {
        body.push(React.createElement('div', { className: 'dsh-mlv-rows', key: 'models' },
          React.createElement('div', { className: 'dsh-mlv-hint' }, '按模型'),
          rows.map((item) => {
            const live = item.active > 0
            const bits = []
            bits.push(item.active > 0 ? '进行中 ' + String(item.active) : String(item.calls) + ' 次')
            if (item.avgTps !== null && item.avgTps !== undefined) bits.push(String(item.avgTps) + ' tok/s')
            if (item.lastAt !== null && item.lastAt !== undefined) bits.push(fmtClock(item.lastAt, true))
            return React.createElement('div', {
              className: 'dsh-mlv-model' + (live ? ' dsh-mlv-model--active' : ''),
              key: item.provider + '/' + item.model,
              title: fmtModel(item) + ' · provider ' + String(item.provider) +
                ' · 累计 ' + String(item.calls) + ' 次（其中外部进程 ' + String(item.external) + '）',
            },
            React.createElement('span', { className: 'm' }, fmtModelShort(item, 22)),
            ModelTag(item),
            React.createElement('span', { className: 'v' }, bits.join(' · ')))
          })))
      }
    }
    body.push(React.createElement('div', { className: 'dsh-mlv-rows', key: 'totals' }, summaryRows(totals, active.length, snapshot.runtime)))
    body.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'hint' },
      state.mode === 'sse' ? '实时推送中（SSE）' : state.mode === 'poll' ? '轮询兜底中（1.5s）' : '连接中…',
      state.error === null ? '' : ' · ' + state.error))
    children.push(React.createElement('div', { key: 'body' }, body))
  } else if (open) {
    children.push(React.createElement('div', { className: 'dsh-mlv-rows', key: 'empty' },
      React.createElement('div', { className: 'dsh-mlv-hint dsh-mlv-err' }, state.error === null ? '正在读取 Host 数据…' : String(state.error))))
  }

  // 位置未测量出来之前先隐藏：默认位置是左锚定，layout effect 在首次绘制前就会落位。
  const style = pos === null
    ? { left: '0px', top: '0px', visibility: 'hidden' }
    : { left: Math.round(pos.left) + 'px', top: Math.round(pos.top) + 'px' }

  return React.createElement('div', {
    ref: nodeRef,
    className: 'dsh-mlv-widget' + (dragging ? ' dsh-mlv-widget--dragging' : '') + (open ? ' dsh-mlv-widget--wide' : ''),
    style,
    title,
    onPointerDown,
    onPointerMove,
    onPointerUp: (event) => endDrag(event, true),
    onPointerCancel: (event) => endDrag(event, false),
  }, children)
}

/* --------------------------- 设置页「模型调用监控」 --------------------------- */

/** 统计卡片。 */
function stat(key, label, value, sub) {
  return React.createElement('div', { className: 'dsh-mlv-stat', key },
    React.createElement('div', { className: 'dsh-mlv-statLabel' }, label),
    React.createElement('div', { className: 'dsh-mlv-statValue' }, value),
    sub === undefined || sub === null ? null : React.createElement('div', { className: 'dsh-mlv-statSub' }, sub))
}

/** 进行中调用的明细表。 */
function ActiveTable(props) {
  const active = props.active
  const now = props.now
  if (active.length === 0) {
    return React.createElement('div', { className: 'dsh-mlv-hint' }, '当前没有进行中的模型调用。发起一条对话即可看到实时数据。')
  }
  const head = React.createElement('tr', null,
    React.createElement('th', null, '模型'),
    React.createElement('th', null, '来源'),
    React.createElement('th', null, '会话'),
    React.createElement('th', { className: 'num' }, '耗时'),
    React.createElement('th', { className: 'num' }, '首字'),
    React.createElement('th', { className: 'num' }, '输出'),
    React.createElement('th', { className: 'num' }, '速度'),
    React.createElement('th', null, '上下文占用'))
  const rows = active.map((item) => React.createElement('tr', { key: item.id },
    React.createElement('td', null, fmtModel(item)),
    React.createElement('td', { className: item.source === 'log' ? 'dsh-mlv-dim' : '' }, sourceLabel(item)),
    React.createElement('td', { className: 'dsh-mlv-dim' }, item.sessionId === null ? '—' : item.sessionId.slice(0, 8)),
    React.createElement('td', { className: 'num' }, fmtDur(Math.max(0, now - item.startedAt))),
    React.createElement('td', { className: 'num' }, fmtDur(item.firstTextMs === null ? item.ttftMs : item.firstTextMs)),
    React.createElement('td', { className: 'num' }, item.outputTokens === null
      ? '≈' + fmtTok(Math.round(item.textChars / 2.5))
      : fmtTok(item.outputTokens)),
    React.createElement('td', { className: 'num' }, fmtTps(item.tps, item.tpsEstimated)),
    React.createElement('td', { className: 'dsh-mlv-dim' }, fmtContext(item))))
  return React.createElement('table', { className: 'dsh-mlv-table' },
    React.createElement('thead', null, head),
    React.createElement('tbody', null, rows))
}

/** 最近调用的明细表。 */
function RecentTable(props) {
  const recent = props.recent
  if (recent.length === 0) return React.createElement('div', { className: 'dsh-mlv-hint' }, '尚无已结束的调用记录。')
  const head = React.createElement('tr', null,
    React.createElement('th', null, '时间'),
    React.createElement('th', null, '模型'),
    React.createElement('th', null, '来源'),
    React.createElement('th', { className: 'num' }, '耗时'),
    React.createElement('th', { className: 'num' }, '首包'),
    React.createElement('th', { className: 'num' }, '速度'),
    React.createElement('th', { className: 'num' }, '输入'),
    React.createElement('th', { className: 'num' }, '输出'),
    React.createElement('th', { className: 'num' }, '缓存读'),
    React.createElement('th', null, '状态'))
  const rows = recent.map((item) => {
    const info = statusInfo(item.status)
    return React.createElement('tr', { key: item.id },
      React.createElement('td', { className: 'dsh-mlv-dim' }, fmtClock(item.startedAt, true)),
      React.createElement('td', { title: item.errorMessage === null ? '' : String(item.errorMessage) }, fmtModel(item)),
      React.createElement('td', { className: item.source === 'log' ? 'dsh-mlv-dim' : '' }, sourceLabel(item)),
      React.createElement('td', { className: 'num' }, fmtDur(item.durationMs)),
      React.createElement('td', { className: 'num' }, fmtDur(item.ttftMs)),
      React.createElement('td', { className: 'num' }, fmtTps(item.tps, item.tpsEstimated)),
      React.createElement('td', { className: 'num' }, fmtTok(item.inputTokens)),
      React.createElement('td', { className: 'num' }, fmtTok(item.outputTokens)),
      React.createElement('td', { className: 'num' }, fmtTok(item.cacheReadTokens)),
      React.createElement('td', { className: 'dsh-mlv-' + info.tone },
        info.label + (item.finishKind === null ? '' : '·' + finishLabel(item.finishKind))))
  })
  return React.createElement('div', { className: 'dsh-mlv-scroll' },
    React.createElement('table', { className: 'dsh-mlv-table' },
      React.createElement('thead', null, head),
      React.createElement('tbody', null, rows)))
}

/** 模型清单：元数据 + 实测统计（模型相关数据的主视图）。 */
function ModelTable(props) {
  const models = props.models
  if (models.length === 0) return React.createElement('div', { className: 'dsh-mlv-hint' }, '还没有观测到任何模型调用。')
  const head = React.createElement('tr', null,
    React.createElement('th', null, '提供方'),
    React.createElement('th', null, '模型'),
    React.createElement('th', { className: 'num' }, '上下文窗口'),
    React.createElement('th', { className: 'num' }, '最大输出'),
    React.createElement('th', null, '输入模态'),
    React.createElement('th', null, '推理档位'),
    React.createElement('th', { className: 'num' }, '调用'),
    React.createElement('th', { className: 'num' }, '其中外部'),
    React.createElement('th', { className: 'num' }, '平均耗时'),
    React.createElement('th', { className: 'num' }, '平均速度'),
    React.createElement('th', { className: 'num' }, '缓存命中'))
  const rows = models.map((item) => React.createElement('tr', { key: item.provider + '/' + item.model },
    React.createElement('td', { className: 'dsh-mlv-dim' }, item.provider),
    React.createElement('td', { title: item.model }, item.name === null || item.name === item.model ? item.model : item.name),
    React.createElement('td', { className: 'num' }, item.contextWindow === null ? '—' : fmtTok(item.contextWindow)),
    React.createElement('td', { className: 'num' }, item.maxTokens === null ? '—' : fmtTok(item.maxTokens)),
    React.createElement('td', { className: 'dsh-mlv-dim' }, item.modalities === null ? '—' : item.modalities.join('+')),
    React.createElement('td', { className: 'dsh-mlv-dim' },
      item.efforts === null || item.efforts.length === 0
        ? '—'
        : item.efforts.join('/') + (item.defaultEffort === null ? '' : '（默认 ' + item.defaultEffort + '）')),
    React.createElement('td', { className: 'num' }, String(item.calls) + (item.active > 0 ? '(+' + String(item.active) + ')' : '')),
    React.createElement('td', { className: 'num dsh-mlv-dim' }, item.external === 0 ? '—' : String(item.external)),
    React.createElement('td', { className: 'num' }, fmtDur(item.avgMs)),
    React.createElement('td', { className: 'num' }, item.avgTps === null ? '—' : String(item.avgTps) + ' tok/s'),
    React.createElement('td', { className: 'num' }, item.cacheHitPercent === null ? '—' : String(item.cacheHitPercent) + '%')))
  return React.createElement('div', { className: 'dsh-mlv-scroll' },
    React.createElement('table', { className: 'dsh-mlv-table' },
      React.createElement('thead', null, head),
      React.createElement('tbody', null, rows)))
}

/**
 * 模型运行时日志（第三观测源）：远端模型所在机器上的 llama.cpp / Ollama 服务端日志。
 *
 * 与「调用」两条源互补：这里看的是**模型自己怎么说的** —— 加载、上下文尺寸、
 * 槽位、每次推理的提示/生成耗时与 tok/s（模型自报）、以及报错。
 *
 * @param {{runtime: object|null}} props - 快照里的 runtime 段。
 * @returns {object} React 元素。
 */
function RuntimeLogCard(props) {
  const runtime = props.runtime
  const [source, setSource] = React.useState('all')
  /** 某个具体来源的明细（按需拉，见下面 effect）：{ source, lines, at }。 */
  const [detail, setDetail] = React.useState(null)

  // 切到某个来源时才去取它的明细，并且每 5 秒刷新一次；
  // 这样快照推送里就不必携带整段日志（之前一次推送 ~113KB，其中 86KB 是日志行）。
  React.useEffect(() => {
    if (source === 'all' || runtime === null || runtime === undefined) return undefined
    let alive = true
    const pull = () => {
      rpc('runtime', {}).then((data) => {
        if (!alive || data === null || data === undefined) return
        const hit = (data.sources || []).find((item) => item.id === source)
        setDetail({ source, lines: hit === undefined ? [] : hit.lines, at: Date.now() })
      }, () => { /* 服务不可达时保留上一次 */ })
    }
    pull()
    const timer = setInterval(pull, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [source])
  const children = [
    React.createElement('div', { className: 'dsh-mlv-sectionTitle', key: 't' }, '模型运行时日志（模型运行的那台机器）'),
  ]

  if (runtime === null || runtime === undefined) {
    children.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'off' },
      '未启用运行时日志采集（环境变量 DSH_MODEL_LIVE_RUNTIME=0 可关闭；需要 NAS 到模型主机配好 SSH 免密）。'))
    return React.createElement('div', { className: 'dsh-mlv-card' }, children)
  }

  children.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'status' },
    (runtime.running ? '运行中' : '已停止') + ' · 主机 ' + String(runtime.label) +
    ' · 轮次 ' + String(runtime.polls) + ' · 失败 ' + String(runtime.failures) +
    ' · 已读 ' + fmtTok(runtime.bytes) + 'B' +
    (runtime.lastAt === null ? '' : ' · 最近 ' + fmtClock(runtime.lastAt, true)) +
    ' · ' + (runtime.lastError === null ? '采集正常' : '采集异常：' + String(runtime.lastError))))

  if (runtime.perf !== null && runtime.perf !== undefined) {
    const bits = []
    if (runtime.perf.promptTps !== null) bits.push('提示 ' + String(runtime.perf.promptTps) + ' tok/s')
    if (runtime.perf.generateTps !== null) bits.push('生成 ' + String(runtime.perf.generateTps) + ' tok/s')
    children.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'perf' },
      '模型自报性能（来自 ' + String(runtime.perf.source) + ' 的日志）：' + (bits.length === 0 ? '—' : bits.join(' · '))))
  }

  const tabs = [{ id: 'all', label: '全部', count: runtime.lines.length }].concat(
    runtime.sources.map((item) => ({
      id: item.id,
      label: item.label + (item.error === null ? '' : '（读取失败）'),
      count: item.count,
    })))
  children.push(React.createElement('div', { className: 'dsh-mlv-actions', key: 'tabs' },
    tabs.map((tab) => React.createElement('button', {
      key: tab.id,
      type: 'button',
      className: 'dsh-mlv-btn' + (source === tab.id ? ' dsh-mlv-btn--on' : ''),
      onClick: () => setSource(tab.id),
    }, tab.label + (tab.id === 'all' ? '' : ' · ' + String(tab.count))))))

  const chosen = source === 'all'
    ? runtime.lines
    : (detail !== null && detail.source === source ? detail.lines : [])

  if (chosen.length === 0) {
    children.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'empty' },
      source === 'all'
        ? '还没有采到运行时日志。'
        : (detail === null
          ? '正在读取该来源的日志…'
          : '这个来源暂时没有日志（文件可能为空，例如 llama.cpp 的 stdout）。')))
  } else {
    children.push(React.createElement('div', { className: 'dsh-mlv-log', key: 'lines' },
      chosen.slice().reverse().map((line, index) => React.createElement('div', {
        className: 'dsh-mlv-logLine dsh-mlv-logLine--' + line.level,
        key: String(line.at) + '-' + String(index),
      },
      React.createElement('span', { className: 'dsh-mlv-logTime' }, fmtClock(line.at, true)),
      React.createElement('span', { className: 'dsh-mlv-logSrc' }, line.label),
      React.createElement('span', { className: 'dsh-mlv-logText' }, line.text)))))
  }

  if (runtime.standalone === true) {
    const host = typeof window !== 'undefined' && typeof window.location === 'object' ? window.location.hostname : ''
    const link = host === '' ? runtime.url : 'http://' + host + ':18610/'
    children.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'standalone' },
      '采集由**独立服务**承担（不依赖 DSH、不依赖 Hermes，DSH 启停不影响它）：',
      React.createElement('a', { href: link, target: '_blank', rel: 'noreferrer', key: 'link', style: { color: 'inherit', textDecoration: 'underline' } }, link),
      '（点开是它自带的完整面板，含来源标签、级别过滤与暂停）'))
  }
  children.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'note' },
    '只读采集：服务定期经 SSH 读取远端日志文件的新增字节（首次只看尾部 64KB），不写、不删、不改远端任何东西。' +
    '「全部」用快照里的实时尾部；切到具体来源时才按需拉取该来源的明细（每 5 秒刷新）。'))

  return React.createElement('div', { className: 'dsh-mlv-card' }, children)
}

/** 模型目录：按提供方列出端点实际广告的模型（来自 llm.listModels）。 */
function CatalogBlock() {
  const [state, setState] = React.useState({ phase: 'idle' })
  const load = () => {
    setState({ phase: 'loading' })
    rpc('catalog', {}).then((data) => {
      setState({ phase: 'ok', data })
    }, (error) => {
      setState({ phase: 'error', message: String(error && error.message ? error.message : error) })
    })
  }
  const children = [
    React.createElement('div', { className: 'dsh-mlv-sectionTitle', key: 't' }, '模型目录（提供方端点实际广告的模型）'),
    React.createElement('div', { className: 'dsh-mlv-hint', key: 'h' },
      '数据来自 llm.listModels(provider)，按提供方缓存 60 秒；可能打到 provider 端点，所以按需加载。'),
  ]
  const actions = React.createElement('div', { className: 'dsh-mlv-actions', key: 'a' },
    React.createElement('button', {
      className: 'dsh-mlv-btn',
      type: 'button',
      onClick: load,
      disabled: state.phase === 'loading',
    }, state.phase === 'loading' ? '加载中…' : '加载模型目录'))
  children.push(actions)
  if (state.phase === 'error') {
    children.push(React.createElement('div', { className: 'dsh-mlv-err', key: 'e' }, String(state.message)))
  }
  if (state.phase === 'ok' && state.data !== null) {
    const entries = state.data.entries
    if (entries.length === 0) children.push(React.createElement('div', { className: 'dsh-mlv-hint', key: 'none' }, '没有已注册的提供方。'))
    entries.forEach((entry) => {
      const head = React.createElement('div', { className: 'dsh-mlv-sectionTitle', key: entry.provider + '-h' },
        entry.provider,
        React.createElement('span', { className: 'dsh-mlv-dim' },
          entry.error === null
            ? ' · ' + String(entry.models.length) + ' 个模型' + (entry.cached ? '（缓存）' : '')
            : ' · 读取失败：' + String(entry.error)))
      children.push(head)
      if (entry.error === null && entry.models.length > 0) {
        children.push(React.createElement('div', { className: 'dsh-mlv-tags', key: entry.provider + '-l' },
          entry.models.map((model) => React.createElement('span', { className: 'dsh-mlv-tag', key: model.id, title: model.description === null ? model.id : model.description },
            (model.name === null || model.name === model.id ? model.id : model.name) +
            (model.modalities === null ? '' : ' · ' + model.modalities.join('+'))))))
      }
    })
  }
  return React.createElement('div', { className: 'dsh-mlv-card' }, children)
}

/** 设置页「模型调用监控」。 */
function ModelLiveSettings() {
  const state = useLive()
  const [catalogVersion, setCatalogVersion] = React.useState(0)
  const snapshot = state.snapshot
  const active = state.active
  useTicker(active.length > 0)
  const totals = snapshot === null ? null : snapshot.totals

  const clear = () => {
    rpc('clear', {}).then(() => {
      store.tick = null
      setCatalogVersion((n) => n + 1)
    }, (error) => {
      console.warn('[model-live] 清空失败', error)
    })
  }

  const modeBadge = state.mode === 'sse'
    ? React.createElement('span', { className: 'dsh-mlv-badge dsh-mlv-badge--live' }, '实时推送 · SSE')
    : state.mode === 'poll'
      ? React.createElement('span', { className: 'dsh-mlv-badge dsh-mlv-badge--warn' }, '轮询兜底 · 1.5s')
      : React.createElement('span', { className: 'dsh-mlv-badge' }, '连接中…')

  const header = React.createElement('div', { className: 'dsh-mlv-pageHead' },
    React.createElement('span', null, '\uD83E\uDDE0'),
    React.createElement('span', null, '模型调用监控'),
    modeBadge)

  if (snapshot === null) {
    return React.createElement('div', { className: 'dsh-mlv-page' },
      header,
      React.createElement('div', { className: 'dsh-mlv-card' },
        React.createElement('div', { className: 'dsh-mlv-hint' }, '正在读取 Host 数据…'),
        state.error === null ? null : React.createElement('div', { className: 'dsh-mlv-err' }, String(state.error))))
  }

  const successRate = totals.calls === 0 ? null : Math.round(((totals.calls - totals.failed - totals.aborted) / totals.calls) * 1000) / 10

  const stats = React.createElement('div', { className: 'dsh-mlv-grid' },
    stat('active', '进行中', String(active.length), active.length > 0 ? fmtModelShort(active[0], 20) : '空闲'),
    stat('calls', '累计调用', String(totals.calls), totals.failed + totals.aborted > 0 ? '失败 ' + String(totals.failed) + ' · 中断 ' + String(totals.aborted) : '全部正常'),
    stat('source', '外部进程调用', String(totals.external === undefined ? 0 : totals.external),
      '本进程 ' + String(totals.live === undefined ? totals.calls : totals.live) + '（本地模型多跑在外部进程）'),
    stat('rate', '成功率', successRate === null ? '—' : String(successRate) + '%', null),
    stat('ttft', '平均首包延迟', fmtDur(totals.avgTtftMs), '含排队与网络'),
    stat('tps', '平均输出速度', totals.avgTps === null ? '—' : String(totals.avgTps) + ' tok/s', '输出 token / 耗时'),
    stat('tokens', '累计 token', fmtTok(totals.totalTokens), '输入 ' + fmtTok(totals.inputTokens) + ' · 输出 ' + fmtTok(totals.outputTokens)),
    stat('cache', '缓存命中占比', totals.cacheHitPercent === null ? '—' : String(totals.cacheHitPercent) + '%', '缓存读 ' + fmtTok(totals.cacheReadTokens)),
    stat('reasoning', '思考 token', fmtTok(totals.reasoningTokens), '含在输出 token 内'))

  const liveCard = React.createElement('div', { className: 'dsh-mlv-card' },
    React.createElement('div', { className: 'dsh-mlv-sectionTitle' }, '进行中的模型调用'),
    React.createElement(ActiveTable, { active, now: nowMs() }))

  const recentCard = React.createElement('div', { className: 'dsh-mlv-card' },
    React.createElement('div', { className: 'dsh-mlv-sectionTitle' }, '最近调用（内存中保留最近 ' + String(snapshot.bufferLimit) + ' 次，这里显示 ' + String(snapshot.recent.length) + ' 条）'),
    React.createElement(RecentTable, { recent: snapshot.recent }))

  const modelCard = React.createElement('div', { className: 'dsh-mlv-card' },
    React.createElement('div', { className: 'dsh-mlv-sectionTitle' }, '模型数据（来自 llm.resolveModelInfo + 实测统计）'),
    React.createElement(ModelTable, { models: snapshot.models }))

  const actionsCard = React.createElement('div', { className: 'dsh-mlv-card' },
    React.createElement('div', { className: 'dsh-mlv-actions' },
      React.createElement('button', { className: 'dsh-mlv-btn', type: 'button', onClick: clear }, '清空本插件的内存记录')),
    React.createElement('p', { className: 'dsh-mlv-note' },
      '两个观测源，合起来才是全部调用：① **本进程**——包装内核的 llm/stream 瀑布，chunk 原样透传；' +
      '② **外部进程**——增量回读 $DSH_HOME/sessions 下的会话日志（只读、不写），' +
      '用来覆盖 `dsh --profile headless` 之类**另外的 DSH 进程**（本部署的本地模型/执行者就跑在那里，' +
      '光靠瀑布是看不见的）。同一进程内的调用会按「会话 + 模型 + 时间」自动去重，不会算两次。',
      React.createElement('br'),
      '只读观测：不注入任何请求字段、不改会话与日志，也不写入磁盘。',
      React.createElement('br'),
      '统计只存在于 Host 内存中，DSH 重启即清零；模型元数据（上下文窗口/最大输出/输入模态/推理档位）来自内核的 llm.resolveModelInfo，与模型选择器同源。',
      React.createElement('br'),
      '速率带 ~ 前缀表示该值由流式字符数估算（provider 尚未回报 usage），收到 usage 后会变成精确值。'),
    React.createElement('div', { className: 'dsh-mlv-hint' },
      '提供方：' + (snapshot.providers.length === 0
        ? '—'
        : snapshot.providers.map((row) => (row.name === null ? row.id : row.name) + '(' + row.id + ')').join('、'))),
    React.createElement('div', { className: 'dsh-mlv-hint' },
      'Host 运行时长 ' + fmtDur(snapshot.uptimeMs) + ' · 最近一次数据 ' + fmtClock(state.lastAt, true) + ' · SSE 重连 ' + String(store.reconnects) + ' 次 · key ' + String(catalogVersion)),
    snapshot.scanner === undefined || snapshot.scanner === null
      ? null
      : React.createElement('div', { className: 'dsh-mlv-hint' },
        '会话日志观测：' + (snapshot.scanner.running ? '运行中' : '未启动') +
        ' · 目录 ' + String(snapshot.scanner.root) +
        ' · 已读 ' + String(snapshot.scanner.stats === null ? 0 : snapshot.scanner.stats.files) + ' 个会话文件 / ' +
        fmtTok(snapshot.scanner.stats === null ? 0 : snapshot.scanner.stats.bytes) + 'B' +
        ' · 回填窗口 ' + fmtDur(snapshot.scanner.backfillMs) +
        (snapshot.scanner.stats !== null && snapshot.scanner.stats.errors > 0 ? ' · 读取异常 ' + String(snapshot.scanner.stats.errors) + ' 次' : '')))

  return React.createElement('div', { className: 'dsh-mlv-page' },
    header, stats, liveCard, recentCard, modelCard,
    React.createElement(RuntimeLogCard, { key: 'runtime', runtime: snapshot.runtime }),
    React.createElement(CatalogBlock, { key: 'catalog' }),
    actionsCard)
}

/**
 * 注册 Client 半边。
 * @param {object} ctx - 客户端插件上下文。
 */
function apply(ctx) {
  ensureStarted()
  if (typeof ctx.effect === 'function') ctx.effect(() => insertCss(css))
  else insertCss(css)

  const slots = ctx.get('slots')
  if (!slots) return

  // 悬浮挂件：frame-wide 浮层，点击穿透，仅条目自身 opt-in。
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'model-live', order: 96, label: '模型调用实时监视' },
    ModelLiveWidget,
  ))

  // 设置页：一级导航条目，排在「API 余额」(135) 之后。
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'model-live', order: 136, label: '模型调用监控' },
    ModelLiveSettings,
  ))
}

const inject = ['slots']

module.exports = { apply, inject }
