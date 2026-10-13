---
name: rs-dashboard
description: Set up, connect or operate the RS-SDK Dashboard for rs-sdk bots - run it locally (bun, RS_SDK_DIR) or connect bots to the hosted dashboard (dash.soko.tools) with an API token; host game clients, run the connector, report bot activity. Use when the user asks to see/watch/monitor their bots, set up the dashboard, or connect bots to it.
---

# RS-SDK Dashboard

A web dashboard for rs-sdk bots: live game view and phone remote, Bot HQ map, XP and gold tracking, drop alerts, and
"Current activity" (log + running script) per bot. Repo: https://github.com/markeljan/rs-sdk-dashboard

There are two ways to run it. Ask the user which one they want if it isn't clear.

## A. Local (on the machine with the bots)

```bash
git clone https://github.com/markeljan/rs-sdk-dashboard.git && cd rs-sdk-dashboard && bun install
RS_SDK_DIR=/path/to/rs-sdk bun start          # http://localhost:4747 (+ a "Phone (same Wi-Fi)" URL)
```

- Every `bots/<name>/bot.env` is imported, and logs, running scripts and Pause work directly. No connector is needed.
- Keep it running (a terminal tab or tmux). Set `RSD_PASSWORD` if other people share the network.
- More ways to add accounts:
  - `RSD_ACCOUNTS="name:pw, other:pw!"` (a trailing `!` means the dashboard runs that account's game client)
  - `bun app/cli.ts import <bot.env | dir>`
  - the web UI (⚙ → Manage accounts)

## B. Hosted (https://dash.soko.tools)

The user signs up and copies their personal skill (it has their API token) from the welcome page. With that token
(`RSD_TOKEN`), run from the rs-sdk checkout:

```bash
curl -fsSL https://dash.soko.tools/connect.sh | RSD_TOKEN=$RSD_TOKEN bash      # add every bot (RUN_CLIENT=1: cloud clients)
curl -fsSL https://dash.soko.tools/connector.ts -o .rsd-connector.ts && RSD_TOKEN=$RSD_TOKEN bun .rsd-connector.ts   # keep running
```

## Rules for both

- **One game client per account.** If the dashboard runs an account's client (`runClient: true`), don't open a browser
  client or the lite runner for that account. Scripts and MCP `execute_code` connect to the gateway as usual and drive
  the dashboard's client. To switch: close the other client first, then
  `PATCH /_rsd/api/accounts/<name> {"runClient": true}`. The dashboard refuses with 409 while another client is
  logged in.
- **Pause:** a PAUSED file in `bots/<name>/` means the user paused that bot on the dashboard. Don't start scripts for
  it until the file is gone.
- **Activity from scripts (optional):**
  `POST <dashboard>/_rsd/api/accounts/<name>/activity {"text": "...", "goal": "..."}`, with
  `Authorization: Bearer $RSD_TOKEN` on the hosted dashboard. Local mode needs no token unless `RSD_PASSWORD` is set.
- **Read state:** `GET /api/accounts` and `GET /api/state?account=<name>`.
