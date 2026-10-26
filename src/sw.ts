// sw.ts — MV3 background service worker: 扩展形态的 wasm 计算引擎宿主。
// 职责: 消息协议 ({t:'v'} / {t:'skim'}) + 惰性 wasm 装载 (engine.wasm 裸文件,
// 构建期由 scripts/build.mjs 落包)。协议 SSOT = 本文件与 src/core/abi-rpc.ts 成对。
// 生命周期: SW 随事件唤醒/回收 — 模块级 wasm 缓存在 SW 存活期内复用, 被杀后
// 重建 (~百 ms 级, 含 wasm 编译), 调用方无感。

import { loadEngine, type SkimAbi } from './core/abi.ts'

/** chrome.runtime 最小消费面 (SW 侧; 与 host.ts/abi-rpc.ts 同纪律: 不引入全量 @types/chrome)。 */
declare const chrome: {
  runtime: {
    getURL(path: string): string
    onMessage: {
      addListener(cb: (req: unknown, sender: unknown, sendResponse: (res: unknown) => void) => boolean): void
    }
  }
}

let abi: SkimAbi | null = null

async function engine(): Promise<SkimAbi> {
  if (!abi) {
    const url = chrome.runtime.getURL('engine.wasm')
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer()) as Uint8Array<ArrayBuffer>
    abi = await loadEngine(bytes)
  }
  return abi
}

chrome.runtime.onMessage.addListener((req: unknown, _sender, sendResponse: (res: unknown) => void) => {
  const r = req as { t?: string; rulesJson?: string; fileName?: string; logText?: string }
  if (r?.t === 'v') {
    engine()
      .then((e) => sendResponse({ ok: true, version: e.engineVersion }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    return true // 异步 sendResponse (消息通道保持打开)
  }
  if (r?.t === 'skim') {
    engine()
      .then((e) => e.skimJson(r.rulesJson ?? '[]', r.fileName ?? 'log', r.logText ?? ''))
      .then((envelope) => sendResponse({ ok: true, envelope }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  return false // 未知消息不响应 (协议演进容错)
})
