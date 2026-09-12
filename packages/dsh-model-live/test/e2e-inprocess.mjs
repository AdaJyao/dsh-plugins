/**
 * dsh-model-live — 宿主半边 + 浏览器半边的进程内端到端测试
 *
 * 不依赖浏览器，也不依赖 DSH 运行时：把真插件的两份代码同时装进一个 Node 进程，
 * 用假的 ctx / webServer / llm / EventSource / fetch / React 把它们接起来：
 *
 *   假模型流 → Host llm/stream 观测 → SSE/HTTP 路由 → 假 EventSource → Client 数据源
 *            → 组件渲染 → 断言渲染出来的文本
 *
 * 覆盖：SSE 事件解析、快照与 tick 合并、轮询兜底、设置页与挂件的渲染路径。
 */
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import { apply as applyHost } from '../lib/index.js'

/* ------------------- 夹具：另一个 DSH 进程的会话日志 ------------------- */

/**
 * 造一份**合成会话日志**并把它设为临时 DSH_HOME 的会话目录。
 * 插件会把它当作"外部进程"（例如 `dsh --profile headless` 的执行者）的调用读进来 ——
 * 这正是本部署里本地模型（ollama）调用唯一能被 web 进程看见的途径。
 * 刻意写成**两个 zstd 帧**拼接，顺带验证多帧增量解码。
 */
const FIXTURE_HOME = '/tmp/dsh-model-live-fixture'
const now = Date.now()
rmSync(FIXTURE_HOME, { recursive: true, force: true })
const fixtureFile = join(FIXTURE_HOME, 'sessions', '--tmp-executor-ws--', 'session-fixture-0001', 'session.jsonl.zstd')
mkdirSync(join(fixtureFile, '..'), { recursive: true })
const fixtureLines = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
writeFileSync(fixtureFile, Buffer.concat([
  zstdCompressSync(Buffer.from(fixtureLines([
    { type: 'session', version: 0, id: 'session-fixture-0001', createdAt: now - 60000, cwd: '/tmp/executor-ws', delegationDepth: 0, agentPreset: 'code' },
  ]), 'utf8')),
  zstdCompressSync(Buffer.from(fixtureLines([
    { type: 'request/context', seq: 11, time: now - 50000, data: { provider: 'ollama', model: 'qwen3.8-27b-iq4xs:latest', contextWindow: 32768 } },
    { type: 'assistant/chunk', seq: 12, time: now - 49900, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先想一想' } } },
    { type: 'text-chunks', seq0: 13, time0: now - 49800, data: { turn: 1, step: 1, index: 1, dt: [40, 60], texts: ['你好', '，世界'] } },
    { type: 'assistant/chunk', seq: 16, time: now - 49600, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 30 } } } },
    { type: 'assistant/chunk', seq: 17, time: now - 49500, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
    { type: 'assistant/message', seq: 18, time: now - 49400, data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'ollama', model: 'qwen3.8-27b-iq4xs:latest' } }, usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 30 } } },
  ]), 'utf8')),
]))
// 插件从 $DSH_HOME/sessions 取会话日志根目录；必须在 apply 之前设好。
process.env.DSH_HOME = FIXTURE_HOME
// 运行时日志采集要 SSH 到真实主机；端到端测试里关掉（由 runtime-log-scan.mjs 单独实测）。
process.env.DSH_MODEL_LIVE_RUNTIME = '0'
console.log('夹具会话日志:', fixtureFile)

/* ------------------------------ 迷你 React ------------------------------ */

/** 极简 hooks 派发器：每个函数组件渲染前重置。 */
const hooks = { list: [], index: 0 }
const realSetInterval = globalThis.setInterval

/**
 * 造一个够用的 React 替身：createElement + 四个 hook。
 * 只求「把真实组件代码跑一遍」，不求重渲染。
 */
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props === null || props === undefined ? {} : props) }
    const flat = []
    for (const child of children) {
      if (Array.isArray(child)) for (const item of child) flat.push(item)
      else flat.push(child)
    }
    merged.children = flat.length <= 1 ? flat[0] : flat
    return { type, props: merged }
  },
  useState(initial) {
    const slot = hooks.index
    hooks.index += 1
    if (hooks.list.length <= slot) hooks.list[slot] = typeof initial === 'function' ? initial() : initial
    const value = hooks.list[slot]
    return [value, () => {}]
  },
  useEffect(factory) {
    hooks.index += 1
    try { factory() } catch (error) { /* 副作用失败不影响断言 */ }
    return undefined
  },
  useLayoutEffect() { hooks.index += 1 },
  useRef(initial) { hooks.index += 1; return { current: initial === undefined ? null : initial } },
}

/** 把一个元素树渲染成纯文本（用于断言）。 */
function renderText(node, depth) {
  if (depth === undefined) depth = 0
  if (depth > 40) return ''
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((item) => renderText(item, depth + 1)).join(' ')
  const saved = { list: hooks.list.slice(), index: hooks.index }
  hooks.list = []
  hooks.index = 0
  let out
  if (typeof node.type === 'function') {
    out = renderText(node.type(node.props), depth + 1)
  } else {
    out = renderText(node.props === undefined ? null : node.props.children, depth + 1)
  }
  hooks.list = saved.list
  hooks.index = saved.index
  return out
}

/* ------------------------------ 假的宿主环境 ------------------------------ */

function makeRes(onWrite) {
  const res = {
    status: null,
    headers: null,
    chunks: [],
    writeHead(status, headers) { res.status = status; res.headers = headers; return res },
    write(chunk) {
      res.chunks.push(String(chunk))
      if (onWrite !== undefined) onWrite(String(chunk))
      return true
    },
    end(chunk) { if (chunk !== undefined) res.chunks.push(String(chunk)) },
  }
  return res
}

function makeReq(body, method) {
  const handlers = new Map()
  return {
    method: method === undefined ? 'POST' : method,
    url: '/',
    on(event, callback) { handlers.set(event, callback); return this },
    emit(event) { const cb = handlers.get(event); if (cb) cb() },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
}

const services = new Map()
let route = null
const listeners = new Map()
const ctx = {
  on(event, callback) { listeners.set(event, callback); return () => listeners.delete(event) },
  get(service) { return services.get(service) },
  effect(factory) { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
  inject(names, callback) { callback(ctx) },
  logger: { warn() {}, info() {}, error() {} },
}
Object.defineProperty(ctx, 'webServer', { get() { return services.get('webServer') } })
services.set('webServer', { register(entry) { route = entry; return () => { route = null } } })

let llmCalls = 0
services.set('llm', {
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }, { id: 'ollama', name: 'Ollama' }],
  resolveModelInfo: async (provider, model) => {
    llmCalls += 1
    // 本地 ollama 端点实际只服务 32768（与日志里的 request/context 一致）。
    if (provider === 'ollama') {
      return {
        provider,
        id: model,
        name: 'Qwen3.8 27B IQ4_XS（本地）',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 32768 },
        defaultMaxTokens: 8192,
        reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' },
      }
    }
    return {
      provider,
      id: model,
      name: 'DeepSeek V4 Flash 视觉实验版',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 262144 },
      defaultMaxTokens: 8192,
      reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' },
    }
  },
  listModels: async (provider) => [{ id: provider + '-a', name: '模型 A', inputModalities: ['text'] }],
})

applyHost(ctx)
const waterfall = listeners.get('llm/stream')

/* ------------------------------ 假浏览器环境 ------------------------------ */

/** 直接走 Host 路由的 fetch 替身。 */
async function fakeFetch(url, options) {
  const res = makeRes()
  const req = makeReq(JSON.parse((options && options.body) || '{}'), (options && options.method) || 'POST')
  req.url = url
  await route.handler(req, res)
  const text = res.chunks.join('')
  return {
    ok: res.status === 200,
    status: res.status,
    json: async () => JSON.parse(text),
  }
}

/** 假 EventSource：把 SSE 帧解析后按事件名派发。 */
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.handlers = new Map()
    this.closed = false
    this.buffer = ''
    this.frames = 0
    this.req = null
    queueMicrotask(() => { this.connect() })
  }

  addEventListener(name, callback) {
    const list = this.handlers.get(name) || []
    list.push(callback)
    this.handlers.set(name, list)
  }

  dispatch(name, data) {
    for (const callback of this.handlers.get(name) || []) callback({ data })
  }

  feed(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n\n')
    while (index !== -1) {
      const frame = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      index = this.buffer.indexOf('\n\n')
      let name = null
      let data = null
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7)
        else if (line.startsWith('data: ')) data = line.slice(6)
      }
      if (name !== null && name !== 'ping') {
        this.frames += 1
        this.dispatch(name, data)
      }
      if (name === 'ping') this.dispatch('ping', data)
    }
  }

  async connect() {
    if (this.closed) return
    const res = makeRes((chunk) => this.feed(chunk))
    const req = makeReq(undefined, 'GET')
    req.url = this.url
    this.req = req
    await route.handler(req, res)
  }

  close() { this.closed = true; if (this.req !== null) this.req.emit('close') }
}

globalThis.fetch = fakeFetch
globalThis.EventSource = FakeEventSource
// 插件会注入自己的 <style>；给个够用的 document 替身。
globalThis.document = {
  head: { append() {} },
  createElement() {
    return {
      dataset: {},
      textContent: '',
      remove() {},
    }
  },
}

/** 装载客户端 bundle（走真实的 __ModuleLoader__ 契约）。 */
const code = readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8')
let captured = null
const fakeWindow = { __ModuleLoader__: { load(spec) { captured = spec } } }
// eslint-disable-next-line no-new-func
new Function('window', code)(fakeWindow)
assert.ok(captured !== null, '客户端 bundle 应当调用 window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-model-live')

const clientModule = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('未预期的 require: ' + specifier)
})
assert.equal(typeof clientModule.apply, 'function')
assert.deepEqual(clientModule.inject, ['slots'])

/** 假的 slots 服务：记录注册的插槽与组件。 */
const registrations = []
const slots = {
  inject(name, callback) { callback() },
  register(options, component) { registrations.push({ options, component }) },
}
const clientCtx = {
  get(name) { return name === 'slots' ? slots : undefined },
  effect(factory) { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
}
clientModule.apply(clientCtx)

assert.equal(registrations.length, 2, '应当注册两个插槽')
const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
const section = registrations.find((entry) => entry.options.name === 'settings.section')
assert.ok(overlay !== undefined, '应当注册 shell.overlay 挂件')
assert.ok(section !== undefined, '应当注册 settings.section 设置页')
assert.equal(overlay.options.label, '模型调用实时监视')
assert.equal(section.options.label, '模型调用监控')

/* --------------------------- 让真实数据流进来 --------------------------- */

/** 跑一次假模型调用（走真实瀑布）。 */
async function runCall(provider, model, kind) {
  const stream = waterfall(
    { provider, model, sessionId: 'session-abcdef12', messages: [{}, {}], tools: [{}], system: 'x'.repeat(50) },
    () => (async function* () {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        yield { type: 'text-delta', index: 0, text: '一段输出文字'.repeat(4) }
      }
      yield { type: 'usage', usage: { inputTokens: 1500, outputTokens: 420, cacheReadTokens: 9000, reasoningTokens: 60 } }
      yield { type: 'finish', reason: { kind: kind === undefined ? 'stop' : kind } }
    })(),
  )
  for await (const chunk of stream) { /* 消费 */ }
}

// 组件里的 useTicker 会开 setInterval；这里替换成不排程的桩，保证测试进程能自然退出。
globalThis.setInterval = () => 0

const live = runCall('deepseek-official', 'deepseek-v4-flash-vision-exp')
await new Promise((resolve) => setTimeout(resolve, 260))

// 此时应当已有 SSE 连接并收到快照 + tick。
const source = clientModule.__source === undefined ? null : clientModule.__source
const widgetTextLive = renderText(React.createElement(overlay.component, {}))
const sectionTextLive = renderText(React.createElement(section.component, {}))
assert.ok(sectionTextLive.includes('模型调用监控'), '设置页标题应当渲染')
assert.ok(sectionTextLive.includes('进行中的模型调用'), '应当渲染进行中区块')
assert.ok(sectionTextLive.includes('deepseek-v4-flash-vision-exp'), '进行中应当出现真实模型名')
// 进行中时挂件折叠态显示的是「模型名 + 耗时 · 速率」，不含「调用」二字。
assert.ok(widgetTextLive.includes('deepseek-v4-flash-vision-exp') || widgetTextLive.includes('视觉'), '挂件应当渲染当前模型：' + widgetTextLive)
assert.ok(/ms|s ·/.test(widgetTextLive) || widgetTextLive.includes('tok'), '挂件应当渲染实时指标：' + widgetTextLive)
await live
await new Promise((resolve) => setTimeout(resolve, 200))

const widgetText = renderText(React.createElement(overlay.component, {}))
const sectionText = renderText(React.createElement(section.component, {}))

assert.ok(sectionText.includes('DeepSeek V4 Flash 视觉实验版'), '模型数据显示名应当来自 resolveModelInfo')
assert.ok(sectionText.includes('262144') || sectionText.includes('262.1k'), '应当显示上下文窗口')
assert.ok(sectionText.includes('最近调用'), '应当渲染最近调用区块')
assert.ok(sectionText.includes('模型数据'), '应当渲染模型数据区块')
assert.ok(sectionText.includes('text+image'), '应当显示输入模态')
assert.ok(sectionText.includes('high'), '应当显示推理档位')
assert.ok(sectionText.includes('tok/s'), '应当显示输出速度')
assert.ok(sectionText.includes('DeepSeek 官方'), '应当显示提供方清单')
assert.ok(sectionText.includes('缓存读'), '应当显示缓存读 token')
assert.ok(sectionText.includes('9.0k') || sectionText.includes('9000'), '缓存读应当显示为 9.0k')
// 两个模型各解析一次：本进程的 deepseek 与外部会话日志里的本地 ollama 模型；
// 同一个模型再来第二次调用时不会再解析（缓存命中）。
assert.equal(llmCalls, 2, '每个模型只解析一次元数据')

// 外部进程（合成会话日志夹具）里的本地模型调用必须已经在界面上。
assert.ok(sectionText.includes('外部·executor-ws'), '设置页应当标出「外部进程」来源：' + sectionText.slice(0, 200))
assert.ok(sectionText.includes('qwen3.8-27b-iq4xs:latest'), '设置页应当列出本地模型调用')
assert.ok(sectionText.includes('32.8k'), '本地模型的上下文窗口应当来自日志里的 request/context')

// 失败路径也要能在界面上看出来。
await runCall('ollama', 'qwen3.8-27b-iq4xs:latest', 'error')
await new Promise((resolve) => setTimeout(resolve, 250))
const afterError = renderText(React.createElement(section.component, {}))
assert.ok(afterError.includes('qwen3.8-27b-iq4xs:latest'), '失败模型也应当出现在最近调用里')
assert.ok(afterError.includes('失败'), '应当显示失败状态')

console.log('渲染摘要（设置页，节选）：')
console.log('  ' + afterError.replace(/\s+/g, ' ').slice(0, 460))
console.log('\n挂件摘要：')
console.log('  ' + widgetText.replace(/\s+/g, ' ').slice(0, 200))

/* ---------------------------- 轮询兜底也要通 ---------------------------- */

globalThis.EventSource = undefined
const stateResponse = await fakeFetch('/_dsh/model-live/state', { method: 'POST', body: '{}' })
const state = await stateResponse.json()
assert.equal(state.ok, true)
// 2 条本进程实时观测 + 1 条外部会话日志（本地模型）
assert.equal(state.data.totals.calls, 3)
assert.equal(state.data.totals.live, 2, '本进程应当有 2 条')
assert.equal(state.data.totals.external, 1, '外部进程应当有 1 条')

const external = state.data.recent.find((row) => row.source === 'log')
assert.ok(external !== undefined, '应当有一条来自会话日志的调用')
assert.equal(external.provider, 'ollama')
assert.equal(external.model, 'qwen3.8-27b-iq4xs:latest')
assert.equal(external.workspace, 'executor-ws')
assert.equal(external.status, 'ok')
assert.equal(external.finishKind, 'stop')
assert.equal(external.contextWindow, 32768, '上下文窗口来自日志的 request/context')
assert.equal(external.textChars, 5, '打包行 text-chunks 的字符数应当累加正确')
assert.equal(external.reasoningChars, 4, 'reasoning-delta 的字符数应当累加正确')
assert.equal(external.outputTokens, 120)
assert.equal(external.inputTokens, 900)
assert.equal(external.tokensEstimatedProxy === undefined, true)
assert.ok(external.durationMs > 0)

// 模型清单里，本地模型那一行要标出「其中外部」
const localRow = state.data.models.find((row) => row.model === 'qwen3.8-27b-iq4xs:latest')
assert.ok(localRow !== undefined, '模型清单应当包含本地模型')
assert.equal(localRow.external, 1)
assert.equal(localRow.contextWindow, 32768)

// 扫描器自述（供界面说明来源）
assert.equal(state.data.scanner.running, true)
assert.ok(state.data.scanner.root.endsWith('/sessions'), '扫描根目录应当是 $DSH_HOME/sessions')
assert.ok(state.data.scanner.stats.files >= 1)
console.log('\n轮询（POST /state）兜底路径 OK：calls=' + String(state.data.totals.calls) +
  '（本进程 ' + String(state.data.totals.live) + ' / 外部 ' + String(state.data.totals.external) + '）')

globalThis.setInterval = realSetInterval
console.log('\n进程内端到端断言全部通过 ✅')
