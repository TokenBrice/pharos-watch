# Compare Feature Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve the compare feature with better UX, accessibility, additional charts, and mobile support.

**Architecture:** All changes are frontend-only — no API/worker changes needed. Price history is already available in the stablecoin-detail endpoint (`totalCirculatingUSD / totalCirculating` gives price). Changes span the compare page client, comparison table, comparison chart, and coin selector components.

**Tech Stack:** React 19, Next.js 16, TypeScript strict, Tailwind CSS v4, Recharts, TanStack Query

---

### Task 1: Remove "best" highlight from Market Cap

**Files:**
- Modify: `src/components/comparison-table.tsx:128` (remove `bestMarketCap` computation)
- Modify: `src/components/comparison-table.tsx:210-217` (remove conditional class)

**Step 1: Remove bestMarketCap from rowData**

In `src/components/comparison-table.tsx`, remove the `bestMarketCap` computation and usage:

```typescript
// In the useMemo (line ~128), DELETE this line:
const bestMarketCap = bestHighestIndex(marketCaps);

// In the return object (line ~133), DELETE this property:
bestMarketCap,
```

**Step 2: Remove highlight class from Market Cap cells**

In the Market Cap `<TableRow>` (line ~210), change the `className` from:
```tsx
className={`text-center font-mono tabular-nums ${i === rowData.bestMarketCap ? BEST_CLASS : ""}`}
```
to:
```tsx
className="text-center font-mono tabular-nums"
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 4: Commit**

```bash
git add src/components/comparison-table.tsx
git commit -m "fix(compare): remove opinionated 'best' highlight from market cap row"
```

---

### Task 2: Increase max coins to 5 and fix URL sync

Two tightly coupled changes: increasing capacity requires the grid to accommodate 5 slots, and fixing URL sync avoids the redundant `router.replace` on mount.

**Files:**
- Modify: `src/app/compare/client.tsx`

**Step 1: Change MAX_COINS and CHART_COLORS**

In `src/app/compare/client.tsx`:

```typescript
// Line 24: change from 3 to 5
const MAX_COINS = 5;

// Line 107: change from 3 to 5
const CHART_COLORS = CHART_PALETTE.slice(0, 5);
```

**Step 2: Fix URL sync — replace bidirectional state with derived state**

Replace the current `useState` + `useEffect` pattern (lines 40-60) with a `useMemo` that reads from `searchParams` plus a setter that writes to the URL:

```typescript
// Replace lines 40-60 with:

// Derive selected IDs from URL (single source of truth)
const selectedIds = useMemo(() => {
  const param = searchParams.get("coins");
  if (!param) return [];
  return param
    .split(",")
    .map((s) => SYMBOL_TO_COIN.get(s.trim().toLowerCase()))
    .filter((c): c is CoinOption => !!c)
    .slice(0, MAX_COINS)
    .map((c) => c.id);
}, [searchParams]);

// Write selected IDs to URL
const setSelectedIds = useCallback(
  (updater: (prev: string[]) => string[]) => {
    const next = updater(selectedIds);
    const symbols = next
      .map((id) => TRACKED_STABLECOINS.find((c) => c.id === id))
      .filter((c): c is (typeof TRACKED_STABLECOINS)[number] => !!c)
      .map((c) => c.symbol.toLowerCase());
    const paramStr = symbols.join(",");
    const newUrl = paramStr ? `/compare/?coins=${paramStr}` : "/compare/";
    router.replace(newUrl, { scroll: false });
  },
  [selectedIds, router],
);
```

Add `useCallback` to the imports from React.

**Step 3: Update grid layout for 5 slots**

Change the grid class (line ~192):

```tsx
// From:
<div className="grid gap-3 sm:grid-cols-3">

// To:
<div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
```

**Step 4: Verify build**

Run: `npm run build`
Expected: Clean build. URL now drives state without redundant replace on mount.

**Step 5: Commit**

```bash
git add src/app/compare/client.tsx
git commit -m "feat(compare): increase max coins to 5, fix URL sync"
```

---

### Task 3: Persist time range in URL

**Files:**
- Modify: `src/app/compare/client.tsx` (pass range prop down, read/write URL param)
- Modify: `src/components/comparison-chart.tsx` (accept controlled range)

**Step 1: Make ComparisonChart accept controlled range**

In `src/components/comparison-chart.tsx`, update the props interface and hook usage:

```typescript
interface ComparisonChartProps {
  title: string;
  series: SeriesData[];
  formatValue?: (v: number) => string;
  range?: TimeRangeOption;
  onRangeChange?: (range: TimeRangeOption) => void;
}
```

Change the `useTimeRangeFilter` usage to respect the controlled `range` prop. The `useTimeRangeFilter` hook uses local state — we need to sync the external prop into it. The simplest approach: if `range` and `onRangeChange` are provided, use them; otherwise fall back to local state.

Replace the `useTimeRangeFilter` call and add a controlled wrapper:

```typescript
const { range: localRange, setRange: setLocalRange, filteredData, options } = useTimeRangeFilter(
  mergedData,
  "ts"
);

const activeRange = range ?? localRange;
const handleRangeChange = onRangeChange ?? setLocalRange;

// We need filteredData to respect activeRange. Since useTimeRangeFilter
// manages its own state, sync it:
useEffect(() => {
  if (range != null && range !== localRange) {
    setLocalRange(range);
  }
}, [range]);
```

Pass `activeRange` and `handleRangeChange` to `TimeRangeButtons`.

**Step 2: Read/write range from URL in client.tsx**

In `src/app/compare/client.tsx`, add range state from URL:

```typescript
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

// After selectedIds derivation:
const range = (searchParams.get("range") as TimeRangeOption) || "all";

const setRange = useCallback(
  (newRange: TimeRangeOption) => {
    const params = new URLSearchParams(searchParams.toString());
    if (newRange === "all") {
      params.delete("range");
    } else {
      params.set("range", newRange);
    }
    const qs = params.toString();
    router.replace(qs ? `/compare/?${qs}` : "/compare/", { scroll: false });
  },
  [searchParams, router],
);
```

Also update `setSelectedIds` to preserve the existing `range` param when updating coins:

```typescript
const setSelectedIds = useCallback(
  (updater: (prev: string[]) => string[]) => {
    const next = updater(selectedIds);
    const symbols = next
      .map((id) => TRACKED_STABLECOINS.find((c) => c.id === id))
      .filter((c): c is (typeof TRACKED_STABLECOINS)[number] => !!c)
      .map((c) => c.symbol.toLowerCase());
    const params = new URLSearchParams();
    if (symbols.length > 0) params.set("coins", symbols.join(","));
    const currentRange = searchParams.get("range");
    if (currentRange) params.set("range", currentRange);
    const qs = params.toString();
    router.replace(qs ? `/compare/?${qs}` : "/compare/", { scroll: false });
  },
  [selectedIds, router, searchParams],
);
```

Pass `range` and `onRangeChange={setRange}` to both `ComparisonChart` instances.

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build. Time range persists in URL, shareable links include range.

**Step 4: Commit**

```bash
git add src/app/compare/client.tsx src/components/comparison-chart.tsx
git commit -m "feat(compare): persist time range in URL query params"
```

---

### Task 4: Add price history chart with peg deviation view

**Files:**
- Modify: `src/hooks/use-stablecoins.ts` (add `detailToPriceHistory` extractor)
- Modify: `src/app/compare/client.tsx` (build price series, render second chart)

**Step 1: Add detailToPriceHistory function**

In `src/hooks/use-stablecoins.ts`, add a new function after `detailToSupplyHistory`:

```typescript
export interface PriceHistoryPoint {
  date: number;       // epoch seconds
  price: number;      // USD price
}

/** Extract historical prices from detail tokens. Price = totalCirculatingUSD / totalCirculating. */
export function detailToPriceHistory(detail: StablecoinDetail | undefined): PriceHistoryPoint[] {
  if (!detail?.tokens) return [];
  return detail.tokens
    .map((t) => {
      const usd = sumCirculating(t.totalCirculatingUSD) || sumCirculating(t.circulating);
      const native = sumCirculating(t.totalCirculating);
      if (usd <= 0 || native <= 0) return null;
      return { date: t.date, price: usd / native };
    })
    .filter((d): d is PriceHistoryPoint => d !== null);
}
```

**Step 2: Build price series in client.tsx**

In `src/app/compare/client.tsx`, add a second `useQueries` call with `detailToPriceHistory` selector (or derive from the same queries). Since `useQueries` already fetches the detail data, we can extract price history from the same query results by calling `detailToPriceHistory` directly on the raw data.

Change the `supplyQueries` to NOT use `select` — instead, keep the raw `StablecoinDetail` and derive both supply and price series from it:

```typescript
const detailQueries = useQueries({
  queries: selectedIds.map((id) => ({
    queryKey: ["stablecoin-detail", id],
    queryFn: () =>
      apiFetch<StablecoinDetail>(`/api/stablecoin/${encodeURIComponent(id)}`),
    staleTime: CRON_1H,
    enabled: !!id,
  })),
});

const supplySeries = useMemo(() => {
  return selectedIds
    .map((id, i) => {
      const detail = detailQueries[i]?.data;
      const history = detailToSupplyHistory(detail);
      if (history.length === 0) return null;
      const meta = TRACKED_META_BY_ID.get(id);
      return {
        id,
        label: meta?.name ?? id,
        data: history.map((d) => ({ ts: d.date * 1000, value: d.circulatingUsd })),
        color: CHART_COLORS[i % CHART_COLORS.length],
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}, [selectedIds, detailQueries]);

const priceSeries = useMemo(() => {
  return selectedIds
    .map((id, i) => {
      const detail = detailQueries[i]?.data;
      const history = detailToPriceHistory(detail);
      if (history.length === 0) return null;
      const meta = TRACKED_META_BY_ID.get(id);
      return {
        id,
        label: meta?.name ?? id,
        data: history.map((d) => ({ ts: d.date * 1000, value: d.price })),
        color: CHART_COLORS[i % CHART_COLORS.length],
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}, [selectedIds, detailQueries]);

const detailLoading = detailQueries.some((q) => q.isLoading);
```

Update the import to include `detailToPriceHistory` and `PriceHistoryPoint`.

**Step 3: Render price chart**

Add a second `ComparisonChart` after the market cap chart:

```tsx
{!detailLoading && priceSeries.length >= 2 && (
  <ComparisonChart
    title="Price History"
    series={priceSeries}
    formatValue={(v) => `$${v.toFixed(4)}`}
    range={range}
    onRangeChange={setRange}
  />
)}
```

**Step 4: Verify build**

Run: `npm run build`
Expected: Clean build. Two charts visible when comparing coins.

**Step 5: Commit**

```bash
git add src/hooks/use-stablecoins.ts src/app/compare/client.tsx
git commit -m "feat(compare): add price history chart"
```

---

### Task 5: Add normalized view toggle to market cap chart

**Files:**
- Modify: `src/components/comparison-chart.tsx` (add normalize toggle + logic)

**Step 1: Add normalize toggle**

Add a `normalizable` boolean prop. When true, show "Absolute" / "Normalized (%)" toggle buttons next to the time range buttons. When normalized, transform each series: `value → ((value / firstValue) - 1) * 100` (percent change from first point).

```typescript
interface ComparisonChartProps {
  title: string;
  series: SeriesData[];
  formatValue?: (v: number) => string;
  range?: TimeRangeOption;
  onRangeChange?: (range: TimeRangeOption) => void;
  normalizable?: boolean;
}
```

Add state and normalization logic:

```typescript
const [normalized, setNormalized] = useState(false);

// Normalize: percent change from first available value per series
const displayData = useMemo(() => {
  if (!normalized || filteredData.length === 0) return filteredData;
  // Find first non-null value for each series
  const firstValues: Record<string, number> = {};
  for (const s of series) {
    for (const row of filteredData) {
      const val = row[s.id];
      if (typeof val === "number" && val > 0) {
        firstValues[s.id] = val;
        break;
      }
    }
  }
  return filteredData.map((row) => {
    const normalized: Record<string, number> = { ts: row.ts };
    for (const s of series) {
      const val = row[s.id];
      const first = firstValues[s.id];
      if (typeof val === "number" && first) {
        normalized[s.id] = ((val / first) - 1) * 100;
      }
    }
    return normalized;
  });
}, [normalized, filteredData, series]);
```

Render toggle buttons in the header next to TimeRangeButtons:

```tsx
<CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
  <CardTitle as="h2">{title}</CardTitle>
  <div className="flex items-center gap-2">
    {normalizable && (
      <div className="flex gap-1">
        <button
          onClick={() => setNormalized(false)}
          aria-pressed={!normalized}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
            !normalized
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          Absolute
        </button>
        <button
          onClick={() => setNormalized(true)}
          aria-pressed={normalized}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
            normalized
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          Normalized %
        </button>
      </div>
    )}
    <TimeRangeButtons options={options} value={activeRange} onChange={handleRangeChange} />
  </div>
</CardHeader>
```

Use `displayData` instead of `filteredData` in the chart. When normalized, override the value formatter to show `+X.X%` / `-X.X%`.

In the chart rendering section, use `displayData` and the appropriate formatter:

```typescript
const activeFormatter = normalized
  ? (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`
  : valueFormatter;
```

Pass `activeFormatter` to the YAxis `tickFormatter` and Tooltip `formatter`.

**Step 2: Pass normalizable={true} for market cap chart**

In `src/app/compare/client.tsx`, add `normalizable` to the market cap chart:

```tsx
<ComparisonChart
  title="Market Cap History"
  series={supplySeries}
  formatValue={formatCurrency}
  range={range}
  onRangeChange={setRange}
  normalizable
/>
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build. Market cap chart has Absolute/Normalized toggle.

**Step 4: Commit**

```bash
git add src/components/comparison-chart.tsx src/app/compare/client.tsx
git commit -m "feat(compare): add normalized percentage view for market cap chart"
```

---

### Task 6: Keyboard navigation in CoinSelector

**Files:**
- Modify: `src/components/coin-selector.tsx`

**Step 1: Add keyboard navigation state and handlers**

Add `focusedIndex` state and arrow key / Enter handling:

```typescript
const [focusedIndex, setFocusedIndex] = useState(-1);
const buttonRef = useRef<HTMLButtonElement>(null);
```

Replace the `handleKeyDown` callback with comprehensive keyboard handling:

```typescript
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent) => {
    if (!open) return;
    switch (e.key) {
      case "Escape":
        setOpen(false);
        setSearch("");
        setFocusedIndex(-1);
        buttonRef.current?.focus();
        e.preventDefault();
        break;
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((prev) => {
          const nextIdx = prev + 1;
          return nextIdx >= filtered.length ? 0 : nextIdx;
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((prev) => {
          const nextIdx = prev - 1;
          return nextIdx < 0 ? filtered.length - 1 : nextIdx;
        });
        break;
      case "Enter": {
        e.preventDefault();
        const target = filtered[focusedIndex];
        if (target && !disabledIds?.has(target.id)) {
          onSelect(target);
          setOpen(false);
          setSearch("");
          setFocusedIndex(-1);
        }
        break;
      }
      case "Tab":
        // Close dropdown on Tab to prevent focus escaping
        setOpen(false);
        setSearch("");
        setFocusedIndex(-1);
        break;
    }
  },
  [open, filtered, focusedIndex, disabledIds, onSelect],
);
```

Note: `filtered` must be computed before `handleKeyDown` is defined. Move the `filtered` computation above the callback (it's currently below the early return for `selected`). Since `filtered` is only used when `!selected`, compute it conditionally or always compute it. The simplest fix: always compute `filtered` before the early return.

**Step 2: Reset focusedIndex on search change**

```typescript
// In the search input onChange:
onChange={(e) => {
  setSearch(e.target.value);
  setFocusedIndex(-1);
}}
```

**Step 3: Add visual focus indicator and aria-activedescendant**

On each `<li>`, add a conditional focus class and an `id`:

```tsx
{filtered.map((coin, idx) => {
  const disabled = disabledIds?.has(coin.id);
  const focused = idx === focusedIndex;
  return (
    <li
      key={coin.id}
      id={`coin-option-${coin.id}`}
      role="option"
      aria-selected={focused}
      aria-disabled={disabled}
      className={
        disabled
          ? "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm opacity-40 cursor-not-allowed"
          : `flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-accent ${focused ? "bg-accent" : ""}`
      }
      ...
    >
```

On the `<ul>`, add `aria-activedescendant`:

```tsx
<ul
  role="listbox"
  aria-activedescendant={focusedIndex >= 0 ? `coin-option-${filtered[focusedIndex]?.id}` : undefined}
  className="max-h-56 overflow-y-auto px-1 pb-1"
>
```

**Step 4: Add ref to trigger button for focus return**

Add `ref={buttonRef}` to the `<Button>` element.

**Step 5: Scroll focused item into view**

Add an effect to scroll the focused item into view:

```typescript
useEffect(() => {
  if (focusedIndex >= 0 && filtered[focusedIndex]) {
    const el = document.getElementById(`coin-option-${filtered[focusedIndex].id}`);
    el?.scrollIntoView({ block: "nearest" });
  }
}, [focusedIndex, filtered]);
```

**Step 6: Verify build**

Run: `npm run build`
Expected: Clean build. Arrow keys, Enter, Escape, Tab all work correctly.

**Step 7: Commit**

```bash
git add src/components/coin-selector.tsx
git commit -m "feat(compare): add keyboard navigation to coin selector dropdown"
```

---

### Task 7: Partial error/loading states

**Files:**
- Modify: `src/app/compare/client.tsx` (track per-coin errors, pass loading state)
- Modify: `src/components/comparison-table.tsx` (show error/loading indicators)

**Step 1: Track per-coin detail query errors in client.tsx**

After `detailQueries`, compute error map:

```typescript
const detailErrors = useMemo(() => {
  const errors: Record<string, boolean> = {};
  selectedIds.forEach((id, i) => {
    if (detailQueries[i]?.isError) errors[id] = true;
  });
  return errors;
}, [selectedIds, detailQueries]);
```

Pass `detailErrors` and `detailLoading` to `ComparisonTable`:

```tsx
<ComparisonTable
  coins={comparisonCoins}
  pegRates={pegRates}
  logos={logos}
  detailErrors={detailErrors}
  loading={detailLoading}
/>
```

**Step 2: Update ComparisonTable props and rendering**

Add to the props interface:

```typescript
interface ComparisonTableProps {
  coins: ComparisonCoin[];
  pegRates: Record<string, number>;
  logos?: Record<string, string>;
  detailErrors?: Record<string, boolean>;
  loading?: boolean;
}
```

When a coin has an error, show a small warning indicator in the header:

```tsx
{coins.map((coin) => (
  <TableHead key={coin.id} className="text-center min-w-[120px]">
    <div className="flex flex-col items-center gap-1">
      <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={28} />
      <span className="text-xs font-semibold">{coin.symbol}</span>
      <span className="text-xs text-muted-foreground font-normal">{coin.name}</span>
      {detailErrors?.[coin.id] && (
        <span className="text-xs text-destructive">Chart data unavailable</span>
      )}
    </div>
  </TableHead>
))}
```

**Step 3: Show skeleton in chart area during partial loading**

In `client.tsx`, show the chart skeleton only while loading, and show charts even if some series are missing (the chart already handles this by filtering null series):

```tsx
{detailLoading ? (
  <Skeleton className="h-[300px] sm:h-[400px] rounded-2xl" />
) : (
  <>
    {supplySeries.length >= 2 && (
      <ComparisonChart
        title="Market Cap History"
        series={supplySeries}
        formatValue={formatCurrency}
        range={range}
        onRangeChange={setRange}
        normalizable
      />
    )}
    {priceSeries.length >= 2 && (
      <ComparisonChart
        title="Price History"
        series={priceSeries}
        formatValue={(v) => `$${v.toFixed(4)}`}
        range={range}
        onRangeChange={setRange}
      />
    )}
  </>
)}
```

**Step 4: Verify build**

Run: `npm run build`
Expected: Clean build. Error states show when detail requests fail.

**Step 5: Commit**

```bash
git add src/app/compare/client.tsx src/components/comparison-table.tsx
git commit -m "feat(compare): add partial error and loading state indicators"
```

---

### Task 8: Mobile-friendly table layout

**Files:**
- Modify: `src/components/comparison-table.tsx` (add mobile card layout)

**Step 1: Add mobile card layout**

Wrap the existing `<Table>` in a `hidden sm:block` container and add a mobile-only stacked card layout:

```tsx
return (
  <>
    {/* Mobile: stacked cards per coin */}
    <div className="sm:hidden space-y-4">
      {coins.map((coin, i) => (
        <div key={coin.id} className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center gap-2">
            <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={28} />
            <div>
              <span className="font-semibold text-sm">{coin.symbol}</span>
              <span className="text-xs text-muted-foreground ml-1.5">{coin.name}</span>
            </div>
            {detailErrors?.[coin.id] && (
              <span className="text-xs text-destructive ml-auto">Chart unavailable</span>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Price</dt>
            <dd className="text-right font-mono tabular-nums">{rowData.prices[i]}</dd>
            <dt className="text-muted-foreground">Peg Score</dt>
            <dd className="text-right font-mono tabular-nums">
              {rowData.pegScores[i] != null ? `${rowData.pegScores[i]!.toFixed(1)}/10` : "N/A"}
            </dd>
            <dt className="text-muted-foreground">Market Cap</dt>
            <dd className="text-right font-mono tabular-nums">{formatCurrency(rowData.marketCaps[i])}</dd>
            <dt className="text-muted-foreground">7d Change</dt>
            <dd className="text-right font-mono tabular-nums">
              {rowData.weeklyChanges[i] != null
                ? `${rowData.weeklyChanges[i]! >= 0 ? "+" : ""}${rowData.weeklyChanges[i]!.toFixed(2)}%`
                : "N/A"}
            </dd>
            <dt className="text-muted-foreground">Liquidity</dt>
            <dd className="text-right font-mono tabular-nums">
              {rowData.liquidityScores[i] != null ? `${rowData.liquidityScores[i]!.toFixed(1)}/10` : "N/A"}
            </dd>
            <dt className="text-muted-foreground">Governance</dt>
            <dd className="text-right">{rowData.governanceLabels[i]}</dd>
            <dt className="text-muted-foreground">Backing</dt>
            <dd className="text-right">{rowData.backingLabels[i]}</dd>
            <dt className="text-muted-foreground">Peg</dt>
            <dd className="text-right">{rowData.pegCurrencies[i]}</dd>
            <dt className="text-muted-foreground">Rating</dt>
            <dd className="text-right">{rowData.bluechipGrades[i] ?? "N/A"}</dd>
          </dl>
        </div>
      ))}
    </div>

    {/* Desktop: side-by-side table */}
    <div className="hidden sm:block">
      <Table>
        {/* ... existing table content unchanged ... */}
      </Table>
    </div>
  </>
);
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build. Mobile shows stacked cards, desktop shows table.

**Step 3: Commit**

```bash
git add src/components/comparison-table.tsx
git commit -m "feat(compare): add mobile-friendly stacked card layout for comparison table"
```

---

### Task 9: Copy link button

**Files:**
- Modify: `src/app/compare/page.tsx` (add copy button area)
- Modify: `src/app/compare/client.tsx` (add copy link button with toast)

**Step 1: Add copy link button in client.tsx**

Add a "Copy link" button next to the page subtitle area. Use the browser Clipboard API:

```typescript
const [copied, setCopied] = useState(false);

const handleCopyLink = useCallback(async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  } catch {
    // Fallback: do nothing — clipboard may not be available
  }
}, []);
```

Render it at the top of the CompareClient component's return, above the grid:

```tsx
{selectedIds.length >= 2 && (
  <div className="flex justify-end">
    <button
      onClick={handleCopyLink}
      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5" />
          Copied!
        </>
      ) : (
        <>
          <Link2 className="h-3.5 w-3.5" />
          Copy link
        </>
      )}
    </button>
  </div>
)}
```

Add imports for `Link2` and `Check` from `lucide-react`.

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build. "Copy link" button visible when 2+ coins selected.

**Step 3: Commit**

```bash
git add src/app/compare/client.tsx
git commit -m "feat(compare): add copy link button for sharing comparisons"
```

---

### Task 10: Final verification and build

**Step 1: Full type-check and build**

Run: `npm run build`
Expected: Clean build with no warnings or errors.

**Step 2: Visual verification**

Run: `npm run dev` and verify:
- Selecting 5 coins works, grid layout correct
- Market cap chart shows Absolute/Normalized toggle
- Price history chart appears below market cap chart
- Time range persists in URL
- Mobile layout shows stacked cards
- Arrow keys navigate coin dropdown
- Copy link button works
- No "best" highlight on market cap row

**Step 3: Commit all**

Ensure all changes are committed. Create a single summary commit if any stragglers remain.
