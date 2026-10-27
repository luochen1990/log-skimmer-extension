// playwright.config.ts — e2e 配置: fixture 静态服务 (8801) 由 webServer 自管。
// config 置于仓库根: webServer 命令的 cwd = config 目录 (root), `npm run serve` 可解析。
// LSK_E2E_PORT: 同仓多 worktree 并行 e2e 的端口逃生口 (serve.mjs 同步消费, 见其头注释)。
import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.LSK_E2E_PORT ?? 8801)

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
