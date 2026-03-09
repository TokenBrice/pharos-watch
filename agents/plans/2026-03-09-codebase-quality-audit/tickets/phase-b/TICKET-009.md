---
title: "Fix deriveSupplyFromMarketCap fallback and add null-safety to supply display"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: true
---

## Goal

Fix the supply derivation fallback that returns mcap as supply when price is unavailable, and ensure the detail view model distinguishes "no data" from "zero supply" for prev-period values.

## Context

**Research findings addressed:**
- R5-C2: `deriveSupplyFromMarketCap()` falls back to returning raw mcap value when price is null — this produces a supply number equal to the market cap
- R5-M2: `safeNum()` in `shared/lib/supply.ts` converts null/undefined → 0, hiding missing historical data
- R5-I4: Detail view model uses `number` type for prev-period supply, never null

## Task

### 1. Fix deriveSupplyFromMarketCap fallback

In `src/lib/stablecoin-detail-derive.ts` (~line 32-37):

```typescript
export function deriveSupplyFromMarketCap(
  marketCapUsd: number,
  priceUsd: number | null | undefined,
): number {
  return typeof priceUsd === "number" && priceUsd > 0 ? marketCapUsd / priceUsd : marketCapUsd;
}
```

The fallback `marketCapUsd` on line 36 is wrong — when price is null, we can't derive supply from mcap alone. Change the return type to `number | null` and return `null` when price is not available:

```typescript
export function deriveSupplyFromMarketCap(
  marketCapUsd: number | null | undefined,
  priceUsd: number | null | undefined,
): number | null {
  if (typeof marketCapUsd !== "number" || marketCapUsd <= 0) return null;
  if (typeof priceUsd !== "number" || priceUsd <= 0) return null;
  return marketCapUsd / priceUsd;
}
```

Update callers to handle `null`:
- `src/hooks/use-stablecoin-detail-view-model.ts` — where `deriveSupplyFromMarketCap` is called

### 2. Add nullable prev-period supply helpers

In `shared/lib/supply.ts`, add nullable variants of the prev-period helpers that return `null` instead of `0` for missing data:

```typescript
export function getPrevDayRawOrNull(c: StablecoinData): number | null {
  const val = sumPegBuckets(c.circulatingPrevDay);
  return val === 0 && !hasAnyBucket(c.circulatingPrevDay) ? null : val;
}
```

(Same pattern for `getPrevWeekRawOrNull`, `getPrevMonthRawOrNull`.)

The helper `hasAnyBucket` should check if all values in the peg bucket object are null/undefined/0.

**Do NOT modify the existing `getPrevDayRaw()` etc.** — those have many consumers. Add new `*OrNull` variants.

### 3. Use nullable helpers in detail view model

In `src/hooks/use-stablecoin-detail-view-model.ts`, use the new `*OrNull` variants for the detail page's supply change calculations. When a prev value is null, the supply change display should show "N/A" (handled by the UI component, not the view model — just pass `null`).

## Files Modified

- `src/lib/stablecoin-detail-derive.ts`
- `shared/lib/supply.ts`
- `src/hooks/use-stablecoin-detail-view-model.ts`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `deriveSupplyFromMarketCap(1000000, null)` returns `null` (not `1000000`)
- `getPrevDayRawOrNull` exists in shared/lib/supply.ts
- Detail view model uses nullable supply values for prev-period data
