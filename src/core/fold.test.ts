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

test('foldRuns: no 断档 + 间无标注 → 延续合并 (跨虚拟化空洞)', () => {
  // 10-11 与 13-15 之间 no 12 不在场且无标注 → 对用户同样不可见 → 合并单段, span 含空洞
  deepEqual(
    foldRuns(entries([10, 11, 13, 14, 15]), () => false),
    [{ startNo: 10, endNo: 15 }],
  )
})

test('foldRuns: no 断档 + 间有标注 → 切段 (标注截断优先于空洞合并)', () => {
  const anno = new Set([12])
  deepEqual(
    foldRuns(entries([10, 11, 13, 14, 15]), (no) => anno.has(no)),
    [{ startNo: 13, endNo: 15 }],
  )
})

test('foldRuns: 多重断档全合并 + 跨洞 span 计数 (endNo - startNo + 1)', () => {
  // 命中只在 1 与 21: 2..20 全部无标注 (含 6-15 两个不在场空洞) → 单段, span=20
  deepEqual(
    foldRuns(entries([2, 3, 4, 5, 16, 17, 18, 19, 20]), (no) => no === 1 || no === 21),
    [{ startNo: 2, endNo: 20 }],
  )
})

test('foldRuns: 断档区间部分有标注 → 于标注处切段 (不问标注行是否在场)', () => {
  // no 12 有标注但不在场 (虚拟化回收) — 仍切段: 命中可能驻留洞中, 不可折叠跨越;
  // 16 无标注不在场 → 13-15 与 17-18 合并
  const anno = new Set([12])
  deepEqual(
    foldRuns(entries([10, 11, 13, 14, 15, 17, 18]), (no) => anno.has(no)),
    [{ startNo: 13, endNo: 18 }],
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
