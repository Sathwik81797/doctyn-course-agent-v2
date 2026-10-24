#!/usr/bin/env bash
# Start the Windows render engine (keeps running until Ctrl+C). Run from Git Bash.
cd "$(dirname "$0")/.." || exit 1
exec npm run engine
