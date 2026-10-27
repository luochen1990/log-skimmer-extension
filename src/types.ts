// types.ts — 跨模块共享的协议类型 (SSOT)。
// SkimResult 族 = 引擎 serde JSON 协议的 TS 镜像 (字段名/枚举值与 engine/src/lib.rs
// 的 serde 序列化严格一致, 参照 native.json 实例); Bundle 族 = rules 仓发布管线契约;
// Adapter/Controller 族 = 本仓内部接口。

// ---------- 引擎 SkimResult JSON 协议 ----------

/** 命中语义 (engine Intent, serde lowercase)。 */
export type Intent = 'failure' | 'warning' | 'info'
/** 规则类别 (engine Category 封闭枚举, serde lowercase)。 */
export type Category =
  | 'fmt'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'test'
  | 'security'
  | 'deps'
  | 'infra'
  | 'config'
  | 'unknown'
export type Confidence = 'low' | 'medium' | 'high'
export type Kind = 'signal' | 'noise'

export interface Fragment {
  rule: string
  kind: Kind
  intent: Intent
  category: Category
  confidence: Confidence
  /** 该规则自身消费区间 (1-based 含端点)。 */
  block: [number, number]
  /** 输出区间 (block ∪ context), 1-based 含端点。 */
  out: [number, number]
  text: string
}

export interface OutputBlock {
  start_line: number
  end_line: number
  rules: string[]
  fragments: Fragment[]
}

export interface SkimStats {
  input_lines: number
  output_lines: number
  signature_output_lines: number
  noise_lines_removed: number
}

export interface SkimResult {
  file: string
  input_lines: number
  output_lines: number
  blocks: OutputBlock[]
  stats: SkimStats
}

/** `wasm_skim_json` 导出返回的 envelope。 */
export type SkimEnvelope = { ok: true; result: SkimResult } | { ok: false; error: string }

// ---------- 规则 bundle 跨仓契约 ----------
// format_version / min_engine_version 可省略 (SSOT = rules 仓生成管线:
// "无则省略该键" — 规则集 manifest.yaml 未声明则 bundle 不携带, 消费侧放行,
// 键省略语义与引擎侧 "无 manifest 照常装载" 一致); 携带时参与版本协商 (rules.ts)。
export interface BundleManifest {
  format_version?: number
  min_engine_version?: string
  rule_count: number
  generated_at: string
}

export interface RuleSource {
  id: string
  path: string
  yaml: string
}

export interface RulesBundle {
  manifest: BundleManifest
  rules: RuleSource[]
}

// ---------- 适配器 (adapter) 契约 ----------

/** 行池内的一行: no 语义由 adapter 定 (forgejo=step 局部 1-based; github=data-index 0-based)。 */
export interface LineEntry {
  no: number
  text: string
  el: HTMLElement
}

/** 数据外置日志源 (差异点: forgejo=整 job 单源; github=每 step 一源)。 */
export interface LogSource {
  key: string
  url: string
  fileName: string
  label: string
}

/** 已装载的源 (ok=false 时为降级态, 供 overlay 呈现错误)。 */
export type LoadedSource =
  | {
      key: string
      label: string
      fileName: string
      ok: true
      text: string
      result: SkimResult
    }
  | {
      key: string
      label: string
      fileName: string
      ok: false
      error: string
    }

export interface AlignResult {
  /** 全量行号 → step 内行号 (块坐标 → DOM 行的映射面; 正向 noToFull 只在构建期消费)。 */
  inverse: Map<number, number>
  /** 对齐时的池指纹 (行数 + 全部行文本, 见 poolFingerprint) — 变化 = 池漂移, 缓存失效重算。 */
  fp: string
  stepKey: string
  stats: { domLines: number; matched: number; unmatched: number }
}

export interface AdapterCtx {
  /** forgejo: stepKey → 对齐缓存 (池指纹变化即失效重算)。 */
  aligns: Map<string, AlignResult>
}

/** 自动展开探测面 (controller 实现, adapter 消费; 见 Adapter.foldables)。 */
export interface FoldProbe {
  /** 某外置状态 key (lineKey) 是否命中标注 — github group 区间命中判定。 */
  hasHitLine: (lineKey: string) => boolean
  /** 存在尚未被任何已对齐池段覆盖的命中行 — forgejo 未渲染 step 候选判定。 */
  hasHiddenHit: () => boolean
}

/** 一个可程序化展开的页面原生折叠区。 */
export interface Foldable {
  /** 外置去重 key (controller 记录, 只展开一次防循环)。 */
  key: string
  /** 触发页面原生展开 (之后 DOM 增长走既有 replay)。 */
  expand(): void
}

export interface Adapter {
  name: string
  /**
   * true = match 依赖渐进渲染的 DOM (SPA/Turbo), boot 时未就绪值得有界重探
   * (500ms × 20); false = match 时序稳定 (如纯 URL 判定), miss 即退出。
   */
  readonly deferProbe: boolean
  /** 页面识别 (零 IO)。 */
  match(doc: Document, loc: Location): boolean
  /** 数据外置源清单 (差异点: forgejo=整 job 单源; github=每 step 一源)。 */
  logSources(doc: Document, loc: Location): Promise<LogSource[]> | LogSource[]
  /** MutationObserver 挂载点。 */
  observeRoot(doc: Document): Element
  /** 当前在场的行池 (懒加载/虚拟化感知)。 */
  stepLogs(doc: Document): HTMLElement[]
  /** 池标识 (外置状态 key 的一部分)。 */
  stepKeyOf(poolEl: HTMLElement, doc: Document): string
  /**
   * 块 → 页面原生坐标标签 (null = 退回源坐标 L 起-止)。forgejo: step 局部行号
   * (与页面行号同体系; 全局↔局部经对齐缓存逆映射); github: 源坐标即页面行。
   */
  pageCoords?(blk: OutputBlock, ctx: AdapterCtx): string | null
  /** 池内行枚举 (全量在场行)。 */
  linesOf(poolEl: HTMLElement): LineEntry[]
  /** 子树内行枚举 — 增量 sync 用 (只扫 mutation 涉及的新节点)。 */
  linesIn(subtree: Element): LineEntry[]
  /** 外置状态 key (语义由 adapter 定)。 */
  lineKey(stepKey: string, no: number): string
  /** 池内外置状态 key 的公共前缀 — 池内容漂移时按前缀作废旧标注 (M3)。 */
  poolKeyPrefix(stepKey: string): string
  /** 块 → 行标注 (forgejo 经对齐器; github 直映)。 */
  annotateStep(
    src: LoadedSource,
    stepKey: string,
    lines: LineEntry[],
    emit: (lineKey: string, frag: Fragment) => void,
    ctx: AdapterCtx,
  ): AlignResult | null
  sourceForStep(loaded: LoadedSource[], stepKey: string): LoadedSource | undefined
  /** overlay → 流内联动。 */
  jumpTo(src: LoadedSource, block: OutputBlock, ctx: AdapterCtx): boolean
  /**
   * true = 标注依赖池的完整 DOM 行内容 (forgejo 对齐器) → 增量 sync 中
   * 行数变化须整池重对齐; false = 坐标直映 (github) → 增量只处理新节点。
   */
  contentAligned: boolean
  /**
   * 页面原生折叠区自动展开 (含命中行才展开; 防循环由 controller 的外置 Set 去重)。
   * 缺省 = 该平台无自动展开面。
   */
  foldables?(doc: Document, probe: FoldProbe): Foldable[]
  /**
   * 行元素是否在页面原生折叠区内 (该区自带展开/收起 UX, skim 折叠让位不免)。
   * 缺省 = 无原生折叠面 (全部行可折)。
   */
  nativeFoldOf?(el: Element): boolean
}

// ---------- 诊断 ----------

export type DiagStage = 'adapter' | 'rules' | 'wasm' | 'source' | 'skim'

export interface Diag {
  stage: DiagStage
  message: string
  hint?: string
}

// ---------- 验证面 (window.__lsk, e2e 消费) ----------

export interface LskReport {
  adapter: string
  ready: boolean
  engineVersion: string
  sources: Array<
    | {
        ok: true
        key: string
        label: string
        fileName: string
        blocks: number
        inputLines: number
        outputLines: number
      }
    | { ok: false; key: string; label: string; error: string }
  >
  timing: { total: number }
  inline: { applied: number; replayed: number; enabled: boolean }
  sync: { full: number; incremental: number; linesExamined: number; lastExamined: number }
  align: Array<{ domLines: number; matched: number; unmatched: number }>
  rules: {
    source: 'cache' | 'network'
    ruleCount: number
    generatedAt: string
    fetchedAt: number
    stale: boolean
  } | null
  diags: Diag[]
}
