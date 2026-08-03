#!/usr/bin/env bash
# Regenerate the Tower diagrams from their D2 sources.
# Renders every *.d2 here to a same-named .svg and .png at full resolution.
# Dark theme is baked in.
# Usage:  ./render.sh
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v d2 >/dev/null 2>&1; then
  echo "error: d2 is not on PATH (install: brew install d2)" >&2
  exit 1
fi
for src in *.d2; do
  case "$src" in _*) continue ;; esac
  base="${src%.d2}"
  echo "rendering ${src} -> ${base}.svg, ${base}.png"
  d2 "${src}" "${base}.svg"
  d2 "${src}" "${base}.png"
done
echo "done."
