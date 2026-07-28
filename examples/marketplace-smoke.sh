#!/usr/bin/env bash
# Local marketplace flow: register two agents → seller opens a shop and lists
# a free offer → buyer orders → seller delivers → buyer accepts.

set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8791}"
TOKEN="${ADMIN_BOOTSTRAP_TOKEN:?ADMIN_BOOTSTRAP_TOKEN required}"
RUN_ID="${RUN_ID:-$(date +%s)}"

json_field() {
  python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"
}

post_json() {
  curl -fsS -X POST "$BASE$1" \
    -H "Content-Type: application/json" \
    -H "$2" \
    -d "$3"
}

register_agent() {
  post_json /v1/agents/register \
    "X-Bootstrap-Token: $TOKEN" \
    "{\"device_id\":\"$1-$RUN_ID\",\"display_name\":\"$2\"}"
}

SELLER_JSON="$(register_agent market-seller "Market Seller")"
BUYER_JSON="$(register_agent market-buyer "Market Buyer")"
SELLER_KEY="$(printf '%s' "$SELLER_JSON" | json_field api_key)"
BUYER_KEY="$(printf '%s' "$BUYER_JSON" | json_field api_key)"

SHOP_JSON="$(post_json /v1/shops "X-Api-Key: $SELLER_KEY" \
  "{\"slug\":\"research-$RUN_ID\",\"name\":\"Research Agent\",\"description\":\"Fast, source-backed market research.\"}")"
SHOP_ID="$(printf '%s' "$SHOP_JSON" | json_field id)"

PRODUCT_JSON="$(post_json "/v1/shops/$SHOP_ID/products" "X-Api-Key: $SELLER_KEY" \
  '{"name":"Research sample","description":"A free sample report for marketplace dogfood.","product_type":"digital","price_cents":0,"delivery_mode":"agent"}')"
PRODUCT_ID="$(printf '%s' "$PRODUCT_JSON" | json_field id)"

ORDER_JSON="$(post_json /v1/orders "X-Api-Key: $BUYER_KEY" \
  "{\"product_id\":\"$PRODUCT_ID\",\"requirements\":\"Summarise the Agent marketplace opportunity.\"}")"
ORDER_ID="$(printf '%s' "$ORDER_JSON" | json_field id)"

post_json "/v1/orders/$ORDER_ID/deliver" "X-Api-Key: $SELLER_KEY" \
  '{"body_md":"Delivery complete: initial market signal is positive; validate willingness to pay next."}' >/dev/null
post_json "/v1/orders/$ORDER_ID/accept" "X-Api-Key: $BUYER_KEY" '{}' >/dev/null

FINAL="$(curl -fsS "$BASE/v1/orders/$ORDER_ID" -H "X-Api-Key: $BUYER_KEY")"
STATUS="$(printf '%s' "$FINAL" | python3 -c "import json,sys; print(json.load(sys.stdin)['order']['status'])")"
test "$STATUS" = "completed"

curl -fsS "$BASE/market" | grep -q "Research Agent"
printf 'marketplace smoke OK: %s\n' "$ORDER_ID"
