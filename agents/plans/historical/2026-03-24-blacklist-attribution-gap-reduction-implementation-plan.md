# Blacklist Attribution Gap Reduction Implementation Plan

Date: 2026-03-24
Inputs:
- [blacklist attribution gap reduction ranking](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/research/2026-03-24-blacklist-attribution-gap-reduction-ranking.md)
- [tron blacklist amount attribution research](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/research/2026-03-24-tron-blacklist-amount-research.md)
- [blacklist tracker remediation plan](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-24-blacklist-tracker-remediation-plan.md)

Goal: reduce remaining unattributed blacklist amounts with the lowest execution risk, prioritizing the current production backlog and adding enough operational control that future gaps cannot remain stranded silently.

## Executive Summary

The implementation should be sequenced as a controlled backlog-remediation project, not as a broad infrastructure expansion.

Production data on 2026-03-24 shows:

- total rows: `15,208`
- recoverable gaps: `26`
- all `26` recoverable gaps are legacy Avalanche `USDC` blacklist rows from 2022
- all `26` are missing `contract_address` and `config_key`
- there are no recoverable gaps in the last 365 days

That means the safest high-return plan is:

1. add explicit attempt/diagnostic tracking for amount recovery
2. implement a targeted legacy remediation path for pre-provenance rows
3. add an operator-controlled sweeper for future stale recoverable rows
4. only then decide whether an extra EVM provider is worth the complexity

Do not start by changing the live hourly blacklist cron behavior materially. Land observability and the targeted repair path first.

## Objectives

1. Eliminate the current recoverable EVM backlog without destabilizing hourly ingestion.
2. Make amount-attribution retries inspectable and finite.
3. Distinguish legitimate zero-balance resolutions from true unresolved failures.
4. Add a safe operator workflow for future historical cleanup.
5. Keep the solution backward-compatible with the existing D1 rollout process.

## Non-Goals

- Reworking Tron amount attribution in this tranche
- Re-enabling `EURC`
- Rewriting blacklist ingestion architecture again
- Broad provider expansion before existing backlog repair and observability are in place

## Delivery Strategy

Use four workstreams in strict order:

1. Recovery telemetry and diagnostics
2. Legacy backlog remediation path
3. Operator sweeper and status integration
4. Optional provider-ladder hardening

Each workstream should land with its own tests and documentation updates. The one-time production remediation should not run until Workstreams 1 and 2 are deployed and validated.

## Workstream 1: Recovery Telemetry And Diagnostics

Purpose: make every future missing-amount row explainable before attempting bulk remediation.

### Scope

- `worker/migrations/*`
- `worker/src/cron/sync-blacklist.ts`
- `worker/src/lib/blacklist-gaps.ts`
- `worker/src/api/status*`
- `docs/blacklist-tracker.md`
- `docs/status-dashboard.md`
- blacklist cron/status tests

### Schema

Add minimal retry/diagnostic fields to `blacklist_events`:

- `amount_attempt_count INTEGER NOT NULL DEFAULT 0`
- `amount_last_attempted_at INTEGER`
- `amount_last_error_class TEXT`
- `amount_last_provider TEXT`

Guidelines:

- keep fields nullable or defaulted so the migration is backward-compatible
- do not drop or repurpose existing amount fields in this tranche
- write only append-safe changes

### Runtime Changes

Whenever the worker attempts balance recovery for a row:

- increment `amount_attempt_count`
- set `amount_last_attempted_at`
- set `amount_last_provider` to the provider that actually answered or failed last
- set `amount_last_error_class` when the attempt misses due to known provider/runtime reasons

Suggested error classes:

- `provider_null`
- `provider_timeout`
- `provider_http_error`
- `provider_unsupported`
- `config_missing`
- `runtime_budget`
- `budget_exhausted`
- `ambiguous_config`

Keep the classes coarse. This is operational telemetry, not a user-facing taxonomy.

### Status Integration

Extend internal gap reporting to expose:

- total recoverable gaps
- recent recoverable gaps
- oldest recoverable gap age
- rows with `amount_attempt_count = 0`
- rows with repeated failed attempts above a threshold

Do not change the public blacklist API contract unless necessary. This telemetry is primarily for ops/admin/status.

### Acceptance Criteria

- every recovery attempt leaves an audit trail on the row
- status tooling can distinguish new transient misses from stale stranded rows
- no existing consumer breaks on rows with new fields

### Risks And Mitigation

- Risk: excessive write churn during hourly cron
- Mitigation: only update attempt metadata for rows actually selected for recovery work, not every scanned row

- Risk: overly granular error classes create noise
- Mitigation: keep the enum intentionally small and operational

## Workstream 2: Legacy Backlog Remediation Path

Purpose: safely clear the current recoverable backlog, which is a legacy pre-provenance cohort.

### Scope

- `worker/src/cron/sync-blacklist.ts`
- new admin/remediation helper under `worker/src/lib/` or `worker/src/api/admin/`
- `worker/src/lib/blacklist-contracts.ts`
- `worker/src/cron/blacklist/balance-providers.ts`
- `docs/blacklist-tracker.md`
- `docs/api-reference.md` if an admin endpoint is added
- targeted tests

### Design Principle

Do not overload the normal hourly cron with special-case legacy repair logic. Build a bounded targeted remediation path that can be run deliberately and verified.

### Remediation Target Definition

Target rows matching all of:

- `amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')`
- `event_type IN ('blacklist', 'unblacklist', 'destroy')`
- `contract_address IS NULL OR config_key IS NULL`

For the first execution tranche, further narrow to:

- `chain_id = 'avalanche'`
- `stablecoin = 'USDC'`

This keeps the first production run tightly scoped to the known backlog.

### Remediation Flow

1. Load a batch of target rows ordered by oldest timestamp first.
2. Resolve config deterministically from current canonical contract metadata.
3. If config resolution is ambiguous, do not invent precision:
   - leave row unresolved
   - write `amount_last_error_class = 'ambiguous_config'`
4. Attempt historical amount recovery with the current provider ladder.
5. If recovery succeeds with `0`, treat it as a normal success:
   - `amount_native = 0`
   - `amount_usd_at_event = 0` for USD-pegged assets
   - `amount_source = 'historical_balance'`
   - `amount_status = 'resolved'`
6. Backfill provenance on success:
   - `contract_address`
   - `config_key`
   - `event_signature` and `event_topic0` only if they can be reconstructed safely
7. If recovery still fails:
   - keep row recoverable
   - persist attempt diagnostics

### Execution Surface

Preferred implementation:

- add a bounded admin endpoint or scripted admin action, not an automatic migration

Why:

- it is easier to dry-run
- it is easier to verify the exact affected row set
- it avoids tying a one-time data repair to every hourly cron invocation forever

Possible surfaces:

- `POST /api/admin/blacklist-remediate-amount-gaps`
- or a worker-side admin script invoked via `wrangler`

Recommended payload/controls:

- `chainId`
- `stablecoin`
- `limit`
- `dryRun`
- `onlyMissingProvenance`
- `maxAttempts`

### Dry-Run Requirement

Before the first write-enabled run, support a dry-run mode that reports:

- candidate row count
- config resolution outcome counts
- estimated rows likely to be resolved
- a sample of affected IDs

### Acceptance Criteria

- the tool can target the exact known Avalanche `USDC` cohort
- successful remediation converts rows to normal `resolved` rows, including zero balances
- failed rows are left in a more diagnosable state than before
- the hourly cron behavior for new rows remains unchanged

### Risks And Mitigation

- Risk: mistaken config assignment for legacy rows
- Mitigation: first tranche only targets a single known chain/token cohort with a single canonical contract

- Risk: accidental wide write blast radius
- Mitigation: dry-run support, explicit filters, capped batch size, and oldest-first ordering

## Workstream 3: Operator Sweeper And Gap Lifecycle Controls

Purpose: prevent future historical gaps from lingering silently once provider availability improves.

### Scope

- admin API or scripts
- status/ops UI if applicable
- `worker/src/lib/blacklist-gaps.ts`
- docs
- tests

### Core Behavior

Add an operator-controlled sweeper for stale recoverable rows:

- batch-oriented
- filterable by chain, stablecoin, age, status, and attempt count
- disabled by default from public cron flow

Suggested filters:

- `olderThanDays`
- `statusIn`
- `chainId`
- `stablecoin`
- `maxAttempts`
- `limit`

Suggested output:

- scanned row count
- resolved row count
- still-recoverable row count
- error-class breakdown

### Lifecycle Policy

Define and document how recoverable rows age:

- `recoverable_pending`: not yet exhausted, or worth retrying
- `provider_failed`: last attempt failed due to provider/runtime issue
- `ambiguous`: cannot currently assign a trustworthy amount due to identity/provider ambiguity

Do **not** automatically convert old recoverable rows to `permanently_unavailable` just because they are old. That should remain a semantic state, not a timeout state.

### Status Rules

Add operator-facing thresholds such as:

- recoverable gaps older than `30` days => warning
- recoverable gaps older than `90` days => critical

Use exact threshold values only if they align with existing status-dashboard conventions; otherwise document them in the plan and finalize during implementation.

### Acceptance Criteria

- operators can retry stale recoverable rows without touching fresh hourly ingestion
- stale unresolved rows are visible in status tooling
- status no longer treats all gaps as equal

## Workstream 4: Optional EVM Provider-Ladder Hardening

Purpose: improve resilience only after backlog repair and observability are done.

### Decision Gate

This workstream should ship only if one of the following is true after Workstreams 1-3:

- recoverable gaps remain after the targeted remediation
- provider diagnostics show repeated misses concentrated on one chain/provider
- operational confidence in the current ladder is still too low

If the Avalanche backlog clears cleanly and no new recoverable gaps appear, this workstream can be deferred.

### Scope

- `worker/src/cron/blacklist/balance-providers.ts`
- `worker/src/lib/chain-registry.ts`
- env/config wiring
- docs for infrastructure dependencies
- balance-provider tests

### Requirements For Any New Provider

- reliable historical `eth_call`
- support for the exact EVM chains Pharos tracks in blacklist
- bounded timeout behavior
- cheap enough for the blacklist cron retry profile
- compatible with the existing provider ladder and telemetry fields

### Rollout Pattern

- add as a final fallback first
- instrument with `amount_last_provider`
- verify it only changes recoverable-to-resolved outcomes, not resolved-to-failed regressions

### Acceptance Criteria

- new provider can be enabled without changing public API behavior
- diagnostics show when it is actually being used
- budget/timeouts remain within current blacklist cron constraints

## Validation Plan

## Unit And Integration Tests

Add or extend tests for:

- attempt metadata updates on success and failure
- targeted legacy-row selection logic
- deterministic config resolution for legacy Avalanche `USDC`
- successful resolution to `0` being treated as `resolved`
- dry-run mode with no writes
- bounded admin remediation endpoint/script behavior
- sweeper summary output
- status metrics for oldest recoverable gap and repeated-attempt rows

### Required Commands

- `npm test -- --run worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/api/__tests__/blacklist.test.ts`
- `npm run lint`
- `cd worker && npx tsc --noEmit`

If admin endpoint or status/UI files change:

- `npm test`
- `npm run build`

Before any push:

- `npm run test:merge-gate`

## Production Validation

Use a staged rollout:

1. deploy code without running remediation
2. inspect dry-run output for the Avalanche `USDC` cohort
3. run a tiny write-enabled batch, for example `5` rows
4. inspect row-level before/after changes in D1
5. run the full targeted cohort
6. verify:
   - recoverable gaps drop as expected
   - resolved rows include zero balances where appropriate
   - no fresh recent recoverable rows appear unexpectedly

## Rollout Order

1. Land schema + telemetry fields.
2. Land remediation endpoint/script in dry-run form.
3. Land sweeper/status visibility.
4. Deploy.
5. Run dry-run against production.
6. Run a tiny write-enabled pilot batch.
7. Run the full targeted Avalanche `USDC` repair.
8. Re-check production gap metrics.
9. Decide whether Workstream 4 is still warranted.

## Rollback Strategy

### Code Rollback

- standard worker rollback is sufficient because schema additions are backward-compatible
- do not add destructive migrations in this tranche

### Data Rollback

Because this work writes directly to `blacklist_events`, rollback should rely on:

- targeted row snapshots before write-enabled remediation
- explicit logging of affected IDs in each batch
- the ability to re-run a corrective update on the same IDs if needed

For the first production run, record:

- target row IDs
- pre-remediation amount fields
- pre-remediation provenance fields
- post-remediation values

This can be done through dry-run output plus operator logs; a dedicated audit table is optional, not required for tranche one.

## Documentation Updates

Update only the docs touched by real behavior change:

- `docs/blacklist-tracker.md`
- `docs/api-reference.md` if an admin endpoint is added
- `docs/status-dashboard.md` if status surfaces new gap metrics
- `docs/testing.md` if new blacklist validation surfaces are added

Methodology docs do not need a major update unless public-facing blacklist semantics change again. This tranche is primarily operational and data-quality focused.

## Recommended First Implementation Slice

If execution is split into smaller PRs, the first slice should be:

1. migration for attempt metadata
2. worker writes for attempt metadata
3. status query updates
4. tests

The second slice should be:

1. targeted remediation endpoint/script
2. dry-run mode
3. Avalanche `USDC` deterministic targeting
4. tests and docs

The third slice should be:

1. operator sweeper
2. optional provider-ladder enhancement if still justified by post-remediation data

## Done Definition

This plan is complete when all of the following are true:

- the current recoverable Avalanche `USDC` cohort has been remediated or exhaustively diagnosed
- no recoverable rows older than the chosen ops threshold can remain invisible
- operators can dry-run and execute bounded historical gap remediation safely
- zero-balance recoveries are treated as successful attribution, not second-class outcomes
- the system can explain why a row is still unresolved after repeated attempts

## Recommendation

Proceed with Workstreams 1-3 now.

Treat Workstream 4 as conditional. The data does not currently justify rushing a new EVM provider before the backlog repair and telemetry improvements are in place.
