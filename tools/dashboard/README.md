# Multi-account dashboard

> Standalone, open-source version for any rs-sdk user (local or hosted at https://dash.soko.tools): [markeljan/rs-sdk-dashboard](https://github.com/markeljan/rs-sdk-dashboard). Since 2026-10-13 the fleet runs on the hosted one; the local :8765 dashboard is off, and `tools/dashboard-cloud-shim.ts` (LaunchAgent com.rs-sdk.dashboard-shim) answers scripts' `localhost:8765/api/state` reads from https://dash.soko.tools. To go back: move `~/Library/LaunchAgents/disabled-rs-sdk/com.rs-sdk.fleet-dashboard.plist` back and boot it out of the shim. This directory is still the dashboard's source; sync it to rs-sdk-dashboard.

Local web dashboard (desktop + phone PWA) for many bot accounts: live stream, remote input, pause/resume, a per-account overview (XP/gold/clues/bot health), Bot HQ fleet map, managed headless game clients.

```bash
cp tools/dashboard/accounts.example.json telemetry/accounts.json   # list your accounts
bun tools/dashboard/server.ts                                        # http://localhost:8765 + LAN URLs
```

Setup, config fields, HTTP API and restart safety: [`.claude/skills/dashboard/SKILL.md`](../../.claude/skills/dashboard/SKILL.md).
