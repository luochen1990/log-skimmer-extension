// degrade.spec.ts — 降级路径: 每个失败环节给出 "哪个环节/为什么/怎么办" 的诊断,
// 不注入不报错 (可用性原则: 程序不应异常终止; 页面永远不被破坏)。
import { expect, test } from '@playwright/test'
import {
  BASE,
  BUNDLE_URL,
  getReport,
  injectUserscript,
  newSkimPage,
  readFixtureBundle,
  staleCacheSeed,
  waitReady,
  waitSettled,
} from './harness.ts'

test('无日志端点 (运行中 job) → 诊断呈现, 面板自动打开', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  await page.goto(`${BASE}/fixtures/degrade/no-endpoint.html`)
  await injectUserscript(page)
  const report = await waitSettled(page)
  expect(report.ready).toBe(false)
  expect(report.diags.some((d) => d.stage === 'source')).toBe(true)
  expect(report.diags.some((d) => d.message.includes('no log endpoints'))).toBe(true)
  // 面板自动打开 + 诊断条可见
  expect(await page.locator('#lsk-overlay').isVisible()).toBe(true)
  const diagText = await page.locator('#lsk-diags').textContent()
  expect(diagText).toContain('no log endpoints')
  await page.screenshot({ path: 'e2e/shots/degrade-no-endpoint.png' })
  await context.close()
})

test('日志端点 403 (登录墙/私有仓) → 源级错误 + hint', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  await page.goto(`${BASE}/fixtures/degrade/forbidden.html`)
  await injectUserscript(page)
  await waitReady(page)
  const report = await getReport(page)
  expect(report.ready).toBe(true) // boot 完成 (诊断是源级, 不致命)
  const src = report.sources[0]
  if (!src || src.ok) throw new Error('expected source failure')
  expect(src.error).toContain('403')
  expect(src.error).toContain('sign in')
  // overlay 错误框呈现
  await page.click('#lsk-fab')
  const errBox = await page.locator('#lsk-overlay .lsk-err').textContent()
  expect(errBox).toContain('403')
  await page.screenshot({ path: 'e2e/shots/degrade-403.png' })
  await context.close()
})

test('日志端点 404 (匿名/保留删除) → 源级错误 + github 登录 hint', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  await page.goto(`${BASE}/fixtures/degrade/notfound.html`)
  await injectUserscript(page)
  await waitReady(page)
  const src = (await getReport(page)).sources[0]
  if (!src || src.ok) throw new Error('expected source failure')
  expect(src.error).toContain('404')
  expect(src.error).toContain('sign in')
  await context.close()
})

test('规则 bundle 首拉失败 (无缓存) → rules 诊断, 不注入', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  await page.goto(`${BASE}/fixtures/github/index.html`)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await page.route(BUNDLE_URL, (route) => route.abort())
  await injectUserscript(page)
  const report = await waitSettled(page)
  expect(report.ready).toBe(false)
  const diag = report.diags.find((d) => d.stage === 'rules')
  if (!diag) throw new Error('expected rules diag')
  expect(diag.message).toContain('fetch failed')
  expect(await page.locator('#lsk-overlay').isVisible()).toBe(true) // 面板自动打开
  await page.screenshot({ path: 'e2e/shots/degrade-rules-fetch.png' })
  await context.close()
})

test('版本协商: min_engine_version 高于本构建 → bundle 拒收', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  const bundle = (await readFixtureBundle()) as { manifest: Record<string, unknown> }
  bundle.manifest.min_engine_version = '999.0.0'
  await page.route(BUNDLE_URL, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(bundle) }),
  )
  await page.goto(`${BASE}/fixtures/github/index.html`)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  const report = await waitSettled(page)
  expect(report.ready).toBe(false)
  const diag = report.diags.find((d) => d.stage === 'rules')
  if (!diag) throw new Error('expected rules diag')
  expect(diag.message).toContain('999.0.0')
  await context.close()
})

test('离线韧性: stale 缓存 + 网络死 → 缓存可用 + stale 提示', async ({ browser }) => {
  const bundle = await readFixtureBundle()
  const { context, page } = await newSkimPage(browser, { seed: staleCacheSeed(bundle, 10) })
  await page.goto(`${BASE}/fixtures/github/index.html`)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await page.route(BUNDLE_URL, (route) => route.abort()) // 网络死
  await injectUserscript(page)
  await waitReady(page)
  const report = await getReport(page)
  expect(report.ready).toBe(true)
  expect(report.rules).toMatchObject({ source: 'cache', stale: true, ruleCount: 165 })
  // 功能不受影响: 双源 + step2 10 块 (T4 锚点)
  expect(report.sources[1]).toMatchObject({ ok: true, blocks: 10 })
  await page.click('#lsk-fab')
  expect(await page.locator('#lsk-rules-chip').textContent()).toContain('old')
  await page.screenshot({ path: 'e2e/shots/degrade-stale-cache.png' })
  await context.close()
})

test('无脚本管理器 (no GM): 降级 storage + fetch, 可用性完整', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser, { noGm: true })
  // 无 GM 时 bundleUrlOverride 不可用, 默认 URL = raw.githubusercontent.com —
  // e2e 离线原则: 拦截默认 URL 以本地 fixture 响应 (模拟可网环境)
  await page.route('**/raw.githubusercontent.com/**', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(await readFixtureBundle()),
    }),
  )
  await page.goto(`${BASE}/fixtures/github/index.html`)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  await waitReady(page)
  const report = await getReport(page)
  expect(report.sources[1]).toMatchObject({ ok: true, blocks: 10 })
  await context.close()
})

test('非 CI 页面: 适配器不匹配 → 零注入零报错', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  await page.goto(`${BASE}/fixtures/degrade/plain.html`)
  await injectUserscript(page)
  await page.waitForTimeout(300)
  expect(await page.evaluate('window.__lsk')).toBeUndefined()
  expect(await page.locator('#lsk-fab').count()).toBe(0)
  await context.close()
})
