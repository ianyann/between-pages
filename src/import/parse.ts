/**
 * 作品链接识别：只用 URL 对象解析（协议、主机名、路径、查询参数），不靠字符串包含判断平台。
 * 域名匹配只是第一步；路径必须符合该平台作品页（或可定位到作品的章节页）的格式，并能取出作品 ID。
 * 识别结果给出规范化链接：统一为 https、桌面版域名，去掉所有无关查询参数。
 */

export type Platform = 'qidian' | 'jjwxc' | 'gongzicp' | 'douban-book' | 'douban-movie' | 'goodreads'

/** 链接能确定的作品种类：novel 网络小说；book 图书；screen 电影或电视剧（豆瓣桌面链接无法区分）；tv 电视剧。 */
export type SourceKind = 'novel' | 'book' | 'screen' | 'tv'

export interface ParsedSource {
  platform: Platform
  kind: SourceKind
  externalId: string
  canonicalUrl: string
  note?: string // 例如「已从章节链接定位到作品」
}

export type ParseResult =
  | { ok: true; source: ParsedSource }
  | { ok: false; reason: 'empty' | 'invalid' | 'unsupported-site' | 'not-work-page'; message: string; platform?: Platform }

export const PLATFORM_LABELS: Record<Platform, string> = {
  qidian: '起点中文网',
  jjwxc: '晋江文学城',
  gongzicp: '长佩文学',
  'douban-book': '豆瓣读书',
  'douban-movie': '豆瓣电影',
  goodreads: 'Goodreads',
}

export const sourceKey = (s: { platform: Platform; externalId: string }) => `${s.platform}:${s.externalId}`

type Fail = Extract<ParseResult, { ok: false }>
const notWork = (platform: Platform, message: string): Fail => ({ ok: false, reason: 'not-work-page', platform, message })
const found = (source: ParsedSource): ParseResult => ({ ok: true, source })

const ID = /^\d{1,20}$/
/** 路径按 / 拆分，去掉空段。 */
const segs = (u: URL) => u.pathname.split('/').filter(Boolean)

/** 主机名属于 domain 本身或其子域。hostname 已由 URL 对象转为小写并做过 IDNA 处理。 */
const under = (host: string, domain: string) => host === domain || host.endsWith('.' + domain)

// —— 起点中文网 ——
// www.qidian.com/book/<id>/ · book.qidian.com/info/<id> · m.qidian.com/book/<id>(.html)
// 章节：www.qidian.com/chapter/<id>/<章节>/ · m.qidian.com/chapter/<id>/<章节>/ · vipreader.qidian.com/chapter/<id>/<章节>
function qidian(u: URL): ParseResult {
  const host = u.hostname
  const s = segs(u)
  const book = (id: string, note?: string) =>
    found({ platform: 'qidian', kind: 'novel', externalId: id, canonicalUrl: `https://www.qidian.com/book/${id}/`, note })
  const id1 = s[1]?.replace(/\.html$/, '')
  if (['www.qidian.com', 'qidian.com', 'm.qidian.com'].includes(host)) {
    if (s[0] === 'book' && s.length === 2 && ID.test(id1)) return book(id1)
    if (s[0] === 'chapter' && ID.test(s[1] ?? '')) return book(s[1], '这是章节链接，已定位到所属作品。')
  }
  if (host === 'book.qidian.com' && s[0] === 'info' && s.length === 2 && ID.test(id1)) return book(id1)
  if (host === 'vipreader.qidian.com' && s[0] === 'chapter' && ID.test(s[1] ?? '')) return book(s[1], '这是章节链接，已定位到所属作品。')
  return notWork('qidian', '这是起点的链接，但不是作品页。请打开作品详情页（地址形如 qidian.com/book/数字）后复制链接。')
}

// —— 晋江文学城 ——
// www.jjwxc.net/onebook.php?novelid=<id>[&chapterid=…] · my.jjwxc.net/onebook_vip.php?novelid=<id>&chapterid=…
// 手机版：m.jjwxc.net/book2/<id>[/<章节>]
function jjwxc(u: URL): ParseResult {
  const host = u.hostname
  const s = segs(u)
  const book = (id: string, note?: string) =>
    found({ platform: 'jjwxc', kind: 'novel', externalId: id, canonicalUrl: `https://www.jjwxc.net/onebook.php?novelid=${id}`, note })
  const novelid = u.searchParams.get('novelid') ?? ''
  if (['www.jjwxc.net', 'jjwxc.net', 'my.jjwxc.net'].includes(host) && ['/onebook.php', '/onebook_vip.php'].includes(u.pathname) && ID.test(novelid))
    return book(novelid, u.searchParams.has('chapterid') ? '这是章节链接，已定位到所属作品。' : undefined)
  if (['m.jjwxc.net', 'wap.jjwxc.net'].includes(host) && s[0] === 'book2' && ID.test(s[1] ?? ''))
    return book(s[1], s.length > 2 ? '这是章节链接，已定位到所属作品。' : undefined)
  return notWork('jjwxc', '这是晋江的链接，但不是作品页。请打开作品目录页（地址含 novelid=数字）后复制链接。')
}

// —— 长佩文学 ——
// www.gongzicp.com/novel-<id>.html · 手机版 m.gongzicp.com/novel-<id>.html
// 章节页 read-<章节ID>.html 只含章节 ID，无法可靠定位作品，不接受
function gongzicp(u: URL): ParseResult {
  const host = u.hostname
  const s = segs(u)
  const m = s.length === 1 ? /^novel-(\d{1,20})\.html$/.exec(s[0]) : null
  if (['www.gongzicp.com', 'gongzicp.com', 'm.gongzicp.com'].includes(host) && m)
    return found({ platform: 'gongzicp', kind: 'novel', externalId: m[1], canonicalUrl: `https://www.gongzicp.com/novel-${m[1]}.html` })
  if (s.length === 1 && /^read-\d+\.html$/.test(s[0]))
    return notWork('gongzicp', '这是长佩的章节页，链接里只有章节编号，无法确定是哪部作品。请打开作品页（地址形如 novel-数字.html）后复制链接。')
  return notWork('gongzicp', '这是长佩的链接，但不是作品页。请打开作品页（地址形如 novel-数字.html）后复制链接。')
}

// —— 豆瓣 ——
// 图书：book.douban.com/subject/<id>/ · m.douban.com/book/subject/<id>/
// 影视：movie.douban.com/subject/<id>/（电影与电视剧共用，无法从链接区分）· m.douban.com/movie/subject/<id>/ · m.douban.com/tv/subject/<id>/
// App 分享：www.douban.com/doubanapp/dispatch?uri=/book/<id>/ 或 /movie/<id>/
function douban(u: URL): ParseResult {
  const host = u.hostname
  const s = segs(u)
  const book = (id: string): ParseResult =>
    found({ platform: 'douban-book', kind: 'book', externalId: id, canonicalUrl: `https://book.douban.com/subject/${id}/` })
  const movie = (id: string, kind: SourceKind): ParseResult =>
    found({ platform: 'douban-movie', kind, externalId: id, canonicalUrl: `https://movie.douban.com/subject/${id}/` })
  const tail = s[s.length - 1]
  if (host === 'book.douban.com') return s[0] === 'subject' && s.length === 2 && ID.test(tail) ? book(tail) : notWork('douban-book', '这是豆瓣读书的链接，但不是图书条目页（地址形如 book.douban.com/subject/数字）。')
  if (host === 'movie.douban.com') return s[0] === 'subject' && s.length === 2 && ID.test(tail) ? movie(tail, 'screen') : notWork('douban-movie', '这是豆瓣电影的链接，但不是影视条目页（地址形如 movie.douban.com/subject/数字）。')
  if (host === 'm.douban.com' && s[1] === 'subject' && s.length === 3 && ID.test(s[2])) {
    if (s[0] === 'book') return book(s[2])
    if (s[0] === 'movie') return movie(s[2], 'screen')
    if (s[0] === 'tv') return movie(s[2], 'tv')
  }
  if ((host === 'www.douban.com' || host === 'douban.com') && u.pathname.replace(/\/$/, '') === '/doubanapp/dispatch') {
    const m = /^\/(book|movie|tv)\/(\d{1,20})\/?$/.exec(u.searchParams.get('uri') ?? '')
    if (m) return m[1] === 'book' ? book(m[2]) : movie(m[2], m[1] === 'tv' ? 'tv' : 'screen')
  }
  return { ok: false, reason: 'not-work-page', message: '这是豆瓣的链接，但不是图书或影视条目页。请打开条目页后复制链接。' }
}

// —— Goodreads ——
// www.goodreads.com/book/show/<id>[-slug | .Slug] · 可带语言前缀 /en/book/show/<id>
function goodreads(u: URL): ParseResult {
  let s = segs(u)
  if (/^[a-z]{2}$/.test(s[0] ?? '')) s = s.slice(1) // 语言前缀
  const m = s[0] === 'book' && s[1] === 'show' && s.length === 3 ? /^(\d{1,20})(?:[-.][^/]*)?$/.exec(s[2]) : null
  if (['www.goodreads.com', 'goodreads.com', 'm.goodreads.com'].includes(u.hostname) && m)
    return found({ platform: 'goodreads', kind: 'book', externalId: m[1], canonicalUrl: `https://www.goodreads.com/book/show/${m[1]}` })
  return notWork('goodreads', '这是 Goodreads 的链接，但不是单本图书页（地址形如 goodreads.com/book/show/数字）。')
}

/** 识别一个作品链接。input 可以是完整链接，也可以是不带协议的链接（如 book.douban.com/subject/…）。 */
export function parseWorkUrl(input: string): ParseResult {
  const raw = input.trim()
  if (!raw) return { ok: false, reason: 'empty', message: '请粘贴作品链接。' }
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, reason: 'invalid', message: '这不是有效的链接。' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'invalid', message: '只支持 http / https 链接。' }
  if (u.username || u.password) return { ok: false, reason: 'invalid', message: '链接中包含用户名或密码，已拒绝。' }
  if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, reason: 'unsupported-site', message: '暂不支持这个网站的链接。' }
  const host = u.hostname.replace(/\.$/, '')
  if (host !== u.hostname) u.hostname = host

  if (under(host, 'qidian.com')) return qidian(u)
  if (under(host, 'jjwxc.net')) return jjwxc(u)
  if (under(host, 'gongzicp.com')) return gongzicp(u)
  if (under(host, 'douban.com')) return douban(u)
  if (under(host, 'goodreads.com')) return goodreads(u)
  return { ok: false, reason: 'unsupported-site', message: '暂不支持这个网站。目前支持：起点中文网、晋江文学城、长佩文学、豆瓣读书 / 电影、Goodreads。' }
}

/** 从粘贴的文字（例如 App「分享」出来的一段话）中找出第一个链接。 */
export function extractUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"'，。！？、）》】」]+/i.exec(text)
  if (m) return m[0]
  const bare = /(?:^|\s)((?:[a-z0-9-]+\.)+(?:com|net)\/[^\s<>"'，。！？、）》】」]*)/i.exec(text)
  return bare ? bare[1] : null
}

/** 粘贴的文字里用书名号标出的标题（例如「我在起点读《书名》」）。这是用户粘贴的内容，只作为建议。 */
export function titleFromPastedText(text: string): string | null {
  const m = /《([^《》\n]{1,80})》/.exec(text)
  return m ? m[1].trim() || null : null
}
