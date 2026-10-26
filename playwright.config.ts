// playwright.config.ts — e2e 配置: fixture 静态服务 (8801) 由 webServer 自管。
// config 置于仓库根: webServer 命令的 cwd = config 目录 (root), `npm run serve` 可解析。
import { defineConfig } from '@playwright/test'

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
    baseURL: 'http://127.0.0.1:8801',
    headless: true,
  },
  webServer: {
    command: 'npm run serve',
    url: 'http://127.0.0.1:8801/fixtures/github/index.html',
    reuseExistingServer: true,
    timeout: 20_000,
  },
})
