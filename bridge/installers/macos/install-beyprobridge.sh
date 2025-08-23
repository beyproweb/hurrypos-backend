#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$HOME/Applications/BeyproBridge"
BIN_SRC="dist/beypro-bridge-macos-x64"
TARGET_BIN="$APP_DIR/beypro-bridge"
PLIST="$HOME/Library/LaunchAgents/com.beypro.bridge.plist"
echo "Installing Beypro Bridge (macOS per-user)..."
mkdir -p "$APP_DIR"
if [ ! -f "$BIN_SRC" ]; then
  echo "ERROR: $BIN_SRC not found. Run npm run build:mac first."; exit 1
fi
cp -f "$BIN_SRC" "$TARGET_BIN"
chmod +x "$TARGET_BIN"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.beypro.bridge</string>
  <key>ProgramArguments</key><array><string>$TARGET_BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/beypro-bridge.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/beypro-bridge.err.log</string>
</dict></plist>
PLIST
launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load -w "$PLIST"
echo "✅ Installed to $TARGET_BIN"
echo "✅ Auto-start enabled (launchd)."
