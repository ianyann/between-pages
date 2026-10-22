import { db } from '../db'

/**
 * 内置装饰素材：用程序绘制成透明 PNG，首次使用时以固定 ID 写入素材库，
 * 之后与普通图片完全相同（可叠放、缩放、旋转、调透明度、导出、备份）。
 * 修改某个装饰的画法时，请把 key 的版本号加一，避免影响已用在画布上的旧图。
 */
export const DECORATION_GROUPS = ['纸片', '胶带', '色块', '线条与形状'] as const

interface Decoration {
  key: string
  label: string
  group: (typeof DECORATION_GROUPS)[number]
  width: number // 放进画布时的逻辑尺寸
  height: number
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number) => void
}

const INK = '#373735'
const SHADOW = 'rgba(55,55,53,0.18)'

/** 可复现的伪随机数，让同一装饰每次生成的毛边都一样。 */
function seeded(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 撕纸毛边的矩形路径。 */
function tornPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, amp: number, rand: () => number) {
  const step = 9
  const jitter = () => (rand() - 0.5) * amp
  ctx.beginPath()
  ctx.moveTo(x, y)
  for (let i = step; i < w; i += step) ctx.lineTo(x + i, y + jitter())
  for (let i = 0; i < h; i += step) ctx.lineTo(x + w + jitter(), y + i)
  for (let i = w; i > 0; i -= step) ctx.lineTo(x + i, y + h + jitter())
  for (let i = h; i > 0; i -= step) ctx.lineTo(x + jitter(), y + i)
  ctx.closePath()
}

function paperScrap(fill: string, extra?: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number) => {
    const m = 12
    ctx.save()
    ctx.shadowColor = SHADOW
    ctx.shadowBlur = 10
    ctx.shadowOffsetY = 3
    tornPath(ctx, m, m, w - m * 2, h - m * 2, 7, rand)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.restore()
    if (extra) {
      ctx.save()
      tornPath(ctx, m, m, w - m * 2, h - m * 2, 7, seeded(1))
      ctx.clip()
      extra(ctx, m, m, w - m * 2, h - m * 2)
      ctx.restore()
    }
  }
}

function tape(fill: string, stripes?: string) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number) => {
    const tooth = 6
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(w, 0)
    for (let y = 0; y < h; y += tooth) ctx.lineTo(w - (Math.floor(y / tooth) % 2 ? 0 : 5 + rand() * 3), y + tooth / 2)
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    for (let y = h; y > 0; y -= tooth) ctx.lineTo(Math.floor(y / tooth) % 2 ? 0 : 5 + rand() * 3, y - tooth / 2)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    if (stripes) {
      ctx.save()
      ctx.clip()
      ctx.strokeStyle = stripes
      ctx.lineWidth = 8
      for (let x = -h; x < w; x += 22) {
        ctx.beginPath()
        ctx.moveTo(x, h)
        ctx.lineTo(x + h, 0)
        ctx.stroke()
      }
      ctx.restore()
    }
  }
}

function block(fill: string) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, w, h)
  }
}

export const DECORATIONS: Decoration[] = [
  { key: 'scrap-cream-v1', label: '米色纸片', group: '纸片', width: 320, height: 230, draw: paperScrap('#F1E8D4') },
  { key: 'scrap-kraft-v1', label: '牛皮纸', group: '纸片', width: 300, height: 250, draw: paperScrap('#C9A77C') },
  {
    key: 'scrap-lined-v1',
    label: '横线纸',
    group: '纸片',
    width: 300,
    height: 380,
    draw: paperScrap('#FBFAF6', (ctx, x, y, w, h) => {
      ctx.strokeStyle = 'rgba(46,74,98,0.28)'
      ctx.lineWidth = 1
      for (let ly = y + 40; ly < y + h; ly += 26) {
        ctx.beginPath()
        ctx.moveTo(x, ly)
        ctx.lineTo(x + w, ly)
        ctx.stroke()
      }
      ctx.strokeStyle = 'rgba(158,59,46,0.4)'
      ctx.beginPath()
      ctx.moveTo(x + 36, y)
      ctx.lineTo(x + 36, y + h)
      ctx.stroke()
    }),
  },
  {
    key: 'scrap-grid-v1',
    label: '方格纸',
    group: '纸片',
    width: 300,
    height: 300,
    draw: paperScrap('#FAFAF7', (ctx, x, y, w, h) => {
      ctx.strokeStyle = 'rgba(91,107,74,0.25)'
      ctx.lineWidth = 1
      for (let gx = x; gx < x + w; gx += 20) {
        ctx.beginPath()
        ctx.moveTo(gx, y)
        ctx.lineTo(gx, y + h)
        ctx.stroke()
      }
      for (let gy = y; gy < y + h; gy += 20) {
        ctx.beginPath()
        ctx.moveTo(x, gy)
        ctx.lineTo(x + w, gy)
        ctx.stroke()
      }
    }),
  },
  { key: 'tape-yellow-v1', label: '黄胶带', group: '胶带', width: 260, height: 60, draw: tape('rgba(232,200,110,0.68)') },
  { key: 'tape-pink-v1', label: '粉胶带', group: '胶带', width: 260, height: 60, draw: tape('rgba(228,164,160,0.62)') },
  { key: 'tape-mint-v1', label: '薄荷胶带', group: '胶带', width: 260, height: 60, draw: tape('rgba(156,196,176,0.62)') },
  { key: 'tape-stripe-v1', label: '条纹胶带', group: '胶带', width: 260, height: 60, draw: tape('rgba(247,246,242,0.7)', 'rgba(158,59,46,0.35)') },
  { key: 'block-red-v1', label: '红色块', group: '色块', width: 360, height: 260, draw: block('rgba(158,59,46,0.32)') },
  { key: 'block-blue-v1', label: '蓝色块', group: '色块', width: 360, height: 260, draw: block('rgba(46,74,98,0.3)') },
  { key: 'block-ochre-v1', label: '赭色块', group: '色块', width: 360, height: 260, draw: block('rgba(200,161,90,0.35)') },
  { key: 'block-ink-v1', label: '墨色块', group: '色块', width: 360, height: 260, draw: block('rgba(55,55,53,0.22)') },
  {
    key: 'line-ink-v1',
    label: '直线',
    group: '线条与形状',
    width: 420,
    height: 12,
    draw: (ctx, w, h) => {
      ctx.fillStyle = INK
      ctx.fillRect(0, h / 2 - 1.5, w, 3)
    },
  },
  {
    key: 'line-wave-v1',
    label: '波浪线',
    group: '线条与形状',
    width: 420,
    height: 40,
    draw: (ctx, w, h) => {
      ctx.strokeStyle = INK
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let x = 4; x <= w - 4; x += 2) ctx.lineTo(x, h / 2 + Math.sin(x / 18) * (h / 2 - 6))
      ctx.stroke()
    },
  },
  {
    key: 'circle-ink-v1',
    label: '圆圈',
    group: '线条与形状',
    width: 240,
    height: 240,
    draw: (ctx, w, h) => {
      ctx.strokeStyle = INK
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.ellipse(w / 2, h / 2, w / 2 - 4, h / 2 - 4, 0, 0, Math.PI * 2)
      ctx.stroke()
    },
  },
  {
    key: 'frame-ink-v1',
    label: '方框',
    group: '线条与形状',
    width: 300,
    height: 400,
    draw: (ctx, w, h) => {
      ctx.strokeStyle = INK
      ctx.lineWidth = 3
      ctx.strokeRect(3, 3, w - 6, h - 6)
    },
  },
  {
    key: 'dot-red-v1',
    label: '圆点',
    group: '线条与形状',
    width: 80,
    height: 80,
    draw: (ctx, w, h) => {
      ctx.fillStyle = '#9E3B2E'
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2)
      ctx.fill()
    },
  },
]

const PREFIX = 'builtin-'
export const decorationAssetId = (key: string) => PREFIX + key
export const findDecoration = (assetId: string) =>
  assetId.startsWith(PREFIX) ? DECORATIONS.find((d) => d.key === assetId.slice(PREFIX.length)) : undefined

function render(d: Decoration, pixelRatio: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = d.width * pixelRatio
  canvas.height = d.height * pixelRatio
  const ctx = canvas.getContext('2d')!
  ctx.scale(pixelRatio, pixelRatio)
  d.draw(ctx, d.width, d.height, seeded(d.key.length * 7919 + d.width))
  return canvas
}

const previews = new Map<string, string>()
export function decorationPreview(d: Decoration): string {
  let url = previews.get(d.key)
  if (!url) {
    url = render(d, 0.5).toDataURL('image/png')
    previews.set(d.key, url)
  }
  return url
}

/** 确保内置装饰已写入素材库（只生成一次）。不是内置装饰时什么也不做。 */
export async function ensureDecorationAsset(assetId: string): Promise<void> {
  const d = findDecoration(assetId)
  if (!d || (await db.assets.get(assetId))) return
  const blob = await new Promise<Blob | null>((r) => render(d, 2).toBlob(r, 'image/png'))
  if (!blob) throw new Error('无法生成装饰素材')
  await db.assets.put({
    id: assetId,
    data: await blob.arrayBuffer(),
    mimeType: 'image/png',
    name: d.label,
    width: d.width * 2,
    height: d.height * 2,
    size: blob.size,
    createdAt: Date.now(),
  })
}
