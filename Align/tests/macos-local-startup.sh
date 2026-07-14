#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for launcher in "$ROOT/packaging/brainana-align-launcher" "$ROOT/packaging/templates/brainana-align-launcher.in"; do
  /bin/bash -n "$launcher"
  block="$(sed -n '/if \[\[ "$MODE_PICK" == "Local files on this Mac" \]\]; then/,/^else$/p' "$launcher")"
  grep -F 'ROOT="$HOME"' <<<"$block" >/dev/null
  if grep -F 'choose_folder' <<<"$block" >/dev/null; then
    echo "Local startup still invokes choose_folder in $launcher" >&2
    exit 1
  fi
done
echo "macOS local startup regression test passed"
