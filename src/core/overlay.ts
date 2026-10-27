// overlay.ts — skim 视图 overlay (呈现双轨之主轨)。
// 职责: 悬浮面板只渲染 skim 块 (intent 图标/颜色 + category 标签 + 行坐标 + context
//       展开), 块间未匹配区折叠为 "⋯ N lines"; 与页面虚拟化/懒加载完全解耦
//       (数据全量外置, 渲染不依赖行 DOM 在场)。
// 降级呈现: 源级失败 (fetch 403/登录墙等) → 该源 tab 呈现错误框; 全局诊断 (规则/
//       wasm 阶段) → 底部诊断条 (哪个环节/为什么/怎么办)。规则信息条含 stale 提示
//       与手动刷新入口。
// 联动: 块/行点击 → onJump(block) 回调 (controller 接 adapter 滚动原生流内对应行)。

import { APP_VERSION } from '../generated/version.ts'
import type { Diag, Intent, OutputBlock, SkimResult } from '../types.ts'
import { blockIntent, INTENT_META, topFragment } from './intent.ts'

/** 静态自有元素查找 — 找不到即内部结构错误, 显式抛错优于静默。 */
function must<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel)
  if (!el) throw new Error(`[logskim] internal: ${sel} missing`)
  return el
}

export interface OverlaySource {
  label: string
  fileName: string
  text?: string
  result?: SkimResult
  error?: string
}

export interface RulesInfo {
  ruleCount: number
  generatedAt: string
  fetchedAt: number
  source: 'cache' | 'network'
  stale: boolean
}

export interface OverlayInit {
  onJump: (block: OutputBlock, srcIdx: number) => void
  onToggleInline: (on: boolean) => void
  /** 规则刷新 (异步); overlay 在 Promise 落定前禁用按钮 (防连点)。 */
  onRefreshRules: () => Promise<void>
}

export class SkimOverlay {
  private doc!: Document
  private root!: HTMLDivElement
  private metaEl!: HTMLElement
  private rulesChip!: HTMLElement
  private tabsEl!: HTMLElement
  private bodyEl!: HTMLElement
  private diagEl!: HTMLElement
  private sources: OverlaySource[] = []
  private srcIdx = 0
  private inlineOn = true

  constructor(private readonly init: OverlayInit) {}

  mount(doc: Document): void {
    if (this.root) return
    this.doc = doc
    const fab = doc.createElement('button')
    fab.id = 'lsk-fab'
    fab.textContent = 'skim'
    Object.assign(fab.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483600',
      background: '#1f2328',
      color: '#fff',
      border: 'none',
      borderRadius: '18px',
      padding: '8px 16px',
      font: '600 13px ui-sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,.35)',
    })
    fab.onclick = () => this.toggle()
    doc.body.appendChild(fab)

    const css = doc.createElement('style')
    css.textContent = `
#lsk-overlay { position:fixed; right:16px; top:16px; bottom:64px; width:560px; z-index:2147483600; display:none;
  flex-direction:column; background:#fff; color:#1f2328; border-radius:10px; border:1px solid #d1d9e0;
  box-shadow:0 8px 32px rgba(0,0,0,.3); font:12px/1.5 ui-sans-serif,system-ui; }
#lsk-overlay .lsk-hd { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid #d1d9e0; flex-wrap:wrap; }
#lsk-overlay .lsk-hd b { font-size:13px; }
#lsk-overlay .lsk-meta { color:#57606a; font:11px ui-monospace,monospace; }
#lsk-overlay .lsk-ver { color:#82460a; font:11px ui-monospace,monospace; }
#lsk-overlay .lsk-hd .lsk-sp { margin-left:auto; display:flex; gap:4px; align-items:center; }
#lsk-overlay .lsk-tabs { display:flex; gap:4px; padding:6px 14px 0; flex-wrap:wrap; }
#lsk-overlay .lsk-bd { overflow:auto; flex:1; padding:6px 0; }
#lsk-overlay .lsk-blk { padding:7px 14px; }
#lsk-overlay .lsk-blk.sel { outline: 2px solid #0969da; outline-offset:-2px; }
#lsk-overlay .lsk-row { display:flex; align-items:center; gap:8px; cursor:pointer; }
#lsk-overlay .lsk-row:hover { background:#f6f8fa; }
#lsk-overlay .lsk-ic { width:18px; height:18px; border-radius:9px; display:inline-flex; align-items:center; justify-content:center; font:700 11px ui-monospace; flex:none; }
#lsk-overlay .lsk-cat { font:600 10px ui-sans-serif; padding:1px 7px; border-radius:9px; }
#lsk-overlay .lsk-lines { color:#57606a; font:11px ui-monospace,monospace; margin-left:auto; flex:none; }
#lsk-overlay .lsk-ctx { display:none; margin:6px 0 0 26px; padding:6px 10px; background:#f6f8fa; border-radius:6px;
  font:11px/1.45 ui-monospace,monospace; white-space:pre-wrap; word-break:break-all; max-height:180px; overflow:auto; }
#lsk-overlay .lsk-blk.open .lsk-ctx { display:block; }
#lsk-overlay .lsk-gap { text-align:center; color:#8c959f; font:11px ui-monospace,monospace; padding:2px 0; user-select:none; }
#lsk-overlay button.lsk-mini { font:11px ui-sans-serif; padding:3px 10px; border:1px solid #d1d9e0; border-radius:6px; background:#fff; cursor:pointer; }
#lsk-overlay button.lsk-mini.on { background:#ddf4ff; border-color:#0969da; color:#0969da; }
#lsk-overlay .lsk-chip { font:10px ui-monospace,monospace; color:#57606a; padding:2px 7px; border:1px solid #d1d9e0; border-radius:9px; }
#lsk-overlay .lsk-chip.stale { background:#fff8c5; border-color:#9a6700; color:#82460a; }
#lsk-overlay .lsk-err { margin:10px 14px; padding:10px 12px; background:#ffebe9; border:1px solid #cf222e;
  border-radius:8px; font:11px/1.5 ui-monospace,monospace; white-space:pre-wrap; }
#lsk-overlay .lsk-diags { border-top:1px solid #d1d9e0; padding:6px 14px; display:none; max-height:120px; overflow:auto; }
#lsk-overlay .lsk-diags .lsk-diag { padding:3px 0; font:11px/1.4 ui-sans-serif; }
#lsk-overlay .lsk-diags .lsk-diag b { color:#cf222e; }
#lsk-overlay .lsk-diags .lsk-diag .lsk-hint { color:#57606a; display:block; }`
    doc.head.appendChild(css)

    const p = doc.createElement('div')
    p.id = 'lsk-overlay'
    p.innerHTML = `
<div class="lsk-hd"><b>skim</b> <span class="lsk-ver" title="extension build version — chrome://extensions card must match">v${APP_VERSION}</span> <span class="lsk-meta" id="lsk-meta"></span>
  <span class="lsk-sp">
    <span class="lsk-chip" id="lsk-rules-chip" title="rules bundle"></span>
    <button class="lsk-mini" id="lsk-refresh" title="refresh rules bundle (re-skim)">⟳ rules</button>
    <button class="lsk-mini on" id="lsk-inline-btn" title="toggle inline annotations">inline: on</button>
    <button class="lsk-mini" id="lsk-close">✕</button>
  </span></div>
<div class="lsk-tabs" id="lsk-tabs"></div>
<div class="lsk-bd" id="lsk-body"></div>
<div class="lsk-diags" id="lsk-diags"></div>`
    doc.body.appendChild(p)
    this.root = p
    this.metaEl = must<HTMLElement>(p, '#lsk-meta')
    this.rulesChip = must<HTMLElement>(p, '#lsk-rules-chip')
    this.tabsEl = must<HTMLElement>(p, '#lsk-tabs')
    this.bodyEl = must<HTMLElement>(p, '#lsk-body')
    this.diagEl = must<HTMLElement>(p, '#lsk-diags')
    must<HTMLButtonElement>(p, '#lsk-close').onclick = () => this.toggle()
    const refreshBtn = must<HTMLButtonElement>(p, '#lsk-refresh')
    refreshBtn.onclick = () => {
      refreshBtn.disabled = true // pending (n8): 落定前禁用, 防重复刷新
      void this.init.onRefreshRules().finally(() => {
        refreshBtn.disabled = false
      })
    }
    const inlineBtn = must<HTMLButtonElement>(p, '#lsk-inline-btn')
    inlineBtn.onclick = () => {
      this.inlineOn = !this.inlineOn
      inlineBtn.textContent = `inline: ${this.inlineOn ? 'on' : 'off'}`
      inlineBtn.classList.toggle('on', this.inlineOn)
      this.init.onToggleInline(this.inlineOn)
    }
  }

  toggle(): void {
    const open = this.root.style.display !== 'flex'
    this.root.style.display = open ? 'flex' : 'none'
  }

  /** 强制打开 (致命降级路径自动呈现诊断)。 */
  open(): void {
    this.root.style.display = 'flex'
  }

  /** 多源渲染入口 (forgejo=整 job 单源 / github=每 step 一源); 失败源呈现错误框。 */
  renderSources(sources: OverlaySource[]): void {
    this.sources = sources
    this.tabsEl.innerHTML = ''
    sources.forEach((s, i) => {
      const t = this.doc.createElement('button')
      t.className = 'lsk-mini'
      t.textContent = s.label
      t.onclick = () => this.selectSource(i)
      this.tabsEl.appendChild(t)
    })
    const failIdx = sources.findIndex((s) => s.result?.blocks.some((b) => blockIntent(b) === 'failure'))
    this.selectSource(Math.max(failIdx, 0))
  }

  selectSource(i: number): void {
    this.srcIdx = i
    for (const [k, el] of [...this.tabsEl.children].entries()) {
      el.classList.toggle('on', k === i)
    }
    const s = this.sources[i]
    if (!s) return
    if (!s.result || s.text === undefined) {
      this.renderSourceError(s)
      return
    }
    this.render(s.result, s.text, s.fileName)
  }

  private renderSourceError(s: OverlaySource): void {
    this.metaEl.textContent = s.fileName
    this.bodyEl.innerHTML = ''
    const box = this.doc.createElement('div')
    box.className = 'lsk-err'
    box.textContent = `✕ ${s.label}\n${s.error ?? 'unknown error'}`
    this.bodyEl.appendChild(box)
  }

  /** 渲染 SkimResult; text 为全量日志文本 (context 展开取行用)。 */
  private render(result: SkimResult, text: string, fileName: string): void {
    const total = result.input_lines || 1
    const comp = Math.round((1 - result.output_lines / total) * 100)
    const counts: Partial<Record<Intent, number>> = {}
    for (const b of result.blocks) {
      const it = blockIntent(b)
      counts[it] = (counts[it] ?? 0) + 1
    }
    const countStr = (Object.entries(counts) as Array<[Intent, number]>)
      .map(([k, v]) => `${v} ${k}`)
      .join(' · ')
    this.metaEl.textContent = `${fileName} · ${result.input_lines}→${result.output_lines} lines (-${comp}%) · ${countStr}`

    const body = this.bodyEl
    body.innerHTML = ''
    const lines = text.split('\n')
    let cursor = 1 // 1-based, 当前折叠游标
    for (const blk of result.blocks) {
      if (blk.start_line > cursor) {
        const gap = body.appendChild(this.doc.createElement('div'))
        gap.className = 'lsk-gap'
        gap.textContent = `⋯ ${blk.start_line - cursor} lines`
      }
      body.appendChild(this.blockEl(blk, lines))
      cursor = blk.end_line + 1
    }
    if (cursor <= total) {
      const gap = body.appendChild(this.doc.createElement('div'))
      gap.className = 'lsk-gap'
      gap.textContent = `⋯ ${total - cursor + 1} lines`
    }
  }

  private blockEl(blk: OutputBlock, lines: string[]): HTMLElement {
    const frag = topFragment(blk)
    const it = INTENT_META[frag?.intent ?? 'info']
    const el = this.doc.createElement('div')
    el.className = 'lsk-blk'
    el.dataset.lskBlock = String(blk.start_line)
    el.dataset.lskSrc = String(this.srcIdx)
    const row = this.doc.createElement('div')
    row.className = 'lsk-row'
    const ic = this.doc.createElement('span')
    ic.className = 'lsk-ic'
    Object.assign(ic.style, { background: it.bg, color: it.color })
    ic.textContent = it.icon
    const cat = this.doc.createElement('span')
    cat.className = 'lsk-cat'
    Object.assign(cat.style, { background: it.bg, color: it.color })
    cat.textContent = frag?.category ?? '?'
    const rule = this.doc.createElement('span')
    rule.style.cssText = 'color:#57606a;font:11px ui-monospace,monospace'
    rule.textContent = blk.fragments.map((f) => f.rule).join(' ') // 多规则块全展示
    const ln = this.doc.createElement('span')
    ln.className = 'lsk-lines'
    ln.textContent = `L${blk.start_line}${blk.end_line > blk.start_line ? `-${blk.end_line}` : ''}`
    row.append(ic, cat, rule, ln)
    const ctx = this.doc.createElement('div')
    ctx.className = 'lsk-ctx'
    ctx.textContent = lines.slice(blk.start_line - 1, blk.end_line).join('\n')
    row.onclick = (e) => {
      el.classList.toggle('open')
      if (!e.shiftKey) this.init.onJump(blk, Number(el.dataset.lskSrc))
      el.scrollIntoView({ block: 'nearest' })
    }
    el.append(row, ctx)
    return el
  }

  /** 规则信息条 (chip): 数量/生成日期; stale → 黄底提示。 */
  renderRules(info: RulesInfo | null): void {
    if (!info) {
      this.rulesChip.style.display = 'none'
      return
    }
    this.rulesChip.style.display = ''
    const ageDays = Math.floor((Date.now() - info.fetchedAt) / 86_400_000)
    const fetchedNote = info.source === 'cache' ? `cached ${ageDays}d ago` : 'just fetched'
    this.rulesChip.classList.toggle('stale', info.stale)
    this.rulesChip.title = info.stale
      ? `rules bundle is ${ageDays} days old — click ⟳ rules to refresh`
      : `rules bundle ${info.generatedAt} (${fetchedNote})`
    this.rulesChip.textContent = info.stale
      ? `⚠ ${info.ruleCount} rules · ${ageDays}d old`
      : `${info.ruleCount} rules · ${info.generatedAt}`
  }

  /** 诊断条: 非致命问题清单 (环节/原因/怎么办); 空清单即隐藏。 */
  renderDiags(diags: Diag[]): void {
    this.diagEl.innerHTML = ''
    if (!diags.length) {
      this.diagEl.style.display = 'none'
      return
    }
    this.diagEl.style.display = 'block'
    for (const d of diags) {
      const row = this.doc.createElement('div')
      row.className = 'lsk-diag'
      const head = this.doc.createElement('b')
      head.textContent = `[${d.stage}] ${d.message}`
      row.appendChild(head)
      if (d.hint) {
        const hint = this.doc.createElement('span')
        hint.className = 'lsk-hint'
        hint.textContent = `→ ${d.hint}`
        row.appendChild(hint)
      }
      this.diagEl.appendChild(row)
    }
  }
}
