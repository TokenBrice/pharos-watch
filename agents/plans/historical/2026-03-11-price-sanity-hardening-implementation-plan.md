# Price Sanity Hardening — Implementation Plan

**Date:** 2026-03-11  
**Status:** Proposed  
**Design doc:** [2026-03-11-price-sanity-hardening-design.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-design.md)  
**Primary systems affected:** `sync-stablecoins`, `enrich-prices`, DEX price sanity, depeg backfill  
**Risk level:** High, because this plan changes the acceptance logic for primary price ingestion, fallback price enrichment, DEX-derived prices, and historical depeg extraction

## Purpose

This document converts the price-sanity audit and design into an execution-ready implementation plan.

The goal is to make price validation:

- context-aware instead of one-size-fits-all
- consistent across sync, DEX, and backfill paths
- safer against thin-source noise
- safer against falsely dropping true catastrophic failures
- observable enough that we can explain every material behavior change before and after rollout

## Why This Must Be Sequenced Conservatively

This change touches one of the most sensitive parts of Pharos:

- stablecoins cache publication
- price cache writes
- DEX-implied price observations
- depeg confirmation inputs
- historical depeg reconstruction

If we tighten too early, we can falsely remove real prices.  
If we loosen too early, we can let corrupted prices poison caches and downstream signals.

Because of that, this plan intentionally favors:

- additive helpers first
- characterization tests before behavioral changes
- shadow comparison before enforcement
- sequential gates instead of parallel implementation streams

## Scope

In scope:

- [worker/src/cron/enrich-prices.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/enrich-prices.ts)
- [worker/src/cron/sync-stablecoins.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins.ts)
- [worker/src/cron/sync-stablecoins/stages.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/stages.ts)
- [worker/src/cron/dex-liquidity/price-sanity.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/price-sanity.ts)
- [worker/src/cron/dex-liquidity/*](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity)
- [worker/src/cron/dex-discovery/crawl-sources.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-discovery/crawl-sources.ts)
- [worker/src/api/backfill-depegs.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-depegs.ts)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts)
- [worker/src/api/status.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/status.ts)
- [worker/src/cron/compute-dews.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts)
- [worker/src/cron/stability-index.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/stability-index.ts)
- [worker/src/cron/daily-digest.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts)
- [worker/src/lib/report-cards-snapshot.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts)
- [worker/src/lib/safety-scores.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/safety-scores.ts)
- [worker/src/cron/__tests__/enrich-prices.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/enrich-prices.test.ts)
- [worker/src/cron/__tests__/sync-stablecoins.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-stablecoins.test.ts)
- [worker/src/cron/__tests__/sync-stablecoins-stages.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-stablecoins-stages.test.ts)
- [worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts)
- [worker/src/cron/__tests__/detect-depegs.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/detect-depegs.test.ts)
- [worker/src/cron/__tests__/confirm-pending-depegs.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/confirm-pending-depegs.test.ts)
- [worker/src/api/__tests__/backfill-depegs-helpers.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/backfill-depegs-helpers.test.ts)
- [worker/src/api/__tests__/mint-burn-flows.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/mint-burn-flows.test.ts)
- [worker/src/api/__tests__/peg-summary.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/peg-summary.test.ts)
- [worker/src/api/__tests__/stability-index.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/stability-index.test.ts)
- [worker/src/api/__tests__/stress-signals.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/stress-signals.test.ts)
- [worker/src/api/__tests__/status.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/status.test.ts)
- [worker/src/cron/__tests__/compute-dews.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/compute-dews.test.ts)
- [worker/src/cron/__tests__/daily-digest.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/daily-digest.test.ts)
- [worker/src/cron/__tests__/stability-index.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/stability-index.test.ts)
- [worker/src/lib/__tests__/report-cards-snapshot.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/report-cards-snapshot.test.ts)
- [worker/src/lib/__tests__/safety-scores.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/safety-scores.test.ts)
- [src/lib/__tests__/stablecoin-detail-view-model.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/__tests__/stablecoin-detail-view-model.test.ts)
- [src/lib/__tests__/stablecoin-schema-compat.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/__tests__/stablecoin-schema-compat.test.ts)
- [src/components/__tests__/comparison-table.test.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/__tests__/comparison-table.test.tsx)
- [src/hooks/use-stablecoins.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-stablecoins.ts)
- [src/hooks/use-stablecoin-detail-view-model.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-stablecoin-detail-view-model.ts)
- [src/components/homepage-client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/homepage-client.tsx)
- [src/app/compare/client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/compare/client.tsx)
- [src/app/dependency-map/client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/dependency-map/client.tsx)
- [src/app/safety-scores/client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/safety-scores/client.tsx)
- [docs/data-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/data-pipeline.md)
- [docs/dex-liquidity.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/dex-liquidity.md)
- [docs/depeg-detection.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/depeg-detection.md)
- [docs/data-flow-map.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/data-flow-map.md)
- [docs/api-reference.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
- [docs/methodology-page.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/methodology-page.md)
- [docs/dews.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/dews.md)
- [docs/stability-index.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/stability-index.md)
- [docs/digest-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/digest-pipeline.md)
- [docs/status-dashboard.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/status-dashboard.md)
- [docs/worker-infrastructure.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
- [docs/deployment-process.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md)
- [README.md](/home/ahirice/Documents/git/stablecoin-dashboard/README.md)
- [shared/types/index.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/index.ts)

Out of scope:

- changing upstream vendors
- changing cron topology
- changing D1 schema unless a later phase proves it is absolutely necessary
- changing public payload shapes beyond what is already carried in cron metadata or admin status unless explicitly documented and reviewed
- redesigning the `/status` UI
- changing DEWS / PSI / report-card methodology

## Non-Negotiables

- Do not weaken the cache-poisoning guard just to preserve more prices.
- Do not tighten the guard in a way that can silently delete real catastrophic failures without corroboration logic.
- Do not introduce per-price DB reads inside hot DEX loops.
- Do not ship behavioral changes to sync, DEX, and backfill in a single unobserved jump.
- Do not change the `priceConfidence` enum without updating [docs/api-reference.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md) and shared types.
- Do not add a new external data source; this plan only normalizes use of existing FX and metal references.
- Keep the shared boundary clean: reusable validation logic belongs in worker-neutral or worker-lib code, not buried deeper inside one cron if multiple callers need it.
- Update docs in the same branch that changes runtime behavior.
- Do not sign off the work based only on `sync-stablecoins` tests; downstream consumers of `stablecoins`, `price_cache`, and `dex_prices` must be smoke-tested explicitly.

## Execution Strategy

## Safety-First Single-Agent Order

This plan is intentionally **not** highly parallelized.

Implement it on a single feature branch, in ticket order:

```text
TICKET-001 characterization tests
TICKET-002 additive validation core
TICKET-003 shadow mode + telemetry
TICKET-004 sync/arbitration enforcement
TICKET-005 DEX enforcement
TICKET-006 backfill enforcement
TICKET-007 downstream regression review
TICKET-008 docs + cleanup
```

Do not start the next behavioral ticket until the current gate has passed.

## Merge Gates

This plan has five hard gates:

1. **Gate A:** TICKET-001 must land before any runtime behavior changes
2. **Gate B:** TICKET-003 shadow mode must be deployed and observed before TICKET-004 enforcement
3. **Gate C:** Sync enforcement must stabilize before DEX enforcement
4. **Gate D:** DEX enforcement must stabilize before backfill enforcement
5. **Gate E:** Downstream regression review must pass before final docs/sign-off

## Verification Standard

Every completed behavioral ticket must finish with:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Minimum targeted suites during development:

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/sync-stablecoins-stages.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/cron/__tests__/detect-depegs.test.ts \
  worker/src/cron/__tests__/confirm-pending-depegs.test.ts \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts \
  worker/src/api/__tests__/mint-burn-flows.test.ts \
  worker/src/api/__tests__/stability-index.test.ts \
  worker/src/api/__tests__/stress-signals.test.ts \
  worker/src/api/__tests__/status.test.ts \
  worker/src/cron/__tests__/compute-dews.test.ts \
  worker/src/cron/__tests__/daily-digest.test.ts \
  worker/src/cron/__tests__/stability-index.test.ts \
  worker/src/cron/__tests__/sync-fx-rates.test.ts \
  worker/src/lib/__tests__/stablecoins-cache.test.ts \
  worker/src/lib/__tests__/report-cards-snapshot.test.ts \
  worker/src/lib/__tests__/safety-scores.test.ts \
  src/lib/__tests__/stablecoin-detail-view-model.test.ts \
  src/lib/__tests__/stablecoin-schema-compat.test.ts \
  src/components/__tests__/comparison-table.test.tsx
```

If a ticket changes only test scaffolding or docs, full `npm test` can be deferred to the next behavioral ticket, but targeted suites for touched areas still need to pass immediately.

## Canary Asset Matrix

Every enforcement phase must be reviewed against the same canary set:

| Asset | Why it matters |
|------|----------------|
| `usds-sky` / `usds-makerdao` if present in current metadata | Severe USD depeg scenario |
| `eurc-circle` | Non-USD dual-primary arbitration |
| `jpyc-jpyc` | Low-nominal FX peg |
| `brz-transfero` | BRL alias normalization (`peggedREAL`) |
| `xaut-tether` | Full-ounce gold |
| `paxg-pax-gold` | Full-ounce gold with separate provider path |
| `kau-kinesis` | Fractional gold (gram-scale) |
| `cgo-comtech` | Fractional gold (gram-scale) |
| `ggbr-goldfish-gold` | Extreme fractional gold (`0.001 oz`) |
| `kag-kinesis` | Silver peg |
| `ousg-ondo-finance` | NAV token; must not be forced toward `$1` |
| `ustb-superstate` | NAV token; high nominal price |
| `fpi-frax` | Variable / non-fixed peg behavior |
| `isc-international-stable-currency` | Variable / non-fixed peg behavior |

## Downstream Consumer Matrix

The implementation and sign-off process must account for these downstream readers, not just the ingestion path itself:

| Downstream | Dependency on price-sanity changes | Risk if missed |
|------|--------------------------------------|----------------|
| `compute-dews` | reads `stablecoins` cache and `dex_prices`; uses `priceConfidence` in scoring | DEWS can over- or under-state system stress |
| `stability-index` | reads `stablecoins` cache and active depeg state | PSI can drift if price availability or depeg inputs change |
| `daily-digest` | reads stablecoins cache for market context | digest can publish misleading market state or fail closed unexpectedly |
| `report-cards` / safety snapshots | derive from stablecoins cache, peg summary, and liquidity | grades and safety surfaces can shift unexpectedly |
| `mint-burn-flows` | uses stablecoins cache for market-cap lookup and depends indirectly on `price_cache` availability | flow weighting and UI context can become misleading |
| `peg-summary` / depeg UI | consumes primary prices plus `dex_prices` corroboration | live depeg provenance can change unexpectedly |
| Homepage / Compare / Dependency Map / detail view | consume `/api/stablecoins` directly | users can see missing prices, shifted peg references, or stale provenance |

These are not optional smoke checks. They are part of the acceptance contract.

## Required Shadow Metrics Before Enforcement

TICKET-003 must add comparison metadata so we can observe the new engine before it decides anything.

Minimum shadow fields in `sync-stablecoins` cron metadata:

- `priceValidationShadow.compared`
- `priceValidationShadow.matched`
- `priceValidationShadow.mismatched`
- `priceValidationShadow.mismatchRate`
- `priceValidationShadow.mismatchBreakdown`
- `priceValidationShadow.sampleMismatches`

Minimum shadow fields in DEX cron metadata:

- `priceValidationShadow.comparedObs`
- `priceValidationShadow.acceptedOld`
- `priceValidationShadow.acceptedNew`
- `priceValidationShadow.deltaAccepted`
- `priceValidationShadow.sampleRejectedByNew`

Recommended enforcement gates:

- Sync shadow runs clean for at least 24 hours
- All mismatches are either expected by design or manually explained
- No unexplained mismatch on USD top-10 assets
- No unexplained mismatch on any canary asset above
- DEX shadow shows no canary asset unexpectedly losing all usable observations

## Implementation Phases

## Phase 0 — Baseline and Characterization

Goal: freeze the current intended behavior in tests before runtime logic changes.

### TICKET-001: Characterization Tests and Canary Fixtures

```yaml
title: "Expand characterization tests around price sanity canaries"
agent: codex
model: gpt-5
reasoning_effort: high
risk: low
```

#### Goal

Build a stronger regression harness around the current system, especially for the exact assets and edge cases the new design is meant to improve.

#### Files

- [worker/src/cron/__tests__/enrich-prices.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/enrich-prices.test.ts)
- [worker/src/cron/__tests__/sync-stablecoins.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-stablecoins.test.ts)
- [worker/src/cron/__tests__/sync-stablecoins-stages.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-stablecoins-stages.test.ts)
- [worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts)
- [worker/src/cron/__tests__/detect-depegs.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/detect-depegs.test.ts)
- [worker/src/api/__tests__/backfill-depegs-helpers.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/backfill-depegs-helpers.test.ts)

#### Task

1. Add or expand canary tests for:
   - `eurc-circle`
   - `jpyc-jpyc`
   - `brz-transfero`
   - `xaut-tether`
   - `kau-kinesis`
   - `cgo-comtech`
   - `ggbr-goldfish-gold`
   - `kag-kinesis`
   - `ousg-ondo-finance`
   - one `VAR` peg coin
2. Add explicit tests that document the current behavior for:
   - non-USD dual-primary divergence selection
   - DEX sanity without live FX/metal references
   - fractional commodity behavior when `commodityOunces` is missing
   - missing/unknown `pegType` fail-open behavior
   - stale FX cache differences between sync and enrichment
3. Mark current oddities in test names and comments as characterization behavior, not desired future behavior.
4. Do not change production logic in this ticket.

#### Acceptance Criteria

- Every canary asset above appears in at least one targeted test
- There is a clear test proving the current non-USD dual-primary behavior
- There is a clear test proving the current DEX fallback-range behavior
- No production logic changes are included

#### Verification

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts
```

## Phase 1 — Additive Core Without Behavioral Switch

Goal: introduce the new primitives while preserving current runtime behavior.

### TICKET-002: Add a Shared Price Validation Core

```yaml
title: "Add canonical validation context, reference loader, and mode-aware validator"
agent: codex
model: gpt-5
reasoning_effort: high
risk: medium
```

#### Goal

Create the new core validation module and supporting pure helpers without yet making any caller depend on the new behavior.

#### Recommended File Layout

Prefer a new worker-lib module rather than leaving the logic inside [worker/src/cron/enrich-prices.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/enrich-prices.ts):

```text
worker/src/lib/price-validation/
  context.ts
  references.ts
  validator.ts
  types.ts
```

If that is too granular, a single `worker/src/lib/price-validation.ts` file is acceptable.

#### Task

1. Define internal types:
   - `PriceValidationMode`
   - `PriceReferenceType`
   - `PriceValidationContext`
   - `PriceValidationDecision`
2. Build a canonical context helper sourced from tracked metadata first:
   - normalize BRL to `peggedREAL`
   - carry `navToken`
   - carry `commodityOunces`
   - classify peg class (`usd`, `fiat_fx`, `commodity`, `nav`, `variable`, `unknown`)
3. Build a shared reference loader:
   - loads FX + gold/silver references from cache
   - applies one freshness policy
   - exposes whether references are `fresh`, `stale`, or `static`
4. Build a mode-aware validator returning a structured decision, not just boolean:
   - `accepted`
   - `reasonCode`
   - `referenceType`
   - `referencePrice`
   - `candidateRatio`
   - `boundsUsed`
5. Preserve the old helper surface for compatibility:
   - keep `isReasonablePrice(...)` callable
   - either wrap the new core using current semantics or leave the old helper intact for now
6. Add unit tests for the new module:
   - USD fixed peg
   - EUR fixed peg
   - JPY low nominal
   - BRL alias
   - full-ounce gold
   - fractional gold
   - silver
   - NAV token
   - `VAR` peg
   - missing `pegType`
   - fresh vs stale reference loading

#### Key Constraint

Do not switch `sync-stablecoins`, DEX sanity, or backfill to use the new decision for acceptance yet. This ticket is additive.

#### Acceptance Criteria

- The new module exists and is covered by pure tests
- BRL, fractional gold, NAV, and `VAR` logic are all represented in tests
- Existing public/runtime behavior remains unchanged

#### Verification

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts \
  worker/src/cron/__tests__/sync-fx-rates.test.ts
cd worker && npx tsc --noEmit
```

### TICKET-003: Shadow Mode and Validation Telemetry

```yaml
title: "Run the new validator in shadow mode and emit mismatch telemetry"
agent: codex
model: gpt-5
reasoning_effort: high
risk: medium
```

#### Goal

Observe the new engine against the current engine before changing runtime decisions.

#### Files

- [worker/src/cron/sync-stablecoins.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins.ts)
- [worker/src/cron/enrich-prices.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/enrich-prices.ts)
- [worker/src/cron/dex-liquidity/price-sanity.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/price-sanity.ts)
- optionally [worker/src/api/status.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/status.ts) if admin surfacing is needed

#### Task

1. In `sync-stablecoins`, evaluate old and new decisions side-by-side at these points:
   - dual-primary application
   - pre-reject before enrichment
   - post-enrichment reject-before-cache
   - cached price fallback admission
2. Emit shadow comparison metadata, capped to avoid oversized cron metadata rows.
3. In DEX sanity, compare old boolean decision vs new decision in memory and count deltas, but keep old behavior active.
4. If exposing on `/api/status`, keep it admin-only via cron metadata readback. Do not change the public stablecoins payload.
5. Add tests proving:
   - shadow counters populate
   - sample mismatches are capped
   - no runtime acceptance path changed yet

#### Acceptance Criteria

- `sync-stablecoins` metadata contains shadow validation counters
- DEX metadata contains old/new acceptance deltas
- payload contracts for `/api/stablecoins` do not change in this ticket
- canary assets can be manually reviewed in logs/metadata

#### Required Observation Window Before Next Ticket

Observe at least 24 hours of scheduled runs after deploy.

Manual review checklist:

- all mismatches on canary assets are explained
- no unexplained sync mismatch on top USD stablecoins
- no canary commodity or FX asset loses valid prices unexpectedly

#### Verification

```bash
npm test -- --run \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/api/__tests__/status.test.ts
npm run build
```

## Phase 2 — Enforce New Logic in Primary Sync Paths

Goal: switch the high-value ingestion path first, while DEX and backfill still remain on old acceptance behavior.

### TICKET-004: Switch Dual-Primary Arbitration and Sync Cache Admission

```yaml
title: "Enforce reference-driven sync validation for primary and enrichment paths"
agent: codex
model: gpt-5
reasoning_effort: xhigh
risk: high
```

#### Goal

Adopt the new validator for the stablecoins sync path, including dual-primary selection and pre-cache validation.

#### Files

- [worker/src/cron/enrich-prices.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/enrich-prices.ts)
- [worker/src/cron/sync-stablecoins.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins.ts)
- [worker/src/cron/sync-stablecoins/stages.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/stages.ts)

#### Task

1. Build canonical validation context once per asset in sync paths.
2. Change dual-primary divergence selection:
   - use peg reference for all fixed pegs, not only USD
   - preserve NAV token exemption
3. Change sync-time price admission to use mode-aware decisions:
   - `primary_authoritative` for trusted primary results
   - `fallback_enrichment` for CMC, DexScreener search, and cached fallback admission
4. Ensure `commodityOunces` and canonical peg information are always sourced from tracked metadata for tracked assets.
5. Preserve broad positive-price behavior for `VAR` and unknown pegs unless the design explicitly tightens them.
6. Keep shadow counters for one more release even after enforcement so post-switch drift is visible.
7. Add tests for:
   - EUR divergence picks peg-closer candidate
   - JPY divergence picks peg-closer candidate
   - gold divergence picks peg-closer candidate
   - NAV divergence still avoids `$1` anchoring
   - cached fallback admission uses canonical metadata
   - tracked fractional gold fallback uses `commodityOunces` even when raw asset fields omit it

#### Important Guardrails

- Do not remove the reject-before-cache ordering
- Do not silently widen fallback/DEX behavior in this ticket
- If the new validator throws, fail safely and surface degraded telemetry rather than silently bypassing validation

#### Acceptance Criteria

- Non-USD fixed pegs no longer default to DL on disagreement
- Sync uses one canonical metadata context for tracked assets
- Cache-poisoning guard remains in place
- Existing canaries still price correctly under intended scenarios

#### Verification

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/sync-stablecoins-stages.test.ts \
  worker/src/cron/__tests__/detect-depegs.test.ts
cd worker && npx tsc --noEmit
```

#### Post-Deploy Observation

Observe another 24 hours before DEX enforcement.

Check specifically:

- `eurc-circle`
- `jpyc-jpyc`
- `brz-transfero`
- `xaut-tether`
- `kau-kinesis`
- `ggbr-goldfish-gold`
- `ousg-ondo-finance`

## Phase 3 — Enforce New Logic in DEX Paths

Goal: move DEX observations to live-reference validation without per-loop DB penalties.

### TICKET-005: Switch DEX Sanity to Shared References and Strict Observation Mode

```yaml
title: "Adopt live-reference DEX observation validation"
agent: codex
model: gpt-5
reasoning_effort: xhigh
risk: high
```

#### Goal

Use the new validation engine for DEX observation acceptance in both scoring and discovery flows.

#### Files

- [worker/src/cron/dex-liquidity/price-sanity.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/price-sanity.ts)
- [worker/src/cron/dex-liquidity/orchestrator.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/orchestrator.ts)
- [worker/src/cron/dex-liquidity/crawl-helpers.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/crawl-helpers.ts)
- [worker/src/cron/dex-liquidity/staging-merge.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/staging-merge.ts)
- [worker/src/cron/dex-liquidity/fetch-primary.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-primary.ts)
- [worker/src/cron/dex-liquidity/fetch-fallbacks.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-fallbacks.ts)
- [worker/src/cron/dex-discovery/orchestrator.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-discovery/orchestrator.ts)
- [worker/src/cron/dex-discovery/crawl-sources.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-discovery/crawl-sources.ts)

#### Task

1. Load FX + metal references once per DEX cron entrypoint, not per observation.
   - scoring path entrypoint: `worker/src/cron/dex-liquidity/orchestrator.ts`
   - discovery path entrypoint: `worker/src/cron/dex-discovery/orchestrator.ts`
2. Thread those references through the DEX sanity helper so each observation can be validated in `dex_observation` mode.
3. Remove implicit static-range-only behavior from normal DEX operation.
4. Keep an explicit stale/static fallback path for reference outages, but mark it in telemetry.
5. Add metrics for:
   - observations compared
   - observations rejected by new mode
   - rejections by reason
   - canary asset observation counts before/after
6. Add tests for:
   - JPYC with live JPY reference
   - BRZ with BRL alias normalization
   - XAUT with live gold reference
   - GGBR with `0.001 oz` scaling
   - KAG with live silver reference
   - NAV token DEX observations, if any exist in tests, staying broad-positive rather than peg-anchored

#### Performance Constraint

This ticket must not add a D1 read inside:

- pool iteration loops
- per-token batch loops
- staged-pool merge loops

References must be loaded once and passed down.

#### Acceptance Criteria

- DEX sanity uses fresh FX/metals in normal operation
- DEX loops do not regress into per-observation DB access
- canary commodity and FX assets validate against the correct live reference
- fallback/static reference use is visible in telemetry

#### Verification

```bash
npm test -- --run \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/cron/__tests__/sync-fx-rates.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts
npm run lint
```

#### Post-Deploy Observation

Observe at least one full day of DEX scoring + discovery cycles.

Manual checks:

- no canary asset unexpectedly drops to zero DEX observations
- obvious garbage observations are reduced, not increased
- gold and JPY canaries show intended new behavior

## Phase 4 — Enforce New Logic in Historical Backfill Paths

Goal: apply the same normalized engine to historical depeg extraction with a mode suited to backfill.

### TICKET-006: Switch Backfill and Historical Extraction

```yaml
title: "Adopt historical backfill validation mode for depeg extraction"
agent: codex
model: gpt-5
reasoning_effort: high
risk: medium
```

#### Goal

Use a backfill-specific validation mode so severe historical failures are not filtered by rules tuned for fallback or DEX noise.

#### Files

- [worker/src/api/backfill-depegs.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-depegs.ts)
- [worker/src/api/__tests__/backfill-depegs-helpers.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/backfill-depegs-helpers.test.ts)
- [worker/src/api/__tests__/backfill-depegs.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/backfill-depegs.test.ts)

#### Task

1. Replace direct boolean helper use in historical extraction with the new `historical_backfill` mode.
2. Keep canonical tracked metadata for:
   - peg normalization
   - `commodityOunces`
   - NAV classification
3. Preserve existing coin-specific exclusion logic such as known CoinGecko anomalies.
4. Add tests for:
   - a severe USD downside move that should survive in historical mode when otherwise valid
   - JPYC / low-nominal FX historical behavior
   - fractional gold historical behavior
   - known bad commodity outliers still being excluded for the right reason

#### Acceptance Criteria

- backfill no longer relies on the same coarse boolean rules as DEX or fallback enrichment
- historical mode preserves intended catastrophic-move coverage
- known exclusions still work

#### Verification

```bash
npm test -- --run \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts \
  worker/src/api/__tests__/backfill-depegs.test.ts \
  worker/src/cron/__tests__/detect-depegs.test.ts
cd worker && npx tsc --noEmit
```

## Phase 5 — Cleanup, Docs, and Final Lock-In

Goal: remove ambiguity, update docs, and make the new behavior the documented source of truth.

### TICKET-007: Downstream Consumer Regression Review

```yaml
title: "Run dedicated downstream consumer regression review before final docs/sign-off"
agent: codex
model: gpt-5
reasoning_effort: xhigh
risk: high
```

#### Goal

Prove that the new price-sanity behavior does not introduce unintended regressions in secondary systems that consume `stablecoins`, `price_cache`, or `dex_prices`.

#### Files

- [worker/src/cron/compute-dews.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts)
- [worker/src/cron/stability-index.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/stability-index.ts)
- [worker/src/cron/daily-digest.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts)
- [worker/src/lib/report-cards-snapshot.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts)
- [worker/src/lib/safety-scores.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/safety-scores.ts)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts)
- [worker/src/api/peg-summary.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/peg-summary.ts)
- [src/components/homepage-client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/homepage-client.tsx)
- [src/app/compare/client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/compare/client.tsx)
- [src/app/dependency-map/client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/dependency-map/client.tsx)
- [src/hooks/use-stablecoin-detail-view-model.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-stablecoin-detail-view-model.ts)

#### Task

1. Review every consumer in the downstream matrix and identify whether it relies on:
   - stablecoins cache presence
   - stablecoins price availability
   - `priceConfidence`
   - `priceUpdatedAt`
   - `fxFallbackRates`
   - `dex_prices`
   - `price_cache`
2. Add or expand tests where behavior could change silently:
   - `compute-dews` confidence effects
   - `stability-index` input integrity
   - `daily-digest` stablecoins-cache dependence
   - `report-cards-snapshot` and `safety-scores` cache-read expectations
   - `mint-burn-flows` market-cap lookup behavior under changed price availability
   - frontend stablecoin-detail / compare / homepage compatibility with unchanged schema but shifted price semantics
3. Add a dedicated regression checklist to the PR description or implementation notes covering:
   - DEWS
   - PSI
   - digest
   - report cards / safety scores
   - mint/burn
   - peg summary
   - homepage
   - compare
   - dependency map
4. If there is no PR flow in use, record that regression checklist in the implementation notes and the progress tracker instead.
5. If any downstream consumer requires runtime metadata or docs updates to stay interpretable, make those changes in this ticket rather than deferring them.

#### Acceptance Criteria

- Every consumer in the downstream matrix has either:
  - a passing targeted automated test, or
  - a documented manual smoke check with explicit outcome
- No downstream job starts treating missing prices as healthy zeroes
- No downstream UI breaks because of stablecoins payload compatibility assumptions
- No downstream scoring job changes semantics silently without tests or docs

#### Verification

```bash
npm test -- --run \
  worker/src/cron/__tests__/compute-dews.test.ts \
  worker/src/cron/__tests__/daily-digest.test.ts \
  worker/src/cron/__tests__/stability-index.test.ts \
  worker/src/api/__tests__/mint-burn-flows.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts \
  worker/src/api/__tests__/stability-index.test.ts \
  worker/src/api/__tests__/status.test.ts \
  worker/src/api/__tests__/stress-signals.test.ts \
  worker/src/lib/__tests__/report-cards-snapshot.test.ts \
  worker/src/lib/__tests__/safety-scores.test.ts \
  src/lib/__tests__/stablecoin-detail-view-model.test.ts \
  src/lib/__tests__/stablecoin-schema-compat.test.ts \
  src/components/__tests__/comparison-table.test.tsx
```

### TICKET-008: Cleanup Compatibility Layers and Update Docs

```yaml
title: "Finalize price-sanity hardening docs and cleanup"
agent: codex
model: gpt-5
reasoning_effort: medium
risk: medium
```

#### Goal

Document the new system precisely and remove obsolete comments, tests, and compatibility scaffolding that would otherwise cause future drift.

#### Files

- [docs/data-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/data-pipeline.md)
- [docs/dex-liquidity.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/dex-liquidity.md)
- [docs/depeg-detection.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/depeg-detection.md)
- [docs/data-flow-map.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/data-flow-map.md)
- [docs/api-reference.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
- [docs/methodology-page.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/methodology-page.md)
- [docs/dews.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/dews.md)
- [docs/stability-index.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/stability-index.md)
- [docs/digest-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/digest-pipeline.md)
- [docs/status-dashboard.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/status-dashboard.md)
- [docs/worker-infrastructure.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
- [README.md](/home/ahirice/Documents/git/stablecoin-dashboard/README.md)

#### Task

1. Update the data pipeline docs to explain:
   - validation modes
   - canonical metadata context
   - reference freshness policy
   - dual-primary selection for non-USD pegs
2. Update DEX docs to explain:
   - live FX/metal reference use
   - fallback/static reference behavior
   - stricter observation-mode validation
3. Update depeg/backfill docs to explain:
   - historical validation mode
   - why severe confirmed failures are preserved
4. Update API docs only if any public/admin metadata shape changed.
5. Remove outdated comments that still claim the old global helper behavior.
6. Keep the “no new data source” fact explicit; `/about` does not need a source update.
7. Update methodology-page mappings if any methodology-facing copy references old price-validation behavior.
8. If DEWS, PSI, digest, or status copy depends on price-provenance interpretation, update those docs in the same ticket.

#### Acceptance Criteria

- Docs match runtime behavior
- No stale comment describes the old non-USD divergence rule
- No stale doc claims DEX sanity works without live FX/metal references

#### Verification

```bash
npm run build
npm run lint
```

## Final Verification

Before considering the work complete:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Recommended focused re-run immediately before merge:

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/sync-stablecoins-stages.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/cron/__tests__/detect-depegs.test.ts \
  worker/src/cron/__tests__/confirm-pending-depegs.test.ts \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts \
  worker/src/api/__tests__/mint-burn-flows.test.ts \
  worker/src/api/__tests__/stability-index.test.ts \
  worker/src/api/__tests__/stress-signals.test.ts \
  worker/src/cron/__tests__/compute-dews.test.ts \
  worker/src/cron/__tests__/daily-digest.test.ts \
  worker/src/cron/__tests__/stability-index.test.ts \
  worker/src/cron/__tests__/sync-fx-rates.test.ts \
  worker/src/lib/__tests__/report-cards-snapshot.test.ts \
  worker/src/lib/__tests__/safety-scores.test.ts \
  src/lib/__tests__/stablecoin-detail-view-model.test.ts \
  src/lib/__tests__/stablecoin-schema-compat.test.ts \
  src/components/__tests__/comparison-table.test.tsx
```

## Manual Review Checklist

After deploy, review:

1. `sync-stablecoins` cron metadata for shadow and post-enforcement counters
2. DEX cron metadata for old/new observation deltas
3. `/api/status` admin response if new validation metadata was surfaced there
4. Canary assets:
   - `eurc-circle`
   - `jpyc-jpyc`
   - `brz-transfero`
   - `xaut-tether`
   - `kau-kinesis`
   - `cgo-comtech`
   - `ggbr-goldfish-gold`
   - `kag-kinesis`
   - `ousg-ondo-finance`
   - one `VAR` peg asset

Questions to answer explicitly:

- Did any canary lose a legitimate current price?
- Did any canary gain a clearly bad current price?
- Did any canary lose all DEX observations unexpectedly?
- Did NAV tokens remain exempt from false `$1` anchoring?
- Did fractional commodities use the right unit size everywhere?
- Did DEWS, PSI, digest, report cards, and mint/burn continue to behave sensibly under the new price availability/provenance rules?

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Over-tightening drops real crashes | High | mode split, shadow rollout, canary review, authoritative-mode downside allowance |
| Under-tightening still admits garbage fallback prices | High | stricter fallback/DEX modes, reason-coded telemetry, canary mismatch review |
| DEX performance regression from reference loading | High | load references once per cron, never inside pool loops |
| Inconsistent tracked metadata usage persists | High | canonical context sourced from tracked metadata first, tested on fractional gold and BRL |
| Backfill history changes unexpectedly | Medium | separate backfill ticket, targeted helper tests, manual canary review before operator use |
| Metadata becomes too large for cron rows | Medium | keep counters compact, cap samples to a small N |
| Docs drift from runtime | Medium | docs ticket is mandatory, not optional |

## Rollback Strategy

This plan intentionally avoids D1 migrations so rollback remains code-only.

Rollback order:

1. Revert the latest enforcement ticket if the issue is isolated
2. If the issue spans multiple tickets, revert back to the last shadow-only deployment
3. Keep shadow telemetry if possible during rollback so postmortem data remains available

Operational rollback principle:

- prefer reverting enforcement while keeping observability
- do not revert back to fully opaque behavior if avoidable

## Recommended Merge Sequence

1. TICKET-001
2. TICKET-002
3. TICKET-003
4. Deploy and observe Gate B
5. TICKET-004
6. Deploy and observe Gate C
7. TICKET-005
8. Deploy and observe Gate D
9. TICKET-006
10. TICKET-007
11. Pass Gate E
12. TICKET-008

## Summary

This implementation plan is intentionally conservative.

It does not treat price-sanity hardening as a single helper refactor. It treats it as a staged infrastructure change:

- first lock the behavior in tests
- then build the new engine additively
- then observe it in shadow mode
- then switch primary sync
- then switch DEX
- then switch backfill
- then update docs and remove ambiguity

That is the safest way to improve a critical price-ingestion system without guessing our way through production behavior.
