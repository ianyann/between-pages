import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { db, PSD_MIME, saveProEdit, type Asset } from '../db'
import { makeThumb, newId } from '../lib'
import { PhotopeaError, photopeaSrc, waitForPhotopea, type PhotopeaClient } from './photopea'

/**
 * 专业编辑器（实验）：嵌入第三方 Photopea。与创作桌完全隔离，只通过素材盒读写素材。
 * 原素材从不被覆盖；每次保存都生成新的素材 ID。
 */

const CONSENT_KEY = 'between-pages:photopea-notice'

type Phase =
  | { kind: 'notice' }
  | { kind: 'loading' }
  | { kind: 'opening' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; retry: boolean }

export default function ProEditor() {
  const { assetId = '' } = useParams()
  const [params] = useSearchParams()
  const back = params.get('from') || '/'
  const navigate = useNavigate()

  const [phase, setPhase] = useState<Phase>(() => (readConsent() ? { kind: 'loading' } : { kind: 'notice' }))
  const [attempt, setAttempt] = useState(0)
  const started = phase.kind !== 'notice' // 同意说明后才加载第三方页面
  const [source, setSource] = useState<{ asset: Asset; openAs: Asset; viaPsd: boolean } | null | undefined>(undefined)
  const [withPsd, setWithPsd] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const client = useRef<PhotopeaClient | null>(null)
  const savingRef = useRef(false)
  const lastSaved = useRef<{ hash: string; psd: boolean } | null>(null)

  // 读取要编辑的素材；若它是专业编辑的结果且保存过 PSD，优先打开 PSD 以保留图层与蒙版
  useEffect(() => {
    ;(async () => {
      const asset = await db.assets.get(assetId)
      if (!asset) return setSource(null)
      const pro = await db.proEdits.get(assetId)
      const psd = pro?.psdAssetId ? await db.assets.get(pro.psdAssetId) : undefined
      setSource({ asset, openAs: psd ?? asset, viaPsd: !!psd })
    })().catch(() => setSource(null))
  }, [assetId])

  // 加载 Photopea 并打开素材（只随「开始 / 重试」触发，阶段变化不会中断进行中的打开）
  useEffect(() => {
    if (!started || !source) return
    let cancelled = false
    const frame = frameRef.current!
    waitForPhotopea(frame)
      .then(async (c) => {
        if (cancelled) return
        client.current = c
        setPhase({ kind: 'opening' })
        await c.open(source.openAs.data)
        if (!cancelled) setPhase({ kind: 'ready' })
      })
      .catch((err) => {
        if (cancelled) return
        const e = err as PhotopeaError
        const retry = e.kind === 'offline' || e.kind === 'init-timeout' || e.kind === 'open-failed'
        setPhase({ kind: 'error', message: e.message || String(err), retry })
      })
    return () => {
      cancelled = true
    }
  }, [started, source, attempt])

  async function save() {
    if (savingRef.current || !client.current || !source) return
    savingRef.current = true
    setSaving(true)
    setStatus({ tone: 'info', text: '正在从 Photopea 导出…' })
    try {
      const png = await client.current.export('png')
      const hash = fnv1a(png)
      if (lastSaved.current && lastSaved.current.hash === hash && (lastSaved.current.psd || !withPsd)) {
        setStatus({ tone: 'info', text: '内容与上一次保存相同，没有重复保存。' })
        return
      }
      const psd = withPsd ? await client.current.export('psd') : null
      setStatus({ tone: 'info', text: '正在保存到素材盒…' })
      const { width, height } = await imageSize(png) // 能解码才保存
      const now = Date.now()
      const base = source.asset.name.replace(/(-专业编辑)?\.[a-z0-9]+$/i, '')
      const id = newId()
      const psdId = psd ? newId() : null
      const name = `${base}-专业编辑.png`
      const { thumb, thumbType } = await makeThumb(png, 'image/png')
      await saveProEdit(
        { id, data: png, mimeType: 'image/png', name, width, height, size: png.byteLength, createdAt: now },
        psd && psdId ? { id: psdId, data: psd, mimeType: PSD_MIME, name: `${base}-专业编辑.psd`, width, height, size: psd.byteLength, createdAt: now } : null,
        { id, sourceAssetId: source.asset.id, psdAssetId: psdId, editor: 'photopea', createdAt: now, updatedAt: now },
        { id, category: '专业编辑', name, width, height, thumb, thumbType, addedAt: now },
      )
      // 只有写入数据库成功后才提示完成
      lastSaved.current = { hash, psd: !!psd }
      setStatus({ tone: 'ok', text: `已保存到素材盒：${name}${psd ? '（含 PSD）' : ''}` })
    } catch (err) {
      const e = err as Error
      const quota = e.name === 'QuotaExceededError' || /quota/i.test(e.message)
      setStatus({ tone: 'error', text: quota ? '设备存储空间不足，保存失败。' : `保存失败：${e.message}` })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  function leave() {
    if (phase.kind === 'ready' && !leaving) return setLeaving(true)
    navigate(back)
  }

  if (source === null)
    return (
      <p className="py-20 text-center text-sm text-mute">
        找不到这张素材。<Link to={back} className="underline">返回</Link>
      </p>
    )

  if (phase.kind === 'notice')
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <p className="mb-3 text-xs tracking-[0.3em] text-mute uppercase">Experimental</p>
        <h1 className="mb-6 font-serif text-2xl">专业编辑器（实验）</h1>
        <div className="space-y-3 text-sm leading-relaxed">
          <p>
            这里嵌入的是<strong>第三方在线编辑器 Photopea</strong>（photopea.com），不是页间的一部分。
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-mute">
            <li>需要联网加载 Photopea 页面。</li>
            <li>所选图片会在你的浏览器内直接交给 Photopea 页面处理，页间不会把它上传到任何服务器；但 Photopea 页面内部如何处理数据由它决定，页间无法控制。</li>
            <li>Photopea 可能显示自己的广告，并适用它自己的使用条款与隐私政策。</li>
            <li>请用页面上方的「保存到素材盒」保存；在 Photopea 菜单里另存的文件不会回到页间。</li>
          </ul>
        </div>
        <div className="mt-8 flex gap-3">
          <button
            onClick={() => {
              writeConsent()
              setPhase({ kind: 'loading' })
            }}
            className="rounded-full bg-ink px-6 py-2 text-sm text-paper"
          >
            我知道了，打开
          </button>
          <Link to={back} className="rounded-full border border-line px-6 py-2 text-sm">返回</Link>
        </div>
      </div>
    )

  const busyText = phase.kind === 'loading' ? '正在连接 Photopea…' : phase.kind === 'opening' ? '正在把图片交给 Photopea…' : ''

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-sm">
        <button onClick={leave} className={leaving ? 'text-red-700' : 'text-mute'}>
          {leaving ? '未保存的修改会丢失，再点一次离开' : '← 返回'}
        </button>
        {leaving && <button onClick={() => setLeaving(false)} className="text-mute">留下</button>}
        <div className="min-w-0 flex-1">
          <span className="font-serif">专业编辑</span>
          {/* 窄屏时换行显示，始终可见 */}
          <span className="block text-xs text-mute sm:ml-2 sm:inline">第三方编辑器 Photopea · 实验功能{source?.viaPsd ? ' · 已打开保存的 PSD' : ''}</span>
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={withPsd} onChange={(e) => setWithPsd(e.target.checked)} className="accent-ink" />
          同时保存 PSD（保留图层与蒙版）
        </label>
        <button onClick={save} disabled={phase.kind !== 'ready' || saving} className="rounded-full bg-ink px-4 py-1.5 text-paper disabled:opacity-40">
          {saving ? '保存中…' : '保存到素材盒'}
        </button>
      </header>
      {status && (
        <p role="status" className={`shrink-0 border-b border-line px-4 py-2 text-sm ${status.tone === 'error' ? 'text-red-700' : status.tone === 'ok' ? '' : 'text-mute'}`}>
          {status.text}
          {lastSaved.current && status.tone !== 'error' && (
            <Link to={back} className="ml-3 underline">返回创作桌</Link>
          )}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {source && (
          <iframe
            key={attempt}
            ref={frameRef}
            title="Photopea（第三方编辑器）"
            src={photopeaSrc()}
            // 允许它运行；不允许它跳转或改动页间本身
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
          />
        )}
        {(busyText || phase.kind === 'error') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-paper/95 px-6 text-center text-sm">
            {phase.kind === 'error' ? (
              <>
                <p className="max-w-sm text-red-700">{phase.message}</p>
                <div className="flex gap-3">
                  {phase.retry && (
                    <button
                      onClick={() => {
                        client.current = null
                        setAttempt((n) => n + 1)
                        setPhase({ kind: 'loading' })
                      }}
                      className="rounded-full border border-ink px-5 py-1.5"
                    >
                      重试
                    </button>
                  )}
                  <Link to={back} className="rounded-full border border-line px-5 py-1.5">返回</Link>
                </div>
              </>
            ) : (
              <p className="text-mute">{busyText}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function readConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1'
  } catch {
    return false
  }
}

function writeConsent() {
  try {
    localStorage.setItem(CONSENT_KEY, '1')
  } catch {
    // 无法记录时下次再提示一次
  }
}

/** 解码 PNG 得到尺寸；解码失败说明数据不可用，不保存。 */
async function imageSize(buf: ArrayBuffer): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }))
  const size = { width: bmp.width, height: bmp.height }
  bmp.close()
  return size
}

/** 简单内容指纹，用于避免把同样的结果重复保存。 */
function fnv1a(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]
    h = Math.imul(h, 0x01000193)
  }
  return `${b.length}:${(h >>> 0).toString(16)}`
}
