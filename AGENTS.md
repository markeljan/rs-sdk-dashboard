# AGENTS.md

This file is for coding agents working on this repo. To set up or use the dashboard instead, see
`skills/rs-dashboard/SKILL.md`, `docs/setup-local.md` and `docs/setup-hosted.md`.

## Layout

| Path | What | Edit here? |
|---|---|---|
| `tools/dashboard/` | The dashboard itself (server + UI), the same code the rs-sdk fleet runs | **No.** Change it in rs-sdk, then sync |
| `sdk/`, `server/`, `tools/quests/` | The rs-sdk files the dashboard imports (SDK, webclient code for the lite view, fork bot bundle) | **No.** Synced |
| `app/` | This project's layer: front server, users and auth, accounts, per-user dashboard processes, proxy, API tokens, agent skill, connector | Yes |
| `app/pages/` | Login, welcome, manage, landing page, and `inject.js` (the Accounts row in the dashboard's Settings) | Yes |
| `scripts/sync-from-rs-sdk.ts` | Copies `tools/dashboard` and its imports from an rs-sdk checkout | Yes |
| `infra/aws/` | Hosted deployment (EC2 + Docker + Caddy) | Yes |
| `docs/`, `skills/` | Copy-paste setup prompts and the generic agent skill | Yes |

## How it fits together

- **Front server** (`app/server.ts`): owns users and accounts. For each user it runs one `tools/dashboard/server.ts`
  on 127.0.0.1 (`app/instances.ts`). It writes that process's `accounts.json` and `bot.env` files (hosted:
  credentials live in tmpfs) and proxies all HTTP and WebSocket traffic to it.
- **The dashboard process:**
  - runs the game clients (headless Chrome, detached)
  - observes accounts through the gateway
  - draws lite views
  - streams frames, with per-viewer Auto quality and frame credits
- **Restarts:** on SIGTERM a dashboard process detaches from its Chromes, and the next process reattaches to them.
  That's why `infra/aws/hot-deploy.sh` can ship changes without logging game clients out.
- **Connector** (`app/connector.ts`): runs next to the bots. It sends logs, `tasks.json`, running scripts (ps plus
  host status files) and telemetry jsonl to `/_rsd/api/connect/sync`, and mirrors Pause back to the bots.
- **API tokens:** signed (`rsd_<user>_<nonce>_<sig>`) and recorded on first use. Revoking one stores its nonce.

## Commands

```bash
bun install
bun run check                               # typecheck + app tests (must pass before pushing)
bun test tools/dashboard                    # the dashboard's own tests (needs Chrome)
bun scripts/sync-from-rs-sdk.ts ../rs-sdk   # pull dashboard changes from rs-sdk
RSD_MODE=hosted RSD_DATA_DIR=/tmp/rsd PORT=4751 bun app/cli.ts start   # hosted mode locally
```

## Deploying the hosted service (dash.soko.tools)

- `HOST=<ip> infra/aws/hot-deploy.sh`: dashboard and `app/pages` changes. Game clients stay logged in.
- `HOST=<ip> FRONT=1 infra/aws/hot-deploy.sh`: also `app/*.ts`. The front server restarts in place.
- `HOST=<ip> DOMAIN=dash.soko.tools infra/aws/deploy.sh`: dependency or Dockerfile changes. This rebuilds the
  container and logs every game client out and back in, so warn users first.

## Rules

- **Game client limit:** only one game client can be logged in per account. Never start a client for an account
  without checking that another one isn't logged in (`/status/<name>` on the gateway).
- **Secrets:** never commit `bot.env`, tokens, `.env`, or anything under `data/`.
- **Tests:** keep `app/app.test.ts` passing, and add cases for new `/_rsd/api` routes.
