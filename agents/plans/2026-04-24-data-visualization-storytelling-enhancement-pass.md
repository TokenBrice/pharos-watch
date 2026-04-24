# Pharos Data Visualization And Storytelling Enhancement Pass

Date: 2026-04-24
Status: preparation plan, revision 4 pending reviewer loop

## Purpose

Pharos should not merely collect, categorize, and display data. Its best surfaces make the data legible through metaphors that embody the underlying structure: harbors and cargo on `/chains/`, DEWS radar contacts on `/depeg/`, and printer/shredder flows on `/flows/`. This pass plans a careful expansion of that language without turning metaphors into decoration or changing methodology semantics.

## Assumptions

- Existing data should be used first. New backend collection, D1 migrations, cron jobs, API routes, provider contracts, and methodology scoring changes are out of scope for the release implementation.
- Recharts remains the default charting layer. D3 should be used for layout/math where a route needs custom geometry, not as an imperative DOM renderer.
- Pure presentation changes do not change methodology versions. Any change that alters score, threshold, data source, label semantics, or public methodology claims requires the relevant methodology and timeline docs.
- Existing dirty worktree changes are not part of this pass unless the user explicitly expands scope.
- Current `/coverage/` and `/liquidity/` already contain most of the initially proposed reach and exit-route storytelling. This pass should validate those surfaces, not reimplement them, unless a concrete missing behavior is found.

## Success Criteria

- Use subagent research for external visualization practice, current Pharos surface enhancement, and new opportunity discovery.
- Consolidate findings into this auditable plan under `/agents/`.
- Run reviewer subagents through review > fix plan issue loops until the plan has zero blockers, zero majors, and fewer than three minors.
- Implement only after the plan clears review.
- Preserve exact-value workbenches under every metaphor so users can inspect the data behind the story.
- Add focused model/component tests for each new derived visualization model.
- Commit in logical batches without absorbing unrelated worktree changes.
- Run targeted tests, typecheck/lint/build where relevant, browser smoke checks, docs checks, and `npm run test:merge-gate`.
- Push the committed implementation to `origin/main` after validation.

## Current Worktree And Push Isolation

Current local state observed before implementation:

- `main` is ahead of `origin/main` by one existing local commit: `7e4028b2 docs: align corpus with source audit`.
- The existing local commit changes docs/generated API artifacts and is outside the visualization implementation. Because the user asked for a production push from `main`, review this commit before implementation and include it only if it remains acceptable; otherwise stop before push rather than rewriting branch history.
- The current checkout has unrelated unstaged alt-peg, chains, docs, and `src/lib/alt-peg-*` edits plus unrelated untracked `/agents/plans/*` files.

Rules for this pass:

- Do not edit, format, unstage, revert, or commit unrelated dirty paths in the current checkout.
- Implement and validate in a clean throwaway worktree based on the reviewed push base, not in the dirty checkout, so whole-repo lint/typecheck/build/browser smoke are not contaminated by unrelated local edits.
- The clean worktree should be based on `HEAD` only after explicitly accepting the existing local commit as part of the production push; otherwise base on `origin/main` and stop before any push decision.
- Stage only this pass' files with explicit pathspecs in the clean worktree.
- Before every commit, run `git diff --cached --name-only` and confirm the intended commit is isolated.
- Before push, run `git log --oneline origin/main..HEAD` and confirm it contains only the accepted pre-existing commit plus the logical commits created for this pass.

## Research Synthesis

External visualization guidance:

- Data visualizations should lead with the analytical question, use descriptive labels, preserve text alternatives, avoid color-only encoding, stay responsive, and keep underlying values available in tables or equivalent text.
- Recharts 3 is suitable for Pharos' current React/SVG charts and has accessibility support by default. D3 is strongest for custom scales, layout, force, maps, and geometry. Vega-Lite and Observable Plot are useful for prototyping, but a second runtime grammar has no clear payoff for this pass.
- Canvas/WebGL libraries should be exceptions for measured high-density cases because Pharos' current data sizes and accessibility needs favor SVG/React.
- Chart.js is not a good default for Pharos because canvas content needs explicit fallback content for screen-reader accessibility.

Repo findings:

- Strong existing metaphors already exist: chain harbors, DEWS radar, mint/burn printer-shredder, alt-peg atlas, safety inspection board, PSI lighthouse, cemetery tombstones, liquidity exit route map, and dependency graph.
- The main gap is connection between metaphor and operational drill-down: visuals explain whole surfaces but do not always cross-highlight rows, events, sources, or caveats.
- The highest-value new storytelling opportunities are source provenance, direct dependency hub ranking, coverage reach calibration, redemption semantics, and issuer intervention history.

## Visualization Contract For This Pass

Every new or changed storytelling visualization must include:

- a visible title or compact statement of the primary interpretation;
- a source/caveat line where the visual can be mistaken for broader truth;
- accessible label text or adjacent text summary for SVG/chart meaning;
- stable responsive dimensions that do not resize from hover, filtering, or missing data;
- semantic colors first, with non-color labels or patterns where status matters;
- exact values in visible text, table rows, or an adjacent list/table equivalent; tooltips and linked detail views are supplemental, not the only place a value appears;
- row/list/table parity for every encoded source group, dependency hub, dependency edge aggregate, blacklist exposure bucket, event-count symbol, and quarter amount; keyboard and screen-reader users must be able to read the same APY/source/confidence/freshness, dependency count/weight/market-cap/example, and blacklist bucket/event/amount details without hover;
- no ornamental geometry: every plotted shape, lane, chip, or bar must encode a named data field;
- existing tokens and shells first, especially `FeaturePageShell`, `pharos-card-shell`, `pharos-panel-header`, `pharos-table-shell`, `pharos-chart-stage`, control pills, existing chart/tooltip primitives, mono/tabular numeric treatment, and route-local design patterns;
- no score/methodology claim changes unless explicitly handled as methodology work.

## Responsive And Accessibility Contract

- Yield: desktop renders metric-led "Yield Sources" lanes above the scatter/table; mobile uses stacked source-group cards as the primary surface, with the same counts and APY context visible. Dense chart views stay secondary. The leaderboard remains the exact-value workbench.
- Coverage: no new large visualization in this pass unless a specific gap is found. Existing Feature Snapshot and matrix remain the source of truth.
- Dependency Map: desktop adds a metric-led "Dependency Hubs" board near the graph; mobile uses ranked hub rows as the primary readable surface and treats dense graph interaction as secondary. `DependencyMapMobileSummary` must reuse the same pure model.
- Blacklist: desktop adds a compact "Intervention Ledger" strip above charts; mobile renders resolved-exposure and observed-event blocks as stacked rows with at least 44px tap targets.
- Accessibility checks must include keyboard traversal, visible focus, screen-reader summary text, non-color status labels, labels plus dash/shape/pattern differences where chart marks need distinction, visible SVG focus states where SVG is interactive, both-theme contrast review for legends/fills/muted text, reduced-motion behavior, 200% zoom, no page-level horizontal overflow, and mobile touch-target/overflow checks.

## Existing Surface Enhancement Map

### `/chains/` Harbor

- Current: `src/app/chains/nautical-chart.tsx`, `harbor-map.ts`, `harbor-list.tsx`, `client.tsx`.
- Enhancement: selected harbor detail panel plus hover/focus sync from ship to leaderboard row.
- Data: `ChainHarborEntry.topStablecoins`, `dominanceShare`, `change7dPct`, `stablecoinCount`, `remaining`.
- Value: makes cargo actionable and links metaphor to the table.
- Decision: defer because unrelated chain files already exist in the dirty worktree.

### `/depeg/` DEWS Radar

- Current: `src/components/dews-summary.tsx`, `dews-alert-feed.tsx`, `peg-heatmap.tsx`.
- Enhancement: radar contact selection that filters/highlights alert feed and heatmap row, plus compact signal breakdown.
- Data: `useStressSignals()`, `useStressSignalDetail()`, existing DEWS detail helpers.
- Value: turns a radar overview into a navigable incident workflow.
- Decision: follow-up. Coupling across three sections is higher than the value for this first release.

### `/flows/` Printer/Shredder

- Current: `flow-brrr-overview.tsx`, `flow-machine-scene.tsx`, `flow-chart.tsx`.
- Enhancement: pressure receipt beside the machine with top minted/burned symbols and coverage state.
- Data: `/api/mint-burn-flows` rows, 24h/7d/30d/90d flow fields, coverage metadata.
- Value: names what the machine is printing or shredding instead of staying aggregate.
- Decision: follow-up. Public flow semantics are sensitive and require careful lag/coverage caveats.

### `/alt-pegs/` Atlas

- Current: `fiat-world-atlas/*`, `alt-peg-hero.ts`, `alt-peg-market.ts`.
- Enhancement: mobile itinerary grouped by region/cohort.
- Data: existing atlas/cohort models.
- Value: improves mobile storytelling.
- Decision: defer because unrelated alt-peg/chains work has been active in the worktree.

### `/safety-scores/` Inspection Board

- Current: `inspection-board.tsx`, `view-model.ts`, `stress-test-panel.tsx`.
- Enhancement: inspection docket/exposure bar by dimension.
- Data: `buildSafetyInspectionBoard()` outputs such as `dimensionSummaries`, `worstFindings`, `findingExposureUsd`.
- Value: clearer audit artifact.
- Decision: defer. Safety Score surfaces are score-sensitive and need a separate score-impact review.

### `/stability-index/` Lighthouse

- Current: `presentational.tsx`, `view-model.ts`, `psi-history-chart.tsx`.
- Enhancement: component beam dimmers and contributor-driven dimming explanation.
- Data: current PSI components, contributors, history stats.
- Value: explains what is dimming the lighthouse today.
- Decision: follow-up. Curated event/contributor causality can overclaim.

### `/liquidity/` Exit Route Map

- Current: `liquidity-stats.tsx`, `liquidity-table.tsx`.
- Existing state: route already has protocol/chain rails, HHI, pool balance, organic share, leading route labels, exact values, and caveat copy.
- Data rule if touched: global DEX score fields may be null; derive HHI from `protocolTvl`, use existing aggregate fallback for pool balance and organic values, or render NR.
- Decision: validation-only unless a precise missing improvement appears. Do not duplicate the existing exit route map.

### `/coverage/` Control Tower

- Current: `use-coverage-matrix-model.ts`, `coverage-page-sections.tsx`, `coverage-lens-summary.tsx`.
- Existing state: Feature Snapshot already compares count reach and market-cap reach and highlights widest, narrowest, and major-heavy features.
- Data rule if touched: unavailable live feeds must be visibly annotated as Pharos feature availability/status, not asset safety or general data quality.
- Decision: audit/refinement only. Do not build another reach chart unless implementation identifies a precise missing behavior.

### `/blacklist/` Intervention Ledger

- Current: `blacklist-stats.tsx`, `blacklist-status-charts.tsx`, `blacklist-chart.tsx`, `blacklist-table.tsx`.
- Enhancement: intervention ledger strip combining resolved blacklist/freeze exposure buckets, tracked symbol event-count leaders, and frozen-value quarter context.
- Data: `BlacklistSummaryResponse.stats.perCoinTotalEvents`, chart quarters, `buildBlacklistStatusBuckets()`.
- Value: connects resolved freeze exposure to observed intervention history without treating event streams as issuer-level risk.
- Decision: implement as frontend-only.
- Scope guard: split resolved exposure status from observed supported tracker events; do not imply event count predicts policy risk. `yes`, `possible`, `upstream`, and `no` must be labelled as resolved blacklist/freeze exposure buckets: `upstream` is inherited collateral/custody/parent exposure, and `no` means no resolved exposure in the current model. If quarter frozen-value context is shown, include the existing tracker caveat that public aggregates reflect supported event coverage and amount/suppression rules.

### `/cemetery/` Memorial

- Current: `cemetery-client.tsx`, `cemetery-tombstones.tsx`, `cemetery-charts.tsx`.
- Enhancement: cross-highlight cause/year/largest failure between charts, tombstones, and autopsy cards.
- Data: static `DEAD_STABLECOINS`.
- Value: strong polish but less operationally useful than yield/dependency/blacklist.
- Decision: defer.

### `/dependency-map/` Dependency Hubs Board

- Current: `dependency-map/client.tsx`, `contagion-graph.tsx`, `dependency-map-mobile-summary.tsx`, `contagion-layout.ts`.
- Enhancement: dependency hub board ranking upstream hubs by dependent count, dimensionless inbound weight, direct dependent market-cap context, and examples; keep graph as the main visual.
- Data: report-card dependency edges, live card IDs, stablecoin market caps.
- Value: makes systemic-risk graph actionable and readable on mobile.
- Decision: implement by extracting the existing mobile hub calculation into a pure model shared by mobile and desktop.
- Metric definitions:
  - `dependentCount`: number of unique live direct dependents where an edge points from the hub to the dependent in the current graph orientation.
  - `inboundWeight`: dimensionless sum of direct dependency edge weights; label exactly as "inbound weight", not USD exposure.
  - `uniqueDependentMcapUsd`: optional visible context computed from `edge.to` direct dependents only, deduped by dependent ID; label as modeled dependent market cap, not loss, liquidity, or guaranteed exposure.
  - the existing mobile hub `mcap` value is the hub's own market cap and must not be reused as dependent market-cap context.
  - no transitive or recursive blast-radius claim in this pass.

### Stablecoin Detail Dossier

- Current: `src/app/stablecoin/[id]/client.tsx`, `use-stablecoin-detail-view-model.ts`, detail components.
- Enhancement: compact risk-story strip naming the strongest current signal across Safety, DEWS, Liquidity, Flows, Blacklist, and Reserves.
- Data: already aggregated in detail view model.
- Value: helps users orient before diving into sections.
- Decision: defer. Easy to overclaim without narrower model review.

## New Storytelling Opportunity Matrix

| Priority | Experience | Primary route | Data | Decision |
| --- | --- | --- | --- | --- |
| 1 | Yield Sources Board | `/yield/` | published selected ranking sources, alt sources, selected-source provenance, benchmark context | Implement Batch 1 |
| 2 | Dependency Hubs Board | `/dependency-map/` | dependency graph edges, report cards, market caps | Implement Batch 2 |
| 3 | Intervention Ledger | `/blacklist/` | blacklist/freeze exposure buckets, tracked symbol event counts, quarter chart | Implement Batch 3 frontend-only |
| 4 | Coverage Control Tower audit | `/coverage/` | feature summaries, market-cap reach, coverage states | Validate existing surface; no new chart unless precise gap |
| 5 | Liquidity Route Meter audit | `/liquidity/` | global DEX route shares and derived HHI | Validate existing surface; no duplicate build |
| 6 | Flow Pressure Receipt | `/flows/` | flow rows, coverage metadata | Follow-up |
| 7 | PSI Beam Dimmers | `/stability-index/` | PSI components, contributors | Follow-up |
| 8 | Stablecoin Dossier Spine | `/stablecoin/[id]` | multiple route-local feeds | Follow-up after separate review |

## Concrete Release Scope

### Batch 1: Trust And Source Provenance

Add `/yield/` Yield Sources Board:

- pure model groups published selected ranking sources plus published alternate sources by yield type and `dataSource`; rejected, stale, unavailable, and historical-only sources are not represented unless they are in the current ranking payload;
- confidence-tier counts apply only to selected/best source rows where `YieldRanking.provenance.confidenceTier` exists;
- confidence labels must say "selected-source confidence" and never imply overall source coverage;
- alternate sources are grouped by source family/data source and yield type, never by confidence tier;
- visual renders source lanes/cards above the scatter/table;
- shows selected-source count, alternate-source count, selected-source confidence distribution, APY context over the represented selected+alternate payload, source-switch/anomaly counts when present, and caveat that APY is not investability or safety;
- no new API calls or scoring changes.

### Batch 2: Systemic Dependency Readability

Add `/dependency-map/` Dependency Hubs Board:

- pure model extracts current mobile hub calculation and shares it between desktop and mobile;
- visual ranks top upstream hubs with unique direct dependent count, dimensionless inbound weight, optional deduped direct-dependent market cap, and example dependents;
- tests must prove duplicate direct dependents are deduped for `dependentCount` and `uniqueDependentMcapUsd`, while inbound weight remains the sum of direct edge weights;
- tests must prove hub market cap is not used as dependent-market-cap context;
- graph remains the main visual;
- caveat: modeled dependent market-cap context is not guaranteed loss.

### Batch 3: Intervention Storytelling

Add `/blacklist/` Intervention Ledger:

- visual summarizes resolved direct/possible/upstream/no blacklist/freeze exposure buckets and top tracked symbols/contracts by observed supported events;
- uses existing summary/status data only;
- separates resolved exposure status from observed supported tracker events;
- caveat: event count is observed supported tracker history, not policy probability.

### Validation-Only Existing Surface Audits

- `/coverage/`: no implementation unless a precise missing behavior appears during final visual audit; if touched, refine copy to say "Pharos feature availability/status", not asset safety or data quality in general.
- `/liquidity/`: no duplicate implementation unless a precise missing behavior appears; if touched, respect null global score fields and derive HHI from `protocolTvl`.
- Record the validation-only outcome in `/agents/`: either "no precise gap found" with evidence, or exact follow-up/doc/UI issue if a semantics gap is found.

## Methodology And Docs Gate

- Before final commit, record a yes/no methodology checkpoint in the plan or validation note:
  - yes: if any rendered labels/caveats changed public methodology claims, update the relevant methodology section, changelog/timeline doc, and numeric methodology version;
  - no: if changes are presentation-only and use existing payload semantics, record the no-version-bump rationale.
- Route docs are mandatory for new visible route contracts: `docs/yield-intelligence.md`, `docs/dependency-map.md`, and `docs/blacklist-tracker.md`.

## Explicit Exclusions For This Pass

- No new backend cron, D1 schema, API route, provider, or migration.
- No methodology version bump unless implementation unexpectedly changes data semantics.
- No changes to current unrelated chains/alt-peg/design-doc worktree files.
- No broad redesign of route shells, navigation, fonts, tokens, or shadcn primitives.
- No Canvas/WebGL or new chart library dependency.
- No safety score, liquidity score, PSI, DEWS, or report-card scoring changes.

## Planned Files

Expected new/changed files:

- `agents/plans/2026-04-24-data-visualization-storytelling-enhancement-pass.md`
- `src/app/yield/source-constellation-model.ts`
- `src/app/yield/source-constellation-model.test.ts`
- `src/app/yield/source-constellation.tsx`
- `src/app/yield/source-constellation.test.tsx`
- `src/app/yield/client.tsx`
- `src/app/dependency-map/firebreak-board-model.ts`
- `src/app/dependency-map/firebreak-board-model.test.ts`
- `src/app/dependency-map/firebreak-board.tsx`
- `src/app/dependency-map/firebreak-board.test.tsx`
- `src/app/dependency-map/client.tsx`
- `src/components/dependency-map-mobile-summary.tsx`
- `src/components/blacklist-intervention-ledger.tsx`
- `src/components/__tests__/blacklist-intervention-ledger.test.tsx`
- route docs for new user-facing contracts: `docs/yield-intelligence.md`, `docs/dependency-map.md`, `docs/blacklist-tracker.md`.

Optional only if audit finds precise gaps:

- `docs/coverage-page.md`
- `docs/dex-liquidity.md`
- `src/components/liquidity-stats.tsx`
- coverage page files

## Validation Plan

Targeted tests:

- `npm test -- src/app/yield/source-constellation-model.test.ts src/app/yield/source-constellation.test.tsx src/app/dependency-map/firebreak-board-model.test.ts src/app/dependency-map/firebreak-board.test.tsx src/components/__tests__/blacklist-intervention-ledger.test.tsx`
- include changed existing component tests, especially `src/app/dependency-map/client.test.tsx`, `src/components/__tests__/blacklist-stats.test.tsx`, `src/components/__tests__/blacklist-status-charts.test.tsx`, `src/components/__tests__/liquidity-stats.test.tsx` if liquidity is touched, and `src/lib/__tests__/coverage.test.ts` if coverage is touched.

Broad validation:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- local static-export smoke: start the static export server and run `SMOKE_UI_OVERFLOW_ROUTES="/yield/,/dependency-map/,/blacklist/" npm run test:smoke-ui -- --url http://127.0.0.1:<port> --mode local`.
- additional accessibility check for `/yield/`, `/dependency-map/`, and `/blacklist/`: keyboard tab traversal, visible focus, screen-reader label/summary presence, 200% zoom, both-theme contrast/manual review for the new visual marks, and no page-level horizontal overflow.
- docs checks when docs change: `npm run check:verified-doc-links` and `npm run check:doc-source-paths`; broader doc validation is also covered by merge gate.
- after committing: `npm run test:merge-gate`; if checking staged work before commit, use `npm run test:merge-gate -- --staged` because merge gate is committed-diff based.

Deployment:

- implement in a clean worktree and make logical commits:
  1. plan/research artifact,
  2. yield source provenance visual and docs,
  3. dependency firebreak board and docs,
  4. blacklist intervention ledger and docs.
- use pathspec-only staging or pathspec-limited commits to exclude unrelated dirty files.
- before push, run `git log --oneline origin/main..HEAD` and confirm it contains the accepted existing local commit plus the four visualization-pass commits only.
- push `main` to `origin/main`.

## Review Loop Criteria

Reviewers classify issues as:

- blocker: plan would likely ship misleading data, break repo rules, or touch unrelated dirty work;
- major: plan is feasible but misses a necessary test/doc/scope constraint;
- minor: naming, ordering, copy, or small implementation-risk clarification.

The plan is ready to implement only when review returns zero blockers, zero majors, and fewer than three minors.
