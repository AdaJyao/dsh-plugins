/**
 * 对真实能力端点核对一遍判定表 —— 不启动 harness。
 *
 * 用法：
 *   node scripts/live-check.mjs [能力端点URL] [路由id]
 * 缺省端点：http://192.168.31.222:8090/api/models/list，路由 id：llama
 *
 * @module dsh-pi-ai-vision/live-check
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const { createEngine } = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'index.js')).href)
const { pickModelArray, readModelId } = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'capabilities.js')).href)

const url = process.argv[2] ?? 'http://192.168.31.222:8090/api/models/list'
const provider = process.argv[3] ?? 'llama'

const silent = { info() {}, warn() {}, debug() {}, error() {} }
const engine = createEngine({ routes: { [provider]: { capabilityUrl: url, timeoutMs: 8000 } } }, silent)
await engine.refreshAll()

const source = engine.sources.get(provider)
const response = await fetch(url)
const entries = pickModelArray(await response.json(), undefined) ?? []

let vision = 0
let text = 0
let unknown = 0
const rows = []
for (const entry of entries) {
  const id = readModelId(entry)
  if (id === undefined) continue
  const decision = engine.decide(provider, id)
  const declared = decision === undefined ? '（不改动）' : decision.join(' + ')
  if (decision?.includes('image')) vision += 1
  else if (decision === undefined) unknown += 1
  else text += 1
  rows.push({ id, declared, upstream: source.vision(id) })
}

console.log(`端点 ${url}`)
console.log(`共 ${rows.length} 个模型：判为可收图 ${vision}，明确纯文本 ${text}，不做改动 ${unknown}\n`)
const width = Math.max(...rows.map((row) => row.id.length), 4)
for (const row of rows) {
  const mark = row.declared.includes('image') ? '[图]' : '[  ]'
  console.log(`${mark} ${row.id.padEnd(width)}  上游 supportsVision=${String(row.upstream)}  ->  ${row.declared}`)
}
