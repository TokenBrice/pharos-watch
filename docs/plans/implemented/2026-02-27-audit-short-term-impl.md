# Data Pipeline Audit — Short-term Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 9 High/Medium-severity issues from the data pipeline audit across frontend and worker code.

**Architecture:** Worker-side fixes (threshold, pruning, indexes, freshness headers) are independent. Frontend fixes (stale banners, error boundaries, FX indicators) are independent of each other but share component patterns. All changes are additive or small surgical edits.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Cloudflare Workers + D1, TanStack Query

---

## Task 1: Fix tracking window inflation (Fix 9)

**Files:**
- Modify: `src/lib/peg-score.ts:18`

**Step 1: Fix Math.min → Math.max**

In `src/lib/peg-score.ts`, line 18, change `Math.min` to `Math.max`:

```typescript
// Before:
const trackingStartSec = rawTrackingStart != null
  ? Math.min(rawTrackingStart, fourYearsAgo)
  : fourYearsAgo;

// After:
const trackingStartSec = rawTrackingStart != null
  ? Math.max(rawTrackingStart, fourYearsAgo)
  : fourYearsAgo;
```

This picks the LATER (more recent) date so new coins are judged on their actual age, not inflated to a 4-year window.

---

## Task 2: Raise DEX liquidity pool threshold (Fix 3)

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts:613`

**Step 1: Change threshold from 100 to 1000**

```typescript
// Before:
if (!pools || pools.length < 100) {

// After:
if (!pools || pools.length < 1000) {
```

---

## Task 3: Add stability_index_samples pruning (Fix 8)

**Files:**
- Modify: `worker/src/cron/stability-index.ts` (after the INSERT, around line 106)

**Step 1: Add prune query after insert**

After the `.run()` call that inserts the new sample (around line 106), add:

```typescript
// Prune samples older than 90 days
await db.prepare("DELETE FROM stability_index_samples WHERE stored_at < ?")
  .bind(Math.floor(Date.now() / 1000) - 90 * 86400)
  .run();
```

Insert it before the `console.log` line.

---

## Task 4: Normalize dependency weights in report cards (Fix 4)

**Files:**
- Modify: `src/lib/report-cards.ts:406-410`

**Step 1: Add normalizer for weights > 1**

Replace lines 406-410:

```typescript
// Before:
const totalWeight = Math.min(1, resolved.reduce((sum, d) => sum + d.weight, 0));
const selfBackedFraction = 1 - totalWeight;
const SELF_BACKED_SCORE = 75;
const blendedScore = resolved.reduce((sum, d) => sum + d.score * d.weight, 0)
  + selfBackedFraction * SELF_BACKED_SCORE;

// After:
const rawTotal = resolved.reduce((sum, d) => sum + d.weight, 0);
const totalWeight = Math.min(1, rawTotal);
const selfBackedFraction = 1 - totalWeight;
const SELF_BACKED_SCORE = 75;
const normalizer = rawTotal > 1 ? rawTotal : 1;
const blendedScore = resolved.reduce((sum, d) => sum + d.score * (d.weight / normalizer), 0)
  + selfBackedFraction * SELF_BACKED_SCORE;
```

When weights sum > 1, `normalizer` scales them down proportionally so they sum to 1. When ≤ 1, behavior is unchanged.

---

## Task 5: Add blacklist indexes migration (Fix 5)

**Files:**
- Create: `worker/migrations/0028_blacklist_indexes.sql`

**Step 1: Create migration file**

```sql
CREATE INDEX IF NOT EXISTS idx_be_chain_name ON blacklist_events(chain_name);
CREATE INDEX IF NOT EXISTS idx_be_event_type ON blacklist_events(event_type);
```

---

## Task 6: Add StaleDataBanner to missing pages (Fix 1)

**Files:**
- Modify: `src/app/safety-scores/client.tsx`
- Modify: `src/app/portfolio/client.tsx`
- Modify: `src/app/stablecoin/[id]/client.tsx`
- Modify: `src/app/compare/client.tsx`
- Modify: `src/components/digest-archive-client.tsx`

All hooks return `UseQueryResult` which includes `dataUpdatedAt` from TanStack Query.

**Step 1: safety-scores/client.tsx**

Add imports:
```typescript
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_15MIN } from "@/hooks/use-api-query";
```

Destructure `dataUpdatedAt` from `useReportCards()`:
```typescript
const { data: reportCardsData, isLoading: rcLoading, dataUpdatedAt: rcUpdatedAt } = useReportCards();
```

Insert `<StaleDataBanner>` at the start of the return `<div className="space-y-6">`:
```tsx
<StaleDataBanner
  queries={[{ label: "Grades", dataUpdatedAt: rcUpdatedAt, staleTime: CRON_15MIN }]}
/>
```

**Step 2: portfolio/client.tsx**

Add imports:
```typescript
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_15MIN } from "@/hooks/use-api-query";
```

Destructure `dataUpdatedAt` from `useReportCards()`:
```typescript
const { data: reportCardsData, dataUpdatedAt: rcUpdatedAt } = useReportCards();
```

Insert banner at start of return div.

**Step 3: stablecoin/[id]/client.tsx**

Add import:
```typescript
import { StaleDataBanner } from "@/components/stale-data-banner";
```

`CRON_15MIN` is already available via `use-api-query` — check if imported, else add it. The `useStablecoins` hook already destructures what's needed.

Destructure `dataUpdatedAt` from `useStablecoins()`:
```typescript
const { data: listData, dataUpdatedAt: listUpdatedAt } = useStablecoins();
```

Insert banner after the `supplyError` block and before the HERO CARD:
```tsx
<StaleDataBanner
  queries={[{ label: "Prices", dataUpdatedAt: listUpdatedAt, staleTime: CRON_15MIN }]}
/>
```

**Step 4: compare/client.tsx**

Add import:
```typescript
import { StaleDataBanner } from "@/components/stale-data-banner";
```

`CRON_1H` is already imported. Destructure `dataUpdatedAt` from `useStablecoins()`:
```typescript
const { data, isLoading, dataUpdatedAt } = useStablecoins();
```

Insert banner at start of return div (before the share buttons):
```tsx
<StaleDataBanner
  queries={[{ label: "Prices", dataUpdatedAt, staleTime: CRON_1H }]}
/>
```

Note: Compare uses `CRON_1H` because its data comes from detail queries, not the 15min list.

**Step 5: digest-archive-client.tsx**

The digest archive page uses `DigestArchiveClient` component. Add imports:
```typescript
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_24H } from "@/hooks/use-api-query";
```

Destructure `dataUpdatedAt`:
```typescript
const { data, isLoading, dataUpdatedAt } = useDigestArchive();
```

Insert banner before the digest list, after the loading/empty states — at the start of the final return block:
```tsx
return (
  <div className="space-y-4">
    <StaleDataBanner
      queries={[{ label: "Digests", dataUpdatedAt, staleTime: CRON_24H }]}
    />
    <div className="space-y-0">
      {data.digests.map( ... )}
    </div>
  </div>
);
```

---

## Task 7: Surface FX rate fallback source to users (Fix 2)

**Files:**
- Modify: `src/components/homepage-client.tsx` — pass sources to heatmap
- Modify: `src/components/peg-heatmap.tsx` — show indicator for fallback currencies
- Modify: `src/app/stablecoin/[id]/client.tsx` — show indicator on detail page
- Modify: `src/app/stablecoins/[peg]/client.tsx` — show indicator on peg landing

All three client files already call `derivePegRates()` which returns `{ rates, sources }` — they just destructure only `rates`. The fix is to also destructure `sources` and pass it to UI components.

**Step 1: Update homepage-client.tsx**

Change the destructuring (line ~89):
```typescript
// Before:
const { rates: pegRates } = useMemo(

// After:
const { rates: pegRates, sources: pegRateSources } = useMemo(
```

Pass `pegRateSources` to `PegHeatmap`:
```tsx
<PegHeatmap
  coins={filteredPegCoins}
  logos={logos}
  isLoading={isPegLoading}
  pegFilter={pegFilter}
  typeFilter={typeFilter}
  onPegFilterChange={setPegFilter}
  onTypeFilterChange={setTypeFilter}
  pegRateSources={pegRateSources}
/>
```

**Step 2: Update peg-heatmap.tsx**

Add to `PegHeatmapProps`:
```typescript
import type { PegRateSource } from "@/lib/peg-rates";

interface PegHeatmapProps {
  // ... existing props
  pegRateSources?: Record<string, PegRateSource>;
}
```

In the component, derive which peg currencies use fallback:
```typescript
const fallbackPegs = useMemo(() => {
  if (!pegRateSources) return new Set<string>();
  return new Set(
    Object.entries(pegRateSources)
      .filter(([, src]) => src === "fallback")
      .map(([peg]) => peg)
  );
}, [pegRateSources]);
```

In the card header area, when `pegFilter !== "all"` and the selected peg is a fallback, show a small notice. Or add a subtitle under the card title:
```tsx
{fallbackPegs.size > 0 && (
  <p className="text-xs text-muted-foreground">
    Some peg references use ECB FX rates (not market-derived) for currencies with fewer than 3 tracked coins.
  </p>
)}
```

For individual coin cells, if the coin's `pegType` is in `fallbackPegs`, add a subtle indicator — a small "(ECB)" text after the deviation value.

**Step 3: Update stablecoin/[id]/client.tsx**

Destructure `sources`:
```typescript
// Before:
const { rates: pegRates } = derivePegRates(

// After:
const { rates: pegRates, sources: pegRateSources } = derivePegRates(
```

In the price section (where peg deviation is shown), check `pegRateSources[coin.pegType]`:
```tsx
{pegRateSources[coin.pegType] === "fallback" && (
  <span className="text-xs text-muted-foreground" title="Peg reference: ECB FX rate (not market-derived)">
    (ECB rate)
  </span>
)}
```

Where `coin.pegType` comes from the asset's `pegType` field (already available in the component as `asset.pegType`).

**Step 4: Update stablecoins/[peg]/client.tsx**

Destructure `sources`:
```typescript
// Before:
const { rates: pegRates } = useMemo(

// After:
const { rates: pegRates, sources: pegRateSources } = useMemo(
```

Show a notice before the table if the current peg uses fallback:
```tsx
{pegRateSources[`pegged${pegCurrency}`] === "fallback" && (
  <p className="text-xs text-amber-600 dark:text-amber-400">
    Peg reference uses ECB FX rate (not market-derived) — fewer than 3 coins tracked for {pegCurrency}.
  </p>
)}
```

---

## Task 8: Add freshness headers to 6 endpoints (Fix 6)

**Files:**
- Modify: `worker/src/api/blacklist.ts`
- Modify: `worker/src/api/depeg-events.ts`
- Modify: `worker/src/api/dex-liquidity.ts`
- Modify: `worker/src/api/peg-summary.ts`
- Modify: `worker/src/api/report-cards.ts`
- Modify: `worker/src/api/digest-archive.ts`

The pattern (from `daily-digest.ts`):
```typescript
import { addFreshnessHeaders } from "../lib/api-utils";

// In the Response:
headers: addFreshnessHeaders({
  "Content-Type": "application/json",
  "Cache-Control": CACHE_PROFILES.standard,
}, timestampSec, maxAgeSec),
```

**Step 1: blacklist.ts**

Import `addFreshnessHeaders` from `../lib/api-utils` (add to existing import). Get the freshest timestamp from the data:

```typescript
// After the events mapping, get max timestamp:
const latestTs = events.length > 0 ? Math.max(...events.map((e) => e.timestamp)) : Math.floor(Date.now() / 1000);

// Replace headers:
headers: addFreshnessHeaders({
  "Content-Type": "application/json",
  "Cache-Control": CACHE_PROFILES.realtime,
}, latestTs, 900),  // 15 minutes max age (blacklist syncs every 15m)
```

**Step 2: depeg-events.ts**

Import `addFreshnessHeaders`. Get timestamp from latest event:

```typescript
const latestTs = events.length > 0 ? events[0].startedAt : Math.floor(Date.now() / 1000);

headers: addFreshnessHeaders({
  "Content-Type": "application/json",
  "Cache-Control": CACHE_PROFILES.realtime,
}, latestTs, 900),
```

Note: events are already ordered DESC, so `events[0]` is the newest.

**Step 3: dex-liquidity.ts**

Import `addFreshnessHeaders`. Get min `updated_at` from the rows:

```typescript
const rows = result.results ?? [];
const oldestUpdate = rows.length > 0
  ? Math.min(...rows.map((r) => r.updated_at))
  : Math.floor(Date.now() / 1000);

headers: addFreshnessHeaders({
  "Content-Type": "application/json",
  "Cache-Control": CACHE_PROFILES.standard,
}, oldestUpdate, 3600),  // 1 hour max age
```

**Step 4: peg-summary.ts**

Already has `cached` loaded from `getCache(db, "stablecoins")` which has `.updatedAt`:

```typescript
// At the Response (line 200), wrap headers:
headers: addFreshnessHeaders({
  "Content-Type": "application/json",
  "Cache-Control": CACHE_PROFILES.realtime,
}, cached.updatedAt, 900),
```

Import `addFreshnessHeaders` from `../lib/api-utils`.

**Step 5: report-cards.ts**

Already has `stablecoinsCached.updatedAt` (used in `response.updatedAt` at line 265):

```typescript
headers: addFreshnessHeaders({
  "Content-Type": "application/json",
  "Cache-Control": CACHE_PROFILES.standard,
}, stablecoinsCached.updatedAt, 900),
```

Import `addFreshnessHeaders` from `../lib/api-utils`.

**Step 6: digest-archive.ts**

Get max `generated_at` from the rows:

```typescript
const latestTs = digests.length > 0 ? digests[0].generatedAt : Math.floor(Date.now() / 1000);

headers: addFreshnessHeaders({
  "Content-Type": "application/json",
  "Cache-Control": CACHE_PROFILES.standard,
}, latestTs, 86400),  // 24 hour max age
```

Import `addFreshnessHeaders` from `../lib/api-utils`.

---

## Task 9: Add React component-level error boundaries (Fix 7)

**Files:**
- Create: `src/components/section-error-boundary.tsx`
- Modify: `src/components/homepage-client.tsx` — wrap major sections

**Step 1: Create SectionErrorBoundary component**

```tsx
"use client";

import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class SectionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}] render error:`, error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            This section failed to load.
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-2 text-sm font-medium text-foreground hover:underline"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

**Step 2: Wrap homepage sections**

Import in `homepage-client.tsx`:
```typescript
import { SectionErrorBoundary } from "@/components/section-error-boundary";
```

Wrap these sections:
- `<MarketHighlights ... />` → `<SectionErrorBoundary name="highlights">...</SectionErrorBoundary>`
- Charts grid div → `<SectionErrorBoundary name="charts">...</SectionErrorBoundary>`
- Digest section → `<SectionErrorBoundary name="digest">...</SectionErrorBoundary>`
- StablecoinTable section → `<SectionErrorBoundary name="table">...</SectionErrorBoundary>`
- CategoryStats section → `<SectionErrorBoundary name="stats">...</SectionErrorBoundary>`
- PegHeatmap section → `<SectionErrorBoundary name="heatmap">...</SectionErrorBoundary>`
- DepegFeed section → `<SectionErrorBoundary name="depeg-feed">...</SectionErrorBoundary>`

---

## Task 10: Build verification

**Step 1: Frontend build**
```bash
npm run build
```
Expected: Clean build with no errors.

**Step 2: Worker type-check**
```bash
cd worker && npx tsc --noEmit
```
Expected: No type errors.

---

## Task 11: Commit and push to production

**Step 1: Commit all changes**

Stage and commit with a descriptive message covering all 9 fixes.

**Step 2: Push to main**

Push to trigger Cloudflare Pages deploy.

**Step 3: Verify deploy**

Monitor Cloudflare Pages deploy status. Once live, verify:
- StaleDataBanner appears on safety-scores, portfolio, stablecoin detail, compare, digest pages
- FX source indicator shows on non-USD peg pages
- Freshness headers present on API endpoints
- Error boundary catches section-level errors without page crash
