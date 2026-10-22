import { useCallback, useEffect, useRef, useState } from 'react'
import { db, saveCutout, type Box } from '../db'
import { makeThumb, newId } from '../lib'

/**
 * 剪裁编辑器：原图像素从不修改，所有操作都只改一张与原图同尺寸的透明遮罩。
 * 结果 = 原图 × 遮罩，裁到可见范围后另存为透明 PNG；遮罩本身也保存，可随时重新编辑。
 */

type Tool = 'lasso' | 'erase' | 'restore' | 'pan'
const TOOLS: { value: Tool; label: string; hint: string }[] = [
  { value: 'lasso', label: '轮廓', hint: '沿人物轮廓画一圈，松开后自动闭合，只保留圈内部分。' },
  { value: 'erase', label: '擦除', hint: '涂抹去掉不要的部分（只改遮罩，原图不变）。' },
  { value: 'restore', label: '恢复', hint: '涂抹找回被去掉的部分。' },
  { value: 'pan', label: '移动', hint: '拖动查看；也可以双指或滚轮缩放。' },
]
const HISTORY_LIMIT = 12 // 每步只存透明通道（宽×高 字节）
const DPR = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1

interface View {
  zoom: number
  x: number
  y: number
}

export interface CutoutResult {
  assetId: string
  isNew: boolean
  oldBox?: Box
  newBox: Box
}

export default function CutoutEditor(props: {
  sourceAssetId: string
  cutoutId: string | null // 继续编辑已有剪裁时传入
  onCancel: () => void
  onSaved: (r: CutoutResult) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const src = useRef<HTMLImageElement | null>(null)
  const srcName = useRef('')
  const mask = useRef<HTMLCanvasElement | null>(null)
  const comp = useRef<HTMLCanvasElement | null>(null)
  const view = useRef<View>({ zoom: 1, x: 0, y: 0 })
  const size = useRef({ w: 0, h: 0 })
  const path = useRef<number[]>([]) // 最近一次闭合轮廓
  const usedLasso = useRef(false)
  const oldBox = useRef<Box | undefined>(undefined)
  const createdAt = useRef(Date.now())

  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [tool, setTool] = useState<Tool>('lasso')
  const [brush, setBrush] = useState(36) // 屏幕像素
  const [showOriginal, setShowOriginal] = useState(false)
  const [zoomLabel, setZoomLabel] = useState(100)
  const [saving, setSaving] = useState(false)
  const [, bump] = useState(0)

  const undoStack = useRef<{ alpha: Uint8Array; path: number[] }[]>([])
  const redoStack = useRef<{ alpha: Uint8Array; path: number[] }[]>([])

  // —— 绘制 ——
  const op = useRef<{ kind: 'brush' | 'lasso' | 'pan'; last: { x: number; y: number }; id: number } | null>(null)
  const frame = useRef(0)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const lasso = useRef<number[] | null>(null)
  const toolRef = useRef(tool)
  toolRef.current = tool
  const brushRef = useRef(brush)
  brushRef.current = brush
  const originalRef = useRef(showOriginal)
  originalRef.current = showOriginal

  const render = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const c = canvasRef.current
      const img = src.current
      if (!c || !img || !comp.current) return
      const ctx = c.getContext('2d')!
      const { zoom, x, y } = view.current
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.fillStyle = checker(ctx)
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.setTransform(DPR * zoom, 0, 0, DPR * zoom, DPR * x, DPR * y)
      // 拖动过程中用快速缩放，松手后再以高质量重绘
      ctx.imageSmoothingQuality = op.current ? 'low' : 'high'
      if (originalRef.current) {
        ctx.drawImage(img, 0, 0)
      } else {
        // 轮廓 / 恢复时淡淡显示原图，便于看清被去掉的部分；擦除、移动时显示真实透明效果
        const ghost = toolRef.current === 'lasso' || toolRef.current === 'restore' ? 0.22 : 0
        if (ghost) {
          ctx.globalAlpha = ghost
          ctx.drawImage(img, 0, 0)
          ctx.globalAlpha = 1
        }
        ctx.drawImage(comp.current, 0, 0)
      }
      ctx.lineWidth = 1 / zoom
      ctx.strokeStyle = 'rgba(55,55,53,0.35)'
      ctx.strokeRect(0, 0, img.naturalWidth, img.naturalHeight)
      const l = lasso.current
      if (l && l.length >= 4) {
        ctx.beginPath()
        ctx.moveTo(l[0], l[1])
        for (let i = 2; i < l.length; i += 2) ctx.lineTo(l[i], l[i + 1])
        ctx.setLineDash([6 / zoom, 4 / zoom])
        ctx.lineWidth = 2 / zoom
        ctx.strokeStyle = '#9E3B2E'
        ctx.stroke()
        ctx.setLineDash([])
      }
      const p = pointer.current
      if (p && (toolRef.current === 'erase' || toolRef.current === 'restore')) {
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
        ctx.beginPath()
        ctx.arc(p.x, p.y, brushRef.current / 2, 0, Math.PI * 2)
        ctx.lineWidth = 1
        ctx.strokeStyle = '#373735'
        ctx.stroke()
      }
    })
  }, [])

  /** 重新合成（原图 × 遮罩）；rect 为原图坐标中需要更新的区域。 */
  const recomposite = useCallback((rect?: Box) => {
    const img = src.current!
    const c = comp.current!.getContext('2d')!
    const [W, H] = [img.naturalWidth, img.naturalHeight]
    const r0 = rect ?? { x: 0, y: 0, width: W, height: H }
    // 只处理变化的区域（限制在图片范围内）
    const x = Math.max(0, Math.floor(r0.x))
    const y = Math.max(0, Math.floor(r0.y))
    const w = Math.min(W, Math.ceil(r0.x + r0.width)) - x
    const h = Math.min(H, Math.ceil(r0.y + r0.height)) - y
    if (w <= 0 || h <= 0) return
    c.save()
    c.clearRect(x, y, w, h)
    c.drawImage(img, x, y, w, h, x, y, w, h)
    c.globalCompositeOperation = 'destination-in'
    c.drawImage(mask.current!, x, y, w, h, x, y, w, h)
    c.restore()
  }, [])

  // —— 遮罩快照（只取透明通道） ——
  const snapshot = (from?: HTMLCanvasElement) => {
    const m = from ?? mask.current!
    const d = m.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, m.width, m.height).data
    const alpha = new Uint8Array(m.width * m.height)
    for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3]
    return { alpha, path: [...path.current] }
  }
  const restoreSnapshot = (s: { alpha: Uint8Array; path: number[] }) => {
    const m = mask.current!
    const img = new ImageData(m.width, m.height)
    for (let i = 0; i < s.alpha.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255
      img.data[i * 4 + 3] = s.alpha[i]
    }
    m.getContext('2d')!.putImageData(img, 0, 0)
    path.current = s.path
    recomposite()
    render()
  }
  const pushUndo = () => {
    undoStack.current = [...undoStack.current, snapshot()].slice(-HISTORY_LIMIT)
    redoStack.current = []
    bump((n) => n + 1)
  }
  const undo = () => {
    const prev = undoStack.current.at(-1)
    if (!prev) return
    redoStack.current = [snapshot(), ...redoStack.current]
    undoStack.current = undoStack.current.slice(0, -1)
    restoreSnapshot(prev)
    bump((n) => n + 1)
  }
  // 落笔时只做一次快速的整图复制；抬笔后才提取透明通道写入撤销记录，避免落笔卡顿
  const strokeStart = useRef<HTMLCanvasElement | null>(null)
  const beginStroke = () => {
    const m = mask.current!
    const copy = strokeStart.current ?? Object.assign(document.createElement('canvas'), { width: m.width, height: m.height })
    const c = copy.getContext('2d', { willReadFrequently: true })!
    c.clearRect(0, 0, copy.width, copy.height)
    c.drawImage(m, 0, 0)
    strokeStart.current = copy
  }
  const endStroke = () => {
    undoStack.current = [...undoStack.current, snapshot(strokeStart.current!)].slice(-HISTORY_LIMIT)
    redoStack.current = []
    bump((n) => n + 1)
  }
  /** 放弃进行中的一笔：恢复到落笔前，不留撤销 / 重做记录。 */
  const cancelBrush = () => {
    const m = mask.current!.getContext('2d')!
    m.save()
    m.globalCompositeOperation = 'copy'
    m.drawImage(strokeStart.current!, 0, 0)
    m.restore()
    recomposite()
    render()
  }
  const redo = () => {
    const next = redoStack.current[0]
    if (!next) return
    undoStack.current = [...undoStack.current, snapshot()].slice(-HISTORY_LIMIT)
    redoStack.current = redoStack.current.slice(1)
    restoreSnapshot(next)
    bump((n) => n + 1)
  }

  // —— 载入原图与遮罩 ——
  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    const load = async (data: ArrayBuffer, type: string) => {
      const url = URL.createObjectURL(new Blob([data], { type }))
      urls.push(url)
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    }
    ;(async () => {
      const asset = await db.assets.get(props.sourceAssetId)
      if (!asset) throw new Error('找不到原图')
      const img = await load(asset.data, asset.mimeType)
      const existing = props.cutoutId ? await db.cutouts.get(props.cutoutId) : undefined
      if (cancelled) return
      const [w, h] = [img.naturalWidth, img.naturalHeight]
      src.current = img
      srcName.current = asset.name.replace(/\.[a-z0-9]+$/i, '')
      mask.current = Object.assign(document.createElement('canvas'), { width: w, height: h })
      comp.current = Object.assign(document.createElement('canvas'), { width: w, height: h })
      const mctx = mask.current.getContext('2d', { willReadFrequently: true })!
      if (existing) {
        mctx.drawImage(await load(existing.mask, 'image/png'), 0, 0)
        path.current = existing.path
        usedLasso.current = existing.method === 'lasso'
        oldBox.current = existing.box
        createdAt.current = existing.createdAt
      } else {
        mctx.fillStyle = '#fff' // 新剪裁：从完整图片开始
        mctx.fillRect(0, 0, w, h)
      }
      recomposite()
      fit()
      setReady(true)
    })().catch((err) => {
      console.error('打开剪裁失败', err)
      setError('无法打开这张图片的剪裁。')
    })
    return () => {
      cancelled = true
      urls.forEach(URL.revokeObjectURL)
    }
  }, [props.sourceAssetId, props.cutoutId]) // eslint-disable-line react-hooks/exhaustive-deps

  // —— 画布尺寸与视图 ——
  const fit = useCallback(() => {
    const img = src.current
    const { w, h } = size.current
    if (!img || !w) return
    const zoom = Math.min((w - 32) / img.naturalWidth, (h - 32) / img.naturalHeight)
    view.current = { zoom, x: (w - img.naturalWidth * zoom) / 2, y: (h - img.naturalHeight * zoom) / 2 }
    setZoomLabel(Math.round(zoom * 100))
    render()
  }, [render])

  useEffect(() => {
    const wrap = wrapRef.current!
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      const h = Math.round(e.contentRect.height)
      const first = !size.current.w
      size.current = { w, h }
      const c = canvasRef.current!
      c.width = w * DPR
      c.height = h * DPR
      c.style.width = `${w}px`
      c.style.height = `${h}px`
      if (first) fit()
      else render()
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [fit, render])

  useEffect(render, [tool, showOriginal, render])

  const zoomAt = (k: number, sx: number, sy: number) => {
    const v = view.current
    const zoom = Math.min(16, Math.max(0.05, v.zoom * k))
    const wx = (sx - v.x) / v.zoom
    const wy = (sy - v.y) / v.zoom
    view.current = { zoom, x: sx - wx * zoom, y: sy - wy * zoom }
    setZoomLabel(Math.round(zoom * 100))
    render()
  }

  // —— 指针：单指 / 鼠标 / 触控笔按工具操作；双指缩放平移；检测到触控笔后手指只用于查看 ——
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>())
  const pinch = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null)
  const penSeen = useRef(false)

  const local = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const toImage = (p: { x: number; y: number }) => ({ x: (p.x - view.current.x) / view.current.zoom, y: (p.y - view.current.y) / view.current.zoom })

  function paint(from: { x: number; y: number }, to: { x: number; y: number }, erase: boolean) {
    const m = mask.current!.getContext('2d')!
    const width = brushRef.current / view.current.zoom
    m.save()
    m.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    m.strokeStyle = m.fillStyle = '#fff'
    m.lineWidth = width
    m.lineCap = m.lineJoin = 'round'
    m.beginPath()
    m.moveTo(from.x, from.y)
    m.lineTo(to.x === from.x && to.y === from.y ? to.x + 0.01 : to.x, to.y)
    m.stroke()
    m.restore()
    const pad = width / 2 + 2
    recomposite({
      x: Math.floor(Math.min(from.x, to.x) - pad),
      y: Math.floor(Math.min(from.y, to.y) - pad),
      width: Math.ceil(Math.abs(to.x - from.x) + pad * 2),
      height: Math.ceil(Math.abs(to.y - from.y) + pad * 2),
    })
  }

  function applyLasso(points: number[]) {
    const img = src.current!
    const m = mask.current!.getContext('2d')!
    m.save()
    m.clearRect(0, 0, img.naturalWidth, img.naturalHeight)
    m.beginPath()
    m.moveTo(points[0], points[1])
    for (let i = 2; i < points.length; i += 2) m.lineTo(points[i], points[i + 1])
    m.closePath()
    m.fillStyle = '#fff'
    m.fill() // 画布填充本身带抗锯齿
    m.lineWidth = 1.5
    m.strokeStyle = 'rgba(255,255,255,0.5)' // 轮廓外再加约 1px 半透明过渡，边缘更柔和
    m.stroke()
    m.restore()
    path.current = points.map((v) => Math.round(v * 10) / 10)
    usedLasso.current = true
    recomposite()
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = local(e)
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType })
    // 触摸指针由浏览器自动捕获；鼠标与触控笔需要显式捕获，拖出画布也能继续
    if (e.pointerType !== 'touch') canvasRef.current!.setPointerCapture(e.pointerId)
    if (e.pointerType === 'pen') penSeen.current = true
    const touches = [...pointers.current.values()].filter((v) => v.type === 'touch')
    if (touches.length === 2) {
      // 第二根手指：放弃进行中的一笔，改为缩放平移
      if (op.current?.kind === 'brush') cancelBrush()
      op.current = null
      lasso.current = null
      const [a, b] = touches
      pinch.current = { dist: Math.hypot(b.x - a.x, b.y - a.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      return
    }
    if (op.current) return
    const viewOnly = (e.pointerType === 'touch' && penSeen.current) || e.button === 1 || toolRef.current === 'pan'
    if (viewOnly) {
      op.current = { kind: 'pan', last: p, id: e.pointerId }
    } else if (toolRef.current === 'lasso') {
      const ip = toImage(p)
      lasso.current = [ip.x, ip.y]
      op.current = { kind: 'lasso', last: p, id: e.pointerId }
    } else {
      beginStroke()
      const ip = toImage(p)
      paint(ip, ip, toolRef.current === 'erase')
      op.current = { kind: 'brush', last: ip, id: e.pointerId }
    }
    render()
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = local(e)
    pointer.current = p
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { ...p, type: e.pointerType })
    const pc = pinch.current
    if (pc) {
      const touches = [...pointers.current.values()].filter((v) => v.type === 'touch')
      if (touches.length < 2) return
      const [a, b] = touches
      const dist = Math.hypot(b.x - a.x, b.y - a.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      view.current = { ...view.current, x: view.current.x + mid.x - pc.mid.x, y: view.current.y + mid.y - pc.mid.y }
      zoomAt(dist / pc.dist, mid.x, mid.y)
      pinch.current = { dist, mid }
      return
    }
    const o = op.current
    if (o && o.id === e.pointerId) {
      if (o.kind === 'pan') {
        view.current = { ...view.current, x: view.current.x + p.x - o.last.x, y: view.current.y + p.y - o.last.y }
        o.last = p
      } else if (o.kind === 'lasso') {
        const ip = toImage(p)
        const l = lasso.current!
        if (Math.hypot(ip.x - l[l.length - 2], ip.y - l[l.length - 1]) * view.current.zoom >= 3) l.push(ip.x, ip.y)
      } else {
        const ip = toImage(p)
        paint(o.last, ip, toolRef.current === 'erase')
        o.last = ip
      }
    }
    render()
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId)
    if (pinch.current) {
      if ([...pointers.current.values()].filter((v) => v.type === 'touch').length < 2) pinch.current = null
      return
    }
    const o = op.current
    if (!o || o.id !== e.pointerId) return
    op.current = null
    const l = lasso.current
    lasso.current = null
    // 抬手时的重活（读取整张遮罩做撤销快照、生成轮廓遮罩）放到事件处理之后执行，
    // 让抬手事件立即处理完，界面保持跟手
    setTimeout(() => {
      if (o.kind === 'brush') endStroke()
      if (o.kind === 'lasso' && l && l.length >= 6 && polygonArea(l) * view.current.zoom ** 2 > 400) {
        pushUndo()
        applyLasso(l)
      }
      render()
    }, 0)
    render()
  }

  // 滚轮：Ctrl / ⌘ 缩放，否则平移
  useEffect(() => {
    const c = canvasRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top)
      else {
        view.current = { ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY }
        render()
      }
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // 撤销 / 重做快捷键（编辑器打开时由它接管）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (!(e.metaKey || e.ctrlKey) || (key !== 'z' && key !== 'y')) return
      e.preventDefault()
      e.stopPropagation()
      if (key === 'y' || e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // —— 保存：裁到可见范围的透明 PNG + 完整遮罩 ——
  async function save() {
    const img = src.current!
    const m = mask.current!
    const [w, h] = [m.width, m.height]
    const d = m.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data
    let [x0, y0, x1, y1] = [w, h, -1, -1]
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (d[(y * w + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
    if (x1 < 0) return setError('当前什么都没有保留，请先画出轮廓或用「恢复」找回部分图像。')
    setSaving(true)
    setError('')
    try {
      const box: Box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
      const out = Object.assign(document.createElement('canvas'), { width: box.width, height: box.height })
      const o = out.getContext('2d')!
      o.drawImage(img, -box.x, -box.y)
      o.globalCompositeOperation = 'destination-in'
      o.drawImage(m, -box.x, -box.y)
      const [resultBlob, maskBlob] = await Promise.all([toBlob(out), toBlob(m)])
      const assetId = props.cutoutId ?? newId()
      const data = await resultBlob.arrayBuffer()
      const now = Date.now()
      const { thumb, thumbType } = await makeThumb(data, 'image/png')
      const name = `${srcName.current}-剪裁.png`
      await saveCutout(
        { id: assetId, data, mimeType: 'image/png', name, width: box.width, height: box.height, size: resultBlob.size, createdAt: now },
        {
          id: assetId,
          sourceAssetId: props.sourceAssetId,
          method: usedLasso.current ? 'lasso' : 'brush',
          path: path.current,
          mask: await maskBlob.arrayBuffer(),
          width: w,
          height: h,
          box,
          createdAt: createdAt.current,
          updatedAt: now,
        },
        { id: assetId, category: '剪裁', name, width: box.width, height: box.height, thumb, thumbType, addedAt: now },
      )
      props.onSaved({ assetId, isNew: !props.cutoutId, oldBox: oldBox.current, newBox: box })
    } catch (err) {
      console.error('保存剪裁失败', err)
      setError('保存失败，请重试。')
      setSaving(false)
    }
  }

  const current = TOOLS.find((t) => t.value === tool)!
  return (
    <div role="dialog" aria-label="剪裁图片" className="fixed inset-0 z-50 flex flex-col bg-paper">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <button onClick={props.onCancel} className="text-sm text-mute">取消</button>
        <div className="min-w-0 flex-1 truncate text-center">
          <span className="font-serif">剪裁</span>
          <span className="ml-2 text-xs text-mute">原图不会被修改</span>
        </div>
        <button onClick={undo} disabled={!undoStack.current.length} className="text-sm disabled:opacity-30">撤销</button>
        <button onClick={redo} disabled={!redoStack.current.length} className="text-sm disabled:opacity-30">重做</button>
        <button onClick={save} disabled={!ready || saving} className="rounded-full bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-40">
          {saving ? '保存中…' : props.cutoutId ? '保存修改' : '保存为新素材'}
        </button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2 text-xs">
        <div role="group" aria-label="剪裁工具" className="flex overflow-hidden rounded-full border border-line">
          {TOOLS.map((t) => (
            <button key={t.value} onClick={() => setTool(t.value)} className={`px-3 py-1.5 ${tool === t.value ? 'bg-ink text-paper' : ''}`}>
              {t.label}
            </button>
          ))}
        </div>
        {(tool === 'erase' || tool === 'restore') && (
          <label className="flex items-center gap-1.5">
            <span className="text-mute">笔刷</span>
            <input type="range" aria-label="笔刷大小" min={4} max={160} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="w-24 accent-ink" />
            <span className="w-7 tabular-nums">{brush}</span>
          </label>
        )}
        <button
          onPointerDown={() => setShowOriginal(true)}
          onPointerUp={() => setShowOriginal(false)}
          onPointerLeave={() => setShowOriginal(false)}
          onKeyDown={(e) => e.key === ' ' && setShowOriginal(true)}
          onKeyUp={() => setShowOriginal(false)}
          className={`rounded-full border px-3 py-1.5 ${showOriginal ? 'border-ink bg-ink text-paper' : 'border-line'}`}
        >
          按住看原图
        </button>
        <div className="ml-auto flex items-center divide-x divide-line rounded-full border border-line">
          <button onClick={() => zoomAt(1 / 1.25, size.current.w / 2, size.current.h / 2)} className="px-3 py-1.5" aria-label="缩小">−</button>
          <span className="w-12 text-center tabular-nums text-mute">{zoomLabel}%</span>
          <button onClick={() => zoomAt(1.25, size.current.w / 2, size.current.h / 2)} className="px-3 py-1.5" aria-label="放大">+</button>
          <button onClick={fit} className="px-3 py-1.5">适应</button>
        </div>
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden" style={{ touchAction: 'none' }}>
        <canvas
          ref={canvasRef}
          className="block"
          style={{ cursor: tool === 'pan' ? 'grab' : tool === 'lasso' ? 'crosshair' : 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            pointer.current = null
            render()
          }}
        />
        {!ready && !error && <p className="absolute inset-0 flex items-center justify-center text-sm text-mute">载入中…</p>}
      </div>

      <p className="shrink-0 border-t border-line px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs text-mute">
        {error ? <span className="text-red-700">{error}</span> : current.hint}
      </p>
    </div>
  )
}

function polygonArea(p: number[]) {
  let a = 0
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length
    a += p[i] * p[j + 1] - p[j] * p[i + 1]
  }
  return Math.abs(a / 2)
}

function toBlob(c: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('无法生成图片'))), 'image/png'))
}

let checkerPattern: CanvasPattern | null = null
function checker(ctx: CanvasRenderingContext2D) {
  if (!checkerPattern) {
    const t = Object.assign(document.createElement('canvas'), { width: 16 * DPR, height: 16 * DPR })
    const c = t.getContext('2d')!
    c.fillStyle = '#ffffff'
    c.fillRect(0, 0, t.width, t.height)
    c.fillStyle = '#ece9e2'
    c.fillRect(0, 0, t.width / 2, t.height / 2)
    c.fillRect(t.width / 2, t.height / 2, t.width / 2, t.height / 2)
    checkerPattern = ctx.createPattern(t, 'repeat')
  }
  return checkerPattern!
}
