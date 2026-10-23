/**
 * 浏览器内的网络请求与失败分类。页间部署在 GitHub Pages（纯静态，无服务器），所有请求都由用户的浏览器直接发出。
 *
 * 分类方法：先用普通跨域请求（cors）读取；若浏览器直接拒绝（TypeError），再发一次 no-cors 请求：
 * - no-cors 成功（得到不可读的 opaque 响应）→ 服务器可以访问，但它没有允许其他网站读取（CORS 限制）；
 * - no-cors 也失败 → 网络不可达、被拦截或离线。
 * no-cors 响应的内容浏览器不会交给页面，这只用来判断原因，不能也不用来读取数据。
 * 两种请求都不带 Cookie、不带来源页地址。
 */

export type FailureKind = 'timeout' | 'cors-blocked' | 'unreachable' | 'http-error' | 'rate-limited' | 'forbidden' | 'too-large' | 'not-html'

export class FetchFailure extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
    public status?: number,
  ) {
    super(message)
  }
}

const env = import.meta.env as Record<string, string | undefined>
export const FETCH_TIMEOUT = Number(env.VITE_IMPORT_TIMEOUT) || 12_000

/**
 * 仅开发测试用：把平台页面请求改写到本地模拟服务。生产构建中 import.meta.env.DEV 为 false，此分支被移除。
 */
export function requestUrl(url: string): string {
  if (import.meta.env.DEV && env.VITE_IMPORT_MOCK_ORIGIN) {
    const u = new URL(url)
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && !/openlibrary\.org$|googleapis\.com$/.test(u.hostname))
      return `${env.VITE_IMPORT_MOCK_ORIGIN}/page/${u.hostname}${u.pathname}${u.search}`
  }
  return url
}

/** 不带 Cookie、不带来源页地址；超时或外部取消都会中止。 */
export async function timedFetch(url: string, outer: AbortSignal, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController()
  const abort = () => ctl.abort()
  outer.addEventListener('abort', abort)
  const timer = setTimeout(abort, FETCH_TIMEOUT)
  try {
    return await fetch(requestUrl(url), { mode: 'cors', ...init, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal: ctl.signal })
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', abort)
  }
}

/** 请求并分类失败原因。成功时返回可读的响应（状态码 2xx）。 */
export async function readable(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await timedFetch(url, signal, init)
  } catch (err) {
    throw await classify(err, url, signal)
  }
  if (res.ok) return res
  if (res.status === 429) throw new FetchFailure('rate-limited', '请求过于频繁，服务暂时拒绝（429），请稍后再试', 429)
  if (res.status === 403 || res.status === 401) throw new FetchFailure('forbidden', `服务拒绝访问（${res.status}），可能需要登录或触发了访问保护`, res.status)
  throw new FetchFailure('http-error', `服务返回 ${res.status}`, res.status)
}

async function classify(err: unknown, url: string, signal: AbortSignal): Promise<FetchFailure> {
  if (err instanceof FetchFailure) return err
  const e = err as Error
  if (e?.name === 'AbortError') return new FetchFailure('timeout', signal.aborted ? '已取消' : `请求超时（${FETCH_TIMEOUT / 1000} 秒内没有响应）`)
  if (signal.aborted) return new FetchFailure('timeout', '已取消')
  try {
    await timedFetch(url, signal, { mode: 'no-cors' })
    return new FetchFailure('cors-blocked', '服务器有响应，但不允许其他网站在浏览器中读取（跨域 CORS 限制）')
  } catch (e2) {
    if ((e2 as Error)?.name === 'AbortError') return new FetchFailure('timeout', `请求超时（${FETCH_TIMEOUT / 1000} 秒内没有响应）`)
    return new FetchFailure('unreachable', '无法连接（网络不可用、被拦截或离线）')
  }
}

const MAX_HTML_BYTES = 3 * 1024 * 1024

/** 读取 HTML 并按正确编码解码（晋江等站点使用 GB18030 / GBK）。 */
export async function readHtml(res: Response): Promise<string> {
  const type = (res.headers.get('content-type') || '').toLowerCase()
  if (type && !type.includes('html')) throw new FetchFailure('not-html', '返回的不是网页')
  if (Number(res.headers.get('content-length') || 0) > MAX_HTML_BYTES) throw new FetchFailure('too-large', '网页过大')
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_HTML_BYTES) throw new FetchFailure('too-large', '网页过大')
  return decodeHtml(buf, type)
}

export function decodeHtml(buf: ArrayBuffer, contentType = ''): string {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1]
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4096))
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  }
  const label = (charset || 'utf-8').toLowerCase()
  const normalized = ['gb2312', 'gbk', 'x-gbk'].includes(label) ? 'gb18030' : label
  try {
    return new TextDecoder(normalized).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** 网页中可用的结构化信息：标题、Open Graph、JSON-LD。只解析，不执行任何脚本。 */
export interface HtmlMeta {
  title: string | null
  og: Record<string, string>
  meta: Record<string, string>
  jsonLd: unknown[]
  textLength: number // 正文文字量，用于判断是否只有页面框架（内容由脚本动态加载）
}

export function extractHtmlMeta(html: string): HtmlMeta {
  const doc = new DOMParser().parseFromString(html, 'text/html') // DOMParser 不执行脚本
  const og: Record<string, string> = {}
  const meta: Record<string, string> = {}
  doc.querySelectorAll('meta').forEach((m) => {
    const content = m.getAttribute('content')
    if (content == null) return
    const prop = m.getAttribute('property')
    const name = m.getAttribute('name')
    if (prop?.startsWith('og:')) og[prop.slice(3)] = content.trim()
    else if (name) meta[name.toLowerCase()] = content.trim()
  })
  const jsonLd: unknown[] = []
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      jsonLd.push(JSON.parse(s.textContent || ''))
    } catch {
      // 一些站点的 JSON-LD 含非法字符，忽略
    }
  })
  doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove())
  return {
    title: doc.querySelector('title')?.textContent?.trim() || null,
    og,
    meta,
    jsonLd,
    textLength: (doc.body?.textContent || '').replace(/\s+/g, '').length,
  }
}
