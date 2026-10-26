// host.ts — 宿主服务抽象 (storage get/set/delete + 跨域 GET) 与运行时探测。
// 契约: 上层 (rules.ts/controller.ts) 只依赖 HostEnv 接口, 不感知宿主细节;
// 三实现按探测顺序择一 (顺序 = 优先级):
//   ① userscript: GM.*/GM_xmlhttpRequest (Tampermonkey 等脚本管理器);
//   ② chrome 扩展: chrome.storage.local + fetch — raw.githubusercontent.com 响应
//      ACAO:* (已验证), content script 直接 fetch 即可, 无需 host_permissions;
//   ③ 裸浏览器降级: localStorage + 同源 fetch (真跨域被 CORS 拒 → 诊断层提示装宿主)。
// GM 优先于 chrome: Tampermonkey 沙箱内 chrome.storage 指向 TM 自身的存储而非我们的,
// GM 在场时必须走 GM。kind 字段 (宿主形态) 供诊断文案分派 (CSP/跨域失败的降级指引)。

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

/** 宿主形态 — 诊断文案分派依据 (CSP 失败降级 / 跨域失败提示)。 */
export type HostKind = 'userscript' | 'extension' | 'bare'

export interface HostEnv {
  /** 跨域 GET (规则 bundle 专用); 非 2xx 抛 HttpError, 网络失败抛 Error。 */
  crossOriginFetch(url: string, timeoutMs: number): Promise<CrossOriginResponse>
  getValue(key: string): Promise<string | undefined>
  setValue(key: string, value: string): Promise<void>
  deleteValue(key: string): Promise<void>
  /** 宿主形态 (诊断文案分派); 'bare' = 无宿主 (localStorage 降级, 跨域受 CORS 限)。 */
  kind: HostKind
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

/** chrome.storage 最小消费面 (仅本仓用到的 API — 全量 @types/chrome 不引入, 零依赖纪律)。 */
interface StorageArea {
  get(keys: string): Promise<Record<string, string>>
  set(items: Record<string, string>): Promise<void>
  remove(keys: string): Promise<void>
}

declare const chrome: { storage?: { local?: StorageArea } } | undefined

/** 普通 fetch GET (chrome 宿主与无宿主降级共用; 受页面 CORS 约束)。 */
async function fetchGet(url: string, timeoutMs: number): Promise<CrossOriginResponse> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await r.text()
    if (!r.ok) throw new HttpError(r.status, url)
    return { status: r.status, text }
  } catch (e) {
    throw e instanceof Error ? e : new Error(`network error: ${url}`)
  }
}

function gmXhr(url: string, timeoutMs: number): Promise<CrossOriginResponse> {
  if (typeof GM_xmlhttpRequest === 'undefined') return fetchGet(url, timeoutMs) // 不可达于 GM 宿主, 类型完备用
  return new Promise((resolve, reject) => {
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

/** 扩展宿主在场判定: 页面世界的 window.chrome 无 storage 绑定, storage.local 在场才认。 */
function chromeLocalStorage(): StorageArea | null {
  if (typeof chrome === 'undefined') return null
  return chrome.storage?.local ?? null
}

/** localStorage 门面 (无宿主时的降级 storage; 值恒为 string)。 */
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

/** 运行时宿主探测: GM → chrome.storage → localStorage 降级。 */
export function detectHost(): HostEnv {
  if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
    return {
      crossOriginFetch: gmXhr,
      getValue: (k) => GM.getValue(k),
      setValue: (k, v) => GM.setValue(k, v),
      deleteValue: (k) => GM.deleteValue(k),
      kind: 'userscript',
    }
  }
  const area = chromeLocalStorage()
  if (area) {
    return {
      crossOriginFetch: fetchGet,
      getValue: async (k) => (await area.get(k))[k],
      setValue: (k, v) => area.set({ [k]: v }),
      deleteValue: (k) => area.remove(k),
      kind: 'extension',
    }
  }
  return { crossOriginFetch: fetchGet, ...lsEnv, kind: 'bare' }
}
