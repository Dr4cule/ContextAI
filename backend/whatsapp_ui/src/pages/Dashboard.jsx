import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'

function loadLocalSummaries() {
  try {
    const raw = localStorage.getItem('contextai_summaries')
    if (!raw) return {}
    return JSON.parse(raw)
  } catch (e) {
    return {}
  }
}

function saveLocalSummaries(obj) {
  try {
    localStorage.setItem('contextai_summaries', JSON.stringify(obj))
  } catch (e) {
    console.warn('Failed to save summaries', e)
  }
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [summaries, setSummaries] = useState({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  
  // AI Q&A state
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiAnswer, setAiAnswer] = useState(null)
  const [askingAI, setAskingAI] = useState(false)
  const [showAIPanel, setShowAIPanel] = useState(false)

  useEffect(() => {
    const local = loadLocalSummaries()
    setSummaries(local)
  }, [])

  // Simple local search over cached summaries
  useEffect(() => {
    const keys = Object.keys(summaries)
    if (!query) {
      setResults(keys.map(k => summaries[k]).reverse())
      return
    }
    const q = query.toLowerCase()
    const filtered = keys
      .map(k => summaries[k])
      .filter(s => {
        return (
          (s.aiSummary && s.aiSummary.toLowerCase().includes(q)) ||
          (s.chatName && s.chatName.toLowerCase().includes(q)) ||
          (s.messages && s.messages.join(' ').toLowerCase().includes(q))
        )
      })
    setResults(filtered.reverse())
  }, [query, summaries])

  async function refreshFromServer() {
    // Simply reload from localStorage - much faster
    setLoading(true)
    try {
      const local = loadLocalSummaries()
      setSummaries(local)
    } catch (err) {
      console.warn('Failed to refresh from localStorage', err)
    } finally {
      setLoading(false)
    }
  }

  function clearCache() {
    if (!confirm('Clear all cached summaries?')) return
    localStorage.removeItem('contextai_summaries')
    setSummaries({})
    setResults([])
    setAiAnswer(null)
  }

  function deleteSummary(chatId) {
    if (!confirm('Delete this summary from cache?')) return
    const updated = { ...summaries }
    delete updated[chatId]
    setSummaries(updated)
    saveLocalSummaries(updated)
  }

  function goToChat(chatId) {
    const summary = summaries[chatId]
    if (!summary) return
    
    // Navigate to appropriate page based on source
    if (summary.source === 'discord') {
      navigate('/discord')
    } else {
      // Default to WhatsApp
      localStorage.setItem('contextai_selected_chat', chatId)
      navigate('/whatsapp')
    }
  }

  async function askAI() {
    if (!aiQuestion.trim()) return
    if (Object.keys(summaries).length === 0) {
      alert('No summaries available. Analyze some chats first!')
      return
    }

    setAskingAI(true)
    setAiAnswer(null)
    
    try {
      const res = await axios.post('http://localhost:8002/api/dashboard-qa', {
        summaries,
        question: aiQuestion
      })
      
      if (res.data && res.data.answer) {
        setAiAnswer({
          question: aiQuestion,
          answer: res.data.answer,
          analyzedChats: res.data.analyzedChats
        })
        setShowAIPanel(true)
      }
    } catch (err) {
      console.error('AI Q&A failed', err)
      alert('AI Q&A failed: ' + (err.response?.data?.error || err.message || 'Unknown error'))
    } finally {
      setAskingAI(false)
    }
  }

  function formatAIAnswer(text) {
    if (!text) return null
    return text.split('\n').map((line, i) => {
      if (line.trim().startsWith('**') && line.trim().endsWith('**')) {
        return <div key={i} className="ai-header">{line.replace(/\*\*/g, '')}</div>
      }
      if (line.trim().startsWith('- ') || line.trim().startsWith('• ')) {
        return <div key={i} className="ai-bullet">{line.replace(/^[-•]\s*/, '• ')}</div>
      }
      if (line.trim()) {
        return <div key={i} className="ai-text">{line}</div>
      }
      return <br key={i} />
    })
  }

  return (
    <div className="page dashboard">
      <h2>📊 Dashboard</h2>
      <p className="muted">Search, analyze, and ask AI questions across all your chat summaries.</p>

      {/* AI Q&A Section */}
      <div className="ai-qa-section">
        <div className="ai-qa-header">
          <h3>🤖 Ask AI Anything</h3>
          <p className="muted-small">Ask questions about patterns, correlations, or insights across all {Object.keys(summaries).length} cached chats</p>
        </div>
        
        <div className="ai-qa-input-row">
          <input
            type="text"
            placeholder="e.g., 'What are common topics across all chats?' or 'Which chat has the most active discussion?'"
            value={aiQuestion}
            onChange={e => setAiQuestion(e.target.value)}
            onKeyPress={e => e.key === 'Enter' && askAI()}
            className="ai-question-input"
          />
          <button onClick={askAI} disabled={askingAI} className="ask-ai-btn">
            {askingAI ? '🤔 Thinking...' : '✨ Ask AI'}
          </button>
        </div>

        {aiAnswer && showAIPanel && (
          <div className="ai-answer-panel">
            <div className="ai-answer-header">
              <span className="ai-answer-label">💡 AI Analysis ({aiAnswer.analyzedChats} chats analyzed)</span>
              <button className="close-ai-btn" onClick={() => setShowAIPanel(false)}>✕</button>
            </div>
            <div className="ai-answer-question">❓ {aiAnswer.question}</div>
            <div className="ai-answer-content">
              {formatAIAnswer(aiAnswer.answer)}
            </div>
          </div>
        )}
      </div>

      {/* Search Section */}
      <div className="search-row">
        <input 
          placeholder="🔍 Search summaries by keyword..." 
          value={query} 
          onChange={e => setQuery(e.target.value)} 
          className="search-input-dashboard"
        />
        <button onClick={refreshFromServer} disabled={loading} className="refresh-btn">
          {loading ? '⏳ Refreshing...' : '🔄 Refresh'}
        </button>
        <button onClick={clearCache} className="clear-btn">🗑️ Clear Cache</button>
      </div>

      {/* Results Grid */}
      <div className="results">
        {results.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">📭</div>
            <div>No summaries yet</div>
            <div className="muted-small">Visit WhatsApp page and analyze a chat to get started</div>
          </div>
        ) : (
          results.map(s => (
            <div key={s.chatId} className="summary-card">
              {/* Source Badge */}
              <div className="source-badge" title={s.source || 'WhatsApp'}>
                {s.source === 'discord' ? (
                  '💬'
                ) : (
                  <svg viewBox="0 0 512 512" width="16" height="16" fill="#25D366">
                    <path d="M256.064 0h-.128C114.784 0 0 114.816 0 256c0 56 18.048 107.904 48.736 150.048l-31.904 95.104 98.4-31.456C155.712 496.512 204 512 256.064 512 397.216 512 512 397.152 512 256S397.216 0 256.064 0zm148.96 361.504c-6.176 17.44-30.688 31.904-50.24 36.128-13.376 2.848-30.848 5.12-89.664-19.264-75.232-31.168-123.68-107.616-127.456-112.576-3.616-4.96-30.4-40.48-30.4-77.216s18.656-54.624 26.176-62.304c6.176-6.304 16.384-9.184 26.176-9.184 3.168 0 6.016.16 8.576.288 7.52.32 11.296.768 16.256 12.64 6.176 14.88 21.216 51.616 23.008 55.392 1.824 3.776 3.648 8.896 1.088 13.856-2.4 5.12-4.512 7.392-8.288 11.744-3.776 4.352-7.36 7.68-11.136 12.352-3.456 4.064-7.36 8.416-3.008 15.936 4.352 7.36 19.392 31.904 41.536 51.616 28.576 25.44 51.744 33.568 60.032 37.024 6.176 2.56 13.536 1.952 18.048-2.848 5.728-6.176 12.8-16.416 20-26.496 5.12-7.232 11.584-8.128 18.368-5.568 6.912 2.4 43.488 20.48 51.008 24.224 7.52 3.776 12.48 5.568 14.304 8.736 1.792 3.168 1.792 18.048-4.384 35.52z"/>
                  </svg>
                )}
              </div>
              
              {/* Card Actions */}
              <button className="card-delete-btn" onClick={() => deleteSummary(s.chatId)} title="Delete">
                🗑️
              </button>
              <button className="card-goto-btn" onClick={() => goToChat(s.chatId)} title="Go to chat">
                🔗
              </button>
              
              {/* Card Content */}
              <div className="summary-head">
                <div className="chat-name">{s.isGroup ? '👥' : '👤'} {s.chatName}</div>
                <div className="meta">
                  💬 {s.textMessages} msgs •
                  👥 {Object.keys(s.participants || {}).length} participants
                </div>
              </div>
              <div className="summary-body">
                {s.aiSummary ? (
                  <div className="ai-summary">
                    {s.aiSummary.split('\n').slice(0, 6).map((l, i) => (
                      <div key={i} className="summary-line">
                        {l.trim() && `• ${l.replace(/^[-•*]\s*/, '')}`}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="no-summary">(no AI summary)</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
