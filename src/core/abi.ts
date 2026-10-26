// abi.ts — wasm 引擎宿主薄壳 (浏览器侧)。
// 契约 (与 spike-wasm/wasm-spike/src/lib.rs 严格一致, 不得单侧演化):
//   alloc(len) -> ptr; free(ptr, cap); skim_json(rp,rl, fp,fl, lp,ll) -> ptr
//   返回缓冲区 = 4B LE u32 长度前缀 + payload JSON envelope {ok,result|error}
//   rules 入参 = JSON `[[源名, YAML 文本], ...]`
// 纪律 (T1 踩坑, 全部沿用):
//   ① JS string.length ≠ UTF-8 字节长 → 一律 encode 后按字节长 alloc;
//   ② 逐段 "alloc→建视图→写入" 安全 (视图建立在 alloc 之后); 但任何跨 wasm 调用
//     持有的旧视图会被 memory 增长 detach → 每次读返回值前必须重建视图;
//   ③ free 的 cap 必须与申请一致; skim_json 异常路径也要归还入参缓冲。

import type { SkimEnvelope } from '../types.ts'

interface WasmExports {
  memory: WebAssembly.Memory
  alloc(len: number): number
  free(ptr: number, cap: number): void
  skim_json(rp: number, rl: number, fp: number, fl: number, lp: number, ll: number): number
}

export interface SkimAbi {
  skimJson(rulesJson: string, fileName: string, logText: string): SkimEnvelope
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
    const ptr = ex.alloc(buf.length)
    new Uint8Array(ex.memory.buffer, ptr, buf.length).set(buf)
    return { ptr, len: buf.length }
  }

  function skimJson(rulesJson: string, fileName: string, logText: string): SkimEnvelope {
    const rs = send(rulesJson)
    const fs = send(fileName)
    const ls = send(logText)
    let outPtr: number
    try {
      outPtr = ex.skim_json(rs.ptr, rs.len, fs.ptr, fs.len, ls.ptr, ls.len)
    } finally {
      // skim_json 抛异常 (引擎 panic) 时也归还入参缓冲, 防线性内存泄漏 (纪律 ③)
      ex.free(rs.ptr, rs.len)
      ex.free(fs.ptr, fs.len)
      ex.free(ls.ptr, ls.len)
    }
    const mem = new Uint8Array(ex.memory.buffer) // 读取前重建视图, 防 detach (纪律 ②)
    const len = new DataView(ex.memory.buffer, outPtr, 4).getUint32(0, true)
    const payload = dec.decode(mem.subarray(outPtr + 4, outPtr + 4 + len))
    ex.free(outPtr, 4 + len)
    return JSON.parse(payload) as SkimEnvelope
  }

  return { skimJson }
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
