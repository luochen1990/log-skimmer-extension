// intent.ts — intent 语义单点: 优先级/颜色/展示元数据/块主 intent 推导。
// 收敛此前散落三处的重复表 (controller 排序 / inline 配色 / overlay 图标)。

import type { Fragment, Intent, OutputBlock } from '../types.ts'

/** 同行/同块多规则: 高 intent 胜出 (failure > warning > info, 与引擎 intent_rank 一致 — 引擎 rank 越小越优先, 语义相同)。 */
export const INTENT_RANK: Record<Intent, number> = { failure: 3, warning: 2, info: 1 }

export const INTENT_COLOR: Record<Intent, string> = {
  failure: '#cf222e',
  warning: '#9a6700',
  info: '#0969da',
}

export const INTENT_META: Record<Intent, { icon: string; color: string; bg: string }> = {
  failure: { icon: '✕', color: '#cf222e', bg: '#ffebe9' },
  warning: { icon: '⚠', color: '#82460a', bg: '#fff8c5' },
  info: { icon: 'ℹ', color: '#0969da', bg: '#ddf4ff' },
}

/** 块内最高优先级 fragment (图标/配色/类别/emit 单点 — fragments[0] 未必最高)。 */
export function topFragment(block: OutputBlock): Fragment | undefined {
  return block.fragments.reduce<Fragment | undefined>(
    (best, f) => (!best || INTENT_RANK[f.intent] > INTENT_RANK[best.intent] ? f : best),
    undefined,
  )
}

/** 块主 intent = 全 fragments 的最高优先级 (计数/选 tab 用此单点)。 */
export function blockIntent(block: OutputBlock): Intent {
  return topFragment(block)?.intent ?? 'info'
}
