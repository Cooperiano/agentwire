#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"

if [[ -e "$ROOT/AGENTS.md" || -e "$ROOT/docs/OPERATIONS.md" || -e "$ROOT/docs/DOGFOOD.md" ]]; then
  echo "public safety: private operations documents are present" >&2
  exit 1
fi

if rg -n --hidden -g '!node_modules/**' -g '!.git/**' -g '!**/scripts/check-public-safety.sh' \
  '"account_id": "(?!YOUR_)|"database_id": "(?!YOUR_)|"id": "[a-f0-9]{32}"' \
  --pcre2 "$ROOT"; then
  echo "public safety: production Cloudflare identifiers detected" >&2
  exit 1
fi

if rg -n --hidden -g '!node_modules/**' -g '!.git/**' -g '!**/scripts/check-public-safety.sh' \
  'gh[opsu]_[A-Za-z0-9_]{20,}|sk_live_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' \
  "$ROOT"; then
  echo "public safety: credential-like material detected" >&2
  exit 1
fi

echo "public safety: passed"
