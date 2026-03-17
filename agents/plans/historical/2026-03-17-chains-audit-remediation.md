# Chains Page Audit Remediation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all issues identified in the chains page audit — eliminate code duplication, improve accessibility, fix dark mode gaps, add error resilience, correct data accuracy, and polish edge cases.

**Architecture:** Shared chain UI utilities extracted to `src/lib/chain-ui.ts`. Backend backing-type logic corrected in `shared/lib/chain-aggregator.ts`. Frontend pages adopt existing `QueryErrorNotice`/`StaleDataBanner` patterns and `Skeleton` components. All changes stay within the existing module boundaries.

**Tech Stack:** React 19, TypeScript strict, Tailwind CSS v4, TanStack Query, Vitest, Next.js 16 static export.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/chain-ui.ts` | Shared chain formatting helpers + health band color maps |
| Modify | `shared/lib/chains.ts` | Add exported `getActiveChainIds()` |
| Modify | `shared/lib/__tests__/chains.test.ts` | Test for `getActiveChainIds` |
| Modify | `shared/lib/chain-aggregator.ts:119-123` | Fix backing default for unclassified coins |
| Modify | `shared/lib/__tests__/chain-aggregator.test.ts` | Test backing fix |
| Modify | `shared/lib/chain-health.ts:6-10` | Export weight constants |
| Modify | `src/app/chains/page.tsx` | Use shared `getActiveChainIds` |
| Modify | `src/app/chains/client.tsx` | Use shared utils, add a11y, error handling, skeletons |
| Modify | `src/app/chains/[chain]/page.tsx` | Use shared `getActiveChainIds` |
| Modify | `src/app/chains/[chain]/client.tsx` | Use shared utils, fix dark mode, add a11y, error handling, skeletons, fix backing default, dynamic weight labels, treemap edge cases |
| (no change) | `src/hooks/use-chains.ts` | Already exposes `error`/`refetch`/`dataUpdatedAt` via `useApiQuery` return |
| Modify | `src/lib/nav-config.ts:59` | Fix trailing slash |
| Modify | `src/lib/data-health-config.ts` | Add `"chains"` preset for StaleDataBanner |
| Modify | `docs/chains-page.md` | Document all changes |

---

## Chunk 1: Shared Utility Extraction

### Task 1: Create `src/lib/chain-ui.ts`

Extract the duplicated formatting and color-map code from both chain client files into a single shared module. This is the foundation for the rest of the refactor.

**Files:**
- Create: `src/lib/chain-ui.ts`

- [ ] **Step 1: Create the shared module**

```ts
// src/lib/chain-ui.ts
import type { HealthBand } from "@shared/types/chains";

/**
 * Format a USD value with tier-specific decimal precision:
 * T/B = 2 decimals, M = 1 decimal, K and below = 0 decimals.
 * Matches the original chains page formatting exactly.
 */
export function formatChainUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

/**
 * Format a ratio (e.g. 0.05) as a signed percentage string (e.g. "+5.00%").
 * Always shows a "+" sign for zero and positive values.
 */
export function formatRatioPct(value: number): string {
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Badge-style classes: background + text color for health bands.
 * Note: light-mode text uses -700 (harmonized from the leaderboard's original values).
 */
export const HEALTH_BADGE_CLASSES: Record<HealthBand, string> = {
  robust: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  healthy: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  mixed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  fragile: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  concentrated: "bg-red-500/15 text-red-700 dark:text-red-400",
};

/** Text-only classes for health band labels (no background). */
export const HEALTH_TEXT_CLASSES: Record<HealthBand, string> = {
  robust: "text-emerald-600 dark:text-emerald-400",
  healthy: "text-sky-600 dark:text-sky-400",
  mixed: "text-amber-600 dark:text-amber-400",
  fragile: "text-orange-600 dark:text-orange-400",
  concentrated: "text-red-600 dark:text-red-400",
};

/** Trend-direction color classes (positive = green, negative = red). */
export function trendColor(value: number): string {
  return value >= 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/chain-ui.ts
git commit -m "refactor(chains): extract shared chain UI helpers to src/lib/chain-ui.ts"
```

---

### Task 2: Refactor leaderboard client to use shared utils

Replace the local `formatUsd`, `formatPct`, and `HEALTH_BAND_COLORS` in the leaderboard with imports from the new shared module.

**Files:**
- Modify: `src/app/chains/client.tsx`

- [ ] **Step 1: Replace imports and remove local definitions**

At the top of `src/app/chains/client.tsx`, add:
```ts
import { formatChainUsd, formatRatioPct, HEALTH_BADGE_CLASSES, trendColor } from "@/lib/chain-ui";
```

Remove these local definitions (lines 16-36):
- `function formatUsd` (lines 16-22)
- `function formatPct` (lines 24-28)
- `const HEALTH_BAND_COLORS` (lines 30-36)

- [ ] **Step 2: Update all references**

In the file body, replace:
- `formatUsd(` → `formatChainUsd(`
- `formatPct(` → `formatRatioPct(`
- `HEALTH_BAND_COLORS[` → `HEALTH_BADGE_CLASSES[`

In the table row for 7d change (around line 185), replace the inline conditional color classes:
```tsx
// Before:
className={cn("text-right font-mono tabular-nums", chain.change7dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}

// After:
className={cn("text-right font-mono tabular-nums", trendColor(chain.change7dPct))}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/chains/client.tsx
git commit -m "refactor(chains): leaderboard client uses shared chain-ui helpers"
```

---

### Task 3: Refactor profile client to use shared utils

Replace local formatting helpers and color maps in the chain profile with shared imports. This also fixes **M1 (dark mode colors)** since `trendColor()` always includes dark variants.

**Files:**
- Modify: `src/app/chains/[chain]/client.tsx`

- [ ] **Step 1: Replace imports and remove local definitions**

At the top of `src/app/chains/[chain]/client.tsx`, add:
```ts
import { formatChainUsd, formatRatioPct, HEALTH_BADGE_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
```

Remove these local definitions (lines 14-48):
- `const HEALTH_BAND_COLORS` (lines 14-20)
- `const HEALTH_BAND_BG` (lines 22-28)
- `function formatUsd` (lines 36-42)
- `function formatPct` (lines 44-48)

- [ ] **Step 2: Update all references in the file**

Replace throughout the file:
- `formatUsd(` → `formatChainUsd(`
- `formatPct(` → `formatRatioPct(`
- `HEALTH_BAND_COLORS[` → `HEALTH_TEXT_CLASSES[`
- `HEALTH_BAND_BG[` → Replace the two usages in `HealthBreakdownCard` (around line 109) where both are used together. Change from:
  ```tsx
  cn("flex h-14 w-14 ...", HEALTH_BAND_BG[healthBand], HEALTH_BAND_COLORS[healthBand])
  ```
  to:
  ```tsx
  cn("flex h-14 w-14 ...", HEALTH_BADGE_CLASSES[healthBand])
  ```
  (The badge classes combine bg + text, which is what the score circle needs.)

  **Note:** This shifts the score circle's light-mode text from `-600` to `-700` (harmonized with the leaderboard badge). The dark-mode colors are unchanged. This is an intentional consolidation — mention in the commit message.

For the hero card change colors (lines 89-91 — this is the **M1 dark mode fix**), replace the inline color conditionals:
```tsx
// Before (line 89 — already correct):
chain.change24hPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
// Before (lines 90-91 — MISSING dark variants):
chain.change7dPct >= 0 ? "text-emerald-600" : "text-red-600"
chain.change30dPct >= 0 ? "text-emerald-600" : "text-red-600"

// After (all three):
trendColor(chain.change24hPct)
trendColor(chain.change7dPct)
trendColor(chain.change30dPct)
```

For the stablecoin table rows (around lines 274-278), same pattern:
```tsx
// Before:
coin.change7dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
// After:
trendColor(coin.change7dPct)
// (same for change30dPct)
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/chains/[chain]/client.tsx
git commit -m "refactor(chains): profile client uses shared chain-ui helpers (fixes dark mode)"
```

---

### Task 4: Extract `getActiveChainIds` to shared

The identical function is defined in both `src/app/chains/page.tsx` and `src/app/chains/[chain]/page.tsx`. Move it to `shared/lib/chains.ts` where it naturally belongs alongside `CHAIN_META`.

**Files:**
- Modify: `shared/lib/chains.ts`
- Modify: `shared/lib/__tests__/chains.test.ts`
- Modify: `src/app/chains/page.tsx`
- Modify: `src/app/chains/[chain]/page.tsx`

- [ ] **Step 1: Write the test in `shared/lib/__tests__/chains.test.ts`**

Add a new describe block at the end of the file:

```ts
describe("getActiveChainIds", () => {
  it("returns chain IDs that appear in both contracts and CHAIN_META", () => {
    const ids = getActiveChainIds();
    expect(ids.length).toBeGreaterThan(0);
    // Every returned ID must be a valid CHAIN_META key
    for (const id of ids) {
      expect(CHAIN_META[id]).toBeDefined();
    }
    // Ethereum must always be present (sanity check)
    expect(ids).toContain("ethereum");
  });

  it("returns sorted, deduplicated IDs", () => {
    const ids = getActiveChainIds();
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

Also add the import for `getActiveChainIds`:
```ts
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared/lib/__tests__/chains.test.ts`
Expected: FAIL — `getActiveChainIds` is not exported.

- [ ] **Step 3: Add the function to `shared/lib/chains.ts`**

At the end of the file, add:

```ts
import { TRACKED_STABLECOINS } from "./stablecoins";

/** Chain IDs that have at least one tracked stablecoin contract and a CHAIN_META entry. */
export function getActiveChainIds(): string[] {
  const chainIds = new Set<string>();
  for (const coin of TRACKED_STABLECOINS) {
    if (coin.contracts) {
      for (const contract of coin.contracts) {
        if (CHAIN_META[contract.chain]) chainIds.add(contract.chain);
      }
    }
  }
  return Array.from(chainIds).sort();
}
```

**Note:** `TRACKED_STABLECOINS` is not currently imported in `chains.ts`. Adding this import is safe — `shared/lib/stablecoins/index.ts` does NOT import from `chains.ts`, so there is no circular dependency.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- shared/lib/__tests__/chains.test.ts`
Expected: PASS

- [ ] **Step 5: Update both page files to import from shared**

In `src/app/chains/page.tsx`:
- Add `getActiveChainIds` to the existing `CHAIN_META` import from `@shared/lib/chains`
- Remove the local `getActiveChainIds` function (lines 16-26)
- Remove the `TRACKED_STABLECOINS` import (line 4) if it's now unused

In `src/app/chains/[chain]/page.tsx`:
- Add `getActiveChainIds` to the existing `CHAIN_META` import from `@shared/lib/chains`
- Remove the local `getActiveChainIds` function (lines 9-19)
- Remove the `TRACKED_STABLECOINS` import (line 4) if it's now unused

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 7: Commit**

```bash
git add shared/lib/chains.ts shared/lib/__tests__/chains.test.ts src/app/chains/page.tsx src/app/chains/[chain]/page.tsx
git commit -m "refactor(chains): extract getActiveChainIds to shared/lib/chains.ts"
```

---

## Chunk 2: Accessibility & Quick Fixes

> **Note:** Chunk 1 refactoring shifts line numbers in both client files. Line references below are relative to the **original** source files. After Chunk 1, locate the target code by searching for the specific string patterns shown in "Before" blocks rather than relying on line numbers.

### Task 5: Fix nav trailing slash

**Files:**
- Modify: `src/lib/nav-config.ts:59`

- [ ] **Step 1: Add trailing slash**

Change line 59 from:
```ts
{ href: "/chains", label: "Stable per Chain", icon: Layers, description: "Stablecoin activity per chain" },
```
to:
```ts
{ href: "/chains/", label: "Stable per Chain", icon: Layers, description: "Stablecoin activity per chain" },
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/lib/nav-config.ts
git commit -m "fix(nav): add trailing slash to /chains/ link"
```

---

### Task 6: Add table captions and scope attributes

Add `<caption>` elements to both tables for screen reader context, and `scope="col"` to the profile stablecoin table headers.

**Files:**
- Modify: `src/app/chains/client.tsx`
- Modify: `src/app/chains/[chain]/client.tsx`

- [ ] **Step 1: Add caption to leaderboard table**

In `src/app/chains/client.tsx`, inside the `<table>` element (around line 100), add a caption as the first child:
```tsx
<table className="w-full text-sm">
  <caption className="sr-only">Blockchain networks ranked by stablecoin supply</caption>
  <TableHeader>
```

- [ ] **Step 2: Add caption and scope to profile stablecoin table**

In `src/app/chains/[chain]/client.tsx`, in the `StablecoinTable` component (around line 245), add:
```tsx
<table className="w-full text-sm">
  <caption className="sr-only">Stablecoins deployed on this chain</caption>
  <thead>
    <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
      <th scope="col" className="px-3 py-2 w-10">#</th>
      <th scope="col" className="px-3 py-2">Stablecoin</th>
      <th scope="col" className="px-3 py-2 text-right">Supply on Chain</th>
      <th scope="col" className="px-3 py-2 text-right">Chain Share</th>
      <th scope="col" className="px-3 py-2 text-right">7d</th>
      <th scope="col" className="px-3 py-2 text-right">30d</th>
    </tr>
  </thead>
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/app/chains/client.tsx src/app/chains/[chain]/client.tsx
git commit -m "a11y(chains): add table captions and scope attributes"
```

---

### Task 7: Handle `darkInvert` on chain logos

Chain logos with `darkInvert: true` (e.g., Aptos) need a `dark:invert` class to remain visible on dark backgrounds. Follow the existing pattern in `src/components/key-info-card.tsx:307`.

**Files:**
- Modify: `src/app/chains/client.tsx`
- Modify: `src/app/chains/[chain]/client.tsx`

- [ ] **Step 1: Add CHAIN_META import to leaderboard (if not already present)**

The leaderboard client doesn't currently import `CHAIN_META`. Add:
```ts
import { CHAIN_META } from "@shared/lib/chains";
```

- [ ] **Step 2: Update the Image in the leaderboard table row**

In `src/app/chains/client.tsx`, the chain logo in the table row (around line 176):
```tsx
// Before:
<Image src={chain.logoPath} alt="" width={20} height={20} className="rounded-full" />

// After:
<Image src={chain.logoPath} alt="" width={20} height={20} className={`rounded-full${CHAIN_META[chain.id]?.darkInvert ? " dark:invert" : ""}`} />
```

- [ ] **Step 3: Update the Image in the profile hero card**

In `src/app/chains/[chain]/client.tsx`, in the `HeroCard` component (around line 73):
```tsx
// Before:
{meta && <Image src={meta.logoPath} alt="" width={40} height={40} className="rounded-full" />}

// After:
{meta && <Image src={meta.logoPath} alt="" width={40} height={40} className={`rounded-full${meta.darkInvert ? " dark:invert" : ""}`} />}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add src/app/chains/client.tsx src/app/chains/[chain]/client.tsx
git commit -m "fix(chains): apply dark:invert to chain logos that need it"
```

---

## Chunk 3: Error Handling & Loading UX

### Task 8: Add `QueryErrorNotice` and `StaleDataBanner`

Both chain pages show a bare "Failed to load" string on error with no retry. The codebase has established `QueryErrorNotice` and `StaleDataBanner` components used on the homepage and other pages. Adopt them.

**Files:**
- Modify: `src/lib/data-health-config.ts`
- Modify: `src/app/chains/client.tsx`
- Modify: `src/app/chains/[chain]/client.tsx`

**Context:** `useChains()` in `src/hooks/use-chains.ts` returns the full `UseQueryResult<ChainsResponse, Error>` from `useApiQuery`, which includes `error`, `refetch`, and `dataUpdatedAt`. No changes needed in the hook file.

- [ ] **Step 1: Register `"chains"` preset in data-health-config**

In `src/lib/data-health-config.ts`, add the chains preset inside `DATA_HEALTH_PRESETS`:

```ts
  chains: { label: "Chain Data", staleTime: CRON_15MIN },
```

Add it after the existing `stablecoins` entry (they share the same cron interval).

- [ ] **Step 2: Update leaderboard client error handling**

In `src/app/chains/client.tsx`, update the `ChainsLeaderboardClient` component:

Add imports:
```ts
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
```

Change the hook destructuring:
```ts
const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useChains();
```

Replace the error return block (around line 82-84):
```tsx
// Before:
if (isError || !data) {
  return <div className="flex items-center justify-center py-20 text-destructive">Failed to load chain data.</div>;
}

// After:
if (isError && !data) {
  return (
    <QueryErrorNotice error={error} onRetry={() => { void refetch(); }} />
  );
}
```

Add the `StaleDataBanner` and `QueryErrorNotice` at the top of the main return JSX (inside the `<div className="space-y-6">`, before the KPI strip):
```tsx
<QueryErrorNotice error={error} hasData={!!data?.chains?.length} onRetry={() => { void refetch(); }} />
<StaleDataBanner queries={[{ preset: "chains", dataUpdatedAt, error, hasData: !!data?.chains?.length }]} />
```

- [ ] **Step 3: Update profile client error handling**

In `src/app/chains/[chain]/client.tsx`, make the same changes in `ChainProfileClient`:

Add the same imports (`QueryErrorNotice`, `StaleDataBanner`).

Change the hook destructuring:
```ts
const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useChains();
```

Replace the error block (around line 301-303):
```tsx
if (isError && !data) {
  return (
    <QueryErrorNotice error={error} onRetry={() => { void refetch(); }} />
  );
}
```

Add banners at the top of the returned `<div className="space-y-6">`:
```tsx
<QueryErrorNotice error={error} hasData={!!data?.chains?.length} onRetry={() => { void refetch(); }} />
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 5: Commit**

Note: No changes are needed in `src/hooks/use-chains.ts` — `useApiQuery` already returns the full `UseQueryResult` including `error`, `refetch`, and `dataUpdatedAt`.

```bash
git add src/lib/data-health-config.ts src/app/chains/client.tsx src/app/chains/[chain]/client.tsx
git commit -m "fix(chains): add QueryErrorNotice with retry and stale data handling"
```

---

### Task 9: Add loading skeletons

Replace the text-only "Loading chain data..." with skeleton loaders that match the final layout shape.

**Files:**
- Modify: `src/app/chains/client.tsx`
- Modify: `src/app/chains/[chain]/client.tsx`

- [ ] **Step 1: Add skeleton import and leaderboard skeleton**

In `src/app/chains/client.tsx`, add:
```ts
import { Skeleton } from "@/components/ui/skeleton";
```

Replace the loading return (around line 80-81):
```tsx
// Before:
if (isLoading) {
  return <div className="flex items-center justify-center py-20 text-muted-foreground">Loading chain data...</div>;
}

// After:
if (isLoading) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
      <div className="rounded-lg border">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="mx-3 my-2.5 h-8 rounded" />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add profile skeleton**

In `src/app/chains/[chain]/client.tsx`, add the `Skeleton` import and replace the loading return (around line 298-300):
```tsx
if (isLoading) {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 rounded-lg" />
      <Skeleton className="h-64 rounded-lg" />
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/app/chains/client.tsx src/app/chains/[chain]/client.tsx
git commit -m "ux(chains): add skeleton loading states to leaderboard and profile"
```

---

## Chunk 4: Data Accuracy & Layout

### Task 10: Fix KPI "Top Chain Dominance" explicit sort

The KPI currently uses `data.chains[0]` which relies on the API sort order being by `totalUsd`. Make this explicit.

**Files:**
- Modify: `src/app/chains/client.tsx`

- [ ] **Step 1: Compute the top chain explicitly**

Near where `topHealthChain` is computed (around line 86), change the "Top Chain Dominance" KPI to use an explicit lookup:

```tsx
// Already exists:
const topHealthChain = [...data.chains].sort((a, b) => (b.healthScore ?? -1) - (a.healthScore ?? -1))[0];

// Add:
const topSupplyChain = [...data.chains].sort((a, b) => b.totalUsd - a.totalUsd)[0];
```

Then update the KPI card (around line 94):
```tsx
// Before:
<KpiCard label="Top Chain Dominance" value={data.chains[0] ? `${data.chains[0].name} ${(data.chains[0].dominanceShare * 100).toFixed(1)}%` : "--"} />

// After:
<KpiCard label="Top Chain" value={topSupplyChain ? `${topSupplyChain.name} ${(topSupplyChain.dominanceShare * 100).toFixed(1)}%` : "--"} />
```

Note: also renamed the label from "Top Chain Dominance" to "Top Chain" for clarity since the value shows both name and share.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/app/chains/client.tsx
git commit -m "fix(chains): use explicit sort for top chain KPI"
```

---

### Task 11: Fix backing type defaults

When a stablecoin has no `backing` metadata (not in `TRACKED_META_BY_ID`), both the aggregator and the profile client default it to `"rwa-backed"`. This skews the backing diversity score and UI breakdown. Fix by:
- Aggregator: exclude unclassified coins from the 3-type backing distribution used for health scoring
- Client: show unclassified as a separate "Other" segment

**Files:**
- Modify: `shared/lib/chain-aggregator.ts:119-127`
- Modify: `shared/lib/__tests__/chain-aggregator.test.ts`
- Modify: `src/app/chains/[chain]/client.tsx` (BackingBreakdown)

- [ ] **Step 1: Write a test for the aggregator backing fix**

In `shared/lib/__tests__/chain-aggregator.test.ts`, add a new test. This test file uses the **real** `TRACKED_META_BY_ID` (no mocks). `dai-makerdao` is a real tracked stablecoin with `flags.backing = "crypto-backed"`. The `unknown-coin` ID doesn't exist in the registry, so `TRACKED_META_BY_ID.get("unknown-coin")` returns `undefined` — making it an unclassified coin:

```ts
it("excludes unclassified coins from backing distribution used in health score", () => {
  // If we have one crypto-backed and one unclassified coin with equal supply,
  // the diversity score should be 0 (monoculture of crypto-backed)
  // NOT some positive value from a fake rwa-backed/crypto-backed split.
  const input = makeInput({
    peggedAssets: [
      {
        id: "dai-makerdao", symbol: "DAI", price: 1.0, pegType: "peggedUSD",
        chainCirculating: { ethereum: { current: 500, circulatingPrevDay: 500, circulatingPrevWeek: 500, circulatingPrevMonth: 500 } },
      },
      {
        id: "unknown-coin", symbol: "UNK", price: 1.0, pegType: "peggedUSD",
        chainCirculating: { ethereum: { current: 500, circulatingPrevDay: 500, circulatingPrevWeek: 500, circulatingPrevMonth: 500 } },
      },
    ],
    safetyScores: { "dai-makerdao": 60 },
    pegRates: { peggedUSD: 1 },
  });
  const result = aggregateChains(input);
  const eth = result.chains.find((c) => c.id === "ethereum")!;
  // DAI = crypto-backed. unknown-coin has no metadata → should be excluded from backing dist.
  // Result: monoculture of crypto-backed → diversity = 0
  expect(eth.healthFactors.backingDiversity).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared/lib/__tests__/chain-aggregator.test.ts`
Expected: FAIL — currently unknown-coin defaults to "rwa-backed", creating a 50/50 rwa/crypto split with a positive diversity score instead of the expected 0.

- [ ] **Step 3: Fix the aggregator**

In `shared/lib/chain-aggregator.ts`, change the backing accumulation (around lines 119-123):

```ts
// Before:
const backingTotals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0 };
for (const coin of acc.coins) {
  const key = coin.backing ?? "rwa-backed";
  backingTotals[key] = (backingTotals[key] ?? 0) + coin.supplyUsd;
}

// After:
const backingTotals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0 };
for (const coin of acc.coins) {
  if (coin.backing && coin.backing in backingTotals) {
    backingTotals[coin.backing] += coin.supplyUsd;
  }
}
```

This only counts coins with a known backing type in the 3-type distribution. Unclassified coins are excluded from the health score's backing diversity factor.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- shared/lib/__tests__/chain-aggregator.test.ts`
Expected: All PASS.

- [ ] **Step 5: Fix the client-side backing breakdown**

In `src/app/chains/[chain]/client.tsx`, in the `BackingBreakdown` component (around line 196-200):

```ts
// Before:
const totals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0 };
for (const coin of coins) {
  const key = coin.backing ?? "rwa-backed";
  totals[key] = (totals[key] ?? 0) + coin.supplyOnChain;
}

// After:
const totals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0, other: 0 };
for (const coin of coins) {
  const key = coin.backing && coin.backing in totals ? coin.backing : "other";
  totals[key] += coin.supplyOnChain;
}
```

Add "other" to `BACKING_BAR_COLORS` (around line 30):
```ts
const BACKING_BAR_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500",
  "crypto-backed": "bg-violet-500",
  algorithmic: "bg-amber-500",
  other: "bg-zinc-400",
};
```

Also ensure `BACKING_LABELS_SHORT` has an entry for "other". Check `shared/lib/classification.ts` — if it doesn't, add a fallback in the legend render:
```tsx
<span>{BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? (type === "other" ? "Other" : type)}</span>
```

- [ ] **Step 6: Verify build + tests**

Run: `npm test && npm run build`
Expected: All pass, clean build.

- [ ] **Step 7: Commit**

```bash
git add shared/lib/chain-aggregator.ts shared/lib/__tests__/chain-aggregator.test.ts src/app/chains/[chain]/client.tsx
git commit -m "fix(chains): exclude unclassified coins from backing diversity calculation"
```

---

### Task 12: Improve treemap layout for edge cases

The composition treemap grid breaks on chains with 1-2 stablecoins. When the dominant coin is > 40%, it spans 2 columns and 2 rows in a 3-column grid, leaving awkward gaps.

**Files:**
- Modify: `src/app/chains/[chain]/client.tsx` (CompositionSection)

- [ ] **Step 1: Simplify the treemap for small coin counts**

In the `CompositionSection` component (around line 146), add a guard for small counts and simplify the span logic:

```tsx
{/* Treemap-like blocks */}
<div
  className={cn(
    "grid gap-1.5 auto-rows-fr",
    top5.length <= 2 ? "grid-cols-2" : "grid-cols-3",
  )}
  style={{ minHeight: "200px" }}
>
  {top5.map((coin) => {
    const pct = totalUsd > 0 ? coin.supplyOnChain / totalUsd : 0;
    const shouldSpan = top5.length > 2 && pct > 0.4;
    return (
      <Link
        key={coin.id}
        href={buildStablecoinUrl(coin.id)}
        className="flex flex-col items-center justify-center rounded-lg border bg-muted/30 p-2 text-center text-xs hover:bg-muted/50 transition-colors"
        style={{
          gridColumn: shouldSpan ? "span 2" : undefined,
          gridRow: shouldSpan ? "span 2" : undefined,
        }}
      >
        <span className="font-semibold">{coin.symbol}</span>
        <span className="text-muted-foreground">{(pct * 100).toFixed(1)}%</span>
        <span className="font-mono text-[10px]">{formatChainUsd(coin.supplyOnChain)}</span>
      </Link>
    );
  })}
  {rest.length > 0 && (
    <div className="flex flex-col items-center justify-center rounded-lg border bg-muted/20 p-2 text-center text-xs">
      <span className="text-muted-foreground">{rest.length} others</span>
      <span className="font-mono text-[10px]">{formatChainUsd(restTotal)}</span>
    </div>
  )}
</div>
```

Key changes:
- `grid-cols-2` when there are 1-2 coins (avoids empty columns)
- `shouldSpan` only applies when there are > 2 coins (avoids spanning in a 2-col grid)

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/app/chains/[chain]/client.tsx
git commit -m "fix(chains): improve treemap layout for chains with few stablecoins"
```

---

## Chunk 5: Polish & Documentation

### Task 13: Export health weights for dynamic labels

The profile's `HealthBreakdownCard` hardcodes weight percentages as strings ("Quality (30%)"). Export the weight constants from `chain-health.ts` so the labels stay in sync with the algorithm.

**Files:**
- Modify: `shared/lib/chain-health.ts:6-10`
- Modify: `src/app/chains/[chain]/client.tsx`

- [ ] **Step 1: Export the weight constants**

In `shared/lib/chain-health.ts`, change lines 6-10 from `const` to `export const`:

```ts
export const QUALITY_WEIGHT = 0.30;
export const CHAIN_ENVIRONMENT_WEIGHT = 0.20;
export const CONCENTRATION_WEIGHT = 0.20;
export const PEG_STABILITY_WEIGHT = 0.20;
export const BACKING_DIVERSITY_WEIGHT = 0.10;
```

- [ ] **Step 2: Use dynamic labels in the profile**

In `src/app/chains/[chain]/client.tsx`, add import:
```ts
import {
  QUALITY_WEIGHT,
  CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT,
  PEG_STABILITY_WEIGHT,
  BACKING_DIVERSITY_WEIGHT,
} from "@shared/lib/chain-health";
```

Update the `HealthBreakdownCard` factor gauges (around lines 121-125). Use `Math.round()` to avoid IEEE 754 floating-point artifacts (e.g., `0.10 * 100` = `10.000000000000002`):
```tsx
<FactorGauge label={`Quality (${Math.round(QUALITY_WEIGHT * 100)}%)`} score={healthFactors.quality} />
<FactorGauge label={`Chain Environment (${Math.round(CHAIN_ENVIRONMENT_WEIGHT * 100)}%)`} score={healthFactors.chainEnvironment} />
<FactorGauge label={`Concentration (${Math.round(CONCENTRATION_WEIGHT * 100)}%)`} score={healthFactors.concentration} />
<FactorGauge label={`Peg Stability (${Math.round(PEG_STABILITY_WEIGHT * 100)}%)`} score={healthFactors.pegStability} />
<FactorGauge label={`Backing Diversity (${Math.round(BACKING_DIVERSITY_WEIGHT * 100)}%)`} score={healthFactors.backingDiversity} />
```

- [ ] **Step 3: Verify build + tests**

Run: `npm test && npm run build`
Expected: All pass, clean build (exporting existing constants can't break existing tests).

- [ ] **Step 4: Commit**

```bash
git add shared/lib/chain-health.ts src/app/chains/[chain]/client.tsx
git commit -m "refactor(chains): derive health weight labels from exported constants"
```

---

### Task 14: Update documentation

Update `docs/chains-page.md` to reflect all the changes made.

**Files:**
- Modify: `docs/chains-page.md`

- [ ] **Step 1: Update the doc**

Key additions/changes:
1. Under "Route Shape", add `src/lib/chain-ui.ts` as shared chain formatting/color utilities.
2. Under "Route Shape", note that `getActiveChainIds` now lives in `shared/lib/chains.ts`.
3. Under "Chain Health Score", note that backing diversity excludes unclassified coins.
4. Under "`/chains/` Contract", note that error states use `QueryErrorNotice` with retry and `StaleDataBanner`.
5. Under "`/chains/[chain]/` Contract", note the `BackingBreakdown` uses an "Other" bucket for unclassified coins.
6. Under "Update Rules", add `src/lib/chain-ui.ts` as a file to update when health band colors change.

- [ ] **Step 2: Verify no other docs need updates**

Check if `docs/api-reference.md` mentions the chains endpoint — if so, verify it's still accurate (no API response shape changed).

- [ ] **Step 3: Commit**

```bash
git add docs/chains-page.md
git commit -m "docs: update chains-page.md with audit remediation changes"
```

---

### Task 15: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 2: Run full build**

Run: `npm run build`
Expected: Clean build with no errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No new warnings/errors.

- [ ] **Step 4: Run doc count check**

Run: `npm run check:doc-counts`
Expected: Pass (no stablecoin count changes made).

- [ ] **Step 5: Visual check (dev server)**

Run: `npm run dev`
- Visit `/chains/` — verify KPI strip, table sorting, skeleton loading, error retry
- Visit `/chains/ethereum/` — verify hero card dark mode colors, health weight labels, treemap, backing breakdown "Other" bucket
- Visit `/chains/aptos/` — verify darkInvert logo is visible in dark mode
- Check a small chain (few stablecoins) — verify treemap doesn't break

- [ ] **Step 6: Final commit if any fixups needed**

```bash
git add -A && git commit -m "chore: chains audit remediation fixups"
```
