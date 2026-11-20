# syntax=docker/dockerfile:1

# Node 22+ is required for the built-in node:sqlite module used by the N-400 reader.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Install dependencies first so the layer is cached across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code plus the committed data snapshots (bulletins + N-400).
COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
