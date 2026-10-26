// align.ts — 全量日志行 ↔ step 内 DOM 行 的两指针对齐器 (forgejo 用)。
// 问题: 数据外置 skim 的块坐标是全量日志行号; forgejo DOM 行是 step 内局部行号,
//       且 step 边界/runner 前导行不渲染。用文本内容单调对齐求映射。
// 契约: domLines 为 [{no, text}] (DOM 顺序), fullLines 为全量文本行数组 (0-based)。
//       返回 {noToFull, firstFull, lastFull, stats}。
// 韧性: 每行容许 ±window 的局部回溯/前跳 (吸收 forgejo 丢弃 ##[group] 边界行等偏差),
//       未命中记 null 并计入 stats.unmatched — 调用方可断言对齐质量。

import type { LineEntry } from '../types.ts'

const TS_RE = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s?/
// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI (ANSI 转义) 序列匹配是本归一化器的职责本体
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g // CSI 序列 (SGR 及光标类); forgejo/GitHub 渲染侧均剥除

export function normLine(s: string): string {
  let t = s
    .replace(/\uFEFF/g, '')
    .replace(/\r/g, '')
    .replace(ANSI_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  // 前缀时间戳可能叠两层 (forgejo runner 前缀 + cat 内容自带); 渲染侧只保留内容层,
  // 全量文本侧双层都在 — 循环剥到不再匹配。剥尽为空 (裸时间戳行/空行) 两侧都归一为
  // "" (JS \s 覆盖 U+00A0, DOM 的 nbsp 空行同样折叠) — 保持对称, 否则空行错配。
  for (;;) {
    const n = t.replace(TS_RE, '')
    if (n === t) return t
    t = n
  }
}

export interface AlignStepResult {
  noToFull: Map<number, number>
  firstFull: number | null
  lastFull: number | null
  stats: { domLines: number; matched: number; unmatched: number }
}

/**
 * 池指纹 = 行数 + 全部行文本 — contentAligned 池的漂移哨兵。
 * 同数异容 (重渲染换文本) 也能察觉, 优于纯行数; 取全量拼接而非首末行采样
 * (首末采样对中段漂移有盲区)。controller (grown 判定) 与 forgejo (对齐缓存
 * 失效) 必须用同一公式, 故收敛在此单点。
 */
export function poolFingerprint(lines: LineEntry[]): string {
  return `${lines.length} ${lines.reduce((acc, l) => acc + l.text, '')}`
}

export function alignStep(
  domLines: LineEntry[],
  fullLines: string[],
  opts: { window?: number } = {},
): AlignStepResult {
  const W = opts.window ?? 6
  const fullNorm = fullLines.map(normLine)
  const noToFull = new Map<number, number>()
  const used = new Set<number>()
  // 首行锚定: DOM 行集可能对应全量的任意连续段 (多 step: 非首 step 的段在中部;
  // 重渲染: 段起点漂移), 单调游标从 0 起步追不上中段 — 先全局定位首行作游标初值。
  let cursor = 0
  const first = domLines[0]
  if (first) {
    const t = normLine(first.text)
    const anchor = fullNorm.findIndex((l, i) => l === t && !used.has(i))
    if (anchor >= 0) cursor = anchor
  }
  let matched = 0
  let unmatched = 0
  for (const dl of domLines) {
    const target = normLine(dl.text)
    let hit: number | null = null
    for (let k = 0; k <= W && hit === null; k++) {
      for (const idx of [cursor + k, cursor - k]) {
        if (idx >= 0 && idx < fullNorm.length && !used.has(idx) && fullNorm[idx] === target) {
          hit = idx
          break
        }
      }
    }
    if (hit !== null) {
      noToFull.set(dl.no, hit)
      used.add(hit)
      cursor = hit + 1
      matched++
    } else {
      unmatched++
    }
  }
  const vals = [...noToFull.values()]
  return {
    noToFull,
    firstFull: vals.length ? Math.min(...vals) : null,
    lastFull: vals.length ? Math.max(...vals) : null,
    stats: { domLines: domLines.length, matched, unmatched },
  }
}
