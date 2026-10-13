# Responsive layouts

Dashboard source lives in rs-sdk. Sync it with `bun scripts/sync-from-rs-sdk.ts ../rs-sdk` after committing there.

Run `bun run check` and `bun test tools/dashboard` before pushing. `app/pages-layout.test.ts` renders the actual
landing, login and account-management pages against synthetic, read-only APIs at 320, 375, 390, 430, 768, 844
and 1440 px widths. It checks page overflow and account action buttons, including long hostnames.
`tools/dashboard/layout.test.ts` covers the shared dashboard's account bar, long activity logs and goals,
Settings, Bot HQ, desktop, regular/fullscreen API and dynamic fullscreen, viewport height changes and PWA
safe areas. Tests use Chromium emulation; physical iOS/Android behavior still needs a device check.

Phone account cards use two lines and preserve their height. Long status counters are available in **Full activity**
while the orange headline stays at two lines. Log output and Bot HQ rows have their own scroll areas.
Settings and account management wrap their controls on narrow screens. Landscape fullscreen keeps controls
clear of display cutouts; a fullscreen account row appears only when space is available above the arrows.

For changes confined to `tools/dashboard/public/` and `app/pages/`, deploy those static directories into the
running container and its `/opt/rs-dashboard/src` checkout. Both servers read these files from disk, so no
process restart or game-client logout is needed. Other dashboard changes use `infra/aws/hot-deploy.sh`.
