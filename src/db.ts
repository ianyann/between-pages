import Dexie, { type EntityTable, type Transaction } from 'dexie'

/**
 * 持久化数据结构。修改字段时：
 * 1. 新增 db.version(n + 1) 声明新结构，用 .upgrade() 迁移旧数据（旧版本声明保留不删）；
 * 2. 同步更新 DB_VERSION。
 *
 * 版本历史：
 * v1 第一阶段：entries、assets
 * v2 第二阶段：新增 works；entries 增加 *workIds、*imageIds 多值索引
 * v3 第三阶段：新增 canvases（创作桌画布）；旧的 Entry.canvas 字段迁入该表
 * v3.5 新增 boxItems（素材盒）；画布元素允许位于纸张外的桌面区域（坐标系不变）
 * v5 新增 cutouts（剪裁素材的遮罩与来源）；画布新增 drawing（绘画层）元素类型
 * v6 新增 proEdits（专业编辑器实验：结果 PNG、来源与可选 PSD 的关联）
 */
export const DB_VERSION = 6

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

  /** 已弃用：v3 起画布保存在 canvases 表。保留此字段（恒为 null）只为兼容旧数据与旧备份。 */
  canvas: unknown | null
}

/**
 * 坐标约定（世界坐标，保存到数据库）：
 * 纸张固定在 (0, 0)–(CANVAS_WIDTH, CANVAS_HEIGHT)；桌面是包围纸张的更大区域 DESK。
 * 元素可以位于纸张外（坐标为负或超出纸张），与屏幕缩放、平移无关。导出只取纸张范围。
 */
export const CANVAS_WIDTH = 900
export const CANVAS_HEIGHT = 1200
export const DESK = { x: -700, y: -500, width: 2300, height: 2200 }
export const CANVAS_FORMAT = 2 // 2：新增 drawing 元素

/** 一篇日记的创作桌画布。 */
export interface CanvasDoc {
  id: string
  entryId: string // 所属日记
  format: number // 画布数据格式版本（CANVAS_FORMAT）
  width: number
  height: number
  background: string
  elements: CanvasElement[] // 按 z 从下到上排列
  assetIds: string[] // 画布用到的图片，由 elements 派生，用于引用检查
  createdAt: number
  updatedAt: number
}

interface BaseElement {
  id: string // 画布内唯一；同一素材多次放入也各自独立
  x: number // 左上角（旋转前），逻辑坐标
  y: number
  width: number
  height: number
  rotation: number // 角度，绕左上角
  z: number // 图层顺序，0 在最下
}

export interface ImageElement extends BaseElement {
  type: 'image'
  assetId: string // 指向 assets 表，不复制图片数据
  style: { opacity: number }
}

export type TextPreset = 'title' | 'body' | 'note'

export interface TextStyle {
  preset: TextPreset // 初始样式来源，仅作记录
  fontFamily: 'serif' | 'sans'
  fontSize: number
  fontWeight: 'normal' | 'bold'
  color: string
  align: 'left' | 'center' | 'right'
  lineHeight: number
  letterSpacing: number
}

export interface TextElement extends BaseElement {
  type: 'text'
  text: string // 画布上的文字，独立于日记正文
  style: TextStyle
}

export type StrokeTool = 'pen' | 'marker' | 'eraser'

/** 一条笔画。坐标相对所在绘画层的原点 (x, y)，扁平数组 [x0, y0, x1, y1, …]。 */
export interface Stroke {
  id: string
  tool: StrokeTool // eraser 只擦除同一绘画层里在它之前的笔迹
  color: string
  width: number // 世界坐标中的笔宽
  opacity: number
  points: number[]
}

/**
 * 绘画层：作为一个整体参与图层顺序、移动、复制与删除。
 * x, y 为原点（新建时为 0, 0，即纸张左上角）；width, height 为笔迹范围（由 strokes 派生）。
 */
export interface DrawingElement extends BaseElement {
  type: 'drawing'
  strokes: Stroke[]
  style: { opacity: number }
}

export type CanvasElement = ImageElement | TextElement | DrawingElement

export const BOX_CATEGORIES = ['人物', '场景', '物件', '截图', '剪裁', '专业编辑', '其他'] as const
export type BoxCategory = (typeof BOX_CATEGORIES)[number]

/** 素材盒条目：只存索引信息与缩略图，原图仍在 assets 表（id 相同）。可被任意日记复用。 */
export interface BoxItem {
  id: string // = assetId
  category: BoxCategory
  name: string
  width: number
  height: number
  thumb: ArrayBuffer // 长边约 240px 的缩略图
  thumbType: string
  addedAt: number
}

/**
 * 剪裁素材：结果是 assets 表中的一张透明 PNG（id 相同，已裁到可见范围）。
 * 原图保持不变；mask 是与原图同尺寸的可编辑透明遮罩，重新打开时据此继续编辑。
 */
export interface Cutout {
  id: string // = 结果素材 ID
  sourceAssetId: string // 原图，永远不被修改
  method: 'lasso' | 'brush' // 最近一次的主要方式：轮廓剪裁 / 只用画笔修整
  path: number[] // 最近一次闭合轮廓（原图像素坐标，扁平数组），没有则为空
  mask: ArrayBuffer // PNG，alpha 通道即遮罩
  width: number // 遮罩 / 原图尺寸
  height: number
  box: { x: number; y: number; width: number; height: number } // 结果 PNG 在原图中的位置
  createdAt: number
  updatedAt: number
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
  canvases: EntityTable<CanvasDoc, 'id'>
  boxItems: EntityTable<BoxItem, 'id'>
  cutouts: EntityTable<Cutout, 'id'>
  proEdits: EntityTable<ProEdit, 'id'>
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

db.version(3)
  .stores({
    entries: 'id, entryDate, updatedAt, status, *workIds, *imageIds',
    assets: 'id, entryId',
    works: 'id, type, name, updatedAt, coverAssetId',
    canvases: 'id, entryId, updatedAt, *assetIds',
  })
  .upgrade(async (tx: Transaction) => {
    // 第一、二阶段从未写入 Entry.canvas；若存在符合结构的旧画布，迁入新表并把原字段置 null，其余一律不动
    const entries: Entry[] = await tx.table('entries').toArray()
    const now = Date.now()
    for (const e of entries) {
      const old = e.canvas as Partial<CanvasDoc> | null | undefined
      if (old === null) continue
      if (old && Array.isArray(old.elements)) {
        await tx.table('canvases').put(normalizeCanvas({ ...old, id: newCanvasId(e.id), entryId: e.id, createdAt: now, updatedAt: now }))
      }
      await tx.table('entries').update(e.id, { canvas: null })
    }
  })

// v4 只新增素材盒表，不改动任何已有数据
db.version(4).stores({
  entries: 'id, entryDate, updatedAt, status, *workIds, *imageIds',
  assets: 'id, entryId',
  works: 'id, type, name, updatedAt, coverAssetId',
  canvases: 'id, entryId, updatedAt, *assetIds',
  boxItems: 'id, category, addedAt',
})

// v5 只新增剪裁表，不改动任何已有数据
db.version(5).stores({
  entries: 'id, entryDate, updatedAt, status, *workIds, *imageIds',
  assets: 'id, entryId',
  works: 'id, type, name, updatedAt, coverAssetId',
  canvases: 'id, entryId, updatedAt, *assetIds',
  boxItems: 'id, category, addedAt',
  cutouts: 'id, sourceAssetId, updatedAt',
})

// v6 只新增专业编辑记录表，不改动任何已有数据
db.version(6).stores({
  entries: 'id, entryDate, updatedAt, status, *workIds, *imageIds',
  assets: 'id, entryId',
  works: 'id, type, name, updatedAt, coverAssetId',
  canvases: 'id, entryId, updatedAt, *assetIds',
  boxItems: 'id, category, addedAt',
  cutouts: 'id, sourceAssetId, updatedAt',
  proEdits: 'id, sourceAssetId, psdAssetId, updatedAt',
})

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

/** 涉及素材增删的事务都需要这些表，以便检查全部引用。 */
const ASSET_TABLES = () => [db.entries, db.assets, db.works, db.canvases, db.boxItems, db.cutouts, db.proEdits]

/**
 * 删除不再被任何日记、作品、画布、素材盒或剪裁来源引用的素材。必须在包含 entries、works、assets 的读写事务中调用，
 * 且调用前先写入引用变化。
 */
async function deleteUnreferencedAssets(ids: Iterable<string>) {
  const queue = [...new Set(ids)]
  while (queue.length) {
    const id = queue.shift()!
    const usedByEntry = await db.entries.where('imageIds').equals(id).count()
    const usedByWork = await db.works.where('coverAssetId').equals(id).count()
    const usedByCanvas = await db.canvases.where('assetIds').equals(id).count()
    const inBox = await db.boxItems.get(id)
    const usedAsCutoutSource = await db.cutouts.where('sourceAssetId').equals(id).count() // 剪裁结果需要原图才能再编辑
    const usedByProEdit =
      (await db.proEdits.where('sourceAssetId').equals(id).count()) + (await db.proEdits.where('psdAssetId').equals(id).count())
    if (!usedByEntry && !usedByWork && !usedByCanvas && !inBox && !usedAsCutoutSource && !usedByProEdit) {
      await db.assets.delete(id)
      await db.cutouts.delete(id) // 若它本身是剪裁结果，一并删除其遮罩记录（原图不受影响）
      // 若它是专业编辑的结果：删除关联记录，其专属 PSD 随后按同样规则检查；来源图不连带删除
      const pro = await db.proEdits.get(id)
      if (pro) {
        await db.proEdits.delete(id)
        if (pro.psdAssetId) queue.push(pro.psdAssetId)
      }
    }
  }
}

/** 在一个事务内保存日记与图片变更：要么全部成功，要么全部不生效。 */
export async function saveEntry(entry: Entry, newAssets: Asset[], removedAssetIds: string[]) {
  await db.transaction('rw', ASSET_TABLES(), async () => {
    if (newAssets.length) await db.assets.bulkPut(newAssets)
    await db.entries.put(entry)
    await deleteUnreferencedAssets(removedAssetIds)
  })
}

/** 删除日记及其画布；图片只在不再被引用时删除。 */
export async function deleteEntry(id: string) {
  await db.transaction('rw', ASSET_TABLES(), async () => {
    const entry = await db.entries.get(id)
    const ownKeys = await db.assets.where('entryId').equals(id).primaryKeys()
    const canvases = await db.canvases.where('entryId').equals(id).toArray()
    await db.canvases.bulkDelete(canvases.map((c) => c.id))
    await db.entries.delete(id)
    await deleteUnreferencedAssets([...(entry?.imageIds ?? []), ...ownKeys, ...canvases.flatMap((c) => c.assetIds)])
  })
}

/** 把图片放进素材盒（原图与条目同一事务写入）。 */
export async function addToBox(asset: Asset, item: BoxItem) {
  await db.transaction('rw', [db.assets, db.boxItems], async () => {
    await db.assets.put(asset)
    await db.boxItems.put(item)
  })
}

/**
 * 专业编辑器（Photopea 实验）的保存记录：
 * id 为保存到素材盒的透明 PNG 结果；psdAssetId 指向同时保存的 PSD（保留图层与蒙版，不作为图片显示）。
 * 来源图与 PSD 都不会因为删除结果而连带删除来源图。
 */
export interface ProEdit {
  id: string // = 结果 PNG 的素材 ID
  sourceAssetId: string // 打开编辑器时的素材（原图或上一次的结果），从不被覆盖
  psdAssetId: string | null
  editor: 'photopea'
  createdAt: number
  updatedAt: number
}

export const PSD_MIME = 'image/vnd.adobe.photoshop'

/** 保存专业编辑结果：PNG、可选 PSD、关联记录、素材盒条目在同一事务中写入。 */
export async function saveProEdit(png: Asset, psd: Asset | null, record: ProEdit, item: BoxItem) {
  await db.transaction('rw', [db.assets, db.proEdits, db.boxItems], async () => {
    await db.assets.put(png)
    if (psd) await db.assets.put(psd)
    await db.proEdits.put(record)
    await db.boxItems.put(item)
  })
}

export type Box = { x: number; y: number; width: number; height: number }

/**
 * 保存剪裁结果：结果 PNG、可编辑遮罩记录、素材盒条目在同一事务中写入。
 * 原图从不改动；重新编辑时沿用同一个结果素材 ID。
 */
export async function saveCutout(result: Asset, cutout: Cutout, item: BoxItem) {
  await db.transaction('rw', [db.assets, db.cutouts, db.boxItems], async () => {
    await db.assets.put(result)
    await db.cutouts.put(cutout)
    const existing = await db.boxItems.get(item.id)
    await db.boxItems.put(existing ? { ...existing, thumb: item.thumb, thumbType: item.thumbType, width: item.width, height: item.height } : item)
  })
}

/** 剪裁结果的可见范围变化后，调整一个使用它的图片元素，让画面中的人物保持原位（考虑旋转）。 */
export function rebaseImageElement(el: ImageElement, oldBox: Box, newBox: Box): ImageElement {
  const sx = el.width / oldBox.width
  const sy = el.height / oldBox.height
  const dx = (newBox.x - oldBox.x) * sx
  const dy = (newBox.y - oldBox.y) * sy
  const r = (el.rotation * Math.PI) / 180
  return {
    ...el,
    x: el.x + dx * Math.cos(r) - dy * Math.sin(r),
    y: el.y + dx * Math.sin(r) + dy * Math.cos(r),
    width: newBox.width * sx,
    height: newBox.height * sy,
  }
}

/** 在除 skipCanvasId 外的所有画布中调整使用该剪裁结果的元素（当前打开的画布由编辑器自己处理）。 */
export async function rebaseCutoutInCanvases(assetId: string, oldBox: Box, newBox: Box, skipCanvasId: string) {
  await db.transaction('rw', db.canvases, async () => {
    const list = await db.canvases.where('assetIds').equals(assetId).toArray()
    for (const c of list) {
      if (c.id === skipCanvasId) continue
      const elements = c.elements.map((el) => (el.type === 'image' && el.assetId === assetId ? rebaseImageElement(el, oldBox, newBox) : el))
      await db.canvases.put(normalizeCanvas({ ...c, elements, updatedAt: Date.now() }))
    }
  })
}

/** 读取日记的画布；没有则返回 undefined。 */
export async function loadCanvas(entryId: string): Promise<CanvasDoc | undefined> {
  const doc = await db.canvases.where('entryId').equals(entryId).first()
  return doc && normalizeCanvas(doc)
}

/** 保存画布及新上传的图片（同一事务）。 */
export async function saveCanvas(doc: CanvasDoc, newAssets: Asset[]) {
  await db.transaction('rw', [db.canvases, db.assets], async () => {
    if (newAssets.length) await db.assets.bulkPut(newAssets)
    await db.canvases.put(normalizeCanvas(doc))
  })
}

/**
 * 清理只为这篇日记上传、却已不被任何地方引用的图片（例如从画布上删掉的本地图片）。
 * 只在打开创作桌时调用：此时没有撤销历史，不会删掉之后还可能被撤销找回的图片。
 */
export async function cleanupEntryAssets(entryId: string) {
  await db.transaction('rw', ASSET_TABLES(), async () => {
    await deleteUnreferencedAssets(await db.assets.where('entryId').equals(entryId).primaryKeys())
  })
}

export const newCanvasId = (entryId: string) => `canvas-${entryId}`

/** 补全缺失字段、按 z 排序并重新编号、派生 assetIds。读写与导入共用。 */
export function normalizeCanvas(doc: Partial<CanvasDoc> & { id: string; entryId: string }): CanvasDoc {
  const elements = (Array.isArray(doc.elements) ? doc.elements : [])
    .filter((el) => el && typeof el.id === 'string' && (el.type === 'image' || el.type === 'text' || el.type === 'drawing'))
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    .map((el, i) => ({ ...el, rotation: el.rotation ?? 0, z: i }))
  return {
    id: doc.id,
    entryId: doc.entryId,
    format: doc.format ?? CANVAS_FORMAT,
    width: doc.width ?? CANVAS_WIDTH,
    height: doc.height ?? CANVAS_HEIGHT,
    background: doc.background ?? '#F7F6F2',
    elements,
    assetIds: [...new Set(elements.flatMap((el) => (el.type === 'image' ? [el.assetId] : [])))],
    createdAt: doc.createdAt ?? Date.now(),
    updatedAt: doc.updatedAt ?? Date.now(),
  }
}

/** 保存作品；更换或移除封面时，旧封面仅在无其他引用时删除。 */
export async function saveWork(work: Work, newCover: Asset | null) {
  await db.transaction('rw', ASSET_TABLES(), async () => {
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
  await db.transaction('rw', ASSET_TABLES(), async () => {
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
