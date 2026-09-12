/**
 * dsh-model-live — Host 端（模型调用实时监视）
 *
 * 观测点：LLM 服务的 llm/stream 瀑布（@deepseek-ai/dsh-llm 的
 * streamWithRegistration 里 ctx.waterfall(this, 'llm/stream', options, ...)）。
 * 本插件只是在链路最外层再套一层 **只读** 的异步生成器包装：
 * 每个 chunk 原样透传（不缓存、不重排、不改写、不吞异常），只做标量计数。
 * 因此它对会话行为是零影响的 —— 解包/异常/中断语义全部保持内核原样。
 *
 * 提供两种取数方式（浏览器半边两种都会用）：
 *  - SSE  GET  /_dsh/model-live/events   实时推送（结构变化推 snapshot，进行中推 tick）
 *  - 轮询 POST /_dsh/model-live/state    同一份快照（SSE 不可达时的兜底）
 *  - 目录 POST /_dsh/model-live/catalog  提供方 + 模型清单（带 TTL 缓存）
 *  - 清空 POST /_dsh/model-live/clear    只清本插件的内存记录，不碰任何会话/日志
 *
 * 三条硬约束：
 * 1. 只读：不注入请求、不改 options、不修改会话与日志，也不持久化任何东西。
 * 2. 观测失败绝不影响模型调用：所有计数逻辑都包在 try/catch 里，异常被丢弃。
 * 3. 不落地：只在内存里保留最近 MAX_RECORDS 次调用；DSH 重启即清零。
 *
 * 路由刻意挂在 /_dsh/ 之下：该前缀已在门户网关 bridge.mjs 的改写表内，
 * 无论是直连 23006 还是经 fnOS 门户 /app/dsh-qddev 都可达，无需改网关。
 */

import { SessionLogTailer } from './session-log.js'
import { RuntimeLogClient } from './runtime-client.js'

/** Cordis 插件名（与包名一致，便于在插件清单里对上）。 */
export const name = 'dsh-model-live'

/**
 * **本地推理提供方**的识别（启发式，只看 provider id 前缀）。
 * 面板上要把"这条调用到底跑在哪"讲清楚：云端 API 与用户自己机器上的推理服务
 * （本部署是 `spark-local` 的 llama.cpp 与 `ollama`）混在一张表里时，光看模型名不够直观。
 * 认不出来的一律按"非本地"处理 —— 宁可少标，也不要错标。
 */
const LOCAL_PROVIDER_RE = /^(ollama|spark|llama|lm-?studio|vllm|local|koboldcpp|text-generation)/i
function isLocalProvider(provider) {
  return typeof provider === 'string' && LOCAL_PROVIDER_RE.test(provider.trim()) === true
}

/** HTTP 路由前缀。 */
const ROUTE_PREFIX = '/_dsh/model-live'
/** 内存中保留的调用记录上限（超出丢最老的）。 */
const MAX_RECORDS = 120
/** 快照里「最近调用」的条数上限。 */
const RECENT_LIMIT = 30
/** 进行中调用的推送节奏（毫秒）。 */
const TICK_MS = 300
/** SSE 心跳注释间隔（毫秒），用于穿透会掐空闲连接的反代。 */
const PING_MS = 20000
/** 单次调用记录的工具名上限。 */
const TOOL_NAME_LIMIT = 12
/** 模型目录缓存时长（毫秒）——listModels 可能打到 provider 端点。 */
const CATALOG_TTL_MS = 60000
/** 结构变化合并推送的窗口（毫秒），避免并发调用结束时刷屏。 */
const FLUSH_MS = 120
/** 会话日志扫描节奏（毫秒）。本地模型调用多发生在别的 DSH 进程里，靠它才能看见。 */
const SCAN_TICK_MS = 2000
/** 首次扫描只回填这么久以内的调用（更早的历史不进内存）。 */
const SCAN_BACKFILL_MS = 6 * 60 * 60 * 1000
/** 每 tick 最多推进几个会话日志文件（避免启动时长时间占用事件循环）。 */
const SCAN_FILES_PER_TICK = 3
/** 判定「同一次调用」的时间容差（毫秒）：实时观测与日志两条来源据此去重。 */
const DEDUPE_WINDOW_MS = 5000
/** 运行时日志采集节奏（毫秒）。 */
const RUNTIME_POLL_MS = 5000
/**
 * 快照里带多少行运行时日志（**只带合并视图**）。
 *
 * 这里刻意压得很小：运行时日志一旦整段塞进快照，每次结构变化就要推 80~110KB，
 * 面板开着时浏览器每几秒解析一次大 JSON、React 重渲染一遍 —— 又费又卡。
 * 每源明细改走按需路由 `POST /_dsh/model-live/runtime`（见下），只在真的切到某个来源时取。
 */
const RUNTIME_LINES = 20
/** 按需路由里每个来源最多返回多少行。 */
const RUNTIME_SOURCE_LINES = 120
/**
 * 运行时日志采集**独立服务**的地址。
 *
 * 采集本身不在 DSH 里 —— 独立服务 `dsh-runtime-log` 负责经 SSH 只读拉取模型主机上的
 * 日志（llama.cpp 的 Spark-X2.5-4B / Ollama 服务端），自带网页与 API，由用户级 cron 看护。
 * 这样 DSH 重启、插件停用都不会中断采集；本插件只是它的一个消费者。
 * 服务目录：/vol1/1000/DeepSeek herness/project/dsh-runtime-log
 */
const RUNTIME_URL = process.env.DSH_RUNTIME_LOG_URL ?? 'http://127.0.0.1:18610'

/**
 * 注册 Host 半边。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  /** id -> 调用记录（live 活对象，字段随时在变）。 */
  const records = new Map()
  /** 记录 id 的时间序（用于裁剪）。 */
  const order = []
  /** 模型元数据：provider + NUL + model -> { name, contextWindow, ... }。 */
  const facts = new Map()
  /** 正在解析的模型元数据（去重）。 */
  const resolving = new Set()
  /** 每模型聚合统计：同 key -> 计数桶。 */
  const stats = new Map()
  /** 正在推送的 SSE 响应对象集合。 */
  const clients = new Set()
  /** 提供方模型目录缓存：provider -> { at, models, error }。 */
  const catalog = new Map()

  /** 全局累计（只统计已经结束的调用）。 */
  const totals = {
    calls: 0,
    failed: 0,
    aborted: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    millis: 0,
    generationMillis: 0,
    ttftSum: 0,
    ttftCount: 0,
    lastAt: 0,
    lastModel: null,
    /** 最近一次调用的显示名与提供方（面板上直接展示"具体是哪个模型"）。 */
    lastModelName: null,
    lastProvider: null,
    /** 其中来自会话日志（别的 DSH 进程，例如 headless 执行者）的条数。 */
    external: 0,
    /** 其中跑在本地推理服务上的条数（spark-local / ollama …）。 */
    local: 0,
  }

  /** 会话启动时刻（= 插件加载时刻）。 */
  const startedAt = Date.now()
  /** 结构性版本号：只要列表/统计形态变了就 +1。 */
  let revision = 0
  /** 记录序号。 */
  let seq = 0
  /** 会话日志来源的记录序号（与实时记录共用 seq 排序，但 id 前缀不同便于辨认）。 */
  let logSeq = 0
  /** 推送节拍器。 */
  let timer = null
  /** 心跳计时。 */
  let sincePing = 0
  /** 结构变化待推送。 */
  let pendingFlush = null

  /* ------------------------------- 小工具 ------------------------------- */

  /**
   * 只取叶子字符串并限长：内部活数据不做整体拷贝。
   * @param {unknown} value - 任意值。
   * @param {number} max - 最大长度。
   * @returns {string|null} 短字符串或 null。
   */
  function str(value, max) {
    if (typeof value !== 'string') return null
    return value.length > max ? value.slice(0, max) : value
  }

  /**
   * 只取有限数值。
   * @param {unknown} value - 任意值。
   * @returns {number|null} 有限数或 null。
   */
  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  /**
   * 非负计数。
   * @param {unknown} value - 任意值。
   * @returns {number} 有限非负数或 0。
   */
  function count(value) {
    const n = finite(value)
    return n === null || n < 0 ? 0 : n
  }

  /**
   * 错误压成一行短文本。
   * @param {unknown} error - 任意异常。
   * @returns {string} 不超过 200 字符的说明。
   */
  function message(error) {
    return String(error && error.message ? error.message : error).slice(0, 200)
  }

  /** 模型聚合的键。 */
  function modelKey(provider, model) {
    return String(provider) + '\u0000' + String(model)
  }

  /* --------------------------- 模型元数据与聚合 --------------------------- */

  /**
   * 取 llm 服务（可能尚未挂载）。
   * @returns {object|undefined} llm 服务实例。
   */
  function llm() {
    try {
      return ctx.get('llm')
    } catch {
      return undefined
    }
  }

  /**
   * 异步解析一个模型的元数据并落缓存 —— 这是「模型相关数据」的来源：
   * 显示名、上下文窗口、默认最大输出、输入模态、推理档位。
   * 解析失败只记一行日志，不影响调用本身。
   * @param {string} provider - 提供方路由。
   * @param {string} model - 模型 id。
   */
  function resolveFacts(provider, model) {
    const key = modelKey(provider, model)
    if (facts.has(key) || resolving.has(key)) return
    const service = llm()
    if (service === undefined || typeof service.resolveModelInfo !== 'function') return
    resolving.add(key)
    Promise.resolve()
      .then(() => service.resolveModelInfo(provider, model))
      .then((info) => {
        const modalities = Array.isArray(info && info.inputModalities) ? info.inputModalities : null
        const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
          ? info.reasoning.efforts.map((effort) => str(effort && effort.id, 32)).filter((id) => id !== null)
          : null
        facts.set(key, {
          provider,
          model,
          name: str(info && info.name, 120),
          description: str(info && info.description, 200),
          contextWindow: finite(info && info.context && info.context.contextWindow),
          maxTokens: finite(info && info.defaultMaxTokens),
          modalities: modalities === null ? null : modalities.map((m) => str(m, 16)).filter((m) => m !== null),
          efforts,
          defaultEffort: str(info && info.reasoning && info.reasoning.defaultEffort, 32),
          resolvedAt: Date.now(),
          error: null,
        })
      }, (error) => {
        facts.set(key, {
          provider,
          model,
          name: null,
          description: null,
          contextWindow: null,
          maxTokens: null,
          modalities: null,
          efforts: null,
          defaultEffort: null,
          resolvedAt: Date.now(),
          error: message(error),
        })
      })
      .then(() => {
        resolving.delete(key)
        touch()
      })
  }

  /**
   * 取一个模型的聚合桶，没有就建。
   * @param {string} provider - 提供方路由。
   * @param {string} model - 模型 id。
   * @returns {object} 聚合桶。
   */
  function bucket(provider, model) {
    const key = modelKey(provider, model)
    let row = stats.get(key)
    if (row === undefined) {
      row = {
        provider,
        model,
        calls: 0,
        failed: 0,
        aborted: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        millis: 0,
        generationMillis: 0,
        ttftSum: 0,
        ttftCount: 0,
        active: 0,
        lastAt: 0,
        external: 0,
      }
      stats.set(key, row)
    }
    return row
  }

  /* ------------------------------ 调用观测 ------------------------------ */

  /**
   * 开始记录一次模型调用。任何异常都被吞掉并返回 null —— 观测不得影响调用。
   * @param {object} options - llm/stream 的请求对象。
   * @returns {object|null} 新记录，或 null（观测不可用）。
   */
  function begin(options) {
    try {
      const now = Date.now()
      const provider = str(options && options.provider, 80) || '(未知)'
      const model = str(options && options.model, 120) || '(未知)'
      seq += 1
      const record = {
        id: 'c' + String(seq),
        seq,
        source: 'live',
        workspace: null,
        preset: null,
        contextWindowHint: null,
        status: 'active',
        startedAt: now,
        endedAt: 0,
        provider,
        model,
        sessionId: str(options && options.sessionId, 64),
        systemChars: typeof (options && options.system) === 'string' ? options.system.length : 0,
        messages: Array.isArray(options && options.messages) ? options.messages.length : 0,
        tools: Array.isArray(options && options.tools) ? options.tools.length : 0,
        reasoningEffort: str(options && options.reasoningEffort, 32),
        maxTokens: finite(options && options.maxTokens),
        textChars: 0,
        reasoningChars: 0,
        toolArgChars: 0,
        chunks: 0,
        toolNames: [],
        usage: null,
        finish: null,
        errorCode: null,
        errorMessage: null,
        firstChunkAt: 0,
        firstTextAt: 0,
      }
      records.set(record.id, record)
      order.push(record.id)
      while (order.length > MAX_RECORDS) {
        const dropped = order.shift()
        records.delete(dropped)
      }
      bucket(provider, model).active += 1
      resolveFacts(provider, model)
      touch()
      return record
    } catch (error) {
      ctx.logger?.warn?.('[model-live] 记录调用失败（已忽略）')
      ctx.logger?.warn?.(error)
      return null
    }
  }

  /**
   * 观察一个 chunk：只累加标量，不改动 chunk 本身。
   * @param {object} record - 调用记录。
   * @param {object} chunk - 内核产出的流式分片。
   */
  function observe(record, chunk) {
    try {
      if (chunk === null || typeof chunk !== 'object') return
      record.chunks += 1
      if (record.firstChunkAt === 0) record.firstChunkAt = Date.now()
      switch (chunk.type) {
        case 'text-delta': {
          const size = typeof chunk.text === 'string' ? chunk.text.length : 0
          record.textChars += size
          if (size > 0 && record.firstTextAt === 0) record.firstTextAt = Date.now()
          break
        }
        case 'reasoning-delta': {
          const size = typeof chunk.text === 'string' ? chunk.text.length : 0
          record.reasoningChars += size
          if (size > 0 && record.firstTextAt === 0) record.firstTextAt = Date.now()
          break
        }
        case 'tool-call-delta': {
          record.toolArgChars += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta.length : 0
          const name = str(chunk.name, 60)
          if (name !== null && record.toolNames.length < TOOL_NAME_LIMIT && record.toolNames.indexOf(name) === -1) {
            record.toolNames.push(name)
          }
          break
        }
        case 'usage': {
          const usage = chunk.usage && typeof chunk.usage === 'object' ? chunk.usage : null
          if (usage !== null) {
            record.usage = {
              inputTokens: count(usage.inputTokens),
              outputTokens: count(usage.outputTokens),
              cacheReadTokens: count(usage.cacheReadTokens),
              cacheWriteTokens: count(usage.cacheWriteTokens),
              reasoningTokens: count(usage.reasoningTokens),
            }
          }
          break
        }
        case 'finish': {
          const reason = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason : null
          const failure = reason && reason.failure && typeof reason.failure === 'object' ? reason.failure : null
          record.finish = {
            kind: str(reason && reason.kind, 24) || 'unknown',
            code: str(failure && failure.code, 40),
            status: finite(failure && failure.status),
          }
          break
        }
        default:
          break
      }
    } catch {
      /* 观测失败绝不影响调用 */
    }
  }

  /**
   * 结算一次调用：定状态、并入聚合。幂等（重复调用无副作用）。
   * @param {object} record - 调用记录。
   * @param {unknown} failure - 从迭代里抛出的异常，或 null。
   * @param {boolean} early - 消费者提前放弃（生成器 return）。
   */
  function settle(record, failure, early) {
    try {
      if (record.status !== 'active') return
      const now = Date.now()
      const finishKind = record.finish === null ? null : record.finish.kind
      record.endedAt = now
      if (failure !== null && failure !== undefined) {
        record.status = 'error'
        record.errorMessage = message(failure)
      } else if (finishKind === 'error') {
        record.status = 'error'
        record.errorCode = record.finish.code
        record.errorMessage = '模型调用失败' + (record.finish.code === null ? '' : '：' + String(record.finish.code))
      } else if (finishKind === 'aborted') {
        record.status = 'aborted'
      } else if (early) {
        record.status = 'closed'
      } else {
        record.status = 'ok'
      }
      accumulate(record)
      touch()
    } catch (error) {
      ctx.logger?.warn?.('[model-live] 结算调用失败（已忽略）')
      ctx.logger?.warn?.(error)
    }
  }

  /**
   * 把一条**已结束**的调用并入聚合（每模型桶 + 全局累计）。
   * 实时观测与会话日志两条来源共用这一份口径，保证数字不会因为来源不同而解释不一。
   * @param {object} record - 已定状态的调用记录。
   */
  function accumulate(record) {
    try {
      if (record.endedAt <= 0) return
      const usage = record.usage
      const generationStart = record.firstTextAt || record.firstChunkAt || record.startedAt
      const row = bucket(record.provider, record.model)
      row.calls += 1
      row.active = Math.max(0, row.active - 1)
      row.millis += Math.max(0, record.endedAt - record.startedAt)
      if (record.firstChunkAt > 0) {
        row.ttftSum += record.firstChunkAt - record.startedAt
        row.ttftCount += 1
      }
      if (record.status === 'error') row.failed += 1
      if (record.status === 'aborted') row.aborted += 1
      if (record.source === 'log') row.external += 1
      if (usage !== null) {
        row.inputTokens += usage.inputTokens
        row.outputTokens += usage.outputTokens
        row.cacheReadTokens += usage.cacheReadTokens
        row.cacheWriteTokens += usage.cacheWriteTokens
        row.reasoningTokens += usage.reasoningTokens
        row.generationMillis += Math.max(1, record.endedAt - generationStart)
      }
      row.lastAt = Math.max(row.lastAt, record.endedAt)

      totals.calls += 1
      if (record.status === 'error') totals.failed += 1
      if (record.status === 'aborted') totals.aborted += 1
      if (record.source === 'log') totals.external += 1
      totals.millis += Math.max(0, record.endedAt - record.startedAt)
      if (record.firstChunkAt > 0) {
        totals.ttftSum += record.firstChunkAt - record.startedAt
        totals.ttftCount += 1
      }
      if (usage !== null) {
        totals.inputTokens += usage.inputTokens
        totals.outputTokens += usage.outputTokens
        totals.cacheReadTokens += usage.cacheReadTokens
        totals.cacheWriteTokens += usage.cacheWriteTokens
        totals.reasoningTokens += usage.reasoningTokens
        // 生成窗口（首字→结束）：只用来算平均输出速度，不含排队与首包时间。
        totals.generationMillis += Math.max(1, record.endedAt - generationStart)
      }
      totals.lastAt = Math.max(totals.lastAt, record.endedAt)
      totals.lastModel = record.model
      totals.lastModelName = record.modelName ?? null
      totals.lastProvider = record.provider
      // 「本地」= 跑在用户自己机器上的推理服务（spark-local / ollama…）。
      // 这对面板很关键：云端调用和本地调用混在一张表里时，用户最想知道"这条到底是谁在跑"。
      if (isLocalProvider(record.provider)) totals.local += 1
    } catch (error) {
      ctx.logger?.warn?.('[model-live] 聚合计入失败（已忽略）')
      ctx.logger?.warn?.(error)
    }
  }

  /**
   * 本进程是否已经（或正在）观测到同一次调用 —— 会话日志入库前据此去重。
   * 判据：同一会话 + 同一模型 + 时间锚点落在容差窗内。
   * @param {object} call - 会话日志解析出的调用。
   * @returns {boolean} 命中返回 true（该条日志记录应丢弃）。
   */
  function matchesLive(call) {
    for (const record of records.values()) {
      if (record.source !== 'live') continue
      if (record.sessionId === null || record.sessionId !== call.sessionId) continue
      if (record.model !== call.model) continue
      const anchor = record.status === 'active' ? record.startedAt : record.endedAt
      if (Math.abs(anchor - call.endedAt) <= DEDUPE_WINDOW_MS) return true
    }
    return false
  }

  /** 会话工作区短名（取 cwd 的最后一段）。 */
  function workspaceOf(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return null
    const parts = cwd.split('/').filter((part) => part !== '')
    return str(parts.length === 0 ? cwd : parts[parts.length - 1], 60)
  }

  /**
   * 会话日志入库：把**别的 DSH 进程**（例如 `dsh --profile headless` 的执行者）里
   * 的一次模型调用并入同一份观测结果。
   * @param {object} call - SessionLogTailer 产出的调用。
   */
  function onLogCall(call) {
    try {
      if (call.endedAt <= 0 || typeof call.model !== 'string') return
      if (matchesLive(call)) return
      logSeq += 1
      seq += 1
      const record = {
        id: 'x' + String(logSeq),
        seq,
        source: 'log',
        status: call.status,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        provider: typeof call.provider === 'string' ? call.provider : '(未知)',
        model: call.model,
        sessionId: call.sessionId,
        workspace: workspaceOf(call.cwd),
        preset: call.preset,
        systemChars: 0,
        messages: 0,
        tools: 0,
        reasoningEffort: null,
        maxTokens: null,
        textChars: call.textChars,
        reasoningChars: call.reasoningChars,
        toolArgChars: call.toolArgChars,
        chunks: call.chunks,
        toolNames: Array.isArray(call.toolNames) ? call.toolNames.slice(0, TOOL_NAME_LIMIT) : [],
        usage: call.usage,
        finish: call.finishKind === null || call.finishKind === undefined ? null : { kind: call.finishKind, code: null, status: null },
        errorCode: null,
        errorMessage: call.status === 'error' ? '会话日志显示该次调用以错误结束' : null,
        firstChunkAt: 0,
        firstTextAt: finite(call.firstTextAt) === null ? 0 : call.firstTextAt,
        contextWindowHint: finite(call.contextWindow),
      }
      records.set(record.id, record)
      order.push(record.id)
      while (order.length > MAX_RECORDS) {
        const dropped = order.shift()
        records.delete(dropped)
      }
      resolveFacts(record.provider, record.model)
      accumulate(record)
      touch()
    } catch (error) {
      ctx.logger?.warn?.('[model-live] 会话日志入库失败（已忽略）')
      ctx.logger?.warn?.(error)
    }
  }

  /**
   * 包装一次模型调用：chunk 原样透传，只在两侧计数。
   * @param {object} record - 调用记录。
   * @param {() => AsyncIterable<object>} next - 下游瀑布链。
   * @returns {AsyncGenerator<object>} 供内核消费的同一份分片流。
   */
  async function* watch(record, next) {
    let settled = false
    try {
      for await (const chunk of next()) {
        observe(record, chunk)
        yield chunk
      }
      settled = true
      settle(record, null, false)
    } catch (error) {
      settled = true
      settle(record, error, false)
      throw error
    } finally {
      if (!settled) settle(record, null, true)
    }
  }

  /* ------------------------------- 视图构造 ------------------------------ */

  /**
   * 把一个活记录投影成纯标量视图（可安全 JSON 过桥）。
   * @param {object} record - 调用记录。
   * @param {number} now - 当前时刻。
   * @returns {object} 视图。
   */
  function view(record, now) {
    const active = record.status === 'active'
    const end = active ? now : record.endedAt
    const durationMs = Math.max(0, end - record.startedAt)
    const usage = record.usage
    const outputTokens = usage === null ? null : usage.outputTokens
    const contextTokens = usage === null
      ? null
      : usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    const info = facts.get(modelKey(record.provider, record.model))
    // 会话日志来源带了自己那次请求的 contextWindow，模型元数据还没解析出来时先用它。
    const contextWindow = info === undefined || info.contextWindow === null
      ? (record.contextWindowHint === undefined ? null : record.contextWindowHint)
      : info.contextWindow
    // 生成窗口：首字（或首包）到结束；进行中就用「现在」。
    const generationStart = record.firstTextAt || record.firstChunkAt || record.startedAt
    const generationMs = Math.max(1, end - generationStart)
    // 速率：有 usage 就用真值；否则按字符数估算（保守按 2.5 字符/token 折算）并标记 estimated。
    let tps = null
    let tpsEstimated = false
    if (outputTokens !== null && outputTokens > 0 && generationMs > 500) {
      tps = outputTokens / (generationMs / 1000)
    } else {
      const estimated = (record.textChars + record.reasoningChars) / 2.5
      if (estimated >= 8 && generationMs > 500) {
        tps = estimated / (generationMs / 1000)
        tpsEstimated = true
      }
    }
    return {
      id: record.id,
      seq: record.seq,
      source: record.source === undefined ? 'live' : record.source,
      workspace: record.workspace === undefined ? null : record.workspace,
      preset: record.preset === undefined ? null : record.preset,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt === 0 ? null : record.endedAt,
      durationMs,
      provider: record.provider,
      model: record.model,
      modelName: info === undefined ? null : info.name,
      /** 是否跑在本地推理服务上（本地/云端徽标用）。 */
      local: isLocalProvider(record.provider),
      contextWindow,
      sessionId: record.sessionId,
      messages: record.messages,
      tools: record.tools,
      systemChars: record.systemChars,
      reasoningEffort: record.reasoningEffort,
      maxTokens: record.maxTokens,
      textChars: record.textChars,
      reasoningChars: record.reasoningChars,
      toolArgChars: record.toolArgChars,
      chunks: record.chunks,
      toolNames: record.toolNames,
      inputTokens: usage === null ? null : usage.inputTokens,
      outputTokens,
      cacheReadTokens: usage === null ? null : usage.cacheReadTokens,
      cacheWriteTokens: usage === null ? null : usage.cacheWriteTokens,
      reasoningTokens: usage === null ? null : usage.reasoningTokens,
      contextTokens,
      contextPercent: contextWindow === null || contextTokens === null
        ? null
        : Math.round((contextTokens / contextWindow) * 1000) / 10,
      ttftMs: record.firstChunkAt === 0 ? null : record.firstChunkAt - record.startedAt,
      firstTextMs: record.firstTextAt === 0 ? null : record.firstTextAt - record.startedAt,
      tps: tps === null ? null : Math.round(tps * 10) / 10,
      tpsEstimated,
      finishKind: record.finish === null ? null : record.finish.kind,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
    }
  }

  /**
   * 所有进行中的调用视图（先到先显示）。
   * @returns {object[]} 视图数组。
   */
  function activeViews() {
    const now = Date.now()
    const list = []
    for (const id of order) {
      const record = records.get(id)
      if (record === undefined || record.status !== 'active') continue
      list.push(view(record, now))
    }
    return list
  }

  /**
   * 最近结束的调用视图（新→旧）。
   * @param {number} limit - 条数上限。
   * @returns {object[]} 视图数组。
   */
  function recentViews(limit) {
    const now = Date.now()
    const finished = []
    for (const id of order) {
      const record = records.get(id)
      if (record === undefined || record.status === 'active') continue
      finished.push(record)
    }
    // 按结束时间倒序：会话日志会一次性回填一批历史，插入顺序并不等于时间顺序。
    finished.sort((a, b) => b.endedAt - a.endedAt)
    return finished.slice(0, limit).map((record) => view(record, now))
  }

  /**
   * 模型维度的汇总行：元数据（上下文/模态/推理档）+ 实测统计（次数/速度/缓存命中）。
   * @returns {object[]} 按调用次数降序的模型行。
   */
  function modelRows() {
    const keys = new Set()
    for (const key of stats.keys()) keys.add(key)
    for (const key of facts.keys()) keys.add(key)
    const rows = []
    for (const key of keys) {
      const row = stats.get(key)
      const info = facts.get(key)
      const provider = row === undefined ? (info === undefined ? '' : info.provider) : row.provider
      const model = row === undefined ? (info === undefined ? '' : info.model) : row.model
      const outputTokens = row === undefined ? 0 : row.outputTokens
      const generationMillis = row === undefined ? 0 : row.generationMillis
      const billedInput = row === undefined ? 0 : row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens
      rows.push({
        provider,
        model,
        local: isLocalProvider(provider),
        name: info === undefined ? null : info.name,
        description: info === undefined ? null : info.description,
        contextWindow: info === undefined ? null : info.contextWindow,
        maxTokens: info === undefined ? null : info.maxTokens,
        modalities: info === undefined ? null : info.modalities,
        efforts: info === undefined ? null : info.efforts,
        defaultEffort: info === undefined ? null : info.defaultEffort,
        factsError: info === undefined ? null : info.error,
        calls: row === undefined ? 0 : row.calls,
        active: row === undefined ? 0 : row.active,
        failed: row === undefined ? 0 : row.failed,
        aborted: row === undefined ? 0 : row.aborted,
        external: row === undefined ? 0 : row.external,
        inputTokens: row === undefined ? 0 : row.inputTokens,
        outputTokens,
        cacheReadTokens: row === undefined ? 0 : row.cacheReadTokens,
        cacheWriteTokens: row === undefined ? 0 : row.cacheWriteTokens,
        reasoningTokens: row === undefined ? 0 : row.reasoningTokens,
        cacheHitPercent: billedInput === 0 ? null : Math.round((row.cacheReadTokens / billedInput) * 1000) / 10,
        avgMs: row === undefined || row.calls === 0 ? null : Math.round(row.millis / row.calls),
        avgTtftMs: row === undefined || row.ttftCount === 0 ? null : Math.round(row.ttftSum / row.ttftCount),
        // 生成窗口不足 200ms 时样本太小，速率没有意义（例如缓存全命中的极短回复）。
        avgTps: generationMillis < 200 ? null : Math.round((outputTokens / (generationMillis / 1000)) * 10) / 10,
        lastAt: row === undefined || row.lastAt === 0 ? null : row.lastAt,
      })
    }
    rows.sort((a, b) => (b.calls - a.calls) || String(a.model).localeCompare(String(b.model)))
    return rows
  }

  /**
   * 提供方清单（来自 llm 服务的路由注册表）。
   * @returns {object[]} [{id, name}]。
   */
  function providerRows() {
    const service = llm()
    if (service === undefined || typeof service.listProviders !== 'function') return []
    try {
      return service.listProviders().map((row) => ({ id: str(row && row.id, 80), name: str(row && row.name, 120) }))
    } catch {
      return []
    }
  }

  /**
   * 运行时日志的**快照投影**：状态齐全、行数受限，避免把整个日志塞进每次推送。
   * @returns {object|null} 精简视图。
   */
  function runtimeSnapshotView() {
    if (runtimeTailer === null) return null
    const full = runtimeTailer.view(RUNTIME_LINES)
    return {
      ...full,
      sources: full.sources.map((source) => ({
        id: source.id,
        label: source.label,
        path: source.path,
        host: source.host,
        size: source.size,
        count: source.count,
        lastAt: source.lastAt,
        error: source.error,
        lines: [],
      })),
    }
  }

  /**
   * 构造给浏览器的完整快照。全部字段都是叶子标量。
   * @returns {object} 快照。
   */
  function snapshot() {
    const now = Date.now()
    const active = activeViews()
    const billedInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    let activeCalls = 0
    for (const row of stats.values()) activeCalls += row.active
    return {
      ok: true,
      revision,
      now,
      startedAt,
      uptimeMs: now - startedAt,
      bufferLimit: MAX_RECORDS,
      active,
      recent: recentViews(RECENT_LIMIT),
      models: modelRows(),
      providers: providerRows(),
      totals: {
        calls: totals.calls,
        failed: totals.failed,
        aborted: totals.aborted,
        active: activeCalls,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        reasoningTokens: totals.reasoningTokens,
        totalTokens: billedInput + totals.outputTokens,
        cacheHitPercent: billedInput === 0 ? null : Math.round((totals.cacheReadTokens / billedInput) * 1000) / 10,
        avgMs: totals.calls === 0 ? null : Math.round(totals.millis / totals.calls),
        avgTtftMs: totals.ttftCount === 0 ? null : Math.round(totals.ttftSum / totals.ttftCount),
        avgTps: totals.outputTokens === 0 || totals.generationMillis < 200
          ? null
          : Math.round((totals.outputTokens / (totals.generationMillis / 1000)) * 10) / 10,
        lastAt: totals.lastAt === 0 ? null : totals.lastAt,
        lastModel: totals.lastModel,
        lastModelName: totals.lastModelName,
        lastProvider: totals.lastProvider,
        external: totals.external,
        live: totals.calls - totals.external,
        /** 本地推理服务上的调用条数（与 external 正交：本地调用也可能来自别的 DSH 进程）。 */
        local: totals.local,
        localPercent: totals.calls === 0 ? null : Math.round((totals.local / totals.calls) * 1000) / 10,
      },
      /**
       * 模型运行时日志（第三观测源）。快照里只带**状态 + 合并视图的少量行**；
       * 每源明细由 `POST /_dsh/model-live/runtime` 按需取（面板切到某来源时才请求）。
       */
      runtime: runtimeTailer === null ? null : runtimeSnapshotView(),
      /** 会话日志扫描器（第二观测源）的自述：界面据此说明"本地调用为什么也在这里"。 */
      scanner: {
        running: tailer !== null && tailer.timer !== null,
        root: scannerRoot,
        backfillMs: SCAN_BACKFILL_MS,
        windowStart: tailer === null ? null : tailer.windowStart,
        stats: tailer === null ? null : { ...tailer.stats },
      },
    }
  }

  /* ------------------------------- SSE 推送 ------------------------------ */

  /**
   * 写一个 SSE 事件。写入失败只摘掉该连接。
   * @param {import('node:http').ServerResponse} res - 响应对象。
   * @param {string} event - 事件名。
   * @param {string} payload - 已序列化的 JSON 文本。
   */
  function send(res, event, payload) {
    try {
      res.write('event: ' + event + '\ndata: ' + payload + '\n\n')
    } catch {
      clients.delete(res)
    }
  }

  /** 推一份完整快照（结构变化）。 */
  function pushSnapshot() {
    if (clients.size === 0) return
    let payload
    try {
      payload = JSON.stringify(snapshot())
    } catch {
      return
    }
    for (const res of [...clients]) send(res, 'snapshot', payload)
  }

  /** 推一次进行中调用的增量（时间/计数会动，结构不会）。 */
  function pushTick() {
    if (clients.size === 0) return
    let payload
    try {
      payload = JSON.stringify({ revision, now: Date.now(), active: activeViews() })
    } catch {
      return
    }
    for (const res of [...clients]) send(res, 'tick', payload)
  }

  /** 标记结构变化：revision 自增 + 合并窗口内推一次快照。 */
  function touch() {
    revision += 1
    if (clients.size === 0 || pendingFlush !== null) return
    pendingFlush = setTimeout(() => {
      pendingFlush = null
      pushSnapshot()
    }, FLUSH_MS)
    if (typeof pendingFlush.unref === 'function') pendingFlush.unref()
  }

  /** 起停推送节拍器：有连接才跑，没连接立刻停。 */
  function ensureTimer() {
    if (clients.size > 0 && timer === null) {
      sincePing = 0
      timer = setInterval(() => {
        sincePing += TICK_MS
        if (sincePing >= PING_MS) {
          sincePing = 0
          for (const res of [...clients]) send(res, 'ping', String(Date.now()))
        }
        // 只有真的在进行中的调用才刷 tick，空闲时零流量。
        let active = 0
        for (const row of stats.values()) active += row.active
        if (active > 0) pushTick()
      }, TICK_MS)
      if (typeof timer.unref === 'function') timer.unref()
    } else if (clients.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /* ------------------------ 第二观测源：会话日志 ------------------------ */

  /**
   * 会话日志根目录。DSH 把每个进程（含 `dsh --profile headless` 的执行者）的
   * 会话都写在同一个 `$DSH_HOME/sessions` 下，因此这里能看见别的进程里的本地模型调用。
   */
  const scannerRoot = (() => {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : null
    return home === null ? null : home + '/sessions'
  })()

  /** 会话日志扫描器；拿不到 DSH_HOME 时为 null（只保留本进程观测）。 */
  const tailer = scannerRoot === null
    ? null
    : new SessionLogTailer({
      root: scannerRoot,
      backfillMs: SCAN_BACKFILL_MS,
      tickMs: SCAN_TICK_MS,
      maxFilesPerTick: SCAN_FILES_PER_TICK,
      onCall: onLogCall,
      warn: (text, error) => {
        ctx.logger?.warn?.(text)
        if (error !== undefined) ctx.logger?.warn?.(error)
      },
    })
  if (tailer !== null) {
    try {
      tailer.start()
      ctx.logger?.info?.('[model-live] 会话日志观测已启动：' + scannerRoot)
    } catch (error) {
      ctx.logger?.warn?.('[model-live] 会话日志观测启动失败（仅保留本进程观测）')
      ctx.logger?.warn?.(error)
    }
  }

  /* --------------------- 第三观测源：模型运行时日志 --------------------- */

  /**
   * 运行时日志客户端（读独立服务）；用 DSH_MODEL_LIVE_RUNTIME=0 可关闭。
   * 采集在服务里做，这里只是读取 —— 服务不可达时如实标注，不影响另外两个源。
   */
  const runtimeTailer = process.env.DSH_MODEL_LIVE_RUNTIME === '0'
    ? null
    : new RuntimeLogClient({
      url: RUNTIME_URL,
      pollMs: RUNTIME_POLL_MS,
      // 读到新内容（或服务状态变化）就推一次快照，界面上的日志才是"活的"。
      onUpdate: () => touch(),
      warn: (text, error) => {
        ctx.logger?.warn?.(text)
        if (error !== undefined) ctx.logger?.warn?.(error)
      },
    })
  if (runtimeTailer !== null) {
    try {
      runtimeTailer.start()
      ctx.logger?.info?.('[model-live] 运行时日志源：读取独立服务 ' + RUNTIME_URL)
    } catch (error) {
      ctx.logger?.warn?.('[model-live] 运行时日志客户端启动失败（仅保留调用观测）')
      ctx.logger?.warn?.(error)
    }
  }

  /* ------------------------------- 观测挂钩 ------------------------------ */

  // 挂在瀑布链上：只包装、不改写，任何异常都原样抛回内核。
  ctx.on('llm/stream', (options, next) => {
    const record = begin(options)
    if (record === null) return next()
    return watch(record, next)
  }, { global: true })

  /* -------------------------------- 路由 -------------------------------- */

  /**
   * 读取 POST 请求体（JSON，缺省为空对象）。
   * @param {import('node:http').IncomingMessage} req - 请求对象。
   * @returns {Promise<object>} 解析后的对象。
   */
  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * 回一份 JSON。
   * @param {import('node:http').ServerResponse} res - 响应对象。
   * @param {number} status - HTTP 状态码。
   * @param {object} body - 响应体。
   */
  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  /**
   * 拉取某个提供方的模型清单（带 60 秒缓存；失败也缓存，避免反复打端点）。
   * @param {string} provider - 提供方路由。
   * @returns {Promise<object>} { provider, at, models, error, cached }。
   */
  async function providerCatalog(provider) {
    const cached = catalog.get(provider)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      return { provider: cached.provider, at: cached.at, models: cached.models, error: cached.error, cached: true }
    }
    const service = llm()
    if (service === undefined || typeof service.listModels !== 'function') {
      return { provider, at: Date.now(), models: [], error: 'llm 服务不可用', cached: false }
    }
    let models = []
    let error = null
    try {
      const listed = await service.listModels(provider)
      models = (Array.isArray(listed) ? listed : []).slice(0, 200).map((row) => ({
        id: str(row && row.id, 120),
        name: str(row && row.name, 120),
        description: str(row && row.description, 200),
        modalities: Array.isArray(row && row.inputModalities)
          ? row.inputModalities.map((m) => str(m, 16)).filter((m) => m !== null)
          : null,
      }))
    } catch (failure) {
      error = message(failure)
    }
    const entry = { provider, at: Date.now(), models, error, cached: false }
    catalog.set(provider, entry)
    return entry
  }

  // 静态插件没有 harness 全局：Host↔Client 走 webServer HTTP 路由。
  // ctx.inject 保证 webServer 就绪后再注册（apply 时它可能还没挂载）。
  ctx.inject(['webServer'], (wsCtx) => {
    wsCtx.effect(() => wsCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://dsh.internal')
        const method = url.pathname.replace(/^\/_dsh\/model-live\/?/, '').split('/')[0] || ''
        try {
          if (method === 'events') {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
            res.write('retry: 3000\n\n')
            clients.add(res)
            ensureTimer()
            send(res, 'snapshot', JSON.stringify(snapshot()))
            req.on('close', () => {
              clients.delete(res)
              ensureTimer()
            })
            req.on('error', () => {
              clients.delete(res)
              ensureTimer()
            })
            return
          }
          if (method === 'state') {
            await readBody(req)
            return sendJson(res, 200, { ok: true, data: snapshot() })
          }
          if (method === 'runtime') {
            // 按需取运行时日志的**每源明细**：面板切到某个来源时才请求，
            // 免得把整段日志塞进每次快照推送。
            await readBody(req)
            if (runtimeTailer === null) return sendJson(res, 200, { ok: true, data: null })
            const full = runtimeTailer.view(RUNTIME_SOURCE_LINES)
            return sendJson(res, 200, {
              ok: true,
              data: {
                label: full.label,
                url: full.url,
                running: full.running,
                polls: full.polls,
                failures: full.failures,
                bytes: full.bytes,
                lastAt: full.lastAt,
                lastError: full.lastError,
                perf: full.perf,
                sources: full.sources.map((source) => ({
                  id: source.id,
                  label: source.label,
                  path: source.path,
                  host: source.host,
                  size: source.size,
                  count: source.count,
                  lastAt: source.lastAt,
                  error: source.error,
                  lines: source.lines,
                })),
              },
            })
          }
          if (method === 'catalog') {
            const payload = await readBody(req)
            const providers = providerRows()
            const wanted = str(payload.provider, 80)
            const targets = wanted === null
              ? providers.map((row) => row.id).filter((id) => id !== null)
              : [wanted]
            const entries = []
            for (const provider of targets) entries.push(await providerCatalog(provider))
            return sendJson(res, 200, { ok: true, data: { providers, entries, ttlMs: CATALOG_TTL_MS } })
          }
          if (method === 'clear') {
            await readBody(req)
            records.clear()
            order.length = 0
            stats.clear()
            totals.calls = 0
            totals.failed = 0
            totals.aborted = 0
            totals.inputTokens = 0
            totals.outputTokens = 0
            totals.cacheReadTokens = 0
            totals.cacheWriteTokens = 0
            totals.reasoningTokens = 0
            totals.millis = 0
            totals.generationMillis = 0
            totals.ttftSum = 0
            totals.ttftCount = 0
            totals.lastAt = 0
            totals.lastModel = null
            touch()
            return sendJson(res, 200, { ok: true, data: snapshot() })
          }
          return sendJson(res, 404, { ok: false, error: { message: '未知方法: ' + method } })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: { message: message(error) } })
        }
      },
    }))
  })

  // 插件卸载：停掉会话日志扫描、断开所有 SSE 连接并停表。
  ctx.effect(() => () => {
    if (tailer !== null) tailer.stop()
    if (runtimeTailer !== null) runtimeTailer.stop()
    for (const res of [...clients]) {
      try {
        res.end()
      } catch {
        /* 连接可能已经没了 */
      }
    }
    clients.clear()
    ensureTimer()
    if (pendingFlush !== null) {
      clearTimeout(pendingFlush)
      pendingFlush = null
    }
  })
}
