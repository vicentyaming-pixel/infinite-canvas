#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"
./scripts/local-rainyun.sh start

printf '\nInfinite Canvas is ready. You can close this terminal window.\n'
