# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8000
WORKDIR /app

# tini as PID 1 so SIGTERM reaches node and zombies get reaped
RUN apk add --no-cache tini

COPY --chown=node:node app/ ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# node user (uid 1000) ships with the base image
USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
