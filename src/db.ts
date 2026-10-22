import Dexie, { type EntityTable } from 'dexie'

/**
 * 持久化数据结构。修改字段时：
 * 1. 在下方 db.version(n + 1) 中声明新结构，必要时用 .upgrade() 迁移旧数据；
 * 2. 同步更新 DB_VERSION。
 */
export const DB_VERSION = 1

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

  // —— 预留扩展字段（第一阶段不使用）——
  canvas: CanvasData | null // 自由拼贴画布
  workIds: string[] // 关联的作品（小说 / 漫画 / 电影 / 电视剧）
}

/** 预留：画布内容。第二阶段再细化元素类型。 */
export interface CanvasData {
  version: number
  width: number
  height: number
  elements: unknown[]
}

/** 图片素材：以二进制形式存入 IndexedDB，可在任何时候恢复。 */
export interface Asset {
  id: string
  entryId: string
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
}

db.version(DB_VERSION).stores({
  entries: 'id, entryDate, updatedAt, status',
  assets: 'id, entryId',
})

/** 请求持久化存储，降低浏览器在空间紧张时清除数据的概率。 */
export function requestPersistentStorage() {
  navigator.storage?.persist?.().catch(() => {})
}

/** 日期倒序；同一天内按创建时间倒序。 */
export async function listEntries(limit?: number): Promise<Entry[]> {
  const all = await db.entries.toArray()
  all.sort((a, b) =>
    a.entryDate === b.entryDate ? b.createdAt - a.createdAt : a.entryDate < b.entryDate ? 1 : -1,
  )
  return limit ? all.slice(0, limit) : all
}

/** 在一个事务内保存日记与图片变更：要么全部成功，要么全部不生效。 */
export async function saveEntry(entry: Entry, newAssets: Asset[], removedAssetIds: string[]) {
  await db.transaction('rw', db.entries, db.assets, async () => {
    if (newAssets.length) await db.assets.bulkPut(newAssets)
    if (removedAssetIds.length) await db.assets.bulkDelete(removedAssetIds)
    await db.entries.put(entry)
  })
}

export async function deleteEntry(id: string) {
  await db.transaction('rw', db.entries, db.assets, async () => {
    await db.assets.where('entryId').equals(id).delete()
    await db.entries.delete(id)
  })
}
