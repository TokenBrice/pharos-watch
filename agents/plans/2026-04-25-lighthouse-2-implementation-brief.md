# Lighthouse-2 Implementation Brief

Date: 2026-04-25
Scope: Separate `/lighthouse-2/` concept variant. Do not modify the current `/lighthouse/` route while this variant is being built.

## Assumptions

- `/lighthouse-2/` is a sibling concept route, not a replacement for `/lighthouse/`.
- Use existing data only: `useChains()`, `useStabilityIndexDetail()`, `useStressSignals()`, and `useStablecoins()`.
- Keep the primary stage free of visible explanatory prose. Exact facts live in the accessible ledger, SVG titles, aria labels, and any route chrome outside the stage.
- Preserve Pharos visualization rules from `docs/data-visualization.md`: pure view-model first, SVG scene, token-backed data colors, reduced-motion support, and screen-reader feature parity.
- The revised vibe is fantasy naval exploration with steampunk instruments, not sci-fi: brass, etched chartwork, sea fog, compass geometry, expedition islands, and a watchtower beacon.

## Visual Metaphor

Build a top-down/isometric "Pharos Expedition Chart": a living sea chart viewed from above, with the PSI lighthouse at the center and four data territories arranged as navigable islands.

- Central object: an old stone lighthouse on a crag, drawn in 2.5D isometric SVG. The lamp is the PSI state. It is a guide beacon, not a dashboard score.
- Chain Harbors: ports and anchored ships around the main coastline. Chains are harbors; stablecoin deployments are cargo; concentration is draft/depth; 7d movement is wake.
- DEWS: a brass storm-glass compass, not a futuristic radar. Rings and storm marks retain DEWS band semantics while reading as navigation/weather instrumentation.
- Alt-Peg Map: far archipelago and cartographer's inset map. Peg cohorts are islands, coin marks are settlements or seals, and gold/silver/index cohorts sit as celestial navigation emblems.
- World tone: dark sea green/ink water, muted copper/verdigris/brass, warm lamp light, restrained semantic risk colors. Avoid neon blue/purple glow, hologram panels, scanlines, glassmorphism, and full-stage blur.

The memorable image should be "a fantasy navigator's table that happens to be live Pharos data," not "a spaceship command center."

## Layout And World Map

Use a fixed SVG viewBox, preferably `1600x1000` or `1920x1080`, with `preserveAspectRatio="xMidYMid meet"` so the isometric geometry does not stretch.

- Center: PSI lighthouse on a rocky island, slightly below true center so its beam can reach all territories.
- West/southwest: Chain harbor belt, capped at the largest 8 harbors plus a tail flotilla.
- Northeast: DEWS storm compass island, compact and visually secondary until selected.
- Southeast: Alt-peg archipelago inset, using existing alt-peg market sizing and peg colors.
- North/northwest: PSI lens machinery and component shutters integrated into the lighthouse grounds, not as a separate futuristic machine.
- Edges: decorative cartographic sea marks, shoals, contour lines, and route arcs. These are `aria-hidden` and carry no new data.

World position is layout, not a metric. Document this in tests/aria, and do not imply geographic chain placement.

## Modules And Islands

Recommended file structure for implementation:

```text
src/app/lighthouse-2/
  page.tsx
  client.tsx
  expedition-model.ts
  expedition-stage.tsx
  expedition-stage.css
  lighthouse-2-a11y-ledger.tsx
  layers/
    chart-atmosphere-layer.tsx
    expedition-tower-layer.tsx
    chain-harbor-layer.tsx
    storm-compass-layer.tsx
    alt-peg-archipelago-layer.tsx
    stage-controls-layer.tsx
  __tests__/
    expedition-model.test.ts
    expedition-stage.test.tsx
```

Implementation should borrow data helpers, not visual layers, from existing modules:

- Chain harbors: `buildChainHarborEntries`, `hullWidth`, `cargoCapacityForHull`, `depthLayers`, `wakeLength`, `aggregateSkyBand`.
- PSI: `PSI_HEX_COLORS` and current PSI component fields.
- DEWS: `computePositions`, `computeBandCounts`, `highestBand`, `sweepDuration`, `THREAT_BAND_HEX`.
- Alt-pegs: `buildPegDiversityHero`, `coinEmblemSize`, `FIAT_MAP_SIZE_CEIL`, `SKY_COHORT_SIZE_CEIL`, and peg color outputs.

Do not import or reuse the current `/lighthouse/` stage component. The whole point of lighthouse-2 is a different visual language and lower motion budget.

## Data-To-Visual Encodings

### Chain Harbors

- Harbor order: descending tracked chain supply, same visible cap as `/lighthouse/`.
- Island/ship footprint: `log10`/existing `hullWidth(totalUsd, maxUsd, cap)`.
- Cargo count: existing hull capacity from `cargoCapacityForHull`.
- Harbor color: `HEALTH_HEX_FILL[healthBand]`; neutral fallback for unrated.
- Pennant or harbor flag width: dominant stablecoin share.
- Draft rings under hull: `depthLayers(dominantShare)`.
- Wake ribbon direction/length: sign and magnitude of 7d supply change via `wakeLength`.
- Tail flotilla: aggregate remaining chains as small distant lantern boats, with one ledger row carrying exact remaining count/share.

### PSI Lighthouse

- Lamp color: `PSI_HEX_COLORS[band]`, not a local palette.
- Beam reach/visibility circle: clamped PSI score, same polarity as PSI lighthouse: higher score means clearer/longer guidance.
- Lantern aperture: score ratio with explicit floor/ceiling.
- Four shutters or brass lens petals: severity, breadth, stress breadth, and trend component magnitudes.
- Beam target: selected module or selected harbor. No continuous sweep in the default state.
- No new lighthouse score. PSI powers the lamp; it does not create a fifth aggregate metric.

### DEWS Storm Compass

- Highest band: compass/storm-glass accent color from `THREAT_BAND_HEX`.
- Band counts: concentric etched rings or storm-front arcs, using existing band count output.
- Elevated coins: storm flags/cloud pips positioned with existing DEWS radial logic; score controls distance, band controls color and size.
- Calm density: quiet stippling around the compass rim, not animated shimmer.
- Keep DEWS aggregate-only. Do not draw causal lines from DEWS marks to chain harbors.

### Alt-Peg Archipelago

- Peg clusters: island groups from `buildPegDiversityHero`.
- Coin size: existing `coinEmblemSize(marketCap)` with floors/ceilings.
- Peg color: existing alt-peg/peg color output; no local category colors.
- Gold/silver/index cohorts: celestial navigation seals or chart-margin emblems, still sized by market cap.
- Limit visible detail to keep the inset readable; exact counts go to the ledger.

## Interaction Model

- Route client owns mode, selected harbor, preview harbor, and selected module.
- Stage receives a complete pure model and callbacks only.
- Fine pointer: hover/focus previews a harbor or module; click commits.
- Coarse pointer: tap previews, second tap commits if the same mark is tapped again.
- Keyboard: primary marks are `role="button"` with `tabIndex={0}`; Enter/Space commits; focus mirrors hover preview.
- Mode controls remain icon-only with accessible labels. Prefer a compass/spyglass/harbor/radar/map icon set over visible text controls.
- Beam changes target on preview/selection with a short transition only; no idle beam rotation.
- Auto-cycle is off by default. If retained, it must be opt-in inside the model contract, pause after any user action, and stop under reduced motion.

## Performance Constraints

- SVG only. No Three.js, canvas, React animation libraries, JS `requestAnimationFrame`, DOM measurement loops, or animated SVG filters.
- Default first paint is static. Limit infinite CSS animations to at most one tiny lamp shimmer, and only inside `prefers-reduced-motion: no-preference`.
- Avoid full-stage `filter`, `blur`, `drop-shadow`, `mix-blend-mode`, and `backdrop-filter`. Use flat layered fills, strokes, and small local highlights.
- Keep data marks capped: 8 harbors, <=18 tail lights, <=20 elevated DEWS marks, <=12 alt-peg clusters, <=5 visible coins per cluster/cohort.
- Model output must be deterministic. Seed any decorative jitter from stable ids, never `Math.random()`.
- Use `useMemo` for model construction in the client; no layer-level data transforms beyond simple rendering loops.
- Acceptance budget: desktop and mobile screenshots should show a nonblank, fully framed scene; idle CPU should not visibly spike; interaction should stay responsive on a mid-range laptop.

## Reduced Motion

Reduced motion is a first-class visual state:

- Disable lamp shimmer, route glints, wake drift, compass motion, and any auto-cycle.
- Keep the selected beam, compass rings, wakes, and all marks visible with static opacity.
- Replace animated attention with static emphasis: selected module outline, selected harbor focus ring, and beam target.
- CSS must include explicit `@media (prefers-reduced-motion: reduce)` rules that set `animation: none !important` and leave no element invisible.

## Accessibility Ledger

Preserve a route-local ledger equivalent to `LighthouseA11yLedger`.

Required rows:

- selected harbor: name, supply, chain share, health band, dominant cargo, 7d wake
- PSI lighthouse: score, band, component values, freshness if available
- DEWS storm compass: highest band and band counts
- alt-peg archipelago: visible marks, top cohorts, market-cap sizing caveat
- visible harbor list: one list item per harbor with the same facts as the interactive aria label

SVG requirements:

- root `role="img"` and a stateful `aria-label`
- decorative chartwork `aria-hidden="true"`
- primary marks expose `aria-label`, `aria-pressed` where selected, and keyboard activation
- stage may include SVG `<title>` elements, but no visible explanatory prose inside the stage

## Implementation Acceptance Criteria

- `/lighthouse-2/` is implemented as a separate route; `/lighthouse/` is unchanged except for optional navigation/docs work explicitly approved later.
- First paint reads as a fantasy/nautical/steampunk overhead chart, not a sci-fi control room.
- The stage contains no visible explanatory prose, cards, captions, or paragraph copy.
- All data channels use existing Pharos data and existing token maps; no new scoring, methodology, API, or collection path is introduced.
- View-model tests cover monotonic size/reach behavior, floors/ceilings, null/NaN clamps, deterministic layout, visible caps, and ledger rows.
- Scene tests cover SVG role/label, no visible stage prose selectors, keyboard/click callbacks, reduced-motion class/attribute behavior, and token color usage.
- Browser checks cover desktop, mobile, and reduced-motion screenshots.
- Performance review confirms no JS animation loops, no full-stage filter/backdrop use, and a small bounded DOM mark count.
- If the route becomes public, update `docs/lighthouse-page.md` or create `docs/lighthouse-2-page.md`, then update the docs index/sitemap/nav surfaces according to the existing docs rules.

## Risks

- The fantasy/steampunk direction can become decorative. Keep every prominent object tied to a data channel or make it subdued atmospheric chartwork.
- Top-down/isometric layout can imply geography. Make layout deterministic and categorical, and keep geography claims out of the ledger.
- Reusing current `/lighthouse/` visual layers would carry over the sci-fi feel and animation cost. Reuse data helpers only.
- Removing visible prose from the stage raises discoverability risk. The accessible ledger and icon labels must be complete, and optional detail outside the stage may be needed after usability review.
- Current `/lighthouse/` files are actively changing in the worktree. Build lighthouse-2 route-local files to avoid merge conflicts.
