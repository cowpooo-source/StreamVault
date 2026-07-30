#!/usr/bin/env bash
set -euo pipefail
ERROR_401_THRESHOLD=${ERROR_401_THRESHOLD:-5}
ERROR_456_THRESHOLD=${ERROR_456_THRESHOLD:-3}
ERROR_502_THRESHOLD=${ERROR_502_THRESHOLD:-5}

APP_NAME="${APP_NAME:-stalker-proxy-play}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3201/health}"
CPU_THRESHOLD="${CPU_THRESHOLD:-85}"
CPU_CONSECUTIVE="${CPU_CONSECUTIVE:-3}"
ALERT_COOLDOWN_SECONDS="${ALERT_COOLDOWN_SECONDS:-900}"
ALERT_WEBHOOK_FORMAT="${ALERT_WEBHOOK_FORMAT:-auto}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/streamvault-feature-monitor}"
STATE_FILE="$STATE_DIR/state"
mkdir -p "$STATE_DIR"

count=0
last_alert=0
if [[ -f "$STATE_FILE" ]]; then
  read -r count last_alert < "$STATE_FILE" || true
fi

alert() {
  local message="$1"
  local now
  now="$(date +%s)"
  if (( now - last_alert < ALERT_COOLDOWN_SECONDS )); then return; fi
  logger -t streamvault-feature-monitor -- "$message"
  if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
    local payload
    local format="$ALERT_WEBHOOK_FORMAT"
    if [[ "$format" == "auto" && "$ALERT_WEBHOOK_URL" == *discord.com/api/webhooks* ]]; then
      format="discord"
    fi
    if [[ "$format" == "discord" ]]; then
      payload="$(node -e 'process.stdout.write(JSON.stringify({content:process.argv[1]}))' "$message")"
    else
      payload="$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$message")"
    fi
    curl -fsS --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  last_alert="$now"
}

pid="$(pm2 pid "$APP_NAME" 2>/dev/null || true)"
if [[ -z "$pid" || "$pid" == "0" ]]; then
  alert "$APP_NAME is not running"
  printf '0 %s\n' "$last_alert" > "$STATE_FILE"
  exit 1
fi

if ! health="$(curl -fsS --max-time 10 "$HEALTH_URL")"; then
  alert "$APP_NAME health check failed: $HEALTH_URL"
  printf '0 %s\n' "$last_alert" > "$STATE_FILE"
  exit 1
fi

status_count() {
  node -e 'const value=JSON.parse(process.argv[1]);process.stdout.write(String(value.requests?.byStatus?.[process.argv[2]] ?? 0))' $health $1
}
errors_401=$(status_count 401)
errors_456=$(status_count 456)
errors_502=$(status_count 502)
if (( errors_401 >= ERROR_401_THRESHOLD )); then alert repeated_401_$errors_401; fi
if (( errors_456 >= ERROR_456_THRESHOLD )); then alert repeated_provider_456_$errors_456; fi
if (( errors_502 >= ERROR_502_THRESHOLD )); then alert repeated_502_$errors_502; fi
cpu="$(ps -p "$pid" -o pcpu= | xargs)"
rss_kb="$(ps -p "$pid" -o rss= | xargs)"
if awk -v cpu="$cpu" -v threshold="$CPU_THRESHOLD" 'BEGIN { exit !(cpu >= threshold) }'; then
  count=$((count + 1))
else
  count=0
fi

if (( count >= CPU_CONSECUTIVE )); then
  requests="$(node -e 'const value=JSON.parse(process.argv[1]);process.stdout.write(String(value.requests?.requestsLastMinute ?? 0))' "$health")"
  alert "$APP_NAME sustained CPU ${cpu}% for ${count} checks; RSS $((rss_kb / 1024))MB; requests/min $requests"
fi

printf '%s %s\n' "$count" "$last_alert" > "$STATE_FILE"
