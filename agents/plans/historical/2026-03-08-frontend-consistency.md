# Frontend Consistency Pass

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate formatting inconsistencies, standardize loading/empty states, and consolidate chart date formatting across all pages — making Pharos feel like one product, not a collection of independently-built pages.

**Architecture:** The formatting utilities already exist in `shared/lib/format.ts` but are underused (~30 components bypass them with raw `.toFixed()` calls). Chart date formatting is scattered across ~20 files with 5+ format variations. Loading states mix `<ChartSkeleton>`, raw `<Skeleton>`, `return null`, and plain text. Empty states exist only on Compare and Portfolio pages. This plan consolidates all four categories.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, shared/lib/format.ts

---

### Task 1: Add missing formatting utilities

**Files:**
- Modify: `shared/lib/format.ts`
- Test: `shared/lib/__tests__/format.test.ts` (create if needed, or add to existing)

**Context:**
Three formatting patterns recur across the codebase but have no centralized utility:
1. **Score formatting** (PSI, peg score, liquidity score, yield score) — always `toFixed(1)`, range 0-100
2. **APY formatting** — always `toFixed(2)` with `%` suffix
3. **Chart date formatting** — 5+ variations of `toLocaleDateString` scattered across 20 files

**Step 1: Write tests for the new utilities**

Create or extend the format test file:

```typescript
import { formatScore, formatApy, formatChartDate } from "../format";

describe("formatScore", () => {
  it("formats to one decimal", () => expect(formatScore(72.456)).toBe("72.5"));
  it("handles zero", () => expect(formatScore(0)).toBe("0.0"));
  it("handles 100", () => expect(formatScore(100)).toBe("100.0"));
  it("returns dash for null", () => expect(formatScore(null)).toBe("-"));
  it("returns dash for undefined", () => expect(formatScore(undefined)).toBe("-"));
});

describe("formatApy", () => {
  it("formats to two decimals with %", () => expect(formatApy(4.567)).toBe("4.57%"));
  it("handles zero", () => expect(formatApy(0)).toBe("0.00%"));
  it("handles negative", () => expect(formatApy(-1.5)).toBe("-1.50%"));
  it("returns dash for null", () => expect(formatApy(null)).toBe("-"));
});

describe("formatChartDate", () => {
  const ts = new Date("2025-06-15T12:00:00Z").getTime();
  it("short format: month + day", () => {
    expect(formatChartDate(ts, "short")).toBe("Jun 15");
  });
  it("month-year format", () => {
    expect(formatChartDate(ts, "month-year")).toBe("Jun 2025");
  });
  it("compact format: month + 2-digit year", () => {
    expect(formatChartDate(ts, "compact")).toBe("Jun '25");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run format`
Expected: FAIL — functions don't exist yet.

**Step 3: Implement the utilities**

Add to `shared/lib/format.ts`:

```typescript
/** Format a 0-100 score to one decimal. Returns "-" for nullish values. */
export function formatScore(value: number | null | undefined): string {
  return value != null ? value.toFixed(1) : "-";
}

/** Format an APY percentage to two decimals with % suffix. Returns "-" for nullish. */
export function formatApy(value: number | null | undefined): string {
  return value != null ? `${value.toFixed(2)}%` : "-";
}

type ChartDateFormat = "short" | "month-year" | "compact";

/** Centralized date formatter for chart axes and tooltips. */
export function formatChartDate(
  timestamp: number | string,
  format: ChartDateFormat = "short",
): string {
  const d = new Date(timestamp);
  switch (format) {
    case "short":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "month-year":
      return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    case "compact":
      return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
}
```

**Step 4: Run tests**

Run: `npm test -- --run format`
Expected: All pass.

**Step 5: Commit**

```bash
git add shared/lib/format.ts shared/lib/__tests__/
git commit -m "feat(format): add formatScore, formatApy, formatChartDate utilities"
```

---

### Task 2: Replace raw `.toFixed()` calls with format utilities

**Files to modify** (all in `src/`):

| File | Lines | Current | Replacement |
|------|-------|---------|-------------|
| `src/components/comparison-table.tsx` | ~186, 198, 263, 308 | `pegScores[i]!.toFixed(1)`, `liquidityScores[i]!.toFixed(1)` | `formatScore(pegScores[i])`, `formatScore(liquidityScores[i])` |
| `src/components/comparison-table.tsx` | ~193, 293 | `weeklyChanges[i]!.toFixed(2)` | Keep `toFixed(2)` — this is a percentage change, not a score |
| `src/components/digest-snapshot.tsx` | ~122, 126, 141-145 | `score.toFixed(1)` for PSI scores | `formatScore(score)` |
| `src/components/yield-leaderboard.tsx` | ~68, 237 | `currentApy.toFixed(2)` | `formatApy(currentApy)` (remove manual `%` if present) |
| `src/components/yield-leaderboard.tsx` | ~262 | `pharosYieldScore.toFixed(1)` | `formatScore(pharosYieldScore)` |
| `src/components/stability-index.tsx` | ~141 | `displayScore.toFixed(1)` | `formatScore(displayScore)` |
| `src/components/kpi-bar.tsx` | ~311-334 | Various `.toFixed()` calls | Replace score-like values with `formatScore()`, leave currency formatting to `formatCurrency()` |
| `src/components/peg-heatmap.tsx` | ~184 | `dexPrice.toFixed(4)` | `formatNativePrice()` (already exists in format.ts) |
| `src/components/contagion-graph.tsx` | inline mcap format | `(node.mcap / 1e9).toFixed(1)` | `formatCurrency(node.mcap)` |
| `src/app/stability-index/client.tsx` | ~527-534 | Various `.toFixed()` | `formatScore()` for scores, `formatBps()` for bps values |

**Important exclusions — do NOT replace:**
- SVG coordinate `.toFixed()` calls (e.g., `dews-summary.tsx` lines 204-233) — these are rendering math, not data formatting
- CSS animation values (e.g., `flow-machine-scene.tsx`) — not user-facing data
- Percentage changes that genuinely need `.toFixed(2)` — these aren't scores

**Step 1: Replace score formatting calls**

Work through each file above. For each:
1. Add `import { formatScore } from "@shared/format"` (or adjust import path)
2. Replace the `.toFixed(1)` call with `formatScore(value)`
3. Verify the surrounding template literal still makes sense (remove redundant decimal formatting)

**Step 2: Replace APY formatting calls**

In yield-leaderboard.tsx, replace `.toFixed(2)` + manual `%` with `formatApy()`.

**Step 3: Replace inline currency formatting**

In contagion-graph.tsx, replace `${(node.mcap / 1e9).toFixed(1)}B` with `formatCurrency(node.mcap)`.

**Step 4: Verify in dev**

Run: `npm run dev`
Spot-check: comparison page, stability index, yield leaderboard, depeg tracker.
Verify numbers display identically to before (same decimal places, same format).

**Step 5: Type-check**

Run: `npm run build`
Expected: No type errors.

**Step 6: Commit**

```bash
git add src/components/ src/app/
git commit -m "refactor: replace raw .toFixed() with format utilities"
```

---

### Task 3: Consolidate chart date formatting

**Files to modify** (~15 files with `toLocaleDateString`):

| File | Current Pattern | Target |
|------|----------------|--------|
| `src/components/comparison-chart.tsx:110,115` | `{ month: "short", day: "numeric" }` + time variant | `formatChartDate(ts, "short")` |
| `src/components/flow-chart.tsx:66,68` | Same as above | `formatChartDate(ts, "short")` |
| `src/components/dex-liquidity-card.tsx:222` | `{ month: "short", day: "numeric" }` | `formatChartDate(ts, "short")` |
| `src/components/dews-detail.tsx:174` | `{ month: "short", day: "numeric" }` | `formatChartDate(ts, "short")` |
| `src/components/mcap-chart.tsx:32,66-67` | `{ month: "short" }` | `formatChartDate(ts, "month-year")` or `"short"` depending on context |
| `src/components/peg-diversity-chart.tsx:66` | `{ month: "short", year: "2-digit" }` | `formatChartDate(ts, "compact")` |
| `src/components/cemetery-charts.tsx:362` | `{ month: "short", year: "2-digit" }` | `formatChartDate(ts, "compact")` |
| `src/app/stability-index/client.tsx:182,196` | `{ month: "short", day: "numeric" }` | `formatChartDate(ts, "short")` |

**Exclusions — do NOT replace:**
- `src/components/daily-digest.tsx:11` — uses `{ month: "long", year: "numeric" }` for page headers, not charts
- `src/components/methodology-version-card.tsx:24` — changelog dates, not charts
- `src/components/methodology-changelog-page.tsx:88` — changelog dates
- `src/app/digest/[date]/page.tsx:27` — page title date
- `src/components/digest-archive-client.tsx:27,32` — archive listing dates
- `src/components/usds-status-card.tsx:11` — status date
- `src/components/stablecoin-detail/safety-score-history-section.tsx:10` — history date

These are UI text dates with distinct formatting needs — leave them alone.

**Special case — `comparison-chart.tsx` time format:**
Lines 110 use `{ hour: "numeric", hour12: true }` for hourly data. Add a `"with-time"` format variant if needed:

```typescript
case "with-time":
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "numeric", hour12: true,
  });
```

**Step 1: Add `"with-time"` variant to `formatChartDate` if needed**

Check if comparison-chart and flow-chart actually need the time variant. If yes, add it to the union type and switch statement.

**Step 2: Replace chart date calls**

Work through each chart file. Replace the inline `toLocaleDateString` with the appropriate `formatChartDate` call.

**Step 3: Verify charts render correctly**

Run: `npm run dev`
Check: comparison chart, flow chart, stability index charts, cemetery charts, peg diversity chart.
Verify date labels look identical.

**Step 4: Commit**

```bash
git add src/components/ src/app/ shared/lib/format.ts
git commit -m "refactor: consolidate chart date formatting into formatChartDate"
```

---

### Task 4: Standardize loading states

**Context:**
Three patterns are used for loading states, with no consistency:
1. `<ChartSkeleton>` — used in 7 components (good, keep)
2. Raw `<Skeleton>` composition — used in 15+ components (fine for non-chart layouts)
3. `return null` on loading — used in 5+ components (bad, invisible loading)

The goal is to eliminate pattern 3 (`return null`) and replace with appropriate skeletons.

**Files to modify:**

| Component | Current Loading | Fix |
|-----------|----------------|-----|
| `src/components/dews-detail.tsx` | `return null` | Add skeleton: score badge placeholder + signal list placeholder |
| `src/components/dex-liquidity-card.tsx` | `return null` | Add skeleton: chart placeholder using `<ChartSkeleton>` |
| `src/components/depeg-history.tsx` | `return null` | Add skeleton: table row placeholders |
| `src/components/dews-summary.tsx` | `return null` | Add skeleton: SVG area placeholder |
| `src/components/peg-heatmap.tsx` | `return null` | Add skeleton: grid of small squares |

**Step 1: Replace `return null` in dews-detail.tsx**

Find the `if (isLoading) return null` (or equivalent) and replace with:

```tsx
if (isLoading) {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-32" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Replace `return null` in dex-liquidity-card.tsx**

Replace with `<ChartSkeleton />` (already exists and is imported in other chart components).

**Step 3: Replace remaining `return null` loading states**

Apply the same pattern to `depeg-history.tsx`, `dews-summary.tsx`, `peg-heatmap.tsx`. Use:
- `<ChartSkeleton>` for chart-like components
- Row-based `<Skeleton>` arrays for table-like components
- Grid-based `<Skeleton>` for grid layouts (heatmap)

**Step 4: Verify in dev**

Run: `npm run dev`
Navigate to a coin detail page with slow network (DevTools > Network > Slow 3G).
Verify: all sections show skeletons during loading, no blank/invisible areas.

**Step 5: Commit**

```bash
git add src/components/
git commit -m "fix(loading): replace return-null loading states with skeletons"
```

---

### Task 5: Add empty states to list pages

**Context:**
Only Compare and Portfolio have dedicated empty states. Other list pages (blacklist, yield, stablecoins by peg, cemetery) show blank or empty tables when no data matches. The `<EmptyStateSurface>` component exists at `src/components/empty-state-surface.tsx` — it's a reusable layout with title, description, and optional actions.

For most pages, a simple "no results" message is sufficient — we don't need the full `EmptyStateSurface` with presets and previews. A lightweight pattern:

```tsx
{data.length === 0 && !isLoading && (
  <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
    <p className="text-sm">No results match your filters.</p>
  </div>
)}
```

**Files to modify:**

| Component | Context | Empty State Message |
|-----------|---------|-------------------|
| `src/components/blacklist-table.tsx` | No blacklist events match filter | "No blacklist events match your filters." |
| `src/components/yield-leaderboard.tsx` | No yield data | "No yield data available." |
| `src/components/stablecoin-table.tsx` | No stablecoins match filter | "No stablecoins match your search." |
| `src/components/depeg-tracker-table.tsx` | No depeg events | "No depeg events detected." |
| `src/components/flow-table.tsx` | No flow events | "No mint/burn events in this period." |
| `src/components/liquidity-table.tsx` | No pools | "No liquidity pools tracked for this stablecoin." |

**Step 1: Add empty state to each table component**

For each component, find where the table body is rendered from the data array. Add the empty state check:

```tsx
{filteredData.length === 0 && !isLoading ? (
  <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
    <p className="text-sm">{/* appropriate message */}</p>
  </div>
) : (
  // existing table body
)}
```

**Step 2: Verify in dev**

Run: `npm run dev`
For each page, apply a filter that returns no results and verify the empty state message appears.

**Step 3: Commit**

```bash
git add src/components/
git commit -m "feat(empty-states): add no-results messages to all list/table pages"
```

---

### Task 6: Build, type-check, lint

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 2: Lint**

Run: `npm run lint`
Expected: No new warnings. If new imports trigger unused-import warnings, fix them.

**Step 3: Tests**

Run: `npm test`
Expected: All tests pass.

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: fix build/lint issues from consistency pass"
```
