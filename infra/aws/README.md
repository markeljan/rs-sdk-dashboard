# Hosted deployment (AWS)

The public service at dash.soko.tools runs on a single EC2 instance:

- **EC2**: `t3.large` (2 vCPU, 8 GB) running Ubuntu 24.04 with Docker, plus a 4 GB swap file. Each game client is a headless Chromium of about 200–300 MB, so the default cap of 14 clients fits.
- **Elastic IP**, with a DNS A record pointing the domain at it.
- **Caddy**: HTTPS with automatic Let's Encrypt certificates. It proxies WebSockets.
- **Data**: SQLite plus the encryption secret in `/opt/rs-dashboard/data` (the EBS root volume). Back it up with EBS snapshots.

```bash
cd infra/aws
./provision.sh                                   # key pair, security group, instance, Elastic IP
# DNS: A record  dash.example.com -> <ip>       (e.g. `vercel dns add example.com dash A <ip>`)
HOST=<ip> DOMAIN=dash.example.com ADMIN_EMAIL=you@example.com ./deploy.sh
```

Re-run `deploy.sh` to ship updates. Game clients restart, and bots reconnect on their own.

Operations:

```bash
ssh -i ~/.ssh/rs-dashboard.pem ubuntu@<ip>
cd /opt/rs-dashboard/src/infra/aws && docker compose -f docker-compose.hosted.yml logs -f dashboard
```

Scaling up: use a bigger instance type and raise `RSD_MAX_CLIENTS` in `/opt/rs-dashboard/src/infra/aws/.env`. Beyond one box, split game-client hosts from the web/API tier. The server already keeps all state in SQLite behind `Store`, so that's the seam to replace.
