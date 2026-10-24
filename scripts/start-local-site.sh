#!/usr/bin/env bash
# Whole platform on this PC for testing (website + database + storage + engine in one process).
cd "$(dirname "$0")/.." || exit 1
echo "Open http://127.0.0.1:8790/"
exec npm run cloud:dev
