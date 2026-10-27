// forgejo.spec.ts — forgejo 形态 fixture (M3): 手工 .job-step-logs + 渐进渲染控制。
// 覆盖活体实例 (forgejo-live.spec.ts) 之外的确定性路径:
//   ① 整 job 单源 + 两指针对齐基本链路 (实例停运退路);
//   ② grown: 运行中 job append 行 → 指纹漂移 → 整池剥离重对齐 (M3);
//   ③ 同数异容: 行数不变内容变 → 指纹哨兵仍察觉 (m5, 纯行数哨兵的盲区)。
// API (jobs 列表 / logs 端点) 由 route 拦截 fulfill — 全离线, 无实例依赖。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { FORGEJO_FIXTURE, getReport, injectUserscript, newSkimPage, waitReady } from './harness.ts'

// jobs 列表端点的 run 参数 = 内部主键 ID (fixture 内嵌 data-run-id=4242 ≠ URL 序号 1) —
// 拦截 4242 而非 1: 若 adapter 退回用 URL 序号拼 API, 请求落空 → 源失败 → 测试红。
// web 日志路由 (v0.1.5+): 会话认证通路, 直接吃页面 URL 同款序号 — API 路径已退役
// (/api/v1 只吃 token 不吃会话, 浏览器上下文对私有仓恒 404 — M4 生产教训)。
const WEB_LOGS = '**/fixtures/forgejo/actions/runs/1/jobs/0/attempt/1/logs'
const LOG_TEXT = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/github/logs/step2.log.txt'),
  'utf8',
)

/** 装配 forgejo fixture 页 (API 拦截 + 注入 + 就绪)。 */
async function bootForgejoFixture(browser: import('@playwright/test').Browser) {
  const { context, page } = await newSkimPage(browser)
  await context.route(WEB_LOGS, (route) => route.fulfill({ contentType: 'text/plain', body: LOG_TEXT }))
  await page.goto(FORGEJO_FIXTURE)
  await page.waitForFunction('window.__fjSim && window.__fjSim.rendered >= 80')
  await injectUserscript(page)
  await waitReady(page)
  return { context, page }
}

test('forgejo fixture: 整 job 单源 + 对齐 + overlay 10 块 (同语料 T4 锚点)', async ({ browser }) => {
  const { context, page } = await bootForgejoFixture(browser)
  const report = await getReport(page)
  expect(report.adapter).toBe('forgejo')
  expect(report.sources).toHaveLength(1)
  // 同一份 1172 行语料 → 与 github step2 相同的块数 (引擎确定性)
  expect(report.sources[0]).toMatchObject({ ok: true, blocks: 10, inputLines: 1172 })

  // 初始 80 行 DOM: 两指针对齐 matched ≈ domLines (容许少量归一化偏差)
  const a0 = report.align[0]
  expect(a0?.domLines).toBe(80)
  expect(a0?.matched).toBeGreaterThanOrEqual(75)
  expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)

  await page.click('#lsk-fab')
  expect(await page.locator('#lsk-overlay .lsk-blk').count()).toBe(10)
  await context.close()
})

test('grown (运行中 append): 指纹漂移 → 整池剥离重对齐, 无残留错位 (M3)', async ({ browser }) => {
  const { context, page } = await bootForgejoFixture(browser)

  const beforeInline = await page.locator('.lsk-inline').count()
  expect(beforeInline).toBeGreaterThan(0)

  // 连续 append 至失败区 (T4: 失败块集中在 L985+; 8 × 120 行 → 1040 ≥ 985)
  for (let i = 0; i < 8; i++) await page.click('#fj-append')
  // 等终态 (debounce 可能合并批次, 条目数不定 — 池行数到位即整池重对齐完成)
  await page.waitForFunction('window.__lsk && window.__lsk.align.at(-1).domLines === 1040')
  const report = await getReport(page)
  expect(report.sync.incremental).toBeGreaterThanOrEqual(1)

  // 重对齐条目: domLines 覆盖失败区 且 matched 近满 — 旧 80 行标注未残留错位
  const grownAlign = report.align.at(-1)
  expect(grownAlign?.domLines).toBe(1040)
  expect(grownAlign?.matched).toBeGreaterThanOrEqual((grownAlign?.domLines ?? 0) - 10)
  // 失败块行 (L985+) 进入池 → 注入显著增长
  expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(beforeInline)
  // 截图证据: 滚到失败区让红边条高亮可见 (DOM 断言已全局, 此处纯呈现)
  await page.evaluate(() => document.getElementById('jobstep-0-990')?.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'e2e/shots/forgejo-grown.png' })
  await context.close()
})

test('同数异容 (m5): 行数不变内容变 → 指纹哨兵仍触发整池重对齐', async ({ browser }) => {
  const { context, page } = await bootForgejoFixture(browser)
  const alignCountBefore = (await getReport(page)).align.length

  await page.click('#fj-rewrite') // 80 行 → 另一段 80 行 (行数同, 首末行文本变)
  await page.waitForFunction((n: number) => window.__lsk && window.__lsk.align.length > n, alignCountBefore)
  const report = await getReport(page)
  // 重对齐发生: 新条目 domLines 仍 80 (同数), 但对齐/注入按新内容重建
  const rewritten = report.align.at(-1)
  expect(rewritten?.domLines).toBe(80)
  expect(rewritten?.matched).toBeGreaterThanOrEqual(75)
  // 新 DOM 行 (全新元素) 被按新对齐注入 — 全量在场行重扫生效
  expect(report.sync.incremental).toBeGreaterThanOrEqual(1)
  expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)
  await context.close()
})
