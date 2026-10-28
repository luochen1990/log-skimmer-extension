// store-shots.spec.ts — Chrome Web Store 上架素材生成 (非行为测试)。
// 产物: docs/store/assets/ — screenshot-{n}-*.png (1280×800 整, CWS 硬性规格)
//       + promo-440x280.png (小宣传图)。 forgejo 活体依赖本地实例 (127.0.0.1:3999),
//       不可达时跳过 (素材为入库工件, 缺位可见可补)。
// 触发: `just store-shots` (LSK_STORE_SHOTS=1); 常规 check 链不跑 (test.skip 门)。

import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import { GITHUB_FIXTURE, injectUserscript, newSkimPage, waitSettled } from './harness.ts'

const OUT = 'docs/store/assets'
const VIEWPORT = { width: 1280, height: 800 }
/** 本地 forgejo v16 活体 (与 forgejo-live.spec 同源常量)。 */
const FORGEJO_LIVE = 'http://127.0.0.1:3999'

test.skip(!process.env.LSK_STORE_SHOTS, '上架素材专用: just store-shots (LSK_STORE_SHOTS=1)')

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true })
})

test('screenshot-1: GitHub job 页 — 面板 + 流内高亮/折叠 (浅色)', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser, { viewport: VIEWPORT })
  await page.goto(GITHUB_FIXTURE)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  await waitSettled(page)
  // 滚到失败簇: 流内高亮 + 折叠占位行入镜, 面板常驻右侧
  await scrollToFailureArea(page)
  await page.waitForFunction('document.querySelectorAll(".lsk-inline").length >= 5')
  await page.click('#lsk-fab')
  await expect(page.locator('#lsk-overlay .lsk-blk').first()).toBeVisible()
  await page.screenshot({ path: `${OUT}/screenshot-1-github-light.png` })
  await context.close()
})

test('screenshot-2: GitHub job 页 — 暗色面板形态 (prefers-color-scheme)', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser, { viewport: VIEWPORT, colorScheme: 'dark' })
  await page.goto(GITHUB_FIXTURE)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  await waitSettled(page)
  await scrollToFailureArea(page)
  await page.waitForFunction('document.querySelectorAll(".lsk-inline").length >= 5')
  await page.click('#lsk-fab')
  await expect(page.locator('#lsk-overlay .lsk-blk').first()).toBeVisible()
  await page.screenshot({ path: `${OUT}/screenshot-2-github-dark.png` })
  await context.close()
})

test('screenshot-3: Forgejo job 页 — 自托管形态 (暗色宿主 + 面板)', async ({ browser }) => {
  test.skip(!(await forgejoLiveReachable()), '本地 forgejo 实例不可达 — 素材缺位可补')
  const { context, page } = await newSkimPage(browser, { viewport: VIEWPORT, colorScheme: 'dark' })
  await page.goto(`${FORGEJO_LIVE}/demo/ci-fail/actions/runs/1/jobs/0`, { waitUntil: 'networkidle' })
  await injectUserscript(page) // 宿主 forgejo CSP 宽松, userscript 形态即可复现扩展行为
  await page.waitForSelector('#lsk-fab', { timeout: 20000 })
  await page.waitForTimeout(2500) // autoExpand + 折叠 pass 安顿
  // 失败簇入镜 (Build and test 段 ~L1002)
  await page.evaluate(() => {
    document.querySelector('[id^="jobstep-2-1002"]')?.scrollIntoView({ block: 'center' })
  })
  await page.waitForFunction('document.querySelectorAll(".lsk-inline").length >= 5')
  await page.click('#lsk-fab') // 面板展开入镜 — 结构化 UI 是本形态核心卖点
  await expect(page.locator('#lsk-overlay .lsk-blk').first()).toBeVisible()
  await page.screenshot({ path: `${OUT}/screenshot-3-forgejo-dark.png` })
  await context.close()
})

test('promo-440x280: 品牌小图', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser, {
    viewport: { width: 440, height: 280 },
    noGm: true,
  })
  await page.setContent(PROMO_HTML)
  await page.screenshot({ path: `${OUT}/promo-440x280.png` })
  await context.close()
})

async function forgejoLiveReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${FORGEJO_LIVE}/api/v1/repos/demo/ci-fail`, {
      signal: AbortSignal.timeout(3000),
    })
    return r.ok
  } catch {
    return false
  }
}

/** 两段式滚到失败簇: 像素粗滚推进虚拟化窗口 → attach 后精滚居中 (github.spec 同手法)。 */
async function scrollToFailureArea(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector("[data-index='985']")
    if (el) el.scrollIntoView({ block: 'center' })
    else window.scrollTo(0, 985 * 21)
  })
  await page.waitForTimeout(600)
  await page.evaluate('document.querySelector(`[data-index="1001"]`)?.scrollIntoView({block:"center"})')
  await page.waitForTimeout(500)
}

/** 品牌图 (无外链资源, 全内联; Primer 同源配色 — 与面板 token 一致)。v2: 中部死区填迷你日志卡。 */
const PROMO_HTML = `<!doctype html><html><body style="margin:0">
<div style="width:440px;height:280px;box-sizing:border-box;padding:24px 30px 20px;background:#ffffff;display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif">
  <div style="display:flex;align-items:center;gap:10px">
    <div style="width:32px;height:32px;border-radius:8px;background:#0969da;color:#fff;font:700 16px/32px ui-monospace,monospace;text-align:center">⌁</div>
    <div style="font-size:21px;font-weight:700;color:#1f2328">log-skimmer</div>
    <div style="margin-left:auto;font-size:12.5px;color:#424a53">CI failure logs, skimmed.</div>
  </div>
  <div style="margin-top:14px;background:#0d1117;border-radius:8px;padding:10px 12px;font:11.5px/1.7 ui-monospace,SFMono-Regular,monospace;color:#6e7681">
    <div>Resolving dependencies&hellip; 812 packages</div>
    <div style="text-align:center;color:#6e7681">&ctdot; 731 lines</div>
    <div style="border-left:3px solid #cf222e;background:rgba(248,81,73,.15);color:#ffb1a4;padding-left:8px;margin:2px 0">&#10005; clang: error: linker command failed with exit code 1</div>
    <div style="border-left:3px solid #0969da;background:rgba(56,139,253,.15);color:#8cb7ff;padding-left:8px">&#8505; Current runner version: '2.338.0'</div>
  </div>
  <div style="margin-top:12px;display:flex;gap:8px;font-size:12px">
    <span style="background:#ffebe9;color:#cf222e;padding:3px 10px;border-radius:999px">✕ failure evidence</span>
    <span style="background:#fff8c5;color:#82460a;padding:3px 10px;border-radius:999px">⚠ warnings</span>
    <span style="background:#ddf4ff;color:#0969da;padding:3px 10px;border-radius:999px">ℹ snapshot</span>
  </div>
  <div style="margin-top:auto;font-size:12.5px;color:#57606a">GitHub Actions &amp; self-hosted Forgejo · everything stays local</div>
</div></body></html>`
