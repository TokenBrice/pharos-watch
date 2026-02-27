# Data Pipeline Audit — Short-term Fixes (This Month)

> Remediation plan for High and Medium-severity issues that require careful changes
> across 1–3 files or minor UI work. Each fix is 5 minutes to 2 hours.

---

## 1. Add StaleDataBanner to Missing Pages

**Severity:** High
**Finding:** Five pages display financial data without any staleness indicator: safety-scores, portfolio, stablecoin detail, compare, and digest. Users can view 30+ minute old grades or prices with no warning.

**Files to change:**
- `src/app/safety-scores/client.tsx` — track report-cards query freshness
- `src/app/portfolio/client.tsx` — track report-cards query freshness
- `src/app/stablecoin/[id]/client.tsx` — track stablecoins list query freshness
- `src/app/compare/client.tsx` — track stablecoins list query freshness
- `src/app/digest/page.tsx` — track daily-digest query freshness

**Pattern:** Follow the existing homepage implementation:

```tsx
<StaleDataBanner
  queries={[{ label: "Grades", dataUpdatedAt, staleTime: CRON_15MIN }]}
/>
```

**Effort:** ~1 hour
**Verify:** Navigate to each page with network throttling. Confirm banner appears after staleTime expires.

---

## 2. Surface FX Rate Fallback Source to Users

**Severity:** High
**Finding:** `derivePegRates` returns both `rates` and `sources` (indicating whether each rate is "median" from peer prices or "fallback" from ECB). Every call site discards `sources`. Users of RUB/BRL/TRY/JPY stablecoins see peg deviations computed from ECB fallback rates with no indication.

**Files to change:**
- `src/components/homepage-client.tsx` — destructure and pass `sources`
- `src/components/peg-heatmap.tsx` — show "(ECB rate)" indicator for fallback currencies
- `src/app/stablecoin/[id]/client.tsx` — show indicator on detail page price section
- `src/app/stablecoins/[peg]/client.tsx` — show indicator on peg landing pages

**Approach:** For any coin where `sources[pegType] === "fallback"`, add a subtle tooltip or badge: "Peg reference: ECB FX rate (not market-derived)."

**Effort:** ~2 hours
**Verify:** Check a non-USD peg landing page (e.g., `/stablecoins/rub`) and confirm the indicator appears.

---

## 3. Raise DEX Liquidity Minimum Pool Threshold

**Severity:** High
**Finding:** `sync-dex-liquidity.ts` only requires 100 pools from DeFiLlama to proceed. Normal is thousands of pools. If DeFiLlama returns 101 pools (a drastic reduction), all existing `dex_liquidity` rows are overwritten with severely incomplete data.

**File:** `worker/src/cron/sync-dex-liquidity.ts:613`

**Fix:** Change threshold from 100 to 1000:

```typescript
if (!pools || pools.length < 1000) {
  console.error(`[dex-liquidity] DeFiLlama returned only ${pools?.length ?? 0} pools, skipping`);
  return null;
}
```

**Effort:** 5 minutes
**Verify:** Worker type-check passes. Confirm cron logs show normal pool counts (should be well above 1000).

---

## 4. Normalize Dependency Weights in Report Cards

**Severity:** High
**Finding:** When dependency weights sum to more than 1.0, `totalWeight` is clamped but the raw weights are still used for blending. Scores can exceed 100 (clamped) and the -10 penalty for weak dependencies is absorbed.

**File:** `src/lib/report-cards.ts:405-409`

```typescript
// Current — uses raw weights even when they sum > 1
const totalWeight = Math.min(1, resolved.reduce((sum, d) => sum + d.weight, 0));
const blendedScore = resolved.reduce((sum, d) => sum + d.score * d.weight, 0)
  + selfBackedFraction * SELF_BACKED_SCORE;
```

**Fix:** Normalize weights before blending:

```typescript
const rawTotal = resolved.reduce((sum, d) => sum + d.weight, 0);
const totalWeight = Math.min(1, rawTotal);
const selfBackedFraction = 1 - totalWeight;
const normalizer = rawTotal > 1 ? rawTotal : 1;
const blendedScore = resolved.reduce((sum, d) => sum + d.score * (d.weight / normalizer), 0)
  + selfBackedFraction * SELF_BACKED_SCORE;
```

**Effort:** 30 minutes (including verifying existing grades don't shift unexpectedly)
**Verify:** Check that no coin currently has dependency weights summing > 1 (if none do, this is defensive only). Run `/api/report-cards` and diff output before/after.

---

## 5. Add Missing Database Indexes

**Severity:** Medium
**Finding:** The blacklist API allows filtering by `chain_name` and `event_type`, but neither column has an index. With 13K+ events, filtered queries do full table scans.

**File:** New migration `0028_blacklist_indexes.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_be_chain_name ON blacklist_events(chain_name);
CREATE INDEX IF NOT EXISTS idx_be_event_type ON blacklist_events(event_type);
```

**Effort:** 10 minutes (migration + deploy)
**Verify:** Run filtered blacklist queries and confirm response times improve.

---

## 6. Add Freshness Headers to Direct-Query Endpoints

**Severity:** Medium
**Finding:** Six endpoints serve data directly from DB queries without `X-Data-Age` or `Warning` headers: `/api/blacklist`, `/api/depeg-events`, `/api/dex-liquidity`, `/api/peg-summary`, `/api/report-cards`, `/api/digest-archive`.

**Files to change:**
- `worker/src/api/blacklist.ts` — add `addFreshnessHeaders()` using blacklist sync state timestamp
- `worker/src/api/depeg-events.ts` — add using stablecoins cache timestamp
- `worker/src/api/dex-liquidity.ts` — add using `MIN(updated_at)` from dex_liquidity table
- `worker/src/api/peg-summary.ts` — add using stablecoins cache timestamp (already loaded)
- `worker/src/api/report-cards.ts` — add using stablecoins cache timestamp (already loaded)
- `worker/src/api/digest-archive.ts` — add using `MAX(generated_at)` from daily_digest table

**Pattern:** Use the existing `addFreshnessHeaders()` helper from `api-utils.ts`.

**Effort:** ~1 hour
**Verify:** Curl each endpoint and confirm `X-Data-Age` header is present.

---

## 7. Add React Component-Level Error Boundaries

**Severity:** Medium
**Finding:** No React `ErrorBoundary` components wrap individual homepage sections. A rendering error in one component (heatmap, chart, market highlights) crashes the entire page. Next.js `error.tsx` files only catch route-level errors.

**Files to change:**
- `src/components/homepage-client.tsx` — wrap each major section (heatmap, charts, highlights, table) in an `ErrorBoundary`

**Approach:** Create a simple reusable `<SectionErrorBoundary>` component that catches errors and shows "This section failed to load" with a retry button, letting the rest of the page remain functional.

**Effort:** ~2 hours
**Verify:** Temporarily throw in a component's render method. Confirm only that section shows the fallback, not the entire page.

---

## 8. Add Pruning for `stability_index_samples` Table

**Severity:** Medium
**Finding:** `stability_index_samples` stores one row per 15-minute cron cycle with no pruning. At 96 rows/day, this accumulates ~35K rows/year. The `input_snapshot` TEXT column makes each row substantial.

**File:** `worker/src/cron/stability-index.ts`

**Fix:** After inserting the new sample, prune rows older than 90 days:

```typescript
await db.prepare("DELETE FROM stability_index_samples WHERE stored_at < ?")
  .bind(Math.floor(Date.now() / 1000) - 90 * 86400)
  .run();
```

**Effort:** 20 minutes
**Verify:** Confirm `stability_index_samples` row count stays bounded over a few days.

---

## 9. Fix Tracking Window Inflation for New Coins

**Severity:** Medium
**Finding:** `computePegScoreWithWindow` in `peg-score.ts:18` uses `Math.min(trackingStart, fourYearsAgo)` which expands the denominator for new coins. A 90-day coin shows 4-year denominator, inflating its peg adherence percentage.

**File:** `src/lib/peg-score.ts:18`

```typescript
// Current — picks the EARLIER date, expanding the window
const trackingStartSec = rawTrackingStart != null
  ? Math.min(rawTrackingStart, fourYearsAgo)
  : fourYearsAgo;
```

**Fix:** Use `Math.max` to pick the LATER (more recent) date:

```typescript
const trackingStartSec = rawTrackingStart != null
  ? Math.max(rawTrackingStart, fourYearsAgo)
  : fourYearsAgo;
```

**Note:** This only affects the detail page path. Verify this is the intended semantics — it means new coins are judged on their actual tracking window, not inflated to 4 years.

**Effort:** 5 minutes
**Verify:** Check detail page peg scores for a recently-launched coin. Confirm `trackingSpanDays` matches actual coin age.

---

## Checklist

- [ ] Fix 1: StaleDataBanner on 5 missing pages
- [ ] Fix 2: FX rate source indicator for non-USD pegs
- [ ] Fix 3: DEX pool threshold 100 → 1000
- [ ] Fix 4: Dependency weight normalization
- [ ] Fix 5: Blacklist indexes migration
- [ ] Fix 6: Freshness headers on 6 endpoints
- [ ] Fix 7: Component-level error boundaries
- [ ] Fix 8: Samples table pruning
- [ ] Fix 9: Tracking window Math.min → Math.max
- [ ] Run `npm run build` — confirm clean
- [ ] Run `cd worker && npx tsc --noEmit` — confirm clean
