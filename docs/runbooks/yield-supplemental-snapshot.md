# Runbook: Yield Supplemental Empty Or Stale Snapshot

Triggered by:
- `sync-yield-supplemental` returning `degraded` with `fallbackMode: "empty-snapshot"`
- `sync-yield-data` metadata showing `supplementalSourceMode` as `unavailable` or `stale-cache`
- Optional Aave, Compound, Morpho, Pendle, Yearn/Kong, Beefy, or Royco Dawn rows disappearing from rankings/source boards
- `sync-yield-data` metadata `supplementalMeta.degradedFamilies` naming families whose last producer run ended degraded and kept the previous snapshot

## Symptom

The slower supplemental source snapshot is missing, malformed, empty, or older than its allowed freshness window. The post-V9 publisher still runs but consumes zero supplemental candidates.

## Impact

Core yield publication should remain available. Optional protocol-API and optional RPC family coverage is reduced, so some alternate sources or best rows may disappear until `sync-yield-supplemental` writes fresh per-family snapshots. A fresh all-empty family snapshot is valid current state and yields zero supplemental candidates; a family row absent entirely (missing cache with zero sources) means the lane was never provisioned and does not degrade the core run — the hourly chain provisions it. The acceptance bound is per-family and cadence-derived: the lane default is 1.5× the 4-hour producer cadence (6 hours); the Pendle daily lane fetches at most once per day on the free unkeyed quota and accepts its retained row through 48 hours (two daily cycles), so a `skipped-not-due` / `skipped-backoff` Pendle run is healthy, not degraded, while that row is inside the bound.

Applied `sync-yield-data` remains `ok`; input findings live in `metadata.quality`, not top-level `fallbackMode`. Pendle-only loss goes in `quality.advisoryReasons`, leaving `quality.degraded` false: stale candidates are excluded and the admin supplemental tile remains degraded, but public producer quality stays clean. `partial-family-cache` is suppressed only when exactly Pendle is unavailable. Other required-family failures affect producer quality. vaults.fyi is retired; no missing-family alarm should require its cache.

Aave refreshes three pinned Aave V3 reserves on every successful run: Ethereum USDC, Arbitrum USDT, and Base USDC, plus three rotating tracked-contract targets. Six targets run in two concurrency-three batches within the unchanged 28-second deadline. A successful generation replaces the family snapshot; old rotation windows are not accumulated or renewed with substituted timestamps. Failed/degraded fetches retain the prior snapshot under the usual rules. Rotating targets are discovery probes, not a promise of listed reserves or continuous coverage.

Beefy, Royco, and Aave each cap concurrent outbound work at three. The standalone supplemental peak is three; hourly catch-up alongside parity is declared at four. Do not restore nested fan-out that can exceed these limits.

The unsuffixed aggregate `yield:supplemental-sources:v1` and retired vaults family/budget/circuit rows remain pending separate cleanup. Do not delete them during normal deployment. First archive exact payloads/timestamps in durable R2 retained indefinitely, record a D1 Time Travel bookmark, and close the compatible rollback floor after healthy first primary/catch-up runs plus 48 hours. Aggregate deletion is exact-key only with a 0-to-1-row bound; preserve surviving suffixed family rows and `yield:supplemental-source-run:v1`. SQL `length(value)` measures text characters, not physical D1 shrinkage.

## First Checks

1. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `sync-yield-supplemental` and `sync-yield-data`.
2. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.
3. **Public rankings:** compare `altSources` and `dataSource` distribution in `GET https://api.pharos.watch/api/yield-rankings`.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, length(value) AS bytes, substr(value, 1, 1200) AS value_prefix
FROM cache
WHERE key LIKE 'yield:supplemental-%'
ORDER BY key;
```

```sql
SELECT job, started_at, duration_ms, status, item_count, error, metadata
FROM cron_runs
WHERE job IN ('sync-yield-supplemental', 'sync-yield-data')
ORDER BY started_at DESC
LIMIT 12;
```

```sql
SELECT data_source, COUNT(*) AS rows, MAX(updated_at) AS newest
FROM yield_data
GROUP BY data_source
ORDER BY rows DESC;
```

## Common Causes

- All supplemental families emitted zero candidates. The cron publishes explicit empty rows for successful families; the loader treats the all-empty current snapshot as valid with zero supplemental candidates.
- One per-family cache is malformed or stale. The post-V9 publisher should still load other fresh family caches and report `sourceCoverage.supplementalFallbackMode` as `partial-family-cache` instead of dropping independent coverage. The live family list comes from `SUPPLEMENTAL_SOURCE_FAMILY_KEYS`; retired vaults rows are not a required input.
- One successful per-family run emitted zero candidates. That family may intentionally publish an empty per-family cache to clear a previous non-empty family snapshot.
- Optional protocol APIs timed out inside the family budget.
- Optional RPC families exhausted their family budget or missed many chain targets.
- The cache payload became malformed or older than the supplemental freshness window.
- One family's upstream fetch failed mid-run (HTTP/parse failure or exhausted pagination). The family skips its cache write, retains the previous snapshot (`retained-previous` in the run-outcome row), and is named in `degradedFamilies` instead of publishing a fresh empty row.
- The Pendle lane skipped neutrally (`skipped-not-due` inside its 24h cadence, or `skipped-backoff` while a recorded 429 window is active). Both are healthy while the retained row is inside its 48h budget; inspect `yield:supplemental-sources:v1:pendle-backoff` for the parsed replenish window and expect `pendle-rate-limited-backoff` in `degradedFamilyReasons` only once the retained row leaves the budget.
- The free unkeyed Pendle quota is shared per-IP and can be spent by other Cloudflare egress tenants; that is not a Pharos failure and cannot be cleared from our side. Confirm the backoff row records an `x-ratelimit-weekly-reset`-derived window rather than retrying the API.
- `setCacheIfNewer` skipped the write because a newer snapshot already existed.

## Remediation

- If the latest supplemental run is a single `empty-snapshot`, verify that successful family rows were published. The resulting all-empty family snapshot is valid and should remain available with zero supplemental candidates until the next 4-hour run.
- If `sync-yield-supplemental` metadata shows one family dominating misses or budget exhaustion, inspect `sourceCoverage.sourceFamilySummaries` first. It gives compact per-family status, raw/emitted counts, budget/cap flags, miss reasons, chain breakdowns, and bounded missing-target examples. `sourceCoverage.sourceFamilyCounts` is candidate-oriented. Do not move heavy family fetches onto the post-V9 publisher.
- If the job is stale due to a stuck lease, clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), job `sync-yield-supplemental`, and verify the next four-hour run.
- If the cache is malformed, preserve the malformed value for debugging and let a later successful supplemental run replace it.

## Abort Conditions

- Do not recreate, write, or use the retained aggregate supplemental row as a fallback; coordinated cleanup is a separate operation.
- Do not increase Worker connection pressure by moving supplemental readers into `sync-yield-data`.
- Do not hand-create supplemental candidate rows in `yield_data`; the post-V9 publisher owns evaluation and arbitration.

## Validation

- `sync-yield-supplemental` has a recent run with `rowsWritten > 0` or a documented `skipped-newer`, and `sourceCoverage.sourceFamilySummaries` explains any empty, failed, or budget-exhausted family.
- The registry-enumerated `yield:supplemental-sources:v1:<family>` rows are present when expected, parseable, and recent. A per-family row with `sourceCount: 0` is valid when that family completed successfully with no deduplicated candidates. A single malformed family row should not block other fresh family rows; an all-empty surviving family snapshot remains valid.
- The next `sync-yield-data` metadata shows `supplementalSourceMode: "cache"`; `supplementalSourceCount` may be zero when the current family snapshot is explicitly all-empty.
- Public rankings/source board show expected optional family rows or alternatives.

- Run-outcome `familySnapshotHashes` bind claims to exact family value/publication clocks. A failed outcome upsert cannot attribute old degradation to a replacement row: mismatches/legacy unbound outcomes appear under `supplementalUnknownOutcomeFamilies`, with independent age checks unchanged. Matching degraded families retain their previous snapshot, including Compound targets missing `no-rpc-config`. Pendle `skipped-not-due` / `skipped-backoff` reuse retained rows; verify their age remains within 48h.

## Rollback Notes

The supplemental lane rollback retains family rows for failed/malformed families while successful zero-candidate family snapshots may clear stale family-owned rows. The legacy aggregate row is not part of rollback authority. If a code deploy caused persistent malformed snapshots or unexpected zero-candidate family output, roll back the Worker version and allow the next supplemental cycle to repopulate the family caches.
