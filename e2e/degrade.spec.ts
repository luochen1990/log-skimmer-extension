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
  // 全源失败已自动打开面板 — 直接断言 (勿再点 fab: toggle 会把它关掉)
  await expect(page.locator('#lsk-overlay')).toBeVisible()
  const errBox = await page.locator('#lsk-overlay .lsk-err').textContent()
  expect(errBox).toContain('403')
  await page.screenshot({ path: 'e2e/shots/degrade-403.png' })
  await context.close()
})

test('缓存投毒自愈: 引擎拒收 bundle → 缓存作废 + 提示刷新 (M2)', async ({ browser }) => {
  // 结构校验可过 (字段齐全/版本匹配) 但 yaml 全量非法 — 引擎装载必败的毒化形态
  const bundle = (await readFixtureBundle()) as { rules: Array<Record<string, string>> }
  for (const r of bundle.rules) r.yaml = 'not: [valid: yaml'
  const { context, page } = await newSkimPage(browser)
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
  expect(diag.message).toContain('rejected')
  expect(diag.hint).toContain('reload')

  // 毒化缓存已被作废 (GM storage 无 bundle 键) — 否则刷新页也救不回
  const cached = await page.evaluate(() =>
    Object.hasOwn(JSON.parse(localStorage.getItem('lsk-gm-shim-store') ?? '{}'), 'lsk:rulesBundle'),
  )
  expect(cached).toBe(false)

  // 解除拦截 → reload (重新注入, e2e 注入不跨导航) → 正常 bundle 重拉恢复 (自愈闭环)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.reload()
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  const recovered = await waitReady(page)
  expect(recovered.sources[1]).toMatchObject({ ok: true, blocks: 10 })
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

// 版本协商降级在 engine-version.spec.ts 有专题套件 (wasm 侧版本 + 零注入 +
// 面板呈现全断言); 本用例保留 rules 诊断面视角的双保险。
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
