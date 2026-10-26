// engine-version.spec.ts — M1 正式 wasm (wasm_engine_version 导出) 的版本协商专题。
// 版本来源切换: engineVersion 不再是 host 常量, 而是 wasm 侧真实读取 (abi.ts
// readEngineVersion) — 本套件锁定 "探针返回合法版本 + 协商降级/放行" 三形态。
import { expect, test } from '@playwright/test'
import {
  BUNDLE_URL,
  GITHUB_FIXTURE,
  injectUserscript,
  newSkimPage,
  readFixtureBundle,
  waitReady,
  waitSettled,
} from './harness.ts'

/** M1 产物对账锚点: engine crate Cargo.toml version (漂移 = 产物/源不一致, 该红)。 */
const ENGINE_CRATE_VERSION = '0.1.0'

/** 打开 github fixture 并注入 (版本协商用例与 degrade 主套件同基底)。 */
async function bootVersionPage(browser: import('@playwright/test').Browser): Promise<{
  context: import('@playwright/test').BrowserContext
  page: import('@playwright/test').Page
}> {
  const { context, page } = await newSkimPage(browser)
  await page.goto(GITHUB_FIXTURE)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  return { context, page }
}

test('engineVersion 探针: wasm 侧读取, 返回合法三段版本 (== engine crate 版本)', async ({ browser }) => {
  const { context, page } = await bootVersionPage(browser)
  const report = await waitReady(page)
  // 合法三段 (semver 解析可用形态)
  expect(report.engineVersion).toMatch(/^\d+\.\d+\.\d+$/)
  // 对账锚点: 与构建产物的 engine crate 版本一致 (host 常量时代此断言测不出漂移)
  expect(report.engineVersion).toBe(ENGINE_CRATE_VERSION)
  await context.close()
})

test('min_engine_version 不满足 (高于 wasm 引擎版本) → 降级提示呈现, 不注入', async ({ browser }) => {
  const { context, page } = await bootVersionPage(browser)
  const bundle = (await readFixtureBundle()) as { manifest: Record<string, unknown> }
  bundle.manifest.min_engine_version = '999.0.0'
  await page.route(BUNDLE_URL, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(bundle) }),
  )
  const report = await waitSettled(page)
  expect(report.ready).toBe(false)
  const diag = report.diags.find((d) => d.stage === 'rules')
  if (!diag) throw new Error('expected rules diag')
  // 文案三要素: 要求版本 ≥X / 当前实际版本 A.B.C (wasm 侧) / 更新指引
  expect(diag.message).toContain('999.0.0')
  expect(diag.message).toContain(ENGINE_CRATE_VERSION)
  expect(diag.message).toContain('update the userscript')
  // 不注入: 面板自动打开呈现诊断, 零流内高亮
  expect(await page.locator('#lsk-overlay').isVisible()).toBe(true)
  const diagText = await page.locator('#lsk-diags').textContent()
  expect(diagText).toContain('999.0.0')
  expect(await page.locator('.lsk-inline').count()).toBe(0)
  await page.screenshot({ path: 'e2e/shots/engine-version-degrade.png' })
  await context.close()
})

test('min_engine_version 满足 (≤ wasm 引擎版本) → 协商通过, 正常注入', async ({ browser }) => {
  const { context, page } = await bootVersionPage(browser)
  // 默认 fixture bundle (min=0.1.0 ≤ 引擎 0.1.0) — 协商放行形态
  const report = await waitReady(page)
  expect(report.ready).toBe(true)
  expect(report.rules).toMatchObject({ ruleCount: 165, source: 'network' })
  // 正常注入: step2 真实失败样本 (T4 对账锚点 10 blocks / 1172→21)
  expect(report.sources[1]).toMatchObject({ ok: true, blocks: 10, inputLines: 1172, outputLines: 21 })
  await page.click('#lsk-fab')
  expect(await page.locator('#lsk-overlay .lsk-blk').count()).toBe(10)
  await context.close()
})
