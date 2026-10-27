// forgejo.ts — forgejo 日志页适配器 (gitea 系, v16 实测 DOM)。
// 勘察事实 (本地 forgejo v16.0.5 实例, 2026-10-26, T4 PROTO-REPORT):
//   行: div.job-log-line#jobstep-<stepIdx>-<lineNo>  (.line-num 锚 + .log-msg 内容, ANSI 已转 span)
//   层级: .action-view-body > .job-step-container > .job-step-section > .job-step-logs
//   step 懒加载: 点折叠头才渲染该 step 行 (无虚拟化, 展开后全量在场, 多 step 可共存);
//   收起/展开不销毁行 DOM (注入属性存活, 无需重放)
//   全量数据: GET /actions/runs/{序号}/jobs/{下标}/attempt/{N}/logs (web 路由, 纯文本) —
//             直接吃页面 URL 同款序号 (服务端 GetRunByIndex 解析), 会话认证与页面渲染
//             同通路。刻意的架构选择 (M4 生产教训): /api/v1 路径天然不通 — API 只吃
//             token 不吃会话 cookie, 私有仓上浏览器会话请求恒 404 "target not found"
//             (与 id 错误同形态, 生产实测 207↔22044 解析全对仍 404); web 路由零 ID
//             解析、零认证问题, 双缺陷一并消除。
// 坐标映射: skim 块在全量日志行坐标; DOM 行是 step 内局部行号 → alignStep 两指针对齐
//           (contentAligned: 行数变化 = 对齐失效, 增量 sync 整池重对齐)。

import { alignStep, poolFingerprint } from '../core/align.ts'
import { topFragment } from '../core/intent.ts'
import type {
  Adapter,
  AdapterCtx,
  AlignResult,
  LineEntry,
  LoadedSource,
  LogSource,
  OutputBlock,
} from '../types.ts'

/** 页面 URL → {owner, repo, runId, jobIndex} (web 日志路由的直拼输入)。 */
export function parseForgejoLoc(loc: Location): {
  owner: string
  repo: string
  runId: string
  jobIndex: number
} {
  const m = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/jobs\/(\d+)/.exec(loc.pathname)
  const owner = m?.[1]
  const repo = m?.[2]
  const runId = m?.[3]
  const jobIndex = m === null || m[4] === undefined ? Number.NaN : Number(m[4])
  if (!owner || !repo || !runId || !Number.isInteger(jobIndex)) {
    throw new Error(`not a forgejo job page: ${loc.pathname}`)
  }
  return { owner, repo, runId, jobIndex }
}

/** 行元素 → [{no, text, el}] (no = step 内局部行号, 取自 id, 1-based; 非 jobstep-N-M id 滤除)。 */
function lineEntries(els: HTMLElement[]): LineEntry[] {
  return els
    .map((el) => {
      const m = /^jobstep-(\d+)-(\d+)$/.exec(el.id)
      return {
        no: m ? Number(m[2]) : Number.NaN,
        text: el.querySelector('.log-msg')?.textContent ?? el.textContent ?? '',
        el,
      }
    })
    .filter((l) => Number.isInteger(l.no))
}

export const forgejoAdapter = {
  name: 'forgejo',
  contentAligned: true,
  // match 纯 URL 判定 (时序稳定) → miss 即退出, 无需 DOM 重探。
  deferProbe: false,

  match(_doc: Document, loc: Location) {
    return /\/actions\/runs\/\d+\/jobs\/\d+/.test(loc.pathname)
  },

  /**
   * 全量日志源: 整 job 单源 — web 日志路由直拼 (页面 URL 同款序号, 零 ID 解析)。
   * attempt 号: URL /attempt/N 优先 → SSR data-attempt-number → 终退 1。
   */
  async logSources(doc: Document, loc: Location) {
    const { owner, repo, runId, jobIndex } = parseForgejoLoc(loc)
    const attempt =
      /\/attempt\/(\d+)/.exec(loc.pathname)?.[1] ??
      doc.querySelector('#repo-action-view')?.getAttribute('data-attempt-number') ??
      '1'
    return [
      {
        key: `job-${runId}-${jobIndex}-a${attempt}`,
        label: `job #${jobIndex} · attempt ${attempt}`,
        url: `/${owner}/${repo}/actions/runs/${runId}/jobs/${jobIndex}/attempt/${attempt}/logs`,
        fileName: `job-${jobIndex}-a${attempt}.log`,
      },
    ] satisfies LogSource[]
  },

  sourceForStep(loaded) {
    return loaded.find((s) => s.ok) ?? loaded[0]
  },

  /**
   * 块(全量坐标) → step 内行标注: 两指针对齐 (缓存 per stepKey, 指纹变化即重算 —
   * 同数异容也能察觉; 调用方在增量 sync 中据指纹漂移整池重扫)。
   */
  annotateStep(src, stepKey, lines, emit, ctx): AlignResult | null {
    if (!src.ok) return null
    const fp = poolFingerprint(lines)
    let a = ctx.aligns.get(stepKey)
    if (!a || a.fp !== fp) {
      const r = alignStep(lines, src.text.split('\n'))
      a = {
        inverse: new Map([...r.noToFull].map(([no, f]) => [f, no])),
        fp,
        stepKey,
        stats: r.stats,
      }
      ctx.aligns.set(stepKey, a)
    }
    for (const blk of src.result.blocks) {
      const frag = topFragment(blk)
      if (!frag) continue
      for (let f0 = blk.start_line - 1; f0 <= blk.end_line - 1; f0++) {
        const no = a.inverse.get(f0)
        if (no !== undefined) emit(forgejoAdapter.lineKey(stepKey, no), frag)
      }
    }
    return a
  },

  observeRoot(doc) {
    // body 而非 .action-view-body: PJAX/局部刷新可能替换日志区容器。
    return doc.body
  },

  /** 在场 step 日志池: .job-step-logs (懒加载后非空)。stepKey 取池内首个行 id 的 step 号。 */
  stepLogs(doc) {
    return [...doc.querySelectorAll<HTMLElement>('.job-step-logs')].filter((el) =>
      el.querySelector('.job-log-line'),
    )
  },

  stepKeyOf(logsEl, doc) {
    const m = /^jobstep-(\d+)-/.exec(logsEl.querySelector('.job-log-line')?.id ?? '')
    if (m) return `jobstep-${m[1]}`
    return `logs-${[...doc.querySelectorAll('.job-step-logs')].indexOf(logsEl)}`
  },

  /** 池内行迭代 (no = step 内局部行号, 取自 id, 1-based)。 */
  linesOf(logsEl) {
    return lineEntries([...logsEl.querySelectorAll<HTMLElement>('.job-log-line')])
  },

  /** 增量 sync: subtree 自身是行则只含自身, 否则枚举子树内行 (lazy append 的行节点)。 */
  linesIn(subtree) {
    const els =
      subtree instanceof HTMLElement && subtree.classList.contains('job-log-line')
        ? [subtree]
        : [...subtree.querySelectorAll<HTMLElement>('.job-log-line')]
    return lineEntries(els)
  },

  /** 外置状态 key: `${stepKey}:${no}` (no = step 内局部行号; 全量块坐标 → 局部行映射见 annotateStep)。 */
  lineKey(stepKey, no) {
    return `${stepKey}:${no}`
  },

  poolKeyPrefix(stepKey) {
    return `${stepKey}:`
  },

  /** 原生流内跳转 (overlay 联动): 全量行号 → 经对齐逆映射到 step 内行 → id 锚定位。 */
  jumpTo(_src: LoadedSource, blk: OutputBlock, ctx: AdapterCtx) {
    for (const a of ctx.aligns.values()) {
      const no = a.inverse.get(blk.start_line - 1)
      if (no !== undefined) {
        const el = document.getElementById(`${a.stepKey}-${no}`)
        if (!el) continue
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.animate?.([{ background: '#fff3cd' }, { background: '' }], { duration: 1200 })
        return true
      }
    }
    return false
  },
} satisfies Adapter
