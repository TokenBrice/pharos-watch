# Feasibility

Note: `08-implementation-plan.md` is the current source of truth for v0.1 implementation details. This feasibility note has been reconciled for `/lighthouse/` replacement and desktop-only world scope, but defer to `08` for sequencing.

## Assumptions

- The current target is a full visual replacement of the existing `/lighthouse/` route, not a new `/pharosville/` route.
- `/lighthouse/` may be mined for pure data-adapter ideas only. Its current visual language is explicitly not the target.
- ClaudeVille is the strongest reference for visual and architectural direction: authored isometric world, Canvas 2D renderer, sprite manifest, camera/minimap, DOM side panels, and data-to-place contract.
- The first production version should use existing Pharos public data surfaces. New Worker endpoints should be deferred until a clear performance or payload reason exists.
- The world must remain analytically useful to Pharos users. It can be charming, but every visual cue must answer a real market or risk question.

## Verdict

PharosVille is feasible.

The existing Pharos data model already supports the core concept:

- PSI: `useStabilityIndexDetail()` / `GET /api/stability-index?detail=true`
- Stablecoin list, market caps, prices, peg types, chains: `useStablecoins()` / `GET /api/stablecoins`
- Chain docks and chain sizes: `useChains()` / `GET /api/chains`
- Peg and price health: `usePegSummary()` / `GET /api/peg-summary`
- DEWS stress: `useStressSignals()` / `GET /api/stress-signals`
- Safety/report-card state: `useReportCards()` / `GET /api/report-cards`
- DEX liquidity: `useDexLiquidity()` / `GET /api/dex-liquidity`
- Mint/burn flows: `useMintBurnFlows()` / `GET /api/mint-burn-flows`
- Yield: `useYieldRankings()` / `GET /api/yield-rankings`
- Dead/frozen stablecoins: `DEAD_STABLECOINS` plus `FROZEN_STABLECOINS` machinery documented in `docs/cemetery-and-compare.md`

Current repo scale checked on 2026-04-28:

- Stablecoin metadata entries: 215 total.
- Active stablecoins: 203.
- Pre-launch stablecoins: 11.
- Frozen stablecoins: 1.
- Curated dead stablecoins: 88.
- Merged cemetery entries: 89 when frozen entries are included through `CEMETERY_ENTRIES`.

The biggest feasibility issue is not data availability. It is information design: 215 stablecoins cannot all be individually prominent without making the scene unreadable. The plan must support aggregation, zoom levels, selected detail panels, and a screen-reader/DOM ledger.

## What To Borrow From ClaudeVille

Borrow these patterns:

- Canvas 2D isometric renderer with explicit update/render phases.
- Authored world layout instead of random placement.
- Stable semantic buildings and districts.
- Sprite manifest with asset version cache busting.
- Asset manager with placeholder detection and precomputed alpha masks.
- Camera pan/zoom/follow and minimap.
- Terrain cache; only moving entities/effects redraw every frame.
- Selection in canvas mirrored into DOM detail panels.
- Visual regression capture points.

Do not copy these directly:

- ClaudeVille's desktop-only assumption for the world renderer is acceptable for v0.1 because the user explicitly scoped narrow screens out. PharosVille still needs a polished DOM desktop-only fallback below `1280px` with no canvas/runtime asset work.
- Agent event bus/domain model. Pharos data is pull-query snapshots, not live agent events.
- ClaudeVille-specific building metaphors such as code forge/token mine unless they translate cleanly to stablecoin analytics.
- YAML manifest dependency by default. Pharos can use JSON to avoid adding `js-yaml`.

## Recommended Renderer

Use Canvas 2D, not Pixi/Phaser.

Reasons:

- ClaudeVille proves Canvas 2D is sufficient for this style.
- Pharos already runs strict CSP and should avoid any renderer that depends on eval/shader compilation surprises.
- Canvas 2D lets us keep the route lightweight and dependency-minimal.
- Existing Pharos build/test/visual-regression stack already supports canvas screenshots.

WebGL/Pixi should stay out of scope unless a later prototype proves Canvas 2D cannot hit the needed frame budget.

## Data Visualization Rule Exception

`docs/data-visualization.md` says Pharos narrative visualization modules normally use pure view-models plus SVG/CSS presentation, and explicitly favors SVG over Canvas for existing data volumes. PharosVille should record a deliberate exception to that rule.

Justification:

- The user explicitly wants a ClaudeVille-like world, not a normal metaphor-led chart.
- The interaction model requires map pan/zoom, camera bounds, minimap, sprite depth sorting, terrain caches, hit testing, and many world entities.
- DOM/SVG would likely become heavier and less maintainable for a tile-map world with 200+ ships, 80+ graves, water basins, and sprite layers.

Compensating gates:

- Pure tested world adapter before renderer work.
- DPR and backing-store pixel budget.
- Canvas nonblank and pixel-budget tests.
- DOM ledger/detail parity for every encoded signal.
- Reduced-motion static render.
- Desktop world screenshot plus narrow-screen fallback screenshot.
- Keyboard-equivalent selection and controls.

## Recommended Scope For V1

The first credible version should include:

- A hand-authored island city map with 70% water by tile count.
- Central Pharos lighthouse island.
- Chain docks sized by chain stablecoin TVL.
- Stablecoin boats derived from aggregate data, with clustering when overloaded.
- Peg-risk distance-from-shore encoding.
- Dead stablecoin cemetery district.
- DOM detail panel for selected boats, docks, cemetery entries, and lighthouse.
- Reduced-motion static composition.
- Accessibility ledger for all encoded data.
- Visual regression tests at desktop world and `<1280px` fallback breakpoints.

Defer:

- Fully generated whole-map art.
- Per-coin historical mini-scenes.
- Complex real-time pathfinding.
- Cross-chain transfer simulation unless backed by a real metric.
- New Worker endpoints.

## Static Export Compatibility

Compatible with current Next.js static export constraints:

- Server page renders route metadata and a client component.
- Client component fetches existing APIs through current hooks and same-origin site-data proxy.
- Canvas runtime loads only in browser.
- Public assets live under `public/pharosville/assets/`.
- No server runtime or dynamic route behavior is required.

## API Load Feasibility

V1 can use only aggregate endpoints:

- `/api/stablecoins`
- `/api/chains`
- `/api/stability-index`
- `/api/peg-summary`
- `/api/stress-signals`
- `/api/report-cards`
- optional `/api/dex-liquidity`
- optional `/api/mint-burn-flows`
- optional `/api/yield-rankings`

Avoid per-coin detail/history calls in the world view. Link to stablecoin detail pages for deep inspection.

Initial route load should stay conservative:

- Required at load: stablecoins, chains, PSI, peg summary, DEWS, report cards.
- Lazy or phase in: DEX liquidity, mint/burn flows, yield rankings, depeg event history.

Direct browser fetches must use the existing frontend helpers, which route public reads through same-origin `/_site-data/*` in production/preview. Do not call `https://api.pharos.watch` directly from the browser route because public API routes are API-key protected on that host.

## Data Correctness Constraints

- Build ship entities only from active stablecoins: require `ACTIVE_IDS.has(asset.id)`, `ACTIVE_META_BY_ID.get(asset.id)`, and `asset.frozen !== true`.
- Frozen assets must belong to `CEMETERY_ENTRIES`, not to active ship rendering.
- Use `getCirculatingRaw(asset)` for market cap. DefiLlama list-endpoint values are already USD-denominated; do not multiply by price.
- Use `canonicalizeChainCirculating()` or `findCanonicalChainData()` for chain supply. Do not read raw chain keys directly.
- Use `buildPegSummaryCoinMap()` and a report-card lookup once in the adapter instead of repeatedly scanning arrays.
- For MVP active-depeg state, rely on `pegSummary.coins[].activeDepeg`. The repo hook is `useInfiniteDepegEvents()`, not `useDepegEvents()`, and active-only depeg loading would require an intentional hook/API-path extension.

## Main Challenges

1. Visual overload: 215 stablecoins plus chains, cemetery, risk signals, and activity layers.
2. Semantics: a beautiful map that does not improve market understanding would fail the product goal.
3. Narrow screens: v0.1 must avoid initializing the world below `1280px` and present a clear desktop-only fallback.
4. Asset consistency: generated pixel assets need a manifest and validation loop.
5. Accessibility: canvas cannot be the only source of truth.
6. Performance: large canvases, DPR, sprite loading, and animation need guardrails.
7. Product fit: the page must preserve Pharos's precise, vigilant dashboard identity while allowing a richer visual metaphor.
