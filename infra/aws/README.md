# Hosted deployment (AWS)

The public service at dash.soko.tools runs on a single EC2 instance:

- **EC2**: `c7i.2xlarge` (8 vCPU, 16 GB) running Ubuntu 24.04 with Docker, plus a 4 GB swap file. Each game client is a headless Chromium of about 250 MB, and its CPU use peaks while it loads the map, so burstable `t3` instances choke when several clients start at once. Cap: `RSD_MAX_CLIENTS=30`.
- **Elastic IP**, with a DNS A record pointing the domain at it.
- **Caddy**: HTTPS with automatic Let's Encrypt certificates. It proxies WebSockets.
- **Data**: SQLite plus the encryption secret in `/opt/rs-dashboard/data` (the EBS root volume). Back it up with EBS snapshots.

```bash
cd infra/aws
./provision.sh                                   # key pair, security group, instance, Elastic IP
# DNS: A record  dash.example.com -> <ip>       (e.g. `vercel dns add example.com dash A <ip>`)
HOST=<ip> DOMAIN=dash.example.com ADMIN_EMAIL=you@example.com ./deploy.sh
```

Ship dashboard-only changes (`tools/dashboard`) with `HOST=<ip> ./hot-deploy.sh`: game clients stay logged in (detach/reattach). Use `deploy.sh` for `app/`, dependencies or the Dockerfile; that restarts every game client (bots reconnect on their own).

Operations:

```bash
ssh -i ~/.ssh/rs-dashboard.pem ubuntu@<ip>
cd /opt/rs-dashboard/src/infra/aws && docker compose -f docker-compose.hosted.yml logs -f dashboard
```

Scaling up: use a bigger instance type and raise `RSD_MAX_CLIENTS` in `/opt/rs-dashboard/src/infra/aws/.env`. Beyond one box, split game-client hosts from the web/API tier. The server already keeps all state in SQLite behind `Store`, so that's the seam to replace.

Public world spectator TV runs separately at **https://live.soko.tools** on the same host. Build with `bun run tv:build`, then deploy with `HOST=<ip> infra/aws/deploy-tv.sh`; this preserves dashboard game clients. See [live TV](../../docs/live-tv.md) for the renderer, relay, controls and recovery.
