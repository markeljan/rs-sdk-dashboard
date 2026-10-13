# RS-SDK Dashboard

This is the multi-account dashboard for [rs-sdk](https://github.com/MaxBittker/rs-sdk) bots. It is the same dashboard the rs-sdk fleet runs. Use it to watch every bot live from a laptop or phone, tap into the game when a bot gets stuck, follow XP and gold rates, and keep game clients running in the cloud so your agents' scripts keep working when your computer is off.

You can use it two ways:

- **Hosted**: https://dash.soko.tools. It's free: sign up, add accounts, done.
- **Local**: run it yourself with Bun or Docker.

## Quick start: hosted, with an AI agent

1. Sign up at https://dash.soko.tools.
2. Click **Copy agent skill** and paste it into Claude Code, Codex, ChatGPT or any other agent working in your rs-sdk checkout. The skill already contains your dashboard URL and an API token. It tells the agent to add every `bots/*/bot.env`, optionally host their game clients, and report what each bot is doing.
3. Open the dashboard on your phone and choose **Share → Add to Home Screen**.

Without an agent, you have three other ways to add accounts:

- **＋ Add account**: enter a username and password, or paste a `bot.env`.
- **Import bots folder**: pick your rs-sdk `bots` folder.
- **Terminal**: run this one line in your rs-sdk checkout:

  ```bash
  curl -fsSL https://dash.soko.tools/connect.sh | RSD_TOKEN=<token from the page> bash      # RUN_CLIENT=1 to host the clients
  ```

## Quick start: local

Install Bun first (`curl -fsSL https://bun.sh/install | bash`).

```bash
git clone https://github.com/markeljan/rs-sdk-dashboard.git && cd rs-sdk-dashboard
bun install
RS_SDK_DIR=~/rs-sdk bun start      # http://localhost:4747; imports every bots/<name>/bot.env from your checkout
```

You can also start it with:

- `bun start` with no settings, then add accounts on the page.
- `RSD_ACCOUNTS="mybot:pw, alt:pw!" bun start`. A trailing `!` means the dashboard runs that account's game client.
- `bun app/cli.ts import <bot.env | accounts.json | rs-sdk dir>`.
- `bun app/cli.ts skill` prints the agent skill for this local dashboard.

`bun install` downloads the Chrome used for game clients (puppeteer). Set `RSD_PASSWORD` if anyone else can reach the port.

Docker: `docker compose up -d`, then open http://localhost:4747.

## Account types

- **Game client here** (managed): the dashboard keeps a headless game client logged in, streams it at up to 60 fps, and takes taps and keys. Scripts and MCP `execute_code` drive this client through the gateway, so don't open a second client for the account.
- **Lite**: the account's client runs somewhere else (a browser tab or the lite runner). The dashboard draws a simulated 2004 client from the account's live state, so you can watch it but not send input.

Every view, setting and feature comes from the dashboard itself: Bot HQ, dynamic fullscreen, toasts, highlights, the stream FPS and quality settings, and the rest. ⚙ Settings → **Accounts & agents** links to account management.

## How it's built

```
browser / phone ──▶ app/ (front server: login, accounts, tokens, agent skill, proxy)
                          └─▶ one tools/dashboard/server.ts per user on 127.0.0.1 (the rs-sdk fleet dashboard, unmodified)
                                 ├─ observe-mode SDK + gateway HTTP for state      (rs-sdk gateway)
                                 └─ headless Chrome per "game client here" account (/bot?bot=…)
```

- `tools/`, `sdk/` and `server/` are synced verbatim from rs-sdk by `bun scripts/sync-from-rs-sdk.ts <rs-sdk checkout>`. Don't edit them here. Change the dashboard in rs-sdk, then sync. `SYNCED_FROM` records the rs-sdk commit.
- `app/` is this project's own code. It turns each user's accounts into that user's dashboard `accounts.json` and `bot.env` files, then proxies HTTP and WebSockets to it.
- API tokens are signed, not stored. Every visit gets a fresh token built into the skill. A token is recorded the first time it's used, and you can rename or revoke it under Manage accounts.
- Game passwords are stored with AES-256-GCM encryption. On the hosted service the dashboard processes read them from tmpfs, never from disk.

## Agent API

Use the bearer token from the skill.

| Endpoint | |
|---|---|
| `POST /_rsd/api/accounts` | add or update: `{name, password, server?, runClient?}` or `{botEnv, runClient?}` |
| `GET /_rsd/api/accounts` · `PATCH`/`DELETE /_rsd/api/accounts/<name>` | list, change `{password, server, runClient}`, remove |
| `POST /_rsd/api/accounts/<name>/activity` | `{text, goal?}`: the "Current activity" card |
| `POST /_rsd/api/accounts/<name>/log` | `{lines: [...]}`: the activity log |
| `GET /api/accounts`, `GET /api/state?account=<name>` | the dashboard's own data: levels, XP/h, skills, items, client status |

## Configuration

These are environment variables; see `.env.example`. The main ones:

- `RSD_MODE` (`local`, or `hosted` for sign-ups)
- `PORT`
- `RSD_DATA_DIR`
- `RSD_SERVER` (default game server)
- `RSD_PASSWORD`
- `RSD_ACCOUNTS`
- `RS_SDK_DIR`
- `RSD_ACCOUNTS_FILE`
- `RSD_PUBLIC_URL`, `RSD_SECRET` and `RSD_ADMIN_EMAIL` (hosted)
- Limits: `RSD_MAX_ACCOUNTS`, `RSD_MAX_CLIENTS_PER_USER`, `RSD_MAX_CLIENTS`

The dashboard's own variables pass through to each per-user process: `FPS`, `QUALITY`, `IDLE_FPS`, `OBSERVERS`, `NO_HISCORES`, `PUPPETEER_EXECUTABLE_PATH`.

## Hosting it yourself

[`infra/aws`](infra/aws) contains the scripts behind dash.soko.tools: one EC2 instance running Docker, Caddy for HTTPS, and SQLite.

## Development

```bash
bun run check                              # typecheck + tests (app/)
bun test tools/dashboard                   # the dashboard's own tests (needs Chrome)
bun scripts/sync-from-rs-sdk.ts ../rs-sdk  # pull dashboard changes from rs-sdk
```

MIT licensed. Includes code from rs-sdk and the Lost City client (MIT, see `LICENSE-rs-sdk` and `server/webclient/LICENSE`).
