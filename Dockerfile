# ── base ──────────────────────────────────────────────────────────────────────
# Debian 13 (trixie): its libheif (1.23) decodes the HDR "gain map" HEIC that
# recent iPhones and Android phones write, which Debian 12's 1.15 rejects, and
# its ffmpeg (7.1) can read HEIC as a fallback.
FROM node:22-trixie-slim AS base
# Prisma picks its engine by the OpenSSL it finds at install/generate time and
# needs it at runtime; the slim image ships none.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
RUN npm ci

# ── builder ───────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
# Build-time placeholder: lib/prisma.ts builds a client at module load, but
# nothing queries it during the build. The real DATABASE_URL is set at runtime.
ENV DATABASE_URL="file:./build-placeholder.db"
RUN npm run build
RUN npm prune --omit=dev

# ── runner ────────────────────────────────────────────────────────────────────
FROM node:22-trixie-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# gosu drops root in the entrypoint; wget serves the compose healthcheck;
# ffmpeg makes video thumbnails; heif-dec (libheif-examples, with the libde265
# HEVC plugin it depends on) decodes HEIC photos, which sharp's bundled libvips can't.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu wget openssl ca-certificates ffmpeg libheif-examples \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
# Needed at runtime for migrate deploy + seed (not part of the standalone output)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/package.json ./package.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh && mkdir -p /data /photos/upload /photos/dropoff
EXPOSE 3200
ENV PORT=3200
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_URL="file:/data/photo-selector.db"
ENV PHOTOS_UPLOAD_DIR=/photos/upload
ENV PHOTOS_DROPOFF_DIR=/photos/dropoff
ENV PHOTOS_CACHE_DIR=/data/cache
ENTRYPOINT ["./docker-entrypoint.sh"]
