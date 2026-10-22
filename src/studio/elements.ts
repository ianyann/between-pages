import Konva from 'konva'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type CanvasElement,
  type ImageElement,
  type TextElement,
  type TextPreset,
  type TextStyle,
} from '../db'
import { newId } from '../lib'
import { cloneStrokes, withDrawingBounds } from './drawing'

/** 画布可编辑的部分（撤销 / 重做的快照单位）。 */
export interface StudioDoc {
  background: string
  elements: CanvasElement[] // 按 z 从下到上
}

export const FONT_STACKS = {
  serif: '"Songti SC", "Noto Serif SC", "Source Han Serif SC", STSong, "Noto Serif CJK SC", serif',
  sans: '-apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Noto Sans CJK SC", sans-serif',
}

export const TEXT_PRESETS: Record<TextPreset, { label: string; sample: string; width: number; style: TextStyle }> = {
  title: {
    label: '标题',
    sample: '标题',
    width: 760,
    style: { preset: 'title', fontFamily: 'serif', fontSize: 64, fontWeight: 'normal', color: '#373735', align: 'left', lineHeight: 1.25, letterSpacing: 4 },
  },
  body: {
    label: '正文',
    sample: '在这里写正文',
    width: 520,
    style: { preset: 'body', fontFamily: 'serif', fontSize: 26, fontWeight: 'normal', color: '#373735', align: 'left', lineHeight: 1.8, letterSpacing: 0 },
  },
  note: {
    label: '批注',
    sample: '批注',
    width: 240,
    style: { preset: 'note', fontFamily: 'sans', fontSize: 18, fontWeight: 'normal', color: '#8a8984', align: 'left', lineHeight: 1.5, letterSpacing: 1 },
  },
}

export const COLOR_SWATCHES = ['#373735', '#8a8984', '#F7F6F2', '#FFFFFF', '#9E3B2E', '#2E4A62', '#5B6B4A', '#C8A15A']
export const BACKGROUND_SWATCHES = ['#F7F6F2', '#FFFFFF', '#EFEBE3', '#E4E0D6', '#DCE1E3', '#373735', '#1F2A36']

/** 文字块的实际高度（随内容和宽度自动换行而变化）。 */
export function measureTextHeight(el: Pick<TextElement, 'text' | 'width' | 'style'>): number {
  const node = new Konva.Text(textAttrs(el))
  const h = node.height()
  node.destroy()
  return Math.max(1, Math.round(h))
}

/** Konva.Text 的公共属性（画布渲染与测量共用，保证两处一致）。 */
export function textAttrs(el: Pick<TextElement, 'text' | 'width' | 'style'>) {
  return {
    text: el.text,
    width: el.width,
    fontSize: el.style.fontSize,
    fontFamily: FONT_STACKS[el.style.fontFamily],
    fontStyle: el.style.fontWeight,
    fill: el.style.color,
    align: el.style.align,
    lineHeight: el.style.lineHeight,
    letterSpacing: el.style.letterSpacing,
    wrap: 'word' as const,
  }
}

export function withMeasuredHeight(el: TextElement): TextElement {
  return { ...el, height: measureTextHeight(el) }
}

export interface Point {
  x: number
  y: number
}

/** 默认放在纸张中上部；工作台中通常传入当前视图中心。 */
export const PAPER_CENTER: Point = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 - 120 }

/** 新元素以 at 为中心放置，连续添加时错开，避免完全重叠。 */
function placement(width: number, height: number, count: number, at: Point) {
  const offset = (count % 6) * 28 - 70
  return { x: Math.round(at.x - width / 2 + offset), y: Math.round(at.y - height / 2 + offset) }
}

export function createText(preset: TextPreset, text: string | undefined, count: number, at: Point = PAPER_CENTER): TextElement {
  const p = TEXT_PRESETS[preset]
  const base = { text: text?.trim() || p.sample, width: p.width, style: { ...p.style } }
  const height = measureTextHeight(base)
  return { id: newId(), type: 'text', ...base, height, rotation: 0, z: count, ...placement(p.width, height, count, at) }
}

/** 默认缩放：保持原始宽高比，长边不超过画布的 60%。 */
export function createImage(
  assetId: string,
  naturalWidth: number,
  naturalHeight: number,
  count: number,
  at: Point = PAPER_CENTER,
  exact = false, // true：正好以 at 为中心（拖放到指定位置时）
): ImageElement {
  const nw = naturalWidth || 600
  const nh = naturalHeight || 600
  const k = Math.min(1, (CANVAS_WIDTH * 0.6) / nw, (CANVAS_HEIGHT * 0.6) / nh)
  const width = Math.round(nw * k)
  const height = Math.round(nh * k)
  const pos = exact ? { x: Math.round(at.x - width / 2), y: Math.round(at.y - height / 2) } : placement(width, height, count, at)
  return { id: newId(), type: 'image', assetId, width, height, rotation: 0, z: count, style: { opacity: 1 }, ...pos }
}

const renumber = (els: CanvasElement[]) => els.map((el, i) => (el.z === i ? el : { ...el, z: i }))

export type LayerMove = 'top' | 'up' | 'down' | 'bottom'

export function moveLayer(els: CanvasElement[], id: string, move: LayerMove): CanvasElement[] {
  const i = els.findIndex((el) => el.id === id)
  if (i < 0) return els
  const list = [...els]
  const [el] = list.splice(i, 1)
  const to = { top: list.length, bottom: 0, up: Math.min(list.length, i + 1), down: Math.max(0, i - 1) }[move]
  list.splice(to, 0, el)
  return renumber(list)
}

export function addElement(els: CanvasElement[], el: CanvasElement): CanvasElement[] {
  return renumber([...els, el])
}

/** 复制：新的元素 ID，共用同一素材（绘画层的每条笔画也换新 ID），略微错开并放在最上层。 */
export function duplicateElement(el: CanvasElement): CanvasElement {
  const copy = { ...el, id: newId(), x: el.x + 24, y: el.y + 24 }
  return copy.type === 'drawing' ? { ...copy, strokes: cloneStrokes(copy.strokes) } : copy
}

export function removeElement(els: CanvasElement[], id: string): CanvasElement[] {
  return renumber(els.filter((el) => el.id !== id))
}

export function patchElement(els: CanvasElement[], id: string, patch: Partial<CanvasElement>): CanvasElement[] {
  return els.map((el) => {
    if (el.id !== id) return el
    const next = { ...el, ...patch } as CanvasElement
    return next.type === 'text' ? withMeasuredHeight(next) : next.type === 'drawing' ? withDrawingBounds(next) : next
  })
}

/** 绕元素中心缩放 k 倍并旋转到 rotation（双指手势用）。文字同时放大字号。 */
export function scaleRotateAroundCenter(el: CanvasElement, k: number, rotation: number): Partial<CanvasElement> {
  const rad = (el.rotation * Math.PI) / 180
  const cx = el.x + (el.width / 2) * Math.cos(rad) - (el.height / 2) * Math.sin(rad)
  const cy = el.y + (el.width / 2) * Math.sin(rad) + (el.height / 2) * Math.cos(rad)
  const width = Math.max(20, el.width * k)
  const height = Math.max(20, el.height * k)
  const r2 = (rotation * Math.PI) / 180
  const x = cx - (width / 2) * Math.cos(r2) + (height / 2) * Math.sin(r2)
  const y = cy - (width / 2) * Math.sin(r2) - (height / 2) * Math.cos(r2)
  const patch: Partial<CanvasElement> = { x, y, width, height, rotation }
  if (el.type === 'text') (patch as Partial<TextElement>).style = { ...el.style, fontSize: Math.max(6, Math.round(el.style.fontSize * k)) }
  return patch
}
