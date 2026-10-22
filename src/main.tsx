import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import './index.css'
import { requestPersistentStorage } from './db'
import { newId } from './lib'
import Home from './pages/Home'
import EntryList from './pages/EntryList'
import EntryView from './pages/EntryView'
import EntryEditor from './pages/EntryEditor'

requestPersistentStorage()

function Layout() {
  const { pathname } = useLocation()
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {pathname !== '/' && !pathname.endsWith('/edit') && (
        <nav className="flex items-baseline justify-between py-5">
          <Link to="/" className="font-serif text-base tracking-[0.2em]">页间</Link>
          <Link to="/new" className="text-sm text-mute">+ 新建</Link>
        </nav>
      )}
      <Outlet />
    </div>
  )
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
)
