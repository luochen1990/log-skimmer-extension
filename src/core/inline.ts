// inline.ts — 原生流内辅助注入 (呈现双轨之辅轨)。
// 契约: 输入 行级标注 Map<lineKey, {intent, category, rule}> (状态外置, 由 controller
//       依 adapter 坐标映射生成); 对 DOM 中在场的行施加 intent 边条/背景/悬浮说明。
// 幂等: 已注入行跳过 (data-lsk 签名比对); 行被虚拟化重建后由 ReplayDriver 重放。
// 不持有任何页面选择器知识 — 选择器全在 adapter (lineKey 的语义也由 adapter 定义)。

import type { Intent } from '../types.ts'

export const INTENT_COLOR: Record<Intent, string> = {
  failure: '#cf222e',
  warning: '#9a6700',
  info: '#0969da',
}

export interface Annotation {
  sig: string
  intent: Intent
  category: string
  rule: string
}

export class InlineInjector {
  private styleEl: HTMLStyleElement | null = null
  enabled = true
  readonly stats = { applied: 0, replayed: 0 }

  ensureStyle(doc: Document): void {
    if (this.styleEl) return
    const st = doc.createElement('style')
    st.id = 'lsk-inline-style'
    st.textContent = `
.lsk-inline { border-left: 3px solid var(--lsk-c) !important; background: color-mix(in srgb, var(--lsk-c) 12%, transparent) !important; }
.lsk-inline:hover::after { content: attr(data-lsk-tip); position: absolute; left: calc(100% - 2px); transform: translateX(-100%) translateY(-100%);
  background: #24292f; color: #fff; font: 11px/1.4 ui-monospace, monospace; padding: 3px 8px; border-radius: 4px; white-space: nowrap; z-index: 99999; }`
    doc.head.appendChild(st)
    this.styleEl = st
  }

  /** 对单个行元素施加标注 (幂等)。replay=true 时计入重放统计。 */
  apply(lineEl: HTMLElement, anno: Annotation, opts: { replay?: boolean } = {}): boolean {
    if (!lineEl || lineEl.dataset.lsk === anno.sig) return false
    const c = INTENT_COLOR[anno.intent]
    lineEl.dataset.lsk = anno.sig
    lineEl.classList.add('lsk-inline')
    lineEl.style.setProperty('--lsk-c', c)
    lineEl.style.position = lineEl.style.position || 'relative'
    lineEl.dataset.lskTip = `skim: ${anno.intent}/${anno.category} [${anno.rule}]`
    if (opts.replay) this.stats.replayed++
    else this.stats.applied++
    return true
  }

  /**
   * 开关 (B1 教训): off = 移除全部注入痕迹**含幂等签名** — 否则重放对新行注入、
   * 旧行残留的混合态; on 由 controller 补一次主动 sync (无 DOM 变更则无重放事件)。
   */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.clearAll()
  }

  /** 清除全部注入痕迹 (开关 off / 规则刷新重注入前的全清)。 */
  clearAll(): void {
    this.styleEl?.ownerDocument.querySelectorAll('.lsk-inline').forEach((el) => {
      el.classList.remove('lsk-inline')
      delete (el as HTMLElement).dataset.lsk
      ;(el as HTMLElement).style.removeProperty('--lsk-c')
    })
  }

  /** 批量: 现场行 → 查标注表注入。返回本次注入数。 */
  applyAll(
    lineEls: HTMLElement[],
    annotations: Map<string, Annotation>,
    lineKeyOf: (el: HTMLElement) => string | undefined,
    opts: { replay?: boolean } = {},
  ): number {
    if (!this.enabled) return 0
    let n = 0
    for (const el of lineEls) {
      const anno = annotations.get(lineKeyOf(el) ?? '')
      if (anno && this.apply(el, anno, opts)) n++
    }
    return n
  }
}
