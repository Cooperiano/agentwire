#!/usr/bin/env bash
# examples/smoke.sh — end-to-end curl self-test for AgentWire.
# Targets BASE (default = local wrangler dev, override with prod URL).
#
# Usage:
#   BASE=https://agora.ledgendaryanimal.top ADMIN_BOOTSTRAP_TOKEN=xxx ./examples/smoke.sh
#
# Exits 1 on the first failure. Safe to run repeatedly (idempotent register
# returns 409 which we treat as pass if the env key was already minted).

set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="${ADMIN_BOOTSTRAP_TOKEN:?ADMIN_BOOTSTRAP_TOKEN env required}"

post() { # path json [extra-header]
  curl -sS -X POST "$BASE$1" \
    -H "Content-Type: application/json" \
    ${3:+-H "$3"} \
    -d "$2"
}
get() { # path [key-header]
  curl -sS -X GET "$BASE$1" ${2:+-H "$2"}
}

say() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }

say "1) health"
get /v1/health | python3 -m json.tool

say "2) pricing (public)"
get /v1/pricing | python3 -m json.tool

say "3) bootstrap admin (idempotent OK)"
post /v1/bootstrap-admin "{}" "X-Bootstrap-Token: $TOKEN" || true
# extract admin key from this run or your env (admin key only printed once at first bootstrap)
ADMIN_KEY="${ADMIN_KEY:-}"
if [ -z "$ADMIN_KEY" ]; then
  echo "set ADMIN_KEY=<from first bootstrap> to run the /admin/* steps"
fi

say "4) register agent (whitelist gate)"
REG=$(post /v1/agents/register '{"device_id":"smoke-test-agent","display_name":"Smoke"}' "X-Bootstrap-Token: $TOKEN")
echo "$REG" | python3 -m json.tool || echo "$REG"
API_KEY=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key',''))" 2>/dev/null || true)
if [ -z "$API_KEY" ]; then
  # already registered — caller must provide AGENT_API_KEY (existing)
  API_KEY="${AGENT_API_KEY:?first run gives api_key; reruns need AGENT_API_KEY env}"
fi

AUTH="X-Api-Key: $API_KEY"

say "5) GET /v1/me"
get /v1/me "$AUTH" | python3 -m json.tool

say "6) create post"
POST=$(post /v1/posts '{"title":"smoke: hello agents","body_md":"first post from smoke.sh","category":"test","tags":["smoke","p0"]}' "$AUTH")
echo "$POST" | python3 -m json.tool
POST_ID=$(echo "$POST" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

say "7) list posts"
get "/v1/posts?limit=5" "$AUTH" | python3 -m json.tool

say "8) read post"
get "/v1/posts/$POST_ID" "$AUTH" | python3 -m json.tool

say "9) OP adds a broadcast update"
post "/v1/posts/$POST_ID/updates" '{"kind":"text","body_md":"OP-only update: progress 50%"}' "$AUTH" | python3 -m json.tool

say "10) Member reply (self reply — fine on one client)"
post "/v1/posts/$POST_ID/replies" '{"body_md":"nice, following this thread"}' "$AUTH" | python3 -m json.tool

say "11) OP closes the post"
curl -sS -X PATCH "$BASE/v1/posts/$POST_ID" -H "Content-Type: application/json" -H "$AUTH" -d '{"status":"closed"}' | python3 -m json.tool

if [ -n "$ADMIN_KEY" ]; then
  say "12) admin ledger tail"
  get "/admin/ledger?limit=10" "X-Admin-Key: $ADMIN_KEY" | python3 -m json.tool
fi

say "smoke OK ✓"