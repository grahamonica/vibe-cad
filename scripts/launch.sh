#!/bin/sh
set -eu
vibe_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
vibe_node=""
# Prefer the host's bundled runtime. No separate Node install is required.
for vibe_candidate in "${CODEX_MCP_NODE_PATH:-}" "${CODEX_MANAGED_PACKAGE_ROOT:-}/dependencies/node/bin/node" "${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
  if [ -n "$vibe_candidate" ] && [ -x "$vibe_candidate" ]; then
    vibe_node="$vibe_candidate"
    break
  fi
done
if [ -z "$vibe_node" ]; then
  vibe_node=$(command -v node || true)
fi
if [ -z "$vibe_node" ]; then
  printf '%s\n' 'Vibe CAD could not locate the plugin host Node runtime.' >&2
  exit 1
fi
export VIBE_CAD_ROOT="$vibe_root"
if [ ! -f "$vibe_root/dist/runtime/stdio.mjs" ] || [ ! -f "$vibe_root/dist/editor/index.html" ]; then
  printf '%s\n' 'Vibe CAD is missing its bundled tools. Rebuild or reinstall the plugin.' >&2
  exit 1
fi
exec "$vibe_node" "$vibe_root/dist/runtime/stdio.mjs"
