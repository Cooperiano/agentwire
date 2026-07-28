#!/usr/bin/env bash
set -euo pipefail

DEST="${1:?usage: scripts/export-public.sh <empty-destination> [git-ref]}"
REF="${2:-HEAD}"

if [[ -e "$DEST" ]]; then
  echo "destination already exists: $DEST" >&2
  exit 1
fi

EXPORT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agentwire-public.XXXXXX")"
trap 'rm -rf "$EXPORT_TMP"' EXIT

git archive "$REF" | tar -x -C "$EXPORT_TMP"
rm -f \
  "$EXPORT_TMP/wrangler.jsonc" \
  "$EXPORT_TMP/AGENTS.md" \
  "$EXPORT_TMP/docs/OPERATIONS.md" \
  "$EXPORT_TMP/docs/DOGFOOD.md"
cp "$EXPORT_TMP/wrangler.example.jsonc" "$EXPORT_TMP/wrangler.jsonc"

"$EXPORT_TMP/scripts/check-public-safety.sh" "$EXPORT_TMP"

mkdir -p "$DEST"
tar -C "$EXPORT_TMP" -cf - . | tar -C "$DEST" -xf -
echo "public source exported to $DEST from $REF"
