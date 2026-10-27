// inline-fold.spec.ts — 任务③ 流内视图行为契约: 噪音折叠 / icon 高亮 / 自动展开 / 可逆性。
// 契约锚点:
//   ① 折叠: 连续无标注段 (≥3) 隐藏 (class, 绝不 remove 页面节点) + 段首占位行, 点击展开;
//   ② 可逆: inline off = 高亮+折叠+占位行全清, 页面行数/结构不变;
//   ③ 幂等重放: 虚拟化重建/grown 后折叠态与高亮无损重建;
//   ④ 自动展开: 命中所在的原生折叠区展开且只展开一次 (github group / forgejo step)。
// 不变量: .lsk-inline 与 .lsk-folded 互斥 (标注行永不折叠)。
import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import { FORGEJO_FIXTURE, GITHUB_FIXTURE, injectUserscript, newSkimPage, waitReady } from './harness.ts'

const GH_GROUP_FIXTURE = `${GITHUB_FIXTURE.replace(/\/index\.html$/, '')}/group-fold.html`
const FORGEJO_FOLD_FIXTURE = `${FORGEJO_FIXTURE}?fold=1`
const LOG_TEXT = fs.readFileSync('fixtures/github/logs/step2.log.txt', 'utf8')

/** 等 github 夹具滚动级联收敛 (折叠→高度压缩→锚定→attach 的链路落定)。 */
async function settle(page: import('@playwright/test').Page, ms = 800): Promise<void> {
  await page.waitForTimeout(ms)
}

test.describe('forgejo (确定性整池, 无虚拟化)', () => {
  async function bootFold(browser: import('@playwright/test').Browser, url = FORGEJO_FIXTURE) {
    const { context, page } = await newSkimPage(browser)
    await context.route('**/attempt/1/logs', (route) =>
      route.fulfill({ contentType: 'text/plain', body: LOG_TEXT }),
    )
    await page.goto(url)
    await page.waitForFunction(
      'window.__fjSim && (window.__fjSim.rendered >= 80 || window.__fjSim.fold === true)',
    )
    await injectUserscript(page)
    await waitReady(page)
    return { context, page }
  }

  test('折叠: 无标注段隐藏 + 占位行可见; 点击展开; off 完全还原; on 尊重用户展开', async ({ browser }) => {
    const { context, page } = await bootFold(browser)

    // 80 行池, L1 标注 → run 2-80 (79 行) 折叠为一条占位行
    const ph = page.locator('.lsk-fold-ph')
    await expect(ph).toHaveCount(1)
    await expect(ph.first()).toHaveText('⋯ 79 lines')
    expect(await page.locator('[data-lsk-fold]').count()).toBe(79)
    // 结构不变量: 页面行仍全在 (只是 display:none), 无节点被移除
    expect(await page.locator('.job-log-line').count()).toBe(80)
    // 不变量: 标注行与折叠互斥
    expect(await page.locator('.lsk-inline.lsk-folded').count()).toBe(0)
    // 高亮行在场 (L1) 且可见
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)

    // 点击占位行 → 展开该段 (行恢复显示, 占位行移除, 行数不变)
    await ph.first().click()
    await expect(page.locator('.lsk-fold-ph')).toHaveCount(0)
    expect(await page.locator('[data-lsk-fold]').count()).toBe(0)
    expect(await page.locator('.job-log-line').count()).toBe(80)

    // off: 高亮/折叠痕迹全清 + 结构不变 (可逆性)
    await page.click('#lsk-fab')
    await page.click('#lsk-inline-btn')
    expect(await page.locator('.lsk-inline').count()).toBe(0)
    expect(await page.locator('[data-lsk-fold]').count()).toBe(0)
    expect(await page.locator('.job-log-line').count()).toBe(80)

    // on: 恢复高亮; 用户展开过的段不复活 (userExpanded 外置状态)
    await page.click('#lsk-inline-btn')
    await expect(page.locator('.lsk-inline').first()).toBeVisible()
    await expect(page.locator('.lsk-fold-ph')).toHaveCount(0)
    await context.close()
  })

  test('自动展开: 收起 step 含命中 → 程序化点开折叠头 (只一次), 命中经 replay 注入', async ({ browser }) => {
    const { context, page } = await bootFold(browser, FORGEJO_FOLD_FIXTURE)
    // 未手工点击折叠头: boot 的 autoExpand 发现 "未渲染 step + 存在未覆盖命中" → 点开
    const sim = (await page.evaluate('({...window.__fjSim})')) as { rendered: number; opened: number }
    expect(sim.rendered).toBeGreaterThanOrEqual(80)
    expect(sim.opened).toBe(1) // 防循环: 只展开一次
    // 展开引发的 DOM 增长走 replay (debounce 120ms) — 等注入落定
    await page.waitForFunction('document.querySelectorAll(".lsk-inline").length > 0', undefined, {
      timeout: 10_000,
    })
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThan(0)
    // 折叠 pass 在展开后的池上照常生效
    expect(await page.locator('.lsk-fold-ph').count()).toBe(1)
    await context.close()
  })

  test('重放幂等 (grown): 整池重对齐后折叠态重建, 无残留无错位', async ({ browser }) => {
    const { context, page } = await bootFold(browser)
    expect(await page.locator('.lsk-fold-ph').count()).toBe(1)

    for (let i = 0; i < 8; i++) await page.click('#fj-append')
    await page.waitForFunction('window.__lsk && window.__lsk.align.at(-1).domLines === 1040')
    await settle(page, 600)

    // 1040 行池重对齐重折叠: 占位行重建 (多段), 无重叠 key, 标注行零折叠
    const phKeys = await page
      .locator('.lsk-fold-ph')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lskPh))
    expect(phKeys.length).toBeGreaterThanOrEqual(1)
    expect(new Set(phKeys).size).toBe(phKeys.length)
    const folded = await page.locator('[data-lsk-fold]').count()
    expect(folded).toBeGreaterThan(0)
    expect(await page.locator('.lsk-inline.lsk-folded').count()).toBe(0)
    // 占位行位置正确: 段首行的前一兄弟是占位行, 其余折叠行紧跟折叠行 (run 连续)
    const misaligned = await page.evaluate(() => {
      let bad = 0
      for (const el of document.querySelectorAll<HTMLElement>('[data-lsk-fold]')) {
        const prev = el.previousElementSibling
        const ok =
          prev?.classList.contains('lsk-fold-ph') === true ||
          (prev instanceof HTMLElement && prev.dataset.lskFold === el.dataset.lskFold)
        if (!ok) bad++
      }
      return bad
    })
    expect(misaligned).toBe(0)
    await context.close()
  })
})

test.describe('github (虚拟化窗口)', () => {
  test('折叠: 视口噪音段折叠 + 占位行; 点击展开; step 重建后折叠态经重放恢复', async ({ browser }) => {
    const { context, page } = await newSkimPage(browser)
    await page.goto(GITHUB_FIXTURE)
    await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
    await injectUserscript(page)
    await waitReady(page)

    // 初始窗口 (rows 0-99): 仅 L1 标注 → 噪音段折叠, 占位行在场
    expect(await page.locator('.lsk-fold-ph').count()).toBeGreaterThanOrEqual(1)
    expect(await page.locator('.lsk-inline.lsk-folded').count()).toBe(0)

    // 滚到失败区 → attach → 重放: 折叠+高亮随批次重建
    await page.evaluate(() => window.scrollTo(0, 985 * 21))
    await page.waitForFunction('window.__lsk && window.__lsk.inline.replayed > 0')
    await settle(page)
    expect(await page.locator('.lsk-fold-ph').count()).toBeGreaterThanOrEqual(3)
    expect(await page.locator('.lsk-inline').count()).toBeGreaterThanOrEqual(15)

    // 点击失败区前的占位行 (:982, "⋯ 18 lines") → 该段展开, 其余段仍折叠
    const key = await page
      .locator('.lsk-fold-ph')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lskPh).find((k) => k?.endsWith(':982')))
    expect(key).toBeTruthy()
    // 展开前的段内行身份 (data-index 列表) — 展开后必须原样在场且解除隐藏。
    // (结构不变量: 我们只解除隐藏, 绝不增删页面节点; 虚拟化池的绝对行数随
    // attach/detach 波动, 不可作断言面)
    const runIdxes = await page
      .locator(`[data-lsk-fold="${key}"]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-index')))
    expect(runIdxes.length).toBe(18)
    await page.locator(`.lsk-fold-ph[data-lsk-ph="${key}"]`).click()
    await expect(page.locator(`.lsk-fold-ph[data-lsk-ph="${key}"]`)).toHaveCount(0)
    const restored = await page.evaluate(
      (idxes: Array<string | null>) =>
        idxes.every((i) => {
          const el = i === null ? null : document.querySelector(`#check-step-2 [data-index='${i}']`)
          return el !== null && !el.classList.contains('lsk-folded')
        }),
      runIdxes,
    )
    expect(restored).toBe(true)
    // 其他段不受牵连
    expect(await page.locator('.lsk-fold-ph').count()).toBeGreaterThanOrEqual(2)

    // 重放幂等: step 折叠/展开 (整池清空重建) → 占位行与高亮经重放恢复
    await page.click('#check-step-2 summary')
    await page.waitForTimeout(400)
    await page.click('#check-step-2 summary')
    await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 2')
    await page.evaluate(() => window.scrollTo(0, 985 * 21))
    await page.waitForFunction(() => document.querySelectorAll('.lsk-inline').length >= 15, undefined, {
      timeout: 15_000,
    })
    await settle(page)
    expect(await page.locator('.lsk-fold-ph').count()).toBeGreaterThanOrEqual(2)
    expect(await page.locator('.lsk-inline.lsk-folded').count()).toBe(0)
    await page.screenshot({ path: 'e2e/shots/github-fold-replay.png' })
    await context.close()
  })

  test('自动展开 (group): 命中所在 group 展开, 无命中 group 保持收起', async ({ browser }) => {
    const { context, page } = await newSkimPage(browser)
    await page.goto(GH_GROUP_FIXTURE)
    await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
    await injectUserscript(page)
    await waitReady(page)

    // 初始窗口内的 group (bootstrap, 无命中) 保持收起
    await expect(page.locator('details.lsk-group[data-gstart="1"]')).not.toHaveAttribute('open')
    // 滚到命中 group (grouped 语料: awk 在原 L1001 前插入 group 头 → idx 1000-1004,
    // 完整落在 cluster 20 (1000-1049) 内 — fixture 契约 "group 不跨 cluster";
    // 内含 clang/gcc 失败块 (idx 1001-1002))
    await page.evaluate(() => window.scrollTo(0, 985 * 21))
    await page.waitForFunction('window.__lsk && window.__lsk.inline.replayed > 0')
    await expect
      .poll(
        async () =>
          page
            .locator('details.lsk-group[data-gstart="1000"]')
            .evaluate((el) => (el as HTMLDetailsElement).open),
        { timeout: 10_000 },
      )
      .toBe(true)
    // group 内命中行已注入且可见 (details 展开态); group 内噪音照常折叠
    const inGroup = await page.evaluate(() => {
      const g = document.querySelector('details.lsk-group[data-gstart="1000"]')
      return {
        inline: g?.querySelectorAll('.lsk-inline').length ?? 0,
        visible: [...(g?.querySelectorAll('.lsk-inline') ?? [])].every(
          (el) => (el as HTMLElement).offsetParent !== null || (el as HTMLElement).offsetHeight > 0,
        ),
      }
    })
    expect(inGroup.inline).toBeGreaterThan(0)
    expect(inGroup.visible).toBe(true)
    await page.screenshot({ path: 'e2e/shots/github-group-autoexpand.png' })
    await context.close()
  })
})

test('暗色适配: prefers-color-scheme → 面板 token 切换 (Primer Dark 同源)', async ({ browser }) => {
  const { context, page } = await newSkimPage(browser)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(GITHUB_FIXTURE)
  await page.waitForFunction('window.__ghSim && window.__ghSim.renders >= 1')
  await injectUserscript(page)
  await waitReady(page)
  await page.click('#lsk-fab')
  await expect(page.locator('#lsk-overlay')).toBeVisible()
  const bg = await page.evaluate(() => {
    const panel = document.querySelector('#lsk-overlay')?.shadowRoot?.querySelector('.panel')
    return panel === null || panel === undefined ? '' : getComputedStyle(panel).backgroundColor
  })
  expect(bg).toBe('rgb(22, 27, 34)') // token 暗色 --lsk-bg (#161b22)
  await page.screenshot({ path: 'e2e/shots/github-overlay-dark.png' })
  await context.close()
})
