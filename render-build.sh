#!/usr/bin/env bash
set -e
apt-get update && apt-get install -y libvips-dev
npm install --legacy-peer-deps --ignore-scripts
npm rebuild sharp --force
echo "✅ Sharp rebuilt successfully"
