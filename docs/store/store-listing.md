# Chrome Web Store 上架材料包 (store-listing)

> 用途: CWS 开发者控制台逐字段填写的 SSOT。提交时按本文件逐项对照;
> 隐私政策 URL 取本仓 GitHub 渲染页: <https://github.com/luochen1990/log-skimmer-extension/blob/main/docs/store/privacy-policy.md>

## Store listing 字段

### Name (显示名, ≤75 字符)

```
log-skimmer: CI failure log highlights
```

### Summary (≤132 字符)

```
Inline failure highlights + a skim summary panel on GitHub Actions / self-hosted Forgejo job logs. Local-only.
```

### Description

```markdown
CI failure logs run to tens of thousands of lines — the actual evidence is a few dozen.

log-skimmer highlights that evidence directly on the job-log page:

• Inline highlights — matched lines get an intent-colored edge, icon and tooltip (✕ failure / ⚠ warning / ℹ info), surviving virtualization, lazy-loading and re-renders.
• Skim panel — a floating summary: evidence blocks with page-native line numbers, one-click jump, and unmatched ranges folded to "⋯ N lines".
• Auto-expand — collapsed step groups that contain matches are expanded for you.
• Local-only — the full log is fetched with your existing session and analyzed by an embedded WebAssembly engine in your browser. No accounts, no telemetry, no servers; log content never leaves your machine.
• Degraded, never broken — behind a login wall, on 403s, or when rule download fails, you get a panel explaining what happened instead of a silently broken page.

The rule set is maintained in the open at log-skimmer-rules (community + AI-assisted contributions), fetched from a public CDN with multi-source fallback, and cached for offline use. That bundle — pure data, never code — is the only network dependency.

Works on:
• github.com Actions job pages (Chrome extension form; a Tampermonkey userscript is available for CSP-lenient hosts like self-hosted Forgejo)
• Self-hosted Forgejo job pages

Open source (Apache-2.0): https://github.com/luochen1990/log-skimmer-extension
```

### Category / Language

- Category: **Developer Tools**
- Language: **English** (可后补 zh-CN 第二语言 listing)

### Graphics (上传 docs/store/assets/)

| 资产            | 文件                            | 规格     |
| --------------- | ------------------------------- | -------- |
| 截图 1 (主张图) | `screenshot-1-github-light.png` | 1280×800 |
| 截图 2          | `screenshot-2-github-dark.png`  | 1280×800 |
| 截图 3          | `screenshot-3-forgejo-dark.png` | 1280×800 |
| 小宣传图        | `promo-440x280.png`             | 440×280  |

### Privacy practice (数据使用披露)

- Privacy policy URL: 见文首链接
- 勾选声明 (dashboard "Data usage" 表单):
  - **Website content** — 勾 "…is being processed" (本地读取日志页内容做高亮/摘要, 不离开浏览器); **不勾** collect/transmit 类
  - 其余类别 (Personal communications / Authentication info / Personal identifiers / Health / Financial …) — 全部不勾
  - "No data is collected, sold, or used for purposes unrelated to the item's single purpose" — 勾选确认

## 审核答辩 notes (Review notes 栏或质询回复用)

### 单一用途 (single purpose)

Highlight and summarize CI job-log failure evidence on code-hosting platforms'
Actions log pages. Nothing else.

### 逐权限说明

| 权限                                                                                | 说明                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                                                           | 本地缓存规则 bundle 与面板开关状态; 不存储任何用户身份数据                                                                                                                                                                      |
| content_scripts @ `github.com/*/*/actions/runs*`, `github.com/*/*/commit/*/checks*` | GitHub Actions job 日志页注入高亮/面板                                                                                                                                                                                          |
| content_scripts @ `*://*/*/*/actions/runs*`                                         | **广域匹配的必要性**: Forgejo 是自托管软件, 实例域名任意 (企业内网/私有部署), 无法枚举; 匹配严格限定在 CI job 日志 URL 路径 (`/{owner}/{repo}/actions/runs/…`), 非全站; 行为与 github.com 完全一致 — 读日志内容本地渲染, 零外发 |

### 无远程代码 (remote code) 声明

- 扩展仅加载自身打包资源; 规则 bundle 是 **数据** (YAML 文本, 经本地 wasm 引擎解析), 不经 `eval`/动态注入, 不可能执行 — 符合 MV3 remote code 禁令。
- bundle 来源为公开只读 CDN (raw.githubusercontent.com / cdn.jsdelivr.net, `Access-Control-Allow-Origin: *`), 用户可经 `lsk:bundleUrl` 覆盖; 请求不携带任何用户标识。

### 审核者复验路径

1. 安装后打开任一公开仓 GitHub Actions 失败 job 页, 例:
   `https://github.com/denoland/deno/actions/runs/40315870034/job/121548196796`
   (若链接随时间失效: 任取公开仓失败 run → 点开失败 job)
2. 右下角出现 **skim** 按钮 → 点击 → 面板列出失败证据块, 行号与页面原生行号对齐;
   命中行有色彩边条 + icon; 未匹配段折叠为 "⋯ N lines"。
3. 自托管 Forgejo 形态: 无法提供公网实例 (自托管软件), 可在本地 `forgejo` 实例验证
   (源码仓库 README 有 fixture/e2e 复现路径: `just check` 全链 e2e)。

### 新账号审核预期

- 首次提交通常人工审 2–7 天; 若因广域匹配被质询/拒绝, 回复模板:
  > The broad host match is required because Forgejo (a self-hostable code
  > hosting platform) instances live on arbitrary domains — commonly corporate
  > intranets. The pattern is strictly path-scoped to CI job-log URLs
  > (`/{owner}/{repo}/actions/runs/…`) and behaves identically to the
  > github.com match: page content is read locally to render highlights, and
  > no data ever leaves the browser. A store-version restricted to github.com
  > would silently break the Forgejo use case.
- 若仍被拒 (rare): 降级预案 = 商店版收敛 github.com 专属 (manifest 单行改动),
  Forgejo 用户走 userscript 渠道 (README 已载安装法)。
