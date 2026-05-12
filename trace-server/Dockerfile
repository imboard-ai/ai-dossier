FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application
COPY src/ ./src/
COPY ../trace-schema.json ./

# Create data directory
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/traces.db
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/index.js"]
