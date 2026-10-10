# Runbook: Yield Rankings Stale Or Missing

Triggered by:
- `/api/yield-rankings` returning `503`, malformed-cache errors, or no rankings
- `/status/` impacted surfaces naming yield data
- `/admin/` -> Crons showing stale or unhealthy `sync-yield-data`
- `/admin/` -> Endpoint probes showing unhealthy `/api/yield-rankings`
- `/api/health` degraded with a `yield-safety-unrated-serving:*` warning, or `/yield/` showing all rows as Safety NR (see [Safety Identity Mismatch](#safety-identity-mismatch))

## Symptom

The public `/yield/` page shows a stale-data banner, empty leaderboard, or failed rankings request. API clients may see `503` from `GET /api/yield-rankings` when the cached `yield-rankings` payload is missing or malformed.

## Impact

Rankings, PYS, provenance, and detail panels may be stale or unavailable. History excludes unpublished generation-aware rows and normally caps reads to the last published rankings cutoff. If neither cache nor cron evidence supplies a cutoff, readable history is served uncapped with `publication-cutoff-unavailable`, stale metadata and `no-store`; this is not proof of a fresh publication.

## First Checks

1. **Public status:** `/status/` for public cache/probe impact.
2. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `sync-yield-data`; also inspect Endpoint probes for `/api/yield-rankings`.
3. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.
4. **Public API:** `GET https://api.pharos.watch/api/yield-rankings`.
5. **Source decisions:** see [Source Decision Evidence](#source-decision-evidence) below for the generation and per-asset decision queries.

Rankings full and summary `_meta` report `assessedAt`, `freshBudgetSec: 7200`, `degradedBudgetSec: 14400`, and `reason` alongside publication time, age, and status. Age is reassessed at response time: above two hourly intervals is degraded, above four is stale. Both non-fresh states send `Warning: 110` and `Cache-Control: no-store`. Source and comparison-anchor ages also advance on both live-safety and held-safety paths; publication time does not refresh upstream observations.

An applied `sync-yield-data` returns `ok` with `metadata.quality { degraded, reasons }`. Inspect those reasons for imperfect inputs and non-blocking coverage/quarantine alarms; use `metadata.reason` for unapplied `degraded` work. The top-level `fallbackMode` has been removed. `streakDegradedRuns` includes non-clean completed publications and exposes the latest concrete cause; Pendle-only advisory loss does not flip public producer quality.

Check `freshness:yield-data` against `yield-rankings`: sentinel `generationId` / `updated_at` must match rankings `publication.generationId` / publication time after any applied publication, even with quality findings. `/api/status` and `/api/health` publish yield `generationId` / `publishedAt`, or null for legacy/fallback evidence. Do not confuse served yield age with the last clean run or the independent safety clock.

## Source Decision Evidence

`GET /api/yield-source-decisions`, the admin-only read path that joined generations and decisions in one response, was retired on 2026-08-09. Every table it read is unchanged and still written by each publication run, so the same evidence is assembled from the `yield_publication_generations` and `yield_source_decisions` snippets in [Read-Only D1 Snippets](#read-only-d1-snippets) below, plus the typed alternates for one asset:

```sql
SELECT generation_id, stablecoin_id, alt_source_key, alt_yield_source,
       alt_apy30d_delta, rejection_reason_code, recorded_at
FROM yield_source_decision_alternatives
WHERE stablecoin_id = '<stablecoin_id>'
  AND generation_id = '<generation_id>'
ORDER BY recorded_at DESC, alt_source_key ASC;
```

Filter generations by `state IN ('staged', 'published', 'failed')` to reproduce the endpoint's `state` filter. Keep result sets small; the retired endpoint capped both generation and decision reads at 25 rows for a reason.
`failure_reason` on generation rows uses a stable vocabulary; besides ordinary `failed` publishes, a persist-stage abort finalizes the batch as `aborted`, and a staged row older than one hour is pruned to `failed` / `abandoned-staged` by the retention rule.

## Read-Only D1 Snippets

Run these as read-only D1 queries through Wrangler or the Cloudflare dashboard:

```sql
SELECT key, updated_at, length(value) AS bytes
FROM cache
WHERE key IN ('yield-rankings', 'freshness:yield-data');
```

```sql
SELECT job, started_at, duration_ms, status, item_count, error, metadata
FROM cron_runs
WHERE job = 'sync-yield-data'
ORDER BY started_at DESC
LIMIT 5;
```

```sql
SELECT COUNT(*) AS best_rows, MAX(updated_at) AS newest_row, MIN(updated_at) AS oldest_row
FROM yield_data
WHERE is_best = 1;
```

```sql
SELECT stablecoin_id, source_key, data_source, current_apy, pharos_yield_score, updated_at
FROM yield_data
WHERE is_best = 1
ORDER BY updated_at ASC
LIMIT 20;
```

```sql
SELECT generation_id, started_at, state, ranking_count, source_row_count, best_row_count, failure_reason
FROM yield_publication_generations
ORDER BY started_at DESC
LIMIT 10;
```

```sql
SELECT stablecoin_id, selected_source_key, selected_confidence_tier, selected_data_source,
       selected_apy_30d, selected_score, source_switch, rejected_count
FROM yield_source_decisions
WHERE generation_id = '<generation_id>'
ORDER BY selected_score DESC
LIMIT 25;
```

```sql
SELECT stablecoin_id, length(alternatives_json) AS evidence_bytes, alternatives_json
FROM yield_source_decisions
WHERE generation_id = '<generation_id>' AND stablecoin_id = '<stablecoin_id>';
```

The `alternatives_json` ledger is intentionally compact and bounded to 4 KB per selected row. It keeps at most four alternate sources with short rejected/retained reasons and anomaly samples, so it is debug evidence rather than a full replay log.

## Safety Identity Mismatch

`/yield/` showing every row as Safety NR — blank scatter chart, `—` hero PYS, zeroed risk-tolerance bands — while APYs still populate is the *safety hydration* failure mode, not a rankings-cache failure. The read path hydrates safety from the live V9 publication only when the identity stamped into the `yield-rankings` cache is evaluator-compatible with it (`safetyScorePublicationIdentitiesAreComparable`). Every scoring deploy rotates the evaluation-build digest, so a mismatch window is expected after each rollout until the next hourly `sync-yield-data` publish.

Since 2026-08-19 the API bridges that window itself: an incompatible or unavailable live publication can use the cached payload's own publish-time safety values (`yield-safety-hydration-stale`, `provenance.liveSafetyHydration.fallback: "publish-time-snapshot"`). The 24-hour stale-coherent budget applies independently to yield and safety evidence publications; missing safety time is not refreshed from cache time. A usable fallback alone does not emit an HTTP `Warning`, but publication aging still does above the two-hour boundary.
`provenance.liveSafetyHydration.reason` joins every applicable reason, including the upstream snapshot's own cause. Fallback coverage does not count `cached-publish` safety merely because a stored score exists; qualifying non-default `opportunity-safety` rows still count under `countRowSafetyCoverage`.

Investigate only when `/api/health` is `degraded` with a `yield-safety-unrated-serving:<reason>` warning — that means the public surface is actually serving NR safety:

- `yield-safety-unrated-serving:safety-identity-missing`: the cached payload has no stamped safety identity. The last `sync-yield-data` publish predates identity stamping or published without a usable safety snapshot; check its `cron_runs` metadata `sourceCoverage.safetySnapshot`.
- `yield-safety-unrated-serving:safety-identity-mismatch` / `:safety-snapshot-unavailable`: the publish-time fallback aged past the 24-hour stale-coherent window, meaning `sync-yield-data` has not published a compatible snapshot for over a day. Diagnose the cron (below), not the identity coupling.
- `yield-safety-unrated-serving:safety-snapshot-held`: either the yield or original accepted safety clock exceeded 24 hours (or lacks a valid timestamp), even when identities match. The in-budget form is the healthy advisory `yield-safety-publish-time-fallback:safety-snapshot-held`.
- `yield-safety-availability-unknown`: missing/unreadable validated publication health, or its accepted generation disagrees with the readable identity envelope. Investigate the sidecar; never bypass the identity guard.

Compare the two identities directly:

```sql
SELECT json_extract(value, '$.provenance.safetySnapshot.safetyScoreIdentity') AS stamped
FROM cache WHERE key = 'yield-rankings';
```

```sql
SELECT json_extract(value, '$.identity') AS live
FROM cache WHERE key = 'report-cards:v9';
```

Comparability requires equal model, schema version, methodology version, `evaluationBuildDigest`, `policyId`, and `policyDigest`; input/publication generation IDs may differ. `safetyIdentityChangedBeforePublish` records a mid-run incompatible identity change; that run publishes and the next compatible run re-aligns.

## Common Causes

- `sync-yield-data` is stale, failing, or stuck behind an active lease.
- The cache publication guard skipped overwrite because the new payload failed schema validation, had duplicate IDs, or shrank severely versus the previous cache.
- Core inputs were degraded: safety snapshot coverage below threshold, retained/stale benchmark fallback, unavailable DeFiLlama pools, deterministic on-chain outage without alternative coverage, or supplemental source loss reducing coverage.
- D1 rows were staged but cache publication failed or CAS-skipped because a newer cache already exists; the generation remains `failed`, public cache stays on the previous good generation, and generation-aware history rows remain hidden.
  A compare-and-swap skip now logs a `publication-skipped` event and reports the progress stage `publication-skipped` instead of `publication-complete`; the previous published generation is retained.

- The run resolved no yield-bearing coins and returned `degraded` with metadata reason `no-yield-bearing-coins` — an empty cohort is no longer a healthy run.
- No usable published Safety Score V9 generation exists for the run: either nothing is readable, or the publication is held and its accepted generation has left the stale-coherent window. The run defers before source resolution with metadata reason `safety-snapshot-unavailable:<upstream reason>` — for example `safety-snapshot-unavailable:v9-publication-held` — and carries `safetySnapshotHeld` plus `acceptedPublicationAgeSeconds`. An unusable snapshot forces `NR` on every evaluated row, so the run cannot publish a ranking row: yield sources, DL pools, and publication are not implicated, and the previous published generation stays intact. A *held* publication inside the window is the opposite case, not this one: the run publishes against the accepted generation the report-card route still serves and reports `safety-snapshot:v9-publication-held` as a degradation reason.
- Authoritative history publication cutoff lookup failed. Readable history remains available with `_meta.status: "stale"`, `reason: "publication-cutoff-unavailable"`, and `Cache-Control: no-store`, even if cache metadata supplies a fallback cap. An unavailable authority is not a fresh history claim.

## Remediation

- If `sync-yield-data` is stale but not leased, wait for the next `55 * * * *` run if the last failure was transient.
- If the cron is repeatedly `skipped_locked`, confirm the lease is stale, then clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), job `sync-yield-data`.
- If metadata shows `reason: "previous-yield-rankings-cache-invalid"` or publication guard failure, do not delete the cache blindly. Preserve the last good payload for rollback/debugging and identify whether the failure came from payload schema, severe shrink, duplicate ranking IDs, or a generation `failure_reason`.
- For `metadata.reason: "safety-snapshot-unavailable:<reason>"`, inspect upstream `report-cards:v9`, `report-cards:v9:publication-health`, and producer runs. Yield defers until accepted evidence is usable. `safety-snapshot-held` in `metadata.quality.advisoryReasons` instead means publication used the accepted generation inside its budget; actual sparse coverage is a separate quality finding.
- If the degraded reason points to benchmarks, use [`yield-benchmark-fallback-stale.md`](./yield-benchmark-fallback-stale.md).
- If the degraded reason points to deterministic on-chain cooldown or all-fail state, use [`yield-deterministic-cooldown.md`](./yield-deterministic-cooldown.md).
- If supplemental source coverage dropped, use [`yield-supplemental-snapshot.md`](./yield-supplemental-snapshot.md).
- Coverage reasons `yield-publication:coverage-regression:<tracked|opportunity|total>` are non-blocking alarms, including direct-to-modeled substitution. Do not mistake them for a held generation. Empty total, total below `ceil(previous * 0.4)` for a prior count of at least five, and common-input holds still retain the previous publication.

## Abort Conditions

- Do not clear a `sync-yield-data` lease while `/api/status` shows an active, fresh `inFlight` progress row for the same job.
- Do not mutate `yield_data`, `yield_history`, `yield_publication_generations`, `yield_source_decisions`, or `cache` by hand to force rankings publication.
- Do not bypass schema/severe-shrink guards; they are the rollback boundary that protects public rankings.
- Stop if another operator is running yield-history cleanup and `cache['yield-history-cleanup:writer-pause']` is armed; see [`yield-history-cleanup-writer-pause.md`](./yield-history-cleanup-writer-pause.md).

## Validation

- `/admin/` shows a recent `sync-yield-data` run with `status` `ok` or expected `degraded`.
- `GET /api/yield-rankings` returns `200`, non-empty `rankings`, and a fresh `_meta` / `updatedAt`.
- Latest `yield_publication_generations` row is `published` or has an understood `failed` reason while the previous public cache remains valid.
- `yield_data` best-row count is plausible relative to the previous good run, and current rows for the latest public generation carry `publication_state='published'`.
- `freshness:yield-data` and served rankings share the winning generation/time; safety `publishedAt` remains original with `maxAgeSeconds: 86400`. Above-floor held coverage emits the held advisory, not `safety-snapshot-coverage`; below-floor coverage still gates public quality.
- `GET /api/yield-history?stablecoin=<id>&days=30` works for a known ranked coin and does not return points newer than the rankings cutoff.
- Every row serving a null PYS carries an explicit `pysNullReason` (the NR degrade path preserves the original reason), and no row serves `0` while a null reason is set.

## Rollback Notes

The normal rollback is to keep serving the previous `yield-rankings` cache while the post-V9 publisher recovers. Failed or CAS-skipped generations are intentionally left in D1 as audit evidence and should not be promoted manually. If a deploy caused repeated publication failures, roll back the Worker version through the standard deployment process; do not manually rewrite rankings cache contents unless a maintainer explicitly approves a targeted restore.
