// forgejo.ts — forgejo 日志页适配器 (gitea 系, v16 实测 DOM)。
// 勘察事实 (本地 forgejo v16.0.5 实例, 2026-10-26, T4 PROTO-REPORT):
//   行: div.job-log-line#jobstep-<stepIdx>-<lineNo>  (.line-num 锚 + .log-msg 内容, ANSI 已转 span)
//   层级: .action-view-body > .job-step-container > .job-step-section > .job-step-logs
//   step 懒加载: 点折叠头才渲染该 step 行 (无虚拟化, 展开后全量在场, 多 step 可共存);
//   收起/展开不销毁行 DOM (注入属性存活, 无需重放)
//   全量数据: GET /api/v1/repos/{o}/{r}/actions/jobs/{job_id}/logs (纯文本; job_id 经
//             /actions/runs/{id}/jobs 列表按下标映射 — id 解析链见 resolveRunApiId)
// 坐标映射: skim 块在全量日志行坐标; DOM 行是 step 内局部行号 → alignStep 两指针对齐
//           (contentAligned: 行数变化 = 对齐失效, 增量 sync 整池重对齐)。

import { LOG_FETCH_TIMEOUT_MS } from '../config.ts'
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

interface ForgejoJob {
  id: number
  name: string
}

/** 页面 URL → {owner, repo, runId, jobIndex} (run 内下标 → job_id 的映射输入)。 */
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

/**
 * run 的 API id 候选链 (双 ID 体系: 页面 URL = 展示序号 Index, API = 内部主键 ID —
 * GetRunByIndex vs GetRunByID, v16.0.5 源码实证, 长寿实例必然分叉, 生产 207↔22044):
 * ① #repo-action-view[data-run-id] (SSR 内嵌, View handler 置 job.Run.ID);
 * ② GET /actions/runs?run_number={index} (ListActionRuns 序号过滤) 反查 entries[0].id;
 * ③ URL 序号 (首 run 实例 id==index 的历史兜底)。
 * 候选依序试 jobs 端点, 任一 200 即用 — 对 ①② 单点失效 (DOM 漂移 / API 形态差异)
 * 自愈; 全败报出自描述清单 (含人工核验 URL — 匿名/失权请求对私有仓恒 404, 与
 * id 错误同形态, 需并列呈现以区分)。
 */
async function fetchJobsList(owner: string, repo: string, runId: string): Promise<ForgejoJob[] | null> {
  const resp = await fetch(`/api/v1/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(LOG_FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) return null
  const list: unknown = await resp.json()
  const raw = Array.isArray(list) ? list : ((list as { jobs?: unknown[] }).jobs ?? [])
  return raw.filter((j): j is ForgejoJob => typeof (j as ForgejoJob)?.id === 'number')
}

/** run_number 反查: 序号 → 真实 ID (任何失败返回 null, 由候选链兜底)。 */
async function lookupIdByRunNumber(owner: string, repo: string, urlIndex: string): Promise<string | null> {
  try {
    const resp = await fetch(`/api/v1/repos/${owner}/${repo}/actions/runs?run_number=${urlIndex}`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(LOG_FETCH_TIMEOUT_MS),
    })
    if (!resp.ok) return null
    const data: unknown = await resp.json()
    const entries = Array.isArray(data) ? data : ((data as { entries?: unknown[] }).entries ?? [])
    const id = (entries[0] as { id?: number } | undefined)?.id
    return Number.isInteger(id) ? String(id) : null
  } catch {
    return null
  }
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

/** 候选命中后的源构造 (jobIndex → job_id 映射 + 失败诊断)。 */
function sourceFor(
  owner: string,
  repo: string,
  runId: string,
  jobs: ForgejoJob[] | null,
  jobIndex: number,
): LogSource[] {
  if (!jobs || jobs.length === 0) throw new Error(`run ${runId} has no jobs`)
  const job = jobs[jobIndex]
  if (!job) throw new Error(`job index ${jobIndex} not in run ${runId} (${jobs.length} jobs)`)
  return [
    {
      key: `job-${job.id}`,
      label: `job: ${job.name}`,
      url: `/api/v1/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`,
      fileName: `job-${job.id}.log`,
    },
  ]
}

export const forgejoAdapter = {
  name: 'forgejo',
  contentAligned: true,
  // match 纯 URL 判定 (时序稳定) → miss 即退出, 无需 DOM 重探。
  deferProbe: false,

  match(_doc: Document, loc: Location) {
    return /\/actions\/runs\/\d+\/jobs\/\d+/.test(loc.pathname)
  },

  /** 全量日志源: 整 job 单源 (候选链解析 run id → jobIndex 下标映射)。 */
  async logSources(doc: Document, loc: Location) {
    const { owner, repo, runId: urlIndex, jobIndex } = parseForgejoLoc(loc)
    const domId = doc.querySelector('#repo-action-view')?.getAttribute('data-run-id') ?? ''
    const candidates: Array<[id: string, via: string]> = []
    if (domId) candidates.push([domId, 'data-run-id'])
    const tried: string[] = []
    let jobs: ForgejoJob[] | null = null
    let runId = ''
    const tryId = async (id: string, via: string): Promise<boolean> => {
      const list = await fetchJobsList(owner, repo, id)
      tried.push(`${via}=${id}→${list ? 'ok' : '404'}`)
      if (!list) return false
      jobs = list
      runId = id
      return true
    }
    if (domId && (await tryId(domId, 'data-run-id'))) return sourceFor(owner, repo, runId, jobs, jobIndex)
    const lookupId = await lookupIdByRunNumber(owner, repo, urlIndex)
    if (lookupId && lookupId !== domId && (await tryId(lookupId, 'run_number'))) {
      return sourceFor(owner, repo, runId, jobs, jobIndex)
    }
    if (await tryId(urlIndex, 'url-index')) return sourceFor(owner, repo, runId, jobs, jobIndex)
    throw new Error(
      `fetch jobs list 404 — tried [${tried.join(', ')}]; open /api/v1/repos/${owner}/${repo}/actions/runs/${domId || urlIndex}/jobs in a browser tab: JSON = plugin bug (report), 404 = session/API auth issue`,
    )
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
