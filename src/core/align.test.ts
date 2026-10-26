// align.test.ts — 对齐器单元测试 (归一化四件套 + 两指针单调对齐性质)。
import { deepEqual, equal, notEqual } from 'node:assert/strict'
import { test } from 'node:test'
import type { LineEntry } from '../types.ts'
import { alignStep, normLine, poolFingerprint } from './align.ts'

function entry(no: number, text: string): LineEntry {
  return { no, text, el: {} as HTMLElement }
}

test('normLine: 剥 BOM/CR/CSI/空白折叠', () => {
  equal(normLine('\uFEFFhello\r'), 'hello')
  equal(normLine('a \t b   c'), 'a b c')
  equal(normLine('\x1b[31mred\x1b[0m text'), 'red text')
})

test('normLine: 前缀时间戳循环剥层 (forgejo 双时间戳)', () => {
  equal(normLine('2026-10-25T18:22:14Z hello'), 'hello')
  equal(normLine('2026-10-25T18:22:14Z 2026-10-25T18:22:15.123Z hello'), 'hello')
  // 裸时间戳行: 剥尽为空 — 两侧对称归 "" (T4 坑 A-2)
  equal(normLine('2026-10-25T18:22:14Z '), '')
  equal(normLine('2026-10-25T18:22:14.000Z'), '')
  // nbsp 空行 (DOM 侧) 与空行折叠一致
  equal(normLine(' '), '')
})

test('alignStep: 完美匹配的单调对齐', () => {
  const full = ['a', 'b', 'c', 'd', 'e']
  const dom = [entry(1, 'b'), entry(2, 'c')]
  const r = alignStep(dom, full)
  equal(r.noToFull.get(1), 1)
  equal(r.noToFull.get(2), 2)
  deepEqual(r.stats, { domLines: 2, matched: 2, unmatched: 0 })
})

test('alignStep: ±window 容忍局部错位, used-set 不重复消费', () => {
  // full 有重复文本: 第二个 'x' 不可被再次消费
  const full = ['x', 'x', 'y', 'z']
  const dom = [entry(1, 'x'), entry(2, 'x')]
  const r = alignStep(dom, full)
  equal(r.noToFull.get(1), 0)
  equal(r.noToFull.get(2), 1)
  equal(r.stats.unmatched, 0)
})

test('alignStep: 未命中计 unmatched (对齐质量可见)', () => {
  const r = alignStep([entry(1, 'nope')], ['a', 'b'])
  equal(r.stats.unmatched, 1)
  equal(r.stats.matched, 0)
  equal(r.firstFull, null)
})

test('alignStep: DOM 侧带时间戳/全量侧双时间戳 (forgejo 实形态)', () => {
  const full = ['2026-01-01T00:00:00Z 2026-01-01T00:00:01Z build ok', 'next']
  const dom = [entry(1, '2026-01-01T00:00:01Z build ok'), entry(2, 'next')]
  const r = alignStep(dom, full)
  equal(r.stats.matched, 2)
})

test('poolFingerprint: 行数/任一行文本变化 → 指纹变化 (同数异容可察)', () => {
  const a = [entry(1, 'x'), entry(2, 'y'), entry(3, 'z')]
  equal(poolFingerprint(a), poolFingerprint([entry(9, 'x'), entry(8, 'y'), entry(7, 'z')])) // no 不参与 (纯内容指纹)
  notEqual(poolFingerprint(a), poolFingerprint([entry(1, 'x'), entry(2, 'y')])) // 行数变
  notEqual(poolFingerprint(a), poolFingerprint([entry(1, 'x'), entry(2, 'M'), entry(3, 'z')])) // 中段变 (同数异容)
  equal(poolFingerprint([]), '0 ') // 空池退化形态稳定
})

test('alignStep: 中段子序列可对齐 (首行锚定 — 多 step 非首段/段起点漂移形态)', () => {
  const full = ['head1', 'head2', 'a', 'b', 'c', 'd', 'tail1', 'tail2']
  const dom = [entry(1, 'c'), entry(2, 'd')]
  const r = alignStep(dom, full)
  equal(r.noToFull.get(1), 4)
  equal(r.noToFull.get(2), 5)
  equal(r.stats.matched, 2)
})

test('alignStep: 首行锚定不影响前缀段 (锚点=0 退化)', () => {
  const full = ['a', 'b', 'c']
  const r = alignStep([entry(1, 'a'), entry(2, 'b')], full)
  equal(r.noToFull.get(1), 0)
  equal(r.noToFull.get(2), 1)
})
