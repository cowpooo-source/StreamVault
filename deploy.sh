#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:?Usage: ./deploy.sh <domain>}"
INSTALL_DIR="/opt/streamvault"
NODE_PORT=3001

echo "=== StreamVault VPS Deploy ==="
echo "Domain: $DOMAIN"

# Detect OS
if command -v dnf &>/dev/null; then
  PKG="dnf"
elif command -v yum &>/dev/null; then
  PKG="yum"
elif command -v apt-get &>/dev/null; then
  PKG="apt-get"
  sudo apt-get update
else
  echo "Unsupported OS"; exit 1
fi

# Install system packages
echo "Installing packages..."
if [ "$PKG" = "apt-get" ]; then
  sudo apt-get install -y curl git nginx certbot python3-certbot-nginx
  # Node.js 20
  if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
else
  # RHEL/CentOS/Oracle Linux
  sudo $PKG install -y epel-release || true
  sudo $PKG install -y curl git nginx certbot python3-certbot-nginx
  if ! command -v node &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo $PKG install -y nodejs
  fi
fi

# PM2
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
fi

echo "Node $(node -v) | npm $(npm -v) | PM2 $(pm2 -v)"

# Clone or update repo
if [ ! -d "$INSTALL_DIR" ]; then
  sudo git clone https://github.com/cowpooo-source/StreamVault.git "$INSTALL_DIR"
  sudo chown -R "$USER:$USER" "$INSTALL_DIR"
else
  cd "$INSTALL_DIR" && git pull
fi

# Build frontend
cd "$INSTALL_DIR/streamvault"
npm install
# Clean old dist to avoid conflicts
rm -rf dist
VITE_API_URL="" npm run build

# Install backend deps
cd "$INSTALL_DIR/stalker-proxy"
npm install --production

# Preserve existing secrets on redeploy; allow explicit overrides via env vars.
TMP_ENV="$(mktemp)"
PRESERVE_PATTERN='^(PORT|ALLOWED_ORIGIN)='
if [ -n "${TMDB_API_KEY:-}" ]; then
  PRESERVE_PATTERN='^(PORT|ALLOWED_ORIGIN|TMDB_API_KEY)='
fi
{
  printf 'PORT=%s\n' "$NODE_PORT"
  printf 'ALLOWED_ORIGIN=%s\n' "${ALLOWED_ORIGIN:-*}"
  if [ -n "${TMDB_API_KEY:-}" ]; then
    printf 'TMDB_API_KEY=%s\n' "$TMDB_API_KEY"
  fi
  if [ -f .env ]; then
    grep -Ev "$PRESERVE_PATTERN" .env || true
  fi
} > "$TMP_ENV"
mv "$TMP_ENV" .env

# Nginx config
sudo tee /etc/nginx/conf.d/streamvault.conf > /dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    root $INSTALL_DIR/streamvault/dist;
    index index.html;

    location ~ ^/(stalker|stream|proxy|health|api|img|analytics) {
        proxy_pass http://127.0.0.1:$NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Prevent MIME type errors by returning 404 for missing assets instead of index.html
    location ~* \.(?:js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|otf|map)$ {
        expires 1y;
        access_log off;
        add_header Cache-Control "public";
        try_files \$uri =404;
    }
}
NGINX

# Remove default configs that conflict
sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
sudo nginx -t && sudo systemctl enable nginx && sudo systemctl restart nginx

# SSL
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect

# Start backend with PM2
cd "$INSTALL_DIR/stalker-proxy"
pm2 delete streamvault 2>/dev/null || true
pm2 start src/index.js --name streamvault
pm2 save

# Auto-start on boot
pm2 startup systemd -u "$USER" --hp "$HOME" 2>&1 | grep "sudo" | bash || true

# Open firewall (if firewalld is active)
if command -v firewall-cmd &>/dev/null && systemctl is-active firewalld &>/dev/null; then
  sudo firewall-cmd --permanent --add-port=80/tcp
  sudo firewall-cmd --permanent --add-port=443/tcp
  sudo firewall-cmd --reload
fi

echo ""
echo "=== StreamVault is live at https://$DOMAIN ==="
echo "Update: cd $INSTALL_DIR && git pull && cd streamvault && npm run build && pm2 restart streamvault"
echo "Logs:   pm2 logs streamvault"
