// controller.ts — userscript 编排核心 (页面知识全在 adapter)。
// 编排: 适配器探测 → 规则装载 (cache-first) → wasm 引擎 → 数据外置取数+skim
//       → 呈现双轨 (overlay 主视图 + 流内注入) → MutationObserver 重放。
// 架构不变式 (T4 结论, 沿用): 状态外置 + 幂等 sync + 事件驱动重放 — 注入永不假设
// 行 DOM 存活; 任何重建/虚拟化/懒加载都收敛为 "sync 一遍"。
// 增量 sync (T4 遗留 #6): observer 批次只扫 mutation 涉及的新节点 — 未受影响的
// 行池零成本跳过; 受影响池内只 apply 新增子树的行 (大 step 滚动防 O(在场行) 全池重扫;
// contentAligned 适配器行数变化时该池整池重对齐, 有界于池大小)。
// B1 教训: inline 开关 off = 清痕迹含签名 (重放不注入), on = 主动补一次 sync。

import { forgejoAdapter } from './adapters/forgejo.ts'
import { githubAdapter } from './adapters/github.ts'
import { ENGINE_VERSION, LOG_FETCH_TIMEOUT_MS, REPLAY_DEBOUNCE_MS } from './config.ts'
import { gunzip } from './core/abi.ts'
import { poolFingerprint } from './core/align.ts'
import { SkimEngine } from './core/engine.ts'
import { type Annotation, InlineInjector } from './core/inline.ts'
import { INTENT_RANK } from './core/intent.ts'
import { ReplayDriver } from './core/observer.ts'
import { SkimOverlay } from './core/overlay.ts'
import { type RulesLoadResult, RulesStore, rulesJsonForWasm } from './core/rules.ts'
import type { GmEnv } from './gm.ts'
import type {
  Adapter,
  AdapterCtx,
  Diag,
  Fragment,
  LineEntry,
  LoadedSource,
  LogSource,
  LskReport,
  SkimResult,
} from './types.ts'

const ADAPTERS: Adapter[] = [forgejoAdapter, githubAdapter]

/** 适配器探测重试参数: 500ms × 20 = 10s 上界 (Turbo/SPA 渐进渲染等待窗)。 */
const PROBE_INTERVAL_MS = 500
const PROBE_MAX_ATTEMPTS = 20

export interface BootDeps {
  gm: GmEnv
  doc: Document
  loc: Location
  /** 内嵌 (gzip+base64) 引擎 wasm — 构建期生成, 见 scripts/build.mjs。 */
  wasmB64: string
}

function errToMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 引擎自检探针: 结构校验通过 ≠ 引擎可执行 (rules 解析在首次 skim 才发生 —
 * ABI 每次调用重传 rules)。一次最小 skim (单行普通文本, 规则无命中) 隔离
 * "缓存投毒" (坏 yaml bundle), 调用方在 catch 中作废缓存 (M2)。
 * 注: 空日志会被引擎的 "日志为空" 校验拒收, 探针必须非空。
 */
function engineProbe(e: SkimEngine): void {
  e.skim('lsk-probe', 'lsk-probe.log')
}

/**
 * 适配器探测 (M1 激活竞态): 先立即探测; 全 miss 时, 仅当存在 deferProbe 适配器
 * (match 依赖渐进渲染的 DOM) 才等 DOMContentLoaded 后有界重探 — 早注入
 * (document-start) 或 Turbo 迟渲染下不静默退出; 时序稳定的适配器 miss 即终局。
 */
async function findAdapter(doc: Document, loc: Location): Promise<Adapter | null> {
  const probe = (): Adapter | null => ADAPTERS.find((a) => a.match(doc, loc)) ?? null
  const first = probe()
  if (first) return first
  if (!ADAPTERS.some((a) => a.deferProbe)) return null
  if (doc.readyState === 'loading') {
    await new Promise<void>((res) => doc.addEventListener('DOMContentLoaded', () => res(), { once: true }))
  }
  for (let i = 0; i < PROBE_MAX_ATTEMPTS; i++) {
    const a = probe()
    if (a) return a
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
  }
  return null
}

export async function boot(deps: BootDeps): Promise<void> {
  const { gm, doc, loc, wasmB64 } = deps
  const matched = await findAdapter(doc, loc)
  if (!matched) {
    console.debug('[logskim] no adapter matched', loc.href)
    return
  }
  const adapter: Adapter = matched // 重绑定收窄类型 — 闭包内保持 non-null (TS 流分析不跨函数声明)

  const t0 = performance.now()
  const report: LskReport = {
    adapter: adapter.name,
    ready: false,
    engineVersion: ENGINE_VERSION,
    sources: [],
    timing: { total: 0 },
    inline: { applied: 0, replayed: 0, enabled: true },
    sync: { full: 0, incremental: 0, linesExamined: 0, lastExamined: 0 },
    align: [],
    rules: null,
    diags: [],
  }
  const win = doc.defaultView
  if (win) (win as { __lsk?: LskReport }).__lsk = report
  const bootHref = loc.href

  // ---- 诊断收集 (持久清单, overlay 底部呈现; 按 stage+message 去重) ----
  const diags: Diag[] = []
  function pushDiag(d: Diag): void {
    if (!diags.some((x) => x.stage === d.stage && x.message === d.message)) {
      diags.push(d)
      report.diags = [...diags]
      overlay.renderDiags(diags)
    }
  }

  // ---- overlay 先挂 (降级路径的呈现面; 数据就绪后再 renderSources) ----
  const overlay = new SkimOverlay({
    onJump: (blk, srcIdx) => {
      const src = loaded[srcIdx]
      return src?.ok ? adapter.jumpTo(src, blk, ctx) : false
    },
    onToggleInline: (on) => {
      injector.setEnabled(on) // off: 清 class+签名 (重放不再注入) — B1
      report.inline = { ...injector.stats, enabled: on }
      if (on) syncInline() // on: 无 DOM 变更则无重放事件 — 主动补一次 sync 恢复
    },
    onRefreshRules: () => refreshRules(),
  })
  overlay.mount(doc)
  overlay.renderDiags([])

  /** 致命降级 (无规则/无 wasm/全源失败): 空源呈现 + 面板自动打开, 不注入不报错。 */
  function fatal(diag: Diag): void {
    pushDiag(diag)
    overlay.renderSources([])
    overlay.open()
  }

  /** 规则元数据呈现单点: 验证面 (report.rules) 与 overlay chip 同源更新 (boot/refresh 共用)。 */
  function applyRulesInfo(load: Extract<RulesLoadResult, { ok: true }>): void {
    const info = {
      source: load.source,
      ruleCount: load.bundle.rules.length,
      generatedAt: load.bundle.manifest.generated_at,
      fetchedAt: load.fetchedAt,
      stale: load.stale,
    }
    report.rules = info
    overlay.renderRules(info)
  }

  // ---- 状态外置 ----
  const annotations = new Map<string, Annotation>() // lineKey → 标注
  const ctx: AdapterCtx = { aligns: new Map() }
  const loaded: LoadedSource[] = []
  const injector = new InlineInjector()
  injector.ensureStyle(doc)
  /** 行池增量状态 (WeakMap: 池被移除即可 GC): 指纹哨兵 — 漂移即整池重对齐重注入。 */
  let poolStates = new WeakMap<HTMLElement, { fp: string }>()
  let engine: SkimEngine | null = null

  function addAnno(key: string, frag: Fragment): void {
    const prev = annotations.get(key)
    if (!prev || INTENT_RANK[frag.intent] > INTENT_RANK[prev.intent]) {
      annotations.set(key, {
        sig: `${frag.intent}:${frag.rule}`,
        intent: frag.intent,
        category: frag.category,
        rule: frag.rule,
      })
    }
  }

  function skim(text: string, fileName: string): SkimResult {
    if (!engine) throw new Error('engine not ready')
    return engine.skim(text, fileName)
  }

  // ---- 呈现轨 ②: 流内注入 (幂等 sync; 初始 pass 与 observer 重放共用同一函数) ----
  function syncInline(opts: { replay?: boolean; mutations?: MutationRecord[] } = {}): void {
    if (!injector.enabled) {
      report.inline = { ...injector.stats, enabled: false }
      return
    }
    let examined = 0
    const replay = opts.replay === true
    const applyEntries = (entries: LineEntry[], stepKey: string): void => {
      for (const t of entries) t.el.dataset.lskKey = adapter.lineKey(stepKey, t.no)
      injector.applyAll(
        entries.map((t) => t.el),
        annotations,
        (el) => el.dataset.lskKey,
        { replay },
      )
    }
    /** 单池 sync: annotate 恒用全池行 (forgejo 对齐需要); apply 目标 = targets (增量时只含新子树行)。 */
    const syncPool = (pool: HTMLElement, addedRoots: Element[] | null): void => {
      const stepKey = adapter.stepKeyOf(pool, doc)
      const src = adapter.sourceForStep(loaded, stepKey)
      if (!src?.ok) return
      const allLines = adapter.linesOf(pool)
      const a = adapter.annotateStep(src, stepKey, allLines, addAnno, ctx)
      if (a && !report.align.some((s) => s === a.stats)) report.align.push(a.stats)
      poolStates.set(pool, { fp: poolFingerprint(allLines) })
      const targets =
        addedRoots === null ? allLines : dedupeEntries(addedRoots.flatMap((r) => adapter.linesIn(r)))
      examined += targets.length
      applyEntries(targets, stepKey)
    }

    /** 池内容漂移 (M3): 作废旧标注 (前缀键) + 剥离 DOM 痕迹含签名 → 强制整池重对齐重注入。 */
    const stripPool = (pool: HTMLElement): void => {
      const prefix = adapter.poolKeyPrefix(adapter.stepKeyOf(pool, doc))
      for (const k of annotations.keys()) if (k.startsWith(prefix)) annotations.delete(k)
      injector.clearPool(pool)
    }

    if (!opts.mutations) {
      report.sync.full++
      for (const pool of adapter.stepLogs(doc)) syncPool(pool, null)
    } else {
      // 增量: 只找含新增节点的池; 未受影响池零成本跳过。
      const addedEls: Element[] = []
      for (const m of opts.mutations) {
        for (const n of m.addedNodes) {
          // 自家 UI (overlay/fab) 渲染也走 body observer — 过滤, 防自激励重放
          if (n.nodeType === 1 && !(n as Element).closest('#lsk-overlay,#lsk-fab')) {
            addedEls.push(n as Element)
          }
        }
      }
      if (addedEls.length === 0) return
      report.sync.incremental++
      for (const pool of adapter.stepLogs(doc)) {
        const hits = addedEls.filter((el) => pool.contains(el) || el.contains(pool))
        if (hits.length === 0) continue
        const st = poolStates.get(pool)
        const grown =
          adapter.contentAligned && st !== undefined && poolFingerprint(adapter.linesOf(pool)) !== st.fp
        // contentAligned 池: 指纹漂移 = 对齐失效 → 剥离旧痕迹 (M3) 后整池重对齐
        if (grown) stripPool(pool)
        syncPool(pool, grown ? null : hits)
      }
    }
    report.sync.linesExamined += examined
    report.sync.lastExamined = examined
    report.inline = { ...injector.stats, enabled: true }
  }

  // ---- 数据装载: 规则 (cache-first) + wasm + 源取数 + skim ----
  const rulesStore = new RulesStore(gm)
  const rulesLoad = await rulesStore.load()
  if (!rulesLoad.ok) {
    fatal(rulesLoad.diag)
    return // 无规则无法 skim — 诊断已呈现
  }
  const { bundle } = rulesLoad
  applyRulesInfo(rulesLoad)
  if (rulesLoad.stale) {
    pushDiag({
      stage: 'rules',
      message: `rules bundle cached ${Math.floor((Date.now() - rulesLoad.fetchedAt) / 86_400_000)}d ago`,
      hint: 'click "⟳ rules" in the skim panel to refresh',
    })
  }

  let wasmBytes: Uint8Array<ArrayBuffer>
  try {
    wasmBytes = await gunzip(wasmB64)
  } catch (e) {
    fatal({ stage: 'wasm', message: `engine wasm failed to load: ${errToMessage(e)}` })
    return
  }
  try {
    engine = await SkimEngine.create(wasmBytes, rulesJsonForWasm(bundle))
    engineProbe(engine)
  } catch (e) {
    // 缓存投毒自愈 (M2): bundle 过了结构校验但引擎执行不了 (yaml 语法坏/不兼容) —
    // 不作废则坏缓存永久存在, 刷新页面也救不回。
    await rulesStore.invalidateCache()
    fatal({
      stage: 'rules',
      message: `engine rejected the rules bundle: ${errToMessage(e)}`,
      hint: 'cached bundle invalidated — reload the page to re-fetch',
    })
    return
  }

  const sourcesLoaded = await loadSources()
  if (!sourcesLoaded) return // 无源: 诊断已呈现 (fatal), 不进入注入/observer
  renderLoadedSources()

  // ---- 初始 pass + observer 重放 ----
  syncInline()
  const driver = new ReplayDriver((batch) => {
    if (loc.href !== bootHref) {
      // GitHub Turbo 同文档导航: 状态全外置于旧 URL — 干净重载 (userscript 随页重跑)。
      loc.reload()
      return
    }
    syncInline({ replay: true, mutations: batch })
  }, REPLAY_DEBOUNCE_MS)
  driver.start(adapter.observeRoot(doc))
  report.timing.total = Math.round(performance.now() - t0)
  report.ready = true
  console.debug('[logskim] ready', report)

  // ---- 手动刷新规则: 网络失败保留旧 bundle 继续工作; 成功则全量 reskim ----
  let refreshing = false
  async function refreshRules(): Promise<void> {
    if (refreshing) return // busy 防重入 (overlay 按钮 disabled 之外的二道防线)
    refreshing = true
    try {
      const r = await rulesStore
        .refresh()
        .catch((e): RulesLoadResult => ({ ok: false, diag: { stage: 'rules', message: errToMessage(e) } }))
      if (!r.ok) {
        pushDiag({
          ...r.diag,
          message: `refresh failed: ${r.diag.message}`,
          hint: 'keeping the cached bundle',
        })
        return
      }
      let candidate: SkimEngine
      try {
        candidate = await SkimEngine.create(wasmBytes, rulesJsonForWasm(r.bundle))
        engineProbe(candidate)
      } catch (e) {
        await rulesStore.invalidateCache() // 引擎拒收的新 bundle 已写缓存 — 作废 (M2)
        pushDiag({
          stage: 'rules',
          message: `refreshed bundle rejected by engine: ${errToMessage(e)}`,
          hint: 'cache invalidated — keeping the old engine instance, reload to re-fetch',
        })
        return
      }
      engine = candidate
      applyRulesInfo(r)
      // 只清 rules 诊断 (m6): source/wasm 等其他环节的问题与刷新无关, 不能顺手抹掉
      const kept = diags.filter((d) => d.stage !== 'rules')
      diags.length = 0
      diags.push(...kept)
      report.diags = [...diags]
      overlay.renderDiags(diags)
      reskimAll()
    } finally {
      refreshing = false
    }
  }

  /** 已装载源 → overlay 呈现 (boot 与 reskimAll 共用)。 */
  function renderLoadedSources(): void {
    overlay.renderSources(
      loaded.map((s) => ({
        label: s.label,
        fileName: s.fileName,
        ...(s.ok ? { text: s.text, result: s.result } : { error: s.error }),
      })),
    )
  }

  /** 规则更新后的全量重注入: 清痕迹 → 重 skim → 重建标注表 → 整池 sync。 */
  function reskimAll(): void {
    const rescanned: LoadedSource[] = loaded.map((s) => {
      if (!s.ok) return s
      try {
        return { ...s, result: skim(s.text, s.fileName) }
      } catch (e) {
        return { key: s.key, label: s.label, fileName: s.fileName, ok: false, error: errToMessage(e) }
      }
    })
    loaded.length = 0
    loaded.push(...rescanned)
    report.sources = summarize(loaded)
    annotations.clear()
    poolStates = new WeakMap() // WeakMap 无 clear — 换新实例 (旧池状态全作废)
    ctx.aligns.clear()
    report.align = []
    injector.clearAll()
    syncInline()
    renderLoadedSources()
  }

  /**
   * 源取数 + skim; 返回是否装载了至少一个源 (零源 → false, 诊断走 fatal);
   * 单源失败 → 降级态 LoadedSource (其余源可用, boot 继续)。
   */
  async function loadSources(): Promise<boolean> {
    let sources: LogSource[]
    try {
      sources = await adapter.logSources(doc, loc)
    } catch (e) {
      fatal({ stage: 'adapter', message: errToMessage(e), hint: 'page layout or API may have changed' })
      return false
    }
    if (sources.length === 0) {
      fatal({
        stage: 'source',
        message: 'no log endpoints found on this page',
        hint:
          adapter.name === 'github'
            ? 'job may still be running, or logs are behind sign-in'
            : 'job may still be running',
      })
      return false
    }
    // 并行取数 (m1): 各源独立 fetch+skim, 失败互不阻塞; 按 index 回填保序
    const settled = await Promise.allSettled(
      sources.map(async (s): Promise<LoadedSource> => {
        const resp = await fetch(s.url, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(LOG_FETCH_TIMEOUT_MS),
        })
        if (!resp.ok) throw new Error(`${resp.status} ${logStatusHint(resp.status, adapter.name)}`.trim())
        const text = await resp.text()
        return {
          key: s.key,
          label: s.label,
          fileName: s.fileName,
          ok: true,
          text,
          result: skim(text, s.fileName),
        }
      }),
    )
    settled.forEach((r, i) => {
      const s = sources[i]
      if (!s) return // 不可达 (allSettled 与 sources 等长); 防畸形
      loaded.push(
        r.status === 'fulfilled'
          ? r.value
          : { key: s.key, label: s.label, fileName: s.fileName, ok: false, error: errToMessage(r.reason) },
      )
    })
    report.sources = summarize(loaded)
    if (loaded.length > 0 && !loaded.some((s) => s.ok)) {
      pushDiag({ stage: 'source', message: 'all log sources failed — see the error box in the skim panel' })
      overlay.open()
    }
    return true
  }
}

function summarize(loaded: LoadedSource[]): LskReport['sources'] {
  return loaded.map((s) =>
    s.ok
      ? {
          ok: true,
          key: s.key,
          label: s.label,
          fileName: s.fileName,
          blocks: s.result.blocks.length,
          inputLines: s.result.input_lines,
          outputLines: s.result.output_lines,
        }
      : { ok: false, key: s.key, label: s.label, error: s.error },
  )
}

function logStatusHint(status: number, adapterName: string): string {
  if (status === 404) {
    return adapterName === 'github'
      ? '(anonymous access cannot fetch logs — sign in; or the log was deleted by retention)'
      : '(log not found — deleted by retention?)'
  }
  if (status === 403) return '(login wall / private repo / rate limit — sign in and retry)'
  return ''
}

function dedupeEntries(entries: LineEntry[]): LineEntry[] {
  const seen = new Set<HTMLElement>()
  const out: LineEntry[] = []
  for (const e of entries) {
    if (seen.has(e.el)) continue
    seen.add(e.el)
    out.push(e)
  }
  return out
}
