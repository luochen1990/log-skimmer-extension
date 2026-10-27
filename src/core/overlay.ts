// overlay.ts — skim 视图 overlay (呈现双轨之主轨)。
// 职责: 悬浮面板只渲染 skim 块 (intent 图标/颜色 + category 标签 + 日志原文摘要 + 行坐标 +
//       context 展开), 块间未匹配区折叠为 "⋯ N lines"; 与页面虚拟化/懒加载完全解耦
//       (数据全量外置, 渲染不依赖行 DOM 在场)。
// 隔离: 面板与 fab 均为 Shadow DOM host (#lsk-overlay/#lsk-fab, open root) — 样式与宿主页
//       双向隔离 (根治 v0.1.3 宿主 CSS 吞字事故的架构面), 布局关键属性 (fixed/尺寸/z-index)
//       以 inline style 落 host (页面样式表不可覆写), 内部样式经 tokens.ts 注入 shadow。
//       Playwright CSS 引擎穿透 open shadow — 既有 e2e 选择器全部不变。
// 降级呈现: 源级失败 (fetch 403/登录墙等) → 该源 tab 呈现错误框; 全局诊断 (规则/
//       wasm 阶段) → 底部诊断条 (哪个环节/为什么/怎么办)。规则信息条含 stale 提示
//       与手动刷新入口。
// 联动: 块/行点击 → onJump(block) 回调 (controller 接 adapter 滚动原生流内对应行)。

import { APP_VERSION } from '../generated/version.ts'
import type { Diag, Intent, OutputBlock, SkimResult } from '../types.ts'
import { blockIntent, INTENT_META, topFragment } from './intent.ts'
import { OVERLAY_TOKENS } from './tokens.ts'

/** 静态自有元素查找 — 找不到即内部结构错误, 显式抛错优于静默。 */
function must<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel)
  if (!el) throw new Error(`[logskim] internal: ${sel} missing`)
  return el
}

/** intent → 工具类名 (shadow 内 .t-* 徽章配色, 见 tokens.ts)。 */
function intentClass(it: Intent): string {
  return `t-${it}`
}

/** 块摘要: 剥行首 ISO 时间戳前缀 + 收敛空白, 截断到 300 字符 (纯展示层)。 */
function summaryOf(raw: string): string {
  const s = raw
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (s || raw.trim() || '(empty line)').slice(0, 300)
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
  /** 块 → 页面原生坐标标签 (null = 退回源坐标); 行号与页面对齐的关键 (forgejo step 局部号)。 */
  pageCoords?: (block: OutputBlock) => string | null
}

/** host 元素布局关键属性 — inline style 落地 (页面样式表不可覆写, 宿主隔离的半边)。 */
const HOST_LAYER = {
  position: 'fixed',
  zIndex: '2147483600',
} as const

export class SkimOverlay {
  private doc!: Document
  private root!: HTMLDivElement // #lsk-overlay host (布局在 host, 结构在 shadow)
  private fabBadge!: HTMLElement
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

    // ---- fab: host div (布局 inline) + shadow 内按钮 (样式隔离) ----
    const fab = doc.createElement('div')
    fab.id = 'lsk-fab'
    Object.assign(fab.style, HOST_LAYER, { right: '16px', bottom: '16px' })
    const fabShadow = fab.attachShadow({ mode: 'open' })
    fabShadow.innerHTML = `
<style>
${OVERLAY_TOKENS}
button {
    display: inline-flex; align-items: center; gap: 7px;
    background: var(--lsk-fg); color: var(--lsk-bg);
    border: none; border-radius: 999px; padding: 8px 16px;
    font: 600 13px var(--lsk-sans); cursor: pointer;
    box-shadow: var(--lsk-shadow);
  }
  button:hover { filter: brightness(1.15); }
  .fab-n { display: none; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
    background: var(--lsk-failure-fg); color: #fff; font: 700 11px/18px var(--lsk-sans);
    text-align: center; }
  .fab-n.on { display: inline-block; }
</style>
<button><span>skim</span><span class="fab-n"></span></button>`
    const fabBtn = must<HTMLButtonElement>(fabShadow, 'button')
    this.fabBadge = must<HTMLElement>(fabShadow, '.fab-n')
    fabBtn.onclick = () => this.toggle()
    doc.body.appendChild(fab)

    // ---- overlay: host div + shadow 面板 ----
    const p = doc.createElement('div')
    p.id = 'lsk-overlay'
    Object.assign(p.style, HOST_LAYER, {
      right: '16px',
      top: '16px',
      bottom: '64px',
      width: 'min(560px, calc(100vw - 32px))',
      display: 'none',
    })
    const shadow = p.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
<style>
${OVERLAY_TOKENS}
* { box-sizing: border-box; }
.panel {
  width: 100%; height: 100%; display: flex; flex-direction: column;
  background: var(--lsk-bg); color: var(--lsk-fg);
  border: 1px solid var(--lsk-border); border-radius: var(--lsk-r-lg);
  box-shadow: var(--lsk-shadow);
  font: 12px/1.5 var(--lsk-sans); overflow: hidden;
}
/* ---- 头部: 品牌行 / meta 行 / tabs 行 三层 ---- */
.lsk-hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px 6px; }
.lsk-brand { font: 700 13px var(--lsk-sans); letter-spacing: .2px; display: inline-flex; align-items: center; gap: 6px; }
.lsk-brand::before { content: '≋'; color: var(--lsk-accent); font-size: 15px; }
.lsk-ver { color: var(--lsk-fg-faint); font: 11px var(--lsk-mono); }
.lsk-sp { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.lsk-metaline { display: flex; align-items: center; gap: 8px; padding: 0 14px 8px; border-bottom: 1px solid var(--lsk-border-soft); min-height: 24px; }
.lsk-meta { color: var(--lsk-fg-dim); font: 11px var(--lsk-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lsk-meta b { color: var(--lsk-fg); font-weight: 600; }
.lsk-tabs { display: flex; gap: 6px; padding: 8px 14px 0; overflow-x: auto; scrollbar-width: thin; flex: none; }
.lsk-tabs::-webkit-scrollbar { height: 4px; }
.lsk-tabs:empty { display: none; }
/* ---- 控件 ---- */
button.lsk-mini { font: 11px var(--lsk-sans); font-weight: 500; padding: 3px 10px; border: 1px solid var(--lsk-border);
  border-radius: var(--lsk-r-sm); background: var(--lsk-bg); color: var(--lsk-fg); cursor: pointer; white-space: nowrap; }
button.lsk-mini:hover { background: var(--lsk-bg-soft); }
button.lsk-mini.on { background: var(--lsk-accent-soft); border-color: var(--lsk-accent); color: var(--lsk-accent); }
button.lsk-mini:disabled { opacity: .5; cursor: default; }
button.lsk-iconbtn { border: none; background: transparent; color: var(--lsk-fg-dim); cursor: pointer;
  font: 13px var(--lsk-sans); padding: 2px 6px; border-radius: var(--lsk-r-sm); }
button.lsk-iconbtn:hover { background: var(--lsk-bg-soft); color: var(--lsk-fg); }
/* ---- tabs: 横向滚动 chip, intent 计数徽标 ---- */
.lsk-tab { display: inline-flex; align-items: center; gap: 6px; max-width: 200px;
  font: 11px var(--lsk-sans); padding: 3px 10px; border: 1px solid var(--lsk-border);
  border-radius: 999px; background: var(--lsk-bg); color: var(--lsk-fg-dim); cursor: pointer; white-space: nowrap; }
.lsk-tab .lbl { overflow: hidden; text-overflow: ellipsis; }
.lsk-tab:hover { border-color: var(--lsk-fg-faint); color: var(--lsk-fg); }
.lsk-tab.on { background: var(--lsk-accent-soft); border-color: var(--lsk-accent); color: var(--lsk-accent); font-weight: 600; }
.lsk-tab .n { display: none; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
  font: 700 10px/16px var(--lsk-sans); text-align: center; }
.lsk-tab .n.on { display: inline-block; }
/* ---- 块列表 ---- */
.lsk-bd { overflow: auto; flex: 1; padding: 6px 0 10px; overscroll-behavior: contain; }
.lsk-blk { padding: 2px 14px; }
.lsk-blk.sel { outline: 2px solid var(--lsk-accent); outline-offset: -2px; border-radius: var(--lsk-r-sm); }
.lsk-row { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 4px 6px; border-radius: var(--lsk-r-md); }
.lsk-row:hover { background: var(--lsk-bg-soft); }
.lsk-ic { width: 18px; height: 18px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
  font: 700 11px var(--lsk-mono); flex: none; }
.lsk-cat { font: 600 10px var(--lsk-sans); padding: 1px 8px; border-radius: 999px; flex: none; letter-spacing: .3px; }
.lsk-sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 11px var(--lsk-mono); color: var(--lsk-fg); }
.lsk-lines { color: var(--lsk-fg-dim); font: 11px var(--lsk-mono); margin-left: auto; flex: none;
  background: var(--lsk-bg-soft); border-radius: var(--lsk-r-sm); padding: 1px 7px; }
.lsk-ctx { display: none; margin: 2px 0 4px 28px; padding: 7px 10px; background: var(--lsk-bg-soft);
  border: 1px solid var(--lsk-border-soft); border-radius: var(--lsk-r-sm);
  font: 11px/1.5 var(--lsk-mono); white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; }
.lsk-blk.open .lsk-ctx { display: block; }
/* ---- 折叠 gap: 居中徽章 + 两侧发丝线, 与块行明确分层 ---- */
.lsk-gap { display: flex; align-items: center; gap: 8px; margin: 2px 14px; color: var(--lsk-fg-faint);
  font: 10px var(--lsk-mono); user-select: none; }
.lsk-gap::before, .lsk-gap::after { content: ''; flex: 1; height: 1px; background: var(--lsk-border-soft); }
/* ---- 错误框 / 诊断条 ---- */
.lsk-err { margin: 10px 14px; padding: 10px 12px; background: var(--lsk-failure-bg); color: var(--lsk-failure-fg);
  border: 1px solid var(--lsk-failure-fg); border-radius: var(--lsk-r-md);
  font: 11px/1.5 var(--lsk-mono); white-space: pre-wrap; }
.lsk-diags { border-top: 1px solid var(--lsk-border); padding: 6px 14px; display: none; max-height: 120px; overflow: auto;
  background: var(--lsk-bg-soft); flex: none; }
.lsk-diags .lsk-diag { padding: 3px 0; font: 11px/1.4 var(--lsk-sans); }
.lsk-diags .lsk-diag b { color: var(--lsk-failure-fg); font-weight: 600; }
.lsk-diags .lsk-diag .lsk-hint { color: var(--lsk-fg-dim); display: block; }
/* ---- rules chip ---- */
.lsk-chip { font: 10px var(--lsk-mono); color: var(--lsk-fg-dim); padding: 1px 8px; border: 1px solid var(--lsk-border);
  border-radius: 999px; white-space: nowrap; margin-left: auto; }
.lsk-chip.stale { background: var(--lsk-warning-bg); border-color: var(--lsk-warning-fg); color: var(--lsk-warning-fg); }
</style>
<div class="panel">
  <div class="lsk-hd">
    <span class="lsk-brand">skim</span> <span class="lsk-ver" title="extension build version — chrome://extensions card must match">v${APP_VERSION}</span>
    <span class="lsk-sp">
      <button class="lsk-mini" id="lsk-refresh" title="refresh rules bundle (re-skim)">⟳ rules</button>
      <button class="lsk-mini on" id="lsk-inline-btn" title="toggle inline annotations">inline: on</button>
      <button class="lsk-iconbtn" id="lsk-close" title="close panel">✕</button>
    </span>
  </div>
  <div class="lsk-metaline">
    <span class="lsk-meta" id="lsk-meta"></span>
    <span class="lsk-chip" id="lsk-rules-chip" title="rules bundle"></span>
  </div>
  <div class="lsk-tabs" id="lsk-tabs"></div>
  <div class="lsk-bd" id="lsk-body"></div>
  <div class="lsk-diags" id="lsk-diags"></div>
</div>`
    doc.body.appendChild(p)
    this.root = p
    this.metaEl = must<HTMLElement>(shadow, '#lsk-meta')
    this.rulesChip = must<HTMLElement>(shadow, '#lsk-rules-chip')
    this.tabsEl = must<HTMLElement>(shadow, '#lsk-tabs')
    this.bodyEl = must<HTMLElement>(shadow, '#lsk-body')
    this.diagEl = must<HTMLElement>(shadow, '#lsk-diags')
    must<HTMLButtonElement>(shadow, '#lsk-close').onclick = () => this.toggle()
    const refreshBtn = must<HTMLButtonElement>(shadow, '#lsk-refresh')
    refreshBtn.onclick = () => {
      refreshBtn.disabled = true // pending (n8): 落定前禁用, 防重复刷新
      void this.init.onRefreshRules().finally(() => {
        refreshBtn.disabled = false
      })
    }
    const inlineBtn = must<HTMLButtonElement>(shadow, '#lsk-inline-btn')
    inlineBtn.onclick = () => {
      this.inlineOn = !this.inlineOn
      inlineBtn.textContent = `inline: ${this.inlineOn ? 'on' : 'off'}`
      inlineBtn.classList.toggle('on', this.inlineOn)
      this.init.onToggleInline(this.inlineOn)
    }
  }

  toggle(): void {
    const open = this.root.style.display === 'none'
    this.root.style.display = open ? 'block' : 'none'
  }

  /** 强制打开 (致命降级路径自动呈现诊断)。 */
  open(): void {
    this.root.style.display = 'block'
  }

  /** 多源渲染入口 (forgejo=整 job 单源 / github=每 step 一源); 失败源呈现错误框。
   *  附带: fab 失败计数徽标 (全源 failure 块计数, 一眼可见)。 */
  renderSources(sources: OverlaySource[]): void {
    this.sources = sources
    let failures = 0
    for (const s of sources) {
      for (const b of s.result?.blocks ?? []) if (blockIntent(b) === 'failure') failures++
    }
    this.fabBadge.textContent = String(failures)
    this.fabBadge.classList.toggle('on', failures > 0)

    this.tabsEl.innerHTML = ''
    sources.forEach((s, i) => {
      const t = this.doc.createElement('button')
      t.className = 'lsk-tab'
      const lbl = this.doc.createElement('span')
      lbl.className = 'lbl'
      lbl.textContent = s.label
      t.appendChild(lbl)
      // intent 计数徽标: 块主 intent 的数量 (失败/警告一眼可辨)
      const counts = new Map<Intent, number>()
      for (const b of s.result?.blocks ?? []) {
        const it = blockIntent(b)
        counts.set(it, (counts.get(it) ?? 0) + 1)
      }
      for (const it of ['failure', 'warning'] as const) {
        const n = counts.get(it) ?? 0
        if (n === 0) continue
        const badge = this.doc.createElement('span')
        badge.className = `n ${intentClass(it)} on`
        badge.textContent = String(n)
        t.appendChild(badge)
      }
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
    this.metaEl.innerHTML = ''
    const file = this.doc.createElement('b')
    file.textContent = fileName
    const stat = this.doc.createElement('span')
    stat.textContent = ` · ${result.input_lines}→${result.output_lines} lines (-${comp}%) · ${countStr}`
    this.metaEl.append(file, stat)

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
    const it = frag?.intent ?? 'info'
    const el = this.doc.createElement('div')
    el.className = 'lsk-blk'
    el.dataset.lskBlock = String(blk.start_line)
    el.dataset.lskSrc = String(this.srcIdx)
    const row = this.doc.createElement('div')
    row.className = 'lsk-row'
    const ic = this.doc.createElement('span')
    ic.className = `lsk-ic ${intentClass(it)}`
    ic.textContent = INTENT_META[it].icon
    const cat = this.doc.createElement('span')
    cat.className = `lsk-cat ${intentClass(it)}`
    cat.textContent = frag?.category ?? '?'
    // 原文摘要 (块首行) — 用户不展开 context 即可识别错误; rule id 降为 title 提示。
    // 摘要剥行首 ISO 时间戳前缀 (语料实形态: 时间戳占半行, 淹没错误正文; 仅展示层剥离)。
    const sum = this.doc.createElement('span')
    sum.className = 'lsk-sum'
    sum.textContent = summaryOf(lines[blk.start_line - 1] ?? '')
    sum.title = `rules: ${blk.fragments.map((f) => f.rule).join(', ')}`
    const ln = this.doc.createElement('span')
    ln.className = 'lsk-lines'
    const page = this.init.pageCoords?.(blk) ?? null
    ln.textContent = page ?? `L${blk.start_line}${blk.end_line > blk.start_line ? `-${blk.end_line}` : ''}`
    if (page) ln.title = `source L${blk.start_line}-${blk.end_line}`
    row.append(ic, cat, sum, ln)
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
