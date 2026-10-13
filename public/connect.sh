#!/usr/bin/env bash
# Adds every bot of an rs-sdk checkout (bots/*/bot.env) to the RS-SDK Dashboard at __DASH__.
# Run it from your rs-sdk directory:
#   curl -fsSL __DASH__/connect.sh | RSD_TOKEN=rsd_... bash
# RSD_TOKEN: dashboard -> Settings -> API tokens.  RUN_CLIENT=1 also lets the dashboard run each game client.
set -euo pipefail
: "${RSD_TOKEN:?set RSD_TOKEN (dashboard: Settings -> API tokens)}"
DASH="${DASH:-__DASH__}"
[ -d bots ] || { echo "Run this inside your rs-sdk checkout (no bots/ directory here)."; exit 1; }
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
value() { grep -E "^(export )?$1=" "$2" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e "s/^[\"']//" -e "s/[\"']\$//"; }
out=$(mktemp)
added=0
for f in bots/*/bot.env; do
  case "$f" in bots/_*) continue ;; esac
  user=$(value BOT_USERNAME "$f"); pass=$(value PASSWORD "$f"); server=$(value SERVER "$f")
  [ -n "$user" ] && [ -n "$pass" ] || continue
  extra=""; [ "${RUN_CLIENT:-}" = 1 ] && extra=',"runClient":true'
  body=$(printf '{"name":"%s","password":"%s","server":"%s"%s}' "$(json_escape "$user")" "$(json_escape "$pass")" "$(json_escape "${server:-rs-sdk-demo.fly.dev}")" "$extra")
  code=$(curl -sS -o "$out" -w '%{http_code}' -X POST "$DASH/api/accounts" -H "Authorization: Bearer $RSD_TOKEN" -H 'content-type: application/json' -d "$body" || echo 000)
  if [ "$code" = 200 ]; then added=$((added + 1)); echo "added $user"; else echo "$user: HTTP $code $(cat "$out")"; fi
done
rm -f "$out"
echo "Done: $added account(s) on $DASH"
