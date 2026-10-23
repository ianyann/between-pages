import type { WorkType } from '../db'
import { parseWorkUrl, type ParsedSource, type ParseResult, type Platform } from './parse'

/**
 * 元数据适配器：recognize(url) → fetchMetadata(parsed) → normalizeMetadata(raw)。
 * 只返回确实获得的字段；没有把握的字段一律留空，交给用户填写。
 *
 * 页间是部署在 GitHub Pages 上的纯静态网页，没有服务器。浏览器只能读取明确允许跨域（CORS）的接口：
 * - 起点、晋江、长佩、豆瓣：没有面向第三方网页的公开接口，作品页也不允许跨域读取 → 只识别链接，不自动获取。
 * - Goodreads：旧 API 已停止发放密钥，不使用；改为查询 Open Library（公开、允许跨域），
 *   只接受记录中带有同一个 Goodreads ID 的结果，不按标题相似度猜测。
 *   Open Library 没有封面时，用它给出的 ISBN 查询 Google Books，并核对 ISBN 一致才采用封面。
 * 不使用代理、抓取服务、登录模拟或任何绕过手段。
 */

export interface Metadata {
  title: string | null
  author: string | null
  category: WorkType | null
  coverUrl: string | null
  sourceUrl: string
  platform: Platform
  externalId: string
  provider: string | null // 实际提供数据的服务，例如 Open Library
  fields: ('title' | 'author' | 'category' | 'coverUrl')[] // 由提供方给出的字段
}

export type FetchOutcome =
  | { status: 'ok'; metadata: Metadata; notes: string[] }
  | { status: 'unsupported'; metadata: Metadata; reason: string } // 平台不提供可合规读取的接口
  | { status: 'not-found'; metadata: Metadata; reason: string }
  | { status: 'failed'; metadata: Metadata; reason: string } // 网络 / 跨域 / 超时 / 数据异常

export interface Adapter {
  platform: Platform
  /** 是否能在浏览器中合规地获取元数据。 */
  canFetch: boolean
  /** 不能获取时给用户的说明。 */
  limitation?: string
  fetchMetadata?(p: ParsedSource, signal: AbortSignal): Promise<unknown>
  normalizeMetadata(p: ParsedSource, raw: unknown): Omit<FetchOutcome, 'metadata'> & { metadata: Metadata }
}

const env = import.meta.env as Record<string, string | undefined>
export const OPEN_LIBRARY = env.VITE_OPENLIBRARY_URL || 'https://openlibrary.org'
export const OPEN_LIBRARY_COVERS = env.VITE_OPENLIBRARY_COVERS_URL || 'https://covers.openlibrary.org'
export const GOOGLE_BOOKS = env.VITE_GOOGLE_BOOKS_URL || 'https://www.googleapis.com'
const FETCH_TIMEOUT = 12_000
const MAX_JSON_BYTES = 2 * 1024 * 1024

/** 链接本身就能确定的类别。豆瓣桌面版影视链接不区分电影与电视剧，留空。 */
export function categoryFromLink(p: ParsedSource): WorkType | null {
  return p.kind === 'novel' ? 'novel' : p.kind === 'book' ? 'book' : p.kind === 'tv' ? 'tv' : null
}

function baseMetadata(p: ParsedSource): Metadata {
  const category = categoryFromLink(p)
  return { title: null, author: null, category, coverUrl: null, sourceUrl: p.canonicalUrl, platform: p.platform, externalId: p.externalId, provider: null, fields: [] }
}

const linkOnly = (platform: Platform, limitation: string): Adapter => ({
  platform,
  canFetch: false,
  limitation,
  normalizeMetadata: (p) => ({ status: 'unsupported', metadata: baseMetadata(p), reason: limitation }),
})

const DOUBAN_LIMIT = '豆瓣的公开 API 已停止对外提供，条目页也不允许其他网站在浏览器中读取，页间无法合规地自动获取标题、作者和封面。来源链接会保留，请手动补全信息。'
const CN_LIMIT = '没有面向第三方网页的公开接口，作品页也不允许其他网站在浏览器中读取，页间无法合规地自动获取标题、作者和封面。来源链接会保留，请手动补全信息。'

/** 只取需要的字段，并校验 Goodreads ID 精确一致。 */
type OpenLibraryDoc = { key?: string; title?: string; author_name?: string[]; cover_i?: number; isbn?: string[]; id_goodreads?: string[] }
type GoodreadsRaw = { docs: OpenLibraryDoc[]; google?: { isbn: string; thumbnail: string | null } | null; googleError?: string }

const goodreadsAdapter: Adapter = {
  platform: 'goodreads',
  canFetch: true,
  async fetchMetadata(p, signal) {
    const q = new URLSearchParams({ q: `id_goodreads:${p.externalId}`, fields: 'key,title,author_name,cover_i,isbn,id_goodreads', limit: '5' })
    const data = (await getJson(`${OPEN_LIBRARY}/search.json?${q}`, signal)) as { docs?: unknown }
    const docs = (Array.isArray(data?.docs) ? data.docs : []).filter(
      (d): d is OpenLibraryDoc => !!d && Array.isArray((d as OpenLibraryDoc).id_goodreads) && (d as OpenLibraryDoc).id_goodreads!.includes(p.externalId),
    )
    const raw: GoodreadsRaw = { docs }
    // Open Library 没有封面：用唯一匹配记录的 ISBN 查 Google Books，ISBN 必须一致
    const doc = docs.length === 1 ? docs[0] : null
    const isbn = doc && !doc.cover_i ? doc.isbn?.find((x) => /^(\d{13}|\d{9}[\dX])$/.test(x)) : undefined
    if (isbn) {
      try {
        raw.google = await googleBooksCover(isbn, signal)
      } catch (err) {
        raw.googleError = describeError(err)
      }
    }
    return raw
  },
  normalizeMetadata(p, raw) {
    const r = raw as GoodreadsRaw
    const metadata = baseMetadata(p)
    if (r.docs.length === 0) return { status: 'not-found', metadata, reason: 'Open Library 中没有找到带有这个 Goodreads 编号的图书记录。' }
    if (r.docs.length > 1) return { status: 'not-found', metadata, reason: 'Open Library 中有多条记录对应这个 Goodreads 编号，无法确定是哪一本，没有自动填入。' }
    const d = r.docs[0]
    const notes: string[] = []
    metadata.provider = 'Open Library'
    const title = typeof d.title === 'string' ? d.title.trim() : ''
    if (title) (metadata.title = title), metadata.fields.push('title')
    const authors = (d.author_name ?? []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    if (authors.length) (metadata.author = authors.join('、')), metadata.fields.push('author')
    if (typeof d.cover_i === 'number' && d.cover_i > 0) {
      metadata.coverUrl = `${OPEN_LIBRARY_COVERS}/b/id/${d.cover_i}-L.jpg?default=false`
      metadata.fields.push('coverUrl')
    } else if (r.google?.thumbnail) {
      metadata.coverUrl = r.google.thumbnail
      metadata.fields.push('coverUrl')
      notes.push(`封面来自 Google Books（ISBN ${r.google.isbn} 已核对一致）。`)
    } else {
      notes.push(r.googleError ? `没有找到封面（Google Books 查询失败：${r.googleError}）。` : '没有找到封面。')
    }
    return { status: 'ok', metadata, notes }
  },
}

async function googleBooksCover(isbn: string, signal: AbortSignal): Promise<{ isbn: string; thumbnail: string | null } | null> {
  const data = (await getJson(`${GOOGLE_BOOKS}/books/v1/volumes?q=isbn:${isbn}&maxResults=3`, signal)) as { items?: unknown[] }
  type Item = { volumeInfo?: { industryIdentifiers?: { identifier?: string }[]; imageLinks?: { thumbnail?: string } } }
  const item = (data?.items ?? []).find((it) => (it as Item)?.volumeInfo?.industryIdentifiers?.some((x) => x?.identifier === isbn)) as Item | undefined
  if (!item) return null
  const thumb = item.volumeInfo?.imageLinks?.thumbnail
  // Google 的图片地址常为 http，升级为 https
  return { isbn, thumbnail: typeof thumb === 'string' ? thumb.replace(/^http:\/\/(books\.google\.com|[a-z0-9.-]+\.googleusercontent\.com)\//, 'https://$1/') : null }
}

export const ADAPTERS: Record<Platform, Adapter> = {
  qidian: linkOnly('qidian', `起点中文网${CN_LIMIT}`),
  jjwxc: linkOnly('jjwxc', `晋江文学城${CN_LIMIT}`),
  gongzicp: linkOnly('gongzicp', `长佩文学${CN_LIMIT}`),
  'douban-book': linkOnly('douban-book', DOUBAN_LIMIT),
  'douban-movie': linkOnly('douban-movie', DOUBAN_LIMIT),
  goodreads: goodreadsAdapter,
}

/** recognize：识别链接并找到对应的适配器。 */
export function recognize(url: string): ParseResult {
  return parseWorkUrl(url)
}

/** 获取并规范化元数据。任何失败都返回 status，而不是抛出，保证可以继续手动创建。 */
export async function fetchMetadata(p: ParsedSource, signal: AbortSignal): Promise<FetchOutcome> {
  const adapter = ADAPTERS[p.platform]
  if (!adapter.canFetch || !adapter.fetchMetadata) return adapter.normalizeMetadata(p, null) as FetchOutcome
  try {
    const raw = await adapter.fetchMetadata(p, signal)
    return adapter.normalizeMetadata(p, raw) as FetchOutcome
  } catch (err) {
    return { status: 'failed', metadata: baseMetadata(p), reason: describeError(err) }
  }
}

export function describeError(err: unknown): string {
  const e = err as Error
  if (e?.name === 'AbortError') return '请求超时或已取消'
  if (e?.name === 'TypeError') return '请求被浏览器拦截或网络不可用（可能是跨域限制或离线）'
  return e?.message || String(err)
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await timedFetch(url, signal, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`服务返回 ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_JSON_BYTES) throw new Error('返回数据过大')
  const text = await res.text()
  if (text.length > MAX_JSON_BYTES) throw new Error('返回数据过大')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回的不是有效数据')
  }
}

/** 不带 Cookie、不带来源页地址；超时或外部取消都会中止。 */
export async function timedFetch(url: string, outer: AbortSignal, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController()
  const abort = () => ctl.abort()
  outer.addEventListener('abort', abort)
  const timer = setTimeout(abort, FETCH_TIMEOUT)
  try {
    return await fetch(url, { ...init, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal })
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', abort)
  }
}

const MAX_COVER_BYTES = 10 * 1024 * 1024
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** 下载封面为文件。只接受图片类型、限制大小；失败时抛出说明（调用方不应让它阻止创建作品）。 */
export async function downloadCover(url: string, signal: AbortSignal): Promise<File> {
  const res = await timedFetch(url, signal)
  if (!res.ok) throw new Error(`封面服务返回 ${res.status}`)
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!COVER_TYPES.includes(type)) throw new Error('封面地址返回的不是图片')
  if (Number(res.headers.get('content-length') || 0) > MAX_COVER_BYTES) throw new Error('封面图片过大')
  const blob = await res.blob()
  if (blob.size > MAX_COVER_BYTES) throw new Error('封面图片过大')
  if (blob.size < 100) throw new Error('封面图片无效')
  return new File([blob], `cover.${type.split('/')[1]}`, { type })
}
