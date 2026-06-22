# ContextAI UI — built with Vite, served as static files by nginx.
FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# The app normally builds under "/ui/" (so the backend can host it). For the
# container we serve it at the root, so override the base path.
RUN npm run build -- --base=/

# --- Runtime image -----------------------------------------------------------
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
