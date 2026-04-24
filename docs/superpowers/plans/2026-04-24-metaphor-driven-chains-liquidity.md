# Metaphor-Driven Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the named-but-not-drawn metaphors on `/chains` (Harbor Map) and `/liquidity` (Pool Depth) with data-encoding SVG scenes that visually render the metaphor, matching `/cemetery` and `/alt-pegs` conventions.

**Architecture:** Two independent phases, each independently shippable. Phase 1 splits the existing `harbor-map.tsx` into a pure-model module, a legacy bar-list, and a new `NauticalChart` SVG scene (desktop) with list fallback (`< xl`). Phase 2 introduces `DepthGauges` on `/liquidity` — a grid of vertical cylinder SVGs plus a Global Reservoir hero, with filter state lifted to `LiquidityClient` as a single source of truth.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Vitest + Testing Library, inline JSX SVG with semantic CSS variables. No new deps.

**Reference docs:** `docs/superpowers/specs/2026-04-24-metaphor-driven-chains-liquidity-design.md`

---

## Phase 1 — /chains Nautical Chart

### Task 1: Atomic split of harbor-map into model + HarborList

One atomic refactor: no intermediate shims. Because `harbor-map.ts` and `harbor-map.tsx` can't coexist (module resolution picks one), we replace the .tsx file with a .ts file in a single step and move its JSX into a new `harbor-list.tsx` at the same time.

**Files:**
- Create: `src/app/chains/harbor-map.ts` (pure model)
- Create: `src/app/chains/harbor-list.tsx` (component, extracted)
- Delete: src/app/chains/harbor-map.tsx (removed; its pieces now live in harbor-map.ts and harbor-list.tsx)
- Modify: `src/app/chains/client.tsx` (swap import)
- Modify: `src/app/chains/harbor-map.test.ts` (import from new locations)

- [ ] **Step 1: Create the pure-TS model module**

```ts
// src/app/chains/harbor-map.ts
import { CHAIN_META } from "@shared/lib/chains";
import type { ChainSummary, HealthBand } from "@shared/types/chains";

const MAX_HARBORS = 8;

export interface ChainHarborEntry {
  id: string;
  name: string;
  logoPath: string;
  darkInvert: boolean;
  totalUsd: number;
  sharePct: number;
  berthPct: number;
  healthScore: number | null;
  healthBand: HealthBand | null;
  stablecoinCount: number;
  dominantSymbol: string;
  dominantSharePct: number;
  change7dPct: number;
}

export interface ChainHarborModel {
  totalUsd: number;
  harborCount: number;
  entries: ChainHarborEntry[];
  topSharePct: number;
  largestHarbor: ChainHarborEntry | null;
  fragileHarbors: number;
  averageHealthScore: number | null;
}

export function buildChainHarborModel(
  chains: ChainSummary[],
  globalTotalUsd: number,
): ChainHarborModel {
  const sorted = [...chains].sort((a, b) => b.totalUsd - a.totalUsd);
  const top = sorted.slice(0, MAX_HARBORS);
  const maxSupply = top[0]?.totalUsd ?? 0;
  const topSupply = top.reduce((sum, chain) => sum + chain.totalUsd, 0);
  const scored = chains
    .map((chain) => chain.healthScore)
    .filter((score): score is number => score != null);

  const entries = top.map((chain) => ({
    id: chain.id,
    name: chain.name,
    logoPath: chain.logoPath,
    darkInvert: CHAIN_META[chain.id]?.darkInvert ?? false,
    totalUsd: chain.totalUsd,
    sharePct: globalTotalUsd > 0 ? (chain.totalUsd / globalTotalUsd) * 100 : 0,
    berthPct: maxSupply > 0 ? (chain.totalUsd / maxSupply) * 100 : 0,
    healthScore: chain.healthScore,
    healthBand: chain.healthBand,
    stablecoinCount: chain.stablecoinCount,
    dominantSymbol: chain.dominantStablecoin.symbol,
    dominantSharePct: chain.dominantStablecoin.share * 100,
    change7dPct: chain.change7dPct,
  }));

  return {
    totalUsd: globalTotalUsd,
    harborCount: chains.length,
    entries,
    topSharePct: globalTotalUsd > 0 ? (topSupply / globalTotalUsd) * 100 : 0,
    largestHarbor: entries[0] ?? null,
    fragileHarbors: chains.filter((chain) => chain.healthBand === "fragile" || chain.healthBand === "concentrated").length,
    averageHealthScore: scored.length > 0
      ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length)
      : null,
  };
}

export const HARBOR_MAX = MAX_HARBORS;
```

- [ ] **Step 2: Delete harbor-map.tsx**

```bash
rm src/app/chains/harbor-map.tsx
```

(The JSX from this file moves to `harbor-list.tsx` in the next step.)

- [ ] **Step 3: Create harbor-list.tsx with the extracted JSX**

See the full file content in Task 3 below — copy it verbatim here. (Kept separate for readability.) Import `buildChainHarborModel` from `./harbor-map`.

*Full content:* same as the body of Task 3's `harbor-list.tsx` in this plan. Create it now so nothing is broken after the delete.

- [ ] **Step 4: Update src/app/chains/client.tsx**

Change the import line:

```tsx
import { ChainHarborMap } from "./harbor-map";
```

to:

```tsx
import { HarborList } from "./harbor-list";
```

And the JSX usage:

```tsx
<ChainHarborMap chains={data.chains} globalTotalUsd={data.globalTotalUsd} />
```

to:

```tsx
<HarborList chains={data.chains} globalTotalUsd={data.globalTotalUsd} />
```

(Task 3 later swaps this to `<NauticalChart>`; this step keeps the build green in the interim.)

- [ ] **Step 5: Update harbor-map.test.ts**

Change line 6 from:

```ts
import { buildChainHarborModel, ChainHarborMap } from "./harbor-map";
```

to:

```ts
import { buildChainHarborModel } from "./harbor-map";
import { HarborList as ChainHarborMap } from "./harbor-list";
```

The existing tests reference `ChainHarborMap` by that alias — they keep working unchanged.

- [ ] **Step 6: Run tests + type-check**

```bash
npm test -- src/app/chains/ --run
npx tsc --noEmit
```

Expected: all four existing harbor-map tests PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(chains): split harbor-map into pure model + HarborList"
```

---

### Task 2: Add nautical-scene helper math + tests

**Files:**
- Create: `src/app/chains/nautical-scene-math.ts`
- Test: `src/app/chains/nautical-scene-math.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/chains/nautical-scene-math.test.ts
import { describe, it, expect } from "vitest";
import {
  hullWidth,
  cargoBuckets,
  depthLayers,
  wakeLength,
  aggregateSkyBand,
} from "./nautical-scene-math";

describe("hullWidth", () => {
  it("returns minimum width when supply is zero", () => {
    expect(hullWidth(0, 1_000_000, 400)).toBe(28);
  });
  it("returns full inner width for the largest chain", () => {
    expect(hullWidth(1_000_000, 1_000_000, 400)).toBeCloseTo(400 - 40);
  });
  it("is monotonic non-decreasing across a supply range", () => {
    const widths = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000]
      .map((s) => hullWidth(s, 1_000_000, 400));
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]!);
    }
  });
});

describe("cargoBuckets", () => {
  it("returns 0 for zero coins", () => {
    expect(cargoBuckets(0)).toBe(0);
  });
  it("returns 1 for 1-5 coins", () => {
    expect(cargoBuckets(1)).toBe(1);
    expect(cargoBuckets(5)).toBe(1);
  });
  it("returns 2 for 6-10 coins", () => {
    expect(cargoBuckets(6)).toBe(2);
    expect(cargoBuckets(10)).toBe(2);
  });
  it("caps at 6 containers", () => {
    expect(cargoBuckets(999)).toBe(6);
  });
});

describe("depthLayers", () => {
  it("returns 1 for dominance below 5%", () => {
    expect(depthLayers(0.03)).toBe(1);
  });
  it("returns 2 for dominance between 5% and 15%", () => {
    expect(depthLayers(0.05)).toBe(2);
    expect(depthLayers(0.14)).toBe(2);
  });
  it("returns 3 for dominance at or above 15%", () => {
    expect(depthLayers(0.15)).toBe(3);
    expect(depthLayers(0.5)).toBe(3);
  });
});

describe("wakeLength", () => {
  it("returns 0 when change is null or undefined", () => {
    expect(wakeLength(null)).toBe(0);
    expect(wakeLength(undefined)).toBe(0);
  });
  it("returns 0 below 0.5% threshold", () => {
    expect(wakeLength(0.003)).toBe(0);
    expect(wakeLength(-0.004)).toBe(0);
  });
  it("scales up to 1 at 20% magnitude", () => {
    expect(wakeLength(0.2)).toBe(1);
    expect(wakeLength(-0.2)).toBe(1);
    expect(wakeLength(0.5)).toBe(1);
  });
  it("preserves direction in sign", () => {
    expect(Math.sign(wakeLength(0.05))).toBe(1);
    expect(Math.sign(wakeLength(-0.05))).toBe(-1);
  });
});

describe("aggregateSkyBand", () => {
  it("returns 'sun' when no fragile or concentrated chains", () => {
    expect(aggregateSkyBand([
      { healthBand: "robust" },
      { healthBand: "healthy" },
      { healthBand: "mixed" },
    ])).toBe("sun");
  });
  it("returns 'fog' when fragile+concentrated ≥ 30%", () => {
    expect(aggregateSkyBand([
      { healthBand: "robust" },
      { healthBand: "healthy" },
      { healthBand: "fragile" },
      { healthBand: "concentrated" },
    ])).toBe("fog");
  });
  it("returns 'sun' when fragile ratio < 30%", () => {
    const bands = Array(10).fill({ healthBand: "healthy" as const });
    bands[0] = { healthBand: "fragile" as const };
    expect(aggregateSkyBand(bands)).toBe("sun");
  });
  it("ignores null bands in the denominator", () => {
    expect(aggregateSkyBand([
      { healthBand: null },
      { healthBand: null },
      { healthBand: "fragile" },
    ])).toBe("fog");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- src/app/chains/nautical-scene-math.test.ts --run
```

Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

```ts
// src/app/chains/nautical-scene-math.ts
import type { HealthBand } from "@shared/types/chains";

const HULL_MIN_WIDTH = 28;
const SCENE_OUTER_PADDING = 40;

/**
 * Log10-scaled hull width. Largest chain fills (cardWidth - padding);
 * smallest rendered ship never drops below HULL_MIN_WIDTH.
 */
export function hullWidth(totalUsd: number, maxUsd: number, cardWidth: number): number {
  const innerWidth = Math.max(cardWidth - SCENE_OUTER_PADDING, HULL_MIN_WIDTH);
  if (maxUsd <= 0 || totalUsd <= 0) return HULL_MIN_WIDTH;
  const ratio = Math.log10(totalUsd + 1) / Math.log10(maxUsd + 1);
  return Math.max(HULL_MIN_WIDTH, Math.min(innerWidth, ratio * innerWidth));
}

/** 0..6 containers. 1 container per 5 coins (rounded up), capped at 6. */
export function cargoBuckets(stablecoinCount: number): number {
  if (stablecoinCount <= 0) return 0;
  return Math.min(6, Math.ceil(stablecoinCount / 5));
}

/** 1 (shallow) / 2 (mid) / 3 (deep). Thresholds: <5% / 5–15% / ≥15%. */
export function depthLayers(dominanceShare: number): 1 | 2 | 3 {
  if (dominanceShare >= 0.15) return 3;
  if (dominanceShare >= 0.05) return 2;
  return 1;
}

/** Normalized wake length in [-1, 1]. Dead zone below 0.5% magnitude. */
export function wakeLength(change7dPct: number | null | undefined): number {
  if (change7dPct == null) return 0;
  const magnitude = Math.abs(change7dPct);
  if (magnitude < 0.005) return 0;
  const scaled = Math.min(1, magnitude / 0.2);
  return Math.sign(change7dPct) * scaled;
}

/**
 * Returns 'fog' if ≥ 30% of rated chains are fragile or concentrated,
 * otherwise 'sun'. Unrated (null band) chains are excluded from the ratio.
 */
export function aggregateSkyBand(
  entries: readonly { healthBand: HealthBand | null }[],
): "sun" | "fog" {
  const rated = entries.filter((e) => e.healthBand != null);
  if (rated.length === 0) return "sun";
  const unhealthy = rated.filter(
    (e) => e.healthBand === "fragile" || e.healthBand === "concentrated",
  ).length;
  return unhealthy / rated.length >= 0.3 ? "fog" : "sun";
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
npm test -- src/app/chains/nautical-scene-math.test.ts --run
```

Expected: PASS (all 15 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/app/chains/nautical-scene-math.ts src/app/chains/nautical-scene-math.test.ts
git commit -m "feat(chains): add nautical scene math helpers"
```

---

### Task 3: HarborList component (body, referenced from Task 1)

This is the full content of `src/app/chains/harbor-list.tsx` referenced by Task 1 Step 3. Create the file with this content verbatim.

**Files:**
- Create: `src/app/chains/harbor-list.tsx`

- [ ] **Step 1: Full file content**

```tsx
// src/app/chains/harbor-list.tsx
"use client";

import Image from "next/image";
import { Anchor, Activity, ShipWheel } from "lucide-react";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import type { ChainSummary } from "@shared/types/chains";
import { HEALTH_BADGE_CLASSES, HEALTH_FILL_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import { buildChainHarborModel } from "./harbor-map";

function formatPercentValue(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function ChainHarborMetric({
  icon,
  label,
  value,
  detail,
  mono = true,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className={cn("mt-1 min-w-0 break-words text-lg font-bold tabular-nums", mono ? "font-mono" : "font-sans")}>{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function HarborList({
  chains,
  globalTotalUsd,
}: {
  chains: ChainSummary[];
  globalTotalUsd: number;
}) {
  const model = buildChainHarborModel(chains, globalTotalUsd);
  if (model.entries.length === 0) return null;

  return (
    <section className="pharos-card-shell overflow-hidden" aria-labelledby="chain-harbor-heading">
      <div className="pharos-panel-header flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Harbor Map</p>
          <h2 id="chain-harbor-heading" className="text-lg font-semibold tracking-tight">
            Where stablecoin supply is docked
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Chain size is cargo; health and dominant-coin share show whether each port is resilient or concentrated.
          </p>
        </div>
        <div className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
          Top {model.entries.length} chains hold {formatPercentValue(model.topSharePct)}
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <div className="space-y-3">
          {model.entries.map((entry, index) => {
            const healthClass = entry.healthBand ? HEALTH_TEXT_CLASSES[entry.healthBand] : "text-muted-foreground";
            const fillClass = entry.healthBand ? HEALTH_FILL_CLASSES[entry.healthBand] : "bg-muted-foreground";
            return (
              <div
                key={entry.id}
                className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border/60 bg-background/35 px-3 py-2.5 sm:grid-cols-[2rem_minmax(8rem,0.95fr)_minmax(0,1.6fr)]"
              >
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <div className="flex min-w-0 items-center gap-2">
                  <Image
                    src={entry.logoPath}
                    alt=""
                    width={22}
                    height={22}
                    className={cn("rounded-full", entry.darkInvert ? "dark:invert" : "")}
                    style={{ width: 22, height: 22 }}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{entry.name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {formatCompactUsd(entry.totalUsd)} / {formatPercentValue(entry.sharePct)}
                    </p>
                  </div>
                </div>
                <div className="col-span-2 min-w-0 space-y-1.5 sm:col-span-1">
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted/45" aria-hidden="true">
                    <div className={cn("h-full rounded-full", fillClass)} style={{ width: `${Math.max(entry.berthPct, 2)}%` }} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className={cn("font-mono font-semibold tabular-nums", healthClass)}>
                      {entry.healthScore ?? "NR"} {entry.healthBand ?? "unrated"}
                    </span>
                    <span>
                      Dominant: <span className="font-mono text-foreground">{entry.dominantSymbol}</span>{" "}
                      {formatPercentValue(entry.dominantSharePct)}
                    </span>
                    <span className={cn("font-mono tabular-nums", trendColor(entry.change7dPct))}>
                      {formatSignedPercent(entry.change7dPct * 100, 2)} 7d
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <ChainHarborMetric
            icon={<Anchor className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />}
            label="Largest port"
            value={model.largestHarbor?.name ?? "n/a"}
            detail={`${model.largestHarbor?.dominantSymbol ?? "n/a"} is the dominant cargo there`}
            mono={false}
          />
          <ChainHarborMetric
            icon={<ShipWheel className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />}
            label="Avg health"
            value={model.averageHealthScore ?? "NR"}
            detail={`${model.harborCount} active chain profiles`}
          />
          <ChainHarborMetric
            icon={<Activity className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />}
            label="Fragile ports"
            value={model.fragileHarbors}
            detail="Chains currently banded fragile or concentrated"
          />
          <div className="rounded-xl border border-border/60 bg-background/35 p-3">
            <p className="pharos-kicker">Health bands</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["robust", "healthy", "mixed", "fragile", "concentrated"] as const).map((band) => (
                <span key={band} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", HEALTH_BADGE_CLASSES[band])}>
                  {band}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
        Source: Chain health snapshot. Harbor size is supply distribution, not issuer redemption capacity.
      </p>
    </section>
  );
}
```

(Tests and commit happen at the end of Task 1 — see Task 1 Steps 6 and 7.)

---

### Task 4: Build NauticalChart SVG scene

**Files:**
- Create: `src/app/chains/nautical-chart.tsx`
- Create: `src/app/chains/nautical-chart.css`

- [ ] **Step 1: Write the CSS keyframes**

```css
/* src/app/chains/nautical-chart.css */
@media (prefers-reduced-motion: no-preference) {
  @keyframes nc-wave-drift {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(6px); }
  }
  @keyframes nc-flag-wave {
    0%, 100% { transform: skewX(-4deg); }
    50% { transform: skewX(4deg); }
  }
  @keyframes nc-sun-pulse {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 1; }
  }

  .nc-waterline {
    animation: nc-wave-drift 8s ease-in-out infinite;
  }
  .nc-flag {
    animation: nc-flag-wave 5s ease-in-out infinite;
    transform-origin: left center;
  }
  .nc-sun {
    animation: nc-sun-pulse 6s ease-in-out infinite;
  }
}
```

- [ ] **Step 2: Write the SVG scene component**

```tsx
// src/app/chains/nautical-chart.tsx
"use client";

import Image from "next/image";
import { Anchor, Activity, ShipWheel } from "lucide-react";
import type { ChainSummary } from "@shared/types/chains";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { HEALTH_BADGE_CLASSES, HEALTH_FILL_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import { buildChainHarborModel, type ChainHarborEntry } from "./harbor-map";
import {
  hullWidth,
  cargoBuckets,
  depthLayers,
  wakeLength,
  aggregateSkyBand,
} from "./nautical-scene-math";
import { HarborList } from "./harbor-list";
import "./nautical-chart.css";

const SCENE_WIDTH = 900;
const SCENE_HEIGHT = 260;
const WATERLINE_Y = 150;
const PIER_X = 40;
const LANE_HEIGHT = 78;

const HEALTH_HEX: Record<string, string> = {
  robust: "#10b981",
  healthy: "#0ea5e9",
  mixed: "#f59e0b",
  fragile: "#f97316",
  concentrated: "#ef4444",
};

function healthHex(band: string | null): string {
  return band ? HEALTH_HEX[band] ?? "#94a3b8" : "#94a3b8";
}

function Sun() {
  return (
    <g className="nc-sun" aria-hidden="true">
      <circle cx={SCENE_WIDTH - 80} cy={50} r={22} fill="#fde68a" opacity={0.9} />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
        const r1 = 26;
        const r2 = 38;
        const rad = (deg * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={SCENE_WIDTH - 80 + Math.cos(rad) * r1}
            y1={50 + Math.sin(rad) * r1}
            x2={SCENE_WIDTH - 80 + Math.cos(rad) * r2}
            y2={50 + Math.sin(rad) * r2}
            stroke="#fde68a"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.7}
          />
        );
      })}
    </g>
  );
}

function Fog() {
  return (
    <g aria-hidden="true" opacity={0.6}>
      {[30, 50, 70].map((y, i) => (
        <line
          key={y}
          x1={SCENE_WIDTH - 180}
          y1={y}
          x2={SCENE_WIDTH - 20}
          y2={y}
          stroke="#cbd5e1"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={i === 1 ? "24 8" : "12 6"}
          opacity={0.6 - i * 0.12}
        />
      ))}
    </g>
  );
}

function Ship({
  entry,
  laneY,
  x,
  hullW,
}: {
  entry: ChainHarborEntry;
  laneY: number;
  x: number;
  hullW: number;
}) {
  const color = healthHex(entry.healthBand);
  const cargo = cargoBuckets(entry.stablecoinCount);
  const layers = depthLayers(entry.sharePct / 100);
  const wake = wakeLength(entry.change7dPct);
  const hullTop = laneY;
  const hullBottom = laneY + 18;
  const deckLeft = x;
  const deckRight = x + hullW;
  const bowInset = 6;

  const mastX = x + hullW * 0.6;
  const flagWidth = Math.max(10, Math.min(32, (entry.dominantSharePct / 100) * 32));

  return (
    <g>
      {/* Wake: behind ship if negative 7d, ahead if positive */}
      {wake !== 0 && (
        <path
          d={
            wake > 0
              ? `M ${deckRight} ${hullBottom - 2} q ${wake * 28} -4 ${wake * 56} 0`
              : `M ${deckLeft} ${hullBottom - 2} q ${wake * 28} -4 ${wake * 56} 0`
          }
          stroke={wake > 0 ? "#10b981" : "#ef4444"}
          strokeWidth={1.5}
          strokeDasharray="3 3"
          fill="none"
          opacity={0.7}
        />
      )}
      {/* Hull — trapezoid */}
      <path
        d={`M ${deckLeft} ${hullTop} L ${deckRight} ${hullTop} L ${deckRight - bowInset} ${hullBottom} L ${deckLeft + bowInset} ${hullBottom} Z`}
        fill={color}
        opacity={0.85}
      />
      {/* Deck stripe */}
      <line x1={deckLeft} y1={hullTop} x2={deckRight} y2={hullTop} stroke="#475569" strokeWidth={0.75} opacity={0.4} />
      {/* Cargo containers */}
      {Array.from({ length: cargo }).map((_, i) => (
        <rect
          key={i}
          x={deckLeft + 4 + i * 7}
          y={hullTop - 6}
          width={6}
          height={6}
          fill="#64748b"
          opacity={0.65}
        />
      ))}
      {/* Mast */}
      <line x1={mastX} y1={hullTop} x2={mastX} y2={hullTop - 28} stroke="#475569" strokeWidth={1.2} />
      {/* Flag (logo) */}
      <rect
        className="nc-flag"
        x={mastX}
        y={hullTop - 28}
        width={flagWidth}
        height={10}
        fill={color}
        opacity={0.9}
      />
      <image
        href={entry.logoPath}
        x={mastX + flagWidth / 2 - 7}
        y={hullTop - 27}
        width={14}
        height={14}
      />
      {/* Depth layers */}
      {Array.from({ length: layers }).map((_, i) => {
        const offset = 4 + i * 3;
        return (
          <line
            key={i}
            x1={deckLeft + 4 + i * 2}
            y1={hullBottom + offset}
            x2={deckRight - 4 - i * 2}
            y2={hullBottom + offset}
            stroke="#0284c7"
            strokeWidth={0.75}
            opacity={0.45 - i * 0.08}
          />
        );
      })}
      {/* Rank plaque */}
      <text
        x={deckLeft + hullW / 2}
        y={hullBottom + 22}
        textAnchor="middle"
        fontSize={9}
        fontFamily="ui-monospace, Menlo, monospace"
        fill="currentColor"
        opacity={0.6}
      >
        {entry.name}
      </text>
    </g>
  );
}

function HorizonFleet({
  remaining,
  y,
}: {
  remaining: readonly ChainSummary[];
  y: number;
}) {
  if (remaining.length === 0) return null;
  const baseX = SCENE_WIDTH - 220;
  return (
    <g opacity={0.55}>
      {remaining.slice(0, 10).map((c, i) => (
        <rect
          key={c.id}
          x={baseX + i * 18}
          y={y}
          width={14}
          height={4}
          fill="#475569"
          opacity={0.5}
        >
          <title>{c.name}</title>
        </rect>
      ))}
    </g>
  );
}

function CompassPlate({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="relative rounded-xl border border-amber-700/20 bg-gradient-to-br from-amber-50/40 to-amber-100/10 p-3 dark:border-amber-300/15 dark:from-amber-950/30 dark:to-amber-900/10">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 font-mono text-lg font-bold tabular-nums break-words">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function NauticalChart({
  chains,
  globalTotalUsd,
}: {
  chains: ChainSummary[];
  globalTotalUsd: number;
}) {
  const model = buildChainHarborModel(chains, globalTotalUsd);
  if (model.entries.length === 0) return null;

  const sky = aggregateSkyBand(model.entries);
  const maxSupply = model.entries[0]?.totalUsd ?? 0;
  const topCount = model.entries.length;
  const laneWidth = (SCENE_WIDTH - PIER_X - 40) / Math.max(topCount, 1);

  const remaining = [...chains]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(topCount);

  return (
    <section className="pharos-card-shell overflow-hidden" aria-labelledby="chain-nautical-heading">
      <div className="pharos-panel-header flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Harbor Chart</p>
          <h2 id="chain-nautical-heading" className="text-lg font-semibold tracking-tight">
            Where stablecoin supply is docked
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Ship length tracks supply. Hull color is health band; flag width is dominant-coin share; cargo is stablecoin count; depth lines mark dominance draft.
          </p>
        </div>
        <div className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
          Top {topCount} chains hold {model.topSharePct.toFixed(1)}%
        </div>
      </div>

      {/* Desktop scene */}
      <div className="hidden xl:block">
        <svg
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          role="img"
          aria-label={`Nautical chart of ${topCount} largest stablecoin chains`}
          className="h-[260px] w-full text-foreground"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Sky gradient */}
          <defs>
            <linearGradient id="nc-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#bae6fd" stopOpacity="0.1" />
            </linearGradient>
            <linearGradient id="nc-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0284c7" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#0c4a6e" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={SCENE_WIDTH} height={WATERLINE_Y} fill="url(#nc-sky)" />
          <rect x="0" y={WATERLINE_Y} width={SCENE_WIDTH} height={SCENE_HEIGHT - WATERLINE_Y} fill="url(#nc-water)" />

          {/* Sky icon */}
          {sky === "sun" ? <Sun /> : <Fog />}

          {/* Horizon fleet */}
          <HorizonFleet remaining={remaining} y={WATERLINE_Y - 6} />

          {/* Waterline */}
          <line
            className="nc-waterline"
            x1="0"
            y1={WATERLINE_Y}
            x2={SCENE_WIDTH}
            y2={WATERLINE_Y}
            stroke="#0284c7"
            strokeWidth={1}
            strokeDasharray="4 6"
            opacity={0.5}
          />

          {/* Ships */}
          {model.entries.map((entry, i) => {
            const hullW = hullWidth(entry.totalUsd, maxSupply, laneWidth * 1.1);
            const x = PIER_X + i * laneWidth + (laneWidth - hullW) / 2;
            return (
              <Ship
                key={entry.id}
                entry={entry}
                laneY={WATERLINE_Y - 18}
                x={x}
                hullW={hullW}
              />
            );
          })}
        </svg>
      </div>

      {/* Non-desktop fallback */}
      <div className="xl:hidden">
        <HarborList chains={chains} globalTotalUsd={globalTotalUsd} />
      </div>

      {/* Compass plates */}
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <CompassPlate
          icon={<Anchor className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />}
          label="Largest port"
          value={model.largestHarbor?.name ?? "n/a"}
          detail={`${model.largestHarbor?.dominantSymbol ?? "n/a"} dominant cargo`}
        />
        <CompassPlate
          icon={<ShipWheel className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />}
          label="Avg health"
          value={model.averageHealthScore ?? "NR"}
          detail={`${model.harborCount} active chain profiles`}
        />
        <CompassPlate
          icon={<Activity className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />}
          label="Fragile ports"
          value={model.fragileHarbors}
          detail="fragile or concentrated chains"
        />
        <div className="rounded-xl border border-amber-700/20 bg-gradient-to-br from-amber-50/40 to-amber-100/10 p-3 dark:border-amber-300/15 dark:from-amber-950/30 dark:to-amber-900/10">
          <p className="pharos-kicker">Health bands</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(["robust", "healthy", "mixed", "fragile", "concentrated"] as const).map((band) => (
              <span key={band} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", HEALTH_BADGE_CLASSES[band])}>
                {band}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
        Source: Chain health snapshot. Harbor size is supply distribution, not issuer redemption capacity.
      </p>
    </section>
  );
}
```

- [ ] **Step 3: Swap client.tsx to use NauticalChart**

In `src/app/chains/client.tsx` replace the `HarborList` import (added in Task 3) and the `<HarborList>` usage with `NauticalChart`:

```tsx
import { NauticalChart } from "./nautical-chart";
// ...
<NauticalChart chains={data.chains} globalTotalUsd={data.globalTotalUsd} />
```

Remove the `HarborList` import from `client.tsx` — it's now re-used internally by `NauticalChart`.

- [ ] **Step 4: Run tests + type-check + build**

```bash
npm test -- src/app/chains/ --run
npx tsc --noEmit
npm run lint
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/chains/nautical-chart.tsx src/app/chains/nautical-chart.css src/app/chains/client.tsx
git commit -m "feat(chains): draw the harbor — SVG nautical chart scene"
```

---

### Task 5: Component test for NauticalChart

**Files:**
- Create: `src/app/chains/nautical-chart.test.tsx`

- [ ] **Step 1: Write the tests**

```tsx
// @vitest-environment jsdom
// src/app/chains/nautical-chart.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import { NauticalChart } from "./nautical-chart";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) =>
    createElement("img", { ...props, alt: props.alt ?? "" }),
}));

afterEach(() => cleanup());

function makeChain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    id: overrides.id ?? "ethereum",
    name: overrides.name ?? "Ethereum",
    logoPath: overrides.logoPath ?? "/logos/chains/ethereum.svg",
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd ?? 100,
    change24h: 0, change24hPct: 0,
    change7d: 0, change7dPct: overrides.change7dPct ?? 0,
    change30d: 0, change30dPct: 0,
    stablecoinCount: overrides.stablecoinCount ?? 3,
    dominantStablecoin: overrides.dominantStablecoin ?? { id: "usdc-circle", symbol: "USDC", share: 0.6 },
    dominanceShare: overrides.dominanceShare ?? 0.5,
    healthScore: overrides.healthScore ?? 82,
    healthBand: overrides.healthBand ?? "healthy",
    healthFactors: { concentration: 80, quality: 85, pegStability: 90, backingDiversity: 70, chainEnvironment: 80 },
  };
}

describe("NauticalChart", () => {
  it("renders nothing when no chains", () => {
    const { container } = render(createElement(NauticalChart, { chains: [], globalTotalUsd: 0 }));
    expect(container.firstChild).toBeNull();
  });

  it("renders SVG scene and compass plates with top-share headline", () => {
    const chains = [
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 }),
      makeChain({ id: "base", name: "Base", totalUsd: 25, healthBand: "mixed", healthScore: 70 }),
      makeChain({ id: "tron", name: "Tron", totalUsd: 15, healthBand: "fragile", healthScore: 45 }),
    ];
    render(createElement(NauticalChart, { chains, globalTotalUsd: 100 }));

    expect(screen.getByRole("heading", { name: "Where stablecoin supply is docked" })).toBeTruthy();
    expect(screen.getByText("Top 3 chains hold 100.0%")).toBeTruthy();
    // Compass plate values
    expect(screen.getByText("Ethereum")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy(); // fragile ports count
    // SVG scene renders with aria-label
    expect(screen.getByRole("img", { name: /Nautical chart of 3 largest/ })).toBeTruthy();
  });

  it("renders the mobile fallback list via HarborList at xl:hidden", () => {
    const chains = [makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60 })];
    const { container } = render(createElement(NauticalChart, { chains, globalTotalUsd: 100 }));
    // HarborList section exists with its own heading (rendered twice — once in fallback div)
    const fallbackHeadings = container.querySelectorAll('[id="chain-harbor-heading"]');
    expect(fallbackHeadings.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- src/app/chains/nautical-chart.test.tsx --run
```

Expected: all 3 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/chains/nautical-chart.test.tsx
git commit -m "test(chains): nautical-chart scene renders ships + compass plates"
```

---

## Phase 2 — /liquidity Depth Gauges

### Task 6: liquidity-ui helpers + tests

**Files:**
- Create: `src/lib/liquidity-ui.ts`
- Test: `src/lib/liquidity-ui.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// src/lib/liquidity-ui.test.ts
import { describe, it, expect } from "vitest";
import {
  COVERAGE_FILL_CLASSES,
  COVERAGE_TEXT_CLASSES,
  rippleIntensityBand,
  clarityOpacity,
  depthFillPct,
} from "./liquidity-ui";

describe("COVERAGE_FILL_CLASSES", () => {
  it("has an entry for every coverage class", () => {
    for (const key of ["primary", "mixed", "fallback", "legacy", "unobserved"] as const) {
      expect(COVERAGE_FILL_CLASSES[key]).toBeTruthy();
      expect(COVERAGE_TEXT_CLASSES[key]).toBeTruthy();
    }
  });
});

describe("rippleIntensityBand", () => {
  it("returns 'still' below 100k volume", () => {
    expect(rippleIntensityBand(0)).toBe("still");
    expect(rippleIntensityBand(99_999)).toBe("still");
  });
  it("returns 'gentle' between 100k and 10M", () => {
    expect(rippleIntensityBand(100_000)).toBe("gentle");
    expect(rippleIntensityBand(5_000_000)).toBe("gentle");
  });
  it("returns 'choppy' at and above 10M", () => {
    expect(rippleIntensityBand(10_000_000)).toBe("choppy");
    expect(rippleIntensityBand(500_000_000)).toBe("choppy");
  });
});

describe("clarityOpacity", () => {
  it("returns 0 when organicFraction is 1 (perfectly clear)", () => {
    expect(clarityOpacity(1)).toBe(0);
  });
  it("returns high opacity when organicFraction is 0 (fully murky)", () => {
    expect(clarityOpacity(0)).toBeGreaterThan(0.5);
  });
  it("clamps null to default mid-murk", () => {
    const v = clarityOpacity(null);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
  it("is monotonic decreasing in organic fraction", () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map(clarityOpacity);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]!);
    }
  });
});

describe("depthFillPct", () => {
  it("returns 0 for null score", () => {
    expect(depthFillPct(null)).toBe(0);
  });
  it("clamps scores to [0, 100]", () => {
    expect(depthFillPct(-5)).toBe(0);
    expect(depthFillPct(120)).toBe(100);
  });
  it("passes through valid scores", () => {
    expect(depthFillPct(42)).toBe(42);
    expect(depthFillPct(0)).toBe(0);
    expect(depthFillPct(100)).toBe(100);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- src/lib/liquidity-ui.test.ts --run
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/lib/liquidity-ui.ts
import type { LiquidityCoverageClass } from "@shared/types";

export const COVERAGE_FILL_CLASSES: Record<LiquidityCoverageClass, string> = {
  primary: "fill-sky-700 dark:fill-sky-500",
  mixed: "fill-teal-600 dark:fill-teal-400",
  fallback: "fill-amber-600 dark:fill-amber-400",
  legacy: "fill-slate-500 dark:fill-slate-400",
  unobserved: "fill-muted-foreground/30",
};

export const COVERAGE_TEXT_CLASSES: Record<LiquidityCoverageClass, string> = {
  primary: "text-sky-700 dark:text-sky-400",
  mixed: "text-teal-700 dark:text-teal-400",
  fallback: "text-amber-700 dark:text-amber-400",
  legacy: "text-slate-600 dark:text-slate-400",
  unobserved: "text-muted-foreground",
};

export const COVERAGE_WATER_HEX: Record<LiquidityCoverageClass, string> = {
  primary: "#0369a1",
  mixed: "#0d9488",
  fallback: "#d97706",
  legacy: "#64748b",
  unobserved: "#94a3b8",
};

export type RippleBand = "still" | "gentle" | "choppy";

export function rippleIntensityBand(volume24hUsd: number): RippleBand {
  if (volume24hUsd >= 10_000_000) return "choppy";
  if (volume24hUsd >= 100_000) return "gentle";
  return "still";
}

/** 0 (fully clear) to ~0.65 (fully murky). null organic → mid-murk. */
export function clarityOpacity(organicFraction: number | null): number {
  if (organicFraction == null) return 0.35;
  const clamped = Math.max(0, Math.min(1, organicFraction));
  return (1 - clamped) * 0.65;
}

export function depthFillPct(score: number | null): number {
  if (score == null) return 0;
  return Math.max(0, Math.min(100, score));
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
npm test -- src/lib/liquidity-ui.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/liquidity-ui.ts src/lib/liquidity-ui.test.ts
git commit -m "feat(liquidity): add coverage-class + depth-fill helpers"
```

---

### Task 7: Depth gauge SVG component + CSS

**Files:**
- Retired after review: depth-gauge component and animation stylesheet.

- [ ] **Step 1: Write CSS keyframes**

```css
/* src/app/liquidity/depth-gauges.css */
@media (prefers-reduced-motion: no-preference) {
  @keyframes dg-ripple-still {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(1px); }
  }
  @keyframes dg-ripple-gentle {
    0%, 100% { transform: translateX(-2px); }
    50% { transform: translateX(2px); }
  }
  @keyframes dg-ripple-choppy {
    0% { transform: translateX(-3px) translateY(0); }
    25% { transform: translateX(0) translateY(-1px); }
    50% { transform: translateX(3px) translateY(0); }
    75% { transform: translateX(0) translateY(1px); }
    100% { transform: translateX(-3px) translateY(0); }
  }
  @keyframes dg-buoy-bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2px); }
  }

  .dg-ripple-still { animation: dg-ripple-still 4s ease-in-out infinite; }
  .dg-ripple-gentle { animation: dg-ripple-gentle 2.6s ease-in-out infinite; }
  .dg-ripple-choppy { animation: dg-ripple-choppy 1.6s ease-in-out infinite; }
  .dg-buoy { animation: dg-buoy-bob 3.5s ease-in-out infinite; transform-origin: center; }
}
```

- [ ] **Step 2: Write the component**

```tsx
// src/app/liquidity/depth-gauge.tsx
"use client";

import type { LiquidityCoverageClass } from "@shared/types";
import { cn } from "@/lib/utils";
import {
  COVERAGE_WATER_HEX,
  clarityOpacity,
  depthFillPct,
  rippleIntensityBand,
} from "@/lib/liquidity-ui";
import "./depth-gauges.css";

export interface DepthGaugeProps {
  score: number | null;
  coverageClass: LiquidityCoverageClass | null;
  volume24hUsd: number;
  organicFraction: number | null;
  logoUrl?: string;
  symbol: string;
  size?: "sm" | "lg";
  patternId: string;
}

export function DepthGauge({
  score,
  coverageClass,
  volume24hUsd,
  organicFraction,
  logoUrl,
  symbol,
  size = "sm",
  patternId,
}: DepthGaugeProps) {
  const dry = score == null || coverageClass === "unobserved" || coverageClass == null;
  const W = size === "lg" ? 180 : 80;
  const H = size === "lg" ? 320 : 220;
  const CYL_X = size === "lg" ? 40 : 18;
  const CYL_Y = size === "lg" ? 30 : 20;
  const CYL_W = W - CYL_X * 2;
  const CYL_H = H - CYL_Y * 2;
  const fillPct = depthFillPct(score);
  const fillPx = (fillPct / 100) * CYL_H;
  const waterY = CYL_Y + CYL_H - fillPx;
  const cls = coverageClass ?? "unobserved";
  const waterHex = COVERAGE_WATER_HEX[cls];
  const murk = clarityOpacity(organicFraction);
  const ripple = rippleIntensityBand(volume24hUsd);
  const rippleClass =
    ripple === "choppy" ? "dg-ripple-choppy"
    : ripple === "gentle" ? "dg-ripple-gentle"
    : "dg-ripple-still";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={
        dry
          ? `${symbol} — unrated depth gauge`
          : `${symbol} — depth ${fillPct.toFixed(0)} of 100, ${cls} coverage`
      }
      className={cn("block", size === "lg" ? "h-80 w-auto" : "h-56 w-full max-w-[80px]")}
    >
      <defs>
        <pattern id={`${patternId}-murk`} width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="currentColor" opacity="0.6" />
          <circle cx="4" cy="4" r="1" fill="currentColor" opacity="0.6" />
        </pattern>
        <pattern id={`${patternId}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" opacity="0.4" />
        </pattern>
      </defs>

      {/* Cylinder walls */}
      <rect
        x={CYL_X}
        y={CYL_Y}
        width={CYL_W}
        height={CYL_H}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={dry ? "4 3" : undefined}
        opacity={dry ? 0.4 : 0.7}
        rx={4}
      />
      {/* Tick marks at 25/50/75 */}
      {[0.25, 0.5, 0.75].map((t) => {
        const y = CYL_Y + CYL_H - t * CYL_H;
        return (
          <line
            key={t}
            x1={CYL_X - 4}
            y1={y}
            x2={CYL_X}
            y2={y}
            stroke="currentColor"
            strokeWidth={0.8}
            opacity={0.5}
          />
        );
      })}

      {!dry && (
        <>
          {/* Unobserved gets hatched fill; others get solid */}
          {cls === "unobserved" ? (
            <rect
              x={CYL_X + 1}
              y={waterY}
              width={CYL_W - 2}
              height={fillPx}
              fill={`url(#${patternId}-hatch)`}
              color="currentColor"
            />
          ) : (
            <rect
              x={CYL_X + 1}
              y={waterY}
              width={CYL_W - 2}
              height={fillPx}
              fill={waterHex}
              opacity={0.85}
            />
          )}
          {/* Murk overlay */}
          {murk > 0 && (
            <rect
              x={CYL_X + 1}
              y={waterY}
              width={CYL_W - 2}
              height={fillPx}
              fill={`url(#${patternId}-murk)`}
              opacity={murk}
              color="#1e293b"
            />
          )}
          {/* Surface ripple */}
          <path
            className={rippleClass}
            d={`M ${CYL_X + 1} ${waterY} q ${CYL_W / 4} -3 ${CYL_W / 2} 0 t ${CYL_W / 2} 0`}
            fill="none"
            stroke={waterHex}
            strokeWidth={1.5}
            opacity={0.9}
          />
          {/* Buoy (logo) */}
          {logoUrl && (
            <g className="dg-buoy" transform={`translate(${W / 2}, ${waterY})`}>
              <circle r={size === "lg" ? 18 : 12} fill="#fff" opacity={0.9} />
              <image
                href={logoUrl}
                x={size === "lg" ? -16 : -10}
                y={size === "lg" ? -16 : -10}
                width={size === "lg" ? 32 : 20}
                height={size === "lg" ? 32 : 20}
              />
            </g>
          )}
        </>
      )}
    </svg>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/liquidity/depth-gauge.tsx src/app/liquidity/depth-gauges.css
git commit -m "feat(liquidity): DepthGauge SVG component"
```

---

### Task 8: DepthGauges grid + Global Reservoir hero

**Files:**
- Retired after review: DepthGauges grid and Global Reservoir hero.

- [ ] **Step 1: Write the component**

```tsx
// src/app/liquidity/depth-gauges.tsx
"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { DEX_GLOBAL_KEY } from "@shared/types";
import type { DexLiquidityData } from "@shared/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  COVERAGE_TEXT_CLASSES,
} from "@/lib/liquidity-ui";
import { DepthGauge } from "./depth-gauge";
import type { LiquidityRow } from "@/components/liquidity-table";

export type GaugeSort = "depth" | "volume" | "clarity";

export function DepthGauges({
  rows,
  unratedRows,
  liquidityMap,
  logos,
  sort,
  onSortChange,
  onSelect,
}: {
  rows: LiquidityRow[];
  unratedRows: LiquidityRow[];
  liquidityMap: Record<string, DexLiquidityData>;
  logos: Record<string, string>;
  sort: GaugeSort;
  onSortChange: (s: GaugeSort) => void;
  onSelect: (id: string) => void;
}) {
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      if (sort === "depth") return (b.liq.liquidityScore ?? 0) - (a.liq.liquidityScore ?? 0);
      if (sort === "volume") return b.liq.totalVolume24hUsd - a.liq.totalVolume24hUsd;
      return (b.liq.organicFraction ?? 0) - (a.liq.organicFraction ?? 0);
    });
    return copy;
  }, [rows, sort]);

  const globalData = liquidityMap[DEX_GLOBAL_KEY];
  const globalPct = useMemo(() => {
    // Normalize global TVL against its own scale — 100 = current, ceiling is informational only.
    return globalData ? 100 : 0;
  }, [globalData]);

  return (
    <section className="space-y-4" aria-labelledby="depth-gauges-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Depth Gauges</p>
          <h2 id="depth-gauges-heading" className="text-lg font-semibold tracking-tight">
            Exit liquidity, read off the cylinder wall
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Water level is the liquidity score. Color is coverage class. Murk is wash-traded volume. A dashed, empty gauge means the pipeline hasn&apos;t observed enough coverage.
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={sort}
          onValueChange={(v) => v && onSortChange(v as GaugeSort)}
          className="flex gap-1"
          aria-label="Sort gauges"
        >
          <ToggleGroupItem value="depth" variant="outline" size="sm" className="text-xs">Depth</ToggleGroupItem>
          <ToggleGroupItem value="volume" variant="outline" size="sm" className="text-xs">Volume</ToggleGroupItem>
          <ToggleGroupItem value="clarity" variant="outline" size="sm" className="text-xs">Clarity</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Hero reservoir */}
      {globalData && (
        <div className="pharos-card-shell flex flex-col items-center gap-4 p-5 md:flex-row md:items-stretch">
          <div className="flex shrink-0 items-center justify-center">
            <DepthGauge
              size="lg"
              score={globalPct}
              coverageClass="primary"
              volume24hUsd={globalData.totalVolume24hUsd}
              organicFraction={globalData.organicFraction}
              symbol="GLOBAL"
              patternId="gauge-global"
            />
          </div>
          <div className="flex flex-1 flex-col justify-center gap-2">
            <p className="pharos-kicker">Global Reservoir</p>
            <p className="font-mono text-3xl font-bold tabular-nums">{formatCompactUsd(globalData.totalTvlUsd)}</p>
            {globalData.tvlChange7d != null && (
              <p className={cn("font-mono text-sm tabular-nums", (globalData.tvlChange7d ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                {formatSignedPercent(globalData.tvlChange7d, 2)} 7d TVL
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              24h volume {formatCompactUsd(globalData.totalVolume24hUsd)}
            </p>
          </div>
        </div>
      )}

      {/* Gauge grid (desktop) / snap-scroll (mobile) */}
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8"
      >
        {sorted.map((row) => {
          const cls = row.liq.coverageClass ?? null;
          const colorClass = cls ? COVERAGE_TEXT_CLASSES[cls] : "text-muted-foreground";
          return (
            <button
              key={row.meta.id}
              type="button"
              onClick={() => onSelect(row.meta.id)}
              className="pharos-focus-ring group flex flex-col items-center gap-1.5 rounded-xl border border-border/60 bg-background/35 p-2 transition-colors hover:border-frost-blue/50"
            >
              <DepthGauge
                score={row.liq.liquidityScore}
                coverageClass={row.liq.coverageClass}
                volume24hUsd={row.liq.totalVolume24hUsd}
                organicFraction={row.liq.organicFraction}
                logoUrl={logos[row.meta.id]}
                symbol={row.meta.symbol}
                patternId={`gauge-${row.meta.id}`}
              />
              <div className="flex items-baseline gap-1">
                <span className="text-[11px] font-semibold">{row.meta.symbol}</span>
                <span className={cn("font-mono text-[11px] tabular-nums", colorClass)}>
                  {row.liq.liquidityScore?.toFixed(0) ?? "--"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Dry Docks */}
      {unratedRows.length > 0 && (
        <div className="space-y-2">
          <p className="pharos-kicker">Dry Docks</p>
          <p className="text-xs text-muted-foreground">
            No observed DEX coverage. Gauges stay dry until the pipeline has enough evidence.
          </p>
          <div className="grid grid-cols-3 gap-2 opacity-70 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
            {unratedRows.map((row) => (
              <div
                key={row.meta.id}
                className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border/50 p-1.5"
              >
                <DepthGauge
                  score={null}
                  coverageClass={null}
                  volume24hUsd={0}
                  organicFraction={null}
                  symbol={row.meta.symbol}
                  patternId={`gauge-dry-${row.meta.id}`}
                />
                <span className="text-[10px] text-muted-foreground">{row.meta.symbol}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/liquidity/depth-gauges.tsx
git commit -m "feat(liquidity): depth-gauges grid + global reservoir hero"
```

---

### Task 9: Integrate DepthGauges into LiquidityClient

**Files:**
- Modify: `src/app/liquidity/client.tsx`

- [ ] **Step 1: Add gauge-sort URL param and mount DepthGauges**

In `src/app/liquidity/client.tsx`, immediately before the existing `{/* Filters + Leaderboard */}` block, add the DepthGauges section and a `gaugeSort` URL param. Update imports:

```tsx
// Add to imports
import { DepthGauges, type GaugeSort } from "./depth-gauges";
```

Add after the existing `setPegFilter` declaration (around line 49):

```tsx
const rawGaugeSort = getParam("gs", "depth");
const gaugeSort: GaugeSort = (rawGaugeSort === "volume" || rawGaugeSort === "clarity")
  ? rawGaugeSort
  : "depth";
const setGaugeSort = useCallback((s: GaugeSort) => {
  trackEvent("filter_applied", { page: "liquidity", filter_type: "gaugeSort", filter_value: s });
  setParam("gs", s);
}, [setParam]);
```

Mount DepthGauges between the `{summaryStats && ...}` block and the `{/* Filters + Leaderboard */}` block:

```tsx
{liquidityMap && (
  <DepthGauges
    rows={scoredRows}
    unratedRows={unratedRows}
    liquidityMap={liquidityMap}
    logos={logos ?? {}}
    sort={gaugeSort}
    onSortChange={setGaugeSort}
    onSelect={handleRowClick}
  />
)}
```

- [ ] **Step 2: Run tests + type-check**

```bash
npm test -- src/app/liquidity/ --run
npx tsc --noEmit
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/liquidity/client.tsx
git commit -m "feat(liquidity): mount DepthGauges above the leaderboard"
```

---

### Task 10: Component test for DepthGauges

**Files:**
- Retired after review: DepthGauges component test.

- [ ] **Step 1: Write the tests**

```tsx
// @vitest-environment jsdom
// src/app/liquidity/depth-gauges.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepthGauges } from "./depth-gauges";
import { DEX_GLOBAL_KEY, type DexLiquidityData, type LiquidityCoverageClass } from "@shared/types";
import type { LiquidityRow } from "@/components/liquidity-table";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) =>
    createElement("img", { ...props, alt: props.alt ?? "" }),
}));

afterEach(() => cleanup());

function makeLiq(overrides: Partial<DexLiquidityData>): DexLiquidityData {
  return {
    totalTvlUsd: 1_000_000,
    totalVolume24hUsd: 100_000,
    totalVolume7dUsd: 500_000,
    poolCount: 3,
    pairCount: 3,
    chainCount: 2,
    protocolTvl: {},
    chainTvl: {},
    topPools: [],
    liquidityScore: 70,
    concentrationHhi: 0.3,
    depthStability: null,
    tvlChange24h: null,
    tvlChange7d: 1.5,
    updatedAt: Date.now(),
    dexPriceUsd: 1,
    dexDeviationBps: null,
    priceSourceCount: null,
    priceSourceTvl: null,
    priceSources: null,
    effectiveTvlUsd: 900_000,
    avgPoolStress: null,
    weightedBalanceRatio: 0.9,
    organicFraction: 0.8,
    durabilityScore: null,
    coverageClass: "primary" as LiquidityCoverageClass,
    coverageConfidence: 0.9,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    trendworthy: true,
    sourceMix: {},
    balanceMeasuredTvlUsd: 900_000,
    organicMeasuredTvlUsd: 900_000,
    scoreComponents: null,
    lockedLiquidityPct: null,
    methodologyVersion: "v1",
    ...overrides,
  };
}

function makeRow(id: string, score: number | null, vol: number, organic: number | null): LiquidityRow {
  return {
    meta: {
      id,
      symbol: id.toUpperCase(),
      name: `Coin ${id}`,
      logoPath: `/logos/${id}.svg`,
      flags: { pegCurrency: "USD" as const },
      geckoId: id,
      tags: [],
      chains: [],
    } as LiquidityRow["meta"],
    liq: makeLiq({ liquidityScore: score, totalVolume24hUsd: vol, organicFraction: organic }),
  };
}

describe("DepthGauges", () => {
  it("renders the hero reservoir and one gauge per row, sorted by depth by default", () => {
    const rows = [
      makeRow("a", 40, 10_000, 0.5),
      makeRow("b", 80, 100, 0.9),
      makeRow("c", 60, 9_000_000, 0.1),
    ];
    render(createElement(DepthGauges, {
      rows,
      unratedRows: [],
      liquidityMap: { [DEX_GLOBAL_KEY]: makeLiq({}) },
      logos: {},
      sort: "depth",
      onSortChange: () => {},
      onSelect: () => {},
    }));

    expect(screen.getByText("Global Reservoir")).toBeTruthy();
    const labels = screen.getAllByText(/^[ABC]$/);
    expect(labels.map((el) => el.textContent)).toEqual(["B", "C", "A"]);
  });

  it("renders a Dry Docks row when unrated rows exist", () => {
    render(createElement(DepthGauges, {
      rows: [],
      unratedRows: [makeRow("x", null, 0, null)],
      liquidityMap: {},
      logos: {},
      sort: "depth",
      onSortChange: () => {},
      onSelect: () => {},
    }));
    expect(screen.getByText("Dry Docks")).toBeTruthy();
    expect(screen.getByText("X")).toBeTruthy();
  });

  it("fires onSelect when a gauge is clicked", () => {
    const onSelect = vi.fn();
    render(createElement(DepthGauges, {
      rows: [makeRow("a", 40, 10_000, 0.5)],
      unratedRows: [],
      liquidityMap: {},
      logos: {},
      sort: "depth",
      onSortChange: () => {},
      onSelect,
    }));
    fireEvent.click(screen.getByRole("button", { name: /A/ }));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("sorts by volume when sort=volume", () => {
    const rows = [
      makeRow("lowvol", 95, 100, 0.9),
      makeRow("hivol", 40, 10_000_000, 0.1),
    ];
    render(createElement(DepthGauges, {
      rows,
      unratedRows: [],
      liquidityMap: {},
      logos: {},
      sort: "volume",
      onSortChange: () => {},
      onSelect: () => {},
    }));
    const labels = screen.getAllByText(/^HIVOL|LOWVOL$/);
    expect(labels[0]?.textContent).toBe("HIVOL");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- src/app/liquidity/depth-gauges.test.tsx --run
```

Expected: all 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/liquidity/depth-gauges.test.tsx
git commit -m "test(liquidity): DepthGauges renders, sorts, and clicks"
```

---

## Phase 3 — Final validation + push

### Task 11: Update design-language doc

**Files:**
- Modify: `docs/design-language.md`

- [ ] **Step 1: Add the "Draw the Metaphor" section**

Append to the end of `docs/design-language.md`:

```markdown
## Draw the Metaphor

When a page introduces a metaphor (harbor, cemetery, atlas), render it — don't just name it. Cemetery tombstones have arched caps, crosses, and flower scatter. The Alt-Peg Atlas has a starfield and celestial band. The Chains Nautical Chart has ships, flags, cargo, and depth lines. The Liquidity Depth Gauges have water columns, surface ripples, and buoys.

Rules that keep this from drifting into decoration:

- **Every shape encodes a data field.** No ornamental shapes. If a shape doesn't vary with a number, remove it.
- **Inline JSX SVG, semantic CSS variables, hex fallbacks.** No external .svg assets; no runtime SVG libraries.
- **CSS keyframes only, gated on `prefers-reduced-motion: no-preference`.** No framer-motion.
- **Mobile degrades via breakpoint swap,** not feature removal. Rich visual on `xl:` — simplified list or snap-scroll below.
- **The underlying data table remains.** The metaphor is a hero; the table is the workbench.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design-language.md
git commit -m "docs(design): draw the metaphor — principle from chains + liquidity"
```

---

### Task 12: Merge-gate validation + push

- [ ] **Step 1: Run merge gate**

```bash
npm run test:merge-gate
```

Expected: PASS (or clean skips). If anything fails, fix locally and re-run — never skip with `--no-verify`.

- [ ] **Step 2: Push to main**

```bash
git push origin main
```

Expected: push succeeds; Pages deploy auto-triggers.

---

## Self-review checklist (for the executing agent)

Before declaring complete, confirm:

- [ ] All new helper modules have corresponding `*.test.ts(x)` with passing assertions
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run lint` clean
- [ ] `npm test --run` clean
- [ ] `/chains` renders nautical chart at `xl:` viewport; HarborList at `< xl`
- [ ] `/liquidity` renders Global Reservoir + gauge grid + Dry Docks
- [ ] Sort toggle on /liquidity persists via `gs` URL param
- [ ] No new dependencies in `package.json`
- [ ] `harbor-map.tsx` removed; no dangling imports
