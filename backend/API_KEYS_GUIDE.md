# AI Engine Guide (Ollama)

> **Note:** ContextAI no longer uses Google Gemini API keys. All AI runs on
> **Ollama**. This guide replaces the old multi-key setup.

## Overview

Every backend (WhatsApp, Discord) and the RAG server share one AI client:
[`llm.js`](./llm.js). It talks to one or more Ollama servers and load-balances
across them with automatic failover.

- **Text / reasoning:** `minimax-m3:cloud`
- **Vision (images):** `minimax-m3:cloud` (handles images natively; override with `OLLAMA_VISION_MODEL` if you prefer a dedicated vision model)
- **Embeddings (RAG only):** `nomic-embed-text:latest` when installed, otherwise a local hash-based fallback

## Configuration

Set hosts via the `OLLAMA_HOSTS` environment variable (comma-separated). Defaults
to `http://localhost:11434` if unset — so it works with no `.env`.

```env
OLLAMA_HOSTS=http://localhost:11434
# Optional overrides:
OLLAMA_TEXT_MODEL=minimax-m3:cloud
# OLLAMA_VISION_MODEL=minimax-m3:cloud
# OLLAMA_EMBED_MODEL=nomic-embed-text:latest
OLLAMA_TIMEOUT_MS=180000
```

## How load balancing works

1. **Round-robin** — each request uses the next host in rotation.
2. **Failover** — if a host is down or overloaded, the call retries on the
   remaining hosts before surfacing an error.
3. **Vision routing** — image requests are sent only to hosts that have a
   vision-capable model, discovered from each host's `/api/tags`.

Add redundancy simply by adding more hosts to `OLLAMA_HOSTS`.

## Check status

```bash
curl http://localhost:8002/api/keys/status
```

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

(The Discord backend exposes the same data at `/api/ai/status`.)

## Troubleshooting

- **`reachable: false`** — the host is down or unreachable from this machine.
  Verify with `curl http://<host>:11434/api/tags`.
- **Vision returns nothing** — ensure your text model supports images
  (`minimax-m3:cloud` does), or set `OLLAMA_VISION_MODEL` to a vision model.
- **Slow responses** — cloud models can take a few seconds; raise
  `OLLAMA_TIMEOUT_MS` if you see timeouts on very large prompts.
