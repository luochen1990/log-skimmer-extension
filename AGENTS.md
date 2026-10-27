# log-skimmer-web 维护者文档

> 职责边界: 本仓 = log-skimmer 生态的浏览器交付面 (userscript)。README 写接口面 (安装/使用),
> 本文写实现约定 (给维护者与 agent)。跨仓契约的 SSOT 不在此处 — 见下表引用。

## 布局

- `src/` — TypeScript (严格模式, ESM 源 → esbuild IIFE 产物):
  - `types.ts` — 协议类型 SSOT: SkimResult JSON (引擎 serde 镜像) / bundle 契约 / Adapter 接口 / 诊断与报告面。
  - `config.ts` — 常量 SSOT (bundle URL / 版本 / GM 键 / 超时)。
  - `host.ts` — 宿主服务抽象 (storage + 跨域 GET): 三实现按探测择一
    (userscript GM_* → chrome.storage.local+fetch → localStorage 降级), GM 优先于 chrome
    (Tampermonkey 沙箱内 chrome.storage 指 TM 自身存储)。
  - `sw.ts` — MV3 background service worker 入口: 扩展形态的 wasm 计算引擎宿主
    (消息协议 `{t:'v'}`/`{t:'skim'}`, 与 `core/abi-rpc.ts` 成对 SSOT; engine.wasm 包内裸文件)。
  - `controller.ts` — 编排: 适配器探测 → **abi 分派** (extension=SW RPC / 其余=本地 wasm)
    → 规则 (版本协商用 abi 侧版本) → 取数+skim → 呈现双轨 → observer 重放。
  - `core/` — 页面无关核心: `abi.ts` (wasm 薄壳, T1 ABI 纪律, 模块级 compile 缓存;
    `SkimAbi.skimJson` 统一 async — RPC 通道兼容) / `abi-rpc.ts` (SkimAbi 的 SW 消息通道
    实现, 扩展形态专用) / `engine.ts` / `align.ts`
    (forgejo 两指针对齐: 归一化四件套 + **首行锚定** — DOM 行集可对应全量任意连续段,
    非仅前缀; `poolFingerprint` 池漂移哨兵 SSOT) / `rules.ts`
    (bundle 校验/缓存/版本协商/作废) / `semver.ts` / `intent.ts` (intent 优先级/配色/
    块主 intent 单点) / `inline.ts` (幂等注入, clearAll/clearPool) / `observer.ts` (重放驱动) /
    `overlay.ts` (摘要面板)。
  - `adapters/` — 页面知识孤岛: `github.ts` (data-log-url + data-index 直映, deferProbe) /
    `forgejo.ts` (job API + 对齐映射)。新增 CI 平台 = 新增一个 adapter 文件。

### CSP 实测事实 (2026-10-26/27, 形态架构依据)

github.com 页面 CSP (`script-src github.githubassets.com 'sha256-…'`, 无 `wasm-unsafe-eval`)
拒绝 **页面世界与 content script isolated world 双方**的 `WebAssembly.compile` (后者为
真实扩展环境实测, Playwright + --load-extension; 推翻 "isolated world 不受页面 CSP 约束"
的预判)。因此扩展形态的 wasm 计算必须且只能在 background service worker (扩展自身 CSP,
manifest `extension_pages` 显式放行 `wasm-unsafe-eval`)。e2e 的 extension.spec.ts 严格
CSP fixture 用例 = 防 "wasm 挪回页面世界" 的回归锚。userscript 形态在 github.com 结构性
不可行, 仅作 CSP 宽松环境 (自托管 forgejo 等) 备选。
- `fixtures/` — e2e 基底: `github/` (T4 仿真: 虚拟化 + 重渲染 + 真实语料) /
  `forgejo/` (M3: 手工 .job-step-logs + append/rewrite 渐进渲染控制, API 由 e2e route
  拦截 — 兼作活体实例停运退路) / `degrade/` (无端点/403/404/非 CI 页) /
  `rules-bundle.json` (跨仓契约格式的本地构造副本)。
- `scripts/` — `build.mjs` (源构建 wasm (引擎仓, `LOG_SKIMMER_WASM_SRC` 可覆盖)
  → gzip+base64 内嵌 + esbuild + userscript banner) /
  `serve.mjs` (8801 静态服务, CORS 全开, `/_status/<code>/` 状态码仿真) /
  `make-local-bundle.mjs` (规则仓 checkout → fixtures bundle, dev 工具)。
- `e2e/` — Playwright: `harness.ts` (GM shim + 注入) + 五个 spec (github 主链路+M1/M4 /
  degrade 含 M2 自愈 / forgejo fixture (M3 grown/同数异容) / forgejo 活体 /
  engine-version 版本协商专题) + `shots/` 交付截图。

## 实现约定

- **架构三不变式** (spike T4 结论, 违反即架构回归): ① 状态外置 (标注按 `(source, line)`
  外置, 行 DOM 是临时物); ② 幂等 sync 是唯一注入路径 (初始 pass 与 observer 重放共用
  `syncInline`, 增量批次只扫 mutation 涉及的新节点 — `sync.lastExamined` 是增量性的可断言面;
  自家 UI 变更 (#lsk-overlay/#lsk-fab) 在批次入口过滤, 防自激励); ③ 事件驱动重放
  (任何重建/懒加载/虚拟化收敛为 "sync 一遍")。
- **池漂移协议 (contentAligned 适配器)**: 池指纹 (`poolFingerprint` = 行数+全行文本,
  同数异容可察, 首末采样有中段盲区故取全量) 变化 = 对齐失效 → 先 `stripPool` (作废该池
  前缀键标注 + `clearPool` 剥离 DOM 痕迹含幂等签名) 再整池重对齐重注入 — 残留旧标注会
  错位 (M3)。非 contentAligned (github 直映) 不参与。
- **激活竞态 (M1)**: adapter 可声明 `deferProbe` (match 依赖渐进渲染的 DOM) — controller
  探测 miss 时等 DOMContentLoaded 后有界重探 (500ms×20); 时序稳定的 adapter (纯 URL
  判定) miss 即退出, 不空等。
- **缓存投毒自愈 (M2)**: bundle 过结构校验 ≠ 引擎可执行 — boot/refresh 建引擎后跑
  `engineProbe` (单行最小 skim; 空日志会被引擎 "日志为空" 校验拒掉, 探针必须非空),
  失败即 `invalidateCache` + fatal/诊断提示 reload。
- **B1 教训 (控件态闭环)**: 任何影响注入形态的控件走 "改态 → sync" 而非直接改 DOM;
  off 必须清幂等签名 (否则重放对新行注入、旧行残留); on 必须主动补 sync (无 DOM 变更
  则无重放事件)。**每个新控件都要补 "toggle 后滚动/重渲染" 的 e2e 用例**。
  触发异步动作的控件 (⟳ rules) 补 pending disabled + busy 防重入 (n8)。
- **sourceForStep 严格匹配**: 不做 "任意可用源" 兜底 — 兜底会把别的 step 的源标注到
  本池 → 错位高亮 (M4); stepKey 匹配不上就零注入 (可诊断的静默)。
- **wasm ABI 纪律** (T1, `src/core/abi.ts` 头注释): UTF-8 字节长 alloc / 逐段 alloc→建
  视图→写 (跨调用旧视图会被 memory 增长 detach, 读前必须重建) / 4B LE 前缀读 /
  free 带原 cap / 异常路径 finally 归还。ABI 变更须与引擎仓联动。
- **规则消费纪律**: bundle 格式 SSOT = rules 仓生成管线, 本仓只消费; 校验
  (`validateBundle`) 对 format_version / min_engine_version / 结构 / rule_count 全严格
  (宁拒勿错, 有诊断)。缓存 cache-first; 刷新失败保留旧 bundle。
- **日志取数**: 恒同源 + `credentials: 'same-origin'`; 跨域仅 bundle (多源依序
  fallback: raw 主源 + jsDelivr 镜像, 全败诊断列各源原因; `lsk:bundleUrl` 覆盖
  优先于列表 — 内网镜像入口。`@connect` 需同时放行两域)。
- **forgejo 双 ID 体系**: 页面 URL = 展示序号 Index, API = 内部主键 ID (v16.0.5
  源码 GetRunByIndex vs GetRunByID, 长寿实例必然分叉, 生产 207↔22044) — run id
  解析链: `#repo-action-view[data-run-id]` (SSR 内嵌) → `/actions/runs?run_number=`
  反查; 禁止用 URL 序号直拼 API。
- **零运行时依赖** — 产物不 import 任何 npm 包; 工具链全 devDependencies
  (版本 SSOT = package-lock.json, `npm ci` 复现)。devShell 只提供 node/just/jq/rg。
- **userscript 产物**: 单文件 IIFE (生态约束), wasm gzip+base64 内嵌 (~0.75 MiB),
  `@version` SSOT = package.json (构建期注入 banner)。源码保持 ESM。
- **TS 纪律**: 严格模式全开 (noUncheckedIndexedAccess / exactOptionalPropertyTypes);
  源码 import 一律带 `.ts` 扩展名 (node --test 直跑 + esbuild 双兼容); 单测只测纯逻辑
  (align/semver/rules), DOM 行为全部走 e2e。
- **e2e 离线纪律**: 测试不得触真实网络 — bundle/日志全走本地 fixture 服务; 对默认
  raw.githubusercontent.com 的用例必须 route 拦截。GM_* 用 harness 的测试 shim
  (localStorage 持久化, 可预置缓存)。

## 跨仓契约引用 (SSOT 均在对方仓, 此处只登记接口)

| 契约                                                                                | SSOT 位置                                               | 本仓消费点                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| wasm ABI (`wasm_alloc`/`wasm_free`/`wasm_skim_json`/`wasm_engine_version`, 4B 前缀) | 引擎仓 `log-skimmer-wasm` crate (master, PR #101)       | `src/core/abi.ts` + 构建期源构建 (`scripts/build.mjs`) |
| 规则 bundle 格式 + 发布端点                                                         | rules 仓生成管线 (`reports` 分支)                       | `src/core/rules.ts` + `src/config.ts`                  |
| SkimResult JSON 协议                                                                | 引擎仓 serde (CLI --json 同协议)                        | `src/types.ts`                                         |
| GitHub job 页 DOM 事实                                                              | spike T3 DOM-REPORT (登录墙内未实测项见 github.ts TODO) | `src/adapters/github.ts`                               |
| Forgejo v16 job 页 DOM 事实                                                         | spike T4 PROTO-REPORT (本地真实实例勘察)                | `src/adapters/forgejo.ts`                              |

## 已知未决 (登记在案的待办)

- `hiddenLineCount` 偏移 (GitHub 显示行号 vs data-index, 登录墙内未实测) —
  `src/adapters/github.ts` 头部 TODO, fixture 已按已知语义 (文本行 ↔ data-index 一一对应) 建模。
- GitHub 真实 DOM 的 cluster wrapper 选择器 (jumpTo 目前用 fixture 契约 `.lsk-cluster`) —
  同文件 TODO, 登录态实测后只改一处。
- 构建期 wasm 源 = 引擎仓 feat-wasm worktree (临时路径, M1 未合入 master) —
  生产 CI 自建源 (web 仓 CI 装 rust + wasm32 target checkout 引擎仓) 是切换点,
  见 scripts/build.mjs 注释。
- **forgejo 活体 e2e 依赖本地实例 (127.0.0.1:3999, T4 遗留), 不可达自动 skip —
  skip 后 forgejo 基本链路仍由 `fixtures/forgejo/` fixture e2e 兜底 (M3 起补齐:
  单源/对齐/grown/同数异容), 活体独有面 (Vue 渲染管线/懒加载交互) 缺口,
  复跑 `spike-proto/scripts/forgejo-dev/run-local-forgejo.sh` 恢复。

## 验证链

`just check` = lint (biome, --error-on-warnings) → build (esbuild, 生成 src/generated/) →
typecheck (tsc --noEmit) → unit (node --test) → e2e (playwright, webServer 自管 8801)。
构建在 typecheck 前是刻意的: tsc 需要构建期生成的 wasm-b64 模块。
