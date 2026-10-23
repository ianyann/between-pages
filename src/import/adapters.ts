import type { WorkType } from '../db'
import { extractHtmlMeta, FetchFailure, readable, readHtml, type FailureKind, type HtmlMeta } from './net'
import { parseWorkUrl, type ParsedSource, type ParseResult, type Platform } from './parse'

/**
 * 元数据适配器：recognize(url) → fetchMetadata(parsed) → normalizeMetadata(raw)。
 * 只返回确实获得的字段；没有把握的字段一律留空，交给用户填写。
 *
 * 页间部署在 GitHub Pages（纯静态，无服务器），所有请求都在用户的浏览器中直接发出：
 * - Goodreads：不请求 goodreads.com；用 Goodreads 编号查询 Open Library（公开接口，允许跨域），
 *   只接受记录中带有同一个编号的结果。Open Library 无封面时，按 ISBN 核对后用 Google Books 的封面。
 * - 起点、晋江、长佩、豆瓣：直接请求作品页（不带 Cookie），只有在浏览器允许读取时才解析其中的
 *   Open Graph / JSON-LD / 微数据。被跨域限制、超时、403、429 或跳转到验证页时，如实说明原因。
 * 不使用代理、抓取服务、登录模拟、验证码绕过或任何反爬绕过手段。
 */

export interface Metadata {
  title: string | null
  author: string | null
  category: WorkType | null
  coverUrl: string | null
  isbn: string | null
  sourceUrl: string
  platform: Platform
  externalId: string
  provider: string | null // 实际提供数据的来源，例如 Open Library、豆瓣作品页
  fields: ('title' | 'author' | 'category' | 'coverUrl' | 'isbn')[] // 由提供方给出的字段
}

export type FetchOutcome =
  | { status: 'ok'; metadata: Metadata; notes: string[] }
  | { status: 'not-found'; metadata: Metadata; reason: string } // 请求成功，但没有可用的作品信息
  | { status: 'failed'; metadata: Metadata; reason: string; failure: FailureKind | 'other' } // 请求本身失败

export interface Adapter {
  platform: Platform
  /** 实际请求的地址（用于说明与诊断）。 */
  requestUrl(p: ParsedSource): string
  fetchMetadata(p: ParsedSource, signal: AbortSignal): Promise<unknown>
  normalizeMetadata(p: ParsedSource, raw: unknown): FetchOutcome
}

const env = import.meta.env as Record<string, string | undefined>
export const OPEN_LIBRARY = env.VITE_OPENLIBRARY_URL || 'https://openlibrary.org'
export const OPEN_LIBRARY_COVERS = env.VITE_OPENLIBRARY_COVERS_URL || 'https://covers.openlibrary.org'
export const GOOGLE_BOOKS = env.VITE_GOOGLE_BOOKS_URL || 'https://www.googleapis.com'
const MAX_JSON_BYTES = 2 * 1024 * 1024

/** 链接本身就能确定的类别。豆瓣桌面版影视链接不区分电影与电视剧，留空。 */
export function categoryFromLink(p: ParsedSource): WorkType | null {
  return p.kind === 'novel' ? 'novel' : p.kind === 'book' ? 'book' : p.kind === 'tv' ? 'tv' : null
}

export function baseMetadata(p: ParsedSource): Metadata {
  return { title: null, author: null, category: categoryFromLink(p), coverUrl: null, isbn: null, sourceUrl: p.canonicalUrl, platform: p.platform, externalId: p.externalId, provider: null, fields: [] }
}

// —— 作品页适配器（起点、晋江、长佩、豆瓣）——

type PageRaw = { html: string; finalUrl: string }

/** 各平台允许的最终地址（防止被跳转到验证页或其他站点后仍当作作品页解析）。 */
const PAGE_HOSTS: Record<Exclude<Platform, 'goodreads'>, string[]> = {
  qidian: ['www.qidian.com', 'book.qidian.com', 'm.qidian.com'],
  jjwxc: ['www.jjwxc.net', 'jjwxc.net', 'my.jjwxc.net', 'm.jjwxc.net'],
  gongzicp: ['www.gongzicp.com', 'gongzicp.com', 'm.gongzicp.com'],
  'douban-book': ['book.douban.com', 'm.douban.com'],
  'douban-movie': ['movie.douban.com', 'm.douban.com'],
}

function pageAdapter(platform: Exclude<Platform, 'goodreads'>, label: string, parse: (p: ParsedSource, page: ParsedPage, m: Metadata) => string | null): Adapter {
  return {
    platform,
    requestUrl: (p) => p.canonicalUrl,
    async fetchMetadata(p, signal) {
      const res = await readable(p.canonicalUrl, signal, { headers: { Accept: 'text/html' } })
      const finalUrl = res.url
      // 开发测试时请求被改写到本地模拟服务，不检查主机
      if (!(import.meta.env.DEV && env.VITE_IMPORT_MOCK_ORIGIN)) {
        const host = new URL(finalUrl).hostname
        if (!PAGE_HOSTS[platform].includes(host)) throw new FetchFailure('forbidden', `请求被跳转到 ${host}（可能是登录或验证页面），页间不会绕过验证`)
      }
      return { html: await readHtml(res), finalUrl } satisfies PageRaw
    },
    normalizeMetadata(p, raw) {
      const { html } = raw as PageRaw
      const metadata = baseMetadata(p)
      const page = parsePage(html)
      // 页面中必须出现这个作品编号，避免把首页、验证页或别的作品当成结果
      if (!html.includes(p.externalId))
        return { status: 'not-found', metadata, reason: `${label}返回的页面中没有这个作品的编号（可能是验证页、首页或错误页）。` }
      metadata.provider = `${label}作品页`
      const problem = parse(p, page, metadata)
      if (problem) return { status: 'not-found', metadata: baseMetadata(p), reason: problem }
      if (!metadata.title)
        return {
          status: 'not-found',
          metadata: baseMetadata(p),
          reason: page.meta.textLength < 200 ? `${label}返回的只是页面框架，作品信息由脚本动态加载，网页无法直接读取。` : `${label}作品页中没有找到可识别的标题信息。`,
        }
      return { status: 'ok', metadata, notes: [] }
    },
  }
}

interface ParsedPage {
  doc: Document
  meta: HtmlMeta
  ld: Record<string, unknown>[] // 展开 @graph 后的 JSON-LD 对象
}

function parsePage(html: string): ParsedPage {
  const meta = extractHtmlMeta(html)
  const ld: Record<string, unknown>[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') {
      ld.push(x as Record<string, unknown>)
      if (Array.isArray((x as { '@graph'?: unknown })['@graph'])) walk((x as { '@graph': unknown[] })['@graph'])
    }
  }
  meta.jsonLd.forEach(walk)
  return { doc: new DOMParser().parseFromString(html, 'text/html'), meta, ld }
}

const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null)
const names = (x: unknown): string | null => {
  const list = (Array.isArray(x) ? x : [x]).map((a) => (typeof a === 'string' ? str(a) : str((a as { name?: unknown })?.name))).filter(Boolean) as string[]
  return list.length ? [...new Set(list)].join('、') : null
}
const ldOfType = (page: ParsedPage, types: string[]) =>
  page.ld.find((o) => (Array.isArray(o['@type']) ? (o['@type'] as string[]) : [o['@type']]).some((t) => types.includes(String(t))))
const itemprop = (page: ParsedPage, name: string) => {
  const el = page.doc.querySelector(`[itemprop="${name}"]`)
  return el ? str(el.getAttribute('content') ?? el.getAttribute('src') ?? el.textContent) : null
}
/** 只接受 http(s) 地址的图片，统一为 https。 */
const imageUrl = (x: string | null, base: string) => {
  if (!x) return null
  try {
    const u = new URL(x, base)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href.replace(/^http:/, 'https:') : null
  } catch {
    return null
  }
}

function setField(m: Metadata, key: 'title' | 'author' | 'coverUrl' | 'isbn', value: string | null) {
  if (!value) return
  m[key] = value
  m.fields.push(key)
}

/** 网络小说站点常用 og:novel:* 标签；其次 JSON-LD、微数据。 */
function parseNovelPage(p: ParsedSource, page: ParsedPage, m: Metadata): string | null {
  const og = page.meta.og
  const book = ldOfType(page, ['Book', 'CreativeWork', 'Article'])
  setField(m, 'title', str(og['novel:book_name']) ?? str(book?.name) ?? itemprop(page, 'articleSection') ?? itemprop(page, 'name'))
  setField(m, 'author', str(og['novel:author']) ?? names(book?.author) ?? itemprop(page, 'author'))
  setField(m, 'coverUrl', imageUrl(str(og.image) ?? str(book?.image) ?? itemprop(page, 'image'), p.canonicalUrl))
  return null
}

function parseDoubanBook(p: ParsedSource, page: ParsedPage, m: Metadata): string | null {
  const book = ldOfType(page, ['Book'])
  if (!book) return '豆瓣返回的页面中没有图书数据（可能是登录或验证页面）。'
  const url = str(book.url)
  if (url && !url.includes(`/subject/${p.externalId}`)) return '豆瓣返回的图书数据与链接中的编号不一致，没有采用。'
  setField(m, 'title', str(book.name))
  setField(m, 'author', names(book.author))
  setField(m, 'isbn', str(book.isbn))
  setField(m, 'coverUrl', imageUrl(str(page.meta.og.image), p.canonicalUrl))
  return null
}

function parseDoubanMovie(p: ParsedSource, page: ParsedPage, m: Metadata): string | null {
  const movie = ldOfType(page, ['Movie', 'TVSeries'])
  if (!movie) return '豆瓣返回的页面中没有影视数据（可能是登录或验证页面）。'
  const url = str(movie.url)
  if (url && !url.includes(`/subject/${p.externalId}`)) return '豆瓣返回的影视数据与链接中的编号不一致，没有采用。'
  setField(m, 'title', str(movie.name))
  m.category = String(movie['@type']) === 'TVSeries' ? 'tv' : 'film'
  m.fields.push('category')
  setField(m, 'coverUrl', imageUrl(str(page.meta.og.image) ?? str(movie.image), p.canonicalUrl))
  return null
}

// —— Goodreads（经 Open Library）——

type OpenLibraryDoc = { key?: string; title?: string; author_name?: string[]; cover_i?: number; isbn?: string[]; id_goodreads?: string[] }
type GoodreadsRaw = { docs: OpenLibraryDoc[]; google?: { isbn: string; thumbnail: string | null } | null; googleError?: string }

const goodreadsAdapter: Adapter = {
  platform: 'goodreads',
  requestUrl: (p) => `${OPEN_LIBRARY}/search.json?q=id_goodreads:${p.externalId}`,
  async fetchMetadata(p, signal) {
    const q = new URLSearchParams({ q: `id_goodreads:${p.externalId}`, fields: 'key,title,author_name,cover_i,isbn,id_goodreads', limit: '5' })
    const data = (await getJson(`${OPEN_LIBRARY}/search.json?${q}`, signal)) as { docs?: unknown }
    const docs = (Array.isArray(data?.docs) ? data.docs : []).filter(
      (d): d is OpenLibraryDoc => !!d && Array.isArray((d as OpenLibraryDoc).id_goodreads) && (d as OpenLibraryDoc).id_goodreads!.includes(p.externalId),
    )
    const raw: GoodreadsRaw = { docs }
    const doc = docs.length === 1 ? docs[0] : null
    const isbn = doc && !doc.cover_i ? doc.isbn?.find((x) => /^(\d{13}|\d{9}[\dX])$/.test(x)) : undefined
    if (isbn) {
      try {
        raw.google = await googleBooksCover(isbn, signal)
      } catch (err) {
        raw.googleError = (err as Error).message
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
    setField(metadata, 'title', str(d.title))
    setField(metadata, 'author', names((d.author_name ?? []).filter((x) => typeof x === 'string')))
    if (typeof d.cover_i === 'number' && d.cover_i > 0) setField(metadata, 'coverUrl', `${OPEN_LIBRARY_COVERS}/b/id/${d.cover_i}-L.jpg?default=false`)
    else if (r.google?.thumbnail) {
      setField(metadata, 'coverUrl', r.google.thumbnail)
      notes.push(`封面来自 Google Books（ISBN ${r.google.isbn} 已核对一致）。`)
    } else notes.push(r.googleError ? `没有找到封面（Google Books 查询失败：${r.googleError}）。` : '没有找到封面。')
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
  qidian: pageAdapter('qidian', '起点', parseNovelPage),
  jjwxc: pageAdapter('jjwxc', '晋江', parseNovelPage),
  gongzicp: pageAdapter('gongzicp', '长佩', parseNovelPage),
  'douban-book': pageAdapter('douban-book', '豆瓣', parseDoubanBook),
  'douban-movie': pageAdapter('douban-movie', '豆瓣', parseDoubanMovie),
  goodreads: goodreadsAdapter,
}

/** recognize：识别链接。 */
export function recognize(url: string): ParseResult {
  return parseWorkUrl(url)
}

/** 获取并规范化元数据。任何失败都返回 status，而不是抛出，保证可以继续手动创建。 */
export async function fetchMetadata(p: ParsedSource, signal: AbortSignal): Promise<FetchOutcome> {
  const adapter = ADAPTERS[p.platform]
  let raw: unknown
  try {
    raw = await adapter.fetchMetadata(p, signal)
  } catch (err) {
    const f = err instanceof FetchFailure ? err : null
    return { status: 'failed', metadata: baseMetadata(p), reason: describeError(err), failure: f?.kind ?? 'other' }
  }
  try {
    return adapter.normalizeMetadata(p, raw)
  } catch (err) {
    // 请求成功但解析出错：与网络失败区分
    return { status: 'not-found', metadata: baseMetadata(p), reason: `页面已取得，但解析时出错：${(err as Error).message}` }
  }
}

export function describeError(err: unknown): string {
  const e = err as Error
  if (err instanceof FetchFailure) return e.message
  if (e?.name === 'AbortError') return '请求超时或已取消'
  if (e?.name === 'TypeError') return '请求被浏览器拦截或网络不可用（可能是跨域限制或离线）'
  return e?.message || String(err)
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await readable(url, signal, { headers: { Accept: 'application/json' } })
  if (Number(res.headers.get('content-length') || 0) > MAX_JSON_BYTES) throw new FetchFailure('too-large', '返回数据过大')
  const text = await res.text()
  if (text.length > MAX_JSON_BYTES) throw new FetchFailure('too-large', '返回数据过大')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回的不是有效数据')
  }
}

const MAX_COVER_BYTES = 10 * 1024 * 1024

/** 按文件内容（而不是声明的类型）判断图片格式。 */
export function sniffImage(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

/** 下载封面为文件：检查实际图片格式与大小；失败时抛出说明（调用方不应让它阻止创建作品）。 */
export async function downloadCover(url: string, signal: AbortSignal): Promise<File> {
  const u = new URL(url)
  if (u.protocol !== 'https:' && !(import.meta.env.DEV && u.hostname === '127.0.0.1')) throw new Error('封面地址不是 https')
  let res: Response
  try {
    res = await readable(url, signal)
  } catch (err) {
    throw err instanceof FetchFailure && err.kind === 'cors-blocked' ? new Error('图片服务器不允许其他网站读取这张图片') : err
  }
  if (Number(res.headers.get('content-length') || 0) > MAX_COVER_BYTES) throw new Error('封面图片过大')
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_COVER_BYTES) throw new Error('封面图片过大')
  const type = sniffImage(buf)
  if (!type) throw new Error('封面地址返回的不是图片')
  return new File([buf], `cover.${type.split('/')[1]}`, { type })
}
