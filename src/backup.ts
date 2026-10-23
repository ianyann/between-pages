import { BOX_CATEGORIES, db, DB_VERSION, fillEntryDefaults, fillProEditDefaults, normalizeCanvas, WORK_TYPES, type Asset, type BoxItem, type CanvasDoc, type Cutout, type ProEdit, type Entry, type Work } from './db'

/**
 * 备份文件格式（JSON）：
 * { app, format, dbVersion, exportedAt, entries, works, canvases, boxItems, assets }
 * works（v2 起）、canvases（v3 起）、boxItems（v4 起）、cutouts（v5 起）、proEdits（v6 起）为可选，旧备份没有这些项也能导入。
 * 专业编辑保存的 PSD 作为普通素材存在 assets 中（mimeType 为 PSD），随 assets 一起备份。
 * assets[].data、boxItems[].thumb、cutouts[].mask 为 base64 编码的二进制。
 * format 只在文件结构本身变化时递增；dbVersion 记录导出时的数据库版本，导入时据此补全旧字段。
 */
export const BACKUP_FORMAT = 1
const APP = 'between-pages'

type BackupAsset = Omit<Asset, 'data'> & { data: string }
type BackupBoxItem = Omit<BoxItem, 'thumb'> & { thumb: string }
type BackupCutout = Omit<Cutout, 'mask'> & { mask: string }

export interface BackupSummary {
  entries: number
  works: number
  canvases: number
  boxItems: number
  cutouts: number
  proEdits: number
  assets: number
}

/** 生成备份文件。逐段拼接成 Blob，避免把全部图片拼成一个超长字符串。 */
export async function exportBackup(): Promise<{ file: File; summary: BackupSummary }> {
  const [entries, works, canvases, boxItems, cutouts, proEdits, assets] = await db.transaction(
    'r',
    [db.entries, db.works, db.canvases, db.boxItems, db.cutouts, db.proEdits, db.assets],
    () =>
      Promise.all([
        db.entries.toArray(),
        db.works.toArray(),
        db.canvases.toArray(),
        db.boxItems.toArray(),
        db.cutouts.toArray(),
        db.proEdits.toArray(),
        db.assets.toArray(),
      ]),
  )
  const cutoutsForBackup: BackupCutout[] = []
  for (const c of cutouts) cutoutsForBackup.push({ ...c, mask: await toBase64(c.mask) })
  const boxForBackup: BackupBoxItem[] = []
  for (const b of boxItems) boxForBackup.push({ ...b, thumb: await toBase64(b.thumb) })
  const head = {
    app: APP,
    format: BACKUP_FORMAT,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
    works,
    canvases,
    boxItems: boxForBackup,
    cutouts: cutoutsForBackup,
    proEdits,
  }
  const headJson = JSON.stringify(head)
  const parts: BlobPart[] = [headJson.slice(0, -1), ',"assets":[']
  for (const [i, a] of assets.entries()) {
    const { data, ...meta } = a
    const json = JSON.stringify({ ...meta, data: '' })
    // 在 "data":"" 的位置写入 base64
    const at = json.lastIndexOf('"data":""') + 8
    parts.push(i ? ',' : '', json.slice(0, at), await toBase64(data), json.slice(at))
  }
  parts.push(']}')

  const stamp = head.exportedAt.slice(0, 16).replace(/[-:T]/g, '')
  const file = new File(parts, `between-pages-backup-${stamp}.json`, { type: 'application/json' })
  return { file, summary: { entries: entries.length, works: works.length, canvases: canvases.length, boxItems: boxItems.length, cutouts: cutouts.length, proEdits: proEdits.length, assets: assets.length } }
}

/**
 * 导入备份：只合并、不删除本地数据。
 * 同 ID 记录保留最后修改时间较新的一方；图片按 ID 去重，本地已有则不覆盖。
 */
export async function importBackup(file: File): Promise<BackupSummary> {
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new Error('无法读取文件，它不是有效的备份文件。')
  }
  const b = raw as { app?: string; format?: number; entries?: unknown; works?: unknown; canvases?: unknown; boxItems?: unknown; cutouts?: unknown; proEdits?: unknown; assets?: unknown }
  if (b?.app !== APP || typeof b.format !== 'number') throw new Error('这不是页间的备份文件。')
  if (b.format > BACKUP_FORMAT) throw new Error('这个备份来自更新版本的页间，请先更新应用。')
  if (!Array.isArray(b.entries) || !Array.isArray(b.assets)) throw new Error('备份文件内容不完整。')

  const entries = (b.entries as Partial<Entry>[]).filter((e) => typeof e?.id === 'string').map((e) => {
    fillEntryDefaults(e)
    return e as Entry
  })
  const validTypes = new Set(WORK_TYPES.map((t) => t.value))
  const works = (Array.isArray(b.works) ? (b.works as Work[]) : []).filter(
    (w) => typeof w?.id === 'string' && typeof w.name === 'string',
  ).map((w) => ({ ...w, type: validTypes.has(w.type) ? w.type : 'other', coverAssetId: w.coverAssetId ?? null }))
  const canvases = (Array.isArray(b.canvases) ? (b.canvases as CanvasDoc[]) : [])
    .filter((c) => typeof c?.id === 'string' && typeof c.entryId === 'string')
    .map(normalizeCanvas)
  const categories = new Set<string>(BOX_CATEGORIES)
  const boxItems: BoxItem[] = (Array.isArray(b.boxItems) ? (b.boxItems as BackupBoxItem[]) : [])
    .filter((x) => typeof x?.id === 'string' && typeof x.thumb === 'string')
    .map((x) => ({ ...x, category: categories.has(x.category) ? x.category : '其他', thumb: fromBase64(x.thumb) }))
  const cutouts: Cutout[] = (Array.isArray(b.cutouts) ? (b.cutouts as BackupCutout[]) : [])
    .filter((c) => typeof c?.id === 'string' && typeof c.sourceAssetId === 'string' && typeof c.mask === 'string')
    .map((c) => ({ ...c, path: Array.isArray(c.path) ? c.path : [], mask: fromBase64(c.mask) }))
  const rawPro = (Array.isArray(b.proEdits) ? (b.proEdits as ProEdit[]) : []).filter((p) => typeof p?.id === 'string' && typeof p.sourceAssetId === 'string')
  const rawById = new Map(rawPro.map((p) => [p.id, p]))
  const proEdits: ProEdit[] = rawPro.map((p) => fillProEditDefaults(p, (id) => rawById.get(id))) // v6 备份没有版本字段
  const assets: Asset[] = (b.assets as BackupAsset[])
    .filter((a) => typeof a?.id === 'string' && typeof a.data === 'string')
    .map((a) => ({ ...a, data: fromBase64(a.data) }))

  const added: BackupSummary = { entries: 0, works: 0, canvases: 0, boxItems: 0, cutouts: 0, proEdits: 0, assets: 0 }
  await db.transaction('rw', [db.entries, db.works, db.canvases, db.boxItems, db.cutouts, db.proEdits, db.assets], async () => {
    const existingAssets = new Set(await db.assets.toCollection().primaryKeys())
    const newAssets = assets.filter((a) => !existingAssets.has(a.id))
    await db.assets.bulkPut(newAssets)
    added.assets = newAssets.length

    const localEntries = await db.entries.bulkGet(entries.map((e) => e.id))
    const newerEntries = entries.filter((e, i) => isNewer(e, localEntries[i]))
    await db.entries.bulkPut(newerEntries)
    added.entries = newerEntries.length

    const localWorks = await db.works.bulkGet(works.map((w) => w.id))
    const newerWorks = works.filter((w, i) => isNewer(w, localWorks[i]))
    await db.works.bulkPut(newerWorks)
    added.works = newerWorks.length

    const localCanvases = await db.canvases.bulkGet(canvases.map((c) => c.id))
    const newerCanvases = canvases.filter((c, i) => isNewer(c, localCanvases[i]))
    await db.canvases.bulkPut(newerCanvases)
    added.canvases = newerCanvases.length

    // 素材盒条目只补缺，不覆盖本机已有分类
    const localBox = await db.boxItems.bulkGet(boxItems.map((x) => x.id))
    const newBox = boxItems.filter((_, i) => !localBox[i])
    await db.boxItems.bulkPut(newBox)
    added.boxItems = newBox.length

    const localCutouts = await db.cutouts.bulkGet(cutouts.map((c) => c.id))
    const newerCutouts = cutouts.filter((c, i) => isNewer(c, localCutouts[i]))
    await db.cutouts.bulkPut(newerCutouts)
    added.cutouts = newerCutouts.length

    const localPro = await db.proEdits.bulkGet(proEdits.map((p) => p.id))
    const newerPro = proEdits.filter((p, i) => isNewer(p, localPro[i]))
    await db.proEdits.bulkPut(newerPro)
    added.proEdits = newerPro.length
  })
  return added
}

const isNewer = (incoming: { updatedAt: number }, local: { updatedAt: number } | undefined) =>
  !local || (incoming.updatedAt ?? 0) > (local.updatedAt ?? 0)

/** 借助浏览器原生的 data URL 编码，比逐字节 btoa 快得多。 */
function toBase64(buf: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(new Blob([buf]))
  })
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes.buffer
}

const LAST_BACKUP_KEY = 'between-pages:last-backup'

export function getLastBackup(): number | null {
  try {
    const v = localStorage.getItem(LAST_BACKUP_KEY)
    return v ? Number(v) : null
  } catch {
    return null
  }
}

export function setLastBackup(ts: number) {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(ts))
  } catch {
    // 无法记录时不影响备份本身
  }
}
