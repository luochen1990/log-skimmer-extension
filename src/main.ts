// main.ts — userscript 入口 (esbuild bundle 起点; ==UserScript== header 由构建期
// banner 注入, 见 scripts/build.mjs)。GM 环境探测 → controller 编排; 顶层异常兜底。
import { boot } from './controller.ts'
import wasmB64 from './generated/wasm-b64.ts'
import { detectGm } from './gm.ts'

boot({ gm: detectGm(), doc: document, loc: location, wasmB64 }).catch((e: unknown) => {
  // controller 内部已尽力降级呈现; 此处是最后一道防线 (理论上不可达)。
  console.error('[logskim] fatal', e)
})
