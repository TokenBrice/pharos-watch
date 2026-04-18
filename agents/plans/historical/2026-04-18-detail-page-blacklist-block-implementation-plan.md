# Detail Page Blacklist Block — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-coin "Blacklist Activity" block to the stablecoin detail page surfacing frozen-address count, frozen USD total, destroyed USD total, a quarterly event-cadence chart, and a 10-row recent-events feed.

**Architecture:** Extend the existing `GET /api/blacklist-summary` response with four per-coin fields (three scalar aggregations + one quarterly chart aggregation). Detail page consumes the same `useBlacklistSummary` hook, plus existing `useBlacklistEventsPage` with a `stablecoin` filter for the feed. New components live under `src/components/stablecoin-detail/` alongside `flows-section.tsx`. Gated via data presence like `hasFlows`.

**Tech Stack:** TypeScript, Next.js (App Router), Cloudflare Workers + D1, React, Zod, Vitest, recharts.

**Companion spec:** `agents/plans/2026-04-18-detail-page-blacklist-block-design.md`

---

## File Structure

**New files (5):**
- `src/components/stablecoin-detail/blacklist-section.tsx` — orchestrator (gating, loading, renders two sections)
- `src/components/stablecoin-detail/blacklist-detail-stats.tsx` — three MetricStatCards
- `src/components/stablecoin-detail/blacklist-detail-chart.tsx` — quarterly stacked bars, three event-type series
- `src/components/stablecoin-detail/blacklist-detail-event-feed.tsx` — 10-row table + "See all events →" footer
- `src/components/stablecoin-detail/__tests__/blacklist-section.test.tsx` — orchestrator gating tests

**Modified files (6):**
- `shared/types/market.ts` — extend `BlacklistSummaryResponseSchema` with four new fields + exported chart-point type
- `worker/src/api/blacklist-summary.ts` — add new SQL query + JS aggregations, attach to response
- `worker/src/api/__tests__/blacklist-summary.test.ts` — extend existing test, add a new test for the new aggregations
- `src/lib/stablecoin-detail-view-model.ts` — compute `hasBlacklist` boolean from summary
- `src/app/stablecoin/[id]/client.tsx` — insert `<BlacklistSection>`, add scrollspy entry
- `docs/blacklist-tracker.md` + `docs/api-reference.md` — document new fields + component tree

**Reality-check deltas from spec** (discovered while writing the plan):
1. Spec proposed a subdirectory `src/components/stablecoin-detail/blacklist-section/`. The existing directory is flat (`flows-section.tsx`, `overview-section.tsx`, etc.) — plan uses flat layout to match convention.
2. Spec proposed three new SQL aggregations. The existing handler's `perCoinResult` query (line 33–40) already returns `(stablecoin, event_type, n, usd_sum)` — plan derives `perCoinDestroyedTotal` from this in JS rather than re-querying.
3. Spec proposed SQL computation for the freeze-ledger stats. The handler already loads `currentBalances` and `latestByAddr` into memory — plan does per-coin aggregation in JS instead of adding two more D1 queries.
4. Only one new D1 query is actually required (quarterly event-type breakdown), which must be a new query because no existing one groups by time bucket.

---

## Task 1: Extend shared types with four new fields

**Files:**
- Modify: `shared/types/market.ts:554-555` (add four new fields to the stats schema)

- [ ] **Step 1.1: Add a named chart-point schema + four new fields to the stats schema**

Find lines 554-555 in `shared/types/market.ts`:

```typescript
  perCoinBlacklistCounts: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinTotalEvents: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
```

Replace with:

```typescript
  perCoinBlacklistCounts: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinTotalEvents: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinFrozenAddressCount: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinFrozenTotal: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinDestroyedTotal: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinQuarterlyEventTypes: z.record(
    z.enum(BLACKLIST_STABLECOINS),
    z.array(
      z.object({
        quarter: z.string(),
        blacklist: z.number(),
        unblacklist: z.number(),
        destroy: z.number(),
      }),
    ),
  ),
```

- [ ] **Step 1.2: Export a named `BlacklistQuarterlyEventTypePoint` type for component props**

Immediately above line 554 (before `perCoinBlacklistCounts`), add:

```typescript
export const BlacklistQuarterlyEventTypePointSchema = z.object({
  quarter: z.string(),
  blacklist: z.number(),
  unblacklist: z.number(),
  destroy: z.number(),
});
export type BlacklistQuarterlyEventTypePoint = z.infer<typeof BlacklistQuarterlyEventTypePointSchema>;
```

Then update the inline schema in step 1.1 to use this named schema:

```typescript
  perCoinQuarterlyEventTypes: z.record(
    z.enum(BLACKLIST_STABLECOINS),
    z.array(BlacklistQuarterlyEventTypePointSchema),
  ),
```

- [ ] **Step 1.3: Run typecheck**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm run build -- --no-lint 2>&1 | head -40
cd worker && npx tsc --noEmit
```

Expected: both succeed; root `npm run build` may surface Worker-path-dependent consumers — those are resolved in Task 2.

- [ ] **Step 1.4: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add shared/types/market.ts
git commit -m "feat(types): extend BlacklistSummaryResponse with per-coin detail fields"
```

---

## Task 2: Extend summary handler — SQL + JS aggregations

**Files:**
- Modify: `worker/src/api/blacklist-summary.ts` (add one SQL query + JS aggregations + response fields)
- Modify: `worker/src/api/__tests__/blacklist-summary.test.ts` (extend existing test, add a focused test)

- [ ] **Step 2.1: Write the failing test for the new fields**

Open `worker/src/api/__tests__/blacklist-summary.test.ts`. At the end of the first test case (after line 100, after the existing assertions), append these assertions inside the same test:

```typescript
    // Per-coin detail fields surfaced for the detail page block.
    const stats = body.stats as typeof body.stats & {
      perCoinFrozenAddressCount: Record<string, number>;
      perCoinFrozenTotal: Record<string, number>;
      perCoinDestroyedTotal: Record<string, number>;
      perCoinQuarterlyEventTypes: Record<string, Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>>;
    };
    expect(stats.perCoinFrozenAddressCount.USDT).toBe(1);
    expect(stats.perCoinFrozenAddressCount.USDC).toBe(0);
    expect(stats.perCoinFrozenTotal.USDT).toBe(1250);
    expect(stats.perCoinFrozenTotal.USDC).toBe(0);
    expect(stats.perCoinDestroyedTotal.USDC).toBe(500);
    expect(stats.perCoinDestroyedTotal.USDT).toBe(0);
    expect(stats.perCoinQuarterlyEventTypes.USDT.length).toBeGreaterThan(0);
    expect(stats.perCoinQuarterlyEventTypes.USDT[0]).toMatchObject({ blacklist: 1, unblacklist: 0, destroy: 0 });
```

Extend the `body` type declaration to include the new fields. The test fixture at the top also needs a fourth D1 response for the new query — add it to the `mockD1([...])` array before the `cron_runs` row:

```typescript
      {
        match: "quarter_sort_key",
        rows: [
          { stablecoin: "USDT", quarter_sort_key: 7_604 /* arbitrary bucket aligned with 1_777_000_000 */, event_type: "blacklist", n: 1 },
          { stablecoin: "USDC", quarter_sort_key: 7_604, event_type: "destroy", n: 1 },
        ],
      },
```

Compute the real bucket value: `const ts = 1_777_000_000; const d = new Date(ts * 1000); const bucket = d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);` — run this once and inline the literal number. (Do not leave a stale comment.)

- [ ] **Step 2.2: Run test to verify it fails**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard/worker
npx vitest run src/api/__tests__/blacklist-summary.test.ts
```

Expected: FAIL — `perCoinFrozenAddressCount` / `perCoinFrozenTotal` / `perCoinDestroyedTotal` / `perCoinQuarterlyEventTypes` are `undefined` on the response.

- [ ] **Step 2.3: Add the new SQL query for per-coin quarterly event types**

In `worker/src/api/blacklist-summary.ts`, after the existing `perCoinResult` query (ends at line 40), add:

```typescript
    // Per-coin, per-quarter, per-event-type counts for the stablecoin detail
    // page chart. Bucketing matches the JS helper in
    // shared/lib/blacklist-aggregates.ts (year*4 + floor(month/3)) so labels
    // align with the main-page chart.
    const perCoinQuarterlyResult = await db
      .prepare(
        `SELECT
           stablecoin,
           (CAST(strftime('%Y', datetime(timestamp, 'unixepoch')) AS INTEGER) * 4 +
            CAST((CAST(strftime('%m', datetime(timestamp, 'unixepoch')) AS INTEGER) - 1) / 3 AS INTEGER)) AS quarter_sort_key,
           event_type,
           COUNT(*) AS n
         FROM blacklist_events
         WHERE suppression_reason IS NULL
         GROUP BY stablecoin, quarter_sort_key, event_type`,
      )
      .all<{ stablecoin: string; quarter_sort_key: number; event_type: string; n: number }>();
```

- [ ] **Step 2.4: Add the four new JS aggregations and attach to response**

In `worker/src/api/blacklist-summary.ts`, after the `perCoinTotalEvents` accumulation loop (ends at line 117) and before `const usdcBlacklisted = ...` (line 119), add:

```typescript
    // ---------------- Per-coin detail fields ----------------

    const perCoinFrozenAddressCount = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    for (const row of latestByAddr) {
      if (row.eventType !== "blacklist") continue;
      if (!BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) continue;
      perCoinFrozenAddressCount[row.stablecoin as BlacklistStablecoin] += 1;
    }

    const perCoinFrozenTotal = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    for (const snapshot of currentBalances.values()) {
      if (snapshot.amountUsd == null || snapshot.amountUsd <= 0) continue;
      if (!BLACKLIST_STABLECOINS.includes(snapshot.stablecoin as BlacklistStablecoin)) continue;
      perCoinFrozenTotal[snapshot.stablecoin as BlacklistStablecoin] += snapshot.amountUsd;
    }

    const perCoinDestroyedTotal = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    for (const row of perCoinResult.results ?? []) {
      if (row.event_type !== "destroy") continue;
      if (!BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) continue;
      perCoinDestroyedTotal[row.stablecoin as BlacklistStablecoin] += row.usd_sum ?? 0;
    }

    // Build per-coin quarterly event-type arrays using the same sortKey->label
    // helper as the main chart. Missing quarters are filled with zero-row
    // entries between a coin's first and last bucket so bars render
    // contiguously (matching buildBlacklistQuarterlyChartFromSnapshots).
    const perCoinQuarterlyEventTypes = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, [] as BlacklistQuarterlyEventTypePoint[]]),
    ) as Record<BlacklistStablecoin, BlacklistQuarterlyEventTypePoint[]>;
    const perCoinBucketMap = new Map<BlacklistStablecoin, Map<number, { blacklist: number; unblacklist: number; destroy: number }>>();
    for (const row of perCoinQuarterlyResult.results ?? []) {
      if (!BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) continue;
      const symbol = row.stablecoin as BlacklistStablecoin;
      const coinBuckets = perCoinBucketMap.get(symbol) ?? new Map();
      const bucket = coinBuckets.get(row.quarter_sort_key) ?? { blacklist: 0, unblacklist: 0, destroy: 0 };
      if (row.event_type === "blacklist") bucket.blacklist += row.n;
      else if (row.event_type === "unblacklist") bucket.unblacklist += row.n;
      else if (row.event_type === "destroy") bucket.destroy += row.n;
      coinBuckets.set(row.quarter_sort_key, bucket);
      perCoinBucketMap.set(symbol, coinBuckets);
    }
    for (const [symbol, buckets] of perCoinBucketMap.entries()) {
      const sortKeys = [...buckets.keys()].sort((a, b) => a - b);
      if (sortKeys.length === 0) continue;
      const minKey = sortKeys[0]!;
      const maxKey = sortKeys[sortKeys.length - 1]!;
      const points: BlacklistQuarterlyEventTypePoint[] = [];
      for (let k = minKey; k <= maxKey; k++) {
        const b = buckets.get(k) ?? { blacklist: 0, unblacklist: 0, destroy: 0 };
        points.push({ quarter: sortKeyToLabel(k), ...b });
      }
      perCoinQuarterlyEventTypes[symbol] = points;
    }
```

- [ ] **Step 2.5: Add imports and attach fields to response body**

At the top of `worker/src/api/blacklist-summary.ts`, extend the existing import from `@shared/types/market` to include `BlacklistQuarterlyEventTypePoint`:

```typescript
import {
  BLACKLIST_STABLECOINS,
  type BlacklistEvent,
  type BlacklistStablecoin,
  type BlacklistQuarterlyEventTypePoint,
} from "@shared/types/market";
```

Extend the existing import from `@shared/lib/blacklist-aggregates` to expose `sortKeyToLabel`:

```typescript
import {
  buildBlacklistQuarterlyChartFromSnapshots,
  sortKeyToLabel,
} from "@shared/lib/blacklist-aggregates";
```

Then in `shared/lib/blacklist-aggregates.ts`, export the existing private helper. Find line 13:

```typescript
function sortKeyToLabel(sortKey: number): string {
```

Change to:

```typescript
export function sortKeyToLabel(sortKey: number): string {
```

Finally, in the response body in `handleBlacklistSummary` (the `stats: { ... }` object starting at line 135), add the four new fields to the stats object, right after `perCoinTotalEvents` (line 151):

```typescript
          perCoinBlacklistCounts,
          perCoinTotalEvents,
          perCoinFrozenAddressCount,
          perCoinFrozenTotal,
          perCoinDestroyedTotal,
          perCoinQuarterlyEventTypes,
```

- [ ] **Step 2.6: Run test to verify it passes**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard/worker
npx vitest run src/api/__tests__/blacklist-summary.test.ts
```

Expected: PASS — all new assertions satisfied.

- [ ] **Step 2.7: Add a focused test for suppression-reason filter + empty coin**

Append a second test case to `worker/src/api/__tests__/blacklist-summary.test.ts`:

```typescript
  it("excludes suppressed events from per-coin detail fields and returns zero for coins without data", async () => {
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          // Suppressed rows should never arrive here because the SQL filters
          // them, but we pass an empty result to simulate an all-suppressed
          // EURC state and confirm the JS aggregations produce zeros.
        ],
      },
      {
        match: "WITH ranked AS",
        rows: [],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 0, max_ts: null, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      {
        match: "FROM blacklist_current_balances",
        rows: [],
      },
      {
        match: "quarter_sort_key",
        rows: [],
      },
      { match: "cron_runs", rows: [], first: { started_at: 1_777_000_200 } },
    ]);

    const res = await handleBlacklistSummary(db);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      stats: {
        perCoinFrozenAddressCount: Record<string, number>;
        perCoinFrozenTotal: Record<string, number>;
        perCoinDestroyedTotal: Record<string, number>;
        perCoinQuarterlyEventTypes: Record<string, unknown[]>;
      };
    };
    expect(body.stats.perCoinFrozenAddressCount.USDC).toBe(0);
    expect(body.stats.perCoinFrozenTotal.USDC).toBe(0);
    expect(body.stats.perCoinDestroyedTotal.USDC).toBe(0);
    expect(body.stats.perCoinQuarterlyEventTypes.USDC).toEqual([]);
  });
```

- [ ] **Step 2.8: Run test suite + worker typecheck**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard/worker
npx vitest run src/api/__tests__/blacklist-summary.test.ts
npx tsc --noEmit
```

Expected: both tests PASS; typecheck clean.

- [ ] **Step 2.9: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add worker/src/api/blacklist-summary.ts worker/src/api/__tests__/blacklist-summary.test.ts shared/lib/blacklist-aggregates.ts
git commit -m "feat(blacklist-summary): return per-coin detail stats and quarterly event-type breakdown"
```

---

## Task 3: BlacklistDetailStats component

**Files:**
- Create: `src/components/stablecoin-detail/blacklist-detail-stats.tsx`

- [ ] **Step 3.1: Write the component**

```tsx
"use client";

import { MetricStatCard } from "@/components/metric-stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCurrency } from "@shared/lib/format";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

interface BlacklistDetailStatsProps {
  symbol: BlacklistStablecoin;
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
}

export function BlacklistDetailStats({ symbol, stats, isLoading }: BlacklistDetailStatsProps) {
  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="rounded-xl">
            <CardHeader>
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const frozenAddresses = stats.perCoinFrozenAddressCount[symbol] ?? 0;
  const frozenTotal = stats.perCoinFrozenTotal[symbol] ?? 0;
  const destroyedTotal = stats.perCoinDestroyedTotal[symbol] ?? 0;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-5 animate-in fade-in duration-300">
      <MetricStatCard
        borderColorClass="border-l-emerald-500"
        title="Frozen addresses"
        value={frozenAddresses}
        subtext="net-frozen (latest action is blacklist)"
      />
      <MetricStatCard
        borderColorClass="border-l-amber-500"
        title="Frozen total"
        value={formatCurrency(frozenTotal)}
        subtext="persistent freeze-ledger balance"
      />
      <MetricStatCard
        borderColorClass="border-l-red-500"
        title="Destroyed"
        value={formatCurrency(destroyedTotal)}
        subtext="seized & burned (USD value)"
      />
    </div>
  );
}
```

- [ ] **Step 3.2: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add src/components/stablecoin-detail/blacklist-detail-stats.tsx
git commit -m "feat(detail): add blacklist-detail-stats component"
```

---

## Task 4: BlacklistDetailChart component

**Files:**
- Create: `src/components/stablecoin-detail/blacklist-detail-chart.tsx`

- [ ] **Step 4.1: Write the component**

```tsx
"use client";

import { useMemo } from "react";
import { ComposedChart, Bar, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { CategoricalXAxis, ChartGrid, MonoYAxis } from "@/components/chart-primitives";
import type { BlacklistQuarterlyEventTypePoint } from "@shared/types";

const CHART_HEIGHT = "h-[220px] sm:h-[260px]";

// Event-type palette. Red = blacklist (punitive), amber = destroy (escalation),
// emerald = unblacklist (reversal). These mirror the badge colours used in the
// main /blacklist table.
const EVENT_TYPE_COLORS = {
  blacklist: "#ef4444",
  destroy: "#f59e0b",
  unblacklist: "#10b981",
} as const;

interface BlacklistDetailChartProps {
  data: BlacklistQuarterlyEventTypePoint[] | undefined;
  isLoading: boolean;
}

type Entry = { dataKey: string; value: number; color: string };

export function BlacklistDetailChart({ data, isLoading }: BlacklistDetailChartProps) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();
  const chartData = useMemo(() => data ?? [], [data]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64 mt-1" />
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  if (chartData.length === 0) {
    return null;
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h3" className="pharos-kicker">Events per Quarter</CardTitle>
        <p className="text-xs text-muted-foreground">
          Count of blacklist, unblacklist, and destroy events attributed to their execution quarter.
        </p>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2">
          {(["blacklist", "unblacklist", "destroy"] as const).map((key) => (
            <div key={key} className="pharos-chart-legend-chip">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: EVENT_TYPE_COLORS[key] }}
              />
              {key[0]!.toUpperCase() + key.slice(1)}
            </div>
          ))}
        </div>
        <div
          ref={ref}
          className={CHART_HEIGHT}
          role="figure"
          aria-label={`Quarterly blacklist events chart showing ${chartData.length} quarters`}
        >
          {ready ? (
            <ComposedChart
              width={width}
              height={height}
              data={chartData}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <ChartGrid strokeDasharray="3 3" />
              <CategoricalXAxis
                dataKey="quarter"
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                angle={-35}
                textAnchor="end"
                height={52}
                interval={Math.max(0, Math.floor(chartData.length / 8) - 1)}
              />
              <MonoYAxis
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                allowDecimals={false}
                width={48}
              />
              <Tooltip content={<EventTypeTooltip />} cursor={{ fill: "currentColor", opacity: 0.05 }} />
              <Bar dataKey="blacklist" stackId="a" fill={EVENT_TYPE_COLORS.blacklist} fillOpacity={0.8} />
              <Bar dataKey="unblacklist" stackId="a" fill={EVENT_TYPE_COLORS.unblacklist} fillOpacity={0.7} />
              <Bar dataKey="destroy" stackId="a" fill={EVENT_TYPE_COLORS.destroy} fillOpacity={0.75} radius={[3, 3, 0, 0]} />
            </ComposedChart>
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventTypeTooltip({ active, payload, label }: { active?: boolean; payload?: Entry[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => p.value > 0);
  if (rows.length === 0) return null;
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{label}</TooltipLabel>
      {rows.map((p) => (
        <TooltipRow key={p.dataKey} color={p.color} label={p.dataKey} value={String(p.value)} />
      ))}
    </PharosChartTooltip>
  );
}
```

- [ ] **Step 4.2: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add src/components/stablecoin-detail/blacklist-detail-chart.tsx
git commit -m "feat(detail): add blacklist-detail-chart component"
```

---

## Task 5: BlacklistDetailEventFeed component

**Files:**
- Create: `src/components/stablecoin-detail/blacklist-detail-event-feed.tsx`

- [ ] **Step 5.1: Write the component**

```tsx
"use client";

import Link from "next/link";
import {
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, ShieldOff } from "lucide-react";
import { useBlacklistEventsPage } from "@/hooks/use-blacklist-events";
import { formatCurrency, timeAgo, formatEventDate } from "@shared/lib/format";
import type { BlacklistEvent, BlacklistStablecoin } from "@shared/types";

const COLUMNS: readonly DataTableColumn[] = [
  { id: "time", label: "Time" },
  { id: "event", label: "Event" },
  { id: "address", label: "Address" },
  { id: "amount", label: "Amount", className: "text-right" },
  { id: "chain", label: "Chain", className: "hidden sm:table-cell" },
  { id: "tx", label: "Tx", className: "text-center" },
] as const;

interface Props {
  symbol: BlacklistStablecoin;
  limit?: number;
}

function eventBadge(eventType: BlacklistEvent["eventType"]) {
  if (eventType === "blacklist") {
    return {
      label: "Blacklist",
      className: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20 text-xs",
    };
  }
  if (eventType === "unblacklist") {
    return {
      label: "Unblacklist",
      className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-xs",
    };
  }
  return {
    label: "Destroy",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20 text-xs",
  };
}

function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function FeedSkeleton() {
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="bg-muted/50 h-10" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2 border-t">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
          <div className="flex-1" />
          <Skeleton className="h-4 w-4 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function FeedEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
      <ShieldOff className="h-10 w-10 opacity-40" />
      <p className="text-sm">No blacklist events recorded yet.</p>
    </div>
  );
}

export function BlacklistDetailEventFeed({ symbol, limit = 10 }: Props) {
  const { data, isLoading, isError } = useBlacklistEventsPage({
    stablecoin: symbol,
    limit,
    offset: 0,
  });

  if (isLoading) return <FeedSkeleton />;
  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Unable to load blacklist events. Please try again in a few moments.
      </div>
    );
  }
  if (!data || data.events.length === 0) return <FeedEmpty />;

  return (
    <>
      <DataTableShell
        columns={COLUMNS}
        containerClassName="rounded-xl border overflow-hidden"
        tableClassName="min-w-[520px]"
      >
        {data.events.map((evt) => {
          const badge = eventBadge(evt.eventType);
          return (
            <TableRow key={evt.id}>
              <TableCell className="whitespace-nowrap text-xs" title={formatEventDate(evt.timestamp)}>
                <span className="font-mono">{timeAgo(evt.timestamp)}</span>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={badge.className}>
                  {badge.label}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                <a
                  href={evt.explorerAddressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {shortAddress(evt.address)}
                </a>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-sm">
                {evt.amountUsdAtEvent != null ? (
                  formatCurrency(evt.amountUsdAtEvent)
                ) : (
                  <span className="text-muted-foreground">&mdash;</span>
                )}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-sm">{evt.chainName}</TableCell>
              <TableCell className="text-center">
                <a
                  href={evt.explorerTxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="View transaction on block explorer"
                >
                  <span className="hidden md:inline">{shortHash(evt.txHash)}</span>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </TableCell>
            </TableRow>
          );
        })}
      </DataTableShell>
      <div className="mt-3 flex justify-end">
        <Link
          href={`/blacklist?stablecoin=${symbol}`}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          See all events →
        </Link>
      </div>
    </>
  );
}
```

- [ ] **Step 5.2: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add src/components/stablecoin-detail/blacklist-detail-event-feed.tsx
git commit -m "feat(detail): add blacklist-detail-event-feed component"
```

---

## Task 6: BlacklistSection orchestrator

**Files:**
- Create: `src/components/stablecoin-detail/blacklist-section.tsx`
- Create: `src/components/stablecoin-detail/__tests__/blacklist-section.test.tsx`

- [ ] **Step 6.1: Write the failing orchestrator test**

```tsx
// src/components/stablecoin-detail/__tests__/blacklist-section.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlacklistSection } from "../blacklist-section";

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: vi.fn(),
  useBlacklistEventsPage: vi.fn(() => ({ data: { events: [] }, isLoading: false, isError: false })),
}));

import { useBlacklistSummary } from "@/hooks/use-blacklist-events";

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeSummary(overrides: Partial<{ perCoinTotalEvents: Record<string, number>; perCoinFrozenAddressCount: Record<string, number>; perCoinFrozenTotal: Record<string, number>; perCoinDestroyedTotal: Record<string, number>; perCoinQuarterlyEventTypes: Record<string, Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>>; }> = {}) {
  return {
    data: {
      stats: {
        perCoinTotalEvents: overrides.perCoinTotalEvents ?? { USDC: 5 },
        perCoinFrozenAddressCount: overrides.perCoinFrozenAddressCount ?? { USDC: 3 },
        perCoinFrozenTotal: overrides.perCoinFrozenTotal ?? { USDC: 1000 },
        perCoinDestroyedTotal: overrides.perCoinDestroyedTotal ?? { USDC: 0 },
        perCoinQuarterlyEventTypes: overrides.perCoinQuarterlyEventTypes ?? { USDC: [{ quarter: "Q1 '26", blacklist: 5, unblacklist: 0, destroy: 0 }] },
      },
    },
    isLoading: false,
    isError: false,
  };
}

describe("BlacklistSection", () => {
  it("returns null for a coin not in BLACKLIST_STABLECOINS", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(makeSummary() as ReturnType<typeof useBlacklistSummary>);
    const { container } = renderWithClient(<BlacklistSection stablecoinId="busd" symbol={"BUSD" as "USDC"} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null for a supported coin with zero events", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(
      makeSummary({ perCoinTotalEvents: { USDC: 0 } }) as ReturnType<typeof useBlacklistSummary>,
    );
    const { container } = renderWithClient(<BlacklistSection stablecoinId="usdc" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the Blacklist Activity section for a supported coin with events", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(makeSummary() as ReturnType<typeof useBlacklistSummary>);
    const { getByText } = renderWithClient(<BlacklistSection stablecoinId="usdc" symbol="USDC" />);
    expect(getByText(/Blacklist Activity/i)).toBeInTheDocument();
  });

  it("renders null when the summary errors (silent failure)", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(
      { data: undefined, isLoading: false, isError: true } as ReturnType<typeof useBlacklistSummary>,
    );
    const { container } = renderWithClient(<BlacklistSection stablecoinId="usdc" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 6.2: Run the test — confirm it fails (module not found)**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npx vitest run src/components/stablecoin-detail/__tests__/blacklist-section.test.tsx
```

Expected: FAIL with "Cannot find module '../blacklist-section'".

- [ ] **Step 6.3: Write the orchestrator component**

```tsx
// src/components/stablecoin-detail/blacklist-section.tsx
"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { BlacklistDetailStats } from "./blacklist-detail-stats";
import { BlacklistDetailChart } from "./blacklist-detail-chart";
import { BlacklistDetailEventFeed } from "./blacklist-detail-event-feed";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin } from "@shared/types";

interface BlacklistSectionProps {
  stablecoinId: string;
  symbol: BlacklistStablecoin;
}

export function BlacklistSection({ symbol }: BlacklistSectionProps) {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const { data: summary, isLoading, isError } = useBlacklistSummary();

  if (!isSupported) return null;
  if (isError) return null;
  if (!isLoading && summary && (summary.stats.perCoinTotalEvents[symbol] ?? 0) === 0) {
    return null;
  }

  return (
    <>
      <section id="blacklist">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className={DETAIL_SECTION_TITLE_CLASS}>Blacklist Activity</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Addresses the issuer has frozen, released, or destroyed on this asset.
            </p>
          </div>
          {isLoading || !summary ? (
            <div className="space-y-4">
              <BlacklistDetailStats symbol={symbol} stats={undefined} isLoading />
              <Skeleton className="h-[220px] w-full rounded-xl" />
            </div>
          ) : (
            <div className="space-y-4">
              <BlacklistDetailStats symbol={symbol} stats={summary.stats} isLoading={false} />
              <BlacklistDetailChart
                data={summary.stats.perCoinQuarterlyEventTypes[symbol]}
                isLoading={false}
              />
            </div>
          )}
        </Card>
      </section>

      <section id="blacklist-history">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className={DETAIL_SECTION_TITLE_CLASS}>Recent Blacklist Events</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Latest 10 freeze-ledger actions on this asset across all supported chains.
            </p>
          </div>
          <BlacklistDetailEventFeed symbol={symbol} limit={10} />
        </Card>
      </section>
    </>
  );
}
```

- [ ] **Step 6.4: Run the tests — confirm all four pass**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npx vitest run src/components/stablecoin-detail/__tests__/blacklist-section.test.tsx
```

Expected: PASS × 4.

- [ ] **Step 6.5: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add src/components/stablecoin-detail/blacklist-section.tsx src/components/stablecoin-detail/__tests__/blacklist-section.test.tsx
git commit -m "feat(detail): add BlacklistSection orchestrator with gating"
```

---

## Task 7: Wire into detail page

**Architecture note:** `src/lib/stablecoin-detail-view-model.ts` is a PURE builder function (no hooks). All hooks are called in `src/hooks/use-stablecoin-detail-view-model.ts`, which passes data into the builder. Modify both.

**Files:**
- Modify: `src/hooks/use-stablecoin-detail-view-model.ts` (call `useBlacklistSummary`, pass data to builder)
- Modify: `src/lib/stablecoin-detail-view-model.ts` (accept new params, compute `hasBlacklist`, add to interface + return)
- Modify: `src/lib/__tests__/stablecoin-detail-view-model.test.ts` (pass new params in existing fixtures)
- Modify: `src/app/stablecoin/[id]/client.tsx` (render section + scrollspy entry)

- [ ] **Step 7.1: Extend the pure builder's params interface and computation**

In `src/lib/stablecoin-detail-view-model.ts`:

Add to the imports at top (near the existing `@shared/types` imports):

```typescript
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin, type BlacklistSummaryResponse } from "@shared/types";
```

Extend `BuildStablecoinDetailViewModelParams` (around line 108–146) by appending two fields before the closing `}`:

```typescript
  blacklistSummary?: BlacklistSummaryResponse;
  isBlacklistLoading: boolean;
```

Extend `StablecoinDetailReadyViewModel` (around line 60–100) by adding:

```typescript
  hasBlacklist: boolean;
```

In the destructured params of `buildStablecoinDetailViewModel` (around line 195–233), add:

```typescript
  blacklistSummary,
  isBlacklistLoading,
```

Right after the `hasFlows` computation (line 281–283), add:

```typescript
  const isBlacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const hasBlacklist =
    isBlacklistSupported &&
    (isBlacklistLoading ||
      (!!blacklistSummary &&
        (blacklistSummary.stats.perCoinTotalEvents[coin.symbol as BlacklistStablecoin] ?? 0) > 0));
```

In the returned object (around line 285), add `hasBlacklist` alongside `hasFlows`:

```typescript
    hasFlows,
    hasBlacklist,
```

- [ ] **Step 7.2: Wire the hook in the hook wrapper**

In `src/hooks/use-stablecoin-detail-view-model.ts`:

Add import near the existing hook imports (around line 4–14):

```typescript
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
```

In the hook body, alongside the other hook calls (right after line 82's `useMintBurnFlows` call), add:

```typescript
  const { data: blacklistSummary, isLoading: isBlacklistLoading } = useBlacklistSummary();
```

In the `buildStablecoinDetailViewModel({...})` call (line 108–145), pass the new params alongside `isFlowsLoading`:

```typescript
    flowsData,
    isFlowsLoading,
    blacklistSummary,
    isBlacklistLoading,
    liveReserves: liveReserves.reserveResult,
```

- [ ] **Step 7.3: Update the builder test to pass the new params**

Open `src/lib/__tests__/stablecoin-detail-view-model.test.ts`. Every call to `buildStablecoinDetailViewModel({...})` must include the new required `isBlacklistLoading` field. Add it right after `isFlowsLoading` in every fixture (e.g., around line 59 of the first test). The simplest addition:

```typescript
      isFlowsLoading: false,
      isBlacklistLoading: false,
```

`blacklistSummary` is optional — no need to add it. Defaulting `isBlacklistLoading: false` means `hasBlacklist` will be `false` in tests that don't care about the section, which matches the pre-change behaviour.

Run the test to confirm it still passes:

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npx vitest run src/lib/__tests__/stablecoin-detail-view-model.test.ts
```

Expected: PASS.

- [ ] **Step 7.4: Add scrollspy entry and render the section**

In `src/app/stablecoin/[id]/client.tsx`:

Add to `DETAIL_SECTION_DEFS` (between `flows` and `history`, around line 94–95):

```typescript
  flows: { id: "flows", label: "Flows" },
  blacklist: { id: "blacklist", label: "Blacklist" },
  history: { id: "history", label: "History" },
```

Find the `detailSections` array (line 191+) and add the conditional:

```typescript
  const detailSections = [
    /* … existing entries … */
    ...(viewModel.hasFlows ? [s.flows] : []),
    ...(viewModel.hasBlacklist ? [s.blacklist] : []),
    s.history,
    s.explore,
  ];
```

Find where `<FlowsSection>` is rendered (around line 337). Add right after it, before the History Zone:

```tsx
          <FlowsSection stablecoinId={id} hasFlows={viewModel.hasFlows} />
          {viewModel.hasBlacklist && (
            <BlacklistSection
              stablecoinId={id}
              symbol={viewModel.coin.symbol as BlacklistStablecoin}
            />
          )}
```

Add the imports at the top of `client.tsx`:

```typescript
import { BlacklistSection } from "@/components/stablecoin-detail/blacklist-section";
import type { BlacklistStablecoin } from "@shared/types";
```

- [ ] **Step 7.5: Run build + typecheck**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm run build 2>&1 | tail -30
```

Expected: build succeeds. If the build complains about unused imports or type mismatches, fix them.

- [ ] **Step 7.6: Run the full test suite**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm test -- --run
cd worker && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7.7: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add src/lib/stablecoin-detail-view-model.ts src/hooks/use-stablecoin-detail-view-model.ts src/lib/__tests__/stablecoin-detail-view-model.test.ts src/app/stablecoin/[id]/client.tsx
git commit -m "feat(detail): wire BlacklistSection into stablecoin detail page"
```

---

## Task 8: Update documentation

**Files:**
- Modify: `docs/blacklist-tracker.md` (new "Detail-page block" subsection)
- Modify: `docs/api-reference.md` (updated `/api/blacklist-summary` response shape)

- [ ] **Step 8.1: Find the Frontend section in the blacklist doc**

```bash
grep -n "^## \|^### " /home/ahirice/Documents/git/stablecoin-dashboard/docs/blacklist-tracker.md | head -30
```

Identify the section that documents frontend consumers (hooks, components).

- [ ] **Step 8.2: Append a subsection documenting the detail-page block**

Under the frontend section, add:

```markdown
### Detail-page block

Stablecoin detail pages (`/stablecoin/<id>`) render a `BlacklistSection` immediately after the Mint & Burn Flow History when both conditions hold:

1. The coin's symbol is in `BLACKLIST_STABLECOINS` (`shared/types/market.ts`).
2. `summary.stats.perCoinTotalEvents[symbol] > 0` (i.e., real, non-suppressed events exist).

The section consists of:

- **BlacklistDetailStats** — three `MetricStatCard`s showing `perCoinFrozenAddressCount`, `perCoinFrozenTotal` (USD), and `perCoinDestroyedTotal` (USD).
- **BlacklistDetailChart** — quarterly stacked bars, three event-type series (blacklist / unblacklist / destroy), driven by `perCoinQuarterlyEventTypes[symbol]`.
- **BlacklistDetailEventFeed** — latest 10 events for the coin via `useBlacklistEventsPage({ stablecoin: symbol, limit: 10, offset: 0 })`, with a "See all events →" footer link to `/blacklist?stablecoin=<symbol>`.

Source files: `src/components/stablecoin-detail/blacklist-section.tsx`, `blacklist-detail-stats.tsx`, `blacklist-detail-chart.tsx`, `blacklist-detail-event-feed.tsx`.

Gating is driven by the view model (`src/lib/stablecoin-detail-view-model.ts` → `hasBlacklist`) so the scrollspy nav omits the "Blacklist" pill when the section is absent.
```

- [ ] **Step 8.3: Update API reference**

Open `docs/api-reference.md`, find the `/api/blacklist-summary` response schema. Update the `stats` object to list the four new fields:

```markdown
- `perCoinFrozenAddressCount: Record<BlacklistStablecoin, number>` — net-frozen address count per coin (addresses whose latest event is `blacklist`).
- `perCoinFrozenTotal: Record<BlacklistStablecoin, number>` — USD total from the freeze-ledger snapshot table, per coin.
- `perCoinDestroyedTotal: Record<BlacklistStablecoin, number>` — USD total of `destroy` events per coin.
- `perCoinQuarterlyEventTypes: Record<BlacklistStablecoin, Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>>` — per-coin quarterly breakdown of event-type counts; zero-filled between each coin's earliest and latest bucket for contiguous charting.
```

- [ ] **Step 8.4: Run doc count guard**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm run check:doc-counts || true
```

Expected: pass, or a clean report showing no drift. If it fails for reasons unrelated to this change, leave them for a separate PR.

- [ ] **Step 8.5: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add docs/blacklist-tracker.md docs/api-reference.md
git commit -m "docs: document detail-page blacklist block and new summary fields"
```

---

## Task 9: Final verification

- [ ] **Step 9.1: Run the full merge-gate**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm run test:merge-gate 2>&1 | tail -50
```

Expected: all gates pass. Fix anything that fails before proceeding.

- [ ] **Step 9.2: Manual browser smoke test**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm run dev
```

Open in a browser:
- `/stablecoin/usd-coin` → should show the new Blacklist Activity block with stats + chart + 10 events, and a "Blacklist" pill in the scrollspy nav.
- `/stablecoin/tether` → same (USDT has heavy blacklist activity).
- `/stablecoin/dai` → DAI is not in `BLACKLIST_STABLECOINS`, so the block and scrollspy pill should be absent.
- Click "See all events →" on USDC's block → should land on `/blacklist?stablecoin=USDC` with the filter applied to the table.

- [ ] **Step 9.3: If smoke test reveals issues, fix them and commit**

Any UI polish issues (spacing, alignment, overflowing numbers, etc.) get fixed in this task — one commit per logical fix. Do not defer.

---

## Self-Review

### Spec coverage

- Gating on `BLACKLIST_STABLECOINS` + `perCoinTotalEvents[symbol] > 0` — Task 6 step 6.3, Task 7 step 7.2.
- Placement after `FlowsSection` with two sibling sections — Task 6 step 6.3, Task 7 step 7.3.
- Four new API fields (`perCoinFrozenAddressCount`, `perCoinFrozenTotal`, `perCoinDestroyedTotal`, `perCoinQuarterlyEventTypes`) — Tasks 1 & 2.
- `suppression_reason` filter — Task 2 step 2.3 (SQL `WHERE suppression_reason IS NULL`), step 2.7 (test covers the empty case).
- "See all events →" link — Task 5 step 5.1.
- Scrollspy conditional — Task 7 steps 7.2–7.3.
- Silent error behaviour — Task 6 step 6.3 (`if (isError) return null`).
- Edge case 5a (freeze-ledger gap shows zeros) — default behaviour of `Object.fromEntries` pre-seeding with zeros in Task 2 step 2.4.

### Placeholder scan

- No TBDs, TODOs, or "implement later" markers.
- All file paths are absolute or repo-relative and real.
- All code blocks are complete compilable TypeScript/TSX snippets.
- Step 2.1 has one intentional placeholder `7_604` with explicit instruction to compute the real bucket value and inline it before running the test.

### Type consistency

- `BlacklistQuarterlyEventTypePoint` defined in Task 1, referenced in Tasks 2 & 4 with identical shape.
- `BlacklistStablecoin` used consistently in prop types and runtime membership checks.
- `symbol` prop name consistent across all four components and the orchestrator.
- `useBlacklistSummary` return shape (`data / isLoading / isError`) matches existing hook signature verified in pre-plan exploration.
- `useBlacklistEventsPage` params use `stablecoin` / `limit` / `offset` as confirmed in pre-plan exploration.
