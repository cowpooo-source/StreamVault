#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/opc/StreamVault-Feature"
BRANCH="${1:-feature/direct-play-no-proxy}"
APP_NAME="stalker-proxy-http-sandbox"
BACKEND_DIR="$REPO_DIR/stalker-proxy"
FRONTEND_DIR="$REPO_DIR/streamvault"
PORT="${PORT:-3101}"

log() { printf '\n==> %s\n' "$1"; }

log "Deploying HTTP sandbox branch $BRANCH from $REPO_DIR"
cd "$REPO_DIR"

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

log "Building frontend"
cd "$FRONTEND_DIR"
npm ci
rm -rf dist
npm run build

log "Installing backend dependencies"
cd "$BACKEND_DIR"
npm install
npm install --omit=dev

log "Starting/restarting PM2 sandbox app"
PORT="$PORT" pm2 startOrRestart ecosystem.sandbox.config.cjs --only "$APP_NAME"
pm2 save

log "Sandbox health check"
curl -sf "http://127.0.0.1:${PORT}/health" || echo "Warning: health check failed"

log "Setup nginx config for HTTP sandbox"
sudo cp "$REPO_DIR/nginx_vps_http_sandbox.conf" /etc/nginx/conf.d/sandbox.portalheaven.stream.conf
sudo systemctl reload nginx

log "HTTP sandbox deploy done — http://sandbox.portalheaven.stream"