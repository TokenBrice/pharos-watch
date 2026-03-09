---
title: "Fix PSI perfect-score-on-missing-mcap and DEWS CALM-on-missing-signals"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: true
---

## Goal

Fix two scoring edge cases where missing data produces misleadingly optimistic scores instead of null/insufficient-data indicators.

## Context

**Research findings addressed:**
- R5-C3: PSI outputs perfect 100/BEDROCK when `totalMcapUsd` ≤ 0 (data outage hides systemic risk)
- R5-I1: DEWS returns `score: 0, band: "CALM"` when >50% of signals are missing (insufficient data looks like calm market)

## Task

### 1. Fix PSI on missing market cap

In `worker/src/lib/stability-index.ts` (~lines 38-64), the `computeStabilityIndex()` function computes severity share using `totalMcapUsd`. When mcap is 0 or missing, severity share becomes 0 and the raw score stays 100, yielding a BEDROCK band during data outages.

**Fix:** At the start of `computeStabilityIndex()`, add a guard:
```typescript
if (!totalMcapUsd || totalMcapUsd <= 0) {
  return null;
}
```

The return type needs to change from `StabilityIndexResult` to `StabilityIndexResult | null`. Update all callers to handle `null`:

1. In `worker/src/cron/stability-index.ts` (the cron that calls `computeStabilityIndex`): skip writing to DB/cache when result is null.
2. In the PSI API handler (`worker/src/api/stability-index.ts`): return the cached value (which will be the last valid computation).
3. Check `worker/src/lib/dews.ts` if it uses `computeStabilityIndex` — if so, handle null there too.

**Important:** Do NOT change any tests that validate the current scoring formula. Only add null-guard logic.

### 2. Fix DEWS on insufficient signals

In `worker/src/lib/dews.ts` (~line 608-611), when `totalWeight < 0.3` (meaning >70% of signal weight is missing), the function returns `{ score: 0, band: "CALM", signals }`.

**Fix:** Change this to return null instead:
```typescript
if (totalWeight < 0.3) {
  return null;
}
```

Update the return type of `computeDews()` to `DewsResult | null`. Update callers:

1. In `worker/src/cron/compute-dews.ts` (or wherever `computeDews` is called): skip writing when result is null.
2. In the DEWS API handler: return the last valid cached value.

**Important:** Also update `docs/dews.md` to document the insufficient-data behavior (currently undocumented).

## Files Modified

- `worker/src/lib/stability-index.ts`
- `worker/src/cron/stability-index.ts` (or wherever PSI cron calls computeStabilityIndex)
- `worker/src/lib/dews.ts`
- `worker/src/cron/compute-dews.ts` (or wherever DEWS cron calls computeDews)
- `docs/dews.md`
- `docs/stability-index.md`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `computeStabilityIndex` returns null when totalMcapUsd ≤ 0
- `computeDews` returns null when totalWeight < 0.3
- Both docs updated to describe insufficient-data behavior
