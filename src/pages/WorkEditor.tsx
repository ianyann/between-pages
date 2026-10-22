import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { db, saveWork, WORK_TYPES, type Asset, type Work, type WorkType } from '../db'
import { assetToUrl, fileToAsset, newId } from '../lib'

/** 新增 / 编辑作品。作品字段少，采用手动保存。 */
export default function WorkEditor() {
  const params = useParams()
  const navigate = useNavigate()
  const [id] = useState(() => params.id ?? newId())

  const [loaded, setLoaded] = useState(!params.id)
  const [existing, setExisting] = useState<Work | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<WorkType>('manga')
  const [coverId, setCoverId] = useState<string | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [newCover, setNewCover] = useState<Asset | null>(null)
  const [state, setState] = useState<'idle' | 'processing' | 'saving' | 'error'>('idle')
  const [hint, setHint] = useState('')

  const coverUrlRef = useRef(coverUrl)
  function showCover(url: string | null) {
    if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current)
    coverUrlRef.current = url
    setCoverUrl(url)
  }
  useEffect(() => () => showCover(null), [])

  useEffect(() => {
    if (!params.id) return
    let cancelled = false
    ;(async () => {
      const work = await db.works.get(params.id!)
      if (cancelled) return
      if (work) {
        const asset = work.coverAssetId ? await db.assets.get(work.coverAssetId) : undefined
        if (cancelled) return
        setExisting(work)
        setName(work.name)
        setType(work.type)
        setCoverId(work.coverAssetId)
        showCover(asset ? assetToUrl(asset) : null)
      }
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [params.id])

  async function pickCover(file: File | undefined) {
    if (!file) return
    setState('processing')
    try {
      const asset = await fileToAsset(file, { workId: id })
      setNewCover(asset)
      setCoverId(asset.id)
      showCover(assetToUrl(asset))
      setState('idle')
    } catch (err) {
      console.error('读取封面失败', err)
      setHint(`无法读取图片：${file.name}`)
      setState('idle')
    }
  }

  function removeCover() {
    setNewCover(null)
    setCoverId(null)
    showCover(null)
  }

  async function save() {
    if (!name.trim()) return setHint('请填写作品名称。')
    setState('saving')
    const now = Date.now()
    try {
      await saveWork(
        { id, name: name.trim(), type, coverAssetId: coverId, createdAt: existing?.createdAt ?? now, updatedAt: now },
        newCover && newCover.id === coverId ? newCover : null,
      )
      navigate(`/work/${id}`, { replace: true })
    } catch (err) {
      console.error('保存作品失败', err)
      setState('error')
    }
  }

  if (!loaded) return <p className="py-20 text-center text-sm text-mute">载入中…</p>
  if (params.id && !existing)
    return (
      <p className="py-20 text-center text-sm text-mute">
        这部作品不存在。<Link to="/library" className="underline">回到作品馆</Link>
      </p>
    )

  const busy = state === 'processing' || state === 'saving'

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-10 -mx-5 mb-8 flex items-center justify-between border-b border-line bg-paper/95 px-5 py-3 backdrop-blur">
        <Link to={existing ? `/work/${id}` : '/library'} className="text-sm text-mute">← 取消</Link>
        <span className="text-xs text-mute">
          {state === 'saving' ? '保存中…' : state === 'error' ? '保存失败，请重试' : existing ? '编辑作品' : '新增作品'}
        </span>
        <button onClick={save} disabled={busy} className="rounded-full bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-40">
          保存
        </button>
      </div>

      <div className="flex flex-col gap-8 sm:flex-row">
        <div className="w-40 shrink-0">
          <label className="block aspect-[3/4] cursor-pointer overflow-hidden border border-dashed border-mute/50">
            {coverUrl ? (
              <img src={coverUrl} alt="封面预览" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full flex-col items-center justify-center gap-1 text-mute">
                <span className="text-2xl font-light">+</span>
                <span className="text-xs">{state === 'processing' ? '处理中…' : '上传封面'}</span>
              </span>
            )}
            <input
              id="work-cover"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                pickCover(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
          {coverId && (
            <button onClick={removeCover} className="mt-2 text-xs text-mute">移除封面</button>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-8">
          <label className="block">
            <span className="mb-2 block text-xs tracking-[0.2em] text-mute">作品名称</span>
            <input
              id="work-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setHint('')
              }}
              placeholder="例如：同情的形式"
              className="w-full border-b border-line bg-transparent pb-2 font-serif text-2xl outline-none placeholder:text-line focus:border-ink"
            />
          </label>
          <div>
            <span className="mb-3 block text-xs tracking-[0.2em] text-mute">类型</span>
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
          </div>
          {hint && <p className="text-sm text-red-700">{hint}</p>}
        </div>
      </div>
    </div>
  )
}
