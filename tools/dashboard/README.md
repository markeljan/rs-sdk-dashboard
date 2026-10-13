# Multi-account dashboard

> Standalone, open-source version for any rs-sdk user (local or hosted at https://dash.soko.tools): [markeljan/rs-sdk-dashboard](https://github.com/markeljan/rs-sdk-dashboard). Since 2026-10-13 the fleet runs on the hosted one; the local :8765 dashboard is off, and `tools/dashboard-cloud-shim.ts` (LaunchAgent com.rs-sdk.dashboard-shim) answers scripts' `localhost:8765/api/state` reads from https://dash.soko.tools. To go back: move `~/Library/LaunchAgents/disabled-rs-sdk/com.rs-sdk.fleet-dashboard.plist` back and boot it out of the shim. This directory is still the dashboard's source; sync it to rs-sdk-dashboard.

Local web dashboard (desktop + phone PWA) for many bot accounts: live stream, remote input, pause/resume, a per-account overview (XP/gold/clues/bot health), Bot HQ fleet map, managed headless game clients.

```bash
cp tools/dashboard/accounts.example.json telemetry/accounts.json   # list your accounts
bun tools/dashboard/server.ts                                        # http://localhost:8765 + LAN URLs
```

Setup, config fields, HTTP API and restart safety: [`.claude/skills/dashboard/SKILL.md`](../../.claude/skills/dashboard/SKILL.md).

## Responsive layout checks

`bun test tools/dashboard/layout.test.ts` runs the real dashboard against synthetic HTTP data, with no gateway,
observers or game clients. It checks phone and tablet portrait/landscape, narrow browser windows, desktop,
regular native/CSS fullscreen, dynamic fullscreen, standalone display mode with simulated safe-area insets,
Settings and the 89-account Bot HQ list. Viewport resizing covers browser chrome expanding and collapsing.
These are Chromium device-emulation checks; they do not replace testing on physical Safari/Android devices.

The phone account bar keeps two lines (account name and level/QP or online counts), never shrinks vertically,
and folds lite accounts behind its toggle. Current activity shows a two-line action headline; **Full activity**
keeps the complete status and goal accessible. Logs scroll inside the card. Short browser windows can scroll
vertically, and landscape uses a game/side-panel split after exiting fullscreen. Fullscreen respects orientation
and display safe areas; an account row is shown only when it fits clear of the camera controls.

Static page changes are served from disk. Updating `tools/dashboard/public/` and the hosted `app/pages/`
does not require restarting the front server, dashboard processes or game clients.
