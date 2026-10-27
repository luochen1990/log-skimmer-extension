// main.ts — 双形态入口 (esbuild bundle 起点): Chrome MV3 content script 与
// Tampermonkey userscript 共用 (userscript 的 ==UserScript== header 由构建期
// banner 注入, 见 scripts/build.mjs)。宿主探测 → controller 编排; 顶层异常兜底。
import { boot } from './controller.ts'
import wasmB64 from './generated/wasm-b64.ts'
import { detectHost } from './host.ts'

boot({ host: detectHost(), doc: document, loc: location, wasmB64 })
  .then((outcome) => {
    // SPA 重臂 (M4 用户实测教训): content script 不随 Turbo 同文档导航重注入 —
    // 未识别页面 (如 run summary) 上 URL 变化 (如点进 job) 即整页重载换取重新注入;
    // 与 controller ReplayDriver 的 bootHref 守卫同语义 (识别页导航走那边)。
    if (outcome === 'no-adapter') {
      const last = location.href
      setInterval(() => {
        if (location.href !== last) location.reload()
      }, 1000)
    }
  })
  .catch((e: unknown) => {
    // controller 内部已尽力降级呈现; 此处是最后一道防线 (理论上不可达)。
    console.error('[logskim] fatal', e)
  })
