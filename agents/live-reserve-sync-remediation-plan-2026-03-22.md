# Live Reserve Sync Remediation Plan

Date: 2026-03-22

Input: [live-reserve-sync-audit-2026-03-22.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/live-reserve-sync-audit-2026-03-22.md)

Goal: execute on all audit findings with a sequencing that preserves production safety, improves data accuracy first, and reduces long-term maintenance cost second.

## Objectives

1. Preserve and expose the most accurate reserve data possible, even across partial failures.
2. Make reserve-sync health and scoring eligibility reflect real evidence quality rather than incidental implementation details.
3. Reduce adapter sprawl by moving repeated patterns into shared contracts and helpers.
4. Increase confidence through targeted tests, explicit acceptance criteria, and a final full validation gate.

## Constraints And Guardrails

- Migrations must be backward-compatible. Standard deploy applies D1 migrations before the new worker is live.
- No destructive migration in the main rollout. Cleanup happens only after the new read/write path has been stable in production.
- Preserve current public API shape unless a contract change is explicitly intended and documented.
- Any change that affects report-card collateral passthrough or redemption-backstop behavior must update the matching methodology/timeline docs.
- Keep live reserve coverage available during the rollout. Do not require a flag day cutover.

## Recommended Execution Order

1. Phase 0: contract decisions and invariants
2. Phase 1: storage and state separation
3. Phase 2: orchestrator and reader refactor
4. Phase 3: warning semantics and evidence-quality contract
5. Phase 4: freshness standardization
6. Phase 5: precision and shared-helper refactor
7. Phase 6: adapter remediation by family
8. Phase 7: observability, docs, and final hardening

This order is intentional:

- Phases 1 and 2 fix the current correctness bug where good metadata is lost after bad runs.
- Phases 3 and 4 make health/scoring behavior coherent.
- Phases 5 and 6 reduce long-term maintenance burden only after the data contract is stable.

## Phase 0: Contract Decisions To Lock Before Coding

This phase is short but mandatory. The implementation should not start until these decisions are written down in the PR or in a short design note.

### D0.1 Success Snapshot vs Attempt State

Adopt this model:

- `reserve_composition` is the latest successful snapshot store
- `reserve_sync_state` is the latest attempt state store
- success metadata used by downstream business logic lives with the successful snapshot, not with the latest attempt row

### D0.2 Warning Effect Model

Replace the current implicit rule "any warning => degraded" with explicit effect classes:

- `info`: visible in API/status, does not change `last_status`
- `degraded`: visible, sets `last_status = degraded`, excluded from scoring-eligible reads
- `fatal`: hard-fail the adapter result

Implementation recommendation:

- extend `LiveReserveWarning` to include `effect: "info" | "degraded" | "fatal"`
- keep `severity` only for presentation if still useful

### D0.3 Standard Snapshot Metadata Contract

Define a typed shared metadata shape for cross-adapter fields:

- `sourceTimestamp?: number`
- `unknownExposurePct?: number`
- `supplyUsd?: number`
- `totalReserveUsd?: number`
- `immediateRedeemableUsd?: number`
- `immediateRedeemableRatio?: number`
- `redemptionFeeBps?: number`
- `details?: Record<string, unknown>`

Use this as the supported contract for downstream consumers. Adapter-specific extras go under `details`.

### D0.4 Timestamp-Less Independent Feeds

Recommended default:

- timestamp-less onchain oracle probes do not automatically degrade sync state
- they must expose an explicit freshness mode such as `freshness: "verified" | "unverified"`
- scoring eligibility remains a product decision per adapter, not an incidental side effect of a warning

Immediate application:

- `chainlink-nav` `getPrice()` routes should stop being permanently degraded by implementation detail alone

### D0.5 Residual-Modeled Adapters

Recommended default:

- if the adapter intentionally models residual exposure as an explicit reserve slice, that should not automatically degrade the sync
- degradation should depend on configured thresholds, not on the mere presence of residual modeling

Immediate application:

- `gho` residual issuance warning should become threshold-based or informational once residual exposure is explicitly modeled as a slice

### Exit Criteria

- All five decisions above are reflected in code comments, shared types, or a short design note in `/agents/`
- No implementation PR starts before these are locked

## Phase 1: Storage And State Separation

### Scope

Fix F1 and O2 from the audit:

- latest successful telemetry must survive failed/skipped sync attempts
- add forensic history without breaking the current runtime

### Schema Plan

#### Migration 1: additive only

Add nullable / defaulted fields and history tables:

- `reserve_composition`
  - add `metadata TEXT NOT NULL DEFAULT '{}'`
  - add `warning_count INTEGER NOT NULL DEFAULT 0`
  - add `warnings TEXT`
  - add `adapter_source_model TEXT`
  - add `adapter_evidence_class TEXT`
- `reserve_composition_history`
  - append-only successful snapshots
  - columns: `stablecoin_id`, `fetched_at`, `adapter_key`, `slices`, `metadata`, `warnings`, `warning_count`
- `reserve_sync_attempt_history`
  - append-only attempt log
  - columns: `stablecoin_id`, `attempted_at`, `adapter_key`, `breaker_key`, `status`, `warnings`, `warning_count`, `last_error`, `metadata`

Keep `reserve_sync_state` intact for now.

#### Migration 2: optional backfill helper, no destructive change

- one-off backfill from existing `reserve_sync_state.metadata` into `reserve_composition.metadata` where the latest success timestamps match
- only backfill rows where `reserve_composition.metadata` is still empty

### Code Changes

- update [live-reserves-store.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/live-reserves-store.ts) to read/write `reserve_composition.metadata`
- update [sync-live-reserves.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts) to:
  - write success metadata to `reserve_composition`
  - never overwrite success metadata on failure/skip
  - append to attempt history on every attempt
  - append to snapshot history on every success
- keep dual-read fallback temporarily:
  - if `reserve_composition.metadata` is empty and timestamps align, fall back to legacy `reserve_sync_state.metadata`

### Acceptance Criteria

- a failed run after a successful run does not erase `immediateRedeemableUsd`, `immediateRedeemableRatio`, or `redemptionFeeBps`
- redemption-backstop consumers continue to resolve from the last successful metadata after failure
- current public reserve API behavior remains available during the migration window
- new migrations are rollout-safe and do not require the new worker to be live first

### Validation

- add unit tests covering:
  - success -> failure metadata preservation
  - success -> skipped metadata preservation
  - legacy backfill read path
  - history row append behavior
- run:
  - `npm test -- worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
  - `npm run check:migrations`

## Phase 2: Orchestrator And Reader Refactor

### Scope

Fix F2 and prepare for F3/F4:

- authoritative reads must fail closed on malformed stored snapshots
- readers must distinguish latest success from latest attempt without ambiguity

### Implementation Tasks

1. Change snapshot parsing to produce a corruption outcome, not a filtered best-effort live result.
2. Introduce a strict authoritative snapshot loader:
   - valid JSON
   - non-empty slice set
   - valid risks
   - non-negative finite pcts
   - sum within tolerance
3. Update `resolveReserveResult()` to:
   - return `live` only for fully valid authoritative snapshots
   - fall back when snapshot rows are corrupt or incomplete
   - surface corruption to ops/status
4. Update overview/status computation so corrupted latest snapshots are counted distinctly from ordinary missing data.
5. Remove consumer dependence on `reserve_sync_state.metadata` as the business-data source of truth once Phase 1 dual-write is live.

### Acceptance Criteria

- no partially filtered snapshot can be returned as `mode="live"`
- corrupted stored rows degrade or fall back cleanly
- status surfaces can distinguish:
  - no snapshot yet
  - stale snapshot
  - corrupted snapshot
  - latest attempt error

### Validation

- add tests for:
  - corrupted `reserve_composition.slices`
  - mismatched timestamps with valid metadata
  - stale valid snapshots
  - corrupted latest snapshot falling back to curated/template presentation
- run:
  - `npm test -- worker/src/lib/__tests__/live-reserves-store.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts`

## Phase 3: Warning Semantics And Evidence Contract

### Scope

Fix F3 and O1:

- health and scoring eligibility should depend on meaningful warning effects, not the existence of any warning
- evidence quality must be explicit

### Implementation Tasks

1. Extend `LiveReserveWarning` with `effect`.
2. Refactor `validateAdapterOutput()` to return:
   - info warnings
   - degraded warnings
   - fatal warnings
3. Change `sync-live-reserves` state resolution:
   - fatal warning => fail
   - degraded warning => write `last_status = degraded`
   - info warning => keep `last_status = ok`
4. Introduce helper utilities:
   - `hasDegradingWarnings()`
   - `hasFatalWarnings()`
5. Revisit scoring eligibility logic so it uses:
   - evidence class
   - freshness
   - `last_status`
   - explicit freshness mode where relevant
6. Update status UI / API copy to separate:
   - informational notes
   - degraded evidence
   - hard failures

### Adapter-Specific Immediate Applications

- `chainlink-nav` `getPrice()`:
  - move freshness-unverified warning to `effect = info` or downgrade evidence class by explicit config decision from Phase 0
- `gho`:
  - residual aggregation warning becomes threshold-based or informational if the residual slice is intentionally modeled

### Acceptance Criteria

- warning-bearing adapters are not permanently degraded unless the warning is actually evidence-degrading
- report-card passthrough is gated by explicit data-quality policy, not by incidental warning presence

### Validation

- add tests for:
  - info warning keeps `ok`
  - degraded warning produces `degraded`
  - fatal warning rejects output
  - `chainlink-nav` getPrice path no longer becomes degraded by default
  - `gho` residual modeling behaves per policy

## Phase 4: Freshness Standardization

### Scope

Fix F4:

- every non-latest-state source must emit freshness evidence where possible
- every disclosure/dashboard adapter must have an explicit freshness policy

### Shared Work

1. Standardize `sourceTimestamp` as the canonical field used by validation.
2. Add optional `freshnessMode` metadata for feeds whose freshness cannot be directly proven.
3. Expand the adapter registry validation policies in [live-reserve-adapters.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/live-reserve-adapters.ts).
4. Add a short ops rule:
   - if upstream exposes a date, parse it
   - if upstream does not, mark freshness unverified explicitly

### Adapter Freshness Backlog

- Add or validate timestamps for:
  - `circle-transparency`
  - `mento`
  - `m0`
  - `openeden-usdo`
  - `infinifi`
  - `reservoir`
  - `fx`
  - `tether`
  - `frax`
- Confirm existing timestamp producers are correct:
  - `accountable`
  - `dola-inverse`
  - `ethena`
  - `falcon`
  - `fdusd-transparency`
  - `sgforge-coinvertible`
  - `sky-makercore`
  - `chainlink-nav`
  - `chainlink-por`

### Acceptance Criteria

- every adapter is classified into one of:
  - freshness verified
  - freshness unverified but explicitly documented
  - freshness not applicable because source is direct latest-state onchain data
- no dashboard/HTML adapter remains `independent` without an explicit freshness story

### Validation

- add targeted adapter tests for timestamp parsing
- update registry tests to assert every adapter has a declared freshness mode or policy

## Phase 5: Precision, Normalization, And Shared Helpers

### Scope

Fix F5 and O3/O4 on the maintainability side.

### Implementation Tasks

1. Change `normalizeSlices()` default precision from `0` to `1`.
2. Make `slicesFromValues()` sort and normalize via one shared code path so all adapters behave consistently.
3. Remove pre-normalization tail dropping from adapters unless the dropped tail is explicitly aggregated into a named residual slice.
4. Add request-signature raw-response memoization for same-run identical fetches:
   - JSON GET
   - HTML GET
   - GraphQL POST
5. Keep current `sharedSourceMode = "source-invariant"` for final parsed results, but add raw payload reuse for coin-aware parsers.
6. Introduce shared helper families:
   - HTML disclosure extractors
   - bucketed value -> slice converters
   - common asset classification / symbol-to-risk helpers
   - common timestamp parsing + normalization

### Acceptance Criteria

- reserve output precision is consistent across adapters
- small exposures are not silently lost from stored live output
- adapters that hit the same upstream URL in the same run no longer refetch identical payloads unnecessarily

### Validation

- helper unit tests for normalization and memoization
- adapter tests for small-tail preservation
- hotspot review to confirm LOC reductions in adapter files and helpers

## Phase 6: Adapter Remediation Matrix

This is the execution checklist for all 27 adapters. Every adapter listed in the audit is covered here.

| Adapter | Planned Changes | Validation |
| --- | --- | --- |
| `accountable` | Switch to shared param parser, add bucket-total reconciliation against `total_reserves`, replace open-ended `exposure_split` recursion with stricter parsing, retain timestamp behavior | unit tests for each bucket, reconciliation failure tests |
| `asymmetry` | one-decimal precision, move branch classification toward shared taxonomy, add freshness metadata if upstream exposes it | transform tests with small tails and unknown branches |
| `btcfi` | replace fail-on-new-BTC-wrapper with explicit unknown BTC bucket, add source timestamp if possible, consider multi-slice output if upstream supports it | tests for new wrapper behavior and freshness parsing |
| `chainlink-nav` | inject clock, centralize Chainlink staleness handling, handle `getPrice()` freshness as explicit policy instead of permanent degraded state | unit tests for `latestRoundData` and `getPrice` modes |
| `chainlink-por` | share Chainlink helper path, inject clock, keep explicit staleness policy | Chainlink helper tests |
| `circle-transparency` | migrate to shared HTML extraction helper, extract statement/report date, use shared param parser, add freshness policy | parser tests with realistic HTML variations |
| `collateral-positions-api` | degrade immaterial missing-price assets into unknown bucket, widen coinId resolution, add freshness metadata if available | missing-price threshold tests |
| `crvusd` | one-decimal precision, move collateral symbol classification to shared canonical helper, add freshness metadata if source exposes it | classifier tests and precision tests |
| `curated-validated` | fold into generic probe-validated-static family, clarify presentation semantics, keep conservative evidence class | shared probe/static tests |
| `dola-inverse` | move bucket taxonomy into shared asset classification helper, retain timestamp logic | bucket tests |
| `erc4626-single-asset` | use shared param parser, add optional stronger vault verification hooks where justified | onchain mock tests |
| `ethena` | move asset allowlists to shared taxonomy layer, retain reconciliation and freshness logic | taxonomy tests |
| `evm-branch-balances` | enforce same-chain branches at schema level or support per-branch chain reads correctly, key prices by chain/address rather than branch name, retain fee-probe support | config validation tests and duplicate-name tests |
| `falcon` | move asset allowlists to shared taxonomy layer, retain timestamp and unknown exposure logic | transform tests |
| `fdusd-transparency` | move to shared HTML disclosure parser, retain timestamp logic | HTML parser tests |
| `frax` | fold into generic probe-validated-static family, make static/live semantics explicit, add freshness metadata if API exposes it | probe/static tests |
| `fx` | allow unknown collateral keys into explicit other bucket rather than full failure, add freshness metadata if possible | unknown-key tests |
| `gho` | add decoder-path tests, convert residual warning to threshold/info policy, parallelize facilitator reads with bounded concurrency, keep redemption metadata | decoder tests and integration-style mocked onchain tests |
| `infinifi` | stop dropping sub-0.05% tails, use one-decimal precision, move farm map toward shared config, add freshness metadata if upstream exposes it | tail-preservation tests |
| `m0` | verify unit assumptions around `cashScaleApplied`, extract timestamp if upstream exposes one, benefit from raw-response memoization | unit reconciliation tests |
| `mento` | move to shared HTML parser, extract source/report date, add freshness policy | HTML parser tests |
| `openeden-usdo` | add source timestamp extraction, keep component and ratio reconciliation | reconciliation plus timestamp tests |
| `reservoir` | replace substring bucket matching with stable identifiers if API exposes them, use one-decimal precision, add freshness metadata if possible | matching and precision tests |
| `sgforge-coinvertible` | parse full bank composition or honor `bankPct` instead of assuming 100% single-bank cash, move to shared HTML parser | bank share tests |
| `single-asset` | keep weak evidence explicit, share fee-probe mixin/helper, avoid overstating proof strength, maintain probe semantics | probe-mode and fee-mode tests |
| `sky-makercore` | move token taxonomy into shared classifier, retain timestamp and unknown exposure logic | taxonomy tests |
| `tether` | extract report/source date if the payload exposes it, add freshness policy, keep weak-live-probe evidence class | timestamp and payload tests |

## Phase 7: Observability, Docs, And Final Hardening

### Ops And Status

1. Update status surfaces to show:
   - latest attempt state
   - latest successful snapshot age
   - degraded-vs-info warning counts
   - corrupt snapshot counts if introduced
2. Add history drill-down support using the new history tables.
3. Expose evidence-class coverage in admin/ops KPIs:
   - independent
   - validated-static
   - weak-live-probe

### Documentation Updates Required During Implementation

- [docs/live-reserves.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md)
- [docs/worker-infrastructure.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
- [docs/api-reference.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md) if reserve API sync metadata or modes change
- [docs/redemption-backstops.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/redemption-backstops.md) if metadata reuse semantics change
- [docs/report-cards-timeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/report-cards-timeline.md) and the scoring methodology changelog if scoring eligibility changes
- [docs/testing.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md) if new reserve-sync checks or suites are added

Only update the about page if new data sources are introduced. This remediation plan does not assume new sources by default.

## Validation Strategy

Validation is part of the implementation, not a postscript.

### Per-Phase Gates

- Phase 1 gate:
  - migrations replay cleanly
  - metadata preservation tests pass
- Phase 2 gate:
  - corrupt snapshot fail-closed tests pass
  - reserve API contract tests pass
- Phase 3 gate:
  - warning-effect tests pass
  - scoring eligibility tests pass
- Phase 4 gate:
  - every adapter has freshness coverage or explicit freshness-unverified policy
- Phase 5 gate:
  - normalization tests pass
  - no precision regressions in targeted fixtures
- Phase 6 gate:
  - each touched adapter has updated tests
  - no adapter remains with an uncaptured audit action

### Final Pre-Push Validation

Run the full local gate before push:

```bash
npm run lint
npm test
npm run build
npm run check:doc-sync
npm run check:doc-counts
npm run check:migrations
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Targeted reserve-sync suites should also be part of the working loop:

```bash
npm test -- worker/src/cron/__tests__/sync-live-reserves.test.ts
npm test -- worker/src/lib/__tests__/live-reserves-store.test.ts
npm test -- worker/src/api/__tests__/stablecoin-reserves.test.ts
npm test -- worker/src/lib/__tests__/redemption-backstop-sources.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/*
```

## Exit Criteria For The Full Program

The remediation is complete only when all of the following are true:

1. Last successful reserve metadata survives failed/skipped attempts.
2. Corrupt stored snapshots cannot be served as authoritative live data.
3. Warning handling is effect-based and no longer degrades every warning-bearing feed by default.
4. Every adapter has an explicit freshness story.
5. Precision is consistent and small exposures are not silently lost.
6. Every adapter named in the audit has been explicitly reviewed and updated or consciously left unchanged with justification.
7. Reserve-sync docs, scoring docs, and redemption docs are aligned with the new behavior.
8. `npm run test:merge-gate` passes.

## Audit Traceability Matrix

Every audit item is mapped below so implementation planning can be checked mechanically.

| Audit Item | Covered By |
| --- | --- |
| F1 metadata loss on failed/skipped runs | Phase 1, Phase 2 |
| F2 malformed stored snapshots served as live | Phase 2 |
| F3 warnings too coarse | Phase 3 |
| F4 freshness inconsistent/missing | Phase 4, Phase 6 |
| F5 precision loss | Phase 5, Phase 6 |
| F6 weak high-risk test coverage | Phase 1 through Phase 6 validation work |
| O1 mixed evidence quality | Phase 3, Phase 7 |
| O2 success state mixed with attempt state | Phase 0, Phase 1 |
| O3 within-run cache too narrow | Phase 5 |
| O4 no snapshot/attempt history | Phase 1, Phase 7 |

## Plan Validation Checklist

This checklist is for validating the plan itself before implementation begins.

- All 6 audit findings are mapped in the traceability matrix.
- All 4 architectural observations are mapped in the traceability matrix.
- All 27 adapters appear in the adapter remediation matrix.
- Rollout-safe migration sequencing is specified.
- Final validation commands are specified.
- Documentation updates affected by behavior/methodology changes are listed.

If any item above fails, the plan is incomplete and should be revised before coding starts.
