import Dexie, { type EntityTable, type Transaction } from 'dexie'

/**
 * 持久化数据结构。修改字段时：
 * 1. 新增 db.version(n + 1) 声明新结构，用 .upgrade() 迁移旧数据（旧版本声明保留不删）；
 * 2. 同步更新 DB_VERSION。
 *
 * 版本历史：
 * v1 第一阶段：entries、assets
 * v2 第二阶段：新增 works；entries 增加 *workIds、*imageIds 多值索引
 */
export const DB_VERSION = 2

export type EntryStatus = 'draft' | 'done'

export interface Entry {
  id: string // 稳定唯一 ID，创建后不再变化
  title: string
  body: string
  entryDate: string // 日记日期，本地日期 YYYY-MM-DD（用户可修改）
  createdAt: number // 创建时间，毫秒时间戳
  updatedAt: number // 最后修改时间，毫秒时间戳
  status: EntryStatus // draft = 草稿，done = 完成
  imageIds: string[] // 图片顺序，指向 assets 表
  workIds: string[] // 关联的作品，指向 works 表（只存 ID）

  // —— 预留扩展字段 ——
  canvas: CanvasData | null // 自由拼贴画布
}

/** 预留：画布内容。后续阶段再细化元素类型。 */
export interface CanvasData {
  version: number
  width: number
  height: number
  elements: unknown[]
}

export type WorkType = 'manga' | 'novel' | 'film' | 'tv' | 'other'

export const WORK_TYPES: { value: WorkType; label: string }[] = [
  { value: 'manga', label: '漫画' },
  { value: 'novel', label: '小说' },
  { value: 'film', label: '电影' },
  { value: 'tv', label: '电视剧' },
  { value: 'other', label: '其他' },
]

export const workTypeLabel = (t: WorkType) => WORK_TYPES.find((x) => x.value === t)?.label ?? '其他'

export interface Work {
  id: string // 稳定唯一 ID
  name: string
  type: WorkType
  coverAssetId: string | null // 封面，指向 assets 表
  createdAt: number
  updatedAt: number
}

/**
 * 图片素材：以二进制形式存入 IndexedDB，可在任何时候恢复。
 * entryId / workId 只记录素材最初为谁上传；能否删除以 Entry.imageIds 与 Work.coverAssetId 的引用为准。
 */
export interface Asset {
  id: string
  entryId?: string
  workId?: string
  data: ArrayBuffer // 使用 ArrayBuffer 而非 Blob，兼容性最稳
  mimeType: string
  name: string
  width: number
  height: number
  size: number
  createdAt: number
}

export const db = new Dexie('between-pages') as Dexie & {
  entries: EntityTable<Entry, 'id'>
  assets: EntityTable<Asset, 'id'>
  works: EntityTable<Work, 'id'>
}

db.version(1).stores({
  entries: 'id, entryDate, updatedAt, status',
  assets: 'id, entryId',
})

db.version(2)
  .stores({
    entries: 'id, entryDate, updatedAt, status, *workIds, *imageIds',
    assets: 'id, entryId',
    works: 'id, type, name, updatedAt, coverAssetId',
  })
  .upgrade((tx: Transaction) => tx.table('entries').toCollection().modify(fillEntryDefaults))

/** 为旧版本日记补全缺失字段（数据库迁移与导入备份共用）。只补缺失项，不改 ID、不动其他内容。 */
export function fillEntryDefaults(e: Partial<Entry>) {
  if (!Array.isArray(e.workIds)) e.workIds = []
  if (!Array.isArray(e.imageIds)) e.imageIds = []
  if (e.canvas === undefined) e.canvas = null
}

/** 请求持久化存储，降低浏览器在空间紧张时清除数据的概率。 */
export function requestPersistentStorage() {
  navigator.storage?.persist?.().catch(() => {})
}

/** 日期倒序；同一天内按创建时间倒序。 */
export function sortEntries(list: Entry[]): Entry[] {
  return list.sort((a, b) =>
    a.entryDate === b.entryDate ? b.createdAt - a.createdAt : a.entryDate < b.entryDate ? 1 : -1,
  )
}

export async function listEntries(limit?: number): Promise<Entry[]> {
  const all = sortEntries(await db.entries.toArray())
  return limit ? all.slice(0, limit) : all
}

/**
 * 删除不再被任何日记或作品引用的素材。必须在包含 entries、works、assets 的读写事务中调用，
 * 且调用前先写入引用变化。
 */
async function deleteUnreferencedAssets(ids: Iterable<string>) {
  for (const id of new Set(ids)) {
    const usedByEntry = await db.entries.where('imageIds').equals(id).count()
    const usedByWork = await db.works.where('coverAssetId').equals(id).count()
    if (!usedByEntry && !usedByWork) await db.assets.delete(id)
  }
}

/** 在一个事务内保存日记与图片变更：要么全部成功，要么全部不生效。 */
export async function saveEntry(entry: Entry, newAssets: Asset[], removedAssetIds: string[]) {
  await db.transaction('rw', [db.entries, db.assets, db.works], async () => {
    if (newAssets.length) await db.assets.bulkPut(newAssets)
    await db.entries.put(entry)
    await deleteUnreferencedAssets(removedAssetIds)
  })
}

export async function deleteEntry(id: string) {
  await db.transaction('rw', [db.entries, db.assets, db.works], async () => {
    const entry = await db.entries.get(id)
    const ownKeys = await db.assets.where('entryId').equals(id).primaryKeys()
    await db.entries.delete(id)
    await deleteUnreferencedAssets([...(entry?.imageIds ?? []), ...ownKeys])
  })
}

/** 保存作品；更换或移除封面时，旧封面仅在无其他引用时删除。 */
export async function saveWork(work: Work, newCover: Asset | null) {
  await db.transaction('rw', [db.entries, db.assets, db.works], async () => {
    const prev = await db.works.get(work.id)
    if (newCover) await db.assets.put(newCover)
    await db.works.put(work)
    if (prev?.coverAssetId && prev.coverAssetId !== work.coverAssetId) {
      await deleteUnreferencedAssets([prev.coverAssetId])
    }
  })
}

/** 删除作品：只从日记中解除关联，不删除日记本身。 */
export async function deleteWork(id: string) {
  await db.transaction('rw', [db.entries, db.assets, db.works], async () => {
    const work = await db.works.get(id)
    await db.entries
      .where('workIds')
      .equals(id)
      .modify((e) => {
        e.workIds = e.workIds.filter((w) => w !== id)
      })
    await db.works.delete(id)
    if (work?.coverAssetId) await deleteUnreferencedAssets([work.coverAssetId])
  })
}

/** 每部作品关联的日记数量。 */
export async function countEntriesByWork(): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  await db.entries.each((e) => e.workIds.forEach((w) => counts.set(w, (counts.get(w) ?? 0) + 1)))
  return counts
}
