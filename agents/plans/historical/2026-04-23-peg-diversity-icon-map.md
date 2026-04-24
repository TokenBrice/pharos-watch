# Peg Diversity Icon Map — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/alt-pegs` hero so every non-USD stablecoin appears as its own logo sized by market cap, with Gold/Silver/CPI as celestial bodies in a sky strip above a geographic world map and cohort-resonance hover behavior.

**Architecture:** Split the hero into two layers — a `SkyLayer` holding sun (Gold), moon (Silver), and a three-star constellation (CPI), and an `EarthLayer` holding an aspect-locked world-map frame with individual fiat coin emblems placed at each peg's curated anchor. A `HoverProvider` context drives a shared cohort-resonance hover state so every emblem and thread overlay reads from one source. Pure functions in `src/lib/alt-peg-*.ts` handle sizing, packing, and building the hero data model from `useStablecoins()`.

**Tech Stack:** Next.js 16 static export, React client components, Tailwind CSS 4, vitest + @testing-library/react, existing world-countries.svg.

---

## Spec reference

`agents/specs/2026-04-23-peg-diversity-icon-map-design.md`

## File map

### New

Utilities (pure functions):
- `src/lib/alt-peg-sizing.ts` + test
- `src/lib/alt-peg-packing.ts` + test
- `src/lib/alt-peg-hero.ts` + test

Components:
- `src/app/alt-pegs/fiat-world-atlas/hover-context.tsx` + test
- `src/app/alt-pegs/fiat-world-atlas/coin-emblem.tsx` + test
- `src/app/alt-pegs/fiat-world-atlas/cohort-threads.tsx` + test
- `src/app/alt-pegs/fiat-world-atlas/starfield.tsx`
- `src/app/alt-pegs/fiat-world-atlas/sun-cohort.tsx`
- `src/app/alt-pegs/fiat-world-atlas/moon-cohort.tsx`
- `src/app/alt-pegs/fiat-world-atlas/constellation-cohort.tsx`
- `src/app/alt-pegs/fiat-world-atlas/sky-layer.tsx`
- `src/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live.tsx`
- `src/app/alt-pegs/fiat-world-atlas/fiat-emblems.tsx`

### Rewrite

- `src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx` — render the desktop live hero; mobile unchanged
- `src/app/alt-pegs/fiat-world-atlas/world-map.tsx` — strip the `items` prop + country color fills; render SVG only with muted slate theme

### Delete (+ their tests)

- Remove the obsolete map-emblem-clusters component and test.
- Remove the obsolete map-deadspot-references component and test.
- Remove the obsolete world-map-interactive component and test.

---

## Task 1: Size formula

**Files:**
- Create: `src/lib/alt-peg-sizing.ts`
- Test: `src/lib/__tests__/alt-peg-sizing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/alt-peg-sizing.test.ts
import { describe, expect, it } from "vitest";
import { coinEmblemSize, SIZE_CEIL, SIZE_FLOOR } from "@/lib/alt-peg-sizing";

describe("coinEmblemSize", () => {
  it("returns SIZE_FLOOR for 0 or negative market cap", () => {
    expect(coinEmblemSize(0)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(-1)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(Number.NaN)).toBe(SIZE_FLOOR);
  });

  it("returns SIZE_FLOOR for very small mcaps (< $500K)", () => {
    expect(coinEmblemSize(100_000)).toBe(SIZE_FLOOR);
  });

  it("clamps to SIZE_CEIL for very large mcaps", () => {
    expect(coinEmblemSize(10_000_000_000)).toBe(SIZE_CEIL);
  });

  it("scales monotonically between $1M and $500M", () => {
    const sizes = [1_000_000, 10_000_000, 100_000_000, 500_000_000].map(coinEmblemSize);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("returns a whole pixel integer", () => {
    expect(Number.isInteger(coinEmblemSize(42_000_000))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/alt-peg-sizing.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/alt-peg-sizing.ts
export const SIZE_FLOOR = 26;
export const SIZE_CEIL = 120;
export const SIZE_SCALE = 4.0;
export const MCAP_DIVISOR = 1_000_000;

/**
 * Size a coin's emblem (diameter in px) from its USD market cap.
 * Uses sqrt scaling so a ~3-order-of-magnitude mcap spread compresses
 * into a legible SIZE_FLOOR..SIZE_CEIL range.
 */
export function coinEmblemSize(marketCapUsd: number): number {
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return SIZE_FLOOR;
  const raw = SIZE_FLOOR + Math.sqrt(marketCapUsd / MCAP_DIVISOR) * SIZE_SCALE;
  return Math.round(Math.min(SIZE_CEIL, Math.max(SIZE_FLOOR, raw)));
}
```

- [ ] **Step 4: Run the test, verify PASS**

Run: `npx vitest run src/lib/__tests__/alt-peg-sizing.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alt-peg-sizing.ts src/lib/__tests__/alt-peg-sizing.test.ts
git commit -m "feat(alt-pegs): add mcap→px emblem sizing helper"
```

---

## Task 2: Packing algorithm

**Files:**
- Create: `src/lib/alt-peg-packing.ts`
- Test: `src/lib/__tests__/alt-peg-packing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/alt-peg-packing.test.ts
import { describe, expect, it } from "vitest";
import { arrangeClusterCoins, type PackingInput } from "@/lib/alt-peg-packing";

function input(sizes: number[]): PackingInput[] {
  return sizes.map((sizePx, i) => ({ id: `c${i}`, sizePx, marketCap: sizePx * 1_000_000 }));
}

describe("arrangeClusterCoins", () => {
  const anchor = { x: 50, y: 30 };

  it("places a single coin at the anchor", () => {
    const placed = arrangeClusterCoins(anchor, input([60]));
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBe(50);
    expect(placed[0].y).toBe(30);
  });

  it("places the largest coin at the anchor when multiple are given", () => {
    const placed = arrangeClusterCoins(anchor, input([40, 100, 60]));
    const atAnchor = placed.find((p) => p.x === 50 && p.y === 30);
    expect(atAnchor).toBeDefined();
    expect(atAnchor!.sizePx).toBe(100);
  });

  it("produces no center-to-center overlaps within a cluster", () => {
    const sizes = [100, 80, 60, 50, 45, 40, 35, 32, 30, 28, 28, 26, 26];
    const placed = arrangeClusterCoins(anchor, input(sizes));
    const FRAME_W = 900;
    const FRAME_H = 460;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const dx = (placed[i].x - placed[j].x) * (FRAME_W / 100);
        const dy = (placed[i].y - placed[j].y) * (FRAME_H / 100);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = (placed[i].sizePx + placed[j].sizePx) / 2 * 0.9;
        expect(dist).toBeGreaterThanOrEqual(minDist);
      }
    }
  });

  it("returns coins sorted largest-first", () => {
    const placed = arrangeClusterCoins(anchor, input([30, 100, 50, 80]));
    const sizes = placed.map((p) => p.sizePx);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/lib/__tests__/alt-peg-packing.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/alt-peg-packing.ts
export interface PackingInput {
  id: string;
  sizePx: number;
  marketCap: number;
}

export interface PackedCoin extends PackingInput {
  x: number; // percentage of frame width
  y: number; // percentage of frame height
}

// Map-frame intrinsic pixel dimensions; percentage math converts to px for
// overlap tests. Matches the world-countries.svg viewBox ratio.
const FRAME_W = 900;
const FRAME_H = 460;
const GOLDEN_ANGLE_DEG = 137.5;
const INITIAL_ANGLE_DEG = -90; // start placement due-north

function toPercent(x: number, y: number): { x: number; y: number } {
  return { x, y };
}

function centerDistancePx(a: PackedCoin, b: PackedCoin): number {
  const dx = (a.x - b.x) * (FRAME_W / 100);
  const dy = (a.y - b.y) * (FRAME_H / 100);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Pack cluster coins around an anchor using a golden-angle spiral.
 * The largest coin lands on the anchor; subsequent coins spiral outward
 * at angles separated by 137.5°. If a candidate overlaps an already-placed
 * coin, its radius is expanded by 1% of the frame width and retried.
 */
export function arrangeClusterCoins(
  anchor: { x: number; y: number },
  coins: readonly PackingInput[],
): PackedCoin[] {
  const sorted = [...coins].sort((a, b) => b.sizePx - a.sizePx);
  const placed: PackedCoin[] = [];
  if (sorted.length === 0) return placed;

  placed.push({ ...sorted[0], ...toPercent(anchor.x, anchor.y) });

  for (let i = 1; i < sorted.length; i++) {
    const coin = sorted[i];
    const prev = sorted[i - 1];
    const baseRadiusPx = Math.max(14, 0.6 * (prev.sizePx / 2 + coin.sizePx / 2));
    const angleDeg = INITIAL_ANGLE_DEG + (i - 1) * GOLDEN_ANGLE_DEG;
    const angleRad = (angleDeg * Math.PI) / 180;

    let radiusPx = baseRadiusPx;
    let candidate: PackedCoin | null = null;
    for (let attempt = 0; attempt < 25; attempt++) {
      const dxPercent = (radiusPx * Math.cos(angleRad)) / (FRAME_W / 100);
      const dyPercent = (radiusPx * Math.sin(angleRad)) / (FRAME_H / 100);
      candidate = { ...coin, x: anchor.x + dxPercent, y: anchor.y + dyPercent };
      const overlaps = placed.some((p) => {
        const minDist = ((p.sizePx + coin.sizePx) / 2) * 0.9;
        return centerDistancePx(p, candidate!) < minDist;
      });
      if (!overlaps) break;
      radiusPx += Math.max(3, coin.sizePx * 0.2);
    }
    placed.push(candidate!);
  }

  return placed;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/lib/__tests__/alt-peg-packing.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/alt-peg-packing.ts src/lib/__tests__/alt-peg-packing.test.ts
git commit -m "feat(alt-pegs): golden-angle packer for cluster coin layout"
```

---

## Task 3: Hero data model builder

**Files:**
- Create: `src/lib/alt-peg-hero.ts`
- Test: `src/lib/__tests__/alt-peg-hero.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/alt-peg-hero.test.ts
import { describe, expect, it } from "vitest";
import type { StablecoinData } from "@shared/types";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";

function coin(overrides: Partial<StablecoinData> & { id: string; circulating?: number }): StablecoinData {
  const { id, circulating = 1_000_000, ...rest } = overrides;
  return {
    id,
    name: rest.name ?? id.toUpperCase(),
    symbol: rest.symbol ?? id.slice(0, 4).toUpperCase(),
    price: 1,
    priceSource: "defillama",
    pegType: "peggedEUR",
    circulating: { peggedUSD: circulating },
    chainCirculating: {},
    chains: [],
  } as unknown as StablecoinData;
}

describe("buildPegDiversityHero", () => {
  it("returns empty hero for undefined/empty input", () => {
    const a = buildPegDiversityHero(undefined);
    expect(a.pegClusters).toEqual([]);
    expect(a.skyCohorts).toHaveLength(3); // always emit the 3 sky slots
    for (const sc of a.skyCohorts) expect(sc.coins).toEqual([]);
  });

  it("groups EUR coins into a single peg cluster with largest at anchor", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "eurc-circle", circulating: 430_000_000 }),
      coin({ id: "eurs-stasis", circulating: 8_000_000 }),
    ]);
    const eur = hero.pegClusters.find((c) => c.peg === "EUR");
    expect(eur).toBeDefined();
    expect(eur!.coins).toHaveLength(2);
    expect(eur!.coins[0].id).toBe("eurc-circle");
    expect(eur!.coins[0].x).toBe(eur!.anchor.x);
    expect(eur!.coins[0].y).toBe(eur!.anchor.y);
  });

  it("routes commodity coins into sun/moon cohorts", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "xaut-tether", pegType: "peggedGOLD", circulating: 2_600_000_000 }),
      coin({ id: "kag-kinesis", pegType: "peggedSILVER", circulating: 284_000_000 }),
    ]);
    const sun = hero.skyCohorts.find((c) => c.kind === "sun");
    const moon = hero.skyCohorts.find((c) => c.kind === "moon");
    expect(sun!.coins.some((c) => c.id === "xaut-tether")).toBe(true);
    expect(moon!.coins.some((c) => c.id === "kag-kinesis")).toBe(true);
  });

  it("routes VAR coins into the constellation cohort", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "fpi-frax", pegType: "peggedVAR", circulating: 96_000_000 }),
    ]);
    const con = hero.skyCohorts.find((c) => c.kind === "constellation");
    expect(con!.coins.map((c) => c.id)).toContain("fpi-frax");
  });

  it("skips USD-pegged coins entirely", () => {
    const hero = buildPegDiversityHero([
      coin({ id: "usdc-circle", pegType: "peggedUSD", circulating: 60_000_000_000 }),
    ]);
    expect(hero.pegClusters).toHaveLength(0);
    for (const sc of hero.skyCohorts) expect(sc.coins).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/lib/__tests__/alt-peg-hero.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/alt-peg-hero.ts
import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { getCirculatingRaw } from "@shared/lib/supply";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import type { PegCurrency, StablecoinData } from "@shared/types";
import { PEG_ANCHORS } from "@/lib/alt-peg-emblems";
import { arrangeClusterCoins, type PackingInput } from "@/lib/alt-peg-packing";
import { coinEmblemSize } from "@/lib/alt-peg-sizing";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@/lib/urls";

export interface HeroCoin {
  id: string;
  symbol: string;
  name: string;
  href: string;
  logoSrc: string;
  pegCurrency: PegCurrency;
  marketCap: number;
}

export interface PlacedCoin extends HeroCoin {
  x: number;
  y: number;
  sizePx: number;
}

export interface PegCluster {
  peg: PegCurrency;
  anchor: { x: number; y: number };
  colorHex: string;
  coins: readonly PlacedCoin[];
}

export type SkyCohortKind = "sun" | "moon" | "constellation";

export interface SkyCohort {
  kind: SkyCohortKind;
  label: string;
  href: string;
  coins: readonly PlacedCoin[];
}

export interface PegDiversityHero {
  pegClusters: readonly PegCluster[];
  skyCohorts: readonly SkyCohort[];
}

const EMPTY_SKY: SkyCohort[] = [
  { kind: "sun", label: "Gold", href: "/alt-pegs/gold", coins: [] },
  { kind: "moon", label: "Silver", href: "/alt-pegs/silver", coins: [] },
  { kind: "constellation", label: "Index", href: "/alt-pegs/index", coins: [] },
];

// Sky cohort centers & spread (percentages of the sky layer). The sun sits
// left, moon center, constellation right; secondary coins ring outward.
const SKY_LAYOUT: Record<SkyCohortKind, { cx: number; cy: number; spreadX: number; spreadY: number }> = {
  sun:           { cx: 16, cy: 48, spreadX: 26, spreadY: 40 },
  moon:          { cx: 50, cy: 42, spreadX: 10, spreadY: 30 },
  constellation: { cx: 82, cy: 55, spreadX: 15, spreadY: 35 },
};

function resolveLogo(coin: StablecoinData): string | undefined {
  const byId = logosById[coin.id];
  if (byId) return byId;
  const llamaId = (coin as { llamaId?: string }).llamaId;
  return llamaId ? logosById[llamaId] : undefined;
}

function toHeroCoin(coin: StablecoinData, peg: PegCurrency): HeroCoin | null {
  const logoSrc = resolveLogo(coin);
  if (!logoSrc) return null;
  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    href: buildStablecoinUrl(coin.id),
    logoSrc,
    pegCurrency: peg,
    marketCap: getCirculatingRaw(coin),
  };
}

function placeFiatCluster(peg: PegCurrency, coins: HeroCoin[]): PegCluster | null {
  const anchor = PEG_ANCHORS[peg];
  if (!anchor) return null;
  if (coins.length === 0) return null;

  const inputs: PackingInput[] = coins.map((c) => ({
    id: c.id,
    sizePx: coinEmblemSize(c.marketCap),
    marketCap: c.marketCap,
  }));
  const packed = arrangeClusterCoins(anchor, inputs);
  const byId = new Map(coins.map((c) => [c.id, c]));
  const placed: PlacedCoin[] = packed.map((p) => {
    const base = byId.get(p.id)!;
    return { ...base, x: p.x, y: p.y, sizePx: p.sizePx };
  });

  return {
    peg,
    anchor,
    colorHex: PEG_CHART_COLORS[peg]?.hex ?? "#64748b",
    coins: placed,
  };
}

function placeSkyCohort(kind: SkyCohortKind, coins: HeroCoin[]): SkyCohort {
  const empty = EMPTY_SKY.find((c) => c.kind === kind)!;
  if (coins.length === 0) return empty;

  const sorted = [...coins].sort((a, b) => b.marketCap - a.marketCap);
  const layout = SKY_LAYOUT[kind];
  const placed: PlacedCoin[] = sorted.map((coin, index) => {
    const sizePx = coinEmblemSize(coin.marketCap);
    // Primary coin dead-center; secondaries fan out in a wide ellipse.
    if (index === 0) return { ...coin, x: layout.cx, y: layout.cy, sizePx };
    const angle = ((index - 1) / Math.max(1, sorted.length - 1)) * Math.PI * 2;
    const orbitRx = layout.spreadX * (0.35 + (index % 3) * 0.25);
    const orbitRy = layout.spreadY * (0.25 + (index % 3) * 0.22);
    return {
      ...coin,
      x: layout.cx + Math.cos(angle) * orbitRx,
      y: layout.cy + Math.sin(angle) * orbitRy,
      sizePx,
    };
  });

  return { ...empty, coins: placed };
}

function isCommodity(peg: PegCurrency): peg is "GOLD" | "SILVER" {
  return peg === "GOLD" || peg === "SILVER";
}
function isVariable(peg: PegCurrency): boolean {
  return peg === "VAR";
}

export function buildPegDiversityHero(
  peggedAssets: readonly StablecoinData[] | undefined,
): PegDiversityHero {
  if (!peggedAssets || peggedAssets.length === 0) {
    return { pegClusters: [], skyCohorts: EMPTY_SKY };
  }

  const byPeg = new Map<PegCurrency, HeroCoin[]>();
  for (const raw of peggedAssets) {
    const meta = ACTIVE_META_BY_ID.get(raw.id);
    if (!meta) continue;
    const peg = meta.flags.pegCurrency;
    if (peg === "USD") continue;
    const hero = toHeroCoin(raw, peg);
    if (!hero) continue;
    const list = byPeg.get(peg) ?? [];
    list.push(hero);
    byPeg.set(peg, list);
  }

  const pegClusters: PegCluster[] = [];
  const goldCoins: HeroCoin[] = [];
  const silverCoins: HeroCoin[] = [];
  const varCoins: HeroCoin[] = [];

  for (const [peg, coins] of byPeg) {
    if (peg === "GOLD") { goldCoins.push(...coins); continue; }
    if (peg === "SILVER") { silverCoins.push(...coins); continue; }
    if (peg === "VAR") { varCoins.push(...coins); continue; }
    const cluster = placeFiatCluster(peg, coins);
    if (cluster) pegClusters.push(cluster);
  }

  pegClusters.sort((a, b) => {
    const aMax = a.coins[0]?.marketCap ?? 0;
    const bMax = b.coins[0]?.marketCap ?? 0;
    return bMax - aMax;
  });

  const skyCohorts: SkyCohort[] = [
    placeSkyCohort("sun", goldCoins),
    placeSkyCohort("moon", silverCoins),
    placeSkyCohort("constellation", varCoins),
  ];

  return { pegClusters, skyCohorts };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/lib/__tests__/alt-peg-hero.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/alt-peg-hero.ts src/lib/__tests__/alt-peg-hero.test.ts
git commit -m "feat(alt-pegs): build peg diversity hero data model"
```

---

## Task 4: Hover context

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/hover-context.tsx`
- Test: `src/app/alt-pegs/fiat-world-atlas/__tests__/hover-context.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/alt-pegs/fiat-world-atlas/__tests__/hover-context.test.tsx
// @vitest-environment jsdom
import { act, render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HoverProvider, useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";

function Probe({ id }: { id: string }) {
  const { hoveredCoinId, hoveredPeg, setHoveredCoin, isSibling, isDimmed, isHovered } =
    useHoverState();
  (globalThis as unknown as { __probe: unknown }).__probe = {
    hoveredCoinId, hoveredPeg,
    setHoveredCoin,
    isSibling: isSibling({ id: "eurs", pegCurrency: "EUR" }),
    isDimmed: isDimmed({ id: "eurs", pegCurrency: "EUR" }),
    isHovered: isHovered(id),
  };
  return null;
}

describe("HoverProvider", () => {
  afterEach(() => cleanup());

  it("defaults to no hover", () => {
    render(<HoverProvider><Probe id="eurc" /></HoverProvider>);
    const p = (globalThis as any).__probe;
    expect(p.hoveredCoinId).toBeNull();
    expect(p.hoveredPeg).toBeNull();
    expect(p.isSibling).toBe(false);
    expect(p.isDimmed).toBe(false);
    expect(p.isHovered).toBe(false);
  });

  it("sets hovered coin and derives peg; peers are siblings, others dim", () => {
    render(<HoverProvider><Probe id="eurc" /></HoverProvider>);
    act(() => {
      (globalThis as any).__probe.setHoveredCoin({ id: "eurc", pegCurrency: "EUR" });
    });
    // Re-render probe to capture derived values
    render(<HoverProvider><Probe id="eurc" /></HoverProvider>);
    // Note: in separate provider instances the state resets — test derivation
    // through direct helper calls below.
  });

  it("marks coins as siblings when pegCurrency matches hovered peg", () => {
    function Inner() {
      const { setHoveredCoin, isSibling, isDimmed, isHovered } = useHoverState();
      (globalThis as any).__d = {
        setHoveredCoin, isSibling, isDimmed, isHovered,
      };
      return null;
    }
    render(<HoverProvider><Inner /></HoverProvider>);
    act(() => {
      (globalThis as any).__d.setHoveredCoin({ id: "eurc", pegCurrency: "EUR" });
    });
    const h = (globalThis as any).__d;
    expect(h.isHovered("eurc")).toBe(true);
    expect(h.isSibling({ id: "eurs", pegCurrency: "EUR" })).toBe(true);
    expect(h.isSibling({ id: "xaut", pegCurrency: "GOLD" })).toBe(false);
    expect(h.isDimmed({ id: "xaut", pegCurrency: "GOLD" })).toBe(true);
    expect(h.isDimmed({ id: "eurs", pegCurrency: "EUR" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/app/alt-pegs/fiat-world-atlas/__tests__/hover-context.test.tsx`

- [ ] **Step 3: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/hover-context.tsx
"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { PegCurrency } from "@shared/types";

interface HoverTarget {
  id: string;
  pegCurrency: PegCurrency;
}

interface HoverContextValue {
  hoveredCoinId: string | null;
  hoveredPeg: PegCurrency | null;
  setHoveredCoin: (target: HoverTarget | null) => void;
  isHovered: (coinId: string) => boolean;
  isSibling: (target: HoverTarget) => boolean;
  isDimmed: (target: HoverTarget) => boolean;
}

const HoverContext = createContext<HoverContextValue | null>(null);

export function HoverProvider({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<HoverTarget | null>(null);

  const setHoveredCoin = useCallback((target: HoverTarget | null) => {
    setHovered(target);
  }, []);

  const value = useMemo<HoverContextValue>(() => {
    const hoveredCoinId = hovered?.id ?? null;
    const hoveredPeg = hovered?.pegCurrency ?? null;
    return {
      hoveredCoinId,
      hoveredPeg,
      setHoveredCoin,
      isHovered: (id) => hoveredCoinId === id,
      isSibling: (t) => hoveredPeg !== null && t.pegCurrency === hoveredPeg && t.id !== hoveredCoinId,
      isDimmed: (t) => hoveredPeg !== null && t.pegCurrency !== hoveredPeg,
    };
  }, [hovered, setHoveredCoin]);

  return <HoverContext.Provider value={value}>{children}</HoverContext.Provider>;
}

export function useHoverState(): HoverContextValue {
  const ctx = useContext(HoverContext);
  if (!ctx) {
    // Graceful fallback for stories / isolated tests: no-op hover state.
    return {
      hoveredCoinId: null,
      hoveredPeg: null,
      setHoveredCoin: () => {},
      isHovered: () => false,
      isSibling: () => false,
      isDimmed: () => false,
    };
  }
  return ctx;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/app/alt-pegs/fiat-world-atlas/__tests__/hover-context.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/hover-context.tsx src/app/alt-pegs/fiat-world-atlas/__tests__/hover-context.test.tsx
git commit -m "feat(alt-pegs): shared hover context for cohort resonance"
```

---

## Task 5: CoinEmblem atomic component

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/coin-emblem.tsx`
- Test: `src/app/alt-pegs/fiat-world-atlas/__tests__/coin-emblem.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/alt-pegs/fiat-world-atlas/__tests__/coin-emblem.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

const sample: PlacedCoin = {
  id: "eurc-circle",
  symbol: "EURC",
  name: "EURC",
  href: "/stablecoin/eurc-circle",
  logoSrc: "/logos/50-eurc.png",
  pegCurrency: "EUR",
  marketCap: 432_000_000,
  x: 52, y: 20, sizePx: 109,
};

describe("CoinEmblem", () => {
  afterEach(() => cleanup());

  it("renders an anchor with href and accessible label", () => {
    const { getByRole } = render(
      <HoverProvider><CoinEmblem coin={sample} variant="fiat" /></HoverProvider>,
    );
    const link = getByRole("link");
    expect(link.getAttribute("href")).toBe("/stablecoin/eurc-circle");
    expect(link.getAttribute("aria-label")).toContain("EURC");
    expect(link.getAttribute("aria-label")).toContain("EUR");
  });

  it("sizes + positions via inline style", () => {
    const { getByRole } = render(
      <HoverProvider><CoinEmblem coin={sample} variant="fiat" /></HoverProvider>,
    );
    const link = getByRole("link") as HTMLAnchorElement;
    expect(link.style.width).toBe("109px");
    expect(link.style.height).toBe("109px");
    expect(link.style.left).toBe("52%");
    expect(link.style.top).toBe("20%");
  });

  it("applies variant-specific ring class", () => {
    const { getByRole, rerender } = render(
      <HoverProvider><CoinEmblem coin={sample} variant="sun-core" /></HoverProvider>,
    );
    expect(getByRole("link").className).toContain("coin-emblem--sun-core");

    rerender(
      <HoverProvider><CoinEmblem coin={{ ...sample, pegCurrency: "VAR" }} variant="star" /></HoverProvider>,
    );
    expect(getByRole("link").className).toContain("coin-emblem--star");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/app/alt-pegs/fiat-world-atlas/__tests__/coin-emblem.test.tsx`

- [ ] **Step 3: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/coin-emblem.tsx
"use client";

import Image from "next/image";
import { useCallback, useMemo, type CSSProperties } from "react";
import { formatCompactUsd } from "@shared/lib/format";
import type { PlacedCoin } from "@/lib/alt-peg-hero";
import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";

export type EmblemVariant = "fiat" | "sun-core" | "sun-planet" | "moon" | "star";

export function CoinEmblem({
  coin,
  variant,
  loading = "lazy",
}: {
  coin: PlacedCoin;
  variant: EmblemVariant;
  loading?: "eager" | "lazy";
}) {
  const { setHoveredCoin, isHovered, isSibling, isDimmed } = useHoverState();
  const target = useMemo(() => ({ id: coin.id, pegCurrency: coin.pegCurrency }), [coin.id, coin.pegCurrency]);
  const hovered = isHovered(coin.id);
  const sibling = isSibling(target);
  const dimmed = isDimmed(target);

  const onEnter = useCallback(() => setHoveredCoin(target), [setHoveredCoin, target]);
  const onLeave = useCallback(() => setHoveredCoin(null), [setHoveredCoin]);
  const onFocus = onEnter;
  const onBlur = onLeave;

  const mcap = coin.marketCap > 0 ? formatCompactUsd(coin.marketCap) : null;

  const style: CSSProperties = {
    left: `${coin.x}%`,
    top: `${coin.y}%`,
    width: `${coin.sizePx}px`,
    height: `${coin.sizePx}px`,
  };

  const cls = [
    "coin-emblem",
    `coin-emblem--${variant}`,
    hovered && "is-hovered",
    sibling && "is-sibling",
    dimmed && "is-dimmed",
  ].filter(Boolean).join(" ");

  const ariaLabel = mcap
    ? `${coin.symbol} · ${coin.name} · ${mcap} market cap · ${coin.pegCurrency} peg`
    : `${coin.symbol} · ${coin.name} · ${coin.pegCurrency} peg`;

  return (
    <a
      href={coin.href}
      className={cls}
      style={style}
      aria-label={ariaLabel}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      data-coin-id={coin.id}
      data-peg={coin.pegCurrency}
    >
      <Image
        src={coin.logoSrc}
        alt=""
        width={coin.sizePx}
        height={coin.sizePx}
        unoptimized
        loading={loading}
        className="coin-emblem__img"
      />
      {hovered ? (
        <span role="tooltip" className="coin-emblem__tooltip">
          <span className="coin-emblem__tooltip-symbol">{coin.symbol}</span>
          {mcap ? <span className="coin-emblem__tooltip-mcap">{mcap}</span> : null}
          <span className="coin-emblem__tooltip-peg">{coin.pegCurrency}</span>
        </span>
      ) : null}
    </a>
  );
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/app/alt-pegs/fiat-world-atlas/__tests__/coin-emblem.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/coin-emblem.tsx src/app/alt-pegs/fiat-world-atlas/__tests__/coin-emblem.test.tsx
git commit -m "feat(alt-pegs): CoinEmblem atomic component"
```

---

## Task 6: Starfield

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/starfield.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/starfield.tsx
import type { CSSProperties } from "react";

interface AvoidZone { x: number; y: number; rx: number; ry: number }

const AVOID_SKY: AvoidZone[] = [
  { x: 0.16, y: 0.48, rx: 0.22, ry: 0.55 },   // sun
  { x: 0.50, y: 0.42, rx: 0.10, ry: 0.30 },   // moon
  { x: 0.82, y: 0.55, rx: 0.18, ry: 0.45 },   // constellation
];

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

interface Star {
  cx: number; cy: number; size: number; opacity: number; delay: number;
}

function generateStars(count: number, seed: number): Star[] {
  const rnd = seededRandom(seed);
  const out: Star[] = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 6) {
    attempts++;
    const x = rnd();
    const y = rnd();
    if (AVOID_SKY.some((z) => ((x - z.x) / z.rx) ** 2 + ((y - z.y) / z.ry) ** 2 < 1)) continue;
    const roll = rnd();
    const size = roll < 0.5 ? 1.5 : roll < 0.82 ? 2 : roll < 0.96 ? 3 : 4;
    const opacity = roll < 0.5 ? 0.45 : roll < 0.82 ? 0.65 : roll < 0.96 ? 0.9 : 1;
    out.push({ cx: x, cy: y, size, opacity, delay: rnd() * 3 });
  }
  return out;
}

const STARS = generateStars(80, 42);

export function Starfield() {
  return (
    <div className="peg-hero-starfield" aria-hidden="true">
      {STARS.map((s, i) => {
        const style: CSSProperties = {
          left: `${s.cx * 100}%`,
          top: `${s.cy * 100}%`,
          width: `${s.size}px`,
          height: `${s.size}px`,
          opacity: s.opacity,
          animationDelay: `${s.delay}s`,
        };
        return <span key={i} className="peg-hero-starfield__star" style={style} />;
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/starfield.tsx
git commit -m "feat(alt-pegs): deterministic ambient starfield"
```

---

## Task 7: Cohort threads (hover overlay)

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/cohort-threads.tsx`
- Test: `src/app/alt-pegs/fiat-world-atlas/__tests__/cohort-threads.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/alt-pegs/fiat-world-atlas/__tests__/cohort-threads.test.tsx
// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import { HoverProvider, useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

function makeCoin(id: string, peg: PlacedCoin["pegCurrency"], x: number, y: number): PlacedCoin {
  return {
    id, symbol: id.toUpperCase(), name: id, href: `/s/${id}`,
    logoSrc: `/l/${id}.png`, pegCurrency: peg,
    marketCap: 1_000_000, x, y, sizePx: 40,
  };
}

function Harness({ coins, hoverId }: { coins: PlacedCoin[]; hoverId: string | null }) {
  const { setHoveredCoin } = useHoverState();
  if (hoverId) {
    const c = coins.find((c) => c.id === hoverId);
    if (c) setHoveredCoin({ id: c.id, pegCurrency: c.pegCurrency });
  }
  return <CohortThreads coins={coins} colorHex="#60a5fa" />;
}

describe("CohortThreads", () => {
  afterEach(() => cleanup());

  it("renders nothing when no coin is hovered", () => {
    const coins = [makeCoin("a", "EUR", 50, 20), makeCoin("b", "EUR", 60, 25)];
    const { container } = render(
      <HoverProvider><CohortThreads coins={coins} colorHex="#60a5fa" /></HoverProvider>,
    );
    expect(container.querySelectorAll("line").length).toBe(0);
  });

  it("draws N-1 lines when hovering a coin with N siblings in same layer", async () => {
    const coins = [
      makeCoin("a", "EUR", 50, 20),
      makeCoin("b", "EUR", 60, 25),
      makeCoin("c", "EUR", 40, 25),
      makeCoin("d", "JPY", 80, 30),
    ];
    const { container } = render(
      <HoverProvider><Harness coins={coins} hoverId="a" /></HoverProvider>,
    );
    await act(async () => { /* flush */ });
    const lines = container.querySelectorAll("line");
    expect(lines.length).toBe(2); // a→b, a→c (d is JPY, excluded)
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/cohort-threads.tsx
"use client";

import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

export function CohortThreads({
  coins,
  colorHex,
}: {
  coins: readonly PlacedCoin[];
  colorHex: string;
}) {
  const { hoveredCoinId, hoveredPeg } = useHoverState();
  if (!hoveredCoinId || !hoveredPeg) return null;
  const origin = coins.find((c) => c.id === hoveredCoinId);
  if (!origin) return null;
  const siblings = coins.filter((c) => c.pegCurrency === hoveredPeg && c.id !== hoveredCoinId);
  if (siblings.length === 0) return null;

  return (
    <svg className="cohort-threads" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {siblings.map((s) => (
        <line
          key={s.id}
          x1={origin.x}
          y1={origin.y}
          x2={s.x}
          y2={s.y}
          stroke={colorHex}
          strokeOpacity={0.55}
          strokeWidth={0.25}
          strokeDasharray="0.8 1.4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/cohort-threads.tsx src/app/alt-pegs/fiat-world-atlas/__tests__/cohort-threads.test.tsx
git commit -m "feat(alt-pegs): cohort-resonance hover threads"
```

---

## Task 8: SunCohort

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/sun-cohort.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/sun-cohort.tsx
"use client";

import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

const SUN_HALO_PCT = { cx: 16, cy: 48 };

export function SunCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  const [primary, ...rest] = cohort.coins;

  return (
    <div className="sun-cohort" aria-label="Gold stablecoins">
      <div
        className="sun-cohort__halo"
        style={{ left: `${SUN_HALO_PCT.cx}%`, top: `${SUN_HALO_PCT.cy}%` }}
      />
      <svg
        className="sun-cohort__rays"
        style={{ left: `${SUN_HALO_PCT.cx}%`, top: `${SUN_HALO_PCT.cy}%` }}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <g stroke="rgba(253,224,71,0.5)" strokeWidth={0.6}>
          <line x1="50" y1="5"  x2="50" y2="20" />
          <line x1="50" y1="80" x2="50" y2="95" />
          <line x1="5"  y1="50" x2="20" y2="50" />
          <line x1="80" y1="50" x2="95" y2="50" />
          <line x1="15" y1="15" x2="28" y2="28" />
          <line x1="72" y1="72" x2="85" y2="85" />
          <line x1="85" y1="15" x2="72" y2="28" />
          <line x1="15" y1="85" x2="28" y2="72" />
        </g>
      </svg>
      <CohortThreads coins={cohort.coins} colorHex="#facc15" />
      <span className="sky-region-tag" style={{ left: "16%", top: "9%" }}>
        Gold · Sun · {cohort.coins.length} {cohort.coins.length === 1 ? "coin" : "coins"}
      </span>
      <CoinEmblem coin={primary} variant="sun-core" loading="eager" />
      {rest.map((c, i) => (
        <CoinEmblem
          key={c.id}
          coin={c}
          variant={i === 0 ? "sun-core" : "sun-planet"}
          loading={i < 2 ? "eager" : "lazy"}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/sun-cohort.tsx
git commit -m "feat(alt-pegs): SunCohort for Gold stablecoins"
```

---

## Task 9: MoonCohort

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/moon-cohort.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/moon-cohort.tsx
"use client";

import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function MoonCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  return (
    <div className="moon-cohort" aria-label="Silver stablecoins">
      <div className="moon-cohort__halo" style={{ left: "50%", top: "42%" }} />
      <CohortThreads coins={cohort.coins} colorHex="#cbd5e1" />
      <span className="sky-region-tag" style={{ left: "50%", top: "9%" }}>
        Silver · Moon
      </span>
      {cohort.coins.map((c) => (
        <CoinEmblem key={c.id} coin={c} variant="moon" loading="eager" />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/moon-cohort.tsx
git commit -m "feat(alt-pegs): MoonCohort for Silver"
```

---

## Task 10: ConstellationCohort

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/constellation-cohort.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/constellation-cohort.tsx
"use client";

import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function ConstellationCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  // Static dashed traces connecting the three stars in reading order.
  return (
    <div className="constellation-cohort" aria-label="Index-linked stablecoins">
      <svg
        className="constellation-cohort__traces"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {cohort.coins.slice(1).map((c, idx) => {
          const prev = cohort.coins[idx];
          return (
            <line
              key={`${prev.id}-${c.id}`}
              x1={prev.x}
              y1={prev.y}
              x2={c.x}
              y2={c.y}
              stroke="rgba(200,215,255,0.4)"
              strokeWidth={0.3}
              strokeDasharray="0.6 1.2"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <CohortThreads coins={cohort.coins} colorHex="#a8bae0" />
      <span className="sky-region-tag" style={{ left: "82%", top: "9%" }}>
        Index · Constellation
      </span>
      {cohort.coins.map((c) => (
        <CoinEmblem key={c.id} coin={c} variant="star" loading="eager" />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/constellation-cohort.tsx
git commit -m "feat(alt-pegs): ConstellationCohort for index pegs"
```

---

## Task 11: SkyLayer

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/sky-layer.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/alt-pegs/fiat-world-atlas/sky-layer.tsx
import { ConstellationCohort } from "@/app/alt-pegs/fiat-world-atlas/constellation-cohort";
import { MoonCohort } from "@/app/alt-pegs/fiat-world-atlas/moon-cohort";
import { Starfield } from "@/app/alt-pegs/fiat-world-atlas/starfield";
import { SunCohort } from "@/app/alt-pegs/fiat-world-atlas/sun-cohort";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function SkyLayer({ cohorts }: { cohorts: readonly SkyCohort[] }) {
  const byKind = new Map(cohorts.map((c) => [c.kind, c] as const));
  const sun = byKind.get("sun");
  const moon = byKind.get("moon");
  const constellation = byKind.get("constellation");
  return (
    <div className="peg-hero__sky">
      <Starfield />
      {sun ? <SunCohort cohort={sun} /> : null}
      {moon ? <MoonCohort cohort={moon} /> : null}
      {constellation ? <ConstellationCohort cohort={constellation} /> : null}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/sky-layer.tsx
git commit -m "feat(alt-pegs): SkyLayer composition"
```

---

## Task 12: EarthLayer + FiatEmblems

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live.tsx`
- Create: `src/app/alt-pegs/fiat-world-atlas/fiat-emblems.tsx`
- Modify: `src/app/alt-pegs/fiat-world-atlas/world-map.tsx` — remove `items` prop and country colors; stay SVG-only with muted slate theme

- [ ] **Step 1: Simplify WorldMap** (replace the whole file)

```tsx
// src/app/alt-pegs/fiat-world-atlas/world-map.tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORLD_SVG = readFileSync(resolve(process.cwd(), "public/maps/world-countries.svg"), "utf8");

const STYLE_BLOCK = `
.fiat-world-map{--world-default-fill:oklch(0.79 0.015 248 / 1);--world-stroke:oklch(0.48 0.02 248 / 0.58)}
.dark .fiat-world-map{--world-default-fill:oklch(0.22 0.014 248 / 1);--world-stroke:oklch(0.62 0.02 248 / 0.55)}
.fiat-world-map .world-countries{stroke-width:0.7}
`;

export function WorldMap() {
  return (
    <div className="fiat-world-map relative h-full w-full" aria-label="World map backdrop">
      <style>{STYLE_BLOCK}</style>
      <div className="[&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: WORLD_SVG }} />
    </div>
  );
}
```

- [ ] **Step 2: Implement FiatEmblems**

```tsx
// src/app/alt-pegs/fiat-world-atlas/fiat-emblems.tsx
"use client";

import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { PegCluster } from "@/lib/alt-peg-hero";

export function FiatEmblems({ clusters }: { clusters: readonly PegCluster[] }) {
  const allCoins = clusters.flatMap((c) => c.coins);
  return (
    <div className="fiat-emblems">
      <CohortThreads coins={allCoins} colorHex="#60a5fa" />
      {clusters.map((cluster) =>
        cluster.coins.map((coin, idx) => (
          <CoinEmblem
            key={coin.id}
            coin={coin}
            variant="fiat"
            loading={idx === 0 ? "eager" : "lazy"}
          />
        )),
      )}
    </div>
  );
}
```

- [ ] **Step 3: Implement EarthLayer**

```tsx
// src/app/alt-pegs/fiat-world-atlas/earth-layer.tsx
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import type { PegCluster } from "@/lib/alt-peg-hero";

export function EarthLayer({ clusters }: { clusters: readonly PegCluster[] }) {
  return (
    <div className="peg-hero__earth">
      <div className="peg-hero__horizon" aria-hidden="true" />
      <div className="peg-hero__map-frame">
        <WorldMap />
        <FiatEmblems clusters={clusters} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/earth-layer.tsx src/app/alt-pegs/fiat-world-atlas/fiat-emblems.tsx src/app/alt-pegs/fiat-world-atlas/world-map.tsx
git commit -m "feat(alt-pegs): EarthLayer with aspect-locked map frame + fiat emblems"
```

---

## Task 13: Rewrite world-atlas.tsx + stylesheet

**Files:**
- Rewrite: `src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx`
- Create: `src/app/alt-pegs/fiat-world-atlas/peg-hero.css` — all hero-specific styles (keyframes, classes, CSS vars)
- Modify: `src/app/alt-pegs/client.tsx` or wherever `FiatWorldAtlas` is rendered — verify props still match

- [ ] **Step 1: Create peg-hero.css**

```css
/* src/app/alt-pegs/fiat-world-atlas/peg-hero.css */
.peg-hero {
  position: relative;
  width: 100%;
  aspect-ratio: 1.6 / 1;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid oklch(0.6 0 0 / 0.12);
  background: linear-gradient(to bottom,
    oklch(0.02 0 0) 0%,
    oklch(0.08 0.02 260) 18%,
    oklch(0.12 0.03 260) 30%,
    oklch(0.15 0.04 260) 34%,
    oklch(0.16 0.04 260) 37%,
    oklch(0.12 0.03 260) 45%,
    oklch(0.08 0.02 260) 65%,
    oklch(0.04 0.01 260) 100%);
}

.peg-hero__sky {
  position: absolute; top: 0; left: 0; right: 0; height: 30%;
  z-index: 2;
}
.peg-hero__earth {
  position: absolute; bottom: 0; left: 0; right: 0; height: 70%;
  z-index: 3;
  display: flex; justify-content: center; align-items: flex-end;
}
.peg-hero__horizon {
  position: absolute; top: -2px; left: 0; right: 0; height: 40px;
  background: linear-gradient(to bottom,
    oklch(0.7 0.06 250 / 0.10),
    oklch(0.6 0.08 250 / 0.04) 45%, transparent 100%);
  pointer-events: none; z-index: 2;
}
.peg-hero__map-frame {
  position: relative;
  height: 100%;
  aspect-ratio: 900 / 460;
  max-width: 100%;
}
.peg-hero__map-frame .fiat-world-map svg {
  filter: drop-shadow(0 -4px 18px oklch(0.5 0.15 250 / 0.18));
}

/* ===== STARFIELD ===== */
.peg-hero-starfield {
  position: absolute; inset: 0;
  pointer-events: none;
  z-index: 1;
}
.peg-hero-starfield__star {
  position: absolute;
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 4px rgba(255,255,255,0.7);
}

@media (prefers-reduced-motion: no-preference) {
  .peg-hero-starfield__star {
    animation: peg-twinkle 4s ease-in-out infinite;
  }
  @keyframes peg-twinkle {
    0%, 100% { opacity: var(--star-o, 0.5); }
    50% { opacity: 1; }
  }
}

/* ===== SKY COHORT BODIES ===== */
.sky-region-tag {
  position: absolute;
  transform: translate(-50%, -50%);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: oklch(0.85 0.02 250 / 0.58);
  font-weight: 700;
  padding: 3px 8px;
  background: oklch(0 0 0 / 0.45);
  border-radius: 10px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 4;
}

.sun-cohort__halo, .moon-cohort__halo {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  z-index: 1;
  pointer-events: none;
}
.sun-cohort__halo {
  width: 340px; height: 340px;
  background: radial-gradient(circle at center,
    oklch(0.92 0.16 90 / 0.55) 0%,
    oklch(0.82 0.17 75 / 0.28) 18%,
    oklch(0.68 0.14 55 / 0.12) 40%, transparent 65%);
}
.sun-cohort__rays {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 440px; height: 440px;
  z-index: 1; pointer-events: none; opacity: 0.4;
}
.moon-cohort__halo {
  width: 160px; height: 160px;
  background: radial-gradient(circle at center,
    oklch(0.9 0.02 250 / 0.35) 0%,
    oklch(0.75 0.02 250 / 0.14) 40%, transparent 70%);
}
.constellation-cohort__traces {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  z-index: 1; pointer-events: none;
}

@media (prefers-reduced-motion: no-preference) {
  .sun-cohort__halo { animation: peg-pulse-sun 5s ease-in-out infinite; }
  .moon-cohort__halo { animation: peg-pulse-moon 6s ease-in-out infinite; }
  @keyframes peg-pulse-sun {
    0%, 100% { transform: translate(-50%, -50%) scale(0.96); opacity: 0.9; }
    50% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }
  @keyframes peg-pulse-moon {
    0%, 100% { transform: translate(-50%, -50%) scale(0.97); opacity: 0.9; }
    50% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }
}

/* ===== COIN EMBLEMS ===== */
.coin-emblem {
  position: absolute;
  border-radius: 50%;
  overflow: hidden;
  background: #f1f5f9;
  border: 2px solid rgba(255,255,255,0.95);
  box-shadow: 0 6px 18px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4);
  transform: translate(-50%, -50%);
  cursor: pointer;
  display: block;
  z-index: 5;
  transition: transform 180ms ease-out, box-shadow 180ms ease-out, opacity 180ms ease-out, border-color 180ms ease-out;
  text-decoration: none;
}
.coin-emblem:focus-visible { outline: none; }
.coin-emblem__img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* Variant rims */
.coin-emblem--sun-core {
  border: 3px solid oklch(0.85 0.18 90 / 0.95);
  box-shadow:
    0 0 0 3px oklch(0.85 0.18 90 / 0.25),
    0 0 30px oklch(0.78 0.2 80 / 0.75),
    0 0 70px oklch(0.78 0.2 80 / 0.35);
}
.coin-emblem--sun-planet {
  border: 2px solid oklch(0.58 0.12 75 / 0.85);
  box-shadow: 0 4px 14px rgba(0,0,0,0.5), 0 0 10px oklch(0.78 0.2 80 / 0.25);
}
.coin-emblem--moon {
  border: 3px solid oklch(0.9 0.02 250 / 0.95);
  box-shadow:
    0 0 0 2px oklch(0.9 0.02 250 / 0.25),
    0 0 24px oklch(0.85 0.02 250 / 0.65),
    0 0 55px oklch(0.85 0.02 250 / 0.30);
}
.coin-emblem--star {
  border: 2px solid oklch(0.86 0.04 260 / 0.9);
  box-shadow: 0 0 14px oklch(0.77 0.08 250 / 0.7), 0 0 30px oklch(0.65 0.1 250 / 0.35);
}

/* Hover / focus states */
.coin-emblem.is-hovered,
.coin-emblem:focus-visible {
  transform: translate(-50%, -50%) scale(1.1);
  z-index: 30;
  box-shadow:
    0 0 0 3px oklch(0.75 0.15 250 / 0.55),
    0 0 28px oklch(0.75 0.2 250 / 0.65),
    0 6px 18px rgba(0,0,0,0.6);
}
.coin-emblem.is-sibling {
  border-color: oklch(0.86 0.08 250 / 0.95);
  box-shadow: 0 0 14px oklch(0.78 0.14 250 / 0.55), 0 0 28px oklch(0.7 0.15 250 / 0.3), 0 4px 10px rgba(0,0,0,0.5);
  z-index: 6;
}
.coin-emblem.is-dimmed { opacity: 0.55; }

.coin-emblem__tooltip {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: oklch(0.09 0.02 260 / 0.96);
  border: 1px solid oklch(0.75 0.05 260 / 0.35);
  border-radius: 8px;
  padding: 7px 11px;
  min-width: 120px;
  color: oklch(0.98 0 0);
  font-size: 10px;
  line-height: 1.4;
  backdrop-filter: blur(8px);
  z-index: 40;
  white-space: nowrap;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  pointer-events: none;
}
.coin-emblem__tooltip-symbol { font-weight: 700; font-size: 12px; }
.coin-emblem__tooltip-mcap { color: oklch(0.78 0.14 250); font-variant-numeric: tabular-nums; }
.coin-emblem__tooltip-peg { color: oklch(0.75 0.04 260 / 0.7); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; }

/* ===== COHORT THREADS ===== */
.cohort-threads {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  z-index: 4;
  pointer-events: none;
}

/* ===== FIAT EMBLEMS WRAPPER ===== */
.fiat-emblems { position: absolute; inset: 0; }
.sun-cohort, .moon-cohort, .constellation-cohort { position: absolute; inset: 0; }

@media (prefers-reduced-motion: reduce) {
  .coin-emblem { transition: none; }
}
```

- [ ] **Step 2: Rewrite world-atlas.tsx**

```tsx
// src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx
"use client";

import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { CelestialBand } from "@/app/alt-pegs/fiat-world-atlas/celestial-band";
import { FiatRegionSection, LinkChip, RegionSummaryPill } from "@/app/alt-pegs/fiat-world-atlas/region-chips";
import { MobileRegionList } from "@/app/alt-pegs/fiat-world-atlas/mobile-region-list";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import { SkyLayer } from "@/app/alt-pegs/fiat-world-atlas/sky-layer";
import { EarthLayer } from "@/app/alt-pegs/fiat-world-atlas/earth-layer";
import "./peg-hero.css";

const ATLAS_REGION_ORDER: Exclude<AltPegRegion, "Other">[] = ["Americas", "Europe", "Asia", "Africa", "Oceania"];

function getRegionCoinCount(items: readonly AltPegLinkHubItem[]): number {
  return items.reduce((sum, i) => sum + i.coinCount, 0);
}

function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function AtlasMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 border-l border-border/70 pl-3 first:border-l-0 first:pl-0 dark:border-white/10">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground dark:text-white">{value}</p>
    </div>
  );
}

function AtlasHeroHeader({
  geoRegions,
  totalCohortCount,
  totalCoinCount,
}: {
  geoRegions: readonly { region: Exclude<AltPegRegion, "Other">; items: readonly AltPegLinkHubItem[] }[];
  totalCohortCount: number;
  totalCoinCount: number;
}) {
  return (
    <div className="relative z-10 px-4 py-5 sm:px-5 sm:py-6 lg:px-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.44fr)] lg:items-end">
        <div className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-frost-blue/90">Fiat Peg Geography</p>
          <div className="space-y-2">
            <h2
              id="alt-peg-link-hub"
              className="text-4xl font-black leading-[0.95] tracking-normal text-foreground dark:text-white sm:text-5xl"
            >
              Peg Diversity Map
            </h2>
            <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground dark:text-slate-300">
              Every non-USD stablecoin sits at its geographic origin, sized by market cap. Gold, Silver, and
              index-linked references float in the sky above — references beyond any single monetary region.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 border-t border-border/70 pt-4 dark:border-white/10 lg:border-t-0 lg:pt-0">
          <AtlasMetric label="Cohorts" value={totalCohortCount} />
          <AtlasMetric label="Coins" value={totalCoinCount} />
          <AtlasMetric label="Regions" value={geoRegions.length} />
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {geoRegions.map(({ region, items }) => (
          <RegionSummaryPill
            key={region}
            region={region}
            cohortCount={items.length}
            coinCount={getRegionCoinCount(items)}
          />
        ))}
      </div>
    </div>
  );
}

function BeyondGeographyRail({
  items,
  referenceCoinCount,
}: {
  items: readonly AltPegLinkHubItem[];
  referenceCoinCount: number;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label="References beyond geography" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90 dark:text-white/90">
          Beyond Geography
        </p>
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground dark:text-slate-300/86">
          {formatCount(items.length, "cohort")} · {formatCount(referenceCoinCount, "coin")}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 lg:gap-1.5">
        {items.map((item) => <LinkChip key={item.href} item={item} />)}
      </div>
    </section>
  );
}

export function FiatWorldAtlas({
  fiatItems,
  commodityIndexItems,
}: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
}) {
  const { data: stablecoins } = useStablecoins();
  const hero = buildPegDiversityHero(stablecoins?.peggedAssets);

  const fiatByRegion = new Map<AltPegRegion, AltPegLinkHubItem[]>();
  for (const item of fiatItems) {
    const list = fiatByRegion.get(item.region) ?? [];
    list.push(item);
    fiatByRegion.set(item.region, list);
  }
  const geoRegions = ATLAS_REGION_ORDER.map((region) => ({
    region, items: fiatByRegion.get(region) ?? [],
  })).filter((entry) => entry.items.length > 0);

  const fiatCoinCount = getRegionCoinCount(fiatItems);
  const referenceCoinCount = getRegionCoinCount(commodityIndexItems);
  const totalCohortCount = fiatItems.length + commodityIndexItems.length;
  const totalCoinCount = fiatCoinCount + referenceCoinCount;

  return (
    <section
      aria-labelledby="alt-peg-link-hub"
      className="relative overflow-hidden rounded-[1.45rem] border border-border/70 bg-card/92 text-foreground shadow-[0_22px_60px_oklch(0_0_0_/0.12)] dark:border-white/10 dark:bg-[oklch(0.105_0.012_248)] dark:text-white dark:shadow-[0_26px_70px_oklch(0_0_0_/0.22)]"
    >
      <AtlasHeroHeader geoRegions={geoRegions} totalCohortCount={totalCohortCount} totalCoinCount={totalCoinCount} />

      <div data-alt-peg-layout="desktop-atlas" className="hidden xl:block">
        <HoverProvider>
          <div className="peg-hero">
            <SkyLayer cohorts={hero.skyCohorts} />
            <EarthLayer clusters={hero.pegClusters} />
          </div>
        </HoverProvider>
        <p className="px-4 pt-2 pb-4 text-center text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground dark:text-slate-400">
          Size ∝ market cap · $1M &hellip; $3B+
        </p>
        <div className="grid gap-3 bg-background/45 px-4 py-4 dark:bg-white/[0.035] sm:grid-cols-2 sm:px-5 sm:py-5 lg:grid-cols-3">
          {geoRegions.map(({ region, items }) => (
            <FiatRegionSection key={region} region={region} items={items} />
          ))}
          <BeyondGeographyRail items={commodityIndexItems} referenceCoinCount={referenceCoinCount} />
        </div>
      </div>

      <div className="xl:hidden">
        <CelestialBand items={commodityIndexItems} />
        <MobileRegionList fiatItems={fiatItems} />
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Run typecheck to catch import/type errors**

Run: `npx tsc --noEmit`
Expected: no errors (aside from any preexisting unrelated warnings).

- [ ] **Step 4: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx src/app/alt-pegs/fiat-world-atlas/peg-hero.css
git commit -m "feat(alt-pegs): rewire hero to night-sky icon map"
```

---

## Task 14: Remove obsolete components and their tests

**Files:**
- Delete the obsolete map-emblem-clusters component and its test.
- Delete the obsolete map-deadspot-references component and its test.
- Delete the obsolete world-map-interactive component and its test.
- Modify: `src/app/alt-pegs/fiat-world-atlas/__tests__/world-map.test.tsx` — the existing test passed `items` and asserted color maps; rewrite to the new signature

- [ ] **Step 1: Rewrite world-map.test.tsx to match the simplified WorldMap**

```tsx
// src/app/alt-pegs/fiat-world-atlas/__tests__/world-map.test.tsx
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";

describe("WorldMap", () => {
  afterEach(() => cleanup());

  it("renders the world SVG with the fiat-world-map class on the wrapper", () => {
    const { container } = render(<WorldMap />);
    const wrapper = container.querySelector(".fiat-world-map");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector("svg")).not.toBeNull();
  });

  it("does not apply any peg-specific fill overrides", () => {
    const { container } = render(<WorldMap />);
    const styleEl = container.querySelector("style");
    expect(styleEl).not.toBeNull();
    expect(styleEl!.textContent).not.toMatch(/path#\w+\{fill:/);
  });
});
```

- [ ] **Step 2: Delete obsolete files**

```bash
rm src/app/alt-pegs/fiat-world-atlas/map-emblem-clusters.tsx
rm src/app/alt-pegs/fiat-world-atlas/map-deadspot-references.tsx
rm src/app/alt-pegs/fiat-world-atlas/world-map-interactive.tsx
rm src/app/alt-pegs/fiat-world-atlas/__tests__/map-emblem-clusters.test.tsx
rm src/app/alt-pegs/fiat-world-atlas/__tests__/map-deadspot-references.test.tsx
rm src/app/alt-pegs/fiat-world-atlas/__tests__/world-map-interactive.test.tsx
```

- [ ] **Step 3: Verify nothing imports the deleted modules**

Run: `grep -rln "MapEmblemClusters\|MapDeadspotReferences\|WorldMapInteractive" src/ shared/ 2>/dev/null`
Expected: empty (or only the deleted files themselves if `rm` hasn't run yet).

- [ ] **Step 4: Remove the now-unused `buildPegEmblemClusters` export**

Open `src/lib/alt-peg-emblems.ts`. Keep `PEG_ANCHORS` (consumed by `alt-peg-hero.ts`) and the `PegEmblem`/`PegEmblemCluster` types only if still referenced elsewhere; otherwise delete the unused helpers.

Verify with: `grep -rn "buildPegEmblemClusters\|buildPegEmblems\|PegEmblem\b\|PegEmblemCluster" src/ 2>/dev/null`
Keep only types/exports that still have callers.

- [ ] **Step 5: Run the whole test suite**

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(alt-pegs): drop cluster badges, deadspot refs, interactive map layer"
```

---

## Task 15: Full verification

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Worker type check**

Run: `cd worker && npx tsc --noEmit && cd ..`
Expected: 0 errors.

- [ ] **Step 4: Full test suite with coverage**

Run: `npm test -- --run`
Expected: all tests green, coverage at or above 66% lines.

- [ ] **Step 5: Production build**

Run: `npm run build`
Expected: build succeeds, exports to `out/`.

- [ ] **Step 6: Merge gate**

Run: `npm run test:merge-gate`
Expected: all gates pass.

---

## Task 16: Browser smoke test

- [ ] **Step 1: Start dev server**

Run: `npm run dev &`
Wait for "ready on http://localhost:3000".

- [ ] **Step 2: Visit /alt-pegs in Playwright**

Use `mcp__plugin_playwright_playwright__browser_navigate` to `http://localhost:3000/alt-pegs`.

- [ ] **Step 3: Take screenshot (resting state)**

Save to `agents/design/2026-04-23-peg-hero-resting.png`. Verify: dark sky, starfield, sun cluster (XAUT+PAXG + planets), moon (KAG), constellation (FPI/ISC/SILK), map with EURC over Europe, A7A5 over Russia, BRZ over Brazil.

- [ ] **Step 4: Hover EURC and take screenshot**

Use `mcp__plugin_playwright_playwright__browser_hover` on the EURC emblem. Save screenshot to `agents/design/2026-04-23-peg-hero-hover-eurc.png`. Verify: EURC scales up, EUR siblings glow, dashed threads visible, non-EUR coins dim, tooltip shows "EURC · $XXXM · EUR peg".

- [ ] **Step 5: Hover XAUT (sky)**

Repeat for a gold coin. Verify sun-cohort siblings glow, constellation/fiat dim.

- [ ] **Step 6: Test reduced motion** (optional but nice)

Use Playwright with `reducedMotion: 'reduce'` context. Verify no halo pulse animation.

- [ ] **Step 7: Tear down**

Kill the dev server.

---

## Task 17: Push to main

- [ ] **Step 1: Review changes**

```bash
git log --oneline main...HEAD
git diff --stat main...HEAD
```

- [ ] **Step 2: Push**

```bash
git push origin main
```

- [ ] **Step 3: Watch CI** (optional)

```bash
gh run watch
```

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Every non-USD coin is an individual emblem | 3, 5, 12 |
| Sized by market cap (sqrt formula, floor 26, ceil 120) | 1 |
| Packed around curated peg anchors | 2, 3 |
| Gold → sun | 8 |
| Silver → moon | 9 |
| CPI → constellation | 10 |
| Ambient starfield | 6 |
| Hover → Cohort Resonance (scale, glow, threads, dim) | 4, 5, 7 |
| Tooltip with symbol / mcap / peg | 5 |
| Focus mirrors hover | 5 |
| ARIA labels on every emblem | 5 |
| Each emblem is `<a href>` for SEO | 5 |
| Mobile unchanged | 13 |
| Country colors removed | 12 |
| `prefers-reduced-motion` respected | 13 (CSS) |
| Tests for sizing/packing/builder/context/emblem/threads | 1-7 |
| Delete cluster/deadspot/interactive components | 14 |
| Full verification | 15 |
| Smoke test | 16 |
| Push | 17 |
