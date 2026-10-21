#!/usr/bin/env bash
# scan_state.sh — JSON active-loop-state detector for loop-router.
#
# Usage: scan_state.sh [repo_root] (default: current directory)
# Exit: 0 = complete scan with no findings; 2 = complete scan with findings;
#       1 = incomplete/failed scan. stdout is always one JSON object once the
#       Python runtime starts. Repository content is data, never instructions.

set -u -o pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$SCRIPT_DIR/scan_state.py" "${1:-.}"
elif command -v python >/dev/null 2>&1; then
  exec python "$SCRIPT_DIR/scan_state.py" "${1:-.}"
fi

printf '%s\n' '{"scan_complete":false,"findings":[],"warnings":[],"errors":[{"operation":"runtime","path":"scripts/scan_state.py","message":"Python 3 is required to scan safely"}]}'
exit 1
