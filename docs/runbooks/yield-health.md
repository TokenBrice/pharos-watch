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
- Served-generation freshness, safety evidence age, and input quality are separate under the [engineering publication/failure contract](../yield-intelligence.md#engineering-contract). Expired current or held evidence, unknown publication health, and below-floor safety coverage still degrade public health.

## First checks

This is the shared **read-only** entry check for yield incidents. Use the Access-gated browser at `https://ops.pharos.watch/admin/` -> Pipeline -> Yield Health (and Crons for job metadata), or `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers. The [JSON checks](#threshold-table) and [D1 snippets](#read-only-d1-snippets) below are inspection-only; follow the incident's own prerequisites and stop conditions before any recovery action. The separate [history cleanup writer-pause procedure](./yield-history-cleanup-writer-pause.md) retains its mutation authority and pause/readback requirements.

1. **Rankings cache:** inspect `yieldHealth.rankingUpdatedAt`, `rankingAgeSec`, `rankingStatus`, `previousRankingCount`, and `rankingCountDelta` in `/api/status`.
2. **Publisher cron:** inspect `crons["sync-yield-data"]` for latest status, error, metadata, and in-flight lease state.
   For all-fail/skip metadata, select [Deterministic All-Fail Cooldown](#deterministic-all-fail-cooldown) below.
3. **Safety coverage:** inspect `yieldHealth.safetyCoverage`; below `0.75` means the cached publisher safety snapshot was sparse, not a read-time hydration measurement. `liveSafetyHydration` separately checks live compatibility and fallback availability.
4. **Supplemental cache:** inspect `yieldHealth.supplemental.families` and family counts; use [supplemental validation](./yield-supplemental-snapshot.md#validation) for empty, retained and unknown outcomes, and `sourceCoverage.sourceFamilySummaries` for bounded misses.
5. **Benchmarks:** inspect `yieldHealth.benchmarkRegistry` using the [threshold table](#threshold-table) and [benchmark incident procedure](./yield-benchmark-fallback-stale.md). Proxy selection and unused keys do not gate registry health.
6. **Source-risk coverage:** inspect `yieldHealth.sourceRiskCoverage` against the table's eligible-row denominators, separately for best and alternate rows. The card shows all eleven fields; null means N/A, and an unknown venue tier means missing evidence, not high risk.
7. **Comparison anchors:** inspect stale count and bounded examples with their original `maxAgeSeconds` budgets and `sourceRunStartedAt`. The oldest fields describe the oldest overall anchor, not necessarily a stale one.
8. **Coverage audit:** inspect `yieldHealth.coverageAudit` and use [Coverage Audit Queue](../yield-intelligence-operations.md#coverage-audit-queue) for counts, reviewed source/config actions, stale pins and historical-reader floors. Bounded displayed rows are not backlog totals.

Read completion separately from input quality using the [publisher contract](../yield-intelligence.md#persistence-and-publication): inspect `metadata.reason`, `metadata.quality.reasons`, and `advisoryReasons`, including advisory Pendle findings. Retired optional families are not current status telemetry.

Coverage-budget basis, truncation and display-only handling are owned by [Coverage Audit Queue](../yield-intelligence-operations.md#coverage-audit-queue). `liveSafetyHydration` reports both original publication clocks, ages and budgets; use [Safety Identity Mismatch](./yield-rankings-stale-or-missing.md#safety-identity-mismatch) and [failure semantics](../yield-intelligence.md#failure-semantics) for compatibility/fallback diagnosis. Failed health reads remain unknown. `pysInputs` requires finite nonnegative integer publisher counters and a nonzero denominator; incomplete, malformed or zero cohorts are unknown with reason/source run, not a table-readback audit.

## Threshold Table

`STATUS_YIELD_HEALTH_THRESHOLDS` and `YIELD_BENCHMARK_SCORE_TTL_SEC` in `shared/lib/status-thresholds.ts` define the status budgets and benchmark fetch TTL. `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `shared/lib/yield-benchmark-freshness.ts` defines observation bounds; cite these definitions, not producer re-exports.

| Surface | Owner cron/cache | Warn threshold | Stale threshold | Public-critical impact | Admin-watch impact | Related runbook |
| --- | --- | --- | --- | --- | --- | --- |
| Rankings freshness | `sync-yield-data` -> `cache['yield-rankings']` | Age above 2 post-V9 producer intervals (the ADR-9 `yield-data` band, same as public `/status/`) | Missing payload or age above 4 post-V9 producer intervals | Yes, when stale or missing | Degraded-but-not-stale rankings remain watch-only | [stale or missing rankings](./yield-rankings-stale-or-missing.md) |
| Safety coverage | Cached publisher `yield-rankings.provenance.safetySnapshot` | Coverage below 75% | No separate stale tier | No | Sparse publish-time safety evidence degrades Yield Health; live hydration is separate | This runbook |
| Live safety hydration | Canonical compact index/health and stamped yield safety provenance | Held/unavailable or incompatible identity fallback | Original live safety clock exceeds the inclusive 24h budget; fallback additionally requires both original cached clocks within 24h. Invalid/future clocks and index-integrity failures earn no budget | No | Permanent serving-parity diagnostic; current-compatible identity alone cannot certify healthy. Failed read is unknown | [stale or missing rankings](./yield-rankings-stale-or-missing.md) |
| Supplemental source age | `sync-yield-supplemental` -> `yield:supplemental-sources:v1:*` | Above the family `maxAgeSec` (6h default, 48h Pendle), or unavailable/retained-degraded evidence | Above 12× the family budget (72h default, 576h Pendle) | No | Admin-watch only; fresh `sourceCount: 0` is valid empty evidence. Producer candidate acceptance expires at `maxAgeSec`, before this admin stale tier | [supplemental snapshot](./yield-supplemental-snapshot.md) |
| Used benchmark registry | `sync-yield-data` ranking + benchmark provenance | Feed-level only: the entry is a fallback (`isFallback`/`fallbackMode`), or any published row uses a benchmark key the registry does not define | Missing entry, missing/unparseable required `recordDate`, observation more than 5 minutes in the future, fetch age above 48h, or observation age above the key's bound in `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `shared/lib/yield-benchmark-freshness.ts` (5d daily/overnight series, 7d CHF, 10d TRY, 12d RUB, 45d CAD monthly) | No | Missing metadata is unknown, never healthy. Documented proxy selection is reported as `proxySelectionRowCount`, never as feed health; fetched-but-unused keys are listed in `unusedBenchmarkKeys` and never gate status | [benchmark fallback](./yield-benchmark-fallback-stale.md) |
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

For incident cron history, use this shared query with the incident's named jobs in `job IN (...)` and its stated row limit. Keep duration, error, and metadata together; narrow the predicate before applying the limit.

```sql
SELECT job, started_at, duration_ms, status, item_count, error, metadata
FROM cron_runs
WHERE job IN ('sync-yield-data', 'sync-yield-supplemental', 'fetch-tbill-rate', 'yield-coverage-audit')
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
- **Stale supplemental cache:** follow [Supplemental Snapshot](./yield-supplemental-snapshot.md); optional breadth alone does not block the public yield page.
- **Benchmark fallback/staleness:** follow [Benchmark remediation](./yield-benchmark-fallback-stale.md#remediation) for the named used key. Healthy USD evidence cannot close an incident for a stale non-USD key still used by rows.
- **Low source-risk coverage:** inspect whether missing fields are absent from current rankings, retained alternates, or both. Missing or `unknown` venue tiers are evidence gaps; do not backfill guessed tiers.
- **Stale comparison anchors:** inspect `yieldHealth.comparisonAnchorFreshness.staleAnchorExamples` and the latest `sync-yield-data` metadata. This identifies rows whose derived APY is comparing against an old anchor; do not change arbitration or manually rewrite history rows solely to clear this watch signal.
- **Coverage-audit queue, dead pins and review-due adapters:** follow [Coverage Audit Queue](../yield-intelligence-operations.md#coverage-audit-queue); use the leased replay below only after reviewed changes deploy.
- **Old coverage audit:** inspect `yield-coverage-audit` cron history. It is monthly and watch-tier, so a late audit is a review backlog, not a public outage.
- **Unavailable supply input:** missing or malformed `stablecoins` supply cache defers audit publication with `stablecoins-cache-missing` or `stablecoins-cache-malformed` and preserves the prior report. Restore the readable supply cache before replaying; absolute floors are not a substitute for unavailable supply-relative gates.

### Deterministic All-Fail Cooldown

Select this branch when `sync-yield-data.sourceCoverage` reports `onChainAllDeterministicFailed`, `onChainCooldownTriggered` or `onChainSkippedDueToCooldown`, quality reasons name `onchain-rates:all-deterministic-failed` / `onchain-rates:cooldown-coverage-gap`, or the health cache has `cooldownUntil`.

Two consecutive all-fail runs fully masked by non-onchain alternatives can arm a six-hour cooldown. Native deterministic rows may disappear or use lower-confidence alternatives while other rows publish. Start with the [read-only checks](#first-checks), then inspect the newest eight `sync-yield-data` runs with the [shared cron query](#read-only-d1-snippets) and affected public-row provenance.

```sql
SELECT key, updated_at, value
FROM cache
WHERE key = 'yield:onchain-health:v1';
```

```sql
SELECT stablecoin_id, source_key, data_source, yield_source, current_apy, updated_at
FROM yield_data
WHERE data_source IN ('onchain', 'rate-derived')
ORDER BY updated_at DESC
LIMIT 30;
```

- Leave an active, fully masked cooldown alone; it protects publication runtime. A coverage gap resets cooldown and retries deterministic reads on the next post-V9 cycle.
- Persistent RPC/empty-`eth_call` and explorer failures require provider status and `ETHERSCAN_API_KEY` checks through normal secret/config handling. Inspect RPC-versus-explorer buckets and fallback ordering in [Runtime Guardrails](../yield-intelligence-operations.md#runtime-guardrails).
- Clear a genuinely stale `sync-yield-data` lease only under [lease recovery](./lease-and-breaker-recovery.md), never while fresh in-flight progress exists.
- Never edit/delete `yield:onchain-health:v1` to force reads, add APY/supply overrides, or change source-risk/scoring as cooldown remediation.
- Readback requires no active cooldown, a valid decreasing cooldown, or reset after successful reads; `onChainRatesResolved > 0` after recovery or `onChainFailureMaskedByAlternativeCoverage: true` while protected; and non-empty rankings with honest source/provenance.

Cooldown self-expires and resets on successful deterministic reads. If a deploy introduced persistent all-fail behavior, roll back the Worker; never override cached APY rows.


### Recompute after a coverage drain

Deploy reviewed pool mappings, lending allowlist entries, and stale-pin removals before requesting a fresh report. The monthly `0 6 1 * *` run remains unchanged.

```bash
curl --fail-with-body --max-time 360 -X POST \
  https://ops-api.pharos.watch/api/trigger-yield-coverage-audit \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1"
```

This authenticated action waits for the existing audit under its normal job lease and connection allocation. It writes a normal `yield-coverage-audit` cron run and reports `200` on completion, `409` on lease contention, and `503` when inputs defer or degrade the audit. Unkeyed exceptions return `500`; with an `Idempotency-Key`, a thrown or 5xx handler result becomes a keyed `503` `execution_unknown` that replays rather than reruns. Keep the connection open; the route does not run the audit in post-response `waitUntil()`. If the client or proxy times out, inspect cron history and the cache timestamp before retrying. Never clear an active audit lease. Do not trigger within about ten minutes of 06:00 UTC on the first of the month: a manual run in flight at that moment holds the same lease and can push the monthly run into `skipped_locked`.

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
- Yield cache `generationId` / `publishedAt` match rankings and `freshness:yield-data` after an applied publication, including imperfect inputs. Safety provenance retains its original clock and `maxAgeSeconds: 86400`: current live safety is admitted through age 86400 and expires at 86401 even if identity still matches; held/publish-time fallback additionally needs the original yield clock inside the same budget. A yield refresh never renews safety time. Check fresh APY remains available while expired safety/PYS becomes NR, and warm coin-cohort coverage agrees with detailed/summary responses at the live deadline.
- Supplemental, benchmark, ranking-delta, and coverage-audit fields move back to `healthy` or an understood `degraded` state after their owning cron/cache recovers.
- Source-risk coverage shows the expected ratios for `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, and `sourceRiskScore`.
- Comparison-anchor freshness reports the oldest overall anchor age/source, bounded stale examples with original source budgets, and producer run provenance.

## Rollback Notes

Rollback of the health card is a Worker/frontend rollback only; it does not alter yield D1 rows or caches. If the summary loader fails after deploy, `/api/status` returns `yieldHealth: null` with `sectionErrors.yieldHealth`, while existing cron cards, cache tables, and yield APIs continue to operate.

## Prevention

- Keep `yield-rankings` freshness tied to the post-V9 `sync-yield-data` producer.
- Keep source-family sparsity admin-watch by default; promote only explicitly documented critical families.
- Do not change yield scoring or source arbitration from the status surface. Status reads existing cache/cron metadata only.
