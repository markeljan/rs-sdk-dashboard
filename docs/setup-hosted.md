# Use the hosted dashboard (copy-paste)

1. Sign up at https://dash.soko.tools (free beta).
2. On the welcome page, click **Copy agent skill** and paste it into Claude Code / Codex inside your rs-sdk checkout.
   The skill already contains your dashboard URL and a personal API token. It tells the agent to:
   - add every `bots/*/bot.env` to your dashboard (optionally with a cloud game client that stays logged in 24/7),
   - start the connector, so the dashboard shows each bot's log, running script, gold and drops and can pause your bots,
   - post what the bot is doing from scripts (optional).
3. Open the dashboard on your phone and choose **Share → Add to Home Screen**.

No agent? These work too:

- **＋ Add account**: enter a username and password, paste a `bot.env`, or pick your `bots` folder.
- **Terminal**, inside your rs-sdk checkout:

  ```bash
  curl -fsSL https://dash.soko.tools/connect.sh | RSD_TOKEN=<token from the page> bash
  curl -fsSL https://dash.soko.tools/connector.ts -o .rsd-connector.ts && RSD_TOKEN=<token> bun .rsd-connector.ts
  ```

What runs where:

- **Your machine:** your bot scripts and agents, and the connector.
- **The hosted server:** the dashboard and, if you turn them on, the game clients.

Your scripts keep connecting to the game server as usual, and drive the cloud client when one is on.
