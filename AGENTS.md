# log-skimmer-web 维护者文档

> 职责边界: 本仓 = log-skimmer 生态的浏览器交付面 (userscript)。README 写接口面 (安装/使用),
> 本文写实现约定 (给维护者与 agent)。跨仓契约的 SSOT 不在此处 — 见下表引用。

## 布局

- `src/` — TypeScript (严格模式, ESM 源 → esbuild IIFE 产物):
  - `types.ts` — 协议类型 SSOT: SkimResult JSON (引擎 serde 镜像) / bundle 契约 / Adapter 接口 / 诊断与报告面。
  - `config.ts` — 常量 SSOT (bundle URL / 版本 / GM 键 / 超时)。
  - `gm.ts` — Tampermonkey GM_* 门面 (唯一管理器接触点; 无管理器自动降级 localStorage+fetch)。
  - `controller.ts` — 编排: 适配器探测 → 规则 → wasm → 取数+skim → 呈现双轨 → observer 重放。
  - `core/` — 页面无关核心: `abi.ts` (wasm 薄壳, T1 ABI 纪律) / `engine.ts` / `align.ts`
    (forgejo 两指针对齐, 归一化四件套) / `rules.ts` (bundle 校验/缓存/版本协商) /
    `semver.ts` / `inline.ts` (幂等注入) / `observer.ts` (重放驱动) / `overlay.ts` (摘要面板)。
  - `adapters/` — 页面知识孤岛: `github.ts` (data-log-url + data-index 直映) /
    `forgejo.ts` (job API + 对齐映射)。新增 CI 平台 = 新增一个 adapter 文件。
- `vendors/` — 外部构建产物 (engine.wasm + 来源/指纹/升级路径登记, 见 vendors/README.md)。
- `fixtures/` — e2e 基底: `github/` (T4 仿真: 虚拟化 + 重渲染 + 真实语料) /
  `degrade/` (无端点/403/404/非 CI 页) / `rules-bundle.json` (跨仓契约格式的本地构造副本)。
- `scripts/` — `build.mjs` (wasm gzip+base64 内嵌 + esbuild + userscript banner) /
  `serve.mjs` (8801 静态服务, CORS 全开, `/_status/<code>/` 状态码仿真) /
  `make-local-bundle.mjs` (规则仓 checkout → fixtures bundle, dev 工具)。
- `e2e/` — Playwright: `harness.ts` (GM shim + 注入) + 三个 spec (github 主链路 / degrade /
  forgejo 活体) + `shots/` 交付截图。

## 实现约定

- **架构三不变式** (spike T4 结论, 违反即架构回归): ① 状态外置 (标注按 `(source, line)`
  外置, 行 DOM 是临时物); ② 幂等 sync 是唯一注入路径 (初始 pass 与 observer 重放共用
  `syncInline`, 增量批次只扫 mutation 涉及的新节点 — `sync.lastExamined` 是增量性的可断言面);
  ③ 事件驱动重放 (任何重建/懒加载/虚拟化收敛为 "sync 一遍")。
- **B1 教训 (控件态闭环)**: 任何影响注入形态的控件走 "改态 → sync" 而非直接改 DOM;
  off 必须清幂等签名 (否则重放对新行注入、旧行残留); on 必须主动补 sync (无 DOM 变更
  则无重放事件)。**每个新控件都要补 "toggle 后滚动/重渲染" 的 e2e 用例**。
- **wasm ABI 纪律** (T1, `src/core/abi.ts` 头注释): UTF-8 字节长 alloc / 全 alloc 后写 /
  4B LE 前缀读 / free 带原 cap / 异常路径 finally 归还。ABI 变更须与引擎仓联动。
- **规则消费纪律**: bundle 格式 SSOT = rules 仓生成管线, 本仓只消费; 校验
  (`validateBundle`) 对 format_version / min_engine_version / 结构 / rule_count 全严格
  (宁拒勿错, 有诊断)。缓存 cache-first; 刷新失败保留旧 bundle。
- **日志取数**: 恒同源 + `credentials: 'same-origin'`; 跨域仅 bundle (GM_xmlhttpRequest,
  `@connect raw.githubusercontent.com`)。
- **零运行时依赖** — 产物不 import 任何 npm 包; 工具链全 devDependencies
  (版本 SSOT = package-lock.json, `npm ci` 复现)。devShell 只提供 node/just/jq/rg。
- **userscript 产物**: 单文件 IIFE (生态约束), wasm gzip+base64 内嵌 (~0.74 MiB),
  `@version` SSOT = package.json (构建期注入 banner)。源码保持 ESM。
- **TS 纪律**: 严格模式全开 (noUncheckedIndexedAccess / exactOptionalPropertyTypes);
  源码 import 一律带 `.ts` 扩展名 (node --test 直跑 + esbuild 双兼容); 单测只测纯逻辑
  (align/semver/rules), DOM 行为全部走 e2e。
- **e2e 离线纪律**: 测试不得触真实网络 — bundle/日志全走本地 fixture 服务; 对默认
  raw.githubusercontent.com 的用例必须 route 拦截。GM_* 用 harness 的测试 shim
  (localStorage 持久化, 可预置缓存)。

## 跨仓契约引用 (SSOT 均在对方仓, 此处只登记接口)

| 契约                                                    | SSOT 位置                                               | 本仓消费点                                |
| ------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| wasm ABI (`alloc`/`free`/`skim_json`, 4B 前缀 envelope) | 引擎仓 `wasm-spike` (M1 正式化后替换)                   | `src/core/abi.ts` + `vendors/engine.wasm` |
| 规则 bundle 格式 + 发布端点                             | rules 仓生成管线 (`reports` 分支)                       | `src/core/rules.ts` + `src/config.ts`     |
| SkimResult JSON 协议                                    | 引擎仓 serde (CLI --json 同协议)                        | `src/types.ts`                            |
| GitHub job 页 DOM 事实                                  | spike T3 DOM-REPORT (登录墙内未实测项见 github.ts TODO) | `src/adapters/github.ts`                  |
| Forgejo v16 job 页 DOM 事实                             | spike T4 PROTO-REPORT (本地真实实例勘察)                | `src/adapters/forgejo.ts`                 |

## 已知未决 (登记在案的待办)

- `hiddenLineCount` 偏移 (GitHub 显示行号 vs data-index, 登录墙内未实测) —
  `src/adapters/github.ts` 头部 TODO, fixture 已按已知语义 (文本行 ↔ data-index 一一对应) 建模。
- GitHub 真实 DOM 的 cluster wrapper 选择器 (jumpTo 目前用 fixture 契约 `.lsk-cluster`) —
  同文件 TODO, 登录态实测后只改一处。
- wasm 产物无 `engine_version` 导出 (spike 产物) — 版本协商用 host 侧 `ENGINE_VERSION`
  常量 (config.ts); M1 产物就绪后按 `vendors/README.md` 升级步骤切换。
- forgejo 活体 e2e 依赖本地实例 (127.0.0.1:3999, T4 遗留), 不可达自动 skip —
  skip 后 forgejo 覆盖缺口, 复跑 `spike-proto/scripts/forgejo-dev/run-local-forgejo.sh` 恢复。

## 验证链

`just check` = lint (biome, --error-on-warnings) → build (esbuild, 生成 src/generated/) →
typecheck (tsc --noEmit) → unit (node --test) → e2e (playwright, webServer 自管 8801)。
构建在 typecheck 前是刻意的: tsc 需要构建期生成的 wasm-b64 模块。
