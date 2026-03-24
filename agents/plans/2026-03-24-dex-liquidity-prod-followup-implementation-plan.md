# DEX Liquidity Prod Follow-Up Implementation Plan

Date: 2026-03-24  
Scope: DEX liquidity module follow-up after live production validation  
Status: Planning artifact for next remediation pass

## Objective

Turn the first live production observations after the DEX-liquidity hardening rollout into a narrow, evidence-driven implementation plan.

This plan is not a re-run of the broader seven-sequence remediation. The core rollout is functioning correctly in production. The goal here is to:

1. Detect silent quality drift earlier.
2. Make evidence gaps more legible to operators and downstream consumers.
3. Tighten the remaining GT-heavy / low-measurement coverage cases that still meaningfully affect confidence semantics.

## Production Findings That Drive This Plan

Observed from the live `sync-dex-liquidity` run started at `2026-03-24 11:10:24 UTC`:

- Cron execution was healthy:
  - `sync-dex-liquidity` completed `ok` in `185188 ms`
  - `sync-dex-discovery` also completed `ok`
  - no `failedSources`
  - no `fallbackMode`
  - no `sourceDegradedFamilies`
- Published data advanced normally:
  - `/api/dex-liquidity` `updatedAt` advanced to `1774350624`
- Quality drift was visible even though the run succeeded:
  - `priceObservationCoins` fell from `104` to `92`
  - `stagedPoolsMerged` fell from `1090` to `1041`
  - `measuredBalanceCoveragePct` was only `0.5343`
  - `weakCoverageCoins` was `112`
  - low-confidence published rows increased from `46` to `66`
- Coverage classes remained broadly stable:
  - `77 primary / 38 mixed / 4 fallback / 42 unobserved`
- The most notable remaining fallback names were:
  - `usdh-native-markets`
  - `pusd-plume`
  - `aeur-anchored-coins`
  - `m-m0`
- Two live names illustrate the remaining semantic gap well:
  - `usdh-native-markets`: GT-only coverage, zero measured balances, fallback confidence, but non-trivial TVL and price activity
  - `pusd-plume`: GT-dominant coverage, unstable price picture, zero measured balances, fallback confidence

## Planning Principles

- Only implement work that is justified by live production evidence.
- Favor observability and semantic clarity before adding new scoring complexity.
- Do not widen source trust by default; increase attribution first, then promote confidence only when evidence improves.
- Keep schema and API changes backward-compatible.

## Phase 1: Drift Detection And Operator Alerting

### Problem

The pipeline can remain fully green while quality degrades materially. Current cron metadata is useful, but it does not yet convert run-over-run deterioration into operator-visible alerts.

### Implementation

- Add run-over-run drift comparison in the DEX liquidity orchestrator for:
  - `priceObservationCoins`
  - `measuredBalanceCoveragePct`
  - `stagedPoolsMerged`
  - `stagedPoolsSkipped`
  - `currentCoverageClasses`
  - top-asset `poolCount` deltas for a small fixed watchlist:
    - `usdc-circle`
    - `usdt-tether`
    - `dai-makerdao`
    - `usds-sky`
    - `usde-ethena`
- Emit structured drift flags into cron metadata, for example:
  - `qualityDriftFlags`
  - `qualityDriftSeverity`
  - `topAssetCoverageDeltas`
- Surface those flags in the cron metadata summary UI so the run is visually “healthy but drifting” rather than simply “ok”.

### File Targets

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/lib/schemas.ts`
- `src/components/status/cron-metadata-summary.ts`
- tests in:
  - `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
  - `src/components/__tests__/cron-card.test.tsx`

### Acceptance Criteria

- A successful run with meaningful evidence deterioration produces explicit drift metadata.
- The status UI renders drift without labeling the cron as failed.
- No existing metadata consumers break if drift fields are absent.

## Phase 2: Evidence-Gap Attribution In Cron Metadata

### Problem

The current metadata tells us that evidence is weak, but not precisely why. Operators need to distinguish:

- no measured balances
- GT-only / crawler-only coverage
- synthetic-only retention
- direct API loss
- protocol-cap suppression

### Implementation

- Expand `sourceCoverage` metadata to include per-run attribution counters such as:
  - `coinsWithoutMeasuredBalances`
  - `coinsGtOnly`
  - `coinsCrawlerOnly`
  - `coinsDirectApiSupportedButMissing`
  - `coinsProtocolCapAffected`
  - `coinsPriceOnlyNoMeasuredLiquidity`
- Add a compact per-source-family evidence summary:
  - measured TVL share by source family
  - retained pool count by source family
  - price-observation count by source family
- Preserve the existing metadata shape and append new optional fields.

### File Targets

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/lib/schemas.ts`
- `src/components/status/cron-metadata-summary.ts`

### Acceptance Criteria

- Operators can explain low coverage confidence from cron metadata alone.
- A run like the observed `2026-03-24 11:10 UTC` one makes the GT-only / no-measured-balance contribution explicit.

## Phase 3: GT-Heavy Fallback Cohort Review And Targeted Source Enrichment

### Problem

A small cohort of live assets still depends almost entirely on GeckoTerminal-style evidence with no measured balances. These are not necessarily wrong, but they are the right next targets for improvement.

### Initial Cohort

- `usdh-native-markets`
- `pusd-plume`
- `aeur-anchored-coins`
- `m-m0`

### Implementation

- For each cohort asset, perform source-path analysis:
  - which chains are involved
  - whether CG onchain currently misses the pools
  - whether a direct API exists but is not integrated
  - whether discovery is missing chain normalization / routing support
- Add direct source integrations only where the source is durable and materially better than GT fallback.
- If no better source exists, keep fallback classification but enrich provenance so the weakness is explicit.

### Likely Workstreams

- `usdh-native-markets`
  - investigate HyperEVM-specific discovery / API options beyond GT
  - evaluate whether Ramses / Nest / Project X can be ingested with measured reserves
- `pusd-plume`
  - investigate Plume discovery normalization and any protocol-native APIs
  - specifically validate whether the observed `0.77899` price is market-real or skewed by isolated GT-only pairs
- `aeur-anchored-coins`
  - determine if the asset truly has only marginal DEX presence or if discovery is missing chain coverage
- `m-m0`
  - same as above, with priority lower than USDH and pUSD

### File Targets

Likely depending on findings:

- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/lib/coingecko-onchain.ts`
- source-specific fetchers if new direct APIs are justified
- docs if source inventory changes

### Acceptance Criteria

- Each cohort asset ends in one of two states:
  - materially better evidence and improved confidence, or
  - unchanged confidence but materially better provenance / operator explanation

## Phase 4: Confidence Semantics For “Measured vs Unmeasured” Liquidity

### Problem

The live run showed only `53.43%` measured-balance coverage at the portfolio level. That is currently available in metadata, but the system still under-communicates the difference between:

- total observed TVL
- effective TVL
- balance-measured TVL

### Implementation

- Review coverage classification and UI language with the measured-balance gap in mind.
- Add explicit semantics for rows where:
  - `totalTvlUsd > 0`
  - `effectiveTvlUsd > 0`
  - `balanceMeasuredTvlUsd = 0`
- Add a display badge / label for “unmeasured liquidity” or equivalent wording where confidence is driven by non-balance evidence.
- Evaluate whether API consumers would benefit from an explicit boolean such as:
  - `hasMeasuredLiquidityEvidence`
  - or `liquidityEvidenceClass`
- Keep the current `coverageClass` stable unless there is a very strong reason to change it.

### File Targets

- `worker/src/api/dex-liquidity.ts`
- `src/components/dex-liquidity-card.tsx`
- `src/app/liquidity/client.tsx`
- `docs/api-reference.md`
- `docs/dex-liquidity.md`

### Acceptance Criteria

- A consumer can distinguish “strong liquidity with measured balances” from “observed liquidity without measured balances” without reverse-engineering multiple numeric fields.
- UI and docs explain the relationship between `totalTvlUsd`, `effectiveTvlUsd`, and `balanceMeasuredTvlUsd`.

## Phase 5: Run History And Trendworthiness Guardrails

### Problem

Low-confidence rows increased materially in a single healthy run. History consumers need clearer guardrails so short-lived evidence deterioration does not look like a structural liquidity collapse.

### Implementation

- Add trendworthiness metadata to daily snapshots and/or history responses:
  - snapshot-level low-confidence marker
  - optional drift marker when the latest run deteriorates sharply vs recent baseline
- Update history consumers and documentation to encourage filtering or downweighting low-confidence periods.
- If appropriate, add an API-level `warning` field for severe data-quality drift without hard failure.

### File Targets

- `worker/src/api/dex-liquidity-history.ts`
- `worker/src/cron/dex-liquidity/persistence.ts`
- `docs/api-reference.md`
- `docs/dex-liquidity.md`

### Acceptance Criteria

- History consumers can programmatically identify low-authority snapshots.
- Sharp evidence deterioration does not silently masquerade as a pure market event.

## Phase 6: Protocol-Cap Explainability

### Problem

The live run recorded:

- `protocolCapReductions.cappedPoolCount = 135`
- `protocolCapReductions.cappedProtocols = 4`
- `protocolCapReductions.reducedTvlUsd = 3349104174`

That is informative, but still too coarse for follow-up analysis.

### Implementation

- Expand cap-reduction metadata to include top contributing protocols and affected stablecoins.
- Add a debug-friendly breakdown:
  - protocol name
  - pre-cap retained TVL
  - post-cap retained TVL
  - reduction amount
- Expose this in cron metadata only, not the public liquidity API, unless there is a clear product need.

### File Targets

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `src/components/status/cron-metadata-summary.ts`

### Acceptance Criteria

- Operators can tell whether a large evidence shift is driven by source loss or cap-policy pressure.

## Phase 7: Verification And Rollout

### Local Verification

- `npm run lint`
- `cd worker && npx tsc --noEmit`
- targeted suites:
  - `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
  - `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`
  - `worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts`
  - `worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts`
  - `worker/src/api/__tests__/dex-liquidity.test.ts`
  - `worker/src/api/__tests__/dex-liquidity-history.test.ts`
  - `src/components/__tests__/cron-card.test.tsx`
- before push:
  - `npm run test:merge-gate`

### Production Verification

- Monitor at least two consecutive `sync-dex-liquidity` runs with `wrangler d1 execute --remote`
- Check that:
  - drift metadata appears when expected
  - no schema consumers break when new metadata fields are absent/present
  - the status UI renders the new drift/evidence summaries correctly
- Sample a fixed watchlist from `/api/dex-liquidity`:
  - `usdc-circle`
  - `usdt-tether`
  - `usdh-native-markets`
  - `pusd-plume`
  - `aeur-anchored-coins`
  - `m-m0`

## Recommended Ticket Breakdown

1. DEX liquidity run drift alerting and metadata expansion
2. DEX liquidity status UI support for drift and evidence-gap summaries
3. GT-heavy fallback cohort audit: USDH / pUSD / aEUR / M
4. Measured-liquidity semantics in public API and UI
5. History trendworthiness markers for low-confidence snapshots
6. Protocol-cap explainability in cron metadata

## Recommended Execution Order

1. Phase 1
2. Phase 2
3. Phase 6
4. Phase 4
5. Phase 5
6. Phase 3

Reasoning:

- First make drift and evidence gaps visible.
- Then improve semantics for operators and consumers.
- Then spend engineering time on source-enrichment for the small fallback cohort, using the richer observability to validate whether those additions actually improve quality.

## Success Definition

This follow-up pass is successful when:

- a healthy-but-drifting liquidity run is clearly distinguishable from a fully healthy one
- operators can explain weak confidence from metadata without reading source code
- GT-heavy fallback assets are either upgraded with better evidence or explicitly documented as low-authority
- downstream consumers can reason about measured versus unmeasured liquidity without ambiguity
