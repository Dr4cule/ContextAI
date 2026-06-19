import React from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import WhatsApp from './pages/WhatsApp'
import Discord from './pages/Discord'
import About from './pages/About'
import { useJobs } from './state/jobsStore'
import './styles.css'

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
      <header className="topbar">
        <div className="brand">ContextAI</div>
        <nav className="nav">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/whatsapp">WhatsApp</NavLink>
          <NavLink to="/discord">Discord</NavLink>
          <NavLink to="/about">About</NavLink>
        </nav>
      </header>

      <main className="main-area">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/whatsapp" element={<WhatsApp />} />
          <Route path="/discord" element={<Discord />} />
          <Route path="/about" element={<About />} />
          {/* Any unknown route falls back to the Dashboard */}
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>

      <GlobalJobBar />
    </div>
  )
}
