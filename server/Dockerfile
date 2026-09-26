# Agent Island engine — production image.
# Built FROM this directory (build context = server/), so paths below are relative to server/.
FROM node:20-slim

# Drop privileges: run as the unprivileged `node` user the image ships with.
# (The server writes world snapshots to ./data, so we create + chown that dir.)
WORKDIR /app/server

# Install deps first (layer-cached when only source changes).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

# Copy the rest of server/ (see .dockerignore: node_modules/, data/, .git,
# tests, and local .env are excluded).
COPY . ./

RUN mkdir -p /app/server/data \
 && chown -R node:node /app/server
USER node

# The engine listens on $PORT (default 8902).
EXPOSE 8902

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8902)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Persist world-<port>.json snapshots across container restarts.
VOLUME /app/server/data

CMD ["node", "index.js"]
