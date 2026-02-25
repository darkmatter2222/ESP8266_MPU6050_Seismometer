# ── Stage 1: Build React frontend ─────────────────────────────────
FROM node:20-alpine AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Node.js production runtime ──────────────────────────
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY --from=frontend /build/dist ./public
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
