// intent.test.ts — intent 语义单点 (优先级/块主 intent 推导) 的单元测试。
import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import type { Fragment, OutputBlock } from '../types.ts'
import { blockIntent, INTENT_COLOR, INTENT_META, INTENT_RANK, topFragment } from './intent.ts'

function frag(rule: string, intent: Fragment['intent']): Fragment {
  return {
    rule,
    kind: 'signal',
    intent,
    category: 'build',
    confidence: 'high',
    block: [1, 1],
    out: [1, 1],
    text: 'x',
  }
}

function block(frags: Fragment[]): OutputBlock {
  return { start_line: 1, end_line: 1, rules: frags.map((f) => f.rule), fragments: frags }
}

test('INTENT_RANK: failure > warning > info (与引擎 intent_rank 语义一致)', () => {
  equal(INTENT_RANK.failure > INTENT_RANK.warning, true)
  equal(INTENT_RANK.warning > INTENT_RANK.info, true)
})

test('topFragment/blockIntent: 最高 intent 胜出, fragments 顺序无关', () => {
  const b = block([frag('a', 'info'), frag('b', 'failure'), frag('c', 'warning')])
  equal(topFragment(b)?.rule, 'b')
  equal(blockIntent(b), 'failure')
  // 顺序反转结论不变 (fragments[0] 未必最高 — 收敛前的三处 bug 形态)
  const rev = block([...b.fragments].reverse())
  equal(topFragment(rev)?.rule, 'b')
  equal(blockIntent(rev), 'failure')
})

test('blockIntent: 空块退化为 info (不可达防御)', () => {
  equal(blockIntent(block([])), 'info')
  equal(topFragment(block([])), undefined)
})

test('INTENT_META/INTENT_COLOR: 三 intent 全覆盖 (各自独立色板)', () => {
  deepEqual(Object.keys(INTENT_META).sort(), ['failure', 'info', 'warning'])
  deepEqual(Object.keys(INTENT_COLOR).sort(), ['failure', 'info', 'warning'])
  // 色板语义不同不强求一致: META = 徽章 bg+color 成对 (浅底深字), COLOR = 流内边条主色
  for (const k of Object.keys(INTENT_RANK) as Array<keyof typeof INTENT_RANK>) {
    equal(/^#/.test(INTENT_META[k].color), true)
    equal(/^#/.test(INTENT_COLOR[k]), true)
  }
})
