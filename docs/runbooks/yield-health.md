# Runbook: Yield Health

Triggered by `/api/status` field:
- `yieldHealth.statusImpact="public-critical"` when `yield-rankings` is missing or stale
- `yieldHealth.status` is `"degraded"` or `"stale"` while `statusImpact` stays `"admin-watch"` for input-quality, safety, supplemental, benchmark, audit, or source-risk diagnostics. Supplemental, audit and live-safety checks can make the aggregate stale; the benchmark rollup caps at degraded. Comparison anchors are field-level watch signals only.

## Symptom

The Pipeline lane shows permanent, read-only Yield Health diagnostics. Ranking freshness can affect public status; family sparsity, benchmark/source-risk gaps, comparison anchors and monthly audit backlog are operator-watch evidence with no pending promotion.

## Impact

- `public-critical`: stale or missing `yield-rankings` can make `/yield/`, stablecoin yield panels, and `GET /api/yield-rankings` stale or unavailable.
- `admin-watch`: sparse safety coverage, stale supplemental coverage, benchmark fallback, low source-risk evidence coverage, stale comparison anchors, and old coverage-audit data reduce operator confidence but do not by themselves change public status.
- Yield Health is read-only. It does not change scoring, source arbitration, publication eligibility, or methodology.
- Yield served-generation freshness is separate from safety evidence age and input quality. Every applied publication advances its atomic sentinel; held safety is advisory inside both 24-hour clocks, while expired held evidence, unknown publication health, and below-floor safety coverage still degrade public health.

## First checks

1. **Rankings cache:** inspect `yieldHealth.rankingUpdatedAt`, `rankingAgeSec`, `rankingStatus`, `previousRankingCount`, and `rankingCountDelta` in `/api/status`.
2. **Publisher cron:** inspect `crons["sync-yield-data"]` for latest status, error, metadata, and in-flight lease state.
3. **Safety coverage:** inspect `yieldHealth.safetyCoverage`; below `0.75` means the cached publisher safety snapshot was sparse, not a read-time hydration measurement. `liveSafetyHydration` separately checks live compatibility and fallback availability.
4. **Supplemental cache:** inspect `yieldHealth.supplemental`; `familyCount`, `freshFamilyCount`, `degradedFamilyCount`, `staleFamilyCount`, `missingFamilyCount`, and `families` identify which optional source families are stale or absent. A fresh family row with `sourceCount: 0` is valid evidence that the family ran and found no candidates and is flagged `fresh but empty` on the card; `degradedFamilies` (from the `yield:supplemental-source-run:v1` outcome row) names families that kept their previous snapshot after a degraded producer run. A missing family row means the family did not publish its health marker. Age above 6h means optional source families may be sparse. For throughput misses, inspect the latest `sync-yield-supplemental` metadata `sourceCoverage.sourceFamilySummaries`; missing-target examples are intentionally bounded.
5. **Benchmarks:** inspect `yieldHealth.benchmarkRegistry`. Each used key is classified from its own feed evidence only: a fallback (`isFallback`/`fallbackMode`) or a published row using an undefined key degrades the entry, and a missing entry, fetch age above 48h, or observation (`recordDate`) age past the key's bound in `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `worker/src/cron/yield-sync/benchmarks.ts` (5d daily/overnight series, 7d CHF, 10d TRY, 12d RUB, 45d CAD monthly) makes it stale. Documented proxy selection is reported as `proxySelectionRowCount` and never gates the entry or the aggregate; fetched-but-unused keys are listed under `unusedBenchmarkKeys`, also without gating status.
6. **Source-risk coverage:** inspect `yieldHealth.sourceRiskCoverage`; core fields below 75% coverage are admin-watch gaps. Ratios are measured over per-field eligible rows only (depth and tier exclude rows whose venue is the asset itself — the `price-derived`/`rate-derived` derivation methods and the `native-wrapper`/`issuer-savings` issuer rails; `rewardShare` counts only split-capable lanes), with best-row and alt-row ratios reported separately; an empty denominator reports `null`, never 100%. `venueRiskTier="unknown"` counts as missing evidence, not high risk.
7. **Comparison anchors:** inspect stale count and bounded examples with their original `maxAgeSeconds` budgets and `sourceRunStartedAt`. The oldest fields describe the oldest overall anchor, not necessarily a stale one.
8. **Coverage audit:** inspect `yieldHealth.coverageAudit`; age above 45d means the monthly coverage review is late. Gap/candidate counts and bounded lists are read-only triage evidence. `venue-risk-config-missing` requires reviewed venue-risk evidence; `stale-venue-risk-score` requires a fresh review; `stale-auto-lending-override` requires pin removal, repointing, or a written bypass review. New audits no longer emit `quarantine-ready-to-restore`; retained historical items do not authorize source restoration. `reviewDueAdapters` / `lifecycleReviewDueCount` remain real lifecycle review signals. Curated missing native/variant/weighted pools carry `missing-pool` plus `coverage-outage` or `dead-config` and emit `curated-pin-missing`.

Applied publisher runs are `ok`; imperfect required inputs are in `metadata.quality.reasons`, while unapplied work is `degraded` with `metadata.reason`. Pendle-only loss goes in `metadata.quality.advisoryReasons`, leaves `quality.degraded` false, and affects the supplemental tile, not the public producer verdict. Retired optional families are not current status telemetry.

Coverage budgets measure unresolved post-review work before display truncation: `queueBudgetBasis: "post-disposition"` uses `operatorReviewSummary.visibleHeadlineGapCount` and `visibleRecommendationCandidateCount`, including dead-pin and restoration items once through their queue entries. Older reports fall back to raw detector totals and explicitly report `queueBudgetBasis: "raw-detectors"` until refreshed. Status shows at most six items per side; the report's `operatorQueue` shows twenty per side; applicable raw headline arrays cap at fifty. These are samples, not queue totals. `staleVenueRiskScores` is complete and uncapped because it comes from the finite venue registry.

The queue is permanently DISPLAY-ONLY: no disposition UI/API is authorized. `totalItemCount = publishedItemCount + truncatedItemCount` measures the full visible post-review cohort before caps (for example 146 = 40 + 106); candidate count adds suppression. `byKindScope="full-visible"` is pre-cap, while older report `published-sample` counts cannot be interpreted as full totals. Human review remains a reviewed source/config change, not an API action.

`liveSafetyHydration` reads the canonical compact index and publication health, not identity alone. Held/unavailable branches may use stamped safety only inside BOTH original yield/safety 24-hour clocks; `safety-score-index-*` integrity failures never fall back. Both publication clocks, their ages and budget are reported; failed read is unknown. `pysInputs` requires both finite nonnegative integer publisher counters and a nonzero denominator; incomplete/malformed/zero cohorts are unknown with reason and source run, not proof of table completeness. The card shows all eleven source-risk fields, with eligible best/alternate denominators and null=N/A.

Access-gated surfaces:

- Browser: `https://ops.pharos.watch/admin/` -> Pipeline -> Yield Health
- Machine API: `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers

## Threshold Table

| Surface | Owner cron/cache | Warn threshold | Stale threshold | Public-critical impact | Admin-watch impact | Related runbook |
| --- | --- | --- | --- | --- | --- | --- |
| Rankings freshness | `sync-yield-data` -> `cache['yield-rankings']` | Age above 2 post-V9 producer intervals (the ADR-9 `yield-data` band, same as public `/status/`) | Missing payload or age above 4 post-V9 producer intervals | Yes, when stale or missing | Degraded-but-not-stale rankings remain watch-only | [stale or missing rankings](./yield-rankings-stale-or-missing.md) |
| Safety coverage | Cached publisher `yield-rankings.provenance.safetySnapshot` | Coverage below 75% | No separate stale tier | No | Sparse publish-time safety evidence degrades Yield Health; live hydration is separate | This runbook |
| Live safety hydration | Canonical compact index/health and stamped yield safety provenance | Held/unavailable or incompatible identity fallback | Either original publication clock exceeds 24h, or index integrity fails: no fallback | No | Permanent parity diagnostic; failed read is unknown | [stale or missing rankings](./yield-rankings-stale-or-missing.md) |
| Supplemental source age | `sync-yield-supplemental` -> `yield:supplemental-sources:v1:*` | Above the family `maxAgeSec` (6h default, 48h Pendle), or unavailable/retained-degraded evidence | Above 12× the family budget (72h default, 576h Pendle) | No | Admin-watch only; fresh `sourceCount: 0` is valid empty evidence. Producer candidate acceptance expires at `maxAgeSec`, before this admin stale tier | [supplemental snapshot](./yield-supplemental-snapshot.md) |
| Used benchmark registry | `sync-yield-data` ranking + benchmark provenance | Feed-level only: the entry is a fallback (`isFallback`/`fallbackMode`), or any published row uses a benchmark key the registry does not define | Missing entry, fetch age above 48h, or observation (`recordDate`) age above the key's bound in `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `worker/src/cron/yield-sync/benchmarks.ts` (5d daily/overnight series, 7d CHF, 10d TRY, 12d RUB, 45d CAD monthly) | No | Documented proxy selection is reported as `proxySelectionRowCount`, never as feed health; fetched-but-unused keys are listed in `unusedBenchmarkKeys` and never gate status | [benchmark fallback](./yield-benchmark-fallback-stale.md) |
| Coverage audit age and queue backlog | `yield-coverage-audit` -> `cache['yield-coverage-audit']` | Age above 45d or missing audit, or backlog above the drain budget of 150 headline gaps / 100 recommendation candidates per cycle (`coverageAudit.queueBudget`) | Age above 540d | No | Late monthly review, unavailable queue, or an undrainable backlog stays watch-only; the rendered queue is display-only and reports `queueTotals.byKind`, `suppressedItemCount` and `truncated` | This runbook |
| PYS input persistence | Publisher `publicationStats` counters | Null share above 5% of measured rows | No separate stale tier | No | Missing, invalid, one-sided or zero-denominator counters are unknown/null, not healthy; metadata is not a readback audit | This runbook |
| Source-risk coverage | `sync-yield-data` published `sourceRisk.*` rows and retained alternates | Any core field below 75% coverage **of eligible rows**: `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, `sourceRiskScore`. Eligibility excludes rows whose venue is the asset itself (`price-derived`/`rate-derived` derivation methods, plus the issuer rails `native-wrapper`/`issuer-savings`) from depth and tier, and rows publishing one undivided rate (no provider split and no `apyReward`) from `rewardShare`. Genuine third-party venues (`strategy-vault`, `lending-market`) stay in the denominator and queue as `venue-risk-config-missing`. A penalty counts as evidenced only with two independent evidence families | No separate stale tier; an empty denominator reports `null`, never 100% | No | Missing neutral-fallback evidence degrades Yield Health; best-row and alt-row ratios are reported separately | This runbook |
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
- **Coverage-audit queue:** record `accept`, `dismiss`, `intentional-gap`, or `watch` in the operator note; no disposition UI/API is authorized. New audits no longer emit `quarantine-ready-to-restore`. Preserve historical decoder/fingerprints/disposition text until a named refreshed report and full pre-cap zero-current-kind evidence close its reader floor. After BIMA variant retirement, only a new normal monthly report or separately authorized leased refresh proves stale-item clearance. An hourly publication cannot clear the monthly cached report.
- **Dead curated pins and review-due adapters:** treat `missing-pool` headline items with a `coverage-outage` reason code as coverage incidents and `dead-config` items as config cleanup; classify `lifecycle-review-due` adapters in the same audit cycle instead of leaving past-due review dates in the registry.
- **Old coverage audit:** inspect `yield-coverage-audit` cron history. It is monthly and watch-tier, so a late audit is a review backlog, not a public outage.
- **Unavailable supply input:** missing or malformed `stablecoins` supply cache defers audit publication with `stablecoins-cache-missing` or `stablecoins-cache-malformed` and preserves the prior report. Restore the readable supply cache before replaying; absolute floors are not a substitute for unavailable supply-relative gates.

### Recompute after a coverage drain

Deploy reviewed pool mappings, lending allowlist entries, and stale-pin removals before requesting a fresh report. The monthly `0 6 1 * *` run remains unchanged.

```bash
curl --fail-with-body --max-time 360 -X POST \
  https://ops-api.pharos.watch/api/trigger-yield-coverage-audit \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1"
```

This authenticated action waits for the existing audit under its normal job lease and connection allocation. It writes a normal `yield-coverage-audit` cron run and reports `200` on completion, `409` on lease contention, and `503` when inputs defer or degrade the audit. Exceptions return `500`. Keep the connection open; the route does not run the audit in post-response `waitUntil()`. If the client or proxy times out, inspect cron history and the cache timestamp before retrying. Never clear an active audit lease. Do not trigger within about ten minutes of 06:00 UTC on the first of the month: a manual run in flight at that moment holds the same lease and can push the monthly run into `skipped_locked`.

After `200`, repeat the read-only status request above. Require `coverageAudit.updatedAt` to advance, `queueBudgetBasis: "post-disposition"`, `headlineGapCount <= 150`, `recommendationCandidateCount <= 100`, and no audit section error. The HTTP response confirms execution, not a healthy coverage verdict. Reviewed dispositions suppress unchanged work before queue-budget health is assessed; display truncation does not lower those totals. Date-sensitive venue-risk reviews may cross their 90-day cadence before the next monthly run, so a healthy manual replay does not guarantee the next month's result.

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
- Yield cache `generationId` / `publishedAt` match rankings and `freshness:yield-data` after an applied publication, including imperfect inputs. Safety provenance retains its original clock and `maxAgeSeconds: 86400`; same-identity held evidence is healthy only inside both 24-hour budgets.
- Supplemental, benchmark, ranking-delta, and coverage-audit fields move back to `healthy` or an understood `degraded` state after their owning cron/cache recovers.
- Source-risk coverage shows the expected ratios for `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, and `sourceRiskScore`.
- Comparison-anchor freshness reports the oldest overall anchor age/source, bounded stale examples with original source budgets, and producer run provenance.

## Rollback Notes

Rollback of the health card is a Worker/frontend rollback only; it does not alter yield D1 rows or caches. If the summary loader fails after deploy, `/api/status` returns `yieldHealth: null` with `sectionErrors.yieldHealth`, while existing cron cards, cache tables, and yield APIs continue to operate.

## Prevention

- Keep `yield-rankings` freshness tied to the post-V9 `sync-yield-data` producer.
- Keep source-family sparsity admin-watch by default; promote only explicitly documented critical families.
- Do not change yield scoring or source arbitration from the status surface. Status reads existing cache/cron metadata only.
