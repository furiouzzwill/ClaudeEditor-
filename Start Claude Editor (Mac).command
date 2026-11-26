#!/bin/bash
# Double-click to start Claude Editor on a Mac.
cd "$(dirname "$0")" || exit 1

# Homebrew installs land here; Finder-launched scripts don't always see them.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Install it from https://nodejs.org (the \"LTS\" button), then double-click this again."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo
  echo "  FFmpeg is not installed."
  echo "  1. Install Homebrew from https://brew.sh"
  echo "  2. In Terminal run:  brew install ffmpeg"
  echo "  Then double-click this again."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing for the first time, this takes a minute..."
  npm install --omit=dev || { read -r -p "Install failed. Press Enter to close..."; exit 1; }
fi

echo
echo "  Claude Editor is starting. Your browser will open in a moment."
echo "  Keep this window open while you edit. Close it to quit."
echo
(sleep 3 && open "http://localhost:5317") &
node server/index.js
