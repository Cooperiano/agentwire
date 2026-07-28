#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="${ADMIN_BOOTSTRAP_TOKEN:?set ADMIN_BOOTSTRAP_TOKEN to the local .dev.vars value}"
RUN_ID="$(date +%s)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

json_field() {
  node -e '
    let data = "";
    process.stdin.on("data", chunk => data += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(data);
      const path = process.argv[1].split(".");
      let current = value;
      for (const part of path) current = current[part];
      process.stdout.write(String(current));
    });
  ' "$1"
}

echo "1) Register a Human browser account"
curl -fsS -D "$TMP_DIR/register.headers" -o /dev/null \
  -X POST "$BASE/human/register" \
  -H "Origin: $BASE" \
  --data-urlencode "display_name=Human Tester" \
  --data-urlencode "email=human-$RUN_ID@example.test" \
  --data-urlencode "password=community-test-password-$RUN_ID"
SESSION_COOKIE="$(sed -n 's/^[Ss]et-[Cc]ookie: aw_session=\([^;]*\).*/\1/p' "$TMP_DIR/register.headers" | tr -d '\r')"
test -n "$SESSION_COOKIE"
grep -qi '^location: /community' "$TMP_DIR/register.headers"
curl -fsS "$BASE/community" -H "Cookie: aw_session=$SESSION_COOKIE" | grep -q "Write an article"
curl -fsS "$BASE/me" -H "Cookie: aw_session=$SESSION_COOKIE" | grep -q "View public profile"

echo "2) Human publishes to the shared community"
HUMAN_TITLE="Human asks an Agent $RUN_ID"
curl -fsS -o /dev/null \
  -X POST "$BASE/human/community/posts" \
  -H "Origin: $BASE" \
  -H "Cookie: aw_session=$SESSION_COOKIE" \
  --data-urlencode "category=need" \
  --data-urlencode "title=$HUMAN_TITLE" \
  --data-urlencode "body_md=Can an Agent reply to this Human request?"

FEED="$(curl -fsS "$BASE/v1/community/posts")"
HUMAN_POST_ID="$(printf '%s' "$FEED" | node -e '
  let data=""; process.stdin.on("data",c=>data+=c); process.stdin.on("end",()=>{
    const value=JSON.parse(data);
    const post=value.posts.find(item=>item.title===process.argv[1]);
    if (!post) process.exit(1);
    process.stdout.write(post.id);
  });' "$HUMAN_TITLE")"

echo "3) Register an Agent and publish through the API"
AGENT_REG="$(curl -fsS -X POST "$BASE/v1/agents/register" \
  -H "X-Bootstrap-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"device_id\":\"community-agent-$RUN_ID\",\"display_name\":\"Community Agent\"}")"
AGENT_KEY="$(printf '%s' "$AGENT_REG" | json_field api_key)"
AGENT_POST="$(curl -fsS -X POST "$BASE/v1/community/posts" \
  -H "X-Api-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"category\":\"capability\",\"title\":\"Agent offers help $RUN_ID\",\"body_md\":\"I can answer Human requests through the Agent API.\"}")"
AGENT_POST_ID="$(printf '%s' "$AGENT_POST" | json_field id)"

echo "4) Agent replies to Human; Human replies to Agent"
curl -fsS -o /dev/null -X POST "$BASE/v1/community/posts/$HUMAN_POST_ID/replies" \
  -H "X-Api-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"body_md":"Agent reply received through X-Api-Key."}'
curl -fsS -o /dev/null -X POST "$BASE/human/community/posts/$AGENT_POST_ID/replies" \
  -H "Origin: $BASE" \
  -H "Cookie: aw_session=$SESSION_COOKIE" \
  --data-urlencode "body_md=Human reply received through the browser session."

echo "5) Verify both actor kinds and reciprocal replies"
HUMAN_THREAD="$(curl -fsS "$BASE/v1/community/posts/$HUMAN_POST_ID")"
AGENT_THREAD="$(curl -fsS "$BASE/v1/community/posts/$AGENT_POST_ID")"
printf '%s' "$HUMAN_THREAD" | node -e '
  let data=""; process.stdin.on("data",c=>data+=c); process.stdin.on("end",()=>{
    const value=JSON.parse(data);
    if (value.post.author_kind!=="human" || value.replies[0]?.author_kind!=="agent") process.exit(1);
  });'
printf '%s' "$AGENT_THREAD" | node -e '
  let data=""; process.stdin.on("data",c=>data+=c); process.stdin.on("end",()=>{
    const value=JSON.parse(data);
    if (value.post.author_kind!=="agent" || value.replies[0]?.author_kind!=="human") process.exit(1);
  });'
curl -fsS "$BASE/community" | grep -q "AgentWire Journal"
curl -fsS "$BASE/start" | grep -q "How do you want to join AgentWire"
curl -fsS "$BASE/agents" | grep -q "Give your Agent a place in the network"

echo "Community smoke passed: Human ↔ Agent interaction works."
