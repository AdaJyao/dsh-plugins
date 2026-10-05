/**
 * dsh-pi-ai-vision —— 宿主半身。
 *
 * 解决的问题
 * ----------
 * `@deepseek-ai/dsh-llm-pi-ai` 的模态解析顺序是「条目 input → 已安装 catalog →
 * 路由 defaultInput（默认 [text]）」。本地 llama.cpp / LM Studio / vLLM 这类网关
 * 不在 pi-ai 的 catalog 里，于是每个模型条目没写 `input` 时一律被判为纯文本，
 * 聊天界面直接拒绝图片附件：
 *
 *   Model "xxx" does not support image input.  (MODEL_DOES_NOT_SUPPORT_IMAGES)
 *
 * 本插件在 `llm` 服务上接管三个方法（`listModels`、`resolveModelInfo`、
 * `resolveModelInfoFor`），在返回值上把 `inputModalities` 补成 `[text, image]`。
 * 判定来源按优先级：
 *
 *   1. 本插件配置里的显式 `models` 覆盖表；
 *   2. 路由 `capabilityUrl` 指向的能力端点（同步读缓存，后台刷新）；
 *   3. 模型名模式表（保守兜底，可在配置里关掉）。
 *
 * 只补不删：任何一级返回 `undefined`（未知）时原样返回，用户在手写配置里声明的
 * 模态永远优先。
 *
 * @module dsh-pi-ai-vision
 */

import { CapabilitySource } from './capabilities.js'
import { resolvePatterns } from './patterns.js'
import { withModalities, withModalitiesInList, TEXT_AND_IMAGE } from './decorate.js'

/** cordis 插件名，用于 fiber 诊断与日志前缀。 */
export const name = 'pi-ai-vision'

/** 本插件离开 `llm` 服务就无法工作，而它只注入这一个。 */
export const inject = ['llm']

/** 能力缓存缺省存活时长（分钟）。 */
const DEFAULT_TTL_MINUTES = 10

/** 取一个可用的日志器，拿不到就退回 console。 */
function resolveLogger(ctx) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger
    if (logger !== null && typeof logger === 'object' && typeof logger.info === 'function') return logger
  } catch {
    // 日志器缺失不该让插件起不来。
  }
  return console
}

/** 规范化配置里的 `models` 覆盖表。 */
function normalizeOverrides(models) {
  if (models === null || typeof models !== 'object') return {}
  const out = {}
  for (const [id, value] of Object.entries(models)) {
    if (id.length === 0 || !Array.isArray(value)) continue
    const modalities = value.filter((entry) => typeof entry === 'string' && entry.length > 0)
    if (modalities.length > 0) out[id] = modalities
  }
  return out
}

/**
 * 把插件配置规范化成路由表。
 *
 * @param {object} config - 插件配置。
 * @param {boolean} globalPatternFallback - 全局模式兜底开关。
 * @returns {Map<string, object>} 路由 id → 规则。
 */
function normalizeRoutes(config, globalPatternFallback) {
  const raw = config?.routes ?? config?.providers ?? {}
  const routes = new Map()
  if (raw === null || typeof raw !== 'object') return routes
  for (const [provider, value] of Object.entries(raw)) {
    if (provider.length === 0 || value === null || value === undefined || value === false) continue
    const spec = typeof value === 'string' ? { capabilityUrl: value } : value
    if (spec === null || typeof spec !== 'object') continue
    const patternFallback = spec.patternFallback === false ? false : globalPatternFallback
    routes.set(provider, {
      capabilityUrl:
        typeof spec.capabilityUrl === 'string' && spec.capabilityUrl.length > 0
          ? spec.capabilityUrl
          : typeof spec.url === 'string'
            ? spec.url
            : '',
      headers: spec.headers !== null && typeof spec.headers === 'object' ? spec.headers : undefined,
      apiKeyEnv: typeof spec.apiKeyEnv === 'string' ? spec.apiKeyEnv : undefined,
      modelsPath: typeof spec.modelsPath === 'string' ? spec.modelsPath : undefined,
      visionFields: Array.isArray(spec.visionFields) ? spec.visionFields : undefined,
      timeoutMs: Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : undefined,
      ttlMinutes: Number.isFinite(spec.ttlMinutes) && spec.ttlMinutes > 0 ? spec.ttlMinutes : DEFAULT_TTL_MINUTES,
      patterns: patternFallback ? resolvePatterns(spec.patterns, spec.useBuiltinPatterns !== false) : [],
      models: normalizeOverrides(spec.models),
    })
  }
  return routes
}

/**
 * 组装一套「模态判定引擎」：能力来源 + 三级判定。
 *
 * 与 cordis 解耦，便于脱离 harness 自测（见 scripts/selftest.mjs）。
 *
 * @param {object} config - 插件配置。
 * @param {object} log - 日志器。
 * @returns {{ routes: Map<string, object>, sources: Map<string, CapabilitySource>, decide: Function, refreshAll: Function, summary: Function }}
 */
export function createEngine(config = {}, log = console) {
  const globalPatternFallback = config?.patternFallback !== false
  const routes = normalizeRoutes(config, globalPatternFallback)
  const sources = new Map()
  for (const [provider, rule] of routes) {
    sources.set(
      provider,
      new CapabilitySource({
        provider,
        url: rule.capabilityUrl,
        headers: rule.headers,
        apiKeyEnv: rule.apiKeyEnv,
        modelsPath: rule.modelsPath,
        visionFields: rule.visionFields,
        timeoutMs: rule.timeoutMs,
        log,
      }),
    )
  }

  const decide = (provider, modelId) => {
    const rule = routes.get(provider)
    if (rule === undefined) return undefined
    const override = rule.models[modelId]
    if (override !== undefined) return override
    const known = sources.get(provider)?.vision(modelId)
    if (known === true) return TEXT_AND_IMAGE
    if (known === false) return undefined
    for (const pattern of rule.patterns) {
      if (pattern.test(modelId)) return TEXT_AND_IMAGE
    }
    return undefined
  }

  const refreshAll = () =>
    Promise.all([...sources.values()].map((source) => source.refresh())).then(() => undefined)

  const summary = () => {
    const lines = []
    for (const [provider, source] of sources) {
      const rule = routes.get(provider)
      lines.push(
        `${provider}: 能力端点${source.configured ? '已配置' : '未配置'}，已装载 ${source.size} 条，` +
          `模式兜底 ${rule.patterns.length > 0 ? `开启（${rule.patterns.length} 条）` : '关闭'}`,
      )
    }
    return lines
  }

  return { routes, sources, decide, refreshAll, summary }
}

/**
 * cordis 插件入口。
 *
 * @param {object} ctx - cordis 上下文（已注入 `llm`）。
 * @param {object} config - 见 README 的配置表。
 */
export function apply(ctx, config = {}) {
  const log = resolveLogger(ctx)
  let engine
  try {
    engine = createEngine(config, log)
  } catch (error) {
    log.warn?.(`pi-ai-vision: 配置解析失败，插件空转：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (engine.routes.size === 0) {
    log.info?.('pi-ai-vision: 未配置任何路由（config.routes 为空），插件空转')
    return
  }

  const { decide, sources, refreshAll, summary } = engine

  // 首次刷新与拓扑变化后的刷新都是后台推进的，判定路径从不等待网络。
  void refreshAll().then(() => {
    for (const line of summary()) log.info?.(line)
  })

  // 只读一次 ctx.llm 并把它留到最后：fiber 卸载后 ctx 会失活
  // （cannot get required service in inactive context），但 apply 期间取得的
  // 这个代理仍然可用，卸载回滚必须走它。
  const llm = ctx.llm
  const restorers = []
  /**
   * 在 `llm` 服务上接管一个方法。
   *
   * cordis 的 `ctx.llm` 是每次读取新建的代理，但**写会穿透到共享 service 实例**，
   * 所以这里赋值即对全应用生效（apiproxy、agent loop 都读同一个实例）。
   */
  const patch = (method, wrap) => {
    const original = llm[method]
    if (typeof original !== 'function') {
      log.warn?.(`pi-ai-vision: llm.${method} 不存在，跳过（可能是 harness 版本变化）`)
      return
    }
    let wrapped
    try {
      wrapped = wrap(original)
      llm[method] = wrapped
    } catch (error) {
      log.warn?.(`pi-ai-vision: 接管 llm.${method} 失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // 注意：cordis 的服务代理每次读取都会返回新的包装函数，所以不能用恒等比较
    // 判断「写入是否成功」——那样会恒为假，连回滚登记都会被跳过。
    if (typeof llm[method] !== 'function') {
      log.warn?.(`pi-ai-vision: 接管 llm.${method} 未生效（service 拒绝写入），该路径回退为原始行为`)
      return
    }
    restorers.push(() => {
      llm[method] = original
    })
  }

  patch('listModels', (original) =>
    async function listModels(provider, ...rest) {
      const models = await Reflect.apply(original, this, [provider, ...rest])
      return withModalitiesInList(models, decide)
    },
  )

  patch('resolveModelInfoFor', (original) =>
    async function resolveModelInfoFor(registration, model, ...rest) {
      const info = await Reflect.apply(original, this, [registration, model, ...rest])
      return withModalities(info, decide)
    },
  )

  patch('resolveModelInfo', (original) =>
    async function resolveModelInfo(provider, model, ...rest) {
      const info = await Reflect.apply(original, this, [provider, model, ...rest])
      return withModalities(info, decide)
    },
  )

  // harness 在适配器拓扑变化时广播该事件；用户在 Models 页增删模型即触发。
  let offTopology
  try {
    offTopology = ctx.on?.('llm/adapters-updated', () => {
      void refreshAll()
    })
  } catch (error) {
    log.debug?.(`pi-ai-vision: 订阅 llm/adapters-updated 失败：${String(error)}`)
  }

  // TTL 轮询兜底：上游给同一个模型换了 mmproj，而拓扑没动。
  const ttlMinutes = Math.min(...[...engine.routes.values()].map((rule) => rule.ttlMinutes))
  const timer = setInterval(() => {
    void refreshAll()
  }, ttlMinutes * 60_000)
  timer.unref?.()

  const teardown = () => {
    clearInterval(timer)
    try {
      offTopology?.()
    } catch {
      // 订阅器已经随 fiber 走掉了。
    }
    for (const restore of restorers) {
      try {
        restore()
      } catch {
        // 服务可能已经卸载。
      }
    }
  }
  try {
    ctx.effect?.(() => teardown, 'pi-ai-vision: llm 模态接管')
  } catch (error) {
    log.warn?.(`pi-ai-vision: 注册清理钩子失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
