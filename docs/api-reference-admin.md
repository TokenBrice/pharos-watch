# Pharos API Admin Reference

> **Agent navigation** — Internal operator reference. Grep the heading or route you need: Admin Auth And Idempotency · Admin Endpoints.

This operator-only companion to [api-reference.md](./api-reference.md) is not published through `/docs/` or listed in `PUBLIC_DOCS`.

## Admin Auth And Idempotency

Admin endpoints are authenticated only on the `ops-api.pharos.watch` host. Cloudflare Access must authenticate the caller first, then inject `Cf-Access-Jwt-Assertion` for the worker. `worker/src/lib/auth.ts` verifies that JWT against the configured Access audience (`CF_ACCESS_OPS_API_AUD`) and team domain (`CF_ACCESS_TEAM_DOMAIN`) via `shared/lib/cloudflare-access-jwt.ts`, including signature, `aud`, `exp`, and `iss` checks. Browser operators should use `https://ops.pharos.watch/admin/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access; the Pages proxy verifies the inbound UI Access token against `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD`, requires an interactive Access token (`type: "app"`), and accepts the token from `Cf-Access-Jwt-Assertion` when Cloudflare forwards it or from the same-origin `cf-access-token` / `CF_Authorization` carrier when the browser is operating off an existing Access session. Mutating requests still require same-origin `Origin`.

Mutating admin calls also require `X-Pharos-Admin: 1` after Cloudflare Access authentication. Browser proxy calls forward that header from the operator UI and additionally require same-origin `Origin`; direct `ops-api` automation must send the header along with the Access service-token credentials.

The website-internal read lane is separate from Cloudflare Access. `site-api.pharos.watch` accepts allowlisted `GET` public-read paths plus the internal `POST /api/telegram-adoption` mutation and requires `X-Pharos-Site-Proxy-Secret`, which Pages proxies inject server-to-server from `SITE_API_SHARED_SECRET`. All Pages hosts — production and preview — must configure `SITE_API_ORIGIN=https://site-api.pharos.watch` (or a Worker preview URL that accepts the site-data secret); the Pages proxies fail closed with `500` when that binding is missing. The `/_site-data/*` lane additionally accepts requests only when the browser `Origin` header (or `Referer` as a fallback) matches `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, or a subdomain of `stablecoin-dashboard.pages.dev`. Public browser traffic must not call `site-api.pharos.watch` directly.

Many router-dispatched mutating admin endpoints also support optional `Idempotency-Key` handling. Current idempotent routes are:

- `POST /api/backfill-depegs`
- `POST /api/backfill-supply-history`
- `POST /api/backfill-stability-index`
- `POST /api/backfill-cg-prices`
- `POST /api/backfill-yield-history`
- `POST /api/backfill-mint-burn-prices` (only when `dry-run=false`)
- `POST /api/backfill-mint-burn`
- `POST /api/backfill-tape`
- `POST /api/reclassify-atomic-roundtrips`
- `POST /api/backfill-dews`
- `POST /api/audit-depeg-history`
- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `POST /api/remediate-blacklist-amount-gaps`
- `POST /api/backfill-blacklist-current-balances`
- `POST /api/admin-telegram-broadcast`
- `POST /api/api-key-requests-admin/:requestId/reject`
- `POST /api/api-key-requests-admin/:requestId/release-claim`
- `POST /api/api-keys`
- `POST /api/api-keys/:id/update`
- `POST /api/api-keys/:id/deactivate`
- `POST /api/api-keys/:id/rotate`

When an `Idempotency-Key` is supplied on one of those routes, the worker fingerprints the request and reserves the key with owner/generation fencing before execution. Terminal responses echo `Idempotency-Key` plus `X-Idempotent-Replay`; a stored terminal response is replayed without rerunning the action, while reuse with a different request fingerprint returns `409`. Only an abandoned reservation whose execution never started can be reclaimed after its takeover window.

Once execution has been marked as started, an unconfirmed outcome is never retried automatically. An in-flight duplicate, a handler throw after that point, or a terminal response that cannot be confirmed as persisted returns `503` with `error: "execution_unknown"`; subsequent requests with the same key also return `503` with `X-Idempotent-Replay: true` and do not invoke the handler again. Operators must reconcile whether the external effect occurred before deciding whether to submit a new idempotency key.

The worker’s idempotent admin route helpers now authenticate first and only then enter idempotency bookkeeping. That keeps the helper contract aligned with its name and prevents future admin endpoints from accidentally becoming “idempotent but unauthenticated” through wrapper misuse.

The `/admin/` UI now sends an `Idempotency-Key` automatically for supported manual actions so double-submits from the operator surface replay safely.

---

## Admin Endpoints

Preferred operator access now splits by surface:

- Browser / human operators: use `https://ops.pharos.watch/admin/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access.
- CLI / automation: call `https://ops-api.pharos.watch/api/...` with `CF-Access-Client-Id` and `CF-Access-Client-Secret` so Cloudflare Access can mint the request JWT the worker verifies. Direct `ops-api` requests also work with Cloudflare Access user/JWT headers.

Endpoint sections below do not repeat the CLI header pair. Unless an endpoint says otherwise, direct operator examples assume the `ops-api` host plus those two Cloudflare Access service-token headers.

### `GET /api/status`

Full admin dashboard: cron run history, cache freshness for all keys, data quality metrics, Telegram bot subscriber stats, and operator reconciliation signals.

**Preferred access:**

- Browser: `https://ops.pharos.watch/admin/` -> same-origin `/api/admin/status`
- CLI: `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` against `https://ops-api.pharos.watch/api/status`

**Response shape:** `StatusResponse` (exported through `shared/types/index.ts`). The JSON below is illustrative rather than exhaustive; the canonical field list lives in `shared/types/status/response.ts`, with `shared/types/status.ts` retained as its compatibility barrel. It currently includes diagnostics such as `summary.transitionsLast24h`, `priceProviderDiagnostics`, `gtProbe`, `cacheBlobSizes`, `yieldHealth`, `publicationHealth`, `providerCircuitHealth`, `canaries`, `dependencyHealth`, `reserveDrift`, `classificationWarnings`, and `reserveComposition.persistentlyStaleIndependentCoins`.

```text
{
  "timestamp": 1771856453,
  "dbHealthy": true,
  "availabilityStatus": "healthy",
  "dataQualityStatus": "healthy",
  "rawOverallStatus": "healthy",
  "overallStatus": "healthy",
  "confidence": 0.94,
  "causes": {
    "availability": [{ "code": "watch_unhealthy_crons_present", "severity": "info" }],
    "dataQuality": [],
    "overall": [{ "code": "watch_unhealthy_crons_present", "severity": "info" }]
  },
  "state": {
    "currentStatus": "healthy",
    "rawStatus": "healthy",
    "lastEvaluatedAt": 1771856453,
    "lastChangedAt": 1771856200,
    "consecutiveRaw": { "healthy": 3, "degraded": 0, "stale": 0 }
  },
  "staleness": { "ageSeconds": 0, "maxAgeSec": 1800, "isStale": false },
  "probe": {
    "timestamp": 1771856440,
    "status": "healthy",
    "sampleCount": 22,
    "passCount": 22,
    "failCount": 0,
    "p95LatencyMs": 301,
    "internal": {
      "status": "healthy",
      "sampleCount": 19,
      "passCount": 19,
      "failCount": 0,
      "p95LatencyMs": 92,
      "origins": ["https://api.pharos.watch"]
    },
    "external": {
      "status": "healthy",
      "sampleCount": 3,
      "passCount": 3,
      "failCount": 0,
      "p95LatencyMs": 301,
      "origins": [
        "https://api.pharos.watch",
        "https://site-api.pharos.watch",
        "https://ops-api.pharos.watch"
      ]
    },
    "internalExternalDiscrepancy": {
      "hasDivergence": false,
      "severityDelta": 0,
      "internalStatus": "healthy",
      "externalStatus": "healthy",
      "reason": "in-sync",
      "details": null
    }
  },
  "discrepancy": {
    "hasDivergence": false,
    "severityDelta": 0,
    "consecutiveDivergent": 0
  },
  "timeline": [
    {
      "id": 411,
      "from": "degraded",
      "to": "healthy",
      "rawStatus": "healthy",
      "transitionType": "recover",
      "reason": "raw-healthy-recovery-threshold",
      "confidence": 0.94,
      "at": 1771856200
    }
  ],
  "caches": { ... },
  "crons": {
    "sync-stablecoins": {
      "lastRun": { "startedAt": 1234567890, "durationMs": 2300, "status": "ok", "itemCount": 156 },
      "inFlight": null,
      "recentRuns": [...],
      "expectedIntervalSec": 900,
      "healthy": true
    }
  },
  "dataQuality": {
    "totalStablecoins": 156,
    "missingPrices": 3,
    "blacklistMissingAmounts": 0,
    "blacklistRecentMissingAmounts": 0,
    "blacklistRecentWindowSec": 86400,
    "blacklistMissingRatio": 0,
    "blacklistTotal": 13422,
    "blacklistOldestRecoverableAgeSec": 0,
    "blacklistNeverAttemptedCount": 0,
    "blacklistRepeatedFailureCount": 0,
    "onchainSupplyDivergences": 0,
    "onchainDivergenceRatio": 0,
    "onchainSupplyMonitoring": "active",
    "onchainSupplyLatestAt": 1771856300,
    "onchainSupplyTrackedCoins": 96,
    "activeDepegs": 12,
    "staleOnchainSupply": 0,
    "onchainStaleRatio": 0
  },
  "sectionErrors": {},
  "canaries": {
    "checkedAt": 1771856453,
    "status": "healthy",
    "latestRunAt": 1771856400,
    "maxAgeSec": 7200,
    "totalChecks": 6,
    "okCount": 6,
    "degradedCount": 0,
    "errorCount": 0,
    "skippedCount": 0,
    "staleCount": 0,
    "checks": {
      "dex-liquidity-current-publication": {
        "checkId": "dex-liquidity-current-publication",
        "label": "DEX liquidity current publication",
        "description": "Current DEX rows are published and match the latest published generation row count.",
        "status": "ok",
        "severity": "info",
        "observedAt": 1771856400,
        "durationMs": 12
      }
    }
  },
  "telegramBot": {
    "totalChats": 128,
    "alertEnabledChats": 123,
    "deliverableChats": 121,
    "subscribedChats": 124,
    "emptyAlertChats": 2,
    "mutedChatsWithSubscriptions": 3,
    "totalSubscriptions": 611,
    "explicitCoinSubscriptions": 560,
    "presetImpliedCoinSubscriptions": 51,
    "activePresetFollowers": 8,
    "avgSubscriptionsPerSubscribedChat": 4.9,
    "pendingDisambiguations": 1,
    "pendingDeliveries": 5,
    "oldestPendingDeliveryAgeSec": 240,
    "pendingDeliveryBacklog": {
      "claimable": 4,
      "due": 4,
      "deferred": 1,
      "sending": 0,
      "executionUnknown": 0,
      "sentCleanup": 0,
      "expired": 1
    },
    "retryErrorClassCounts": { "rate_limit": 2, "server_error": 1 },
    "lastSubscriberActivityAt": 1771856420,
    "customPreferenceChats": 47,
    "quietHoursEnabledChats": 18,
    "alertTypeChats": {
      "dews": 121,
      "depeg": 118,
      "launch": 97,
      "safety": 102,
      "allTypes": 95
    },
    "topStablecoins": [
      { "stablecoinId": "usdc-circle", "symbol": "USDC", "subscribers": 82, "explicitSubscribers": 72, "presetImpliedSubscribers": 10 },
      { "stablecoinId": "usdt-tether", "symbol": "USDT", "subscribers": 77, "explicitSubscribers": 70, "presetImpliedSubscribers": 7 }
    ],
    "lifecycleSnapshot": {
      "date": "2026-05-13",
      "snapshotAt": 1778674145,
      "activeWatchers": 121,
      "newWatchers": 2,
      "churnedWatchers": 1,
      "reactivatedWatchers": 0,
      "explicitCoinFollows": 560,
      "presetImpliedCoinFollows": 51,
      "activePresetFollowers": 8,
      "alertTypeOptIns": {
        "dews": 121,
        "depeg": 118,
        "launch": 97,
        "safety": 102,
        "allTypes": 95
      },
      "quietHoursEnabledChats": 18,
      "pendingDeliveries": 6
    }
  },
  "datasetFreshness": {
    "stablecoins": 1771856400,
    "blacklist": 1771856200,
    "mintBurn": 1771856340,
    "supply": 1771804800,
    "safetyGrades": 1771804800,
    "yield": 1771856320,
    "depegs": 1771856010,
    "dews": 1771856400,
    "digest": 1771804800
  },
  "summary": {
    "unhealthyCrons": 1,
    "availabilityImpactingUnhealthyCrons": 0,
    "watchUnhealthyCrons": 1,
    "degradedCrons": 1,
    "cronErrors": 0,
    "availabilityImpactingCronErrors": 0,
    "availabilityImpactingConsecutiveCronErrors": 0,
    "diagnosticIssueCount": 0,
    "worstCacheRatio": 1.03
  },
  "reserveComposition": {
    "configuredCoins": 18,
    "freshCoins": 16,
    "staleCoins": 1,
    "missingCoins": 0,
    "degradedCoins": 1,
    "errorCoins": 0,
    "corruptCoins": 0,
    "independentFreshEligible": 9,
    "independentFreshUnverified": 2,
    "staticValidatedFresh": 4,
    "weakProbeFresh": 1,
    "writeTimeoutUncertain": 0,
    "deferredCoins": 0,
    "runBudgetTruncated": false,
    "deferredAt": null,
    "nextCursorStablecoinId": null,
    "persistentlyStaleIndependentCoins": [],
    "lastSuccessAt": 1771855800,
    "oldestFreshAgeSec": 3100,
    "status": "healthy",
    "freshCoverageRatio": 0.89,
    "authoritativeFreshCoverageRatio": 0.83
  },
  "priceSourceHealth": {
    "sourceDistribution": {
      "coingecko": 14,
      "coingecko+defillama-list": 118,
      "defillama": 10,
      "defillama-list": 0,
      "protocol-redeem": 1,
      "defillama-contract": 4,
      "coinmarketcap": 2,
      "dexscreener": 1,
      "geckoterminal": 0,
      "cached": 4,
      "missing": 3
    },
    "sourceDepthDistribution": {
      "0": 3,
      "1": 15,
      "2": 52,
      "3": 64,
      "4": 18,
      "5+": 4
    },
    "confidenceDistribution": {
      "high": 127,
      "single-source": 15,
      "low": 8,
      "fallback": 6
    },
    "totalAssets": 156,
    "lastSync": 1771856400
  },
  "coingeckoPriceDiff": {
    "checkedAt": 1771856453,
    "trackedWithGeckoId": 152,
    "comparedCoins": 149,
    "mismatchedCount": 2,
    "thresholdPct": 5,
    "rows": [
      {
        "stablecoinId": "pyusd-paypal",
        "symbol": "PYUSD",
        "name": "PayPal USD",
        "geckoId": "paypal-usd",
        "ourPrice": 0.944,
        "coinGeckoPrice": 1.002,
        "diffPct": 5.79,
        "priceSource": "defillama",
        "priceConfidence": "single-source"
      }
    ]
  },
  "d1Usage": {
    "checkedAt": 1771856453,
    "windowStart": 1771770053,
    "windowEnd": 1771856453,
    "databaseId": "8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a",
    "databaseName": "stablecoin-db",
    "databaseSizeBytes": 1589248000,
    "numTables": 56,
    "region": "EEUR",
    "readReplicationMode": "disabled",
    "readQueries24h": 942012,
    "writeQueries24h": 709241,
    "rowsRead24h": 1633139670,
    "rowsWritten24h": 1555568,
    "capacity": {
      "observedAt": 1771856400,
      "databaseSizeBytes": 1589248000,
      "maximumSizeBytes": 10000000000,
      "utilizationRatio": 0.158925,
      "utilizationPercent": 15.89,
      "thresholdState": "normal",
      "crossedThresholdPercent": null,
      "nextThresholdPercent": 60,
      "sampleCount": 72,
      "forecastBasis": "linear-30d",
      "forecastSpanHours": 71,
      "growthBytesPerDay": 12000000,
      "nextThresholdAt": 1803605467,
      "exhaustionAt": 1832405467,
      "daysUntilExhaustion": 700.9
    }
  },
  "liquidityHealth": {
    "lastRunStatus": "degraded",
    "currentCoverage": 120,
    "previousCoverage": 125,
    "currentGlobalTvl": 123000000,
    "previousGlobalTvl": 125000000,
    "currentTop10CoveredTvl": 100000000,
    "previousTop10CoveredTvl": 102000000,
    "failedSources": ["defillama-yields"],
    "nearCoverageGuard": false,
    "nearValueGuard": false,
    "nearMajorCoverageGuard": false,
    "currentCoverageClasses": { "primary": 80, "mixed": 20, "fallback": 20, "legacy": 0, "unobserved": 36 },
    "previousCoverageClasses": { "primary": 82, "mixed": 18, "fallback": 25, "legacy": 0, "unobserved": 31 }
  },
  "yieldHealth": {
    "status": "healthy",
    "statusImpact": "admin-watch",
    "runbookUrl": "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/yield-health.md",
    "rankingCount": 129,
    "rankingUpdatedAt": 1771856320,
    "rankingAgeSec": 133,
    "rankingMaxAgeSec": 3600,
    "rankingStatus": "healthy",
    "safetyCoverage": {
      "coveredCount": 109,
      "trackedCount": 129,
      "coverageRatio": 0.845,
      "threshold": 0.75,
      "status": "healthy",
      "reason": null
    },
    "supplemental": {
      "updatedAt": 1771849200,
      "ageSec": 7253,
      "maxAgeSec": 21600,
      "status": "healthy"
    },
    "benchmark": {
      "fetchedAt": 1771849000,
      "ageSec": 7453,
      "maxAgeSec": 172800,
      "source": "risk_free_rates",
      "isFallback": false,
      "fallbackMode": null,
      "status": "healthy"
    },
    "coverageAudit": {
      "updatedAt": 1769810400,
      "ageSec": 2046053,
      "maxAgeSec": 3888000,
      "status": "healthy"
    },
    "sourceRiskCoverage": {
      "totalRows": 180,
      "bestRows": 129,
      "altRows": 51,
      "rowsWithSourceRisk": 180,
      "fields": {
        "sourceRiskPenalty": {
          "eligibleCount": 180,
          "populatedCount": 180,
          "nullCount": 0,
          "coverageRatio": 1,
          "nullRate": 0
        },
        "sourceRiskScore": {
          "eligibleCount": 180,
          "populatedCount": 0,
          "nullCount": 180,
          "coverageRatio": 0,
          "nullRate": 1
        }
      }
    },
    "latestCronStatus": "ok",
    "latestCronStartedAt": 1771856300
  },
  "mintBurnReconciliation": {
    "checkedAt": 1771856453,
    "comparedCoins": 42,
    "criticalCount": 1,
    "warnCount": 3,
    "insufficientCount": 12,
    "rows": [
      {
        "stablecoinId": "usdt-tether",
        "symbol": "USDT",
        "flowNet24hUsd": -240000000,
        "chainSupplyDelta24hUsd": -220000000,
        "absoluteDiffUsd": 20000000,
        "diffRatio": 0.08,
        "status": "warn",
        "coverageStatus": "full"
      }
    ]
  }
}
```

`dataQuality.onchainSupplyTrackedCoins` counts only coins with at least one `onchain_supply` row inside the current 3-day active monitoring window. Older historical rows are excluded from `staleOnchainSupply` and `onchainStaleRatio`.

Ratio-based on-chain status thresholds apply only when `dataQuality.onchainSupplyTrackedCoins >= 10`; below that floor, the counts remain visible but do not by themselves escalate `dataQualityStatus`.

`itemCount` and `dataQuality.totalStablecoins` are illustrative example values. In the live handler they reflect the current cached stablecoin payload size, not `TRACKED_STABLECOINS.length`.

`summary.availabilityImpactingUnhealthyCrons` and `summary.availabilityImpactingCronErrors` count only cron jobs tagged `statusImpact="critical"` in `shared/lib/cron-jobs.ts`. `summary.watchUnhealthyCrons` counts the watch-tier jobs that remain visible but do not degrade `availabilityStatus` on their own.

`summary.availabilityImpactingConsecutiveCronErrors` is the subset of `availabilityImpactingCronErrors` whose most recent 2+ runs are **all** `error`. A single transient critical-cron error increments `availabilityImpactingCronErrors` (and sets `availabilityStatus` to `degraded`), but only a `≥2`-consecutive streak increments `availabilityImpactingConsecutiveCronErrors` and escalates `availabilityStatus` to `stale`. This transient-vs-sustained split prevents rare upstream flakes (e.g. DefiLlama returning a truncated response body) from flipping public state on a single bad sample.

`summary.diagnosticIssueCount` counts best-effort status loader failures such as cache freshness lookups, reserve overview diagnostics, mint/burn diagnostics, and non-stablecoins data-quality subqueries. These issues reduce confidence and appear as info causes, but they do not degrade `availabilityStatus` or `dataQualityStatus` on their own unless all freshness evidence for the affected lane is gone.

`reserveComposition.status` is a derived health signal for live reserve coverage. After bootstrap, it becomes `stale` when `freshCoins === 0`, `degraded` when `freshCoverageRatio < 0.75`, `authoritativeFreshCoverageRatio < 0.5`, or `persistentlyStaleIndependentCoins.length > 0`, and `healthy` otherwise.

`reserveComposition.freshCoverageRatio` is `freshCoins / configuredCoins`. `reserveComposition.authoritativeFreshCoverageRatio` counts only stronger evidence cohorts (`independentFreshEligible`, `independentFreshUnverified`, `staticValidatedFresh`) over `configuredCoins`.

`reserveComposition.runBudgetTruncated`, `deferredCoins`, `deferredAt`, and `nextCursorStablecoinId` expose the latest live-reserve deferred-tail cursor when the internal sync budget stopped the run before the queue tail. `persistentlyStaleIndependentCoins` lists independent feeds whose latest source has been failing beyond the persistent-stale window. `writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path and could not be proven authoritative by readback.

`crons[*].healthy` reflects availability impact. Fresh cron runs with `status="degraded"` are warning-only and counted in `summary.degradedCrons`, but they do not mark availability unhealthy on their own.

`availabilityStatus` also inherits the shared public-health floor used by `/api/health`: cache-impact status, the critical mint/burn lane's public warning/staleness contract, and 3+ public-impact open circuit groups can degrade availability even when cron freshness alone is still green. Dynamic per-coin `live-reserves:*` breakers remain visible in `circuits`, but they do not change `availabilityStatus` on their own.

`alertBroker` is a retained compatibility block. The direct-alert runtime reports zero active/pending/critical conditions, zero failed/missing-target deliveries, no oldest timestamp or active keys, and `queryFailed=false`; historical broker tables are not queried.

`producerHeads` contains every canonical schedule/job/path/kind identity, including shared producer paths and budget-only surfaces. `observed=false` explicitly represents an identity that has not run since the history schema deployed. Observed rows separate `lastInvokedAt`/`lastCompletedAt` from `lastProductiveAt` and `lastPublicationAt`, and include invocation ID, Worker version, outcome/error, and invocation/productive counters.

`crons[*].inFlight` is present when a leased cron is actively reporting `cron_run_progress` and the matching `cron_leases` row is still active for the same owner. It includes `startedAt`, `updatedAt`, `stage`, optional `itemsDone/itemsTotal`, optional `message/metadata`, and a `stale` flag when the heartbeat stops updating. High-SLO jobs such as DEX liquidity, yield publication/supplemental sync, digest generation, and Telegram dispatch include stage metadata with `providerFamily`, `phase`, `countTotals`, and, where relevant, `cursor` / `deferredTail` summaries; `/api/status` reads those summaries from `cron_run_progress` and does not add producer-table scans for them.

`overallStatus` is the effective (hysteresis-smoothed) status. `rawOverallStatus` is the immediate worst-of availability/data-quality signal.

`dbHealthy=false` means the DB sentinel failed (`SELECT 1`), so status is forced to at least degraded and data-quality/database freshness queries are skipped.

`telegramBot` is `null` when the Telegram tables are unavailable in the current environment (for example, migrations not yet applied in dev/staging). The rest of `/api/status` still resolves normally.

`telegramBot.deliverySli` is the bounded operational delivery read model from Telegram source-event and authoritative target ledgers. Its envelope is always fail-visible:

- `availability` is `available` only when the complete SLI query succeeds; otherwise it is `unavailable`.
- `quality` is `complete`, `partial`, or `empty` for an available rollup, and `unavailable` on query failure.
- `freshness` is `fresh`, `stale`, or `empty` for an available rollup, and `unknown` on query failure.
- `acceptanceDefinition` is the literal `telegram_bot_api_accepted_not_user_receipt`. Fields such as `planToTelegramAcceptance`, `telegramAccepted`, and `telegramAcceptanceRate` mean Telegram's Bot API accepted a send request. They are not evidence that an end user received, opened, or read the message.
- `rollup` contains the bounded window, evidence age, detection-to-plan and plan-to-acceptance latency, acceptance-before-TTL coverage, authoritative outcomes, preference-change cancellations, unresolved backlog buckets, observed errors, execution-unknown outcomes, and dead letters. It is `null` on query failure; failure never becomes an all-zero or healthy rollup.

`sectionErrors` is a machine-readable map of subsection loader failures. When an individual status subsection fails (for example Telegram stats, discovery backlog, CoinGecko price drift, D1 usage telemetry, liquidity health, reserve drift, or mint/burn reconciliation), `/api/status` still returns `200`, keeps the unaffected sections intact, and records the degraded subsection under `sectionErrors` with a stable `code` plus an operator-facing sanitized `message`. Raw exception text, SQL fragments, and table names stay in logs, not in the response body.

`crons["dispatch-telegram-alerts"].lastRun.metadata` now carries a richer delivery breakdown, including fields such as `freshAttempted`, `freshSent`, `freshRetryQueued`, `freshPermanentFailures`, `pendingAttempted`, `pendingDrained`, `pendingRetryQueued`, `pendingDeferred`, `pendingRateLimited`, `pendingRetryAfterSec`, `pendingDropped`, `pendingEnqueued`, and expanded `eventsDetected` counters (`depegTriggered`, `depegResolved`, `depegWorsening`, `launch`, `suppressedMethodologyChanges`).

Source-event runs also include `authoritativePlanning`. It identifies `sourceEventId` and `sourceEventFamilies`; splits source-preset resolution, candidate-horizon, fan-out input loaders, preference-generation validation, routing, target materialization, duplicate suppression, queue handoff, and pending-drain duration; and reports capture/planning/handoff pages, fan-out load/cache counts, captured/planned/duplicate-suppressed/enqueued targets, and coordinator steps. Eventless runs return the same object with a null source ID and zero counts/timings so status consumers do not need a second shape.

The same cron metadata also exposes the live safety-alert source contract:

- `safetyAlertSourceState`
- `safetyAlertSourceAgeSeconds`
- `safetyAlertsSuppressed`
- `safetyAlertSourceGeneration`

When `safetyAlertsSuppressed=true`, DEWS/depeg/launch alerts can still continue, but safety-grade alerts remain paused until `compute-safety-score-v9` accepts a fresh canonical publication and the Telegram lane reseeds its prior snapshot.

`crons["status-self-check"].lastRun.metadata` now also includes `freshnessDiagnostics` when raw status had to fall back from a freshness sentinel to table or cron evidence during the self-check run, plus `d1CapacityMonitoring` when the dedicated Cloudflare D1 status bindings are configured.

`probe.internal`, `probe.external`, and `probe.internalExternalDiscrepancy` are optional because legacy `status_probe_runs` rows did not persist split-plane details. New rows compare router-dispatched internal self-checks against explicit production-domain HTTP canaries for public API, site API, and ops API routes. Probe-failure and status-divergence alerts include that internal/external comparison.

`datasetFreshness` covers the key operator-visible datasets written by the pipeline: cache-backed stablecoins, blacklist, mint/burn, supply snapshots, safety-grade history, yield, depeg/dews tables, daily digest, and discovery backlog timestamps.

`dataQuality.repairDebt` summarizes low-priority repair/backfill backlog separately from foreground publication health. It reports `status`, `openCount`, `oldestAgeSec`, `byKind`, `availabilityEscalated`, `nextRunnerDueAt`, and `source` from active `worker_repair_tasks` rows. The legacy DDR-specific `ddrRepairDebt*` fields remain populated for compatibility from active DDR task `subject_id`/`payload_json` details and continue to drive the `ddr_repair_debt_present` data-quality warning.

`priceSourceHealth` is derived from the final `sync-stablecoins` asset payload and summarizes resolved price-source distribution, active canonical source-depth buckets (`sourceDepthDistribution`, keyed by `consensusSources.length` buckets `0`, `1`, `2`, `3`, `4`, `5+`), confidence buckets, total assets, and the timestamp of the latest successful price-health snapshot. CoinGecko-vs-Pharos divergence details live in the separate `coingeckoPriceDiff` block.

`coingeckoPriceDiff` is an admin-only live comparison block. It reads the cached tracked assets with `geckoId`, fetches current CoinGecko spot prices and their upstream timestamps through one or more batched `simple/price` calls, and compares only quotes accepted by the shared CoinGecko freshness validator. Missing, invalid, stale, or materially future timestamps are excluded before reporting rows where `abs(pharosPrice - coinGeckoPrice) / coinGeckoPrice > 0.05`. The field is `null` when the comparison is unavailable in the current environment or when the loader fails; failures are surfaced through `sectionErrors.coingeckoPriceDiff`.

`d1Usage` is an admin-only live D1 telemetry block. It uses Cloudflare's D1 database info endpoint plus a trailing-24h `d1AnalyticsAdaptiveGroups` GraphQL query to surface current storage size, table count, replication mode, and recent query/row volume. Its additive `capacity` member carries the latest hourly 60/75/90% threshold classification plus 24h, 72h, 7d, and 30d linear regressions (`growthWindows`, with sample count/span). `conservativeWindow` identifies the shortest valid regression used for runway. The scheduled status lane records the same bounded capacity assessment, but exact D1 capacity telemetry is not exposed by the no-key public health endpoint. The field is `null` until `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_STATUS_API_TOKEN`, and `CLOUDFLARE_D1_DATABASE_ID` are configured on the worker; loader/config failures are surfaced through `sectionErrors.d1Usage`.

`liquidityHealth` is derived from the latest `sync-dex-liquidity` cron metadata and summarizes row coverage, value coverage, major-asset coverage, failed sources, and current/previous coverage-class distribution for the operator dashboard.

`yieldHealth` is derived only from existing yield cache rows and cron metadata: `yield-rankings`, per-family `yield:supplemental-sources:v1:*`, `yield-coverage-audit`, and `crons["sync-yield-data"]`. `rankingStatus` follows the post-V9 `sync-yield-data` cache runway (`>8x` degraded, `>12x` stale); missing or stale rankings are public-critical because `/api/yield-rankings` and `/yield/` depend on them. `rankingCountDelta` and `previousRankingCount` come from `sync-yield-data` source-coverage metadata, with a fallback to the top-level severe-coverage-guard metadata when publication is blocked before normal source coverage is assembled. Safety coverage is admin-watch unless it falls below `0.75`, supplemental family cache age is admin-watch above 6h, and coverage-audit age is admin-watch above 45d. `yieldHealth.benchmarkRegistry` evaluates every benchmark key used by published rows, including row counts and fallback-selection counts; any used fallback is degraded, while a missing or older-than-48h used benchmark is stale. The legacy `yieldHealth.benchmark` field remains the USD-only compatibility view. `yieldHealth.supplemental` reports `familyCount`, `freshFamilyCount`, `degradedFamilyCount`, `staleFamilyCount`, `missingFamilyCount`, and a `families` map keyed by source family with per-family age/source-count/status; a fresh all-empty family snapshot is valid state, while no valid family rows means the supplemental section is unavailable/stale based on family evidence. `sourceRiskCoverage` reports backend-only coverage/null rates for nested `sourceRisk.*` fields across best and alternate ranking rows; `"unknown"` venue tiers count as null-equivalent coverage gaps. Loader failures return `yieldHealth: null` and `sectionErrors.yieldHealth`.

`publicationHealth` is a read-only live supplement over existing publication ledgers. It currently normalizes `dex_liquidity_publication_generations` and `yield_publication_generations` into per-surface `lastPublishedGeneration`, `lastAttemptedGeneration`, `lastFailureReason`, `candidateAgeSec`, and optional dependency watermark fields. Surface loaders settle independently: a failing surface is omitted and listed in the additive `failedSurfaces[]` (`{surface, code, message}`) while successful surfaces stay populated, and `sectionErrors.publicationHealth` is set whenever any surface fails. Loader failures do not change publication behavior or write generic publication rows.

`dependencyHealth` is a read-only derived matrix over existing status signals. The worker combines `caches`, `crons`, `publicationHealth`, and the static registry in `shared/lib/data-dependency-registry.ts` into per-dependency status rows plus `rootCauseGroups` that group degraded/stale symptoms under the highest upstream dependency. This is operator triage metadata only: it does not perform extra D1 reads, does not change `availabilityStatus` / `dataQualityStatus`, and does not mutate publication ledgers.

`providerCircuitHealth` is a read-only admin supplement over active provider circuit-breaker rows. Breaker decisions use the individual `cache["circuit:<source>"]` rows; `/api/status` reads those same authoritative rows through a bounded active-source allowlist so lost or stale aggregate-index writes cannot hide open providers. Successful/failing breaker writes still maintain `cache["provider:circuit:index"]` as best-effort telemetry. Loader failures return `providerCircuitHealth: null` and `sectionErrors.providerCircuitHealth`; public `/api/health.circuits` remains the raw per-circuit surface.

`canaries` is a read-only admin supplement over `worker_canary_runs`. In `status` or `alert` mode it reports the latest row from the current authoritative mode for each active structural check, including DEX publication/current-row invariants, blacklist identity completeness, stablecoins-cache active coverage, PSI and DEWS latest samples, report-card cache generation/methodology freshness, and the GBP benchmark-current check. Retained historical rows for retired check IDs are ignored by the current summary. In `off` or `shadow` mode it returns the empty/unknown compatibility shape without reading retained authoritative rows; shadow evidence is inspected through D1 and cron metadata. Loader failures return `canaries: null` and `sectionErrors.canaries`; canary findings are operator diagnostics and do not directly change availability.

`mintBurnReconciliation` compares 24h configured canonical issuance-chain mint/burn net flow (`mint_burn_hourly`) against the cached stablecoins payload's matching chain-supply delta. It is intended for operator diagnostics, not public scoring.

### `GET /api/status-history`

Machine-readable status timeline endpoint for tooling and incident analysis.

**Query parameters**

| Param   | Type                  | Default | Description                                                                                                          |
| ------- | --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `limit` | `integer`             | `50`    | Number of transitions to return (1–200)                                                                              |
| `from`  | `integer \| ISO date` | —       | Optional lower bound for transition `created_at` (Unix seconds/milliseconds or ISO date); invalid values are ignored |
| `to`    | `integer \| ISO date` | —       | Optional upper bound for transition `created_at` (Unix seconds/milliseconds or ISO date); invalid values are ignored |

`limit` is clamped into `1..200` by the shared query parser.

**Response shape:** `StatusHistoryResponse` (defined in `shared/types/index.ts`). The response includes the current `reserveComposition` summary when it can be computed, or `null` if the reserve overview diagnostic query fails. `hasMore` reports whether another matching transition exists beyond the returned page: `true` means the selected window is truncated, `false` proves the returned page covers the matching window, and `null` means the transition query failed and completeness is unknown. Consumers must not infer that no transition occurred from a `true` or `null` result.

### `GET /api/request-source-stats`

Admin-only site-vs-external demand attribution summary. Aggregates minute-bucketed request counts into a requested window so operators can estimate what share of total request demand is coming from the website itself versus external consumers.

The top-line `site` bucket combines:

- same-origin `/_site-data/*` upstream attempts recorded by the Pages Function; the retired outer Cache API path may still appear in historical windows
- `api.pharos.watch` requests attributed to browser evidence (`Origin` / `Referer` / frontend `Accept` marker + same-site fetch metadata)
- `api.pharos.watch` requests authenticated with API keys carrying the legacy `trafficClass="site"` label (no longer writable; see `POST /api/api-keys/:id/update`)

The top-line `external` bucket is `api.pharos.watch` traffic not classified as site. Admin-only routes and `/api/telegram-webhook` remain excluded. The response also includes worker-lane telemetry so operators can distinguish total demand from actual `public-api` vs `site-api` worker load.

**Query parameters**

| Param         | Type      | Default | Description                                                             |
| ------------- | --------- | ------- | ----------------------------------------------------------------------- |
| `hours`       | `integer` | `24`    | Window size in hours (`1`–`840`, currently 35 days)                     |
| `bucketSec`   | `integer` | `3600`  | Time-bucket rollup size in seconds (`60`–`86400`)                       |
| `routeLimit`  | `integer` | `20`    | Max per-route rows returned in the route breakdown (`1`-`100`)          |
| `apiKeyLimit` | `integer` | `25`    | Max per-key rows returned in the keyed public-API breakdown (`1`-`100`) |

Malformed numeric params return `400`; out-of-range numeric params are clamped to the documented bounds.

**Response shape:** `ApiRequestAttributionResponse` (defined in `shared/types/index.ts`)

`ApiRequestAttributionResponse` includes:

- `generatedAt` — Unix seconds when the response was generated
- `window` — requested `from`/`to`, `durationSec`, `bucketSizeSec`, `routeLimit`, `apiKeyLimit`, and current `retentionDays`
- `totals` — aggregate `siteRequests`, `externalRequests`, `totalRequests`, `siteSharePct`, `externalSharePct`
- `siteDelivery` — Pages delivery-path counters (`pagesCacheHits` is historical-only; current traffic uses `pagesUpstreamFetches`, `pagesUpstreamTimeouts`, or `pagesUpstreamErrors`) plus `publicApiSiteRequests`
- `lanes[]` — worker-load split by `lane` (`public-api`, `site-api`) with the same site/external counters
- `routes[]` — normalized per-route breakdown sorted by total demand volume
- `buckets[]` — time-series rollups using the requested `bucketSec`
- `keyedPublicApi` — summary of authenticated protected `public-api` traffic (`keyedRequests`, `unkeyedRequests`, share percentages, total keys in window, and truncation metadata)
- `apiKeys[]` — top API keys by keyed request volume with masked token, traffic class, active/expiry metadata, rate limit, request count, and keyed/public-api share percentages
- `scope` — explicit booleans describing total site demand, worker load, and whether the selected historical window contains retired Pages cache-hit telemetry

### `GET /api/api-keys`

Admin-only API key inventory. Returns masked tokens plus metadata, but never returns stored secret material. Expired keys remain listed for operator review; callers should use `isActive` plus `expiresAt` to distinguish `active`, `expired`, and deliberate non-expiring exceptions.

**Response shape:** `ApiKeyListResponse` (defined in `shared/types/api-keys.ts`)

### `GET /api/api-keys/lifecycle-summary`

Admin-only counts projection for the Triage workspace. Returns aggregate credential lifecycle counts and the 7-day rotate/deactivate anomaly count without exposing API-key row metadata, owner emails, masked tokens, audit actors, or audit detail payloads.

**Response shape:** `CredentialLifecycleSummaryResponse` (defined in `shared/types/api-keys.ts`)

```json
{
  "generatedAt": 1710500000,
  "totalKeys": 12,
  "active": 10,
  "expiringSoon": 2,
  "expired": 1,
  "nonExpiring": 1,
  "auditAnomalies7d": 3
}
```

### `GET /api/api-keys/audit-log`

Admin-only API key lifecycle audit log. Returns recent create/update/deactivate/rotate audit entries from `api_key_audit_log`.

**Query params:**

| Param      | Type      | Default | Max | Description                        |
| ---------- | --------- | ------- | --- | ---------------------------------- |
| `limit`    | `integer` | `50`    | 200 | Number of audit entries to return  |
| `apiKeyId` | `integer` | n/a     | n/a | Optional filter for one API key ID |

**Response shape:**

```json
{
  "entries": [
    {
      "id": 1,
      "apiKeyId": 7,
      "action": "created",
      "actor": "admin",
      "detail": { "name": "Smoke" },
      "createdAt": 1710500000
    }
  ]
}
```

### `POST /api/api-keys`

Admin-only API key creation route.

**Body shape:** `ApiKeyCreateRequest`

| Field                | Type                   | Required | Description                                                                                                                                 |
| -------------------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | `string`               | Yes      | Display name for the key                                                                                                                    |
| `ownerEmail`         | `string`               | No       | Optional operator / owner contact                                                                                                           |
| `tier`               | `"standard" \| "self-serve"` | No       | Issuance tier; defaults to `"standard"`. `"self-serve"` is written by the verified public issuance path                              |
| `rateLimitPerMinute` | `integer`              | No       | Per-key threshold (`1`–`10000`, default `120`)                                                                                              |
| `expiresAt`          | `integer \| null`      | No       | Unix timestamp when the key should expire. Omit to use the default 90-day expiry. Send `null` only for a deliberate non-expiring exception. |

**Response shape:** `ApiKeyCreateResponse`

**Success status:** `201 Created`

`token` is returned only once. Persist it immediately; later list/read paths expose only `maskedToken`. `key.expiresAt` in the response reflects the stored expiry after the default-90-day fallback is applied.

### `POST /api/api-keys/:id/update`

Admin-only metadata update for an existing API key.

**Body shape:** `ApiKeyUpdateRequest`

Accepted fields:

- `name`
- `ownerEmail`
- `tier`
- `rateLimitPerMinute`
- `isActive`
- `expiresAt`

`trafficClass` is no longer accepted on either mutation body. It is an attribution label only — the real request lane is derived per request in `worker/src/handlers/http/gates.ts` — so issuance always writes `"external"` and existing rows keep whatever value they were created with.

**Response shape:** `ApiKeyMutationResponse`

Send `expiresAt: null` only for a deliberate non-expiring exception. Existing keys created before the expiry migration keep `expiresAt = null` until an operator changes them.

### `POST /api/api-keys/:id/deactivate`

Admin-only hard deactivation for an existing API key. This sets `isActive=false`; the secret cannot be used afterward.

**Response shape:** `ApiKeyMutationResponse`

### `POST /api/api-keys/:id/rotate`

Admin-only secret rotation. The old token stops working immediately and a new plaintext token is returned once. Rotation does not accept expiry input and preserves the current `expiresAt`.

**Response shape:** `ApiKeyRotateResponse`

### `GET /api/api-key-requests-admin`

Admin-only self-serve API key request list used by `ops.pharos.watch/admin-api/`. Returns requester details, risk context, intended endpoints, verification/issuance timestamps, linked key metadata, and claim state. It never returns plaintext API tokens.

**Query params:**

| Param    | Type      | Default | Max | Description                                                                            |
| -------- | --------- | ------- | --- | -------------------------------------------------------------------------------------- |
| `status` | `string`  | n/a     | n/a | Optional filter: `pending_verification`, `issued`, `rejected`, `blocked`, or `expired` |
| `limit`  | `integer` | `50`    | 100 | Number of request rows to return                                                       |

**Response shape:** `ApiKeySelfServeRequestAdminListResponse` (defined in `shared/types/api-key-requests.ts`)

### `POST /api/api-key-requests-admin/:requestId/reject`

Admin-only rejection for a self-serve request. If a linked key exists, the handler deactivates it before marking the request rejected and releasing the email claim.

**Response shape:** `ApiKeySelfServeAdminMutationResponse`

### `POST /api/api-key-requests-admin/:requestId/release-claim`

Admin-only claim release for a self-serve request that should no longer block the normalized email. The handler refuses to release a claim while the request still has an active, unexpired linked key.

**Response shape:** `ApiKeySelfServeAdminMutationResponse`

### `POST /api/backfill-depegs`

Backfills historical depeg events from stored price data.

For coins with a registered authoritative historical price provider, the backfill uses that same provider family first (for example, replayed protocol redemption quotes) before falling back to market history. If the authoritative provider is configured but unavailable, existing `source='backfill'` rows for that coin are preserved instead of being rebuilt from a weaker source.

Supported non-USD fiat assets now prefer direct CoinGecko native-fiat history first and compare that series to the native `1.0` peg before they fall back to USD-denominated CoinGecko/DefiLlama history plus historical FX. In that native-fiat mode, backfill uses daily points plus a two-point confirmation window across 36 hours, while still preserving extreme single-point crashes of `>= 5000 bps`.

`dry-run=true` compares the freshly replayed historical events against the currently stored `source='backfill'` rows without mutating the database. The preview reports whether the replay exactly matches the stored backfill rows, how many stored backfill rows would be removed, how many replayed rows would be added, and the current live-row counts for the same asset.

Bounded replay windows also support `startDay` / `endDay`, plus optional `contextDays` to widen the replay pad around that UTC window. This makes long-history audits and repairs practical over `ops-api` without waiting for a full-coin rebuild. In mutating mode, bounded replays only replace overlapping `source='backfill'` rows for that coin and preserve non-overlapping backfill rows plus all `source='live'` rows.
For commodity-pegged assets, bounded replays limit the peer-median reference fetch to the replay pad and only fetch the needed gold or silver source family.

**Query parameters**

| Param         | Type                               | Default | Description                                                           |
| ------------- | ---------------------------------- | ------- | --------------------------------------------------------------------- |
| `stablecoin`  | `string`                           | —       | Process a single stablecoin ID                                        |
| `batch`       | `integer`                          | `0`     | Batch offset (3 coins per batch)                                      |
| `dry-run`     | `"true"`                           | —       | Preview replay-vs-backfill differences without writing `depeg_events` |
| `startDay`    | `integer \| ISO date (YYYY-MM-DD)` | —       | Lower bound for bounded replay compare/mutation                       |
| `endDay`      | `integer \| ISO date (YYYY-MM-DD)` | —       | Upper bound for bounded replay compare/mutation                       |
| `contextDays` | `integer`                          | `7`     | Extra replay context days on each side of a bounded window (max `90`) |

### `POST /api/backfill-supply-history`

Backfills per-coin supply history snapshots. When historical market-price series are available, the endpoint also persists daily `supply_history.price` values on restored rows so historical PSI replay can use day-level deviation instead of blunt peak fallback.

Commodity and CoinGecko-only total-supply fallback replays historical EVM `totalSupply()` at each UTC day close when CoinGecko market caps are missing. It does not project the current supply backward across the requested window, and it fails closed when the asset has multiple supported EVM deployments. Protocol-TVL fallback can still write market-cap rows, but stores `price: null` for days outside the returned price-chart coverage instead of extrapolating the nearest endpoint price.

**Query parameters**

| Param                           | Type                               | Default | Description                                                                               |
| ------------------------------- | ---------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `stablecoin`                    | `string`                           | —       | Process a single stablecoin ID                                                            |
| `batch`                         | `integer`                          | `0`     | Batch offset for chunked processing                                                       |
| `batchSize`                     | `integer`                          | `10`    | Coins per batch                                                                           |
| `allow-constant-price-fallback` | `"true"`                           | —       | Allow current-price fallback when historical non-USD prices are missing                   |
| `startDay`                      | `integer \| ISO date (YYYY-MM-DD)` | —       | Lower bound for UTC daily rows written                                                    |
| `endDay`                        | `integer \| ISO date (YYYY-MM-DD)` | —       | Upper bound for UTC daily rows written; future values clamp to the last completed UTC day |

### `POST /api/backfill-stability-index`

Backfills historical stability index scores from stored depeg events and supply data.

The rebuild now stops at the last completed UTC day; it does not write a `stability_index` row for the current UTC day. Historical market-cap denominators in this replay path are bounded to core stablecoins, cash equivalents, and configured shadow assets. Variants and stable-value investments retain their depeg and supply histories but do not contribute to replayed PSI. Historical replay treats a core-universe depeg as active for any UTC day whose window overlaps the event interval. When a usable same-day `supply_history.price` exists, the replay derives day severity from that price, but on the UTC day the depeg begins it keeps `peak_deviation_bps` as a floor only when the event materially persisted past that UTC close and the daily snapshot undercaptures the shock by at least the configured depeg threshold. Same-day recovered wicks, near-midnight bleed-throughs, and moderate follow-on moves that the restored day price already captures use the daily historical price instead, and replay days whose restored daily price is back inside the configured depeg threshold are dropped instead of still contributing breadth. Later days fall back to `peak_deviation_bps` only for missing/invalid historical prices. The historical restore path is expected to repair replay-critical `supply_history.price` coverage, including PSI-only shadow assets, before rerunning this rebuild. For methodology `v3.0+`, the replay also derives daily `stressBreadth` from core-universe `stress_signal_history` rows in `ALERT`, `WARNING`, or `DANGER` bands. If a rebuild day cannot be replayed because archival inputs are unavailable, the endpoint preserves the existing stored row instead of deleting that day. The response includes the evaluated `startDay`/`endDay` so operators can confirm the rebuild window.

**Query parameters**

| Param      | Type                               | Default                | Description                                                                      |
| ---------- | ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `dry-run`  | `"true"`                           | —                      | Preview the rebuild window and change summary without mutating `stability_index` |
| `startDay` | `integer \| ISO date (YYYY-MM-DD)` | earliest depeg day     | Lower bound for rebuilt UTC days                                                 |
| `endDay`   | `integer \| ISO date (YYYY-MM-DD)` | last completed UTC day | Upper bound for rebuilt UTC days                                                 |

### `POST /api/backfill-cg-prices`

Backfills historical market prices for the PSI-eligible universe. The endpoint fills NULL `supply_history.price` gaps and can insert missing `supply_history` day rows when market-cap history exists, including PSI-only shadow assets such as `ust-terra`.

**Query parameters**

| Param        | Type      | Default | Description                         |
| ------------ | --------- | ------- | ----------------------------------- |
| `stablecoin` | `string`  | —       | Process a single stablecoin ID      |
| `batchSize`  | `integer` | `10`    | Coins per batch                     |
| `batch`      | `integer` | `0`     | Batch offset for chunked processing |

### `POST /api/backfill-yield-history`

Backfills protocol API yield-history rows for the curated target set used by yield intelligence. The current target set is limited to Zephyr ZYS (`zys-zephyr-protocol`) through the protocol API source.

**Query parameters**

| Param        | Type      | Default | Description                              |
| ------------ | --------- | ------- | ---------------------------------------- |
| `stablecoin` | `string`  | —       | Process a single supported stablecoin ID |
| `batchSize`  | `integer` | `10`    | Coins per batch                          |
| `batch`      | `integer` | `0`     | Batch offset for chunked processing      |

### `POST /api/backfill-tape`

Runs the same TAPE projectors used by the `project-tape` cron with operator-supplied window and limit overrides. Writes are idempotent on `(source_table, source_row_id, transition)`, so the endpoint is safe to re-run. First-observation projectors such as methodology, cemetery, and lifecycle ignore `since` / `until` because they scan static sources keyed by ID.

**Request body or query parameters**

Query parameters win when the same field is supplied in both places.

| Param     | Type      | Default | Description                                                            |
| --------- | --------- | ------- | ---------------------------------------------------------------------- |
| `class`   | `string`  | all     | Repeatable projector class filter, for example `class=depeg.opened`    |
| `since`   | `integer` | none    | Lower source-row timestamp bound in Unix seconds                       |
| `until`   | `integer` | none    | Upper source-row timestamp bound in Unix seconds                       |
| `maxRows` | `integer` | `5000`  | Per-class scan cap, min `1`, max `50000`                               |
| `dryRun`  | `boolean` | `false` | Compute results without writing rows or advancing projector watermarks |
| `dry-run` | `boolean` | `false` | Query/body alias for `dryRun`                                          |

Supported projector classes are `depeg.opened`, `depeg.resolved`, `depeg.peak_worsened`, `freeze.blocked`, `freeze.unblocked`, `freeze.destroyed`, `score.upgraded`, `score.downgraded`, `psi.band_changed`, `dews.band_transitions`, `mint_burn.large_flow`, `yield.warning_emitted`, `yield.pys_dropped`, `methodology.bumped`, `cemetery.entry.added`, and `lifecycle.tracked.frozen`. `dews.band_transitions` is the single DEWS projector class and emits both `dews.escalated` and `dews.deescalated` tape events. `depeg.resolved` projects only recovery-backed depeg closures, not coverage-loss, orphan, or superseded-direction terminal rows.

**Response**

```json
{
  "ok": true,
  "dryRun": false,
  "maxRows": 5000,
  "since": null,
  "until": null,
  "selectedClasses": ["depeg.opened"],
  "projected": 12,
  "perClass": { "depeg.opened": 12 },
  "errors": []
}
```

**Error responses:** `400` for unknown `class` values, invalid negative timestamps, `since > until`, or `maxRows` outside `1..50000`.

### `POST /api/backfill-mint-burn-prices`

Repairs bounded historical mint/burn NULL-USD debt using exact event-day evidence. The endpoint defaults to `dry-run=true`, accepts `limit=1..500` (default `100`) and optional `stablecoin=<id>`, and never uses current `price_cache` or an adjacent-day price. Source order is exact-day `supply_history`, CoinGecko historical market chart, DefiLlama CoinGecko-identity chart, then an exact configured contract chart. DefiLlama spans are loaded sequentially in up to eight 800-day windows per identity; points are merged before event-day resolution, and an over-budget range or unavailable window keeps unresolved rows retryable rather than falsely irreducible.

Mutation requires `dry-run=false&confirm=historical-mint-prices&bookmark=<fresh-d1-bookmark>` plus an `Idempotency-Key` header from 1 to 128 trimmed characters. The bookmark and idempotency key are persisted on every attempted row. Rows without a valid point after definitive source responses become explicitly `irreducible`; transient provider failures remain retryable. Recovered rows are finalized only after `mint_burn_hourly` is rebuilt and verified against source events. `retry-irreducible=true` is reserved for reopening classifications after source coverage improves.

Cron `sync-mint-burn` automatically heals recent NULL-price events within a 48-hour window and reports the healed count in cron metadata as `nullPricesHealed`; this endpoint is primarily for historical backfills beyond that window.

**Response**

```json
{
  "dryRun": true,
  "limit": 100,
  "selected": 1,
  "recovered": 1,
  "classifiedIrreducible": 0,
  "deferredForRetry": 0,
  "aggregateCoinsRebuilt": ["ustb-superstate"],
  "aggregateVerificationPassed": null,
  "dispositions": [
    {
      "eventId": "ethereum-0xabc-0",
      "stablecoinId": "ustb-superstate",
      "chainId": "ethereum",
      "timestamp": 1740279479,
      "disposition": "recover",
      "price": 10.58,
      "priceTimestamp": 1740272109,
      "priceSource": "repair:defillama-gecko-chart-event-day:superstate-short-duration-us-government-securities-fund-ustb",
      "reason": null
    }
  ],
  "backlog": {
    "unclassified": 529,
    "irreducible": 0,
    "pendingAggregate": 0,
    "totalNullUsd": 529
  }
}
```

### `GET /api/backfill-dews`

Runs the historical DEWS backtest path against stored depeg events. This is the default `GET` mode when no `mode` or `repair` query is supplied; it reports true-positive coverage and lead-time summary fields from the historical replay implementation.

Use `GET /api/backfill-dews?mode=backtest-metrics` for the curated anchor fixture metrics described below. Use `GET /api/backfill-dews?repair=...&dry-run=true` for repair previews; mutating repair runs are `POST`-only.

### `GET /api/backfill-dews?mode=backtest-metrics`

Backtest harness that replays DEWS over a curated set of historical depeg onsets (the `BACKTEST_ANCHORS` fixture). Reports detection rate and lead-time percentiles sourced from `stress_signal_history` daily snapshots.

**Authentication:** admin only (same Cloudflare Access gate as the rest of `/api/backfill-dews`).

**Granularity:** `"daily"`. The harness reads `stress_signal_history` rows (one snapshot per UTC day) over a 14-day window ending at each anchor's `onsetAt` and looks for the first `ALERT` / `WARNING` / `DANGER` band inside that window.

**Response**

```json
{
  "detectionRate": 0.75,
  "leadTimeDaysP50": 4,
  "leadTimeDaysP90": 11,
  "granularity": "daily",
  "perAnchor": [
    {
      "stablecoinId": "usdc-circle",
      "onsetAt": 1679400000,
      "detected": true,
      "leadTimeDays": 2,
      "firstAlertBand": "WARNING"
    }
  ]
}
```

| Field             | Type                         | Description                                                                                     |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `detectionRate`   | `number`                     | Fraction of anchors where DEWS surfaced at least `ALERT` before `onsetAt` (`0` if no anchors)   |
| `leadTimeDaysP50` | `number \| null`             | 50th-percentile lead time in days across detected anchors; `null` when no anchors were detected |
| `leadTimeDaysP90` | `number \| null`             | 90th-percentile lead time in days across detected anchors; `null` when no anchors were detected |
| `granularity`     | `"daily"`                    | Snapshot granularity used to compute lead time                                                  |
| `perAnchor`       | `BacktestMetricsPerAnchor[]` | One entry per anchor in the fixture (see below)                                                 |

**`BacktestMetricsPerAnchor`**

| Field            | Type                                       | Description                                                                       |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `stablecoinId`   | `string`                                   | Pharos stablecoin ID of the anchor                                                |
| `onsetAt`        | `number`                                   | Unix seconds of the curated depeg onset                                           |
| `detected`       | `boolean`                                  | Whether DEWS reached at least `ALERT` within the 14-day pre-onset window          |
| `leadTimeDays`   | `number \| null`                           | Days between the first elevated band and `onsetAt`; `null` if `detected=false`    |
| `firstAlertBand` | `"ALERT" \| "WARNING" \| "DANGER" \| null` | Band of the first elevated snapshot inside the window; `null` if `detected=false` |
| `alertDays`      | `number`                                   | Count of elevated (`ALERT`/`WARNING`/`DANGER`) snapshots inside the 14-day window  |
| `bandTransitions`| `number`                                   | Number of band changes across those elevated snapshots                            |
| `pegType`        | `string \| null`                           | `pegged<PEG_CURRENCY>` for PSI-eligible anchors; `null` otherwise                  |

### `GET /api/backfill-dews?repair=refresh-current&dry-run=true`

Dry-run preview for the current-state DEWS repair. Returns the exact set of stablecoins that would be republished under the live `$1M` DEX trust floor, plus source-coverage / validation diagnostics from the preview computation.

### `POST /api/backfill-dews?repair=refresh-current`

Immediately republishes current `stress_signals` rows under the live `$1M` DEX trust floor. The response includes the dry-run preview payload plus the executed `computeAndStoreDEWS()` summary.

### `GET /api/backfill-dews?repair=prune-history&dry-run=true`

Dry-run preview for bounded DEWS history pruning. Returns the exact `stress_signal_history` rows that fall inside the requested window, optional `stablecoin` filter scope, and the current post-window history boundary.

### `POST /api/backfill-dews?repair=prune-history`

Deletes bounded `stress_signal_history` windows that cannot be deterministically recomputed because historical daily snapshots do not retain the DEX trust metadata required to replay the live `$1M` divergence gate.

**Query parameters**

| Param        | Type                                   | Default             | Description                                                                        |
| ------------ | -------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `repair`     | `"refresh-current" \| "prune-history"` | required for `POST` | Selects the DEWS repair mode                                                       |
| `dry-run`    | `"true"`                               | —                   | Required for `GET` repair previews; optional on `POST` to preview without writes   |
| `stablecoin` | `string`                               | —                   | Optional tracked stablecoin ID for `repair=prune-history`                          |
| `startDay`   | `string`                               | `2026-03-09`        | Optional prune-window start day (`YYYY-MM-DD`, Unix seconds, or Unix milliseconds) |
| `endDay`     | `string`                               | current UTC day     | Optional prune-window end day (`YYYY-MM-DD`, Unix seconds, or Unix milliseconds)   |

### `POST /api/backfill-mint-burn`

Backfills mint/burn event ingestion for a specific contract config using the same parsing/classification pipeline as the cron.
If `configKey` is omitted, the worker auto-selects one tracked config using a critical-first / major-symbol-first / most-behind policy and returns the selected config in the response.

**Request body or query parameters**

| Param       | Type      | Default         | Description                                                                              |
| ----------- | --------- | --------------- | ---------------------------------------------------------------------------------------- |
| `configKey` | `string`  | auto-selected   | Optional config key: `{chainId}-{contractAddress}` across the tracked issuance-chain set |
| `fromBlock` | `integer` | from sync state | Start block override                                                                     |
| `toBlock`   | `integer` | chain head      | End block override (clamped to chain head)                                               |
| `chunkSize` | `integer` | `50000`         | Block span per fetch chunk (max 50000)                                                   |
| `maxChunks` | `integer` | `24`            | Maximum chunks to process per request                                                    |

### `POST /api/reclassify-atomic-roundtrips`

Retroactively tags same-transaction mint+burn pairs for the same stablecoin as `flow_type='atomic_roundtrip'` and recalculates the affected hourly buckets.

**Query parameters**

| Param          | Type      | Default         | Description                                                                                                                                 |
| -------------- | --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `since`        | `integer` | `now - 90 days` | Unix seconds cutoff for both forward and reverse scans; `0` requests a full-table sweep and may exceed D1 CPU limits without `stablecoinId` |
| `stablecoinId` | `string`  | —               | Optional Pharos stablecoin ID filter applied to both scans                                                                                  |

**Response**

```json
{
  "done": false,
  "since": 1765218367,
  "stablecoinId": "usdt-tether",
  "updated": 428,
  "toRoundtrip": 420,
  "toStandard": 8,
  "hoursRecalculated": 31,
  "batchSize": 1000
}
```

The endpoint processes up to 1000 `(tx_hash, stablecoin_id)` groups per request. Repeat until `done=true`.

### `GET /api/audit-depeg-history?dry-run=true`

Dry-run preview for the depeg audit endpoint. This is the only supported `GET` mode for `/api/audit-depeg-history`; all mutating executions require `POST`.

The same endpoint also supports dry-run historical repair previews:

- `repair=synthetic-splits` surfaces adjacent same-direction events that were likely split either by the old DEX-only auto-close behavior or by a backfill-to-live handoff where historical replay expired mid-ongoing depeg
- `repair=contradictory-recovery-price` surfaces ended events whose stored `recovery_price` is still outside the allowed depeg threshold and should be nulled

**Query parameters**

| Param        | Type                                                   | Default  | Description                                                                                                                 |
| ------------ | ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `limit`      | `integer`                                              | `25`     | Max events or repair candidates to inspect per request (`max 25`)                                                           |
| `offset`     | `integer`                                              | `0`      | Pagination offset                                                                                                           |
| `dry-run`    | `"true"`                                               | required | Must be exactly `"true"` for `GET`                                                                                          |
| `min-supply` | `number`                                               | `0`      | Minimum supply (USD) to include in audit                                                                                    |
| `symbol`     | `string`                                               | —        | Filter by symbol (case-insensitive)                                                                                         |
| `repair`     | `"synthetic-splits" \| "contradictory-recovery-price"` | —        | Preview synthetic split consolidation or contradictory terminal-price repairs instead of the CoinGecko false-positive audit |

### `POST /api/audit-depeg-history`

Audits existing depeg events against CoinGecko historical price data to detect false positives.

`POST /api/audit-depeg-history?repair=synthetic-splits` instead runs a historical repair pass that consolidates adjacent same-direction events when either:

- a live event was split by the retired DEX-only auto-close behavior after the earlier row closed near peg, or
- a backfill row ended without recovery and a live row resumed the same severe move within one sync gap because the historical replay window expired mid-event.

When a repair group ends in a live row, the live tail is kept as the canonical record and inherits the earlier start plus worst peak so future backfills do not recreate the split.

`POST /api/audit-depeg-history?repair=contradictory-recovery-price` instead nulls ended-event `recovery_price` values that still sit outside the permitted depeg threshold. This is the bounded repair path for legacy rows closed by a native-quote recovery while the stored USD price still looked depegged.

Mutating delete/repair runs and false-positive deletes stage any required PSI stability-index recompute into the same D1 batch commit. If that commit fails, the endpoint now returns `500` with a specific error and does not leave a partial delete/repair behind.

`GET` is accepted only with `dry-run=true`; mutating audits require `POST`.

**Query parameters**

| Param        | Type                                                   | Default | Description                                                                                                            |
| ------------ | ------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `limit`      | `integer`                                              | `25`    | Max events or repair candidates to process per request (`max 25`)                                                      |
| `offset`     | `integer`                                              | `0`     | Pagination offset                                                                                                      |
| `delete`     | `string`                                               | —       | Comma-separated event IDs to delete directly (skips CG audit)                                                          |
| `dry-run`    | `"true"`                                               | —       | When `"true"`, preview deletions without touching DB. Default behavior deletes false positives                         |
| `min-supply` | `number`                                               | `0`     | Minimum supply (USD) to include in audit                                                                               |
| `symbol`     | `string`                                               | —       | Filter by symbol (case-insensitive)                                                                                    |
| `repair`     | `"synthetic-splits" \| "contradictory-recovery-price"` | —       | Run synthetic split consolidation or contradictory terminal-price repair instead of the CoinGecko false-positive audit |

### `POST /api/trigger-digest`

Queues a deferred daily-digest regeneration, bypassing the normal 1-hour dedup check. The HTTP handler writes a bounded retryable intent into the `digest:force-run-request` D1 cache row and returns `202`; the dedicated `*/5 * * * *` digest-trigger poll slot runs due intents under the scheduled-event wall-clock and the existing `daily-digest` lease. Transient failures retry with bounded backoff for up to three attempts, while permanent or exhausted failures remain as retained `dead_letter` state.

**Response**

```json
{
  "ok": true,
  "accepted": true,
  "requestId": "manual-digest-...",
  "message": "Digest trigger queued; will execute on the next polling tick (≤5 min)."
}
```

**Status:** `202 Accepted`

The worker no longer uses HTTP `waitUntil()` for this action. It enqueues the intent in D1 and returns immediately so the Access-gated ops proxy does not need to hold the HTTP request open for the full Anthropic generation window. The scheduled poll logs each run against the `daily-digest` cron history and persists a compact `digest:last-trigger-result` cache entry for D1 inspection/future UI surfacing, including retry state, retained dead letters, and manual `skipped_locked` outcomes when another digest run already holds the lease. The current admin panel shows the enqueue result from the browser session; it does not yet render the persisted poll outcome.

Unhandled pre-enqueue failures are wrapped by the shared error handler and return `500` with `{ "error": "Internal Server Error" }`.

### `POST /api/reset-blacklist-sync`

Rolls back blacklist sync state to re-scan missed events. EVM chains are rolled back by 50,000 blocks; Tron is rolled back by 7 days. The action rewinds both typed and compatibility cursor columns, increments the attempt generation to fence late writers, and clears successful-scan freshness. Routed through `worker/src/router.ts`.

This is a global emergency rewind, not the recovery path for a known event manifest. Bounded data recovery must use a reviewed config/event-specific reconciliation so unrelated cursors are not moved.

**Response** (`evmReset` / `tronReset` are row-change counts from the `blacklist_sync_state` UPDATE, not block numbers)

```json
{
  "ok": true,
  "evmReset": 5,
  "tronReset": 2
}
```

### `GET /api/debug-sync-state`

Returns current blacklist sync state for all configured chains. Useful for diagnosing sync issues. Routed through `worker/src/router.ts`.

**Response**

```json
[
  {
    "configKey": "ethereum-usdc",
    "stablecoin": "USDC",
    "stablecoinId": "usdc-circle",
    "chainId": 1,
    "chainName": "Ethereum",
    "contractAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "providerSource": "evm-logs",
    "cursorKind": "evm_block",
    "cursorValue": 19500000,
    "lastBlock": 19500000,
    "cursorAgeSec": null,
    "attemptGeneration": 12,
    "lastAttemptedAt": 1710503000,
    "lastSucceededAt": 1710503000,
    "lastSkippedAt": null,
    "lastFailedAt": null,
    "consecutiveSkips": 0,
    "consecutiveFailures": 0,
    "lastOutcome": "quiet",
    "lastObservedSafeHead": 19500000,
    "lastSafeHeadObservedAt": 1710503000,
    "lastEventAt": 1710500000,
    "lastEventAgeSec": 3600,
    "lastEventBlock": 19499999,
    "eventCount": 42,
    "lastRunStartedAt": 1710503000,
    "lastRunStatus": "ok",
    "lastErrorClass": null,
    "lastErrorMessage": null
  }
]
```

### `POST /api/remediate-blacklist-amount-gaps`

Admin-only bounded remediation endpoint for recoverable blacklist rows.

**Authentication:** same admin auth as other ops endpoints.

**Idempotency:** supported via optional `Idempotency-Key`.

**Inputs**

- `chainId?: string`
- `stablecoin?: BlacklistStablecoin` from the shared `BLACKLIST_STABLECOINS` set
- `limit?: number` default `25`, max `200`
- `dryRun?: boolean` default `true`
- `onlyMissingProvenance?: boolean` default `false`; set `true` to restrict the pass to legacy rows missing contract/config provenance
- `maxAttempts?: number` default `25`

**Dry-run response**

```json
{
  "ok": true,
  "dryRun": true,
  "candidateCount": 26,
  "resolutionCounts": {
    "resolved": 26,
    "missing_config": 0,
    "ambiguous_config": 0
  }
}
```

**Write-enabled response**

```json
{
  "ok": true,
  "dryRun": false,
  "applied": {
    "resolved": 26,
    "resolvedZero": 26,
    "providerFailed": 0,
    "configMissing": 0,
    "configAmbiguous": 0,
    "budgetUsed": 26,
    "budgetLimit": 900
  }
}
```

### `POST /api/backfill-blacklist-current-balances`

Admin-only one-shot backfill endpoint for `blacklist_current_balances`, intended for blacklist configs whose historical events were ingested before the current-balance cache existed.

**Authentication:** same admin auth as other ops endpoints.

**Idempotency:** supported via optional `Idempotency-Key`.

**Query parameters**

| Param        | Type      | Default | Description                                                                                   |
| ------------ | --------- | ------- | --------------------------------------------------------------------------------------------- |
| `stablecoin` | `string`  | —       | Optional uppercase symbol filter; matches any configured blacklist-contract stablecoin symbol |
| `chainId`    | `string`  | —       | Optional chain filter matching the blacklist contract config `chainId`                        |
| `limit`      | `integer` | `500`   | Max newest latest-per-address blacklist-event rows to load per matching config (max `2000`)   |
| `dryRun`     | `"true"`  | —       | Preview the active-blacklisted candidate count without writing cache rows                     |

`400` is returned when the filters match no configured blacklist contracts.

**Dry-run response**

```json
{
  "ok": true,
  "dryRun": true,
  "configs": [
    {
      "configKey": "ethereum-pyusd",
      "stablecoin": "PYUSD",
      "chainId": "ethereum",
      "candidateCount": 12,
      "updated": 0,
      "deleted": 0,
      "failed": 0
    }
  ],
  "totals": {
    "candidates": 12,
    "updated": 0,
    "deleted": 0,
    "failed": 0
  },
  "budgetUsed": 0,
  "budgetLimit": 900
}
```

**Write-enabled response**

```json
{
  "ok": true,
  "dryRun": false,
  "configs": [
    {
      "configKey": "ethereum-pyusd",
      "stablecoin": "PYUSD",
      "chainId": "ethereum",
      "candidateCount": 500,
      "updated": 12,
      "deleted": 0,
      "failed": 1
    }
  ],
  "totals": {
    "candidates": 500,
    "updated": 12,
    "deleted": 0,
    "failed": 1
  },
  "budgetUsed": 37,
  "budgetLimit": 900
}
```

### `GET /api/admin-action-log`

Returns the last N audited operator actions (action name, actor, target, result, HTTP status, details) for post-incident review. This includes every endpoint surfaced by the admin action catalog, including read-only inspections and dry-run previews, plus handler-owned audit events outside that catalog.

**Authentication:** admin. **Optional query:** `?limit=<1-200>` (default 50).

Malformed `limit` defaults to `50`; out-of-range `limit` is clamped to `1..200`.

Catalog rows contain only allowlisted operational metadata: canonical path/method, configured scope and target, dry-run/live/inspect mode, result status, HTTP status, execution certainty, result mode, replay state, and an opaque SHA-256 idempotency identity when the request supplied a valid key. Request bodies, arbitrary query parameters, authentication headers, raw handler responses, and plaintext tokens are never stored. Keyed catalog intents are unique by action and opaque intent identity; a same-key replay does not create another row, while a distinct key records a new intent. If the first audit write was transiently missing, a replay can backfill it; the original non-replay outcome remains authoritative over an earlier replay placeholder.

For browser actions, `actor` is the normalized email from the signature-verified operator UI Access JWT; browser-supplied actor headers are ignored. Direct service-token tooling without a verified human claim remains attributed to the internal actor. If canonical audit persistence fails after an idempotent result exists, the router returns `503 audit_persistence_failed`; retrying with the same key replays the result and retries the audit write without rerunning the effect.

**Response**

```json
{
  "entries": [
    {
      "id": 42,
      "at": 1700000000,
      "actor": "alice@pharos.watch",
      "action": "reset-blacklist-sync",
      "target": "blacklist-sync",
      "result": "ok",
      "httpStatus": 200,
      "details": { "cleared": 1 }
    }
  ]
}
```

### `POST /api/admin-telegram-broadcast`

Sends a pre-rendered maintenance/broadcast message to Telegram subscribers via the standard pending-queue fan-out. Used for maintenance windows or outage notices. Live calls submit one pending-queue message per target chat per message chunk; existing rows with the same dedupe key are updated rather than duplicated. The existing dispatch cron delivers them with the same per-chat rate-limit isolation and wall-clock retry semantics as regular alerts. Every live call writes one row to `admin_action_audit`.

**Authentication:** admin (`X-Pharos-Admin: 1` header required).

**Body**

```json
{
  "messageHtml": "<b>Pharos maintenance</b>\nThe bot will be offline 10:00-10:15 UTC.",
  "scope": "all",
  "dryRun": true,
  "canaryChatId": "123456789"
}
```

`scope` is `all` (every row in `telegram_subscribers`), `deliverable-watchers` (rows with at least one active global, per-coin, or preset alert follow), or `global-subscribers` (rows where at least one `global_alert_*` flag is set). `dryRun` is required and must be a boolean. `messageHtml` must be a non-empty string, is capped at 16,000 characters, and uses Telegram HTML formatting; long bodies are split via the same chunking pipeline as alerts. Dry-run and live requests preflight the supported Telegram HTML subset before target selection or enqueue: `a[href]`, `b`/`strong`, `i`/`em`, `u`/`ins`, `s`/`strike`/`del`, `code`, `pre`, `tg-spoiler`, and `blockquote` with optional `expandable`, plus simple named/numeric HTML entities. Live requests require `canaryChatId`, an operator-controlled private-chat ID, and exclude that ID from the fleet enqueue after sending every chunk to it silently with link previews disabled. The legacy optional `acknowledgeBacklogRisk` boolean is accepted for rolling-client compatibility but cannot bypass the TTL-reserve gate.

**Dry-run response (`dryRun: true`)**

```json
{
  "targetChatCount": 1247,
  "chunkCount": 1,
  "targetMessageCount": 1247,
  "pendingCapacity": {
    "total": 0,
    "active": 0,
    "due": 0,
    "deferred": 0,
    "expired": 0,
    "nearTtl": 0,
    "oldestPendingAgeSec": null,
    "oldestDuePendingAgeSec": null,
    "estimatedDrainTimeSec": 0,
    "drainBudgetPerRun": 1800,
    "dispatchIntervalSec": 300
  },
  "deliveryEstimate": {
    "currentPendingActive": 0,
    "projectedPendingMessages": 1247,
    "drainBudgetPerRun": 1800,
    "adminBroadcastTtlSec": 2700,
    "estimatedDrainTimeSec": 300,
    "minimumTtlReserveSec": 900,
    "remainingTtlReserveSec": 2400,
    "hasMaterialTtlReserve": true,
    "fitsWithinMinutes": {
      "5": true,
      "15": true,
      "30": true,
      "60": true
    }
  },
  "htmlPreflight": "ok",
  "canary": {
    "requiredForLive": true,
    "chatId": "123456789",
    "wouldSendChunkCount": 1
  },
  "sample": ["100", "200", "300", "400", "500"]
}
```

`sample` lists up to the first 5 target chat IDs (sorted ascending) — useful for sanity-checking the scope filter before going live. `targetMessageCount` covers only the fleet rows; when the supplied canary is also in the selected scope, it is excluded from that count. No Bot API call or queue write occurs during dry-run. Successful dry-runs and HTML preflight failures both write admin audit entries.

**Live response (`dryRun: false`)**

```json
{
  "enqueued": 1247,
  "canary": {
    "chatId": "123456789",
    "chunksSent": 1
  },
  "deliveryEstimate": {
    "projectedPendingMessages": 1247,
    "estimatedDrainTimeSec": 600,
    "minimumTtlReserveSec": 900,
    "remainingTtlReserveSec": 2100,
    "hasMaterialTtlReserve": true
  }
}
```

Before enqueue, live execution requires the admin-delivery pause to be inactive and the bot-wide transport circuit to be closed, claims one admin transport permit, and sends the exact chunks to the private canary. A rejected, uncertain, or incomplete canary prevents all fleet enqueue. `enqueued` reports the number of non-canary chat/chunk messages submitted to the pending queue (`fleetChatCount * chunkCount`). Because the queue uses dedupe upserts, replaying the same broadcast before drain can update existing rows instead of inserting new rows. The dispatch cron drains the queue on its normal cadence.

**Error responses:** `400` for invalid JSON, empty or over-16,000-character `messageHtml`, unknown `scope`, non-boolean `dryRun`, malformed `canaryChatId`, or a live request without `canaryChatId`. `422` for malformed/unsupported Telegram HTML or a canary rejected for formatting/bad-request reasons. `409` when the projected fleet backlog cannot retain the hard 15-minute reserve inside the 45-minute admin TTL, or when admin delivery is operator-paused/the transport circuit is unavailable. `503` covers a transport permit denial or non-formatting canary failure, and `500` means the live Worker has no bot token. Canary failures report `fleetEnqueued: 0`.
