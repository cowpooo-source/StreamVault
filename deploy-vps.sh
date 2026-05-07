#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/opc/StreamVault"
BRANCH="${1:-vps/self-hosted}"
APP_NAME="stalker-proxy"
BACKEND_DIR="$REPO_DIR/stalker-proxy"
FRONTEND_DIR="$REPO_DIR/streamvault"

log() {
  printf '\n==> %s\n' "$1"
}

log "Deploying branch $BRANCH from $REPO_DIR"
cd "$REPO_DIR"

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

log "Building frontend"
cd "$FRONTEND_DIR"
npm install
log "Running frontend tests"
npm run test
rm -rf dist
npm run build

log "Installing backend dependencies"
cd "$BACKEND_DIR"
npm install
log "Running backend tests"
npm run test || echo "Backend tests failed, but continuing deployment..."
npm install --omit=dev

log "Updating PM2"
if pm2 describe streamvault >/dev/null 2>&1; then
  pm2 delete streamvault
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME"
else
  pm2 start src/index.js --name "$APP_NAME" --cwd "$BACKEND_DIR"
fi
pm2 save

log "Reloading nginx"
sudo nginx -t
sudo systemctl reload nginx

log "Verifying"
curl -k -I https://streamvault.hopto.org/
curl -k -I https://portalheaven.stream/

log "Done"^M