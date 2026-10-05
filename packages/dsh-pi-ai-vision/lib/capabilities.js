/**
 * 能力来源 —— 向模型服务端点查询「这个模型到底收不收图片」。
 *
 * 设计要点：
 * 1. `refresh()` 永远是后台推进的，判定路径（`vision()`）是**同步**的。查询慢或
 *    端点不可达时，判定退回模式表，绝不让一次模型请求卡在网络上。
 * 2. 查询失败保留上一次成功的表，不把「暂时问不到」当成「不支持」。
 * 3. 上游返回 `false` 与「上游没提这个模型」是两回事：前者是明确否定，后者是未知。
 *
 * @module dsh-pi-ai-vision/capabilities
 */

/** 缺省的能力字段名，按顺序取第一个存在且可解释的。 */
export const DEFAULT_VISION_FIELDS = Object.freeze([
  'supportsVision',
  'isMultimodal',
  'supports_vision',
  'vision',
  'capabilities.vision',
  'modalities',
])

/** 读一个可能带点号路径的字段。 */
function readPath(object, path) {
  let cursor = object
  for (const segment of String(path).split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
}

/**
 * 把一条模型记录解释成「支持 / 不支持 / 未表态」。
 *
 * @param entry - 上游返回的一条模型记录。
 * @param fields - 候选字段名。
 * @returns `true`、`false`，或 `undefined` 表示这条记录没有表态。
 */
export function readVision(entry, fields = DEFAULT_VISION_FIELDS) {
  if (entry === null || typeof entry !== 'object') return undefined
  for (const field of fields) {
    const value = readPath(entry, field)
    if (typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.includes('image')
  }
  return undefined
}

/**
 * 从任意响应形状里挑出模型数组。
 *
 * @param json - 已解析的响应体。
 * @param modelsPath - 配置里显式给的路径；缺省时按常见键名猜。
 * @returns 模型数组，或 `null`。
 */
export function pickModelArray(json, modelsPath) {
  if (Array.isArray(json)) return json
  if (json === null || typeof json !== 'object') return null
  if (typeof modelsPath === 'string' && modelsPath.length > 0) {
    const value = readPath(json, modelsPath)
    return Array.isArray(value) ? value : null
  }
  for (const key of ['models', 'data', 'list', 'items', 'result', 'model_list']) {
    if (Array.isArray(json[key])) return json[key]
  }
  return null
}

/** 一条模型记录的 id 字段，按常见命名取第一个非空字符串。 */
export function readModelId(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  for (const key of ['id', 'model', 'modelId', 'name']) {
    const value = entry[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * 一条路由的能力来源：缓存 + 后台刷新 + 同步判定。
 */
export class CapabilitySource {
  #provider
  #url
  #headers
  #modelsPath
  #visionFields
  #timeoutMs
  #log
  /** @type {Map<string, boolean> | null} 最近一次成功查询的结果。 */
  #map = null
  /** @type {Promise<void> | null} 正在进行的查询，用于合并并发刷新。 */
  #inflight = null
  /** 上一次失败的简述，用于抑制重复告警。 */
  #lastError = null
  #warned = false

  /**
   * @param {object} options - 路由级配置。
   * @param {string} options.provider - 路由 id，仅用于日志。
   * @param {string} options.url - 能力端点。
   * @param {Record<string, string>} [options.headers] - 额外请求头。
   * @param {string} [options.apiKeyEnv] - 从环境变量取 Bearer 令牌。
   * @param {string} [options.modelsPath] - 模型数组在响应里的路径。
   * @param {string[]} [options.visionFields] - 能力字段候选。
   * @param {number} [options.timeoutMs] - 单次查询超时。
   * @param {object} options.log - 日志器。
   */
  constructor({ provider, url, headers, apiKeyEnv, modelsPath, visionFields, timeoutMs, log }) {
    this.#provider = provider
    this.#url = url
    this.#modelsPath = modelsPath
    this.#visionFields = Array.isArray(visionFields) && visionFields.length > 0 ? visionFields : DEFAULT_VISION_FIELDS
    this.#timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000
    this.#log = log
    const merged = { accept: 'application/json', ...(headers ?? {}) }
    if (typeof apiKeyEnv === 'string' && apiKeyEnv.length > 0) {
      const token = process.env?.[apiKeyEnv]
      if (typeof token === 'string' && token.length > 0) merged.authorization = `Bearer ${token}`
    }
    this.#headers = merged
  }

  /** 这条来源是否配置了可用端点。 */
  get configured() {
    return typeof this.#url === 'string' && this.#url.length > 0
  }

  /** 已装载的模型数，仅用于日志与自测。 */
  get size() {
    return this.#map?.size ?? 0
  }

  /**
   * 同步判定一个模型是否支持视觉。
   *
   * @param {string} modelId - 路由里的模型 id。
   * @returns {boolean | undefined} 明确的支持/不支持，或 `undefined`（未知）。
   */
  vision(modelId) {
    return this.#map?.get(modelId)
  }

  /** 后台推进一次刷新，合并并发调用，永不抛错。 */
  refresh() {
    if (!this.configured) return Promise.resolve(this.#map)
    if (this.#inflight !== null) return this.#inflight
    this.#inflight = this.#load()
      .catch(() => undefined)
      .finally(() => {
        this.#inflight = null
      })
    return this.#inflight
  }

  async #load() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await fetch(this.#url, { headers: this.#headers, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const entries = pickModelArray(json, this.#modelsPath)
      if (entries === null) throw new Error('响应里找不到模型数组')
      const next = new Map()
      for (const entry of entries) {
        const id = readModelId(entry)
        if (id === undefined) continue
        const vision = readVision(entry, this.#visionFields)
        if (vision !== undefined) next.set(id, vision)
      }
      this.#map = next
      this.#lastError = null
      if (this.#warned) {
        this.#log.info?.(`pi-ai-vision: 路由 "${this.#provider}" 能力端点恢复，已装载 ${next.size} 条模型能力`)
        this.#warned = false
      }
      return next
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.#lastError !== message) {
        this.#lastError = message
        this.#warned = true
        const kept = this.#map === null ? '（暂无缓存，判定将退回模式表）' : `（沿用上次成功的 ${this.#map.size} 条）`
        this.#log.warn?.(`pi-ai-vision: 路由 "${this.#provider}" 读取 ${this.#url} 失败：${message}${kept}`)
      }
      return this.#map
    } finally {
      clearTimeout(timer)
    }
  }
}
