# Dockerfile
# Multi-stage build: compile TypeScript → lean production image.
# Uses node:20-alpine with OpenSSL 1.1 installed — required by Prisma 5.x engine.

# ── Stage 1: Build ────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# OpenSSL 1.1 is required by Prisma's query engine on Alpine
RUN apk add --no-cache openssl1.1-compat

# Install all dependencies (including devDeps for tsc)
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --ignore-scripts

# Generate Prisma client
RUN npx prisma generate

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# ── Stage 2: Production image ──────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# OpenSSL 1.1 must also be present at runtime (Prisma engine loads it dynamically)
RUN apk add --no-cache openssl1.1-compat

# Install only production dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev --ignore-scripts && \
    npx prisma generate && \
    npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist/

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S fastify -u 1001
USER fastify

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

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