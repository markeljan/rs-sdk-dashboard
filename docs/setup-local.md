# Set up the dashboard on your own machine (copy-paste prompt)

Paste this into Claude Code, Codex or any coding agent. Run the agent from the folder that contains your rs-sdk checkout, or tell it where the checkout is.

```text
Set up the RS-SDK Dashboard (https://github.com/markeljan/rs-sdk-dashboard) locally for my rs-sdk bots:

1. Make sure Bun is installed (curl -fsSL https://bun.sh/install | bash).
2. Find my rs-sdk checkout (the folder with bots/<name>/bot.env). If there isn't one, clone
   https://github.com/MaxBittker/rs-sdk.git, run bun install, and create a bot with
   bun bots/create-bot.ts <name> (alphanumeric, at most 12 characters).
3. Clone https://github.com/markeljan/rs-sdk-dashboard.git next to it and run bun install in it.
   This also downloads the Chrome it uses for game clients.
4. Start it so that it keeps running (a terminal tab, tmux, or a login item), pointing at the checkout:
   RS_SDK_DIR=<path to rs-sdk> bun start
   Check that http://localhost:4747/_rsd/health answers {"ok":true,...}. Every bots/<name>/bot.env shows up
   on its own, with its log, current script and pause button.
   If other people can reach this machine, also set RSD_PASSWORD=<something>.
5. Game clients: only one client can be logged in per account. For accounts that have no client running
   anywhere else, let the dashboard run it:
   curl -X PATCH http://localhost:4747/_rsd/api/accounts/<name> -H 'content-type: application/json' -d '{"runClient":true}'
   Then wait until curl http://localhost:4747/api/state?account=<name> shows conn.inGame true.
   New characters start on Tutorial Island: run await bot.skipTutorial() once with a small runScript
   script in bots/<name>/.
6. Tell me the URL for this computer and the "Phone (same Wi-Fi)" URL it printed.
```

What you get: the full dashboard (live game view, phone remote, Bot HQ map, XP/gold tracking, drop alerts) for every bot in your checkout. Nothing leaves your machine except the game connection itself.
