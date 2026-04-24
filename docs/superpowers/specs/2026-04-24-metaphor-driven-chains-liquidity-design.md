# Metaphor-Driven Visuals for /chains and /liquidity

**Status:** Design approved, not yet implemented
**Date:** 2026-04-24
**Scope:** Two routes — `src/app/chains/` and `src/app/liquidity/`

## Problem

`/cemetery` commits fully to its metaphor: arched tombstone cards sized by peak market cap, with crosses, flower scatter on hover, and a "Press F to pay respects" interaction. `/alt-pegs/fiat-world-atlas` commits fully: starfield, constellation cohorts, celestial bands for commodities, coin emblems plotted at geographic origin.

By contrast, the existing metaphors on `/chains` and `/liquidity` are **named, not drawn**:

- `/chains` has a "Harbor Map" section with anchor/ship-wheel icons and nautical copy ("Where stablecoin supply is docked"), but the rendering is a standard bar-list with health bars and four metric cards. Nothing visually resembles a harbor.
- `/liquidity` has no metaphor at all. The lead copy talks about "pool depth" and "liquidity is your only exit route in a panic," but the page is a leaderboard table with stat cards and filters. Standard dashboard geometry.

The gap is visualization. This spec closes it.

## Non-Goals

- No changes to data pipelines, API shapes, or scoring methodology.
- No replacement of the existing leaderboard tables — they remain below the new hero sections for data-dense scanning.
- No new third-party dependencies. No framer-motion, no SVG library, no canvas/WebGL.

## Design Principles (from existing codebase conventions)

Confirmed against the codebase inventory:

1. **Inline JSX SVG.** Cemetery's `Flower` and `HammerStrike`, alt-pegs' `sun-cohort` rays and `cohort-threads` lines — all inline SVG inside TSX components. No external .svg assets.
2. **Semantic CSS variables with hex fallbacks** for SVG fill/stroke — e.g. `var(--severity-healthy-hex, #4ade80)`. This makes SVGs dark-mode aware without `dark:` variants.
3. **Motion tokens.** `--motion-duration-fast` (160ms), `--motion-duration-base` (220ms), `--motion-ease-standard`. Animations gated by `@media (prefers-reduced-motion: no-preference)`.
4. **Mobile degradation via breakpoint swap**, not feature removal. The `xl:hidden` / `hidden xl:block` pattern from `alt-pegs/fiat-world-atlas/mobile-region-list.tsx` — rich visual on desktop, simplified list on mobile.
5. **Every shape encodes a field.** No decorative shapes that don't map to a data attribute. Cemetery's tombstone size = peak mcap. Alt-pegs' emblem position = region. Same rule here.

## /chains — Nautical Chart

### Concept

The existing `ChainHarborMap` section is replaced in place. Instead of a bar-list, it renders a top-down SVG nautical chart: a horizontal waterline across the card, with chains drawn as ships docked along the harbor.

### Encoding table

| SVG element | Data source | Scale/mapping |
|---|---|---|
| Ship hull length | `ChainSummary.totalUsd` | log10-scaled between a minimum readable width (28px) and card width; largest chain = widest hull |
| Hull fill color | `ChainSummary.healthBand` | existing `HEALTH_FILL_CLASSES` from `src/lib/chain-ui.ts` |
| Mast + flag | chain's `dominantStablecoin.symbol` | 20×20 logo inside a flag rectangle; flag **width** scales with `dominantStablecoin.share` (narrow = diversified, wide = one coin dominates) |
| Cargo containers | `stablecoinCount` | bucketed: 1 container per 5 coins, capped at 6 containers stacked on deck |
| Depth lines under hull | `dominanceShare` | 1 line if `<5%` (shallow), 2 if `5–15%` (mid), 3 if `≥15%` (deep draft) |
| Wake trail | `change7dPct` | green arrow forward for positive 7d, red trail behind for negative; length scales with abs(change), capped |
| Dock rank plaque | supply rank | small "#1"–"#8" tag on pier |
| Sky icon | aggregate health | sun SVG if avg health ≥ healthy band, fog SVG (horizontal haze lines) if fragile/concentrated count ≥ 30% of chains |

Max 8 ships visible (reuse existing `MAX_HARBORS = 8` constant). Smaller chains render as a row of silhouette ships along the right-edge horizon — each clickable, each linking to `/chains/[id]/`.

### Layout

- SVG scene card sits where `ChainHarborMap` currently sits (between the supply-dominance hero band and the chains table).
- Below the scene: a grid of four **compass-plate** cards — restyled versions of the current `ChainHarborMetric` (Largest port / Avg health / Fragile ports / Health-band legend). Compass plate = rounded rectangle with a brass-toned border gradient, inner tick marks at cardinal points (N/E/S/W).
- Caption footer retained: "Source: Chain health snapshot. Harbor size is supply distribution, not issuer redemption capacity."

### Mobile (`< xl`)

Scene hides (`hidden xl:block`). The current bar-list from `harbor-map.tsx` — already responsive — is preserved verbatim as the `xl:hidden` fallback. Compass-plate cards stack vertically. No functionality lost.

### File changes

- The previous harbor-map.tsx is removed and its responsibilities split into:
  - `src/app/chains/harbor-map.ts` — keep existing `buildChainHarborModel` as a pure-TS module. Extend with:
    - `hullWidth(totalUsd, maxUsd, cardWidth): number` (log-scaled)
    - `cargoBuckets(stablecoinCount): number` (0–6)
    - `depthLayers(dominanceShare): 1 | 2 | 3`
    - `wakeLength(change7dPct): number` (normalized 0–1)
    - `aggregateSkyBand(entries): "sun" | "fog"`
  - `src/app/chains/nautical-chart.tsx` — new React component. Renders the SVG scene for `xl:`, delegates to the legacy bar-list for `< xl`. The legacy bar-list markup moves to a new `harbor-list.tsx` (extracted 1:1 from today's `harbor-map.tsx` body).
- `src/app/chains/harbor-list.tsx` — new. Existing bar-list UI, unchanged behavior. Used as the `xl:hidden` fallback inside `nautical-chart.tsx`.
- `src/app/chains/nautical-chart.css` — new. Keyframes: `wave-drift` (subtle horizontal translate on waterline), `flag-wave` (5s sin-wave SVG path). Both gated on `prefers-reduced-motion: no-preference`.
- `src/app/chains/client.tsx` — swap `<ChainHarborMap>` import to `<NauticalChart>`.
- `src/app/chains/harbor-map.test.ts` — retain and extend with tests for the new pure helpers.

## /liquidity — Depth Gauges

### Concept

The page renders a grid of vertical SVG measuring cylinders — "depth gauges" — one per tracked stablecoin. Each gauge looks like a laboratory graduated cylinder with a water column. The fill height, color, clarity, and surface ripple encode the coin's liquidity profile at a glance.

### Encoding table

| SVG element | Data source | Scale/mapping |
|---|---|---|
| Water fill height | `LiquidityScore` (0–100) | direct percentage of cylinder height; tick marks at 25/50/75/100 |
| Water color | `coverageClass` | `primary` = navy (`--p-blue-700`), `mixed` = teal (`--p-teal-500`), `fallback` = amber (`--p-amber-500`), `legacy` = slate, `unobserved` = hatched (SVG `<pattern>` of diagonal lines) |
| Surface ripple amplitude | `volume24h` (log-bucketed to 3 tiers) | 3 ripple intensity classes: still / gentle / choppy (CSS keyframe on SVG `<path>` d attribute) |
| Clarity overlay | `organicFraction` | SVG halftone `<pattern>` overlaid on water, opacity = `1 - organicFraction` (clear water = organic, murky = wash-traded) |
| Buoy on surface | coin logo | 28×28 circular image positioned at the waterline, bobs 4px vertical with slow keyframe |
| Ticker label below | `symbol` + `score` | mono font, score in same color band as fill |
| Trend arrow | `tvlChange7d` | small green ↑ / red ↓ next to score, muted if abs < 1% |

Unrated / unobserved coins render as **dry gauges**: empty cylinder with dashed walls and a "--" label, placed in a separate "Dry Docks" row below the main grid. Mirrors today's "Unrated / Not Observed" section.

### Hero: the Global Reservoir

Above the gauge grid, one oversized cylinder (roughly 4× width of the individual gauges) represents global stablecoin DEX TVL. Fill height = normalized global TVL (full cylinder if at all-time high, scaled against a 90d rolling ceiling). Alongside: existing `LiquidityStats` stat blocks — but restyled as **waterproof meter plates**, rounded rectangles with a sealed-gasket border motif.

### Sort & filter controls

- Keep existing peg toggle (All / USD / EUR / GOLD) and search input.
- Add sort toggle above the grid: **Depth** (default, by score), **Volume** (24h), **Clarity** (organic fraction).
- Selection persists to URL query param (reuse `useUrlFilters`).

### Layout

- Above the gauge section: hero reservoir + stat plates row.
- Gauge grid: `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8` matching cemetery's pattern.
- Dry Docks row below, dimmer styling.
- Existing `<LiquidityTable>` is preserved below the gauge grid for dense-data scanning. No change to its markup.

### Mobile (`< md`)

- Gauge grid becomes a horizontal snap-scroll strip (`overflow-x-auto snap-x snap-mandatory`), 3 gauges visible at a time.
- Hero reservoir reduces to a compact card (gauge drawn narrower).
- `LiquidityTable` remains as the dense fallback.

### File changes

- `src/app/liquidity/depth-gauges.tsx` — new. The gauge grid + hero reservoir + sort controls.
- `src/app/liquidity/depth-gauge.tsx` — new. One gauge SVG (reused by grid and hero — size prop: `sm` | `lg`).
- `src/app/liquidity/depth-gauges.css` — new. Keyframes: `ripple-still`, `ripple-gentle`, `ripple-choppy`, `buoy-bob`. All gated on `prefers-reduced-motion: no-preference`.
- `src/app/liquidity/depth-gauges.test.tsx` — new. Tests cover: gauge renders correct fill% for score, coverage-class → color mapping, dry-gauge rendered for unrated rows, sort toggle reorders grid, mobile snap-scroll layout present at `< md`.
- `src/lib/liquidity-ui.ts` — new. `COVERAGE_FILL_CLASSES`, `COVERAGE_TEXT_CLASSES`, `rippleIntensityBand(volume24h)`, `clarityOpacity(organicFraction)`. Parallel to existing `src/lib/chain-ui.ts`.
- `src/app/liquidity/client.tsx` — filter state (peg toggle, search input, new sort) is lifted to `LiquidityClient` and owned there (same `useUrlFilters` bindings as today). `<DepthGauges>` receives the already-filtered `scoredRows` / `unratedRows` and the filter UI elements as props (or renders them from shared state). `<LiquidityTable>` continues to receive the same filtered rows as today — unchanged props, unchanged render. Net: one filter source of truth, two consumers (gauges and table).

## Data integrity

Neither feature introduces new data dependencies. All fields listed above already exist:

- `/chains` uses existing `ChainSummary` fields from `shared/types/chains.ts`.
- `/liquidity` uses existing fields on the `LiquidityRow` type and `DexLiquidityPool.extra` from `shared/types/market.ts` — specifically `liquidityScore`, `coverageClass`, `totalVolume24hUsd`, `organicFraction`, `tvlChange7d`.

If a field is null/undefined, the visual gracefully degrades:

- Missing health band → gray hull + "unrated" label.
- Missing 7d change → no wake, no trend arrow.
- Missing organic fraction → default clarity (no murk overlay).
- Missing score → coin routes to Dry Docks row.

## Testing

Follow existing conventions — unit tests on pure helpers + component tests using the same patterns as `cemetery-client.test.tsx` and `alt-peg-cohort-history-chart.test.tsx`:

**/chains**
- `harbor-map.test.ts` extended: `hullWidth` log-scale monotonic, `cargoBuckets` monotonic non-decreasing, `depthLayers` boundaries, `wakeLength` sign-preserving, `aggregateSkyBand` thresholds.
- New `nautical-chart.test.tsx`: renders 8 ships for top 8 chains in supply-desc order, renders horizon silhouettes for remaining chains, falls back to `HarborList` when viewport `< xl` (test via `matchMedia` mock).

**/liquidity**
- `depth-gauges.test.tsx`: gauge fill % matches score, coverage class → fill class mapping, dry gauge renders for null-score rows, sort toggle reorders rows, peg filter reduces visible gauges.
- `liquidity-ui.test.ts` (new): `rippleIntensityBand` buckets, `clarityOpacity` bounds [0, 1].

## Performance & bundle

- Scene SVGs are static JSX — tree-shaken, no runtime assets. Comparable per-route bytes to cemetery/alt-pegs.
- Animations are CSS-only. Zero JS on the animation path.
- No new deps.
- Lazy-loaded: `/liquidity` already uses `createClientFeaturePage` with dynamic import; `/chains` the same. New components sit inside those boundaries.

## Rollout

Ship incrementally, per the "incremental deployment for multi-source work" rule in the project memory:

1. Land `/chains` nautical chart first — smaller surface, extends existing `buildChainHarborModel`. Monitor for two days: visual regressions on mobile fallback, any layout breaks at xl breakpoints, a11y (screen-reader navigation of the SVG scene via `role="img"` + `aria-label`).
2. Land `/liquidity` depth gauges after.

Both changes are client-only renders of existing worker data — no D1 migrations, no cron changes, no API changes. Standard Pages deploy.

## Documentation

- Update `docs/design-language.md` with the metaphor principle ("draw the metaphor, don't name it") and the encoding-table pattern.
- No methodology version bump — this is pure presentation.

## Out of scope

- `/chains/[chain]/` detail-page metaphor. Candidate for a later pass.
- Per-coin liquidity venue breakdown as pipeline diagrams — hinted at during brainstorming, deferred.
- Animated ship arrival/departure tied to 7d flow. Interesting but risks feeling decorative. Reassess after initial deploy.
