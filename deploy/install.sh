#!/usr/bin/env bash
# Provision a new host for MaxGreen Agent.
#
# Review before running: this rewrites the nginx site and the systemd unit, and reloads nginx.
# It does NOT issue a TLS certificate (see deploy/README.md for that step) and it does NOT touch
# .env, backend/secrets/, or the SQLite database.
#
# Usage: sudo bash deploy/install.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
NGINX_SITE="/etc/nginx/sites-available/maxgreen"
NGINX_LINK="/etc/nginx/sites-enabled/maxgreen"
NGINX_AUTH_DIR="/etc/nginx/auth"
NGINX_AUTH_FILE="$NGINX_AUTH_DIR/maxgreen.htpasswd"
SYSTEMD_UNIT="/etc/systemd/system/maxgreen-backend.service"
SERVICE_USER="ubuntu"
VENV="$REPO_ROOT/backend/.venv"

log() { printf '\n==> %s\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
  echo "error: run as root (sudo bash $0)" >&2
  exit 1
fi

if [[ ! -d "$REPO_ROOT/backend" ]]; then
  echo "error: cannot find backend/ next to deploy/ — run this from a clone of the repo" >&2
  exit 1
fi

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx python3-venv python3-pip certbot

log "Creating the Python venv and installing backend requirements"
if [[ ! -x "$VENV/bin/python" ]]; then
  sudo -u "$SERVICE_USER" python3 -m venv "$VENV"
fi
sudo -u "$SERVICE_USER" "$VENV/bin/python" -m pip install --quiet --upgrade pip
sudo -u "$SERVICE_USER" "$VENV/bin/python" -m pip install --quiet -r "$REPO_ROOT/backend/requirements.txt"

log "Creating the HTTP Basic auth file"
install -d -m 750 -o root -g www-data "$NGINX_AUTH_DIR"
if [[ -f "$NGINX_AUTH_FILE" ]]; then
  echo "    $NGINX_AUTH_FILE already exists — leaving it alone"
  echo "    to add a user: sudo htpasswd -B $NGINX_AUTH_FILE <username>"
else
  read -rp "    Basic-auth username to create: " AUTH_USER
  htpasswd -B -c "$NGINX_AUTH_FILE" "$AUTH_USER"
  chown root:www-data "$NGINX_AUTH_FILE"
  chmod 640 "$NGINX_AUTH_FILE"
fi

log "Installing the nginx site"
if [[ -e "$NGINX_LINK" && ! -L "$NGINX_LINK" ]]; then
  echo "error: $NGINX_LINK exists and is not a symlink — move it aside first" >&2
  exit 1
fi
if [[ -f "$NGINX_SITE" ]]; then
  cp -a "$NGINX_SITE" "$NGINX_SITE.bak.$(date +%Y%m%d%H%M%S)"
fi
install -m 644 -o root -g root "$DEPLOY_DIR/nginx-maxgreen.conf" "$NGINX_SITE"
ln -sfn "$NGINX_SITE" "$NGINX_LINK"

log "Installing the systemd unit"
if [[ -f "$SYSTEMD_UNIT" ]]; then
  cp -a "$SYSTEMD_UNIT" "$SYSTEMD_UNIT.bak.$(date +%Y%m%d%H%M%S)"
fi
install -m 644 -o root -g root "$DEPLOY_DIR/maxgreen-backend.service" "$SYSTEMD_UNIT"
systemctl daemon-reload
systemctl enable --now maxgreen-backend.service

log "Validating and reloading nginx"
if ! nginx -t; then
  echo "error: nginx config test failed — not reloading. Fix the errors above, then:" >&2
  echo "       sudo cp $NGINX_SITE.bak.* $NGINX_SITE && sudo nginx -t && sudo systemctl reload nginx" >&2
  exit 1
fi
systemctl reload nginx

log "Done"
cat <<EOF
Next steps:
  1. Issue TLS (needs the hostname to resolve already):
       sudo certbot certonly --webroot -w /var/www/certbot -d 54-179-55-232.sslip.io
       sudo systemctl enable --now certbot.timer
  2. Fill in $REPO_ROOT/.env from .env.example (LLM gateway + Gmail settings).
  3. Place backend/secrets/credentials.json, then run: python gmail_auth.py
  4. Confirm the backend is loopback-only:
       ss -ltnp | grep 8000     # must read 127.0.0.1:8000, never 0.0.0.0:8000
  5. Check the service: systemctl status maxgreen-backend.service
EOF
