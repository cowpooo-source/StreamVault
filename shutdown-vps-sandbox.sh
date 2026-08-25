#!/usr/bin/env bash
set -euo pipefail

APP_NAME="stalker-proxy-sandbox"
PORT="${PORT:-3101}"

log() {
  printf '\n==> %s\n' "$1"
}

log "Stopping sandbox app"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 delete "$APP_NAME"
  pm2 save
else
  log "Sandbox app is not running"
fi

log "Verifying sandbox shutdown"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "Sandbox PM2 app still exists"
  exit 1
fi

if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Sandbox health endpoint still responds on port ${PORT}"
  exit 1
fi

log "Sandbox stopped"
