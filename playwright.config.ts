// playwright.config.ts — e2e 配置: fixture 静态服务由 webServer 自管。
// config 置于仓库根: webServer 命令的 cwd = config 目录 (root), `npm run serve` 可解析。
// 端口策略 (2026-10-28 事故加固): 缺省每次挑空闲端口 — reuseExistingServer 会复用任意来源
// 的同端口服务, 陈旧 fixture 服务 (昨会话遗留) 在场时 e2e 静默跑旧 fixture → 假红/假绿;
// LSK_E2E_PORT 显式指定时固定 (CI 缓存 / 复现口径)。

import net from 'node:net'
import { defineConfig } from '@playwright/test'

/** 向 OS 要一个空闲端口 (listen 0 → 读回; 关闭与 serve 绑定间的窗口本地可忽略)。 */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

const PORT = process.env.LSK_E2E_PORT ? Number(process.env.LSK_E2E_PORT) : await freePort()
process.env.LSK_E2E_PORT = String(PORT) // 同源消费: workers (harness BASE) 与 serve.mjs

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  workers: 4,
  reporter: [['list']],
  outputDir: './e2e/.playwright',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  webServer: {
    command: 'npm run serve',
    url: `http://127.0.0.1:${PORT}/fixtures/github/index.html`,
    reuseExistingServer: true,
    timeout: 20_000,
  },
})
