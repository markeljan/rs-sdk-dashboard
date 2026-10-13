#!/usr/bin/env bash
# Ship the current checkout to the EC2 host and (re)start the hosted stack.
#   HOST=1.2.3.4 DOMAIN=dash.example.com ./deploy.sh
# First run writes /opt/rs-dashboard/src/infra/aws/.env on the server with a fresh RSD_SECRET (kept across deploys).
set -euo pipefail
: "${HOST:?HOST=<server ip>}" "${DOMAIN:?DOMAIN=<public host name>}"
KEY_FILE=${KEY_FILE:-$HOME/.ssh/rs-dashboard.pem}
ADMIN_EMAIL=${ADMIN_EMAIL:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SSH="ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new ubuntu@$HOST"

$SSH 'until [ -f /var/lib/cloud/instance/rsd-ready ]; do echo "waiting for first-boot setup..."; sleep 10; done'
rsync -az --delete -e "ssh -i $KEY_FILE" --exclude node_modules --exclude .git --exclude data --exclude 'infra/aws/.env' "$ROOT/" "ubuntu@$HOST:/opt/rs-dashboard/src/"
$SSH bash -s <<REMOTE
set -euo pipefail
cd /opt/rs-dashboard/src/infra/aws
mkdir -p /opt/rs-dashboard/data /opt/rs-dashboard/caddy
if [ ! -f .env ]; then
  umask 077
  printf 'RSD_SECRET=%s\nRSD_PUBLIC_URL=https://%s\nRSD_ADMIN_EMAIL=%s\n' "\$(openssl rand -hex 32)" "$DOMAIN" "$ADMIN_EMAIL" > .env
fi
grep -q '^DOMAIN=' .env || echo "DOMAIN=$DOMAIN" >> .env
export DOMAIN=$DOMAIN
docker compose -f docker-compose.hosted.yml --env-file .env up -d --build --remove-orphans
docker image prune -f >/dev/null
sleep 5
docker compose -f docker-compose.hosted.yml ps
REMOTE
echo "deployed: https://$DOMAIN"
