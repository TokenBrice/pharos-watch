# Flow Feature Reliability Fix Plan

Date: March 9, 2026  
Source audit: Ethereum-only flows feature audit (mint/burn ingestion, event API, detail-page feed)  
Primary routes: `/flows/`, `/stablecoin/[id]#flows`  
Primary endpoints: `GET /api/mint-burn-flows`, `GET /api/mint-burn-events`, `POST /api/backfill-mint-burn`, `POST /api/reclassify-atomic-roundtrips`

## Purpose

This document converts the current flows audit findings into an execution-ready implementation plan.

The goal is to make the Ethereum-only flows feature more correct, more explainable, and less likely to present misleading data, without expanding scope into a multi-chain redesign or a new scoring model.

This plan is intentionally limited to the residual issues still present after the earlier flow data-quality work. It does not revisit already-landed items such as atomic roundtrip detection itself, bridge-burn classification, or the activity gate, except where those existing mechanisms need to be surfaced or made operationally safer.

## Scope

In scope:

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/lib/alchemy-logs.ts`
- `worker/src/api/mint-burn-events.ts`
- `worker/src/api/backfill-mint-burn.ts`
- `worker/src/api/reclassify-atomic-roundtrips.ts`
- `worker/src/lib/mint-burn-pipeline/*`
- `src/hooks/use-mint-burn-flows.ts`
- `src/components/flow-event-feed.tsx`
- `src/components/stablecoin-detail/flows-section.tsx`
- `shared/types/index.ts`
- `shared/lib/format.ts`
- flow docs, API docs, methodology/changelog copy, and the mint/burn ingestion runbook

Out of scope:

- adding non-Ethereum chain support
- changing the Flow Intensity / Pressure Shift formula
- changing Bank Run Gauge or Flight-to-Quality formulas
- redesigning the `/flows` page or stablecoin detail layout
- adding new upstream data sources

## Non-Negotiables

- Ethereum-only scope remains explicit and enforced.
- Counted economic flow semantics do not change:
  - counted mint = `direction='mint' AND flow_type='standard'`
  - counted burn = `direction='burn' AND burn_type='effective_burn' AND flow_type='standard'`
- Prefer deterministic recomputation and targeted backfill over patching aggregates manually.
- Preserve backward compatibility for public API consumers where practical.
- If public methodology or ingestion semantics change, update:
  - `docs/mint-burn-flows.md`
  - `docs/api-reference.md`
  - `docs/architecture.md`
  - `agents/runbooks/mint-burn-ingestion.md`
  - `src/app/methodology/page.tsx`
  - `src/app/methodology/mint-burn-flow-changelog/page.tsx`
  - `shared/lib/mint-burn-flow-version.ts`
- No new data source is introduced, so `/about` does not need a source update.

## Verification Standard

Every implementation phase must finish with:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Minimum targeted suites during development:

```bash
npm test -- \
  worker/src/cron/__tests__/sync-mint-burn.test.ts \
  worker/src/api/__tests__/mint-burn-events.test.ts \
  worker/src/api/__tests__/mint-burn-flows.test.ts \
  worker/src/lib/__tests__/mint-burn-pipeline.test.ts \
  worker/src/lib/__tests__/mint-burn-roundtrip.test.ts \
  src/lib/__tests__/format.test.ts
```

Manual QA matrix before closing the work:

- `USDT` detail page: counted event feed excludes non-economic noise by default.
- `USDC` or `ZCHF`: bridge burns remain inspectable through the API but are not shown as counted flow history.
- `PAXG` or `XAUT`: unpriced rows never render with a dollar sign.
- `USDT` backfill/reconciliation run: no skipped coverage frontier after partial event-def failures.

## Findings To Fix

| ID | Severity | Problem | Root cause |
|---|---|---|---|
| F1 | High | Cron can skip logs after partial multi-event coverage | sync state advances to `maxBlockSeen` when any event definition succeeds, even if sibling event definitions failed or timestamps were missing |
| F2 | Medium | Detail-page flow history can present excluded noise as real economic flow | event API does not expose `flow_type`, and the UI renders all rows as plain mint/burn history |
| F3 | Medium | Unpriced events are displayed as USD values | UI falls back from `amountUsd` to raw `amount` but still formats with `$` |
| F4 | Low | `minAmount` semantics drift from documentation | API falls back from `amount_usd` to token-native `amount` even though docs describe a USD filter |

## Implementation Strategy

Implement in four workstreams, in this order:

1. Ingestion safety and historical repair
2. Event API contract hardening
3. Detail-page feed and valuation display alignment
4. Docs, methodology versioning, and post-deploy verification

This order fixes the only permanent data-loss risk first, then aligns the public surface with the already-existing economic-flow methodology.

## Workstream 1: Ingestion Safety And Historical Repair

### 1.1 Prevent sync-state advancement beyond uncovered event definitions

Fixes: `F1`

Current problem:

- `syncMintBurn()` records per-event-definition success/failure, but advancement uses `summary.maxBlockSeen` whenever at least one event definition completed successfully.
- For multi-event configs, this can skip uncovered logs in the same scanned range.
- Missing block timestamps create the same class of skip risk: rows are dropped, but advancement is still allowed beyond the affected blocks.

Implementation:

1. In `worker/src/cron/sync-mint-burn.ts`, track fetch coverage per event definition:
   - event label
   - `complete`
   - `scannedToBlock`
   - fetched log count
2. Use the existing `fetched.scannedToBlock` from `worker/src/lib/alchemy-logs.ts` instead of ignoring it.
3. Compute a safe advancement frontier for the config:
   - `eventCoverageFrontier = min(scannedToBlock across all event defs)`
   - `timestampCoverageFrontier = min(missingBlockNumbers) - 1` when any timestamps are missing
   - `safeFrontier = min(eventCoverageFrontier, timestampCoverageFrontier when present)`
4. Change advancement rules:
   - full coverage, no timestamp gaps, and rows found:
     - advance to `maxBlockSeen`
   - full coverage, no timestamp gaps, and no rows found:
     - advance to `min(scanTo, chainHead - safetyMarginBlocks)`
   - partial event-def coverage or timestamp gaps:
     - advance only to `safeFrontier`
   - if `safeFrontier < fromBlock`:
     - do not advance
5. Add explicit advancement reasoning to metadata:
   - `advanceReason`: `full-success-events`, `full-success-empty`, `partial-frontier`, `no-safe-frontier`
   - `coverageFrontier`
   - per-event `scannedToBlock`
   - missing timestamp block count and earliest missing block
6. Keep current `INSERT OR IGNORE` behavior. Duplicate rescans are acceptable; skipped coverage is not.

Primary files:

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/lib/alchemy-logs.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`

Acceptance criteria:

- A config never advances beyond a block range that all event definitions have not safely covered.
- Missing timestamps cap advancement rather than silently dropping rows forever.
- Full-success single-event configs continue to make forward progress exactly as before.
- Cron metadata exposes enough information to explain why a config did or did not advance.

Tests:

- Add a regression where one USDT event definition fails, another succeeds with logs near `scanTo`, and advancement stops at the safe frontier instead of `maxBlockSeen`.
- Add a regression where `resolveBlockTimestamps()` misses one block and advancement stops before the missing block.
- Keep the current exact-range and degraded-status tests passing.

### 1.2 Historical reconciliation for already-skipped coverage

Fixes: `F1`

Current problem:

- Even after the forward fix lands, any historical gaps created by the previous advancement behavior will remain in D1.
- The most likely affected target is any config with `events.length > 1`. Today that is the Ethereum USDT config.

Implementation:

1. After deploying the sync-frontier fix, enumerate all configs where `config.events.length > 1`.
2. For each of those configs, run a full backfill from `config.startBlock` to head via `POST /api/backfill-mint-burn`.
3. Use chunked execution with the existing endpoint until `done: true`.
4. After backfill completes, run `POST /api/reclassify-atomic-roundtrips` to normalize any same-tx pairs where one side already existed in D1 and the complementary side was inserted by backfill.
5. Re-check:
   - recent hourly aggregates
   - USDT 24h / 7d / 30d net flows
   - event totals for the repaired config
6. Record the run in `agents/runbooks/mint-burn-ingestion.md`.

Operational note:

- `backfill-mint-burn` is already idempotent because inserts are `INSERT OR IGNORE`.
- The reclassify endpoint is still required after backfill because ignored pre-existing rows do not get their `flow_type` updated by the insert path.

Primary files:

- `agents/runbooks/mint-burn-ingestion.md`
- `worker/src/api/backfill-mint-burn.ts`
- `worker/src/api/reclassify-atomic-roundtrips.ts`

Acceptance criteria:

- Every multi-event config has been re-ingested across its full tracked range.
- Post-backfill aggregates are consistent with the repaired event set.
- The runbook documents the recovery process for future ingestion-policy changes.

## Workstream 2: Event API Contract Hardening

### 2.1 Expose `flowType` and add a counted-view scope

Fixes: `F2`

Current problem:

- `GET /api/mint-burn-events` returns rows without `flow_type`, so callers cannot distinguish counted economic flow from excluded noise.
- The detail-page feed consumes this endpoint as if it were already a counted economic-flow stream.

Implementation:

1. Extend the API response model to include `flowType`.
2. Add a response schema:
   - `MintBurnEventSchema`
   - `MintBurnEventsResponseSchema`
3. Update `useMintBurnEvents()` to validate the response with the schema.
4. Add a new optional query param on `GET /api/mint-burn-events`:
   - `scope=all|counted`
   - default: `all` for backward compatibility
5. Define `scope=counted` as:
   - `flow_type = 'standard'`
   - `direction = 'mint' OR burn_type = 'effective_burn'`
6. Keep `scope=all` as the full classified event stream.
7. Update the hook query key to include every request-shaping parameter:
   - `stablecoinId`
   - `direction`
   - `burnType`
   - `limit`
   - `offset`
   - `scope`
8. Preserve Ethereum-only chain validation.

Primary files:

- `worker/src/api/mint-burn-events.ts`
- `shared/types/index.ts`
- `src/hooks/use-mint-burn-flows.ts`
- `worker/src/api/__tests__/mint-burn-events.test.ts`

Acceptance criteria:

- API callers can distinguish `standard` rows from `atomic_roundtrip` rows.
- `scope=counted` returns only rows that participate in economic flow metrics.
- Default `scope=all` preserves backward compatibility for existing external consumers.
- Hook cache keys no longer collide across different event-feed scopes or filters.

Tests:

- Add a handler test that returns both `standard` and `atomic_roundtrip` rows and verifies:
  - default `scope=all` returns both
  - `scope=counted` returns only counted rows
- Add a test that confirms `flowType` is present and camel-cased.
- Add a test that query-key-sensitive filters do not share cached responses incorrectly if hook tests already exist; otherwise verify via hook call-site construction and schema-backed usage.

### 2.2 Make `minAmount` truly USD-only

Fixes: `F4`

Current problem:

- The docs define `minAmount` as a USD threshold.
- The implementation uses `COALESCE(amount_usd, amount)`, which silently switches to token units for unpriced rows.

Implementation:

1. Change the filter condition to:
   - `amount_usd IS NOT NULL AND amount_usd >= ?`
2. Do not reinterpret token-native amounts as dollars.
3. Keep the current public param name and docs as USD-only.
4. If raw token-unit filtering is ever needed, add a separate `minTokenAmount` in a future change rather than overloading `minAmount`.

Primary files:

- `worker/src/api/mint-burn-events.ts`
- `worker/src/api/__tests__/mint-burn-events.test.ts`
- `docs/api-reference.md`
- `docs/mint-burn-flows.md`

Acceptance criteria:

- `minAmount` never compares against native token units.
- Unpriced rows are excluded when a USD threshold is requested.
- Documentation and runtime behavior match exactly.

Tests:

- Add a test with:
  - one row where `amount_usd` is null and `amount` is large
  - one row where `amount_usd` is present and above threshold
  - `minAmount` must return only the priced row

## Workstream 3: Detail-Page Feed And Valuation Display Alignment

### 3.1 Make the detail-page feed use counted flow rows by default

Fixes: `F2`

Current problem:

- The stablecoin detail page labels the table as "Mint & Burn Flow History" but currently requests the full event stream.
- That makes bridge burns, review-required burns, and atomic roundtrips look like the same class of economic signal as counted mints/effective burns.

Implementation:

1. Update `FlowEventFeed` call sites used for product flow history to request `scope=counted`.
2. Keep the title focused on counted flow history.
3. Add a short explanatory line under the heading:
   - example: "Excludes bridge burns, review-required burns, and atomic roundtrips."
4. Do not add a UI redesign or complex filtering panel in this pass.
5. Leave `scope=all` available through the API for ops/debug consumers.

Primary files:

- `src/components/flow-event-feed.tsx`
- `src/components/stablecoin-detail/flows-section.tsx`

Acceptance criteria:

- The detail-page feed matches the same counted-row semantics as the summary card and hourly aggregates.
- A user can no longer infer economic redemption pressure from bridge burns or atomic roundtrips shown as ordinary flow rows.

Manual QA:

- Compare a stablecoin with bridge-classified burns before and after the change.
- Verify the counted feed total drops only by excluded rows, not by real mints/effective burns.

### 3.2 Render unpriced rows as token amounts, never as fake dollars

Fixes: `F3`

Current problem:

- `FlowEventFeed` falls back from `amountUsd` to raw `amount`, but still formats that fallback with `formatCurrency()`.
- This can display native token amounts as false dollar amounts.

Implementation:

1. Add a dedicated token-amount formatter in `shared/lib/format.ts`.
2. Formatter requirements:
   - no currency prefix
   - preserve useful precision for sub-1 amounts
   - abbreviate large values
   - return `"N/A"` for non-finite input
3. In `FlowEventFeed`:
   - if `amountUsd != null`, render USD normally
   - if `amountUsd == null`, render native amount plus symbol
   - add a small `Unpriced` badge or muted annotation
4. Do not display a dollar sign anywhere on the native fallback path.

Suggested formatter behavior:

- `>= 1_000`: abbreviated with 2 decimals, no prefix
- `1` to `< 1_000`: 2 decimals, trim trailing zeros
- `< 1`: up to 4 decimals, trim trailing zeros

Primary files:

- `shared/lib/format.ts`
- `src/lib/__tests__/format.test.ts`
- `src/components/flow-event-feed.tsx`

Acceptance criteria:

- Unpriced rows never render with `$`.
- Small native amounts do not round to zero unintentionally.
- The row clearly communicates that valuation is unavailable.

Tests:

- Add formatter unit tests for:
  - large token amounts
  - sub-1 token amounts
  - zero / NaN / Infinity
- Add a feed rendering test if component-test coverage exists; otherwise verify through targeted manual QA and build output.

## Workstream 4: Docs, Methodology Versioning, And Rollout

### 4.1 Update flow docs and API reference

Fixes: `F1`, `F2`, `F3`, `F4`

Update:

- `docs/mint-burn-flows.md`
  - sync advancement logic now uses safe coverage frontiers
  - historical reconciliation/backfill notes
  - `GET /api/mint-burn-events` gains `scope`
  - response includes `flowType`
  - `minAmount` is USD-only
  - detail-page counted-feed semantics
- `docs/api-reference.md`
  - new query param and response field
  - clarified counted vs all-event semantics
- `docs/architecture.md`
  - endpoint contract and response-shape changes
- `agents/runbooks/mint-burn-ingestion.md`
  - post-deploy repair steps for multi-event configs

### 4.2 Bump the public mint/burn methodology version

Recommended version bump: `v4.5` -> `v4.6`

Rationale:

- The scoring formula is unchanged.
- However, ingestion advancement policy and the default product interpretation of event history become more correct and more explicit.
- The methodology page already states that version increments when ingestion attribution policies or tracked event semantics change.

Update:

- `shared/lib/mint-burn-flow-version.ts`
- `src/app/methodology/mint-burn-flow-changelog/page.tsx`
- `src/app/methodology/page.tsx`

Changelog focus:

- safe-frontier sync advancement replaces max-seen advancement under partial coverage
- event feed now defaults to counted economic-flow rows on product surfaces
- unpriced event display corrected to native amounts
- `minAmount` semantics aligned to USD-only filtering

Acceptance criteria:

- Public docs and product copy match runtime behavior.
- Methodology/version text explains behavior changes without overstating a formula change.

## Rollout Order

1. Land `F1` sync-frontier safety and tests.
2. Deploy the worker.
3. Run targeted historical backfill for every multi-event config.
4. Run atomic-roundtrip reclassification after backfill completes.
5. Land event API contract changes (`flowType`, `scope`, USD-only `minAmount`) plus schema updates.
6. Land detail-page feed changes and native-amount formatting.
7. Update docs, methodology version, and changelog copy.
8. Run full verification.

## Risks And Mitigations

### Risk: API behavior change breaks external consumers

Mitigation:

- Keep `scope=all` as the default.
- Make counted semantics opt-in for the product feed.
- Add `flowType` as an additive field.

### Risk: historical backfill is slow or operationally noisy

Mitigation:

- Restrict the mandatory repair run to configs with `events.length > 1`.
- Execute through existing chunked admin backfill flow.
- Record chunk settings and outcomes in the runbook.

### Risk: counted feed hides operationally interesting rows

Mitigation:

- Counted scope is only the default for user-facing flow history.
- `scope=all` remains available for operators and future debug surfaces.

### Risk: native fallback formatting loses too much precision

Mitigation:

- Add a dedicated token formatter rather than reusing `formatSupply()`.
- Cover sub-1 and large-value cases with tests.

## Final Acceptance Checklist

- [ ] No config can advance beyond uncovered event-def or timestamp frontiers.
- [ ] Historical multi-event configs have been backfilled and reclassified.
- [ ] `GET /api/mint-burn-events` exposes `flowType`.
- [ ] Product flow-history surfaces use counted semantics by default.
- [ ] `minAmount` is USD-only in both code and docs.
- [ ] Unpriced rows render native amounts without `$`.
- [ ] Docs, changelog, and methodology version are updated.
- [ ] `npm run build`, `npm run lint`, `npm test`, and `cd worker && npx tsc --noEmit` all pass.
