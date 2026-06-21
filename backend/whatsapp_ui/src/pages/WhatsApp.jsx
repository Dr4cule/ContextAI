import React, { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useJobs } from '../state/jobsStore'

export default function WhatsApp() {
  const [status, setStatus] = useState({ connected: false })
  const [qrCode, setQrCode] = useState(null)
  const [chats, setChats] = useState(() => {
    try { return JSON.parse(localStorage.getItem('contextai_chats') || '[]') } catch (e) { return [] }
  })
  const [selected, setSelected] = useState(null)
  const [summaries, setSummaries] = useState(() => {
    try { return JSON.parse(localStorage.getItem('contextai_summaries') || '{}') } catch (e) { return {} }
  })
  const [qaHistory, setQaHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('contextai_qa_history') || '{}') } catch (e) { return {} }
  })
  const [viewedSummaries, setViewedSummaries] = useState(() => {
    try { return JSON.parse(localStorage.getItem('contextai_viewed_summaries') || '{}') } catch (e) { return {} }
  })
  const [messageLimit, setMessageLimit] = useState(100)
  const [question, setQuestion] = useState('')
  const [askingQuestion, setAskingQuestion] = useState(false)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  // Bot mode state
  const [botEnabled, setBotEnabled] = useState(() => {
    try { return JSON.parse(localStorage.getItem('contextai_bot_enabled') || 'false') } catch (e) { return false }
  })
  const [botGroups, setBotGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem('contextai_bot_groups') || '[]') } catch (e) { return [] }
  })
  const [showBotSelector, setShowBotSelector] = useState(false)
  const [personalities, setPersonalities] = useState([])
  const [loadingPersonalities, setLoadingPersonalities] = useState(false)
  const [analysisDepth, setAnalysisDepth] = useState(() => {
    try { return localStorage.getItem('contextai_analysis_depth') || 'moderate' } catch (e) { return 'moderate' }
  })
  const [copyFeedback, setCopyFeedback] = useState({})
  const [chatsLoading, setChatsLoading] = useState(false)
  const chatLoadInFlight = useRef(false)
  const chatCountRef = useRef(chats.length)
  // Route-stable analysis state. Reading from useJobs() means a navigation
  // away to Dashboard/Discord no longer wipes the spinner or the
  // progress message while the backend request is still running.
  const { jobs, startJob, updateMessage, completeJob, clearAll } = useJobs()
  const analysisJobId = (chatId) => `wa-analyze:${chatId}`
  const chatLoadJobId = 'wa-load-chats'
  // Re-derive chat-load message from the jobs store on every render. Falls
  // back to an empty string once the job is cleared.
  const chatLoadMessage = jobs[chatLoadJobId]?.message || ''

  useEffect(() => {
    chatCountRef.current = chats.length
  }, [chats.length])

  useEffect(() => {
    checkStatus()
    const tick = setInterval(checkStatus, 3000)
    return () => clearInterval(tick)
  }, [])

  // Load personalities on mount
  useEffect(() => {
    if (status.connected) {
      loadPersonalities()
    }
  }, [status.connected])

  async function loadPersonalities() {
    if (loadingPersonalities) return
    setLoadingPersonalities(true)
    try {
      const res = await axios.get('http://localhost:8002/api/bot/personalities')
      if (res.data && res.data.personalities) {
        console.log('✅ Loaded personalities:', res.data.personalities)
        setPersonalities(res.data.personalities)
      }
    } catch (err) {
      console.warn('Failed to load personalities', err)
    } finally {
      setLoadingPersonalities(false)
    }
  }

  // Periodically reload summaries from localStorage to catch background completions
  useEffect(() => {
    const reloadSummaries = () => {
      try {
        const stored = JSON.parse(localStorage.getItem('contextai_summaries') || '{}')
        setSummaries(stored)
      } catch (e) {
        console.warn('Failed to reload summaries', e)
      }
    }
    
    // Check every 5 seconds for new summaries
    const summaryTick = setInterval(reloadSummaries, 5000)
    return () => clearInterval(summaryTick)
  }, [])

  // Auto-select chat if coming from Dashboard
  useEffect(() => {
    if (chats.length > 0) {
      const targetChatId = localStorage.getItem('contextai_selected_chat')
      if (targetChatId) {
        const targetChat = chats.find(c => c.id === targetChatId)
        if (targetChat) {
          setSelected(targetChat)
          localStorage.removeItem('contextai_selected_chat') // Clear after selection
        }
      }
    }
  }, [chats])

  // Sync bot config with backend when it changes
  useEffect(() => {
    if (!status.connected) return
    
    axios.post('http://localhost:8002/api/bot/config', {
      enabled: botEnabled,
      groups: botGroups
    }).catch(err => console.warn('Failed to sync bot config', err))
  }, [botEnabled, botGroups, status.connected])

  // Save analysis depth preference to localStorage
  useEffect(() => {
    localStorage.setItem('contextai_analysis_depth', analysisDepth)
  }, [analysisDepth])

  async function checkStatus() {
    try {
      const res = await axios.get('http://localhost:8002/api/status')
      setStatus({ ...res.data, backendOffline: false } || { connected: false })

      // Once connected (or no QR pending), drop any stale QR image.
      if (res.data?.connected || !res.data?.hasQR) {
        setQrCode(null)
      }

      if (res.data?.chatLoading) {
        setChatsLoading(true)
        startJob(chatLoadJobId, 'WhatsApp is syncing chats...')
      } else if (!chatLoadInFlight.current) {
        setChatsLoading(false)
        completeJob(chatLoadJobId)
      }

      if (res.data?.chatError) {
        updateMessage(chatLoadJobId, res.data.chatError)
      }

      // Load chats once after connection, then let the refresh button handle manual reloads.
      if (res.data && res.data.connected && chatCountRef.current === 0 && !chatLoadInFlight.current) {
        loadChats()
      } else if (res.data && res.data.hasQR) {
        loadQR()
      }
    } catch (err) {
      // Backend not reachable - flag it so the UI can tell the user to start it.
      setStatus({ connected: false, backendOffline: true })
    }
  }

  async function loadQR() {
    try {
      const res = await axios.get('http://localhost:8002/api/qr')
      if (res.data && res.data.qr) setQrCode(res.data.qr)
    } catch (err) {
      console.warn('Failed to load QR', err)
    }
  }

  async function loadChats(forceRefresh = false) {
    if (chatLoadInFlight.current) return
    chatLoadInFlight.current = true
    setChatsLoading(true)
    startJob(chatLoadJobId, forceRefresh ? 'Refreshing WhatsApp chats...' : 'Loading WhatsApp chats...')

    try {
      const res = forceRefresh
        ? await axios.post('http://localhost:8002/api/chats/refresh', {}, { timeout: 15000 })
        : await axios.get('http://localhost:8002/api/chats', { timeout: 15000 })

      if (res.data && Array.isArray(res.data.chats)) {
        // Sort by timestamp descending (most recent first)
        const sortedChats = res.data.chats.sort((a, b) => b.timestamp - a.timestamp)
        setChats(sortedChats)
        localStorage.setItem('contextai_chats', JSON.stringify(sortedChats))
      }

      if (res.data?.loading) {
        updateMessage(chatLoadJobId, res.data.message || 'WhatsApp is syncing chats...')
        setTimeout(() => {
          chatLoadInFlight.current = false
          loadChats(false)
        }, 4000)
        return
      }

      completeJob(chatLoadJobId)
    } catch (err) {
      console.warn('Failed to load chats', err)

      if (err.response?.status === 202 || err.response?.data?.reconnecting || err.response?.data?.loading) {
        updateMessage(chatLoadJobId, err.response?.data?.message || 'WhatsApp is syncing after login...')
        setTimeout(() => {
          chatLoadInFlight.current = false
          loadChats()
        }, 4000)
        return
      }

      updateMessage(chatLoadJobId, err.response?.data?.message || err.message || 'Failed to load chats')
    } finally {
      chatLoadInFlight.current = false
      setChatsLoading(false)
    }
  }

  async function logout() {
    if (!confirm("Logout from WhatsApp? You'll need to scan a new QR code to log back in.")) return
    // Immediately reflect "logging out" so the UI never looks frozen.
    setStatus({ connected: false, loggingOut: true })
    setChats([])
    setSelected(null)
    setSummaries({})
    setQaHistory({})
    setViewedSummaries({})
    setQrCode(null)
    localStorage.removeItem('contextai_chats')
    localStorage.removeItem('contextai_summaries')
    localStorage.removeItem('contextai_qa_history')
    localStorage.removeItem('contextai_viewed_summaries')
    try {
      // Backend responds immediately and regenerates the QR in the background.
      await axios.post('http://localhost:8002/api/logout')
    } catch (err) {
      console.warn('Logout request failed (continuing):', err.message)
    }
    // Poll frequently for a few seconds to surface the fresh QR quickly.
    for (let i = 1; i <= 12; i++) setTimeout(checkStatus, i * 1500)
  }

  function selectChat(c) {
    setSelected(c)
    // Mark summary as viewed when user selects a chat with a summary
    if (summaries[c.id] && summaries[c.id].aiSummary && !viewedSummaries[c.id]) {
      const updated = { ...viewedSummaries, [c.id]: true }
      setViewedSummaries(updated)
      localStorage.setItem('contextai_viewed_summaries', JSON.stringify(updated))
    }
  }

  async function analyzeSelected() {
    if (!selected) return
    const chatId = selected.id
    const jobId = analysisJobId(chatId)

    if (jobs[jobId]) return // already running, do not double-fire

    // Register the job in the route-stable store. This is the single source of
    // truth for "is analyzing" (isAnalyzing derives from it), so the spinner
    // survives navigation and the summary is never silently lost.
    startJob(jobId, `⏳ Analyzing ${selected.name || 'chat'}...`)

    try {
      const res = await axios.post('http://localhost:8002/api/messages', {
        chatId,
        limit: messageLimit,
        analysisDepth: analysisDepth,
      })
      if (res.data) {
        const s = {
          ...res.data,
          chatName: selected.name || res.data.chatName,
          isGroup: selected.isGroup,
        }
        // Persist to localStorage immediately so the summary survives even if
        // the component unmounted (user navigated away) while the request ran.
        const existingSummaries = JSON.parse(localStorage.getItem('contextai_summaries') || '{}')
        const updated = { ...existingSummaries, [chatId]: s }
        localStorage.setItem('contextai_summaries', JSON.stringify(updated))
        setSummaries(prev => ({ ...prev, [chatId]: s }))
        // Mark unseen so the sidebar shows the "new summary" dot until viewed.
        setViewedSummaries(prev => {
          const next = { ...prev, [chatId]: false }
          localStorage.setItem('contextai_viewed_summaries', JSON.stringify(next))
          return next
        })
        updateMessage(jobId, `✅ Summary ready for ${s.chatName}`)
      }
    } catch (err) {
      console.error('Analyze failed', err)
      if (err.code !== 'ERR_CANCELED') {
        const msg = err.response?.data?.message || err.response?.data?.error || err.message || 'Analyze failed'
        updateMessage(jobId, `⚠️ ${msg}`)
      }
    } finally {
      // Delay clearing the job entry slightly so the user can see the
      // success/error message instead of it vanishing mid-render.
      setTimeout(() => completeJob(jobId), 1800)
    }
  }

  async function askQuestion() {
    if (!question.trim() || !selected) return
    
    const chatId = selected.id
    setAskingQuestion(true)
    
    const qaId = Date.now()
    const newQA = { id: qaId, question: question.trim(), answer: null, loading: true }
    
    setQaHistory(prev => {
      const chatQA = prev[chatId] || []
      return { ...prev, [chatId]: [...chatQA, newQA] }
    })
    
    setQuestion('')
    
    try {
      const res = await axios.post('http://localhost:8002/api/chat-qa', {
        chatId,
        question: newQA.question,
        messageLimit
      })
      
      if (res.data && res.data.answer) {
        setQaHistory(prev => {
          const chatQA = (prev[chatId] || []).map(qa =>
            qa.id === qaId ? { ...qa, answer: res.data.answer, contextMessages: res.data.contextMessages, loading: false } : qa
          )
          const updated = { ...prev, [chatId]: chatQA }
          localStorage.setItem('contextai_qa_history', JSON.stringify(updated))
          return updated
        })
      }
    } catch (err) {
      console.error('Q&A failed', err)
      setQaHistory(prev => {
        const chatQA = (prev[chatId] || []).map(qa =>
          qa.id === qaId ? { ...qa, answer: `Error: ${err.message}`, loading: false } : qa
        )
        return { ...prev, [chatId]: chatQA }
      })
    } finally {
      setAskingQuestion(false)
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  // Escape, then turn **bold** into styled spans. Escaping happens before any
  // tag is injected, so this is safe to feed to dangerouslySetInnerHTML.
  function formatInline(text) {
    return escapeHtml(text).replace(
      /\*\*(.+?)\*\*/g,
      '<strong class="text-gold">$1</strong>'
    )
  }

  // Parse the summary one line at a time. The previous version chained several
  // regexes over the whole blob, which double-wrapped header lines like
  // "**📊 Overview**" and produced broken/empty markup. Classifying each line
  // exactly once is both correct and predictable.
  function formatAISummary(text) {
    if (!text) return ''
    const out = []
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.trim()
      if (!line) {
        out.push('<div class="spacer"></div>')
        continue
      }
      const boldHeader = line.match(/^\*\*(.+?)\*\*:?$/)
      if (/^#{1,4}\s+/.test(line)) {
        out.push(`<div class="emoji-header">${formatInline(line.replace(/^#{1,4}\s+/, ''))}</div>`)
      } else if (boldHeader) {
        out.push(`<div class="emoji-header">${formatInline(boldHeader[1])}</div>`)
      } else if (/^[-•*]\s+/.test(line)) {
        out.push(`<div class="bullet">• ${formatInline(line.replace(/^[-•*]\s+/, ''))}</div>`)
      } else {
        out.push(`<div class="summary-line">${formatInline(line)}</div>`)
      }
    }
    return out.join('')
  }

  function copySummaryToClipboard(chatId) {
    const summary = summaries[chatId]
    if (!summary || !summary.aiSummary) return
    
    // Strip HTML tags and copy plain text
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = formatAISummary(summary.aiSummary)
    const plainText = tempDiv.innerText || tempDiv.textContent
    
    navigator.clipboard.writeText(plainText).then(() => {
      // Show feedback
      setCopyFeedback(prev => ({ ...prev, [chatId]: true }))
      setTimeout(() => {
        setCopyFeedback(prev => ({ ...prev, [chatId]: false }))
      }, 2000)
    }).catch(err => {
      console.error('Failed to copy:', err)
      alert('Failed to copy to clipboard')
    })
  }

  function toggleBot() {
    const newState = !botEnabled
    setBotEnabled(newState)
    localStorage.setItem('contextai_bot_enabled', JSON.stringify(newState))
    
    if (newState && botGroups.length === 0) {
      setShowBotSelector(true)
    }
  }

  function toggleBotGroup(group) {
    let updated
    if (botGroups.find(g => g.id === group.id)) {
      // Remove group
      updated = botGroups.filter(g => g.id !== group.id)
    } else {
      // Add group (max 3)
      if (botGroups.length >= 3) {
        alert('Maximum 3 groups allowed for bot mode')
        return
      }
      updated = [...botGroups, { id: group.id, name: group.name, personality: 'hyderabadi' }]
      
      // Trigger memory pre-load for newly added group
      if (botEnabled) {
        preloadGroupMemory(group.id)
      }
    }
    setBotGroups(updated)
    localStorage.setItem('contextai_bot_groups', JSON.stringify(updated))
  }

  async function preloadGroupMemory(groupId) {
    try {
      console.log(`🧠 Pre-loading memory for group ${groupId}...`)
      const response = await fetch('http://localhost:8002/api/bot/preload-memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId })
      })
      
      if (response.ok) {
        const data = await response.json()
        console.log(`✅ Pre-loaded ${data.messagesLoaded} messages for ${data.groupName}`)
      }
    } catch (err) {
      console.error('Failed to pre-load memory:', err)
    }
  }

  function updateGroupPersonality(groupId, personality) {
    const updated = botGroups.map(g => 
      g.id === groupId ? { ...g, personality } : g
    )
    setBotGroups(updated)
    localStorage.setItem('contextai_bot_groups', JSON.stringify(updated))
  }

  function deleteQA(chatId, qaId) {
    setQaHistory(prev => {
      const chatQA = (prev[chatId] || []).filter(qa => qa.id !== qaId)
      const updated = { ...prev, [chatId]: chatQA }
      localStorage.setItem('contextai_qa_history', JSON.stringify(updated))
      return updated
    })
  }

  function removeBotGroup(groupId) {
    const updated = botGroups.filter(g => g.id !== groupId)
    setBotGroups(updated)
    localStorage.setItem('contextai_bot_groups', JSON.stringify(updated))
  }

  const filteredChats = chats
    .filter(c => {
      if (filter === 'individual' && c.isGroup) return false
      if (filter === 'group' && !c.isGroup) return false
      if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)) // Sort by most recent first

  const groupChats = chats.filter(c => c.isGroup)

  const currentSummary = selected ? summaries[selected.id] : null
  const currentQA = selected ? (qaHistory[selected.id] || []) : []
  // Derive "is this chat analyzing" reactively from the route-stable job
  // store, so the spinner survives navigation AND auto-clears the moment the
  // job completes (even if completion happened while this page was unmounted).
  const isAnalyzing = selected ? Boolean(jobs[analysisJobId(selected.id)]) : false

  return (
    <div className="page whatsapp">
      <div className="status-bar">
        <div className="status-left">
          <div className={`status-dot ${status.connected ? 'online' : 'offline'}`}></div>
          <span>
            {status.backendOffline
              ? '🔌 Backend offline — run: node whatsapp_api.js'
              : status.loggingOut
              ? '👋 Logging out — a new QR code will appear shortly...'
              : status.connected
              ? `✅ Connected (${status.chatCount || 0} chats)`
              : status.hasQR
              ? '📱 Scan the QR code to connect'
              : '⏳ Connecting to WhatsApp...'}
          </span>
        </div>
        <div className="status-right">
          {status.connected && (
            <>
              <div className="bot-controls">
                <button 
                  className={`bot-toggle ${botEnabled ? 'active' : ''}`}
                  onClick={toggleBot}
                  title={botEnabled ? 'Bot mode enabled' : 'Bot mode disabled'}
                >
                  🤖 Bot {botEnabled ? 'ON' : 'OFF'}
                </button>
                {botEnabled && (
                  <>
                    <button 
                      className="bot-config-btn"
                      onClick={() => setShowBotSelector(!showBotSelector)}
                      title="Configure bot groups"
                    >
                      ⚙️ {botGroups.length}/3
                    </button>
                    <div className="bot-groups-inline">
                      {botGroups.map(g => (
                        <div key={g.id} className="bot-group-tag">
                          <span>{g.name}</span>
                          <button onClick={() => removeBotGroup(g.id)} title="Remove">×</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button className="logout-btn" onClick={logout}>🚪 Logout</button>
            </>
          )}
        </div>
      </div>

      {/* Bot Group Selector Modal */}
      {showBotSelector && (
        <div className="bot-selector-overlay" onClick={() => setShowBotSelector(false)}>
          <div className="bot-selector-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🤖 Bot Configuration (Max 3 Groups)</h3>
              <button onClick={() => setShowBotSelector(false)}>×</button>
            </div>
            <div className="modal-body">
              
              {/* Selected Groups with Personality */}
              {botGroups.length > 0 && (
                <div className="selected-groups-section">
                  <h4>✅ Active Bot Groups</h4>
                  {botGroups.map(g => (
                    <div key={g.id} className="selected-group-card">
                      <div className="group-info">
                        <div className="group-icon">👥</div>
                        <div className="group-details">
                          <div className="group-name-header">{g.name}</div>
                          <div className="personality-selector">
                            <label>🎭 Personality:</label>
                            <select 
                              value={g.personality || 'hyderabadi'}
                              onChange={e => updateGroupPersonality(g.id, e.target.value)}
                              onClick={e => e.stopPropagation()}
                            >
                              {personalities.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <button 
                          className="remove-group-btn" 
                          onClick={() => removeBotGroup(g.id)}
                          title="Remove from bot"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Available Groups */}
              {botGroups.length < 3 && (
                <div className="available-groups-section">
                  <h4>➕ Add Groups ({botGroups.length}/3)</h4>
                  <p className="muted">Select groups where the bot will auto-respond when you're mentioned</p>
                  <div className="group-selection-list">
                    {groupChats.length === 0 ? (
                      <p className="muted">No group chats found</p>
                    ) : (
                      groupChats
                        .filter(g => !botGroups.find(bg => bg.id === g.id))
                        .map(g => (
                          <div 
                            key={g.id}
                            className="group-select-item"
                            onClick={() => toggleBotGroup(g)}
                          >
                            <div className="group-icon">👥</div>
                            <div className="group-name">{g.name}</div>
                            <div className="add-icon">+</div>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {status.hasQR && qrCode && (
        <div className="qr-section">
          <h3>📱 Scan QR Code</h3>
          <p className="muted">Open WhatsApp → Settings → Linked Devices → Link a Device</p>
          <img src={qrCode} alt="QR Code" className="qr-image" />
        </div>
      )}

      {status.connected && (
        <div className="layout">
          <aside className="left">
            <div className="sidebar-header">
              <h3>💬 Chats</h3>
              <button className="icon-btn" onClick={() => loadChats(true)} title="Refresh" disabled={chatsLoading}>🔄</button>
            </div>

            {chatsLoading && (
              <div className="sync-message">
                <div className="spinner-small"></div>
                <span>{chatLoadMessage || 'Loading WhatsApp chats...'}</span>
              </div>
            )}

            {!chatsLoading && chatLoadMessage && (
              <div className="sync-message warning">{chatLoadMessage}</div>
            )}

            <input
              type="text"
              placeholder="🔍 Search..."
              className="search-input"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />

            <div className="filter-tabs">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
              <button className={filter === 'individual' ? 'active' : ''} onClick={() => setFilter('individual')}>👤</button>
              <button className={filter === 'group' ? 'active' : ''} onClick={() => setFilter('group')}>👥</button>
            </div>

            <div className="chat-list">
              {filteredChats.map(c => (
                <div
                  key={c.id}
                  className={`chat-item ${selected && selected.id === c.id ? 'selected' : ''}`}
                  onClick={() => selectChat(c)}
                >
                  <div className="chat-icon">{c.isGroup ? '👥' : '👤'}</div>
                  <div className="chat-info">
                    <div className="name">{c.name}</div>
                    <div className="meta">{c.isGroup ? 'Group' : 'Individual'}</div>
                  </div>
                  {summaries[c.id] && summaries[c.id].aiSummary && !viewedSummaries[c.id] && <div className="summary-ready-dot" title="New summary ready"></div>}
                </div>
              ))}
              {filteredChats.length === 0 && <div className="empty">No chats found</div>}
            </div>
          </aside>

          <section className="right">
            {selected ? (
              <div className="chat-content">
                <div className="chat-header">
                  <h3>{selected.name}</h3>
                  <span className="meta">{selected.isGroup ? '👥 Group Chat' : '👤 Individual Chat'}</span>
                </div>

                <div className="analyze-controls">
                  <label className="limit-label">
                    📊 Messages to Analyze:
                    <select value={messageLimit} onChange={e => setMessageLimit(Number(e.target.value))}>
                      <option value="50">⚡ 50 (Fast)</option>
                      <option value="100">✨ 100 (Recommended)</option>
                      <option value="200">🔍 200 (Detailed)</option>
                      <option value="500">📈 500 (Deep)</option>
                      <option value="1000">💎 1000 (Batch)</option>
                    </select>
                  </label>
                  
                  <label className="limit-label">
                    🧠 Analysis Depth:
                    <select value={analysisDepth} onChange={e => setAnalysisDepth(e.target.value)}>
                      <option value="moderate">✨ Moderate (Fast)</option>
                      <option value="deep">🔬 Deep (Research Mode)</option>
                    </select>
                  </label>
                  
                  <button
                    className="analyze-btn"
                    onClick={analyzeSelected}
                    disabled={isAnalyzing}
                  >
                    {isAnalyzing ? '⏳ Analyzing...' : currentSummary ? '🔄 Re-analyze' : '⚡ Analyze Chat'}
                  </button>
                </div>

                {isAnalyzing && !currentSummary && (
                  <div className="loading-indicator">
                    <div className="spinner"></div>
                    <p>Analyzing chat... you can switch pages, this keeps running.</p>
                  </div>
                )}

                {currentSummary && (
                  <div className="summary-section">
                    {currentSummary.aiSummary && (
                      <div className="ai-summary-box">
                        <div className="summary-header">
                          <h4>🤖 AI Summary <span className="msg-count">({currentSummary.textMessages} msgs)</span></h4>
                          <button 
                            className="copy-summary-btn" 
                            onClick={() => copySummaryToClipboard(selected.id)}
                            title="Copy summary to clipboard"
                          >
                            {copyFeedback[selected.id] ? '✓ Copied!' : '📋 Copy'}
                          </button>
                        </div>
                        <div dangerouslySetInnerHTML={{ __html: formatAISummary(currentSummary.aiSummary) }} />
                      </div>
                    )}

                    {!currentSummary.aiSummary && (
                      <div className="ai-summary-box ai-summary-failed">
                        <div className="summary-header">
                          <h4>⚠️ AI summary unavailable</h4>
                        </div>
                        <p className="muted">
                          The stats below were collected, but the AI engine didn't return a summary
                          (it may be busy or offline). Your messages are safe — click
                          <strong> Analyze Chat</strong> again to retry.
                        </p>
                        <button className="analyze-btn" onClick={analyzeSelected} disabled={isAnalyzing}>
                          🔁 Retry summary
                        </button>
                      </div>
                    )}

                    <div className="stats-grid">
                      <div className="stat-card">
                        <div className="stat-label">📅 Period</div>
                        <div className="stat-value">
                          {currentSummary.dateRange
                            ? `${currentSummary.dateRange.oldest} - ${currentSummary.dateRange.newest}`
                            : 'N/A'}
                        </div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">💬 Messages</div>
                        <div className="stat-value">{currentSummary.textMessages}</div>
                        <div className="progress-bar">
                          <div className="progress-fill" style={{ width: `${Math.min((currentSummary.textMessages / 100) * 100, 100)}%` }}></div>
                        </div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">👥 Participants</div>
                        <div className="stat-value">{Object.keys(currentSummary.participants || {}).length}</div>
                        <div className="progress-bar">
                          <div className="progress-fill purple" style={{ width: `${Math.min((Object.keys(currentSummary.participants || {}).length / 10) * 100, 100)}%` }}></div>
                        </div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">📈 Avg/Person</div>
                        <div className="stat-value">
                          {Math.round(currentSummary.textMessages / Math.max(Object.keys(currentSummary.participants || {}).length, 1))}
                        </div>
                      </div>
                    </div>

                    {currentSummary.participants && Object.keys(currentSummary.participants).length > 0 && (
                      <div className="participants-section">
                        <h4>👥 Top Contributors</h4>
                        <div className="participants-list">
                          {Object.entries(currentSummary.participants)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 8)
                            .map(([name, count]) => {
                              const maxCount = Math.max(...Object.values(currentSummary.participants))
                              const percentage = (count / maxCount) * 100
                              const isPhone = /^\d+$/.test(name) || /^[\d\s\-\+\(\)]+$/.test(name)
                              const displayName = isPhone && name.length > 8 ? '+' + name.replace(/\D/g, '') : name
                              
                              return (
                                <div key={name} className="participant-item">
                                  <div className="participant-info">
                                    <span className={isPhone ? 'phone-name' : ''}>{displayName}</span>
                                    <span className="msg-count">{count} msgs</span>
                                  </div>
                                  <div className="progress-bar">
                                    <div className="progress-fill gradient" style={{ width: `${percentage}%` }}></div>
                                  </div>
                                </div>
                              )
                            })}
                        </div>
                      </div>
                    )}

                    <div className="qa-section">
                      <h4>💬 Ask Questions</h4>
                      <p className="muted">Get precise answers about this conversation (2-4 sentences)</p>
                      
                      <div className="qa-input-row">
                        <textarea
                          placeholder="e.g., What were the main decisions? Who mentioned the deadline?"
                          value={question}
                          onChange={e => setQuestion(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                              e.preventDefault()
                              askQuestion()
                            }
                          }}
                          rows="2"
                        />
                        <button onClick={askQuestion} disabled={askingQuestion || !question.trim()}>
                          {askingQuestion ? '⏳ Asking...' : '🤖 Ask AI'}
                        </button>
                      </div>

                      <div className="qa-history">
                        {currentQA.map(qa => (
                          <div key={qa.id} className="qa-item">
                            <div className="qa-question-header">
                              <div className="qa-question">
                                ❓ {qa.question}
                              </div>
                              <button 
                                className="delete-qa-btn"
                                onClick={() => deleteQA(selected.id, qa.id)}
                                title="Delete this Q&A"
                              >
                                🗑️
                              </button>
                            </div>
                            <div className="qa-answer">
                              {qa.loading ? (
                                <div className="qa-loading">
                                  <div className="spinner-small"></div> Thinking...
                                </div>
                              ) : (
                                <>
                                  <div className="qa-meta">🤖 {qa.contextMessages || '?'} msgs:</div>
                                  <div>
                                    {(qa.answer || '').split('\n').map((line, index) => (
                                      <React.Fragment key={index}>
                                        {line}
                                        {index < (qa.answer || '').split('\n').length - 1 && <br />}
                                      </React.Fragment>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {!currentSummary && !isAnalyzing && (
                  <div className="empty-state">
                    <div className="empty-icon">📱</div>
                    <p>No summary yet</p>
                    <p className="muted">Click "Analyze Chat" above to generate</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">💬</div>
                <p>Select a chat to analyze</p>
                <p className="muted">Choose from the sidebar</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
