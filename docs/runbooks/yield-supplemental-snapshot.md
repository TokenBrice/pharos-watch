# Runbook: Yield Supplemental Empty Or Stale Snapshot

Triggered by:
- `sync-yield-supplemental` returning `degraded` with `fallbackMode: "empty-snapshot"`
- `sync-yield-supplemental` returning `degraded` with `reason: "retained-family-state-unavailable"` after the retained family/count-drop read failed; the run publishes nothing
- `sync-yield-data` metadata `sourceCoverage.supplementalSourceMode` is `unavailable` or `stale-cache`
- Optional family rows disappear; `SUPPLEMENTAL_SOURCE_FAMILY_KEYS` owns the current family roster
- The run-outcome row `yield:supplemental-source-run:v1` names `degradedFamilies`; publication findings appear in `metadata.quality`

## Symptom

Supplemental family evidence is missing, malformed, empty, or expired. The publisher excludes unavailable families but still consumes other fresh family snapshots.

## Impact

Core publication can continue with reduced optional coverage; [publication quality](../yield-intelligence.md#persistence-and-publication) distinguishes required-family failures from Pendle-only advisory loss. Read empty, absent and retained outcomes under [Common Causes](#common-causes); acceptance expires per family at six hours by default and 48 hours for daily Pendle.

Aave refreshes three pinned Aave V3 reserves on every successful run: Ethereum USDC, Arbitrum USDT, and Base USDC, plus three rotating tracked-contract targets. Six targets run in two concurrency-three batches within the unchanged 28-second deadline. A successful generation replaces the family snapshot; old rotation windows are not accumulated or renewed with substituted timestamps. Failed/degraded fetches retain the prior snapshot under the usual rules. Rotating targets are discovery probes, not a promise of listed reserves or continuous coverage.

Beefy, Royco, and Aave each cap concurrent outbound work at three. The standalone supplemental peak is three; hourly catch-up alongside parity is declared at four. Do not restore nested fan-out that can exceed these limits.

The unsuffixed aggregate `yield:supplemental-sources:v1` and retired vaults family/budget/circuit rows remain pending separate cleanup. A tracker checkbox or healthy rankings never authorize deletion; a missing C18 receipt ([MANIFEST](../../worker/migrations/MANIFEST.md), #1593) means retained and deferred, not zero rows. Do not delete them during normal deployment. First archive exact payloads/timestamps in durable R2 retained indefinitely, record a D1 Time Travel bookmark, and close the compatible rollback floor after healthy first primary/catch-up runs plus 48 hours. Aggregate deletion is exact-key only with a 0-to-1-row bound; preserve surviving suffixed family rows and `yield:supplemental-source-run:v1`. SQL `length(value)` measures text characters, not physical D1 shrinkage.

## First Checks

Start with the [shared read-only Yield Health checks](./yield-health.md#first-checks), focusing on `yieldHealth.supplemental` and `sync-yield-supplemental` / `sync-yield-data` metadata and leases. Then compare `altSources` and `dataSource` distribution in `GET https://api.pharos.watch/api/yield-rankings`.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, length(value) AS bytes, substr(value, 1, 1200) AS value_prefix
FROM cache
WHERE key LIKE 'yield:supplemental-%'
ORDER BY key;
```

Use the [shared cron-history SELECT](./yield-health.md#read-only-d1-snippets) with jobs `sync-yield-supplemental` and `sync-yield-data`, newest 12 runs.

```sql
SELECT data_source, COUNT(*) AS rows, MAX(updated_at) AS newest
FROM yield_data
GROUP BY data_source
ORDER BY rows DESC;
```

## Common Causes

- A successful zero-candidate family publishes an explicit empty row and can clear that family's stale candidates. All-empty surviving families remain valid available evidence. `SUPPLEMENTAL_SOURCE_FAMILY_KEYS` owns required membership; retired vaults rows are not inputs.
- A malformed, stale or missing family is excluded independently (`partial-family-cache`), not a reason to discard other fresh families. Only wholly absent `missing-cache` plus zero sources is unprovisioned; hourly catch-up can provision it once due.
- HTTP/parse/pagination failure or family-budget exhaustion retains the previous snapshot (`retained-previous`) and names `degradedFamilies`; it must not publish a fresh empty result. Optional RPC targets may also exhaust their fair share; inspect family summaries.
- A successful response that returns fewer than half the family's accepted candidate count is a count-drop, not an empty success: the first run retains, the second degrades with `family-count-drop:<family>`. Retention is bounded by the family freshness budget; afterwards the smaller snapshot publishes with its real clock and the family stays degraded through six consistent runs before the new level is accepted. Retained rows keep their original publication clock.
- Fetcher partial rows are diagnostic, not permission to publish a degraded family. Thrown Morpho/Beefy failures discard accumulated candidates; Pendle/Kong keep earlier rows and isolate ordinary failures to the current chain. Parent cancellation propagates, and each family budget is cleaned up once. Pendle still cancels a 429 body and stops all chains immediately; Kong deduplicates within each chain, Morpho paginates symbol batches independently, and Beefy joins APY/vault/TVL documents before emitting rows.
- Pendle's free API uses no bearer header; `fetchPendleMarketSources` owns pagination, not a fixed one-page-per-chain assumption. Its 24h cadence yields `skipped-not-due`; recorded 429 backoff yields `skipped-backoff`. Both are neutral only while the retained row is within 48h; expiry emits `pendle-rate-limited-backoff`.
- Inspect `yield:supplemental-sources:v1:pendle-backoff` source/deadline rather than forcing retries. `resolvePendleRateLimitBackoff` chooses the longest applicable Retry-After/reset delay: weekly reset applies to weekly exhaustion or absent quota evidence, with a seven-day bound and 24h default without usable headers. Unreadable/persist-failed gate state is logged and permits ungated fetching, not a false persisted-backoff claim.
- `setCacheIfNewer` skipped the write because a newer snapshot already existed.

## Remediation

- For `empty-snapshot`, verify successful family markers using [Validation](#validation); do not interpret zero candidates as a failed write.
- For family-dominated misses, inspect `sourceCoverage.sourceFamilySummaries` status/raw/emitted counts, budgets, miss reasons and bounded examples; `sourceFamilyCounts` counts candidates. Keep heavy fetches off the publisher.
- If the job is stale due to a stuck lease, follow [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md) for `sync-yield-supplemental`; never clear a live owner. Verify the next due Aave producer tail or independent-family slot, as applicable.
- If the cache is malformed, preserve the malformed value for debugging and let a later successful supplemental run replace it.

## Abort Conditions

- Do not recreate, write, or use the retained aggregate supplemental row as a fallback; coordinated cleanup is a separate operation.
- Do not increase Worker connection pressure by moving supplemental readers into `sync-yield-data`.
- Do not hand-create supplemental candidate rows in `yield_data`; the post-V9 publisher owns evaluation and arbitration.

## Validation

- Confirm `familyCacheResults` contains `published`, `empty-published`, or an understood `skipped-newer`/neutral Pendle skip, and `sourceCoverage.sourceFamilySummaries` explains failed or budget-exhausted families. `rowsWritten` counts candidates, not cache markers: successful empty writes have zero rows.
- For Aave sequencing acceptance, observe a natural due refresh immediately after a safe stablecoins publication: original quotes must remain within each composite source's budget, productive reserves must emit USD-valued rows, and the Aave family cache/outcome must advance without changing sibling diagnostics. Confirm the next main yield publication no longer carries the recovered Aave failure. Genuinely stale/missing quotes must still retain the old family with `usd-price-unavailable`; do not force runs or widen budgets to manufacture recovery.
- Require following snapshots to retain their reserved time. `aave-refresh-deferred-deadline` means insufficient headroom (neutral before admission) or an admitted timeout (degraded/error, never a successful refresh); inspect the slot outcome and child terminal together. Unsettled attempts retain the shared lease until normal expiry, not a manual reset.
- The registry-enumerated `yield:supplemental-sources:v1:<family>` rows are present when expected, parseable, and recent. A per-family row with `sourceCount: 0` is valid when that family completed successfully with no deduplicated candidates. A single malformed family row should not block other fresh family rows; an all-empty surviving family snapshot remains valid.
- The next yield run's `sourceCoverage.supplementalSourceMode` is `cache`; `sourceCoverage.supplementalSourceCount` may be zero for valid all-empty snapshots.
- Public rankings/source board show expected optional family rows or alternatives.

- Run-outcome `familySnapshotHashes` bind claims to exact family value/publication clocks. A failed outcome upsert cannot attribute old degradation to a replacement row: mismatches/legacy unbound outcomes appear under `supplementalUnknownOutcomeFamilies`, with independent age checks unchanged. Matching degraded families retain their previous snapshot, including Compound targets missing `no-rpc-config`. Pendle `skipped-not-due` / `skipped-backoff` reuse retained rows; verify their age remains within 48h.

## Rollback Notes

The supplemental lane rollback retains family rows for failed/malformed families while successful zero-candidate family snapshots may clear stale family-owned rows. The legacy aggregate row is not part of rollback authority. If a code deploy caused persistent malformed snapshots or unexpected zero-candidate family output, roll back the Worker version and allow the next supplemental cycle to repopulate the family caches.
