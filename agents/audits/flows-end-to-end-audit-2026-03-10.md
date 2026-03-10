# /flows End-to-End Audit

Date: 2026-03-10

Scope:
- `/flows` page UX and product claims
- flow API contracts and frontend hooks
- `sync-mint-burn` critical and extended cron lanes
- mint/burn parsing, bridge classification, hourly aggregation, freshness, and recovery paths

Verification performed:
- `npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts worker/src/lib/__tests__/mint-burn-pipeline.test.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts worker/src/lib/__tests__/mint-burn-roundtrip.test.ts worker/src/api/__tests__/mint-burn-events.test.ts`
- `npm run build`

## Executive Summary

The feature architecture is fundamentally solid: the cron path is isolated, the ingest/backfill pipeline is shared, the critical-vs-extended lane split is professionally designed, and the focused test coverage is better than average for a feature of this complexity.

The main problem is not lack of engineering effort. It is that the current product surface overstates how complete and how fresh the data is. The backend is Ethereum-only, bridge-aware only for a narrow CCIP subset, and not coverage-aware in the API or UI. That means the page can show clean-looking numbers that are materially incomplete, and in one case the hourly table can remain wrong after rows are reclassified out of the counted set.

### The Three Best Additions To Make Next

1. **Add a coverage/confidence layer and surface it everywhere**
   - Expose per-coin `lastSyncedBlock`, `coverageFrontier`, `historyStartBlock`, `historyCoverageDays`, `isPartial`, `isDisabled`, and `lastSuccessfulSyncAt` in `/api/mint-burn-flows`.
   - Surface that on `/flows` as badges/tooltips so users can tell the difference between zero activity and incomplete coverage.
   - This is the single highest leverage product improvement because it fixes the current “looks precise even when partial” problem.

2. **Build a reconciliation auditor against supply deltas**
   - Compare on-chain mint/burn net flow against daily supply deltas from your existing supply pipeline.
   - Flag per-coin gaps such as missing custom event definitions, bridge burns counted as redemptions, or stale backlog windows.
   - This gives you an objective completeness signal instead of relying on manual spot checks.

3. **Expand the protocol-specific classification registry beyond CCIP**
   - Add support for issuer and bridge flows that can look like burns but are not economic redemptions, starting with Circle CCTP-style burns and any issuer-specific treasury contracts for major names.
   - Pair this with a small review queue for `review_required`, `atomic_roundtrip`, and `unpriced` events so the pipeline improves continuously.
   - This is the most accretive accuracy improvement after coverage visibility.

## Findings Ranked By Impact

### 1. Empty-hour recomputation can leave stale hourly rows behind

Severity: Critical

Evidence:
- [worker/src/lib/mint-burn-pipeline/persistence.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/persistence.ts#L81)
- [worker/src/lib/mint-burn-pipeline/persistence.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/persistence.ts#L87)
- [worker/src/lib/mint-burn-pipeline/persistence.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/persistence.ts#L103)

Why it matters:
- `recalcAffectedHours()` only does `INSERT OR REPLACE ... SELECT ... GROUP BY`.
- If an affected hour ends up with zero counted rows after burn reclassification or atomic-roundtrip exclusion, the `SELECT` returns no row and the old `mint_burn_hourly` row survives.
- That means net flow, mint count, and burn count can stay wrong even after the raw events were corrected.

Recommendation:
- Delete each affected `(stablecoin_id, chain_id, hour_ts)` bucket before recomputing it, or switch to a two-step delete+insert strategy inside the helper.
- Add a regression test where an hour goes from one counted event to zero counted events.

### 2. Pressure Shift baseline is not actually a clean rolling 30-day comparator

Severity: High

Evidence:
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L147)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L179)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L188)
- [worker/src/lib/mint-burn-scoring.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-scoring.ts#L13)

Why it matters:
- The scorer compares a rolling 24h `currentDailyNet` against a baseline built from calendar-day buckets.
- The baseline includes the current partial calendar day, so the ongoing move leaks into the comparison set and mutes the very stress signal the score is meant to detect.
- “30-day rolling baseline” in product language is therefore overstated.

Recommendation:
- Exclude the current day from the baseline window and compare rolling 24h vs trailing fully closed days, or move both numerator and baseline to the same rolling-hour semantics.
- Add tests around a large same-day shock to prove the baseline does not self-dampen it.

### 3. Bridge-burn classification is too narrow and will miscount non-CCIP burns as redemptions

Severity: High

Evidence:
- [worker/src/lib/mint-burn-contracts.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L11)
- [worker/src/lib/mint-burn-contracts.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L93)
- [worker/src/lib/mint-burn-contracts.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L183)
- [worker/src/lib/mint-burn-bridge-classifier.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-bridge-classifier.ts#L35)

Why it matters:
- The bridge classifier only supports `protocol: "ccip"`.
- USDC is configured with a CCIP pool, but I found no support for CCTP-style burns or other issuer/canonical bridge mechanisms.
- On an Ethereum-only tracker, misclassifying bridge burns as economic burns is one of the fastest ways to create fake bank-run signals.

Recommendation:
- Add protocol adapters for CCTP and other major stablecoin-specific bridge paths before expanding interpretation of stress signals.
- Expose excluded bridge volume separately so operators can see how much gross flow was filtered out.

### 4. The page currently implies market-wide stablecoin flows, but the implementation is Ethereum-only

Severity: High

Evidence:
- [docs/mint-burn-flows.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/mint-burn-flows.md#L3)
- [src/app/flows/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/flows/page.tsx#L85)
- [src/app/flows/layout.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/flows/layout.tsx#L6)
- [src/app/about/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/about/page.tsx#L12)
- [src/app/about/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/about/page.tsx#L287)

Why it matters:
- The internal docs are explicit that this tracker is Ethereum-only.
- The user-facing page, metadata, and about copy do not say that. They read like full stablecoin issuance/redemption coverage.
- For names like USDT and USDC, that is materially misleading.

Recommendation:
- Add an explicit “Ethereum-only flow tracker” disclosure in the page header, metadata, FAQ copy, and about page.
- If you keep the Bank Run Gauge at market level, label it “Ethereum mint/burn pressure gauge” until multi-chain coverage exists.

### 5. The API and UI do not expose coverage state, so partial history is presented as if it were complete history

Severity: High

Evidence:
- [worker/src/lib/mint-burn-contracts.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L161)
- [worker/src/lib/mint-burn-contracts.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L165)
- [worker/src/cron/sync-mint-burn.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-mint-burn.ts#L65)
- [worker/src/cron/sync-mint-burn.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-mint-burn.ts#L673)
- [worker/src/cron/sync-mint-burn.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-mint-burn.ts#L733)
- [shared/types/index.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/index.ts#L1396)
- [src/app/flows/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/flows/page.tsx#L127)

Why it matters:
- Most configs were initialized with `startBlock: 21_900_000`; in my local audit count, 73 of 84 configs use that default.
- The cron already knows whether a config only advanced to a partial coverage frontier, but the API throws that information away.
- Users therefore see `netFlow90dUsd`, “inactive”, and chart gaps without any indication of whether the coin is truly quiet, newly added, partially backfilled, disabled, or lagging.

Recommendation:
- Add coverage metadata to the response and annotate every history-derived number with completeness.
- Do not render 30d/90d figures as plain numeric truth when the history window is truncated.

### 6. The `/flows` stale-data banner is measuring client fetch freshness, not underlying dataset freshness

Severity: Medium

Evidence:
- [src/hooks/use-mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-mint-burn-flows.ts#L91)
- [src/components/stale-data-banner.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/stale-data-banner.tsx#L15)
- [src/app/flows/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/flows/page.tsx#L108)
- [src/lib/api.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L136)

Why it matters:
- The page passes TanStack Query `dataUpdatedAt` into `StaleDataBanner`.
- `useMintBurnFlows()` uses `apiFetch()`, not `apiFetchWithMeta()`, so warning headers and `X-Data-Age` never reach the banner.
- If the worker serves a fallback cache due to backend failure, the page can still look “fresh” because the browser fetched it just now.

Recommendation:
- Switch mint/burn hooks to a meta-aware fetch path and feed `meta` into `StaleDataBanner`.
- When fallback cache or stale freshness headers are present, show that explicitly in the UI.

### 7. Aggregate `hours` changes the coin window even though the response schema still labels those fields as 24h

Severity: Medium

Evidence:
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L234)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L269)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L369)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L408)
- [shared/types/index.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/index.ts#L1408)
- [docs/api-reference.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md#L1176)

Why it matters:
- In aggregate mode, `hourlyRows` are filtered by `hours`, then rolled into fields named `netFlow24hUsd`, `mintVolume24hUsd`, and `burnVolume24hUsd`.
- The current page avoids abusing that by using the 24h query for the table, but the API contract itself is misleading and easy to misuse elsewhere.

Recommendation:
- Either hard-fix aggregate coin fields to always be 24h regardless of `hours`, or split the response into `coins24h` plus `hourlyWindow`.
- Update docs and schemas so the contract says exactly what it does.

### 8. “Largest event in the last 24h” query is nondeterministic and can pick the wrong row on ties

Severity: Medium

Evidence:
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L332)
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L349)

Why it matters:
- The query selects `e.*` while grouping only by `e.stablecoin_id`.
- The `HAVING e.timestamp = MAX(e.timestamp)` clause depends on SQLite group-row behavior that is not a clean deterministic tie-breaker.
- This is not catastrophic, but it is exactly the kind of quiet analytics bug that erodes trust.

Recommendation:
- Use a window function or a second join on `(stablecoin_id, max_val, max_timestamp)` so the result is deterministic.

### 9. Auto-heal and freshness queries are on a path to scanning too much data as the event table grows

Severity: Medium

Evidence:
- [worker/src/lib/mint-burn-pipeline/price-heal.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/price-heal.ts#L22)
- [worker/src/handlers/scheduled.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/scheduled.ts#L300)
- [worker/migrations/0031a_mint_burn_v2.sql](/home/ahirice/Documents/git/stablecoin-dashboard/worker/migrations/0031a_mint_burn_v2.sql#L17)
- [worker/migrations/0046_mint_burn_bridge_classification.sql](/home/ahirice/Documents/git/stablecoin-dashboard/worker/migrations/0046_mint_burn_bridge_classification.sql#L17)

Why it matters:
- The event table has indexes on `timestamp`, `stablecoin_id`, `chain_id`, and `burn_type`, but not on the specific patterns used by the price-heal query (`amount_usd IS NULL AND timestamp >= ?`) or major-symbol freshness query (`symbol IN (...)`).
- At current scale this may be fine; at mature scale it becomes a silent source of cron drag and alert lag.

Recommendation:
- Add targeted indexes or rewrite the queries to use indexed identifiers, especially for periodic 20-minute maintenance paths.

### 10. Fallback cache writes are not monotonic-safe

Severity: Medium-Low

Evidence:
- [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L559)
- [worker/src/lib/db.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/db.ts#L65)
- [worker/src/lib/db.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/db.ts#L78)

Why it matters:
- The flow handlers write fallback cache snapshots with `setCache()`, which overwrites unconditionally using the completion time of the request.
- A slow older query can therefore overwrite a newer cache snapshot.
- This only affects fallback behavior, but fallback behavior is exactly what matters when the system is under stress.

Recommendation:
- Use `setCacheIfNewer()` for flow caches.

### 11. Atomic-roundtrip exclusion is coarse enough to overfilter legitimate same-transaction activity

Severity: Low

Evidence:
- [worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts#L4)
- [worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts#L21)

Why it matters:
- Any same-transaction mint+burn for the same stablecoin is excluded wholesale.
- That catches flash-loan-like noise, but it can also catch legitimate batched treasury or vault operations.
- The risk is lower than the bridge-classification issue, but it is the same class of “simple heuristic standing in for protocol semantics.”

Recommendation:
- Add protocol-aware exemptions or tag these rows separately in the API so they remain inspectable.

## What Is Already Strong

- The cron split into critical and extended lanes is the right architecture for this dataset. It protects operator-critical freshness from long-tail backfill pressure.
- Shared ingest modules between cron and admin backfill are a strong design choice and reduce drift.
- Coverage-frontier advancement logic is more mature than most ingestion jobs; partial scans do not blindly advance state.
- The focused test suite is meaningful and passes locally.

## Bottom Line

The next major win is not more surface-level UI work. It is making the feature honest about scope and explicit about confidence.

If you fix the empty-hour recomputation bug, add coverage metadata to the API/UI, and introduce reconciliation plus broader bridge/issuer classification, this feature moves from “promising and sophisticated” to “institutionally trustworthy.”
