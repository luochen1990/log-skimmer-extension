// github.ts — GitHub Actions 日志页适配器 (依据 spike T3 DOM-REPORT, 仿真 fixture 驱动)。
// 关键事实 (DOM-REPORT 2026-10-26, [源码]/[第三方] 分级):
//   step 根: check-step[data-log-url] web component; 折叠体 details.js-checks-log-details
//   行: 外壳 div[data-index] (0-based 逻辑行号, 含隐藏行) > div.js-check-step-line.CheckStep-line
//       (.CheckStep-line-number 行号锚 + .js-check-line-content 内容, ANSI→span)
//   虚拟化: 50 行/cluster, 视口 ±50 行窗口 attach, 窗口外 wrapper 清空占位
//   重渲染: step 展开即清空重建 (parser.setData("") + logsContainer.textContent="")
//   数据: data-log-url 即 step 全量日志端点 (登录态有效; 匿名 404 — 登录墙降级路径)
// 坐标映射: data-index = 0-based 逻辑行号, 与日志文本行 1-based 直接换算 (i = data-index + 1)。
//
// TODO(hiddenLineCount — 登录态实测后校准, spike T3 遗留):
//   [T3 §1] 显示行号 (.CheckStep-line-number 文本) 与 data-index 可差 hiddenLineCount
//   (隐藏行: debug/内部命令行不渲染编号?)。本适配器以 data-index 为寻址 SSOT;
//   待实测确认的语义: data-log-url 返回的原始文本是否含隐藏行。若含 → 现有直映正确;
//   若不含 → annotateStep/fullToKey 需按 per-step hiddenLineCount 补偏移 (只改这两处)。
//   fixture (fixtures/github) 按 "文本行 ↔ data-index 一一对应" 建模了已知语义。

import { topFragment } from '../core/intent.ts'
import type { Adapter, LineEntry, LoadedSource, LogSource, OutputBlock } from '../types.ts'

function lineEntriesIn(scope: Element): LineEntry[] {
  const rows = [...scope.querySelectorAll<HTMLElement>('[data-index]')]
  if (scope instanceof HTMLElement && scope.dataset.index !== undefined) rows.unshift(scope)
  return rows
    .map((el) => ({
      no: Number(el.dataset.index), // 0-based 逻辑行号 (寻址 SSOT)
      text: el.querySelector('.js-check-line-content')?.textContent ?? el.textContent ?? '',
      el,
    }))
    .filter((l) => Number.isInteger(l.no))
}

export const githubAdapter = {
  name: 'github',
  contentAligned: false,
  // match 依赖 Turbo 渐进渲染的 DOM (check-step 迟到) → boot 未命中时有界重探。
  deferProbe: true,

  match(doc) {
    // DOM 识别 (零 IO): check-step 在场即 Actions 日志页 (run/job/commit-checks 页通用)。
    // 不要求 data-log-url 在场 — 匿名登录墙下属性仍在, 但运行中/无日志 step 可能缺失,
    // 缺失时 controller 走 "无日志端点" 诊断而非静默退出。
    return !!doc.querySelector('check-step')
  },

  /** 每 step 一个独立数据源 (data-log-url); 无 data-log-url 的 step 不产源。 */
  logSources(doc: Document) {
    return [...doc.querySelectorAll<HTMLElement>('check-step')]
      .filter((el) => el.getAttribute('data-log-url'))
      .map((el, i) => {
        const url = el.getAttribute('data-log-url') ?? ''
        const num = el.getAttribute('data-number') ?? String(i + 1)
        const name = el.getAttribute('data-name') ?? ''
        return {
          key: url,
          url,
          fileName: `step-${num}.log`,
          label: `step ${num}: ${name}`.slice(0, 40),
        } satisfies LogSource
      })
  },

  /** stepKey 严格匹配 (无兜底): 兜底会把别的 step 的源标注到本池 → 错位高亮。 */
  sourceForStep(loaded, stepKey) {
    return loaded.find((s) => s.key === stepKey)
  },

  /** 块(源内坐标) → 行标注: data-index 直映 (0-based ↔ 1-based 换算), 无需对齐。 */
  annotateStep(src, stepKey, _lines, emit) {
    if (!src.ok) return null
    for (const blk of src.result.blocks) {
      const frag = topFragment(blk)
      if (!frag) continue
      for (let ln = blk.start_line; ln <= blk.end_line; ln++) {
        emit(githubAdapter.lineKey(stepKey, ln - 1), frag)
      }
    }
    return null
  },

  observeRoot(doc) {
    // body 而非 .js-check-steps: GitHub Turbo 导航会整块替换日志区容器,
    // 挂 body 可存活容器替换 (URL 变更由 controller 检测重载)。
    return doc.body
  },

  stepLogs(doc) {
    return [...doc.querySelectorAll<HTMLElement>('.js-checks-log-display-container')].filter((el) =>
      el.querySelector('[data-index]'),
    )
  },

  stepKeyOf(containerEl) {
    return containerEl.closest('check-step')?.getAttribute('data-log-url') ?? 'unknown-step'
  },

  linesOf(poolEl) {
    return lineEntriesIn(poolEl)
  },

  /** 增量 sync: 只枚举 mutation 新增子树内的行 (cluster wrapper 或单行外壳)。 */
  linesIn(subtree) {
    return lineEntriesIn(subtree)
  },

  lineKey(stepKey, no) {
    return `${stepKey}#${no}` // no 为 0-based data-index
  },

  poolKeyPrefix(stepKey) {
    return `${stepKey}#`
  },

  /**
   * 跳转: 行可能被虚拟化 detach → 先滚到所属 cluster 占位符, attach 后重试高亮。
   * 注意: `.lsk-cluster[data-start]` 是 fixtures/github/sim.js 的 fixture 契约
   * (真实 GitHub DOM 的 cluster wrapper 选择器待登录态校准 — T3 §3 只给出
   * `wrapper.style.height` 语义未给 class; 校准时只需改此处选择器)。
   */
  jumpTo(_src: LoadedSource, blk: OutputBlock) {
    const idx = blk.start_line - 1
    const direct = document.querySelector(`[data-index='${idx}']`)
    if (direct) {
      flash(direct)
      return true
    }
    const target = [...document.querySelectorAll<HTMLElement>('.lsk-cluster[data-start]')].find(
      (c) => idx >= Number(c.dataset.start) && idx <= Number(c.dataset.end),
    )
    if (target) {
      target.scrollIntoView({ block: 'center' })
      const t = setInterval(() => {
        const el = document.querySelector(`[data-index='${idx}']`)
        if (el) {
          clearInterval(t)
          flash(el)
        }
      }, 80)
      setTimeout(() => clearInterval(t), 3000)
      return true
    }
    return false
  },
} satisfies Adapter

function flash(el: Element): void {
  el.scrollIntoView({ block: 'center' })
  el.animate?.([{ background: '#fff3cd' }, { background: '' }], { duration: 1200 })
}
