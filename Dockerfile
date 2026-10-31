# Veylo — single image serving the API, the realtime server and the built web app.
#
# Build:  docker build -t veylo .
# Run:    docker run --env-file .env -p 4000:4000 veylo
#
# Splitting the web app onto a CDN is also supported: build web/ separately, point
# APP_URL at it, and this image will serve the API alone.

# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
# The web build inlines VITE_* values, so the API origin must be known here.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini curl && addgroup -S veylo && adduser -S veylo -G veylo

COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force

# The build script copies the .sql migrations into dist alongside the compiled JS.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# Attachments live in object storage in production; this is only a fallback mount point.
RUN mkdir -p /app/uploads && chown -R veylo:veylo /app/uploads
USER veylo

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-4000}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
