# Discord RAG Integration Setup

## Overview

Discord channels can now be connected to the RAG (Retrieval-Augmented Generation) system, just like WhatsApp chats. This enables:

- **Automatic message ingestion** to vector database
- **Context-aware Q&A** using RAG retrieval
- **Cross-platform knowledge base** (Discord + WhatsApp)

## How It Works

### 1. Message Ingestion (Auto-Vectorization)

When a message is sent in a **mapped** Discord channel:

```
Discord Message → discord_api.js → RAG Server (localhost:3000) → PostgreSQL + pgvector
```

### 2. Q&A with RAG

When you ask a question about a **mapped** channel:

```
Question → discord_api.js → RAG Server → Vector DB → Ollama → Answer
```

### 3. Fallback for Unmapped Channels

For channels NOT in `discord_mapping.json`:

- Messages are NOT sent to RAG
- Q&A uses Ollama with the summary only (like before)

## Configuration

### discord_mapping.json Format

Map Discord channels to projects/teams:

```json
{
  "guildId_channelId": {
    "project_id": "your_project_id",
    "team_id": "your_team_id"
  }
}
```

### Example with Real Discord IDs

```json
{
  "1234567890123456789_9876543210987654321": {
    "project_id": "discord_hackathon",
    "team_id": "gear5"
  },
  "1234567890123456789_1111222233334444555": {
    "project_id": "discord_dev_team",
    "team_id": "engineering"
  }
}
```

### How to Find Discord IDs

1. **Enable Developer Mode** in Discord:

   - User Settings → Advanced → Developer Mode (toggle ON)

2. **Get Guild ID** (Server ID):

   - Right-click on server name → Copy Server ID

3. **Get Channel ID**:

   - Right-click on channel name → Copy Channel ID

4. **Format the Key**:
   ```
   guildId_channelId
   ```
   Example: `1234567890123456789_9876543210987654321`

## Features

### ✅ Enabled Features

- [x] Auto-ingest Discord messages to RAG
- [x] RAG-powered Q&A for mapped channels
- [x] Fallback to Ollama for unmapped channels
- [x] Real-time message vectorization
- [x] Cross-platform knowledge retrieval

### 🔄 Same as WhatsApp

- Message ingestion to `http://localhost:3000/api/v1/ingest`
- Q&A via `http://localhost:3000/api/v1/ask`
- Project/team-based organization
- Automatic vector embeddings

## Usage Example

### 1. Map a Discord Channel

Edit `backend/discord_mapping.json`:

```json
{
  "1143939208553811574_1144000000000000000": {
    "project_id": "contextai_development",
    "team_id": "gear5"
  }
}
```

### 2. Restart Discord API

```bash
cd backend
node discord_api.js
```

### 3. Messages Auto-Ingest

Any new message in the mapped channel automatically goes to RAG:

```
[DISCORD-INGEST] Channel 1143939208553811574_1144000000000000000 IS mapped. Sending to RAG server...
[DISCORD-INGEST] SUCCESS: Sent message from general to RAG server.
```

### 4. Ask Questions with RAG

The Q&A will use RAG retrieval:

```
[DISCORD-RAG] New Q&A Request
[DISCORD-RAG] Question: What did we discuss about the API?
[DISCORD-RAG] Channel 1143939208553811574_1144000000000000000 is mapped. Using RAG server...
[DISCORD-RAG] Answer generated from RAG server
```

## Logs to Watch

### Message Ingestion Logs

```
✅ [DISCORD-INGEST] Channel XXXXX IS mapped. Sending to RAG server...
✅ [DISCORD-INGEST] SUCCESS: Sent message from #channel-name to RAG server.
```

### Q&A Logs

```
✅ [DISCORD-RAG] Channel XXXXX is mapped. Using RAG server...
✅ [DISCORD-RAG] Answer generated from RAG server
```

### Unmapped Channel Logs

```
⚠️ [DISCORD-INGEST] Channel XXXXX is NOT in discord_mapping.json. Ignoring.
```

## Troubleshooting

### No Messages Being Ingested

1. Check `discord_mapping.json` exists in `backend/` folder
2. Verify the channel key format: `guildId_channelId`
3. Ensure RAG server is running on `localhost:3000`
4. Check Discord bot has `MessageContent` intent enabled

### Q&A Not Using RAG

1. Verify channel is mapped in `discord_mapping.json`
2. Check if `guildId` and `channelId` are being sent from frontend
3. Ensure RAG server is responding on `http://localhost:3000/api/v1/ask`

### RAG Server Connection Issues

```bash
# Start RAG server first
cd backend
node server.js  # or whatever your RAG server file is named

# Then start Discord API
node discord_api.js
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Discord Bot (Port 8004)                  │
│  - Receives messages from Discord API                       │
│  - Checks discord_mapping.json                              │
│  - Sends to RAG if mapped                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 RAG Server (Port 3000)                      │
│  - /api/v1/ingest - Store messages with embeddings          │
│  - /api/v1/ask    - Retrieve context and answer             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│            PostgreSQL + pgvector Database                    │
│  - Stores message embeddings                                │
│  - Vector similarity search                                 │
└─────────────────────────────────────────────────────────────┘
```

## Next Steps

1. **Add your Discord channels** to `discord_mapping.json`
2. **Restart Discord API** to load the mapping
3. **Test message ingestion** by sending messages
4. **Try Q&A** with RAG-powered context retrieval

## Notes

- Each mapped channel costs tokens for embeddings
- Unmapped channels still work with Ollama fallback
- RAG provides better context-aware answers
- Messages are stored permanently in vector DB
