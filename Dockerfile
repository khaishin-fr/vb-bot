FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node config.js ./
COPY --chown=node:node src ./src
USER node
CMD ["node", "src/index.js"]
