// rules.ts — 规则 bundle 的取数/校验/缓存/刷新 (跨仓契约的消费侧)。
// 契约: bundle 格式 SSOT = rules 仓生成管线 ({manifest, rules}, 见 src/config.ts URL);
//       本模块只消费不定义。缓存 = 宿主 storage (GM storage / chrome.storage.local,
//       键 HOST_KEYS.bundle), 版本协商 = manifest.format_version 匹配 +
//       min_engine_version ≤ wasm 侧引擎版本
//       (版本来源 = abi.ts readEngineVersion, 非 host 常量 — M1 产物导出)。
//       两键皆可省略 (契约 "无则省略该键"; 键省略时的放行与引擎侧
//       "无 manifest 照常装载" 对齐 — 值的判读书两侧另有差异, 见函数内注释) —
//       存在才协商, semver 解析失败 (缺段/非法) 按降级处理并报实际值。
// 策略: cache-first (离线可用; bundle 是唯一网络依赖) + SWR (过期后台重验证,
//       controller.ts 调用 — 只写缓存不动会话); 无缓存首拉失败 → 降级诊断;
//       手动刷新失败 → 保留旧缓存继续工作。

import {
  BUNDLE_FORMAT_VERSION,
  HOST_KEYS,
  RULES_BUNDLE_URLS,
  RULES_FETCH_TIMEOUT_MS,
  RULES_STALE_DAYS,
} from '../config.ts'
import type { HostEnv } from '../host.ts'
import type { BundleManifest, Diag, RulesBundle } from '../types.ts'
import { semVerGte } from './semver.ts'

export type RulesLoadResult =
  | {
      ok: true
      bundle: RulesBundle
      source: 'cache' | 'network'
      /** epoch ms — 缓存写入/网络拉取时间。 */
      fetchedAt: number
      stale: boolean
    }
  | { ok: false; diag: Diag }

interface CacheEntry {
  bundle: RulesBundle
  fetchedAt: number
}

/** 结构化校验 + 版本协商。返回人类可读拒收原因 (进诊断), 或规范化 bundle。 */
export function validateBundle(
  raw: unknown,
  engineVersion: string,
): { ok: true; bundle: RulesBundle } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'bundle is not a JSON object' }
  const b = raw as Record<string, unknown>
  const m = b.manifest
  if (typeof m !== 'object' || m === null) return { ok: false, reason: 'bundle.manifest missing' }
  const man = m as Record<string, unknown>
  // format_version 协商: 存在才检查 (含高于本构建 — 旧 userscript 读新格式);
  // 缺失 = 规则集未声明格式版本, 放行 (键省略语义与引擎侧一致 — 注意判等口径
  // 本仓比引擎严: 引擎判上界, 本处 !== 即拒, 防旧格式静默混入)。
  if (man.format_version !== undefined && man.format_version !== BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `bundle format_version ${String(man.format_version)} ≠ ${BUNDLE_FORMAT_VERSION} — update the userscript`,
    }
  }
  // min_engine_version 协商: 存在才检查; 类型损坏 (非 string) 同样拒收 —
  // 该键的唯一职责是挡旧引擎, 损坏形态静默放行 = 升级门失效 (宁拒勿错);
  // semver 任一侧不可解析 (null) 亦拒收, 文案报两侧实际值。
  const minEngine: unknown = man.min_engine_version
  if (minEngine !== undefined) {
    if (typeof minEngine !== 'string') {
      return {
        ok: false,
        reason: `bundle.manifest.min_engine_version is not a string: ${String(minEngine)}`,
      }
    }
    if (semVerGte(engineVersion, minEngine) !== true) {
      return {
        ok: false,
        reason: `bundle requires engine ≥ ${minEngine} (this build: ${engineVersion}) — update the userscript`,
      }
    }
  }
  if (!Array.isArray(b.rules) || b.rules.length === 0) {
    return { ok: false, reason: 'bundle.rules is empty' }
  }
  const rules: RulesBundle['rules'] = []
  const seen = new Set<string>()
  for (const r of b.rules) {
    if (typeof r !== 'object' || r === null)
      return { ok: false, reason: 'bundle.rules item is not an object' }
    const { id, path, yaml } = r as Record<string, unknown>
    if (typeof id !== 'string' || typeof path !== 'string' || typeof yaml !== 'string') {
      return { ok: false, reason: 'bundle.rules item missing id/path/yaml' }
    }
    if (seen.has(id)) return { ok: false, reason: `duplicate rule id: ${id}` }
    seen.add(id)
    rules.push({ id, path, yaml })
  }
  if (man.rule_count !== rules.length) {
    return {
      ok: false,
      reason: `manifest.rule_count ${String(man.rule_count)} ≠ rules.length ${rules.length}`,
    }
  }
  const manifest: BundleManifest = {
    rule_count: rules.length,
    generated_at: typeof man.generated_at === 'string' ? man.generated_at : '',
  }
  // 可选键原样保留 (有则协商过, 无则不虚构)。
  if (man.format_version !== undefined) manifest.format_version = man.format_version
  if (typeof man.min_engine_version === 'string') manifest.min_engine_version = man.min_engine_version
  return { ok: true, bundle: { manifest, rules } }
}

/** wasm 入参格式: [[源名, YAML 文本], ...] (源名用 path, 与 load_rules 目录装载语义一致)。 */
export function rulesJsonForWasm(bundle: RulesBundle): string {
  return JSON.stringify(bundle.rules.map((r) => [r.path, r.yaml]))
}

export class RulesStore {
  constructor(
    private readonly host: HostEnv,
    /** wasm 侧引擎版本 (版本协商事实来源 — boot 时经 readEngineVersion 读取)。 */
    private readonly engineVersion: string,
  ) {}

  /** 候选源: 手动覆盖 (单值, 调试/内网镜像) 优先, 缺省依序尝试发布端点列表。 */
  private async bundleUrls(): Promise<string[]> {
    const override = await this.host.getValue(HOST_KEYS.bundleUrlOverride)
    return override ? [override] : RULES_BUNDLE_URLS
  }

  private async readCache(): Promise<RulesLoadResult | null> {
    const raw = await this.host.getValue(HOST_KEYS.bundle)
    if (raw === undefined) return null
    let entry: CacheEntry
    try {
      entry = JSON.parse(raw) as CacheEntry
    } catch {
      return null // 缓存损坏视同无缓存
    }
    const v = validateBundle(entry.bundle, this.engineVersion)
    if (!v.ok) return null // 缓存版本协商不过 (如用户降级了脚本) → 重拉
    const ageDays = (Date.now() - entry.fetchedAt) / 86_400_000
    return {
      ok: true,
      bundle: v.bundle,
      source: 'cache',
      fetchedAt: entry.fetchedAt,
      stale: ageDays > RULES_STALE_DAYS,
    }
  }

  private async fetchNetwork(): Promise<RulesLoadResult> {
    const urls = await this.bundleUrls()
    let text: string | undefined
    const failures: string[] = []
    for (const url of urls) {
      try {
        const resp = await this.host.crossOriginFetch(url, RULES_FETCH_TIMEOUT_MS)
        text = resp.text
        break
      } catch (e) {
        failures.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (text === undefined) {
      return {
        ok: false,
        diag: {
          stage: 'rules',
          message: `rules bundle fetch failed (${urls.length} source(s) tried):\n${failures.join('\n')}`,
          hint:
            this.host.kind === 'bare'
              ? 'cross-origin fetch needs a host (Chrome extension or Tampermonkey) — install one'
              : urls.length === 1
                ? 'check network access to the configured bundle URL, then retry from the skim panel'
                : 'check network access to the bundle sources, then retry from the skim panel (a private mirror can be set via the lsk:bundleUrl storage key)',
        },
      }
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, diag: { stage: 'rules', message: 'rules bundle is not valid JSON' } }
    }
    const v = validateBundle(json, this.engineVersion)
    if (!v.ok) return { ok: false, diag: { stage: 'rules', message: `rules bundle rejected: ${v.reason}` } }
    const entry: CacheEntry = { bundle: v.bundle, fetchedAt: Date.now() }
    await this.host.setValue(HOST_KEYS.bundle, JSON.stringify(entry))
    return { ok: true, bundle: v.bundle, source: 'network', fetchedAt: entry.fetchedAt, stale: false }
  }

  /** cache-first; 无缓存首拉 (失败即降级诊断)。 */
  async load(): Promise<RulesLoadResult> {
    const cached = await this.readCache()
    if (cached) return cached
    return this.fetchNetwork()
  }

  /** 手动刷新 (强制网络); 失败返回错误结果, 调用方保留旧 bundle 继续工作。 */
  async refresh(): Promise<RulesLoadResult> {
    return this.fetchNetwork()
  }

  /**
   * 作废缓存 — bundle 通过了结构校验但被引擎拒收 (如 yaml 语法坏/引擎不兼容) 时
   * 调用 (缓存投毒自愈: 下次 load 无缓存 → 重拉)。
   */
  async invalidateCache(): Promise<void> {
    await this.host.deleteValue(HOST_KEYS.bundle)
  }
}
