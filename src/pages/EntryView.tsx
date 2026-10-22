import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { db, deleteEntry } from '../db'
import { formatDate, formatTime, useAssetUrl } from '../lib'

export default function EntryView() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  // null = 已确认不存在；undefined = 加载中
  const entry = useLiveQuery(async () => (await db.entries.get(id)) ?? null, [id])

  if (entry === undefined) return null
  if (entry === null)
    return (
      <p className="py-20 text-center text-sm text-mute">
        这篇记录不存在。<Link to="/" className="underline">回到首页</Link>
      </p>
    )

  async function remove() {
    // 两步确认（不用 confirm()，部分内嵌浏览器环境会直接屏蔽它）
    if (!confirming) return setConfirming(true)
    await deleteEntry(id)
    navigate('/entries', { replace: true })
  }

  return (
    <article className="pb-16">
      <div className="mb-10 flex items-center justify-between text-sm">
        <Link to="/entries" className="text-mute">← 全部记录</Link>
        <Link to={`/entry/${id}/edit`} className="rounded-full border border-ink px-4 py-1.5">编辑</Link>
      </div>

      <div className="mb-4 flex items-center gap-3 text-xs tracking-wider text-mute">
        <time>{formatDate(entry.entryDate)}</time>
        {entry.status === 'draft' && <span className="border border-mute/60 px-1.5 leading-4">草稿</span>}
      </div>
      <h1 className={`mb-8 font-serif text-3xl leading-tight ${entry.title ? '' : 'text-mute'}`}>
        {entry.title || '无标题'}
      </h1>
      {entry.body && <div className="font-serif text-[17px] leading-loose whitespace-pre-wrap">{entry.body}</div>}

      {entry.imageIds.length > 0 && (
        <div className="mt-10 space-y-4">
          {entry.imageIds.map((assetId) => (
            <StoredImage key={assetId} id={assetId} />
          ))}
        </div>
      )}

      <footer className="mt-16 space-y-1 border-t border-line pt-4 text-xs text-mute">
        <p>创建于 {formatTime(entry.createdAt)}</p>
        <p>最后修改 {formatTime(entry.updatedAt)}</p>
        <div className="mt-4 flex gap-4">
          <button onClick={remove} className="text-red-700">{confirming ? '删除后无法恢复，再点一次确认删除' : '删除这篇记录'}</button>
          {confirming && <button onClick={() => setConfirming(false)}>取消</button>}
        </div>
      </footer>
    </article>
  )
}

function StoredImage({ id }: { id: string }) {
  const url = useAssetUrl(id)
  if (url === undefined) return <div className="aspect-[4/3] bg-line" />
  if (url === null) return <div className="py-8 text-center text-xs text-mute">图片缺失</div>
  return <img src={url} alt="" className="w-full" />
}
