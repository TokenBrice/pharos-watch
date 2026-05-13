# Yield Intelligence v8.1 Implementation Plan

Date: 2026-05-13
Status: implementation-ready follow-up plan
Scope: Yield Intelligence v8.1 follow-up after the v8.0 publication, source-risk, and `/yield/` route rollout.

## Objective

Turn the v8.0 rollout into an operator-visible and user-understandable v8.1 release. The immediate priority is to verify that production emits the v8.0 contract that docs and UI now describe, then make source risk, source selection, source switches, and source coverage explainable across the API, UI, docs, and tests.

## Evidence Reviewed

- Roadmap artifact: `agents/yield-intelligence-v8-roadmap-2026-05-13.md`.
- Calibration artifacts: `docs/process/yield-pys-v8-calibration-2026-05-13.md` and `docs/process/yield-pys-v8-production-sample-calibration-2026-05-13.md`.
- Live production checks on 2026-05-13:
  - `https://pharos.watch/yield/` returned HTTP 200 and Playwright found `h1 = "Yield Intelligence"`, methodology `v8.0`, and no browser console errors.
  - `https://api.pharos.watch/api/yield-rankings` returned HTTP 401 without `X-API-Key`, which is expected for the protected public API lane.
  - `https://pharos.watch/_site-data/yield-rankings` returned 131 rows, `updatedAt = 1778692802`, 73 retained alternates, no top-level `methodology`, no top-level `publication`, zero populated `sourceRisk` rows, and zero rows with publication generation metadata.
  - `https://pharos.watch/_site-data/yield-history?stablecoin=usdt-tether` returned 2,282 points, methodology `v8.0`, and zero points with `publicationGenerationId`.
- Review swarm findings across roadmap completion, UX clarity, feature additions, coverage, contracts, docs, and operations.

## Implementation Assumptions

- `v8.1` is an incremental release on top of current `v8.0`, not a rewrite.
- Unknown source-risk evidence remains neutral. Do not invent venue tiers or penalties to improve coverage.
- Docs, UI, API examples, OpenAPI/Postman artifacts, and tests must agree on field names and semantics before a task is done.
- Score-affecting changes require methodology and timeline updates with numeric versioning. Pure docs, admin visibility, operator tooling, or copy changes do not require a methodology bump.
- The protected API payload may differ from the public site-data lane. The first implementation task must verify both lanes with an API key or wrangler/D1 before deciding whether the production gap is cache, proxy, deploy, or publisher behavior.

## Current v8.0 Status

| Area | Status | Notes |
| --- | --- | --- |
| Publication generations | Partial | Migration, generation table, state columns, and atomic batch publication exist locally. Production site-data still shows no generation metadata in rankings/history. |
| Source-risk schema | Partial | Optional nested `sourceRisk` contract and scorer support exist. Production site-data rankings currently have zero populated `sourceRisk` rows. |
| PYS v8 scoring | Done in code | Source-risk penalty support and calibration artifacts exist. Live production still needs post-population calibration evidence. |
| `/yield/` route | Partial | Route renders and exposes methodology v8.0. Source-board language and source-risk explanations remain too internal. |
| API contracts | Partial | Markdown docs are richer than generated OpenAPI/Postman artifacts, which still use generic JSON responses for yield endpoints. |
| Operator health | Partial | Backend computes source-risk coverage. Admin Yield Health does not surface it yet. |
| DEWS/report-card integration | Partial | Structured-yield placeholders and report-card no-op boundaries exist, but docs and future handoff are incomplete. |
| Test coverage | Partial | Core layers have tests, but v8 source-risk golden rows are not reused across scoring, publication, API, history, UI, and status coverage. |

## P0: Production Contract And User Comprehension

### YI81-P0-01: Verify and fix the production v8 payload contract

Goal: prove whether production rankings/history expose the v8.0 fields promised by docs and UI, then fix the lane that drops or fails to populate them.

Primary surfaces:

- `worker/src/api/cache-handlers.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/cron/yield-sync/*`
- `worker/src/lib/status/yield-health.ts`
- `functions/_site-data/[[path]].ts`
- `functions/lib/site-data-origin.ts`
- `shared/lib/site-data-lane.ts`
- `docs/api-reference.md`
- `docs/yield-intelligence.md`

Implementation steps:

1. Fetch protected `https://api.pharos.watch/api/yield-rankings` with a valid `X-API-Key` and compare it with `https://pharos.watch/_site-data/yield-rankings`.
2. Use wrangler/D1 read-only queries to inspect the latest `yield-rankings` cache row, latest `yield_publication_generations`, current `yield_data`, and representative `yield_history` rows.
3. Identify whether missing `sourceRisk`, `publication`, `methodology`, and `publicationGenerationId` are caused by stale production code, cache shape, site-data proxy stripping, publisher serialization, or missing D1 population.
4. Add a regression fixture for the exact production-shaped cache payload that failed.
5. Fix only the failing lane. Do not add frontend inference for missing backend fields.

Acceptance criteria:

- Site-data rankings include top-level methodology/publication metadata or docs explicitly state why rankings use another metadata lane.
- Rows that have measured source risk include nested `sourceRisk` in both protected API and site-data responses.
- Published rankings/history rows expose `publicationGenerationId` where available; legacy rows remain null-safe.
- The v8 production calibration artifact can be regenerated with non-zero coverage for populated source-risk fields, or the artifact documents a verified reason coverage is intentionally zero.
- Focused API, history, and site-data proxy tests cover the fixed shape.

Validation:

- `npm test -- worker/src/api/__tests__/yield-rankings.test.ts worker/src/api/__tests__/yield-history.test.ts`
- Relevant site-data route tests, if present.
- Protected API smoke with `X-API-Key`.
- Public site-data smoke from `https://pharos.watch/_site-data/yield-rankings`.

### YI81-P0-02: Rename and explain source-board public vocabulary

Goal: make the Yield Sources board understandable as provenance coverage, not a recommendation table or asset count.

Primary surfaces:

- `src/app/yield/source-board.tsx`
- `src/app/yield/source-board-model.ts`
- `docs/yield-intelligence.md`

Copy changes:

- `Selected` -> `Chosen sources`
- `Alt` -> `Retained alternates`
- `Source rows` -> `Source observations`
- `Source families` -> `Data families`
- Header helper: `Counts every chosen source plus retained alternates for the rows currently visible. This is provenance coverage, not a recommendation ranking.`
- `switch` -> `source changed`

Acceptance criteria:

- A user can tell the board counts source observations, not stablecoins.
- Confidence-tier, source-switch, and anomaly labels have plain-language tooltips.
- Docs use the same public labels as the route.
- Mobile and desktop layouts keep labels readable without overflow.

Validation:

- Focused component tests for `source-board`.
- Playwright screenshot or snapshot check for `/yield/` desktop and mobile.

### YI81-P0-03: Add source-risk driver explanations at the point of use

Goal: explain why source risk affects PYS instead of showing only a penalty number.

Primary surfaces:

- new `yield-source-risk` helper under `src/lib/`, or the existing yield constants helper if it already owns this vocabulary
- `src/components/yield-leaderboard-table-row.tsx`
- `src/components/yield-source-sheet.tsx`
- `src/components/yield-detail-section.tsx`

Implementation steps:

1. Add a pure helper that maps populated `sourceRisk` fields to driver labels and copy.
2. Use the helper in PYS tooltips, source sheet details, and detail-section explanations.
3. Keep missing `sourceRisk` neutral and avoid alarming copy for unknown evidence.

Driver labels:

- `reward-heavy`: most APY comes from incentives, not base yield.
- `thin source depth`: venue TVL is small relative to the stablecoin supply or row context.
- `stale source`: latest source observation is older than expected for its family.
- `limited history`: observation count is too low for mature confidence.
- `source changed`: selected source changed versus the prior published snapshot.

Acceptance criteria:

- Rows with high `rewardShare`, low `sourceDepthRatio`, stale `sourceAgeSeconds`, low `observationCount30d`, or recent switches show distinct driver explanations.
- Missing source-risk data remains neutral.
- The same helper drives leaderboard, source sheet, and detail views.

Validation:

- Component tests for all driver labels and missing-data behavior.
- `npm run typecheck`.

### YI81-P0-04: Surface source-risk coverage in operator Yield Health

Goal: make neutral fallback coverage visible to operators before it becomes a silent quality gap.

Primary surfaces:

- `src/components/status/yield-health.tsx`
- `shared/types/status.ts`
- `worker/src/lib/status/yield-health.ts`
- `docs/runbooks/yield-health.md`

Implementation steps:

1. Render `yieldHealth.sourceRiskCoverage` in the admin Yield Health card.
2. Show coverage for at least `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, and `sourceRiskScore`.
3. Treat `venueRiskTier = "unknown"` as missing evidence, not high risk.
4. Add runbook first checks and read-only JSON/D1 inspection commands.

Acceptance criteria:

- Admin status shows source-risk coverage ratios and degraded coverage without marking public rankings stale.
- Runbook warns operators not to backfill guessed risk tiers or manually edit rankings.
- Existing `statusImpact` behavior is unchanged.

Validation:

- `npm test -- worker/src/lib/status/__tests__/yield-health.test.ts`
- Component tests for healthy, degraded, and missing coverage states.

### YI81-P0-05: Regenerate post-live v8 source-risk calibration

Goal: replace the neutral-fallback production baseline with real populated source-risk evidence after P0-01 is fixed.

Primary surfaces:

- `scripts/yield-pys-v8-calibration.ts`
- `docs/process/`
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`

Acceptance criteria:

- New committed artifact records live coverage for `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, and `sourceRiskScore`.
- Artifact includes rank churn, PYS distribution deltas, capped rows, null-rate table, top movers, and non-USD cohorts.
- Methodology docs no longer say the latest production sample predates populated public `sourceRisk.*` fields once this is true.

Validation:

- Calibration script run against a saved production payload.
- Docs links verified by `npm run lint` or the repo's doc checks if available.

## P1: Product And Contract Improvements

### YI81-P1-01: Populate deterministic rank-change attribution

Goal: explain why live ranking differs from published ranking or filtered view order.

Primary surfaces:

- `shared/types/yield.ts`
- `worker/src/api/cache-handlers.ts`
- `src/components/yield-leaderboard-table-row.tsx`
- `src/components/yield-source-sheet.tsx`
- `src/lib/yield-view-model.ts`

Drivers to consider:

- APY change
- safety-score change
- source-risk penalty change
- benchmark change
- source switch
- volatility/stability change
- venue depth change

Acceptance criteria:

- `/api/yield-rankings` rows include `rankChangeAttribution` when `publishedRank` and `liveRank` differ.
- Primary driver selection is deterministic and tested.
- UI shows compact rank movement with a tooltip that names the driver.
- Filtered view rank remains separate from API published/live rank.

### YI81-P1-02: Add a depth and capacity lens

Goal: help users distinguish high APY on thin venues from lower APY on deeper venues.

Primary surfaces:

- new `yield-source-risk` helper under `src/lib/`, or the existing yield constants helper if it already owns this vocabulary
- `src/lib/yield-view-model.ts`
- `src/components/yield-leaderboard-controls.tsx`
- `src/app/yield/source-board.tsx`
- `docs/yield-intelligence.md`

Acceptance criteria:

- Rows classify into `deep`, `moderate`, `thin`, or `unknown` from documented thresholds using `sourceRisk.sourceDepthRatio` and `sourceTvlUsd`.
- `/yield/` gets a URL-persisted depth filter or `hide thin venues` control.
- Docs state this is venue-depth context, not guaranteed executable capacity.
- Missing TVL or supply resolves to `unknown`.

### YI81-P1-03: Improve source-switch audit surfaces

Goal: explain source changes without implying asset risk changed.

Primary surfaces:

- `src/components/yield-source-sheet.tsx`
- `src/components/yield-history-chart.tsx`
- `src/lib/yield-view-model.ts`
- `worker/src/api/yield-history.ts`

Acceptance criteria:

- Switched rows can be filtered on `/yield/`.
- Source sheet shows current source, previous source key/label when available, selection reason, and rejected alternates.
- History chart switch markers include readable tooltip copy.
- No new backend schema is added unless previous source labels cannot be derived safely.

### YI81-P1-04: Publish richer OpenAPI and Postman yield contracts

Goal: align generated artifacts with the richer Markdown API reference.

Primary surfaces:

- `public/openapi.json`
- `public/postman/pharos-api.postman_collection.json`
- `scripts/lib/public-api-artifact-catalog.ts`
- `docs/api-reference.md`

Acceptance criteria:

- OpenAPI includes named schemas for `YieldRankingsResponse`, `YieldRanking`, `AltYieldSource`, `YieldSourceRisk`, `YieldPublicationMetadata`, `YieldHistoryResponse`, and `YieldHistoryPoint`.
- Postman includes examples for `yield-history?mode=best` and `yield-history?mode=source&sourceKey=...`.
- `npm run check:openapi` and `npm run check:postman` pass.

### YI81-P1-05: Build shared source-explorer model

Goal: stop duplicating source/alternate presentation rules across leaderboard sheet, detail view, and source board.

Primary surfaces:

- `src/app/yield/source-board-model.ts`
- `src/components/yield-source-sheet.tsx`
- `src/components/yield-detail-section.tsx`
- `src/lib/yield-view-model.ts`

Acceptance criteria:

- New `buildYieldSourceExplorerModel()` returns selected source, retained alternates, source identity, source-risk labels, source-switch metadata, and benchmark context.
- Leaderboard sheet and stablecoin detail section consume the same model.
- Duplicate labels keep source-key identity.
- Missing URLs render safely.

### YI81-P1-06: Lock source-risk behavior with reusable golden fixtures

Goal: make future v8.1 changes fail loudly if source-risk semantics drift.

Primary surfaces:

- `shared/lib/__tests__/yield-scoring.test.ts`
- `worker/src/cron/__tests__/yield-evaluation.test.ts`
- `worker/src/cron/__tests__/yield-publication.test.ts`
- `worker/src/api/__tests__/yield-rankings.test.ts`
- `worker/src/api/__tests__/yield-history.test.ts`
- `src/components/__tests__/*`

Golden rows:

- reward-heavy
- stale source age
- low source depth
- source-switch churn
- bootstrap observation count
- zero/negative APY
- missing safety

Acceptance criteria:

- PYS never improves from source-risk penalty alone.
- Neutral or missing evidence remains penalty `1`.
- Source-risk penalty caps at `2.5`.
- Zero or negative APY remains PYS `0`.
- Nested public `sourceRisk` fields are used; flattened legacy shorthand is not accepted as a substitute in public payload tests.

## P2: Risk Model, Ops, And Cross-Feature Follow-Up

### YI81-P2-01: Add sparse reviewed `yieldRiskConfig`

Goal: give venue/source facts a controlled home without guessing risk for unknown venues.

Primary surfaces:

- `worker/src/cron/yield-sync/source-risk.ts`
- new worker/shared yield risk config module
- `shared/types/yield.ts`
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`

Acceptance criteria:

- Registry is typed against `YieldVenueRiskTier`.
- Known venues such as Aave, Compound, Spark, Maple, Yearn, Morpho, Pendle, and Beefy can receive reviewed tiers and rationale.
- Unknown remains neutral.
- PYS changes only where the registry provides non-unknown evidence.
- Docs explain mapping source, review cadence, and the non-goal of guessed penalties.

### YI81-P2-02: Decide and document report-card source-risk boundary

Goal: remove ambiguity around whether external yield opportunities affect base stablecoin report-card scores.

Primary surfaces:

- `shared/lib/report-card-yield-risk.ts`
- `docs/report-cards.md`
- `docs/yield-intelligence.md`
- report-card methodology/timeline docs if behavior changes

Acceptance criteria:

- Docs state that current yield source-risk does not affect Safety Score, Dependency Risk, or Resilience.
- Docs name explicit no-op reasons: external lending opportunity, missing yield config, missing source risk, and source-risk unconsumed.
- Any future score-affecting use requires report-card methodology and timeline updates.

### YI81-P2-03: Implement structured DEWS yield signals

Goal: replace warning-string-only consumption with structured source-risk and rank-attribution inputs.

Primary surfaces:

- `worker/src/lib/dews.ts`
- DEWS source-state/scoring modules
- `shared/lib/dews-config.ts`
- DEWS methodology docs and timeline

Acceptance criteria:

- DEWS consumes structured source-risk and source-switch signals only where fields are populated.
- Missing legacy rows remain explicit no-ops.
- Methodology version bump is applied if DEWS scoring behavior changes.

### YI81-P2-04: Add read-only source-decision debug endpoint

Goal: make generation/source debugging possible without direct SQL for routine operator checks.

Primary surfaces:

- worker admin routes
- `worker/src/api/*`
- `docs/api-reference.md`
- `docs/runbooks/yield-rankings-stale-or-missing.md`

Acceptance criteria:

- Access-gated endpoint returns recent generation summaries and optional per-stablecoin selected/rejected source-decision evidence.
- Endpoint is `no-store`, documented as admin-only, and excluded from public OpenAPI/Postman artifacts.
- Handler tests cover auth, query bounds, generation filtering, and compact response shape.

### YI81-P2-05: Turn coverage audit into an operator queue

Goal: move monthly coverage audit from report-only to actionable triage without prematurely adding noisy persistence.

Primary surfaces:

- `worker/src/cron/yield-coverage-audit.ts`
- status/admin components
- `docs/runbooks/yield-health.md`
- `docs/yield-intelligence-operations.md`

Acceptance criteria:

- Admin surfaces headline gaps and recommendation candidates.
- Docs define `accept`, `dismiss`, `intentional-gap`, and `watch` actions.
- Persistent dismissal state remains deferred until monthly report noise proves it is needed.

### YI81-P2-06: Add Yield Health thresholds table

Goal: make operator thresholds discoverable without reading `loadYieldHealthSummary()`.

Primary surfaces:

- `docs/yield-intelligence-operations.md`
- `docs/runbooks/yield-health.md`

Acceptance criteria:

- Operations docs include owner cron/cache, warn threshold, stale threshold, public-critical impact, and admin-watch impact for rankings, safety coverage, supplemental source age, benchmark fallback, coverage audit age, and source-risk coverage.
- Table links relevant runbooks.

## Recommended Execution Order

1. YI81-P0-01: production contract verification/fix.
2. YI81-P0-04: source-risk coverage in Yield Health.
3. YI81-P0-05: post-live calibration refresh.
4. YI81-P0-02 and YI81-P0-03: public copy and source-risk explanations.
5. YI81-P1-06: reusable golden fixtures.
6. YI81-P1-01, YI81-P1-02, and YI81-P1-03: rank, depth, and switch explainability.
7. YI81-P1-04 and YI81-P1-05: generated contracts and shared source-explorer model.
8. P2 tasks after production coverage and public explanation are stable.

## Definition Of Done For v8.1

- Protected API and public site-data lanes agree on v8 methodology, publication, source-risk, and history metadata semantics.
- Operators can see source-risk coverage and know how to triage missing evidence.
- Users can understand chosen sources, retained alternates, confidence tiers, source changes, warning signals, and benchmark context without reading internal docs.
- Generated OpenAPI/Postman artifacts match the Markdown API reference for yield endpoints.
- Source-risk behavior is covered by reusable golden fixtures across scoring, publication, API, history, UI, and status layers.
- Any score-affecting work includes methodology and timeline updates with numeric versioning.
