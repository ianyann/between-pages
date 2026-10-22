import { useEffect, useState } from 'react'
import { db, type Asset } from './db'

/** crypto.randomUUID 仅在 HTTPS / localhost 可用；手机通过局域网 IP 访问时需要回退。 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 本地日期 YYYY-MM-DD（不能用 toISOString，它是 UTC，会在凌晨跨天）。 */
export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-')
  return `${y}.${m}.${d}`
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

const MAX_EDGE = 2400
const KEEP_ORIGINAL_BYTES = 1.5 * 1024 * 1024

/**
 * 读取用户选择的图片并转成可存库的素材。
 * 大图会缩放到长边 2400px，避免手机照片撑满存储：
 * 不含透明像素的转为 JPEG；含透明像素的保持 PNG，保留透明背景。
 * 含透明像素且无需缩放的图片、GIF 与解码失败的格式保留原文件。
 */
export async function fileToAsset(file: File, owner: { entryId?: string; workId?: string }): Promise<Asset> {
  let blob: Blob = file
  let width = 0
  let height = 0

  try {
    const img = await loadImage(file)
    width = img.naturalWidth
    height = img.naturalHeight
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
    if (file.type !== 'image/gif' && (scale < 1 || file.size > KEEP_ORIGINAL_BYTES)) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const transparent = file.type !== 'image/jpeg' && hasTransparency(ctx, canvas.width, canvas.height)
      if (transparent && scale === 1) throw new Error('keep original') // 透明图且尺寸合适：保留原文件
      const out = await new Promise<Blob | null>((r) =>
        transparent ? canvas.toBlob(r, 'image/png') : canvas.toBlob(r, 'image/jpeg', 0.88),
      )
      if (out) {
        blob = out
        width = canvas.width
        height = canvas.height
      }
    }
  } catch {
    // 无法解码（如部分浏览器上的 HEIC）或需保留原文件
  }

  return {
    id: newId(),
    ...owner,
    data: await blob.arrayBuffer(),
    mimeType: blob.type || file.type || 'application/octet-stream',
    name: file.name,
    width,
    height,
    size: blob.size,
    createdAt: Date.now(),
  }
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true
  return false
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

/** 用于显示的临时 URL：每次都从数据库素材重新生成，组件卸载时释放。 */
export function assetToUrl(asset: Asset): string {
  return URL.createObjectURL(new Blob([asset.data], { type: asset.mimeType }))
}

/** 按 ID 从数据库读取图片并返回显示用 URL；undefined = 加载中，null = 不存在。 */
export function useAssetUrl(id: string | undefined): string | null | undefined {
  const [url, setUrl] = useState<string | null>()
  useEffect(() => {
    if (!id) return setUrl(null)
    let objectUrl: string | undefined
    let cancelled = false
    db.assets.get(id).then((a) => {
      if (cancelled) return
      objectUrl = a ? assetToUrl(a) : undefined
      setUrl(objectUrl ?? null)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id])
  return url
}
