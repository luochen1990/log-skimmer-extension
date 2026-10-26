// engine.ts — wasm skim 编排 (页面无关, 无 IO: abi/规则由调用方注入)。
// 数据流: 全量日志文本 (adapter 提供 URL, controller fetch) → wasm skim → SkimResult。
// abi 来源由 controller 分派: 本地 wasm (userscript/bare) 或 SW RPC (扩展, 2026-10-27
// CSP 实测后的形态分派 — 页面 CSP 拒绝 isolated world 的 wasm 编译)。

import type { SkimResult } from '../types.ts'
import type { SkimAbi } from './abi.ts'

export class SkimEngine {
  private constructor(
    private readonly skimJson: SkimAbi['skimJson'],
    private readonly rulesJson: string,
  ) {}

  static async create(abi: SkimAbi, rulesJson: string): Promise<SkimEngine> {
    return new SkimEngine(abi.skimJson.bind(abi), rulesJson)
  }

  /** logText → skim 结果 (envelope 校验后返回 result)。 */
  async skim(logText: string, fileName = 'log'): Promise<SkimResult> {
    const env = await this.skimJson(this.rulesJson, fileName, logText)
    if (!env.ok || !env.result) {
      const err = !env.ok ? (env.error ?? 'unknown') : 'empty result' // 防畸形 envelope
      throw new Error(`skim failed: ${err}`)
    }
    return env.result
  }
}
