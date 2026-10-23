import { useState } from 'react'
import { exportBackup, getLastBackup, importBackup, setLastBackup, type BackupSummary } from '../backup'
import { formatTime, shareOrDownload } from '../lib'

type Status = { kind: 'idle' | 'working' | 'done' | 'error'; text: string }

export default function Backup() {
  const [lastBackup, setLast] = useState(getLastBackup)
  const [exportStatus, setExportStatus] = useState<Status>({ kind: 'idle', text: '' })
  const [importStatus, setImportStatus] = useState<Status>({ kind: 'idle', text: '' })

  async function runExport() {
    setExportStatus({ kind: 'working', text: '正在生成备份…' })
    try {
      const { file, summary } = await exportBackup()
      const shared = await shareOrDownload(file, '页间备份')
      if (!shared) return setExportStatus({ kind: 'idle', text: '已取消。' })
      const now = Date.now()
      setLastBackup(now)
      setLast(now)
      setExportStatus({ kind: 'done', text: `已导出：${describe(summary)}，文件 ${formatSize(file.size)}。` })
    } catch (err) {
      console.error('导出失败', err)
      setExportStatus({ kind: 'error', text: `导出失败：${(err as Error).message ?? err}` })
    }
  }

  async function runImport(file: File | undefined) {
    if (!file) return
    setImportStatus({ kind: 'working', text: '正在读取备份…' })
    try {
      const added = await importBackup(file)
      setImportStatus({
        kind: 'done',
        text: added.entries + added.works + added.canvases + added.boxItems + added.cutouts + added.proEdits + added.assets === 0 ? '备份中的内容本机都已经有了，没有需要恢复的。' : `已恢复：${describe(added)}。`,
      })
    } catch (err) {
      console.error('导入失败', err)
      setImportStatus({ kind: 'error', text: (err as Error).message ?? String(err) })
    }
  }

  return (
    <div className="pb-16">
      <header className="mb-8 border-b border-ink pb-3">
        <h1 className="font-serif text-2xl">备份与恢复</h1>
        <p className="mt-1 text-xs tracking-[0.2em] text-mute uppercase">Backup</p>
      </header>

      <p className="mb-10 text-sm leading-relaxed text-mute">
        日记、作品和图片只保存在这台设备的浏览器里。浏览器清除数据或更换设备时会丢失，请定期导出备份，把文件存到「文件」App、iCloud 云盘或电脑上。
      </p>

      <section className="mb-12">
        <h2 className="mb-2 font-serif text-lg">导出备份</h2>
        <p className="mb-4 text-sm text-mute">
          {lastBackup ? `上次备份：${formatTime(lastBackup)}` : '还没有备份过。'}
        </p>
        <button
          onClick={runExport}
          disabled={exportStatus.kind === 'working'}
          className="rounded-full bg-ink px-6 py-2 text-sm text-paper disabled:opacity-40"
        >
          导出全部数据
        </button>
        <StatusLine status={exportStatus} />
      </section>

      <section>
        <h2 className="mb-2 font-serif text-lg">从备份恢复</h2>
        <p className="mb-4 text-sm text-mute">只会补回缺少的内容，不会删除本机现有的日记；同一篇日记保留较新的版本。</p>
        <label className="inline-block cursor-pointer rounded-full border border-ink px-6 py-2 text-sm">
          选择备份文件
          <input
            id="backup-file"
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              runImport(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
        <StatusLine status={importStatus} />
      </section>
    </div>
  )
}

function StatusLine({ status }: { status: Status }) {
  if (!status.text) return null
  return <p className={`mt-3 text-sm ${status.kind === 'error' ? 'text-red-700' : 'text-mute'}`}>{status.text}</p>
}

const formatSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

const describe = (s: BackupSummary) => `${s.entries} 篇日记、${s.works} 部作品、${s.canvases} 张画布、${s.boxItems} 个素材盒条目、${s.cutouts} 个剪裁、${s.proEdits} 个专业编辑记录、${s.assets} 个图片文件`
