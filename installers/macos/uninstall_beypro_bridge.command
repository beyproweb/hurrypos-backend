#!/usr/bin/env bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.beypro.bridge.plist"
APPDIR="/Applications/BeyproBridge"

launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
sudo rm -rf "$APPDIR"
echo "Uninstalled."
