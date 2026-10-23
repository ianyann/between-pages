import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { db, nextProEditVersion, PSD_MIME, saveProEdit, type Asset } from '../db'
import { makeThumb, newId } from '../lib'
import { PhotopeaBridge, PhotopeaError, photopeaSrc } from './photopea'

/**
 * 专业编辑器：嵌入第三方 Photopea。Konva 创作桌负责排版拼贴，这里只负责单张素材的专业编辑。
 * 只通过素材库读写：原素材从不被覆盖；每次保存都生成新的素材 ID（新版本）。
 *
 * 从素材盒打开：保存为新素材。
 * 从画布元素打开（?el=元素ID）：保存后可选择 替换当前图片 / 添加为新图层 / 仅保存到素材盒，
 * 选择结果通过返回地址的参数交给创作桌处理（创作桌负责保持位置、角度、图层与比例）。
 */

const CONSENT_KEY = 'between-pages:photopea-notice'

type Phase =
  | { kind: 'notice' }
  | { kind: 'loading' }
  | { kind: 'opening' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; retry: boolean }

type Exported = { data: ArrayBuffer; width: number; height: number }

/** 一次「保存到页间」的状态机。每次保存有自己的 run 编号，过期的异步结果一律丢弃。 */
type SaveState =
  | { step: 'idle' }
  | { step: 'exporting-png'; run: number }
  | { step: 'exporting-psd'; run: number; png: Exported }
  | { step: 'psd-failed'; run: number; png: Exported; reason: string }
  | { step: 'writing'; run: number }
  | { step: 'saved'; run: number; id: string; name: string; version: number; withPsd: boolean }
  | { step: 'error'; run: number; message: string }

type Source = { asset: Asset; openAs: Asset; viaPsd: boolean; version: number }

export default function ProEditor() {
  const { assetId = '' } = useParams()
  const [params] = useSearchParams()
  const from = params.get('from')
  const back = from?.startsWith('/') ? from : '/' // 只允许站内地址
  const elementId = params.get('el') // 从画布元素打开时才有
  const navigate = useNavigate()

  const [phase, setPhase] = useState<Phase>(() => (readConsent() ? { kind: 'loading' } : { kind: 'notice' }))
  const [attempt, setAttempt] = useState(0)
  const started = phase.kind !== 'notice' // 同意说明后才加载第三方页面
  const [source, setSource] = useState<Source | null | undefined>(undefined)
  const [save, setSave] = useState<SaveState>({ step: 'idle' })
  const [choiceOpen, setChoiceOpen] = useState(false)
  const [touched, setTouched] = useState(false) // 用户进入过 Photopea 操作区域（无法确知是否真的改动）
  const [leaving, setLeaving] = useState(false)
  const [notice, setNotice] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const bridge = useRef<PhotopeaBridge | null>(null)
  const runRef = useRef(0)
  const lastSaved = useRef<{ id: string; hash: string; psd: boolean } | null>(null)

  // 读取要编辑的素材；若它是专业编辑的结果且保存过 PSD，优先打开 PSD 以保留图层与蒙版
  useEffect(() => {
    ;(async () => {
      const asset = await db.assets.get(assetId)
      if (!asset) return setSource(null)
      const pro = await db.proEdits.get(assetId)
      const psd = pro?.psdAssetId ? await db.assets.get(pro.psdAssetId) : undefined
      setSource({ asset, openAs: psd ?? asset, viaPsd: !!psd, version: pro?.editVersion ?? 0 })
    })().catch(() => setSource(null))
  }, [assetId])

  // 建立通信并打开素材（只随「开始 / 重试」触发）；离开或重试时销毁通信桥，移除监听与计时器
  useEffect(() => {
    if (!started || !source) return
    const b = new PhotopeaBridge(frameRef.current!)
    bridge.current = b
    ;(async () => {
      await b.ready()
      setPhase({ kind: 'opening' })
      await b.open(source.openAs.data)
      setPhase({ kind: 'ready' })
    })().catch((err) => {
      if (bridge.current !== b) return
      const e = err as PhotopeaError
      if (e.kind === 'closed') return
      const retry = ['offline', 'init-timeout', 'open-failed', 'unresponsive'].includes(e.kind)
      const hint = source.viaPsd && e.kind === 'open-failed' ? ' 保存的 PSD 无法打开；原图和 PNG 结果不受影响。' : ''
      setPhase({ kind: 'error', message: (e.message || String(err)) + hint, retry })
    })
    return () => {
      b.dispose()
      if (bridge.current === b) bridge.current = null
      runRef.current++ // 进行中的保存作废
    }
  }, [started, source, attempt])

  // 焦点进入 iframe 时，认为用户可能在 Photopea 中做了修改
  useEffect(() => {
    const onBlur = () => setTimeout(() => document.activeElement === frameRef.current && setTouched(true))
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  // 关闭或刷新页面前提醒（浏览器只显示它自己的通用提示）
  useEffect(() => {
    if (!touched) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [touched])

  const busy = save.step === 'exporting-png' || save.step === 'exporting-psd' || save.step === 'writing'
  const live = (run: number) => run === runRef.current && bridge.current !== null

  /** 第 1 步：导出 PNG 并校验；随后自动进入 PSD 导出。 */
  async function startSave() {
    const b = bridge.current
    if (busy || !b || !source || phase.kind !== 'ready') return
    const run = ++runRef.current
    setChoiceOpen(false)
    setNotice('')
    setSave({ step: 'exporting-png', run })
    let png: Exported
    try {
      png = await b.exportPng()
      await checkDecodable(png)
    } catch (err) {
      if (live(run)) setSave({ step: 'error', run, message: `PNG 导出失败：${(err as Error).message}` })
      return
    }
    if (!live(run)) return
    const hash = fnv1a(png.data)
    if (lastSaved.current?.hash === hash && lastSaved.current.psd) {
      setSave({ step: 'idle' })
      return setNotice('内容与上一次保存相同，没有重复保存。')
    }
    await exportPsd(run, png)
  }

  /** 第 2 步：导出 PSD 并校验；失败时停下，让用户决定重试或只保存 PNG。 */
  async function exportPsd(run: number, png: Exported) {
    const b = bridge.current
    if (!b || !live(run)) return
    setSave({ step: 'exporting-psd', run, png })
    try {
      const psd = await b.exportPsd()
      if (psd.width !== png.width || psd.height !== png.height) throw new Error('PSD 与 PNG 尺寸不一致，可能不是同一个文档。')
      if (live(run)) await write(run, png, psd)
    } catch (err) {
      if (live(run)) setSave({ step: 'psd-failed', run, png, reason: (err as Error).message })
    }
  }

  /** 第 3 步：同一事务写入 PNG、PSD、版本记录和素材盒条目；写入成功后才提示完成。 */
  async function write(run: number, png: Exported, psd: Exported | null) {
    if (!source || !live(run)) return
    setSave({ step: 'writing', run })
    try {
      const parentId = lastSaved.current?.id ?? source.asset.id // 同一次编辑中连续保存：接在上一版之后
      const { editVersion, rootAssetId } = await nextProEditVersion(parentId)
      const now = Date.now()
      const base = source.asset.name.replace(/\.[a-z0-9]+$/i, '').replace(/-专业编辑( v\d+)?( \(\d+\))?$/, '')
      const id = newId()
      const psdId = psd ? newId() : null
      // 同一原图可以有多条版本链（每次从原图打开都从 v1 开始），重名时加序号区分
      const taken = new Set((await db.boxItems.toArray()).map((b) => b.name))
      let stem = `${base}-专业编辑 v${editVersion}`
      for (let n = 2; taken.has(`${stem}.png`); n++) stem = `${base}-专业编辑 v${editVersion} (${n})`
      const name = `${stem}.png`
      const { thumb, thumbType } = await makeThumb(png.data, 'image/png')
      await saveProEdit(
        { id, data: png.data, mimeType: 'image/png', name, width: png.width, height: png.height, size: png.data.byteLength, createdAt: now },
        psd && psdId
          ? { id: psdId, data: psd.data, mimeType: PSD_MIME, name: `${stem}.psd`, width: psd.width, height: psd.height, size: psd.data.byteLength, createdAt: now }
          : null,
        { id, sourceAssetId: parentId, psdAssetId: psdId, rootAssetId, editVersion, editor: 'photopea', createdAt: now, updatedAt: now },
        { id, category: '专业编辑', name, width: png.width, height: png.height, thumb, thumbType, addedAt: now },
      )
      lastSaved.current = { id, hash: fnv1a(png.data), psd: !!psd }
      setTouched(false)
      if (run !== runRef.current) return // 已离开页面：数据已保存，不再更新界面
      setSave({ step: 'saved', run, id, name, version: editVersion, withPsd: !!psd })
      if (elementId) setChoiceOpen(true)
    } catch (err) {
      if (run !== runRef.current) return
      const e = err as Error
      const quota = e.name === 'QuotaExceededError' || /quota/i.test(e.message)
      setSave({ step: 'error', run, message: `${quota ? '设备存储空间不足' : e.message}。没有写入任何内容，已有素材不受影响。` })
    }
  }

  function returnWith(action: 'replace' | 'add') {
    if (save.step !== 'saved' || !elementId) return
    const [path, query = ''] = back.split('?')
    const q = new URLSearchParams(query)
    q.set('pro', save.id)
    q.set('action', action)
    q.set('el', elementId)
    navigate(`${path}?${q}`)
  }

  function leave() {
    if (touched && !leaving) return setLeaving(true)
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
        <p className="mb-3 text-xs tracking-[0.3em] text-mute uppercase">Third-party editor</p>
        <h1 className="mb-6 font-serif text-2xl">专业编辑器</h1>
        <div className="space-y-3 text-sm leading-relaxed">
          <p>
            这里嵌入的是<strong>第三方在线编辑器 Photopea</strong>（photopea.com），不是页间的一部分。
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-mute">
            <li>需要联网加载 Photopea 页面。</li>
            <li>所选图片会在你的浏览器内直接交给 Photopea 页面处理，页间不会把它上传到任何服务器；但 Photopea 页面内部如何处理数据由它决定，页间无法控制。</li>
            <li>Photopea 可能显示自己的广告，并适用它自己的使用条款与隐私政策。</li>
            <li>请用页面上方的「保存到页间」保存；在 Photopea 菜单里另存的文件不会回到页间。</li>
            <li>原图不会被修改，每次保存都会生成一个新版本（PNG + PSD）。</li>
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

  const busyText = phase.kind === 'loading' ? '正在连接 Photopea…' : phase.kind === 'opening' ? (source?.viaPsd ? '正在把保存的 PSD 交给 Photopea…' : '正在把图片交给 Photopea…') : ''

  const status: { tone: 'ok' | 'error' | 'warn' | 'info'; text: string } | null =
    save.step === 'exporting-png'
      ? { tone: 'info', text: '1/3 正在从 Photopea 导出透明 PNG…' }
      : save.step === 'exporting-psd'
        ? { tone: 'info', text: '2/3 PNG 已导出，正在导出 PSD（保留图层与蒙版）…' }
        : save.step === 'writing'
          ? { tone: 'info', text: '3/3 正在写入页间…' }
          : save.step === 'saved'
            ? save.withPsd
              ? { tone: 'ok', text: `已保存到页间：${save.name}（含 PSD）。原图未改动。` }
              : { tone: 'warn', text: `已保存 PNG：${save.name}。PSD 未保留——再次打开时将从这张 PNG 开始，图层与蒙版无法恢复。原图未改动。` }
            : save.step === 'psd-failed'
              ? { tone: 'warn', text: `PNG 已导出，但 PSD 导出失败：${save.reason} 尚未保存任何内容。` }
              : save.step === 'error'
                ? { tone: 'error', text: `保存失败：${save.message}` }
                : notice
                  ? { tone: 'info', text: notice }
                  : touched
                    ? { tone: 'info', text: 'Photopea 中的修改需要点「保存到页间」才会回到页间。' }
                    : null

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-sm">
        <button onClick={leave} className="text-mute">← 返回页间</button>
        <div className="min-w-0 flex-1">
          <span className="block truncate font-serif" title={source?.asset.name}>
            {source ? source.asset.name : '载入中…'}
          </span>
          {/* 窄屏时也始终可见 */}
          <span className="block text-xs text-mute">
            第三方编辑器 Photopea{source?.viaPsd ? ` · 已打开 v${source.version} 的 PSD` : source?.version ? ` · v${source.version}（无 PSD，从 PNG 开始）` : ''}
          </span>
        </div>
        <button onClick={startSave} disabled={phase.kind !== 'ready' || busy || save.step === 'psd-failed'} className="rounded-full bg-ink px-4 py-1.5 text-paper disabled:opacity-40">
          {busy ? '保存中…' : '保存到页间'}
        </button>
      </header>
      {leaving && (
        <div role="alertdialog" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-[#EFEBE3] px-4 py-2.5 text-sm">
          <p className="min-w-0 flex-1">Photopea 里可能还有没保存到页间的修改（页间无法确切检测）。离开后这些修改会丢失。</p>
          <button onClick={() => setLeaving(false)} className="rounded-full border border-ink px-4 py-1">留下</button>
          <button onClick={() => navigate(back)} className="rounded-full border border-line px-4 py-1 text-red-700">仍然离开</button>
        </div>
      )}
      {status && (
        <div
          role="status"
          className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2 text-sm ${status.tone === 'error' ? 'text-red-700' : status.tone === 'warn' ? 'text-[#8a5a00]' : status.tone === 'ok' ? '' : 'text-mute'}`}
        >
          <span className="min-w-0 flex-1">{status.text}</span>
          {save.step === 'psd-failed' && (
            <>
              <button onClick={() => exportPsd(save.run, save.png)} className="rounded-full border border-ink px-3 py-0.5 text-ink">重试 PSD</button>
              <button onClick={() => write(save.run, save.png, null)} className="rounded-full border border-line px-3 py-0.5 text-ink">仅保存 PNG（不保留 PSD）</button>
              <button onClick={() => setSave({ step: 'idle' })} className="text-mute">取消</button>
            </>
          )}
          {save.step === 'saved' && !choiceOpen && (
            <Link to={back} className="text-ink underline">返回{elementId || back.endsWith('/studio') ? '创作桌' : ''}</Link>
          )}
        </div>
      )}
      {choiceOpen && save.step === 'saved' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
          <span className="mr-2 text-mute">回到画布：</span>
          <button onClick={() => returnWith('replace')} className="rounded-full bg-ink px-4 py-1 text-paper">替换当前图片</button>
          <button onClick={() => returnWith('add')} className="rounded-full border border-ink px-4 py-1">添加为新图层</button>
          <button onClick={() => setChoiceOpen(false)} className="rounded-full border border-line px-4 py-1">仅保存到素材盒</button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {source && started && (
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
                <p className="max-w-sm text-mute">已有素材和画布都没有改动。</p>
                <div className="flex gap-3">
                  {phase.retry && (
                    <button
                      onClick={() => {
                        setSave({ step: 'idle' })
                        setAttempt((n) => n + 1)
                        setPhase({ kind: 'loading' })
                      }}
                      className="rounded-full border border-ink px-5 py-1.5"
                    >
                      重试
                    </button>
                  )}
                  <Link to={back} className="rounded-full border border-line px-5 py-1.5">返回页间</Link>
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

/** 确认 PNG 能被浏览器解码，且解码尺寸与文件头一致；否则不保存。 */
async function checkDecodable(png: Exported) {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(new Blob([png.data], { type: 'image/png' }))
  } catch {
    throw new Error('导出的 PNG 无法读取。')
  }
  const ok = bmp.width === png.width && bmp.height === png.height
  bmp.close()
  if (!ok) throw new Error('导出的 PNG 尺寸异常。')
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
