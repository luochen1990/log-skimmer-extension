// forgejo-live.spec.ts — 本地 forgejo v16 真实实例 (127.0.0.1:3999, T4 遗留运行中)。
// 实例不可达时整组 skip (报告注明: forgejo 覆盖依赖该实例在场; fixture 退路未建 —
// forgejo 页面是 Vue CSR, 手搓 fixture 仿真成本高, 而实例本身即真实渲染管线)。
import { expect, test } from '@playwright/test'
import { getReport, injectUserscript, newSkimPage, waitReady } from './harness.ts'

const FORGEJO = 'http://127.0.0.1:3999'
const JOB_PAGE = `${FORGEJO}/demo/ci-fail/actions/runs/1/jobs/0`

test.beforeEach(async () => {
  // 实例探活: 不可达 → skip (环境缺位不是回归, 不红)
  try {
    const resp = await fetch(`${FORGEJO}/api/v1/repos/demo/ci-fail/actions/runs/1/jobs`, {
      signal: AbortSignal.timeout(3000),
    })
    test.skip(!resp.ok, `forgejo dev instance unreachable (${resp.status})`)
  } catch {
    test.skip(true, 'forgejo dev instance unreachable (network)')
  }
})

test('forgejo 真实页: 整 job 单源 + 对齐映射 + 7 块 (T4 对账锚点)', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser) // bundleUrlOverride → 本地 fixture 服务 (CORS 已开)
  await page.goto(JOB_PAGE)
  // Vue CSR: 等 step 折叠头渲染 (日志行可能需点击展开)
  await page.waitForSelector('.job-step-section', { timeout: 15_000 })

  await injectUserscript(page)
  await waitReady(page)
  let report = await getReport(page)

  // 整 job 单源 (job API), 真实语料 1181 行 → 7 块 (T4 轨 A 锚点)
  expect(report.sources).toHaveLength(1)
  const src = report.sources[0]
  expect(src).toMatchObject({ ok: true, blocks: 7, inputLines: 1181 })

  // 展开 step → 懒加载行 → observer 重放注入 (两指针对齐: matched 应近满)
  // 头部 = div.job-step-summary.step-expandable (Vue 渲染, 非 <summary>)
  const stepHeads = page.locator('.job-step-section')
  for (let i = 0; i < (await stepHeads.count()); i++) {
    const head = stepHeads.nth(i)
    if ((await head.locator('.job-log-line').count()) === 0) {
      await head.locator('.job-step-summary').click()
      await page.waitForTimeout(600)
    }
  }
  await page.waitForFunction('window.__lsk && window.__lsk.inline.applied + window.__lsk.inline.replayed > 0')
  await page.waitForTimeout(600)
  report = await getReport(page)
  const totalMatched = report.align.reduce((n, a) => n + a.matched, 0)
  expect(totalMatched).toBeGreaterThan(1000) // T4: 1174/1174
  expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)
  await page.screenshot({ path: 'e2e/shots/forgejo-live-inline.png' })

  // overlay: 单源 7 块 + 跳转联动
  await page.click('#lsk-fab')
  expect(await page.locator('#lsk-overlay .lsk-blk').count()).toBe(7)
  await page.locator('#lsk-overlay .lsk-blk').nth(3).locator('.lsk-row').click()
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'e2e/shots/forgejo-live-overlay.png' })
  await context.close()
})
