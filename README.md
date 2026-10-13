# RS-SDK Dashboard

Watch and control your [rs-sdk](https://github.com/MaxBittker/rs-sdk) bots from anywhere: a live game view with
phone remote control, a Bot HQ map of every account, XP and gold rates, drop alerts, and what each bot is doing right
now. It's the dashboard a 90-account rs-sdk fleet runs on, packaged so anyone can use it.

**Two ways to use it:**

| | Hosted: [dash.soko.tools](https://dash.soko.tools) | Local: run it yourself |
|---|---|---|
| Setup | Sign up, paste one skill into your agent | `git clone` + `bun start` |
| Runs your game clients | Optional, in the cloud, 24/7 (limited slots) | Optional, on your machine, no limit |
| Access | Anywhere, phone included | Your computer + phones on your Wi-Fi |
| Cost | Free beta | Free |

Your bot scripts and agents run on your own machine in both setups. The dashboard shows them and can host their
game clients.

## Quick start: hosted

1. Sign up at **https://dash.soko.tools**.
2. Click **Copy agent skill** and paste it into Claude Code, Codex or any agent, inside your rs-sdk checkout. It
   adds your bots, can run their game clients in the cloud, and starts the connector, which sends each bot's log,
   script, gold and drops to the dashboard.
3. On your phone: open the site, then **Share → Add to Home Screen**.

Details and the no-agent options: [docs/setup-hosted.md](docs/setup-hosted.md).

## Quick start: local

Copy-paste prompt for your agent: [docs/setup-local.md](docs/setup-local.md). Or by hand:

```bash
git clone https://github.com/markeljan/rs-sdk-dashboard.git && cd rs-sdk-dashboard
bun install                                  # needs Bun: curl -fsSL https://bun.sh/install | bash
RS_SDK_DIR=../rs-sdk bun start               # http://localhost:4747, and a "Phone (same Wi-Fi)" URL
```

Every `bots/<name>/bot.env` in your checkout appears with its log, running script and a working pause button. To let
the dashboard run an account's game client, open ⚙ → Manage accounts and turn on **Client**. Only one client can be
logged in per account, so close any other client for that account first.

Other ways to add accounts:

- `RSD_ACCOUNTS="mybot:pw, alt:pw!" bun start` (`!` = run its client here)
- `bun app/cli.ts import <bot.env | dir>`
- the web UI

Set `RSD_PASSWORD` if other people share your network. Docker: `docker compose up -d`.

## For agents

- **Skill** to drop into Claude Code / Codex: [`skills/rs-dashboard/SKILL.md`](skills/rs-dashboard/SKILL.md). It
  covers setup, connecting, the one-client-per-account rule, pause and activity.
- **Working on this repo:** [`AGENTS.md`](AGENTS.md).
- **API**: all requests take `Authorization: Bearer <token>` on the hosted dashboard.

| Endpoint | |
|---|---|
| `POST /_rsd/api/accounts` | add or update: `{name, password, server?, runClient?}` or `{botEnv, runClient?}` |
| `PATCH` / `DELETE /_rsd/api/accounts/<name>` | `{password?, server?, runClient?}` / remove |
| `POST /_rsd/api/accounts/order` | `{names: [...]}`, the account order |
| `POST /_rsd/api/accounts/<name>/activity` | `{text, goal?}` for the Current activity card (answers `{paused}`) |
| `POST /_rsd/api/connect/sync` | the connector's batch upload |
| `GET /api/accounts`, `GET /api/state?account=<name>` | live data: levels, XP/h, items, client status |

## Features

- **Live view:** the dashboard runs headless game clients, streams them (Auto quality per device, smooth on mobile
  data) and takes taps, keys, right-clicks and camera control. On phones it has a split fullscreen layout and cursor
  mode.
- **Lite view:** for accounts whose client runs elsewhere, a drawn 2004 client built from live state.
- **Bot HQ:** every account on one world map, with an event feed and fleet totals.
- **Tracking:** current activity (log + running script), XP/h, wealth and GP/h, play time, drop alerts and
  highlights.
- **Control:** pause/resume bots, reload clients, in-game chat.
- **Accounts:** add, remove and reorder; game clients on/off; API tokens (created on use); a copy-paste agent skill.

## How it's built

```
browser / phone ──▶ app/ front server (login, accounts, tokens, skill, landing page, proxy)
                        └─▶ one tools/dashboard/server.ts per user (the rs-sdk dashboard, unmodified)
                              ├─ observes accounts through the rs-sdk gateway
                              └─ headless Chrome per "client on" account (the rs-sdk web client)
bots' machine ── connector (logs, scripts, gold, drops, pause) ──▶ /_rsd/api/connect/sync
```

- `tools/`, `sdk/` and `server/` are synced verbatim from rs-sdk (`scripts/sync-from-rs-sdk.ts`, see `SYNCED_FROM`).
- Game passwords are stored with AES-256-GCM encryption. Hosted, dashboards read them from tmpfs.
- Deploying your own hosted copy: [infra/aws/README.md](infra/aws/README.md).

## Configuration

Settings are environment variables; see [`.env.example`](.env.example).

- **Mode and storage:** `RSD_MODE` (`local` / `hosted`), `PORT`, `RSD_DATA_DIR`.
- **Accounts:** `RSD_SERVER`, `RSD_PASSWORD`, `RSD_ACCOUNTS`, `RS_SDK_DIR`.
- **Hosted:** `RSD_PUBLIC_URL`, `RSD_SECRET`, `RSD_ADMIN_EMAIL`, and the limits `RSD_MAX_ACCOUNTS`,
  `RSD_MAX_CLIENTS_PER_USER`, `RSD_MAX_CLIENTS`.
- **Stream defaults:** `FPS`, `QUALITY`, `IDLE_FPS` (passed through to the dashboard).

## Hosted beta: what to expect

dash.soko.tools runs on a single server. Cloud game clients are limited: up to 3 per user, about 20 free slots in
total. If it gets popular, the limits may get stricter or the hosted setup may grow. Running locally has no limits.

MIT licensed. Includes code from rs-sdk and the Lost City client (MIT): see `LICENSE-rs-sdk` and
`server/webclient/LICENSE`.
