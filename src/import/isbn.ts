import { readable } from './net'

/**
 * ISBN 辅助补全：用 ISBN 查询允许跨域读取的公开书目接口（Open Library、Google Books），
 * 只采用返回记录中确实含有同一个 ISBN 的结果。
 */

const env = import.meta.env as Record<string, string | undefined>
const OPEN_LIBRARY = env.VITE_OPENLIBRARY_URL || 'https://openlibrary.org'
const OPEN_LIBRARY_COVERS = env.VITE_OPENLIBRARY_COVERS_URL || 'https://covers.openlibrary.org'
const GOOGLE_BOOKS = env.VITE_GOOGLE_BOOKS_URL || 'https://www.googleapis.com'

/** 去掉连字符与空格，校验 ISBN-10 / ISBN-13 校验位，统一为 ISBN-13。不合法时返回 null。 */
export function normalizeIsbn(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').toUpperCase()
  if (/^\d{13}$/.test(s)) {
    const sum = [...s.slice(0, 12)].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0)
    return (10 - (sum % 10)) % 10 === Number(s[12]) && /^97[89]/.test(s) ? s : null
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((t, d, i) => t + (d === 'X' ? 10 : Number(d)) * (10 - i), 0)
    if (sum % 11) return null
    const body = '978' + s.slice(0, 9)
    const c = [...body].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0)
    return body + ((10 - (c % 10)) % 10)
  }
  return null
}

const isbn10Of = (isbn13: string) => {
  if (!isbn13.startsWith('978')) return null
  const body = isbn13.slice(3, 12)
  const c = (11 - ([...body].reduce((t, d, i) => t + Number(d) * (10 - i), 0) % 11)) % 11
  return body + (c === 10 ? 'X' : String(c))
}

export interface IsbnResult {
  isbn: string
  title: string | null
  author: string | null
  coverUrl: string | null
  provider: string | null
  /** 每个服务的查询结果，便于向用户说明。 */
  attempts: { provider: string; result: string }[]
}

export async function lookupIsbn(isbn: string, signal: AbortSignal): Promise<IsbnResult> {
  const out: IsbnResult = { isbn, title: null, author: null, coverUrl: null, provider: null, attempts: [] }
  const ids = new Set([isbn, isbn10Of(isbn)].filter(Boolean) as string[])

  // Open Library Books API
  try {
    const key = `ISBN:${isbn}`
    const res = await readable(`${OPEN_LIBRARY}/api/books?bibkeys=${key}&format=json&jscmd=data`, signal, { headers: { Accept: 'application/json' } })
    const data = (await res.json()) as Record<string, { title?: string; authors?: { name?: string }[]; cover?: { large?: string; medium?: string }; identifiers?: Record<string, string[]> }>
    const rec = data?.[key]
    const recIds = [...(rec?.identifiers?.isbn_13 ?? []), ...(rec?.identifiers?.isbn_10 ?? [])]
    if (rec && recIds.some((x) => ids.has(x)) && rec.title) {
      out.title = rec.title.trim()
      const names = (rec.authors ?? []).map((a) => a?.name?.trim()).filter(Boolean)
      if (names.length) out.author = names.join('、')
      if (rec.cover?.large || rec.cover?.medium) out.coverUrl = `${OPEN_LIBRARY_COVERS}/b/isbn/${isbn}-L.jpg?default=false`
      out.provider = 'Open Library'
      out.attempts.push({ provider: 'Open Library', result: '找到，ISBN 已核对' })
    } else out.attempts.push({ provider: 'Open Library', result: rec ? '记录的 ISBN 不一致，未采用' : '没有这个 ISBN 的记录' })
  } catch (err) {
    out.attempts.push({ provider: 'Open Library', result: (err as Error).message })
  }

  // Google Books：补充 Open Library 没有的标题 / 作者 / 封面
  if (!out.title || !out.author || !out.coverUrl) {
    try {
      const res = await readable(`${GOOGLE_BOOKS}/books/v1/volumes?q=isbn:${isbn}&maxResults=3`, signal, { headers: { Accept: 'application/json' } })
      type Item = { volumeInfo?: { title?: string; authors?: string[]; industryIdentifiers?: { identifier?: string }[]; imageLinks?: { thumbnail?: string } } }
      const data = (await res.json()) as { items?: Item[] }
      const item = (data?.items ?? []).find((it) => it?.volumeInfo?.industryIdentifiers?.some((x) => ids.has(x?.identifier ?? '')))
      const v = item?.volumeInfo
      if (v?.title) {
        const used: string[] = []
        if (!out.title) (out.title = v.title.trim()), used.push('标题')
        if (!out.author && v.authors?.length) (out.author = v.authors.join('、')), used.push('作者')
        const thumb = v.imageLinks?.thumbnail
        if (!out.coverUrl && typeof thumb === 'string') {
          out.coverUrl = thumb.replace(/^http:\/\/(books\.google\.com|[a-z0-9.-]+\.googleusercontent\.com)\//, 'https://$1/')
          used.push('封面')
        }
        if (used.length || !out.provider) out.provider = out.provider ? `${out.provider} + Google Books` : 'Google Books'
        out.attempts.push({ provider: 'Google Books', result: used.length ? `找到，ISBN 已核对，补充${used.join('、')}` : '找到，ISBN 已核对' })
      } else out.attempts.push({ provider: 'Google Books', result: '没有这个 ISBN 的记录' })
    } catch (err) {
      out.attempts.push({ provider: 'Google Books', result: (err as Error).message })
    }
  }
  return out
}
