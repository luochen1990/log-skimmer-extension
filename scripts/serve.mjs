// serve.mjs — 本地静态服务 (fixture 页 + dist 产物 + bundle; 零依赖)。
// CORS 全开 (跨域 GM shim fetch 用 — forgejo 活体 e2e 从 3999 页面
// 拉本服务的 bundle)。状态码仿真: /_status/<code>/<path> 以 <code> 响应 (降级路径 e2e)。

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 端口 SSOT = playwright.config.ts (缺省挑空闲端口, LSK_E2E_PORT 显式时固定);
// 本服务只消费该变量 (config 进程与 serve 同 env, workers 亦同源)。
const PORT = Number(process.env.LSK_E2E_PORT ?? 8801)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
}

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    let status = 200
    // /_status/<code>/<path> — 以指定状态码响应 (fetch 403/404 降级路径仿真)
    const sm = /^\/_status\/(\d{3})\//.exec(urlPath)
    if (sm) {
      status = Number(sm[1])
      urlPath = urlPath.slice(sm[0].length - 1)
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html'
    const p = path.join(ROOT, urlPath)
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(status, {
      'content-type': MIME[path.extname(p)] ?? 'application/octet-stream',
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    })
    fs.createReadStream(p).pipe(res)
  })
  .listen(PORT, '127.0.0.1', () => console.log(`log-skimmer-extension static: http://127.0.0.1:${PORT}/`))
