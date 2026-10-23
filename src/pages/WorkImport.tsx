import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { db, DuplicateSourceError, findWorkBySource, importWork, linkSourceToWork, WORK_TYPES, type Asset, type Work, type WorkSource, type WorkType } from '../db'
import { ADAPTERS, downloadCover, fetchMetadata, recognize, describeError, type FetchOutcome } from '../import/adapters'
import { extractUrl, PLATFORM_LABELS, sourceKey, titleFromPastedText, type ParsedSource } from '../import/parse'
import { assetToUrl, fileToAsset, newId } from '../lib'

/**
 * 从链接导入作品：粘贴 → 识别来源 → 获取可用信息 → 预览并修改 → 查重 → 保存。
 * 任何一步失败都可以继续手动填写；封面下载失败不影响创建。
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'fetching'; source: ParsedSource }
  | { kind: 'duplicate'; source: ParsedSource; work: Work }
  | { kind: 'preview'; source: ParsedSource; outcome: FetchOutcome }

type Origin = 'fetched' | 'pasted' | 'link' | null

export default function WorkImport() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'input' })
  const abortRef = useRef<AbortController | null>(null)

  // 预览表单
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [type, setType] = useState<WorkType | null>(null)
  const [origin, setOrigin] = useState<{ title: Origin; author: Origin; type: Origin }>({ title: null, author: null, type: null })
  const [cover, setCover] = useState<Asset | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverFrom, setCoverFrom] = useState<'fetched' | 'upload' | null>(null)
  const [coverNote, setCoverNote] = useState('')
  const [coverBusy, setCoverBusy] = useState(false)
  const [mode, setMode] = useState<'new' | 'link'>('new')
  const [linkTo, setLinkTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [hint, setHint] = useState('')
  const workId = useRef(newId())

  const works = useLiveQuery(() => db.works.toArray(), [])

  const coverUrlRef = useRef<string | null>(null)
  function showCover(asset: Asset | null) {
    if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current)
    coverUrlRef.current = asset ? assetToUrl(asset) : null
    setCoverUrl(coverUrlRef.current)
    setCover(asset)
  }
  useEffect(
    () => () => {
      abortRef.current?.abort()
      if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current)
    },
    [],
  )

  async function start(input = text) {
    setError('')
    const url = extractUrl(input) ?? input.trim()
    const parsed = recognize(url)
    if (!parsed.ok) return setError(parsed.message)
    const source = parsed.source
    const dup = await findWorkBySource(sourceKey(source))
    if (dup) return setPhase({ kind: 'duplicate', source, work: dup })

    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    setPhase({ kind: 'fetching', source })
    const outcome = await fetchMetadata(source, ctl.signal)
    if (ctl.signal.aborted && outcome.status === 'failed') return // 用户点了「跳过」，已进入预览
    openPreview(source, outcome, input)
    if (outcome.metadata.coverUrl) loadRemoteCover(outcome.metadata.coverUrl, ctl.signal)
  }

  /** 进入预览：只填入确实获得的信息；书名号中的标题来自用户粘贴的文字，单独标注。 */
  function openPreview(source: ParsedSource, outcome: FetchOutcome, input: string) {
    const m = outcome.metadata
    const pasted = titleFromPastedText(input)
    setTitle(m.title ?? pasted ?? '')
    setAuthor(m.author ?? '')
    setType(m.category)
    setOrigin({
      title: m.title ? 'fetched' : pasted ? 'pasted' : null,
      author: m.author ? 'fetched' : null,
      type: m.category ? (m.fields.includes('category') ? 'fetched' : 'link') : null,
    })
    setCoverNote('')
    setPhase({ kind: 'preview', source, outcome })
  }

  async function loadRemoteCover(url: string, signal: AbortSignal) {
    setCoverBusy(true)
    try {
      const file = await downloadCover(url, signal)
      const asset = await fileToAsset(file, { workId: workId.current })
      if (!asset.width) throw new Error('封面图片无法读取')
      if (signal.aborted) return
      showCover(asset)
      setCoverFrom('fetched')
    } catch (err) {
      if (!signal.aborted) setCoverNote(`封面没能下载（${describeError(err)}）。作品仍可创建，可以手动上传封面。`)
    } finally {
      setCoverBusy(false)
    }
  }

  async function pickCover(file: File | undefined) {
    if (!file) return
    abortRef.current?.abort() // 停止仍在进行的自动下载
    setCoverBusy(true)
    try {
      const asset = await fileToAsset(file, { workId: workId.current })
      if (!asset.width) throw new Error()
      showCover(asset)
      setCoverFrom('upload')
      setCoverNote('')
    } catch {
      setCoverNote(`无法读取图片：${file.name}`)
    } finally {
      setCoverBusy(false)
    }
  }

  function skipFetch() {
    if (phase.kind !== 'fetching') return
    abortRef.current?.abort()
    openPreview(phase.source, { status: 'failed', metadata: ADAPTERS[phase.source.platform].normalizeMetadata(phase.source, null).metadata, reason: '已跳过自动获取' }, text)
  }

  function cancel() {
    abortRef.current?.abort()
    navigate('/library')
  }

  async function save() {
    if (phase.kind !== 'preview' || saving) return
    const { source, outcome } = phase
    const m = outcome.metadata
    const now = Date.now()
    const record: WorkSource = {
      platform: source.platform,
      externalId: source.externalId,
      url: source.canonicalUrl,
      addedAt: now,
      ...(m.provider && m.fields.length ? { fetched: { provider: m.provider, fields: m.fields, fetchedAt: now } } : {}),
      ...(coverFrom === 'fetched' && m.coverUrl ? { coverUrl: m.coverUrl } : {}),
    }
    setSaving(true)
    setHint('')
    try {
      if (mode === 'link') {
        if (!linkTo) throw new Error('请选择要关联的作品。')
        await linkSourceToWork(linkTo, record)
        navigate(`/work/${linkTo}`, { replace: true })
      } else {
        if (!title.trim()) throw new Error('请填写作品名称。')
        if (!type) throw new Error('请选择类别。')
        const work: Work = {
          id: workId.current,
          name: title.trim(),
          type,
          coverAssetId: cover?.id ?? null,
          createdAt: now,
          updatedAt: now,
          ...(author.trim() ? { author: author.trim() } : {}),
          sources: [record],
        }
        await importWork(work, cover)
        navigate(`/work/${work.id}`, { replace: true })
      }
    } catch (err) {
      if (err instanceof DuplicateSourceError) return setPhase({ kind: 'duplicate', source, work: err.work })
      setHint((err as Error).message || '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  // —— 第 1 步：粘贴链接 ——
  if (phase.kind === 'input')
    return (
      <div className="pb-24">
        <Header onCancel={cancel} label="从链接导入" />
        <label className="block">
          <span className="mb-2 block text-xs tracking-[0.2em] text-mute">作品链接</span>
          <textarea
            id="import-url"
            value={text}
            rows={3}
            onChange={(e) => {
              setText(e.target.value)
              setError('')
            }}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text')
              if (pasted && !text.trim()) {
                e.preventDefault()
                setText(pasted)
                start(pasted)
              }
            }}
            placeholder="粘贴作品页链接，或 App「分享」出来的整段文字"
            className="w-full resize-none border-b border-line bg-transparent pb-2 text-base outline-none placeholder:text-mute/60 focus:border-ink"
          />
        </label>
        <div className="mt-4 flex items-center gap-4">
          <button onClick={() => start()} className="rounded-full bg-ink px-5 py-1.5 text-sm text-paper">识别</button>
          <Link to="/library/new" className="text-sm text-mute underline">不用链接，手动创建</Link>
        </div>
        {error && (
          <div role="alert" className="mt-6 border-l-2 border-red-700 pl-3 text-sm">
            <p className="text-red-700">{error}</p>
            <Link to="/library/new" className="mt-2 inline-block underline">手动创建作品</Link>
          </div>
        )}
        <section className="mt-12 text-xs leading-relaxed text-mute">
          <p className="mb-2 tracking-[0.2em]">支持的链接</p>
          <ul className="space-y-1">
            <li>起点中文网 · 晋江文学城 · 长佩文学 · 豆瓣读书 / 电影：识别来源与编号，信息需手动补全（这些平台不提供可供网页读取的公开接口）</li>
            <li>Goodreads：通过 Open Library 公开数据查询标题、作者与封面，仅在编号完全对应时自动填入</li>
          </ul>
        </section>
      </div>
    )

  // —— 已存在 ——
  if (phase.kind === 'duplicate')
    return (
      <div className="pb-24">
        <Header onCancel={cancel} label="从链接导入" />
        <SourceLine source={phase.source} />
        <div role="alert" className="mt-8 border-l-2 border-ink pl-4">
          <p className="font-serif text-lg">这部作品已在作品馆中</p>
          <p className="mt-1 text-sm text-mute">《{phase.work.name}》已经关联了这个来源，没有重复创建。</p>
          <div className="mt-4 flex gap-3 text-sm">
            <Link to={`/work/${phase.work.id}`} className="rounded-full bg-ink px-4 py-1.5 text-paper">打开这部作品</Link>
            <button onClick={() => setPhase({ kind: 'input' })} className="rounded-full border border-line px-4 py-1.5">换一个链接</button>
          </div>
        </div>
      </div>
    )

  // —— 获取中 ——
  if (phase.kind === 'fetching')
    return (
      <div className="pb-24">
        <Header onCancel={cancel} label="从链接导入" />
        <SourceLine source={phase.source} />
        <p role="status" className="mt-8 text-sm text-mute">
          正在从 Open Library 查询公开信息…
          <button onClick={skipFetch} className="ml-3 underline">跳过，手动填写</button>
        </p>
      </div>
    )

  // —— 预览与确认 ——
  const { source, outcome } = phase
  const fetchLine =
    outcome.status === 'ok'
      ? `已从 ${outcome.metadata.provider} 获取：${outcome.metadata.fields.map((f) => FIELD_LABELS[f]).join('、')}。${outcome.notes.join('')}请核对后保存。`
      : outcome.status === 'unsupported'
        ? `未自动获取：${outcome.reason}`
        : outcome.status === 'not-found'
          ? `未自动获取：${outcome.reason} 请手动填写。`
          : `自动获取失败：${outcome.reason}。请手动填写。`
  const sameName = (works ?? []).filter((w) => norm(w.name) === norm(title) && title.trim())
  const linkable = [...(works ?? [])].sort((a, b) => Number(sameName.includes(b)) - Number(sameName.includes(a)) || a.name.localeCompare(b.name, 'zh'))

  return (
    <div className="pb-24">
      <Header onCancel={cancel} label={saving ? '保存中…' : '确认信息'} onSave={save} saveDisabled={saving || coverBusy} saveLabel={mode === 'link' ? '关联' : '保存'} />
      <SourceLine source={source} />
      <p role="status" className={`mt-3 text-sm ${outcome.status === 'ok' ? '' : 'text-mute'}`}>{fetchLine}</p>

      <div className="mt-6 flex gap-5 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} className="accent-ink" /> 保存为新作品
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="mode" checked={mode === 'link'} onChange={() => setMode('link')} disabled={!works?.length} className="accent-ink" /> 关联到已有作品
        </label>
      </div>

      {mode === 'link' ? (
        <div className="mt-8 space-y-3">
          <select id="link-target" value={linkTo} onChange={(e) => setLinkTo(e.target.value)} className="w-full border-b border-line bg-transparent py-2 font-serif text-lg outline-none focus:border-ink">
            <option value="">选择作品…</option>
            {linkable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {sameName.includes(w) ? '（同名）' : ''}
              </option>
            ))}
          </select>
          <p className="text-xs text-mute">只为该作品添加这个来源链接，不修改它的名称、作者、类别与封面。</p>
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-8 sm:flex-row">
          <div className="w-40 shrink-0">
            <label className="block aspect-[3/4] cursor-pointer overflow-hidden border border-dashed border-mute/50">
              {coverUrl ? (
                <img src={coverUrl} alt="封面预览" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full flex-col items-center justify-center gap-1 text-mute">
                  <span className="text-2xl font-light">+</span>
                  <span className="text-xs">{coverBusy ? '正在下载封面…' : '上传封面'}</span>
                </span>
              )}
              <input
                id="import-cover"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  pickCover(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>
            {cover && (
              <p className="mt-2 flex justify-between text-xs text-mute">
                <span>{coverFrom === 'fetched' ? `来自 ${outcome.metadata.provider}` : '已上传'}</span>
                <button
                  onClick={() => {
                    showCover(null)
                    setCoverFrom(null)
                  }}
                >
                  移除
                </button>
              </p>
            )}
            {coverNote && <p className="mt-2 text-xs text-red-700">{coverNote}</p>}
          </div>

          <div className="min-w-0 flex-1 space-y-8">
            <Field label="作品名称" origin={origin.title} provider={outcome.metadata.provider}>
              <input
                id="import-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="未能自动获取，请填写"
                className="w-full border-b border-line bg-transparent pb-2 font-serif text-2xl outline-none placeholder:text-base placeholder:text-mute/60 focus:border-ink"
              />
            </Field>
            <Field label="作者" origin={origin.author} provider={outcome.metadata.provider}>
              <input
                id="import-author"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="可选"
                className="w-full border-b border-line bg-transparent pb-2 outline-none placeholder:text-mute/60 focus:border-ink"
              />
            </Field>
            <Field label="类别" origin={origin.type} provider={outcome.metadata.provider}>
              <div className="flex flex-wrap gap-2">
                {WORK_TYPES.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setType(t.value)}
                    className={`rounded-full border px-3.5 py-1 text-sm ${type === t.value ? 'border-ink bg-ink text-paper' : 'border-line text-mute'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {!type && source.kind === 'screen' && <p className="mt-2 text-xs text-mute">豆瓣的影视链接不区分电影与电视剧，请选择。</p>}
            </Field>
          </div>
        </div>
      )}
      {hint && <p role="alert" className="mt-6 text-sm text-red-700">{hint}</p>}
    </div>
  )
}

const FIELD_LABELS = { title: '标题', author: '作者', category: '类别', coverUrl: '封面' } as const

const norm = (s: string) => s.replace(/[\s《》「」"'·:：]/g, '').toLowerCase()

function Header({ onCancel, label, onSave, saveDisabled, saveLabel }: { onCancel: () => void; label: string; onSave?: () => void; saveDisabled?: boolean; saveLabel?: string }) {
  return (
    <div className="sticky top-0 z-10 -mx-5 mb-8 flex items-center justify-between border-b border-line bg-paper/95 px-5 py-3 backdrop-blur">
      <button onClick={onCancel} className="text-sm text-mute">← 取消导入</button>
      <span className="text-xs text-mute">{label}</span>
      {onSave ? (
        <button onClick={onSave} disabled={saveDisabled} className="rounded-full bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-40">
          {saveLabel}
        </button>
      ) : (
        <span className="w-12" />
      )}
    </div>
  )
}

function SourceLine({ source }: { source: ParsedSource }) {
  return (
    <div className="border-b border-ink pb-4">
      <p className="text-xs tracking-[0.2em] text-mute">
        来源 · {PLATFORM_LABELS[source.platform]} · 编号 {source.externalId}
      </p>
      <a href={source.canonicalUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block text-sm break-all underline">
        {source.canonicalUrl}
      </a>
      {source.note && <p className="mt-1 text-xs text-mute">{source.note}</p>}
    </div>
  )
}

function Field({ label, origin, provider, children }: { label: string; origin: Origin; provider: string | null; children: React.ReactNode }) {
  const tag = origin === 'fetched' ? `来自 ${provider}` : origin === 'pasted' ? '来自你粘贴的文字，请确认' : origin === 'link' ? '由链接判断' : null
  return (
    <div>
      <span className="mb-2 flex items-baseline justify-between text-xs tracking-[0.2em] text-mute">
        {label}
        {tag && <span className="tracking-normal">{tag}</span>}
      </span>
      {children}
    </div>
  )
}
