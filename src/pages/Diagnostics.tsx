import { useEffect, useState } from 'react'
import { DB_VERSION } from '../db'

interface DbReport {
  name: string
  version: number
  stores: { name: string; count: number }[]
  error?: string
}

interface Report {
  origin: string
  userAgent: string
  persisted: string
  usage: string
  databases: DbReport[]
  error?: string
}

/**
 * 只读的数据诊断页：直接用原生 IndexedDB 按当前版本打开（不触发升级、不写入），
 * 列出本浏览器在此网址下的所有数据库及每张表的记录数。
 */
export default function Diagnostics() {
  const [report, setReport] = useState<Report>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    collect().then(setReport)
  }, [])

  const text = report ? JSON.stringify(report, null, 2) : ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="pb-16">
      <header className="mb-6 border-b border-ink pb-3">
        <h1 className="font-serif text-2xl">数据诊断</h1>
        <p className="mt-1 text-xs text-mute">只读取，不修改任何数据。程序数据库版本：v{DB_VERSION}</p>
      </header>

      {!report ? (
        <p className="text-sm text-mute">正在读取…</p>
      ) : (
        <div className="space-y-6 text-sm">
          {report.error && <p className="text-red-700">读取失败：{report.error}</p>}
          {report.databases.length === 0 && !report.error && (
            <p>这个浏览器在此网址下没有任何数据库。</p>
          )}
          {report.databases.map((d) => (
            <section key={d.name} className="border border-line p-4">
              <p className="font-serif text-lg">
                {d.name} <span className="text-xs text-mute">版本 {d.version}</span>
              </p>
              {d.error && <p className="mt-1 text-red-700">{d.error}</p>}
              <ul className="mt-2 space-y-1">
                {d.stores.map((s) => (
                  <li key={s.name} className="flex justify-between tabular-nums">
                    <span>{s.name}</span>
                    <span>{s.count} 条</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <dl className="space-y-1 text-xs text-mute">
            <div>持久存储：{report.persisted}</div>
            <div>已用空间：{report.usage}</div>
            <div className="break-all">网址：{report.origin}</div>
            <div className="break-all">浏览器：{report.userAgent}</div>
          </dl>
          <div>
            <button onClick={copy} className="rounded-full border border-ink px-4 py-1.5">
              {copied ? '已复制' : '复制诊断结果'}
            </button>
            <textarea
              id="diagnostics-text"
              readOnly
              value={text}
              rows={8}
              onFocus={(e) => e.target.select()}
              className="mt-3 w-full border border-line bg-transparent p-2 font-mono text-xs"
            />
          </div>
        </div>
      )}
    </div>
  )
}

async function collect(): Promise<Report> {
  const report: Report = {
    origin: location.origin,
    userAgent: navigator.userAgent,
    persisted: '未知',
    usage: '未知',
    databases: [],
  }
  try {
    const persisted = await navigator.storage?.persisted?.()
    if (persisted !== undefined) report.persisted = persisted ? '是' : '否'
    const est = await navigator.storage?.estimate?.()
    if (est?.usage !== undefined) report.usage = `${(est.usage / 1024 / 1024).toFixed(2)} MB`
  } catch {
    // 部分浏览器不支持，忽略
  }
  try {
    // indexedDB.databases() 在较旧的浏览器中不存在，回退为只检查本应用的数据库
    const list = indexedDB.databases ? await indexedDB.databases() : [{ name: 'between-pages' }]
    for (const info of list) {
      if (info.name) report.databases.push(await inspect(info.name))
    }
  } catch (err) {
    report.error = String(err)
  }
  return report
}

function inspect(name: string): Promise<DbReport> {
  return new Promise((resolve) => {
    const result: DbReport = { name, version: 0, stores: [] }
    const req = indexedDB.open(name) // 不指定版本 = 以现有版本打开，不会升级
    req.onupgradeneeded = () => {
      // 数据库不存在时才会触发：中止，避免创建空库
      req.transaction?.abort()
      result.error = '数据库不存在'
    }
    req.onerror = () => {
      result.error ??= String(req.error)
      resolve(result)
    }
    req.onblocked = () => {
      result.error = '被其他打开的页面阻塞'
    }
    req.onsuccess = async () => {
      const idb = req.result
      result.version = idb.version
      const names = [...idb.objectStoreNames]
      try {
        const tx = idb.transaction(names, 'readonly')
        for (const s of names) {
          const count = await new Promise<number>((res, rej) => {
            const c = tx.objectStore(s).count()
            c.onsuccess = () => res(c.result)
            c.onerror = () => rej(c.error)
          })
          result.stores.push({ name: s, count })
        }
      } catch (err) {
        result.error = String(err)
      }
      idb.close()
      resolve(result)
    }
  })
}
