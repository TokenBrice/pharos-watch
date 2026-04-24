# Alt-Pegs Execution Plan

Date: 2026-04-23

Source inputs:

- [Alt-Pegs improvement catalog](/home/ahirice/Documents/git/stablecoin-dashboard/agents/2026-04-23-alt-pegs-improvement-catalog.md)
- [Alt-pegs route contract](/home/ahirice/Documents/git/stablecoin-dashboard/docs/alt-pegs-page.md)
- [Testing guide](/home/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)
- [API reference](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
- [Worker and API limits](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)

## Scope Decision

This plan interprets “main suggestions” as the high-signal shortlist from the catalog, with execution prioritized by impact and realism rather than by trying to implement every idea in one pass.

Main suggestions included here:

1. Improve trust and readability of historical views.
2. Make chart metrics and denominator language explicit.
3. Make dense chart surfaces feel like true drill-down destinations.
4. Reframe the top fold so the route states a thesis instead of only listing scope.
5. Split `all alt-pegs` from `fiat non-USD` in the page framing.
6. Reduce density in the cohort-history experience.
7. Add stronger current-state structure reads such as broadening vs concentration and leader dependence.

Deferred from the mainline plan unless later phases justify them:

- full cohort dossier experience
- compare lab
- credibility matrix
- large new worker-side history endpoints
- deep share/export/social features

## Assumptions

- Phase 1 and Phase 2 should stay frontend-only unless a blocker appears.
- The quickest root-cause fix for the original complaints is better framing and better chart behavior, not immediately adding new APIs.
- The current `/alt-pegs/` route remains the canonical surface; early “larger chart” work should prefer URL-addressable focus states on this route before introducing new route families.
- We should preserve the existing crawlable static link hub even if we visually compress or reorder it.
- Commodity pegs remain in scope for `/alt-pegs/`; we should clarify scope, not silently narrow it to fiat.

## Success Criteria

1. A first-time visitor can tell within one screen whether the page is about all non-USD pegs or fiat non-USD specifically.
2. The historical modules no longer create an immediate “this looks wrong” reaction because start coverage, cadence, and units are explicit.
3. The primary cohort-history experience is materially easier to read on mobile and desktop.
4. Dense chart surfaces have a clear, shareable drill-down or focus affordance.
5. The page makes a stronger market-structure claim, especially around breadth vs concentration.
6. The route remains indexable and keeps its crawlable cohort-navigation path.

## Recommended Delivery Shape

### Release 1: Trust And Readability Fixes

Goal:

- Fix the biggest trust and interpretation problems without changing the data model or adding endpoints.

Deliverables:

- Default both historical modules to `1Y` or `3Y`; keep `All` available and remember the last choice.
- Rename chart titles/subtitles so units are explicit:
  - share of total stablecoin market
  - dollar market cap by cohort
- Add compact coverage and cadence notes directly on both history cards.
- Clarify denominator language in subtitles, legends, and tooltip totals.
- Split current copy between `active now` and `historically tracked`.
- Replace `Start with EUR` with contextual next-step actions.
- Add a short “what counts as non-USD here?” primer.

Why first:

- These are the highest-impact, lowest-risk fixes from the review set.
- They directly answer the original complaints without requiring new architecture.

Likely file touchpoints:

- `src/app/alt-pegs/client.tsx`
- `src/components/non-usd-share-chart.tsx`
- `src/app/alt-pegs/alt-peg-cohort-history-chart.tsx`
- `src/app/alt-pegs/page.tsx`
- `src/lib/alt-peg-market.ts`
- route tests under `src/app/alt-pegs/*.test.tsx`

Docs to update:

- `docs/alt-pegs-page.md`
- `docs/architecture.md`

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run seo:check`

### Release 2: Stronger Top Fold And Current-State Framing

Goal:

- Turn the route into an authored market-structure surface instead of a stack of modules.

Deliverables:

- Rewrite the hero/top fold around a clear thesis.
- Add a compact `What changed` or `What matters now` strip.
- Split headline framing into:
  - `all alt-pegs`
  - `fiat non-USD`
- Add a `Broadening vs Concentration` board.
- Add a `Leader Dependence` read for current cohorts.
- Tighten or replace weak top-fold elements like the current mix bar if they still feel redundant.
- Make the distribution card more guided via badges, filters, or a top-preview-first layout.

Recommended implementation bias:

- Build these from current snapshot data already available in `useStablecoins()` and `buildAltPegSnapshot(...)`.
- Avoid adding new history endpoints in this release.

Why second:

- After trust/readability is repaired, the biggest remaining gap is that the page still does not say enough with the data it already has.

Likely file touchpoints:

- `src/app/alt-pegs/client.tsx`
- route-local presentational components if split out from `client.tsx`
- `src/lib/alt-peg-market.ts`

Docs to update:

- `docs/alt-pegs-page.md`

Validation:

- Same as Release 1

### Release 3: History Experience Redesign

Goal:

- Replace the current dense historical experience with one that is easier to read and better matches the route’s job.

Deliverables:

- Rework the share section into a clearer `share + absolute-cap` pairing.
- Replace the current primary cohort-history view with one of:
  - `Top N + Other`
  - spotlight mode
  - small multiples
- Add structural annotations for the most important regime shifts.
- Add clear focus-state or `Open large chart` affordances for both historical modules.
- Rework mobile ordering if necessary so users reach the explanatory history faster.

Recommended sequencing inside this release:

1. First try `Top N + Other` plus explicit focus states.
2. If that still feels too dense, move to small multiples as the primary default and keep the full stack as opt-in.

Recommended route decision:

- Prefer URL-addressable focus states on `/alt-pegs/` first, for example query-param-driven chart focus.
- Only introduce new subroutes if the focused experience becomes too complex for one route shell.

Why third:

- This is the most meaningful UI/analysis change after the trust fixes, but it is more invasive than Releases 1 and 2.

Likely file touchpoints:

- `src/components/non-usd-share-chart.tsx`
- `src/app/alt-pegs/alt-peg-cohort-history-chart.tsx`
- `src/app/alt-pegs/client.tsx`
- possibly a new route-local chart-focus component

Data note:

- Start with existing `useNonUsdShare()` and `useStablecoinCharts()`.
- Do not add a worker endpoint unless client-side derivation becomes brittle or performance-heavy.

Docs to update:

- `docs/alt-pegs-page.md`
- possibly `docs/architecture.md` if route behavior changes materially

Validation:

- Same as Release 1
- Add focused unit/render coverage for:
  - default range behavior
  - focus-state routing/state
  - top-N grouping behavior

### Release 4: Signature Analytics Modules

Goal:

- Add the strongest distinctive modules once the base route is trustworthy and easy to read.

Deliverables:

- `Who Drove The Move?` contribution module
- breadth-over-time thresholds
- peak vs now / drawdown / first-seen context
- regional fiat atlas
- optional curated compare presets

Potential worker/API decision gate:

- If these features need historical cohort derivations that are awkward or expensive in the browser, add a dedicated derived endpoint at this stage, not earlier.

If a new endpoint is needed, prefer one focused route contract over several small ones. Candidate shape:

- `GET /api/alt-peg-history` for precomputed cohort-level historical rollups and derived stats

Only add it if needed for one or more of:

- breadth thresholds over time
- contribution attribution
- historically aware `Other`
- first-seen / peak / drawdown stats that are too awkward to compute repeatedly client-side

If Phase 4 adds worker work, also update:

- `docs/api-reference.md`
- `docs/architecture.md`

Worker validation if needed:

- `cd worker && npx tsc --noEmit`

### Release 5: Optional Deep Drill-Down Surfaces

Goal:

- Expand beyond the main suggestions only if the route still feels like a good page rather than a true research tool.

Candidates:

- cohort dossier
- compare lab
- credibility matrix

Recommendation:

- Treat these as follow-on bets after measuring whether Releases 1 to 4 already solve the original user feedback.

## Recommended Order Of Work Inside The Codebase

1. Tighten copy, labels, notes, and range defaults.
2. Reframe the hero and current-state summary.
3. Rework the primary cohort-history view.
4. Add chart focus / larger-view affordances.
5. Add signature analytics modules.
6. Only then consider heavy new drill-down surfaces.

## Key Risks And How To Handle Them

### Risk 1: Share and dollar history still get conflated

Mitigation:

- Make the two units explicit in titles, subtitles, tooltip totals, and any new top-fold summary language.

### Risk 2: The cohort-history redesign still feels too dense

Mitigation:

- Treat `Top N + Other` as an intermediate step, not a final commitment.
- Promote small multiples if the focused stack still underperforms.

### Risk 3: New copy helps casual users but annoys power users

Mitigation:

- Keep primers, glossary help, and notes terse and visually secondary.

### Risk 4: Mobile improvements break crawlability or route depth

Mitigation:

- Visually collapse or reorder the link hub, but preserve static HTML links and route discoverability.

### Risk 5: We prematurely add API complexity

Mitigation:

- Hold the line on frontend-only changes through Release 3.
- Add worker support only when a concrete Phase 4 feature clearly needs it.

## Recommended Docs And Test Updates Per Release

Always update:

- `docs/alt-pegs-page.md`

Update when route behavior or data contract changes:

- `docs/architecture.md`

Update only if a new API endpoint is added:

- `docs/api-reference.md`
- `docs/worker-and-api-limits.md` if budgets or endpoint assumptions change

Test posture:

- route render/state tests for `src/app/alt-pegs`
- chart behavior tests where logic becomes non-trivial
- existing full repo validation for Pages-impacting diffs

## Practical Shortlist For Immediate Implementation

If we want the fastest path to a materially better page, implement these first:

1. Default history to `1Y` or `3Y`.
2. Add coverage/cadence/methodology notes directly on the charts.
3. Make share vs dollar framing explicit.
4. Replace `Start with EUR` with contextual next steps.
5. Split headline framing into `all alt-pegs` and `fiat non-USD`.
6. Add a thesis plus `What changed` strip.
7. Replace the dense primary cohort history with `Top N + Other` or spotlight mode.
8. Add explicit `Open large chart` affordances.
9. Add a `Broadening vs Concentration` board.
10. Add a leader-dependence read.

## Recommendation

Treat Releases 1 through 3 as the committed execution plan.

That sequence delivers the core user-facing win:

- more trustworthy history
- clearer market-structure framing
- a more comfortable dedicated route
- better drill-down behavior

Then use Release 4 as the first expansion wave, and only consider Release 5 if the page still feels underpowered after the simpler fixes land.
