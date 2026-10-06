# ==========================================
# Stage 1: Build Frontend and Backend
# ==========================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy package descriptors for caching
COPY client/package*.json ./client/
COPY server/package*.json ./server/

# Install dependencies for both client and server
RUN cd client && npm ci
RUN cd server && npm ci

# Copy source code
COPY client/ ./client/
COPY server/ ./server/

# Build client assets and compile backend TypeScript
RUN cd client && npm run build
RUN cd server && npm run build

# ==========================================
# Stage 2: Production Execution Environment
# ==========================================
FROM node:22-bookworm-slim AS runner

# Install Python 3, g++, gcc and build tools required for judging code submissions
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    g++ \
    gcc \
    make \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create persistent database folder
RUN mkdir -p /app/database && chmod 777 /app/database

# Copy built server and static client dist from builder stage
COPY --from=builder /app/server/package*.json ./server/
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/client/dist ./client/dist

# Environment Variables
ENV NODE_ENV=production
ENV PORT=10000
ENV DB_DIR=/app/database
ENV PYTHON_BIN=python3

# Expose Render default web port
EXPOSE 10000

# Start server (which serves API, Socket.IO, and static client frontend)
CMD ["node", "server/dist/index.js"]
