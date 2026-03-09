---
title: "Consolidate worker lib utilities: chain modules, rate limiting, depeg helpers"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Consolidate fragmented worker lib utilities: merge chain-registry + chain-rpcs, consolidate rate-limit files, and extract shared depeg helpers.

## Context

The audit found:
- Chain utilities split across `chain-registry.ts` and `chain-rpcs.ts` with overlapping chain ID ownership
- Rate-limit logic split between `rate-limit.ts` and `rate-limits.ts` with a parallel implementation in `feedback.ts`
- Depeg event insert SQL duplicated across `detect-depegs.ts` and `confirm-pending-depegs.ts`
- DEX price loading duplicated in both depeg files

## Task

### 1. Merge chain-registry.ts and chain-rpcs.ts

**`worker/src/lib/chain-registry.ts`** and **`worker/src/lib/chain-rpcs.ts`** both manage chain metadata with overlapping chain ID mappings.

Merge them into a single `worker/src/lib/chain-registry.ts`:
- Keep all functionality from both files
- Remove the overlap/duplication
- Update all imports across `worker/src/` to use the merged module
- Delete `chain-rpcs.ts` after merging

### 2. Consolidate rate-limit files

**`worker/src/lib/rate-limit.ts`** and **`worker/src/lib/rate-limits.ts`** — two files with nearly identical names.

Merge into one file (`rate-limit.ts`). Update all imports. Delete `rate-limits.ts`.

Also check if `worker/src/api/feedback.ts` (~line 35) has an inline rate limiter that duplicates `checkRateLimit` from the lib. If so, replace the inline implementation with a call to the shared helper.

### 3. Extract shared depeg helpers

**`worker/src/cron/detect-depegs.ts`** (~lines 25-45, 146, 229) and **`worker/src/cron/confirm-pending-depegs.ts`** (~lines 63-70, 193) both:
1. Load `dex_prices` from the DB with near-identical error handling
2. Build depeg event INSERT statements with the same SQL and parameter assembly

The file `worker/src/lib/depeg-helpers.ts` already exists. Add to it:
- `loadDexPriceMap(db: D1Database): Promise<Map<string, number>>` — shared DEX price loading
- `buildInsertDepegEventStmt(db: D1Database, event: DepegEvent): D1PreparedStatement` — shared event insert

Then use these in both cron files.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `worker/src/lib/chain-rpcs.ts` does not exist (merged into chain-registry)
- `worker/src/lib/rate-limits.ts` does not exist (merged into rate-limit)
- `grep -c 'loadDexPriceMap\|buildInsertDepegEventStmt' worker/src/lib/depeg-helpers.ts` returns 2
- `grep -c 'loadDexPriceMap' worker/src/cron/detect-depegs.ts` returns >0
- `grep -c 'loadDexPriceMap' worker/src/cron/confirm-pending-depegs.ts` returns >0
