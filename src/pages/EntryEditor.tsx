import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { db, saveEntry, type Asset, type CanvasData, type EntryStatus } from '../db'
import { assetToUrl, fileToAsset, formatClock, today } from '../lib'
import WorkPicker from '../WorkPicker'

interface Draft {
  title: string
  body: string
  entryDate: string
  status: EntryStatus
  imageIds: string[]
  workIds: string[]
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const AUTOSAVE_DELAY = 800

export default function EntryEditor() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<Draft>({ title: '', body: '', entryDate: today(), status: 'draft', imageIds: [], workIds: [] })
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [dirty, setDirty] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [processing, setProcessing] = useState(0)
  const [hint, setHint] = useState('')
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // 保存逻辑在异步回调中运行，统一从 ref 读取最新值
  const draftRef = useRef(draft)
  const urlsRef = useRef(urls)
  urlsRef.current = urls
  const meta = useRef<{ createdAt: number | null; canvas: CanvasData | null }>({ createdAt: null, canvas: null })
  const pendingAssets = useRef(new Map<string, Asset>()) // 新添加、尚未写入数据库的图片
  const removedIds = useRef(new Set<string>()) // 已从日记移除、待从数据库删除的图片
  const version = useRef(0)
  const savedVersion = useRef(0)
  const inFlight = useRef<Promise<boolean> | null>(null)

  // 读取已有日记；不存在则作为新日记
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const entry = await db.entries.get(id)
      if (cancelled || !entry) return
      const assets = await db.assets.bulkGet(entry.imageIds)
      if (cancelled) return
      const loadedUrls: Record<string, string> = {}
      assets.forEach((a) => a && (loadedUrls[a.id] = assetToUrl(a)))
      meta.current = { createdAt: entry.createdAt, canvas: entry.canvas ?? null }
      draftRef.current = {
        title: entry.title,
        body: entry.body,
        entryDate: entry.entryDate,
        status: entry.status,
        imageIds: entry.imageIds,
        workIds: entry.workIds ?? [],
      }
      setDraft(draftRef.current)
      setUrls(loadedUrls)
      setUpdatedAt(entry.updatedAt)
      setSaveState('saved')
    })().finally(() => !cancelled && setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [id])

  // 卸载时释放图片 URL
  useEffect(() => () => Object.values(urlsRef.current).forEach(URL.revokeObjectURL), [])

  /** 保存到数据库。保存期间若有新修改，会在当前保存完成后继续保存。返回是否成功。 */
  const save = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current
    const run = async () => {
      while (version.current !== savedVersion.current) {
        const v = version.current
        const d = draftRef.current
        const isEmpty = !d.title.trim() && !d.body.trim() && d.imageIds.length === 0
        if (isEmpty && meta.current.createdAt === null) {
          // 空白的新日记不写入数据库
          savedVersion.current = v
          break
        }
        const newAssets = [...pendingAssets.current.values()].filter((a) => d.imageIds.includes(a.id))
        const removed = [...removedIds.current]
        const now = Date.now()
        const createdAt = meta.current.createdAt ?? now
        setSaveState('saving')
        try {
          await saveEntry(
            { id, ...d, createdAt, updatedAt: now, canvas: meta.current.canvas },
            newAssets,
            removed,
          )
        } catch (err) {
          console.error('保存失败', err)
          setSaveState('error')
          return false
        }
        meta.current.createdAt = createdAt
        newAssets.forEach((a) => pendingAssets.current.delete(a.id))
        removed.forEach((r) => removedIds.current.delete(r))
        savedVersion.current = v
        setUpdatedAt(now)
        setSaveState('saved')
      }
      if (version.current === savedVersion.current) setDirty(false)
      return true
    }
    inFlight.current = run().finally(() => (inFlight.current = null))
    return inFlight.current
  }, [id])

  function update(patch: Partial<Draft>) {
    draftRef.current = { ...draftRef.current, ...patch }
    setDraft(draftRef.current)
    version.current++
    setDirty(true)
    setHint('')
  }

  // 正文框随内容增高
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft.body, loaded])

  // 停止输入后自动保存
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(save, AUTOSAVE_DELAY)
    return () => clearTimeout(t)
  }, [draft, dirty, save])

  // 切到后台 / 关闭页面 / 离开编辑页时立即保存
  useEffect(() => {
    const flush = () => document.visibilityState === 'hidden' && save()
    const onPageHide = () => save()
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (version.current !== savedVersion.current) {
        save()
        e.preventDefault()
      }
    }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
      save()
    }
  }, [save])

  async function addFiles(files: FileList | null) {
    if (!files?.length) return
    const list = Array.from(files)
    setProcessing((n) => n + list.length)
    for (const file of list) {
      try {
        const asset = await fileToAsset(file, { entryId: id })
        pendingAssets.current.set(asset.id, asset)
        setUrls((u) => ({ ...u, [asset.id]: assetToUrl(asset) }))
        update({ imageIds: [...draftRef.current.imageIds, asset.id] })
      } catch (err) {
        console.error('读取图片失败', err)
        setHint(`无法读取图片：${file.name}`)
      } finally {
        setProcessing((n) => n - 1)
      }
    }
    save() // 图片立即保存，不等待防抖
  }

  function removeImage(assetId: string) {
    if (pendingAssets.current.has(assetId)) pendingAssets.current.delete(assetId)
    else removedIds.current.add(assetId)
    const url = urls[assetId]
    if (url) URL.revokeObjectURL(url)
    setUrls(({ [assetId]: _, ...rest }) => rest)
    update({ imageIds: draftRef.current.imageIds.filter((x) => x !== assetId) })
  }

  function setStatus(status: EntryStatus) {
    if (status === 'done' && !draftRef.current.title.trim()) {
      setHint('标记为完成前，请先填写标题。草稿可以留空。')
      return
    }
    update({ status })
  }

  async function finish() {
    if (!(await save())) return
    navigate(meta.current.createdAt === null ? '/' : `/entry/${id}`, { replace: true })
  }

  if (!loaded) return <p className="py-20 text-center text-sm text-mute">载入中…</p>

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-10 -mx-5 mb-6 flex items-center justify-between border-b border-line bg-paper/95 px-5 py-3 backdrop-blur">
        <Link to={meta.current.createdAt === null ? '/' : `/entry/${id}`} className="text-sm text-mute">
          ← 返回
        </Link>
        <SaveIndicator state={saveState} dirty={dirty} processing={processing > 0} updatedAt={updatedAt} onRetry={save} />
        <button onClick={finish} disabled={processing > 0} className="rounded-full bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-40">
          保存
        </button>
      </div>

      <div className="mb-6 flex items-center gap-4 text-sm">
        <input
          type="date"
          value={draft.entryDate}
          onChange={(e) => e.target.value && update({ entryDate: e.target.value })}
          className="bg-transparent text-mute outline-none"
          aria-label="日记日期"
        />
        <div className="ml-auto flex overflow-hidden rounded-full border border-line text-xs">
          {(['draft', 'done'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1 ${draft.status === s ? 'bg-ink text-paper' : 'text-mute'}`}
            >
              {s === 'draft' ? '草稿' : '完成'}
            </button>
          ))}
        </div>
      </div>

      <input
        value={draft.title}
        onChange={(e) => update({ title: e.target.value })}
        placeholder="标题"
        className="mb-6 w-full bg-transparent font-serif text-3xl leading-tight outline-none placeholder:text-line"
      />

      <textarea
        ref={bodyRef}
        value={draft.body}
        onChange={(e) => update({ body: e.target.value })}
        placeholder="写下此刻的感受……"
        rows={10}
        className="min-h-60 w-full resize-none overflow-hidden bg-transparent font-serif text-[17px] leading-loose outline-none placeholder:text-line"
      />

      {hint && <p className="mt-4 text-sm text-red-700">{hint}</p>}

      <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {draft.imageIds.map((assetId) => (
          <figure key={assetId} className="relative aspect-[3/4] overflow-hidden bg-line">
            {urls[assetId] ? (
              <img src={urls[assetId]} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full items-center justify-center text-xs text-mute">图片缺失</span>
            )}
            <button
              onClick={() => removeImage(assetId)}
              className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-paper/90 text-sm"
              aria-label="移除图片"
            >
              ×
            </button>
          </figure>
        ))}
        <label className="flex aspect-[3/4] cursor-pointer flex-col items-center justify-center gap-1 border border-dashed border-mute/50 text-mute">
          <span className="text-2xl font-light">+</span>
          <span className="text-xs">{processing > 0 ? '处理中…' : '添加图片'}</span>
          <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }} />
        </label>
      </div>

      <WorkPicker value={draft.workIds} onChange={(workIds) => update({ workIds })} />
    </div>
  )
}

function SaveIndicator(props: {
  state: SaveState
  dirty: boolean
  processing: boolean
  updatedAt: number | null
  onRetry: () => void
}) {
  if (props.state === 'error')
    return (
      <button onClick={props.onRetry} className="text-xs text-red-700">
        保存失败 · 点击重试
      </button>
    )
  if (props.processing) return <span className="text-xs text-mute">处理图片…</span>
  if (props.state === 'saving') return <span className="text-xs text-mute">保存中…</span>
  if (props.dirty) return <span className="text-xs text-mute">未保存</span>
  if (props.state === 'saved' && props.updatedAt)
    return <span className="text-xs text-mute">已保存 {formatClock(props.updatedAt)}</span>
  return <span className="text-xs text-mute">新记录</span>
}
