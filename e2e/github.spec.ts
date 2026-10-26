// github.spec.ts — GitHub 形态 fixture (虚拟化 + 重渲染对抗) 主套件。
// 数据基底与 T4 轨 B 相同 (真实失败样本 step2 = 1172 行, 真实 165 规则 bundle),
// 断言锚点 = T4 PROTO-REPORT 的实测数字 (浏览器内 wasm skim 与 CLI 对账一致)。
// 覆盖: overlay 呈现 / 流内高亮 / 折叠交互 / 跳转 / 重放 / 控件态 (B1 矩阵) / 增量 sync。
import { expect, test } from '@playwright/test'
import {
  DIST,
  GITHUB_FIXTURE,
  getReport,
  injectUserscript,
  type LskReport,
  newSkimPage,
  waitReady,
} from './harness.ts'

/** 打开 fixture 页并注入 userscript, 等就绪。 */
async function bootGithub(browser: import('@playwright/test').Browser): Promise<{
  context: import('@playwright/test').BrowserContext
  page: import('@playwright/test').Page
  report: LskReport
}> {
  const { context, page } = await newSkimPage(browser)
  await page.goto(GITHUB_FIXTURE)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  const report = await waitReady(page)
  return { context, page, report }
}

/** step2 (失败源) 断言辅助: 源必为 ok, 否则返回 undefined 供 expect 捕获。 */
function srcOf(report: LskReport, idx: number) {
  return report.sources[idx]
}

test.describe('github fixture 主链路', () => {
  test('overlay 呈现: 双源 tab + step2 块数/压缩比与 T4 对账一致', async ({ browser }) => {
    const { context, page, report } = await bootGithub(browser)
    expect(report.adapter).toBe('github')
    expect(report.rules).toMatchObject({ ruleCount: 165, source: 'network' })

    // 双源 (step1 + step2), step2 = 真实失败样本: T4 对账锚点 10 blocks / 1172→21
    expect(report.sources).toHaveLength(2)
    const step2 = srcOf(report, 1)
    expect(step2).toMatchObject({ ok: true, blocks: 10, inputLines: 1172, outputLines: 21 })

    // fab + overlay 打开 → 块列表 + 折叠 gap + 规则 chip
    await expect(page.locator('#lsk-fab')).toBeVisible()
    await page.click('#lsk-fab')
    await expect(page.locator('#lsk-overlay')).toBeVisible()
    // 失败源优先选中 → step2 的 10 块
    expect(await page.locator('#lsk-overlay .lsk-blk').count()).toBe(10)
    expect(await page.locator('#lsk-overlay .lsk-gap').count()).toBeGreaterThan(0)
    const meta = await page.locator('#lsk-meta').textContent()
    expect(meta).toContain('1172→21')
    expect(await page.locator('#lsk-rules-chip').textContent()).toContain('165 rules')
    await page.screenshot({ path: 'e2e/shots/github-overlay.png' })
    await context.close()
  })

  test('流内高亮: 滚动到失败区 → 虚拟化窗口推进 → 重放注入', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)

    // 初始视口: 失败区在窗口外 — 流内高亮仅视口内 info 行
    expect(await page.locator('.lsk-inline').count()).toBeLessThan(5)

    // 滚到失败区 (~L1000): attach → observer 重放
    await page.evaluate(
      'document.querySelector("[data-index=\'985\']")?.scrollIntoView() ?? window.scrollTo(0, 985*21)',
    )
    await page.waitForFunction('window.__lsk && window.__lsk.inline.replayed > 0')
    await page.waitForTimeout(600)
    await page.evaluate('document.querySelector(`[data-index="1001"]`)?.scrollIntoView({block:"center"})')
    await page.waitForTimeout(500)
    const report = await getReport(page)
    expect(report.inline.replayed).toBeGreaterThan(0)
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThanOrEqual(15) // T4: 16 行 (视口窗口内)
    await page.screenshot({ path: 'e2e/shots/github-inline.png' })
    await context.close()
  })

  test('折叠交互: 块 context 展开/收起 + gap 折叠标记', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)
    await page.click('#lsk-fab')

    const blk = page.locator('#lsk-overlay .lsk-blk').first()
    await expect(blk.locator('.lsk-ctx')).toBeHidden()
    await blk.locator('.lsk-row').click()
    await expect(blk.locator('.lsk-ctx')).toBeVisible()
    const ctxText = await blk.locator('.lsk-ctx').textContent()
    expect(ctxText?.length ?? 0).toBeGreaterThan(0)
    await blk.locator('.lsk-row').click()
    await expect(blk.locator('.lsk-ctx')).toBeHidden()
    await context.close()
  })

  test('跳转联动: overlay 点尾块 → 跨 cluster 滚动 + 目标行高亮', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)
    await page.click('#lsk-fab')

    const nb = await page.locator('#lsk-overlay .lsk-blk').count()
    await page
      .locator('#lsk-overlay .lsk-blk')
      .nth(nb - 1)
      .locator('.lsk-row')
      .click()
    // 等滚动落位 (直接 attach 或 cluster 占位→attach→flash 两条链路)
    await page.waitForFunction('window.scrollY > 5000')
    const jump = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.lsk-inline')].at(-1)
      return {
        dataIndex: el?.closest('[data-index]')?.getAttribute('data-index') ?? null,
        scrollY: Math.round(window.scrollY),
      }
    })
    expect(jump.dataIndex).not.toBeNull()
    expect(jump.scrollY).toBeGreaterThan(5000) // 深处块 (尾块 L1136+)
    await page.screenshot({ path: 'e2e/shots/github-jump.png' })
    await context.close()
  })

  test('重放: step 折叠/展开 (整池清空重建) → 高亮经重放恢复', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)

    // 先滚到失败区建立高亮基线
    await page.evaluate(
      'document.querySelector("[data-index=\'985\']")?.scrollIntoView() ?? window.scrollTo(0, 985*21)',
    )
    await page.waitForFunction('window.__lsk && window.__lsk.inline.replayed > 0')
    await page.waitForTimeout(500)
    const before = (await getReport(page)).inline

    // 收起 (T3: 收起保 DOM; 销毁发生在再展开) → 展开 = 整池清空重建 (parser.setData("") 语义)
    await page.click('#check-step-2 summary')
    await page.waitForTimeout(400)
    await page.click('#check-step-2 summary')
    await page.waitForFunction(
      (beforeReplayed: number) => window.__lsk && window.__lsk.inline.replayed > beforeReplayed,
      before.replayed,
      { timeout: 15_000 },
    )
    // 重渲染后滚回失败区 → 高亮恢复 (全新节点上的重放)
    const r0 = (await getReport(page)).inline.replayed
    await page.evaluate(
      'document.querySelector(`[data-index="1001"]`)?.scrollIntoView({block:"center"}) ?? window.scrollTo(0, 1001*21)',
    )
    await page.waitForFunction('document.querySelectorAll(".lsk-inline").length >= 15')
    const report = await getReport(page)
    expect(report.inline.replayed).toBeGreaterThan(r0)
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThanOrEqual(15)
    const sim = (await page.evaluate('({...window.__ghSim})')) as { renders: number }
    expect(sim.renders).toBeGreaterThanOrEqual(2)
    await page.screenshot({ path: 'e2e/shots/github-rerender-recovered.png' })
    await context.close()
  })
})

test.describe('控件态 × 重放 (B1 矩阵)', () => {
  test('inline off: 清痕迹 → 滚动重放零注入; on: 主动 sync 恢复', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)

    // 建立高亮基线
    await page.evaluate(
      'document.querySelector("[data-index=\'985\']")?.scrollIntoView() ?? window.scrollTo(0, 985*21)',
    )
    await page.waitForFunction('window.__lsk && window.__lsk.inline.replayed > 0')
    await page.waitForTimeout(400)
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)

    // off: 全部清痕迹
    await page.click('#lsk-fab')
    await page.click('#lsk-inline-btn')
    expect(await page.locator('.lsk-inline').count()).toBe(0)
    expect((await getReport(page)).inline.enabled).toBe(false)

    // off 状态下滚动 → 虚拟化重放被开关挡住 (B1: 不注入新行)
    await page.evaluate('window.scrollTo(0, 0)')
    await page.waitForTimeout(400)
    await page.evaluate(
      'document.querySelector("[data-index=\'985\']")?.scrollIntoView() ?? window.scrollTo(0, 985*21)',
    )
    await page.waitForTimeout(800)
    expect(await page.locator('.lsk-inline').count()).toBe(0)

    // on: 无 DOM 变更也要主动补 sync 恢复
    await page.click('#lsk-inline-btn')
    expect((await getReport(page)).inline.enabled).toBe(true)
    await page.waitForTimeout(200)
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)
    await context.close()
  })

  test('rules 刷新: 失败 → 保留旧 bundle 继续; 成功 → reskim 高亮重建', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)
    await page.evaluate(
      'document.querySelector("[data-index=\'985\']")?.scrollIntoView() ?? window.scrollTo(0, 985*21)',
    )
    await page.waitForFunction('window.__lsk && window.__lsk.inline.replayed > 0')
    await page.waitForTimeout(400)

    // 刷新失败 (网络断): route abort → 诊断 + 旧 bundle 继续工作
    await page.route('**/fixtures/rules-bundle.json', (route) => route.abort())
    await page.click('#lsk-fab')
    await page.click('#lsk-refresh')
    await page.waitForFunction('window.__lsk && window.__lsk.diags.length > 0')
    let report = await getReport(page)
    expect(report.diags.some((d) => d.stage === 'rules' && d.message.includes('refresh failed'))).toBe(true)
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0) // 高亮未被破坏
    const step2 = srcOf(report, 1)
    expect(step2).toMatchObject({ ok: true, blocks: 10 })

    // 刷新成功: 解除拦截 → 重拉 → reskim (块数不变, 诊断清空)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.click('#lsk-refresh')
    await page.waitForFunction('window.__lsk && window.__lsk.diags.length === 0')
    report = await getReport(page)
    expect(srcOf(report, 1)).toMatchObject({ ok: true, blocks: 10 })
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)
    await context.close()
  })
})

test('早注入 (document-start 语义): boot 有界重探 → 正常激活 (M1)', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  // addInitScript: 页面任何脚本前执行 — check-step 尚未渲染, 模拟最早注入时点
  await context.addInitScript({ path: DIST })
  await page.goto(GITHUB_FIXTURE)
  const report = await waitReady(page)
  expect(report.adapter).toBe('github')
  expect(report.sources[1]).toMatchObject({ ok: true, blocks: 10 })
  await context.close()
})

test('step 池与 check-step 脱钩 → 严格匹配零注入 (M4: 删兜底)', async ({ browser }) => {
  const { context, page } = await bootGithub(browser)

  // 展开 step1 建立注入基线
  await page.click('#check-step-1 summary')
  await page.waitForFunction('document.querySelectorAll("#check-step-1 .lsk-inline").length > 0')

  // 把 step1 日志池移出 check-step → stepKey 退化为 unknown-step (无 data-log-url 可寻)
  await page.evaluate(() => {
    const pool = document.querySelector('#check-step-1 .js-checks-log-display-container')
    if (pool) document.body.appendChild(pool)
  })

  // off→on 强制全量重 sync: 脱钩池无源匹配 → 零注入 (修复前兜底会错拿 step2 源注入)
  await page.click('#lsk-fab')
  await page.click('#lsk-inline-btn')
  await page.click('#lsk-inline-btn')
  await page.waitForTimeout(400)
  const pools = await page.evaluate(() =>
    [...document.querySelectorAll('.js-checks-log-display-container')].map((p) => ({
      inStep: !!p.closest('check-step'),
      inline: p.querySelectorAll('.lsk-inline').length,
    })),
  )
  const detached = pools.filter((p) => !p.inStep)
  expect(detached).toHaveLength(1)
  expect(detached[0]?.inline).toBe(0) // 脱钩池: 无兜底 → 零注入
  const attached = pools.filter((p) => p.inStep)
  expect(attached.length).toBeGreaterThan(0)
  await context.close()
})

test.describe('多源与增量', () => {
  test('step1 第二数据源: 展开 → 高亮 + tab 切换', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)

    // 展开 step1 (懒加载第二源) → 增量 sync 注入
    await page.click('#check-step-1 summary')
    await page.waitForTimeout(900)
    expect(await page.locator('#check-step-1 .lsk-inline').count()).toBeGreaterThan(0)

    // overlay tab 切到 step1 → meta 更新
    await page.click('#lsk-fab')
    await page.locator('#lsk-tabs button', { hasText: 'step 1' }).click()
    const meta = await page.locator('#lsk-meta').textContent()
    expect(meta).toContain('18→')
    await context.close()
  })

  test('增量 sync: 滚动批次只扫新增子树行 (lastExamined 有界)', async ({ browser }) => {
    const { context, page } = await bootGithub(browser)

    // 双 step 展开 (两池在场): boot 一轮全量; step1 懒加载展开走增量路径
    await page.click('#check-step-1 summary')
    await page.waitForTimeout(900)
    const mid = await getReport(page)
    expect(mid.sync.full).toBe(1)
    expect(mid.sync.incremental).toBeGreaterThanOrEqual(1)

    // 小幅滚动 (1-2 个新 cluster): 增量批次只扫新增子树行
    const incBefore = mid.sync.incremental
    await page.evaluate(
      'document.querySelector("[data-index=\'60\']")?.scrollIntoView() ?? window.scrollTo(0, 60*21)',
    )
    await page.waitForFunction(
      (inc: number) => window.__lsk && window.__lsk.sync.incremental > inc,
      incBefore,
    )
    await page.waitForTimeout(400)
    const afterScroll = await getReport(page)
    const domRows = await page.locator('div[data-index]').count()
    // 增量: 检查行数 = 新 attach 的行 (~1-2 cluster), 且严格小于在场行总数
    // (整池重扫则 ≥ 在场行数 — 池内在场 ~150+18 行)
    expect(afterScroll.sync.lastExamined).toBeGreaterThan(0)
    expect(afterScroll.sync.lastExamined).toBeLessThanOrEqual(120)
    expect(domRows).toBeGreaterThanOrEqual(150)

    // 对照: 控件态主动触发一次全量 sync (inline off→on) — lastExamined ≈ 在场行总数
    await page.click('#lsk-fab')
    await page.click('#lsk-inline-btn')
    await page.click('#lsk-inline-btn')
    await page.waitForTimeout(300)
    const fullSync = await getReport(page)
    expect(fullSync.sync.lastExamined).toBeGreaterThanOrEqual(domRows)
    expect(fullSync.sync.lastExamined).toBeGreaterThan(afterScroll.sync.lastExamined)
    await context.close()
  })
})
