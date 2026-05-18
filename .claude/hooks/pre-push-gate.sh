#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Only intercept git push commands
if ! echo "$COMMAND" | grep -qE 'git\s+push'; then
  exit 0
fi

echo "Pre-push gate: running merge gate before push..." >&2
PAGES_SMOKE_FLAG="${MERGE_GATE_PAGES_SMOKE:-1}"

if MERGE_GATE_PAGES_SMOKE="$PAGES_SMOKE_FLAG" npm run test:merge-gate; then
  exit 0
else
  echo "BLOCKED: merge gate failed. Fix the errors above before pushing." >&2
  exit 2
fi
