#!/usr/bin/env bash
# Ship code changes WITHOUT logging game clients out: copy tools/dashboard and app/ into the running container, then
# restart the front server (FRONT=1, for app/*.ts changes) or just the per-user dashboard processes. Dashboards detach
# from their game-client Chromes on SIGTERM and the next process reattaches with the page kept (no reload, no relog).
# Use deploy.sh for dependency or Dockerfile changes - that rebuilds the container and restarts every game client.
#   HOST=1.2.3.4 ./hot-deploy.sh            # tools/dashboard + app/pages
#   HOST=1.2.3.4 FRONT=1 ./hot-deploy.sh    # also app/*.ts (front server restart)
set -euo pipefail
: "${HOST:?HOST=<server ip>}"
KEY_FILE=${KEY_FILE:-$HOME/.ssh/rs-dashboard.pem}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rsync -az --delete -e "ssh -i $KEY_FILE" --exclude node_modules --exclude .git --exclude data --exclude 'infra/aws/.env' "$ROOT/" "ubuntu@$HOST:/opt/rs-dashboard/src/"
ssh -i "$KEY_FILE" "ubuntu@$HOST" FRONT="${FRONT:-}" bash -s <<'REMOTE'
set -euo pipefail
c=$(docker ps --filter name=dashboard --format '{{.Names}}' | head -1)
docker cp /opt/rs-dashboard/src/tools/dashboard/. "$c:/app/tools/dashboard/"
docker cp /opt/rs-dashboard/src/app/. "$c:/app/app/"
if [ -n "${FRONT:-}" ]; then
  docker exec "$c" pkill -TERM -f "^bun app/cli.ts start" || true   # the bun process only, not the restart loop around it
  echo "restarted the front server in $c (dashboards detach and reattach)"
else
  for p in $(docker exec "$c" pgrep -f tools/dashboard/server.ts || true); do docker exec "$c" kill -TERM "$p"; done
  echo "restarted dashboard processes in $c (they come back on the next request, or within 30 s for users with game clients)"
fi
REMOTE
