// gm.ts — Tampermonkey GM_* 门面 (唯一的脚本管理器接触点)。
// 契约: 上层 (rules.ts/controller.ts) 只依赖 GmEnv 接口, 不感知 GM 细节;
// 无管理器环境 (裸浏览器/测试) 自动降级: storage→localStorage, 跨域→fetch
// (同源可用; 真跨域会被 CORS 拒 → 诊断层给出 "装 Tampermonkey" 提示)。

export interface CrossOriginResponse {
  status: number
  text: string
}

/** 携带 HTTP 状态的失败 (供诊断层区分 403/404/网络错误)。 */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, url: string) {
    super(`HTTP ${status}: ${url}`)
    this.name = 'HttpError'
    this.status = status
  }
}

export interface GmEnv {
  /** 跨域 GET (规则 bundle 专用); 非 2xx 抛 HttpError, 网络失败抛 Error。 */
  crossOriginFetch(url: string, timeoutMs: number): Promise<CrossOriginResponse>
  getValue(key: string): Promise<string | undefined>
  setValue(key: string, value: string): Promise<void>
  deleteValue(key: string): Promise<void>
  /** true = 真实脚本管理器在场 (影响诊断文案)。 */
  managed: boolean
}

interface GmLike {
  getValue(key: string): Promise<string | undefined>
  setValue(key: string, value: string): Promise<void>
  deleteValue(key: string): Promise<void>
}

interface GmXhrDetails {
  method?: string
  url: string
  timeout?: number
  onload?: (r: { status: number; responseText: string }) => void
  onerror?: (e: unknown) => void
  ontimeout?: () => void
}

declare const GM: GmLike | undefined
declare const GM_xmlhttpRequest: ((d: GmXhrDetails) => unknown) | undefined

function gmXhr(url: string, timeoutMs: number): Promise<CrossOriginResponse> {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest === 'undefined') {
      // 降级: 普通浏览器无 GM — 同源 fetch (跨域受 CORS 约束, 失败交给诊断层)。
      fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        .then(async (r) => {
          const text = await r.text()
          if (!r.ok) throw new HttpError(r.status, url)
          resolve({ status: r.status, text })
        })
        .catch((e: unknown) => reject(normalizeNetError(e, url)))
      return
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: timeoutMs,
      onload: (r) => {
        if (r.status >= 200 && r.status < 300) resolve({ status: r.status, text: r.responseText })
        else reject(new HttpError(r.status, url))
      },
      onerror: () => reject(new Error(`network error: ${url}`)),
      ontimeout: () => reject(new Error(`timeout: ${url}`)),
    })
  })
}

function normalizeNetError(e: unknown, url: string): Error {
  if (e instanceof Error) return e
  return new Error(`network error: ${url}`)
}

/** localStorage 门面 (无 GM 时的降级 storage; 值恒为 string)。 */
const lsEnv = {
  async getValue(key: string): Promise<string | undefined> {
    return localStorage.getItem(key) ?? undefined
  },
  async setValue(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value)
  },
  async deleteValue(key: string): Promise<void> {
    localStorage.removeItem(key)
  },
}

export function detectGm(): GmEnv {
  if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
    return {
      crossOriginFetch: gmXhr,
      getValue: (k) => GM.getValue(k),
      setValue: (k, v) => GM.setValue(k, v),
      deleteValue: (k) => GM.deleteValue(k),
      managed: true,
    }
  }
  return { crossOriginFetch: gmXhr, ...lsEnv, managed: false }
}
