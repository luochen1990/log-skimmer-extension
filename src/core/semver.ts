// semver.ts — 极简 semver 比较 (仅 major.minor.patch, 容忍缺段/前导 v)。
// 范围: bundle manifest 的 min_engine_version 协商 — 不是通用 semver 实现
// (无 prerelease/build 元数据语义; 引擎版本号从未用过这些形态)。

export interface SemVer {
  major: number
  minor: number
  patch: number
}

export function parseSemVer(s: string): SemVer | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(s.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  }
}

/** a < b → -1; a > b → 1; 相等 → 0; 任一侧不可解析 → null (调用方决定拒收)。 */
export function compareSemVer(a: string, b: string): number | null {
  const pa = parseSemVer(a)
  const pb = parseSemVer(b)
  if (!pa || !pb) return null
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  return 0
}

export function semVerGte(a: string, b: string): boolean | null {
  const c = compareSemVer(a, b)
  return c === null ? null : c >= 0
}
