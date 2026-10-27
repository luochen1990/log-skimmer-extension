// fold.test.ts — 折叠段计算纯函数的单测 (连续性/截断/下限/幂等形态)。
import { deepEqual } from 'node:assert/strict'
import { test } from 'node:test'
import type { LineEntry } from '../types.ts'
import { FOLD_MIN, foldRuns } from './fold.ts'

function entries(nos: number[]): LineEntry[] {
  return nos.map((no) => ({ no, text: '', el: {} as HTMLElement }))
}

test('FOLD_MIN: 段长下限常量语义 (≥3 才折)', () => {
  deepEqual(FOLD_MIN, 3)
})

test('foldRuns: 全无标注 → 单段', () => {
  deepEqual(
    foldRuns(entries([5, 6, 7, 8]), () => false),
    [{ startNo: 5, endNo: 8 }],
  )
})

test('foldRuns: 标注行截断 + 短段丢弃 (min=3)', () => {
  const anno = new Set([1, 5, 9])
  // 2-4 (3 行) 成段; 6-8 成段
  deepEqual(
    foldRuns(entries([1, 2, 3, 4, 5, 6, 7, 8, 9]), (no) => anno.has(no)),
    [
      { startNo: 2, endNo: 4 },
      { startNo: 6, endNo: 8 },
    ],
  )
})

test('foldRuns: 段长 < min 不折 (1-2 行噪音保留)', () => {
  const anno = new Set([3, 6])
  deepEqual(
    foldRuns(entries([1, 2, 3, 4, 5, 6]), (no) => anno.has(no)),
    [],
  )
})

test('foldRuns: no 断档切段 (虚拟化窗口缺行不在场)', () => {
  // 10 与 13 断档: 各自成段但 10-11 只有 2 行 < min; 13-15 成段
  deepEqual(
    foldRuns(entries([10, 11, 13, 14, 15]), () => false),
    [{ startNo: 13, endNo: 15 }],
  )
})

test('foldRuns: 乱序输入 (增量批次根序) 与有序等价', () => {
  const anno = new Set([2])
  deepEqual(
    foldRuns(entries([5, 1, 3, 4]), (no) => anno.has(no)),
    [{ startNo: 3, endNo: 5 }],
  )
})

test('foldRuns: 空输入 / 单行输入', () => {
  deepEqual(
    foldRuns([], () => false),
    [],
  )
  deepEqual(
    foldRuns(entries([1]), () => false),
    [],
  )
})
