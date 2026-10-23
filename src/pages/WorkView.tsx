import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { db, deleteWork, sortEntries, workTypeLabel } from '../db'
import { PLATFORM_LABELS, type Platform } from '../import/parse'
import { formatTime } from '../lib'
import { EntryCard } from './EntryList'
import { Cover } from './Library'

export default function WorkView() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  // null = 已确认不存在；undefined = 加载中
  const work = useLiveQuery(async () => (await db.works.get(id)) ?? null, [id])
  const entries = useLiveQuery(async () => sortEntries(await db.entries.where('workIds').equals(id).toArray()), [id])

  if (work === undefined) return null
  if (work === null)
    return (
      <p className="py-20 text-center text-sm text-mute">
        这部作品不存在。<Link to="/library" className="underline">回到作品馆</Link>
      </p>
    )

  async function remove() {
    if (!confirming) return setConfirming(true)
    try {
      await deleteWork(id)
      navigate('/library', { replace: true })
    } catch (err) {
      console.error('删除作品失败', err)
      setError('删除失败，请重试。')
    }
  }

  const count = entries?.length ?? 0

  return (
    <article className="pb-16">
      <div className="mb-8 flex items-center justify-between text-sm">
        <Link to="/library" className="text-mute">← 作品馆</Link>
        <Link to={`/work/${id}/edit`} className="rounded-full border border-ink px-4 py-1.5">编辑</Link>
      </div>

      <header className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover work={work} className="max-w-56" />
        <div className="min-w-0">
          <p className="mb-2 text-xs tracking-[0.3em] text-mute">{workTypeLabel(work.type)}</p>
          <h1 className="font-serif text-3xl leading-tight break-words">{work.name}</h1>
          {work.author && <p className="mt-2 text-sm">{work.author}</p>}
          <p className="mt-3 text-sm text-mute">{count} 篇日记</p>
          {work.sources?.map((s) => (
            <a key={`${s.platform}:${s.externalId}`} href={s.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-xs text-mute underline">
              {PLATFORM_LABELS[s.platform as Platform] ?? s.platform} ↗
            </a>
          ))}
        </div>
      </header>

      <section className="mt-12">
        <h2 className="mb-2 border-b border-ink pb-3 font-serif text-lg">关联日记</h2>
        {entries === undefined ? null : entries.length === 0 ? (
          <p className="py-10 text-center text-sm text-mute">还没有日记关联到这部作品。可以在编辑日记时添加关联。</p>
        ) : (
          <ul>
            {entries.map((e) => (
              <EntryCard key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-16 space-y-1 border-t border-line pt-4 text-xs text-mute">
        <p>创建于 {formatTime(work.createdAt)}</p>
        <p>最后修改 {formatTime(work.updatedAt)}</p>
        <div className="mt-4 flex flex-wrap gap-4">
          <button onClick={remove} className="text-left text-red-700">
            {confirming
              ? `删除后，${count} 篇日记会解除与它的关联，日记和图片都会保留。再点一次确认删除`
              : '删除这部作品'}
          </button>
          {confirming && <button onClick={() => setConfirming(false)}>取消</button>}
        </div>
        {error && <p className="text-red-700">{error}</p>}
      </footer>
    </article>
  )
}
