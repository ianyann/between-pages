import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { getLastBackup } from '../backup'
import { listEntries } from '../db'
import { EntryCard } from './EntryList'

const RECENT_COUNT = 5
const BACKUP_REMINDER_DAYS = 7

export default function Home() {
  const recent = useLiveQuery(() => listEntries(RECENT_COUNT))
  const lastBackup = getLastBackup()
  const needsBackup = !!recent?.length && (!lastBackup || Date.now() - lastBackup > BACKUP_REMINDER_DAYS * 86400_000)

  return (
    <div>
      <header className="pt-10 pb-14 text-center sm:pt-16">
        <p className="mb-4 text-[10px] tracking-[0.4em] text-mute uppercase">A Private Journal</p>
        <h1 className="font-serif text-5xl tracking-[0.15em] sm:text-6xl">页间</h1>
        <p className="mt-3 font-serif text-sm tracking-[0.3em] text-mute italic">Between Pages</p>
        <p className="mx-auto mt-8 max-w-xs text-sm leading-relaxed text-mute">
          记下读过的书、看过的画面，和那些停留在两页之间的感受。
        </p>
        <Link
          to="/new"
          className="mt-10 inline-block rounded-full bg-ink px-8 py-3 text-sm tracking-widest text-paper"
        >
          新建记录
        </Link>
        <div className="mt-6">
          <Link to="/library" className="text-sm tracking-wider text-mute">
            作品馆 Library →
          </Link>
        </div>
      </header>

      {needsBackup && (
        <Link to="/backup" className="mb-10 flex items-center justify-between border border-ink px-4 py-3 text-sm">
          <span>{lastBackup ? `已超过 ${BACKUP_REMINDER_DAYS} 天没有备份` : '还没有备份过，数据只存在这台设备上'}</span>
          <span className="shrink-0 pl-3">去备份 →</span>
        </Link>
      )}

      <section>
        <div className="mb-2 flex items-baseline justify-between border-b border-ink pb-3">
          <h2 className="font-serif text-lg">最近</h2>
          <Link to="/entries" className="text-xs tracking-wider text-mute">全部 →</Link>
        </div>
        {recent === undefined ? null : recent.length === 0 ? (
          <p className="py-12 text-center text-sm text-mute">还没有记录，从第一页开始吧。</p>
        ) : (
          <ul>
            {recent.map((e) => (
              <EntryCard key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-16 pb-8 text-center">
        <div className="flex justify-center gap-6 text-xs text-mute">
          <Link to="/backup">备份与恢复</Link>
          <Link to="/diagnostics">数据诊断</Link>
        </div>
      </footer>
    </div>
  )
}
