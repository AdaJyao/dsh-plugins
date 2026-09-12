/**
 * dsh-model-live — 会话日志扫描器（跨进程观测）
 *
 * 为什么需要它：插件宿主半边挂在 `llm/stream` 瀑布上，只能看见**本进程**的模型调用。
 * 本部署里本地模型（ollama）的调用大量发生在**别的 DSH 进程**里 —— 例如
 * `dsh --profile headless` 拉起的执行者会话（监督者/执行者体系），它们和 web 进程
 * 共用同一个 `$DSH_HOME`，因此把调用写进同一批会话日志。于是：只订阅瀑布 =
 * 只看得到云端调用，看不到本地调用。
 *
 * 本模块把`$DSH_HOME/sessions/<workspace>/<session>/session.jsonl.zstd` 当作
 * 第二观测源，增量 Tail 出「每一次模型调用」：
 *   request/context     → 该会话当前 provider / model / contextWindow
 *   assistant/chunk     → 一次调用的分片（含 usage / finish）
 *   text-chunks 等打包行 → 同一批分片的紧凑存法（见 dsh-session 的 chunk-rows）
 *   assistant/message   → 一次调用结束（带 usage 与 interrupted）
 * 由 (turn, step) 归组，得到与实时观测同构的一张调用记录。
 *
 * 三条硬约束：
 * 1. 只读：只读文件、不写、不改、不删；最多记录少量标量。
 * 2. 绝不阻塞宿主：每 tick 每个文件至多读 maxBytesPerTick 字节；解码用同步 API
 *    但只在已经读到的小块上跑；任何异常都只放弃该文件并记一行日志。
 * 3. 增量：每次只读 offset 之后的新字节，永不重扫全文；文件被截断则重置。
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

/** Zstandard 帧魔数（小端 0x28 0xB5 0x2F 0xFD）。 */
const ZSTD_MAGIC = 4247762216
/** 一次调用最多记的工具名个数。 */
const TOOL_NAME_LIMIT = 12
/** 每个文件每 tick 最多读取的压缩字节。 */
const MAX_BYTES_PER_TICK = 512 * 1024
/** 单行超过这个长度直接跳过（request/header 会带整份 system + 工具表）。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024

/**
 * 扫出完整 zstd 帧的 [start, end) 区间。算法与 dsh-session-persistence-jsonl
 * 的 scanZstdFrames 同构：只走帧头与块头结构，不解压。
 *
 * @param {Buffer} buffer - 当前累计的原始字节。
 * @returns {{frames: {start: number, end: number}[], tornStart?: number, corrupt?: boolean}}
 *   完整帧区间、可能被截断的尾帧起点，或结构损坏标记。
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, corrupt: true }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, corrupt: true }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, corrupt: true }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 取叶子字符串并限长。 */
function str(value, max) {
  if (typeof value !== 'string') return null
  return value.length > max ? value.slice(0, max) : value
}

/** 取有限数值。 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 把日志里的 usage 归一成与实时观测一致的形状。 */
function usageOf(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const pick = (key) => {
    const value = finite(raw[key])
    return value === null || value < 0 ? 0 : value
  }
  const usage = {
    inputTokens: pick('inputTokens'),
    outputTokens: pick('outputTokens'),
    cacheReadTokens: pick('cacheReadTokens'),
    cacheWriteTokens: pick('cacheWriteTokens'),
    reasoningTokens: pick('reasoningTokens'),
  }
  if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) return null
  return usage
}

/** 会话日志扫描器。 */
export class SessionLogTailer {
  /**
   * @param {object} options - 配置。
   * @param {string} options.root - 会话日志根目录（`$DSH_HOME/sessions`）。
   * @param {(call: object) => void} options.onCall - 每解析出一次**已结束**的调用回调一次。
   * @param {(message: string, error?: unknown) => void} [options.warn] - 诊断回调。
   * @param {number} [options.backfillMs] - 首次扫描只回填这个时间窗内的调用。
   * @param {number} [options.tickMs] - 扫描节奏。
   * @param {number} [options.maxFilesPerTick] - 每 tick 最多推进几个文件。
   */
  constructor(options) {
    this.root = options.root
    this.onCall = options.onCall
    this.warn = options.warn === undefined ? () => {} : options.warn
    this.backfillMs = finite(options.backfillMs) === null ? 6 * 3600 * 1000 : options.backfillMs
    this.tickMs = finite(options.tickMs) === null ? 2000 : options.tickMs
    this.maxFilesPerTick = finite(options.maxFilesPerTick) === null ? 3 : options.maxFilesPerTick
    this.files = new Map()
    this.timer = null
    this.windowStart = 0
    this.busy = false
    /** 诊断计数，挂到快照里给界面看。 */
    this.stats = { files: 0, skipped: 0, bytes: 0, frames: 0, calls: 0, filtered: 0, errors: 0, corrupted: 0 }
  }

  /** 开始扫描（幂等）。 */
  start() {
    if (this.timer !== null) return
    this.windowStart = Date.now() - this.backfillMs
    this.tick()
    this.timer = setInterval(() => this.tick(), this.tickMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 停止扫描（幂等）。 */
  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 列出所有会话日志文件，按修改时间新→旧。
   *
   * 目录结构是**两层**：`sessions/<工作区编码>/<会话 id>/session.jsonl.zstd`
   * （工作区那层只是分组，日志在会话 id 那层下面）。压缩关闭时是 `session.jsonl` 明文。
   */
  list() {
    const entries = []
    let workspaces
    try {
      workspaces = readdirSync(this.root, { withFileTypes: true })
    } catch (error) {
      this.warn('[model-live] 无法读取会话目录：' + String(error && error.message ? error.message : error))
      return entries
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const workspaceDir = join(this.root, workspace.name)
      let sessions
      try {
        sessions = readdirSync(workspaceDir, { withFileTypes: true })
      } catch (error) {
        continue
      }
      for (const session of sessions) {
        // 兼容「会话目录直接在工作区目录下」的老布局与两层布局。
        const candidates = session.isDirectory()
          ? [join(workspaceDir, session.name, 'session.jsonl.zstd'), join(workspaceDir, session.name, 'session.jsonl')]
          : [join(workspaceDir, session.name)]
        for (const path of candidates) {
          if (!path.endsWith('.jsonl.zstd') && !path.endsWith('.jsonl')) continue
          try {
            const stat = statSync(path)
            if (!stat.isFile()) continue
            entries.push({ path, size: stat.size, mtimeMs: stat.mtimeMs, plain: path.endsWith('.jsonl') })
            break
          } catch (error) {
            /* 这个候选不存在：试下一个 */
          }
        }
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries
  }

  /** 取（或建）一个文件的状态。 */
  stateFor(entry) {
    let state = this.files.get(entry.path)
    if (state === undefined) {
      state = {
        path: entry.path,
        offset: 0,
        pending: Buffer.alloc(0),
        carry: '',
        session: { id: null, cwd: null, preset: null },
        provider: null,
        model: null,
        contextWindow: null,
        builders: new Map(),
        skip: false,
        done: false,
      }
      this.files.set(entry.path, state)
      this.stats.files += 1
    }
    return state
  }

  /** 一次扫描：推进有限个文件、有限字节，绝不长时间占用事件循环。 */
  tick() {
    if (this.busy) return
    this.busy = true
    try {
      let budget = this.maxFilesPerTick
      for (const entry of this.list()) {
        if (budget <= 0) break
        const state = this.stateFor(entry)
        if (state.skip) continue
        // 窗口外的历史文件：整体跳过（连解压都不做）。
        if (state.offset === 0 && entry.mtimeMs < this.windowStart) {
          state.skip = true
          this.stats.skipped += 1
          continue
        }
        if (entry.size === state.offset) continue
        if (entry.size < state.offset) {
          // 文件被重写/截断：重置该文件的增量状态。
          state.offset = 0
          state.pending = Buffer.alloc(0)
          state.carry = ''
          state.builders.clear()
        }
        this.consume(state, entry)
        budget -= 1
      }
    } catch (error) {
      this.stats.errors += 1
      this.warn('[model-live] 会话日志扫描异常（已忽略）')
      this.warn(error)
    } finally {
      this.busy = false
    }
  }

  /** 读取并解出该文件新增的完整帧。 */
  consume(state, entry) {
    const length = Math.min(MAX_BYTES_PER_TICK, entry.size - state.offset)
    if (length <= 0) return
    const chunk = Buffer.allocUnsafe(length)
    let fd
    try {
      fd = openSync(state.path, 'r')
      readSync(fd, chunk, 0, length, state.offset)
    } catch (error) {
      state.skip = true
      this.stats.errors += 1
      this.warn('[model-live] 读取会话日志失败：' + String(error && error.message ? error.message : error))
      return
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    state.offset += length
    this.stats.bytes += length

    // 压缩关闭的部署：新字节本身就是明文，直接按行解析。
    if (entry.plain === true) {
      this.stats.frames += 1
      this.ingest(state, chunk.toString('utf8'))
      return
    }

    state.pending = state.pending.length === 0 ? chunk : Buffer.concat([state.pending, chunk])

    const scanned = scanFrames(state.pending)
    if (scanned.corrupt === true) {
      state.skip = true
      this.stats.corrupted += 1
      this.warn('[model-live] 会话日志帧结构损坏，已跳过：' + state.path)
      return
    }
    let consumed = 0
    for (const frame of scanned.frames) {
      let text
      try {
        text = zstdDecompressSync(state.pending.subarray(frame.start, frame.end)).toString('utf8')
      } catch (error) {
        state.skip = true
        this.stats.corrupted += 1
        this.warn('[model-live] 解压会话日志帧失败，已跳过：' + state.path)
        return
      }
      consumed = frame.end
      this.stats.frames += 1
      this.ingest(state, text)
    }
    const keepFrom = scanned.tornStart === undefined ? consumed : Math.min(consumed, scanned.tornStart)
    state.pending = state.pending.subarray(keepFrom)
  }

  /** 把一段解压后的文本按行喂给解析器。 */
  ingest(state, text) {
    state.carry += text
    let index = state.carry.indexOf('\n')
    while (index !== -1) {
      const line = state.carry.slice(0, index)
      state.carry = state.carry.slice(index + 1)
      if (line.length > 0 && line.length <= MAX_LINE_BYTES) this.line(state, line)
      index = state.carry.indexOf('\n')
    }
    if (state.carry.length > MAX_LINE_BYTES) state.carry = ''
  }

  /** 处理一行日志。先做廉价子串预筛，避免为无关行做 JSON.parse。 */
  line(state, line) {
    if (line.charCodeAt(0) !== 123) return
    try {
      if (line.includes('"request/context"')) return this.onContext(state, line)
      if (line.includes('"assistant/chunk"')) return this.onChunk(state, line)
      if (line.includes('"assistant/message"')) return this.onMessage(state, line)
      if (line.includes('"text-chunks"') || line.includes('"reasoning-chunks"') || line.includes('"tool-call-chunks"')) {
        return this.onPacked(state, line)
      }
      if (line.includes('"type":"session"')) return this.onHeader(state, line)
    } catch (error) {
      this.stats.errors += 1
    }
  }

  /** 会话头：记住 id / cwd / preset。 */
  onHeader(state, line) {
    const event = JSON.parse(line)
    state.session.id = str(event.id, 80)
    state.session.cwd = str(event.cwd, 300)
    state.session.preset = str(event.agentPreset, 40)
  }

  /** request/context：该会话当前使用的 provider / model / 上下文窗口。 */
  onContext(state, line) {
    const event = JSON.parse(line)
    const data = event.data === undefined ? {} : event.data
    state.provider = str(data.provider, 80)
    state.model = str(data.model, 120)
    state.contextWindow = finite(data.contextWindow)
  }

  /** 取（或建）一次调用的累加器。 */
  builder(state, turn, step) {
    const key = String(turn) + ':' + String(step)
    let builder = state.builders.get(key)
    if (builder === undefined) {
      builder = {
        turn,
        step,
        startedAt: 0,
        firstTextAt: 0,
        endedAt: 0,
        chunks: 0,
        textChars: 0,
        reasoningChars: 0,
        toolArgChars: 0,
        toolNames: [],
        usage: null,
        finishKind: null,
        provider: state.provider,
        model: state.model,
        contextWindow: state.contextWindow,
      }
      state.builders.set(key, builder)
    }
    return builder
  }

  /** assistant/chunk：单条分片。 */
  onChunk(state, line) {
    const event = JSON.parse(line)
    const data = event.data === undefined ? {} : event.data
    const time = finite(event.time)
    const builder = this.builder(state, data.turn, data.step)
    if (builder.startedAt === 0 && time !== null) builder.startedAt = time
    if (time !== null) builder.endedAt = time
    builder.chunks += 1
    const chunk = data.chunk === undefined ? {} : data.chunk
    this.applyChunk(builder, chunk, time)
  }

  /** 打包行：一次运行的多个 delta 合存成一行。 */
  onPacked(state, line) {
    const row = JSON.parse(line)
    const data = row.data === undefined ? {} : row.data
    const builder = this.builder(state, data.turn, data.step)
    const time0 = finite(row.time0)
    const gaps = Array.isArray(data.dt) ? data.dt : []
    const members = row.type === 'tool-call-chunks' ? (Array.isArray(data.args) ? data.args : []) : (Array.isArray(data.texts) ? data.texts : [])
    let time = time0 === null ? 0 : time0
    for (let index = 0; index < members.length; index += 1) {
      if (index > 0) time += finite(gaps[index - 1]) === null ? 0 : gaps[index - 1]
      if (builder.startedAt === 0) builder.startedAt = time
      builder.endedAt = time
      builder.chunks += 1
      const size = typeof members[index] === 'string' ? members[index].length : 0
      if (row.type === 'text-chunks') {
        builder.textChars += size
        if (size > 0 && builder.firstTextAt === 0) builder.firstTextAt = time
      } else if (row.type === 'reasoning-chunks') {
        builder.reasoningChars += size
        if (size > 0 && builder.firstTextAt === 0) builder.firstTextAt = time
      } else {
        builder.toolArgChars += size
        const name = str(data.name, 60)
        if (name !== null && builder.toolNames.length < TOOL_NAME_LIMIT && builder.toolNames.indexOf(name) === -1) {
          builder.toolNames.push(name)
        }
      }
    }
  }

  /** 把一条分片累加进 builder。 */
  applyChunk(builder, chunk, time) {
    switch (chunk.type) {
      case 'text-delta': {
        const size = typeof chunk.text === 'string' ? chunk.text.length : 0
        builder.textChars += size
        if (size > 0 && builder.firstTextAt === 0 && time !== null) builder.firstTextAt = time
        break
      }
      case 'reasoning-delta': {
        const size = typeof chunk.text === 'string' ? chunk.text.length : 0
        builder.reasoningChars += size
        if (size > 0 && builder.firstTextAt === 0 && time !== null) builder.firstTextAt = time
        break
      }
      case 'tool-call-delta': {
        builder.toolArgChars += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta.length : 0
        const name = str(chunk.name, 60)
        if (name !== null && builder.toolNames.length < TOOL_NAME_LIMIT && builder.toolNames.indexOf(name) === -1) {
          builder.toolNames.push(name)
        }
        break
      }
      case 'block-end': {
        const block = chunk.block === undefined ? {} : chunk.block
        if (block.type === 'tool-call') {
          const name = str(block.name, 60)
          if (name !== null && builder.toolNames.length < TOOL_NAME_LIMIT && builder.toolNames.indexOf(name) === -1) {
            builder.toolNames.push(name)
          }
        }
        break
      }
      case 'usage': {
        builder.usage = usageOf(chunk.usage) ?? builder.usage
        break
      }
      case 'finish': {
        const reason = chunk.reason === undefined ? {} : chunk.reason
        builder.finishKind = str(reason.kind, 24)
        break
      }
      default:
        break
    }
  }

  /** assistant/message：一次调用结束，产出记录。 */
  onMessage(state, line) {
    const event = JSON.parse(line)
    const data = event.data === undefined ? {} : event.data
    const key = String(data.turn) + ':' + String(data.step)
    const builder = state.builders.get(key)
    if (builder === undefined) return
    state.builders.delete(key)
    const endedAt = finite(event.time) ?? builder.endedAt
    if (builder.startedAt === 0) builder.startedAt = endedAt
    const message = data.message === undefined ? {} : data.message
    const source = message.source === undefined ? {} : message.source
    const usage = usageOf(data.usage) ?? builder.usage
    const interrupted = data.interrupted === true
    const failure = data.failure === undefined ? null : data.failure
    const status = interrupted ? 'aborted' : builder.finishKind === 'error' || failure !== null ? 'error' : 'ok'
    // 只回填窗口内的调用：更早的历史没有必要进内存。
    if (endedAt < this.windowStart) {
      this.stats.filtered += 1
      return
    }
    this.stats.calls += 1
    this.onCall({
      source: 'log',
      sessionId: state.session.id,
      cwd: state.session.cwd,
      preset: state.session.preset,
      turn: builder.turn,
      step: builder.step,
      provider: str(source.provider, 80) ?? builder.provider,
      model: str(source.model, 120) ?? builder.model,
      contextWindow: builder.contextWindow,
      startedAt: builder.startedAt,
      firstTextAt: builder.firstTextAt,
      endedAt,
      chunks: builder.chunks,
      textChars: builder.textChars,
      reasoningChars: builder.reasoningChars,
      toolArgChars: builder.toolArgChars,
      toolNames: builder.toolNames,
      usage,
      finishKind: builder.finishKind,
      status,
    })
  }
}
