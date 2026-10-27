// extension.spec.ts — MV3 扩展 (主交付形态) 的 CSP 回归防线。
// 背景 (用户实测 2026-10-26): github.com 页面 CSP 为
//   `script-src github.githubassets.com 'sha256-…'` (无 wasm-unsafe-eval),
// userscript 注入页面世界 → WebAssembly.compile 被 CSP 拒 — userscript 形态在
// github.com 结构性不可行; MV3 content script 运行于 isolated world, 不受页面
// CSP 约束。本套件 = 防 "未来某次构建把 wasm 挪回页面世界" 的回归锚:
//   ① 扩展主链路: 真实 --load-extension + 严格 CSP 的 github.com 仿真页 (页面与
//      静态资源全 route 拦截 → e2e 离线), 断言 wasm 编译 + overlay 呈现 + 流内
//      高亮全链在 isolated world 正常; 同时用页面世界 wasm 编译被拒证明该 CSP
//      确实严格 (对照锚);
//   ② userscript 形态在同页被 CSP 拦截 → 降级文案指向 Chrome 扩展 (真实产物以
//      CSP 允许源的 <script src> 注入页面世界, 复现 Tampermonkey 的失败形态)。
// 注意: content script 的 window.__lsk 在 isolated world, page.evaluate 不可见
// — 断言面全走共享 DOM (fab/overlay/inline 高亮)。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Route, test } from '@playwright/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT_DIR = path.join(ROOT, 'dist/extension')

/** github.com job 页 URL (路径形态匹配 content_scripts matches 与 @match)。 */
const GH_JOB = 'https://github.com/someorg/somerepo/actions/runs/40075984161/job/120819301735'

/** github.com 实测 CSP 形态 (无 wasm-unsafe-eval; hash 为形态占位, 页面无内联脚本)。 */
const GH_CSP = "script-src github.githubassets.com 'sha256-mVqFxUrLmGPFuowyQf3AqA0MZOWWLcAAC/VBdAJrqKk='"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

function local(rel: string): Buffer {
  return fs.readFileSync(path.join(ROOT, rel))
}

async function fulfillFile(route: Route, rel: string, headers: Record<string, string> = {}): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: MIME[path.extname(rel)] ?? 'application/octet-stream',
    body: local(rel),
    headers,
  })
}

/**
 * github.com 世界仿真 (e2e 离线纪律: 三域全拦截, 未知请求 abort — 零真实网络):
 *   github.com/<o>/<r>/actions/runs/… → fixtures/github/index.html (改写 sim.js
 *     与 data-log-url 为三域绝对 URL) + 严格 CSP 响应头;
 *   github.com/fixtures/… → 本地 fixture 文件 (job 日志端点);
 *   github.githubassets.com/fixtures/… → 本地 fixture 文件 (CSP 允许源的页面脚本);
 *   github.githubassets.com/e2e/log-skimmer.user.js → userscript 产物 (仅注入用例);
 *   raw.githubusercontent.com/… → 规则 bundle fixture。
 */
async function routeGhWorld(route: Route, opts: { injectUserscript?: boolean } = {}): Promise<void> {
  const u = new URL(route.request().url())
  if (u.hostname === 'raw.githubusercontent.com') {
    // CORS 头模拟真实 raw 行为 (ACAO:*): 扩展 content script 的 fetch 以页面
    // origin (github.com) 发出, 跨域读取该响应需 CORS 授权 — 漏头 = fetch 被拒
    // (曾让扩展用例规则 chip 超时, 首次实跑才暴露)。
    return fulfillFile(route, 'fixtures/rules-bundle.json', { 'access-control-allow-origin': '*' })
  }
  if (u.hostname === 'github.githubassets.com') {
    if (u.pathname === '/e2e/log-skimmer.user.js') return fulfillFile(route, 'dist/log-skimmer.user.js')
    return fulfillFile(route, u.pathname.slice(1))
  }
  if (u.hostname === 'github.com') {
    if (u.pathname.startsWith('/fixtures/')) return fulfillFile(route, u.pathname.slice(1))
    if (/^\/[^/]+\/[^/]+\/actions\/runs\//.test(u.pathname)) {
      let html = local('fixtures/github/index.html').toString('utf8')
      html = html.replaceAll(
        'src="/fixtures/github/sim.js"',
        'src="https://github.githubassets.com/fixtures/github/sim.js"',
      )
      html = html.replaceAll(
        'data-log-url="/fixtures/github/logs/',
        'data-log-url="https://github.com/fixtures/github/logs/',
      )
      if (opts.injectUserscript) {
        html = html.replace(
          '</body>',
          '  <script defer src="https://github.githubassets.com/e2e/log-skimmer.user.js"></script>\n</body>',
        )
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: html,
        headers: { 'content-security-policy': GH_CSP },
      })
    }
  }
  await route.abort('blockedbyclient')
}

/** 滚动到目标逻辑行 (data-index); 不在场则像素估算兜底 (行高 ~21px)。 */
async function scrollToIndex(page: import('@playwright/test').Page, idx: number): Promise<void> {
  await page.evaluate(
    (i: number) =>
      document.querySelector(`[data-index='${i}']`)?.scrollIntoView() ?? window.scrollTo(0, i * 21),
    idx,
  )
}

test.describe('MV3 扩展 — 严格 CSP 页主链路 (回归锚)', () => {
  test('isolated world 不受页面 CSP 约束: wasm 编译 + overlay 呈现 + 流内高亮', async () => {
    test.setTimeout(90_000)
    const tmpBase = process.env.LSK_TMPDIR ?? '/tmp/opencode' // 沙箱逃生口: /tmp 不可写时指定它处
    fs.mkdirSync(tmpBase, { recursive: true })
    const userDataDir = fs.mkdtempSync(`${tmpBase}/lsk-ext-profile-`)
    // channel:'chromium' = new headless — 支持 --load-extension (默认 headless shell 不支持);
    // 遇阻降级 headed 的记录见 AGENTS.md 验证链。
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    })
    try {
      await context.route('**/*', (r) => routeGhWorld(r))
      const page = await context.newPage()
      await page.goto(GH_JOB)

      // fixture 仿真渲染 (页面世界; sim.js 来自 CSP 允许源 githubassets)
      await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')

      // [对照锚] 同一页面, 页面世界的 wasm 编译被 CSP 拒 — 证明 CSP 确实严格
      await expect(
        page.evaluate(() => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
      ).rejects.toThrow(/Content Security Policy|wasm/i)

      // [主链路] content script (isolated world) boot: fab 出现 = 编排已启动
      await expect(page.locator('#lsk-fab')).toBeVisible({ timeout: 20_000 })
      await page.click('#lsk-fab')
      await expect(page.locator('#lsk-overlay')).toBeVisible()
      // 规则 chip (bundle 经 ACAO:* 直连 fetch) + T4 对账锚点: step2 10 块 / 1172→21
      await expect(page.locator('#lsk-rules-chip')).toContainText('165 rules', { timeout: 20_000 })
      await expect(page.locator('#lsk-overlay .lsk-blk')).toHaveCount(10)
      await expect(page.locator('#lsk-meta')).toContainText('1172→21')
      await page.screenshot({ path: 'e2e/shots/extension-csp-overlay.png' })

      // [主链路] 流内高亮: 收起面板 → 滚到失败区 (~L1000) → 虚拟化推进 + 重放注入
      await page.click('#lsk-fab')
      await scrollToIndex(page, 985)
      await expect(page.locator('.lsk-inline').first()).toBeVisible({ timeout: 10_000 })
      await page.evaluate(() =>
        document.querySelector(`[data-index="1001"]`)?.scrollIntoView({ block: 'center' }),
      )
      await expect(page.locator('.lsk-inline').nth(14)).toBeVisible({ timeout: 10_000 })
      await page.screenshot({ path: 'e2e/shots/extension-csp-inline.png' })
    } finally {
      await context.close()
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})

test.describe('userscript 形态 — 严格 CSP 页降级文案', () => {
  test('wasm 被 CSP 拦截 → 诊断指向 Chrome 扩展形态', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    try {
      await context.route('**/*', (r) => routeGhWorld(r, { injectUserscript: true }))
      const page = await context.newPage()
      await page.goto(GH_JOB)

      // 页面世界注入的 user.js (bare 宿主): gunzip 后 WebAssembly.compile 被 CSP 拒
      await page.waitForFunction('window.__lsk && window.__lsk.diags.length > 0')
      const report = (await page.evaluate('window.__lsk')) as {
        diags: { stage: string; message: string; hint?: string }[]
      }
      expect(report.diags[0]?.stage).toBe('wasm')
      expect(report.diags[0]?.message).toMatch(/engine wasm failed to load/i)
      expect(report.diags[0]?.hint).toContain('Chrome extension')

      // fatal 呈现: 面板自动打开 + 指引可见
      await expect(page.locator('#lsk-overlay')).toBeVisible()
      await expect(page.locator('#lsk-overlay .lsk-diag .lsk-hint')).toContainText('Chrome extension')
      await page.screenshot({ path: 'e2e/shots/extension-csp-userscript-fatal.png' })
    } finally {
      await context.close()
    }
  })
})
