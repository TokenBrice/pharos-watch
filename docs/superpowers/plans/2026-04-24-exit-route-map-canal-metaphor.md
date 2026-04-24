# Exit Route Map — Canal & Locks Metaphor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "transit concourse" SVG scene inside the Exit Route Map card with a side-elevation canal scene (lock gates, aggregate water body, delta of chain basins, distant Pharos lighthouse, vessel) while preserving every data input, metric, and sidebar control.

**Architecture:** Single-file visual rework of the `ExitRouteTerminal` subcomponent in `src/components/liquidity-stats.tsx`. The data model (`buildLiquidityExitRouteModel` and `LiquidityExitRouteModel`) is unchanged. The component is renamed `ExitRouteCanalScene` and renders an SVG composed of three horizontal bands (sky / canal / sea) with lock-gate rectangles in the canal and chain basins in a delta on the right. A colocated CSS module (`src/components/exit-route-canal.css`) holds gradients, colour tokens, and opt-in animations behind `prefers-reduced-motion: no-preference`.

**Tech Stack:** React 19 client component, inline SVG, Tailwind utility classes, vanilla CSS module imported from the component. No new dependencies. Vitest + Testing Library for tests (already set up).

**Reference:** Design spec at `docs/superpowers/specs/2026-04-24-exit-route-map-canal-metaphor-design.md` (committed `62892505`).

---

## File Structure

- **Create:** `src/components/exit-route-canal.css` — gradient defs (sky, canal water, sea), colour tokens for gate/basin states, keyframe animations (vessel drift, lighthouse beam, wave shimmer) all scoped under a `.exit-route-canal` root class and guarded by `prefers-reduced-motion`.
- **Modify:** `src/components/liquidity-stats.tsx` — remove `ExitRouteTerminal` (lines 269–481) and helper functions that only served it (`routeStrokeWidth`, `routeY`, `crowdingWaist`); add a new `ExitRouteCanalScene` component; update `LiquidityExitRouteMap` to import the CSS, render the new scene, and update the caption row copy (lines 510–517).
- **Modify:** `src/components/__tests__/liquidity-stats.test.ts` — update testid assertions on lines 215–219, add assertions for the new caption copy and chain-basin testids.

---

## Task 1: Update tests to expect the new canal scene

**Files:**
- Modify: `src/components/__tests__/liquidity-stats.test.ts:214-222`

- [ ] **Step 1: Rewrite the render assertions**

Open `src/components/__tests__/liquidity-stats.test.ts`, locate the block at lines 214–222 (inside `it("renders the exit route map with disclosed tail routes", …)`), and replace it with:

```ts
    expect(screen.getByText("Exit Route Map")).toBeTruthy();
    expect(screen.getByTestId("exit-route-canal")).toBeTruthy();
    expect(screen.getByTestId("protocol-gate-curve")).toBeTruthy();
    expect(screen.getByTestId("protocol-gate-_other-routes")).toBeTruthy();
    expect(screen.getByTestId("chain-basin-ethereum")).toBeTruthy();
    expect(screen.getByTestId("exit-canal").getAttribute("data-crowding-band")).toBe("visible");
    expect(screen.getByText("Leading gate:")).toBeTruthy();
    expect(screen.getByText("Leading basin:")).toBeTruthy();
    expect(container.querySelector('image[href="/dexes/curve.png"]')).toBeTruthy();
    expect(container.querySelector('image[href="/chains/ethereum.png"]')).toBeTruthy();
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- liquidity-stats.test.ts`
Expected: FAIL — errors about `exit-route-canal`, `chain-basin-ethereum`, `exit-canal`, `Leading gate:`, `Leading basin:` not being found.

- [ ] **Step 3: Commit**

```bash
git add src/components/__tests__/liquidity-stats.test.ts
git commit -m "test(liquidity): expect canal scene testids and new caption copy"
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
 * Colour tokens and ambient motion for the side-elevation canal SVG.
 * Motion is opt-in via prefers-reduced-motion.
 */

.exit-route-canal {
  --canal-sky-top: oklch(0.18 0.024 248);
  --canal-sky-bottom: oklch(0.08 0.014 248);
  --canal-water-left: oklch(0.32 0.068 232 / 0.9);
  --canal-water-right: oklch(0.68 0.14 200 / 0.75);
  --canal-wall: oklch(0.22 0.018 248);
  --canal-dam: oklch(0.34 0.022 248);
  --canal-sea-top: oklch(0.15 0.018 248);
  --canal-sea-bottom: oklch(0.09 0.012 248);
  --canal-caption: oklch(0.56 0.014 248);
  --canal-hero: oklch(0.92 0.014 248);
  --canal-beacon: oklch(0.86 0.18 82);
  --canal-beacon-beam: oklch(0.86 0.18 82 / 0.18);
  --canal-star: oklch(0.88 0.01 248 / 0.55);
}

.exit-route-canal__scene {
  display: block;
  width: 100%;
  min-width: 620px;
  height: auto;
}

@media (min-width: 768px) {
  .exit-route-canal__scene {
    min-width: 0;
  }
}

/* Hide ornamental lighthouse on narrow viewports where the headland would crowd the basin labels. */
@media (max-width: 640px) {
  .exit-route-canal__lighthouse {
    display: none;
  }
}

/* --- Ambient motion (opt-in) --- */
@media (prefers-reduced-motion: no-preference) {
  .exit-route-canal__vessel {
    animation: exit-route-canal-drift 12s linear infinite;
  }
  .exit-route-canal__beam {
    transform-origin: 790px 102px;
    animation: exit-route-canal-sweep 10s ease-in-out infinite alternate;
  }
  .exit-route-canal__wave {
    animation: exit-route-canal-shimmer 6s ease-in-out infinite alternate;
  }
}

@keyframes exit-route-canal-drift {
  0%   { transform: translateX(-8px); }
  50%  { transform: translateX(8px); }
  100% { transform: translateX(-8px); }
}

@keyframes exit-route-canal-sweep {
  0%   { transform: rotate(-8deg); opacity: 0.45; }
  100% { transform: rotate(8deg);  opacity: 0.9; }
}

@keyframes exit-route-canal-shimmer {
  0%   { opacity: 0.65; transform: translateX(0); }
  100% { opacity: 1;    transform: translateX(6px); }
}
```

- [ ] **Step 2: Confirm the file exists and is valid CSS**

Run: `test -f src/components/exit-route-canal.css && echo "ok"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/components/exit-route-canal.css
git commit -m "feat(liquidity): add exit-route-canal stylesheet"
```

---

## Task 3: Replace `ExitRouteTerminal` with `ExitRouteCanalScene` skeleton

This task replaces the old component with a scaffold that renders the three scene bands, the outer container, and the `exit-route-canal` / `exit-canal` testids. Gates and basins are filled in Tasks 4 and 5.

**Files:**
- Modify: `src/components/liquidity-stats.tsx:269-481`

- [ ] **Step 1: Import the new CSS at the top of the file**

In `src/components/liquidity-stats.tsx`, add a single import line under the existing import block (after line 28 `import { MethodologyLabel } …`):

```ts
import "./exit-route-canal.css";
```

- [ ] **Step 2: Delete the old component and its scene-only helpers**

Delete the following blocks from `src/components/liquidity-stats.tsx`:

- Lines 246–260 (helpers `routeStrokeWidth`, `crowdingWaist`, `routeY`) — these are only used by `ExitRouteTerminal`. Keep `crowdingBand` (lines 262–267) because `ExitRouteCanalScene` reuses it.
- Lines 269–481 (the entire `ExitRouteTerminal` function).

After deletion, `crowdingBand` (unchanged) should be immediately followed by where the new component goes.

- [ ] **Step 3: Add the skeleton for `ExitRouteCanalScene`**

Immediately after the `crowdingBand` function, insert:

```tsx
function ExitRouteCanalScene({ model }: { model: LiquidityExitRouteModel }) {
  const band = crowdingBand(model.concentrationHhi);
  const routeSummary = [
    `${formatCurrency(model.totalTvlUsd, 0)} DEX TVL`,
    model.topProtocol ? `${model.topProtocol.label} leading protocol gate` : null,
    model.topChain ? `${model.topChain.label} leading chain basin` : null,
    model.concentrationHhi == null ? null : `${model.concentrationHhi.toFixed(2)} crowding index`,
  ].filter(Boolean).join(", ");

  return (
    <div className="exit-route-canal overflow-hidden rounded-xl border border-border/70">
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 1000 480"
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
              <stop offset="0%" stopColor="var(--canal-water-left)" />
              <stop offset="100%" stopColor="var(--canal-water-right)" />
            </linearGradient>
            <linearGradient id="exit-route-canal-sea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--canal-sea-top)" />
              <stop offset="100%" stopColor="var(--canal-sea-bottom)" />
            </linearGradient>
            <radialGradient id="exit-route-canal-beam" cx="0%" cy="0%" r="100%">
              <stop offset="0%" stopColor="var(--canal-beacon-beam)" />
              <stop offset="100%" stopColor="var(--canal-beacon-beam)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Sky band */}
          <rect x="0" y="0" width="1000" height="140" fill="url(#exit-route-canal-sky)" />

          {/* Canal band (aggregate water body) — gates/basin drawn in later tasks */}
          <rect x="30" y="140" width="940" height="240" fill="url(#exit-route-canal-water)" />

          {/* Sea band */}
          <rect x="0" y="380" width="1000" height="100" fill="url(#exit-route-canal-sea)" />

          {/* Canal group with crowding attribute — used by tests.
              Positioned in the open-water area (right half of canal) so it never collides with gate chips. */}
          <g
            data-testid="exit-canal"
            data-crowding-band={band}
            aria-label={`Aggregate exit canal; crowding ${band}`}
          >
            <text x="625" y="260" textAnchor="middle" fill="var(--canal-hero)" fontSize="26" fontWeight="700">
              {formatCurrency(model.totalTvlUsd, 0)}
            </text>
            <text x="625" y="280" textAnchor="middle" fill="var(--canal-caption)" fontSize="10" fontWeight="700" letterSpacing="1.5">
              SECONDARY EXIT TVL
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update the single call site inside `LiquidityExitRouteMap`**

In `LiquidityExitRouteMap`, change the element at the old line 508 from `<ExitRouteTerminal model={model} />` to `<ExitRouteCanalScene model={model} />`.

- [ ] **Step 5: Run the partial test to confirm skeleton loads**

Run: `npm test -- liquidity-stats.test.ts`
Expected: still FAIL, but the failure now mentions `protocol-gate-curve` / `chain-basin-ethereum` (the skeleton renders; gates/basins aren't drawn yet).

- [ ] **Step 6: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "refactor(liquidity): replace concourse scene with canal skeleton"
```

---

## Task 4: Render lock gates (protocols) inside the canal band

Each protocol route becomes a vertical lock gate inside the canal. Gates are laid out left-to-right in `protocolRoutes` order (already sorted by sharePct desc). Gate width encodes `sharePct`. The gate includes a small mechanism bar at the top, protocol chip with logo at the middle, and numeric labels below the canal band.

**Files:**
- Modify: `src/components/liquidity-stats.tsx` (inside `ExitRouteCanalScene`)

- [ ] **Step 1: Add the geometry helper for gate layout**

Immediately above the `ExitRouteCanalScene` function definition, insert these helpers:

```ts
// Canal spans the full width between x=30 and x=970 in the viewBox.
// Gates are clustered in the LEFT half so the right half reads as open water
// carrying the aggregate-TVL numeric and the drifting vessel.
const CANAL_TOP = 140;
const CANAL_BOTTOM = 380;
const GATE_AREA_LEFT = 80;
const GATE_AREA_RIGHT = 500;
const GATE_AREA_WIDTH = GATE_AREA_RIGHT - GATE_AREA_LEFT; // 420
const GATE_MIN_OPEN = 18;
const GATE_MAX_OPEN = 66;

function gateOpenWidth(sharePct: number): number {
  // Map 0–45% share → 18–66 px opening, clamped for legibility.
  const clamped = Math.max(0, Math.min(45, sharePct));
  const t = clamped / 45;
  return Math.round(GATE_MIN_OPEN + t * (GATE_MAX_OPEN - GATE_MIN_OPEN));
}

function gateXPositions(count: number): number[] {
  // Evenly distributed gate centres across the gate area.
  if (count <= 1) return [GATE_AREA_LEFT + GATE_AREA_WIDTH / 2];
  const step = GATE_AREA_WIDTH / count;
  return Array.from({ length: count }, (_, i) => GATE_AREA_LEFT + step * (i + 0.5));
}
```

- [ ] **Step 2: Render the gates inside the canal group**

Inside `ExitRouteCanalScene`, after the `<rect … fill="url(#exit-route-canal-water)" />` line and before the `<g data-testid="exit-canal" …>` group, insert:

```tsx
          {/* Upstream wall (left edge of canal) */}
          <rect x="30" y={CANAL_TOP} width="5" height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-wall)" />
          <text x="45" y="130" fill="var(--canal-caption)" fontSize="9" fontWeight="700" letterSpacing="1.6">
            UPSTREAM · HOLDERS
          </text>

          {/* Lock gates (protocols) */}
          {(() => {
            const xs = gateXPositions(model.protocolRoutes.length);
            return model.protocolRoutes.map((route, i) => {
              const open = gateOpenWidth(route.sharePct);
              const cx = xs[i];
              const leftPier = cx - open / 2 - 4;
              const rightPier = cx + open / 2;
              const chipR = 12;
              return (
                <g
                  key={`protocol-${route.key}`}
                  data-testid={`protocol-gate-${route.key}`}
                  aria-label={`${route.label} lock gate, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                >
                  <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} lock gate (${formatPercent(route.sharePct, 1)})`}</title>
                  {/* Left pier */}
                  <rect x={leftPier} y={CANAL_TOP} width="4" height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-wall)" />
                  {/* Gate opening (fill colour encodes protocol) */}
                  <rect
                    x={leftPier + 4}
                    y={CANAL_TOP}
                    width={open}
                    height={CANAL_BOTTOM - CANAL_TOP}
                    fill={route.colorHex}
                    opacity="0.5"
                  />
                  {/* Right pier */}
                  <rect x={rightPier} y={CANAL_TOP} width="4" height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-wall)" />
                  {/* Gate mechanism bar at top */}
                  <rect x={leftPier - 2} y={CANAL_TOP - 8} width={open + 10} height="8" fill="var(--canal-wall)" />
                  <rect x={leftPier + 4} y={CANAL_TOP - 6} width={open} height="3" fill="oklch(0.78 0.14 178 / 0.7)" />
                  {/* Protocol chip */}
                  <circle cx={cx} cy={CANAL_TOP + 120} r={chipR} fill="oklch(0.06 0.012 248 / 0.9)" stroke={route.colorHex} strokeWidth="1.2" />
                  {route.logoPath ? (
                    <image href={route.logoPath} x={cx - 9} y={CANAL_TOP + 111} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                  ) : (
                    <text x={cx} y={CANAL_TOP + 125} textAnchor="middle" fill="oklch(0.92 0.01 248)" fontSize="13" fontWeight="800">+</text>
                  )}
                  {/* Labels below the canal */}
                  <text x={cx} y={CANAL_BOTTOM + 16} textAnchor="middle" fill="var(--canal-hero)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
                    {formatCurrency(route.valueUsd, 0)}
                  </text>
                  <text x={cx} y={CANAL_BOTTOM + 30} textAnchor="middle" fill="var(--canal-caption)" fontSize="9" fontFamily="ui-monospace, Menlo, monospace">
                    {formatPercent(route.sharePct, 1)}
                  </text>
                </g>
              );
            });
          })()}
```

- [ ] **Step 3: Run the test — gate testids should pass**

Run: `npm test -- liquidity-stats.test.ts`
Expected: `protocol-gate-curve` and `protocol-gate-_other-routes` assertions pass; `chain-basin-ethereum` still fails.

- [ ] **Step 4: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "feat(liquidity): render protocol lock gates in canal scene"
```

---

## Task 5: Render chain basins in the delta

**Files:**
- Modify: `src/components/liquidity-stats.tsx` (inside `ExitRouteCanalScene`)

- [ ] **Step 1: Add basin geometry helpers**

Immediately after the gate helpers from Task 4, add:

```ts
const DAM_X = 748;
const DAM_WIDTH = 6;
const BASIN_LEFT = DAM_X + DAM_WIDTH;
const BASIN_RIGHT = 968;
const BASIN_AREA_TOP = 150;
const BASIN_AREA_BOTTOM = 372;
const BASIN_GAP = 4;

function basinHeights(routes: LiquidityExitRouteItem[]): number[] {
  // Distribute the basin stack proportionally to sharePct, with a minimum height for legibility.
  const usable = BASIN_AREA_BOTTOM - BASIN_AREA_TOP - BASIN_GAP * Math.max(0, routes.length - 1);
  const totalShare = routes.reduce((sum, r) => sum + Math.max(0, r.sharePct), 0);
  if (totalShare <= 0 || routes.length === 0) return routes.map(() => 0);
  const raw = routes.map((r) => (Math.max(0, r.sharePct) / totalShare) * usable);
  const minH = 18;
  // Bump too-small values up to minH and rescale the rest.
  const floored = raw.map((h) => Math.max(minH, h));
  const overflow = floored.reduce((sum, h) => sum + h, 0) - usable;
  if (overflow <= 0) return floored.map((h) => Math.round(h));
  const adjustable = floored.filter((h) => h > minH).length;
  const perItem = adjustable > 0 ? overflow / adjustable : 0;
  return floored.map((h) => Math.round(h > minH ? h - perItem : h));
}
```

- [ ] **Step 2: Render the dam wall and basins**

Inside `ExitRouteCanalScene`, after the lock-gates block (end of the IIFE that renders gates) and before the `<g data-testid="exit-canal" …>` group, insert:

```tsx
          {/* Dam wall */}
          <rect x={DAM_X} y={CANAL_TOP} width={DAM_WIDTH} height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-dam)" />
          <rect x={DAM_X - 2} y={CANAL_TOP - 2} width={DAM_WIDTH + 4} height="4" fill="oklch(0.78 0.14 178 / 0.5)" />

          {/* Chain basins (delta) */}
          {(() => {
            const heights = basinHeights(model.chainRoutes);
            let cursor = BASIN_AREA_TOP;
            return model.chainRoutes.map((route, i) => {
              const top = cursor;
              const h = heights[i];
              cursor = top + h + BASIN_GAP;
              const midY = top + h / 2;
              return (
                <g
                  key={`chain-${route.key}`}
                  data-testid={`chain-basin-${route.key}`}
                  aria-label={`${route.label} chain basin, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                >
                  <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} chain basin (${formatPercent(route.sharePct, 1)})`}</title>
                  <path
                    d={`M ${BASIN_LEFT} ${top} C ${BASIN_LEFT + 65} ${top}, ${BASIN_RIGHT - 30} ${top}, ${BASIN_RIGHT} ${top} L ${BASIN_RIGHT} ${top + h} C ${BASIN_RIGHT - 30} ${top + h + 2}, ${BASIN_LEFT + 65} ${top + h + 2}, ${BASIN_LEFT} ${top + h} Z`}
                    fill={route.colorHex}
                    opacity="0.55"
                  />
                  {/* Right-aligned label cluster */}
                  <text x={BASIN_RIGHT - 30} y={midY - 2} textAnchor="end" fill="var(--canal-hero)" fontSize="11" fontFamily="ui-monospace, Menlo, monospace">
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

- [ ] **Step 3: Run the test — basin testid should pass**

Run: `npm test -- liquidity-stats.test.ts`
Expected: `chain-basin-ethereum` assertion passes; caption-copy assertions (`Leading gate:`, `Leading basin:`) still fail (handled in Task 7).

- [ ] **Step 4: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "feat(liquidity): render chain basins in canal delta"
```

---

## Task 6: Add scene cues — vessel, Pharos lighthouse, stars, waves, kicker labels

**Files:**
- Modify: `src/components/liquidity-stats.tsx` (inside `ExitRouteCanalScene`)

- [ ] **Step 1: Insert sky-band ornaments after the sky rect**

Inside `ExitRouteCanalScene`, immediately after `<rect x="0" y="0" width="1000" height="140" fill="url(#exit-route-canal-sky)" />` and before the canal rect, insert:

```tsx
          {/* Stars */}
          <g fill="var(--canal-star)">
            <circle cx="140" cy="40" r="0.8" />
            <circle cx="250" cy="70" r="0.6" />
            <circle cx="380" cy="30" r="0.8" />
            <circle cx="520" cy="55" r="0.6" />
            <circle cx="640" cy="45" r="0.8" />
            <circle cx="760" cy="60" r="0.6" />
            <circle cx="880" cy="35" r="0.8" />
          </g>

          {/* Distant headland with Pharos lighthouse */}
          <g className="exit-route-canal__lighthouse">
            <path
              d="M740,140 Q 770,120 800,118 L 820,120 Q 840,130 860,140 Z"
              fill="oklch(0.11 0.014 248)"
              stroke="oklch(0.22 0.018 248)"
              strokeWidth="0.5"
            />
            <g transform="translate(790,118)">
              <rect x="-2" y="-14" width="4" height="14" fill="var(--canal-wall)" />
              <rect x="-4" y="-14" width="8" height="2" fill="var(--canal-beacon)" opacity="0.7" />
              <circle cx="0" cy="-17" r="1.8" fill="var(--canal-beacon)" />
              <path className="exit-route-canal__beam" d="M0,-16 L 120,-40 L 0,-14 Z" fill="url(#exit-route-canal-beam)" />
            </g>
            <text x="790" y="135" textAnchor="middle" fill="var(--canal-caption)" fontSize="9" fontWeight="700" letterSpacing="1.6">
              PHAROS
            </text>
          </g>
```

- [ ] **Step 2: Insert vessel between the lock gates and dam wall**

Still inside `ExitRouteCanalScene`, immediately after the IIFE that renders the basins and before the `<g data-testid="exit-canal" …>` group, insert:

```tsx
          {/* Vessel drifting in the open-water stretch between the last gate and the dam wall.
              Positioned below the TVL numeric so the two don't compete for focus. */}
          <g className="exit-route-canal__vessel" transform="translate(640,330)">
            <path d="M-20,0 L 20,0 L 16,8 L -16,8 Z" fill="oklch(0.92 0.01 248)" opacity="0.85" />
            <rect x="-6" y="-6" width="12" height="6" fill="oklch(0.85 0.01 248)" opacity="0.85" />
            <line x1="0" y1="-6" x2="0" y2="-16" stroke="oklch(0.85 0.01 248)" strokeWidth="0.8" />
            <path d="M-20,4 Q -60,4 -100,10" fill="none" stroke="oklch(0.78 0.14 178)" strokeWidth="0.7" opacity="0.35" />
            <path d="M-20,4 Q -80,8 -140,16" fill="none" stroke="oklch(0.78 0.14 178)" strokeWidth="0.5" opacity="0.2" />
          </g>
```

- [ ] **Step 3: Insert sea ripples inside the sea band**

Inside `ExitRouteCanalScene`, immediately after the sea-band rect `<rect x="0" y="380" width="1000" height="100" fill="url(#exit-route-canal-sea)" />`, insert:

```tsx
          {/* Sea ripples */}
          <g stroke="oklch(0.22 0.018 248)" strokeWidth="0.5" fill="none" opacity="0.9" className="exit-route-canal__wave">
            <path d="M0,395 Q 50,390 100,395 T 200,395 T 300,395 T 400,395 T 500,395 T 600,395 T 700,395 T 800,395 T 900,395 T 1000,395" />
            <path d="M0,415 Q 50,410 100,415 T 200,415 T 300,415 T 400,415 T 500,415 T 600,415 T 700,415 T 800,415 T 900,415 T 1000,415" />
            <path d="M0,435 Q 50,430 100,435 T 200,435 T 300,435 T 400,435 T 500,435 T 600,435 T 700,435 T 800,435 T 900,435 T 1000,435" />
          </g>
          <text x="970" y="465" textAnchor="end" fill="var(--canal-caption)" fontSize="9" fontWeight="700" letterSpacing="1.6">
            OPEN SEA
          </text>
```

- [ ] **Step 4: Run the test to confirm the scene still renders**

Run: `npm test -- liquidity-stats.test.ts`
Expected: Same results as Task 5 — all testid/image assertions pass; `Leading gate:` / `Leading basin:` still fail.

- [ ] **Step 5: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "feat(liquidity): add vessel, lighthouse, stars, ripples to canal scene"
```

---

## Task 7: Update caption copy in `LiquidityExitRouteMap`

**Files:**
- Modify: `src/components/liquidity-stats.tsx` (caption row inside `LiquidityExitRouteMap`)

- [ ] **Step 1: Update the caption-row labels**

In `LiquidityExitRouteMap`, locate the caption row (the `<div className="flex flex-wrap items-center gap-x-4 …">` block that contains `Leading door:` and `Leading lane:`). Replace:

```tsx
              <span>
                Leading door:{" "}
                <span className="font-medium text-foreground">{model.topProtocol?.label ?? "n/a"}</span>
              </span>
              <span>
                Leading lane:{" "}
                <span className="font-medium text-foreground">{model.topChain?.label ?? "n/a"}</span>
              </span>
```

with:

```tsx
              <span>
                Leading gate:{" "}
                <span className="font-medium text-foreground">{model.topProtocol?.label ?? "n/a"}</span>
              </span>
              <span>
                Leading basin:{" "}
                <span className="font-medium text-foreground">{model.topChain?.label ?? "n/a"}</span>
              </span>
```

- [ ] **Step 2: Run the test — all assertions should now pass**

Run: `npm test -- liquidity-stats.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/liquidity-stats.tsx
git commit -m "copy(liquidity): rename caption Leading door→gate, lane→basin"
```

---

## Task 8: Verify responsive degradation at narrow widths

The CSS file already hides the lighthouse below 640px (`@media (max-width: 640px)` block in Task 2). This task manually verifies scene legibility at 360px and 620px widths.

**Files:** none modified unless adjustments are needed.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: server starts on port 3000 (default).

- [ ] **Step 2: Open the liquidity page in a headless browser**

From another terminal, run (using Playwright MCP tools if available, or manually in a browser dev-tools at 360×640):

```
Navigate to http://localhost:3000/liquidity
Resize viewport to 360×640.
```

- [ ] **Step 3: Visually confirm**

At 360×640:
- [ ] Lock gates are visible with distinguishable widths
- [ ] Gate percentages are legible (not overlapping)
- [ ] The lighthouse group is hidden
- [ ] Chain basin labels are right-aligned and not clipped
- [ ] The sidebar stack wraps below the scene

At 640×800:
- [ ] Lighthouse becomes visible on the headland
- [ ] All elements scale proportionally with the viewport

If any of those fail, adjust `src/components/exit-route-canal.css` — typically by shortening label strings, reducing font size, or introducing additional breakpoints in the CSS file. Commit any adjustments with:

```bash
git add src/components/exit-route-canal.css
git commit -m "style(liquidity): tighten canal scene at narrow breakpoints"
```

If no adjustments are needed, proceed to the next task.

- [ ] **Step 4: Stop the dev server**

---

## Task 9: Full validation

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Run the worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Run the pre-push merge gate**

Run: `npm run test:merge-gate`
Expected: Passes.

- [ ] **Step 5: Run the lint pass**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 6: Confirm no orphaned imports**

Run: `grep -n "ExitRouteTerminal\|routeStrokeWidth\|crowdingWaist\|routeY\|chain-lane-" src/components/liquidity-stats.tsx src/components/__tests__/liquidity-stats.test.ts`
Expected: No matches (all old identifiers removed).

- [ ] **Step 7: Final commit if any fixes were needed**

```bash
git status
git add -p
git commit -m "fix(liquidity): address validation findings"
```

(If there are no changes, skip the commit.)

---

## Success Criteria

1. `npm test` — all tests pass, including updated `liquidity-stats.test.ts` assertions.
2. `npm run build` — succeeds.
3. `cd worker && npx tsc --noEmit` — succeeds.
4. `npm run lint` — no warnings or errors introduced.
5. `npm run test:merge-gate` — passes.
6. Visually at ≥1280px: lock-gate widths are proportional to each protocol's `sharePct`, chain basins ordered top-to-bottom by size, Pharos lighthouse visible on the distant headland with faint beam, vessel mid-canal between the lock gates and the dam wall.
7. At 360px width: lighthouse is hidden, all gate percentages remain readable, no horizontal overflow beyond the scene's intended 620px minimum.
8. With `prefers-reduced-motion: reduce`: no animations trigger; the static composition is fully legible.
9. No references to `ExitRouteTerminal`, `chain-lane-*`, `Leading door`, or `Leading lane` remain in the repo.
