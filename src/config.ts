// config.ts — 常量 SSOT (URL/版本/键名集中一处, 消费点不自造)。

/**
 * 规则 bundle 发布端点候选 (跨仓契约: rules 仓 reports 分支, M2 管线产出)。
 * 依序尝试, 任一成功即用; 全部失败才诊断。主源 raw.githubusercontent.com 在
 * 部分网络 (如内网/受限地区) 长期不可达, jsDelivr GH CDN 为镜像候选。
 * 内网/私有镜像 = HOST_KEYS.bundleUrlOverride 手动覆盖 (单值, 优先于本列表)。
 */
export const RULES_BUNDLE_URLS = [
  'https://raw.githubusercontent.com/luochen1990/log-skimmer-rules/reports/rules-bundle.json',
  'https://cdn.jsdelivr.net/gh/luochen1990/log-skimmer-rules@reports/rules-bundle.json',
]

/** bundle manifest.format_version 期望值 (存在且不匹配即拒收; 键可省略 — 契约同 min_engine_version)。 */
export const BUNDLE_FORMAT_VERSION = 2

/** 缓存的 bundle 超过该天数 → overlay 显示 stale 提示 (不阻断功能)。 */
export const RULES_STALE_DAYS = 7

/** 宿主 storage 键 (GM storage 与 chrome.storage.local 共用同一键空间语义)。 */
export const HOST_KEYS = {
  bundle: 'lsk:rulesBundle',
  /** bundle URL 覆盖 (调试/镜像场景; e2e 用它指向本地 fixture)。 */
  bundleUrlOverride: 'lsk:bundleUrl',
} as const

/** 规则 bundle 网络拉取的超时 (ms) — 单源粒度; 多源串行总等待 ≈ 源数 × 该值。 */
export const RULES_FETCH_TIMEOUT_MS = 15_000

/** 同源日志 fetch 的超时 (ms)。 */
export const LOG_FETCH_TIMEOUT_MS = 20_000

/** observer debounce (ms) — 窗口内批次累积不可丢。 */
export const REPLAY_DEBOUNCE_MS = 120
