# Runbook: Yield Health

Triggered by `/api/status` field:
- `yieldHealth.statusImpact="public-critical"` when `yield-rankings` is missing or stale
- `yieldHealth.status` is `"degraded"` (or `"stale"` once a supplemental or coverage-audit surface passes its stale threshold — the benchmark rollup caps at degraded, `buildBenchmarkRegistryHealth` in `worker/src/lib/status/yield-health.ts`, and never turns the aggregate stale) while `statusImpact` stays `"admin-watch"` for admin-watch yield diagnostics such as sparse safety coverage, stale supplemental cache, benchmark fallback, old coverage audit, or low source-risk evidence coverage; stale comparison anchors are exposed as field-level watch signals, but do not by themselves change the aggregate `yieldHealth.status`

## Symptom

The admin Pipeline lane shows stale or degraded Yield Health. Public impact is limited to stale or missing `yield-rankings`; source-family sparsity, supplemental staleness, benchmark fallback, source-risk evidence gaps, comparison-anchor freshness, and old coverage-audit data are operator-watch signals unless a later rollout explicitly promotes them.

## Impact

- `public-critical`: stale or missing `yield-rankings` can make `/yield/`, stablecoin yield panels, and `GET /api/yield-rankings` stale or unavailable.
- `admin-watch`: sparse safety coverage, stale supplemental coverage, benchmark fallback, low source-risk evidence coverage, stale comparison anchors, and old coverage-audit data reduce operator confidence but do not by themselves change public status.
- Yield Health is read-only. It does not change scoring, source arbitration, publication eligibility, or methodology.

## First checks

1. **Rankings cache:** inspect `yieldHealth.rankingUpdatedAt`, `rankingAgeSec`, `rankingStatus`, `previousRankingCount`, and `rankingCountDelta` in `/api/status`.
2. **Publisher cron:** inspect `crons["sync-yield-data"]` for latest status, error, metadata, and in-flight lease state.
3. **Safety coverage:** inspect `yieldHealth.safetyCoverage`; coverage below `0.75` means read-time report-card hydration is sparse.
4. **Supplemental cache:** inspect `yieldHealth.supplemental`; `familyCount`, `freshFamilyCount`, `degradedFamilyCount`, `staleFamilyCount`, `missingFamilyCount`, and `families` identify which optional source families are stale or absent. A fresh family row with `sourceCount: 0` is valid evidence that the family ran and found no candidates and is flagged `fresh but empty` on the card; `degradedFamilies` (from the `yield:supplemental-source-run:v1` outcome row) names families that kept their previous snapshot after a degraded producer run. A missing family row means the family did not publish its health marker. Age above 6h means optional source families may be sparse. For throughput misses, inspect the latest `sync-yield-supplemental` metadata `sourceCoverage.sourceFamilySummaries`; missing-target examples are intentionally bounded.
5. **Benchmarks:** inspect `yieldHealth.benchmarkRegistry` first, then the legacy USD-only `yieldHealth.benchmark` field. Each used key is classified from its own feed evidence only: a fallback (`isFallback`/`fallbackMode`) or a published row using an undefined key degrades the entry, and a missing entry, fetch age above 48h, or observation (`recordDate`) age past the key's bound in `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `worker/src/cron/yield-sync/benchmarks.ts` (5d daily/overnight series, 7d CHF, 10d TRY, 12d RUB, 45d CAD monthly) makes it stale. Documented proxy selection is reported as `proxySelectionRowCount` and never gates the entry or the aggregate; fetched-but-unused keys are listed under `unusedBenchmarkKeys`, also without gating status.
6. **Source-risk coverage:** inspect `yieldHealth.sourceRiskCoverage`; core fields below 75% coverage are admin-watch gaps. Ratios are measured over per-field eligible rows only (depth and tier exclude rows whose venue is the asset itself; `rewardShare` counts only split-capable lanes), with best-row and alt-row ratios reported separately; an empty denominator reports `null`, never 100%. `venueRiskTier="unknown"` counts as missing evidence, not high risk.
7. **Comparison anchors:** inspect `yieldHealth.comparisonAnchorFreshness`; any `staleAnchorCount > 0` is an admin-watch signal. `oldestAnchorAgeSeconds`, `oldestAnchorStablecoinId`, `oldestAnchorSourceKey`, and bounded `staleAnchorExamples` identify the affected derived-source rows.
8. **Coverage audit:** inspect `yieldHealth.coverageAudit`; age above 45d means the monthly coverage review is late. `headlineGapCount`, `recommendationCandidateCount`, `staleAutoLendingOverrideCount`, `venueRiskConfigMissingCount`, `headlineGaps`, and `recommendationCandidates` are the read-only triage queue. Candidate kind `venue-risk-config-missing` means a covered high-TVL venue slug (allowlisted lending protocol or curated exact covered pool) is missing a reviewed venue-risk registry entry or alias; candidate kind `quarantine-ready-to-restore` means a monthly quarantine re-probe succeeded and still requires manual source restoration; candidate kind `stale-venue-risk-score` means a reviewed venue's 5-category risk score is older than 90 days and should be re-verified (audits, governance, TVL); headline kind `stale-auto-lending-override` means a deterministic lending pin no longer clears current static gates and needs removal, repointing, or a written bypass review. `coverageAudit.queueTotals` (`byKind`, `suppressedItemCount`, `truncated`) accounts for every candidate item against the drain budget `coverageAudit.queueBudget` (150 headline gaps / 100 recommendation candidates), and an over-budget queue degrades a fresh audit. `reviewDueAdapters` / `lifecycleReviewDueCount` surface quarantined or intentional-gap adapters whose review date has arrived. Curated native/variant/weighted pins whose DeFiLlama pool has disappeared are queued as `stale-auto-lending-override` items whose `reasonCodes` carry `missing-pool` plus `coverage-outage` or `dead-config` (`native-exact-pool` items are per asset, id `native-exact-pool:<stablecoinId>`); the audit emits the `curated-pin-missing` and `lifecycle-review-due` cron events after its cache write.

Access-gated surfaces:

- Browser: `https://ops.pharos.watch/admin/` -> Pipeline -> Yield Health
- Machine API: `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers

## Threshold Table

| Surface | Owner cron/cache | Warn threshold | Stale threshold | Public-critical impact | Admin-watch impact | Related runbook |
| --- | --- | --- | --- | --- | --- | --- |
| Rankings freshness | `sync-yield-data` -> `cache['yield-rankings']` | Age above 2 post-V9 producer intervals (the ADR-9 `yield-data` band, same as public `/status/`) | Missing payload or age above 4 post-V9 producer intervals | Yes, when stale or missing | Degraded-but-not-stale rankings remain watch-only | [stale or missing rankings](./yield-rankings-stale-or-missing.md) |
| Safety coverage | Read-time report-card hydration in `yield-rankings.provenance.safetySnapshot` | Coverage below 75% | No separate stale tier | No | Sparse safety evidence degrades Yield Health | This runbook |
| Live safety hydration | `yield-rankings.provenance.safetySnapshot.safetyScoreIdentity` vs the active V9 publication identity | Stamped identity missing, or the read path would serve the publish-time snapshot (`liveSafetyHydration.fallback`) | Fallback older than the 24h stale-coherent window: `/yield` serves unrated safety | No | Degraded hydration degrades Yield Health; `unknown` (identity unreadable) does not | [stale or missing rankings](./yield-rankings-stale-or-missing.md) |
| Supplemental source age | `sync-yield-supplemental` -> `yield:supplemental-sources:v1:*` | Any family age above 6h, or missing family cache when family rows exist | Age above 72h | No | Degraded or stale optional families reduce confidence only; a fresh family with `sourceCount: 0` is flagged `fresh but empty` on the card | [supplemental snapshot](./yield-supplemental-snapshot.md) |
| Used benchmark registry | `sync-yield-data` ranking + benchmark provenance | Feed-level only: the entry is a fallback (`isFallback`/`fallbackMode`), or any published row uses a benchmark key the registry does not define | Missing entry, fetch age above 48h, or observation (`recordDate`) age above the key's bound in `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `worker/src/cron/yield-sync/benchmarks.ts` (5d daily/overnight series, 7d CHF, 10d TRY, 12d RUB, 45d CAD monthly) | No | Documented proxy selection is reported as `proxySelectionRowCount`, never as feed health; fetched-but-unused keys are listed in `unusedBenchmarkKeys` and never gate status | [benchmark fallback](./yield-benchmark-fallback-stale.md) |
| Coverage audit age and queue backlog | `yield-coverage-audit` -> `cache['yield-coverage-audit']` | Age above 45d or missing audit, or backlog above the drain budget of 150 headline gaps / 100 recommendation candidates per cycle (`coverageAudit.queueBudget`) | Age above 540d | No | Late monthly review, unavailable queue, or an undrainable backlog stays watch-only; the rendered queue is display-only and reports `queueTotals.byKind`, `suppressedItemCount` and `truncated` | This runbook |
| PYS input persistence | `sync-yield-data` metadata `pysInputsPersistedCount` / `pysInputsNullCount` | More than 5% of published rows persisted no `pys_inputs_at_publish` | No separate stale tier | No | Lost reproducibility evidence degrades Yield Health; absent metadata reports `unknown` and does not gate | This runbook |
| Source-risk coverage | `sync-yield-data` published `sourceRisk.*` rows and retained alternates | Any core field below 75% coverage **of eligible rows**: `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, `sourceRiskScore`. Eligibility excludes rows whose venue is the asset itself (`price-derived`/`rate-derived`) from depth and tier, and rows publishing one undivided rate (no provider split and no `apyReward`) from `rewardShare`. A penalty counts as evidenced only with two independent evidence families | No separate stale tier; an empty denominator reports `null`, never 100% | No | Missing neutral-fallback evidence degrades Yield Health; best-row and alt-row ratios are reported separately | This runbook |
| Comparison-anchor freshness | `sync-yield-data` metadata `sourceCoverage.comparisonAnchorFreshness` | Any `staleAnchorCount > 0` | No separate stale tier | No | Field-level watch signal only; excluded from the aggregate `yieldHealth.status` rollup | This runbook |

Read-only JSON checks:

```bash
curl -fsS https://ops-api.pharos.watch/api/status \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  | jq '.yieldHealth | {status, statusImpact, rankingCount, previousRankingCount, rankingCountDelta, benchmarkRegistry, sourceRiskCoverage, comparisonAnchorFreshness, coverageAudit}'
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
WHERE key IN ('yield-rankings', 'yield-coverage-audit')
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

- **Missing/stale rankings:** check `sync-yield-data` cron errors first. Clear a stuck `sync-yield-data` lease only when the admin cron card shows repeated `skipped_locked` or stale in-flight progress, then let the next post-V9 publisher rebuild `yield-rankings`.
- **Sparse safety coverage:** inspect `safety-score-v9` publication health and `/api/report-cards/v9`; yield rankings can still publish with the explicit unrated safety fallback, but PYS quality is lower.
- **Stale supplemental cache:** inspect `sync-yield-supplemental`. Because supplemental sources are optional, do not block the public yield page solely on this signal.
- **Benchmark fallback/staleness:** inspect `yieldHealth.benchmarkRegistry`, then `risk_free_rates` and the latest `sync-yield-data` metadata for the named key. A retained fallback within 48h fetch age and inside the key's observation bound can remain score-bearing but degraded; past either bound the affected row is NR, and a degraded or stale USD reference additionally re-bases affected non-USD rows to estimated (`reference-benchmark-degraded`) or NR (`benchmark-stale`). Do not let a healthy USD lane close an incident for a stale non-USD key that still has published rows.
- **Low source-risk coverage:** inspect whether missing fields are absent from current rankings, retained alternates, or both. Missing or `unknown` venue tiers are evidence gaps; do not backfill guessed tiers.
- **Stale comparison anchors:** inspect `yieldHealth.comparisonAnchorFreshness.staleAnchorExamples` and the latest `sync-yield-data` metadata. This identifies rows whose derived APY is comparing against an old anchor; do not change arbitration or manually rewrite history rows solely to clear this watch signal.
- **Coverage-audit queue:** classify each headline gap or recommendation candidate from `yieldHealth.coverageAudit.headlineGaps` and `yieldHealth.coverageAudit.recommendationCandidates` as `accept`, `dismiss`, `intentional-gap`, or `watch` in the operator note for that audit cycle. Candidate kind `quarantine-ready-to-restore` identifies a successful quarantine re-probe for manual restoration review; it is not automatic source restoration. Headline kind `stale-auto-lending-override` identifies a deterministic auto-lending override whose current DeFiLlama row is missing or no longer clears static gates. `queuePersistence="durable"` means the visible queue reflects evidence-fingerprinted review dispositions; `queuePersistence="deferred"` means the queue is not backed by durable review dispositions and has no persistent dismissal state. A missing or malformed current `operatorQueue` is exposed as an empty deferred queue; legacy headline lists are not reconstructed.
- **Dead curated pins and review-due adapters:** treat `missing-pool` headline items with a `coverage-outage` reason code as coverage incidents and `dead-config` items as config cleanup; classify `lifecycle-review-due` adapters in the same audit cycle instead of leaving past-due review dates in the registry.
- **Old coverage audit:** inspect `yield-coverage-audit` cron history. It is monthly and watch-tier, so a late audit is a review backlog, not a public outage.

## Abort Conditions

- Do not manually edit `yield-rankings`, `yield_data`, `yield_history`, `yield_publication_generations`, or `yield_source_decisions` to make the health card green.
- Do not guess or manually backfill source-risk tiers. `venueRiskTier="unknown"` is intentionally treated as missing evidence.
- Do not clear a `sync-yield-data` or `sync-yield-supplemental` lease while `/api/status` shows a fresh active in-flight progress row.
- Do not treat supplemental staleness, safety sparsity, source-risk coverage gaps, comparison-anchor freshness, or coverage-audit age as public outages unless a later release explicitly changes the status-impact rule.
- Stop if `cache['yield-history-cleanup:writer-pause']` is armed; use [`yield-history-cleanup-writer-pause.md`](./yield-history-cleanup-writer-pause.md) before expecting post-V9 yield publication to advance.

## Validation

- `GET /api/status` returns `yieldHealth` without `sectionErrors.yieldHealth`.
- The admin Pipeline Yield Health card shows the expected field status and status-impact label.
- If rankings were stale, `GET /api/yield-rankings` returns `200`, non-empty `rankings`, and a fresh `updatedAt` after recovery.
- If the latest generation failed, `yield_publication_generations.failure_reason` explains the failure while the previous public cache remains valid.
- Supplemental, benchmark, ranking-delta, and coverage-audit fields move back to `healthy` or an understood `degraded` state after their owning cron/cache recovers.
- Source-risk coverage shows the expected ratios for `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, and `sourceRiskScore`.
- Comparison-anchor freshness shows the expected anchored row count, stale anchor count, oldest stale anchor age/source, and bounded stale examples from the latest sync metadata.

## Rollback Notes

Rollback of the health card is a Worker/frontend rollback only; it does not alter yield D1 rows or caches. If the summary loader fails after deploy, `/api/status` returns `yieldHealth: null` with `sectionErrors.yieldHealth`, while existing cron cards, cache tables, and yield APIs continue to operate.

## Prevention

- Keep `yield-rankings` freshness tied to the post-V9 `sync-yield-data` producer.
- Keep source-family sparsity admin-watch by default; promote only explicitly documented critical families.
- Do not change yield scoring or source arbitration from the status surface. Status reads existing cache/cron metadata only.
