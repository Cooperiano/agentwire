#!/usr/bin/env bash
# Container entrypoint: patch config → start dispatcher (+billing) → start OpenClaw gateway
set -euo pipefail

CFG="$HOME/.openclaw/openclaw.json"

if [ ! -f "$CFG" ]; then
  echo "ERROR: $CFG not found. Run ./seed.sh on the host first to populate ./data/.openclaw." >&2
  exit 1
fi

# ── config patches ────────────────────────────────────────────────────────

# Rewrite host paths → container paths; force noSandbox + explicit Chromium; bind to 0.0.0.0
sed -i 's|/home/julian/.openclaw|/root/.openclaw|g' "$CFG"

JQ_FILTER='.agents.defaults.model.primary="deepseek/deepseek-v4-pro"
  | .agents.defaults.model.fallbacks=["deepseek/deepseek-v4-flash"]
  | .agents.defaults.workspace="/root/.openclaw/workspace"
  | .browser.noSandbox=true
  | .browser.executablePath="/usr/bin/chromium"
  | .gateway.bind="custom"
  | .gateway.customBindHost="0.0.0.0"
  | .gateway.tailscale.mode="off"
  | (.agents.list[]?.model) |= sub("opencode-go/"; "deepseek/")'

JQ_ARGS=()
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  JQ_FILTER="$JQ_FILTER | .models.providers.deepseek.apiKey=\$k"
  JQ_ARGS=(--arg k "$DEEPSEEK_API_KEY")
fi

jq "${JQ_ARGS[@]}" "$JQ_FILTER" "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"

echo "[entrypoint] primary model : $(jq -r '.agents.defaults.model.primary' "$CFG")"
echo "[entrypoint] deepseek base : $(jq -r '.models.providers.deepseek.baseUrl' "$CFG")"

# ── start dispatcher + billing (background) ──────────────────────────────
# The dispatcher self-initializes billing.json (admin_key + customers + ledger)
# on first run and prints the ADMIN KEY banner.
echo "[entrypoint] starting dispatcher on :8080 ..."
node /app/dispatcher/server.mjs &
echo "[entrypoint] dispatcher pid: $!"

# ── start gateway (foreground, replaces this process) ─────────────────────
echo "[entrypoint] launching gateway :18789 ..."
exec openclaw gateway --port 18789
