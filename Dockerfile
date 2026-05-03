# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: dependency installation (cached layer)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

LABEL maintainer="Group 5 - Scalable Services"
LABEL service="transaction-service"

# better-sqlite3 requires native build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime image (minimal)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache wget        # for HEALTHCHECK

WORKDIR /app

# Copy only production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src ./src
COPY package.json ./

# Create data directory for SQLite
RUN mkdir -p /app/data /app/data/csv

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1

CMD ["node", "src/index.js"]
