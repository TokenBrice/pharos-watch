# DEWS Radar Inversion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Invert the DEWS radar so danger is at the center and CALM coins form an ambient non-interactive starfield at the periphery.

**Architecture:** Two-file change. `dews-radar-utils.ts` gets new radius constants and a new helper. `dews-summary.tsx` gets an ambient calm dot layer, reversed ring radii, a calm zone boundary ring, and a reversed legend. TDD: write failing tests first, then implement.

**Tech Stack:** TypeScript, React 19, SVG, Vitest.

**Design doc:** `docs/plans/2026-03-02-dews-radar-inversion-design.md`

---

### Task 1: Write failing tests for new radius constants and new helper

**Files:**
- Modify: `src/lib/__tests__/dews-radar-utils.test.ts`

The existing `scoreToRadius` tests use the old (outward = danger) constants. Update them to the inverted values and add a new describe block for `deterministicRadiusOffset`.

New radius constants (higher score → smaller radius):
| Band    | Score min | Score max | Inner r | Outer r |
|---------|-----------|-----------|---------|---------|
| WATCH   | 16        | 35        | 178     | 208     |
| ALERT   | 36        | 55        | 143     | 175     |
| WARNING | 56        | 75        | 95      | 140     |
| DANGER  | 76        | 100       | 45      | 90      |

**Step 1: Update `scoreToRadius` describe block**

Replace the entire `describe("scoreToRadius", ...)` block with:

```ts
describe("scoreToRadius", () => {
  it("returns innerR when score is at band minimum", () => {
    expect(scoreToRadius(16, "WATCH")).toBeCloseTo(178);
  });
  it("returns outerR when score is at band maximum", () => {
    expect(scoreToRadius(35, "WATCH")).toBeCloseTo(208);
  });
  it("returns midpoint for mid-band score", () => {
    expect(scoreToRadius(25, "WATCH")).toBeGreaterThan(178);
    expect(scoreToRadius(25, "WATCH")).toBeLessThan(208);
  });
  it("returns innerR for ALERT minimum", () => {
    expect(scoreToRadius(36, "ALERT")).toBeCloseTo(143);
  });
  it("returns outerR for ALERT maximum", () => {
    expect(scoreToRadius(55, "ALERT")).toBeCloseTo(175);
  });
  it("returns innerR for WARNING minimum", () => {
    expect(scoreToRadius(56, "WARNING")).toBeCloseTo(95);
  });
  it("returns outerR for WARNING maximum", () => {
    expect(scoreToRadius(75, "WARNING")).toBeCloseTo(140);
  });
  it("returns innerR for DANGER minimum", () => {
    expect(scoreToRadius(76, "DANGER")).toBeCloseTo(45);
  });
  it("returns outerR for DANGER maximum", () => {
    expect(scoreToRadius(100, "DANGER")).toBeCloseTo(90);
  });
});
```

**Step 2: Add `deterministicRadiusOffset` to the import line**

```ts
import {
  scoreToRadius,
  deterministicOffset,
  deterministicRadiusOffset,
  distributeAngles,
  highestBand,
  sweepDuration,
  pulseDuration,
} from "@/lib/dews-radar-utils";
```

**Step 3: Add new describe block after `deterministicOffset`**

```ts
describe("deterministicRadiusOffset", () => {
  it("returns the same value for the same id and zoneWidth", () => {
    expect(deterministicRadiusOffset("42", 26)).toBe(deterministicRadiusOffset("42", 26));
  });
  it("returns a value in [0, zoneWidth)", () => {
    const result = deterministicRadiusOffset("123", 26);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(26);
  });
  it("returns 0 for empty string", () => {
    expect(deterministicRadiusOffset("", 26)).toBe(0);
  });
  it("uses the same charCode sum as deterministicOffset", () => {
    // "1" has charSum=49; 49 % 26 = 23
    expect(deterministicRadiusOffset("1", 26)).toBe(23);
  });
  it("respects the zoneWidth parameter", () => {
    // "1" charSum=49; 49 % 10 = 9
    expect(deterministicRadiusOffset("1", 10)).toBe(9);
  });
});
```

**Step 4: Run tests — expect failures**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|×)"
```

Expected: `scoreToRadius` tests fail (wrong values), `deterministicRadiusOffset` tests fail (not exported yet).

**Step 5: Commit the failing tests**

```bash
git add src/lib/__tests__/dews-radar-utils.test.ts
git commit -m "test(dews): update scoreToRadius expectations and add deterministicRadiusOffset tests"
```

---

### Task 2: Implement utils changes to make tests pass

**Files:**
- Modify: `src/lib/dews-radar-utils.ts`

**Step 1: Update `BAND_RADIUS` and `RING_RADII` constants**

In `dews-radar-utils.ts`, replace the `BAND_RADIUS` constant:

```ts
// Before:
const BAND_RADIUS: Record<ElevatedBand, [number, number]> = {
  WATCH:   [75,  108],
  ALERT:   [118, 151],
  WARNING: [161, 194],
  DANGER:  [204, 240],
};

// After:
const BAND_RADIUS: Record<ElevatedBand, [number, number]> = {
  WATCH:   [178, 208],
  ALERT:   [143, 175],
  WARNING: [95,  140],
  DANGER:  [45,  90],
};
```

**Step 2: Export `deterministicRadiusOffset`**

Add this function after `deterministicOffset`:

```ts
/**
 * Deterministic radius offset within a zone, derived from a coin ID string.
 * Same id + zoneWidth always returns the same value. Range: [0, zoneWidth).
 * Uses same charCode sum as deterministicOffset for consistency.
 */
export function deterministicRadiusOffset(id: string, zoneWidth: number): number {
  if (id.length === 0) return 0;
  const sum = id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return sum % zoneWidth;
}
```

**Step 3: Run tests — expect all to pass**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|×)"
```

Expected: all tests pass.

**Step 4: Type-check**

```bash
npm run build 2>&1 | tail -20
```

Expected: no errors.

**Step 5: Commit**

```bash
git add src/lib/dews-radar-utils.ts
git commit -m "feat(dews): invert scoreToRadius constants and add deterministicRadiusOffset"
```

---

### Task 3: Update `dews-summary.tsx` — calm layer, rings, legend

**Files:**
- Modify: `src/components/dews-summary.tsx`

This task has no unit tests (SVG rendering). Verify with `npm run build` and visual inspection.

**Step 1: Update imports**

Add `deterministicRadiusOffset` to the import from `dews-radar-utils`:

```ts
import {
  scoreToRadius,
  deterministicOffset,
  deterministicRadiusOffset,
  distributeAngles,
  highestBand,
  sweepDuration,
  pulseDuration,
} from "@/lib/dews-radar-utils";
```

**Step 2: Update `RING_RADII` constant**

```ts
// Before:
const RING_RADII: Record<ElevatedBand, number> = {
  WATCH: 75, ALERT: 118, WARNING: 161, DANGER: 204,
};

// After:
const RING_RADII: Record<ElevatedBand, number> = {
  DANGER: 45, WARNING: 95, ALERT: 143, WATCH: 178,
};
```

**Step 3: Add calm zone constants and `CalmDot` type**

Add these after the `RING_RADII` constant:

```ts
const CALM_INNER_R = 212;
const CALM_ZONE_WIDTH = 26; // outer edge 238 − inner edge 212

interface CalmDot {
  x: number;
  y: number;
}
```

**Step 4: Add `computeCalmDots` function**

Add after the existing `computePositions` function:

```ts
function computeCalmDots(
  signals: Record<string, { score: number; band: string }>,
): CalmDot[] {
  const calmIds = Object.keys(signals).filter((id) => signals[id].band === "CALM");
  const angles = distributeAngles(calmIds.length);
  return calmIds.map((id, i) => {
    const r = CALM_INNER_R + deterministicRadiusOffset(id, CALM_ZONE_WIDTH);
    const angle = angles[i] + deterministicOffset(id);
    return {
      x: CX + r * Math.cos(angle),
      y: CY + r * Math.sin(angle),
    };
  });
}
```

**Step 5: Add `DEWSCalmDot` micro-component**

Add before `DEWSDot`:

```tsx
function DEWSCalmDot({ x, y }: CalmDot) {
  return (
    <circle
      cx={x.toFixed(1)}
      cy={y.toFixed(1)}
      r={2}
      fill="var(--color-muted-foreground)"
      fillOpacity={0.12}
    />
  );
}
```

**Step 6: Update `DEWSRadar` to accept and render calm dots**

Add `calmDots: CalmDot[]` to the `DEWSRadar` props interface:

```tsx
function DEWSRadar({
  elevated,
  calmDots,
  highest,
  totalCount,
  onCoinClick,
}: {
  elevated: ElevatedCoin[];
  calmDots: CalmDot[];
  highest: ThreatBand;
  totalCount: number;
  onCoinClick: (id: string) => void;
})
```

Inside `DEWSRadar`, update the band ring boundary section. Replace:

```tsx
{/* Band ring boundaries */}
{RING_BANDS.map((band) => (
  <circle key={band} cx={CX} cy={CY} r={RING_RADII[band]}
    fill="none" stroke={THREAT_BAND_HEX[band]}
    strokeOpacity={0.25} strokeWidth={1} strokeDasharray="4 6" />
))}
<circle cx={CX} cy={CY} r={OUTER_R}
  fill="none" stroke={hex} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 6" />
```

With:

```tsx
{/* Band ring boundaries */}
{RING_BANDS.map((band) => (
  <circle key={band} cx={CX} cy={CY} r={RING_RADII[band]}
    fill="none" stroke={THREAT_BAND_HEX[band]}
    strokeOpacity={0.25} strokeWidth={1} strokeDasharray="4 6" />
))}
{/* Calm zone inner boundary — faint gray, not a threat color */}
<circle cx={CX} cy={CY} r={CALM_INNER_R}
  fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={1} strokeDasharray="4 6" />
<circle cx={CX} cy={CY} r={OUTER_R}
  fill="none" stroke={hex} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 6" />
```

Then add the calm dot layer just before the elevated coin dots (so elevated coins render on top):

```tsx
{/* Calm ambient starfield — non-interactive, beneath elevated coins */}
{calmDots.map((dot, i) => (
  <DEWSCalmDot key={i} x={dot.x} y={dot.y} />
))}

{/* Coin dots */}
{elevated.map((coin) => (
  ...
```

**Step 7: Update `DEWSLegend` band order**

Reverse `RING_BANDS` in the legend render only (not the constant itself — `RING_BANDS` is used elsewhere in the component):

```tsx
// Before:
{RING_BANDS.map((band) => (

// After:
{[...RING_BANDS].reverse().map((band) => (
```

This renders `DANGER → WARNING → ALERT → WATCH` left-to-right, matching center-out spatial order.

**Step 8: Wire up `computeCalmDots` in `DEWSSummary`**

In the `DEWSSummary` component body, add the calm dots computation and pass it to `DEWSRadar`:

```tsx
// Before:
const elevated = computePositions(data.signals, logos);
const highest = highestBand(elevated.map((c) => c.band));

// After:
const elevated = computePositions(data.signals, logos);
const calmDots = computeCalmDots(data.signals);
const highest = highestBand(elevated.map((c) => c.band));
```

And update the `DEWSRadar` JSX:

```tsx
<DEWSRadar
  elevated={elevated}
  calmDots={calmDots}
  highest={highest}
  totalCount={totalCount}
  onCoinClick={(id) => router.push(`/stablecoin/${id}`)}
/>
```

**Step 9: Build and type-check**

```bash
npm run build 2>&1 | tail -30
```

Expected: no TypeScript errors, clean build.

**Step 10: Run full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests pass.

**Step 11: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): invert radar — danger at center, calm ambient starfield at periphery"
```

---

### Task 4: Verify visually in dev server

**Step 1: Start dev server**

```bash
npm run dev
```

**Step 2: Navigate to homepage**

Open `http://localhost:3000` and find the DEWS widget.

**Step 3: Verify checklist**

- [ ] Elevated coins appear in inner rings (DANGER closest to center, WATCH outermost)
- [ ] CALM coins are visible as tiny faint gray dots near the outer edge
- [ ] Four dashed band rings are visible at the correct radii
- [ ] A faint gray ring delimits the calm zone inner edge (r=212)
- [ ] Legend reads DANGER → WARNING → ALERT → WATCH left-to-right
- [ ] Hovering an elevated coin shows tooltip correctly
- [ ] Clicking an elevated coin navigates to stablecoin detail page
- [ ] Calm dots are non-interactive (no cursor change, no tooltip)

**Step 4: No further commits needed** — visual verification only.
