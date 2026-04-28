# Dockerfile
# Uses node:20-slim (Debian bookworm) — Prisma's officially recommended
# base image. Avoids the OpenSSL 1.1 / Alpine incompatibility entirely.

# ── Stage 1: Build ────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Required by Prisma engine on Debian slim
RUN apt-get update -qy && \
    apt-get install -qy --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# Install all dependencies (including devDeps for tsc)
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --ignore-scripts

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# ── Stage 2: Production image ──────────────────────────────────────────
FROM node:20-slim AS production
WORKDIR /app

ENV NODE_ENV=production

# OpenSSL required at runtime by the Prisma query engine
RUN apt-get update -qy && \
    apt-get install -qy --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# Production dependencies + Prisma client
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev --ignore-scripts && \
    npx prisma generate && \
    npm cache clean --force

# Compiled output from builder
COPY --from=builder /app/dist ./dist/

# Non-root user
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs fastify
USER fastify

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]


# # Dockerfile
# # Multi-stage build: compile TypeScript → lean production image.

# # ── Stage 1: Build ───────────────────────────────────────────────────
# FROM node:20-alpine AS builder
# WORKDIR /app

# # Install dependencies first (layer cache)
# COPY package*.json ./
# COPY prisma ./prisma/
# RUN npm ci --ignore-scripts

# # Generate Prisma client
# RUN npx prisma generate

# # Copy source and compile
# COPY tsconfig.json ./
# COPY src ./src/
# RUN npm run build

# # ── Stage 2: Production image ─────────────────────────────────────────
# FROM node:20-alpine AS production
# WORKDIR /app

# ENV NODE_ENV=production

# # Install only production dependencies
# COPY package*.json ./
# COPY prisma ./prisma/
# RUN npm ci --omit=dev --ignore-scripts && \
#     npx prisma generate && \
#     npm cache clean --force

# # Copy compiled output
# COPY --from=builder /app/dist ./dist/

# # Non-root user for security
# RUN addgroup -g 1001 -S nodejs && \
#     adduser -S fastify -u 1001
# USER fastify

# EXPOSE 3002

# # Healthcheck for container orchestration
# HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
#   CMD node -e "require('http').get('http://localhost:3002/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# CMD ["node", "dist/server.js"]