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

Start with the [shared read-only Yield Health checks](./yield-health.md#first-checks), focusing on ranking freshness and `sync-yield-data` metadata and leases. Also check `/status/` for public cache/probe impact and the admin Endpoint probes for `/api/yield-rankings`, then read `GET https://api.pharos.watch/api/yield-rankings`. Use [Source Decision Evidence](#source-decision-evidence) below for generation and per-asset queries.

Use the [publication contract](../yield-intelligence.md#persistence-and-publication), [wire fields](../yield-intelligence.md#public-wire-contract) and [operator thresholds](./yield-health.md#threshold-table) to compare response-time `_meta`, source/anchor age and independent safety age. Inspect `metadata.reason` separately from `metadata.quality.reasons` / `advisoryReasons`.

Readback must match `freshness:yield-data` generation/time to rankings `publication.generationId` / publication time, including applied publications with quality findings. Status/health generation/time may be null for legacy/fallback evidence; last clean cron time is not served publication age.

## Source Decision Evidence

There is no `/api/yield-source-decisions` endpoint. Assemble bounded evidence from the [shared generation SELECT](./yield-health.md#read-only-d1-snippets), the decision queries below, and typed alternates for one asset:

```sql
SELECT generation_id, stablecoin_id, alt_source_key, alt_yield_source,
       alt_apy30d_delta, rejection_reason_code, recorded_at
FROM yield_source_decision_alternatives
WHERE stablecoin_id = '<stablecoin_id>'
  AND generation_id = '<generation_id>'
ORDER BY recorded_at DESC, alt_source_key ASC;
```

Keep generation/decision reads bounded (normally 10/25 rows) and distinguish staged, published and failed state. The [publication contract](../yield-intelligence.md#persistence-and-publication) owns abort, abandoned-staging and losing-generation semantics.

## Read-Only D1 Snippets

Run these as read-only D1 queries through Wrangler or the Cloudflare dashboard:

```sql
SELECT key, updated_at, length(value) AS bytes
FROM cache
WHERE key IN ('yield-rankings', 'freshness:yield-data');
```

Use the [shared cron-history SELECT](./yield-health.md#read-only-d1-snippets) for `sync-yield-data`, newest 5 runs.

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

For generation identity, state, counts and `failure_reason`, run the [shared generation SELECT](./yield-health.md#read-only-d1-snippets), newest 10 rows, alongside the asset-specific queries below.

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

An incompatible or unavailable live publication can use publish-time safety (`yield-safety-hydration-stale`, `provenance.liveSafetyHydration.fallback: "publish-time-snapshot"`) only within the [original-clock failure contract](../yield-intelligence.md#failure-semantics). Missing safety time is not renewed from cache time. Fallback alone emits no HTTP Warning; publication aging still does above two hours.
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
- Staged rows and `publication-skipped` progress/event evidence indicate schema/cache/CAS failure; compare the winning published generation under [publication semantics](../yield-intelligence.md#persistence-and-publication), never promote losing rows.
- `no-yield-bearing-coins` is a degraded empty-cohort failure, not success.
- `safety-snapshot-unavailable:<upstream reason>` defers before source resolution, preserving the prior generation. Inspect `safetySnapshotHeld` and `acceptedPublicationAgeSeconds`: a held accepted generation inside budget is usable and reports an advisory instead, while sparse coverage remains a separate quality finding.
- Authoritative history publication cutoff lookup failed. Readable history remains available with `_meta.status: "stale"`, `reason: "publication-cutoff-unavailable"`, and `Cache-Control: no-store`, even if cache metadata supplies a fallback cap. An unavailable authority is not a fresh history claim.

## Remediation

- If `sync-yield-data` is stale but not leased, wait for the next `55 * * * *` run if the last failure was transient.
- If the cron is repeatedly `skipped_locked`, confirm the lease is stale, then clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), job `sync-yield-data`.
- If metadata shows `reason: "previous-yield-rankings-cache-invalid"` or publication guard failure, do not delete the cache blindly. Preserve the last good payload for rollback/debugging and identify whether the failure came from payload schema, severe shrink, duplicate ranking IDs, or a generation `failure_reason`.
- For `metadata.reason: "safety-snapshot-unavailable:<reason>"`, inspect upstream `report-cards:v9`, `report-cards:v9:publication-health`, and producer runs. Yield defers until accepted evidence is usable. `safety-snapshot-held` in `metadata.quality.advisoryReasons` instead means publication used the accepted generation inside its budget; actual sparse coverage is a separate quality finding.
- If the degraded reason points to benchmarks, use [`yield-benchmark-fallback-stale.md`](./yield-benchmark-fallback-stale.md).
- For deterministic all-fail/cooldown evidence, follow [Deterministic All-Fail Cooldown](./yield-health.md#deterministic-all-fail-cooldown).
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
