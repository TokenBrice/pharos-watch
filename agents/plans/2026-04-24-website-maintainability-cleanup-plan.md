# Website Maintainability Cleanup Plan

Date: 2026-04-24
Scope: website frontend only: `src/app`, `src/components`, `src/hooks`, `src/lib`, `src/styles`, and static website assets. `worker/`, Worker API handlers, and API behavior are out of scope.

## Assumptions

- The goal is maintainability, code cleanliness, mutualization, and dead-code reduction without product redesign.
- No intentional frontend rendering or behavior change should ship unless explicitly called out below.
- API contracts, Worker runtime behavior, scoring methodology, and data-source semantics are out of scope.
- Existing design-system patterns should be preserved. Refactors should move code, not redesign surfaces.

## Success Criteria

- Website source becomes easier to review by reducing route/client hotspots, local wrappers, and repeated UI plumbing.
- Repeated logic is replaced by existing local primitives where practical, not by broad new abstractions.
- Detectable dead code remains at zero under the repo guardrails.
- Any visual impact is either `none` or limited to exact-preserving component extraction validated by screenshots/build checks.
- Each implementation slice is independently reviewable and revertible.

## Current State Evidence

- `npm run check:unused-code`: passed, with no dead internal modules or unused named exports.
- `npm run check:hotspot-ratchet`: passed.
- `npm run check:shared-cycles`: passed for `shared`, `worker/src`, and `src`.
- `npm run check:duplicate-exports`: passed.
- Current website surface is broad: 50 `src/app/**/page.tsx` files, 251 non-`ui` component source files, and 148 hook/lib source files under `src/hooks` and `src/lib`.
- Largest website hotspots found in the current tree include:
  - `src/app/chains/nautical-chart.tsx`: 1250 lines.
  - `src/components/dex-liquidity-card.tsx`: 667 lines.
  - `src/components/kpi-bar.tsx`: 617 lines.
  - `src/app/portfolio/client.tsx`: 585 lines.
  - `src/components/pre-launch-detail.tsx`: 557 lines.
  - `src/components/contagion-graph.tsx`: 553 lines.
  - `src/components/command-palette.tsx`: 502 lines.
  - `src/components/stablecoin-detail/hero-card.tsx`: 474 lines.
- The prior query-contract refactor has already landed in part: `getPollingWindow()` exists, canonical query option builders exist for supply history, mint/burn per-coin flows, DEX history, safety history, and depeg events, and `useCompareDataModel()` / `usePrefetchStablecoin()` now reuse them.

## Plan-Wide Reviewer Constraints

- Every `visual impact: none` frontend refactor must be either pure import indirection with unit proof, or it must include before/after screenshots plus targeted interaction checks for the touched route/control.
- Screenshot baseline for visible P1/P2 slices: mobile `390x844` and desktop `1280x900`. Capture only affected routes, with likely targets `/`, `/chains/`, `/stablecoin/usdc-circle/`, `/stablecoin/usdt-tether/`, `/liquidity/`, `/depeg/`, `/blacklist/`, and chart-specific routes such as `/yield/` or `/cemetery/` when touched.
- The local UI smoke command requires a served static export. For local visual-smoke validation, run `npm run build`, then serve the artifact with `npm run serve:static-export`, then run `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local`.
- Hotspot decomposition slices must run `npm run check:hotspot-ratchet`. If the target materially shrinks, run `npm run check:hotspot-ratchet:update-baseline` and update or remove matching `scripts/lib/hotspot-ratchet-waivers.json` entries in the same slice.
- Use one commit per numbered implementation slice. Commit hotspot baseline/waiver updates with the hotspot they describe.
- Docs are only updated when behavior, route contracts, methodology content, or documented design conventions change. For visible route work, re-check the relevant route doc and `docs/design-language.md` / `docs/design-tokens.md` if classes/tokens move.

## Main Opportunities

### 0. Fix query-contract correctness before UI mutualization

Files:

- `src/hooks/use-blacklist-events.ts`
- `src/lib/blacklist-api.ts`
- `src/app/blacklist/view-model.ts`
- `src/hooks/api-hooks.ts`
- `src/hooks/use-prefetch-stablecoin.ts`
- `src/components/stablecoin-detail/safety-score-history-section.tsx`

Finding:

- Blacklist event fetch params include `sortBy` and `sortDirection`, but the current blacklist events query key does not include those fields. Sort changes can therefore reuse cached rows for a previous ordering.
- `useSafetyScoreHistory()` uses the meta-envelope query helper for key `["safety-score-history", id, days]`, while `safetyScoreHistoryQueryOptions()` uses a bare response shape for the same key. Hover prefetch can poison the detail-page cache with the wrong envelope.
- Both issues are website-side query/cache correctness risks and should land before visual filter/search refactors.

Plan:

1. Add `sortBy` and `sortDirection` to the blacklist events query key, preserving all existing params and request paths.
2. Add or update hook tests to prove changing blacklist sort fields changes the query key.
3. Make `safetyScoreHistoryQueryOptions()` match the consuming hook response shape, or give prefetch a distinct key if the bare shape is intentionally retained.
4. Add a regression test proving safety-history prefetch options and `useSafetyScoreHistory()` share both key and response-envelope expectations.

Visual impact: none for layout. Visible data impact is positive: sorted blacklist rows and grade-history prefetch should no longer show stale/missing data.

Behavior impact: intended query-cache correctness fix; no API contract change.

Validation:

```bash
npm test -- src/hooks/__tests__/query-option-builders.test.ts src/hooks/__tests__/use-safety-score-history.test.ts src/app/blacklist/view-model.test.tsx
npm run typecheck
npm run check:unused-code
```

Priority: P0, correctness before cleanup.

### 1. Remove the remaining supply-history compatibility shim

Files:

- `src/hooks/use-stablecoin-detail-history.ts`
- `src/components/total-mcap-chart.tsx`

Finding:

- `useStablecoinDetailHistory()` is now only a one-line wrapper around `useSupplyHistory()`.
- The wrapper is still referenced by `TotalMcapChart`, so `check:unused-code` correctly does not flag it.
- This is small dead abstraction rather than dead module code.

Plan:

1. Replace `useStablecoinDetailHistory()` imports with `useSupplyHistory()`.
2. Delete `src/hooks/use-stablecoin-detail-history.ts`.
3. Keep the same default history window and query key behavior by using the existing hook directly.
4. Do not generalize this into a thin-hook deletion pass. Hooks such as `useLogos()` can still be valid result-shape adapters.

Visual impact: none.

Behavior impact: none intended. This removes one import layer over the same hook.

Validation:

```bash
npm test -- src/lib/__tests__/total-mcap-chart.test.ts
npm run check:unused-code
npm run typecheck
```

Priority: P0, safe quick win.

### 2. Decompose website hotspots along existing seams

Files:

- `src/app/chains/nautical-chart.tsx`
- `src/components/kpi-bar.tsx`
- `src/components/dex-liquidity-card.tsx`
- `src/components/command-palette.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/contagion-graph.tsx`
- `src/lib/contagion-layout.ts`

Finding:

- These are the most relevant current frontend hotspot targets after earlier refactors.
- Several already have adjacent view-model/helper files, so the right move is decomposition, not new architecture.
- The hotspot ratchet has explicit waivers for the chains scene, KPI strip, command palette, DEX liquidity card, and stablecoin detail hero.

Plan:

1. `nautical-chart.tsx`: split exact-rendering SVG primitives into adjacent modules:
   - `nautical-lighthouse.tsx`
   - `nautical-ship.tsx`
   - `nautical-background.tsx`
   - `nautical-scene-constants.ts`
   Keep `nautical-chart.tsx` as the data/model-to-scene composition shell. Keep shared `<defs>`, CSS import, viewport constants, selection state, focus/keyboard handlers, and ARIA ownership in the shell; extracted modules should return exact `<g>` fragments and receive geometry/constants as props.
2. `kpi-bar.tsx`: keep `kpi-bar-view-model.ts` as the data derivation authority, then extract:
   - chip primitives
   - primary PSI card
   - desktop grid
   - mobile tile grid
   Do not alter query cadence or top-fold layout.
3. `dex-liquidity-card.tsx`: split into:
   - score/health summary block
   - pool table
   - TVL trend chart
   - breakdown sections
   Keep `dex-liquidity-card-model.ts` as the text/model helper authority.
4. `command-palette.tsx`: split:
   - pure result/search builder
   - pure action descriptor builder
   Keep dialog rendering, global listeners, focus capture/restoration, selected-index state, scroll-into-view, and keyboard navigation in the component until component-level interaction tests exist.
5. `hero-card.tsx`: extract a pure `buildHeroCardModel()` helper for derived display values, leaving the component as composition over existing `hero-card-*` presentational modules. The helper should return serializable scalars, booleans, hrefs, and class names only; keep React nodes, badges, and `MethodologyLabel` usage in the presentation layer.
6. `contagion-graph.tsx`: add a dedicated slice for the still-large graph renderer. Split legend/controls, SVG node-edge renderer, and selected/hover model around the existing `contagion-graph-graph.ts`, `contagion-graph-model.ts`, and `contagion-graph-tooltips.tsx` seams. Treat `src/lib/contagion-layout.ts` as a separate layout-engine cleanup unless the renderer split exposes an exact low-risk helper.

Visual impact: none intended, but risk varies by surface. SVG/chart/card/graph extraction can create pixel drift if props/classes move incorrectly, so screenshot or smoke checks are required for the chains scene, homepage top fold, stablecoin detail hero, contagion graph, and DEX liquidity card.

Behavior impact: none intended. Command palette and contagion graph have keyboard/focus/selection behavior risk even with no visual change.

Validation:

```bash
npm run check:hotspot-ratchet
npm run typecheck
npm test -- src/components/__tests__/kpi-bar.test.tsx src/components/__tests__/dex-liquidity-card.test.tsx src/components/stablecoin-detail/__tests__/hero-card.test.tsx
npm test -- src/app/chains/nautical-chart.test.tsx src/components/__tests__/contagion-graph.test.tsx src/components/__tests__/contagion-graph-graph.test.ts src/hooks/__tests__/use-command-palette-history.test.ts
npm run build
```

Priority: P1, best maintainability payoff.

### 3. Decompose coverage and portfolio route/model hotspots

Files:

- `src/lib/coverage.ts`
- `src/app/coverage/client.tsx`
- `src/app/coverage/coverage-page-sections.tsx`
- `src/app/portfolio/client.tsx`
- `src/hooks/use-portfolio.ts`
- `src/lib/portfolio-analysis.ts`

Finding:

- `src/lib/coverage.ts` is a large `src/lib` hotspot that mixes feature definitions, status presets, status resolvers, row construction, and summary breakdown logic.
- `src/app/portfolio/client.tsx` is one of the largest route clients and owns editor state, presets, parsing/formatting, share/toast behavior, summary cards, exposure rendering, and held-card rendering.
- Both are better explicit maintainability targets than broad static-page extraction.

Plan:

1. Split coverage model data from coverage derivation:
   - `coverage-features.ts`
   - `coverage-status-presets.ts`
   - `coverage-resolvers.ts`
   Keep row/summary assembly in `coverage.ts` until the split is validated.
2. Extract portfolio presentation sections without changing URL/storage semantics:
   - `PortfolioHoldingsEditor`
   - `PortfolioRiskSummary`
   - `PortfolioExposureSection`
   Move parse/format helpers only if tests cover URL, storage, and live-state invariants.

Visual impact: low for coverage labels/counts, medium for portfolio layout and warnings.

Behavior impact: none intended. Coverage status labels and portfolio persistence must remain equivalent.

Validation:

```bash
npm test -- src/lib/__tests__/coverage.test.ts src/app/coverage/coverage-filtering.test.ts src/app/portfolio/client.test.tsx src/hooks/__tests__/use-portfolio.test.ts src/lib/__tests__/portfolio-analysis.test.ts
npm run typecheck
npm run check:hotspot-ratchet
npm run build
```

Priority: P1/P2. Coverage is P1 if touching coverage work; portfolio is P2 because visual/layout drift risk is higher.

### 4. Factor taxonomy hub boilerplate into descriptors

Files:

- `src/app/stablecoins/backing/page.tsx`
- `src/app/stablecoins/governance/page.tsx`
- `src/app/stablecoins/infrastructure/page.tsx`
- `src/app/stablecoins/backing/[backing]/page.tsx`
- `src/app/stablecoins/governance/[governance]/page.tsx`
- `src/app/stablecoins/infrastructure/[infrastructure]/page.tsx`
- `src/components/stablecoin-taxonomy-hub.tsx`
- `src/components/stablecoin-taxonomy-page.tsx`
- `src/lib/stablecoin-taxonomy.ts`

Finding:

- The shared hub/page components already exist, but each route still repeats metadata, breadcrumb item construction, static params, missing-page labels, and route-specific names.
- The dynamic slug routes already use `src/lib/static-slug-page.ts`; the remaining duplication is mostly hub metadata/props plus small route entrypoint differences.

Plan:

1. Add a `StablecoinTaxonomyHubRouteConfig` table for backing, governance, and infrastructure.
2. Use it to build hub metadata and `StablecoinTaxonomyHub` props.
3. Keep slug routes on the existing `static-slug-page.ts` helpers unless extending the descriptor also covers `/stablecoins/[peg]/` and `src/lib/peg-taxonomy.ts` cleanly.
4. Keep the route files as thin Next entrypoints because Next still needs route-local exports.
5. Confirm generated titles/descriptions/canonicals are byte-for-byte equivalent unless an existing inconsistency is intentionally documented.

Visual impact: none.

Behavior impact: none intended. SEO metadata should remain equivalent.

Validation:

```bash
npm run typecheck
npm test -- src/lib/__tests__/stablecoin-taxonomy.test.ts src/app/stablecoins
npm run build
npm run seo:check
```

Priority: P2, low-risk drift reduction but less urgent than current hotspots/query correctness.

### 5. Standardize repeated route filter/search controls without changing state semantics

Files:

- `src/app/depeg/client.tsx`
- `src/app/liquidity/client.tsx`
- `src/app/blacklist/client.tsx`
- `src/app/blacklist/view-model.ts`
- `src/components/filter-bar.tsx`
- `src/components/blacklist-filters.tsx`
- `src/components/yield-leaderboard-controls.tsx`
- `src/components/peg-heatmap.tsx`

Finding:

- Search input + icon + URL-param sync + analytics appears in several route clients.
- Toggle-group filter controls repeat dense mobile hit-target classes and label patterns.
- Semantics differ in important ways: liquidity search is deferred/debounced, depeg search writes immediately, blacklist search is debounced in the route view model.

Plan:

1. Extract only visual/control primitives first:
   - `FilterSearchInput`
   - `FilterToggleGroup`
   - optional `FilterToolbarRow`
2. `FilterSearchInput` must be a controlled visual wrapper only. Callers keep `value`, `onChange`, debounce, analytics, URL behavior, and route-specific `className`.
3. Do not centralize URL or debounce behavior in the first pass.
4. Move only shared search icon layout and opt-in mobile hit-target classes into primitives.
5. Before any later URL/debounce hook extraction, add route-state tests for depeg immediate URL write, liquidity deferred/debounced write, blacklist debounce plus page reset, and explicit expected behavior for literal `q=all`.

Visual impact: none intended, but controls are visible. Exact class preservation is required.

Behavior impact: none in the first pass. A later debounce hook would be behavior-sensitive and should be separate.

Validation:

```bash
npm test -- src/app/blacklist/view-model.test.tsx src/app/depeg/page.test.tsx src/hooks/__tests__/use-depeg-events.test.tsx src/components/__tests__/depeg-table-logic.test.ts src/components/__tests__/table-toolbar.test.tsx
npm test -- src/lib/liquidity-ui.test.ts src/components/__tests__/liquidity-table-logic.test.ts src/components/__tests__/liquidity-table.test.ts src/components/__tests__/liquidity-stats.test.ts
npm run typecheck
npm run build
```

Priority: P2, useful but must avoid over-abstracting different filter semantics.

### 6. Finish exact-match chart primitive adoption

Files:

- `src/components/chart-primitives.tsx`
- `src/components/dex-liquidity-card.tsx`
- `src/components/yield-history-chart.tsx`
- `src/components/stablecoin-detail/blacklist-detail-chart.tsx`
- `src/components/yield-scatter-plot.tsx`

Finding:

- `chart-primitives.tsx` already centralizes common Recharts axes, grid, and tooltip styles.
- Many charts already use it, but several visible charts still inline mono tick styles, grid props, and tooltip styles.
- Not all charts are exact matches; cemetery and yield charts have bespoke needs.

Plan:

1. Convert only exact-match axis/grid/tooltip cases first.
2. Treat a conversion as exact-match only when every Recharts prop is identical or explicitly passed through, including `fontSize`, `tickMargin`, `minTickGap`, date value shape, tooltip formatter, and grid dash pattern.
3. Add narrow props to `chart-primitives.tsx` only when two or more existing charts need the same option.
4. Leave one-off artistic/cemetery styling alone unless preserving bespoke memorial styling is proven route-by-route.

Visual impact: low but non-zero. Axis tick spacing and tooltip defaults can visibly drift.

Behavior impact: none intended.

Validation:

```bash
npm test -- src/components/__tests__ src/lib/__tests__/chart-utils.test.ts src/lib/__tests__/chart-time-range.test.ts
npm run build
npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
```

Run `npm run serve:static-export` in a separate shell before the local smoke command.

Priority: P2, incremental cleanup.

### 7. Extract static content/config from large static pages

Files:

- `src/app/about/page.tsx`
- `src/app/telegram/page.tsx`
- `src/app/methodology/**`
- `src/components/pre-launch-detail.tsx`
- `src/components/funding/funding-page-sections.tsx`

Finding:

- Some large files are mostly static content/config plus JSX.
- These are less risky than stateful hotspots but noisy to review when copy/config changes are mixed with layout.
- Methodology and special editorial pages intentionally have large content blocks, so the goal is reviewability, not reducing line count for its own sake.
- `about` and `telegram` already use adjacent content modules in places, so this should target remaining inline arrays/FAQ/JSON-LD or duplicated local tone/card maps only.

Plan:

1. Move stable arrays, FAQ items, section descriptors, JSON-LD item lists, and copy blocks into adjacent `*-content.ts` files.
2. Leave route-specific JSX composition in the page/component file.
3. Do not touch text unless separately requested.
4. For methodology pages, preserve version/changelog ordering exactly.
5. Do not create a generic editorial-page framework in this pass.

Visual impact: none.

Behavior impact: none intended. Metadata and JSON-LD output must remain equivalent.

Validation:

```bash
npm run typecheck
npm test -- src/lib/__tests__/design-invariants.test.ts src/lib/__tests__/methodology-version.test.ts
npm run build
npm run seo:check
# If content or JSON-LD moves, compare selected out/**/index.html and markdown fixtures.
```

Priority: P3, opportunistic reviewability cleanup.

### 8. Keep query-contract cleanup mostly complete, then remove remaining central-hook pressure carefully

Files:

- `src/hooks/api-hooks.ts`
- `src/hooks/use-api-query.ts`
- domain hook files under `src/hooks`

Finding:

- The high-value query option builder work is already done for compare and prefetch paths.
- `api-hooks.ts` remains a central 287-line module, but it is still readable and not a current hotspot.
- Splitting it purely by feature could improve ownership, but also risks churn across many imports.

Plan:

1. Do not split `api-hooks.ts` immediately.
2. When a feature hook is touched for real work, move that hook to a domain file only if it reduces import churn or enables targeted tests.
3. Keep shared query option builders colocated with the primary resource hook.
4. Preserve query keys exactly.

Visual impact: none.

Behavior impact: none intended, but query-key changes would cause cache behavior changes.

Validation:

```bash
npm test -- src/hooks/__tests__/query-option-builders.test.ts src/hooks/__tests__/query-polling-policy.test.ts
npm run typecheck
```

Priority: P3, opportunistic only.

### 9. Treat dead-code cleanup as guardrail-driven, not speculative

Files:

- All website source.

Finding:

- `check:unused-code` currently reports no dead internal modules or unused named exports.
- The realistic dead-code target is thin compatibility wrappers or stale route-specific indirection, not large obvious unused files.

Plan:

1. Remove known wrappers only when a direct replacement is already proven, starting with `useStablecoinDetailHistory()`.
2. Re-run `check:unused-code` after each decomposition because extraction can leave stale helpers.
3. Do not delete one-off visual components just because they are narrowly used; many are route-specific by design.

Visual impact: none.

Behavior impact: none intended.

Validation:

```bash
npm run check:unused-code
npm run typecheck
```

Priority: continuous.

## Recommended Implementation Order

1. P0 query-contract correctness: blacklist sort fields in the query key and safety-history prefetch envelope/key alignment.
2. P0 wrapper cleanup: remove `useStablecoinDetailHistory()`.
3. P1 hotspot slice A: `dex-liquidity-card.tsx`, `hero-card.tsx`, and only exact-preserving model/presentation seams.
4. P1 hotspot slice B: `kpi-bar.tsx` homepage top-fold split.
5. P1 hotspot slice C: `nautical-chart.tsx` SVG primitive extraction with screenshot coverage.
6. P1 hotspot slice D: `contagion-graph.tsx` renderer/model split, keeping `contagion-layout.ts` changes separate unless tests make the helper extraction trivial.
7. P1 hotspot slice E: `command-palette.tsx` pure result/action builders only, leaving focus and keyboard state in place.
8. P1/P2 coverage and portfolio hotspot cleanup, starting with coverage model-data decomposition.
9. P2 taxonomy descriptor/factory if the narrower hub duplication remains worth the churn.
10. P2 filter/search primitives, preserving all caller-owned state semantics.
11. P2 exact-match chart primitive adoption.
12. P3 content/config extraction for large static pages.
13. P3 opportunistic hook/module moves only when nearby feature work already touches the file.

## Validation Strategy

Baseline before implementation:

```bash
npm run check:unused-code
npm run check:hotspot-ratchet
npm run check:shared-cycles
npm run check:duplicate-exports
```

Minimum per-slice validation:

```bash
npm run typecheck
npm run lint
npm test -- <focused test files>
```

Website-rendering sensitive slices:

```bash
npm run build
npm run seo:check
```

Local visual smoke:

```bash
npm run build
```

Then, in a separate shell:

```bash
npm run serve:static-export
```

And, against that server:

```bash
npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
```

For visible extraction slices, also capture before/after screenshots at mobile `390x844` and desktop `1280x900` for the touched routes. The route set should be narrow and evidence-driven, but likely includes `/`, `/chains/`, `/stablecoin/usdc-circle/`, `/stablecoin/usdt-tether/`, `/liquidity/`, `/depeg/`, `/blacklist/`, `/yield/`, or `/cemetery/` depending on the changed component.

Hotspot-sensitive slices:

```bash
npm run check:hotspot-ratchet
```

If a hotspot target shrinks, update the baseline with `npm run check:hotspot-ratchet:update-baseline` and commit any matching `scripts/lib/hotspot-ratchet-waivers.json` changes with the same slice.

Pre-push / final gate:

```bash
npm run test:merge-gate
```

## Explicit Non-Goals

- No redesign.
- No scoring, methodology, or data-source changes.
- No Worker/API changes.
- No broad component library rewrite.
- No conversion of deliberately bespoke surfaces, such as Cemetery visuals, into generic dashboard components unless exact-preserving extraction is obvious.
