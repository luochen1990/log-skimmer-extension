// fold.ts — 流内噪音折叠 (呈现双轨之辅轨的降噪层)。
// 契约: 池内连续无标注行段 (≥ FOLD_MIN) 隐藏 — 行元素加 class (绝不 remove/detach 页面
//       节点), 段首插入占位行 "⋯ N lines", 点击展开该段。占位行是外来节点, 页面重建
//       (GitHub 虚拟化) 后由 ReplayDriver 幂等重放重建; 用户展开过的段记入 userExpanded
//       (外置状态), 重放/滚动回看不复活。
// 性质: applyPool 幂等 (行签名 data-lsk-fold + 占位行 data-lsk-ph 比对, 重复调用零副作用);
//       计算只吃调用方给的 entries (增量 sync = 变更子树行), 不做全池重扫。

import type { LineEntry } from '../types.ts'

/** 段长下限: 短于此的连续无标注段不值得折 (折放成本 > 扫读成本)。 */
export const FOLD_MIN = 3

/** 连续无标注行段 (no 闭区间; no 语义与 LineEntry 一致, 由调用方的 lineKey 体系定义)。 */
export interface FoldRun {
  startNo: number
  endNo: number
}

/**
 * 纯函数: entries 中的最长连续无标注段。连续性按 no 相邻 (=== +1) 判定 — 虚拟化窗口
 * 的 no 断档 (未 attach 的行不在场) 自然切段; 标注行截断段。entries 无需有序。
 */
export function foldRuns(entries: LineEntry[], isAnno: (no: number) => boolean, min = FOLD_MIN): FoldRun[] {
  const sorted = [...entries].sort((a, b) => a.no - b.no)
  const runs: FoldRun[] = []
  let start: number | null = null
  let prevNo = Number.NaN
  const close = () => {
    if (start !== null && prevNo - start + 1 >= min) runs.push({ startNo: start, endNo: prevNo })
    start = null
  }
  for (const e of sorted) {
    if (isAnno(e.no) || (start !== null && e.no !== prevNo + 1)) close()
    if (!isAnno(e.no) && start === null) start = e.no
    prevNo = e.no
  }
  close()
  return runs
}

/**
 * 折叠注入器 (页面级, 与 InlineInjector 同构: 样式单件 + 幂等 apply + 可逆 clear)。
 * 不持有页面选择器知识 — 池/行语义由调用方 (controller) 经 entries 传入。
 */
export class FoldInjector {
  enabled = true
  private styleEl: HTMLStyleElement | null = null
  /** 用户点开过的段 (foldKey = `${stepKey}:${startNo}`) — 重放不复活 (用户意图优先)。 */
  private readonly userExpanded = new Set<string>()

  ensureStyle(doc: Document): void {
    if (this.styleEl) return
    const st = doc.createElement('style')
    st.id = 'lsk-fold-style'
    st.textContent = `
.lsk-folded { display: none !important; }
.lsk-fold-ph { cursor: pointer; text-align: center; user-select: none;
  color: #8c959f; font: 11px/1.7 ui-monospace, SFMono-Regular, monospace; letter-spacing: .3px; }
.lsk-fold-ph:hover { color: #0969da; background: rgba(9,105,218,.07); }
@media (prefers-color-scheme: dark) {
  .lsk-fold-ph { color: #6e7681; }
  .lsk-fold-ph:hover { color: #4493f8; background: rgba(56,139,253,.12); }
}`
    doc.head.appendChild(st)
    this.styleEl = st
  }

  /**
   * 单池折叠注入 (幂等): runs → 行隐藏 + 段首占位行。entries = 本次 sync 目标行
   * (占位行插入点 = 段首行的 previousElementSibling)。返回本次新折叠行数。
   */
  applyPool(stepKey: string, runs: FoldRun[], entries: LineEntry[], opts: { replay?: boolean } = {}): number {
    if (!this.enabled || runs.length === 0) return 0
    const byNo = new Map(entries.map((e) => [e.no, e]))
    let folded = 0
    for (const run of runs) {
      const key = `${stepKey}:${run.startNo}`
      if (this.userExpanded.has(key)) continue
      let first: HTMLElement | null = null
      for (let no = run.startNo; no <= run.endNo; no++) {
        const el = byNo.get(no)?.el
        if (!el) continue
        if (el.dataset.lskFold !== key) {
          el.dataset.lskFold = key
          el.classList.add('lsk-folded')
          folded++
        }
        if (!first) first = el
      }
      if (!first) continue
      const prev = first.previousElementSibling
      if (
        prev instanceof HTMLElement &&
        prev.classList.contains('lsk-fold-ph') &&
        prev.dataset.lskPh === key
      ) {
        continue
      }
      const ph = first.ownerDocument.createElement('div')
      ph.className = 'lsk-fold-ph'
      ph.dataset.lskPh = key
      ph.textContent = `⋯ ${run.endNo - run.startNo + 1} lines`
      ph.title = 'click to expand this skipped range'
      ph.setAttribute('role', 'button')
      ph.onclick = () => this.expand(key)
      first.insertAdjacentElement('beforebegin', ph)
    }
    if (opts.replay) this.stats.replayed += folded
    else this.stats.applied += folded
    return folded
  }

  readonly stats = { applied: 0, replayed: 0 }

  /** 展开单段 (占位行点击): 解除该段全部行隐藏 + 移除占位行 + 记入 userExpanded。 */
  expand(key: string): void {
    const doc = this.styleEl?.ownerDocument
    if (!doc) return
    const sel = `[data-lsk-fold="${CSS.escape(key)}"]`
    for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
      el.classList.remove('lsk-folded')
      delete el.dataset.lskFold
    }
    for (const ph of doc.querySelectorAll(`[data-lsk-ph="${CSS.escape(key)}"]`)) ph.remove()
    this.userExpanded.add(key)
  }

  /** 开关 (B1 教训): off = 全清注入痕迹 (占位行 + 行隐藏); on 由 controller 补 sync。 */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.clearAll()
  }

  /** 剥除单个行元素的折叠痕迹。 */
  private static strip(el: HTMLElement): void {
    el.classList.remove('lsk-folded')
    delete el.dataset.lskFold
  }

  /** 全清 (开关 off / reskim 重注入前): 移除占位行 + 解除全部行隐藏。userExpanded 保留。 */
  clearAll(): void {
    const doc = this.styleEl?.ownerDocument
    if (!doc) return
    doc.querySelectorAll('.lsk-fold-ph').forEach((ph) => {
      ph.remove()
    })
    doc.querySelectorAll('[data-lsk-fold]').forEach((el) => {
      FoldInjector.strip(el as HTMLElement)
    })
  }

  /** 池内清 (池漂移 stripPool 后): scope 限定池子, 其他池零打扰。 */
  clearPool(pool: Element): void {
    pool.querySelectorAll('.lsk-fold-ph').forEach((ph) => {
      ph.remove()
    })
    pool.querySelectorAll('[data-lsk-fold]').forEach((el) => {
      FoldInjector.strip(el as HTMLElement)
    })
  }

  /** 池前缀失效: 该池的 userExpanded 记录作废 (对齐重建后旧段边界不再有意义)。 */
  clearExpandedPrefix(prefix: string): void {
    for (const k of this.userExpanded) if (k.startsWith(prefix)) this.userExpanded.delete(k)
  }
}
