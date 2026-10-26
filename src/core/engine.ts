// engine.ts — wasm skim 编排 (页面无关, 无 IO: 字节/规则由调用方注入)。
// 数据流: 全量日志文本 (adapter 提供 URL, controller fetch) → wasm skim → SkimResult。

import type { SkimEnvelope, SkimResult } from '../types.ts'
import { loadEngine } from './abi.ts'

export class SkimEngine {
  private constructor(
    private readonly skimJson: (rules: string, file: string, log: string) => SkimEnvelope,
    private readonly rulesJson: string,
  ) {}

  static async create(wasmBytes: Uint8Array<ArrayBuffer>, rulesJson: string): Promise<SkimEngine> {
    const abi = await loadEngine(wasmBytes)
    return new SkimEngine(abi.skimJson, rulesJson)
  }

  /** logText → skim 结果 (envelope 校验后返回 result)。 */
  skim(logText: string, fileName = 'log'): SkimResult {
    const env = this.skimJson(this.rulesJson, fileName, logText)
    if (!env.ok || !env.result) {
      const err = !env.ok ? (env.error ?? 'unknown') : 'empty result' // 防畸形 envelope
      throw new Error(`skim failed: ${err}`)
    }
    return env.result
  }
}
