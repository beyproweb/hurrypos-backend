#!/usr/bin/env bash
# sudo bash install_beypro_bridge.sh

set -euo pipefail
BRIDGE_URL="https://pos.beypro.com/bridge/beypro-bridge-linux-x64-v1.0.5.tar.gz"
INSTALL_DIR="/opt/beypro-bridge"
SERVICE="/etc/systemd/system/beypro-bridge.service"
PORT=7777

echo "[INFO] Installing deps (libusb)…"
if command -v apt-get >/dev/null; then
  apt-get update && apt-get install -y libusb-1.0-0
elif command -v yum >/dev/null; then
  yum install -y libusbx || yum install -y libusb
fi

echo "[INFO] Downloading Bridge…"
mkdir -p "$INSTALL_DIR"
curl -L "$BRIDGE_URL" | tar -xz -C "$INSTALL_DIR"

EXE="$(find "$INSTALL_DIR" -type f -name bridge -perm -111 | head -n1)"
if [[ -z "$EXE" ]]; then
  echo "[ERR] 'bridge' executable not found in $INSTALL_DIR"; exit 1
fi

echo "[INFO] Writing systemd service"
cat > "$SERVICE" <<EOF
[Unit]
Description=Beypro Bridge (USB Thermal Printer)
After=network.target

[Service]
Type=simple
ExecStart=$EXE
Restart=always
Environment=PORT=$PORT
WorkingDirectory=$INSTALL_DIR
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable beypro-bridge.service
systemctl restart beypro-bridge.service

echo "[OK] Bridge running. Check: curl http://127.0.0.1:$PORT/status || curl http://127.0.0.1:$PORT/printers"
