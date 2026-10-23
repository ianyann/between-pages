/**
 * Photopea（第三方在线编辑器）的嵌入通信。
 *
 * 协议（Photopea 官方 Live Messaging，见 https://www.photopea.com/api/live）：
 * - iframe 地址为 https://www.photopea.com#<URL 编码的 JSON 配置>；初始化完成后向外层发送字符串 "done"。
 * - 外层 postMessage 一个文件的 ArrayBuffer：Photopea 打开它，完成后回复 "done"。
 * - 外层 postMessage 一段脚本字符串：Photopea 执行；脚本中 app.activeDocument.saveToOE("png" | "psd")
 *   会把文件以 ArrayBuffer 发回外层，app.echoToOE(x) 会把 x 发回外层，执行完毕再发 "done"。
 *
 * 安全：只接受 origin 为 Photopea、且 source 是本 iframe 的消息；发送时指定目标 origin，从不用 "*"。
 * 图片只在浏览器内通过 postMessage 交给 iframe，不经过任何服务器（Photopea 页面本身需要联网加载）。
 */

export const PHOTOPEA_URL = (import.meta.env.VITE_PHOTOPEA_URL as string | undefined) || 'https://www.photopea.com'
export const PHOTOPEA_ORIGIN = new URL(PHOTOPEA_URL).origin

const env = import.meta.env as Record<string, string | undefined>
const INIT_TIMEOUT = Number(env.VITE_PHOTOPEA_INIT_TIMEOUT) || 45_000 // 编辑器本身有数 MB，慢网络需要时间
const OPEN_TIMEOUT = 60_000
const EXPORT_TIMEOUT = 120_000
export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024

export type PhotopeaErrorKind = 'offline' | 'init-timeout' | 'open-failed' | 'too-large' | 'no-document' | 'export-timeout' | 'export-invalid'

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

/** 等待 Photopea iframe 初始化（收到第一个来自它的 "done"）。 */
export function waitForPhotopea(frame: HTMLIFrameElement): Promise<PhotopeaClient> {
  return new Promise((resolve, reject) => {
    if (!navigator.onLine) return reject(new PhotopeaError('offline', '当前没有网络连接，无法加载第三方编辑器。'))
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new PhotopeaError('init-timeout', 'Photopea 在规定时间内没有完成加载（可能是网络不可用、访问受限或服务暂时不可用）。'))
    }, INIT_TIMEOUT)
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== PHOTOPEA_ORIGIN || e.source !== frame.contentWindow || e.data !== 'done') return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(new PhotopeaClient(frame))
    }
    window.addEventListener('message', onMessage)
  })
}

export class PhotopeaClient {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private frame: HTMLIFrameElement) {}

  /**
   * 发送一条消息，收集 Photopea 的回复直到 "done"。请求依次排队，回复不会串到别的请求里。
   * needBuffer：导出文件时，忽略还没收到文件就先到的 "done"，继续等文件。
   */
  private exchange(payload: string | ArrayBuffer, timeoutMs: number, needBuffer = false): Promise<unknown[]> {
    const run = () =>
      new Promise<unknown[]>((resolve, reject) => {
        const win = this.frame.contentWindow
        if (!win) return reject(new PhotopeaError('open-failed', '编辑器窗口已关闭。'))
        const outputs: unknown[] = []
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMessage)
          reject(new PhotopeaError(needBuffer ? 'export-timeout' : 'open-failed', '等待 Photopea 回应超时。'))
        }, timeoutMs)
        const onMessage = (e: MessageEvent) => {
          if (e.origin !== PHOTOPEA_ORIGIN || e.source !== win) return
          if (e.data === 'done') {
            if (needBuffer && !outputs.some(isArrayBuffer)) return
            clearTimeout(timer)
            window.removeEventListener('message', onMessage)
            resolve(outputs)
          } else outputs.push(e.data)
        }
        window.addEventListener('message', onMessage)
        try {
          win.postMessage(payload, PHOTOPEA_ORIGIN)
        } catch (err) {
          clearTimeout(timer)
          window.removeEventListener('message', onMessage)
          reject(new PhotopeaError('too-large', `无法把文件交给编辑器：${(err as Error).message}`))
        }
      })
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  async documentCount(): Promise<number> {
    const out = await this.exchange('app.echoToOE(app.documents.length);', OPEN_TIMEOUT)
    const n = Number(out.find((x) => typeof x === 'string' || typeof x === 'number'))
    return Number.isFinite(n) ? n : 0
  }

  /** 把文件（复制一份）交给 Photopea 打开，并确认确实多了一个文档。 */
  async open(data: ArrayBuffer): Promise<void> {
    if (data.byteLength > MAX_TRANSFER_BYTES) throw new PhotopeaError('too-large', `文件过大（${Math.round(data.byteLength / 1024 / 1024)} MB），无法交给编辑器。`)
    const before = await this.documentCount()
    await this.exchange(data.slice(0), OPEN_TIMEOUT)
    const after = await this.documentCount()
    if (after <= before) throw new PhotopeaError('open-failed', 'Photopea 没有打开这张图片（格式可能不受支持）。')
  }

  /** 导出当前文档；校验文件头，避免把错误的数据当成 PNG / PSD 保存。 */
  async export(format: 'png' | 'psd'): Promise<ArrayBuffer> {
    if ((await this.documentCount()) < 1) throw new PhotopeaError('no-document', 'Photopea 中没有打开的文档。')
    const out = await this.exchange(`app.activeDocument.saveToOE("${format}");`, EXPORT_TIMEOUT, true)
    const buf = out.find(isArrayBuffer)
    const sig = format === 'png' ? PNG_SIGNATURE : PSD_SIGNATURE
    if (!buf || !hasSignature(buf, sig)) throw new PhotopeaError('export-invalid', `Photopea 返回的数据不是有效的 ${format.toUpperCase()} 文件。`)
    return buf
  }
}
