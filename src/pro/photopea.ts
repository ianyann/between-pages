/**
 * Photopea（第三方在线编辑器）的嵌入通信桥。
 *
 * 协议（Photopea 官方 Live Messaging，见 https://www.photopea.com/api/live）：
 * - iframe 地址为 https://www.photopea.com#<URL 编码的 JSON 配置>；初始化完成后向外层发送字符串 "done"。
 * - 外层 postMessage 一个文件的 ArrayBuffer：Photopea 打开它，完成后回复 "done"。
 * - 外层 postMessage 一段脚本字符串：Photopea 执行；脚本中 app.activeDocument.saveToOE("png" | "psd")
 *   会把文件以 ArrayBuffer 发回外层，app.echoToOE(x) 会把 x 发回外层，执行完毕再发 "done"。
 *   导出时 "done" 可能先于文件到达。
 * - 协议没有请求 ID。因此：同一时间只有一个请求在途（队列串行）；请求超时后，先发一次带随机标记的
 *   echoToOE 同步，丢弃标记之前的所有迟到消息，再处理下一个请求，避免把上一次的回复错配给下一次。
 *
 * 安全：只接受 origin 为 Photopea、且 source 是本 iframe 的消息；发送时指定目标 origin，从不用 "*"。
 * 收到的字符串只作为数据比较，从不执行。发出的脚本只有本文件里的固定模板。
 * 图片只在浏览器内通过 postMessage 交给 iframe，不经过任何服务器（Photopea 页面本身需要联网加载）。
 */

export const PHOTOPEA_URL = (import.meta.env.VITE_PHOTOPEA_URL as string | undefined) || 'https://www.photopea.com'
export const PHOTOPEA_ORIGIN = new URL(PHOTOPEA_URL).origin

const env = import.meta.env as Record<string, string | undefined>
const INIT_TIMEOUT = Number(env.VITE_PHOTOPEA_INIT_TIMEOUT) || 45_000 // 编辑器本身有数 MB，慢网络需要时间
const QUERY_TIMEOUT = 20_000
const OPEN_TIMEOUT = 60_000
const EXPORT_TIMEOUT = Number(env.VITE_PHOTOPEA_EXPORT_TIMEOUT) || 120_000
const EXPORT_GRACE = Number(env.VITE_PHOTOPEA_EXPORT_GRACE) || 20_000 // 收到 "done" 后继续等待文件的时间
export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024

export type PhotopeaErrorKind =
  | 'offline'
  | 'init-timeout'
  | 'closed'
  | 'unresponsive'
  | 'open-failed'
  | 'too-large'
  | 'no-document'
  | 'export-timeout'
  | 'export-invalid'

export class PhotopeaError extends Error {
  constructor(
    public kind: PhotopeaErrorKind,
    message: string,
  ) {
    super(message)
  }
}

/** 嵌入地址。只用默认环境（不传自定义配置），避免依赖未核实的选项。 */
export const photopeaSrc = () => `${PHOTOPEA_URL}#${encodeURI(JSON.stringify({}))}`

const isArrayBuffer = (x: unknown): x is ArrayBuffer => Object.prototype.toString.call(x) === '[object ArrayBuffer]'

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const PSD_SIGNATURE = [0x38, 0x42, 0x50, 0x53] // "8BPS"
export const hasSignature = (buf: ArrayBuffer, sig: number[]) => {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, sig.length))
  return b.length === sig.length && sig.every((v, i) => b[i] === v)
}

/** PNG 文件头：签名 + IHDR 块中的宽高。不合法时返回 null。 */
export function readPngHeader(buf: ArrayBuffer): { width: number; height: number } | null {
  if (buf.byteLength < 33 || !hasSignature(buf, PNG_SIGNATURE)) return null
  const v = new DataView(buf)
  if (v.getUint32(12) !== 0x49484452) return null // "IHDR"
  const width = v.getUint32(16)
  const height = v.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** PSD 文件头（26 字节）：签名、版本 1（PSD）或 2（PSB）、保留位为 0、宽高。不合法时返回 null。 */
export function readPsdHeader(buf: ArrayBuffer): { version: number; width: number; height: number } | null {
  if (buf.byteLength < 26 || !hasSignature(buf, PSD_SIGNATURE)) return null
  const v = new DataView(buf)
  const version = v.getUint16(4)
  if (version !== 1 && version !== 2) return null
  for (let i = 6; i < 12; i++) if (v.getUint8(i) !== 0) return null
  const height = v.getUint32(14)
  const width = v.getUint32(18)
  return width > 0 && height > 0 ? { version, width, height } : null
}

export type BridgeState = 'initializing' | 'ready' | 'busy' | 'closed'

type Reply = { outputs: (string | number | boolean)[]; buffer: ArrayBuffer | null }

interface Pending {
  expectBuffer: boolean
  marker: string | null // 同步请求：等待这个 echo 标记，之后的 "done" 才算结束
  markerSeen: boolean
  doneSeen: boolean
  outputs: (string | number | boolean)[]
  buffer: ArrayBuffer | null
  timers: ReturnType<typeof setTimeout>[]
  resolve: (r: Reply) => void
  reject: (e: Error) => void
}

export class PhotopeaBridge {
  state: BridgeState = 'initializing'
  /** 被忽略的消息数（迟到、重复或无主的回复），用于诊断。 */
  ignored = 0
  private pending: Pending | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private needsSync = false
  private init: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }

  constructor(
    private frame: HTMLIFrameElement,
    private onState?: (s: BridgeState) => void,
  ) {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    promise.catch(() => {}) // 由 ready() 的调用方处理
    this.init = { promise, resolve, reject }
    window.addEventListener('message', this.onMessage)
    if (!navigator.onLine) this.fail(new PhotopeaError('offline', '当前没有网络连接，无法加载第三方编辑器。'))
    else
      this.init.timer = setTimeout(
        () => this.fail(new PhotopeaError('init-timeout', 'Photopea 在规定时间内没有完成加载（可能是网络不可用、访问受限或服务暂时不可用）。')),
        INIT_TIMEOUT,
      )
  }

  /** 等待初始化的 "done"。 */
  ready(): Promise<void> {
    return this.init.promise
  }

  /** 关闭：移除监听、清除计时器、拒绝所有等待中的请求。可重复调用。 */
  dispose() {
    this.fail(new PhotopeaError('closed', '编辑器已关闭。'))
  }

  private fail(err: PhotopeaError) {
    if (this.state === 'closed') return
    this.setState('closed')
    window.removeEventListener('message', this.onMessage)
    clearTimeout(this.init.timer)
    this.init.reject(err)
    const p = this.pending
    this.pending = null
    if (p) {
      p.timers.forEach(clearTimeout)
      p.reject(err)
    }
  }

  private setState(s: BridgeState) {
    if (this.state === s) return
    this.state = s
    this.onState?.(s)
  }

  private onMessage = (e: MessageEvent) => {
    if (e.origin !== PHOTOPEA_ORIGIN || e.source !== this.frame.contentWindow || this.state === 'closed') return
    const d: unknown = e.data
    if (this.state === 'initializing') {
      if (d !== 'done') return void this.ignored++
      clearTimeout(this.init.timer)
      this.setState('ready')
      this.init.resolve()
      return
    }
    const p = this.pending
    if (!p) return void this.ignored++
    if (p.marker !== null) {
      if (d === p.marker) p.markerSeen = true
      else if (d === 'done' && p.markerSeen) this.settle(p)
      else this.ignored++
      return
    }
    if (d === 'done') {
      if (p.doneSeen) return void this.ignored++
      p.doneSeen = true
      if (p.expectBuffer && !p.buffer)
        p.timers.push(setTimeout(() => this.timeout(p, new PhotopeaError('export-invalid', 'Photopea 完成了命令，但没有返回文件。')), EXPORT_GRACE))
    } else if (isArrayBuffer(d)) {
      if (!p.expectBuffer || p.buffer) return void this.ignored++
      p.buffer = d
    } else if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') p.outputs.push(d)
    else return void this.ignored++
    if (p.doneSeen && (!p.expectBuffer || p.buffer)) this.settle(p)
  }

  private settle(p: Pending) {
    if (this.pending !== p) return
    p.timers.forEach(clearTimeout)
    this.pending = null
    this.setState('ready')
    p.resolve({ outputs: p.outputs, buffer: p.buffer })
  }

  private timeout(p: Pending, err: PhotopeaError) {
    if (this.pending !== p) return
    p.timers.forEach(clearTimeout)
    this.pending = null
    this.needsSync = true // 迟到的回复可能还会来，下次请求前先同步
    this.setState('ready')
    p.reject(err)
  }

  /** 发送一条消息并等待它的回复。只在队列中调用。 */
  private exchange(payload: string | ArrayBuffer, opts: { timeout: number; expectBuffer?: boolean; marker?: string; timeoutError: PhotopeaError }): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      if (this.state === 'closed') return reject(new PhotopeaError('closed', '编辑器已关闭。'))
      const win = this.frame.contentWindow
      if (!win) return reject(new PhotopeaError('closed', '编辑器窗口已关闭。'))
      const p: Pending = {
        expectBuffer: !!opts.expectBuffer,
        marker: opts.marker ?? null,
        markerSeen: false,
        doneSeen: false,
        outputs: [],
        buffer: null,
        timers: [],
        resolve,
        reject,
      }
      p.timers.push(setTimeout(() => this.timeout(p, opts.timeoutError), opts.timeout))
      this.pending = p
      this.setState('busy')
      try {
        // ArrayBuffer 以转移方式发送（调用方传入的是副本），避免再复制一份占内存
        if (isArrayBuffer(payload)) win.postMessage(payload, PHOTOPEA_ORIGIN, [payload])
        else win.postMessage(payload, PHOTOPEA_ORIGIN)
      } catch (err) {
        p.timers.forEach(clearTimeout)
        this.pending = null
        this.setState('ready')
        reject(new PhotopeaError('too-large', `无法把文件交给编辑器：${(err as Error).message}`))
      }
    })
  }

  /** 串行执行：前一个请求结束（成功或失败）后才发送下一个。 */
  private request(payload: string | ArrayBuffer, opts: { timeout: number; expectBuffer?: boolean; timeoutError: PhotopeaError }): Promise<Reply> {
    const run = async () => {
      if (this.needsSync) {
        const marker = `between-pages-sync-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`
        await this.exchange(`app.echoToOE("${marker}");`, {
          timeout: QUERY_TIMEOUT,
          marker,
          timeoutError: new PhotopeaError('unresponsive', 'Photopea 没有响应。可以稍等后再试，或返回页间。'),
        })
        this.needsSync = false
      }
      return this.exchange(payload, opts)
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  async documentCount(): Promise<number> {
    const { outputs } = await this.request('app.echoToOE(app.documents.length);', {
      timeout: QUERY_TIMEOUT,
      timeoutError: new PhotopeaError('unresponsive', 'Photopea 没有响应。'),
    })
    const n = Number(outputs.find((x) => typeof x === 'number' || (typeof x === 'string' && /^\d+$/.test(x))))
    return Number.isFinite(n) ? n : 0
  }

  /** 把文件（复制一份）交给 Photopea 打开，并确认确实多了一个文档。 */
  async open(data: ArrayBuffer): Promise<void> {
    if (data.byteLength > MAX_TRANSFER_BYTES) throw new PhotopeaError('too-large', `文件过大（${Math.round(data.byteLength / 1024 / 1024)} MB），无法交给编辑器。`)
    const before = await this.documentCount()
    await this.request(data.slice(0), { timeout: OPEN_TIMEOUT, timeoutError: new PhotopeaError('open-failed', '等待 Photopea 打开文件超时。') })
    const after = await this.documentCount()
    if (after <= before) throw new PhotopeaError('open-failed', 'Photopea 没有打开这个文件（格式可能不受支持）。')
  }

  /** 导出当前文档为 PNG（保留透明）。校验签名、大小与文件头中的宽高。 */
  async exportPng(): Promise<{ data: ArrayBuffer; width: number; height: number }> {
    const data = await this.exportFile('png')
    const head = readPngHeader(data)
    if (!head) throw new PhotopeaError('export-invalid', 'Photopea 返回的数据不是有效的 PNG 文件。')
    return { data, ...head }
  }

  /** 导出当前文档为 PSD（保留图层与蒙版）。校验签名、版本、大小与文件头中的宽高。 */
  async exportPsd(): Promise<{ data: ArrayBuffer; width: number; height: number }> {
    const data = await this.exportFile('psd')
    const head = readPsdHeader(data)
    if (!head) throw new PhotopeaError('export-invalid', 'Photopea 返回的数据不是有效的 PSD 文件。')
    return { data, width: head.width, height: head.height }
  }

  private async exportFile(format: 'png' | 'psd'): Promise<ArrayBuffer> {
    if ((await this.documentCount()) < 1) throw new PhotopeaError('no-document', 'Photopea 中没有打开的文档。')
    const { buffer } = await this.request(`app.activeDocument.saveToOE("${format}");`, {
      timeout: EXPORT_TIMEOUT,
      expectBuffer: true,
      timeoutError: new PhotopeaError('export-timeout', `等待 Photopea 导出 ${format.toUpperCase()} 超时。`),
    })
    if (!buffer || buffer.byteLength === 0) throw new PhotopeaError('export-invalid', `Photopea 没有返回 ${format.toUpperCase()} 文件。`)
    if (buffer.byteLength > MAX_TRANSFER_BYTES) throw new PhotopeaError('export-invalid', `导出的 ${format.toUpperCase()} 文件过大（${Math.round(buffer.byteLength / 1024 / 1024)} MB），没有保存。`)
    return buffer
  }
}
