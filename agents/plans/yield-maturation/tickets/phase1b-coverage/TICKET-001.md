---
title: "Fix DeFiLlama pool map mismatches"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Update `YIELD_POOL_MAP` and `YIELD_VARIANT_MAP` with correct DeFiLlama pool UUIDs for yield-bearing coins that currently miss DL pools.

## Task

1. **Read `worker/src/cron/yield-config.ts`** — Study `YIELD_POOL_MAP` (line ~173-260) and `YIELD_VARIANT_MAP` (line ~22-160).

2. **Update entries** based on the orchestrator's research output. The orchestrator will amend this ticket with exact entries to add or update before dispatching.

   **AMENDMENT PLACEHOLDER — The orchestrator will replace this section with specific entries:**
   ```
   // Example format:
   // YIELD_POOL_MAP additions:
   //   "coin-id": "new-dl-pool-uuid",
   //
   // YIELD_VARIANT_MAP additions:
   //   "coin-id": { variantSymbol: "sXYZ", yieldSource: "Protocol staking", yieldType: "nav-appreciation" },
   ```

3. **Do not remove existing working entries.** Only add new entries or update stale UUIDs.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `npm run build` exits 0
- No existing entries were removed (verify by diffing against the original file)
