// controller.ts — 编排核心 (双形态共用: Chrome MV3 content script 与 Tampermonkey
// userscript; 页面知识全在 adapter, 宿主细节全在 host.ts)。
// 编排: 适配器探测 → wasm 引擎 (解压+版本读取) → 规则装载 (cache-first, 版本协商
//       用 wasm 侧版本) → 数据外置取数+skim → 呈现双轨 (overlay 主视图 + 流内注入)
//       → MutationObserver 重放。
// 架构不变式 (T4 结论, 沿用): 状态外置 + 幂等 sync + 事件驱动重放 — 注入永不假设
// 行 DOM 存活; 任何重建/虚拟化/懒加载都收敛为 "sync 一遍"。
// 增量 sync (T4 遗留 #6): observer 批次只扫 mutation 涉及的新节点 — 未受影响的
// 行池零成本跳过; 受影响池内只 apply 新增子树的行 (大 step 滚动防 O(在场行) 全池重扫;
// contentAligned 适配器行数变化时该池整池重对齐, 有界于池大小)。
// B1 教训: inline 开关 off = 清痕迹含签名 (重放不注入), on = 主动补一次 sync。

import { forgejoAdapter } from './adapters/forgejo.ts'
import { githubAdapter } from './adapters/github.ts'
import { LOG_FETCH_TIMEOUT_MS, REPLAY_DEBOUNCE_MS } from './config.ts'
import { gunzip, loadEngine, type SkimAbi } from './core/abi.ts'
import { loadEngineRpc, rpcAvailable } from './core/abi-rpc.ts'
import { poolFingerprint } from './core/align.ts'
import { SkimEngine } from './core/engine.ts'
import { FoldInjector, foldRuns } from './core/fold.ts'
import { type Annotation, InlineInjector } from './core/inline.ts'
import { INTENT_RANK } from './core/intent.ts'
import { ReplayDriver } from './core/observer.ts'
import { SkimOverlay } from './core/overlay.ts'
import { type RulesLoadResult, RulesStore, rulesJsonForWasm } from './core/rules.ts'
import type { HostEnv, HostKind } from './host.ts'
import type {
  Adapter,
  AdapterCtx,
  Diag,
  FoldProbe,
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
  host: HostEnv
  doc: Document
  loc: Location
  /** 内嵌 (gzip+base64) 引擎 wasm — 构建期生成, 见 scripts/build.mjs。 */
  wasmB64: string
}

function errToMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Chrome 的 CSP 拦截文案特征 (compile/instantiate 皆匹配; 大小写不敏感)。 */
const CSP_WASM_RE = /content security policy|wasm-unsafe-eval|wasm-eval/i

/**
 * wasm 装载失败诊断 — CSP 拦截形态给出形态切换指引 (github.com 实测教训:
 * 页面 CSP 不含 wasm-unsafe-eval 时, 页面世界 (userscript 注入环境) 的
 * WebAssembly 编译被拒; MV3 content script 的 isolated world 不受页面 CSP
 * 约束, 是 github.com 场景唯一可靠形态)。extension 形态理论上不会遇到 CSP 拦截
 * (遇到了说明 Chrome 语义变化), 文案保持中性。
 */
function wasmLoadDiag(e: unknown, kind: HostKind): Diag {
  const message = `engine wasm failed to load: ${errToMessage(e)}`
  const cspBlocked = CSP_WASM_RE.test(message)
  const hint =
    cspBlocked && kind !== 'extension'
      ? 'page CSP blocks WebAssembly compilation — on github.com install the Chrome extension build instead (see README)'
      : kind === 'extension'
        ? 'service worker unavailable — reload the page or reinstall the extension (see README)'
        : undefined
  return hint === undefined ? { stage: 'wasm', message } : { stage: 'wasm', message, hint }
}

/**
 * 引擎自检探针: 结构校验通过 ≠ 引擎可执行 (rules 解析在首次 skim 才发生 —
 * ABI 每次调用重传 rules)。一次最小 skim (单行普通文本, 规则无命中) 隔离
 * "缓存投毒" (坏 yaml bundle), 调用方在 catch 中作废缓存 (M2)。
 * 注: 空日志会被引擎的 "日志为空" 校验拒收, 探针必须非空。
 */
async function engineProbe(e: SkimEngine): Promise<void> {
  await e.skim('lsk-probe', 'lsk-probe.log')
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

/** boot 终态: 'no-adapter' = 页面未识别 (main 据此布防 SPA 重载哨兵); 'booted' = 已呈现 (含降级)。 */
export type BootOutcome = 'no-adapter' | 'booted'

/** GH job 页 URL 形态 (日志页主入口); run summary 等非日志页保持静默 (非 skim 目标)。 */
const GH_JOB_URL = /\/actions\/runs\/\d+\/job\/\d+/

/** 空 report 工厂 (boot 与 no-adapter 诊断共用同一形状)。 */
function newReport(adapter: string): LskReport {
  return {
    adapter,
    ready: false,
    engineVersion: '', // wasm 解压后回填 (版本来源 = wasm 侧, 非 host 常量)
    sources: [],
    timing: { total: 0 },
    inline: { applied: 0, replayed: 0, enabled: true },
    sync: { full: 0, incremental: 0, linesExamined: 0, lastExamined: 0 },
    align: [],
    rules: null,
    diags: [],
  }
}

export async function boot(deps: BootDeps): Promise<BootOutcome> {
  const { host, doc, loc, wasmB64 } = deps
  const matched = await findAdapter(doc, loc)
  if (!matched) {
    // 有声失败 (M4 用户实测教训): job 页 URL 上探测耗尽 = DOM 未识别 (布局漂移/渲染
    // 异常) — 诊断面板而非静默退出 (用户可感知可上报); 非日志页保持静默。
    if (GH_JOB_URL.test(loc.pathname)) {
      const diag: Diag = {
        stage: 'adapter',
        message: 'Actions job page detected but no log DOM (check-step) after probe retries',
        hint: 'reload the page once (a fresh extension build needs a page refresh); if it persists, the page layout may have changed — please report',
      }
      const report: LskReport = { ...newReport('none'), diags: [diag] }
      const win = doc.defaultView
      if (win) (win as { __lsk?: LskReport }).__lsk = report
      const overlay = new SkimOverlay({
        onJump: () => {},
        onToggleInline: () => {},
        onRefreshRules: async () => {},
      })
      overlay.mount(doc)
      overlay.renderDiags([diag])
      overlay.open()
    }
    console.debug('[logskim] no adapter matched', loc.href)
    return 'no-adapter'
  }
  const adapter: Adapter = matched // 重绑定收窄类型 — 闭包内保持 non-null (TS 流分析不跨函数声明)

  const t0 = performance.now()
  const report: LskReport = newReport(adapter.name)
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
    pageCoords: (blk) => adapter.pageCoords?.(blk, ctx) ?? null,
    onToggleInline: (on) => {
      injector.setEnabled(on) // off: 清 class+签名 (重放不再注入) — B1
      folds.setEnabled(on) // off: 解除折叠 + 移除占位行 (可逆性); on 由下方补 sync 恢复
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
  const folds = new FoldInjector()
  folds.ensureStyle(doc)
  /** 自动展开去重 (外置状态): 已程序化展开过的原生折叠区只展开一次 (防循环)。 */
  const expandedFolds = new Set<string>()
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

  async function skim(text: string, fileName: string): Promise<SkimResult> {
    if (!engine) throw new Error('engine not ready')
    return engine.skim(text, fileName)
  }

  // ---- 面板标签时序洞修补: aligns (页面坐标输入) 后填 ----
  // 活体 forgejo 页 boot 时 step 全收起 → 首渲染 aligns 空 → pageCoords 只能给源坐标;
  // autoExpand 展开后 aligns 填充, 须重渲染面板让行号标签转为页面坐标 (fixture 曾测不出:
  // 其 step 在 boot 前已渲染, aligns 天然先于首渲染)。
  let alignsRendered = 0
  let rerenderTimer: ReturnType<typeof setTimeout> | null = null
  /** 防抖重渲染面板源列表 (重放风暴合并为一次; 渲染本身不再增长 aligns, 无环路)。 */
  function scheduleSourcesRerender(): void {
    if (rerenderTimer !== null) return
    rerenderTimer = setTimeout(() => {
      rerenderTimer = null
      renderLoadedSources()
    }, 150)
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
      foldPass(pool, stepKey, allLines, targets)
    }

    /**
     * 折叠 pass: 连续无标注段 (≥3, 跨虚拟化空洞合并) 隐藏 + 段首占位行。
     * runs 计算面 = 全池在场行 (非 targets): 段按源空间 no 合并, 批次边界不切段 —
     * 否则每批各成一个 key, 占位行跨批视觉堆叠 (修复前的 :300/:400/… 堆叠形态)。
     * applyPool 的 DOM 写天然幂等 (行签名+占位行文本比对), 实际写只落在本批变更的行上;
     * startNo 稳定 (段只随 attach 延伸, 见 foldRuns 假设) → 老 key 行零触碰。
     * 页面原生折叠区内的行让位 (该区自带展开 UX, skim 不重复折叠);
     * 用户展开过的段不复活 (userExpanded)。
     */
    const foldPass = (
      _pool: HTMLElement,
      stepKey: string,
      poolLines: LineEntry[],
      targets: LineEntry[],
    ): void => {
      if (!folds.enabled || targets.length === 0) return
      const { nativeFoldOf } = adapter
      const eligible = nativeFoldOf === undefined ? poolLines : poolLines.filter((t) => !nativeFoldOf(t.el))
      if (eligible.length === 0) return
      const runs = foldRuns(eligible, (no) => annotations.has(adapter.lineKey(stepKey, no)))
      folds.applyPool(stepKey, runs, eligible)
    }

    /** 池内容漂移 (M3): 作废旧标注 (前缀键) + 剥离 DOM 痕迹含签名 → 强制整池重对齐重注入。 */
    const stripPool = (pool: HTMLElement): void => {
      const prefix = adapter.poolKeyPrefix(adapter.stepKeyOf(pool, doc))
      for (const k of annotations.keys()) if (k.startsWith(prefix)) annotations.delete(k)
      injector.clearPool(pool)
      folds.clearPool(pool)
      folds.clearExpandedPrefix(`${prefix}`)
    }

    if (!opts.mutations) {
      report.sync.full++
      for (const pool of adapter.stepLogs(doc)) syncPool(pool, null)
    } else {
      // 增量: 只找含新增节点的池; 未受影响池零成本跳过。
      const addedEls: Element[] = []
      for (const m of opts.mutations) {
        for (const n of m.addedNodes) {
          // 自家 UI (overlay/fab/fold 占位行) 渲染也走 body observer — 过滤, 防自激励重放
          if (
            n.nodeType === 1 &&
            !(n as Element).closest('#lsk-overlay,#lsk-fab,.lsk-fold-ph,#lsk-inline-style,#lsk-fold-style')
          ) {
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
    if (ctx.aligns.size > alignsRendered) scheduleSourcesRerender()
  }

  /** 存在未被任何已对齐池段覆盖的命中行 (forgejo 未渲染 step 的自动展开判定)。 */
  function hiddenHitExists(): boolean {
    const covered = (full: number): boolean => {
      for (const a of ctx.aligns.values()) if (a.inverse.has(full)) return true
      return false
    }
    for (const s of loaded) {
      if (!s.ok) continue
      for (const blk of s.result.blocks) {
        for (let f = blk.start_line - 1; f < blk.end_line; f++) if (!covered(f)) return true
      }
    }
    return false
  }

  /**
   * 自动展开 (任务③): 含命中行的页面原生折叠区 → 程序化展开 (adapter 定义折叠语义)。
   * 防循环: expandedFolds 外置 Set 只展开一次; 展开引发的 DOM 增长走既有 replay。
   * inline off 时不展开 (展开是为了看见命中, 命中呈现已关)。
   */
  function autoExpand(): void {
    if (!injector.enabled || !adapter.foldables) return
    const probe: FoldProbe = {
      hasHitLine: (key) => annotations.has(key),
      hasHiddenHit: () => hiddenHitExists(),
    }
    for (const f of adapter.foldables(doc, probe)) {
      if (expandedFolds.has(f.key)) continue
      expandedFolds.add(f.key)
      f.expand()
    }
  }

  // ---- 数据装载: abi 分派 (扩展=SW RPC / 其余=本地 wasm) → 规则 (cache-first, 版本协商用 abi 版本) → 源取数 + skim ----
  // 扩展形态不在 content script 编译 wasm: 严格 CSP 页会拒 (2026-10-27 实测),
  // wasm 跑在 background SW (manifest 放行 wasm-unsafe-eval)。
  let abi: SkimAbi
  let engineVersion: string
  try {
    if (host.kind === 'extension' && rpcAvailable()) {
      abi = await loadEngineRpc()
      engineVersion = abi.engineVersion
    } else {
      abi = await loadEngine(await gunzip(wasmB64))
      engineVersion = abi.engineVersion
    }
    report.engineVersion = engineVersion
  } catch (e) {
    fatal(wasmLoadDiag(e, host.kind))
    return 'booted'
  }
  const rulesStore = new RulesStore(host, engineVersion)
  const rulesLoad = await rulesStore.load()
  if (!rulesLoad.ok) {
    fatal(rulesLoad.diag)
    return 'booted' // 无规则无法 skim — 诊断已呈现
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

  try {
    engine = await SkimEngine.create(abi, rulesJsonForWasm(bundle))
    await engineProbe(engine)
  } catch (e) {
    // 缓存投毒自愈 (M2): bundle 过了结构校验但引擎执行不了 (yaml 语法坏/不兼容) —
    // 不作废则坏缓存永久存在, 刷新页面也救不回。
    await rulesStore.invalidateCache()
    fatal({
      stage: 'rules',
      message: `engine rejected the rules bundle: ${errToMessage(e)}`,
      hint: 'cached bundle invalidated — reload the page to re-fetch',
    })
    return 'booted'
  }

  const sourcesLoaded = await loadSources()
  if (!sourcesLoaded) return 'booted' // 无源: 诊断已呈现 (fatal), 不进入注入/observer
  // 先对齐 (填充 ctx.aligns) 再渲染块 — pageCoords 依赖对齐缓存 (forgejo 局部行号)
  syncInline()
  renderLoadedSources()

  // ---- 初始 pass + observer 重放 ----
  const driver = new ReplayDriver((batch) => {
    if (loc.href !== bootHref) {
      // GitHub Turbo 同文档导航: 状态全外置于旧 URL — 干净重载 (userscript 随页重跑)。
      loc.reload()
      return
    }
    syncInline({ replay: true, mutations: batch })
    autoExpand()
  }, REPLAY_DEBOUNCE_MS)
  driver.start(adapter.observeRoot(doc))
  // 自动展开在 observer 启动后调用: 展开引发的页面渲染 (懒加载/折叠头点击) 必须
  // 被 replay 链路捕获 — 放在 start 之前会丢同步增长的 mutation (fold=1 实测教训)。
  autoExpand()
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
        candidate = await SkimEngine.create(abi, rulesJsonForWasm(r.bundle))
        await engineProbe(candidate)
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
      await reskimAll()
    } finally {
      refreshing = false
    }
  }

  /** 已装载源 → overlay 呈现 (boot 与 reskimAll 共用; alignsRendered 对齐 = pageCoords 输入快照)。 */
  function renderLoadedSources(): void {
    alignsRendered = ctx.aligns.size
    overlay.renderSources(
      loaded.map((s) => ({
        label: s.label,
        fileName: s.fileName,
        ...(s.ok ? { text: s.text, result: s.result } : { error: s.error }),
      })),
    )
  }

  /** 规则更新后的全量重注入: 清痕迹 → 重 skim → 重建标注表 → 整池 sync。 */
  async function reskimAll(): Promise<void> {
    const rescanned: LoadedSource[] = await Promise.all(
      loaded.map(async (s) => {
        if (!s.ok) return s
        try {
          return { ...s, result: await skim(s.text, s.fileName) }
        } catch (e) {
          return { key: s.key, label: s.label, fileName: s.fileName, ok: false, error: errToMessage(e) }
        }
      }),
    )
    loaded.length = 0
    loaded.push(...rescanned)
    report.sources = summarize(loaded)
    annotations.clear()
    poolStates = new WeakMap() // WeakMap 无 clear — 换新实例 (旧池状态全作废)
    ctx.aligns.clear()
    report.align = []
    injector.clearAll()
    folds.clearAll()
    syncInline()
    autoExpand()
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
          result: await skim(text, s.fileName),
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

  return 'booted'
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
