# Connecting agents to the RS-SDK Dashboard

This guide is for coding agents (Claude Code, Codex, …) that run rs-sdk bots. You can copy it into your rs-sdk checkout's `CLAUDE.md` or `AGENTS.md`.

## Setup (once per account)

The dashboard needs each account's `bot.env` credentials. Pick one way to add them:

- Hosted (https://dash.soko.tools): the user creates an API token under ⚙ Settings → API tokens. Then, from the rs-sdk checkout:
  ```bash
  curl -fsSL https://dash.soko.tools/connect.sh | RSD_TOKEN=$RSD_TOKEN bash              # all bots/*/bot.env
  curl -fsSL https://dash.soko.tools/connect.sh | RSD_TOKEN=$RSD_TOKEN RUN_CLIENT=1 bash # + host their game clients
  ```
- Local dashboard: `RS_SDK_DIR=/path/to/rs-sdk bun start`, run in the dashboard checkout. It picks up new bots on restart, or run `bun src/cli.ts import /path/to/rs-sdk`.

## Game clients

Only one game client can be logged in per account. Check the account before you open a browser tab or the lite runner for it:

- If the dashboard shows **client running** for the account, the dashboard is hosting the client. Don't open another one. Scripts (`bun bots/<name>/script.ts`) and MCP `execute_code` drive the dashboard's client through the gateway as usual.
- To move a client from your machine to the dashboard, close your client first, then turn on **Run game client** for the account, or call `PATCH /api/accounts/<name>` with `{"runClient":true}`.

## Report what the bot is doing

The dashboard shows the latest activity line on the account card and on the account page:

```ts
// bots/<name>/lib/dashboard.ts - no-op unless RSD_URL and RSD_TOKEN are set
export async function reportActivity(account: string, text: string) {
    const url = process.env.RSD_URL, token = process.env.RSD_TOKEN;
    if (!url || !token) return;
    await fetch(`${url}/api/accounts/${encodeURIComponent(account)}/activity`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000),
    }).catch(() => {});
}
```

## Read state

`GET /api/accounts/<name>` (with the same bearer token) returns the summary the dashboard shows: skills, inventory, equipment, position, recent game messages, XP/h and client status. For anything richer, use the SDK.
