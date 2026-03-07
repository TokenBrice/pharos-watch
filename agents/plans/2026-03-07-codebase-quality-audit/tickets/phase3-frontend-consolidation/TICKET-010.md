---
title: "Remove overlapping lib utilities and consolidate frontend constants"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Remove frontend lib utilities that duplicate shared/lib logic, consolidate fragmented constants, and consolidate route builder functions.

## Context

The audit found:
1. PSI band color map in src/lib/chart-colors.ts duplicates shared/lib/psi-colors.ts
2. Chain display-name map in src/lib/dex-constants.ts duplicates shared/lib/chains.ts
3. Peg stability recomputation in src/lib/peg-stability.ts duplicates shared/lib/peg-score.ts
4. Day/time constants scattered across 4+ files
5. Route builders fragmented across 3 files

## Task

### 1. Remove PSI band color overlap

**`src/lib/chart-colors.ts`** (~line 57): `PSI_BAND_COLORS` duplicates `PSI_HEX_COLORS` from `shared/lib/psi-colors.ts` (~line 13).

Check all consumers of `PSI_BAND_COLORS`. Replace imports with `PSI_HEX_COLORS` from `@shared/psi-colors`. Remove `PSI_BAND_COLORS` from chart-colors.ts.

### 2. Remove chain display-name overlap

**`src/lib/dex-constants.ts`** (~line 74): Chain naming map duplicates `CHAIN_META[*].name` from `shared/lib/chains.ts` (~line 10).

Check all consumers of the local chain name map. Replace with `CHAIN_META[chain].name` from `@shared/chains`. Remove the duplicate mapping.

### 3. Remove peg stability recomputation overlap

**`src/lib/peg-stability.ts`** (~lines 49, 55): Functions recompute metrics that `shared/lib/peg-score.ts` (~lines 112, 166) already produces.

Check if the peg-stability functions produce the same values as peg-score. If yes, replace consumers with calls to the shared versions. If the functions have slight differences (formatting, additional processing), keep the local functions but have them call the shared function internally.

### 4. Consolidate time constants

These constants are scattered:
- `src/lib/constants.ts` (~line 1)
- `src/lib/mint-burn-timeframes.ts` (~line 1)
- `src/lib/stablecoin-detail-derive.ts` (~line 5)
- `src/lib/yield-scatter.ts` (~line 10)

Day/time constants like `THIRTY_DAYS_SECONDS`, `DAY_HOURS`, `DAY_MS`, raw `86400000` appear in multiple places.

Centralize in `src/lib/constants.ts` and have other files import from there. Remove inline magic numbers.

### 5. Remove threat-band ordering overlap

**`src/lib/depeg-sort.ts`** (~line 9) and **`src/lib/dews-radar-utils.ts`** (~line 35) both define local threat-band ordering while `shared/lib/classification.ts` (~line 338) has the canonical domain.

Check if the local orderings can be derived from or replaced by the shared source. If so, replace.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'PSI_BAND_COLORS' src/lib/chart-colors.ts` returns 0
- Time constants are defined in one place and imported elsewhere
- No duplicated chain name mappings in src/lib/dex-constants.ts
