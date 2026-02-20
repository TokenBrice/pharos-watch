# Comparison Page + Skeleton Transitions + Prefetch on Hover

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a stablecoin comparison page (`/compare/`), smooth skeleton-to-content transitions across all loading states, and prefetch detail page data on hover for instant navigation.

**Architecture:** The comparison page is a new route with client-side coin selection (URL-synced via `?coins=usdt,usdc,dai`), reusing existing hooks and a new overlaid Recharts chart component. Skeleton transitions use `tw-animate-css` (already imported). Prefetch uses TanStack Query's `prefetchQuery` with a shared hook and 100ms debounce.

**Tech Stack:** Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, Recharts.

**Important constraints:**
- Never commit or push — user handles all git operations
- Tailwind classes must be static strings (never construct dynamically)
- Supply helpers: `getCirculatingRaw/USD()` from `src/lib/supply.ts`
- Hook timing: `staleTime = cron interval`, `refetchInterval = 2x`
- `tw-animate-css` is already imported in `globals.css` — `animate-in`, `fade-in`, `duration-300` classes are available
- No new API endpoints needed — all data from existing hooks/endpoints

---

## Phase 1: Skeleton-to-Content Transitions (#5)

### Task 1: Audit and fix skeleton dimensions + add fade-in transitions

**Files:**
- Modify: `src/components/market-pulse.tsx`
- Modify: `src/components/stablecoin-table.tsx`
- Modify: `src/components/peg-heatmap.tsx`
- Modify: `src/components/total-mcap-chart.tsx`
- Modify: `src/components/peg-leaderboard.tsx`
- Modify: `src/components/market-highlights.tsx`
- Modify: `src/components/daily-digest.tsx`

**What to do:**

For each component that has a skeleton/loading branch, make two changes:

**A) Fade-in on loaded content:** Wrap the data-loaded content (the non-skeleton branch) in a `<div className="animate-in fade-in duration-300">`. This prevents the hard visual "pop" when data arrives.

Example pattern (apply to every component with a skeleton):
```tsx
// BEFORE:
if (!data) return <Skeleton ... />;
return <div>...real content...</div>;

// AFTER:
if (!data) return <Skeleton ... />;
return <div className="animate-in fade-in duration-300">...real content...</div>;
```

**B) Match skeleton dimensions to content:** Review each skeleton and adjust if visibly off. The key fixes:

- **`market-pulse.tsx`**: Skeleton is already well-matched (3-zone grid). Add `py-6` to skeleton CardContent to match the loaded state.
- **`stablecoin-table.tsx`**: Skeleton renders 10 rows. This is fine — matches the paginated page size. No dimension changes needed.
- **`peg-heatmap.tsx`**: Skeleton renders 30 tiles. This is reasonable. No changes needed.
- **`total-mcap-chart.tsx`**: Skeleton is `h-[250px] sm:h-[350px]`. Matches the chart container. No changes needed.
- **`peg-leaderboard.tsx`**: Skeleton renders 8 rows of `h-9`. Fine. No changes needed.
- **`market-highlights.tsx`**: Skeleton renders 2 cards with 4 lines each. Fine. No changes needed.
- **`daily-digest.tsx`**: Skeleton renders 3 lines in a dashed card. Fine. No changes needed.

So the main work is adding `animate-in fade-in duration-300` to each loaded-content wrapper.

**Components to modify and their fade-in insertion points:**

1. **`market-pulse.tsx`** — In the `MarketPulse` export, wrap the returned `<Card>` (line ~393) in a div with `animate-in fade-in duration-300`
2. **`stablecoin-table.tsx`** — Find the non-skeleton return path and add the fade-in wrapper around the table container
3. **`peg-heatmap.tsx`** — Find the non-skeleton return and wrap
4. **`total-mcap-chart.tsx`** — Find the non-skeleton chart render and wrap
5. **`peg-leaderboard.tsx`** — Find the non-skeleton return and wrap
6. **`market-highlights.tsx`** — In the `MarketHighlights` export, wrap the returned grid div
7. **`daily-digest.tsx`** — Wrap the loaded card (the non-skeleton, non-null return)

**Important:** The fade-in wrapper should be the outermost element of the loaded content, NOT inside a Card. If the component returns a Card, wrap the Card. This ensures the entire content block fades in together.

**Do NOT add fade-in to:**
- The skeleton itself (it should appear instantly)
- Components that don't have a skeleton branch (they always render)

**Verify:** `npm run build` succeeds. Dev server → load homepage → content should fade in smoothly rather than popping.

---

## Phase 2: Prefetch on Hover (#6)

### Task 2: Create the `usePrefetchStablecoin` hook

**Files:**
- Create: `src/hooks/use-prefetch-stablecoin.ts`

**What to do:**

Create a shared hook that returns a debounced prefetch function. When called with a coin ID, it prefetches the 3 coin-specific queries that the detail page needs.

```tsx
"use client";

import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { CRON_5MIN, CRON_1H } from "@/hooks/use-api-query";

const DEBOUNCE_MS = 100;

export function usePrefetchStablecoin() {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (coinId: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const fetchJson = (path: string) =>
          fetch(`${API_BASE}${path}`).then((r) => r.json());

        queryClient.prefetchQuery({
          queryKey: ["supply-history", coinId],
          queryFn: () =>
            fetchJson(
              `/api/supply-history?stablecoin=${encodeURIComponent(coinId)}&days=1825`
            ),
          staleTime: CRON_1H,
        });

        queryClient.prefetchQuery({
          queryKey: ["depeg-events", coinId],
          queryFn: () =>
            fetchJson(
              `/api/depeg-events?stablecoin=${encodeURIComponent(coinId)}`
            ),
          staleTime: CRON_5MIN,
        });

        queryClient.prefetchQuery({
          queryKey: ["dex-liquidity-history", coinId, 90],
          queryFn: () =>
            fetchJson(
              `/api/dex-liquidity-history?stablecoin=${encodeURIComponent(coinId)}&days=90`
            ),
          staleTime: CRON_1H,
        });
      }, DEBOUNCE_MS);
    },
    [queryClient]
  );
}
```

**Key design choices:**
- 100ms debounce via `setTimeout` — avoids firing on fast mouse sweeps across table rows
- Matches exact query keys from the detail page hooks so TanStack Query dedup works
- `staleTime` matches the hooks so prefetched data is considered fresh when the detail page mounts
- Only prefetches the 3 **coin-specific** queries (supply-history, depeg-events, dex-liquidity-history). The global queries (stablecoins, peg-summary, bluechip-ratings, dex-liquidity) are already cached from the homepage.

**Verify:** `npm run build` succeeds.

---

### Task 3: Add prefetch to stablecoin-table coin links

**Files:**
- Modify: `src/components/stablecoin-table.tsx`

**What to do:**

1. Import the hook: `import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";`
2. Call it in the component: `const prefetch = usePrefetchStablecoin();`
3. Add `onMouseEnter` to the `<Link>` that wraps the coin name (around line 288):

```tsx
<Link
  href={`/stablecoin/${coin.id}`}
  className="flex items-center gap-2 font-medium hover:underline"
  onClick={(e) => e.stopPropagation()}
  onMouseEnter={() => prefetch(coin.id)}
>
```

4. Also add `onMouseEnter` to the `<TableRow>` that has the `onClick` handler (around line 279), since the entire row is clickable:

```tsx
<TableRow
  key={coin.id}
  className="cursor-pointer hover:bg-accent/50 transition-colors"
  onClick={() => router.push(`/stablecoin/${coin.id}`)}
  onMouseEnter={() => prefetch(coin.id)}
  ...
>
```

**Verify:** `npm run build` succeeds.

---

### Task 4: Add prefetch to peg-heatmap tile links

**Files:**
- Modify: `src/components/peg-heatmap.tsx`

**What to do:**

The heatmap tiles are already wrapped in `<Link href={/stablecoin/${coin.id}}>`. Add prefetch:

1. Import the hook: `import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";`
2. Call it in the component: `const prefetch = usePrefetchStablecoin();`
3. Add `onMouseEnter` to each tile `<Link>`:

```tsx
<Link
  href={`/stablecoin/${coin.id}`}
  onMouseEnter={() => prefetch(coin.id)}
  ...
>
```

**Verify:** `npm run build` succeeds.

---

### Task 5: Add prefetch to peg-leaderboard, depeg-feed, and liquidity-table

**Files:**
- Modify: `src/components/peg-leaderboard.tsx`
- Modify: `src/components/depeg-feed.tsx`
- Modify: `src/components/liquidity-table.tsx`

**What to do:**

Same pattern for each:

1. Import `usePrefetchStablecoin`
2. Call the hook
3. Add `onMouseEnter` to each coin `<Link>` or clickable row

**Specific locations:**

- **`peg-leaderboard.tsx`**: The `<Link>` wrapping the coin cell (around the sticky left column). Add `onMouseEnter`.
- **`depeg-feed.tsx`**: The `<Link>` wrapping each feed event card. The link uses `evt.stablecoinId` — add `onMouseEnter={() => prefetch(evt.stablecoinId)}`.
- **`liquidity-table.tsx`**: This uses an `onRowClick` callback instead of `<Link>`. Find where coin navigation happens and add `onMouseEnter` to the `<TableRow>`. The coin ID will be available in the row data.

**Verify:** `npm run build` succeeds.

---

### Task 6: Add prefetch to market-pulse activity ticker (bonus)

**Files:**
- Modify: `src/components/market-pulse.tsx`

**What to do:**

The Activity Ticker in Zone 3 currently renders plain text items. These aren't links yet — but they reference specific stablecoins. This is optional: only do it if the ticker items can be made into links. If not practical (the ticker combines blacklist events which use stablecoin names, not IDs), skip this task.

Check if blacklist events in the ticker have a stablecoin ID available. If yes, wrap in a `<Link>` with prefetch. If only stablecoin name/symbol is available without an ID, skip.

**Verify:** `npm run build` succeeds.

---

## Phase 3: Comparison Page (#3)

### Task 7: Create the comparison page server component

**Files:**
- Create: `src/app/compare/page.tsx`

**What to do:**

```tsx
import type { Metadata } from "next";
import { Suspense } from "react";
import { CompareClient } from "./client";

export const metadata: Metadata = {
  title: "Compare Stablecoins",
  description:
    "Side-by-side comparison of stablecoin stats, supply history, and peg stability.",
  alternates: { canonical: "https://pharos.watch/compare/" },
};

export default function ComparePage() {
  return (
    <>
      <div className="space-y-2 mb-6">
        <h1 className="text-3xl font-bold tracking-tight">
          Compare Stablecoins
        </h1>
        <p className="text-muted-foreground">
          Select up to 3 stablecoins to compare side-by-side.
        </p>
      </div>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <div className="h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse" />
          </div>
        }
      >
        <CompareClient />
      </Suspense>
    </>
  );
}
```

**Verify:** `npm run build` succeeds (will fail until client component exists — create both in same task or stub the client).

---

### Task 8: Create the coin selector component

**Files:**
- Create: `src/components/coin-selector.tsx`

**What to do:**

Build a combobox coin selector slot. When empty, shows "Add stablecoin..." placeholder with a search input. When filled, shows the selected coin with a remove button.

**Props:**
```tsx
interface CoinSelectorProps {
  coins: { id: string; name: string; symbol: string }[];
  selected: string | null; // coin ID
  logos?: Record<string, string>;
  onSelect: (id: string) => void;
  onRemove: () => void;
}
```

**Behavior:**
- Empty state: Render a button/card that opens a search dropdown on click
- Search: Filter `coins` array by name or symbol (case-insensitive)
- Dropdown items: Show logo + name + symbol for each match
- Selecting a coin calls `onSelect(id)` and closes the dropdown
- Filled state: Show logo + name + symbol + X button to remove
- Use shadcn `Popover` + `Command` (cmdk) for the combobox pattern, OR keep it simple with a custom dropdown

**Implementation approach — use shadcn Popover + Command:**

First check if `src/components/ui/command.tsx` and `src/components/ui/popover.tsx` exist (they're part of shadcn). If not, we need to create them using `npx shadcn@latest add command popover`.

If they exist, use them:
```tsx
<Popover>
  <PopoverTrigger asChild>
    <Button variant="outline" className="...">
      {selected ? <SelectedDisplay /> : "Add stablecoin..."}
    </Button>
  </PopoverTrigger>
  <PopoverContent>
    <Command>
      <CommandInput placeholder="Search..." />
      <CommandList>
        <CommandEmpty>No results</CommandEmpty>
        <CommandGroup>
          {filtered.map(coin => (
            <CommandItem key={coin.id} onSelect={() => onSelect(coin.id)}>
              <StablecoinLogo ... /> {coin.name} ({coin.symbol})
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  </PopoverContent>
</Popover>
```

If they DON'T exist, use a simple custom implementation with Popover-like behavior (div with absolute positioning, input filter, click-outside close). Don't install new shadcn components unless they already exist.

**Verify:** `npm run build` succeeds.

---

### Task 9: Create the comparison table component

**Files:**
- Create: `src/components/comparison-table.tsx`

**What to do:**

A table with metrics as rows, selected coins as columns. Color-code the "best" value per row.

**Props:**
```tsx
interface ComparisonTableProps {
  coins: {
    id: string;
    symbol: string;
    name: string;
    data: StablecoinData;
    meta: StablecoinMeta;
    pegScore: number | null;
    liquidityScore: number | null;
    bluechipGrade: string | null;
  }[];
  pegRates: Record<string, number>;
  logos?: Record<string, string>;
}
```

**Rows to display:**

| Metric | Source | "Best" = |
|--------|--------|----------|
| Price | `data.price` + `formatNativePrice()` | Closest to peg reference |
| Peg Score | `pegScore` | Highest |
| Market Cap | `getCirculatingRaw(data)` + `formatCurrency()` | Highest |
| 7d Change | `(current - prevWeek) / prevWeek * 100` | N/A (neutral) |
| Liquidity Score | `liquidityScore` | Highest |
| Governance | `meta.flags.governance` | N/A (categorical) |
| Backing | `meta.flags.backing` | N/A (categorical) |
| Peg Currency | `meta.flags.pegCurrency` | N/A (categorical) |
| Bluechip Rating | `bluechipGrade` | Best grade (A+ > A > B+ ...) |

**Best value highlighting:** For numeric rows where "best" applies, add `text-green-500 font-semibold` to the best value cell. Use `GRADE_ORDER` from `src/lib/bluechip.ts` for comparing bluechip grades.

**Layout:** Standard HTML table with responsive horizontal scroll on mobile.

**Verify:** `npm run build` succeeds.

---

### Task 10: Create the comparison chart component

**Files:**
- Create: `src/components/comparison-chart.tsx`

**What to do:**

A reusable Recharts overlay chart used for both supply history and depeg deviation. Multiple series (one per selected coin) with distinct colors.

**Props:**
```tsx
interface ComparisonChartProps {
  title: string;
  series: {
    id: string;
    label: string;
    data: { ts: number; value: number }[];
    color: string;
  }[];
  formatValue?: (v: number) => string;
  normalized?: boolean; // If true, normalize each series to 100 at start
  referenceLine?: number; // Optional horizontal reference line (e.g., 0 for deviation)
}
```

**Color palette for coins:** Use 3 distinct colors: `#3b82f6` (blue), `#10b981` (emerald), `#f59e0b` (amber). Assign by index in the selected coins array.

**Chart implementation:**
- Use Recharts `LineChart` (not AreaChart) for multi-series overlay — cleaner with multiple lines
- `ResponsiveContainer` wrapping `LineChart`
- One `<Line>` per series with `type="monotone"`, `dot={false}`, `strokeWidth={2}`
- Shared `XAxis` with date formatting, `YAxis` with value formatting
- `Tooltip` showing all series values at the hovered timestamp
- Optional `ReferenceLine` at y=0 for deviation charts

**Normalization logic:**
When `normalized=true`, transform each series so the first data point = 100:
```tsx
const baseValue = series.data[0].value;
normalized = series.data.map(d => ({ ts: d.ts, value: (d.value / baseValue) * 100 }));
```

**Time range:** Reuse `useTimeRangeFilter` and `TimeRangeButtons` from existing components.

**Data merging for tooltip:** Recharts works best with a single data array. Merge all series into one array keyed by timestamp, with one field per coin. Use a `useMemo` to build this merged array.

**Height:** `h-[300px] sm:h-[400px]`

**Verify:** `npm run build` succeeds.

---

### Task 11: Create the comparison page client component

**Files:**
- Create: `src/app/compare/client.tsx`

**What to do:**

The main client component that orchestrates coin selection, URL sync, data fetching, and renders the comparison table + charts.

**State management:**
- Selected coins stored as array of IDs: `string[]` (max 3)
- Synced to URL: `?coins=usdt,usdc,dai` (uses symbol, lowercased)
- On mount, parse `?coins=` from URL, look up IDs by symbol from `TRACKED_STABLECOINS`
- On change, update URL via `router.replace()` without scroll

**Data fetching:**
- `useStablecoins()` — global data (already cached from homepage likely)
- `usePegSummary()` — peg scores per coin
- `useBluechipRatings()` — bluechip grades
- `useDexLiquidity()` — liquidity scores
- For each selected coin: `useSupplyHistory(id)` — need to call per-coin

**Challenge: calling hooks per-coin**
React hooks can't be called conditionally or in loops. Solutions:
- **Option A:** Create a wrapper component `<CoinDataProvider coinId={id}>` that calls the per-coin hooks and passes data up via callback or context.
- **Option B (simpler):** Always render 3 hook-calling components (even if slots are empty), using `enabled: !!coinId` to skip fetch for empty slots.
- **Option C (recommended):** Use `useQueries` from TanStack Query to fetch multiple queries dynamically.

**Go with Option C:**
```tsx
import { useQueries } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { CRON_1H } from "@/hooks/use-api-query";

const supplyQueries = useQueries({
  queries: selectedIds.map((id) => ({
    queryKey: ["supply-history", id],
    queryFn: () =>
      fetch(`${API_BASE}/api/supply-history?stablecoin=${encodeURIComponent(id)}&days=1825`)
        .then((r) => r.json()),
    staleTime: CRON_1H,
    enabled: !!id,
  })),
});
```

**Layout:**
```
┌─────────────────────────────────────────┐
│ [Coin Selector 1] [Coin Selector 2] [Coin Selector 3] │
├─────────────────────────────────────────┤
│ Comparison Table (metrics × coins)      │
├─────────────────────────────────────────┤
│ Supply History Chart (overlaid)         │
│ [Normalize toggle] [Time range buttons] │
├─────────────────────────────────────────┤
│ Depeg Events Chart (overlaid)           │
│ [Time range buttons]                    │
└─────────────────────────────────────────┘
```

Show comparison sections only when at least 2 coins are selected. With 0-1 coins, show a prompt message.

**Supply chart data:** For each selected coin, map `useSupplyHistory` data to `{ ts: date * 1000, value: circulatingUsd }`.

**Depeg chart data:** This is trickier — `useDepegEvents` returns discrete events, not a continuous deviation time series. The peg-summary has `currentDeviationBps` but not historical. Options:
- Skip the depeg deviation chart for now (there's no continuous deviation history API)
- OR use the depeg events to plot event markers rather than a continuous line

**Decision: Skip the continuous depeg deviation chart.** The data doesn't exist as a time series. Instead, show a simplified depeg event timeline — a table/list of depeg events for the selected coins, sorted by date. This reuses `useDepegEvents` per coin.

**Verify:** `npm run build` succeeds. Navigate to `/compare/` — page renders with coin selectors.

---

### Task 12: Add "Compare" entry points

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx` — add "Compare with..." button
- Modify: `src/components/stablecoin-table.tsx` — add compare action (optional, deferred)

**What to do:**

**Detail page button:** Add a small "Compare" button in the detail page header area (near the breadcrumb or coin title). When clicked, navigates to `/compare/?coins={symbol}` with the current coin pre-selected.

Find a good insertion point in `src/app/stablecoin/[id]/client.tsx`. The breadcrumb area (with the `<ArrowLeft>` back button) is a natural spot. Add a button next to it:

```tsx
import { ArrowLeftRight } from "lucide-react";

<Link
  href={`/compare/?coins=${meta.symbol.toLowerCase()}`}
  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
>
  <ArrowLeftRight className="h-3.5 w-3.5" />
  Compare
</Link>
```

**Do NOT add to the main navigation.** Per the design doc recommendation (option B), keep the nav clean. The compare page is discoverable via detail page buttons and direct URL.

**Verify:** `npm run build` succeeds. Detail page shows a "Compare" link that navigates to `/compare/?coins={symbol}`.

---

## Phase 4: Verification

### Task 13: Full build verification and visual check

**Files:** None — verification task

**What to do:**
1. `npm run build` — must pass with zero errors
2. Dev server (`npm run dev`) visual checks:
   - Homepage: content fades in smoothly on load (no hard pop)
   - Hover coin in table → wait 1s → click → detail page loads with data pre-populated (check network tab — no new fetches for supply-history/depeg-events/dex-liquidity-history)
   - Hover heatmap tile → same prefetch behavior
   - `/compare/` — select 2 coins → comparison table renders, supply chart overlays both series
   - `/compare/?coins=usdt,usdc` — page loads with coins pre-selected from URL
   - Detail page → "Compare" link → navigates to compare with coin pre-selected
   - Mobile responsive: compare page stacks selectors vertically, charts render full-width

---

## File Summary

| Action | File | Phase |
|--------|------|-------|
| Modify | `src/components/market-pulse.tsx` | 1 (fade-in) |
| Modify | `src/components/stablecoin-table.tsx` | 1 (fade-in) + 2 (prefetch) |
| Modify | `src/components/peg-heatmap.tsx` | 1 (fade-in) + 2 (prefetch) |
| Modify | `src/components/total-mcap-chart.tsx` | 1 (fade-in) |
| Modify | `src/components/peg-leaderboard.tsx` | 1 (fade-in) + 2 (prefetch) |
| Modify | `src/components/market-highlights.tsx` | 1 (fade-in) |
| Modify | `src/components/daily-digest.tsx` | 1 (fade-in) |
| Create | `src/hooks/use-prefetch-stablecoin.ts` | 2 |
| Modify | `src/components/depeg-feed.tsx` | 2 (prefetch) |
| Modify | `src/components/liquidity-table.tsx` | 2 (prefetch) |
| Create | `src/app/compare/page.tsx` | 3 |
| Create | `src/app/compare/client.tsx` | 3 |
| Create | `src/components/coin-selector.tsx` | 3 |
| Create | `src/components/comparison-table.tsx` | 3 |
| Create | `src/components/comparison-chart.tsx` | 3 |
| Modify | `src/app/stablecoin/[id]/client.tsx` | 3 (compare link) |
