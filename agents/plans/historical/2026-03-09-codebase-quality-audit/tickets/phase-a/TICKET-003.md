---
title: "Remove dead code from worker and shared modules"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Remove dead code in `shared/` and `worker/src/` — unused type fields, dead type exports, dead functions, dead files, and stale comments. Pure deletions with no behavior change.

## Context

The R2 audit found significant dead code: a never-read metadata field maintained across 156 stablecoins, 25+ dead schema/type exports, dead helper functions, and an orphaned script file.

**Research findings addressed:**
- R2 Finding C1: Dead `supplyMethod` field (-120 LOC)
- R2 Finding C2: Dead schema/type exports in shared/types (-180 LOC)
- R2 Finding I1: Dead shared/index.ts (-4 LOC)
- R2 Finding I2: Dead `loadDexPriceMap` function (-8 LOC)
- R2 Finding M6: Orphan backfill-megafilter script (-180 LOC)
- R2 Finding M7: Stale comment in detect-depegs (-1 LOC)

## Task

### 1. Remove `supplyMethod` from StablecoinMeta and all coin entries

**Step 1a:** In `shared/types/index.ts` (~line 158), remove the `supplyMethod` field from the `StablecoinMeta` type/interface.

**Step 1b:** In `shared/lib/stablecoins.ts`, search for all occurrences of `supplyMethod` and remove those properties from every coin entry. The field appears in the `coin()` helper defaults and in individual coin definitions throughout the file.

**IMPORTANT:** Before removing, verify `supplyMethod` is truly never read by searching both `src/` and `worker/src/` for any reference to `supplyMethod`. The R2 audit confirmed no read-path exists, but double-check.

### 2. De-export dead schema/type fragments from shared/types/index.ts

The following exported types and schemas are never imported by `src/` or `worker/src/`. Remove the `export` keyword from each (keep internal-only if used within the same file, delete entirely if unused):

Search for each name across `src/` and `worker/src/` before removing. The R2 audit identified these at the listed line numbers, but lines may have shifted:
- Line ~480: internal schema fragments
- Line ~561, ~594, ~601, ~669: intermediate response schema parts
- Line ~780, ~790, ~797, ~806, ~818: methodology envelope sub-schemas
- Line ~947, ~958: internal status sub-schemas
- Line ~1070, ~1094, ~1096, ~1127, ~1168: report card sub-schemas
- Line ~1200, ~1230, ~1267: yield/mint-burn sub-schemas
- Line ~1317, ~1328, ~1359, ~1375, ~1398, ~1400, ~1430, ~1437, ~1469: other sub-schemas

The exact list is ~25 exports. For each, verify no import exists in `src/` or `worker/src/` before de-exporting.

### 3. Remove dead shared/index.ts

Delete `shared/index.ts` — it's not imported anywhere. Verify first with: `grep -r "from.*shared/index\|@shared/index\|shared'" src/ worker/src/` — should return nothing.

### 4. Remove dead loadDexPriceMap and fix stale comment

In `worker/src/lib/depeg-helpers.ts` (~line 52), remove the `loadDexPriceMap` function (it has no call-sites; code uses `loadDexPriceRows` instead).

In `worker/src/cron/detect-depegs.ts` (~line 53), update the comment that references `loadDexPriceMap` to reference `loadDexPriceRows` instead.

### 5. Remove orphan backfill-megafilter script

Delete `worker/src/scripts/backfill-megafilter.ts` — it has no package.json script entry and sits in an excluded path. Verify it's not imported anywhere first.

## Files Modified

- `shared/types/index.ts`
- `shared/lib/stablecoins.ts`
- `shared/index.ts` (deleted)
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/scripts/backfill-megafilter.ts` (deleted)

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -r 'supplyMethod' shared/` returns nothing
- `ls shared/index.ts` fails (file deleted)
- `grep 'loadDexPriceMap' worker/src/lib/depeg-helpers.ts` returns nothing
- `ls worker/src/scripts/backfill-megafilter.ts` fails (file deleted)
- `grep 'loadDexPriceMap' worker/src/cron/detect-depegs.ts` returns nothing (comment updated)
