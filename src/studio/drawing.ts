import Konva from 'konva'
import { CANVAS_HEIGHT, CANVAS_WIDTH, type DrawingElement, type Stroke, type StrokeTool } from '../db'
import { newId } from '../lib'

export interface Brush {
  tool: StrokeTool
  color: string
  width: number
  opacity: number
}

export const BRUSH_DEFAULTS: Record<StrokeTool, Brush> = {
  pen: { tool: 'pen', color: '#373735', width: 4, opacity: 1 },
  marker: { tool: 'marker', color: '#C8A15A', width: 24, opacity: 0.45 },
  eraser: { tool: 'eraser', color: '#000000', width: 30, opacity: 1 },
}

export const TOOL_LABELS: Record<StrokeTool, string> = { pen: '细笔', marker: '马克笔', eraser: '橡皮' }

export const INK_SWATCHES = ['#373735', '#9E3B2E', '#2E4A62', '#5B6B4A', '#C8A15A', '#E4A4A0', '#FFFFFF']

/** Konva.Line 的属性（编辑器与导出共用）。橡皮用 destination-out，只作用于所在绘画层的缓存画布。 */
export function strokeAttrs(s: Stroke) {
  const eraser = s.tool === 'eraser'
  return {
    points: s.points,
    stroke: eraser ? '#000' : s.color,
    strokeWidth: s.width,
    opacity: eraser ? 1 : s.opacity,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
    tension: 0.35,
    globalCompositeOperation: (eraser ? 'destination-out' : 'source-over') as GlobalCompositeOperation,
    listening: !eraser,
    hitStrokeWidth: Math.max(16, s.width),
    perfectDrawEnabled: false,
  }
}

/** 笔迹范围（相对绘画层原点，不含橡皮），已包含笔宽。没有笔迹时返回 null。 */
export function strokesBounds(strokes: Stroke[]) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const s of strokes) {
    if (s.tool === 'eraser') continue
    const r = s.width / 2
    for (let i = 0; i < s.points.length; i += 2) {
      x0 = Math.min(x0, s.points[i] - r)
      x1 = Math.max(x1, s.points[i] + r)
      y0 = Math.min(y0, s.points[i + 1] - r)
      y1 = Math.max(y1, s.points[i + 1] + r)
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 }
}

/** width / height 记录从原点到笔迹最远处的范围（用于「整个工作台」等估算）。 */
export function withDrawingBounds(el: DrawingElement): DrawingElement {
  const b = strokesBounds(el.strokes)
  return { ...el, width: Math.max(1, Math.round(b?.x1 ?? 1)), height: Math.max(1, Math.round(b?.y1 ?? 1)) }
}

export function createDrawing(z: number): DrawingElement {
  return { id: newId(), type: 'drawing', x: 0, y: 0, width: 1, height: 1, rotation: 0, z, strokes: [], style: { opacity: 1 } }
}

export const hasEraser = (el: DrawingElement) => el.strokes.some((s) => s.tool === 'eraser')

/** 单个缓存画布的像素上限，避免超出手机浏览器的画布尺寸限制。 */
const MAX_CACHE_PIXELS = 4_000_000

/**
 * 含橡皮笔迹的绘画层需要缓存成独立画布，destination-out 才只擦本层而不擦到下面的图片。
 * region 为缓存范围（本层局部坐标）；倍率受像素上限约束，放大很多时橡皮区域可能略模糊。
 */
export function cacheDrawingGroup(
  group: Konva.Group,
  el: DrawingElement,
  pixelRatio: number,
  region?: { x: number; y: number; width: number; height: number },
  force = false, // 正在用橡皮时，即使还没有橡皮笔迹也要缓存
) {
  group.clearCache()
  if (!force && !hasEraser(el)) return
  const b = strokesBounds(el.strokes)
  if (!b) return
  let r = { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 }
  if (region) {
    const x0 = Math.max(r.x, region.x)
    const y0 = Math.max(r.y, region.y)
    const x1 = Math.min(r.x + r.width, region.x + region.width)
    const y1 = Math.min(r.y + r.height, region.y + region.height)
    if (x1 <= x0 || y1 <= y0) return
    r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }
  const ratio = Math.max(0.1, Math.min(pixelRatio, Math.sqrt(MAX_CACHE_PIXELS / (r.width * r.height))))
  group.cache({ ...r, pixelRatio: ratio })
}

/**
 * 橡皮拖动过程中：把一段擦除直接画在已有缓存上，开销只与这一小段有关，不必重建整层缓存。
 * 依赖 Konva 内部的缓存结构（_getCanvasCache）；取不到时返回 false，由调用方退回整层重建。
 */
export function eraseOnCache(group: Konva.Group, from: [number, number], to: [number, number], width: number): boolean {
  const cache = (group as unknown as { _getCanvasCache?: () => { scene?: { _canvas?: HTMLCanvasElement; pixelRatio: number }; x: number; y: number } | undefined })._getCanvasCache?.()
  const canvas = cache?.scene?._canvas
  if (!cache || !canvas || typeof cache.x !== 'number') return false
  const pr = cache.scene!.pixelRatio
  const ctx = canvas.getContext('2d')!
  ctx.save()
  ctx.setTransform(pr, 0, 0, pr, -cache.x * pr, -cache.y * pr)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = ctx.lineJoin = 'round'
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(from[0], from[1])
  ctx.lineTo(to[0] + (to[0] === from[0] && to[1] === from[1] ? 0.01 : 0), to[1])
  ctx.stroke()
  ctx.restore()
  return true
}

/** 导出用：绘画层的 Konva 节点，只缓存纸张范围。 */
export function buildDrawingGroup(el: DrawingElement, pixelRatio: number): Konva.Group {
  const group = new Konva.Group({ x: el.x, y: el.y, opacity: el.style.opacity })
  for (const s of el.strokes) group.add(new Konva.Line(strokeAttrs(s)))
  cacheDrawingGroup(group, el, pixelRatio, { x: -el.x, y: -el.y, width: CANVAS_WIDTH, height: CANVAS_HEIGHT })
  return group
}

/** 复制绘画层时，每条笔画也换成新的 ID。 */
export const cloneStrokes = (strokes: Stroke[]) => strokes.map((s) => ({ ...s, id: newId() }))

/** 简化：丢掉与上一点过近的点，坐标保留一位小数。 */
export function appendPoint(points: number[], x: number, y: number, minDist: number) {
  const n = points.length
  if (n >= 2 && Math.hypot(x - points[n - 2], y - points[n - 1]) < minDist) return false
  points.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10)
  return true
}
