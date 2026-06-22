# ContextAI backend (WhatsApp + Discord APIs).
# One image runs either service; docker-compose picks the command per service.
FROM node:20-bookworm-slim

# WhatsApp uses whatsapp-web.js -> puppeteer, which needs a real Chromium.
# Install the distro Chromium (it pulls the shared libs it needs) and tell
# puppeteer to use it instead of downloading its own copy.
# SKIP_DOWNLOAD covers puppeteer >= 19; SKIP_CHROMIUM_DOWNLOAD covers older.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# App source (node_modules / whatsapp_ui / session folders are .dockerignored).
COPY . .

# 8002 = WhatsApp API, 8004 = Discord API.
EXPOSE 8002 8004

CMD ["node", "whatsapp_api.js"]
