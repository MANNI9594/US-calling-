# ============================================================================
# US Calling Master Manager — Backend Dockerfile
# Multi-stage build: install + compile in one stage, run a slim image.
# ============================================================================

FROM node:20-slim AS builder
WORKDIR /app

# OpenSSL is required by Prisma's query engine at runtime on Debian-slim.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ----------------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY public ./public

# Local-disk storage default: mount a volume at /app/storage in production
# (see docs/DEPLOYMENT.md). Ignored entirely when STORAGE_PROVIDER=s3.
RUN mkdir -p /app/storage

EXPOSE 4000

# Applies the current schema directly to the database (no migration files
# required — appropriate for a personal single-user tool with no CLI access
# on the deploying machine; see docs/DEPLOYMENT.md "No-CLI deployment path"),
# then starts the server. Safe to run on every boot.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
