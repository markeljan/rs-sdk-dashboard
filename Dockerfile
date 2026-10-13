# RS-SDK Dashboard: Bun + Chromium (headless game clients).
FROM oven/bun:1-debian
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates tini procps lsof \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    RSD_DATA_DIR=/data \
    PORT=4747
COPY package.json bun.lock ./
COPY server/webclient/package.json server/webclient/package.json
RUN bun install --production --ignore-scripts && cd server/webclient && bun install --production --ignore-scripts
COPY app ./app
COPY tools ./tools
COPY sdk ./sdk
COPY server ./server
COPY SYNCED_FROM ./
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:4747/_rsd/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "app/cli.ts", "start"]
