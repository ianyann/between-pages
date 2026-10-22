import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import './index.css'
import { db, requestPersistentStorage } from './db'
import { newId } from './lib'
import Home from './pages/Home'
import EntryList from './pages/EntryList'
import EntryView from './pages/EntryView'
import EntryEditor from './pages/EntryEditor'
import Library from './pages/Library'
import WorkView from './pages/WorkView'
import WorkEditor from './pages/WorkEditor'
import Diagnostics from './pages/Diagnostics'
import Backup from './pages/Backup'

requestPersistentStorage()

function Layout() {
  const { pathname } = useLocation()
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {pathname !== '/' && !pathname.endsWith('/edit') && pathname !== '/library/new' && (
        <nav className="flex items-baseline justify-between py-5">
          <Link to="/" className="font-serif text-base tracking-[0.2em]">页间</Link>
          <div className="flex gap-5 text-sm text-mute">
            <Link to="/entries">日记</Link>
            <Link to="/library">作品馆</Link>
            <Link to="/new">+ 新建</Link>
          </div>
        </nav>
      )}
      <DbStatus />
      <ErrorBoundary key={pathname}>
        <Outlet />
      </ErrorBoundary>
    </div>
  )
}

const DATA_SAFE_HINT = '这不代表数据已被删除。请不要清除浏览器数据，并打开「数据诊断」页查看。'

/** 数据库打开或升级失败时明确提示，避免显示成「没有记录」。 */
function DbStatus() {
  const [problem, setProblem] = useState('')
  useEffect(() => {
    const onBlocked = () => setProblem('数据库升级被另一个打开的页间页面阻止。请关闭其他页间页面后刷新。')
    db.on('blocked', onBlocked)
    db.open().catch((err) => setProblem(`数据库无法打开：${err?.name ?? ''} ${err?.message ?? err}`))
    return () => db.on('blocked').unsubscribe(onBlocked)
  }, [])
  if (!problem) return null
  return (
    <div role="alert" className="my-4 border border-red-700 p-4 text-sm text-red-700">
      <p>{problem}</p>
      <p className="mt-1">{DATA_SAFE_HINT}</p>
      <Link to="/diagnostics" className="mt-2 inline-block underline">打开数据诊断</Link>
    </div>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(err: unknown) {
    return { error: String((err as Error)?.message ?? err) }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="my-10 text-sm">
        <p className="text-red-700">页面出错：{this.state.error}</p>
        <p className="mt-1 text-mute">{DATA_SAFE_HINT}</p>
        <a href="#/diagnostics" className="mt-2 inline-block underline">打开数据诊断</a>
      </div>
    )
  }
}

/** 新建：先分配稳定 ID，再进入编辑页。首次有内容时才写入数据库。 */
function NewEntry() {
  const [id] = useState(newId)
  return <Navigate to={`/entry/${id}/edit`} replace />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="entries" element={<EntryList />} />
          <Route path="new" element={<NewEntry />} />
          <Route path="entry/:id" element={<EntryView />} />
          <Route path="entry/:id/edit" element={<EntryEditor />} />
          <Route path="library" element={<Library />} />
          <Route path="library/new" element={<WorkEditor />} />
          <Route path="work/:id" element={<WorkView />} />
          <Route path="work/:id/edit" element={<WorkEditor />} />
          <Route path="diagnostics" element={<Diagnostics />} />
          <Route path="backup" element={<Backup />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
)
