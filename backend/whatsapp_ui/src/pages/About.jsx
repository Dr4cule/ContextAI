import React from 'react'

export default function About(){
  return (
    <div className="page about">
      <h2>📚 About ContextAI</h2>
      
      <section className="about-section">
        <h3>🎯 What is ContextAI?</h3>
        <p>
          ContextAI is an intelligent chat-analysis platform that transforms your conversations across
          <strong> WhatsApp and Discord</strong> into actionable insights. Running entirely on
          local/cloud <strong>Ollama</strong> models, it summarizes lengthy histories, extracts key
          information, analyzes participant behavior, and powers interactive Q&A — with no proprietary API
          keys required.
        </p>
      </section>

      <section className="about-section">
        <h3>✨ Features</h3>
        <ul className="feature-list">
          <li>🤖 <strong>AI-Powered Summarization</strong> - Get concise summaries of your chat history</li>
          <li>📊 <strong>Advanced Analytics</strong> - Track message counts, participation stats, and engagement patterns</li>
          <li>💬 <strong>Interactive Q&A</strong> - Ask questions about your conversations and get instant answers</li>
          <li>🔍 <strong>Smart Search</strong> - Find and filter chats across your entire message history</li>
          <li>📈 <strong>Visual Insights</strong> - Beautiful charts and progress bars for data visualization</li>
          <li>💾 <strong>Local Caching</strong> - Fast access to previously analyzed chats</li>
        </ul>
      </section>

      <section className="about-section">
        <h3>🛠️ Technology Stack</h3>
        <div className="tech-grid">
          <div className="tech-item">
            <div className="tech-icon">⚛️</div>
            <div className="tech-name">React 18</div>
            <div className="tech-desc">Modern UI framework</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">⚡</div>
            <div className="tech-name">Vite</div>
            <div className="tech-desc">Lightning-fast build tool</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">🤖</div>
            <div className="tech-name">Ollama · MiniMax-M3</div>
            <div className="tech-desc">minimax-m3 reasoning + vision model</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">💬</div>
            <div className="tech-name">WhatsApp · Discord</div>
            <div className="tech-desc">Multi-platform integration</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">🎨</div>
            <div className="tech-name">Custom CSS</div>
            <div className="tech-desc">Glass-dark theme & motion</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">🔧</div>
            <div className="tech-name">Node.js + Express</div>
            <div className="tech-desc">Backend API server</div>
          </div>
        </div>
      </section>

      <section className="about-section">
        <h3>🔌 Backend API Endpoints</h3>
        <div className="api-list">
          <div className="api-item">
            <code className="api-method">GET</code>
            <code className="api-path">/api/status</code>
            <span className="api-desc">WhatsApp connection status</span>
          </div>
          <div className="api-item">
            <code className="api-method">GET</code>
            <code className="api-path">/api/qr</code>
            <span className="api-desc">QR code for authentication</span>
          </div>
          <div className="api-item">
            <code className="api-method">GET</code>
            <code className="api-path">/api/chats</code>
            <span className="api-desc">List of WhatsApp chats</span>
          </div>
          <div className="api-item">
            <code className="api-method">POST</code>
            <code className="api-path">/api/messages</code>
            <span className="api-desc">Generate AI summary for chat</span>
          </div>
          <div className="api-item">
            <code className="api-method">POST</code>
            <code className="api-path">/api/chat-qa</code>
            <span className="api-desc">Ask questions about chat</span>
          </div>
          <div className="api-item">
            <code className="api-method">GET</code>
            <code className="api-path">/api/keys/status</code>
            <span className="api-desc">Ollama hosts &amp; model status</span>
          </div>
          <div className="api-item">
            <code className="api-method">POST</code>
            <code className="api-path">/api/logout</code>
            <span className="api-desc">Logout from WhatsApp</span>
          </div>
        </div>
      </section>

      <section className="about-section">
        <h3>👥 Team Gear5</h3>
        <p className="team-intro">
          ContextAI is proudly developed by Team Gear5 from <strong>Neil Gogte Institute of Technology</strong>.
        </p>
        <div className="team-grid">
          <div className="team-member">
            <div className="member-icon">👨‍💻</div>
            <div className="member-name">Arshlaan</div>
            <div className="member-role">Developer</div>
          </div>
          <div className="team-member">
            <div className="member-icon">👨‍💻</div>
            <div className="member-name">Harsha</div>
            <div className="member-role">Developer</div>
          </div>
          <div className="team-member">
            <div className="member-icon">👨‍💻</div>
            <div className="member-name">Ashraf</div>
            <div className="member-role">Developer</div>
          </div>
          <div className="team-member">
            <div className="member-icon">👨‍💻</div>
            <div className="member-name">Prajith</div>
            <div className="member-role">Developer</div>
          </div>
        </div>
      </section>

      <section className="about-section">
        <h3>🎨 Design Philosophy</h3>
        <p>
          ContextAI uses a modern <strong>glass-dark</strong> interface: a deep slate canvas with soft
          ambient glows, frosted translucent surfaces, and an <strong>indigo–violet</strong> accent
          (shifting to Discord blue on the Discord page). Typography is clean, highly readable
          <strong> Inter</strong> with a <strong>JetBrains Mono</strong> accent for code and identifiers —
          prioritising clarity and focus over decoration.
        </p>
      </section>

      <footer className="about-footer">
        <p>Crafted with ❤️ by Team Gear5</p>
        <p className="muted">Neil Gogte Institute of Technology • 2026</p>
      </footer>
    </div>
  )
}
