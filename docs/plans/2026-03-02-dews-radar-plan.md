# DEWS Radar Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the plain `DEWSSummary` card on `/depeg/` with a sonar-pulse radar visualization showing elevated coins as dots on concentric threat-band zones, with a rotating sweep line whose speed reflects the current threat level.

**Architecture:** Pure SVG component inside the existing `Card` shell. Utility functions extracted to `src/lib/dews-radar-utils.ts` (pure, testable). All sub-components (`DEWSRadar`, `DEWSDot`, `DEWSCenter`, `DEWSTooltip`, `DEWSLegend`) live in `dews-summary.tsx` — no new files beyond the utils module. No new data fetching; uses existing `useStressSignals()` hook and `logos` prop.

**Tech Stack:** React 19, SVG, CSS `@keyframes`, Vitest, existing `THREAT_BAND_HEX` tokens from `src/lib/classification.ts`.

**Design doc:** `docs/plans/2026-03-02-dews-radar-redesign.md`

---

## Radar constants (reference for all tasks)

```
SVG viewBox:  0 0 560 480
Radar center: CX=280, CY=240
Outer radius: OUTER_R=240

Band zones [innerR, outerR]:
  WATCH   [75,  108]   score 16–35    hex #14b8a6
  ALERT   [118, 151]   score 36–55    hex #eab308
  WARNING [161, 194]   score 56–75    hex #f97316
  DANGER  [204, 240]   score 76–100   hex #ef4444

Ring boundary radii (inner edge of each zone):
  r=75 (WATCH), r=118 (ALERT), r=161 (WARNING), r=204 (DANGER), r=240 (outer)

Sweep duration by highest band:
  CALM=12s  WATCH=8s  ALERT=6s  WARNING=4s  DANGER=2.5s

Dot pulse duration by band:
  WATCH=3.0s  ALERT=2.0s  WARNING=1.2s  DANGER=0.6s

Dot radius by tier:
  WARNING/DANGER → r=9 (always-visible label)
  WATCH/ALERT    → r=6 (hover label only)
```

---

## Task 1: Write failing tests for radar utility functions

**Files:**
- Create: `src/lib/__tests__/dews-radar-utils.test.ts`

**Step 1: Create the test file**

```ts
// src/lib/__tests__/dews-radar-utils.test.ts
import { describe, it, expect } from "vitest";
import {
  scoreToRadius,
  deterministicOffset,
  distributeAngles,
  highestBand,
  sweepDuration,
  pulseDuration,
} from "@/lib/dews-radar-utils";

describe("scoreToRadius", () => {
  it("returns innerR when score is at band minimum", () => {
    expect(scoreToRadius(16, "WATCH")).toBeCloseTo(75);
  });
  it("returns outerR when score is at band maximum", () => {
    expect(scoreToRadius(35, "WATCH")).toBeCloseTo(108);
  });
  it("returns midpoint for mid-band score", () => {
    // WATCH: innerR=75, outerR=108, midScore=25.5 → midR=91.5
    expect(scoreToRadius(25, "WATCH")).toBeGreaterThan(75);
    expect(scoreToRadius(25, "WATCH")).toBeLessThan(108);
  });
  it("returns innerR for DANGER minimum", () => {
    expect(scoreToRadius(76, "DANGER")).toBeCloseTo(204);
  });
  it("returns outerR for DANGER maximum", () => {
    expect(scoreToRadius(100, "DANGER")).toBeCloseTo(240);
  });
});

describe("deterministicOffset", () => {
  it("returns the same value for the same id on repeated calls", () => {
    expect(deterministicOffset("42")).toBe(deterministicOffset("42"));
  });
  it("returns different values for different ids", () => {
    // char sums of "1" and "999" differ enough to produce different offsets
    const a = deterministicOffset("1");
    const b = deterministicOffset("999");
    // Not required to differ always, but these two happen to
    // The key invariant is determinism — same id → same value
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
  });
  it("returns a finite number in [0, π/6)", () => {
    const offset = deterministicOffset("123");
    expect(isFinite(offset)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(Math.PI / 6);
  });
  it("handles empty string without throwing", () => {
    expect(() => deterministicOffset("")).not.toThrow();
    expect(deterministicOffset("")).toBe(0);
  });
});

describe("distributeAngles", () => {
  it("returns empty array for n=0", () => {
    expect(distributeAngles(0)).toEqual([]);
  });
  it("returns [-π/2] for n=1 (12 o'clock start)", () => {
    const angles = distributeAngles(1);
    expect(angles).toHaveLength(1);
    expect(angles[0]).toBeCloseTo(-Math.PI / 2);
  });
  it("returns 4 angles evenly spaced by π/2 for n=4", () => {
    const angles = distributeAngles(4);
    expect(angles).toHaveLength(4);
    const step = angles[1] - angles[0];
    expect(step).toBeCloseTo(Math.PI / 2);
    expect(angles[2] - angles[1]).toBeCloseTo(step);
    expect(angles[3] - angles[2]).toBeCloseTo(step);
  });
  it("covers a full 2π circle for any n>1", () => {
    const angles = distributeAngles(6);
    const totalSpan = angles[angles.length - 1] - angles[0] + (2 * Math.PI) / 6;
    expect(totalSpan).toBeCloseTo(2 * Math.PI);
  });
});

describe("highestBand", () => {
  it("returns CALM for empty array", () => {
    expect(highestBand([])).toBe("CALM");
  });
  it("returns CALM when only CALM bands present", () => {
    expect(highestBand(["CALM", "CALM"])).toBe("CALM");
  });
  it("returns the single elevated band when only one is present", () => {
    expect(highestBand(["CALM", "WATCH", "CALM"])).toBe("WATCH");
  });
  it("returns the highest when multiple bands are present", () => {
    expect(highestBand(["WATCH", "ALERT", "WARNING"])).toBe("WARNING");
  });
  it("returns DANGER when DANGER is present", () => {
    expect(highestBand(["WATCH", "DANGER", "ALERT"])).toBe("DANGER");
  });
});

describe("sweepDuration", () => {
  it("returns 12 for CALM", () => {
    expect(sweepDuration("CALM")).toBe(12);
  });
  it("returns a strictly decreasing duration as threat increases", () => {
    expect(sweepDuration("WATCH")).toBeGreaterThan(sweepDuration("ALERT"));
    expect(sweepDuration("ALERT")).toBeGreaterThan(sweepDuration("WARNING"));
    expect(sweepDuration("WARNING")).toBeGreaterThan(sweepDuration("DANGER"));
  });
});

describe("pulseDuration", () => {
  it("returns a strictly decreasing duration as threat increases", () => {
    expect(pulseDuration("WATCH")).toBeGreaterThan(pulseDuration("ALERT"));
    expect(pulseDuration("ALERT")).toBeGreaterThan(pulseDuration("WARNING"));
    expect(pulseDuration("WARNING")).toBeGreaterThan(pulseDuration("DANGER"));
  });
  it("returns a positive number for all bands", () => {
    expect(pulseDuration("WATCH")).toBeGreaterThan(0);
    expect(pulseDuration("DANGER")).toBeGreaterThan(0);
  });
});
```

**Step 2: Run tests — verify they all fail with "module not found"**

```bash
npm test -- src/lib/__tests__/dews-radar-utils.test.ts
```

Expected: all tests fail with `Cannot find module '@/lib/dews-radar-utils'`

---

## Task 2: Implement radar utility functions

**Files:**
- Create: `src/lib/dews-radar-utils.ts`

**Step 1: Create the module**

```ts
// src/lib/dews-radar-utils.ts
import type { ThreatBand } from "@/lib/classification";

type ElevatedBand = Exclude<ThreatBand, "CALM">;

const BAND_SCORE: Record<ElevatedBand, [number, number]> = {
  WATCH:   [16, 35],
  ALERT:   [36, 55],
  WARNING: [56, 75],
  DANGER:  [76, 100],
};

const BAND_RADIUS: Record<ElevatedBand, [number, number]> = {
  WATCH:   [75,  108],
  ALERT:   [118, 151],
  WARNING: [161, 194],
  DANGER:  [204, 240],
};

const SWEEP_DURATION: Record<ThreatBand, number> = {
  CALM:    12,
  WATCH:   8,
  ALERT:   6,
  WARNING: 4,
  DANGER:  2.5,
};

const PULSE_DURATION: Record<ElevatedBand, number> = {
  WATCH:   3.0,
  ALERT:   2.0,
  WARNING: 1.2,
  DANGER:  0.6,
};

const BAND_ORDER: ThreatBand[] = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];

/**
 * Map a coin's score to a radius within its band's radial zone.
 * scoreMin → innerR, scoreMax → outerR, linear interpolation in between.
 */
export function scoreToRadius(score: number, band: ElevatedBand): number {
  const [scoreMin, scoreMax] = BAND_SCORE[band];
  const [innerR, outerR] = BAND_RADIUS[band];
  const t = (score - scoreMin) / (scoreMax - scoreMin);
  return innerR + t * (outerR - innerR);
}

/**
 * Small deterministic angular jitter from a coin ID string, in radians.
 * Same id always returns same value. Range: [0, π/6).
 */
export function deterministicOffset(id: string): number {
  if (id.length === 0) return 0;
  const sum = id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return ((sum % 30) * Math.PI) / 180;
}

/**
 * N equally-spaced base angles starting at 12 o'clock (-π/2), clockwise.
 */
export function distributeAngles(n: number): number[] {
  if (n === 0) return [];
  const step = (2 * Math.PI) / n;
  return Array.from({ length: n }, (_, i) => -Math.PI / 2 + i * step);
}

/**
 * The highest threat band across a set of band strings.
 * Returns "CALM" if none are elevated.
 */
export function highestBand(bands: string[]): ThreatBand {
  let maxIdx = 0;
  for (const b of bands) {
    const idx = BAND_ORDER.indexOf(b as ThreatBand);
    if (idx > maxIdx) maxIdx = idx;
  }
  return BAND_ORDER[maxIdx];
}

/** Sweep revolution duration in seconds for a given system threat level. */
export function sweepDuration(band: ThreatBand): number {
  return SWEEP_DURATION[band];
}

/** Dot pulse animation duration in seconds for a given non-CALM band. */
export function pulseDuration(band: ElevatedBand): number {
  return PULSE_DURATION[band];
}
```

**Step 2: Run tests — verify all pass**

```bash
npm test -- src/lib/__tests__/dews-radar-utils.test.ts
```

Expected: all tests pass

**Step 3: Commit**

```bash
git add src/lib/dews-radar-utils.ts src/lib/__tests__/dews-radar-utils.test.ts
git commit -m "feat: add DEWS radar utility functions with tests"
```

---

## Task 3: Static radar skeleton

Build the SVG canvas: rings, spokes, outer boundary. No animation yet, no dots. Replace the entire `dews-summary.tsx` with this skeleton to verify the visual structure is correct before adding moving parts.

**Files:**
- Modify: `src/components/dews-summary.tsx` (full replacement)

**Step 1: Replace with skeleton**

```tsx
"use client";

import { useId } from "react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { PSI_ELIGIBLE_META_BY_ID } from "@/lib/psi-eligible";
import { THREAT_BAND_HEX } from "@/lib/classification";
import type { ThreatBand } from "@/lib/classification";
import {
  scoreToRadius,
  deterministicOffset,
  distributeAngles,
  highestBand,
  sweepDuration,
  pulseDuration,
} from "@/lib/dews-radar-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CX = 280;
const CY = 240;
const OUTER_R = 240;

type ElevatedBand = Exclude<ThreatBand, "CALM">;

const RING_BANDS: ElevatedBand[] = ["WATCH", "ALERT", "WARNING", "DANGER"];
const RING_RADII: Record<ElevatedBand, number> = {
  WATCH: 75, ALERT: 118, WARNING: 161, DANGER: 204,
};

// 8 spokes at 45° intervals, from r=10 to OUTER_R
const SPOKES = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return {
    x1: CX + 10 * Math.cos(a), y1: CY + 10 * Math.sin(a),
    x2: CX + OUTER_R * Math.cos(a), y2: CY + OUTER_R * Math.sin(a),
  };
});

// Wake arc: 90° sector from 12 o'clock to 3 o'clock in the sweep group's local frame.
// The sweep line points right (0°). The wake is the quadrant behind it (-90° to 0°).
// M center, L to 12 o'clock point, arc clockwise to 3 o'clock point, Z
const WAKE_PATH = `M ${CX} ${CY} L ${CX} ${CY - OUTER_R} A ${OUTER_R} ${OUTER_R} 0 0 1 ${CX + OUTER_R} ${CY} Z`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ElevatedCoin {
  id: string;
  score: number;
  band: ElevatedBand;
  symbol: string;
  name: string;
  logoUrl?: string;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computePositions(
  signals: Record<string, { score: number; band: string }>,
  logos: Record<string, string> | undefined,
): ElevatedCoin[] {
  const byBand: Record<ElevatedBand, Array<{ id: string; score: number }>> = {
    WATCH: [], ALERT: [], WARNING: [], DANGER: [],
  };

  for (const [id, entry] of Object.entries(signals)) {
    if (entry.band === "CALM") continue;
    const b = entry.band as ElevatedBand;
    if (byBand[b]) byBand[b].push({ id, score: entry.score });
  }

  const result: ElevatedCoin[] = [];

  for (const band of RING_BANDS) {
    const coins = byBand[band];
    const angles = distributeAngles(coins.length);
    coins.forEach((coin, i) => {
      const r = scoreToRadius(coin.score, band);
      const angle = angles[i] + deterministicOffset(coin.id);
      const meta = PSI_ELIGIBLE_META_BY_ID.get(coin.id);
      result.push({
        id: coin.id,
        score: coin.score,
        band,
        symbol: meta?.symbol ?? coin.id,
        name: meta?.name ?? coin.id,
        logoUrl: logos?.[coin.id],
        x: CX + r * Math.cos(angle),
        y: CY + r * Math.sin(angle),
      });
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sub-components (unexported)
// ---------------------------------------------------------------------------

// Placeholder — will be replaced in Task 4
function DEWSRadarSkeleton({ hex }: { hex: string }) {
  return (
    <svg viewBox="0 0 560 480" width="100%" style={{ maxHeight: 440 }}
      aria-label="DEWS radar" role="img">
      {/* Spokes */}
      {SPOKES.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
          stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
      ))}
      {/* Band ring boundaries */}
      {RING_BANDS.map((band) => (
        <circle key={band} cx={CX} cy={CY} r={RING_RADII[band]}
          fill="none" stroke={THREAT_BAND_HEX[band]}
          strokeOpacity={0.25} strokeWidth={1} strokeDasharray="4 6" />
      ))}
      {/* Outer boundary */}
      <circle cx={CX} cy={CY} r={OUTER_R}
        fill="none" stroke={hex}
        strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 6" />
      {/* Center placeholder */}
      <circle cx={CX} cy={CY} r={38}
        fill={hex} fillOpacity={0.12}
        stroke={hex} strokeOpacity={0.35} strokeWidth={1.5} />
      <text x={CX} y={CY - 4} textAnchor="middle" dominantBaseline="middle"
        fill={hex} fontSize={11} fontWeight={700} fontFamily="var(--font-mono)" letterSpacing={1}>
        DEWS
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Public component (wired up with skeleton only for now)
// ---------------------------------------------------------------------------

interface DEWSSummaryProps {
  logos?: Record<string, string>;
}

export function DEWSSummary({ logos }: DEWSSummaryProps) {
  const { data, isLoading } = useStressSignals();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[440px] rounded-lg bg-muted animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.signals || Object.keys(data.signals).length === 0) return null;

  const elevated = computePositions(data.signals, logos);
  const highest = highestBand(elevated.map((c) => c.band));
  const hex = THREAT_BAND_HEX[highest];

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
      </CardHeader>
      <CardContent>
        <DEWSRadarSkeleton hex={hex} />
      </CardContent>
    </Card>
  );
}
```

**Step 2: Verify it builds without errors**

```bash
npm run build 2>&1 | tail -20
```

Expected: exit 0, no TypeScript errors

**Step 3: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): radar skeleton — rings, spokes, static structure"
```

---

## Task 4: Add sweep line + wake arc animation

Replace `DEWSRadarSkeleton` with `DEWSRadar` that includes the rotating sweep group.

**Files:**
- Modify: `src/components/dews-summary.tsx`

**Step 1: Add CSS keyframes constant and replace skeleton with animated radar**

Add this constant near the top (after `WAKE_PATH`):

```tsx
const RADAR_KEYFRAMES = `
  @keyframes dews-sweep-rotate {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes dews-glow {
    0%, 100% { opacity: 0.10; }
    50%      { opacity: 0.35; }
  }
  @keyframes dews-center-pulse {
    0%, 100% { opacity: 0.65; }
    50%      { opacity: 1.00; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dews-sweep-g  { animation-play-state: paused !important; }
    .dews-glow-r   { animation: none !important; opacity: 0.15; }
    .dews-center-r { animation: none !important; opacity: 0.80; }
  }
`;
```

Replace `DEWSRadarSkeleton` with `DEWSRadar` (this is the target component for the full implementation; coin dots and center readout will be added in subsequent tasks):

```tsx
function DEWSRadar({
  elevated,
  highest,
  totalCount,
  onCoinClick,
}: {
  elevated: ElevatedCoin[];
  highest: ThreatBand;
  totalCount: number;
  onCoinClick: (id: string) => void;
}) {
  const uid = useId();
  const wakeGradId = `dews-wake-${uid}`;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const hex = THREAT_BAND_HEX[highest];
  const dur = sweepDuration(highest);

  return (
    <svg viewBox="0 0 560 480" width="100%" style={{ maxHeight: 440 }}
      aria-label={`DEWS radar — ${elevated.length === 0 ? "all coins calm" : `${elevated.length} elevated, highest: ${highest}`}`}
      role="img">
      <defs>
        <style>{RADAR_KEYFRAMES}</style>
        <radialGradient id={wakeGradId} cx={CX} cy={CY} r={OUTER_R} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={hex} stopOpacity={0.18} />
          <stop offset="100%" stopColor={hex} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* Spokes */}
      {SPOKES.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
          stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
      ))}

      {/* Band ring boundaries */}
      {RING_BANDS.map((band) => (
        <circle key={band} cx={CX} cy={CY} r={RING_RADII[band]}
          fill="none" stroke={THREAT_BAND_HEX[band]}
          strokeOpacity={0.25} strokeWidth={1} strokeDasharray="4 6" />
      ))}
      <circle cx={CX} cy={CY} r={OUTER_R}
        fill="none" stroke={hex} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 6" />

      {/* Sweep group — wake arc + line, rotates together */}
      <g
        className="dews-sweep-g"
        style={{
          transformOrigin: `${CX}px ${CY}px`,
          animation: `dews-sweep-rotate ${dur}s linear infinite`,
        }}
      >
        <path d={WAKE_PATH} fill={`url(#${wakeGradId})`} />
        <line
          x1={CX} y1={CY} x2={CX + OUTER_R} y2={CY}
          stroke={hex} strokeOpacity={0.65} strokeWidth={1.5} strokeLinecap="round"
        />
      </g>

      {/* Coin dots — Task 5 */}
      {/* Center readout — Task 6 */}
      {/* Tooltip — Task 7 */}
    </svg>
  );
}
```

Update `DEWSSummary` to use `DEWSRadar` (swap out `DEWSRadarSkeleton`):

```tsx
<DEWSRadar
  elevated={elevated}
  highest={highest}
  totalCount={totalCount}
  onCoinClick={(id) => {/* navigation wired in Task 7 */}}
/>
```

**Step 2: Verify build**

```bash
npm run build 2>&1 | tail -20
```

Expected: exit 0

**Step 3: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): add rotating sweep line and wake arc animation"
```

---

## Task 5: Add coin dots with two-tier label hierarchy

**Files:**
- Modify: `src/components/dews-summary.tsx`

**Step 1: Add `DEWSDot` sub-component** (insert before `DEWSRadar`)

```tsx
function DEWSDot({
  coin,
  onHover,
  onClick,
}: {
  coin: ElevatedCoin;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}) {
  const hex = THREAT_BAND_HEX[coin.band];
  const isHighTier = coin.band === "WARNING" || coin.band === "DANGER";
  const dotR = isHighTier ? 9 : 6;
  const glowR = dotR + 7;
  const dur = pulseDuration(coin.band);

  return (
    <g
      transform={`translate(${coin.x.toFixed(1)}, ${coin.y.toFixed(1)})`}
      role="button"
      tabIndex={0}
      aria-label={`${coin.symbol}: DEWS score ${coin.score}, band ${coin.band}`}
      style={{ cursor: "pointer" }}
      onMouseEnter={() => onHover(coin.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(coin.id)}
      onBlur={() => onHover(null)}
      onClick={() => onClick(coin.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(coin.id); }}
    >
      {/* Animated glow ring */}
      <circle r={glowR} fill={hex}
        className="dews-glow-r"
        style={{ animation: `dews-glow ${dur}s ease-in-out infinite` }} />
      {/* Main dot */}
      <circle r={dotR} fill={hex} fillOpacity={0.92} />
      {/* Always-visible label: WARNING and DANGER only */}
      {isHighTier && (
        <text
          y={-(dotR + 7)}
          textAnchor="middle"
          dominantBaseline="auto"
          fill={hex}
          fontSize={10}
          fontWeight={700}
          fontFamily="var(--font-mono)"
        >
          {coin.symbol}
        </text>
      )}
    </g>
  );
}
```

**Step 2: Wire dots into `DEWSRadar`**

Inside `DEWSRadar`, replace the `{/* Coin dots — Task 5 */}` comment:

```tsx
{/* Coin dots — render below tooltip so tooltip is on top */}
{elevated.map((coin) => (
  <DEWSDot
    key={coin.id}
    coin={coin}
    onHover={setHoveredId}
    onClick={onCoinClick}
  />
))}
```

**Step 3: Verify build**

```bash
npm run build 2>&1 | tail -20
```

Expected: exit 0

**Step 4: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): add coin dots with two-tier label hierarchy"
```

---

## Task 6: Add center readout

**Files:**
- Modify: `src/components/dews-summary.tsx`

**Step 1: Add `DEWSCenter` sub-component** (insert before `DEWSRadar`)

```tsx
function DEWSCenter({
  highest,
  elevatedCount,
  totalCount,
  sweepDur,
}: {
  highest: ThreatBand;
  elevatedCount: number;
  totalCount: number;
  sweepDur: number;
}) {
  const hex = THREAT_BAND_HEX[highest];
  const label = highest === "CALM" ? "ALL CALM" : highest;
  const sublabel =
    highest === "CALM" ? `${totalCount} monitored` : `${elevatedCount} elevated`;

  return (
    <g>
      <circle
        cx={CX} cy={CY} r={38}
        fill={hex} fillOpacity={0.13}
        stroke={hex} strokeOpacity={0.38} strokeWidth={1.5}
        className="dews-center-r"
        style={{ animation: `dews-center-pulse ${sweepDur}s ease-in-out infinite` }}
      />
      <text
        x={CX} y={CY - 5}
        textAnchor="middle" dominantBaseline="middle"
        fill={hex} fontSize={11} fontWeight={700}
        fontFamily="var(--font-mono)" letterSpacing={1}
      >
        {label}
      </text>
      <text
        x={CX} y={CY + 11}
        textAnchor="middle" dominantBaseline="middle"
        fill="var(--color-muted-foreground)" fontSize={9}
        fontFamily="var(--font-mono)"
      >
        {sublabel}
      </text>
    </g>
  );
}
```

**Step 2: Wire center into `DEWSRadar`**

Replace the `{/* Center readout — Task 6 */}` comment (must come after dots so it renders on top):

```tsx
<DEWSCenter
  highest={highest}
  elevatedCount={elevated.length}
  totalCount={totalCount}
  sweepDur={dur}
/>
```

**Step 3: Verify build**

```bash
npm run build 2>&1 | tail -20
```

Expected: exit 0

**Step 4: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): add animated center readout"
```

---

## Task 7: Add hover tooltip and click navigation

**Files:**
- Modify: `src/components/dews-summary.tsx`

**Step 1: Add `DEWSTooltip` sub-component** (insert before `DEWSCenter`)

The tooltip is SVG-native (a `<g>` with rect + text). It clamps to SVG bounds to avoid overflow.

```tsx
function DEWSTooltip({ coin }: { coin: ElevatedCoin }) {
  const hex = THREAT_BAND_HEX[coin.band];
  const W = 124;
  const H = 46;
  // Clamp so tooltip stays within viewBox
  const tx = Math.min(Math.max(coin.x + 14, 4), 560 - W - 4);
  const ty = Math.min(Math.max(coin.y - H - 10, 4), 480 - H - 4);

  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={W} height={H} rx={6}
        fill="var(--color-popover)" stroke="var(--color-border)" strokeWidth={1} />
      <text x={tx + 10} y={ty + 16}
        fill="var(--color-foreground)" fontSize={11} fontWeight={600}
        fontFamily="var(--font-sans)">
        {coin.symbol}
      </text>
      <text x={tx + 10} y={ty + 32}
        fill={hex} fontSize={10} fontWeight={600}
        fontFamily="var(--font-mono)">
        {coin.band}
      </text>
      <text x={tx + W - 10} y={ty + 32}
        fill="var(--color-muted-foreground)" fontSize={10}
        fontFamily="var(--font-mono)" textAnchor="end">
        {coin.score}/100
      </text>
    </g>
  );
}
```

**Step 2: Wire tooltip into `DEWSRadar`**

Replace the `{/* Tooltip — Task 7 */}` comment (must be rendered after dots and before center so center stays on top):

```tsx
{hoveredId && (() => {
  const hovered = elevated.find((c) => c.id === hoveredId);
  return hovered ? <DEWSTooltip coin={hovered} /> : null;
})()}
```

**Step 3: Wire navigation in `DEWSSummary`**

`DEWSSummary` uses `useRouter`. Add the import and handler:

```tsx
// At the top of the file, useRouter is already imported from "next/navigation"
// In DEWSSummary:
const router = useRouter();
// ...
<DEWSRadar
  elevated={elevated}
  highest={highest}
  totalCount={totalCount}
  onCoinClick={(id) => router.push(`/stablecoin/${id}`)}
/>
```

**Step 4: Verify build**

```bash
npm run build 2>&1 | tail -20
```

Expected: exit 0

**Step 5: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): add hover tooltip and coin click navigation"
```

---

## Task 8: Complete `DEWSSummary` — legend, count header, all-calm state

**Files:**
- Modify: `src/components/dews-summary.tsx`

**Step 1: Add `DEWSLegend` sub-component** (insert before `DEWSSummary`)

```tsx
function DEWSLegend({ updatedAt }: { updatedAt: number }) {
  const minsAgo = Math.round((Date.now() - updatedAt) / 60_000);
  const ageLabel = minsAgo <= 1 ? "just now" : `${minsAgo}m ago`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 border-t">
      {RING_BANDS.map((band) => (
        <div key={band} className="flex items-center gap-1.5">
          <svg width={20} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={20} y2={2}
              stroke={THREAT_BAND_HEX[band]} strokeWidth={2} strokeDasharray="4 3" />
          </svg>
          <span className="text-xs text-muted-foreground capitalize">
            {band.charAt(0) + band.slice(1).toLowerCase()}
          </span>
        </div>
      ))}
      <span className="ml-auto text-xs text-muted-foreground/50 tabular-nums font-mono">
        Updated {ageLabel}
      </span>
    </div>
  );
}
```

**Step 2: Replace `DEWSSummary` with the complete final version**

```tsx
interface DEWSSummaryProps {
  logos?: Record<string, string>;
}

export function DEWSSummary({ logos }: DEWSSummaryProps) {
  const { data, isLoading } = useStressSignals();
  const router = useRouter();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[440px] rounded-lg bg-muted animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.signals || Object.keys(data.signals).length === 0) return null;

  const totalCount = Object.keys(data.signals).length;
  const elevated = computePositions(data.signals, logos);
  const highest = highestBand(elevated.map((c) => c.band));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {elevated.length > 0
              ? `${elevated.length} elevated · ${totalCount - elevated.length} calm`
              : `All ${totalCount} coins calm`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-0 pb-4">
        <DEWSRadar
          elevated={elevated}
          highest={highest}
          totalCount={totalCount}
          onCoinClick={(id) => router.push(`/stablecoin/${id}`)}
        />
        <DEWSLegend updatedAt={data.updatedAt * 1000} />
      </CardContent>
    </Card>
  );
}
```

**Step 3: Run full test suite**

```bash
npm test
```

Expected: all tests pass (including the new utility tests)

**Step 4: Run lint**

```bash
npm run lint
```

Expected: no errors

**Step 5: Run build**

```bash
npm run build 2>&1 | tail -20
```

Expected: exit 0, static export succeeds

**Step 6: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): complete radar redesign — legend, header, all states"
```

---

## Task 9: Final verification

**Step 1: Full clean build**

```bash
npm run build 2>&1 | grep -E "error|warning|✓|✗" | head -30
```

Expected: `✓ Compiled successfully` or equivalent, zero TypeScript errors

**Step 2: Worker type-check** (shared `src/lib/` files are imported by worker)

```bash
cd worker && npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (zero errors)

**Step 3: Confirm test count is unchanged or higher**

```bash
npm test -- --reporter=verbose 2>&1 | tail -10
```

Expected: all suites pass, `dews-radar-utils` suite shows 14+ passing tests

**Step 4: Final commit if any cleanup needed, then done**

```bash
git log --oneline -6
```

Expected output (roughly):
```
feat(dews): complete radar redesign — legend, header, all states
feat(dews): add hover tooltip and coin click navigation
feat(dews): add animated center readout
feat(dews): add coin dots with two-tier label hierarchy
feat(dews): add rotating sweep line and wake arc animation
feat(dews): radar skeleton — rings, spokes, static structure
feat: add DEWS radar utility functions with tests
```

---

## Reference: complete `dews-summary.tsx` import block

To avoid confusion, here are all imports needed at the top of the final file:

```tsx
"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { PSI_ELIGIBLE_META_BY_ID } from "@/lib/psi-eligible";
import { THREAT_BAND_HEX } from "@/lib/classification";
import type { ThreatBand } from "@/lib/classification";
import {
  scoreToRadius,
  deterministicOffset,
  distributeAngles,
  highestBand,
  sweepDuration,
  pulseDuration,
} from "@/lib/dews-radar-utils";
```
