#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${STREAMVAULT_REPO_DIR:-}"
BRANCH="${1:-vps/self-hosted}"
APP_NAME="stalker-proxy"

log() {
  printf '\n==> %s\n' "$1"
}

assert_clean_checkout() {
  local dirty
  dirty="$(git status --porcelain --untracked-files=all)"
  if [[ -n "$dirty" ]]; then
    echo "Deployment requires a clean Git worktree. Commit or remove these changes first:" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi
}

if [[ -z "$REPO_DIR" ]]; then
  for candidate in /opt/streamvault /home/opc/StreamVault; do
    if [[ -d "$candidate/.git" ]]; then
      REPO_DIR="$candidate"
      break
    fi
  done
fi

if [[ -z "$REPO_DIR" ]]; then
  echo "Could not find the production checkout." >&2
  echo "Set STREAMVAULT_REPO_DIR or clone the repo into /opt/streamvault." >&2
  exit 1
fi

BACKEND_DIR="$REPO_DIR/stalker-proxy"
FRONTEND_DIR="$REPO_DIR/streamvault"

log "Deploying branch $BRANCH from $REPO_DIR"
cd "$REPO_DIR"

git fetch origin "$BRANCH"
assert_clean_checkout
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
assert_clean_checkout

RELEASE_COMMIT="$(git rev-parse HEAD)"
export RELEASE_COMMIT
export VITE_RELEASE_COMMIT="$RELEASE_COMMIT"
if [[ -z "${VITE_STALKER_LAZY_CATALOG_ENABLED:-}" ]]; then
  case "$BRANCH" in
    vps/http-static) export VITE_STALKER_LAZY_CATALOG_ENABLED="true" ;;
    *) export VITE_STALKER_LAZY_CATALOG_ENABLED="false" ;;
  esac
fi
if [[ -z "${STALKER_LAZY_CATALOG_ENABLED:-}" ]]; then
  case "$BRANCH" in
    vps/http-static) export STALKER_LAZY_CATALOG_ENABLED="true" ;;
    *) export STALKER_LAZY_CATALOG_ENABLED="false" ;;
  esac
fi

log "Building frontend"
cd "$FRONTEND_DIR"
npm install
log "Running frontend tests"
npm run test
rm -rf dist
npm run build
if [[ ! -s "$FRONTEND_DIR/dist/release.json" ]]; then
  echo "Frontend release metadata was not emitted." >&2
  exit 1
fi
FRONTEND_RELEASE_COMMIT="$(node --input-type=commonjs -e "process.stdout.write(require('./dist/release.json').commit || '')")"
if [[ "$FRONTEND_RELEASE_COMMIT" != "$RELEASE_COMMIT" ]]; then
  echo "Frontend release $FRONTEND_RELEASE_COMMIT does not match backend release $RELEASE_COMMIT." >&2
  exit 1
fi

log "Installing backend dependencies"
cd "$BACKEND_DIR"
npm install
log "Running backend tests"
npm run test
npm install --omit=dev

log "Updating PM2"
if pm2 describe streamvault >/dev/null 2>&1; then
  pm2 delete streamvault
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
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
