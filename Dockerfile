# RS-SDK Dashboard: Bun + Chromium (for the headless game clients).
FROM oven/bun:1-debian
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production
COPY src ./src
COPY public ./public
ENV CHROME_PATH=/usr/bin/chromium \
    RSD_DATA_DIR=/data \
    PORT=4747 \
    NODE_ENV=production
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:4747/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/cli.ts", "start"]
