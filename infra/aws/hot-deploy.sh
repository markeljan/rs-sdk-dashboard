#!/usr/bin/env bash
# Ship dashboard changes (tools/dashboard, synced from rs-sdk) WITHOUT logging game clients out: copy the code into the
# running container and restart only the per-user dashboard processes. They detach from their game-client Chromes on
# SIGTERM and the next process reattaches with the page kept (no reload, no relog). Use deploy.sh for app/ changes,
# dependency or Dockerfile changes - that rebuilds the container and restarts every game client.
#   HOST=1.2.3.4 ./hot-deploy.sh
set -euo pipefail
: "${HOST:?HOST=<server ip>}"
KEY_FILE=${KEY_FILE:-$HOME/.ssh/rs-dashboard.pem}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rsync -az --delete -e "ssh -i $KEY_FILE" --exclude node_modules --exclude .git --exclude data --exclude 'infra/aws/.env' "$ROOT/" "ubuntu@$HOST:/opt/rs-dashboard/src/"
ssh -i "$KEY_FILE" "ubuntu@$HOST" bash -s <<'REMOTE'
set -euo pipefail
c=$(docker ps --filter name=dashboard --format '{{.Names}}' | head -1)
docker cp /opt/rs-dashboard/src/tools/dashboard/. "$c:/app/tools/dashboard/"
for p in $(docker exec "$c" pgrep -f tools/dashboard/server.ts || true); do docker exec "$c" kill -TERM "$p"; done
echo "restarted dashboard processes in $c (they come back on the next request, or within 30 s for users with game clients)"
REMOTE
