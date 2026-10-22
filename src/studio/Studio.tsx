import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  cleanupEntryAssets,
  db,
  loadCanvas,
  newCanvasId,
  saveCanvas,
  type CanvasElement,
  type TextElement,
  type TextPreset,
} from '../db'
import { fileToAsset, formatClock } from '../lib'
import CanvasStage from './CanvasStage'
import {
  addElement,
  createImage,
  createText,
  moveLayer,
  patchElement,
  removeElement,
  type LayerMove,
  type StudioDoc,
} from './elements'
import { ADD_TABS, AddPanel, BackgroundPanel, PropsPanel, type AddTab } from './Panels'

const AUTOSAVE_DELAY = 1000
const HISTORY_LIMIT = 100
const EMPTY: StudioDoc = { background: '#F7F6F2', elements: [] }

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type Drawer = AddTab | 'props' | 'background' | null

export default function Studio() {
  const { id = '' } = useParams()
  const entry = useLiveQuery(async () => (await db.entries.get(id)) ?? null, [id])
  const wide = useMediaQuery('(min-width: 1024px)')

  const [loaded, setLoaded] = useState(false)
  const [present, setPresent] = useState<StudioDoc>(EMPTY)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addTab, setAddTab] = useState<AddTab>('material')
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [uploading, setUploading] = useState(0)
  const [hint, setHint] = useState('')

  // —— 撤销 / 重做：保存整份快照；预览中的变化（拖滑块等）结束时才记一步 ——
  const presentRef = useRef(present)
  const past = useRef<StudioDoc[]>([])
  const future = useRef<StudioDoc[]>([])
  const previewBase = useRef<StudioDoc | null>(null)
  const [, rerender] = useState(0)

  // —— 保存 ——
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [dirty, setDirty] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const createdAt = useRef<number | null>(null)
  const version = useRef(0)
  const savedVersion = useRef(0)
  const inFlight = useRef<Promise<boolean> | null>(null)

  const setDoc = useCallback((next: StudioDoc) => {
    presentRef.current = next
    setPresent(next)
    version.current++
    setDirty(true)
  }, [])

  /** mode = 'preview'：只更新画面；'commit'：完成一次操作，记入撤销历史。 */
  const update = useCallback(
    (fn: (doc: StudioDoc) => StudioDoc, mode: 'preview' | 'commit' = 'commit') => {
      const cur = presentRef.current
      const next = fn(cur)
      if (mode === 'preview') {
        if (!previewBase.current) previewBase.current = cur
        setDoc(next)
        return
      }
      const base = previewBase.current ?? cur
      previewBase.current = null
      if (next === base) return
      past.current = [...past.current, base].slice(-HISTORY_LIMIT)
      future.current = []
      if (next !== cur) setDoc(next)
      else rerender((n) => n + 1)
    },
    [setDoc],
  )

  const undo = useCallback(() => {
    if (previewBase.current) update((d) => d) // 先结束未完成的预览
    const prev = past.current.at(-1)
    if (!prev) return
    past.current = past.current.slice(0, -1)
    future.current = [presentRef.current, ...future.current]
    setEditingId(null)
    setDoc(prev)
  }, [setDoc, update])

  const redo = useCallback(() => {
    const next = future.current[0]
    if (!next) return
    future.current = future.current.slice(1)
    past.current = [...past.current, presentRef.current]
    setEditingId(null)
    setDoc(next)
  }, [setDoc])

  const save = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current
    const run = async () => {
      while (version.current !== savedVersion.current) {
        const v = version.current
        const doc = presentRef.current
        const now = Date.now()
        const created = createdAt.current ?? now
        setSaveState('saving')
        try {
          await saveCanvas(
            { id: newCanvasId(id), entryId: id, format: 1, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, ...doc, assetIds: [], createdAt: created, updatedAt: now },
            [],
          )
        } catch (err) {
          console.error('画布保存失败', err)
          setSaveState('error')
          return false
        }
        createdAt.current = created
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

  // 读取画布；打开前先清理之前从画布上删掉、已无引用的本地图片
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await cleanupEntryAssets(id).catch((err) => console.warn('清理未引用图片失败', err))
      const doc = await loadCanvas(id)
      if (cancelled) return
      if (doc) {
        createdAt.current = doc.createdAt
        presentRef.current = { background: doc.background, elements: doc.elements }
        setPresent(presentRef.current)
        setUpdatedAt(doc.updatedAt)
        setSaveState('saved')
      }
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  // 停止操作 1 秒后自动保存；拖动过程中不写库，只在松手提交后保存
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(save, AUTOSAVE_DELAY)
    return () => clearTimeout(t)
  }, [present, dirty, save])

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

  // —— 图片加载：从素材库读取，显示用的临时 URL 在离开时释放 ——
  const [images, setImages] = useState(() => new Map<string, HTMLImageElement | null>())
  const imageJobs = useRef(new Map<string, Promise<HTMLImageElement | null>>())
  const objectUrls = useRef<string[]>([])
  useEffect(() => () => objectUrls.current.forEach(URL.revokeObjectURL), [])

  const ensureImage = useCallback((assetId: string) => {
    let job = imageJobs.current.get(assetId)
    if (!job) {
      job = (async () => {
        const asset = await db.assets.get(assetId)
        if (!asset) return null
        const url = URL.createObjectURL(new Blob([asset.data], { type: asset.mimeType }))
        objectUrls.current.push(url)
        const img = new Image()
        img.src = url
        try {
          await img.decode()
          return img
        } catch {
          return null
        }
      })()
      imageJobs.current.set(assetId, job)
      job.then((img) => setImages((m) => new Map(m).set(assetId, img)))
    }
    return job
  }, [])

  useEffect(() => {
    present.elements.forEach((el) => el.type === 'image' && ensureImage(el.assetId))
  }, [present.elements, ensureImage])

  // —— 元素操作 ——
  const selected = present.elements.find((el) => el.id === selectedId) ?? null

  function add(el: CanvasElement) {
    update((d) => ({ ...d, elements: addElement(d.elements, el) }))
    setSelectedId(el.id)
    setEditingId(null)
    if (!wide) setDrawer(null)
  }

  async function addImage(assetId: string) {
    const img = await ensureImage(assetId)
    if (!img) return setHint('这张图片无法读取。')
    add(createImage(assetId, img.naturalWidth, img.naturalHeight, presentRef.current.elements.length))
  }

  async function upload(files: FileList) {
    const list = Array.from(files)
    setUploading((n) => n + list.length)
    for (const file of list) {
      try {
        const asset = await fileToAsset(file, { entryId: id })
        await db.assets.put(asset) // 只被画布引用，不加入日记图片
        await addImage(asset.id)
      } catch (err) {
        console.error('添加图片失败', err)
        setHint(`无法添加图片：${file.name}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const addText = (preset: TextPreset, text?: string) => add(createText(preset, text, presentRef.current.elements.length))

  const patch = useCallback(
    (elId: string, p: Partial<CanvasElement>, mode: 'preview' | 'commit' = 'commit') =>
      update((d) => (Object.keys(p).length ? { ...d, elements: patchElement(d.elements, elId, p) } : d), mode),
    [update],
  )

  const remove = useCallback(
    (elId: string) => {
      update((d) => ({ ...d, elements: removeElement(d.elements, elId) }))
      setSelectedId(null)
      setEditingId(null)
    },
    [update],
  )

  const layer = (elId: string, move: LayerMove) => update((d) => ({ ...d, elements: moveLayer(d.elements, elId, move) }))

  function endEdit(elId: string, text: string) {
    setEditingId(null)
    const el = presentRef.current.elements.find((e) => e.id === elId)
    if (!el || el.type !== 'text') return
    if (!text.trim()) return remove(elId) // 文字清空即删除该文字块
    if (text !== el.text) patch(elId, { text } as Partial<TextElement>)
  }

  // —— 快捷键：输入框内（含输入法组合中）一律交给浏览器 ——
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        redo()
      } else if (mod || e.altKey) {
        return // 其余组合键保持浏览器默认行为
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        remove(selectedId)
      } else if (e.key === 'Escape') {
        setSelectedId(null)
      } else if (e.key === 'Enter' && selected?.type === 'text') {
        e.preventDefault()
        setEditingId(selected.id)
      } else if (e.key.startsWith('Arrow') && selected) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
        if (d) patch(selected.id, { x: selected.x + d[0], y: selected.y + d[1] })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, remove, patch, selected, selectedId])

  // —— 画布显示尺寸：按容器大小缩放，数据始终是逻辑坐标 ——
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0.5)
  useEffect(() => {
    if (!box) return
    const ro = new ResizeObserver(([e]) => {
      const pad = wide ? 48 : 24
      const s = Math.min((e.contentRect.width - pad) / CANVAS_WIDTH, (e.contentRect.height - pad) / CANVAS_HEIGHT)
      setScale(Math.max(0.1, s))
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [box, wide])

  if (entry === null)
    return (
      <p className="py-20 text-center text-sm text-mute">
        这篇记录不存在。<Link to="/" className="underline">回到首页</Link>
      </p>
    )
  if (!entry || !loaded) return <p className="py-20 text-center text-sm text-mute">载入中…</p>

  const naturalRatio = (() => {
    if (selected?.type !== 'image') return null
    const img = images.get(selected.assetId)
    return img ? img.naturalHeight / img.naturalWidth : null
  })()

  const addPanel = (tab: AddTab) => (
    <AddPanel tab={tab} entry={entry} uploading={uploading > 0} onAddImage={addImage} onUpload={upload} onAddText={addText} />
  )
  const propsPanel = selected && (
    <PropsPanel
      key={selected.id}
      el={selected}
      naturalRatio={naturalRatio}
      onPreview={(p) => patch(selected.id, p, 'preview')}
      onCommit={(p) => patch(selected.id, p)}
      onLayer={(m) => layer(selected.id, m)}
      onDelete={() => remove(selected.id)}
      onEditText={() => {
        setEditingId(selected.id)
        if (!wide) setDrawer(null)
      }}
    />
  )
  const backgroundPanel = (
    <BackgroundPanel
      value={present.background}
      onPreview={(c) => update((d) => ({ ...d, background: c }), 'preview')}
      onCommit={(c) => update((d) => ({ ...d, background: c }))}
    />
  )

  const stage = (
    <div ref={setBox} className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#ECEAE4]">
      <div className="shadow-[0_1px_12px_rgba(55,55,53,0.12)]">
        <CanvasStage
          doc={present}
          scale={scale}
          images={images}
          selectedId={selectedId}
          editingId={editingId}
          onSelect={(sel) => {
            setSelectedId(sel)
            if (sel !== editingId) setEditingId(null)
          }}
          onEditStart={(elId) => {
            setSelectedId(elId)
            setEditingId(elId)
          }}
          onEditEnd={endEdit}
          onPreview={(elId, p) => patch(elId, p, 'preview')}
          onCommit={(elId, p) => patch(elId, p)}
        />
      </div>
    </div>
  )

  const topBar = (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-paper px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
      <Link to={`/entry/${id}`} className="text-sm text-mute">← 返回</Link>
      <div className="min-w-0 flex-1 truncate text-center">
        <span className="font-serif">创作桌</span>
        {wide && <span className="ml-2 text-xs tracking-[0.2em] text-mute uppercase">Studio · {entry.title || '无标题'}</span>}
      </div>
      <SaveIndicator state={saveState} dirty={dirty} updatedAt={updatedAt} onRetry={save} />
      <div className="flex gap-1">
        <IconButton label="撤销" disabled={!past.current.length && !previewBase.current} onClick={undo}>
          <ArrowIcon />
        </IconButton>
        <IconButton label="重做" disabled={!future.current.length} onClick={redo}>
          <ArrowIcon flip />
        </IconButton>
      </div>
    </header>
  )

  const hintLine = hint && (
    <p role="alert" className="bg-paper px-4 py-2 text-sm text-red-700" onClick={() => setHint('')}>
      {hint}
    </p>
  )

  if (wide)
    return (
      <div className="flex h-dvh flex-col bg-paper">
        {topBar}
        {hintLine}
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r border-line">
            <nav className="flex border-b border-line text-sm">
              {ADD_TABS.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setAddTab(t.value)}
                  className={`flex-1 py-2.5 ${addTab === t.value ? 'border-b border-ink' : 'text-mute'}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">{addPanel(addTab)}</div>
            <p className="border-t border-line p-3 text-[11px] leading-relaxed text-mute">
              ⌘/Ctrl+Z 撤销 · ⇧+⌘/Ctrl+Z 重做 · Delete 删除 · 方向键微调 · Enter 编辑文字 · Esc 取消选择
            </p>
          </aside>
          {stage}
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-line p-4">
            {propsPanel ?? (
              <div className="space-y-6">
                {backgroundPanel}
                <p className="text-sm leading-relaxed text-mute">点选画布上的元素以调整属性；双击文字直接编辑。</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    )

  // —— 手机 / 平板竖屏：画布居中，工具在底部抽屉 ——
  const drawerTitle = drawer && ({ props: '元素属性', background: '画布背景' } as Record<string, string>)[drawer]
  return (
    <div className="flex h-dvh flex-col bg-paper">
      {topBar}
      {hintLine}
      {stage}
      {drawer && (
        <section className="max-h-[48dvh] shrink-0 overflow-y-auto border-t border-ink bg-paper px-4 pt-3 pb-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-serif">{drawerTitle ?? ADD_TABS.find((t) => t.value === drawer)?.label}</span>
            <button onClick={() => setDrawer(null)} className="text-sm text-mute">收起</button>
          </div>
          {drawer === 'props' ? (propsPanel ?? <p className="text-sm text-mute">先在画布上点选一个元素。</p>) : drawer === 'background' ? backgroundPanel : addPanel(drawer)}
        </section>
      )}
      <nav className="flex shrink-0 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] text-sm">
        {ADD_TABS.map((t) => (
          <ToolButton key={t.value} on={drawer === t.value} onClick={() => setDrawer(drawer === t.value ? null : t.value)}>
            {t.label === '草稿素材' ? '素材' : t.label}
          </ToolButton>
        ))}
        {selected ? (
          <>
            <ToolButton on={drawer === 'props'} onClick={() => setDrawer(drawer === 'props' ? null : 'props')}>属性</ToolButton>
            <ToolButton on={false} onClick={() => remove(selected.id)} danger>删除</ToolButton>
          </>
        ) : (
          <ToolButton on={drawer === 'background'} onClick={() => setDrawer(drawer === 'background' ? null : 'background')}>背景</ToolButton>
        )}
      </nav>
    </div>
  )
}

function ToolButton({ on, danger, onClick, children }: { on: boolean; danger?: boolean; onClick: () => void; children: string }) {
  return (
    <button onClick={onClick} className={`flex-1 py-3 ${on ? 'bg-ink text-paper' : danger ? 'text-red-700' : ''}`}>
      {children}
    </button>
  )
}

function ArrowIcon({ flip }: { flip?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M5 3 2 6l3 3" />
      <path d="M2 6h7.5a4 4 0 0 1 0 8H7" />
    </svg>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-line disabled:opacity-30"
    >
      {children}
    </button>
  )
}

function SaveIndicator({ state, dirty, updatedAt, onRetry }: { state: SaveState; dirty: boolean; updatedAt: number | null; onRetry: () => void }) {
  const cls = 'shrink-0 text-xs text-mute'
  if (state === 'error')
    return (
      <button onClick={onRetry} className="shrink-0 text-xs text-red-700">
        保存失败 · 重试
      </button>
    )
  if (state === 'saving') return <span className={cls}>保存中…</span>
  if (dirty) return <span className={cls}>未保存</span>
  if (state === 'saved' && updatedAt) return <span className={cls}>已保存 {formatClock(updatedAt)}</span>
  return <span className={cls}>空白画布</span>
}

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}
