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

/** wasm skim_json 返回的 envelope。 */
export type SkimEnvelope = { ok: true; result: SkimResult } | { ok: false; error: string }

// ---------- 规则 bundle 跨仓契约 ----------

export interface BundleManifest {
  format_version: number
  min_engine_version: string
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
  noToFull: Map<number, number>
  inverse: Map<number, number>
  /** 对齐时的池指纹 (行数+首末行文本) — 指纹变化 = 池内容漂移, 缓存失效。 */
  fp: string
  lineCount: number
  stepKey: string
  stats: { domLines: number; matched: number; unmatched: number }
}

export interface AdapterCtx {
  /** forgejo: stepKey → 对齐缓存 (行数变化即失效重算)。 */
  aligns: Map<string, AlignResult>
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
