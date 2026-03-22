# Pricing Remediation Implementation Plan

Date: 2026-03-22

Companion audit:
- `agents/pricing-module-audit-2026-03-22.md`

Primary goals:
- Make published prices materially harder to get wrong
- Ensure weak evidence cannot become downstream-authoritative without corroboration
- Reduce self-reinforcing loops between the stablecoin cache, DEX bridge, and primary pricing
- Make pricing behavior auditable, source-aware, and maintainable

Constraints:
- Keep changes root-cause driven
- Maintain backward-compatible D1 migrations
- Preserve existing API contracts unless a change is deliberate, documented, and coordinated
- Verify every phase with the relevant tests plus the repo validation gates

## Success Criteria

Functional success:
- A soft single-source result can no longer open or close depegs without secondary confirmation.
- Large fixed-peg price moves cannot publish unless corroboration rules are met.
- DEX-derived prices cannot self-reinforce through reuse of weak or stale tracked stablecoin prices.
- Large-pool challenge coverage matches the configured live thresholds and no longer silently degrades because of a global completeness gate.
- Published prices preserve source observation time and provenance strongly enough for downstream trust decisions.

Engineering success:
- Source policy is defined once and reused across consensus, validation, replay, depeg trust, health reporting, and UI transparency.
- Pricing-specific hotspots are reduced by moving source policy, trust classification, and provenance plumbing into dedicated modules.
- Test coverage expands to include the exact failure classes from the audit, including the recent USR-style incident shape.

Operational success:
- Admin/status surfaces expose enough provenance and diagnostics to explain why a price was selected.
- Rollout can proceed in phases without breaking existing cache readers or requiring coordinated destructive migrations.

## Recommended Delivery Strategy

Ship this as seven implementation phases in order.

| Phase | Focus | Why First / Why Later | Estimated Size |
| --- | --- | --- | --- |
| 0 | Characterization tests and observability baselines | Locks in incident coverage before behavior changes | S |
| 1 | Canonical source registry and trust model | Unblocks nearly every other fix | M |
| 2 | Timestamp / provenance plumbing | Needed before depeg trust and replay fixes are correct | M |
| 3 | Publication hardening and temporal quarantine | Highest-value pricing-integrity behavior change | M |
| 4 | Downstream depeg-trust hardening | Removes the biggest trust mismatch from current runtime | M |
| 5 | DEX bridge and challenger integrity | Closes the remaining self-reinforcement and challenge-coverage gaps | L |
| 6 | Enrichment reliability and maintainability refactor | Completes long-tail reliability and code-health work | M |

Do not start Phase 5 before Phase 1 is landed. Phase 5 depends on a canonical source/trust registry and richer provenance.

## Phase 0: Characterization Harness

Objective:
- Add regression tests and diagnostics for every failure class called out in the audit before changing behavior.

Primary files:
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`
- `worker/src/cron/__tests__/dex-api-common.test.ts`
- `worker/src/lib/__tests__/price-validation.test.ts`
- `worker/src/lib/__tests__/price-consensus.test.ts`
- `worker/src/cron/__tests__/challenger-persistence.test.ts`
- `worker/src/cron/__tests__/sync-fx-rates.test.ts`
- `worker/src/cron/__tests__/detect-depegs*` / `confirm-pending-depegs*` if missing or weak

Implementation tasks:
- Add a characterization test for “soft single-source must not be depeg-authoritative”.
- Add a characterization test for “downgraded `coingecko+defillama-list` still receives a secondary pool check”.
- Add a characterization test for “large weak move vs previous trusted price enters quarantine”.
- Add a characterization test for “DEX quote-leg derivation refuses weak/stale tracked stablecoin prices”.
- Add a characterization test for “challenger publication threshold matches challenge-consumption threshold”.
- Add a characterization test for “published price freshness follows source observation time, not sync write time”.
- Add explicit USR-style fixtures:
  - wrong soft market print
  - misleading DEX leg
  - large pool disagreement
  - low-confidence and single-source downstream trust

Acceptance criteria:
- Every audit P0/P1 failure mode has a concrete test case.
- The tests fail if the old behavior is reintroduced.

Verification:
- Run the pricing-focused test slice.
- Run `npm test -- --run <new-pricing-suites>`.

## Phase 1: Canonical Source Registry And Trust Model

Objective:
- Replace distributed string-based source semantics with one canonical registry.

Primary files:
- New: `shared/lib/pricing-source-registry.ts`
- `worker/src/lib/pricing-source-policy.ts`
- `shared/lib/pricing-sources.ts`
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/metadata.ts`
- `worker/src/api/status-supplements.ts`

Recommended registry shape:
- `key`
- `label`
- `family`
- `defaultWeight`
- `trustTier`
- `isSoftSource`
- `isReplaySafe`
- `isPoolChallengeExempt`
- `isGtProbeEligible`
- `canBeDepegAuthoritative`
- `requiresObservedAt`
- `isSearchDerived`

Recommended trust tiers:
- `hard_oracle`
- `hard_market`
- `hard_protocol`
- `soft_aggregator`
- `soft_dex`
- `fallback_search`
- `cached_replay`

Implementation tasks:
- Introduce the registry in `shared/` so both worker and frontend/status surfaces can consume it.
- Refactor `isPoolChallengeEligibleConsensus()`, `isGtProbeEligibleSingleSource()`, and replay-safe checks to use the registry rather than ad hoc sets.
- Refactor `classifyPrimaryDepegTrust()` to use source/trust-tier semantics, not only `priceConfidence`.
- Refactor price-source health bucket mapping to derive from the registry.
- Keep a backward-compatible label layer in `shared/lib/pricing-sources.ts`, but make it consume the registry.

Recommended behavior after this phase:
- `high` is no longer automatically authoritative downstream.
- `single-source` is split into hard and soft trust classes.
- `cached`, `fallback`, `low`, and soft single-source all classify as `confirm_required`.

Acceptance criteria:
- There is one canonical place to answer “is this source replay-safe / authoritative / GT-eligible / soft?”
- No worker logic depends on duplicated string sets for pricing-source semantics.

Verification:
- Unit tests for the registry and trust classification.
- Re-run the pricing-focused suites plus any status-supplement tests that inspect source health.

## Phase 2: Timestamp And Provenance Plumbing

Objective:
- Preserve source observation time and enough provenance for downstream trust decisions and operator debugging.

Primary files:
- New: `worker/src/lib/pricing-types.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/enrich-prices-shared.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/shared.ts`
- `worker/src/lib/pyth.ts`
- `worker/src/lib/redstone.ts`
- `worker/src/lib/curve-onchain.ts`
- `worker/src/lib/geckoterminal-price-probe.ts`
- `worker/src/lib/authoritative-price-sources.ts`
- `worker/src/lib/db-cache.ts`
- `worker/src/lib/stablecoins-cache.ts`
- `shared/types/*` or the stablecoin response schema if new fields are exposed
- `docs/api-reference.md`

Recommended data model:
- Internal `ObservedPrice` / `SelectedPrice` should include:
  - `price`
  - `source`
  - `confidence`
  - `candidateSources`
  - `agreeSources`
  - `disagreeSources`
  - `sourceObservedAt`
  - `pharosSyncedAt`
  - `sourceDiagnostics`

Public contract recommendation:
- Keep `priceUpdatedAt` for compatibility, but redefine/document it carefully.
- Add `priceObservedAt` and `priceSyncedAt` if needed rather than overloading one field silently.
- If you preserve only one public field, make it the true observation timestamp and expose sync time elsewhere in operator metadata.

Implementation tasks:
- Extend primary and fallback adapters to return observation time when available.
- Propagate observation time through consensus and into the cached stablecoin payload.
- Expand `price_cache` schema to store:
  - `source`
  - `confidence`
  - `observed_at`
  - `synced_at`
- Preserve replay provenance instead of storing only `price`.
- Update `classifyPrimaryDepegTrust()` to use source observation age rather than cache write age.

Migration requirements:
- Add a backward-compatible D1 migration for `price_cache`.
- Keep reads tolerant of missing new columns until all environments are migrated.

Acceptance criteria:
- Published freshness reflects upstream observation time.
- Replayed prices preserve original source and confidence metadata.
- Operator surfaces can explain where and when the price came from.

Verification:
- New unit tests for observed-time propagation.
- Worker type-check.
- API contract tests if public payload changes.

## Phase 3: Publication Hardening And Temporal Quarantine

Objective:
- Prevent weak evidence from publishing large wrong prices even if the current generic bounds would allow them.

Primary files:
- `worker/src/lib/price-validation.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- `worker/src/lib/price-consensus.ts`
- New: `worker/src/lib/pricing-quarantine.ts`

Implementation tasks:
- Introduce symmetric extreme-move corroboration for fixed pegs:
  - large upside
  - large downside
- Make publication rules source-aware:
  - hard sources can publish more freely
  - soft single-source, low-confidence, fallback, cached, and search-derived paths must satisfy stricter rules
- Add a previous-price jump guard:
  - compare candidate price against the previous accepted trusted price
  - if the move exceeds a peg-aware threshold and the new evidence is weaker, quarantine rather than publish
- Rework `low` consensus selection:
  - stop treating `low` as “highest-weight source wins”
  - either compute a weighted median for diagnostics or refuse publication for weak fixed-peg moves until corroborated

Recommended decision framework:
- For fixed pegs:
  - small moves can publish according to the new source-aware trust rules
  - medium moves require either multi-source agreement or strong source tier
  - severe moves require independent corroboration or an explicit challenger/protocol override
- For NAV / variable assets:
  - keep looser behavior, but still preserve provenance and freshness

Acceptance criteria:
- A fixed-peg asset cannot publish a large move from weak evidence alone.
- A bad new print that sharply diverges from the last trusted price is quarantined or downgraded.
- `low` no longer means “publish one weighted favorite and hope the label is enough”.

Verification:
- New price-validation and consensus tests.
- End-to-end pricing suite.

## Phase 4: Downstream Depeg-Trust Hardening

Objective:
- Align depeg authority with actual source quality rather than UI-level confidence labels.

Primary files:
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `shared/lib/depeg-dews-version.ts` if methodology semantics change
- `docs/depeg-detection.md`
- `docs/depeg-dews-timeline.md` if thresholds/semantics change

Implementation tasks:
- Refactor `classifyPrimaryDepegTrust()` to consume the Phase 1 source registry.
- Treat these classes as `confirm_required`:
  - soft single-source
  - `low`
  - `fallback`
  - `cached`
  - stale observed data
- Preserve authority for:
  - validated protocol redemption
  - selected hard oracles / hard venues
  - pool-challenge replacement marks when they are explicitly derived from sufficient independent large-pool evidence
- Tighten confirmation rules for extreme moves even on hard sources when the move is large enough.
- Add logging/metadata that records why a primary was trusted or not trusted.

Acceptance criteria:
- A single soft market print cannot directly open or close a depeg.
- Depeg trust is explainable by source class, not just `high` vs `single-source`.

Verification:
- Add or expand `detect-depegs` and `confirm-pending-depegs` tests.
- Re-run pricing + depeg suites.

## Phase 5: DEX Bridge And Challenger Integrity

Objective:
- Remove DEX feedback loops, align challenger publication with consumption, and preserve richer DEX provenance.

Primary files:
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/cron/dex-liquidity/challenger-persistence.ts`
- `worker/src/lib/dex-api-common.ts`
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/dex-liquidity/token-price-observations.ts`
- `worker/src/cron/dex-liquidity/price-sanity.ts`
- `worker/src/lib/constants.ts`
- `docs/dex-liquidity.md`
- `docs/pricing-pipeline.md`

Implementation tasks:

1. Quote-leg confidence gating
- Only reuse tracked stablecoin prices for DEX quote legs when they are:
  - fresh by source observation time
  - not fallback/cached/low
  - from an allowed trust tier
- Otherwise:
  - use peg reference when safe
  - or refuse derivation

2. DEX observation provenance
- Mark whether each observation used:
  - direct USD token pricing
  - peg reference
  - tracked stablecoin quote price
- Persist the quote-leg derivation mode in observation metadata or `price_sources_json`.

3. Challenger publication alignment
- Align published challenger min TVL with `POOL_CHALLENGE_MIN_TVL`.
- Replace the current global all-or-nothing completeness gate with per-stablecoin completeness.
- Persist per-coin challenger diagnostics:
  - retained pool count
  - retained TVL
  - coverage ratio
  - source failures / degraded sources
  - threshold used

4. DEX protocol aggregation tightening
- Revisit `aggregateProtocolSources()` so promoted primary sources preserve more structure.
- Recommended default:
  - aggregate at least by `protocol + chain`
  - store chain breakdown even if the promoted source label stays protocol-level
- Keep the one-protocol-one-vote principle for primary consensus, but do not discard the chain-level evidence in persistence.

5. Weak soft-result challenge expansion
- Extend pool challenge beyond `high` soft consensus.
- Extend GT/pool secondary checks to downgraded `CG + DL-list` and selected `low` fixed-peg results.

Acceptance criteria:
- DEX quote derivation cannot reuse weak cached stablecoin prices.
- Challengers published to D1 represent the same coverage assumptions that the pricing path consumes.
- Soft weak results receive secondary challenge coverage instead of escaping the challenge layer.

Verification:
- `dex-api-common`, `dex-liquidity-price-bridge`, `challenger-persistence`, `dex-liquidity-scoring`, and `enrich-prices` suites.

## Phase 6: Enrichment Reliability And Code-Health Refactor

Objective:
- Finish long-tail reliability work and reduce hotspot complexity after core semantics are stabilized.

Primary files:
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/enrich-prices-passes.ts`
- `worker/src/lib/price-validation.ts`
- `worker/src/lib/redstone.ts`
- `worker/src/lib/cex-tickers.ts`
- `worker/src/cron/sync-stablecoins/stages.ts`
- `shared/lib/pricing-pipeline-version.ts`

Implementation tasks:

1. Pass isolation
- Split passes 2-4 into independent try/catch blocks.
- Record per-pass outcomes and failure reasons cleanly.

2. Validation decomposition
- Extract reusable helpers from `price-validation.ts`:
  - reference resolution
  - hardcoded bound resolution
  - mode-aware bound application
  - extreme-move checks

3. Source-adapter cleanup
- RedStone:
  - derive a venue-based robust price
  - compare it to the provider aggregate
- CEX adapters:
  - add verification tests or smoke checks for hardcoded product maps
- Replace the `geckoId.includes("wrong")` sentinel with explicit metadata flags in tracked metadata

4. Staleness model improvement
- Keep the existing stale-data detector
- Add a jump detector and expose it in cron metadata and status if useful

5. Module split
- Break large files into stable units only after behavior is locked:
  - `price-source-registry`
  - `price-trust`
  - `price-provenance`
  - `price-publication`
  - `price-quarantine`
  - `enrichment-adapters`

Acceptance criteria:
- No pricing pass failure suppresses later passes unnecessarily.
- Validation logic becomes easier to reason about and test in isolation.
- The codebase no longer encodes known-invalid metadata via string hacks.

Verification:
- Full pricing-focused test slice
- `npm run lint`
- `cd worker && npx tsc --noEmit`

## Documentation And Methodology Updates

These changes affect methodology semantics, API interpretation, and operator reasoning. Plan to update docs in the same PRs that change behavior.

Pricing methodology updates:
- `docs/pricing-pipeline.md`
- `docs/pricing-pipeline-timeline.md`
- `shared/lib/pricing-pipeline-version.ts`
- `src/app/methodology/sections/core-sections.tsx`

API / operator documentation:
- `docs/api-reference.md` if public payload or semantics change
- `docs/worker-and-api-limits.md` if budgets / cadence assumptions change
- `docs/about-page.md` and `src/app/about/page.tsx` only if the externally disclosed source roster changes

DEX / challenge documentation:
- `docs/dex-liquidity.md`

Depeg methodology docs if trust/confirmation semantics change:
- `docs/depeg-detection.md`
- relevant depeg timeline docs if methodology version changes

## Rollout Plan

Recommended rollout order:

1. Land Phase 0 tests first.
2. Land Phase 1 registry/trust model with minimal behavior change where possible.
3. Land Phase 2 provenance plumbing and migrations.
4. Land Phase 3 publication hardening behind constants that can be tuned quickly if needed.
5. Land Phase 4 depeg-trust changes after provenance and publication hardening are live.
6. Land Phase 5 DEX bridge/challenger changes after the trust registry exists.
7. Finish with Phase 6 refactors.

Backward-compatibility rules:
- D1 migrations must be additive.
- New JSON fields in `price_sources_json` or stablecoin cache payloads must be optional on read.
- Do not repurpose public fields silently without updating docs and UI consumers in the same change.

Operational safeguards:
- Log when a price is quarantined, downgraded, or refused because of:
  - weak source tier
  - stale observed time
  - jump vs previous trusted price
  - failed corroboration
- Expose new counters in `cron_runs.metadata` and status supplements where possible.

## Verification Matrix

Per-phase local verification:

Phase 0-6 common:
```bash
npm test
npm run lint
cd worker && npx tsc --noEmit
```

For behavior or payload changes that affect frontend or API surfaces:
```bash
npm run build
```

Before any push:
```bash
npm run test:merge-gate
```

Targeted suites to keep hot during implementation:
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/lib/__tests__/price-consensus.test.ts`
- `worker/src/lib/__tests__/price-validation.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`
- `worker/src/cron/__tests__/dex-api-common.test.ts`
- `worker/src/cron/__tests__/challenger-persistence.test.ts`
- depeg detection / confirmation suites

## Open Design Decisions

These are the only decisions that should be resolved before Phase 3 begins:

1. Public timestamp semantics
- Recommended default: publish both `priceObservedAt` and `priceSyncedAt`; keep `priceUpdatedAt` only as a compatibility alias if necessary.

2. Low-confidence publication policy
- Recommended default: for fixed pegs, do not publish a large `low` move unless corroborated by an independent source family or large-pool challenge.

3. DEX protocol aggregation granularity
- Recommended default: keep one promoted vote per protocol for primary consensus, but persist protocol+chain breakdown for diagnostics and future gating.

4. Extreme-move thresholds
- Recommended default: peg-aware and source-aware, with stricter rules for weak sources than for hard sources.

## Immediate Next Step

Start with Phase 0 and Phase 1 in the same branch only if the source registry extraction stays small. Otherwise land Phase 0 first, then Phase 1 as the first real behavior-enabling change. That gives the rest of the plan a stable semantic foundation.
