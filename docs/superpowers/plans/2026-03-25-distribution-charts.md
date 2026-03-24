# Distribution Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Distribution" section to the stablecoin detail page with two donut charts: chain supply distribution and DEX liquidity protocol distribution.

**Architecture:** Single new component (`DistributionSection`) dynamically imported into the detail page client. Uses existing `useStablecoins()` and `useDexLiquidity()` hooks — no API or pipeline changes. Hex color maps added to `dex-constants.ts` for SVG fills.

**Tech Stack:** React 19, Recharts (`PieChart`/`Pie`/`Cell`/`Tooltip`/`Label`), TanStack Query (via existing hooks), Tailwind CSS v4.

**Spec:** `docs/superpowers/specs/2026-03-25-distribution-charts-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/dex-constants.ts` | Modify | Add `CHAIN_HEX` and `PROTOCOL_HEX` hex color maps |
| `src/components/stablecoin-detail/distribution-section.tsx` | Create | Donut chart cards for chain + protocol distribution |
| `src/app/stablecoin/[id]/client.tsx` | Modify | Wire up section entry, dynamic import, render slot |

---

### Task 1: Add hex color maps to dex-constants.ts

**Files:**
- Modify: `src/lib/dex-constants.ts`

- [ ] **Step 1: Add `CHAIN_HEX` map**

Append after the existing `CHAIN_COLORS` block (line 73) in `src/lib/dex-constants.ts`:

```ts
/** Hex equivalents of CHAIN_COLORS for SVG fill attributes (Recharts) */
export const CHAIN_HEX: Record<string, string> = {
  ethereum:  "#2563eb",
  arbitrum:  "#0ea5e9",
  base:      "#60a5fa",
  polygon:   "#8b5cf6",
  bsc:       "#f59e0b",
  optimism:  "#ef4444",
  avalanche: "#dc2626",
  solana:    "#10b981",
  gnosis:    "#14b8a6",
  fantom:    "#93c5fd",
};
```

- [ ] **Step 2: Add `PROTOCOL_HEX` map**

Append after `CHAIN_HEX`:

```ts
/** Hex equivalents of PROTOCOL_COLORS for SVG fill attributes (Recharts) */
export const PROTOCOL_HEX: Record<string, string> = {
  curve:        "#3b82f6",
  "uniswap-v3": "#ec4899",
  uniswap:      "#f472b6",
  fluid:        "#06b6d4",
  balancer:     "#8b5cf6",
  aerodrome:    "#0ea5e9",
  velodrome:    "#ef4444",
  pancakeswap:  "#f59e0b",
  sushiswap:    "#6366f1",
  "trader-joe": "#f97316",
  raydium:      "#a855f7",
  orca:         "#2dd4bf",
  quickswap:    "#8b5cf6",
};
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit --project tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dex-constants.ts
git commit -m "Add CHAIN_HEX and PROTOCOL_HEX maps for SVG chart fills"
```

---

### Task 2: Create the DistributionSection component

**Files:**
- Create: `src/components/stablecoin-detail/distribution-section.tsx`

**Key references for the implementer:**
- Donut chart pattern: `src/components/cemetery-charts.tsx` lines 63-114
- Tooltip: `src/components/pharos-chart-tooltip.tsx` (`PharosChartTooltip`, `TooltipRow`)
- Chart container: `src/hooks/use-chart-container-ready.ts`
- Section title: `src/components/stablecoin-detail/section-title.ts` (`DETAIL_SECTION_TITLE_CLASS`)
- Color maps: `src/lib/dex-constants.ts` (`CHAIN_HEX`, `PROTOCOL_HEX`, `normalizeChain`, `prettifyProtocol`, `PROTOCOL_LOGOS`)
- Chain logos: `@shared/lib/chains` (`CHAIN_META`)
- Format: `@shared/lib/format` (`formatCurrency`)
- Chart palette fallback: `@/lib/chart-colors` (`CHART_PALETTE`, `CHART_SLATE`)
- Hooks: `@/hooks/use-stablecoins` (`useStablecoins`), `@/hooks/api-hooks` (`useDexLiquidity`)
- Card primitives: `@/components/ui/card` (`Card`, `CardContent`, `CardHeader`, `CardTitle`)
- Skeleton: `@/components/ui/skeleton`

- [ ] **Step 1: Create the file with shared types and data preparation helper**

Create `src/components/stablecoin-detail/distribution-section.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, Label } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { PharosChartTooltip, TooltipRow } from "@/components/pharos-chart-tooltip";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useDexLiquidity } from "@/hooks/api-hooks";
import { formatCurrency } from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import { CHART_PALETTE, CHART_SLATE } from "@/lib/chart-colors";
import {
  CHAIN_HEX,
  PROTOCOL_HEX,
  PROTOCOL_LOGOS,
  normalizeChain,
  prettifyProtocol,
} from "@/lib/dex-constants";

/* ── Types ── */

interface DonutDatum {
  name: string;
  value: number;
  hex: string;
  logoPath?: string;
  darkInvert?: boolean;
}

/* ── Data preparation ── */

const OTHER_THRESHOLD = 0.02;

function buildDonutData(
  raw: Record<string, number>,
  opts: {
    labelForKey: (key: string) => string;
    hexForKey: (key: string) => string | undefined;
    logoForKey?: (key: string) => { path: string; darkInvert?: boolean } | null;
  },
): { data: DonutDatum[]; total: number } {
  const entries = Object.entries(raw)
    .map(([key, value]) => ({ key, value }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = entries.reduce((sum, e) => sum + e.value, 0);
  if (total === 0) return { data: [], total: 0 };

  const data: DonutDatum[] = [];
  let otherValue = 0;

  for (const e of entries) {
    if (e.value / total < OTHER_THRESHOLD) {
      otherValue += e.value;
    } else {
      const logo = opts.logoForKey?.(e.key);
      data.push({
        name: opts.labelForKey(e.key),
        value: e.value,
        hex: opts.hexForKey(e.key) ?? CHART_PALETTE[data.length % CHART_PALETTE.length],
        logoPath: logo?.path,
        darkInvert: logo?.darkInvert,
      });
    }
  }

  if (otherValue > 0) {
    data.push({ name: "Other", value: otherValue, hex: CHART_SLATE });
  }

  return { data, total };
}
```

- [ ] **Step 2: Add the DonutCard sub-component**

Append to the same file:

```tsx
/* ── Donut card ── */

function CenterLabel({ cx, cy, text }: { cx: number; cy: number; text: string }) {
  return (
    <text
      x={cx}
      y={cy}
      textAnchor="middle"
      dominantBaseline="central"
      className="fill-foreground"
      style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600 }}
    >
      {text}
    </text>
  );
}

function DonutCard({
  title,
  ariaLabel,
  data,
  total,
}: {
  title: string;
  ariaLabel: string;
  data: DonutDatum[];
  total: number;
}) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={ref}
          className="pharos-chart-stage h-[200px] sm:h-[250px]"
          role="figure"
          aria-label={ariaLabel}
        >
          {ready ? (
            <PieChart width={width} height={height}>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={85}
                dataKey="value"
                nameKey="name"
                paddingAngle={3}
                strokeWidth={0}
              >
                {data.map((d, i) => (
                  <Cell key={i} fill={d.hex} />
                ))}
                <Label
                  content={(props) => {
                    const vb = props.viewBox;
                    if (!vb || !("cx" in vb)) return null;
                    return <CenterLabel cx={vb.cx} cy={vb.cy} text={formatCurrency(total)} />;
                  }}
                  position="center"
                />
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const d = payload[0].payload as DonutDatum;
                  const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : "0";
                  return (
                    <PharosChartTooltip active={active}>
                      <TooltipRow color={d.hex} label={d.name} value={`${formatCurrency(d.value)} (${pct}%)`} />
                    </PharosChartTooltip>
                  );
                }}
              />
            </PieChart>
          ) : null}
        </div>

        {/* Legend — uses hex inline styles for dot color (same visual output as Tailwind bg-* classes,
           avoids carrying a separate colorClass field through DonutDatum) */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {data.map((d) => (
            <span key={d.name} className="flex items-center gap-1.5">
              {d.logoPath ? (
                <img
                  src={d.logoPath}
                  alt=""
                  width={14}
                  height={14}
                  className={`h-3.5 w-3.5 rounded-full object-contain shrink-0${d.darkInvert ? " dark:invert" : ""}`}
                />
              ) : (
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.hex }} />
              )}
              <span>{d.name}</span>
              <span className="font-mono tabular-nums">
                {total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : "—"}
              </span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Add the exported DistributionSection component**

Append to the same file:

```tsx
/* ── Main section ── */

function ChainDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const { data: listData, isLoading } = useStablecoins();

  const { data, total } = useMemo(() => {
    const coin = listData?.peggedAssets.find((a) => a.id === stablecoinId);
    if (!coin?.chainCirculating) return { data: [], total: 0 };

    const raw: Record<string, number> = {};
    for (const [chain, info] of Object.entries(coin.chainCirculating)) {
      if (info.current > 0) raw[chain] = info.current;
    }

    return buildDonutData(raw, {
      labelForKey: normalizeChain,
      hexForKey: (key) => CHAIN_HEX[key.toLowerCase()],
      logoForKey: (key) => {
        const meta = CHAIN_META[key.toLowerCase()];
        return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
      },
    });
  }, [listData, stablecoinId]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>Chain Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] sm:h-[250px] rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) return null;

  return (
    <DonutCard
      title="Chain Distribution"
      ariaLabel={`Supply distribution across ${data.length} chains`}
      data={data}
      total={total}
    />
  );
}

function DexDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const { data: liquidityMap, isLoading } = useDexLiquidity();

  const { data, total } = useMemo(() => {
    const liq = liquidityMap?.[stablecoinId];
    if (!liq?.protocolTvl) return { data: [], total: 0 };

    return buildDonutData(liq.protocolTvl, {
      labelForKey: prettifyProtocol,
      hexForKey: (key) => PROTOCOL_HEX[key],
      logoForKey: (key) => {
        const path = PROTOCOL_LOGOS[key];
        return path ? { path } : null;
      },
    });
  }, [liquidityMap, stablecoinId]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>DEX Liquidity Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] sm:h-[250px] rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>DEX Liquidity Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground">
            No DEX liquidity data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <DonutCard
      title="DEX Liquidity Distribution"
      ariaLabel={`DEX liquidity distribution across ${data.length} protocols`}
      data={data}
      total={total}
    />
  );
}

export function DistributionSection({ stablecoinId }: { stablecoinId: string }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
      <ChainDistributionCard stablecoinId={stablecoinId} />
      <DexDistributionCard stablecoinId={stablecoinId} />
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit --project tsconfig.json`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/stablecoin-detail/distribution-section.tsx
git commit -m "Add DistributionSection with chain and DEX donut charts"
```

---

### Task 3: Integrate into the detail page

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx`

- [ ] **Step 1: Add to DETAIL_SECTIONS**

In `src/app/stablecoin/[id]/client.tsx`, add the distribution entry to the `DETAIL_SECTIONS` array after the `chart` entry (line ~81):

```ts
// After: { id: "chart", label: "Chart" },
{ id: "distribution", label: "Distribution" },
// Before: { id: "info", label: "Info" },
```

- [ ] **Step 2: Add dynamic import**

Add after the `CollateralUsageSection` dynamic import block (around line ~67):

```ts
const DistributionSection = dynamic(
  () => import("@/components/stablecoin-detail/distribution-section").then((mod) => mod.DistributionSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);
```

- [ ] **Step 3: Add render slot**

Insert between `<section id="chart">` (line ~283) and `<section id="info">` (line ~287):

```tsx
      <section id="distribution">
        <SectionErrorBoundary name="distribution">
          <DistributionSection stablecoinId={viewModel.id} />
        </SectionErrorBoundary>
      </section>
```

`SectionErrorBoundary` is already imported (used for the liquidity section).

- [ ] **Step 4: Verify build**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/stablecoin/[id]/client.tsx
git commit -m "Wire DistributionSection into stablecoin detail page"
```

---

### Task 4: Visual verification and merge gate

- [ ] **Step 1: Run the merge gate**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run test:merge-gate`
Expected: All checks pass (lint, typecheck, tests, coverage, worker typecheck).

- [ ] **Step 2: Fix any lint or type issues discovered**

If the merge gate reports problems, fix them and re-run until it passes.

- [ ] **Step 3: Final commit (if fixes were needed)**

```bash
git add -u
git commit -m "Fix lint/type issues in distribution charts"
```
