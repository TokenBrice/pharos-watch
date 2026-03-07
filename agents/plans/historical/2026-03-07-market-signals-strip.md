# Market Signals Strip Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the two-card MarketHighlights component (BiggestDepegs + FastestMovers) with a single compact horizontal "Market Signals" strip that is denser on desktop and readable on mobile.

**Architecture:** Single-file rewrite of `src/components/market-highlights.tsx`. The exported component name (`MarketHighlights`) and props interface (`MarketHighlightsProps`) stay identical — no changes to the parent (`src/components/homepage-client.tsx`). Internally, the two sub-components (`BiggestDepegs`, `FastestMovers`) are replaced by a unified strip with two zones: depegs left, movers right, separated by a divider. Items are compact inline links. Item count adapts per breakpoint via Tailwind responsive `hidden`/`flex` classes.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui Card primitives

**Key references:**
- Design doc: `agents/plans/2026-03-07-market-signals-strip-design.md`
- Existing component: `src/components/market-highlights.tsx`
- Design tokens: `docs/design-tokens.md`, `docs/design-language.md`
- Format helpers: `shared/lib/format.ts` (`formatPegDeviation`, `formatBps`)
- Supply helpers: `shared/lib/supply.ts` (`getCirculatingRaw`, `getPrevWeekRaw`)
- Peg reference: `shared/lib/peg-rates.ts` (`getPegReference`)
- Metadata: `shared/lib/stablecoins.ts` (`TRACKED_IDS`, `TRACKED_META_BY_ID`)
- URL builder: `src/lib/urls.ts` (`buildStablecoinUrl`)
- Logo: `src/components/stablecoin-logo.tsx` (`StablecoinLogo`)

---

## Task 1: Rewrite the MarketHighlights component

**Files:**
- Modify: `src/components/market-highlights.tsx` (full rewrite, keep same export name + props)

### Step 1: Read the existing file

Read `src/components/market-highlights.tsx` to confirm current structure. You will see:
- `BiggestDepegs` sub-component (~lines 29-127)
- `FastestMovers` sub-component (~lines 131-235)
- `MarketHighlights` export (~lines 239-265) that renders both in a 2-column grid
- `MarketHighlightsProps` interface with `{ data, logos, pegRates }`
- Two skeleton constants: `SKELETON_COLS`, `SKELETON_ROWS`

### Step 2: Replace the entire file contents

Replace the entire file with the code below. This is a complete rewrite — do not merge with existing code.

```tsx
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatPegDeviation } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinData } from "@shared/types";

/* ─── Constants ─────────────────────────────────────────────────── */

const SKELETON_DEPEG_INDICES = Array.from({ length: 4 }, (_, i) => i);
const SKELETON_MOVER_INDICES = Array.from({ length: 3 }, (_, i) => i);

const SUPPLY_FLOOR = 1_000_000;

/**
 * Responsive visibility classes per item index.
 * Index 0-1: always visible.
 * Index 2: visible from sm+.
 * Index 3: visible from lg+ (depegs only — movers cap at 3).
 */
const DEPEG_VIS: Record<number, string> = {
  0: "flex",
  1: "flex",
  2: "hidden sm:flex",
  3: "hidden lg:flex",
};

const MOVER_VIS: Record<number, string> = {
  0: "flex",
  1: "flex",
  2: "hidden sm:flex",
};

/* ─── Types ─────────────────────────────────────────────────────── */

interface MarketHighlightsProps {
  data: StablecoinData[] | undefined;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
}

interface DepegEntry {
  id: string;
  symbol: string;
  name: string;
  bps: number;
}

interface MoverEntry {
  id: string;
  symbol: string;
  name: string;
  pctChange: number;
}

/* ─── Data hooks ────────────────────────────────────────────────── */

function useDepegs(data: StablecoinData[] | undefined, pegRates: Record<string, number>) {
  return useMemo(() => {
    if (!data) return [];

    const entries: DepegEntry[] = [];

    for (const coin of data) {
      const meta = TRACKED_META_BY_ID.get(coin.id);
      if (!meta) continue;
      if (meta.flags.navToken) continue;
      if (coin.price == null || typeof coin.price !== "number" || isNaN(coin.price)) continue;
      const supply = getCirculatingRaw(coin);
      if (supply < SUPPLY_FLOOR) continue;

      const pegRef = getPegReference(coin.pegType, pegRates, meta.commodityOunces);
      if (pegRef === 0) continue;
      const bps = Math.round(((coin.price / pegRef) - 1) * 10000);

      entries.push({ id: coin.id, symbol: coin.symbol, name: coin.name, bps });
    }

    entries.sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));
    return entries.slice(0, 4);
  }, [data, pegRates]);
}

function useMovers(data: StablecoinData[] | undefined) {
  return useMemo(() => {
    if (!data) return { growers: [] as MoverEntry[], shrinkers: [] as MoverEntry[] };

    const entries: MoverEntry[] = [];

    for (const coin of data) {
      if (!TRACKED_IDS.has(coin.id)) continue;
      const current = getCirculatingRaw(coin);
      const prev = getPrevWeekRaw(coin);
      if (current < SUPPLY_FLOOR || prev < SUPPLY_FLOOR) continue;

      const pctChange = ((current - prev) / prev) * 100;
      entries.push({ id: coin.id, symbol: coin.symbol, name: coin.name, pctChange });
    }

    const sorted = [...entries].sort((a, b) => b.pctChange - a.pctChange);
    return {
      growers: sorted.slice(0, 3),
      shrinkers: sorted.slice(-3).reverse().filter((e) => e.pctChange < 0),
    };
  }, [data]);
}

/* ─── Color helpers ─────────────────────────────────────────────── */

/**
 * Sign-aware depeg color:
 * - Below peg (negative bps): red — insolvency/redemption concern
 * - Above peg (positive bps): amber — liquidity premium
 * - Near peg (<10 bps absolute): muted
 */
function depegColorClass(bps: number): string {
  const abs = Math.abs(bps);
  if (abs < 10) return "text-muted-foreground";
  if (bps < 0) return "text-red-700 dark:text-red-400";
  return "text-amber-700 dark:text-amber-400";
}

/* ─── Sub-components ────────────────────────────────────────────── */

function DepegEntry({
  entry,
  logos,
  visClass,
}: {
  entry: DepegEntry;
  logos?: Record<string, string>;
  visClass: string;
}) {
  return (
    <Link
      href={buildStablecoinUrl(entry.id)}
      className={`${visClass} pharos-focus-ring group items-center gap-1.5 rounded-md px-1.5 py-1 transition-[background-color,color] duration-150 hover:bg-muted/40`}
    >
      <StablecoinLogo src={logos?.[entry.id]} name={entry.name} size={16} />
      <span className="text-xs font-medium group-hover:underline group-focus-visible:underline">
        {entry.symbol}
      </span>
      <span className={`text-xs font-mono font-semibold ${depegColorClass(entry.bps)}`}>
        {formatPegDeviation(entry.bps / 10000 + 1, 1)}
      </span>
    </Link>
  );
}

function MoverPairRow({
  grower,
  shrinker,
  logos,
  visClass,
}: {
  grower: MoverEntry | undefined;
  shrinker: MoverEntry | undefined;
  logos?: Record<string, string>;
  visClass: string;
}) {
  return (
    <div className={`${visClass} grid grid-cols-2 gap-x-3`}>
      {grower ? (
        <Link
          href={buildStablecoinUrl(grower.id)}
          className="pharos-focus-ring group flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-[background-color,color] duration-150 hover:bg-muted/40"
        >
          <StablecoinLogo src={logos?.[grower.id]} name={grower.name} size={16} />
          <span className="truncate text-xs font-medium group-hover:underline group-focus-visible:underline">
            {grower.symbol}
          </span>
          <span className="text-xs font-mono font-semibold text-emerald-700 dark:text-emerald-400 ml-auto flex-shrink-0">
            +{grower.pctChange.toFixed(1)}%
          </span>
        </Link>
      ) : (
        <div />
      )}
      {shrinker ? (
        <Link
          href={buildStablecoinUrl(shrinker.id)}
          className="pharos-focus-ring group flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-[background-color,color] duration-150 hover:bg-muted/40"
        >
          <StablecoinLogo src={logos?.[shrinker.id]} name={shrinker.name} size={16} />
          <span className="truncate text-xs font-medium group-hover:underline group-focus-visible:underline">
            {shrinker.symbol}
          </span>
          <span className="text-xs font-mono font-semibold text-red-700 dark:text-red-400 ml-auto flex-shrink-0">
            {shrinker.pctChange.toFixed(1)}%
          </span>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}

/* ─── Skeleton ──────────────────────────────────────────────────── */

function MarketSignalsSkeleton() {
  return (
    <div className="pharos-card-shell flex flex-col lg:flex-row lg:divide-x lg:divide-border/40 divide-y lg:divide-y-0 divide-border/40">
      {/* Depegs skeleton */}
      <div className="flex-1 p-4 space-y-2.5">
        <Skeleton className="h-2.5 w-24" />
        <div className="grid grid-cols-2 gap-2">
          {SKELETON_DEPEG_INDICES.map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
      {/* Movers skeleton */}
      <div className="flex-1 p-4 space-y-2.5">
        <Skeleton className="h-2.5 w-20" />
        <div className="space-y-2">
          {SKELETON_MOVER_INDICES.map((i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Main export ───────────────────────────────────────────────── */

export function MarketHighlights({ data, logos, pegRates }: MarketHighlightsProps) {
  const depegs = useDepegs(data, pegRates ?? {});
  const { growers, shrinkers } = useMovers(data);

  if (!data) return <MarketSignalsSkeleton />;

  const moverPairCount = Math.max(growers.length, shrinkers.length);

  return (
    <div className="pharos-card-shell flex flex-col lg:flex-row lg:divide-x lg:divide-border/40 divide-y lg:divide-y-0 divide-border/40 animate-in fade-in duration-300">
      {/* ── Depegs zone ── */}
      <div className="flex-1 p-4">
        <h2 className="pharos-kicker mb-2.5">Biggest Depegs</h2>
        {depegs.length === 0 ? (
          <p className="text-xs text-muted-foreground">All on-peg</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {depegs.map((d, i) => (
              <DepegEntry
                key={d.id}
                entry={d}
                logos={logos}
                visClass={DEPEG_VIS[i] ?? "hidden"}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Movers zone ── */}
      <div className="flex-1 p-4">
        <h2 className="pharos-kicker mb-2.5">Movers <span className="normal-case font-normal text-muted-foreground">(7d)</span></h2>
        {moverPairCount === 0 ? (
          <p className="text-xs text-muted-foreground">No significant moves</p>
        ) : (
          <div className="space-y-1">
            {Array.from({ length: moverPairCount }).map((_, i) => (
              <MoverPairRow
                key={i}
                grower={growers[i]}
                shrinker={shrinkers[i]}
                logos={logos}
                visClass={MOVER_VIS[i] ?? "hidden"}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

**Critical notes for the implementing agent:**

1. **`formatPegDeviation` expects a price ratio, not raw bps.** The function at `shared/lib/format.ts` computes bps internally from `(price / pegValue - 1) * 10000`. So we pass `entry.bps / 10000 + 1` as the price and `1` as the peg value to reconstruct the ratio. This reuses the existing formatter and its `+/-` sign and ` bps` suffix.

2. **Tailwind classes must be static strings.** The `DEPEG_VIS` and `MOVER_VIS` lookup maps contain complete static class strings — they are NOT dynamically constructed. Tailwind's JIT scanner will find `"hidden sm:flex"` and `"hidden lg:flex"` in the source.

3. **The `MarketHighlightsProps` interface is re-declared identically** to keep this file self-contained. The parent (`homepage-client.tsx`) already passes `{ data, logos, pegRates }` — no changes needed there.

4. **No Card/CardHeader/CardContent imports.** The new component uses raw `pharos-card-shell` class on a plain `<div>` for zero chrome overhead. The old `Card` import is removed.

5. **`divide-x`/`divide-y` for the divider.** On desktop (`lg+`), zones sit side-by-side with a vertical divider via `lg:divide-x lg:divide-border/40`. On mobile, they stack with a horizontal divider via `divide-y divide-border/40`. The `lg:divide-y-0` cancels the horizontal divider on desktop.

### Step 3: Verify the build

```bash
npm run build
```

Expected: Clean build, no type errors. The component is only consumed by `homepage-client.tsx` which already passes the correct props.

### Step 4: Run lint

```bash
npm run lint
```

Expected: 0 errors (pre-existing warnings are fine).

### Step 5: Run tests

```bash
npm test
```

Expected: All tests pass. There are no dedicated tests for `MarketHighlights` — it's a presentation component tested visually.

### Step 6: Commit

```bash
git add src/components/market-highlights.tsx
git commit -m "refactor: replace market highlights with compact signals strip

- Merge BiggestDepegs + FastestMovers into single horizontal strip
- Sign-aware depeg coloring (red below-peg, amber above-peg)
- Paired movers rows (grower vs shrinker per row)
- Responsive item capping via CSS (2/3/4 items by breakpoint)
- Compact entries: logo + symbol + value only (no prices)
- Divider-separated zones: depegs left, movers right on desktop

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Visual verification

This is a presentation-heavy change. After committing, verify visually.

### Step 1: Start the dev server

```bash
npm run dev
```

### Step 2: Check desktop layout (1280px+)

Open http://localhost:3000 in a browser. Verify:
- Single card with two zones side-by-side
- Vertical divider between depegs and movers zones
- Depegs zone: 4 entries in a 2-column grid, each showing logo + symbol + colored bps
- Movers zone: 3 paired rows, grower left + shrinker right
- Below-peg depegs show red, above-peg show amber
- Each entry is a clickable link to the coin detail page
- Hover state: subtle background highlight + underline on symbol

### Step 3: Check tablet layout (768px)

Resize to 768px width. Verify:
- Same two-zone layout but 4th depeg entry is hidden (only 3 visible)
- Movers show all 3 pairs

### Step 4: Check mobile layout (<640px)

Resize to 375px width. Verify:
- Zones stack vertically with horizontal divider
- Only 2 depeg entries visible
- Only 2 mover pairs visible
- No text truncation or overflow — entries fit cleanly
- All text is readable

### Step 5: Check empty states

If you can trigger empty states (unlikely with real data), verify:
- "All on-peg" text in depegs zone
- "No significant moves" in movers zone

### Step 6: Check skeleton loading

Hard-refresh the page or throttle network to see the skeleton state. Verify it matches the two-zone layout shape.
