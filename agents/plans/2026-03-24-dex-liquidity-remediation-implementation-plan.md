# DEX Liquidity Remediation Implementation Plan

Date: 2026-03-24

Companion audit:
- `agents/audits/2026-03-24-dex-liquidity-dex-module-audit.md`

Scope:
- DEX-side liquidity pipeline only
- includes discovery, direct API adapters, dedup, scoring inputs, DEX price observations, persistence, and API shaping
- excludes Redemption Backstop

Primary goals:
- Improve DEX liquidity data accuracy and recall
- Make confidence and provenance semantics honest
- Reduce code duplication and hotspot complexity
- Preserve existing API contracts unless a documented contract change is deliberate

Constraints:
- Keep changes root-cause driven
- Maintain backward-compatible D1 migrations
- Preserve pricing-pipeline downstream behavior unless the change is explicitly intended and tested
- Update docs whenever methodology, source list, or operator semantics change

## Executive Delivery Strategy

Ship this work in seven phases.

Order matters:
- Characterization and observability must land before behavior changes
- Coverage-recall fixes should land before scoring-model refinements
- Provenance semantics should land before confidence-model changes
- Architecture refactors should happen after key behavioral fixes are locked in by tests

Recommended order:

| Phase | Focus | Primary Outcome | Size |
| --- | --- | --- | --- |
| 0 | Characterization and observability | Lock current behavior and expose hidden coverage gaps | S |
| 1 | Coverage recall hardening | Stop silently missing pools and weakly covered assets | M |
| 2 | Provenance and measurement honesty | Distinguish measured vs assumed vs synthetic inputs | M |
| 3 | Confidence and fallback policy upgrade | Make row-level trust reflect evidence quality | M |
| 4 | Source-normalization remediation | Fix source-specific accuracy weaknesses | M |
| 5 | Pool model and contribution-engine refactor | Remove duplicated merge/scoring logic | L |
| 6 | Scoring/API cleanup and rollout hardening | Finish semantics, docs, and operational safety | M |

## Success Criteria

Functional success:
- GT and CoinGecko onchain no longer silently truncate to the first page when more usable pools exist
- fallback sources can improve weak partial coverage, not only fill zero-coverage holes
- direct APIs, staged pools, and synthetic orderbook sources carry honest provenance and maturity semantics
- DEX price observations and liquidity rows expose confidence that reflects actual source breadth and measurement quality
- protocol TVL anti-inflation controls still suppress obvious virtual-reserve inflation without clipping legitimate direct-API liquidity

Engineering success:
- pool contribution logic is defined once rather than duplicated across multiple merge paths
- `fetch-primary.ts`, `scoring.ts`, `orchestrator.ts`, and `dex-api-common.ts` are materially smaller and easier to review
- direct-API fetch results use an explicit object shape rather than array metadata mutation
- source-specific behavior lives in smaller adapters with a shared normalization contract

Operational success:
- cron metadata exposes pagination, truncation, per-source coverage, and weak-coverage recovery telemetry
- operators can explain why a row is trusted, synthetic, decayed, capped, or incomplete
- rollout can happen incrementally without breaking current readers or requiring destructive migrations

## Delivery Principles

1. Accuracy before elegance.
2. Recall before scoring refinements.
3. Measured data must not be conflated with heuristics.
4. Confidence is a modeled output, not a label shortcut.
5. Refactors must preserve behavior until the behavior change is deliberate and covered by tests.

## Phase 0: Characterization and Observability

Objective:
- Add regression coverage and telemetry for the exact failure classes identified in the audit before changing behavior.

Primary files:
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`
- `worker/src/cron/__tests__/dex-api-common.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`

Implementation tasks:
- Add characterization tests for first-page-only GT and CG onchain fetch behavior so the current truncation is explicit.
- Add tests for weak-partial coverage cases:
  - one pool but no price observation
  - one thin price observation but poor corroboration
  - fallback not firing today
- Add tests for direct-API maturity defaults, orderbook synthetic pair-quality assumptions, and staged confidence decay.
- Add tests for protocol TVL cap behavior:
  - legitimate direct-API liquidity
  - obvious inflated fallback liquidity
- Add tests for ambiguous derived-identity observation collapse.
- Add cron metadata assertions for new telemetry fields once introduced in later phases.

Acceptance criteria:
- Every P0/P1 audit issue has a failing test or explicit characterization before remediation starts.
- The test surface distinguishes missing coverage from weak partial coverage.

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts worker/src/cron/__tests__/dex-liquidity-scoring.test.ts worker/src/cron/__tests__/dex-api-common.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts
```

## Phase 1: Coverage Recall Hardening

Objective:
- Improve pool recall and stop treating weak partial coverage as “done”.

Primary files:
- `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`
- `worker/src/lib/coingecko-onchain.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `docs/dex-liquidity.md`
- `docs/worker-and-api-limits.md`

Implementation tasks:
- Add bounded pagination support for:
  - GeckoTerminal token pools
  - CoinGecko onchain token pools
- Introduce explicit per-token limits:
  - `maxPages`
  - `maxPools`
  - `paginationTruncated`
  - source-specific time budget ceilings
- Extend fallback targeting beyond `!hasPools || !hasDexPrice`.
- Add a `needsCoverageEnrichment()` predicate based on:
  - pool count
  - total covered TVL
  - protocol count in price observations
  - coverage class/confidence
  - measured-balance TVL share
- Run DexScreener and CG-tickers fallback for weak-partial rows, not only zero-coverage rows.
- Persist and emit telemetry:
  - `pagesFetchedBySource`
  - `poolsSeenBySource`
  - `paginationTruncatedBySource`
  - `weakCoverageCoins`
  - `coverageRecoveredCoins`

Recommended guardrails:
- keep crawl budgets bounded and fail soft
- do not let pagination upgrades consume the full trigger slot
- prefer deterministic page caps over “fetch until exhausted”

Acceptance criteria:
- GT and CG onchain can ingest more than the first page when useful pools exist.
- fallback enrichment runs for weak partial coverage and raises real coverage in tests.
- cron metadata can distinguish complete coverage from truncated coverage.

Verification:
```bash
npm test -- --run worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts
```

## Phase 2: Provenance and Measurement Honesty

Objective:
- Separate measured inputs from heuristic defaults and synthetic constructs.

Primary files:
- `worker/src/lib/dex-api-common.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/types.ts`
- `worker/src/cron/dex-liquidity/persistence.ts`
- `worker/src/api/dex-liquidity.ts`
- `docs/dex-liquidity.md`
- `docs/api-reference.md`

Recommended model expansion:
```ts
interface PoolMeasurementFlags {
  tvlMeasured: boolean;
  volumeMeasured: boolean;
  balanceMeasured: boolean;
  maturityMeasured: boolean;
  priceMeasured: boolean;
  synthetic: boolean;
  decayed: boolean;
  capped: boolean;
}
```

Implementation tasks:
- Add canonical provenance/measurement flags to the internal normalized pool shape and serialized `top_pools_json`.
- Replace direct-API `maturityDays: 90` with:
  - actual creation time when available, or
  - conservative unknown-maturity fallback plus `maturityMeasured = false`
- Replace CG-tickers orderbook pair-quality spoofing with an explicit orderbook quote-quality path.
- Mark synthetic orderbook TVL as synthetic rather than measured.
- Mark staged TVL/volume as decayed when freshness confidence reduced them.
- Distinguish:
  - measured balance
  - inferred balance
  - neutral balance fallback
- Ensure frontend/API surfaces can expose the new semantics without breaking existing consumers.

Migration recommendation:
- avoid wide schema changes if the new flags can live inside existing JSON blobs first
- only add D1 columns when a field is needed for query-time filtering or row-level API access

Acceptance criteria:
- every pool row can explain whether its TVL, volume, balance, maturity, and price are measured or assumed
- orderbook liquidity no longer gains high pair-quality by pretending to trade against `USDC`
- direct-API pools no longer receive maturity credit they did not earn

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/dex-api-common.test.ts worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts worker/src/cron/__tests__/dex-liquidity-scoring.test.ts
cd worker && npx tsc --noEmit
```

## Phase 3: Confidence and Fallback Policy Upgrade

Objective:
- Replace coarse coverage labels with evidence-aware confidence and fix weak trust semantics.

Primary files:
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/constants.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/dex-liquidity-history.ts`
- `docs/dex-liquidity.md`
- `docs/api-reference.md`

Implementation tasks:
- Replace the current `classifyCoverage()` shortcut with a composite confidence model.
- Base confidence on:
  - source family count
  - protocol count
  - chain count
  - measured-balance TVL share
  - measured-organic TVL share
  - synthetic TVL share
  - degraded fetch families
  - pagination truncation
  - fallback dependence
- Preserve the public `coverage_class` family labels if useful, but recompute `coverage_confidence` from evidence.
- Add a distinct weak-partial tier internally even if the public API continues to serialize `mixed` or `fallback`.
- Tighten history baseline selection to avoid over-trusting thin-but-primary rows.
- Revisit trend baseline selection in `worker/src/api/dex-liquidity.ts` so historical changes prefer confident comparable baselines.

Recommended public semantics:
- `primary`: broad, high-confidence primary-family coverage
- `mixed`: both primary and fallback families, or primary with material heuristic dependence
- `fallback`: recovery-mode coverage dominated by staging / DexScreener / orderbook fallbacks
- `unobserved`: no usable DEX presence

Acceptance criteria:
- rows built from one direct API source do not automatically receive `1.0` confidence
- confidence drops when coverage is truncated, synthetic-heavy, or poorly corroborated
- history/trend baselines prefer better-quality rows

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/dex-liquidity-scoring.test.ts worker/src/api/__tests__/dex-liquidity.test.ts worker/src/api/__tests__/dex-liquidity-history.test.ts
```

## Phase 4: Source-Normalization Remediation

Objective:
- Fix source-specific accuracy weaknesses before the structural refactor.

Primary files:
- `worker/src/cron/dex-liquidity/fetch-fluid.ts`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts`
- `worker/src/cron/dex-liquidity/fetch-orca.ts`
- `worker/src/lib/dex-api-common.ts`
- `worker/src/lib/dex-api-types.ts`
- `docs/dex-liquidity.md`

Implementation tasks:
- Fluid:
  - preserve reserve precision until after decimal normalization
  - stop converting large bigint reserves to JS number too early
  - separate approximate volume fallback from measured USD volume
- Balancer:
  - validate more strictly for malformed token balanceUSD / balance combinations
  - annotate whether per-token prices were directly measured or reconstructed
- Raydium/Orca:
  - make fee-rate normalization and balance normalization explicit and shared
  - annotate source-native vs reconstructed fields
- Direct-API result transport:
  - replace `Object.assign(array, meta)` with an explicit object:
    - `pools`
    - `ok`
    - `degraded`
    - `errors`
- Identity confidence:
  - stop assigning `derived_unique` during collection time
  - introduce `derived_candidate` or equivalent unresolved state until uniqueness is proven

Acceptance criteria:
- Fluid no longer risks precision loss before reserve normalization
- direct API fetchers have explicit, uniform result semantics
- derived-identity confidence is assigned honestly

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts worker/src/cron/__tests__/dex-api-common.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts
cd worker && npx tsc --noEmit
```

## Phase 5: Pool Model and Contribution-Engine Refactor

Objective:
- Remove duplicated pool merge/scoring logic and centralize semantics.

Primary files:
- New: `worker/src/cron/dex-liquidity/normalized-pools.ts`
- New: `worker/src/cron/dex-liquidity/pool-contribution.ts`
- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/lib/dex-api-common.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`

Recommended decomposition:
- source adapters produce `NormalizedLiquidityPool`
- dedup layer resolves exact and derived identities
- contribution engine computes:
  - pair quality
  - balance health
  - stress
  - quality-adjusted TVL
  - effective TVL
  - protocol/chain/source aggregation
- scorer consumes only normalized/contributed pools

Implementation tasks:
- Introduce one normalized pool model shared by:
  - DL/Curve/subgraph primary pools
  - direct API pools
  - staged discovery pools
  - DexScreener fallback pools
  - CG-tickers synthetic orderbook pools
- Extract one contribution function so `mergeGtPools`, `mergeCgPools`, and direct-API conversion stop reimplementing the same logic with drift-prone defaults.
- Refactor `computeStablecoinScores()` into smaller units:
  - `filterRetainedPools`
  - `applyProtocolCaps`
  - `rebuildAggregates`
  - `computeCoverage`
  - `buildGlobalAggregate`
  - `computeDexPrices`
- Keep behavior stable initially; use characterization tests to prevent accidental semantic drift.

Acceptance criteria:
- pool contribution math is implemented once
- hotspot files shrink materially
- adding a new source no longer requires touching multiple merge paths

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts worker/src/cron/__tests__/dex-liquidity-scoring.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts
npm run check:hotspot-ratchet
```

## Phase 6: Scoring, API, and Rollout Hardening

Objective:
- Finish semantic cleanup, operator transparency, docs, and safe rollout.

Primary files:
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/dex-liquidity-history.ts`
- `src/components/dex-liquidity-card.tsx`
- `src/components/liquidity-breakdown.tsx`
- `src/components/liquidity-table.tsx`
- `docs/dex-liquidity.md`
- `docs/pricing-pipeline.md`
- `src/app/methodology/sections/core-sections.tsx`
- `shared/lib/liquidity-score-version.ts`
- `docs/liquidity-score-timeline.md`
- `src/app/about/page.tsx`

Implementation tasks:
- Revisit protocol TVL capping:
  - split strict cap vs soft cap by source/protocol family
  - ensure direct APIs are not clipped by a stale DL protocol cap in legitimate cases
- Revisit duplicate observation collapse:
  - only collapse after identity certainty is resolved
  - preserve enough metadata to explain why observations were collapsed
- Improve API warning payloads and `_meta`-style diagnostics where useful.
- Update methodology docs if the semantics of:
  - Liquidity Score
  - coverage confidence
  - synthetic orderbook handling
  - direct-API maturity / pool quality
  materially change
- Update `/about` if the externally described liquidity sources or source roles change materially.

Rollout guidance:
- ship Phase 6 only after Phases 1-5 are stable
- if confidence semantics change historical comparability, bump the liquidity methodology version and document it
- keep D1 migrations backward-compatible and avoid destructive cleanup until after production stabilizes

Acceptance criteria:
- the final model is documented and operator-visible
- methodology/version surfaces match runtime behavior
- no silent semantic drift remains between runtime, docs, and frontend explanations

Verification:
```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Cross-Cutting Work Items

### Documentation

Update when the corresponding phase lands:
- `docs/dex-liquidity.md`
- `docs/api-reference.md`
- `docs/worker-and-api-limits.md`
- `docs/pricing-pipeline.md` if DEX price-observation semantics change
- `src/app/methodology/sections/core-sections.tsx`
- `shared/lib/liquidity-score-version.ts`
- `docs/liquidity-score-timeline.md`
- `src/app/about/page.tsx` if visible source lists change

### Suggested D1 Migration Policy

Avoid schema churn early.

Recommended order:
1. Prefer internal JSON/provenance additions first.
2. Add columns only when query-time behavior or API contracts require them.
3. Keep all migrations backward-compatible with the old worker until rollout completes.

Potential later migrations if needed:
- row-level provenance columns for query-time filtering
- additional `dex_prices` diagnostics if operator queries need indexed access

### Operational Telemetry Recommendations

Add to cron metadata incrementally:
- `pagesFetchedBySource`
- `paginationTruncatedBySource`
- `weakCoverageCoins`
- `coverageRecoveredCoins`
- `syntheticOnlyCoins`
- `measuredBalanceCoveragePct`
- `sourceDegradedFamilies`
- `protocolCapReductions`

## Recommended Ticket Breakdown

If split into execution tickets, use this order:

1. Characterization tests and telemetry scaffolding
2. GT pagination
3. CG onchain pagination
4. weak-partial fallback targeting
5. provenance flags and synthetic/measured semantics
6. direct-API maturity and Fluid precision fixes
7. coverage-confidence remodel
8. identity-confidence cleanup
9. explicit direct-API result object refactor
10. normalized pool model and contribution-engine extraction
11. scoring decomposition
12. protocol-cap policy upgrade
13. docs, methodology versioning, and rollout cleanup

## Final Recommendation

Do not start with the architectural refactor.

The highest-value sequence is:

1. expose and fix recall gaps
2. make measurement semantics honest
3. make confidence honest
4. then refactor around the improved model

That order improves production accuracy early while ensuring the later refactor is built around the right semantics rather than preserving today’s shortcuts.
