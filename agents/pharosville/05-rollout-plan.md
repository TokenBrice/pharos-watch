# Rollout Plan

Note: `08-implementation-plan.md` supersedes this earlier rollout plan for v0.1 sequencing. This file remains useful as background, but implementation should follow `08`.

## Phase 0 — Product Contract And Prototype Fixtures

Goal: lock the semantic contract before rendering complexity.

Deliverables:

- `agents/pharosville/` research pack.
- Route decision: replace the existing `/lighthouse/` visual experience; keep `/lighthouse/` as the public URL for v0.1.
- Written world model and data mappings.
- Fixture dataset covering:
  - healthy top stablecoin.
  - active/degraded peg state.
  - several chain sizes.
  - dead stablecoin entries.
  - stale/degraded data.
  - overloaded long-tail set.

Validation:

- Stakeholder review of mapping.
- No product code required.

Exit criteria:

- Agreement that the visual grammar answers real Pharos questions.

## Phase 1 — Pure World Adapter

Goal: convert existing Pharos data into a deterministic world snapshot.

Files:

- `src/app/lighthouse/systems/world-types.ts`
- `src/app/lighthouse/systems/pharosville-world.ts`
- `src/app/lighthouse/systems/layout.ts`
- `src/app/lighthouse/systems/clustering.ts`
- tests beside these modules

Inputs:

- stablecoins
- chains
- stability index
- peg summary
- stress signals
- report cards
- static cemetery data

Required data rule:

- Build all ship entities from stablecoin `chainCirculating` so the full active set is represented.
- Treat chain `topStablecoins` as summary/decorative data only.
- Exclude frozen/pre-launch/non-active assets from active ships.
- Use `CEMETERY_ENTRIES` for graves.
- Use `getCirculatingRaw()` and chain-circulating helpers.

Subtasks:

1. Input normalization:
   - active/frozen universe split.
   - peg-summary/report-card maps.
   - shared supply and chain-circulating helpers.
2. Risk placement:
   - `resolveShipRiskPlacement()` with explicit precedence and tests.
3. Ship clustering:
   - zoom-level policies and max visible/selectable counts.
4. Layout invariants:
   - water ratio, dock positions, cemetery area, no major overlaps.
5. Detail models:
   - lighthouse, dock, ship, cluster, grave.

Deliverables:

- `buildPharosVilleWorld(inputs): PharosVilleWorld`
- deterministic placement and clustering
- water ratio/layout invariants
- ship style and risk placement policy
- detail models for all selectable entities

Validation:

- `npx vitest run src/app/lighthouse/systems`
- adapter tests for missing/stale inputs
- overloaded dataset test with 215+ active assets
- fixture cases for null PSI current, unknown bands, stale report cards, missing DEWS, frozen assets in stablecoins payload, NAV tokens, and low price confidence

Exit criteria:

- Data contract is stable without any canvas.

## Phase 2 — Route Shell And Placeholder Canvas

Goal: make the page real with code-drawn placeholder visuals.

Files:

- `src/app/lighthouse/page.tsx`
- `src/app/lighthouse/client.tsx`
- `src/app/lighthouse/desktop-only-fallback.tsx`
- `src/app/lighthouse/pharosville-world.tsx`
- `src/app/lighthouse/pharosville.css`
- `src/app/lighthouse/renderer/*`
- `src/app/lighthouse/components/*`

Deliverables:

- route metadata and breadcrumb
- desktop viewport gate before client queries
- loading/error/freshness notices
- Canvas 2D render loop
- camera pan/zoom
- central lighthouse placeholder
- authored island/water map
- chain docks and placeholder ships
- cemetery placeholder
- DOM detail panel
- accessibility ledger

Validation:

- unit tests for projection/hit testing
- Playwright canvas nonblank check at `>=1280px`
- Playwright fallback/no-canvas/no-query/no-manifest check below `1280px`
- manual browser review
- `npm run lint`
- `npm test`

Exit criteria:

- The page is usable and data-bound before final art.

## Phase 3 — Interaction And Clustering

Goal: make the world inspectable under realistic data load.

Deliverables:

- click/hover hit testing for lighthouse, docks, ships, clusters, graves
- filters for risk band, chain, type, and top/cluster mode
- selected detail panel
- minimap
- keyboard entity list
- reduced-motion static composition
- long-tail ship clustering
- zoom-dependent label policy

Validation:

- selection unit tests
- accessibility smoke with keyboard path
- overloaded 215+ entity fixture
- desktop world screenshot and `<1280px` fallback screenshot

Exit criteria:

- Users can inspect exact data without canvas clutter.

## Phase 4 — Asset Manifest And Pixellab V1 Art

Goal: replace placeholders with consistent static sprites.

Deliverables:

- `public/pharosville/assets/manifest.json`
- asset manager
- sprite renderer
- first production asset set:
  - water/deep water/shore/cobble/grass
  - lighthouse
  - generic dock and 3-5 chain dock variants
  - 4-6 boat classes
  - tombstones and cemetery gate
  - risk/status overlays
- `scripts/pharosville/validate-assets.mjs`

Validation:

- asset validator
- `file` or PNG dimension checks
- visual screenshot baselines
- no checkerboard placeholders

Exit criteria:

- The page has a coherent ClaudeVille-level visual identity with Pharos-specific symbols.

## Phase 5 — Motion And Market Effects

Goal: add purposeful motion that explains state.

Deliverables:

- lighthouse beam/flame state
- ship bobbing and limited route motion
- risk-zone wave/weather effects
- cargo flow effects for mint/burn, if enabled
- DEX liquidity crane/channel effects, if enabled
- reduced-motion fallback
- motion budget constants and tests

Validation:

- reduced-motion screenshot deterministic
- normal-motion manual review
- performance profiling on mid-tier laptop

Exit criteria:

- Motion highlights risk/activity without visual noise.

## Phase 6 — Documentation, SEO Decision, And Beta Launch

Goal: integrate cleanly with Pharos docs and release process.

Deliverables:

- rewrite `docs/lighthouse-page.md` as the PharosVille route contract
- update `docs/architecture.md`
- update docs index if required
- sitemap/robots decision:
  - beta: `noindex,follow`
  - stable public: indexable with canonical `/lighthouse/` unless a later route migration is approved
- visual test docs
- changelog entry if public-facing
- beta gate:
  - route may exist but stays unlinked from primary nav until Phase 4/5 visual quality, accessibility, and performance gates pass.
  - if publicly reachable before then, use `noindex,follow`.
  - primary navigation link requires final accessibility/performance/visual pass.

Validation:

- `npm run build`
- `npm run seo:check` if indexable
- `npm run lint`
- `npm test`
- `npm run test:merge-gate`

Exit criteria:

- Page is shippable without undocumented behavior or unverified assets.

## Phase 7 — Post-MVP Enhancements

Candidate enhancements:

- selected dependency graph route lines
- richer chain dock variants for top 10 chains
- daily snapshot playback
- share image generation
- "storm mode" focused on active depeg/DEWS events
- guided tour from existing Pharos concepts
- more detailed cemetery close-up view
- live data freshness bell / city notice board

Only add these after v1 proves the world model is useful.
