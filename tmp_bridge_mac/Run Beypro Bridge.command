

cd "$(dirname "$0")"
chmod +x local-print-bridge
xattr -d com.apple.quarantine local-print-bridge 2>/dev/null || true
./local-print-bridge
