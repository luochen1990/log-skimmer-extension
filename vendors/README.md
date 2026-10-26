# vendors/ — 外部构建产物供给

本目录存放**由其他仓构建、以二进制形式进仓**的产物。每个产物必须登记: 来源、
构建方式、内容指纹、升级路径。**禁止**在本仓内手工修改这些文件。

## engine.wasm

| 项     | 值                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| 内容   | log-skimmer 引擎 (Rust `engine` crate) 的 wasm32 编译产物 + 手写 C ABI 薄壳                                            |
| 来源   | log-skimmer 仓 `spike-wasm-20261026-1014` 分支 `wasm-spike` crate (SPIKE 产物, spike-wasm/SPIKE-REPORT.md)             |
| 构建   | `cargo build --release -p wasm-spike --target wasm32-unknown-unknown` (rustup 工具链 1.94.1)                           |
| sha256 | `355fa02d1dc567de0897d5ab527e7e70c07d533b5578f9a0a75a3f6cec925053`                                                     |
| 体积   | 1,716,189 B (release 默认 profile, 无 LTO/wasm-opt — M1 有压缩空间)                                                    |
| 导出   | `memory` / `alloc(len)->ptr` / `free(ptr,cap)` / `skim_json(rp,rl,fp,fl,lp,ll)->ptr` (无 `engine_version` 导出 — 见下) |

### 为何复制进仓 (而非构建期拉取)

1. **可复现**: `just check` 不依赖 /tmp 下的临时 worktree (spike-wasm 目录生命周期
   不由本仓控制) 或 rust 工具链在场。
2. **体积可接受**: 本仓的交付物 (userscript) 本来就要内嵌该 wasm, 仓库自包含使
   build 单变量 (无网络、无工具链漂移)。
3. **M1 切换点单一**: 引擎仓 wasm crate 正式化 (M1) 后, 升级 = 替换本文件 + 更新
   本表指纹, 消费侧 (`src/core/abi.ts` + `scripts/build.mjs`) 不变 — ABI 契约不变。

### 升级到 M1 正式产物

1. 用引擎仓正式 crate 构建产物, 替换 `engine.wasm`, 更新上表 (来源/构建/sha256/体积)。
2. 若 M1 产物新增 `engine_version` 导出: 在 `src/core/abi.ts` 的 `getEngineVersion`
   接入真实读取, 删除 `src/config.ts` 中 `ENGINE_VERSION` 常量的 host 侧假设
   (版本协商逻辑不变, 仅版本来源切换)。
3. 跑 `just check` — e2e 含 wasm 真实 skim 对账 (块数与 fixture 断言), ABI 漂移会红。
