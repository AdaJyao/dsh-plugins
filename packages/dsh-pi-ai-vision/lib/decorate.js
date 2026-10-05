/**
 * 纯函数层：把「模态决定」叠到 harness 交出来的模型元数据上。
 *
 * 与 cordis 完全无关，因此可以脱离 harness 单测。见 scripts/selftest.mjs。
 *
 * @module dsh-pi-ai-vision/decorate
 */

/** 视觉模态组合。 */
export const TEXT_AND_IMAGE = Object.freeze(['text', 'image'])
/** 纯文本模态组合。 */
export const TEXT_ONLY = Object.freeze(['text'])

/**
 * 给一条模型元数据补上 `inputModalities`。
 *
 * 只做「补」，不做「删」：`decide` 返回 `undefined` 时原样返回，因此用户在手写配置
 * 里声明的模态永远不会被插件覆盖掉。
 *
 * @param {object} info - `{ provider, id, name, inputModalities? }`。
 * @param {(provider: string, modelId: string) => string[] | undefined} decide - 模态决定。
 * @returns 新的元数据对象。
 */
export function withModalities(info, decide) {
  if (info === null || typeof info !== 'object') return info
  const provider = typeof info.provider === 'string' ? info.provider : undefined
  const modelId = typeof info.id === 'string' ? info.id : undefined
  if (provider === undefined || modelId === undefined) return info
  const modalities = decide(provider, modelId)
  if (modalities === undefined) return info
  return { ...info, inputModalities: [...modalities] }
}

/**
 * 对 `listModels` 的结果逐条应用。
 *
 * @param {object[]} models - 模型元数据数组。
 * @param {Function} decide - 模态决定。
 * @returns 新的数组。
 */
export function withModalitiesInList(models, decide) {
  if (!Array.isArray(models)) return models
  return models.map((entry) => withModalities(entry, decide))
}
