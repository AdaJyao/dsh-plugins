/**
 * 模型名模式表 —— 能力接口不可用时的保守兜底。
 *
 * 这里**刻意不收录 gemma-3 系列**：同一个家族里 gemma-3-1b 是无 mmproj 的纯文本
 * 模型，而 gemma-3-4b/12b/27b 才是多模态。按名字推断必然误判其中之一，而误判成
 * 「支持图片」的代价远大于漏判（超发的图片会被持久化进会话历史，之后该模型每一轮
 * 都会重发一张它处理不了的图，会话因此卡死）。所以只收录名字本身就无歧义的多模态
 * 家族。
 *
 * @module dsh-pi-ai-vision/patterns
 */

/** 无歧义的多模态家族名模式。 */
export const DEFAULT_VISION_PATTERNS = Object.freeze([
  /llava/i,
  /bakllava/i,
  /internvl/i,
  /minicpm[-_.]?v/i,
  /qwen[\w.]*[-_.]?vl(?![a-z])/i,
  /(^|[-_.])vl(?=[-_.\d]|$)/i,
  /vision/i,
  /smolvlm/i,
  /moondream/i,
  /pixtral/i,
  /idefics/i,
  /cogvlm/i,
  /glm-?\d+(\.\d+)?v(?![a-z])/i,
  /gemma-?3[-_.](4|12|27)b/i,
  /gemma-?4/i,
])

/**
 * 把配置里的模式（字符串或正则）与内置表合并。
 *
 * @param configured - 配置中为该路由列出的模式；`null` 表示只用内置表，`[]` 表示禁用。
 * @param useDefaults - 是否叠加内置表。
 * @returns 可对模型 id 调用 `test` 的正则数组。
 */
export function resolvePatterns(configured, useDefaults = true) {
  const out = []
  if (useDefaults) out.push(...DEFAULT_VISION_PATTERNS)
  for (const entry of configured ?? []) {
    if (entry instanceof RegExp) out.push(entry)
    else if (typeof entry === 'string' && entry.length > 0) {
      try {
        out.push(new RegExp(entry, 'i'))
      } catch {
        // 非法模式忽略：一个写坏的正则不应该让整条路由失效。
      }
    }
  }
  return out
}
