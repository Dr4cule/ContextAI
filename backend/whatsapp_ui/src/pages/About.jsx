import React from 'react'

export default function About(){
  return (
    <div className="page about">
      <h2>About ContextAI</h2>
      <p className="muted">Multi-platform chat intelligence powered by local/cloud Ollama models.</p>

      <section className="about-section">
        <h3>What it does</h3>
        <p>
          ContextAI turns your <strong>WhatsApp</strong> and <strong>Discord</strong> conversations into
          actionable insight. It summarizes long histories, surfaces decisions and action items, breaks
          down participation, and answers questions about any chat — all running on
          <strong> Ollama</strong>, with no proprietary API keys required.
        </p>
      </section>

      <section className="about-section">
        <h3>Features</h3>
        <ul className="feature-list">
          <li><strong>AI summarization</strong> — concise, structured summaries of any conversation</li>
          <li><strong>Participation analytics</strong> — message counts and top contributors per chat</li>
          <li><strong>Ask anything</strong> — natural-language Q&amp;A over a single chat or across all summaries</li>
          <li><strong>Smart search &amp; cache</strong> — instantly find and revisit past analyses</li>
        </ul>
      </section>

      <section className="about-section">
        <h3>Built with</h3>
        <div className="tech-grid">
          <div className="tech-item">
            <div className="tech-icon">⚛️</div>
            <div className="tech-name">React + Vite</div>
            <div className="tech-desc">Fast, modern UI</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">🤖</div>
            <div className="tech-name">Ollama · MiniMax-M3</div>
            <div className="tech-desc">Reasoning + vision model</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">🔧</div>
            <div className="tech-name">Node.js + Express</div>
            <div className="tech-desc">Backend APIs</div>
          </div>
          <div className="tech-item">
            <div className="tech-icon">💬</div>
            <div className="tech-name">WhatsApp · Discord</div>
            <div className="tech-desc">Multi-platform sync</div>
          </div>
        </div>
      </section>

      <section className="about-section">
        <h3>Team Gear5</h3>
        <p className="team-intro">
          Built by <strong>Team Gear5</strong> — Neil Gogte Institute of Technology.
        </p>
        <div className="team-grid">
          {['Arshlaan', 'Harsha', 'Ashraf', 'Prajith'].map((name) => (
            <div key={name} className="team-member">
              <div className="member-icon">👨‍💻</div>
              <div className="member-name">{name}</div>
              <div className="member-role">Developer</div>
            </div>
          ))}
        </div>
      </section>

      <footer className="about-footer">
        <p>Crafted with ❤️ by Team Gear5</p>
        <p className="muted">Neil Gogte Institute of Technology • 2026</p>
      </footer>
    </div>
  )
}
