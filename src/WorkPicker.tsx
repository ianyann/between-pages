import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db, saveWork, WORK_TYPES, workTypeLabel, type WorkType } from './db'
import { newId } from './lib'

/** 日记编辑页中的作品关联：选择已有作品，或按名称快速新建。只读写作品 ID。 */
export default function WorkPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const works = useLiveQuery(() => db.works.orderBy('updatedAt').reverse().toArray(), [])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  const byId = new Map(works?.map((w) => [w.id, w]))
  const linked = value.map((id) => byId.get(id)).filter((w) => w !== undefined)
  const q = query.trim()
  const matches = works?.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())) ?? []
  const exact = works?.some((w) => w.name === q)

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])

  async function create(type: WorkType) {
    const now = Date.now()
    const id = newId()
    try {
      await saveWork({ id, name: q, type, coverAssetId: null, createdAt: now, updatedAt: now }, null)
      onChange([...value, id])
      setQuery('')
      setError('')
    } catch (err) {
      console.error('新建作品失败', err)
      setError('新建作品失败，请重试。')
    }
  }

  return (
    <section className="mt-10 border-t border-line pt-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs tracking-[0.2em] text-mute">关联作品</h2>
        <button onClick={() => setOpen(!open)} className="text-sm text-mute">
          {open ? '收起' : '+ 关联作品'}
        </button>
      </div>

      {linked.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {linked.map((w) => (
            <li key={w.id} className="flex items-center gap-1 rounded-full border border-ink py-1 pr-1.5 pl-3 text-sm">
              <span className="font-serif">{w.name}</span>
              <span className="text-xs text-mute">{workTypeLabel(w.type)}</span>
              <button
                onClick={() => toggle(w.id)}
                className="ml-0.5 flex h-6 w-6 items-center justify-center text-mute"
                aria-label={`取消关联 ${w.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !open && <p className="text-sm text-mute">未关联作品</p>
      )}

      {open && (
        <div className="mt-4 border border-line bg-white/40 p-3">
          <input
            id="work-picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索或输入新作品名称"
            className="w-full border-b border-line bg-transparent pb-2 outline-none placeholder:text-mute/60"
          />
          <ul className="mt-2 max-h-64 overflow-y-auto">
            {matches.map((w) => {
              const on = value.includes(w.id)
              return (
                <li key={w.id}>
                  <button onClick={() => toggle(w.id)} className="flex w-full items-center gap-3 py-2.5 text-left">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center border text-xs ${on ? 'border-ink bg-ink text-paper' : 'border-mute/60'}`}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-serif">{w.name}</span>
                    <span className="text-xs text-mute">{workTypeLabel(w.type)}</span>
                  </button>
                </li>
              )
            })}
            {works && works.length === 0 && !q && (
              <li className="py-3 text-sm text-mute">作品馆还是空的。输入名称即可新建。</li>
            )}
          </ul>
          {q && !exact && (
            <div className="mt-2 border-t border-line pt-3">
              <p className="mb-2 text-sm">
                新建「<span className="font-serif">{q}</span>」为：
              </p>
              <div className="flex flex-wrap gap-2">
                {WORK_TYPES.map((t) => (
                  <button key={t.value} onClick={() => create(t.value)} className="rounded-full border border-mute/60 px-3 py-1 text-sm">
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </div>
      )}
    </section>
  )
}
