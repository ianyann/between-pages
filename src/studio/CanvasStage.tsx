import Konva from 'konva'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Image as KImage, Layer, Rect, Stage, Text as KText, Transformer } from 'react-konva'
import { CANVAS_HEIGHT, CANVAS_WIDTH, DESK, type CanvasElement, type TextElement } from '../db'
import { FONT_STACKS, scaleRotateAroundCenter, textAttrs, type LayerMove, type StudioDoc } from './elements'

// 一根手指拖动元素时，第二根手指落下仍能触发事件（双指缩放需要）
Konva.hitOnDragEnabled = true

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const TEXT_SIDE_ANCHORS = ['middle-left', 'middle-right']
const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const ANCHOR_SIZE = COARSE ? 22 : 10
const ROTATE_OFFSET = COARSE ? 36 : 26
const TR_PADDING = COARSE ? 14 : 2 // 触屏手柄较大：与元素留出间距，避免小元素被手柄盖住

export const DESK_COLOR = '#E6E2D9'
export const MIN_ZOOM = 0.08
export const MAX_ZOOM = 4
export const ASSET_DRAG_TYPE = 'application/x-between-pages-asset'

/**
 * 视图变换（不保存）：屏幕坐标 = 世界坐标 × zoom + (x, y)。
 * 元素数据始终是世界坐标，窗口大小、缩放、平移都不会改变它。
 */
export interface View {
  zoom: number
  x: number
  y: number
}

/** 保证桌面至少有一部分留在屏幕内，避免平移到找不回来。 */
export function clampView(v: View, w: number, h: number): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom))
  const keep = 80
  const left = DESK.x * zoom
  const right = (DESK.x + DESK.width) * zoom
  const top = DESK.y * zoom
  const bottom = (DESK.y + DESK.height) * zoom
  return {
    zoom,
    x: Math.min(w - keep - left, Math.max(keep - right, v.x)),
    y: Math.min(h - keep - top, Math.max(keep - bottom, v.y)),
  }
}

interface Props {
  doc: StudioDoc
  width: number // 容器像素尺寸
  height: number
  view: View
  images: Map<string, HTMLImageElement | null>
  selectedId: string | null
  editingId: string | null
  onViewChange: (v: View) => void
  onSelect: (id: string | null) => void
  onEditStart: (id: string) => void
  onEditEnd: (id: string, text: string) => void
  onPreview: (id: string, patch: Partial<CanvasElement>) => void // 过程中的变化，不进撤销历史
  onCommit: (id: string, patch: Partial<CanvasElement>) => void // 一次完整操作
  onDuplicate: (id: string) => void
  onLayer: (id: string, move: LayerMove) => void
  onDelete: (id: string) => void
  onDropAsset: (assetId: string, world: { x: number; y: number }) => void
}

export default function CanvasStage(props: Props) {
  const { doc, width, height, view, images, selectedId, editingId } = props
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const selected = doc.elements.find((el) => el.id === selectedId)
  const [interacting, setInteracting] = useState(false) // 拖动 / 变换 / 双指中隐藏快捷操作

  // 选中元素变化时挂载变换框；编辑文字时隐藏
  useEffect(() => {
    const tr = trRef.current
    if (!tr) return
    const node = selected && editingId !== selected.id ? stageRef.current?.findOne('#' + selected.id) : undefined
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selected, editingId, doc])

  const toWorld = (sx: number, sy: number) => ({ x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom })

  // —— 视图：滚轮平移，Ctrl/⌘ + 滚轮（含触控板双指捏合）缩放 ——
  function onWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault()
    const p = stageRef.current?.getPointerPosition()
    if (!p) return
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // 触控板捏合的 delta 很小，鼠标滚轮一格约 100：限制单次变化，避免一格就缩放到底
      const d = Math.max(-40, Math.min(40, e.evt.deltaY))
      const zoom = view.zoom * Math.exp(-d * 0.01)
      const w = toWorld(p.x, p.y)
      props.onViewChange(clampView({ zoom, x: p.x - w.x * zoom, y: p.y - w.y * zoom }, width, height))
    } else {
      props.onViewChange(clampView({ ...view, x: view.x - e.evt.deltaX, y: view.y - e.evt.deltaY }, width, height))
    }
  }

  // —— 双指：选中元素时缩放 / 旋转元素；否则缩放 / 平移视图 ——
  const pinch = useRef<
    | { kind: 'element'; dist: number; angle: number; el: CanvasElement }
    | { kind: 'view'; dist: number; mid: { x: number; y: number }; world: { x: number; y: number }; zoom: number }
    | null
  >(null)
  const lastPinchPatch = useRef<Partial<CanvasElement> | null>(null)

  function touchInfo(e: TouchEvent) {
    const [a, b] = [e.touches[0], e.touches[1]]
    const rect = stageRef.current!.container().getBoundingClientRect()
    return {
      dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      angle: (Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180) / Math.PI,
      mid: { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top },
    }
  }

  function onTouchStart(e: Konva.KonvaEventObject<TouchEvent>) {
    if (e.evt.touches.length === 2) {
      const stage = stageRef.current!
      stage.stopDrag()
      const t = touchInfo(e.evt)
      if (selected) {
        stage.findOne('#' + selected.id)?.stopDrag()
        pinch.current = { kind: 'element', dist: t.dist, angle: t.angle, el: selected }
      } else {
        pinch.current = { kind: 'view', dist: t.dist, mid: t.mid, world: toWorld(t.mid.x, t.mid.y), zoom: view.zoom }
      }
      lastPinchPatch.current = null
      setInteracting(true)
      return
    }
    deselectOnEmpty(e)
  }

  function onTouchMove(e: Konva.KonvaEventObject<TouchEvent>) {
    const p = pinch.current
    if (!p || e.evt.touches.length < 2) return
    e.evt.preventDefault()
    const now = touchInfo(e.evt)
    if (p.kind === 'element') {
      const patch = scaleRotateAroundCenter(p.el, now.dist / p.dist, p.el.rotation + now.angle - p.angle)
      lastPinchPatch.current = patch
      props.onPreview(p.el.id, patch)
    } else {
      const zoom = p.zoom * (now.dist / p.dist)
      props.onViewChange(clampView({ zoom, x: now.mid.x - p.world.x * zoom, y: now.mid.y - p.world.y * zoom }, width, height))
    }
  }

  function onTouchEnd(e: Konva.KonvaEventObject<TouchEvent>) {
    const p = pinch.current
    if (!p || e.evt.touches.length >= 2) return
    if (p.kind === 'element' && lastPinchPatch.current) props.onCommit(p.el.id, lastPinchPatch.current)
    pinch.current = null
    setInteracting(false)
  }

  function deselectOnEmpty(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    const t = e.target
    if (t === t.getStage() || t.name() === 'desk' || t.name() === 'paper') props.onSelect(null)
  }

  // —— 拖动与变换：结束时一次性提交 ——
  function commitNode(el: CanvasElement, node: Konva.Node) {
    const sx = node.scaleX()
    const sy = node.scaleY()
    node.scale({ x: 1, y: 1 })
    const base = { x: node.x(), y: node.y(), rotation: node.rotation() }
    if (el.type === 'image') {
      props.onCommit(el.id, { ...base, width: Math.max(10, node.width() * sx), height: Math.max(10, node.height() * sy) })
    } else {
      const k = Math.abs(sy - 1) > 0.001 ? sy : 1 // 角点缩放时字号同比变化，侧边只改宽度
      props.onCommit(el.id, {
        ...base,
        width: Math.max(24, node.width() * sx),
        style: { ...el.style, fontSize: Math.max(6, Math.round(el.style.fontSize * k)) },
      } as Partial<TextElement>)
    }
    setInteracting(false)
  }

  function onTextTransform(node: Konva.Text) {
    // 拖动侧边时实时改宽度，让文字重新换行而不是被拉伸
    const anchor = trRef.current?.getActiveAnchor() ?? ''
    if (TEXT_SIDE_ANCHORS.includes(anchor)) {
      node.setAttrs({ width: Math.max(24, node.width() * node.scaleX()), scaleX: 1, scaleY: 1 })
    }
  }

  /** 元素中心保持在桌面范围内，避免拖到桌面外找不回来。 */
  function clampToDesk(el: CanvasElement, x: number, y: number) {
    const cx = Math.min(DESK.x + DESK.width, Math.max(DESK.x, x + el.width / 2))
    const cy = Math.min(DESK.y + DESK.height, Math.max(DESK.y, y + el.height / 2))
    return { x: cx - el.width / 2, y: cy - el.height / 2 }
  }

  const common = (el: CanvasElement) => ({
    id: el.id,
    x: el.x,
    y: el.y,
    rotation: el.rotation,
    draggable: editingId !== el.id,
    onMouseDown: () => props.onSelect(el.id),
    onTap: () => props.onSelect(el.id),
    onDragStart: () => {
      props.onSelect(el.id)
      setInteracting(true)
    },
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
      e.cancelBubble = true // 不当作平移桌面
      setInteracting(false)
      props.onCommit(el.id, clampToDesk(el, e.target.x(), e.target.y()))
    },
    onTransformStart: () => setInteracting(true),
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => commitNode(el, e.target),
  })

  // —— 快捷操作条：放在元素与旋转手柄上方，空间不足时放在下方，不遮挡元素 ——
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarPos, setToolbarPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const node = selected && !editingId && !interacting ? stageRef.current?.findOne('#' + selected.id) : undefined
    if (!node) return setToolbarPos(null)
    const r = node.getClientRect() // 屏幕像素，已包含旋转与视图变换
    const tb = toolbarRef.current
    const tw = tb?.offsetWidth ?? 280
    const th = tb?.offsetHeight ?? 36
    const above = r.y - TR_PADDING - ROTATE_OFFSET - ANCHOR_SIZE / 2 - 8 - th
    const below = r.y + r.height + TR_PADDING + ANCHOR_SIZE / 2 + 8
    const top = above >= 4 ? above : below + th <= height - 4 ? below : Math.max(4, above)
    const left = Math.min(width - tw - 4, Math.max(4, r.x + r.width / 2 - tw / 2))
    setToolbarPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }))
  }, [selected, editingId, interacting, doc, view, width, height])

  const editing = doc.elements.find((el): el is TextElement => el.id === editingId && el.type === 'text')

  return (
    <div
      className="relative overflow-hidden"
      style={{ width, height, touchAction: 'none' }}
      onDragOver={(e) => e.dataTransfer.types.includes(ASSET_DRAG_TYPE) && e.preventDefault()}
      onDrop={(e) => {
        const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE)
        if (!assetId) return
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        props.onDropAsset(assetId, toWorld(e.clientX - rect.left, e.clientY - rect.top))
      }}
    >
      <Stage
        ref={stageRef}
        width={width}
        height={height}
        x={view.x}
        y={view.y}
        scaleX={view.zoom}
        scaleY={view.zoom}
        draggable // 在空白处拖动 = 平移桌面
        dragBoundFunc={(pos) => {
          const v = clampView({ ...view, x: pos.x, y: pos.y }, width, height)
          return { x: v.x, y: v.y }
        }}
        onDragMove={(e) => {
          if (e.target === stageRef.current) props.onViewChange({ ...view, x: e.target.x(), y: e.target.y() })
        }}
        onDragEnd={(e) => {
          if (e.target === stageRef.current) props.onViewChange({ ...view, x: e.target.x(), y: e.target.y() })
        }}
        onWheel={onWheel}
        onMouseDown={deselectOnEmpty}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <Layer>
          <Rect name="desk" x={DESK.x} y={DESK.y} width={DESK.width} height={DESK.height} fill={DESK_COLOR} />
          <Rect
            name="paper"
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            fill={doc.background}
            shadowColor="#373735"
            shadowOpacity={0.18}
            shadowBlur={24}
            shadowOffsetY={4}
          />
          {doc.elements.map((el) =>
            el.type === 'image' ? (
              images.get(el.assetId) ? (
                <KImage key={el.id} {...common(el)} image={images.get(el.assetId)!} width={el.width} height={el.height} opacity={el.style.opacity} />
              ) : (
                <Rect key={el.id} {...common(el)} width={el.width} height={el.height} fill="#d6d2c8" opacity={el.style.opacity} />
              )
            ) : (
              <KText
                key={el.id}
                {...common(el)}
                {...textAttrs(el)}
                visible={editingId !== el.id}
                onDblClick={() => props.onEditStart(el.id)}
                onDblTap={() => props.onEditStart(el.id)}
                onTransform={(e) => onTextTransform(e.target as Konva.Text)}
              />
            ),
          )}
          {/* 纸张边界辅助线：画在元素之上，被遮住时也能看出纸张范围；不参与导出 */}
          <Rect
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            stroke="#373735"
            strokeWidth={1}
            strokeScaleEnabled={false}
            dash={[6, 6]}
            opacity={0.35}
            listening={false}
          />
          <Transformer
            ref={trRef}
            keepRatio
            flipEnabled={false}
            enabledAnchors={selected?.type === 'text' ? [...CORNER_ANCHORS, ...TEXT_SIDE_ANCHORS] : CORNER_ANCHORS}
            rotationSnaps={[0, 90, 180, 270]}
            rotationSnapTolerance={4}
            anchorSize={ANCHOR_SIZE}
            padding={TR_PADDING}
            rotateAnchorOffset={ROTATE_OFFSET}
            anchorStroke="#373735"
            anchorFill="#F7F6F2"
            anchorCornerRadius={COARSE ? 11 : 2}
            borderStroke="#373735"
            borderDash={[4, 3]}
            ignoreStroke
            boundBoxFunc={(oldBox, box) => (Math.abs(box.width) < 24 || Math.abs(box.height) < 12 ? oldBox : box)}
          />
        </Layer>
      </Stage>

      {selected && !editing && (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="快捷操作"
          className="absolute flex divide-x divide-line rounded-full border border-line bg-paper/95 text-xs shadow-sm backdrop-blur"
          style={{ left: toolbarPos?.left ?? -9999, top: toolbarPos?.top ?? -9999, visibility: toolbarPos ? 'visible' : 'hidden' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(
            [
              ['复制', () => props.onDuplicate(selected.id)],
              ['上移', () => props.onLayer(selected.id, 'up')],
              ['下移', () => props.onLayer(selected.id, 'down')],
              ['置顶', () => props.onLayer(selected.id, 'top')],
              ['置底', () => props.onLayer(selected.id, 'bottom')],
              ['删除', () => props.onDelete(selected.id)],
            ] as const
          ).map(([label, run]) => (
            <button key={label} onClick={run} className={`px-2.5 py-2 ${label === '删除' ? 'text-red-700' : ''}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <TextEditor key={editing.id} el={editing} view={view} onDone={(text) => props.onEditEnd(editing.id, text)} />
      )}
    </div>
  )
}

/**
 * 覆盖在文字块上的原生输入框。中文输入法组合输入期间（拼音未确认）不响应 Esc / ⌘↩，
 * 失焦时若仍在组合，等组合结束再提交，避免丢字或提前退出。
 */
function TextEditor({ el, view, onDone }: { el: TextElement; view: View; onDone: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const finishAfterComposition = useRef(false)
  const finished = useRef(false)

  const finish = () => {
    if (finished.current || !ref.current) return
    finished.current = true
    onDone(ref.current.value)
  }

  const autosize = () => {
    const t = ref.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = `${t.scrollHeight}px`
  }

  useEffect(() => {
    const t = ref.current!
    t.focus({ preventScroll: true })
    t.select()
    autosize()
  }, [])

  // iOS 在输入框字号小于 16px 时会放大整页：字号不足时用 16px 渲染再整体缩小
  const scale = view.zoom
  const fontPx = el.style.fontSize * scale
  const zoom = Math.min(1, fontPx / 16)
  const style: CSSProperties = {
    position: 'absolute',
    left: view.x + el.x * scale,
    top: view.y + el.y * scale,
    width: (el.width * scale) / zoom,
    transform: `rotate(${el.rotation}deg) scale(${zoom})`,
    transformOrigin: 'top left',
    fontSize: fontPx / zoom,
    fontFamily: FONT_STACKS[el.style.fontFamily],
    fontWeight: el.style.fontWeight,
    lineHeight: el.style.lineHeight,
    letterSpacing: (el.style.letterSpacing * scale) / zoom,
    textAlign: el.style.align,
    color: el.style.color,
    background: 'rgba(247,246,242,0.85)',
    outline: '1px dashed #373735',
    border: 0,
    padding: 0,
    margin: 0,
    resize: 'none',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }

  return (
    <textarea
      ref={ref}
      id="canvas-text-editor"
      aria-label="编辑文字"
      defaultValue={el.text}
      style={style}
      onInput={autosize}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => {
        composing.current = false
        if (finishAfterComposition.current) finish()
      }}
      onKeyDown={(e) => {
        e.stopPropagation() // 编辑时不触发画布快捷键
        if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          finish()
        }
      }}
      onBlur={() => {
        if (composing.current) {
          finishAfterComposition.current = true
          setTimeout(finish, 500) // 个别浏览器失焦后不再派发 compositionend
        } else finish()
      }}
    />
  )
}
