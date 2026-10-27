// tokens.ts — 面板设计 token 单点 (SSOT): 中性色/语义色/字体/圆角/阴影全部集中此处,
// 以 CSS custom properties 形式注入 overlay 的 shadow root (:host 作用域, 宿主页不可见)。
// 暗色 = prefers-color-scheme 覆盖, 色值与 GitHub Primer Dark 同源 — 与宿主 GitHub Dark
// 视觉共生 (浅色页取 Primer Light 同源)。流内样式 (inline.ts/fold.ts) 是宿主 DOM 的
// 页面级注入, 不消费本 token (避免变量泄漏进宿主页), 语义色以 intent.ts 常量为准。

export const OVERLAY_TOKENS = `
:host {
  all: initial;
  /* 中性色 (Primer Light) */
  --lsk-bg: #ffffff;
  --lsk-bg-soft: #f6f8fa;
  --lsk-fg: #1f2328;
  --lsk-fg-dim: #59636e;
  --lsk-fg-faint: #8c959f;
  --lsk-border: #d1d9e0;
  --lsk-border-soft: #e7ecf0;
  --lsk-accent: #0969da;
  --lsk-accent-soft: #ddf4ff;
  /* intent 语义色 (与 intent.ts 常量同源; 暗色在下方覆盖) */
  --lsk-failure-fg: #cf222e;
  --lsk-failure-bg: #ffebe9;
  --lsk-warning-fg: #82460a;
  --lsk-warning-bg: #fff8c5;
  --lsk-info-fg: #0969da;
  --lsk-info-bg: #ddf4ff;
  --lsk-tip-bg: #24292f;
  --lsk-tip-fg: #ffffff;
  /* 形状/层次 */
  --lsk-r-sm: 6px;
  --lsk-r-md: 8px;
  --lsk-r-lg: 12px;
  --lsk-shadow: 0 1px 3px rgba(31,35,40,.08), 0 12px 36px rgba(31,35,40,.22);
  --lsk-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  --lsk-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
}
@media (prefers-color-scheme: dark) {
  :host {
    /* 中性色 (Primer Dark) */
    --lsk-bg: #161b22;
    --lsk-bg-soft: #21262d;
    --lsk-fg: #e6edf3;
    --lsk-fg-dim: #9198a1;
    --lsk-fg-faint: #6e7681;
    --lsk-border: #30363d;
    --lsk-border-soft: #21262d;
    --lsk-accent: #4493f8;
    --lsk-accent-soft: rgba(56,139,253,.18);
    /* intent: 暗色提高前景亮度, 背景降为低饱和叠层 */
    --lsk-failure-fg: #f85149;
    --lsk-failure-bg: rgba(248,81,73,.14);
    --lsk-warning-fg: #d29922;
    --lsk-warning-bg: rgba(187,128,9,.16);
    --lsk-info-fg: #4493f8;
    --lsk-info-bg: rgba(56,139,253,.16);
    --lsk-tip-bg: #6e7681;
    --lsk-tip-fg: #0d1117;
    --lsk-shadow: 0 1px 3px rgba(1,4,9,.4), 0 12px 36px rgba(1,4,9,.65);
  }
}
/* intent 工具类: 面板内徽章/胶囊/icon 统一走 bg+color 成对 (双主题对比度有保) */
.t-failure { background: var(--lsk-failure-bg); color: var(--lsk-failure-fg); }
.t-warning { background: var(--lsk-warning-bg); color: var(--lsk-warning-fg); }
.t-info    { background: var(--lsk-info-bg);    color: var(--lsk-info-fg); }
`
