# RS-SDK TV

Public spectator site: https://live.soko.tools. The dashboard links to it from Settings and the landing page.

TV shows the live world with the original game's terrain, models, animations, public chat, health bars and hitsplats. It uses the read-only public world feed. It never logs into an account or connects to the gameplay gateway. The renderer is [MaxBittker/rs-world](https://github.com/MaxBittker/rs-world), built on dennisdev's BSD-licensed rs-map-viewer; credits and its license ship with the site.

## Watch

- **Auto TV**: the same server-directed camera story for everyone. It holds a shot for 35 seconds, then rotates through populated areas, favoring observed combat, boss locations, minigames, and Voltbot. The ranking is heuristic; unobserved events elsewhere cannot be detected until a camera/scout visits them. The roster reports online public players roughly every three seconds. Three persistent scout feeds cover Duel Arena, Castle Wars and Kalphite Queen.
- **Players**: search the whole online roster and select anyone to follow. Characters on other floors and underground are supported. The camera follows live movement and reacquires after teleports.
- **Rankings**: Skills, GP coin-stack and dragon chainbody icon buttons select Overall, Bank value and Equipment value. The Other rankings dropdown contains all 19 skills, quest points and combat level. Online-only is on by default; **Watch** jumps to the matching live player and opens their details. Official ranks are preserved; hiscore coverage is the top 105 entries per skill/overall/quests and top 50 public bank/equipment entries. Combat ranks the whole online roster. Scores are published snapshots, cached for five minutes, with a fetch timestamp. Failed refreshes are explicitly labeled as saved snapshots. Online availability always comes from the fresh roster.
- **Player**: while following someone, shows public skills, total level, overall rank, quest points and live combat level/location. Published bank/equipment totals and items appear when the player is in those public top-50 tables; bank items are limited to the six published top items. Unavailable values stay unknown. Full private banks and live inventory are not exposed by this feed.
- **Chat**: public viewer chat is always visible at the bottom left, independently of the explorer tabs, including cinema mode. It requires no login. A nickname is saved in browser localStorage. Messages are plain text, up to 400 characters; each IP can send five per ten seconds. The last 80 messages load on connection; the latest 500 persist across service restarts in `/opt/rs-dashboard/tv/chat-data/chat.sqlite`. This chat never sends messages into the game.
- **Places**: instantly visit Duel Arena, Castle Wars, Varrock, Lumbridge, Falador, bosses and other presets. A destination can be quiet; selecting it does not imply an event is happening.
- **World map**: use **Map** in the top bar or the globe on the minimap. Double-click a map tile to jump there; select a player marker to follow.
- **Camera**: drag to orbit, wheel to zoom, WASD to move, E/R up, C/F down. Arrow keys look around with the RuneScape camera directions. Moving manually leaves auto mode. Free-camera changes affect only that viewer. Touch uses two joysticks.
- **Cinema**: hides controls. Hover the top edge to restore them. `?clean=1` starts this way and can be used as an OBS browser source. Fullscreen uses the browser's fullscreen control.

This is live client-side 3D rendering of server state, rather than an encoded video stream. It needs WebGL2. Static game assets are about 10 MB on first load; subsequent traffic consists of small world-state deltas. All viewers can choose their own camera without paying to encode or transmit a video per viewer. A separate RTMP/HLS channel for Twitch or YouTube is not provisioned.

## Build and run

```sh
bun run tv:build
bun run tv:start  # http://127.0.0.1:4750
```

The build script checks out pinned renderer commit `7e4c9f711ba2f5a1f8e354c6083b8a471530383b` into `.tv-cache/renderer`, applies `tv/` plus the shared director types, and fetches the current demo server's game cache. Generated cache/build files are ignored. The renderer's existing CRA build has upstream lint warnings; compilation and type checking must succeed. Our dashboard checks remain `bun run check`. Run `TV_URL=https://live.soko.tools bun scripts/e2e-tv.ts` for live desktop/mobile acceptance: changing entity positions, follow, location jumps, map navigation, camera movement and cinema controls. It writes screenshots under `/tmp/rs-tv-*.png`.

Environment: `PORT=4750`, `HOST=127.0.0.1`, `TV_SITE_DIR=tv-build`, `TV_WORLD_FEED=wss://rs-sdk-demo.fly.dev/worldfeed`; `TV_GAME_SERVER` overrides the cache source at build time. `TV_HISCORES_ORIGIN` overrides the public hiscores host. `TV_CHAT_DB` sets the local SQLite chat path (default `data/tv-chat.sqlite`); `TV_TRUST_PROXY=1` is used behind Caddy for chat IP limits. No account credentials are needed. Serve COOP/COEP headers for shared memory; the TV server already supplies them.

## Relay and recovery

`app/tv-server.ts` is an independent Bun service. Nearby cameras share a 384-tile region feed. Up to 20 regions plus three scouts keep upstream usage below the game's 32-spectator cap. Idle regions close after 15 seconds; unused regions can be reclaimed immediately. New viewers receive complete entity snapshots before deltas. Historical chat, hitsplats and transient animations are excluded from snapshots. Slow viewers reconnect for a fresh snapshot instead of losing deltas. Upstreams reconnect with backoff, and stale feeds are closed after 20 seconds. The UI marks a stalled camera reconnecting after 10 seconds.

`GET /health` and `GET /api/tv` report freshness, viewer count, upstream count, the current shot and candidate stories. `/worldfeed` accepts only camera area subscriptions; all other client messages are ignored. It cannot forward game commands. The health endpoint returns `ok:false` if no fresh roster has arrived in 15 seconds.

## AWS deployment

The existing EC2 host `54.164.46.10` serves TV through Caddy, alongside the dashboard. DNS has an A record `live.soko.tools -> 54.164.46.10` under Vercel team `w3gpt`. A separate `rs-tv` container reuses the already-installed dashboard image, limited to 1 CPU and 512 MB, with a read-only filesystem. It does not mount dashboard data or account credentials. Docker restarts it after host/process failure.

```sh
HOST=54.164.46.10 infra/aws/deploy-tv.sh
curl -fsS https://live.soko.tools/health
ssh -i ~/.ssh/rs-dashboard.pem ubuntu@54.164.46.10 'docker logs --tail 50 rs-tv'
```

The script only restarts `rs-tv` and gracefully reloads Caddy. Existing dashboard game clients stay logged in. Caddy config is copied into a temporary path before reload because prior rsync deployments can replace the inode behind its read-only bind mount. Its persistent host config includes both domains.

Use this script for TV updates, rather than rebuilding the shared dashboard container. A future full `deploy.sh` still logs dashboard clients out and needs the normal warning. TV remains a separate service; its static assets and code live under `/opt/rs-dashboard/tv/` and are unaffected by dashboard source syncs.

## Sharing and public data

`tv/index.html` supplies server-rendered Open Graph and Twitter large-image card metadata. `tv/public/og-tv.jpg` is a 1200×630 JPEG composed from a real spectator screenshot; rebuild it with `bun scripts/build-tv-share.ts [screenshot.png]`, then run the regular TV build/deploy. `tv/public/tv-icon.svg` supplies the TV favicon. Ranking shortcuts use the authentic Skills-tab sprite, a coin stack and dragon chainbody from the game cache; refresh them with `bun scripts/sync-tv-icons.ts`. Social crawlers do not need JavaScript to read the card.

`GET /api/rankings?category=overall&online=1` joins cached public tables with the current online roster; `GET /api/player?name=<name>` returns that player's public skills and available published bank/equipment snapshots. The read-only parser validates the known public HTML tables; upstream errors retain an explicitly stale snapshot or return an unavailable error. Profile fetches and category fetches are deduplicated, bounded and cached. GP/hour is intentionally omitted: the public feed has no reliable earnings history, and bank changes include transfers and withdrawals.

`WS /chat` sends recent history and broadcasts anonymous site-chat messages. Nicknames are chosen display names, not authenticated game accounts. Chat uses a separate persistent volume; no game credentials or dashboard data are mounted. Test with `bun run check`; `TV_URL=http://127.0.0.1:4750 bun scripts/e2e-tv-features.ts` verifies the live UI plus local browser chat delivery. On production the same script reads chat without posting test messages.
