import Konva from 'konva'
import { useEffect, useRef, type CSSProperties } from 'react'
import { Image as KImage, Layer, Rect, Stage, Text as KText, Transformer } from 'react-konva'
import { CANVAS_HEIGHT, CANVAS_WIDTH, type CanvasElement, type TextElement } from '../db'
import { FONT_STACKS, scaleRotateAroundCenter, textAttrs, type StudioDoc } from './elements'

// 一根手指拖动元素时，第二根手指落下仍能触发事件（双指缩放需要）
Konva.hitOnDragEnabled = true

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const TEXT_SIDE_ANCHORS = ['middle-left', 'middle-right']
const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

interface Props {
  doc: StudioDoc
  scale: number // 显示倍率 = 屏幕像素 / 逻辑像素；只影响显示，不影响数据
  images: Map<string, HTMLImageElement | null>
  selectedId: string | null
  editingId: string | null
  onSelect: (id: string | null) => void
  onEditStart: (id: string) => void
  onEditEnd: (id: string, text: string) => void
  onPreview: (id: string, patch: Partial<CanvasElement>) => void // 过程中的变化，不进撤销历史
  onCommit: (id: string, patch: Partial<CanvasElement>) => void // 一次完整操作
}

export default function CanvasStage(props: Props) {
  const { doc, scale, images, selectedId, editingId } = props
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const selected = doc.elements.find((el) => el.id === selectedId)

  // 选中元素变化时挂载变换框；编辑文字时隐藏
  useEffect(() => {
    const tr = trRef.current
    if (!tr) return
    const node = selected && editingId !== selected.id ? stageRef.current?.findOne('#' + selected.id) : undefined
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selected, editingId, doc])

  // —— 双指缩放 / 旋转选中元素 ——
  const pinch = useRef<{ dist: number; angle: number; el: CanvasElement } | null>(null)
  const lastPinchPatch = useRef<Partial<CanvasElement> | null>(null)

  function touchInfo(e: TouchEvent) {
    const [a, b] = [e.touches[0], e.touches[1]]
    return {
      dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      angle: (Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180) / Math.PI,
    }
  }

  function onTouchStart(e: Konva.KonvaEventObject<TouchEvent>) {
    if (e.evt.touches.length === 2 && selected) {
      stageRef.current?.findOne('#' + selected.id)?.stopDrag()
      pinch.current = { ...touchInfo(e.evt), el: selected }
      lastPinchPatch.current = null
      return
    }
    deselectOnEmpty(e)
  }

  function onTouchMove(e: Konva.KonvaEventObject<TouchEvent>) {
    const p = pinch.current
    if (!p || e.evt.touches.length < 2) return
    e.evt.preventDefault()
    const now = touchInfo(e.evt)
    const patch = scaleRotateAroundCenter(p.el, now.dist / p.dist, p.el.rotation + now.angle - p.angle)
    lastPinchPatch.current = patch
    props.onPreview(p.el.id, patch)
  }

  function onTouchEnd(e: Konva.KonvaEventObject<TouchEvent>) {
    if (!pinch.current || e.evt.touches.length >= 2) return
    if (lastPinchPatch.current) props.onCommit(pinch.current.el.id, lastPinchPatch.current)
    pinch.current = null
  }

  function deselectOnEmpty(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    const t = e.target
    if (t === t.getStage() || t.name() === 'background') props.onSelect(null)
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
  }

  function onTextTransform(node: Konva.Text) {
    // 拖动侧边时实时改宽度，让文字重新换行而不是被拉伸
    const anchor = trRef.current?.getActiveAnchor() ?? ''
    if (TEXT_SIDE_ANCHORS.includes(anchor)) {
      node.setAttrs({ width: Math.max(24, node.width() * node.scaleX()), scaleX: 1, scaleY: 1 })
    }
  }

  const common = (el: CanvasElement) => ({
    id: el.id,
    x: el.x,
    y: el.y,
    rotation: el.rotation,
    draggable: editingId !== el.id,
    onMouseDown: () => props.onSelect(el.id),
    onTap: () => props.onSelect(el.id),
    onDragStart: () => props.onSelect(el.id),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => props.onCommit(el.id, { x: e.target.x(), y: e.target.y() }),
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => commitNode(el, e.target),
  })

  const editing = doc.elements.find((el): el is TextElement => el.id === editingId && el.type === 'text')

  return (
    <div className="relative" style={{ width: CANVAS_WIDTH * scale, height: CANVAS_HEIGHT * scale, touchAction: 'none' }}>
      <Stage
        ref={stageRef}
        width={CANVAS_WIDTH * scale}
        height={CANVAS_HEIGHT * scale}
        scaleX={scale}
        scaleY={scale}
        onMouseDown={deselectOnEmpty}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <Layer>
          <Rect name="background" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill={doc.background} />
          {doc.elements.map((el) =>
            el.type === 'image' ? (
              images.get(el.assetId) ? (
                <KImage key={el.id} {...common(el)} image={images.get(el.assetId)!} width={el.width} height={el.height} opacity={el.style.opacity} />
              ) : (
                <Rect key={el.id} {...common(el)} width={el.width} height={el.height} fill="#e2e0d9" opacity={el.style.opacity} />
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
          <Transformer
            ref={trRef}
            keepRatio
            flipEnabled={false}
            enabledAnchors={selected?.type === 'text' ? [...CORNER_ANCHORS, ...TEXT_SIDE_ANCHORS] : CORNER_ANCHORS}
            rotationSnaps={[0, 90, 180, 270]}
            rotationSnapTolerance={4}
            anchorSize={COARSE ? 22 : 10}
            // 触屏手柄较大：与元素留出间距，避免小元素被手柄完全盖住而无法拖动或双击
            padding={COARSE ? 14 : 2}
            rotateAnchorOffset={COARSE ? 36 : 26}
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
      {editing && (
        <TextEditor key={editing.id} el={editing} scale={scale} onDone={(text) => props.onEditEnd(editing.id, text)} />
      )}
    </div>
  )
}

/**
 * 覆盖在文字块上的原生输入框。中文输入法组合输入期间（拼音未确认）不响应 Esc / ⌘↩，
 * 失焦时若仍在组合，等组合结束再提交，避免丢字或提前退出。
 */
function TextEditor({ el, scale, onDone }: { el: TextElement; scale: number; onDone: (text: string) => void }) {
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
  const fontPx = el.style.fontSize * scale
  const zoom = Math.min(1, fontPx / 16)
  const style: CSSProperties = {
    position: 'absolute',
    left: el.x * scale,
    top: el.y * scale,
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
