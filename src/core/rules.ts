// rules.ts — 规则 bundle 的取数/校验/缓存/刷新 (跨仓契约的消费侧)。
// 契约: bundle 格式 SSOT = rules 仓生成管线 ({manifest, rules}, 见 src/config.ts URL);
//       本模块只消费不定义。缓存 = GM storage (键 GM_KEYS.bundle), 版本协商 =
//       manifest.format_version 严格匹配 + min_engine_version ≤ 本构建 ENGINE_VERSION。
// 策略: cache-first (离线可用; bundle 是唯一网络依赖); 无缓存首拉失败 → 降级诊断;
//       手动刷新失败 → 保留旧缓存继续工作。

import {
  BUNDLE_FORMAT_VERSION,
  ENGINE_VERSION,
  GM_KEYS,
  RULES_BUNDLE_URL,
  RULES_STALE_DAYS,
} from '../config.ts'
import type { GmEnv } from '../gm.ts'
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
  if (man.format_version !== BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `bundle format_version ${String(man.format_version)} ≠ ${BUNDLE_FORMAT_VERSION} — update the userscript`,
    }
  }
  if (typeof man.min_engine_version !== 'string') {
    return { ok: false, reason: 'bundle.manifest.min_engine_version missing' }
  }
  const gte = semVerGte(engineVersion, man.min_engine_version)
  if (gte !== true) {
    return {
      ok: false,
      reason: `bundle requires engine ≥ ${man.min_engine_version} (this build: ${engineVersion}) — update the userscript`,
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
    format_version: man.format_version,
    min_engine_version: man.min_engine_version,
    rule_count: rules.length,
    generated_at: typeof man.generated_at === 'string' ? man.generated_at : '',
  }
  return { ok: true, bundle: { manifest, rules } }
}

/** wasm 入参格式: [[源名, YAML 文本], ...] (源名用 path, 与 load_rules 目录装载语义一致)。 */
export function rulesJsonForWasm(bundle: RulesBundle): string {
  return JSON.stringify(bundle.rules.map((r) => [r.path, r.yaml]))
}

export class RulesStore {
  constructor(private readonly gm: GmEnv) {}

  private async bundleUrl(): Promise<string> {
    return (await this.gm.getValue(GM_KEYS.bundleUrlOverride)) || RULES_BUNDLE_URL
  }

  private async readCache(): Promise<RulesLoadResult | null> {
    const raw = await this.gm.getValue(GM_KEYS.bundle)
    if (raw === undefined) return null
    let entry: CacheEntry
    try {
      entry = JSON.parse(raw) as CacheEntry
    } catch {
      return null // 缓存损坏视同无缓存
    }
    const v = validateBundle(entry.bundle, ENGINE_VERSION)
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
    const url = await this.bundleUrl()
    let text: string
    try {
      const resp = await this.gm.crossOriginFetch(url, 15_000)
      text = resp.text
    } catch (e) {
      return {
        ok: false,
        diag: {
          stage: 'rules',
          message: `rules bundle fetch failed: ${e instanceof Error ? e.message : String(e)}`,
          hint: this.gm.managed
            ? `check network access to ${url}, then retry from the skim panel`
            : `cross-origin fetch needs a userscript manager (Tampermonkey) — install it, or check ${url}`,
        },
      }
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, diag: { stage: 'rules', message: `rules bundle at ${url} is not valid JSON` } }
    }
    const v = validateBundle(json, ENGINE_VERSION)
    if (!v.ok) return { ok: false, diag: { stage: 'rules', message: `rules bundle rejected: ${v.reason}` } }
    const entry: CacheEntry = { bundle: v.bundle, fetchedAt: Date.now() }
    await this.gm.setValue(GM_KEYS.bundle, JSON.stringify(entry))
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
}
