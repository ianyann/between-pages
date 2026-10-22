import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { db, type CanvasElement, type Entry, type ImageElement, type TextElement, type TextPreset, type TextStyle } from '../db'
import { useAssetUrl } from '../lib'
import { BACKGROUND_SWATCHES, COLOR_SWATCHES, TEXT_PRESETS, type LayerMove } from './elements'

export type AddTab = 'image' | 'text' | 'material'

export const ADD_TABS: { value: AddTab; label: string }[] = [
  { value: 'image', label: '图片' },
  { value: 'text', label: '文字' },
  { value: 'material', label: '草稿素材' },
]

const sectionTitle = 'mb-3 text-xs tracking-[0.2em] text-mute'
const chip = 'rounded-full border border-line px-3 py-1 text-sm hover:border-ink'

// —— 左侧：添加素材 ——

interface AddProps {
  tab: AddTab
  entry: Entry
  uploading: boolean
  onAddImage: (assetId: string) => void
  onUpload: (files: FileList) => void
  onAddText: (preset: TextPreset, text?: string) => void
}

export function AddPanel({ tab, entry, uploading, onAddImage, onUpload, onAddText }: AddProps) {
  if (tab === 'image')
    return (
      <div className="space-y-6">
        <label className="flex cursor-pointer items-center justify-center border border-dashed border-mute/60 py-4 text-sm text-mute">
          {uploading ? '正在处理图片…' : '+ 从本地添加图片'}
          <input
            id="studio-upload"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) onUpload(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
        <EntryImages entry={entry} onAddImage={onAddImage} />
      </div>
    )

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
    <button onClick={onClick} className="aspect-square overflow-hidden bg-line" aria-label="把这张图片放进画布">
      {url && <img src={url} alt="" className="h-full w-full object-contain" />}
    </button>
  )
}

/** 草稿素材：日记标题、正文、图片与关联作品。放入画布的是副本，修改不会影响日记本身。 */
function Materials({ entry, onAddImage, onAddText }: Omit<AddProps, 'tab' | 'uploading' | 'onUpload'>) {
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
}

export function PropsPanel(p: PropsPanelProps) {
  const { el } = p
  return (
    <div className="space-y-7">
      {el.type === 'text' ? <TextProps {...p} el={el} /> : <ImageProps {...p} el={el} />}

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

function ImageProps({ el, naturalRatio, onPreview, onCommit }: PropsPanelProps & { el: ImageElement }) {
  return (
    <>
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
