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
 * 本插件在**两层**上把 `inputModalities` 补成 `[text, image]`：
 *
 *   A. `llm` 服务的 `listModels` / `resolveModelInfo` / `resolveModelInfoFor`
 *      —— apiproxy 的图片准入闸门与模型列表走这里；
 *   B. 每个受管路由**适配器实例**的 `resolveModel` —— 真正的请求组装走这里
 *      （LlmRuntime.prepareCall → registration.adapter.prepareCall → adapter.resolveModel）。
 *
 * 两层缺一不可。只做 A：图片会被放行，却在 dispatch 之前被 `projectImagesForTextModel`
 * 换成文本占位符（`[image omitted because this model accepts text only; …]`），
 * 模型于是「看不见」图 —— 表现为模型自己回一句「我读不到图片」。
 * 只做 B：界面根本不让附图片。
 *
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

  const { decide: rawDecide, sources, refreshAll, summary } = engine

  // 埋点。这次排查最难的不是「修」，是「看不见」：插件有没有生效、哪一层被走到、判定返回了
  // 什么，从外面一概不可知。下面这些计数与最近判定随 status.json 落盘。
  const trace = []
  const hits = { listModels: 0, resolveModelInfo: 0, resolveModelInfoFor: 0, adapterResolveModel: 0, configPinned: 0 }
  const decide = (provider, modelId) => {
    const decision = rawDecide(provider, modelId)
    trace.push({
      at: new Date().toISOString(),
      provider,
      model: modelId,
      decision: decision === undefined ? null : decision.join('+'),
    })
    if (trace.length > 40) trace.shift()
    scheduleStatus()
    return decision
  }

  // 首次刷新与拓扑变化后的刷新都是后台推进的，判定路径从不等待网络。
  void refreshAll().then(() => {
    for (const line of summary()) log.info?.(line)
    // 能力表这时才有内容，配置层要再钉一次（apply 那一刻它还是空的）。
    scanAdapters()
    writeStatus()
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
      hits.listModels += 1
      const models = await Reflect.apply(original, this, [provider, ...rest])
      return withModalitiesInList(models, decide)
    },
  )

  patch('resolveModelInfoFor', (original) =>
    async function resolveModelInfoFor(registration, model, ...rest) {
      hits.resolveModelInfoFor += 1
      const info = await Reflect.apply(original, this, [registration, model, ...rest])
      return withModalities(info, decide)
    },
  )

  patch('resolveModelInfo', (original) =>
    async function resolveModelInfo(provider, model, ...rest) {
      hits.resolveModelInfo += 1
      const info = await Reflect.apply(original, this, [provider, model, ...rest])
      return withModalities(info, decide)
    },
  )

  // ---------------------------------------------------------------------------
  // 第二层：适配器自己的模型解析。
  //
  // 只接管 `llm` 服务是不够的。真正组装请求的那条路是
  //   LlmRuntime.prepareCall → registration.adapter.prepareCall → adapter.resolveModel()
  // 它返回的 inputModalities 直接进 normalizeModelInfo，**不经过**
  // llm.resolveModelInfo / resolveModelInfoFor。漏掉这一层，图片会被 apiproxy 放行、
  // 再在 dispatch 之前被 projectImagesForTextModel 换成文本占位符。
  //
  // 适配器实例按 provider 共享（一个 PiAiAdapter 服务所有 pi-ai 路由），所以用 WeakSet
  // 保证一个实例只包一次，改不改由 provider 参数决定。
  // ---------------------------------------------------------------------------
  const wrappedAdapters = new WeakSet()
  const adapterRestorers = []
  /** 被钉过 image 的配置描述符，连同原值，供卸载时还原。 */
  const configRestorers = []
  let adapterCount = 0
  /**
   * 最靠内的一层：直接改 pi-ai 配置快照里的模型描述符。
   *
   * PiAiAdapter 的 resolveModel 读的是 [...resolvedModel.input]，它的 stream() 还会自己
   * 再查一次 model.input.includes("image") —— 两处都取自同一批描述符，不经过任何可以被
   * 接管的方法。只补前两层，这一层仍会把图片判成纯文本。
   */
  const pinConfigInputs = (adapter) => {
    let snapshot
    try {
      snapshot = typeof adapter.current === 'function' ? adapter.current() : adapter.snapshot
    } catch (error) {
      log.debug?.(`pi-ai-vision: 读不到适配器快照：${String(error)}`)
      return
    }
    const models = snapshot?.models
    if (models === undefined || models === null || typeof models.getModels !== 'function') return
    for (const provider of engine.routes.keys()) {
      let list
      try {
        list = models.getModels(provider)
      } catch {
        continue
      }
      if (!Array.isArray(list)) continue
      for (const descriptor of list) {
        if (descriptor === null || typeof descriptor !== 'object' || !Array.isArray(descriptor.input)) continue
        const decision = rawDecide(provider, descriptor.id)
        if (decision !== undefined && decision.includes('image') && !descriptor.input.includes('image')) {
          const before = descriptor.input
          descriptor.input = [...before, 'image']
          hits.configPinned += 1
          configRestorers.push(() => {
            descriptor.input = before
          })
        }
      }
    }
  }

  const wrapAdapter = (adapter) => {
    if (adapter === null || typeof adapter !== 'object') return
    // 快照可能被重建，所以即使实例已经包过也要重新钉一次配置。
    pinConfigInputs(adapter)
    if (wrappedAdapters.has(adapter)) return
    const original = adapter.resolveModel
    if (typeof original !== 'function') return
    adapter.resolveModel = function resolveModel(provider, model, ...rest) {
      hits.adapterResolveModel += 1
      return Promise.resolve(Reflect.apply(original, this, [provider, model, ...rest])).then((info) =>
        withModalities(info, decide),
      )
    }
    wrappedAdapters.add(adapter)
    adapterCount += 1
    adapterRestorers.push(() => {
      adapter.resolveModel = original
    })
  }
  /** 把当前所有受管路由的适配器都包上；适配器晚挂载时靠 llm/adapters-updated 补。 */
  const scanAdapters = () => {
    let map
    try {
      map = ctx.llm.adapters
    } catch (error) {
      log.debug?.(`pi-ai-vision: 读不到 llm.adapters：${String(error)}`)
      return
    }
    if (map === null || typeof map !== 'object' || typeof map.get !== 'function') {
      log.warn?.('pi-ai-vision: llm.adapters 不是可读的 Map，适配器层无法接管（harness 版本变化？）')
      return
    }
    for (const provider of engine.routes.keys()) {
      const registration = map.get(provider)
      if (registration?.adapter !== undefined) wrapAdapter(registration.adapter)
    }
  }
  scanAdapters()

  // 装载证据。cordis 的 ctx.logger 输出不进进程日志，于是「插件到底有没有生效」
  // 从外部完全看不出来 —— 这次排查就卡在这里。写一个只读状态文件让它可被直接检查：
  //
  //   ~/.dsh/pi-ai-vision/status.json
  //
  // 含装载时刻、两层各自接管到几个、能力端点的模型数与判为支持视觉的模型名单。
  // config.statusFile: false 可关掉。
  const statusPath =
    config?.statusFile === false ? undefined : path.join(os.homedir(), '.dsh', 'pi-ai-vision', 'status.json')
  const loadedAt = new Date().toISOString()
  // 判定发生在请求里，状态文件不能等到下一次 TTL 轮询才更新；合并成 1.5 秒最多写一次。
  let statusTimer
  const scheduleStatus = () => {
    if (statusTimer !== undefined) return
    statusTimer = setTimeout(() => {
      statusTimer = undefined
      writeStatus()
    }, 1500)
    statusTimer.unref?.()
  }
  const writeStatus = () => {
    if (statusPath === undefined) return
    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true })
      const capabilityCounts = {}
      const visionModels = {}
      for (const [provider, source] of sources) {
        capabilityCounts[provider] = source.size
        visionModels[provider] = source.visionIds()
      }
      fs.writeFileSync(
        statusPath,
        `${JSON.stringify(
          {
            plugin: name,
            loadedAt,
            updatedAt: new Date().toISOString(),
            llmMethodsPatched: restorers.length,
            adaptersWrapped: adapterCount,
            hits,
            routes: summary(),
            capabilityCounts,
            visionModels,
            recentDecisions: trace,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch (error) {
      log.debug?.(`pi-ai-vision: 写状态文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  writeStatus()

  // harness 在适配器拓扑变化时广播该事件；适配器重挂 + 用户在 Models 页增删模型都会触发。
  let offTopology
  try {
    offTopology = ctx.on?.('llm/adapters-updated', () => {
      scanAdapters()
      writeStatus()
      void refreshAll().then(() => {
        scanAdapters()
        writeStatus()
      })
    })
  } catch (error) {
    log.debug?.(`pi-ai-vision: 订阅 llm/adapters-updated 失败：${String(error)}`)
  }

  // TTL 轮询兜底：上游给同一个模型换了 mmproj，而拓扑没动。
  const ttlMinutes = Math.min(...[...engine.routes.values()].map((rule) => rule.ttlMinutes))
  const timer = setInterval(() => {
    void refreshAll().then(() => {
      scanAdapters()
      writeStatus()
    })
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
    for (const restore of adapterRestorers) {
      try {
        restore()
      } catch {
        // 适配器可能已经换掉了。
      }
    }
    for (const restore of configRestorers) {
      try {
        restore()
      } catch {
        // 描述符可能已经被重建。
      }
    }
  }
  try {
    ctx.effect?.(() => teardown, 'pi-ai-vision: llm 模态接管')
  } catch (error) {
    log.warn?.(`pi-ai-vision: 注册清理钩子失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
