FROM node:22-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

# Default port (override with -e PORT=xxxx)
EXPOSE 3117

# Health check
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3117/api/health || exit 1

# Limit heap to 384MB to stay under 512MB container limit (OS + stack overhead)
CMD ["node", "--max-old-space-size=384", "server.mjs"]
