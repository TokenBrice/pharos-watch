# Runbook: Yield Health

Triggered by `/api/status` field:
- `yieldHealth.statusImpact="public-critical"` when `yield-rankings` is missing or stale
- `yieldHealth.status="degraded"` for admin-watch yield diagnostics such as sparse safety coverage, stale supplemental cache, benchmark fallback, old coverage audit, or low source-risk evidence coverage

## Symptom

The admin Pipeline lane shows stale or degraded Yield Health. Public impact is limited to stale or missing `yield-rankings`; source-family sparsity, supplemental staleness, benchmark fallback, source-risk evidence gaps, and old coverage-audit data are operator-watch signals unless a later rollout explicitly promotes them.

## Impact

- `public-critical`: stale or missing `yield-rankings` can make `/yield/`, stablecoin yield panels, and `GET /api/yield-rankings` stale or unavailable.
- `admin-watch`: sparse safety coverage, stale supplemental coverage, benchmark fallback, low source-risk evidence coverage, and old coverage-audit data reduce operator confidence but do not by themselves change public status.
- Yield Health is read-only. It does not change scoring, source arbitration, publication eligibility, or methodology.

## First checks

1. **Rankings cache:** inspect `yieldHealth.rankingUpdatedAt`, `rankingAgeSec`, and `rankingStatus` in `/api/status`.
2. **Publisher cron:** inspect `crons["sync-yield-data"]` for latest status, error, metadata, and in-flight lease state.
3. **Safety coverage:** inspect `yieldHealth.safetyCoverage`; coverage below `0.75` means read-time report-card hydration is sparse.
4. **Supplemental cache:** inspect `yieldHealth.supplemental`; `familyCount`, `freshFamilyCount`, `degradedFamilyCount`, `staleFamilyCount`, `missingFamilyCount`, and `families` identify which optional source families are stale or absent. Age above 6h means optional source families may be sparse.
5. **Benchmark:** inspect `yieldHealth.benchmark`; fallback or age above 48h means retained benchmark data is driving yield context.
6. **Source-risk coverage:** inspect `yieldHealth.sourceRiskCoverage`; core fields below 75% coverage are admin-watch gaps. `venueRiskTier="unknown"` counts as missing evidence, not high risk.
7. **Coverage audit:** inspect `yieldHealth.coverageAudit`; age above 45d means the monthly coverage review is late. `headlineGapCount` and `recommendationCandidateCount` are the read-only triage queue.

Access-gated surfaces:

- Browser: `https://ops.pharos.watch/admin/` -> Pipeline -> Yield Health
- Machine API: `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers

Read-only JSON checks:

```bash
curl -fsS https://ops-api.pharos.watch/api/status \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  | jq '.yieldHealth | {status, statusImpact, sourceRiskCoverage, coverageAudit}'
```

```bash
curl -fsS https://ops-api.pharos.watch/api/status \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  | jq '.yieldHealth.sourceRiskCoverage.fields | {
      sourceRiskPenalty,
      rewardShare,
      sourceAgeSeconds,
      sourceDepthRatio,
      venueRiskTier,
      sourceRiskScore
    }'
```

## Read-Only D1 Snippets

Use Wrangler's D1 execute command from `worker/` for the SQL below, and keep every inspection query `SELECT`-only.

```sql
SELECT key, updated_at, length(value) AS bytes
FROM cache
WHERE key IN ('yield-rankings', 'yield:supplemental-sources:v1', 'yield-coverage-audit')
   OR key LIKE 'yield:supplemental-sources:v1:%'
ORDER BY key;
```

```sql
SELECT job, started_at, status, item_count, error, metadata
FROM cron_runs
WHERE job IN ('sync-yield-data', 'sync-yield-supplemental', 'yield-coverage-audit')
ORDER BY started_at DESC
LIMIT 12;
```

```sql
SELECT key, updated_at, substr(value, 1, 1200) AS value_prefix
FROM cache
WHERE key = 'yield-rankings';
```

```sql
SELECT key, updated_at, substr(value, 1, 2000) AS value_prefix
FROM cache
WHERE key = 'yield-coverage-audit';
```

```sql
SELECT generation_id, started_at, state, ranking_count, source_row_count, best_row_count, failure_reason
FROM yield_publication_generations
ORDER BY started_at DESC
LIMIT 10;
```

## Remediation

- **Missing/stale rankings:** check `sync-yield-data` cron errors first. Clear a stuck `sync-yield-data` lease only when the admin cron card shows repeated `skipped_locked` or stale in-flight progress, then let the next hourly publisher rebuild `yield-rankings`.
- **Sparse safety coverage:** inspect report-card cache health and `/api/report-cards`; yield rankings can still publish with default safety fallback, but PYS quality is lower.
- **Stale supplemental cache:** inspect `sync-yield-supplemental`. Because supplemental sources are optional, do not block the public yield page solely on this signal.
- **Benchmark fallback:** inspect `risk_free_rates` cache and the latest `sync-yield-data` metadata. A retained fallback is acceptable briefly; treat retained data older than 48h as needing operator follow-up.
- **Low source-risk coverage:** inspect whether missing fields are absent from current rankings, retained alternates, or both. Missing or `unknown` venue tiers are evidence gaps; do not backfill guessed tiers.
- **Coverage-audit queue:** classify each headline gap or recommendation candidate as `accept`, `dismiss`, `intentional-gap`, or `watch` in the operator note for that audit cycle. This is a triage convention only; there is no persistent dismissal state.
- **Old coverage audit:** inspect `yield-coverage-audit` cron history. It is monthly and watch-tier, so a late audit is a review backlog, not a public outage.

## Abort Conditions

- Do not manually edit `yield-rankings`, `yield_data`, `yield_history`, `yield_publication_generations`, or `yield_source_decisions` to make the health card green.
- Do not guess or manually backfill source-risk tiers. `venueRiskTier="unknown"` is intentionally treated as missing evidence.
- Do not clear a `sync-yield-data` or `sync-yield-supplemental` lease while `/api/status` shows a fresh active in-flight progress row.
- Do not treat supplemental staleness, safety sparsity, source-risk coverage gaps, or coverage-audit age as public outages unless a later release explicitly changes the status-impact rule.
- Stop if `cache['yield-history-cleanup:writer-pause']` is armed; use the writer-pause runbook before expecting hourly yield publication to advance.

## Validation

- `GET /api/status` returns `yieldHealth` without `sectionErrors.yieldHealth`.
- The admin Pipeline Yield Health card shows the expected field status and status-impact label.
- If rankings were stale, `GET /api/yield-rankings` returns `200`, non-empty `rankings`, and a fresh `updatedAt` after recovery.
- If the latest generation failed, `yield_publication_generations.failure_reason` explains the failure while the previous public cache remains valid.
- Supplemental, benchmark, and coverage-audit fields move back to `healthy` or an understood `degraded` state after their owning cron/cache recovers.
- Source-risk coverage shows the expected ratios for `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, and `sourceRiskScore`.

## Rollback Notes

Rollback of the health card is a Worker/frontend rollback only; it does not alter yield D1 rows or caches. If the summary loader fails after deploy, `/api/status` returns `yieldHealth: null` with `sectionErrors.yieldHealth`, while existing cron cards, cache tables, and yield APIs continue to operate.

## Prevention

- Keep `yield-rankings` freshness tied to the hourly `sync-yield-data` producer.
- Keep source-family sparsity admin-watch by default; promote only explicitly documented critical families.
- Do not change yield scoring or source arbitration from the status surface. Status reads existing cache/cron metadata only.
