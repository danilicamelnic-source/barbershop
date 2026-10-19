# Untested build file (Docker was not available where this project was prepared) — see README → "Docker".
# Kept in deploy/ so Railway does NOT pick it up (Railway always builds a root Dockerfile, and this one runs as a
# non-root user, which breaks Railway volumes). Build from the project root:  docker build -f deploy/Dockerfile .
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY tools ./tools
# /data holds the SQLite database; it must be writable by the unprivileged "node" user.
RUN mkdir -p /data /data/backups && chown -R node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/bookings.db BACKUP_DIR=/data/backups
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
