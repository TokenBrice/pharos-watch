# Pharos Data Visualization And Storytelling Enhancement Pass

Date: 2026-04-24
Status: preparation plan, revision 5 ready for final reviewer loop

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

- On the final plan-review handoff, `main` is aligned with `origin/main` (`git rev-list --left-right --count origin/main...HEAD` returned `0 0`) and there are no pre-existing local commits to include in the production push.
- The checkout was clean before the revision-5 plan corrections. If new unrelated dirty paths appear during implementation, treat them as out of scope and do not edit, format, unstage, revert, or commit them.
- The plan artifact itself is in scope and should be committed before or with the first implementation batch.

Rules for this pass:

- Do not edit, format, unstage, revert, or commit unrelated dirty paths if any appear.
- Prefer implementation in a clean throwaway worktree based on `HEAD` after the plan artifact is committed, or continue in the current checkout only if `git status --short` shows only this pass' files.
- Stage only this pass' files with explicit pathspecs in the clean worktree.
- Before every commit, run `git diff --cached --name-only` and confirm the intended commit is isolated.
- Before push, run `git fetch origin main`, then `git log --oneline origin/main..HEAD` and confirm it contains only the logical commits created for this pass.

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

- Yield: desktop renders metric-led "Yield Sources" lanes above the scatter/table; mobile uses stacked source-group cards as the primary surface, with the same counts and source-row APY context visible. Dense chart views stay secondary. The leaderboard remains the exact-value workbench.
- Coverage: no new large visualization in this pass unless a specific gap is found. Existing Feature Snapshot and matrix remain the source of truth.
- Dependency Map: desktop adds a metric-led "Dependency Hubs" board near the graph; mobile uses ranked hub rows as the primary readable surface and treats dense graph interaction as secondary. `DependencyMapMobileSummary` must reuse the same pure model.
- Blacklist: desktop adds a compact "Intervention Ledger" strip above charts; mobile renders resolved-exposure and observed-event blocks as stacked rows with at least 44px tap targets.
- Accessibility checks must include keyboard traversal, visible focus, screen-reader summary text, non-color status labels, labels plus dash/shape/pattern differences where chart marks need distinction, visible SVG focus states where SVG is interactive, both-theme contrast review for legends/fills/muted text, reduced-motion behavior, 200% zoom, no page-level horizontal overflow, and mobile touch-target/overflow checks.

## Existing Surface Enhancement Map

Repo-shape resolution: every candidate below names the current owner files, payload source, implementation readiness, validation path, and release decision. Deferred items are still specified enough for a later worker, but they are intentionally out of this release because of scope boundaries, semantic sensitivity, or lower near-term value.

| Surface | Current repo shape | Existing payload/model contract | Implementation-ready enhancement | Owner files if implemented | Tests and docs | Release decision |
| --- | --- | --- | --- | --- | --- | --- |
| `/chains/` Harbor | `src/app/chains/client.tsx` renders `NauticalChart`; `src/app/chains/harbor-map.ts` builds `ChainHarborEntry`. | `ChainHarborEntry` exposes `totalUsd`, `sharePct`, `berthPct`, `healthScore`, `healthBand`, `stablecoinCount`, `dominantId`, `dominantSymbol`, `dominantSharePct`, `dominantCargoUsd`, `cargos`, and `change7dPct`. | Add `SelectedHarborPanel` and hover/focus sync between ship, harbor panel, and leaderboard row. Panel fields: chain name/logo, total supply, share, health band, stablecoin count, dominant cargo, top 3 cargos, 7d change. Use the table as the exact-value counterpart. | `src/app/chains/client.tsx`, `src/app/chains/nautical-chart.tsx`, `src/app/chains/harbor-map.ts`, optional `src/app/chains/selected-harbor-panel.tsx`, `docs/chains-page.md`. | `src/app/chains/harbor-map.test.ts`, `src/app/chains/nautical-chart.test.tsx`, keyboard focus/manual overflow smoke. | Defer. The concept is ready, but not part of the first implementation stack. |
| `/depeg/` DEWS Radar | `src/app/depeg/client.tsx` coordinates `DEWSSummary`, `DEWSAlertFeed`, `PegHeatmap`, and `DepegTrackerTable`. `src/components/dews-summary-model.ts` is already pure and testable. | `usePegSummary()`, `useStressSignals()`, `useInfiniteDepegEvents()`, and `ElevatedCoin` fields: `id`, `symbol`, `name`, `logoUrl`, `score`, `band`, `mcap`, `x`, `y`. | Add radar-contact selection that highlights matching alert feed rows, heatmap row, and table rows, with a compact signal breakdown tray. Selection must clear explicitly and must not hide unmatched incidents unless the control says it is filtering. | `src/app/depeg/client.tsx`, `src/components/dews-summary.tsx`, `src/components/dews-summary-model.ts`, `src/components/dews-alert-feed.tsx`, `src/components/peg-heatmap.tsx`, `docs/depeg-detection.md`. | `src/components/__tests__/dews-summary.test.ts`, `src/lib/__tests__/dews-radar-utils.test.ts`, `src/app/depeg/page.test.tsx`, keyboard/SVG focus smoke. | Follow-up. Useful but cross-couples three incident surfaces; not first release. |
| `/flows/` Printer/Shredder | `src/app/flows/client.tsx` renders `FlowBrrrOverview`, `FlowChart`, and `FlowTable`. `FlowBrrrOverview` already computes top mint/burn and 24h/7d pressure locally. | `useMintBurnFlows(24/168/range)` rows plus `MintBurnGauge` fields from `useMintBurnGauge()`. Available fields include 24h/7d/range mint, burn, net, tracked coin count, top mint, top burn, and flow direction. | Add `FlowPressureReceipt`: a receipt-like strip attached to the printer/shredder showing what was printed, what was shredded, net direction, top symbols, tracked-scope caveat, and coverage/lag state. Extract a pure receipt model before rendering. | `src/components/flow-brrr-overview.tsx`, `src/components/flow-pressure-receipt.tsx`, `src/lib/flow-pressure-receipt-model.ts`, `docs/mint-burn-flows.md`. | `src/app/flows/page.test.tsx`, `src/lib/__tests__/mint-burn-timeframes.test.ts`, new receipt model/component tests. | Follow-up. Implementation-ready, but public lag/coverage wording needs its own methodology-doc pass. |
| `/alt-pegs/` Atlas | `src/app/alt-pegs/client.tsx` renders `AltPegSnapshotHero`, `AltPegDistributionCard`, `NonUsdShareChart`, `AltPegCohortHistoryChart`, and `AltPegCohortDirectory`. | `buildAltPegSnapshot()`, `buildAltPegTrendStats()`, and `buildPegDiversityHero()` expose cohorts, clusters, sky cohorts, placed coins, market totals, and non-USD share history. | Add mobile `AtlasItinerary`: region/cohort lanes that convert packed atlas geometry into a readable list, with one-tap jump to cohort history and directory. Keep the map as the first desktop signal. | `src/app/alt-pegs/client.tsx`, `src/app/alt-pegs/fiat-world-atlas/*`, `src/lib/alt-peg-hero.ts`, `docs/alt-pegs-page.md`. | Existing alt-peg client/page/cohort tests plus packing/sizing tests and mobile smoke. | Defer because the route is not part of the first implementation stack. |
| `/safety-scores/` Inspection Board | `src/app/safety-scores/client.tsx` already renders `SafetyInspectionBoard`, `CoreSettlementStrip`, and `SafetyLandscapeCard`. | `buildSafetyInspectionBoard(reportCards, mcapMap)` produces `dimensionSummaries`, `worstFindings`, open-finding counts, and `findingExposureUsd`. | Future refinement: row-to-card focus, dimension detail tray, and clearer "open findings by reviewed dimension" text. Do not change scores, grades, thresholds, or classification copy in this pass. | `src/app/safety-scores/inspection-board.tsx`, `src/app/safety-scores/view-model.ts`, `docs/safety-scores-page.md` or methodology only if semantics change. | `src/app/safety-scores/inspection-board.test.tsx`, `src/app/safety-scores/view-model.test.ts`. | Defer. Score-sensitive surface; separate score-impact review required. |
| `/stability-index/` Lighthouse | `src/app/stability-index/client.tsx` renders `StabilityIndexHero`, `ComponentChart`, `ScoreChart`, contributor rows, and event timeline. | `buildPsiComponentData()`, `buildPsiContributorRows()`, `buildPsiEventTimelineRows()`, and `buildPsiHistoryStats()` expose current components, deltas, contributors, and event context. | Add `PsiBeamDimmers`: compact lanes for depeg stress, flow stress, market concentration, and contributor pressure. It can say "current component pressure" but must not claim curated events caused the current score. | `src/app/stability-index/client.tsx`, `src/app/stability-index/view-model.ts`, optional `psi-beam-dimmers.tsx`, `docs/stability-index.md`. | `src/app/stability-index/view-model.test.ts`, `src/app/stability-index/client.test.tsx`, `src/lib/__tests__/psi-history-events.test.ts`. | Follow-up. Ready, but causality copy needs extra review. |
| `/liquidity/` Exit Route Map | `src/app/liquidity/client.tsx` renders `LiquidityStats` and `LiquidityTable`; `src/components/liquidity-stats.tsx` already includes `buildLiquidityExitRouteModel()`, `LiquidityExitRouteMap`, `ExitRouteRail`, and metrics. | Existing model exposes route shares, HHI/concentration, leading protocol/chain, pool balance, organic activity, total TVL, and caveats. Global DEX score fields may be null. | Validation-only audit: confirm protocol/chain rails, exact values, NR states, HHI, organic, balance, and caveat copy remain visible across desktop/mobile. If touched, derive HHI from `protocolTvl`, use nullable fallbacks, and do not add a second exit-route visualization. | `src/components/liquidity-stats.tsx`, `src/app/liquidity/client.tsx`, `docs/dex-liquidity.md` only if a precise issue is found. | `src/components/__tests__/liquidity-stats.test.tsx`, `src/lib/liquidity-ui.test.ts`, local route smoke. | Validation-only. Existing surface already satisfies the original concept. |
| `/coverage/` Control Tower | `src/app/coverage/coverage-page-sections.tsx` renders `CoverageFeatureSnapshotCard`, `CoveragePricingSourcesCard`, and `CoverageMatrixCard`; `src/hooks/use-coverage-matrix-model.ts` builds the route model. | `useCoverageMatrixModel()` combines stablecoins, peg, DEX, redemption, yield, flows, report cards, pricing-source summaries, feature summaries, and widest/narrowest/major-heavy insights. | Validation-only audit: confirm count reach, market-cap reach, feature availability/status, lens summary, and pricing-source depth are already readable. If touched, labels must say Pharos feature availability/status, not asset safety or general data quality. | `src/app/coverage/coverage-page-sections.tsx`, `src/hooks/use-coverage-matrix-model.ts`, `docs/coverage-page.md` only if a precise issue is found. | `src/lib/__tests__/coverage.test.ts`, `src/app/coverage/coverage-filtering.test.ts`, smoke route. | Validation-only. Do not duplicate the Feature Snapshot. |
| `/blacklist/` Intervention Ledger | `src/app/blacklist/client.tsx` renders stats, status charts, drilldown, quarterly chart, filters, and table. | `summary.stats.perCoinTotalEvents`, `perCoinBlacklistCounts`, `perCoinFrozenTotal`, `perCoinDestroyedTotal`, `summary.chart`, and `buildBlacklistStatusBuckets()` with keys `yes`, `possible`, `upstream`, `no`. The current summary payload has per-symbol totals, not contract-level event totals. | Implement `BlacklistInterventionLedger`: a compact ledger strip after `BlacklistStats` and before status charts. Blocks: resolved blacklist/freeze exposure buckets, stablecoin symbols with observed supported events, quarter peak/recent frozen/destroyed context. Keep event history visually separate from exposure buckets. | `src/components/blacklist-intervention-ledger.tsx`, `src/app/blacklist/client.tsx`, `src/lib/blacklist-status-buckets.ts` only if exported labels are reused, `docs/blacklist-tracker.md`. | `src/components/__tests__/blacklist-intervention-ledger.test.tsx`, changed blacklist status/chart tests as needed, local route smoke. | Implement Batch 3, frontend-only. Labels must say "resolved blacklist/freeze exposure buckets" and "stablecoin symbols with observed supported events"; no contract-level event wording without a backend aggregate. |
| `/cemetery/` Memorial | `src/components/cemetery-client.tsx`, `cemetery-tombstones.tsx`, and `cemetery-charts.tsx` render a bespoke memorial surface from static data. | Static `DEAD_STABLECOINS` powers cause/year/largest-collapse charts, tombstones, and autopsy cards. | Add cross-highlight between cause/year/largest charts, tombstones, and selected autopsy. Use URL-stable selection only if it does not create crawl/index noise. | `src/components/cemetery-client.tsx`, `src/components/cemetery-tombstones.tsx`, `src/components/cemetery-charts.tsx`, `docs/cemetery-and-compare.md`. | `src/components/__tests__/cemetery-client.test.tsx`, keyboard selection smoke. | Defer. Polished but less operationally valuable than the three chosen batches. |
| `/dependency-map/` Dependency Hubs Board | `src/app/dependency-map/client.tsx` currently computes `mobileSummary` inline, renders `ContagionGraph`, then `DependencyMapMobileSummary`; graph edges use upstream `from` -> dependent `to`. | `reportData.cards`, `reportData.dependencyGraph.edges`, `filterDependencyGraphEdgesToLive()`, `mcapMap` from `stablecoinsData.peggedAssets` and `sumPegBuckets()`. Existing mobile field `mcap` is hub own market cap. | Implement `DependencyHubsBoard` and pure `dependency-hubs-model.ts`. Extract the mobile hub logic into the pure model shared by desktop and mobile. Metrics: unique direct dependents, dimensionless summed direct dependency weight, optional deduped direct-dependent market-cap context, top example dependents, and edge-type mix. | `src/app/dependency-map/dependency-hubs-model.ts`, `src/app/dependency-map/dependency-hubs-board.tsx`, `src/app/dependency-map/client.tsx`, `src/components/dependency-map-mobile-summary.tsx`, `docs/dependency-map.md`. | `src/app/dependency-map/dependency-hubs-model.test.ts`, `src/app/dependency-map/dependency-hubs-board.test.tsx`, `src/app/dependency-map/client.test.tsx`. | Implement Batch 2. No transitive blast-radius, loss, liquidity, containment, mitigation, or guaranteed exposure claims. |
| `/stablecoin/[id]` Dossier Spine | `src/app/stablecoin/[id]/client.tsx` renders many route-local sections from `use-stablecoin-detail-view-model.ts`; route already has a hero signal rail and scrollspy. | Detail view model gathers supply, peg, liquidity, report card, redemption, yield, stress signals, flows, blacklist, live reserves, and static metadata. | Add `DossierSpine`: a compact "current strongest signal" strip with one selected signal from Safety, DEWS, Liquidity, Flows, Blacklist, Reserves, and Yield, each linking to its section. Needs a pure arbitration model and strict "current signal, not advice" copy. | `src/hooks/use-stablecoin-detail-view-model.ts`, `src/lib/stablecoin-detail-view-model.ts`, `src/components/stablecoin-detail/*`, `docs/stablecoin-detail-page.md`. | `src/app/stablecoin/[id]/client.test.tsx`, `src/lib/__tests__/stablecoin-detail-view-model.test.ts`, detail component tests. | Defer. High value, but easy to over-rank unlike signals without a separate arbitration review. |

## New Storytelling Opportunity Matrix

This matrix turns the remaining opportunity space into implementable work orders. "Implement" means this pass should ship it. "Validation-only" means the route already has the intended metaphor and only needs proof or a precise issue. "Follow-up" means implementation-ready but not in the first stack.

| Priority | Experience | Route | Existing data contract | Derivation/model contract | UI contract | Files and tests | Risk guard | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Yield Sources Board | `/yield/` | `YieldRanking[]` after `dedupeYieldRankings()`, `YieldRanking.altSources`, `YieldRanking.provenance`, `data.benchmarks`, `data.provenance`, active peg filter in `YieldClient`. | New pure `buildYieldSourceBoardModel(rankings, options)` returns `selectedCount`, `alternateCount`, `representedSourceCount`, `groups` by `yieldType` and `dataSource`, `selectedConfidenceCounts`, `sourceSwitchCount`, `anomalyCount`, source-row APY min/median/max over represented selected+alternate rows, and benchmark labels. Confidence is counted only from selected ranking `provenance.confidenceTier`; alt sources never receive confidence tiers. | A compact "source board" before the scatter: source-family lanes/cards, exact counts, confidence distribution labelled "selected-source confidence", source-row APY range/median, source-switch/anomaly badges when present, and a table/list fallback that exposes the same numbers without hover. Mobile stacks groups as rows with 44px controls; no nested cards inside cards. | `src/app/yield/source-board-model.ts`, `.test.ts`, `source-board.tsx`, `.test.tsx`, `src/app/yield/client.tsx`, `docs/yield-intelligence.md`; reuse existing yield table/source-sheet tests where affected. | APY is source-row context, not asset median, market median, safety, or investability. Do not render rejected, stale, unavailable, or historical-only sources absent from the current ranking payload. Do not imply alt-source confidence. | Implement Batch 1. |
| 2 | Dependency Hubs Board | `/dependency-map/` | `ReportCardsResponse.cards`, `dependencyGraph.edges`, `filterDependencyGraphEdgesToLive()`, live IDs from non-defunct cards, `mcapMap` from stablecoin circulating buckets. | New pure `buildDependencyHubsModel({ cards, edges, mcapMap })` returns ranked hubs with `id`, `label`, `dependentCount`, `summedDirectDependencyWeight`, `uniqueDependentMcapUsd`, `hubMcapUsd`, `examples`, and `edgeTypeBreakdown`. Dedupe dependent IDs for counts and dependent market cap; still sum all direct edge weights for `summedDirectDependencyWeight`. | Desktop board beside/under the graph: "upstream hubs", counts, summed direct dependency weight, modeled dependent market-cap context, examples. Mobile summary consumes the same model and is the primary readable surface below the graph. | `src/app/dependency-map/dependency-hubs-model.ts`, `.test.ts`, `dependency-hubs-board.tsx`, `.test.tsx`, `src/app/dependency-map/client.tsx`, `src/components/dependency-map-mobile-summary.tsx`, `docs/dependency-map.md`. | Summed direct dependency weight is dimensionless and is not USD. `uniqueDependentMcapUsd` is direct modeled dependent market cap, not loss, liquidity, or guaranteed exposure. Existing mobile `mcap` hub value must not be reused as dependent exposure. | Implement Batch 2. |
| 3 | Intervention Ledger | `/blacklist/` | `BlacklistSummaryResponse.stats`, `summary.chart`, `buildBlacklistStatusBuckets()`, current filters and status drilldown state. | New `buildBlacklistInterventionLedgerModel()` inside the component or a small pure helper if logic grows. Return exposure bucket rows, top stablecoin symbols with observed supported events from `perCoinTotalEvents`, top currently frozen symbols from `perCoinFrozenTotal`, peak/recent quarter context from `summary.chart`, and coverage caveats. Contract-level event totals are not available in the current summary payload and stay out of scope. | Ledger strip after stats: resolved exposure buckets first, observed supported event leaders second, quarter context third. Use compact bars/ledger rows, not another full chart. Every visual row has exact count/USD text. | `src/components/blacklist-intervention-ledger.tsx`, test under `src/components/__tests__/`, `src/app/blacklist/client.tsx`, `docs/blacklist-tracker.md`. | Separate resolved blacklist/freeze exposure from observed supported tracker events. Event count is observed supported history, not policy probability. Bucket `possible` means direct possible token/vault control; `upstream` means reserve/custody/parent exposure; bucket `no` means no resolved exposure in the current model. | Implement Batch 3 frontend-only. |
| 4 | Coverage Control Tower Audit | `/coverage/` | `useCoverageMatrixModel()` feature summaries, pricing-source summary, market-cap reach, lens summary. | No new model unless audit finds a precise gap. Record whether the existing Feature Snapshot already satisfies count reach, market-cap reach, widest/narrowest, and major-heavy explanation. | If untouched, no UI change. If refined, copy-only or small label treatment; no duplicate reach chart. | `agents/` validation note; optional `docs/coverage-page.md` and coverage tests only if changed. | Labels must mean Pharos feature availability/status, not generalized asset safety or "data quality". | Validation-only. |
| 5 | Liquidity Exit Route Audit | `/liquidity/` | `buildLiquidityExitRouteModel()`, global DEX route shares, `protocolTvl`, chain/protocol rails, HHI/concentration, pool balance, organic share. | No new model unless audit finds a precise gap. If changed, preserve nullable global score handling and derive HHI from `protocolTvl`. | If untouched, no UI change. If refined, improve existing exit-route rails rather than introducing a second route map. | `agents/` validation note; optional `docs/dex-liquidity.md`, `liquidity-stats` tests only if changed. | Do not overstate exit safety; route map describes current DEX telemetry and concentration. | Validation-only. |
| 6 | Flow Pressure Receipt | `/flows/` | `useMintBurnFlows()`, `useMintBurnGauge()`, local `FlowBrrrOverview` snapshot calculations. | Extract `buildFlowPressureReceiptModel()` returning mint/burn/net totals, top symbols, tracked scope, NR/lag/coverage state, and timeframe labels. | Receipt strip physically attached to the machine metaphor and exact-value list/table counterpart. | `src/lib/flow-pressure-receipt-model.ts`, `src/components/flow-pressure-receipt.tsx`, flow tests, `docs/mint-burn-flows.md`. | Must disclose tracked-chain scope and lag; do not imply global supply creation/destruction when only tracked contracts are present. | Follow-up, implementation-ready. |
| 7 | PSI Beam Dimmers | `/stability-index/` | `buildPsiComponentData()`, `buildPsiContributorRows()`, event timeline rows and history stats. | `buildPsiBeamDimmers()` can reuse component data to classify component pressure lanes and top current contributor context. | Thin dimmer rail near the lighthouse hero with exact PSI component values and deltas. | `src/app/stability-index/psi-beam-dimmers.tsx`, view-model tests, `docs/stability-index.md`. | Say component pressure, not event causality. Do not change PSI scoring. | Follow-up, implementation-ready. |
| 8 | Stablecoin Dossier Spine | `/stablecoin/[id]` | Existing stablecoin detail view model aggregates Safety, DEWS, Liquidity, Flows, Blacklist, Reserves, Yield, and static metadata. | A pure `buildStablecoinDossierSpine()` ranks route-local signals by explicit, reviewed display priority and returns one current summary per signal family. | Sticky-or-near-hero compact strip linking to sections, with exact values and "current signal" labels. | Detail view-model/component tests and `docs/stablecoin-detail-page.md`. | Avoid creating a hidden composite score or recommendation. | Follow-up after separate arbitration review. |

## Concrete Release Scope

### Batch 1: Trust And Source Provenance

Add `/yield/` Yield Sources Board:

- pure model groups published selected ranking sources plus published alternate sources by yield type and `dataSource`; rejected, stale, unavailable, and historical-only sources are not represented unless they are in the current ranking payload;
- confidence-tier counts apply only to selected/best source rows where `YieldRanking.provenance.confidenceTier` exists;
- confidence labels must say "selected-source confidence" and never imply overall source coverage;
- alternate sources are grouped by source family/data source and yield type, never by confidence tier;
- visual renders source lanes/cards above the scatter/table;
- shows selected-source count, alternate-source count, selected-source confidence distribution, source-row APY context over the represented selected+alternate payload, source-switch/anomaly counts when present, and caveat that APY is not an asset median, market median, investability, or safety;
- no new API calls or scoring changes.

### Batch 2: Systemic Dependency Readability

Add `/dependency-map/` Dependency Hubs Board:

- pure model extracts current mobile hub calculation and shares it between desktop and mobile;
- visual ranks top upstream hubs with unique direct dependent count, dimensionless summed direct dependency weight, optional deduped direct-dependent market cap, and example dependents;
- tests must prove duplicate direct dependents are deduped for `dependentCount` and `uniqueDependentMcapUsd`, while `summedDirectDependencyWeight` remains the sum of direct edge weights;
- tests must prove hub market cap is not used as dependent-market-cap context;
- graph remains the main visual;
- caveat: modeled dependent market-cap context is not guaranteed loss.

### Batch 3: Intervention Storytelling

Add `/blacklist/` Intervention Ledger:

- visual summarizes resolved direct/possible/upstream/no blacklist/freeze exposure buckets and top stablecoin symbols by observed supported events;
- implementation labels the observed-event block as "stablecoin symbols with observed supported events";
- uses existing summary/status data only;
- does not mention contracts in event-leader labels unless a future backend aggregate adds contract-level totals;
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
- No changes to unrelated chains, alt-peg, or design-doc files.
- No broad redesign of route shells, navigation, fonts, tokens, or shadcn primitives.
- No Canvas/WebGL or new chart library dependency.
- No safety score, liquidity score, PSI, DEWS, or report-card scoring changes.

## Planned Files

Expected new/changed files:

- `agents/plans/2026-04-24-data-visualization-storytelling-enhancement-pass.md`
- `src/app/yield/source-board-model.ts`
- `src/app/yield/source-board-model.test.ts`
- `src/app/yield/source-board.tsx`
- `src/app/yield/source-board.test.tsx`
- `src/app/yield/client.tsx`
- `src/app/dependency-map/dependency-hubs-model.ts`
- `src/app/dependency-map/dependency-hubs-model.test.ts`
- `src/app/dependency-map/dependency-hubs-board.tsx`
- `src/app/dependency-map/dependency-hubs-board.test.tsx`
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

- `npm test -- src/app/yield/source-board-model.test.ts src/app/yield/source-board.test.tsx src/app/dependency-map/dependency-hubs-model.test.ts src/app/dependency-map/dependency-hubs-board.test.tsx src/components/__tests__/blacklist-intervention-ledger.test.tsx`
- include changed existing component tests, especially `src/app/dependency-map/client.test.tsx`, `src/components/__tests__/blacklist-stats.test.tsx`, `src/components/__tests__/blacklist-status-charts.test.tsx`, `src/components/__tests__/liquidity-stats.test.tsx` if liquidity is touched, and `src/lib/__tests__/coverage.test.ts` if coverage is touched.

Broad validation:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- local static-export smoke: start the static export server with `npm run serve:static-export > /tmp/pages-smoke-server.log 2>&1 &`, wait for `http://127.0.0.1:4173`, then run `SMOKE_UI_OVERFLOW_ROUTES="/yield/,/dependency-map/,/blacklist/" npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local`.
- additional accessibility check for `/yield/`, `/dependency-map/`, and `/blacklist/`: keyboard tab traversal, visible focus, screen-reader label/summary presence, 200% zoom, both-theme contrast/manual review for the new visual marks, and no page-level horizontal overflow.
- docs checks when docs change: `npm run check:verified-doc-links` and `npm run check:doc-source-paths`; broader doc validation is also covered by merge gate.
- before committing a work slice, `npm run test:merge-gate -- --staged` is allowed as a staged-diff check; after all commits are created, run the normal committed-stack gate `npm run test:merge-gate`.

Deployment:

- implement in a clean worktree and make logical commits:
  1. plan/research artifact,
  2. yield source provenance visual and docs,
  3. dependency hubs board and docs,
  4. blacklist intervention ledger and docs.
- use pathspec-only staging or pathspec-limited commits to exclude unrelated dirty files.
- immediately before push, run `git fetch origin main`, then `git log --oneline origin/main..HEAD` and confirm it contains the logical visualization-pass commits only.
- push from the clean implementation branch with a normal non-force push to `origin` using `git push origin HEAD:main`. If the fetch shows remote `main` moved unexpectedly, stop and reconcile before pushing.

## Review Loop Criteria

Reviewers classify issues as:

- blocker: plan would likely ship misleading data, break repo rules, or touch unrelated dirty work;
- major: plan is feasible but misses a necessary test/doc/scope constraint;
- minor: naming, ordering, copy, or small implementation-risk clarification.

The plan is ready to implement only when review returns zero blockers, zero majors, and fewer than three minors.
