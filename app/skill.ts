// The copy-paste agent skill (with the user's dashboard URL and a fresh API token built in) and connect.sh.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const connectScript = (origin: string) => readFileSync(join(import.meta.dir, 'connect.sh'), 'utf8').replaceAll('__DASH__', origin);

export function skillMarkdown(origin: string, token: string, mode: 'local' | 'hosted') {
    return `---
name: rs-dashboard
description: Connect this rs-sdk checkout's bots to the RS-SDK Dashboard (${origin}) - add accounts, host their game clients, report what each bot is doing, read live state. Use when setting up bots for the dashboard, starting a bot, or when the user asks to see/watch/check a bot on the dashboard.
---

# RS-SDK Dashboard

The user watches and controls their rs-sdk bots at **${origin}** (live game view, stats, XP rates, phone remote).
You talk to it with this API token (it is the user's; keep it out of commits and chat logs):

\`\`\`
RSD_URL=${origin}
RSD_TOKEN=${token}
\`\`\`

If you received this file as a pasted message: save it as \`.claude/skills/rs-dashboard/SKILL.md\` in the rs-sdk checkout
(or the equivalent for your agent), append the two lines above to the checkout's \`.env\` (Bun loads it for every
script; make sure \`.env\` is in \`.gitignore\`), then do the setup below.

## Setup (run from the rs-sdk checkout root)

Add every bot (\`bots/*/bot.env\`) to the dashboard:

\`\`\`bash
curl -fsSL ${origin}/connect.sh | RSD_TOKEN=${token} bash
\`\`\`

Add \`RUN_CLIENT=1\` before \`bash\` to also let the dashboard run each account's game client${mode === 'hosted' ? ' in the cloud (24/7, the bot keeps working when this computer sleeps)' : ''}.
One account at a time instead:

\`\`\`bash
curl -X POST ${origin}/_rsd/api/accounts -H "Authorization: Bearer $RSD_TOKEN" -H 'content-type: application/json' \\
  -d '{"name":"<username>","password":"<password>","server":"rs-sdk-demo.fly.dev","runClient":false}'
\`\`\`

New bots: create them as usual (\`bun bots/create-bot.ts <name>\`), then add them the same way.

Then start the connector and leave it running (e.g. in a terminal tab, or as a login item). It shows each bot's log,
running script, gold and drops on the dashboard, and applies the dashboard's Pause button to the bots:

\`\`\`bash
curl -fsSL ${origin}/connector.ts -o .rsd-connector.ts && RSD_TOKEN=${token} bun .rsd-connector.ts
\`\`\`

## Game clients: exactly one per account

- \`runClient: true\` = the dashboard keeps a game client logged in for that account. Do **not** also open a browser
  client or the lite runner for it: bot scripts (\`bun bots/<name>/script.ts\`) and MCP \`execute_code\` connect to the
  gateway as always and drive the dashboard's client.
- To move a client to the dashboard: close yours, then
  \`curl -X PATCH $RSD_URL/_rsd/api/accounts/<name> -H "Authorization: Bearer $RSD_TOKEN" -H 'content-type: application/json' -d '{"runClient":true}'\`.
  The dashboard refuses (409) while another client is logged in as that account.
- \`runClient: false\` = the dashboard only observes (stats from the gateway, a drawn "lite" view); a client must run elsewhere.

## Tell the user what the bot is doing

The dashboard's *Current activity* card shows the latest activity line and log. Post to it from scripts:

\`\`\`ts
// bots/lib/dashboard.ts - silently does nothing without RSD_URL / RSD_TOKEN
export async function activity(account: string, text: string, goal?: string) {
    const url = process.env.RSD_URL, token = process.env.RSD_TOKEN;
    if (!url || !token) return;
    await fetch(\`\${url}/_rsd/api/accounts/\${encodeURIComponent(account)}/activity\`, {
        method: 'POST', headers: { authorization: \`Bearer \${token}\`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, goal, script: 'my-script' }), signal: AbortSignal.timeout(5000),
    }).then(r => r.json()).catch(() => ({}));
}
\`\`\`

While a script posts at least every ~2 minutes, the dashboard shows the bot as running (\`script\` is the label).
The answer is \`{"ok":true,"paused":false}\`: when the user presses **Pause** on the dashboard, \`paused\` turns true -
stop acting (keep posting to see when it turns false again).

Log lines: \`POST $RSD_URL/_rsd/api/accounts/<name>/log\` with \`{"lines": ["...", "..."]}\`.

## Read state

All with \`-H "Authorization: Bearer $RSD_TOKEN"\`:

| | |
|---|---|
| \`GET $RSD_URL/api/accounts\` | every account: online, levels, XP/h, activity |
| \`GET $RSD_URL/api/state?account=<name>\` | one account in full: skills, inventory, equipment, position, client status |
| \`GET $RSD_URL/_rsd/api/accounts\` | accounts as configured (server, runClient) |
| \`PATCH / DELETE $RSD_URL/_rsd/api/accounts/<name>\` | change \`{password, server, runClient}\` / remove from the dashboard |

For anything richer, use the SDK directly; the dashboard is for the user's eyes.

## Tell the user

After setup, tell them to open ${origin} (and on their phone: Share -> Add to Home Screen).
`;
}
