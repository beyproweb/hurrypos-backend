#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo:  sudo bash installers/linux/install-beyprobridge.sh"; exit 1
fi
APP_DIR="/opt/beypro-bridge"
BIN_SRC="dist/beypro-bridge-linux-x64"
TARGET_BIN="$APP_DIR/beypro-bridge"
SERVICE="/etc/systemd/system/beypro-bridge.service"
echo "Installing Beypro Bridge (Linux systemd)..."
mkdir -p "$APP_DIR"
if [ ! -f "$BIN_SRC" ]; then echo "ERROR: $BIN_SRC not found. Run npm run build:linux first."; exit 1; fi
cp -f "$BIN_SRC" "$TARGET_BIN"
chmod +x "$TARGET_BIN"
cat > "$SERVICE" <<UNIT
[Unit]
Description=Beypro Bridge (LAN printer helper)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$TARGET_BIN
Restart=always
User=root
WorkingDirectory=$APP_DIR
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable beypro-bridge
systemctl restart beypro-bridge
echo "✅ Installed to $TARGET_BIN"
echo "✅ Service enabled (beypro-bridge)."
