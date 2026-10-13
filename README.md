# RS-SDK Dashboard

A web dashboard for [rs-sdk](https://github.com/MaxBittker/rs-sdk) bot accounts. Watch your bots play from your laptop or phone, tap in the game when they get stuck, track XP rates, and keep game clients running in the cloud so your agents' scripts work when your computer is off.

You can use it two ways:

- **Hosted**: sign up at **https://dash.soko.tools**. It's free, with nothing to install.
- **Local**: run it yourself with Bun or Docker. Your accounts stay on your machine.

Both run the same code, so they have the same features.

## What it does

- **Every account at a glance**: online status, combat and total level, HP, XP/h, and what each bot is doing.
- **Live game view**: the dashboard can run the game client for an account (headless Chrome) and stream it to any browser. You can tap, right-click (long-press on phones), type and rotate the camera. It's installable as a phone app (PWA).
- **Works with your agents**: rs-sdk scripts and MCP `execute_code` connect to the game server as usual and drive the client the dashboard runs. You don't need a browser tab open.
- **Account details**: skills, inventory, equipment, game messages, in-game chat (read and send), an XP graph, and your scripts' log tail (local mode with an rs-sdk checkout).
- **Agent API**: use API tokens to add accounts, read state as JSON, and post an "activity" line from your scripts.

The dashboard only talks to the rs-sdk **gateway** (the same server your bots use). It needs nothing from your rs-sdk checkout, and it works with the public demo server, your own server, or `localhost`.

## Quick start: hosted

1. Open https://dash.soko.tools and create an account.
2. **＋ Add account**: enter your bot's username and password (from `bots/<name>/bot.env`), or paste the whole `bot.env`. To add many bots at once, use **Import many** and pick your rs-sdk `bots` folder. You can also create a token (⚙ Settings → API tokens) and run this from your rs-sdk checkout:
   ```bash
   curl -fsSL https://dash.soko.tools/connect.sh | RSD_TOKEN=rsd_... bash      # RUN_CLIENT=1 to also host the clients
   ```
3. Optional: tick **Run the game client on this dashboard**. Close your own game tab for that account first, because only one client can be logged in per account. From then on the client runs on our servers 24/7.
4. On your phone, open the same URL and choose **Add to Home Screen**.

Your agent setup doesn't change. Scripts keep using `bot.env`, and they now drive the cloud client. Each account's **Connect agent** tab shows the exact `bot.env`.

## Quick start: local

You need a recent [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`, or `bun upgrade`).

```bash
git clone https://github.com/markeljan/rs-sdk-dashboard.git
cd rs-sdk-dashboard
bun install
bun start                     # http://localhost:4747 (also prints LAN URLs for your phone)
```

Then add accounts in the web UI, or use any of these:

```bash
RS_SDK_DIR=~/rs-sdk bun start                         # import every bots/*/bot.env (+ show script logs)
RSD_ACCOUNTS="mybot:secret, alt2:pw!" bun start       # trailing ! = run its game client here
bun src/cli.ts import ~/rs-sdk/bots/mybot/bot.env     # or an accounts.json, or an rs-sdk dir
bun src/cli.ts add mybot secret --client
bun src/cli.ts list
```

Game clients need Chrome. The dashboard uses an installed Chrome or Chromium, or downloads `chrome-headless-shell` once (about 100 MB) into `~/.rs-dashboard/chrome`.

Docker:

```bash
docker compose up -d          # http://localhost:4747, data in the rsd-data volume
```

If anyone else can reach the port, set `RSD_PASSWORD`. Without it, anyone on your network can open the dashboard and click in your games.

## Configuration

Everything is set with environment variables. Bun reads a `.env` file automatically, and [`.env.example`](.env.example) lists them all.

| Variable | Default | |
|---|---|---|
| `RSD_MODE` | `local` | `hosted` turns on sign-ups and per-user accounts |
| `PORT` | `4747` | |
| `RSD_DATA_DIR` | `~/.rs-dashboard` | SQLite database, encryption key, browser profiles |
| `RSD_SERVER` | `rs-sdk-demo.fly.dev` | default game server, same as `SERVER=` in `bot.env` |
| `RSD_PASSWORD` | – | local mode: password for the web UI |
| `RSD_ACCOUNTS` | – | `name:password[@server][!]`, comma separated |
| `RS_SDK_DIR` | – | rs-sdk checkout to import accounts and logs from |
| `RSD_ACCOUNTS_FILE` | – | JSON list of accounts ([example](accounts.example.json)) |
| `CHROME_PATH` | auto | Chrome for game clients |
| `RSD_FPS` / `RSD_QUALITY` / `RSD_IDLE_FPS` | 20 / 75 / 5 | live view rate, JPEG quality, unwatched render rate |
| `RSD_SECRET` | generated | encrypts stored game passwords (hosted: set it and keep it) |
| `RSD_MAX_ACCOUNTS`, `RSD_MAX_CLIENTS_PER_USER`, `RSD_MAX_CLIENTS` | 20 / 3 / 14 (hosted) | limits |

## For agents and scripts

Create a token under ⚙ Settings → API tokens. Pass it as `Authorization: Bearer <token>`. You can use the account id or the account name in paths.

```bash
# add an account (from your rs-sdk checkout, CI, an agent...)
curl -X POST $DASH/api/accounts -H "Authorization: Bearer $RSD_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"mybot","password":"secret","server":"rs-sdk-demo.fly.dev","runClient":true}'

# or send the bot.env as-is
jq -Rs '{botEnv: ., runClient: true}' bots/mybot/bot.env | curl -X POST $DASH/api/accounts \
  -H "Authorization: Bearer $RSD_TOKEN" -H 'content-type: application/json' -d @-

# tell the dashboard what the bot is doing (shown on its card)
curl -X POST $DASH/api/accounts/mybot/activity -H "Authorization: Bearer $RSD_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"Mining iron, 412 ore banked"}'

curl $DASH/api/accounts/mybot -H "Authorization: Bearer $RSD_TOKEN"   # state as JSON
```

| Endpoint | |
|---|---|
| `GET /api/accounts` | all your accounts (summary cards) |
| `POST /api/accounts` | add or update: `{name, password, server?, runClient?}` or `{botEnv, runClient?}` |
| `GET /api/accounts/:id` | full view: skills, items, messages, client status, XP history |
| `PATCH /api/accounts/:id` | `{password?, server?, runClient?}` |
| `DELETE /api/accounts/:id` | remove from the dashboard (the game account is untouched) |
| `POST /api/accounts/:id/activity` | `{text}` |
| `POST /api/accounts/:id/say` · `GET /api/accounts/:id/chat` | in-game chat via the gateway |
| `POST /api/accounts/:id/input` | `{ev:{kind:'click'|'move'|'key'|'text', ...}}` into the dashboard's client (x/y 0–1) |
| `POST /api/accounts/:id/client/reload` | reload the game page |
| `GET /api/accounts/:id/connect` | `bot.env` text for your rs-sdk checkout |
| `WS /ws` | live account updates; `{"t":"watch","id":N}` streams JPEG frames |

## How it works

```
your agent / scripts ──control──▶ rs-sdk gateway ◀──game client (browser tab, lite runner, or this dashboard)
                                        ▲
             dashboard ── HTTP: /state /status /chat /say (read-only + chat)
                │  └── optional headless Chrome per account: /bot?bot=<name>&password=…  → JPEG frames, input
                └──▶ browsers / phones (WebSocket)
```

- State comes from the gateway's HTTP endpoints. The public demo serves them on its direct port `:7443`, and the dashboard finds that automatically. Gateways without the HTTP API fall back to a read-only observer WebSocket.
- Game passwords are stored with AES-256-GCM encryption. Sessions and API tokens are stored only as hashes.
- A game client nobody is watching renders at 5 fps. Bots run at full speed regardless, because game logic doesn't depend on rendering.

## Self-hosting the public service

[`infra/aws`](infra/aws) has the scripts behind dash.soko.tools. They set up one EC2 instance with Docker, Caddy for automatic HTTPS, and SQLite on its disk. See [infra/aws/README.md](infra/aws/README.md).

## Development

```bash
bun run dev      # restart on change
bun run check    # typecheck + tests
```

The source is small and has no build step: `src/server.ts` (HTTP/WS + auth), `src/runtime.ts` (per-account polling), `src/managed.ts` (headless client, frames, input), `src/gateway.ts`, `src/db.ts`, and `public/app.js` (UI).

Please respect the rs-sdk demo server's rules. It's for bots, so use the remote control to unstick them, not to play by hand.

MIT licensed.
