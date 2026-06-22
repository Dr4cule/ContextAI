import React, { useEffect, useState } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  MessageCircle,
  Hash,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import Dashboard from './pages/Dashboard'
import WhatsApp from './pages/WhatsApp'
import Discord from './pages/Discord'
import About from './pages/About'
import { useJobs } from './state/jobsStore'
import './styles.css'

const NAV = [
  { to: '/', end: true, label: 'Dashboard', Icon: LayoutDashboard },
  { to: '/whatsapp', label: 'WhatsApp', Icon: MessageCircle },
  { to: '/discord', label: 'Discord', Icon: Hash },
  { to: '/about', label: 'About', Icon: Info },
]

function GlobalJobBar() {
  const { jobs } = useJobs()
  const entries = Object.values(jobs || {})
  if (entries.length === 0) return null
  return (
    <div className="global-job-bar" role="status" aria-live="polite">
      <div className="spinner-small" />
      <div className="global-job-list">
        {entries.map((j) => (
          <div key={j.id} className="global-job-item">{j.message}</div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('contextai_sidebar_collapsed') === '1' } catch (e) { return false }
  })

  useEffect(() => {
    try { localStorage.setItem('contextai_sidebar_collapsed', collapsed ? '1' : '0') } catch (e) {}
  }, [collapsed])

  return (
    <div className={`app-root ${collapsed ? 'collapsed' : ''}`}>
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">◆</span>
          <span className="brand-word">ContextAI</span>
        </div>

        <nav className="sidebar-nav">
          {NAV.map(({ to, end, label, Icon }) => (
            <NavLink key={to} to={to} end={end} className="sidebar-link" title={label}>
              <span className="sidebar-link-icon"><Icon size={18} strokeWidth={2} /></span>
              <span className="sidebar-link-label">{label}</span>
            </NavLink>
          ))}
        </nav>

        <button
          className="sidebar-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          <span className="collapse-label">Collapse</span>
        </button>

        <div className="sidebar-foot">
          <span className="sidebar-foot-dot" />
          <span>Powered by Ollama</span>
        </div>
      </aside>

      <main className="app-main">
        <div className="app-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/whatsapp" element={<WhatsApp />} />
            <Route path="/discord" element={<Discord />} />
            <Route path="/about" element={<About />} />
            {/* Any unknown route falls back to the Dashboard */}
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </div>
      </main>

      <GlobalJobBar />
    </div>
  )
}
