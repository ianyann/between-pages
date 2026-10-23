import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { countEntriesByWork, db, WORK_TYPES, workTypeLabel, type Work, type WorkType } from '../db'
import { useAssetUrl } from '../lib'

export default function Library() {
  const works = useLiveQuery(() => db.works.orderBy('updatedAt').reverse().toArray(), [])
  const counts = useLiveQuery(countEntriesByWork, [])
  const [type, setType] = useState<WorkType | 'all'>('all')
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const shown = works?.filter((w) => (type === 'all' || w.type === type) && (w.name.toLowerCase().includes(q) || (w.author ?? '').toLowerCase().includes(q)))

  return (
    <div className="pb-16">
      <header className="mb-6 flex items-baseline justify-between border-b border-ink pb-3">
        <h1 className="font-serif text-2xl">作品馆</h1>
        <span className="text-xs tracking-[0.2em] text-mute uppercase">Library · {works?.length ?? 0}</span>
      </header>

      <div className="mb-8 space-y-4">
        <div className="flex items-center gap-3">
          <input
            id="library-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索作品名称或作者"
            className="min-w-0 flex-1 border-b border-line bg-transparent py-1.5 outline-none placeholder:text-mute/60 focus:border-ink"
          />
          <Link to="/library/import" className="shrink-0 rounded-full border border-ink px-4 py-1.5 text-sm">
            从链接导入
          </Link>
          <Link to="/library/new" className="shrink-0 rounded-full bg-ink px-4 py-1.5 text-sm text-paper">
            新增作品
          </Link>
        </div>
        <div className="-mx-5 flex gap-2 overflow-x-auto px-5 text-sm">
          {[{ value: 'all' as const, label: '全部' }, ...WORK_TYPES].map((t) => (
            <button
              key={t.value}
              onClick={() => setType(t.value)}
              className={`shrink-0 rounded-full border px-3.5 py-1 ${type === t.value ? 'border-ink bg-ink text-paper' : 'border-line text-mute'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {shown === undefined ? null : works!.length === 0 ? (
        <p className="py-16 text-center text-sm text-mute">
          作品馆还是空的。
          <Link to="/library/new" className="underline">添加第一部作品</Link>
        </p>
      ) : shown.length === 0 ? (
        <p className="py-16 text-center text-sm text-mute">没有符合条件的作品。</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3">
          {shown.map((w) => (
            <WorkCard key={w.id} work={w} count={counts?.get(w.id) ?? 0} />
          ))}
        </ul>
      )}
    </div>
  )
}

function WorkCard({ work, count }: { work: Work; count: number }) {
  return (
    <li>
      <Link to={`/work/${work.id}`} className="block">
        <Cover work={work} />
        <h2 className="mt-3 font-serif leading-snug">{work.name}</h2>
        <p className="mt-0.5 text-xs text-mute">
          {workTypeLabel(work.type)} · {count} 篇日记
        </p>
      </Link>
    </li>
  )
}

/** 作品封面；没有封面时以作品名称排版代替。 */
export function Cover({ work, className = '' }: { work: Work; className?: string }) {
  const url = useAssetUrl(work.coverAssetId ?? undefined)
  return (
    <div className={`aspect-[3/4] w-full overflow-hidden bg-line ${className}`}>
      {url ? (
        <img src={url} alt={`${work.name} 封面`} className="h-full w-full object-cover" />
      ) : url === null ? (
        <div className="flex h-full flex-col justify-between p-3">
          <span className="text-[10px] tracking-[0.3em] text-mute">{workTypeLabel(work.type)}</span>
          <span className="font-serif text-lg leading-snug break-words">{work.name}</span>
        </div>
      ) : null}
    </div>
  )
}
