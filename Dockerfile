FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DB_FILE=/data/sailorguard-push.db

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
