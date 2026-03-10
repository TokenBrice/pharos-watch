# /flows Accuracy & Reliability — Implementation Plan

Date: 2026-03-10

Inputs:
- Audit report: [agents/audits/flows-end-to-end-audit-2026-03-10.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/audits/flows-end-to-end-audit-2026-03-10.md)
- User direction for this plan: exclude bridge / tagging expansion from scope for now

## Goal

Improve the `/flows` feature so the data is:
- more correct
- more honest about scope and freshness
- explicit about coverage confidence
- easier to operate and audit over time

This plan focuses on the findings that remain after excluding the bridge-classification workstream.

## Explicit Exclusions

These are intentionally out of scope for this execution plan:
- new bridge-protocol classifiers
- expanded burn tagging heuristics
- multi-chain mint/burn ingestion beyond Ethereum

## Delivery Principles

- Ship correctness fixes before UI polish or contract reshaping.
- Preserve public API compatibility where possible by adding optional fields first.
- Treat methodology-visible scoring changes as documentation work, not just code work.
- Gate every phase with concrete verification, not just local inspection.

## Success Criteria

By the end of this plan:
- hourly aggregates cannot remain stale after rows are reclassified out of the counted set
- Pressure Shift compares live flow against a clean trailing baseline, not one contaminated by the current partial day
- `/flows` clearly states the feature is Ethereum-only
- `/flows` exposes freshness and coverage confidence instead of implying complete market-wide coverage
- backend fallback-cache and stale-data conditions are visible in the UI
- aggregate API semantics for `hours` are unambiguous and documented
- operators have a reconciliation surface that flags divergence between mint/burn flow and chain-level supply movement

## Recommended Phase Order

| Phase | Name | Purpose | Ship Type |
|------|------|---------|----------|
| A | Correctness Foundation | Fix hard data bugs and scoring semantics | Required first |
| B | Coverage & Confidence Model | Expose coverage truth from cron/API to `/flows` | Required second |
| C | Freshness & Scope Truthfulness | Make stale/fallback/scope state visible to users | Required third |
| D | API Contract Cleanup | Remove ambiguous `hours` behavior and lock the contract | Required before wider reuse |
| E | Reconciliation Auditor | Add operator-grade completeness checks | Major additive improvement |
| F | Operational Hardening | Protect reliability as event volume grows | Final hardening |

## Phase A — Correctness Foundation

### Objectives

- eliminate stale hourly rows after reclassification
- make largest-event selection deterministic
- fix baseline math so the current partial day does not pollute the trailing comparison window

### Tasks

1. Add regression coverage before touching production logic.
   - Add a test where an affected hour previously had one counted row and ends with zero counted rows after reclassification.
   - Add a test where a large move on the current UTC day does not affect the baseline denominator/window for that same day.
   - Add a deterministic largest-event test for ties on amount with secondary ordering on time and final row identity.

2. Fix `recalcAffectedHours()` to handle empty post-recompute buckets.
   - Current issue: `INSERT OR REPLACE ... SELECT` does nothing when the hour now has zero counted rows, leaving the old row behind.
   - Implementation direction: delete each affected bucket first, then insert the recomputed replacement if one exists.

3. Rewrite largest-event selection in `/api/mint-burn-flows`.
   - Replace the current grouped `SELECT e.*` pattern with a deterministic CTE/window-function query.
   - Recommended tie-break order:
     - `COALESCE(amount_usd, amount)` desc
     - `timestamp` desc
     - `block_number` desc
     - `id` desc

4. Fix Pressure Shift baseline construction.
   - Exclude the current UTC day from the baseline window.
   - Compare live rolling 24h flow against the last 30 fully closed daily buckets.
   - Keep `MIN_DATA_DAYS` and `MIN_ACTIVITY_USD` gates unless evidence says otherwise.

5. Update methodology/docs for the baseline change.
   - This is a scoring semantics change and must update product methodology copy.

### Likely Files

- `worker/src/lib/mint-burn-pipeline/persistence.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`
- `docs/mint-burn-flows.md`
- `docs/api-reference.md`
- `docs/methodology-page.md`
- `src/app/methodology/page.tsx`
- `shared/lib/mint-burn-flow-version.ts`

### Acceptance Criteria

- zero-count recompute test fails on old logic and passes on new logic
- largest-event query returns the same event deterministically across tie cases
- baseline tests prove the current partial day is excluded
- `/methodology` copy matches the new baseline definition

### Verification Gate

- `npm test -- worker/src/lib/__tests__/mint-burn-pipeline.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts`
- `npm run build`

## Phase B — Coverage & Confidence Model

### Objectives

- make the API say how complete the data is
- let `/flows` distinguish “inactive” from “partially covered” or “still backfilling”

### Design Direction

Add optional coverage fields first so existing consumers do not break.

### Proposed Response Additions

Top-level aggregate response:
- `scope`: `{ chainIds: ["ethereum"], label: "Ethereum-only" }`
- `sync`: `{ lastSuccessfulSyncAt, freshnessStatus, warning, criticalLaneHealthy }`

Per-coin response additions:
- `coverage`: {
  `startBlock`,
  `lastSyncedBlock`,
  `lagBlocks`,
  `historyStartAt`,
  `has24hWindow`,
  `has30dWindow`,
  `has90dWindow`,
  `isPartial`,
  `status`
  }

Recommended `status` enum:
- `full`
- `partial-history`
- `lagging`
- `bootstrapping`
- `disabled`

### Tasks

1. Define the coverage model in `shared/types`.
   - Add optional top-level and per-coin coverage fields.
   - Keep compatibility with current consumers.

2. Derive coverage data in the worker.
   - Source inputs:
     - `MINT_BURN_CONFIGS.startBlock`
     - `mint_burn_sync_state.last_block`
     - latest successful critical-lane cron metadata
     - latest cron freshness state already used by status/health
   - Avoid live RPC work in the API handler.

3. Decide per-coin aggregation rules for multi-config coins.
   - For coins with multiple Ethereum configs, the coin-level coverage should use the minimum safe frontier and the earliest configured start block.

4. Surface the model on `/flows`.
   - Add an Ethereum-only scope badge near the page title.
   - Add row-level badges or muted status text in the table.
   - Add a short explanation under the overview panel for what “partial history” means.

5. Prevent false confidence in long-window metrics.
   - If `has90dWindow` is false, visually annotate or de-emphasize `Net 90d`.
   - Do the same for 30d where appropriate.

### Likely Files

- `worker/src/api/mint-burn-flows.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `shared/types/index.ts`
- `src/hooks/use-mint-burn-flows.ts`
- `src/app/flows/page.tsx`
- `src/components/flow-table.tsx`
- `src/components/flow-brrr-overview.tsx`
- `docs/mint-burn-flows.md`
- `docs/api-reference.md`

### Acceptance Criteria

- aggregate response exposes scope/sync metadata
- every coin row can distinguish coverage state from plain inactivity
- 30d/90d table values are visually qualified when the history window is incomplete

### Verification Gate

- `npm test -- worker/src/api/__tests__/mint-burn-flows.test.ts`
- add/extend component tests for row badges and status rendering
- `npm run build`

## Phase C — Freshness & Scope Truthfulness

### Objectives

- stop using client fetch time as a proxy for data freshness
- make fallback cache and stale backend state visible
- correct user-facing product claims about scope

### Tasks

1. Add a meta-aware query path for mint/burn hooks.
   - Either extend `useApiQuery` to support meta or add `useApiQueryWithMeta`.
   - `useMintBurnFlows` and `useMintBurnEvents` should expose `meta` alongside `data`.

2. Feed backend freshness into `StaleDataBanner`.
   - Use `X-Data-Age` and `Warning` headers from the worker response.
   - Prefer backend freshness when available over client `dataUpdatedAt`.

3. Surface fallback-cache state in `/flows`.
   - If the worker serves cached fallback due to backend failure, show that explicitly.
   - Distinguish:
     - stale but available
     - fallback cache served
     - live query failure with no data

4. Correct scope language in user-facing copy.
   - `/flows` page header/description
   - `/flows` FAQ structured data
   - `/about` data-source and feature copy
   - any local feature cards or shared copy that claim broader coverage than Ethereum-only support

5. Update last-modified markers for touched static pages.

### Likely Files

- `src/lib/api.ts`
- `src/hooks/use-api-query.ts`
- `src/hooks/use-mint-burn-flows.ts`
- `src/components/stale-data-banner.tsx`
- `src/app/flows/page.tsx`
- `src/app/flows/layout.tsx`
- `src/app/about/page.tsx`
- `src/app/sitemap.ts`
- `docs/mint-burn-flows.md`

### Acceptance Criteria

- `/flows` can show backend stale/fallback state even when the browser fetch just succeeded
- page copy explicitly says Ethereum-only
- About page no longer claims Etherscan powers mint/burn flows

### Verification Gate

- targeted hook/component tests for meta propagation
- `npm run build`

## Phase D — API Contract Cleanup

### Objectives

- remove the ambiguity where aggregate `hours` changes coin aggregates that are still named `24h`

### Recommended Contract Strategy

Do not rename existing fields immediately.

Instead:
- make aggregate coin fields truly fixed 24h values
- keep `hours` affecting only the `hourly` series
- add a top-level `windowHours` field so consumers know what the chart window is
- document the behavior explicitly

This is the safest path because current internal consumers mostly use non-24h aggregate queries only for `hourly`.

### Tasks

1. Update aggregate handler behavior.
   - coin summaries should always compute from a 24h window
   - hourly series should continue to respect `hours`
   - 7d/30d/90d trailing fields remain separate explicit aggregates

2. Add tests that lock the contract.
   - `?hours=168` must not mutate `netFlow24hUsd`, `mintVolume24hUsd`, `burnVolume24hUsd`, counts, or pressure state
   - `?hours=168` must still change `hourly`

3. Audit downstream consumers.
   - `/flows`
   - homepage flow snapshot
   - compare page
   - stablecoin detail flows section

4. Update docs and response schemas.

### Likely Files

- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- `shared/types/index.ts`
- `src/hooks/use-mint-burn-flows.ts`
- `docs/api-reference.md`
- `docs/mint-burn-flows.md`

### Acceptance Criteria

- aggregate coin-level “24h” fields are always 24h
- `hours` only affects the hourly series
- docs and tests agree on that contract

### Verification Gate

- `npm test -- worker/src/api/__tests__/mint-burn-flows.test.ts`
- `npm run build`

## Phase E — Reconciliation Auditor

### Objectives

- give operators a direct completeness check instead of inferring coverage from symptoms
- flag coins whose Ethereum mint/burn flow meaningfully diverges from Ethereum supply movement

### Important Constraint

Global `supply_history` is not a valid reconciliation source for this feature because mint/burn flows are Ethereum-only.

This phase therefore needs a chain-specific supply delta source.

### Recommended Approach

Use a chain-specific Ethereum supply snapshot source, not global market-cap history.

Preferred order:
1. revive or extend `onchain_supply` if it can be sourced reliably from DefiLlama chain distribution
2. if `onchain_supply` cannot be trusted yet, create a dedicated Ethereum supply snapshot table fed from the same source family

### Proposed Storage

New table:
- `mint_burn_reconciliation_daily`

Suggested fields:
- `stablecoin_id`
- `snapshot_date`
- `chain_id`
- `mint_burn_net_usd`
- `supply_delta_usd`
- `absolute_diff_usd`
- `pct_diff`
- `coverage_status`
- `reconciliation_status`
- `notes_json`

Suggested statuses:
- `ok`
- `warn`
- `critical`
- `insufficient_source`
- `partial_coverage`

### Tasks

1. Run a short discovery/design task for the chain-level supply source.
   - validate whether existing upstream data can produce stable Ethereum-only daily deltas
   - define acceptable tolerance bands

2. Add the reconciliation table + migration.

3. Add a daily reconciliation cron.
   - schedule after chain-level supply data is available
   - compute prior-day Ethereum supply delta
   - compare to summed prior-day `mint_burn_hourly.net_flow_usd`

4. Exclude non-actionable comparisons.
   - coins still bootstrapping
   - partial-coverage days
   - missing chain supply source

5. Surface results to operators first.
   - `/api/status`
   - status page card
   - do not put it on the public `/flows` page until the signal proves useful

6. Add documentation and tests.

### Likely Files

- new migration under `worker/migrations/`
- `worker/src/cron/`
- `worker/src/api/status.ts`
- `src/components/status/`
- `docs/mint-burn-flows.md`
- `docs/status-dashboard.md`
- `docs/data-flow-map.md`

### Acceptance Criteria

- operators can see which coins diverge, by how much, and whether the divergence is actionable
- reconciliation status does not produce false alarms for partial-coverage days

### Verification Gate

- migration test / local D1 apply check
- targeted cron/status tests
- `npm run build`
- `cd worker && npx tsc --noEmit`

## Phase F — Operational Hardening

### Objectives

- reduce long-term reliability risk from growing event volume
- make fallback behavior safer

### Tasks

1. Run a query-plan audit for hot mint/burn paths.
   - `price-heal` null-price query
   - largest-event query after Phase A rewrite
   - new coverage queries
   - new reconciliation queries

2. Add only the indexes the query-plan audit justifies.
   - likely candidate: partial or composite index for `amount_usd IS NULL` price-heal lookups
   - verify existing indexes before adding more

3. Make flow cache writes monotonic-safe.
   - replace `setCache()` with `setCacheIfNewer()` for aggregate/per-coin flow cache writes
   - prevents an older slow request from overwriting a newer response

4. Improve null-price observability.
   - add backlog counts to cron metadata, not just healed counts
   - distinguish “recent healable” from “older historical nulls”

5. Re-run targeted status and cron health checks.

### Likely Files

- `worker/src/lib/db.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/lib/mint-burn-pipeline/price-heal.ts`
- new migration(s) under `worker/migrations/`
- `docs/mint-burn-flows.md`
- `docs/worker-infrastructure.md`

### Acceptance Criteria

- no cache regression where stale responses can overwrite fresher ones
- query plans stay index-backed for recurring maintenance paths
- cron metadata exposes null-price backlog clearly enough for operators

### Verification Gate

- targeted unit tests for cache-write ordering where practical
- `npm run build`
- `cd worker && npx tsc --noEmit`

## Recommended PR Strategy

Ship this as 5-6 PRs, not one large branch.

Recommended sequence:
1. Phase A only
2. Phase B only
3. Phase C only
4. Phase D only
5. Phase E only
6. Phase F only

Reason:
- Phase A changes the data truth
- Phases B/C change how that truth is communicated
- Phase D changes the formal contract
- Phase E adds a new operator workflow
- Phase F is easier to size once the new queries exist

## Cross-Phase Verification Standard

Minimum gate after every shipped phase:

```bash
npm run build
npm test -- worker/src/api/__tests__/mint-burn-flows.test.ts worker/src/api/__tests__/mint-burn-events.test.ts worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/lib/__tests__/mint-burn-pipeline.test.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts worker/src/lib/__tests__/mint-burn-roundtrip.test.ts
cd worker && npx tsc --noEmit
```

When UI copy, methodology, or API contracts change:
- update `docs/mint-burn-flows.md`
- update `docs/api-reference.md`
- update `docs/methodology-page.md` and `/methodology` content if scoring semantics changed

## Open Questions To Resolve During Execution

1. Reconciliation source:
   - can Ethereum-only daily supply deltas be derived reliably from existing upstream data, or do we need a dedicated snapshot table?

2. Coverage status shape:
   - do we want one normalized `coverage.status` enum or several booleans plus explanatory text?

3. Public API compatibility:
   - should the `windowHours` addition be enough, or do we also want to introduce an explicit `coinsWindowHours: 24` field for clarity?

## Bottom Line

The highest-value execution order is:
- fix correctness bugs
- expose coverage truth
- expose freshness truth
- lock the API contract
- add reconciliation for operator confidence
- harden the operational edges

That sequence improves the feature quickly without mixing root-cause fixes with presentation work.
