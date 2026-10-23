import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  BOX_CATEGORIES,
  db,
  type BoxCategory,
  type BoxItem,
  type CanvasElement,
  type DrawingElement,
  type Entry,
  type ImageElement,
  type StrokeTool,
  type TextElement,
  type TextPreset,
  type TextStyle,
} from '../db'
import { useAssetUrl } from '../lib'
import { ASSET_DRAG_TYPE } from './CanvasStage'
import { INK_SWATCHES, TOOL_LABELS, type Brush } from './drawing'
import { decorationAssetId, decorationPreview, DECORATION_GROUPS, DECORATIONS } from './decorations'
import { BACKGROUND_SWATCHES, COLOR_SWATCHES, TEXT_PRESETS, type LayerMove } from './elements'

export type AddTab = 'box' | 'deco' | 'text' | 'material'

export const ADD_TABS: { value: AddTab; label: string }[] = [
  { value: 'box', label: '素材盒' },
  { value: 'deco', label: '装饰' },
  { value: 'text', label: '文字' },
  { value: 'material', label: '日记素材' },
]

const sectionTitle = 'mb-3 text-xs tracking-[0.2em] text-mute'
const chip = 'rounded-full border border-line px-3 py-1 text-sm hover:border-ink'

/** 桌面端可把缩略图直接拖到工作台上（手机上点按添加）。 */
const dragProps = (assetId: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    e.dataTransfer.setData(ASSET_DRAG_TYPE, assetId)
    e.dataTransfer.effectAllowed = 'copy'
  },
})

// —— 左侧：添加素材 ——

interface AddProps {
  tab: AddTab
  entry: Entry
  importing: number
  onAddImage: (assetId: string) => void
  onImport: (files: FileList, category: BoxCategory) => void
  onAddText: (preset: TextPreset, text?: string) => void
}

export function AddPanel({ tab, entry, importing, onAddImage, onImport, onAddText }: AddProps) {
  if (tab === 'box') return <BoxPanel importing={importing} onAddImage={onAddImage} onImport={onImport} />
  if (tab === 'deco') return <DecorationPanel onAddImage={onAddImage} />

  if (tab === 'text')
    return (
      <div className="space-y-3">
        <p className={sectionTitle}>文字样式</p>
        {(Object.keys(TEXT_PRESETS) as TextPreset[]).map((p) => (
          <button
            key={p}
            onClick={() => onAddText(p)}
            className="block w-full border border-line px-4 py-3 text-left hover:border-ink"
            style={{
              fontFamily: TEXT_PRESETS[p].style.fontFamily === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)',
              fontSize: { title: 26, body: 16, note: 13 }[p],
              color: TEXT_PRESETS[p].style.color,
              letterSpacing: p === 'title' ? '0.1em' : undefined,
            }}
          >
            添加{TEXT_PRESETS[p].label}
          </button>
        ))}
        <p className="pt-2 text-xs leading-relaxed text-mute">双击画布上的文字可直接编辑。</p>
      </div>
    )

  return <Materials entry={entry} onAddImage={onAddImage} onAddText={onAddText} />
}

/** 素材盒：跨日记复用的图片收藏。缩略图来自 boxItems，不加载原图。 */
function BoxPanel({ importing, onAddImage, onImport }: Pick<AddProps, 'importing' | 'onAddImage' | 'onImport'>) {
  const items = useLiveQuery(() => db.boxItems.orderBy('addedAt').reverse().toArray(), [])
  const withPsd = new Set(useLiveQuery(async () => (await db.proEdits.toArray()).filter((p) => p.psdAssetId).map((p) => p.id), []) ?? [])
  const [filter, setFilter] = useState<BoxCategory | 'all'>('all')
  const [importCategory, setImportCategory] = useState<BoxCategory>('其他')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = items?.filter((it) => (filter === 'all' || it.category === filter) && it.name.toLowerCase().includes(q))

  return (
    <div className="space-y-5">
      <div className="border border-dashed border-mute/60 p-3">
        <div role="group" aria-label="导入到分类" className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-mute">放入</span>
          {BOX_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setImportCategory(c)}
              className={`rounded-full border px-2 py-0.5 ${importCategory === c ? 'border-ink bg-ink text-paper' : 'border-line'}`}
            >
              {c}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center justify-center py-2 text-sm">
          {importing > 0 ? `正在导入 ${importing} 张…` : '+ 一次导入多张图片'}
          <input
            id="box-import"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) onImport(e.target.files, importCategory)
              e.target.value = ''
            }}
          />
        </label>
        <p className="text-center text-[11px] text-mute">JPG / PNG / WebP，透明 PNG 保留透明</p>
      </div>

      <div className="space-y-2">
        <input
          id="box-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按文件名搜索"
          className="w-full border-b border-line bg-transparent py-1 outline-none placeholder:text-mute/60 focus:border-ink"
        />
        <div role="group" aria-label="按分类筛选" className="flex flex-wrap gap-1.5 text-xs">
          {(['all', ...BOX_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`rounded-full border px-2.5 py-0.5 ${filter === c ? 'border-ink bg-ink text-paper' : 'border-line text-mute'}`}
            >
              {c === 'all' ? '全部' : c}
            </button>
          ))}
        </div>
      </div>

      {shown === undefined ? null : items!.length === 0 ? (
        <p className="text-sm leading-relaxed text-mute">素材盒还是空的。导入的图片可以在任何一篇日记的工作台里重复使用。</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-mute">没有符合条件的素材。</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {shown.map((it) => (
            <BoxThumb key={it.id} item={it} hasPsd={withPsd.has(it.id)} onClick={() => onAddImage(it.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function BoxThumb({ item, hasPsd, onClick }: { item: BoxItem; hasPsd: boolean; onClick: () => void }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // 在同一个 effect 里创建并释放临时 URL，避免被提前释放
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([item.thumb], { type: item.thumbType }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [item.thumb, item.thumbType])
  return (
    <div className="relative">
      <button
        {...dragProps(item.id)}
        onClick={onClick}
        title={item.name}
        aria-label={`添加素材 ${item.name}`}
        className="checker block aspect-square w-full overflow-hidden border border-line"
      >
        {url && <img src={url} alt="" draggable={false} className="h-full w-full object-contain" />}
      </button>
      {hasPsd && <span className="pointer-events-none absolute bottom-1 left-1 bg-ink px-1 text-[9px] text-paper">PSD</span>}
      <button
        onClick={() => navigate(`/pro/${item.id}?from=${encodeURIComponent(pathname)}`)}
        aria-label={`使用专业编辑器打开 ${item.name}`}
        title="使用专业编辑器打开（第三方 Photopea，实验）"
        className="absolute top-1 right-1 rounded-full border border-line bg-paper/90 px-1.5 text-[10px] leading-4"
      >
        专业
      </button>
    </div>
  )
}

function DecorationPanel({ onAddImage }: { onAddImage: (assetId: string) => void }) {
  return (
    <div className="space-y-6">
      {DECORATION_GROUPS.map((g) => (
        <div key={g}>
          <p className={sectionTitle}>{g}</p>
          <div className="grid grid-cols-2 gap-2">
            {DECORATIONS.filter((d) => d.group === g).map((d) => (
              <button
                key={d.key}
                {...dragProps(decorationAssetId(d.key))}
                onClick={() => onAddImage(decorationAssetId(d.key))}
                aria-label={`添加装饰 ${d.label}`}
                className="checker flex h-20 items-center justify-center overflow-hidden border border-line p-2"
              >
                <img src={decorationPreview(d)} alt="" draggable={false} className="max-h-full max-w-full" />
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs leading-relaxed text-mute">装饰和图片一样可以叠放、旋转、缩放，并在属性中调整透明度。</p>
    </div>
  )
}

function EntryImages({ entry, onAddImage }: { entry: Entry; onAddImage: (id: string) => void }) {
  return (
    <div>
      <p className={sectionTitle}>日记图片</p>
      {entry.imageIds.length === 0 ? (
        <p className="text-sm text-mute">这篇日记还没有图片。</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {entry.imageIds.map((id) => (
            <Thumb key={id} assetId={id} onClick={() => onAddImage(id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function Thumb({ assetId, onClick }: { assetId: string; onClick: () => void }) {
  const url = useAssetUrl(assetId)
  return (
    <button {...dragProps(assetId)} onClick={onClick} className="aspect-square overflow-hidden bg-line" aria-label="把这张图片放进画布">
      {url && <img src={url} alt="" className="h-full w-full object-contain" />}
    </button>
  )
}

/** 草稿素材：日记标题、正文、图片与关联作品。放入画布的是副本，修改不会影响日记本身。 */
function Materials({ entry, onAddImage, onAddText }: Pick<AddProps, 'entry' | 'onAddImage' | 'onAddText'>) {
  const works = useLiveQuery(async () => (await db.works.bulkGet(entry.workIds)).filter((w) => w !== undefined), [entry.workIds.join()])
  const paragraphs = entry.body.split(/\n+/).map((p) => p.trim()).filter(Boolean)

  return (
    <div className="space-y-7">
      <div>
        <p className={sectionTitle}>标题</p>
        {entry.title ? (
          <MaterialText text={entry.title} serif onAdd={() => onAddText('title', entry.title)} />
        ) : (
          <p className="text-sm text-mute">无标题</p>
        )}
      </div>
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <p className={sectionTitle.replace('mb-3 ', '')}>正文</p>
          {paragraphs.length > 1 && (
            <button onClick={() => onAddText('body', entry.body)} className="text-xs text-mute underline">
              添加全文
            </button>
          )}
        </div>
        {paragraphs.length === 0 ? (
          <p className="text-sm text-mute">没有正文</p>
        ) : (
          <div className="space-y-2">
            {paragraphs.map((p, i) => (
              <MaterialText key={i} text={p} onAdd={() => onAddText('body', p)} />
            ))}
          </div>
        )}
      </div>
      <EntryImages entry={entry} onAddImage={onAddImage} />
      <div>
        <p className={sectionTitle}>关联作品</p>
        {works?.length ? (
          <div className="flex flex-wrap gap-2">
            {works.map((w) => (
              <button key={w.id} onClick={() => onAddText('note', `《${w.name.replace(/^《|》$/g, '')}》`)} className={chip}>
                + {w.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-mute">未关联作品</p>
        )}
      </div>
    </div>
  )
}

function MaterialText({ text, serif, onAdd }: { text: string; serif?: boolean; onAdd: () => void }) {
  return (
    <button onClick={onAdd} className="flex w-full gap-2 border border-line p-2.5 text-left text-sm hover:border-ink">
      <span className={`line-clamp-3 min-w-0 flex-1 ${serif ? 'font-serif text-base' : ''}`}>{text}</span>
      <span className="shrink-0 text-mute">+</span>
    </button>
  )
}

// —— 右侧：属性 ——

interface PropsPanelProps {
  el: CanvasElement
  naturalRatio: number | null // 图片原始宽高比
  onPreview: (patch: Partial<CanvasElement>) => void
  onCommit: (patch: Partial<CanvasElement>) => void
  onLayer: (move: LayerMove) => void
  onDelete: () => void
  onEditText: () => void
  onCutout: () => void // 图片：打开剪裁
  onDraw: () => void // 绘画层：继续绘画
  isCutout: boolean // 图片是否为剪裁结果
}

export function PropsPanel(p: PropsPanelProps) {
  const { el } = p
  return (
    <div className="space-y-7">
      {el.type === 'text' ? <TextProps {...p} el={el} /> : el.type === 'image' ? <ImageProps {...p} el={el} /> : <DrawingProps {...p} el={el} />}

      <Field label="图层">
        <div className="grid grid-cols-4 gap-1.5 text-xs">
          {([['top', '置顶'], ['up', '上移'], ['down', '下移'], ['bottom', '置底']] as const).map(([m, label]) => (
            <button key={m} onClick={() => p.onLayer(m)} className="border border-line py-1.5 hover:border-ink">
              {label}
            </button>
          ))}
        </div>
      </Field>

      <div className="flex items-center justify-between text-sm">
        {Math.round(el.rotation) % 360 !== 0 ? (
          <button onClick={() => p.onCommit({ rotation: 0 })} className="text-mute underline">旋转归零（{Math.round(el.rotation)}°）</button>
        ) : (
          <span />
        )}
        <button onClick={p.onDelete} className="text-red-700">删除元素</button>
      </div>
    </div>
  )
}

function TextProps({ el, onPreview, onCommit, onEditText }: PropsPanelProps & { el: TextElement }) {
  const [draft, setDraft] = useState(el.text)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(el.text)
  }, [el.text])

  const style = (patch: Partial<TextStyle>, commit = true) =>
    (commit ? onCommit : onPreview)({ style: { ...el.style, ...patch } } as Partial<TextElement>)

  return (
    <>
      <Field label="文字内容">
        <textarea
          id="studio-text-content"
          value={draft}
          rows={4}
          onFocus={() => (focused.current = true)}
          onChange={(e) => setDraft(e.target.value)}
          // 失焦时才写回画布：中文输入法组合期间不会提交半成品
          onBlur={() => {
            focused.current = false
            if (draft !== el.text) onCommit({ text: draft } as Partial<TextElement>)
          }}
          className="w-full resize-y border border-line bg-transparent p-2 leading-relaxed outline-none focus:border-ink"
        />
        <button onClick={onEditText} className="mt-1 text-xs text-mute underline">在画布上编辑</button>
      </Field>

      <Field label="样式">
        <div className="flex gap-1.5">
          {(Object.keys(TEXT_PRESETS) as TextPreset[]).map((k) => (
            <button
              key={k}
              onClick={() => onCommit({ style: { ...TEXT_PRESETS[k].style } } as Partial<TextElement>)}
              className={`flex-1 border py-1.5 text-xs ${el.style.preset === k ? 'border-ink' : 'border-line'}`}
            >
              {TEXT_PRESETS[k].label}
            </button>
          ))}
        </div>
      </Field>

      <Slider
        label="字号"
        value={el.style.fontSize}
        min={8}
        max={160}
        onPreview={(v) => style({ fontSize: v }, false)}
        onCommit={() => onCommit({})}
      />

      <Field label="颜色">
        <ColorPicker swatches={COLOR_SWATCHES} value={el.style.color} onPreview={(c) => style({ color: c }, false)} onCommit={(c) => style({ color: c })} />
      </Field>

      <Field label="排版">
        <div className="grid grid-cols-3 gap-1.5 text-xs">
          {([['left', '左对齐'], ['center', '居中'], ['right', '右对齐']] as const).map(([a, label]) => (
            <Toggle key={a} on={el.style.align === a} onClick={() => style({ align: a })}>{label}</Toggle>
          ))}
          <Toggle on={el.style.fontFamily === 'serif'} onClick={() => style({ fontFamily: 'serif' })}>宋体</Toggle>
          <Toggle on={el.style.fontFamily === 'sans'} onClick={() => style({ fontFamily: 'sans' })}>黑体</Toggle>
          <Toggle on={el.style.fontWeight === 'bold'} onClick={() => style({ fontWeight: el.style.fontWeight === 'bold' ? 'normal' : 'bold' })}>加粗</Toggle>
        </div>
      </Field>

      <Slider label="行距" value={el.style.lineHeight} min={1} max={2.6} step={0.05} format={(v) => v.toFixed(2)} onPreview={(v) => style({ lineHeight: v }, false)} onCommit={() => onCommit({})} />
      <Slider label="字距" value={el.style.letterSpacing} min={-2} max={24} onPreview={(v) => style({ letterSpacing: v }, false)} onCommit={() => onCommit({})} />
    </>
  )
}

function DrawingProps({ el, onPreview, onCommit, onDraw }: PropsPanelProps & { el: DrawingElement }) {
  const count = el.strokes.filter((s) => s.tool !== 'eraser').length
  return (
    <>
      <p className="text-sm">绘画层 · {count} 条笔迹</p>
      <button onClick={onDraw} className="w-full border border-ink py-2 text-sm">继续在这一层绘画</button>
      <Slider
        label="整体不透明度"
        value={Math.round(el.style.opacity * 100)}
        min={5}
        max={100}
        format={(v) => `${v}%`}
        onPreview={(v) => onPreview({ style: { opacity: v / 100 } } as Partial<DrawingElement>)}
        onCommit={() => onCommit({})}
      />
    </>
  )
}

function ImageProps({ el, naturalRatio, onPreview, onCommit, onCutout, isCutout }: PropsPanelProps & { el: ImageElement }) {
  return (
    <>
      <button onClick={onCutout} className="w-full border border-ink py-2 text-sm">
        {isCutout ? '继续编辑剪裁' : '剪裁（自由轮廓 / 擦除）'}
      </button>
      <Slider
        label="不透明度"
        value={Math.round(el.style.opacity * 100)}
        min={5}
        max={100}
        format={(v) => `${v}%`}
        onPreview={(v) => onPreview({ style: { opacity: v / 100 } } as Partial<ImageElement>)}
        onCommit={() => onCommit({})}
      />
      {naturalRatio && Math.abs(el.height / el.width - naturalRatio) > 0.01 && (
        <button onClick={() => onCommit({ height: Math.round(el.width * naturalRatio) })} className="text-sm text-mute underline">
          恢复原始比例
        </button>
      )}
    </>
  )
}

// —— 背景 ——

export function BackgroundPanel({ value, onPreview, onCommit }: { value: string; onPreview: (c: string) => void; onCommit: (c: string) => void }) {
  return (
    <Field label="画布背景">
      <ColorPicker swatches={BACKGROUND_SWATCHES} value={value} onPreview={onPreview} onCommit={onCommit} />
    </Field>
  )
}

// —— 小部件 ——

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className={sectionTitle}>{label}</p>
      {children}
    </div>
  )
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`border py-1.5 ${on ? 'border-ink bg-ink text-paper' : 'border-line'}`}>
      {children}
    </button>
  )
}

/** 拖动时预览（不进撤销历史），松手时提交一次。 */
function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onPreview: (v: number) => void
  onCommit: () => void
}) {
  return (
    <div>
      <div className="mb-2 flex justify-between">
        <span className={sectionTitle.replace('mb-3 ', '')}>{props.label}</span>
        <span className="text-xs text-mute tabular-nums">{props.format ? props.format(props.value) : Math.round(props.value)}</span>
      </div>
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onPreview(Number(e.target.value))}
        onPointerUp={props.onCommit}
        onKeyUp={props.onCommit}
        onBlur={props.onCommit}
        className="w-full accent-ink"
      />
    </div>
  )
}

function ColorPicker({ swatches, value, onPreview, onCommit }: { swatches: string[]; value: string; onPreview: (c: string) => void; onCommit: (c: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  // 原生 change 事件在取色器关闭时触发一次，用来提交；input 事件只用于预览
  useEffect(() => {
    const input = inputRef.current!
    const handler = () => onCommit(input.value)
    input.addEventListener('change', handler)
    return () => input.removeEventListener('change', handler)
  }, [onCommit])
  return (
    <div className="flex flex-wrap items-center gap-2">
      {swatches.map((c) => (
        <button
          key={c}
          onClick={() => onCommit(c)}
          aria-label={`颜色 ${c}`}
          className={`h-7 w-7 rounded-full border ${value.toLowerCase() === c.toLowerCase() ? 'border-ink ring-2 ring-ink ring-offset-2 ring-offset-paper' : 'border-line'}`}
          style={{ background: c }}
        />
      ))}
      <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-line" title="自定义颜色" style={{ background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}>
        <input ref={inputRef} type="color" aria-label="自定义颜色" value={value.length === 7 ? value : '#373735'} onChange={(e) => onPreview(e.target.value)} className="absolute inset-0 opacity-0" />
      </label>
    </div>
  )
}

// —— 绘画工具条（浮在画布上方） ——

export function DrawToolbar(p: {
  tool: StrokeTool
  brush: Brush
  hasLayer: boolean
  onTool: (t: StrokeTool) => void
  onBrush: (b: Partial<Brush>) => void
  onNewLayer: () => void
  onClear: () => void
  onDone: () => void
}) {
  const eraser = p.tool === 'eraser'
  return (
    <div
      role="toolbar"
      aria-label="绘画工具"
      className="absolute inset-x-3 top-3 mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-paper/95 px-3 py-2 text-xs shadow-sm backdrop-blur"
    >
      <div className="flex overflow-hidden rounded-full border border-line">
        {(['pen', 'marker', 'eraser'] as const).map((t) => (
          <button key={t} onClick={() => p.onTool(t)} className={`px-3 py-1.5 ${p.tool === t ? 'bg-ink text-paper' : ''}`}>
            {TOOL_LABELS[t]}
          </button>
        ))}
      </div>
      {!eraser && (
        <div className="flex items-center gap-1.5">
          {INK_SWATCHES.map((c) => (
            <button
              key={c}
              onClick={() => p.onBrush({ color: c })}
              aria-label={`笔色 ${c}`}
              className={`h-5 w-5 rounded-full border ${p.brush.color.toLowerCase() === c.toLowerCase() ? 'ring-2 ring-ink ring-offset-1 ring-offset-paper' : 'border-line'}`}
              style={{ background: c }}
            />
          ))}
          <label className="relative h-5 w-5 cursor-pointer overflow-hidden rounded-full border border-line" style={{ background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}>
            <input type="color" aria-label="自定义笔色" value={p.brush.color} onChange={(e) => p.onBrush({ color: e.target.value })} className="absolute inset-0 opacity-0" />
          </label>
        </div>
      )}
      <label className="flex items-center gap-1.5">
        <span className="text-mute">粗细</span>
        <input type="range" aria-label="笔刷粗细" min={1} max={eraser ? 120 : 80} value={p.brush.width} onChange={(e) => p.onBrush({ width: Number(e.target.value) })} className="w-20 accent-ink" />
        <span className="w-6 tabular-nums">{p.brush.width}</span>
      </label>
      {!eraser && (
        <label className="flex items-center gap-1.5">
          <span className="text-mute">透明度</span>
          <input type="range" aria-label="笔刷不透明度" min={10} max={100} value={Math.round(p.brush.opacity * 100)} onChange={(e) => p.onBrush({ opacity: Number(e.target.value) / 100 })} className="w-16 accent-ink" />
        </label>
      )}
      <div className="ml-auto flex items-center gap-3">
        <button onClick={p.onNewLayer} className="text-mute underline">新绘画层</button>
        <button onClick={p.onClear} disabled={!p.hasLayer} className="text-red-700 disabled:opacity-30">清除本层</button>
        <button onClick={p.onDone} className="rounded-full bg-ink px-3 py-1.5 text-paper">完成</button>
      </div>
    </div>
  )
}
