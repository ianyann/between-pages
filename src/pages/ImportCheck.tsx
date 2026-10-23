import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchMetadata, GOOGLE_BOOKS, OPEN_LIBRARY, recognize } from '../import/adapters'
import { extractHtmlMeta, FetchFailure, readable, readHtml } from '../import/net'
import { FAILURE_LABELS } from './WorkImport'

/**
 * 网络检测：在当前设备的浏览器里，对固定测试链接各发一次真实请求，报告能否读取、失败类型与解析结果。
 * 只在用户点击后运行；逐个请求，不并发。不带 Cookie。
 */

type Probe = { label: string; url: string; adapter?: boolean; expect?: string }

const PROBES: Probe[] = [
  { label: '豆瓣读书（桌面作品页）', url: 'https://book.douban.com/subject/38461487/', adapter: true, expect: '落在我身上的雨 / 陆庆屹 / ISBN 9787513364065' },
  { label: '豆瓣读书（手机页）', url: 'https://m.douban.com/book/subject/38461487/' },
  { label: '晋江作品页', url: 'https://www.jjwxc.net/onebook.php?novelid=47943', adapter: true, expect: '又一春 / 大风刮过' },
  { label: '长佩作品页', url: 'https://www.gongzicp.com/novel-2004952.html', adapter: true },
  { label: '起点作品页（桌面）', url: 'https://www.qidian.com/book/1045961766/', adapter: true },
  { label: '起点作品页（手机）', url: 'https://m.qidian.com/book/1045961766/' },
  { label: 'Open Library（Goodreads 编号查询）', url: `${OPEN_LIBRARY}/search.json?q=id_goodreads:2767052&fields=title&limit=1` },
  { label: 'Open Library（ISBN 9787513364065）', url: `${OPEN_LIBRARY}/api/books?bibkeys=ISBN:9787513364065&format=json&jscmd=data` },
  { label: 'Google Books（ISBN 9787513364065）', url: `${GOOGLE_BOOKS}/books/v1/volumes?q=isbn:9787513364065` },
]

type Row = { probe: Probe; state: 'waiting' | 'running' | 'done'; access?: string; detail?: string; parsed?: string; ms?: number }

export default function ImportCheck() {
  const [rows, setRows] = useState<Row[]>(PROBES.map((probe) => ({ probe, state: 'waiting' })))
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState('')
  const ctl = useRef<AbortController | null>(null)

  async function run() {
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    setRunning(true)
    setCopied('')
    setRows(PROBES.map((probe) => ({ probe, state: 'waiting' })))
    for (const [i, probe] of PROBES.entries()) {
      if (c.signal.aborted) break
      setRows((r) => r.map((x, j) => (j === i ? { ...x, state: 'running' } : x)))
      const row = await check(probe, c.signal)
      setRows((r) => r.map((x, j) => (j === i ? row : x)))
    }
    setRunning(false)
  }

  function report() {
    const lines = [
      `页间 网络检测 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `浏览器：${navigator.userAgent}`,
      ...rows.map((r) => `- ${r.probe.label}：${r.access ?? '未检测'}${r.ms != null ? `（${r.ms} ms）` : ''}${r.detail ? `；${r.detail}` : ''}${r.parsed ? `；解析：${r.parsed}` : ''}`),
    ]
    return lines.join('\n')
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report())
      setCopied('已复制，可以直接粘贴发送。')
    } catch {
      setCopied('无法自动复制，请长按下方文字手动复制。')
    }
  }

  return (
    <div className="pb-24">
      <div className="mb-8 flex items-center justify-between text-sm">
        <Link to="/library/import" className="text-mute">← 从链接导入</Link>
      </div>
      <h1 className="mb-2 font-serif text-2xl">网络检测</h1>
      <p className="mb-6 text-sm leading-relaxed text-mute">
        页间没有服务器，导入时由这台设备的浏览器直接请求各平台。点击开始后会对下列测试链接各请求一次（不带登录信息），报告能否读取以及失败原因。
      </p>
      <div className="mb-6 flex gap-3">
        <button onClick={run} disabled={running} className="rounded-full bg-ink px-5 py-1.5 text-sm text-paper disabled:opacity-40">
          {running ? '检测中…' : '开始检测'}
        </button>
        <button onClick={copy} disabled={running || rows.every((r) => r.state !== 'done')} className="rounded-full border border-ink px-5 py-1.5 text-sm disabled:opacity-40">
          复制结果
        </button>
      </div>
      {copied && <p className="mb-4 text-sm">{copied}</p>}
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((r) => (
          <li key={r.probe.label} className="py-3 text-sm" data-probe={r.probe.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-serif">{r.probe.label}</span>
              <span className={`shrink-0 text-xs ${r.access === '可读取' ? '' : 'text-mute'}`}>{r.state === 'running' ? '请求中…' : (r.access ?? '')}</span>
            </div>
            <p className="mt-0.5 text-xs break-all text-mute">{r.probe.url}</p>
            {r.detail && <p className="mt-1 text-xs">{r.detail}</p>}
            {r.parsed && <p className="mt-1 text-xs">解析：{r.parsed}</p>}
            {r.probe.expect && r.state === 'done' && <p className="mt-0.5 text-xs text-mute">已知应为：{r.probe.expect}</p>}
          </li>
        ))}
      </ul>
      {rows.some((r) => r.state === 'done') && !running && <pre className="mt-6 text-[11px] leading-relaxed break-all whitespace-pre-wrap text-mute select-all">{report()}</pre>}
    </div>
  )
}

async function check(probe: Probe, signal: AbortSignal): Promise<Row> {
  const t0 = performance.now()
  const done = (x: Partial<Row>): Row => ({ probe, state: 'done', ms: Math.round(performance.now() - t0), ...x })
  try {
    const res = await readable(probe.url, signal)
    const type = res.headers.get('content-type') || ''
    let detail = `HTTP ${res.status} · ${type.split(';')[0] || '未知类型'}`
    let parsed: string | undefined
    if (type.includes('html')) {
      const html = await readHtml(res)
      const m = extractHtmlMeta(html)
      detail += ` · ${Math.round(html.length / 1024)} KB · 正文约 ${m.textLength} 字 · <title>${m.title ?? '无'} · Open Graph ${Object.keys(m.og).length} 项 · JSON-LD ${m.jsonLd.length} 段`
      if (probe.adapter) {
        const parsedUrl = recognize(probe.url)
        if (parsedUrl.ok) {
          const out = await fetchMetadata(parsedUrl.source, signal)
          const md = out.metadata
          parsed = out.status === 'ok' ? [md.title && `标题「${md.title}」`, md.author && `作者「${md.author}」`, md.isbn && `ISBN ${md.isbn}`, md.coverUrl && '有封面地址'].filter(Boolean).join('，') : out.reason
        }
      }
    } else {
      const text = await res.text()
      detail += ` · ${text.length} 字节`
      parsed = summarizeJson(text)
    }
    return done({ access: '可读取', detail, parsed })
  } catch (err) {
    const f = err instanceof FetchFailure ? err : null
    return done({ access: f ? (FAILURE_LABELS[f.kind] ?? f.kind) : '错误', detail: (err as Error).message })
  }
}

function summarizeJson(text: string): string {
  try {
    const d = JSON.parse(text)
    if (Array.isArray(d?.docs)) return `${d.docs.length} 条记录${d.docs[0]?.title ? `，首条「${d.docs[0].title}」` : ''}`
    if (d && typeof d === 'object' && 'totalItems' in d) return `${d.totalItems ?? 0} 条记录${d.items?.[0]?.volumeInfo?.title ? `，首条「${d.items[0].volumeInfo.title}」作者 ${(d.items[0].volumeInfo.authors ?? []).join('、') || '无'}` : ''}`
    if (d?.error) return `错误：${d.error.message ?? JSON.stringify(d.error).slice(0, 80)}`
    const keys = Object.keys(d ?? {})
    return keys.length ? `${keys.length} 条记录${d[keys[0]]?.title ? `，「${d[keys[0]].title}」` : ''}` : '没有记录'
  } catch {
    return '不是 JSON'
  }
}
