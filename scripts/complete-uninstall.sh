#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "This script will stop EktosWhispr, remove the installed app, and delete caches, databases, and preferences."
read -r -p "Continue with the full uninstall? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

remove_target() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "Removing $target"
    rm -rf "$target" 2>/dev/null || sudo rm -rf "$target"
  fi
}

echo "Stopping running EktosWhispr/Electron processes..."
pkill -f "EktosWhispr" 2>/dev/null || true
pkill -f "ektos-whispr" 2>/dev/null || true
pkill -f "Electron Helper.*EktosWhispr" 2>/dev/null || true

echo "Removing /Applications/EktosWhispr.app (requires admin)..."
remove_target "/Applications/EktosWhispr.app"

echo "Purging Application Support data..."
remove_target "$HOME/Library/Application Support/EktosWhispr"
remove_target "$HOME/Library/Application Support/ektos-whispr"
remove_target "$HOME/Library/Application Support/EktosWhispr-dev"
remove_target "$HOME/Library/Application Support/com.ektoswhispr"
remove_target "$HOME/Library/Application Support/com.ektoswhispr.EktosWhispr"

echo "Removing caches, logs, and saved state..."
remove_target "$HOME/Library/Caches/ektos-whispr"
remove_target "$HOME/Library/Caches/com.ektoswhispr.EktosWhispr"
remove_target "$HOME/Library/Preferences/com.ektoswhispr.EktosWhispr.plist"
remove_target "$HOME/Library/Preferences/com.ektoswhispr.helper.plist"
remove_target "$HOME/Library/Logs/EktosWhispr"
remove_target "$HOME/Library/Saved Application State/com.ektoswhispr.EktosWhispr.savedState"

echo "Cleaning temporary files..."
shopt -s nullglob
for tmp in /tmp/ektoswhispr*; do
  remove_target "$tmp"
done
for crash in "$HOME/Library/Application Support/CrashReporter"/EktosWhispr_*; do
  remove_target "$crash"
done
shopt -u nullglob

read -r -p "Remove downloaded Whisper models and caches (~/.cache/whisper, ~/Library/Application Support/whisper)? [y/N]: " wipe_models
if [[ "$wipe_models" =~ ^[Yy]$ ]]; then
  remove_target "$HOME/.cache/whisper"
  remove_target "$HOME/Library/Application Support/whisper"
  remove_target "$HOME/Library/Application Support/EktosWhispr/models"
fi

ENV_FILE="$PROJECT_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  read -r -p "Remove the local environment file at $ENV_FILE? [y/N]: " wipe_env
  if [[ "$wipe_env" =~ ^[Yy]$ ]]; then
    echo "Removing $ENV_FILE"
    rm -f "$ENV_FILE"
  fi
fi

cat <<'EOF'
macOS keeps microphone, screen recording, and accessibility approvals even after files are removed.
Reset them if you want a truly fresh start:
  tccutil reset Microphone com.ektoswhispr.app
  tccutil reset Accessibility com.ektoswhispr.app
  tccutil reset ScreenCapture com.ektoswhispr.app

Full uninstall complete. Reboot if you removed permissions, then reinstall or run npm scripts on a clean tree.
EOF
