/**
 * 挂件默认位置测试（两个插件共用，靠命令行参数指定 bundle 与期望值）
 *
 * 为什么单独写：默认位置由两条规则算出 —— ①左侧贴住聊天区（= 实测侧栏宽度 + 16px），
 * ②纵向按窗口高度取比例。这里用一个能重渲染的迷你 React + 假 DOM 把真实组件跑起来，
 * 断言最终落到根节点上的 style.left / style.top。
 *
 * 用法: node test/widget-position.mjs <bundle 路径> <期望 left> <期望 top> [侧栏宽度] [窗口高度]
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const bundlePath = process.argv[2]
const expectLeft = Number(process.argv[3])
const expectTop = Number(process.argv[4])
const sidebarWidth = Number(process.argv[5] === undefined ? 280 : process.argv[5])
const innerHeight = Number(process.argv[6] === undefined ? 1000 : process.argv[6])
assert.ok(bundlePath !== undefined && Number.isFinite(expectLeft) && Number.isFinite(expectTop), '参数不完整')

/* ------------------------------ 迷你 React ------------------------------ */

const hooks = { list: [], index: 0 }
let pendingRerender = false
const refQueue = []

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
    if (!(slot in hooks.list)) hooks.list[slot] = typeof initial === 'function' ? initial() : initial
    const list = hooks.list
    const setter = (next) => {
      const value = typeof next === 'function' ? next(list[slot]) : next
      if (value !== list[slot]) {
        list[slot] = value
        pendingRerender = true
      }
    }
    return [hooks.list[slot], setter]
  },
  useEffect(factory) {
    hooks.index += 1
    try { factory() } catch (error) { /* 副作用失败不影响断言 */ }
    return undefined
  },
  useLayoutEffect(factory) {
    hooks.index += 1
    try { factory() } catch (error) { /* 同上 */ }
    return undefined
  },
  useRef(initial) {
    const slot = hooks.index
    hooks.index += 1
    if (!(slot in hooks.list)) {
      const queued = refQueue.shift()
      hooks.list[slot] = queued === undefined ? { current: initial === undefined ? null : initial } : queued
    }
    return hooks.list[slot]
  },
}

/** 调用一个函数组件；state 变化时按需重渲染（上限 8 次，防跑飞）。 */
function callComponent(type, props) {
  const slots = []
  let out = null
  for (let pass = 0; pass < 8; pass += 1) {
    pendingRerender = false
    hooks.list = slots
    hooks.index = 0
    out = type(props)
    if (!pendingRerender) break
  }
  return out
}

/** 把元素树展开成真实结构（函数组件被调用，宿主元素保留 props）。 */
function expand(node, depth) {
  if (depth === undefined) depth = 0
  if (depth > 60) return null
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((item) => expand(item, depth + 1))
  if (typeof node.type === 'function') return expand(callComponent(node.type, node.props), depth + 1)
  return {
    type: node.type,
    props: node.props,
    children: expand(node.props === undefined ? null : node.props.children, depth + 1),
  }
}

/** 找到第一个带 style 的宿主元素（挂件的根 div）。 */
function findStyledRoot(node) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findStyledRoot(item)
      if (found !== null) return found
    }
    return null
  }
  if (node.props !== undefined && node.props.style !== undefined) return node
  return findStyledRoot(node.children)
}

/* ------------------------------ 假的浏览器环境 ------------------------------ */

const fakeSidebar = { getBoundingClientRect: () => ({ width: sidebarWidth }) }
const fakeFrame = { firstElementChild: fakeSidebar }
const fakeLayer = { parentElement: fakeFrame }
const fakeNode = {
  offsetParent: fakeLayer,
  parentElement: fakeLayer,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 180, height: 56 }),
}

globalThis.window = { innerHeight }
globalThis.document = {
  head: { append() {} },
  createElement() { return { dataset: {}, textContent: '', remove() {} } },
}
globalThis.fetch = () => new Promise(() => {})
globalThis.EventSource = class { addEventListener() {} close() {} }
globalThis.setInterval = () => 0
globalThis.setTimeout = () => 0
globalThis.clearInterval = () => {}
globalThis.clearTimeout = () => {}

/* ------------------------------ 装载并渲染 ------------------------------ */

const code = readFileSync(bundlePath, 'utf8')
let captured = null
globalThis.window.__ModuleLoader__ = { load(spec) { captured = spec } }
new Function('require', code)((specifier) => {
  if (specifier === 'react') return React
  throw new Error('未预期的 require: ' + specifier)
})
assert.ok(captured !== null, 'bundle 应当调用 window.__ModuleLoader__.load')

const registrations = []
const slots = {
  inject(name, callback) { callback() },
  register(options, component) { registrations.push({ options, component }) },
}
captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('未预期的 require: ' + specifier)
}).apply({
  get(name) { return name === 'slots' ? slots : undefined },
  effect(factory) { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
})

const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
assert.ok(overlay !== undefined, '应当注册 shell.overlay 挂件')

// 组件第一次 useRef 拿到的必须是 **ref 对象**（真实环境里 React 把它挂到 DOM 上，
// 所以 current 才是节点）—— 之前这里直接塞节点，导致 nodeRef.current 是 undefined。
refQueue.push({ current: fakeNode })
const tree = expand(React.createElement(overlay.component, {}))
const root = findStyledRoot(tree)
assert.ok(root !== null, '应当渲染出带 style 的根节点')

const style = root.props.style
assert.equal(style.left, String(expectLeft) + 'px', '默认 left 应当贴住聊天区左缘（侧栏 ' + String(sidebarWidth) + ' + 16）')
assert.equal(style.top, String(expectTop) + 'px', '默认 top 应当按窗口高度比例计算')
assert.equal(style.right, undefined, '不应当再用 right 锚定')
assert.equal(style.bottom, undefined, '不应当再用 bottom 锚定')
assert.notEqual(style.visibility, 'hidden', '测量完成后不应当还处于隐藏态')

console.log('✅ ' + captured.id + '  默认位置 left=' + style.left + ' top=' + style.top +
  '（侧栏 ' + String(sidebarWidth) + 'px / 窗口高 ' + String(innerHeight) + 'px）')
