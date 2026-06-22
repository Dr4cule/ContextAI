# ContextAI RAG server.
# NOTE: build context is the REPO ROOT, because server/index.js imports the
# shared, dependency-free LLM client at ../backend/llm.js. We recreate that
# /app/server + /app/backend/llm.js layout so the relative require resolves.
FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app/server

# Install deps first for better layer caching.
COPY server/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Server source + the shared LLM client it requires from ../backend/llm.
COPY server/ ./
COPY backend/llm.js /app/backend/llm.js

# On-disk vector store location (persisted via a volume at /app/data).
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "index.js"]
