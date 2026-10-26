// config.ts — 常量 SSOT (URL/版本/键名集中一处, 消费点不自造)。

/** 规则 bundle 发布端点 (跨仓契约: rules 仓 reports 分支, M2 管线产出)。 */
export const RULES_BUNDLE_URL =
  'https://raw.githubusercontent.com/luochen1990/log-skimmer-rules/reports/rules-bundle.json'

/** bundle manifest.format_version 期望值 (不匹配即拒收)。 */
export const BUNDLE_FORMAT_VERSION = 2

/**
 * 引擎版本 — 与 vendors/engine.wasm 内的 engine crate 版本对应。
 * M1 前的 host 侧登记 (spike wasm 无 engine_version 导出); M1 产物新增导出后
 * 切换为 wasm 侧真实读取, 见 vendors/README.md 升级步骤。
 */
export const ENGINE_VERSION = '0.1.0'

/** 缓存的 bundle 超过该天数 → overlay 显示 stale 提示 (不阻断功能)。 */
export const RULES_STALE_DAYS = 7

/** GM storage 键。 */
export const GM_KEYS = {
  bundle: 'lsk:rulesBundle',
  /** bundle URL 覆盖 (调试/镜像场景; e2e 用它指向本地 fixture)。 */
  bundleUrlOverride: 'lsk:bundleUrl',
} as const

/** 同源日志 fetch 的超时 (ms)。 */
export const LOG_FETCH_TIMEOUT_MS = 20_000

/** observer debounce (ms) — 窗口内批次累积不可丢。 */
export const REPLAY_DEBOUNCE_MS = 120
