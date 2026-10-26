// harness.ts — e2e 公共设施: GM 测试 shim (模拟 Tampermonkey 环境) + userscript 注入。
// shim 契约: 与 Tampermonkey 的 GM.* / GM_xmlhttpRequest 同形; storage 持久化到
// localStorage (跨页面存续, 供缓存路径测试); 跨域请求走 fetch (fixture 服务端已开 CORS)。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import type { LskReport } from '../src/types.ts'

export type { LskReport }

declare global {
  interface Window {
    /** userscript 验证面 (controller 写入; spec/evaluate 消费)。 */
    __lsk?: LskReport
    /** fixture 仿真观测面 (fixtures/github/sim.js 写入)。 */
    __ghSim?: { renders: number; attaches: number; detaches: number; clusters: number; attachedNow?: number }
  }
}

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/log-skimmer.user.js')
export const BASE = 'http://127.0.0.1:8801'
export const BUNDLE_URL = `${BASE}/fixtures/rules-bundle.json`
export const GITHUB_FIXTURE = `${BASE}/fixtures/github/index.html`

/** GM storage 预置值 (bundle URL 默认指向本地 fixture — e2e 全离线)。 */
export type GmSeed = Record<string, string>

export const defaultSeed = (): GmSeed => ({ 'lsk:bundleUrl': BUNDLE_URL })

/** 构造一个已装 GM shim 的页面 (每次新 context, seed 可预置 GM storage)。 */
export async function newSkimPage(
  browser: Browser,
  opts: { seed?: GmSeed; noGm?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  if (!opts.noGm) {
    await context.addInitScript(gmShim, opts.seed ?? defaultSeed())
  }
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    throw new Error(`pageerror: ${e.message}`)
  })
  return { context, page }
}

/** GM_* shim (浏览器侧安装; seed 覆盖式预置 storage)。 */
function gmShim(seed: GmSeed | undefined): void {
  // addInitScript 对所有文档执行 (含 about:blank) — 非内容页不装。
  if (location.protocol === 'about:') return
  const KEY = 'lsk-gm-shim-store'
  const readStore = (): Record<string, string> => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  }
  const store = readStore()
  if (seed) Object.assign(store, seed)
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store))
    } catch {
      /* storage 不可用时退化为内存态 */
    }
  }
  const w = window as unknown as Record<string, unknown>
  w.GM = {
    getValue: (k: string) => Promise.resolve(store[k]),
    setValue: (k: string, v: string) => {
      store[k] = v
      persist()
      return Promise.resolve()
    },
    deleteValue: (k: string) => {
      delete store[k]
      persist()
      return Promise.resolve()
    },
  }
  w.GM_xmlhttpRequest = (opts: {
    url: string
    timeout?: number
    onload?: (r: { status: number; responseText: string }) => void
    onerror?: (e: unknown) => void
    ontimeout?: () => void
  }) => {
    fetch(opts.url, { signal: AbortSignal.timeout(opts.timeout ?? 15000) })
      .then(async (r) => {
        opts.onload?.({ status: r.status, responseText: await r.text() })
      })
      .catch((e: unknown) => {
        opts.onerror?.(e)
      })
  }
  persist()
}

/** 注入构建产物 (page.evaluate 经 CDP, 不受页面 CSP 约束 — 与 TM 注入语义最接近)。 */
export async function injectUserscript(page: Page): Promise<void> {
  const src = fs.readFileSync(DIST, 'utf8')
  await page.evaluate(src)
}

/** 等 window.__lsk 就绪 (或超时); 返回报告快照。 */
export async function waitReady(page: Page): Promise<LskReport> {
  await page.waitForFunction('window.__lsk && window.__lsk.ready === true', undefined, { timeout: 20_000 })
  return getReport(page)
}

/** 等 boot 终态: 就绪 或 诊断已出 (降级路径不置 ready, 但必有 diag)。 */
export async function waitSettled(page: Page): Promise<LskReport> {
  await page.waitForFunction(
    'window.__lsk && (window.__lsk.ready === true || window.__lsk.diags.length > 0)',
    undefined,
    { timeout: 20_000 },
  )
  return getReport(page)
}

export async function getReport(page: Page): Promise<LskReport> {
  return (await page.evaluate('window.__lsk')) as LskReport
}

/** 构造"已是 N 天前缓存"的 GM seed (bundle 缓存路径测试)。 */
export function staleCacheSeed(bundle: unknown, ageDays: number): GmSeed {
  const bundleJson = typeof bundle === 'string' ? bundle : JSON.stringify(bundle)
  return {
    'lsk:bundleUrl': BUNDLE_URL,
    'lsk:rulesBundle': JSON.stringify({
      bundle: JSON.parse(bundleJson),
      fetchedAt: Date.now() - ageDays * 86_400_000,
    }),
  }
}

export async function readFixtureBundle(): Promise<unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/rules-bundle.json'),
      'utf8',
    ),
  )
}
