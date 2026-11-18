# ==========================================
# TSMusicBot Docker Image
# One-click deployment — all dependencies included
# ==========================================

# --- Stage 1: Build backend + frontend ---
FROM node:22-slim AS builder

# Install build tools for native modules (opus, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ bzip2 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm ci

# Install frontend dependencies
COPY web/package*.json ./web/
RUN cd web && npm ci

# Copy source and build
COPY . .
RUN npm run build

# Install production dependencies (with native addons compiled) in the builder
# so we don't need build tools in the production image.
RUN rm -rf node_modules && npm ci --production && npm cache clean --force

ARG KWS_MODEL=sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01
ADD https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${KWS_MODEL}.tar.bz2 /tmp/wake-model.tar.bz2
RUN mkdir -p /opt/wake-model && \
    tar -xjf /tmp/wake-model.tar.bz2 -C /opt/wake-model --strip-components=1 \
      "${KWS_MODEL}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
      "${KWS_MODEL}/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
      "${KWS_MODEL}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
      "${KWS_MODEL}/tokens.txt" "${KWS_MODEL}/README.md" && \
    cp /usr/share/common-licenses/Apache-2.0 /opt/wake-model/LICENSE

# --- Stage 2: Production image ---
FROM node:22-slim

# Install system FFmpeg — the ffmpeg-static npm package bundles a pre-compiled
# binary that can SIGSEGV inside Docker (incompatible glibc / missing libs).
# System-installed FFmpeg is always compatible with the container runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built output and pre-compiled production node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /opt/wake-model /opt/wake-model
ENV VOICE_KWS_DIR=/opt/wake-model
# package.json declares a `prestart` preflight, so `npm start` inside the
# container needs this file. The image's own CMD calls node directly and never
# goes through npm, but an interactive `docker exec ... npm start` would
# otherwise die on a missing script rather than starting the bot.
COPY --from=builder /app/scripts/check-native.mjs ./scripts/check-native.mjs
# ...and the module it imports for crash-proof logging.
COPY --from=builder /app/scripts/lib/console-log.mjs ./scripts/lib/console-log.mjs

# Data directory for database, cookies, logs
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
