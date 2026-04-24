# Exit Route Map — Canal & Locks Metaphor Implementation Plan (Revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "transit concourse" SVG scene inside the Exit Route Map card with a side-elevation canal scene (mitre-pair lock gates, tapering water body that encodes crowding, trapezoidal delta basins stepping down from the dam, varied sea ripples, a silhouette-only distant lighthouse, a vessel whose drift speed is bound to the crowding index) while preserving every data input, metric, and sidebar control.

**Architecture:** Single-file visual rework of the `ExitRouteTerminal` subcomponent in `src/components/liquidity-stats.tsx`. The data model (`buildLiquidityExitRouteModel` and `LiquidityExitRouteModel`) is unchanged. The component is renamed `ExitRouteCanalScene`. A colocated CSS module (`src/components/exit-route-canal.css`) holds gradient defs, colour tokens, CSS custom properties for the data-driven vessel duration, responsive breakpoints, and three opt-in animations behind `prefers-reduced-motion: no-preference`, all modelled after the sibling `src/app/chains/nautical-chart.css`.

**Tech Stack:** React 19 client component, inline SVG, Tailwind utility classes, vanilla CSS module imported from the component. No new dependencies. Vitest + Testing Library for tests.

**Reference:** Design spec at `docs/superpowers/specs/2026-04-24-exit-route-map-canal-metaphor-design.md`.

**Revision changelog (vs previous plan):**
- Caption copy reverts to "Leading door / Leading lane" (kept verbatim) to resolve the three-way vocabulary conflict with the sidebar `Open routes` metric.
- Lock gates become mitre-pair leaves (two angled trapezoids meeting in the middle) instead of bar-in-pond rectangles.
- Chain basins become trapezoidal pools stepping down from the dam face with a subtle water-surface highlight, replacing rounded-cap rectangles.
- Sea ripples become 5 horizontal lines with varied `strokeDasharray` and opacity taper (0.22 → 0.09), replacing 3 identical sine curves.
- TVL numeric is the primary focal point: 48px / 800 / letter-spacing -1.5, placed above the vessel, not below it.
- Lighthouse drops the `PHAROS` text label; beam uses a gradient cone with `transform-box: view-box`.
- Upstream kicker "UPSTREAM · HOLDERS" replaced by four small tide-gauge ticks on the upstream wall.
- Stars reduced from 7 to 3 hand-placed.
- Canal water body tapers toward the dam proportional to the crowding band (makes the `data-crowding-band` attribute visible, not just semantic).
- Vessel drift duration is driven by `concentrationHhi` via a CSS custom property (slower when crowded).
- Responsive CSS caps the gate roster at top-4 + "Other" below 640px and drops the percentage row at the gate labels.
- Animation fixes: vessel easing linear→ease-in-out with a 1px vertical bob; beam gets `transform-box: view-box`; sea shimmer is opacity-only with co-prime periods per ripple line.

---

## File Structure

- **Create:** `src/components/exit-route-canal.css` — gradient defs, colour tokens, CSS custom property `--vessel-duration` (overridable), five keyframes, responsive breakpoints.
- **Modify:** `src/components/liquidity-stats.tsx` — delete `ExitRouteTerminal` (lines 269–481) and the three orphan helpers `routeStrokeWidth`, `crowdingWaist`, `routeY` (lines 246–260); keep `crowdingBand` (lines 262–267); add a new `ExitRouteCanalScene` component that the `LiquidityExitRouteMap` parent renders. Import the new CSS. The caption row (lines 510–517) is unchanged.
- **Modify:** `src/components/__tests__/liquidity-stats.test.ts:214-222` — update testid assertions to the new scene IDs; caption-copy assertions stay as-is (no `Leading gate` / `Leading basin` — those are explicitly abandoned).

---

## Task 1: Update tests to expect the new canal scene testids

**Files:**
- Modify: `src/components/__tests__/liquidity-stats.test.ts:214-222`

- [ ] **Step 1: Rewrite the render assertions**

Open `src/components/__tests__/liquidity-stats.test.ts`, locate lines 214–222 (inside `it("renders the exit route map with disclosed tail routes", …)`), and replace them with:

```ts
    expect(screen.getByText("Exit Route Map")).toBeTruthy();
    expect(screen.getByTestId("exit-route-canal")).toBeTruthy();
    expect(screen.getByTestId("protocol-gate-curve")).toBeTruthy();
    expect(screen.getByTestId("protocol-gate-_other-routes")).toBeTruthy();
    expect(screen.getByTestId("chain-basin-ethereum")).toBeTruthy();
    expect(screen.getByTestId("exit-canal").getAttribute("data-crowding-band")).toBe("visible");
    expect(screen.getByText("Leading door:")).toBeTruthy();
    expect(screen.getByText("Leading lane:")).toBeTruthy();
    expect(container.querySelector('image[href="/dexes/curve.png"]')).toBeTruthy();
    expect(container.querySelector('image[href="/chains/ethereum.png"]')).toBeTruthy();
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- liquidity-stats.test.ts`
Expected: FAIL. Three testid matchers are renamed by this task and will miss on the current DOM:

- `exit-route-canal` (old name: `exit-route-terminal`)
- `chain-basin-ethereum` (old name: `chain-lane-ethereum`)
- `exit-canal` (old name: `exit-concourse`)

The other assertions (`protocol-gate-curve`, `protocol-gate-_other-routes`, the two `image[href]` selectors, and `Leading door:` / `Leading lane:`) are unchanged from the current code and will pass immediately.

- [ ] **Step 3: Commit**

```bash
git add src/components/__tests__/liquidity-stats.test.ts
git commit -m "test(liquidity): expect canal scene testids"
```

---

## Task 2: Create the canal CSS module

**Files:**
- Create: `src/components/exit-route-canal.css`

- [ ] **Step 1: Write the stylesheet**

Create `src/components/exit-route-canal.css` with:

```css
/*
 * Exit Route Canal — scene-level styles.
 * Colour tokens, data-driven CSS custom properties, and ambient motion
 * for the side-elevation canal SVG. Motion is opt-in via prefers-reduced-motion.
 * Patterns match src/app/chains/nautical-chart.css.
 */

.exit-route-canal {
  --canal-sky-top: oklch(0.18 0.024 248);
  --canal-sky-bottom: oklch(0.08 0.014 248);
  --canal-water-shallow: oklch(0.32 0.068 232 / 0.9);
  --canal-water-deep: oklch(0.24 0.05 220 / 0.95);
  --canal-wall: oklch(0.22 0.018 248);
  --canal-wall-stone: oklch(0.31 0.015 248);
  --canal-dam: oklch(0.36 0.024 248);
  --canal-sea-top: oklch(0.15 0.018 248);
  --canal-sea-bottom: oklch(0.09 0.012 248);
  --canal-caption: oklch(0.56 0.014 248);
  --canal-caption-dim: oklch(0.44 0.012 248);
  --canal-hero: oklch(0.96 0.006 248);
  --canal-hero-kicker: oklch(0.72 0.02 248);
  --canal-accent: oklch(0.78 0.14 178);
  --canal-beacon: oklch(0.86 0.18 82);
  --canal-beacon-beam: oklch(0.86 0.18 82 / 0.35);
  --canal-ripple: oklch(0.78 0.14 178);
  --canal-star: oklch(0.88 0.01 248 / 0.55);

  /* Data-driven vessel drift duration. Default 14s; overridden inline per crowding band. */
  --vessel-duration: 14s;
}

.exit-route-canal__scene {
  display: block;
  width: 100%;
  min-width: 560px;
  height: auto;
}

@media (min-width: 768px) {
  .exit-route-canal__scene {
    min-width: 0;
  }
}

/* Narrow-viewport compactions:
 *  - Hide ornamental lighthouse (it crowds basin labels).
 *  - Hide the gate percentage row (the $ row stays).
 *  - Hide the tail gate ("other routes") and let the scene aggregate to the top-4 below 640px.
 *  The component applies the compact-* classes conditionally.
 */
@media (max-width: 640px) {
  .exit-route-canal__lighthouse,
  .exit-route-canal__gate-pct {
    display: none;
  }
}

/* --- Ambient motion (opt-in) ---
 * All three animations are GPU-friendly (transform + opacity only).
 * Static frame must be fully legible without them.
 */
@media (prefers-reduced-motion: no-preference) {
  .exit-route-canal__vessel {
    animation: exit-route-canal-drift var(--vessel-duration) ease-in-out infinite;
    will-change: transform;
  }
  .exit-route-canal__beam {
    /* view-box box model lets the transform-origin resolve in viewBox user units,
     * so rotation pivots around the lamp head, not the path's bounding box. */
    transform-box: view-box;
    transform-origin: 790px 101px;
    animation: exit-route-canal-sweep 16s ease-in-out infinite alternate;
    will-change: transform, opacity;
  }
  /* Decoupled ripple phases — co-prime periods keep the three lines from re-syncing. */
  .exit-route-canal__wave > path:nth-child(1) {
    animation: exit-route-canal-shimmer 5.3s ease-in-out infinite;
    will-change: opacity;
  }
  .exit-route-canal__wave > path:nth-child(2) {
    animation: exit-route-canal-shimmer 6.7s ease-in-out infinite;
    animation-delay: -1.2s;
    will-change: opacity;
  }
  .exit-route-canal__wave > path:nth-child(3) {
    animation: exit-route-canal-shimmer 8.1s ease-in-out infinite;
    animation-delay: -2.4s;
    will-change: opacity;
  }
  .exit-route-canal__wave > path:nth-child(4) {
    animation: exit-route-canal-shimmer 7.4s ease-in-out infinite;
    animation-delay: -3.1s;
    will-change: opacity;
  }
  .exit-route-canal__wave > path:nth-child(5) {
    animation: exit-route-canal-shimmer 9.2s ease-in-out infinite;
    animation-delay: -4.5s;
    will-change: opacity;
  }
}

@keyframes exit-route-canal-drift {
  0%, 100% { transform: translate3d(-6px, 0, 0); }
  50%      { transform: translate3d(6px, 1px, 0); }
}

@keyframes exit-route-canal-sweep {
  0%   { transform: rotate(-7deg); opacity: 0.55; }
  100% { transform: rotate(7deg);  opacity: 0.75; }
}

@keyframes exit-route-canal-shimmer {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}
```

- [ ] **Step 2: Confirm the file exists**

Run: `test -f src/components/exit-route-canal.css && echo "ok"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/components/exit-route-canal.css
git commit -m "feat(liquidity): add exit-route-canal stylesheet with data-driven motion"
```

---

## Task 3: Replace `ExitRouteTerminal` with `ExitRouteCanalScene` skeleton

This task installs the scaffolding: three bands (sky/canal/sea), a crowding-driven canal taper, the focal TVL numeric, the `exit-route-canal` / `exit-canal` testids, and the data-driven `--vessel-duration` CSS var. Gates and basins are filled in Tasks 4 and 5; scene cues in Task 6.

**Files:**
- Modify: `src/components/liquidity-stats.tsx`

- [ ] **Step 1: Add the CSS import**

In `src/components/liquidity-stats.tsx`, add immediately after line 28 (the last import):

```ts
import "./exit-route-canal.css";
```

- [ ] **Step 2: Delete the orphan helpers**

Delete lines 246–260 (the three functions `routeStrokeWidth`, `crowdingWaist`, `routeY`). Keep `crowdingBand` at lines 262–267 — the new scene reuses it.

- [ ] **Step 3: Delete the old component**

Delete lines 269–481 (the entire `ExitRouteTerminal` function).

- [ ] **Step 4: Add shared geometry constants above the new component**

Immediately after `crowdingBand` (what was line 267), insert these constants. They are referenced by Tasks 3, 4, 5, and 6, so define them once:

```ts
// Canal scene geometry — viewBox is 1000 × 480.
// Gates occupy the left half of the canal so the right half reads as the open-water
// focal area carrying the aggregate-TVL numeric and the drifting vessel.
const SCENE_WIDTH = 1000;
const SCENE_HEIGHT = 480;
const CANAL_TOP = 140;
const CANAL_BOTTOM = 380;
const CANAL_LEFT_EDGE = 30;
const GATE_AREA_LEFT = 80;
const GATE_AREA_RIGHT = 500;
const GATE_AREA_WIDTH = GATE_AREA_RIGHT - GATE_AREA_LEFT; // 420
const OPEN_WATER_LEFT = GATE_AREA_RIGHT + 20;
const DAM_X = 748;
const DAM_WIDTH = 6;
const BASIN_LEFT = DAM_X + DAM_WIDTH;
const BASIN_RIGHT = 968;
const BASIN_AREA_TOP = 150;
const BASIN_AREA_BOTTOM = 372;
const BASIN_GAP = 4;

// Vessel drift duration per crowding band — higher HHI (crowded) = slower vessel.
// Applied via a CSS custom property so motion stays in the stylesheet.
const VESSEL_DURATION_BY_BAND: Record<ReturnType<typeof crowdingBand>, string> = {
  broad: "11s",
  visible: "14s",
  crowded: "22s",
  unknown: "14s",
};

// Canal taper on the open-water side — depth of the inward pinch toward the dam.
// Higher HHI = more squeeze. Makes data-crowding-band visually legible instead of
// being only a semantic attribute.
const CANAL_TAPER_BY_BAND: Record<ReturnType<typeof crowdingBand>, number> = {
  broad: 12,
  visible: 32,
  crowded: 64,
  unknown: 20,
};
```

- [ ] **Step 5: Insert the `ExitRouteCanalScene` skeleton**

Immediately after the constants block, insert:

```tsx
function ExitRouteCanalScene({ model }: { model: LiquidityExitRouteModel }) {
  const band = crowdingBand(model.concentrationHhi);
  const taper = CANAL_TAPER_BY_BAND[band];
  const vesselDuration = VESSEL_DURATION_BY_BAND[band];

  const routeSummary = [
    `${formatCurrency(model.totalTvlUsd, 0)} DEX TVL`,
    model.topProtocol ? `${model.topProtocol.label} leading protocol` : null,
    model.topChain ? `${model.topChain.label} leading chain` : null,
    model.concentrationHhi == null ? null : `${model.concentrationHhi.toFixed(2)} crowding index`,
  ].filter(Boolean).join(", ");

  // Canal water body: rectangle across the gate area, tapered toward the dam on the open-water side.
  const canalPath = [
    `M ${CANAL_LEFT_EDGE} ${CANAL_TOP}`,
    `L ${OPEN_WATER_LEFT} ${CANAL_TOP}`,
    `L ${DAM_X} ${CANAL_TOP + taper}`,
    `L ${DAM_X} ${CANAL_BOTTOM - taper}`,
    `L ${OPEN_WATER_LEFT} ${CANAL_BOTTOM}`,
    `L ${CANAL_LEFT_EDGE} ${CANAL_BOTTOM}`,
    "Z",
  ].join(" ");

  return (
    <div
      className="exit-route-canal overflow-hidden rounded-xl border border-border/70"
      style={{ "--vessel-duration": vesselDuration } as React.CSSProperties}
    >
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          role="img"
          aria-label={`Exit route canal: ${routeSummary}. Secondary-market DEX exits only.`}
          className="exit-route-canal__scene"
          data-testid="exit-route-canal"
        >
          <defs>
            <linearGradient id="exit-route-canal-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--canal-sky-top)" />
              <stop offset="70%" stopColor="var(--canal-sky-bottom)" />
              <stop offset="100%" stopColor="var(--canal-sea-bottom)" />
            </linearGradient>
            <linearGradient id="exit-route-canal-water" x1="0" x2="1">
              <stop offset="0%" stopColor="var(--canal-water-shallow)" />
              <stop offset="100%" stopColor="var(--canal-water-deep)" />
            </linearGradient>
            <linearGradient id="exit-route-canal-sea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--canal-sea-top)" />
              <stop offset="100%" stopColor="var(--canal-sea-bottom)" />
            </linearGradient>
            <linearGradient id="exit-route-canal-beam" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--canal-beacon-beam)" />
              <stop offset="100%" stopColor="var(--canal-beacon-beam)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sky band */}
          <rect x="0" y="0" width={SCENE_WIDTH} height="140" fill="url(#exit-route-canal-sky)" />

          {/* Canal water body (tapers toward dam per crowding band) */}
          <path d={canalPath} fill="url(#exit-route-canal-water)" />

          {/* Waterline highlight — a single thin stroke at the top of the canal. */}
          <path
            d={`M ${CANAL_LEFT_EDGE} ${CANAL_TOP} L ${OPEN_WATER_LEFT} ${CANAL_TOP} L ${DAM_X} ${CANAL_TOP + taper}`}
            fill="none"
            stroke="var(--canal-accent)"
            strokeWidth="0.6"
            opacity="0.35"
          />

          {/* Sea band (behind ripples, added in Task 6) */}
          <rect x="0" y="380" width={SCENE_WIDTH} height="100" fill="url(#exit-route-canal-sea)" />

          {/* Canal group — carries the data-crowding-band attribute and the focal TVL numeric. */}
          <g
            data-testid="exit-canal"
            data-crowding-band={band}
            aria-label={`Aggregate exit canal; crowding ${band}`}
          >
            {/* Focal TVL numeric — centred in the open-water area, above the vessel. */}
            <text
              x="625"
              y="232"
              textAnchor="middle"
              fill="var(--canal-hero)"
              fontSize="48"
              fontWeight="800"
              letterSpacing="-1.5"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              {formatCurrency(model.totalTvlUsd, 0)}
            </text>
            <text
              x="625"
              y="252"
              textAnchor="middle"
              fill="var(--canal-hero-kicker)"
              fontSize="10"
              fontWeight="700"
              letterSpacing="1.8"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              SECONDARY EXIT TVL · DEX DEPTH
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Replace the single call site**

In `LiquidityExitRouteMap` (the call site that still references `<ExitRouteTerminal model={model} />`), change it to:

```tsx
<ExitRouteCanalScene model={model} />
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- liquidity-stats.test.ts`
Expected: FAIL — `exit-route-canal` and `exit-canal` testids now pass; `protocol-gate-curve`, `protocol-gate-_other-routes`, `chain-basin-ethereum` still fail (not drawn yet); `image[href="/dexes/curve.png"]` and `image[href="/chains/ethereum.png"]` still fail (gate and basin logos come in the next tasks); `Leading door:` / `Leading lane:` still pass (caption row unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "refactor(liquidity): replace concourse scene with canal skeleton"
```

---

## Task 4: Render mitre-pair lock gates (protocols)

Each protocol route becomes a **pair of mitre leaves** (two angled trapezoids) hinged to the piers of its chamber. The open gap between the leaves at the canal centreline encodes `sharePct`. Leaves lean inward so the composition reads as "gates" rather than "bars in a pond".

**Files:**
- Modify: `src/components/liquidity-stats.tsx` (inside `ExitRouteCanalScene`)

- [ ] **Step 1: Add gate geometry helpers**

Immediately above the `ExitRouteCanalScene` function (between the constants block and the component), insert:

```ts
const GATE_MIN_OPEN = 14;
const GATE_MAX_OPEN = 58;
const GATE_LEAN = 6;   // inward tilt at the top of each leaf (px)
const GATE_CHIP_R = 12;

function gateOpenWidth(sharePct: number): number {
  // Map 0–45% share → 14–58 px opening, clamped for legibility.
  const clamped = Math.max(0, Math.min(45, sharePct));
  const t = clamped / 45;
  return Math.round(GATE_MIN_OPEN + t * (GATE_MAX_OPEN - GATE_MIN_OPEN));
}

function gateXPositions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [GATE_AREA_LEFT + GATE_AREA_WIDTH / 2];
  const step = GATE_AREA_WIDTH / count;
  return Array.from({ length: count }, (_, i) => GATE_AREA_LEFT + step * (i + 0.5));
}
```

- [ ] **Step 2: Insert the upstream wall, tide-gauge ticks, and gate render block**

Inside `ExitRouteCanalScene`, immediately after the waterline-highlight `<path>` and before the sea-band `<rect>`, insert:

```tsx
          {/* Upstream wall — a stone column at the canal's left edge, with 4 tide-gauge ticks
              replacing the old "UPSTREAM · HOLDERS" label. Ticks are cheap; label was redundant
              (the wall + gates already imply upstream). */}
          <rect x={CANAL_LEFT_EDGE} y={CANAL_TOP} width="5" height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-wall-stone)" />
          <g stroke="var(--canal-caption-dim)" strokeWidth="0.8" opacity="0.7">
            <line x1={CANAL_LEFT_EDGE + 5} y1="180" x2={CANAL_LEFT_EDGE + 11} y2="180" />
            <line x1={CANAL_LEFT_EDGE + 5} y1="220" x2={CANAL_LEFT_EDGE + 11} y2="220" />
            <line x1={CANAL_LEFT_EDGE + 5} y1="260" x2={CANAL_LEFT_EDGE + 11} y2="260" />
            <line x1={CANAL_LEFT_EDGE + 5} y1="300" x2={CANAL_LEFT_EDGE + 11} y2="300" />
          </g>

          {/* Mitre-pair lock gates (protocols) */}
          {(() => {
            const xs = gateXPositions(model.protocolRoutes.length);
            return model.protocolRoutes.map((route, i) => {
              const open = gateOpenWidth(route.sharePct);
              const cx = xs[i];
              const leftPierX = cx - open / 2 - 10;
              const rightPierX = cx + open / 2 + 6;
              const canalDepth = CANAL_BOTTOM - CANAL_TOP;
              const chipCy = CANAL_TOP + canalDepth / 2;

              // Left mitre leaf: trapezoid from left pier, leaning inward at the top,
              // with the inner edge stopping just shy of the gate centreline.
              const leftLeaf = [
                `M ${leftPierX + 6} ${CANAL_TOP}`,
                `L ${cx - open / 2} ${CANAL_TOP + GATE_LEAN}`,
                `L ${cx - open / 2} ${CANAL_BOTTOM - GATE_LEAN}`,
                `L ${leftPierX + 6} ${CANAL_BOTTOM}`,
                "Z",
              ].join(" ");
              // Right mitre leaf: mirror.
              const rightLeaf = [
                `M ${rightPierX - 2} ${CANAL_TOP}`,
                `L ${cx + open / 2} ${CANAL_TOP + GATE_LEAN}`,
                `L ${cx + open / 2} ${CANAL_BOTTOM - GATE_LEAN}`,
                `L ${rightPierX - 2} ${CANAL_BOTTOM}`,
                "Z",
              ].join(" ");

              return (
                <g
                  key={`protocol-${route.key}`}
                  data-testid={`protocol-gate-${route.key}`}
                  aria-label={`${route.label} lock gate, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                >
                  <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} lock gate (${formatPercent(route.sharePct, 1)})`}</title>
                  {/* Left pier (stone) */}
                  <rect x={leftPierX} y={CANAL_TOP} width="4" height={canalDepth} fill="var(--canal-wall-stone)" />
                  {/* Left mitre leaf */}
                  <path d={leftLeaf} fill={route.colorHex} fillOpacity="0.72" stroke="var(--canal-wall)" strokeWidth="0.6" />
                  {/* Right mitre leaf */}
                  <path d={rightLeaf} fill={route.colorHex} fillOpacity="0.72" stroke="var(--canal-wall)" strokeWidth="0.6" />
                  {/* Right pier (stone) */}
                  <rect x={rightPierX} y={CANAL_TOP} width="4" height={canalDepth} fill="var(--canal-wall-stone)" />
                  {/* Gate mechanism bar at the crown (above the water) — single thin rail, no cyan accent stripe */}
                  <rect x={leftPierX - 1} y={CANAL_TOP - 6} width={rightPierX - leftPierX + 6} height="4" fill="var(--canal-wall)" />
                  {/* Protocol chip at canal mid-depth, over the mitre joint */}
                  <circle cx={cx} cy={chipCy} r={GATE_CHIP_R} fill="oklch(0.06 0.012 248 / 0.92)" stroke={route.colorHex} strokeWidth="1.2" />
                  {route.logoPath ? (
                    <image href={route.logoPath} x={cx - 9} y={chipCy - 9} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                  ) : (
                    <text x={cx} y={chipCy + 4} textAnchor="middle" fill="oklch(0.92 0.01 248)" fontSize="13" fontWeight="800">+</text>
                  )}
                  {/* $ label below the canal (always visible) */}
                  <text x={cx} y={CANAL_BOTTOM + 16} textAnchor="middle" fill="var(--canal-hero)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
                    {formatCurrency(route.valueUsd, 0)}
                  </text>
                  {/* % label (hidden on narrow viewports via .exit-route-canal__gate-pct CSS rule) */}
                  <text
                    x={cx}
                    y={CANAL_BOTTOM + 30}
                    textAnchor="middle"
                    fill="var(--canal-caption)"
                    fontSize="9"
                    fontFamily="ui-monospace, Menlo, monospace"
                    className="exit-route-canal__gate-pct"
                  >
                    {formatPercent(route.sharePct, 1)}
                  </text>
                </g>
              );
            });
          })()}
```

- [ ] **Step 3: Run tests — gate testids should pass**

Run: `npm test -- liquidity-stats.test.ts`
Expected: `protocol-gate-curve`, `protocol-gate-_other-routes`, and `image[href="/dexes/curve.png"]` assertions now pass; `chain-basin-ethereum` and `image[href="/chains/ethereum.png"]` still fail.

- [ ] **Step 4: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "feat(liquidity): render mitre-pair lock gates for protocols"
```

---

## Task 5: Render trapezoidal delta basins (chains)

Each chain basin becomes a **trapezoidal pool** that shares its left edge with the dam's downstream face and splays outward toward the right. A thin 0.5px water-surface stroke inside each basin sells the "pool" read.

**Files:**
- Modify: `src/components/liquidity-stats.tsx` (inside `ExitRouteCanalScene`)

- [ ] **Step 1: Add basin height helper**

Immediately after the gate helpers (Task 4 Step 1), insert:

```ts
function basinHeights(routes: LiquidityExitRouteItem[]): number[] {
  // Allocate BASIN_AREA_TOP..BASIN_AREA_BOTTOM proportionally to sharePct, with a
  // minimum row height for legibility. Invariant: minH * maxRoutes <= usable.
  // With MAX_EXIT_ROUTE_ITEMS = 5 + 1 "Other" = 6 rows and usable ≈ 200 px, minH=18
  // gives 108 px floor — well under the 200 px ceiling, so overflow is unreachable.
  if (routes.length === 0) return [];
  const usable = BASIN_AREA_BOTTOM - BASIN_AREA_TOP - BASIN_GAP * (routes.length - 1);
  const totalShare = routes.reduce((sum, r) => sum + Math.max(0, r.sharePct), 0);
  if (totalShare <= 0) return routes.map(() => 0);
  const raw = routes.map((r) => (Math.max(0, r.sharePct) / totalShare) * usable);
  const minH = 18;
  const floored = raw.map((h) => Math.max(minH, h));
  const sumFloored = floored.reduce((sum, h) => sum + h, 0);
  if (sumFloored <= usable) return floored.map((h) => Math.round(h));
  // Rescale heights above minH to absorb the overflow.
  const scale = usable / sumFloored;
  return floored.map((h) => Math.round(h * scale));
}
```

- [ ] **Step 2: Insert dam wall and basin render block**

Inside `ExitRouteCanalScene`, immediately after the gate IIFE (Task 4 Step 2) and before the `<g data-testid="exit-canal" …>` group, insert:

```tsx
          {/* Dam wall with a mid-tone cornice strip — more than a 1-px line, reads as masonry depth. */}
          <rect x={DAM_X - 2} y={CANAL_TOP - 4} width={DAM_WIDTH + 4} height="4" fill="var(--canal-wall-stone)" />
          <rect x={DAM_X} y={CANAL_TOP} width={DAM_WIDTH} height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-dam)" />

          {/* Chain basins (delta) — trapezoidal pools splaying right from the dam face. */}
          {(() => {
            const heights = basinHeights(model.chainRoutes);
            let cursor = BASIN_AREA_TOP;
            return model.chainRoutes.map((route, i) => {
              const top = cursor;
              const h = heights[i];
              cursor = top + h + BASIN_GAP;
              const midY = top + h / 2;
              // Trapezoid: top edge slopes down-right by 4 px, bottom edge slopes up-right by 4 px.
              const basinPath = [
                `M ${BASIN_LEFT} ${top}`,
                `L ${BASIN_RIGHT} ${top + 4}`,
                `L ${BASIN_RIGHT} ${top + h - 4}`,
                `L ${BASIN_LEFT} ${top + h}`,
                "Z",
              ].join(" ");
              return (
                <g
                  key={`chain-${route.key}`}
                  data-testid={`chain-basin-${route.key}`}
                  aria-label={`${route.label} chain basin, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                >
                  <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} chain basin (${formatPercent(route.sharePct, 1)})`}</title>
                  <path d={basinPath} fill={route.colorHex} fillOpacity="0.62" />
                  {/* Water-surface highlight — a single faint stroke across the basin top */}
                  <line x1={BASIN_LEFT + 4} y1={top + 5} x2={BASIN_RIGHT - 4} y2={top + 5} stroke="var(--canal-accent)" strokeWidth="0.4" opacity="0.3" />
                  {/* Right-aligned label cluster */}
                  <text x={BASIN_RIGHT - 30} y={midY - 1} textAnchor="end" fill="var(--canal-hero)" fontSize="11" fontFamily="ui-monospace, Menlo, monospace">
                    {`${route.label} · ${formatCurrency(route.valueUsd, 0)}`}
                  </text>
                  <text x={BASIN_RIGHT - 30} y={midY + 11} textAnchor="end" fill="var(--canal-caption)" fontSize="9" fontFamily="ui-monospace, Menlo, monospace">
                    {formatPercent(route.sharePct, 1)}
                  </text>
                  {/* Chain chip with logo */}
                  <circle cx={BASIN_RIGHT - 12} cy={midY + 3} r="10" fill="oklch(0.06 0.012 248 / 0.9)" stroke={route.colorHex} strokeWidth="1" />
                  {route.logoPath ? (
                    <image href={route.logoPath} x={BASIN_RIGHT - 20} y={midY - 5} width="16" height="16" preserveAspectRatio="xMidYMid meet" />
                  ) : (
                    <text x={BASIN_RIGHT - 12} y={midY + 6} textAnchor="middle" fill="oklch(0.92 0.01 248)" fontSize="11" fontWeight="800">+</text>
                  )}
                </g>
              );
            });
          })()}
```

- [ ] **Step 3: Run tests — basin testids should pass**

Run: `npm test -- liquidity-stats.test.ts`
Expected: `chain-basin-ethereum` and `image[href="/chains/ethereum.png"]` now pass. All assertions should pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "feat(liquidity): render trapezoidal chain basins in the delta"
```

---

## Task 6: Add scene cues — stars, silhouette lighthouse, vessel, varied sea ripples

**Files:**
- Modify: `src/components/liquidity-stats.tsx` (inside `ExitRouteCanalScene`)

All ornamental groups in this task carry `aria-hidden="true"` so assistive tech is not told about decorative motion.

- [ ] **Step 1: Insert sky-band ornaments after the sky rect**

Inside `ExitRouteCanalScene`, immediately after `<rect x="0" y="0" width={SCENE_WIDTH} height="140" fill="url(#exit-route-canal-sky)" />` and before the canal `<path>`, insert:

```tsx
          {/* Three hand-placed stars — asymmetric, varied sizes. */}
          <g fill="var(--canal-star)" aria-hidden="true">
            <circle cx="210" cy="35" r="1" />
            <circle cx="480" cy="62" r="0.7" />
            <circle cx="710" cy="28" r="1.1" />
          </g>

          {/* Distant lighthouse — silhouette-only, no text label. The brand cue is the
              shape and the faint beam; labelling would cannibalise /chains where the
              lighthouse is the hero. */}
          <g className="exit-route-canal__lighthouse" aria-hidden="true">
            {/* Very faint horizon bump suggesting a headland — one path, one stroke */}
            <path d="M740,140 Q 790,126 840,140 Z" fill="oklch(0.11 0.014 248)" opacity="0.85" />
            {/* Tower: a two-tier silhouette (base + upper), not a single rect. */}
            <rect x="787" y="108" width="6" height="12" fill="var(--canal-wall-stone)" />
            <rect x="788" y="102" width="4" height="7" fill="var(--canal-wall)" />
            {/* Gallery line */}
            <rect x="786" y="101" width="8" height="2" fill="var(--canal-wall-stone)" />
            {/* Beacon dot */}
            <circle cx="790" cy="99" r="1.4" fill="var(--canal-beacon)" />
            {/* Beam — gradient cone, rotated via CSS. transform-origin is in the CSS file. */}
            <path
              className="exit-route-canal__beam"
              d="M790,101 L 905,72 L 905,82 L 790,105 Z"
              fill="url(#exit-route-canal-beam)"
            />
          </g>
```

- [ ] **Step 2: Insert vessel after basins, before the exit-canal group**

Inside `ExitRouteCanalScene`, immediately after the basin IIFE (Task 5 Step 2) and before the `<g data-testid="exit-canal" …>` group, insert:

```tsx
          {/* Vessel drifting in the open-water stretch between the last gate and the dam.
              Placed BELOW the focal TVL numeric so the two don't compete.
              Drift duration is bound to --vessel-duration (crowding-driven). */}
          <g className="exit-route-canal__vessel" transform="translate(640,320)" aria-hidden="true">
            {/* Hull — single silhouette path, tapered stern */}
            <path d="M-22,0 Q -20,7 -14,8 L 14,8 Q 20,7 20,0 Z" fill="oklch(0.88 0.008 248)" opacity="0.88" />
            {/* Deckhouse */}
            <rect x="-6" y="-6" width="12" height="6" fill="oklch(0.78 0.008 248)" opacity="0.88" />
            {/* Mast and flag hint */}
            <line x1="0" y1="-6" x2="0" y2="-17" stroke="oklch(0.78 0.008 248)" strokeWidth="0.9" />
            <path d="M0,-17 L 5,-15 L 0,-13 Z" fill="var(--canal-accent)" opacity="0.7" />
            {/* Wake */}
            <path d="M-22,5 Q -56,6 -96,10" fill="none" stroke="var(--canal-ripple)" strokeWidth="0.7" opacity="0.32" />
            <path d="M-22,5 Q -76,9 -140,14" fill="none" stroke="var(--canal-ripple)" strokeWidth="0.5" opacity="0.18" />
          </g>
```

- [ ] **Step 3: Insert the sea ripples**

Inside `ExitRouteCanalScene`, immediately before the `<g data-testid="exit-canal" …>` group (so the ripples render between the sea band and the focal TVL numeric), insert:

```tsx
          {/* Sea ripples — 5 horizontal lines with varied strokeDasharray and opacity taper.
              Depth cue: farther-from-camera ripples are fainter. Each ripple animates on
              its own co-prime period (see CSS) so the surface glimmers asynchronously. */}
          <g className="exit-route-canal__wave" stroke="var(--canal-ripple)" fill="none" aria-hidden="true">
            <path d="M0,395 H 970" strokeDasharray="8 14 4 22 12 18" strokeWidth="0.6" opacity="0.22" />
            <path d="M0,410 H 970" strokeDasharray="12 16 6 24 10 20" strokeWidth="0.55" opacity="0.18" />
            <path d="M0,425 H 970" strokeDasharray="6 18 10 14 8 22" strokeWidth="0.5" opacity="0.14" />
            <path d="M0,440 H 970" strokeDasharray="14 10 20 8 16 12" strokeWidth="0.45" opacity="0.11" />
            <path d="M0,455 H 970" strokeDasharray="10 22 6 16 14 18" strokeWidth="0.4" opacity="0.09" />
          </g>
          <text x="970" y="468" textAnchor="end" fill="var(--canal-caption-dim)" fontSize="9" fontWeight="700" letterSpacing="1.8" aria-hidden="true">
            OPEN SEA
          </text>
```

- [ ] **Step 4: Run the test — full suite should still pass**

Run: `npm test -- liquidity-stats.test.ts`
Expected: PASS — decorative elements added but no test assertions affected.

- [ ] **Step 5: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "feat(liquidity): add vessel, silhouette lighthouse, varied sea ripples"
```

---

## Task 7: Narrow-viewport validation

**Files:** none modified unless adjustments are needed.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: server starts on port 3000.

- [ ] **Step 2: Navigate to `/liquidity` at two widths**

Using Playwright MCP (preferred — proper wait primitives) or Chrome dev-tools, validate:

- **1280 × 800:**
  - [ ] Lighthouse visible on the headland
  - [ ] Focal TVL numeric is the dominant read in the scene
  - [ ] Mitre leaves of each gate visibly lean inward
  - [ ] Canal tapers toward the dam (`data-crowding-band="visible"` in the fixture gives a 32 px taper)
  - [ ] Trapezoidal basins visibly splay rightward from the dam face
  - [ ] Sea ripples visibly shimmer asynchronously
  - [ ] Vessel drifts smoothly (ease-in-out, no jitter at the midpoint reversal)
  - [ ] Beam arc pivots around the lamp head (not around its own bbox)

- **360 × 640 (iOS default):**
  - [ ] Lighthouse is hidden
  - [ ] Gate percentage row is hidden (only the `$` row remains)
  - [ ] No horizontal overflow beyond the scene's declared `min-width: 560px` (a horizontal scrollbar *is* expected inside the card at this viewport; the page itself must not scroll horizontally)
  - [ ] Basin labels are not clipped

- [ ] **Step 3: Adjust CSS if needed**

If any of those fail, tune `src/components/exit-route-canal.css` — typically by adjusting the `@media (max-width: 640px)` block, shortening labels via `.exit-route-canal__gate-pct` / similar class gates, or reducing font sizes at the SVG. Commit adjustments with a targeted message.

- [ ] **Step 4: Stop the dev server**

---

## Task 8: Full validation

**Files:** none modified.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Merge gate**

Run: `npm run test:merge-gate`
Expected: Passes.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 6: Confirm no orphaned identifiers**

Run:

```bash
grep -n "ExitRouteTerminal\|routeStrokeWidth\|crowdingWaist\|routeY\|chain-lane-\|exit-route-terminal\|exit-concourse" src/components/liquidity-stats.tsx src/components/__tests__/liquidity-stats.test.ts
```

Expected: No matches.

- [ ] **Step 7: Prefers-reduced-motion sanity**

In the browser dev-tools, emulate `prefers-reduced-motion: reduce` and reload `/liquidity`.
- [ ] Vessel does not drift
- [ ] Beam does not sweep
- [ ] Sea ripples do not shimmer
- [ ] The static frame is fully legible: all numeric and textual content reads without motion

- [ ] **Step 8: Final commit if any fixes were needed**

```bash
git status
git add -p
git commit -m "fix(liquidity): address validation findings"
```

(If no changes, skip.)

---

## Success Criteria

1. `npm test` — all tests pass.
2. `npm run build` — succeeds.
3. `cd worker && npx tsc --noEmit` — succeeds.
4. `npm run lint` — no new warnings or errors.
5. `npm run test:merge-gate` — passes.
6. At ≥1280px: mitre leaves visibly lean inward per gate, focal TVL numeric dominates the scene, canal taper visibly narrows toward the dam proportional to the crowding band, trapezoidal basins splay rightward, five sea ripples shimmer asynchronously, silhouette lighthouse sits in the upper right without a text label, vessel drifts smoothly under ease-in-out with a 1 px vertical bob.
7. At 360px: lighthouse hidden, gate percentage row hidden, no horizontal page overflow. A horizontal scrollbar inside the card is acceptable and expected below 560 px.
8. With `prefers-reduced-motion: reduce`: no motion triggers; static frame is fully legible.
9. No references to `ExitRouteTerminal`, `routeStrokeWidth`, `crowdingWaist`, `routeY`, `exit-route-terminal`, `exit-concourse`, or `chain-lane-*` anywhere in the repo.
10. The canal scene is family-legible with `/chains` (nautical, Pharos-beacon palette) without cannibalising it (no labelled lighthouse, smaller beam arc, silhouette-scale tower).
