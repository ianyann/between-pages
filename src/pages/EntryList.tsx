import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { listEntries, type Entry } from '../db'
import { formatDate, useAssetUrl } from '../lib'

export default function EntryList() {
  const entries = useLiveQuery(() => listEntries())

  return (
    <div>
      <header className="mb-10 flex items-baseline justify-between border-b border-ink pb-3">
        <h1 className="font-serif text-2xl">全部记录</h1>
        <span className="text-xs tracking-[0.2em] text-mute uppercase">Archive · {entries?.length ?? 0}</span>
      </header>
      {entries === undefined ? null : entries.length === 0 ? (
        <p className="py-16 text-center text-sm text-mute">还没有记录。</p>
      ) : (
        <ul>
          {entries.map((e) => (
            <EntryCard key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function EntryCard({ entry }: { entry: Entry }) {
  const thumb = useAssetUrl(entry.imageIds[0])
  const excerpt = entry.body.trim().replace(/\s+/g, ' ').slice(0, 80)

  return (
    <li className="border-b border-line last:border-0">
      <Link to={`/entry/${entry.id}`} className="flex gap-4 py-5">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-mute">
            <time>{formatDate(entry.entryDate)}</time>
            {entry.status === 'draft' && <span className="border border-mute/60 px-1.5 leading-4">草稿</span>}
            {entry.imageIds.length > 1 && <span>{entry.imageIds.length} 图</span>}
          </div>
          <h2 className={`font-serif text-lg leading-snug ${entry.title ? '' : 'text-mute'}`}>
            {entry.title || '无标题'}
          </h2>
          {excerpt && <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-mute">{excerpt}</p>}
        </div>
        {entry.imageIds.length > 0 && (
          <div className="h-20 w-16 shrink-0 overflow-hidden bg-line">
            {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
          </div>
        )}
      </Link>
    </li>
  )
}
