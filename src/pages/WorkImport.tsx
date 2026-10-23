import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { db, DuplicateSourceError, findWorkBySource, importWork, linkSourceToWork, WORK_TYPES, workTypeLabel, type Asset, type Work, type WorkSource, type WorkType } from '../db'
import { ADAPTERS, baseMetadata, downloadCover, fetchMetadata, recognize, describeError, type FetchOutcome } from '../import/adapters'
import { candidatesFromText } from '../import/assist'
import { lookupIsbn, normalizeIsbn } from '../import/isbn'
import { extractUrl, PLATFORM_LABELS, sourceKey, type ParsedSource } from '../import/parse'
import { assetToUrl, fileToAsset, newId } from '../lib'

/**
 * 从链接导入作品：粘贴 → 识别来源 → 获取可用信息 → 预览并修改 → 查重 → 保存。
 * 自动获取失败时保留来源链接与编号，可以手动填写、从分享文字中提取候选、用 ISBN 查询，或上传封面；
 * 任何辅助结果都只填入空白且未被用户修改过的字段，其余以「候选」形式由用户决定是否使用。
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'fetching'; source: ParsedSource }
  | { kind: 'duplicate'; source: ParsedSource; work: Work }
  | { kind: 'preview'; source: ParsedSource; outcome: FetchOutcome }

type Field = 'title' | 'author' | 'type' | 'isbn'
type Candidate = { field: Field; value: string; from: string }

const FIELD_LABELS: Record<Field | 'coverUrl' | 'category', string> = { title: '标题', author: '作者', type: '类别', category: '类别', isbn: 'ISBN', coverUrl: '封面' }

export default function WorkImport() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'input' })
  const abortRef = useRef<AbortController | null>(null)

  // 预览表单。values 为当前值，origin 为值的来源说明，touched 为用户亲手改过的字段（不会被自动覆盖）
  const [values, setValuesState] = useState<Record<Field, string>>({ title: '', author: '', type: '', isbn: '' })
  const valuesRef = useRef(values)
  const setValues = (next: Record<Field, string>) => {
    valuesRef.current = next
    setValuesState(next)
  }
  const [origin, setOrigin] = useState<Partial<Record<Field, string>>>({})
  const touched = useRef(new Set<Field>())
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [cover, setCover] = useState<Asset | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverFrom, setCoverFrom] = useState<{ kind: 'fetched' | 'upload'; label: string; url?: string } | null>(null)
  const [coverNote, setCoverNote] = useState('')
  const [coverBusy, setCoverBusy] = useState(false)
  const coverTouched = useRef(false)
  const [shareText, setShareText] = useState('')
  const [isbnInput, setIsbnInput] = useState('')
  const [isbnState, setIsbnState] = useState<{ busy: boolean; lines: string[] }>({ busy: false, lines: [] })
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

  /** 用户输入：记为已修改，之后的自动结果不会覆盖它。 */
  function edit(field: Field, value: string) {
    touched.current.add(field)
    setValues({ ...valuesRef.current, [field]: value })
    setOrigin((o) => ({ ...o, [field]: undefined }))
  }

  /** 自动或辅助结果：字段为空且用户没改过时直接填入，否则作为候选。 */
  function offer(list: Candidate[]) {
    const extra: Candidate[] = []
    const next = { ...valuesRef.current }
    const tags: Partial<Record<Field, string>> = {}
    for (const c of list) {
      if (!next[c.field] && !touched.current.has(c.field)) {
        next[c.field] = c.value
        tags[c.field] = c.from
      } else if (next[c.field] !== c.value) extra.push(c)
    }
    setValues(next)
    setOrigin((o) => ({ ...o, ...tags }))
    setCandidates((old) => [...old.filter((o) => !extra.some((e) => e.field === o.field && e.value === o.value)), ...extra])
  }

  function useCandidate(c: Candidate) {
    touched.current.add(c.field)
    setValues({ ...valuesRef.current, [c.field]: c.value })
    setOrigin((o) => ({ ...o, [c.field]: c.from }))
    setCandidates((l) => l.filter((x) => x !== c))
  }

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
    if (ctl.signal.aborted) return // 用户点了「跳过」，已进入预览
    openPreview(source, outcome, input)
    if (outcome.metadata.coverUrl) loadRemoteCover(outcome.metadata.coverUrl, outcome.metadata.provider ?? '', ctl.signal)
  }

  /** 进入预览：只填入确实获得的信息；粘贴文字中的候选单独标注来源。 */
  function openPreview(source: ParsedSource, outcome: FetchOutcome, input: string) {
    const m = outcome.metadata
    touched.current.clear()
    setValues({ title: '', author: '', type: '', isbn: '' })
    setOrigin({})
    setCandidates([])
    setCoverNote('')
    setPhase({ kind: 'preview', source, outcome })
    const from = (m.provider ?? '').trim()
    const list: Candidate[] = []
    if (m.title) list.push({ field: 'title', value: m.title, from: `来自${sp(from)}`.trim() })
    if (m.author) list.push({ field: 'author', value: m.author, from: `来自${sp(from)}`.trim() })
    if (m.category) list.push({ field: 'type', value: m.category, from: m.fields.includes('category') ? `来自${sp(from)}`.trim() : '由链接判断' })
    if (m.isbn) list.push({ field: 'isbn', value: normalizeIsbn(m.isbn) ?? m.isbn, from: `来自${sp(from)}`.trim() })
    list.push(...pastedCandidates(input))
    offer(list)
    if (m.isbn) setIsbnInput(normalizeIsbn(m.isbn) ?? m.isbn)
  }

  function pastedCandidates(input: string): Candidate[] {
    const c = candidatesFromText(input)
    const from = '来自粘贴的文字，请确认'
    return [
      ...(c.title ? [{ field: 'title' as const, value: c.title, from }] : []),
      ...(c.author ? [{ field: 'author' as const, value: c.author, from }] : []),
      ...(c.isbn ? [{ field: 'isbn' as const, value: c.isbn, from }] : []),
    ]
  }

  async function loadRemoteCover(url: string, provider: string, signal: AbortSignal) {
    if (coverTouched.current) return
    setCoverBusy(true)
    try {
      const file = await downloadCover(url, signal)
      const asset = await fileToAsset(file, { workId: workId.current })
      if (!asset.width) throw new Error('封面图片无法读取')
      if (signal.aborted || coverTouched.current) return
      showCover(asset)
      setCoverFrom({ kind: 'fetched', label: `来自${sp(provider.trim())}`.trim(), url })
      setCoverNote('')
    } catch (err) {
      if (!signal.aborted) setCoverNote(`封面没能下载（${describeError(err)}）。作品仍可创建，可以手动上传封面。`)
    } finally {
      setCoverBusy(false)
    }
  }

  async function pickCover(file: File | undefined) {
    if (!file) return
    coverTouched.current = true
    setCoverBusy(true)
    try {
      const asset = await fileToAsset(file, { workId: workId.current })
      if (!asset.width) throw new Error()
      showCover(asset)
      setCoverFrom({ kind: 'upload', label: '已上传' })
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
    openPreview(phase.source, { status: 'not-found', metadata: baseMetadata(phase.source), reason: '已跳过自动获取。' }, text)
  }

  function extractShare() {
    const list = pastedCandidates(shareText)
    const url = extractUrl(shareText)
    if (!list.length) return setHint('没有在这段文字中找到书名号《》中的标题、作者或 ISBN。')
    setHint(url && phase.kind === 'preview' && recognize(url).ok && sourceKey((recognize(url) as { source: ParsedSource }).source) !== sourceKey(phase.source) ? '注意：这段文字中的链接指向另一部作品。' : '')
    offer(list)
    const isbn = list.find((c) => c.field === 'isbn')
    if (isbn && !isbnInput) setIsbnInput(isbn.value)
  }

  async function queryIsbn() {
    const isbn = normalizeIsbn(isbnInput)
    if (!isbn) return setIsbnState({ busy: false, lines: ['ISBN 格式或校验位不正确。'] })
    setIsbnState({ busy: true, lines: [] })
    const ctl = new AbortController()
    abortRef.current = ctl
    const r = await lookupIsbn(isbn, ctl.signal)
    if (ctl.signal.aborted) return
    const lines = r.attempts.map((a) => `${a.provider}：${a.result}`)
    setIsbnState({ busy: false, lines })
    if (!r.title) return
    const from = `来自 ${r.provider}（ISBN ${isbn}）`
    offer([
      { field: 'isbn', value: isbn, from },
      { field: 'title', value: r.title, from },
      ...(r.author ? [{ field: 'author' as const, value: r.author, from }] : []),
    ])
    if (r.coverUrl && !cover) loadRemoteCover(r.coverUrl, `${r.provider}（ISBN 已核对）`, ctl.signal)
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
    const isbn = values.isbn ? normalizeIsbn(values.isbn) : null
    if (values.isbn && !isbn) return setHint('ISBN 格式或校验位不正确。')
    const record: WorkSource = {
      platform: source.platform,
      externalId: source.externalId,
      url: source.canonicalUrl,
      addedAt: now,
      ...(m.provider && m.fields.length ? { fetched: { provider: m.provider, fields: m.fields, fetchedAt: now } } : {}),
      ...(coverFrom?.kind === 'fetched' && coverFrom.url ? { coverUrl: coverFrom.url } : {}),
    }
    setSaving(true)
    setHint('')
    try {
      if (mode === 'link') {
        if (!linkTo) throw new Error('请选择要关联的作品。')
        await linkSourceToWork(linkTo, record)
        navigate(`/work/${linkTo}`, { replace: true })
      } else {
        if (!values.title.trim()) throw new Error('请填写作品名称。')
        if (!values.type) throw new Error('请选择类别。')
        const work: Work = {
          id: workId.current,
          name: values.title.trim(),
          type: values.type as WorkType,
          coverAssetId: cover?.id ?? null,
          createdAt: now,
          updatedAt: now,
          ...(values.author.trim() ? { author: values.author.trim() } : {}),
          ...(isbn ? { isbn } : {}),
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
            <li>起点中文网 · 晋江文学城 · 长佩文学 · 豆瓣读书 / 电影：识别来源与编号，并尝试读取作品页；读不到时会说明原因，可手动补全。</li>
            <li>Goodreads：通过 Open Library 公开数据查询，仅在编号完全对应时自动填入。</li>
          </ul>
          <Link to="/library/import/check" className="mt-3 inline-block underline">网络检测：查看各平台在这台设备上能否读取</Link>
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
          {phase.source.platform === 'goodreads' ? '正在从 Open Library 查询公开信息…' : `正在读取${PLATFORM_LABELS[phase.source.platform]}作品页…`}
          <button onClick={skipFetch} className="ml-3 underline">跳过，手动填写</button>
        </p>
      </div>
    )

  // —— 预览与确认 ——
  const { source, outcome } = phase
  const requested = ADAPTERS[source.platform].requestUrl(source)
  const fetchLine =
    outcome.status === 'ok'
      ? `已从${sp(outcome.metadata.provider ?? '')}获取：${outcome.metadata.fields.map((f) => FIELD_LABELS[f]).join('、')}。${outcome.notes.join('')}请核对后保存。`
      : outcome.status === 'not-found'
        ? `未取得作品信息：${outcome.reason}`
        : `自动获取失败：${outcome.reason}。`
  const sameName = (works ?? []).filter((w) => norm(w.name) === norm(values.title) && values.title.trim())
  const linkable = [...(works ?? [])].sort((a, b) => Number(sameName.includes(b)) - Number(sameName.includes(a)) || a.name.localeCompare(b.name, 'zh'))

  return (
    <div className="pb-24">
      <Header onCancel={cancel} label={saving ? '保存中…' : '确认信息'} onSave={save} saveDisabled={saving || coverBusy} saveLabel={mode === 'link' ? '关联' : '保存'} />
      <SourceLine source={source} />
      <div role="status" className={`mt-3 text-sm ${outcome.status === 'ok' ? '' : 'text-mute'}`}>
        <p>{fetchLine}</p>
        {outcome.status !== 'ok' && (
          <p className="mt-1 text-xs break-all">
            实际请求：{requested}
            {outcome.status === 'failed' && ` · 原因类型：${FAILURE_LABELS[outcome.failure] ?? outcome.failure}`}
            {' · '}来源链接与编号已保留，可以手动填写或使用下面的辅助补全。
          </p>
        )}
      </div>

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
        <>
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
                <p className="mt-2 flex justify-between gap-2 text-xs text-mute">
                  <span className="min-w-0 truncate">{coverFrom?.label}</span>
                  <button
                    onClick={() => {
                      coverTouched.current = true
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
              <FieldBox label="作品名称" tag={origin.title}>
                <input
                  id="import-title"
                  value={values.title}
                  onChange={(e) => edit('title', e.target.value)}
                  placeholder="未能自动获取，请填写"
                  className="w-full border-b border-line bg-transparent pb-2 font-serif text-2xl outline-none placeholder:text-base placeholder:text-mute/60 focus:border-ink"
                />
              </FieldBox>
              <FieldBox label="作者" tag={origin.author}>
                <input
                  id="import-author"
                  value={values.author}
                  onChange={(e) => edit('author', e.target.value)}
                  placeholder="可选"
                  className="w-full border-b border-line bg-transparent pb-2 outline-none placeholder:text-mute/60 focus:border-ink"
                />
              </FieldBox>
              <FieldBox label="类别" tag={origin.type}>
                <div className="flex flex-wrap gap-2">
                  {WORK_TYPES.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => edit('type', t.value)}
                      className={`rounded-full border px-3.5 py-1 text-sm ${values.type === t.value ? 'border-ink bg-ink text-paper' : 'border-line text-mute'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                {!values.type && source.kind === 'screen' && <p className="mt-2 text-xs text-mute">豆瓣的影视链接不区分电影与电视剧，请选择。</p>}
              </FieldBox>
              <FieldBox label="ISBN" tag={origin.isbn}>
                <input
                  id="import-isbn"
                  value={values.isbn}
                  inputMode="numeric"
                  onChange={(e) => edit('isbn', e.target.value)}
                  placeholder="可选"
                  className="w-full border-b border-line bg-transparent pb-2 tabular-nums outline-none placeholder:text-mute/60 focus:border-ink"
                />
              </FieldBox>
            </div>
          </div>

          {candidates.length > 0 && (
            <section className="mt-8">
              <p className="mb-2 text-xs tracking-[0.2em] text-mute">候选信息（不会覆盖你已填写的内容）</p>
              <ul className="space-y-1.5 text-sm">
                {candidates.map((c) => (
                  <li key={`${c.field}:${c.value}`} className="flex items-baseline gap-3">
                    <span className="shrink-0 text-mute">{FIELD_LABELS[c.field]}</span>
                    <span className="min-w-0 flex-1 truncate">{c.field === 'type' ? workTypeLabel(c.value as WorkType) : c.value}</span>
                    <span className="hidden shrink-0 text-xs text-mute sm:inline">{c.from}</span>
                    <button onClick={() => useCandidate(c)} className="shrink-0 rounded-full border border-line px-3 text-xs">使用</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-10 border-t border-line pt-6">
            <p className="mb-4 text-xs tracking-[0.2em] text-mute">辅助补全</p>
            <div className="space-y-6">
              <div>
                <label htmlFor="share-text" className="mb-1.5 block text-sm">从分享文字中提取</label>
                <textarea
                  id="share-text"
                  value={shareText}
                  rows={2}
                  onChange={(e) => setShareText(e.target.value)}
                  placeholder="粘贴 App「分享」或作品页上复制的文字，例如：《书名》作者：某某"
                  className="w-full resize-none border-b border-line bg-transparent pb-1.5 text-sm outline-none placeholder:text-mute/60 focus:border-ink"
                />
                <button onClick={extractShare} disabled={!shareText.trim()} className="mt-2 rounded-full border border-ink px-4 py-1 text-xs disabled:opacity-40">提取候选</button>
              </div>
              {(source.kind === 'book' || values.type === 'book') && (
                <div>
                  <label htmlFor="isbn-query" className="mb-1.5 block text-sm">用 ISBN 查询（Open Library / Google Books，结果须 ISBN 一致）</label>
                  <div className="flex items-center gap-3">
                    <input
                      id="isbn-query"
                      value={isbnInput}
                      inputMode="numeric"
                      onChange={(e) => setIsbnInput(e.target.value)}
                      placeholder="978…"
                      className="min-w-0 flex-1 border-b border-line bg-transparent pb-1.5 text-sm tabular-nums outline-none placeholder:text-mute/60 focus:border-ink"
                    />
                    <button onClick={queryIsbn} disabled={!isbnInput.trim() || isbnState.busy} className="shrink-0 rounded-full border border-ink px-4 py-1 text-xs disabled:opacity-40">
                      {isbnState.busy ? '查询中…' : '查询'}
                    </button>
                  </div>
                  {isbnState.lines.length > 0 && (
                    <ul role="status" aria-label="ISBN 查询结果" className="mt-2 space-y-0.5 text-xs text-mute">
                      {isbnState.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </section>
        </>
      )}
      {hint && <p role="alert" className="mt-6 text-sm text-red-700">{hint}</p>}
    </div>
  )
}

export const FAILURE_LABELS: Record<string, string> = {
  'cors-blocked': '跨域限制（服务器有响应，但不允许网页读取）',
  unreachable: '无法连接',
  timeout: '超时',
  forbidden: '拒绝访问 / 验证页',
  'rate-limited': '请求过于频繁',
  'http-error': '服务错误',
  'too-large': '响应过大',
  'not-html': '不是网页',
  other: '其他错误',
}

/** 中文里夹排的西文名称两侧加空格。 */
const sp = (s: string) => (/^[A-Za-z]/.test(s) ? ` ${s} ` : s)

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

function FieldBox({ label, tag, children }: { label: string; tag?: string; children: ReactNode }) {
  return (
    <div>
      <span className="mb-2 flex items-baseline justify-between gap-3 text-xs tracking-[0.2em] text-mute">
        {label}
        {tag && <span className="truncate tracking-normal">{tag}</span>}
      </span>
      {children}
    </div>
  )
}
