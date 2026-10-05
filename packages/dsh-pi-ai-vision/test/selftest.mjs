/**
 * 自测 —— 不需要启动 harness。
 *
 * A. 模式表与能力解析的纯函数；
 * B. 用**真实 cordis**（从安装里的 @deepseek-ai/cordis 载入）挂一个假 llm 服务，
 *    对本地桩 HTTP 端点跑完整链路：`apply()` → 后台刷新 → 方法接管 → 断言。
 *
 * 用法：
 *   node scripts/selftest.mjs
 * 环境变量：
 *   DSH_CORDIS  指向 @deepseek-ai/cordis 的 lib/index.js（缺省从 ~/.dsh/profiles 找）
 *
 * @module dsh-pi-ai-vision/selftest
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

const plugin = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'index.js')).href)
const { readVision, pickModelArray, readModelId, CapabilitySource } = await import(
  pathToFileURL(path.join(pkgRoot, 'lib', 'capabilities.js')).href
)
const { resolvePatterns, DEFAULT_VISION_PATTERNS } = await import(
  pathToFileURL(path.join(pkgRoot, 'lib', 'patterns.js')).href
)

let passed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.log(`  FAIL ${label}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

function findCordis() {
  const candidates = [
    process.env.DSH_CORDIS,
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  ].filter((entry) => typeof entry === 'string' && entry.length > 0)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return pathToFileURL(candidate).href
  throw new Error('找不到 @deepseek-ai/cordis；请把 DSH_CORDIS 指向它的 lib/index.js')
}

// ---------------------------------------------------------------- A. 纯函数

console.log('A. 纯函数')

check('readVision 读布尔字段', () => {
  assert.equal(readVision({ supportsVision: true }, undefined), true)
  assert.equal(readVision({ supportsVision: false }, undefined), false)
})
check('readVision 读数组形式的 modalities', () => {
  assert.equal(readVision({ modalities: ['text', 'image'] }, ['modalities']), true)
  assert.equal(readVision({ modalities: ['text'] }, ['modalities']), false)
})
check('readVision 读点号路径', () => {
  assert.equal(readVision({ capabilities: { vision: true } }, ['capabilities.vision']), true)
})
check('readVision 未表态返回 undefined', () => {
  assert.equal(readVision({ id: 'x' }, undefined), undefined)
  assert.equal(readVision(null, undefined), undefined)
})
check('pickModelArray 自动识别 models / data / 裸数组', () => {
  assert.deepEqual(pickModelArray({ models: [1] }, undefined), [1])
  assert.deepEqual(pickModelArray({ data: [2] }, undefined), [2])
  assert.deepEqual(pickModelArray([3], undefined), [3])
  assert.equal(pickModelArray({ other: [4] }, undefined), null)
  assert.deepEqual(pickModelArray({ payload: { list: [5] } }, 'payload.list'), [5])
})
check('readModelId 依 id / model / name 取值', () => {
  assert.equal(readModelId({ id: 'a' }), 'a')
  assert.equal(readModelId({ model: 'b' }), 'b')
  assert.equal(readModelId({ name: 'c' }), 'c')
  assert.equal(readModelId({}), undefined)
})
check('模式表命中常见多模态家族', () => {
  const patterns = resolvePatterns(undefined, true)
  for (const id of ['qwen2.5-vl-7b-q4', 'llava-v1.6-7b', 'minicpm-v-8b', 'phi-3.5-vision', 'glm-4.6v-flash', 'smolvlm-256m'])
    assert.ok(patterns.some((re) => re.test(id)), `应命中 ${id}`)
})
check('模式表不误伤纯文本家族', () => {
  const patterns = resolvePatterns(undefined, true)
  for (const id of [
    'bartowski_Qwen2.5-1.5B-Instruct-GGUF_Q4_0',
    'unsloth_gemma-3-1b-it-GGUF_Q4_0',
    'gpt-oss-20b-mxfp4',
    'qwen3-embedding-4b-q4_k_m',
    'unsloth_SmolLM3-3B-GGUF_Q4_0',
    'unsloth_Phi-4-mini-instruct-GGUF_Q4_K_M',
  ])
    assert.ok(!patterns.some((re) => re.test(id)), `不该命中 ${id}`)
})
check('模式表不收录 gemma-3 小杯（1b 无 mmproj）', () => {
  const patterns = resolvePatterns(undefined, true)
  const hits = patterns.filter((re) => re.test('unsloth_gemma-3-1b-it-GGUF_Q4_0'))
  assert.deepEqual(hits, [], 'gemma-3-1b 必须判为纯文本')
  assert.ok(!DEFAULT_VISION_PATTERNS.some((re) => re.source === 'gemma-3'), '内置表不应有裸 gemma-3 模式')
})

// ------------------------------------------------------- B. 端到端（真 cordis）

console.log('B. 端到端（真 cordis + 桩端点）')

const { Context, Service } = await import(findCordis())

/** 桩能力端点：形状与 llama.cpp-hub 的 /api/models/list 一致。 */
const STUB = {
  models: [
    { id: 'gemma-4-e4b-it-q4_k_m', name: 'gemma-4-e4b-it-q4_k_m', supportsVision: true },
    { id: 'unsloth_gemma-3-1b-it-GGUF_Q4_0', name: 'unsloth_gemma-3-1b-it-GGUF_Q4_0', supportsVision: false },
    { id: 'mystery-instruct-9b', name: 'mystery-instruct-9b', supportsVision: false },
  ],
}
let hits = 0
const server = http.createServer((request, response) => {
  hits += 1
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(STUB))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/**
 * 桩适配器：真正组装请求的那条路走这里。
 * LlmRuntime.prepareCall → registration.adapter.prepareCall → adapter.resolveModel()
 * 返回的 inputModalities 直接进 normalizeModelInfo，不经过 llm.resolveModelInfo/For。
 */
class FakeAdapter {
  constructor() {
    /** provider -> 配置描述符数组，模仿 PiAiAdapter 的 snapshot.models。 */
    this.descriptors = new Map()
    this.snapshot = { models: { getModels: (provider) => this.descriptors.get(provider) ?? [] } }
  }
  /** PiAiAdapter 的配置快照入口。 */
  current() {
    return this.snapshot
  }
  async resolveModel(provider, model) {
    const descriptor = (this.descriptors.get(provider) ?? []).find((entry) => entry.id === model)
    return { provider, id: model, name: model, inputModalities: [...(descriptor?.input ?? ['text'])] }
  }
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model) }
  }
}

class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.adapters = new Map()
  }
  async resolveModelInfoFor(registration, model) {
    return { provider: registration.provider.id, id: model, name: model, inputModalities: ['text'] }
  }
  async resolveModelInfo(provider, model) {
    return this.resolveModelInfoFor({ provider: { id: provider, name: provider } }, model)
  }
  async listModels(provider) {
    return [
      { provider, id: 'gemma-4-e4b-it-q4_k_m', name: 'gemma-4-e4b-it-q4_k_m', inputModalities: ['text'] },
      { provider, id: 'unsloth_gemma-3-1b-it-GGUF_Q4_0', name: 'unsloth_gemma-3-1b-it-GGUF_Q4_0', inputModalities: ['text'] },
    ]
  }
}

const root = new Context()
const llmService = new FakeLlm(root)
/** 注册一个桩适配器，返回它以便断言。 */
const adapterFor = (provider) => {
  const adapter = new FakeAdapter()
  adapter.descriptors.set(provider, [
    { provider, id: 'gemma-4-e4b-it-q4_k_m', name: 'gemma-4-e4b-it-q4_k_m', input: ['text'] },
    { provider, id: 'unsloth_gemma-3-1b-it-GGUF_Q4_0', name: 'unsloth_gemma-3-1b-it-GGUF_Q4_0', input: ['text'] },
  ])
  llmService.adapters.set(provider, { adapter, provider: { id: provider, name: provider }, retryPolicy: {} })
  return adapter
}
const llamaAdapter = adapterFor('llama')
adapterFor('other')

const fiber = root.plugin(plugin, {
  routes: {
    llama: { capabilityUrl: `http://127.0.0.1:${port}/api/models/list`, timeoutMs: 3000, ttlMinutes: 60 },
    overridden: {
      patternFallback: false,
      models: { 'plain-but-overridden': ['text', 'image'] },
    },
    nofallback: { patternFallback: false },
  },
})

const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

const modalities = async (provider, model) => (await root.llm.resolveModelInfo(provider, model)).inputModalities

const refreshed = await waitFor(async () => (await modalities('llama', 'gemma-4-e4b-it-q4_k_m')).includes('image'))
check('后台刷新在 5 秒内落地', () => assert.ok(refreshed, '能力端点未被读取或未生效'))
check('能力端点确实被请求', () => assert.ok(hits > 0, 'httptemplate 桩端点没有收到请求'))

check('端点说支持 → 扩为 [text, image]', async () => {})
{
  const info = await modalities('llama', 'gemma-4-e4b-it-q4_k_m')
  check('端点说支持 → 扩为 [text, image]', () => assert.deepEqual(info, ['text', 'image']))
}
{
  const info = await modalities('llama', 'unsloth_gemma-3-1b-it-GGUF_Q4_0')
  check('端点说不支持 → 保持原样，不下调', () => assert.deepEqual(info, ['text']))
}
{
  const info = await modalities('llama', 'llava-v1.6-7b')
  check('端点没提这个模型 → 模式表兜底', () => assert.deepEqual(info, ['text', 'image']))
}
{
  const info = await modalities('llama', '按名字也看不出能力的模型')
  check('完全未知 → 原样返回不猜', () => assert.deepEqual(info, ['text']))
}
{
  const info = await modalities('other-provider', 'llava-v1.6-7b')
  check('未配置的路由不受影响', () => assert.deepEqual(info, ['text']))
}
{
  const info = await modalities('overridden', 'plain-but-overridden')
  check('显式 models 覆盖表优先', () => assert.deepEqual(info, ['text', 'image']))
}
{
  const info = await modalities('nofallback', 'llava-v1.6-7b')
  check('patternFallback:false 时模式表不生效', () => assert.deepEqual(info, ['text']))
}
{
  const models = await root.llm.listModels('llama')
  check('listModels 同步被接管', () => {
    assert.deepEqual(models[0].inputModalities, ['text', 'image'])
    assert.deepEqual(models[1].inputModalities, ['text'])
  })
}

// --- 适配器层：只做 llm 服务层会漏掉的那条路 ---
{
  const info = await llamaAdapter.resolveModel('llama', 'gemma-4-e4b-it-q4_k_m')
  check('适配器层 resolveModel 被接管', () => assert.deepEqual(info.inputModalities, ['text', 'image']))
}
{
  const call = await llamaAdapter.prepareCall('llama', 'gemma-4-e4b-it-q4_k_m')
  check('适配器层 prepareCall（真正组装请求的那条路）', () =>
    assert.deepEqual(call.model.inputModalities, ['text', 'image']),
  )
}
{
  const info = await llamaAdapter.resolveModel('other', 'llava-v1.6-7b')
  check('不属于受管路由的适配器不动', () => assert.deepEqual(info.inputModalities, ['text']))
}
{
  const list = llamaAdapter.descriptors.get('llama')
  const vision = list.find((entry) => entry.id === 'gemma-4-e4b-it-q4_k_m')
  const textOnly = list.find((entry) => entry.id === 'unsloth_gemma-3-1b-it-GGUF_Q4_0')
  check('pi-ai 配置描述符被钉上 image（最内层）', () => assert.deepEqual(vision.input, ['text', 'image']))
  check('纯文本模型的描述符不动', () => assert.deepEqual(textOnly.input, ['text']))
}
{
  const info = await llamaAdapter.resolveModel('llama', '按名字也看不出能力的模型')
  check('适配器层同样只认已知，不猜', () => assert.deepEqual(info.inputModalities, ['text']))
}

await fiber.dispose()
{
  const info = await modalities('llama', 'gemma-4-e4b-it-q4_k_m')
  check('卸载后恢复原始行为（llm 服务层）', () => assert.deepEqual(info, ['text']))
}
{
  const info = await llamaAdapter.resolveModel('llama', 'gemma-4-e4b-it-q4_k_m')
  check('卸载后恢复原始行为（适配器层）', () => assert.deepEqual(info.inputModalities, ['text']))
}

server.close()

console.log(`
${process.exitCode ? '存在失败用例' : `全部通过（${passed} 项）`}`)
