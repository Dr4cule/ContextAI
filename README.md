# ContextAI

A chat-intelligence platform for **WhatsApp and Discord** with AI-powered summaries, intelligent bot responses, and an optional RAG knowledge base. Runs entirely on **Ollama** — using the `minimax-m3:cloud` reasoning model (text + vision) on `localhost:11434` by default — with multi-host load balancing and failover. No proprietary API keys required.

## What It Does

This tool connects to WhatsApp Web and provides:

- **AI Chat Summaries**: Analyze up to 1000 messages with deep or moderate analysis modes
- **Intelligent Bot Mode**: Auto-responds in enabled groups with personality-based responses
- **Image Analysis**: Uses `minimax-m3`'s vision capability to understand and respond to images
- **Q&A System**: Ask questions about specific chats or across your entire chat history
- **Multi-Host Load Balancing**: Distributes AI load across multiple Ollama servers with intelligent failover
- **Conversation Memory**: Bot maintains context across 50 messages per chat
- **RAG Knowledge Base**: Optional retrieval-augmented Q&A — works out of the box with a built-in vector store (no database required), or PostgreSQL + pgvector when available

## Quick Start (Docker)

The fastest way to run the whole stack (RAG server, WhatsApp API, Discord API, and the UI) is Docker Compose.

**Prerequisites**

- [Docker](https://docs.docker.com/get-docker/) with Compose v2 (`docker compose`)
- [Ollama](https://ollama.com/) running on your **host** machine with the models pulled:
  ```bash
  ollama pull minimax-m3:cloud
  ollama pull nomic-embed-text
  ```

**Run it**

```bash
# (optional) override defaults — e.g. a remote Ollama or a Discord token
cp .env.docker.example .env

docker compose up --build
```

Then open:

| Service   | URL                     |
| --------- | ----------------------- |
| **UI**    | http://localhost:5173   |
| WhatsApp  | http://localhost:8002   |
| Discord   | http://localhost:8004   |
| RAG       | http://localhost:3000   |

Open the UI, go to the **WhatsApp** page, and scan the QR code to log in. The session is saved in a Docker volume, so you won't need to re-scan on restart. The Discord bot token can be pasted in the **Discord** page (or set `DISCORD_BOT_TOKEN` in `.env`).

> **Ollama runs on the host, not in a container.** The containers reach it via `host.docker.internal` (mapped automatically, including on Linux). If your Ollama lives elsewhere, set `OLLAMA_HOSTS` in `.env`.

To stop: `docker compose down` (add `-v` to also wipe the saved WhatsApp session and RAG store).

## Technical Implementation

### Interesting Techniques

- **[Promise.race](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race) with Timeout Pattern**: Chat fetching uses race conditions to handle WhatsApp's sync delays after reconnection (up to 60s timeout)
- **Round-Robin Load Balancing**: Cycles through multiple Ollama hosts with automatic failover when one is overloaded or down
- **Queue-Based Concurrency Control**: Limits simultaneous AI requests to prevent rate limiting while maintaining priority ordering
- **[LocalStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage) Caching Strategy**: Persists chat lists, summaries, and Q&A history across sessions
- **Exponential Backoff with Multi-Host Cycling**: Retries failed AI calls by cycling through all available Ollama hosts before waiting
- **Dynamic CSS Grid Layouts**: Responsive three-column layout using [CSS Grid](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout)
- **Real-time Status Polling**: Uses [setInterval](https://developer.mozilla.org/en-US/docs/Web/API/setInterval) for connection monitoring

### Key Technologies

- **[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)** - WhatsApp Web API wrapper using Puppeteer
- **[Ollama](https://ollama.com/)** - Local/cloud LLM runtime serving `minimax-m3:cloud` (text + vision)
- **[discord.js](https://discord.js.org/)** - Discord bot integration
- **[sharp](https://sharp.pixelplumbing.com/)** - Image processing for media handling
- **[Vite](https://vitejs.dev/)** - Frontend build tool with hot module replacement
- **[React Router](https://reactrouter.com/)** - Client-side routing for multi-page navigation
- **[axios](https://axios-http.com/)** - HTTP client with request/response interceptors
- **[qrcode](https://www.npmjs.com/package/qrcode)** - QR code generation for WhatsApp authentication

### Fonts

- **[Inter](https://fonts.google.com/specimen/Inter)** - Primary UI font
- **[JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono)** - Monospace accent for code and identifiers

## Project Structure

```
ContextAI/
├── backend/
│   ├── whatsapp_ui/          # React frontend (Vite)
│   │   ├── src/
│   │   │   ├── pages/        # Route components
│   │   │   ├── App.jsx       # Root component
│   │   │   └── styles.css    # Global styles
│   │   ├── package.json
│   │   └── vite.config.js
│   ├── llm.js                # Shared Ollama client (Gemini-compatible API)
│   ├── whatsapp_api.js       # WhatsApp backend API  (port 8002)
│   ├── discord_api.js        # Discord backend       (port 8004)
│   ├── bot_config.json       # Bot group configuration
│   ├── package.json
│   └── .env                  # Environment variables (optional)
├── server/                   # RAG ingestion + retrieval (port 3000)
│   ├── index.js
│   ├── vectorStore.js        # File-backed vector store (no-DB fallback)
│   └── package.json
├── .env.example              # Template for environment setup
└── README.md
```

**[`backend/whatsapp_ui/`](backend/whatsapp_ui/)** - React frontend built with Vite. Includes multi-page routing for WhatsApp analysis, bot configuration, and dashboard Q&A.

**[`backend/.wwebjs_auth/`](backend/.wwebjs_auth/)** - WhatsApp Web session files generated by whatsapp-web.js. Contains authentication state and prevents re-scanning QR codes.

**[`backend/whatsapp_api.js`](backend/whatsapp_api.js)** - Express API server handling WhatsApp integration, AI processing, and bot responses. Implements queue-based concurrency control and multi-host load balancing.

**[`backend/llm.js`](backend/llm.js)** - Shared Ollama client used by all backends and the RAG server. Exposes a Gemini-compatible interface (`generateContent` / `embedContent`) and handles host round-robin, failover, and vision routing.

**[`server/`](server/)** - RAG ingestion + retrieval service. Uses a file-backed vector store by default; PostgreSQL + pgvector when `DATABASE_URL` is set.

**[`backend/bot_config.json`](backend/bot_config.json)** - Bot configuration including enabled groups and personality assignments.

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- One or more [Ollama](https://ollama.com/) servers reachable on your network, each serving the models below. The app defaults to a single local server at `http://localhost:11434`; add more hosts to `OLLAMA_HOSTS` for round-robin / failover.
- WhatsApp account (for the WhatsApp feature)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Dr4cule/CtxtAI.git
   cd ContextAI
   ```

2. **Install backend dependencies**
   ```bash
   cd backend
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd whatsapp_ui
   npm install
   cd ..
   ```

4. **Configure environment variables** *(optional)*

   The app runs with sensible defaults and **needs no `.env`**. To point at
   different Ollama servers, copy `.env.example` to `backend/.env`:
   ```bash
   cp .env.example backend/.env
   ```
   ```env
   OLLAMA_HOSTS=http://localhost:11434
   # OLLAMA_TEXT_MODEL=minimax-m3:cloud
   # DISCORD_BOT_TOKEN=...        # only for the Discord bot
   # DATABASE_URL=...             # only if you want Postgres-backed RAG
   ```

5. **(Optional) Start the RAG server** — enables cross-source Q&A
   ```bash
   cd server && npm install && node index.js   # http://localhost:3000
   ```
   Works out of the box with a file-backed vector store; uses Postgres+pgvector
   automatically if `DATABASE_URL` is set and reachable.

6. **Start the backend servers**
   ```bash
   cd backend
   node whatsapp_api.js     # WhatsApp  -> http://localhost:8002
   node discord_api.js      # Discord   -> http://localhost:8004 (needs DISCORD_BOT_TOKEN)
   ```

7. **Start the frontend** (in a new terminal)
   ```bash
   cd backend/whatsapp_ui
   npm run dev
   ```
   
   The UI opens at `http://localhost:5173`

8. **Authenticate with WhatsApp**
   
   - Open `http://localhost:5173` in your browser
   - Scan the QR code with WhatsApp on your phone (Settings → Linked Devices)
   - Wait for chat synchronization (may take 30-60 seconds for 500+ chats)

### Bot Configuration

Enable the bot for specific groups through the UI:

1. Navigate to **WhatsApp** page
2. Click **⚙️ Configure Bot**
3. Toggle bot on/off
4. Select groups to enable
5. Choose personality per group (Hyderabadi, Film & Anime Guy, etc.)
6. Save configuration

Bot responds when:
- @mentioned in enabled groups
- Someone replies to its messages
- Asked to summarize recent messages

## AI Engine (Ollama)

All AI runs through the shared [`backend/llm.js`](backend/llm.js) client, which load-balances
across every host in `OLLAMA_HOSTS` and fails over automatically.

**Check engine + host status:**
```bash
curl http://localhost:8002/api/keys/status
```
Returns the active models and per-host reachability:
```json
{
  "engine": "ollama",
  "textModel": "minimax-m3:cloud",
  "visionModel": "minimax-m3:cloud",
  "embedModel": "nomic-embed-text:latest",
  "hosts": [
    { "host": "http://localhost:11434", "reachable": true, "models": ["minimax-m3:cloud", "..."] }
  ]
}
```

**Add or change hosts:** edit `OLLAMA_HOSTS` (comma-separated) in `backend/.env` and restart.
Vision requests are automatically routed to a host that actually has the vision model.

## Features

### Chat Analysis
- Analyze 50-1000 messages per chat
- Deep mode: Comprehensive analysis with context and explanations
- Moderate mode: Fast summary with key points
- Batch processing for chats with 500+ messages

### Bot Personalities
- Hyderabadi: Witty local humor
- Film & Anime Guy: Pop culture expert
- Philosophy Enthusiast: Deep thinker
- Tech Bro: Silicon Valley vibes
- Gen Z Chaos: Internet culture master
- Professional: Corporate communication

### Dashboard Q&A
Ask questions across all analyzed chats with consolidated AI responses.

## Performance

- **Success Rate**: high availability via multi-host failover (add more Ollama hosts to `OLLAMA_HOSTS` for redundancy)
- **Chat Load Time**: 2-5 seconds for 500 chats (after initial sync)
- **Analysis Speed**: 3-10 seconds per 100 messages (depending on API load)
- **Concurrent Requests**: 2 simultaneous AI calls with automatic queuing

## Architecture Notes

The backend uses a hybrid approach:
- Express REST API for HTTP endpoints
- WhatsApp Web.js for WhatsApp integration
- In-memory state for chat lists and bot memory.
- File-based storage for configuration
- LocalStorage on frontend for caching

No database required - the app operates entirely from memory and WhatsApp's message history.

---

**Team**: Gear5  
**License**: MIT
