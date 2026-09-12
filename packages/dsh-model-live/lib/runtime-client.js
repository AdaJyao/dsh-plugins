/**
 * dsh-model-live — 运行时日志**客户端**（第三观测源）
 *
 * 采集本身不在 DSH 里做了：模型运行时日志由**独立服务** dsh-runtime-log 采集
 * （/vol1/1000/DeepSeek herness/project/dsh-runtime-log，自带网页 + JSON API + SSE，
 * 由用户级 cron 看护）。这样：
 *   - 采集不受 DSH 启停影响（DSH 重启、插件停用都不会断采集）；
 *   - SSH 只由那一个服务发起，不因为多开标签/多进程而重复拉取；
 *   - 采集逻辑与展示逻辑解耦：不想用 DSH 也能直接开服务自带的网页看。
 *
 * 本模块只做一件事：定期读独立服务的 `/api/state`，映射成插件快照里的 `runtime` 段
 * （与旧版内置 SSH 采集完全同形，所以界面不用改）。服务不可达时如实标出来，
 * 不影响另外两个观测源（本进程瀑布、会话日志）。
 */

/** 单次 HTTP 读取超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 8000

/**
 * 运行时日志客户端。
 */
export class RuntimeLogClient {
  /**
   * @param {object} options - 配置。
   * @param {string} options.url - 独立服务地址，例如 http://127.0.0.1:18610。
   * @param {number} [options.pollMs] - 读取节奏。
   * @param {() => void} [options.onUpdate] - 数据变化时的回调（供宿主触发快照推送）。
   * @param {(text: string, error?: unknown) => void} [options.warn] - 诊断回调。
   */
  constructor(options) {
    this.url = String(options.url).replace(/\/+$/, '')
    this.pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 5000
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null
    this.warn = options.warn === undefined ? () => {} : options.warn
    /** 最近一次读取结果。 */
    this.state = { ok: false, at: 0, error: null, data: null }
    this.timer = null
    this.busy = false
  }

  /** 读一次独立服务的快照。 */
  async poll() {
    if (this.busy) return
    this.busy = true
    const previous = this.state.data
    try {
      const response = await fetch(this.url + '/api/state', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new Error('独立服务返回 HTTP ' + String(response.status))
      const data = await response.json()
      const changed = previous === null ||
        previous.stats === undefined ||
        data.stats === undefined ||
        previous.stats.polls !== data.stats.polls ||
        this.state.ok !== true
      this.state = { ok: true, at: Date.now(), error: null, data }
      if (changed && this.onUpdate !== null) this.onUpdate()
    } catch (error) {
      const message = String(error && error.message ? error.message : error).slice(0, 200)
      const firstFailure = this.state.ok
      this.state = { ok: false, at: Date.now(), error: message, data: previous }
      if (firstFailure && this.onUpdate !== null) this.onUpdate()
    } finally {
      this.busy = false
    }
  }

  /** 开始周期读取（幂等）。 */
  start() {
    if (this.timer !== null) return
    void this.poll()
    this.timer = setInterval(() => { void this.poll() }, this.pollMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 停止周期读取（幂等）。 */
  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 映射成快照里的 `runtime` 段（与内置采集时代同形）。
   * @returns {object} 可直接 JSON 过桥的视图。
   */
  view() {
    const data = this.state.data
    const stats = data === null || data.stats === undefined ? null : data.stats
    const sources = data === null || !Array.isArray(data.sources) ? [] : data.sources
    return {
      /** 采集在独立服务里进行；这里标出来，界面据此提示"去服务网页看完整内容"。 */
      standalone: true,
      label: this.url.replace(/^https?:\/\//, ''),
      url: this.url,
      running: this.state.ok,
      polls: stats === null ? 0 : stats.polls,
      failures: stats === null ? 0 : stats.failures,
      bytes: stats === null ? 0 : stats.bytes,
      dropped: stats === null ? 0 : stats.dropped,
      lastAt: stats === null ? null : stats.lastAt,
      lastError: this.state.ok ? (stats === null ? null : stats.lastError) : (this.state.error ?? '独立服务不可达'),
      readAt: this.state.at === 0 ? null : this.state.at,
      perf: data === null || data.perf === undefined ? null : data.perf,
      sources: sources.map((source) => ({
        id: source.id,
        label: source.label,
        path: source.path,
        host: source.host,
        size: source.size,
        count: source.count,
        lastAt: source.lastAt,
        error: source.error,
        lines: Array.isArray(source.lines) ? source.lines : [],
      })),
      lines: data === null || !Array.isArray(data.lines) ? [] : data.lines,
    }
  }
}
