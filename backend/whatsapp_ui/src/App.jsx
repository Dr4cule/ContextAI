import React from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import WhatsApp from './pages/WhatsApp'
import Discord from './pages/Discord'
import About from './pages/About'
import { useJobs } from './state/jobsStore'
import './styles.css'

// Minimal line icons (stroke = currentColor) keep the nav crisp at any size.
const Icon = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  whatsapp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.1-5.4A8.5 8.5 0 1 1 21 11.5Z" />
    </svg>
  ),
  discord: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="11" y1="3" x2="9" y2="21" />
      <line x1="17" y1="3" x2="15" y2="21" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ),
}

const NAV = [
  { to: '/', end: true, label: 'Dashboard', icon: 'dashboard' },
  { to: '/whatsapp', label: 'WhatsApp', icon: 'whatsapp' },
  { to: '/discord', label: 'Discord', icon: 'discord' },
  { to: '/about', label: 'About', icon: 'about' },
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
  return (
    <div className="app-root">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">◆</span>
          <span className="brand-word">ContextAI</span>
        </div>

        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="sidebar-link">
              <span className="sidebar-link-icon">{Icon[item.icon]}</span>
              <span className="sidebar-link-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

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
