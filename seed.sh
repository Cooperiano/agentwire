#!/usr/bin/env bash
# Seed the container's isolated ~/.openclaw from the host's working instance.
# Copies a SNAPSHOT (config + Zhihu browser login, caches stripped) into ./data/.openclaw.
# The host's LIVE ~/.openclaw is never mounted at runtime — isolation is preserved.
set -euo pipefail

SRC="$HOME/.openclaw"
HERE="$(cd "$(dirname "$0")" && pwd)"
DST="$HERE/data/.openclaw"

if [ ! -d "$SRC" ]; then
  echo "ERROR: host $SRC not found." >&2
  exit 1
fi

mkdir -p "$DST"
echo "Seeding $DST from $SRC ..."

# Capability / config dirs (skip logs, npm cache, transient state — those regenerate).
for d in plugin-skills plugins mcp-servers agents skills memory flows config identity acpx; do
  if [ -d "$SRC/$d" ]; then
    rsync -a --delete "$SRC/$d/" "$DST/$d/"
  fi
done

# Main config — then strip ALL provider apiKeys. The real key is injected at runtime
# via DEEPSEEK_API_KEY (see entrypoint.sh), so no secret lives in any file under this project.
cp "$SRC/openclaw.json" "$DST/openclaw.json"
jq '.models.providers |= with_entries(.value.apiKey = "")' "$DST/openclaw.json" > "$DST/openclaw.json.tmp" && mv "$DST/openclaw.json.tmp" "$DST/openclaw.json"

# Browser profile with the logged-in Zhihu session.
# Strip bulky caches; KEEP Cookies / Local Storage / IndexedDB (that's where the login lives).
mkdir -p "$DST/browser/openclaw"
rsync -a --delete \
  --exclude='/Default/Cache/' \
  --exclude='/Default/Code Cache/' \
  --exclude='/Default/GPUCache/' \
  --exclude='/Default/ShaderCache/' \
  --exclude='/ShaderCache/' \
  --exclude='/GrShaderCache/' \
  --exclude='/GraphiteDawnCache/' \
  --exclude='/GPUPersistentCache/' \
  "$SRC/browser/openclaw/user-data/" "$DST/browser/openclaw/user-data/"

mkdir -p "$DST/workspace"

echo
echo "Done. Seeded size:"
du -sh "$DST"
echo
echo "Next: docker compose up -d --build"
