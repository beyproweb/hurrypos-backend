#!/usr/bin/env bash
# chmod +x install_beypro_bridge.command ; ./install_beypro_bridge.command

set -euo pipefail
BRIDGE_URL="https://pos.beypro.com/bridge/beypro-bridge-mac-universal-v1.0.5.tar.gz"
APPDIR="/Applications/BeyproBridge"
TMP="$(mktemp -d)"
PLIST="$HOME/Library/LaunchAgents/com.beypro.bridge.plist"
PORT=7777

echo "[INFO] Downloading Bridge…"
curl -L "$BRIDGE_URL" -o "$TMP/bridge.tgz"

echo "[INFO] Installing to $APPDIR"
sudo mkdir -p "$APPDIR"
sudo tar -xzf "$TMP/bridge.tgz" -C "$APPDIR"
rm -rf "$TMP"

# Find executable (bridge)
EXE="$(/usr/bin/find "$APPDIR" -type f -perm +111 -name bridge -maxdepth 2 2>/dev/null | head -n1)"
if [[ -z "$EXE" ]]; then
  echo "[ERR] 'bridge' executable not found in $APPDIR"; exit 1
fi
sudo xattr -dr com.apple.quarantine "$APPDIR" || true

echo "[INFO] Writing LaunchAgent: $PLIST"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" \
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.beypro.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$EXE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/beypro-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/beypro-bridge.err</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string></dict>
</dict></plist>
EOF

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
echo "[OK] Bridge loaded. Listening on http://127.0.0.1:$PORT"
