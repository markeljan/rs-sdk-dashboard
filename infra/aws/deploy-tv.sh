#!/usr/bin/env bash
# Deploy the public spectator service independently. Existing dashboard clients stay logged in.
set -euo pipefail
: "${HOST:?HOST=<dashboard EC2 ip>}"
KEY_FILE=${KEY_FILE:-$HOME/.ssh/rs-dashboard.pem}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
if [ ! -f "$ROOT/tv-build/index.html" ]; then
  echo 'Build first: bun scripts/build-tv.ts' >&2
  exit 1
fi
ssh -i "$KEY_FILE" "ubuntu@$HOST" 'mkdir -p /opt/rs-dashboard/tv/app/tv /opt/rs-dashboard/tv/site'
rsync -az --delete -e "ssh -i $KEY_FILE" "$ROOT/tv-build/" "ubuntu@$HOST:/opt/rs-dashboard/tv/site/"
rsync -az -e "ssh -i $KEY_FILE" "$ROOT/app/tv-server.ts" "ubuntu@$HOST:/opt/rs-dashboard/tv/app/"
rsync -az --delete -e "ssh -i $KEY_FILE" --exclude '*.tsx' --exclude '*.css' "$ROOT/app/tv/" "ubuntu@$HOST:/opt/rs-dashboard/tv/app/tv/"
ssh -i "$KEY_FILE" "ubuntu@$HOST" bash -s <<'REMOTE'
set -euo pipefail
image=$(docker inspect aws-dashboard-1 --format '{{.Config.Image}}')
docker rm -f rs-tv >/dev/null 2>&1 || true
docker run -d --name rs-tv --restart unless-stopped --network aws_default \
  --memory 512m --cpus 1 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  -v /opt/rs-dashboard/tv/app:/app/app:ro -v /opt/rs-dashboard/tv/site:/site:ro \
  -e PORT=4750 -e HOST=0.0.0.0 -e TV_SITE_DIR=/site \
  --health-cmd='bun -e "const r=await fetch(\"http://127.0.0.1:4750/health\");if(!(await r.json()).ok)process.exit(1)"' \
  --health-interval=30s --health-start-period=30s --health-retries=3 \
  --entrypoint bun "$image" app/tv-server.ts
# Preserve the running dashboard's entire Caddy configuration; only append our own hostname.
caddy=/opt/rs-dashboard/src/infra/aws/Caddyfile
if ! grep -q '^live.soko.tools {' "$caddy"; then
  cp "$caddy" "$caddy.before-tv"
  cat >> "$caddy" <<'CADDY'

live.soko.tools {
    encode zstd gzip
    reverse_proxy rs-tv:4750
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }
}
CADDY
fi
# A previous rsync may have replaced the host inode behind the read-only bind.
# Reload a fresh copy; a future container start resolves the persistent host path.
docker exec -i aws-caddy-1 sh -c 'cat > /tmp/rs-tv-Caddyfile' < "$caddy"
docker exec aws-caddy-1 caddy validate --config /tmp/rs-tv-Caddyfile --adapter caddyfile
docker exec aws-caddy-1 caddy reload --config /tmp/rs-tv-Caddyfile --adapter caddyfile
echo 'TV deployed. Verify https://live.soko.tools/health and the rendered scene.'
REMOTE
