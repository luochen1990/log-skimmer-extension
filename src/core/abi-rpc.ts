// abi-rpc.ts — SkimAbi 的 RPC 实现 (扩展形态): wasm 计算在 background service worker。
// 背景 (2026-10-27 实测): 严格 CSP 页 (github.com script-src 无 wasm-unsafe-eval) 下,
// content script 的 isolated world 里 WebAssembly.compile 同样被页面 CSP 拒 —
// MV3 扩展唯一可靠的 wasm 执行环境 = SW (扩展自身 CSP, manifest 显式放行
// 'wasm-unsafe-eval')。本模块把 SW 消息通道包装成与本地 wasm 无差异的 SkimAbi,
// 上层 (SkimEngine/controller) 不感知计算位置。
// 消息协议 SSOT = 本文件与 src/sw.ts 成对, 两侧不得单侧演化。

import type { SkimEnvelope } from '../types.ts'
import type { SkimAbi } from './abi.ts'

/** chrome.runtime 最小消费面 (与 host.ts 同纪律: 全量 @types/chrome 不引入)。 */
declare const chrome: { runtime?: RuntimeMessaging } | undefined

interface RuntimeMessaging {
  sendMessage(msg: unknown): Promise<unknown>
}

function runtime(): RuntimeMessaging | null {
  if (typeof chrome === 'undefined') return null
  const rt = (chrome as { runtime?: RuntimeMessaging }).runtime
  return typeof rt?.sendMessage === 'function' ? rt : null
}

/** 扩展形态在场判定 (controller 据此分派 abi 来源; SW 形态必须先行注册)。 */
export function rpcAvailable(): boolean {
  return runtime() !== null
}

type SwRequest = { t: 'v' } | { t: 'skim'; rulesJson: string; fileName: string; logText: string }
type SwResponse = { ok: true; version?: string; envelope?: SkimEnvelope } | { ok: false; error: string }

async function call(req: SwRequest): Promise<SwResponse> {
  const rt = runtime()
  if (!rt) return { ok: false, error: 'chrome.runtime unavailable' }
  try {
    return (await rt.sendMessage(req)) as SwResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** RPC 形态 SkimAbi: engineVersion 在装载时取一次 (与本地形态语义一致); 失败抛错走 wasmLoadDiag 降级。 */
export async function loadEngineRpc(): Promise<SkimAbi> {
  const v = await call({ t: 'v' })
  if (!v.ok || typeof v.version !== 'string') {
    throw new Error(`sw engine unavailable: ${v.ok ? 'no version' : v.error}`)
  }
  const engineVersion = v.version
  return {
    engineVersion,
    async skimJson(rulesJson, fileName, logText): Promise<SkimEnvelope> {
      const r = await call({ t: 'skim', rulesJson, fileName, logText })
      if (!r.ok || !r.envelope) {
        throw new Error(`sw skim failed: ${r.ok ? 'no envelope' : r.error}`)
      }
      return r.envelope
    },
  }
}
