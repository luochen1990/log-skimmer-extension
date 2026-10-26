// abi.ts — wasm 引擎宿主薄壳 (浏览器侧)。
// 契约 (与引擎仓 log-skimmer-wasm/src/lib.rs 严格一致, 不得单侧演化):
//   wasm_alloc(len) -> ptr; wasm_free(ptr, cap);
//   wasm_skim_json(rp,rl, fp,fl, lp,ll) -> ptr
//     返回缓冲区 = 4B LE u32 长度前缀 + payload JSON envelope {ok,result|error}
//     rules 入参 = JSON `[[源名, YAML 文本], ...]`
//   wasm_engine_version() -> ptr — payload = 引擎版本字符串 (无 JSON 包装),
//     版本协商 (bundle manifest min_engine_version) 的 wasm 侧事实来源
// 纪律 (T1 踩坑, 全部沿用):
//   ① JS string.length ≠ UTF-8 字节长 → 一律 encode 后按字节长 alloc;
//   ② 逐段 "alloc→建视图→写入" 安全 (视图建立在 alloc 之后); 但任何跨 wasm 调用
//     持有的旧视图会被 memory 增长 detach → 每次读返回值前必须重建视图;
//   ③ free 的 cap 必须与申请一致; wasm_skim_json 异常路径也要归还入参缓冲。

import type { SkimEnvelope } from '../types.ts'

interface WasmExports {
  memory: WebAssembly.Memory
  wasm_alloc(len: number): number
  wasm_free(ptr: number, cap: number): void
  wasm_skim_json(rp: number, rl: number, fp: number, fl: number, lp: number, ll: number): number
  wasm_engine_version(): number
}

export interface SkimAbi {
  skimJson(rulesJson: string, fileName: string, logText: string): SkimEnvelope
  /** wasm 侧引擎版本 (实例化时读取一次; 4B 前缀协议同上, payload 为纯字符串)。 */
  readonly engineVersion: string
}

/** compile 缓存 (见 loadEngine; 引用比较判定同一构建产物)。 */
let compiled: { bytes: Uint8Array<ArrayBuffer>; module: WebAssembly.Module } | null = null

export async function loadEngine(wasmBytes: Uint8Array<ArrayBuffer>): Promise<SkimAbi> {
  // 模块级 compile 缓存 (bytes 引用比较): 同一份 wasm 重复建引擎 (规则刷新) 只
  // compile 一次, 每次新建 Instance (实例持规则状态, 不可复用)。
  if (compiled === null || compiled.bytes !== wasmBytes) {
    compiled = { bytes: wasmBytes, module: await WebAssembly.compile(wasmBytes) }
  }
  // compile + new Instance (而非 instantiate): lib.dom 的 instantiate 重载对
  // 两参形态的类型推断不稳定; compile 路径类型无歧义且语义等价。
  const instance = new WebAssembly.Instance(compiled.module, {})
  const ex = instance.exports as unknown as WasmExports
  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8')

  function send(str: string): { ptr: number; len: number } {
    const buf = enc.encode(str) // 按 UTF-8 字节长 alloc (纪律 ①)
    const ptr = ex.wasm_alloc(buf.length)
    new Uint8Array(ex.memory.buffer, ptr, buf.length).set(buf)
    return { ptr, len: buf.length }
  }

  /** 读出参: 4B LE 前缀长度 + payload, 读毕归还 (读前重建视图, 纪律 ②)。 */
  function recv(ptr: number): string {
    const mem = new Uint8Array(ex.memory.buffer)
    const len = new DataView(ex.memory.buffer, ptr, 4).getUint32(0, true)
    const payload = dec.decode(mem.subarray(ptr + 4, ptr + 4 + len))
    ex.wasm_free(ptr, 4 + len)
    return payload
  }

  const engineVersion = recv(ex.wasm_engine_version())

  function skimJson(rulesJson: string, fileName: string, logText: string): SkimEnvelope {
    const rs = send(rulesJson)
    const fs = send(fileName)
    const ls = send(logText)
    let outPtr: number
    try {
      outPtr = ex.wasm_skim_json(rs.ptr, rs.len, fs.ptr, fs.len, ls.ptr, ls.len)
    } finally {
      // wasm_skim_json 抛异常 (引擎 panic) 时也归还入参缓冲, 防线性内存泄漏 (纪律 ③)
      ex.wasm_free(rs.ptr, rs.len)
      ex.wasm_free(fs.ptr, fs.len)
      ex.wasm_free(ls.ptr, ls.len)
    }
    return JSON.parse(recv(outPtr)) as SkimEnvelope
  }

  return { skimJson, engineVersion }
}

/**
 * 从 wasm 侧读取引擎版本 (版本协商的事实来源 — 早于规则装载)。
 * 与 SkimEngine.create 共享 compile 缓存; 额外成本仅一次 Instance 实例化
 * (规则装载发生在 skim 调用期, 版本读取无需规则)。
 */
export async function readEngineVersion(wasmBytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await loadEngine(wasmBytes)).engineVersion
}

/**
 * 解压内嵌 wasm — 构建期已 gzip (体积 1.72MB → ~0.55MB, base64 后进一步省 ~60% 产物体积)。
 * DecompressionStream 基线: Chrome 103+ / FF 113+ / Safari 16.4+ (2026 年目标浏览器均满足)。
 */
export async function gunzip(b64: string): Promise<Uint8Array<ArrayBuffer>> {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable — browser too old for this userscript')
  }
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
