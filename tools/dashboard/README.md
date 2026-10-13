# Multi-account dashboard

> Standalone, open-source version for any rs-sdk user (local or hosted at https://dash.soko.tools): [markeljan/rs-sdk-dashboard](https://github.com/markeljan/rs-sdk-dashboard). This directory stays the fleet's own dashboard.

Local web dashboard (desktop + phone PWA) for many bot accounts: live stream, remote input, pause/resume, a per-account overview (XP/gold/clues/bot health), Bot HQ fleet map, managed headless game clients.

```bash
cp tools/dashboard/accounts.example.json telemetry/accounts.json   # list your accounts
bun tools/dashboard/server.ts                                        # http://localhost:8765 + LAN URLs
```

Setup, config fields, HTTP API and restart safety: [`.claude/skills/dashboard/SKILL.md`](../../.claude/skills/dashboard/SKILL.md).
