---
title: "Replace id-prefix heuristics with detailProvider checks"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Prerequisites

Phase 1 must be merged to main first (this ticket depends on `detailProvider` existing on `StablecoinMeta`).

## Goal

Eliminate all `id.startsWith("cg-")` and similar prefix-based branching in worker code, replacing with explicit `detailProvider` field checks.

## Task

1. **`worker/src/cron/sync-stablecoins/supplemental-assets.ts` (line 15):**
   Replace:
   ```ts
   const FIAT_CG_METAS = TRACKED_STABLECOINS.filter((stablecoin) => stablecoin.id.startsWith("cg-"));
   ```
   With:
   ```ts
   const FIAT_CG_METAS = TRACKED_STABLECOINS.filter((stablecoin) => stablecoin.detailProvider === "coingecko");
   ```

2. **`worker/src/api/stablecoin-detail.ts` (line 68):**
   Replace:
   ```ts
   const isCgOnly = id.startsWith("cg-") && !!meta?.geckoId;
   ```
   With:
   ```ts
   const isCgOnly = meta?.detailProvider === "coingecko" && !!meta?.geckoId;
   ```

3. **`worker/src/api/backfill-supply-history.ts` (line ~219):**
   Find the regex-based prefix check (NOTE: this uses a regex, NOT `startsWith`):
   ```ts
   if (/^(gold-|silver-|cg-)/.test(meta.id)) {
   ```
   Replace with a `detailProvider` check:
   ```ts
   if (meta.detailProvider === "coingecko" || meta.detailProvider === "commodity") {
   ```

4. **Discovery sweep — find any remaining prefix-based patterns.** Run BOTH of these to catch all variants (startsWith AND regex patterns):
   ```bash
   grep -rn 'startsWith("cg-")\|startsWith("gold-")\|startsWith("silver-")' worker/src/ shared/ --include="*.ts" | grep -v __tests__
   grep -rn 'gold-\|silver-\|cg-' worker/src/ shared/ --include="*.ts" | grep -v __tests__ | grep -v stablecoins.ts | grep -v peg-rates.ts | grep -v dead-stablecoins.ts
   ```
   Fix every remaining match that uses ID prefixes for branching logic. (The second grep is broader — ignore string literals in data files like `stablecoins.ts` and `peg-rates.ts`.)

5. **Verify supplemental-assets.ts is clean.** After step 1, confirm no other prefix-based patterns remain in the file. The file already uses `meta.geckoId` for CoinGecko slug derivation (no `id.replace("cg-", "")` pattern exists). No separate TICKET-003 is needed for this file.

6. **Also check `shared/lib/peg-rates.ts` (line ~9):** It contains `COMMODITY_MEDIAN_EXCLUDES = new Set(["gold-dgld"])`. This is a hardcoded gold-prefix ID, not a `startsWith` check, but it needs updating in Phase 3 when IDs switch. **Do not change it now** (the actual ID hasn't changed yet) — but verify it is captured in the Phase 3 TICKET-004 scope.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -rn 'startsWith("cg-")\|startsWith("gold-")\|startsWith("silver-")' worker/src/ shared/ --include="*.ts" | grep -v __tests__` returns 0 matches
- `grep -F 'gold-|silver-|cg-' worker/src/api/backfill-supply-history.ts` returns 0 matches (regex prefix check replaced with detailProvider)
- `grep -n '"cg-"' worker/src/cron/sync-stablecoins/supplemental-assets.ts` returns 0 matches (no remaining string literal prefix references)
