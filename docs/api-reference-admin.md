# Pharos API Admin Reference

> **Agent navigation** — Internal operator reference. Start at [Admin endpoint entry](#admin-endpoint-entry), read Admin Auth And Idempotency, then search the exact route heading.

This operator-only companion to [api-reference.md](./api-reference.md) is not published through `/docs/` or listed in `PUBLIC_DOCS`.

## Admin Auth And Idempotency

Admin endpoints are authenticated only on the `ops-api.pharos.watch` host. Cloudflare Access must authenticate the caller first, then inject `Cf-Access-Jwt-Assertion` for the worker. `worker/src/lib/auth.ts` verifies that JWT against the configured Access audience (`CF_ACCESS_OPS_API_AUD`) and team domain (`CF_ACCESS_TEAM_DOMAIN`) via `shared/lib/cloudflare-access-jwt.ts`, including signature, `aud`, `exp`, and `iss` checks. Browser operators should use `https://ops.pharos.watch/admin/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access; the Pages proxy verifies the inbound UI Access token against `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD`, requires an interactive Access token (`type: "app"`), and accepts the token from `Cf-Access-Jwt-Assertion` when Cloudflare forwards it or from the same-origin `cf-access-token` / `CF_Authorization` carrier when the browser is operating off an existing Access session. Mutating requests still require same-origin `Origin`.

Mutating admin calls also require `X-Pharos-Admin: 1` after Cloudflare Access authentication. Browser proxy calls forward that header from the operator UI and additionally require same-origin `Origin`; direct `ops-api` automation must send the header along with the Access service-token credentials.

The website-internal read lane is separate from Cloudflare Access. `site-api.pharos.watch` accepts allowlisted `GET` public-read paths plus the internal `POST /api/telegram-adoption` mutation and requires `X-Pharos-Site-Proxy-Secret`, which Pages proxies inject server-to-server from `SITE_API_SHARED_SECRET`. All Pages hosts — production and preview — must configure `SITE_API_ORIGIN=https://site-api.pharos.watch` (or a Worker preview URL that accepts the site-data secret); the Pages proxies fail closed with `500` when that binding is missing. The `/_site-data/*` lane additionally accepts requests only when the browser `Origin` header (or `Referer` as a fallback) matches `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, or a subdomain of `stablecoin-dashboard.pages.dev`. Public browser traffic must not call `site-api.pharos.watch` directly.

Many router-dispatched mutating admin endpoints also support optional `Idempotency-Key` handling. Current idempotent routes are:

- `POST /api/backfill-dews`
- `POST /api/trigger-digest`
- `POST /api/trigger-yield-coverage-audit`
- `POST /api/reset-blacklist-sync`
- `POST /api/remediate-blacklist-amount-gaps`
- `POST /api/admin-telegram-broadcast`
- `POST /api/api-keys`
- `POST /api/api-keys/:id/update`
- `POST /api/api-keys/:id/deactivate`
- `POST /api/api-keys/:id/rotate`

When an `Idempotency-Key` is supplied on one of those routes, the worker fingerprints the request and reserves the key with owner/generation fencing before execution. Terminal responses echo `Idempotency-Key` plus `X-Idempotent-Replay`; a stored terminal response is replayed without rerunning the action, while reuse with a different request fingerprint returns `409`. Only an abandoned reservation whose execution never started can be reclaimed after its takeover window.

Once execution has been marked as started, an unconfirmed outcome is never retried automatically. An in-flight duplicate, a handler throw after that point, or a terminal response that cannot be confirmed as persisted returns `503` with `error: "execution_unknown"`; subsequent requests with the same key also return `503` with `X-Idempotent-Replay: true` and do not invoke the handler again. `execution_unknown` rows are exempt from the seven-day terminal TTL, so the original key can never age out and reserve a fresh row. Operators must reconcile whether the external effect occurred before deciding whether to submit a new idempotency key.

A stale started reservation stays terminally `execution_unknown`: it is never handed back for re-execution unless the action ships a reconciliation callback that proves the original effect did not commit. No API-key or feedback action ships one today, so those keys are operator-reconciled.

API-key mutations are compare-and-swap writes. `PATCH /api/api-keys/:id` sets only the fields present in the validated body and is fenced on the key prefix observed by the request, so a concurrent deactivation is never undone by an unrelated `{name}` update; `POST /api/api-keys/:id/rotate` is fenced on the same prefix in the batch that moves the donor claim. When the fence does not match, both return `409` (`API key changed concurrently; re-read it before updating`/`… before rotating`) instead of a silently lost write, and the caller must re-read the key before retrying.

The worker’s idempotent admin route helpers now authenticate first and only then enter idempotency bookkeeping. That keeps the helper contract aligned with its name and prevents future admin endpoints from accidentally becoming “idempotent but unauthenticated” through wrapper misuse.

The `/admin/` UI now sends an `Idempotency-Key` automatically for supported manual actions so double-submits from the operator surface replay safely.

---

## Admin Endpoints

### Admin endpoint entry

Read [Admin Auth And Idempotency](#admin-auth-and-idempotency) before changing an operator handler. Then search the exact method and route heading below and read only that contract; the endpoint sections retain their existing anchors. For dashboard payload changes, use the [status backend contract](./status-dashboard.md#backend-contract-get-apistatus) alongside the `GET /api/status` section. Public endpoint work belongs in the [public API reference](./api-reference.md), not this operator catalog.

Preferred operator access now splits by surface:

- Browser / human operators: use `https://ops.pharos.watch/admin/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access.
- CLI / automation: call `https://ops-api.pharos.watch/api/...` with `CF-Access-Client-Id` and `CF-Access-Client-Secret` so Cloudflare Access can mint the request JWT the worker verifies. Direct `ops-api` requests also work with Cloudflare Access user/JWT headers.

Endpoint sections below do not repeat the CLI header pair. Unless an endpoint says otherwise, direct operator examples assume the `ops-api` host plus those two Cloudflare Access service-token headers.

Historical rebuilds and staged captures run through `worker/scripts/one-shot-backfill.ts`, not HTTP or the dashboard; all twelve former routes are unregistered. Recurring `backfill-dews`, blacklist remediation/reset, digest and yield-audit triggers remain here with their existing authentication/idempotency contracts. CLI writes use Wrangler authentication and are not covered by HTTP idempotency reservations. Ordinary jobs use D1 commands; jobs requiring destructive multi-statement atomicity additionally require `--allow-atomic-import`, which acknowledges temporary live D1 unavailability. See [One-shot historical backfills](./runbooks/one-shot-backfills.md#operator-contract), [transport safety](./runbooks/one-shot-backfills.md#transport-safety) and [interruption/receipt cleanup](./runbooks/one-shot-backfills.md#interruption-and-cleanup) for the command inventory, unchanged job parameter/result contracts and reconciliation procedure.

### `GET /api/status`

Full admin dashboard: cron run history, cache freshness for all keys, data quality metrics, Telegram bot subscriber stats, and operator reconciliation signals.

Since 2026-09-27 dedicated asset-scoped circuit outages no longer count as source-wide degradation; the shared `protocol-redeem` circuit remains source-wide. The `priceSourceHealth.sourceDistribution` vocabulary now includes all six previously omitted registry buckets: `kava-pricefeed`, `aerodrome-onchain`, `velodrome-onchain`, `mento-fpmm`, `mento-broker`, and `protocol-redeem-cached-rate`. A bucket's availability in the contract does not imply that a current asset uses that source.

**Response shape:** `StatusResponse` (exported through `shared/types/index.ts`). The JSON below is illustrative; the canonical list lives in `shared/types/status/response.ts`. Retained diagnostics include yield/publication/provider/dependency health, canaries, reserve drift and reserve composition. The duplicate static custody warning and unmatched mint/burn circulation comparison are retired without response aliases.

The legacy top-level projections `gtProbe`, `priceProviderDiagnostics`, `cacheBlobSizes`, and the duplicate `alertBroker` block are intentionally omitted from `/api/status`. The retired alert-broker summary is also absent from `/api/health`; producer/provider diagnostics remain in the `sync-stablecoins` cron's latest-run metadata for operator inspection. Retained status sections are validated for their required fields and malformed sections fail closed at the admin client boundary.

Cron terminal execution and observed quality are independent: `degradedCrons` counts fresh operational degraded attempts (including inheritance behind neutral skips), not successful-run `metadata.quality.{reason,reasons,sources}` findings. Those findings remain visible in cron summaries and Attention. Observer `ok` does not renew the observed producer's publication clock.

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
    "adapterReliability": [
      {
        "adapterKey": "circle",
        "attempts": 72,
        "ok": 70,
        "degraded": 1,
        "error": 1,
        "skipped": 0,
        "successRate": 0.972
      }
    ],
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
    "conservationVersion": 1,
    "checkedAt": 1771856453,
    "criticalCount": 0,
    "rows": [
      {
        "stablecoinId": "usds-sky",
        "symbol": "USDS",
        "status": "insufficient-source",
        "conservationIssue": "Conservation evidence is not available.",
        "conservation": [],
        "coverageStatus": "full"
      }
    ]
  }
}
```

`dataQuality.onchainSupplyTrackedCoins` counts only coins with at least one `onchain_supply` row inside the current 3-day active monitoring window. Older historical rows are excluded from `staleOnchainSupply` and `onchainStaleRatio`. An active coin's latest row becomes stale after two `sync-kinesis-supply` producer cycles (currently eight hours).

Ratio-based on-chain status thresholds apply only when `dataQuality.onchainSupplyTrackedCoins >= 10`; below that floor, the counts remain visible but do not by themselves escalate `dataQualityStatus`.

`itemCount` and `dataQuality.totalStablecoins` are illustrative example values. In the live handler they reflect the current cached stablecoin payload size, not `TRACKED_STABLECOINS.length`.

`summary.availabilityImpactingUnhealthyCrons` and `summary.availabilityImpactingCronErrors` count only cron jobs tagged `statusImpact="critical"` in `shared/lib/cron-jobs.ts`. `summary.watchUnhealthyCrons` counts the watch-tier jobs that remain visible but do not degrade `availabilityStatus` on their own.

`summary.availabilityImpactingConsecutiveCronErrors` is the subset of `availabilityImpactingCronErrors` whose most recent 2+ runs are **all** `error`. A single transient critical-cron error increments `availabilityImpactingCronErrors` (and sets `availabilityStatus` to `degraded`), but only a `≥2`-consecutive streak increments `availabilityImpactingConsecutiveCronErrors` and escalates `availabilityStatus` to `stale`. This transient-vs-sustained split prevents rare upstream flakes (e.g. DefiLlama returning a truncated response body) from flipping public state on a single bad sample.

`summary.diagnosticIssueCount` counts best-effort status loader failures such as cache freshness lookups, reserve overview diagnostics, mint/burn diagnostics, and non-stablecoins data-quality subqueries. These issues reduce confidence and appear as info causes, but they do not degrade `availabilityStatus` or `dataQualityStatus` on their own unless all freshness evidence for the affected lane is gone.

`reserveComposition.status` is a derived health signal for live reserve coverage. After bootstrap, it becomes `stale` when `freshCoins === 0`; `degraded` when `freshCoverageRatio < 0.75`, `authoritativeFreshCoverageRatio < 0.5`, `persistentlyStaleIndependentCoins.length > 0`, or reserve capacity pressure is present — `writeTimeoutUncertain > 0`, or a `runBudgetTruncated` run whose deferred share (`deferredCoins / configuredCoins`) is at least `0.25`; and `healthy` otherwise.

`reserveComposition.freshCoverageRatio` is `freshCoins / configuredCoins`. `reserveComposition.authoritativeFreshCoverageRatio` counts only stronger evidence cohorts (`independentFreshEligible`, `independentFreshUnverified`, `staticValidatedFresh`) over `configuredCoins`.

`reserveComposition.runBudgetTruncated`, `deferredCoins`, `deferredAt`, and `nextCursorStablecoinId` expose the latest live-reserve deferred-tail cursor when the internal sync budget stopped the run before the queue tail. `persistentlyStaleIndependentCoins` lists independent feeds whose latest source has been failing beyond the persistent-stale window. `writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path and could not be proven authoritative by readback.

`crons[*].healthy` reflects availability impact. Fresh cron runs with `status="degraded"` are warning-only and counted in `summary.degradedCrons`, but they do not mark availability unhealthy on their own. Every counted job is derivable from the served records — a fresh degraded `lastRun`, or a neutral `lastRun` whose inherited degraded required run is served in `recentRuns` (appended after the ten-run display window when that window is all neutral, behind a newer proven-satisfied readback when one exists).

`availabilityStatus` also inherits the shared public-health floor used by `/api/health`: cache-impact status, the critical mint/burn lane's public warning/staleness contract, and 3+ public-impact open circuit groups can degrade availability even when cron freshness alone is still green. Dynamic per-coin `live-reserves:*` breakers remain visible in `circuits`, but they do not change `availabilityStatus` on their own.


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

`crons["dispatch-telegram-alerts"].lastRun.metadata` now carries a richer delivery breakdown, including fields such as `freshAttempted`, `freshSent`, `freshRetryQueued`, `freshPermanentFailures`, `pendingAttempted`, `pendingDrained`, `pendingRetryQueued`, `pendingDeferred`, `pendingRateLimited`, `pendingRetryAfterSec`, `pendingDropped`, `pendingEnqueued`, and expanded `eventsDetected` counters (`depegTriggered`, `depegResolved`, `depegWorsening`, `launch`, `suppressedMethodologyChanges`). Rows written before this breakdown (and recovery re-writes of them) can lack the fresh-side counters while still carrying the pending-side ones; the admin comms model reads an absent `freshRetryQueued` as `0` only when that dispatch completed `ok` and `pendingRetryQueued` is present, and keeps delivery `Unknown` for any other incomplete shape.

Source-event runs also include `authoritativePlanning`. It identifies `sourceEventId` and `sourceEventFamilies`; splits source-preset resolution, candidate-horizon, fan-out input loaders, preference-generation validation, routing, target materialization, duplicate suppression, queue handoff, and pending-drain duration; and reports capture/planning/handoff pages, fan-out load/cache counts, captured/planned/duplicate-suppressed/enqueued targets, and coordinator steps. Eventless runs return the same object with a null source ID and zero counts/timings so status consumers do not need a second shape.

The same cron metadata also exposes the live safety-alert source contract:

- `safetyAlertSourceState`
- `safetyAlertSourceAgeSeconds`
- `safetyAlertsSuppressed`
- `safetyAlertSourceGeneration`

When `safetyAlertsSuppressed=true`, DEWS/depeg/launch alerts can still continue, but safety-grade alerts remain paused until `compute-safety-score-v9` accepts a fresh canonical publication and the Telegram lane reseeds its prior snapshot.

`crons["status-self-check"].lastRun.metadata` now also includes `freshnessDiagnostics` when raw status had to fall back from a freshness sentinel to table or cron evidence during the self-check run, plus `d1CapacityMonitoring` when the dedicated Cloudflare D1 status bindings are configured.

`probe.internal`, `probe.external`, and `probe.internalExternalDiscrepancy` are optional because legacy `status_probe_runs` rows did not persist split-plane details. New rows compare rotating router diagnostics against three production-domain HTTP health/gate targets; these are unequal populations, not paired-route outage proof. Without an execution context, the internal-labelled cohort uses HTTPS and reports `probeMode: external-http`. Site health requires the trimmed configured shared secret; otherwise the site target measures only an expected `401`/`403` gate. Ops accepts `302`/`403` blocking responses without attesting redirect Location/Access identity or authenticated availability. There is no condition-specific probe/discrepancy push notification; escalation is operator-driven. Failed discrepancy reads expose `consecutiveDivergent: null`, not zero, and do not reset persisted streaks.

`datasetFreshness` covers the key operator-visible datasets written by the pipeline: cache-backed stablecoins, blacklist, mint/burn, supply snapshots, safety-grade history, yield, depeg/dews tables, daily digest, and discovery backlog timestamps.

`dataQuality.repairDebt` summarizes low-priority repair/backfill backlog separately from foreground publication health. It reports `status`, `openCount`, `oldestAgeSec`, `byKind`, `availabilityEscalated`, `nextRunnerDueAt`, and `source` from active `worker_repair_tasks` rows. The legacy DDR-specific `ddrRepairDebt*` fields remain populated for compatibility from active DDR task `subject_id`/`payload_json` details and continue to drive the `ddr_repair_debt_present` data-quality warning.

`priceSourceHealth` is derived from the final `sync-stablecoins` asset payload and summarizes resolved price-source distribution, active canonical source-depth buckets (`sourceDepthDistribution`, keyed by `consensusSources.length` buckets `0`, `1`, `2`, `3`, `4`, `5+`), confidence buckets, total assets, and the timestamp of the latest successful price-health snapshot. CoinGecko-vs-Pharos divergence details live in the separate `coingeckoPriceDiff` block.

`coingeckoPriceDiff` is an admin-only live comparison block. It reads the cached tracked assets with `geckoId`, fetches current CoinGecko spot prices and their upstream timestamps through one or more batched `simple/price` calls, and compares only quotes accepted by the shared CoinGecko freshness validator. Missing, invalid, stale, or materially future timestamps are excluded before reporting rows where `abs(pharosPrice - coinGeckoPrice) / coinGeckoPrice > 0.05`. The field is `null` when the comparison is unavailable in the current environment or when the loader fails; failures are surfaced through `sectionErrors.coingeckoPriceDiff`.

Malformed CoinGecko batches fail the whole diagnostic visibly rather than publishing a clean partial result. Zero comparable quotes means unmeasured, not zero drift. This cached-Pharos/live-CoinGecko comparison is triage evidence, not matched-clock consensus or a pricing veto.

`d1Usage` is permanent admin-only D1 diagnosis, normally reused from the 15-minute self-check raw snapshot (30-minute TTL), with live fallback when missing/stale. Dedicated Cloudflare bindings enable concurrent REST database info and trailing-24h `d1AnalyticsAdaptiveGroups` GraphQL reads; missing config yields null and failures yield `sectionErrors.d1Usage`. Preserve each `checkedAt` and 24-hour window rather than equating browser polls with upstream reads. Hourly capacity observations coalesce in UTC-hour rows; live fallback may refresh that history. `capacity` contains authoritative current 60/75/90% utilization thresholds and advisory 24h/72h/7d/30d regressions with sample spans; `conservativeWindow` means shortest valid window, not maximum slope or guaranteed runway. Missing/malformed/expired/future-clock capacity degrades public health with sanitized warnings, never exact private size/forecast fields. API-only `tableGrowth` contains daily reviewed-name/family row counts/deltas, nullable timestamp attribution, top growers and `failedTables` for unreadable/invalid counts; same-day cache reuse is not a separate claim, its serving age is at most 50 hours, and rows are not table byte sizes. The D1 card does not render per-table census details.

`liquidityHealth` is derived from the latest `sync-dex-liquidity` cron metadata and summarizes row coverage, value coverage, major-asset coverage, failed sources, and current/previous coverage-class distribution for the operator dashboard.

`yieldHealth` is derived only from existing yield cache rows and cron metadata: `yield-rankings`, per-family `yield:supplemental-sources:v1:*`, `yield-coverage-audit`, and `crons["sync-yield-data"]`. `rankingStatus` follows the post-V9 `sync-yield-data` cache runway (`>8x` degraded, `>12x` stale); missing or stale rankings are public-critical because `/api/yield-rankings` and `/yield/` depend on them. `rankingCountDelta` and `previousRankingCount` come from `sync-yield-data` source-coverage metadata, with a fallback to the top-level severe-coverage-guard metadata when publication is blocked before normal source coverage is assembled. Safety coverage is admin-watch unless it falls below `0.75`, supplemental family cache age is admin-watch above 6h, and coverage-audit age is admin-watch above 45d. `yieldHealth.benchmarkRegistry` evaluates every benchmark key used by published rows, including row counts and fallback-selection counts; any used fallback is degraded, while a missing or older-than-48h used benchmark is stale. The legacy `yieldHealth.benchmark` field remains the USD-only compatibility view. `yieldHealth.supplemental` reports `familyCount`, `freshFamilyCount`, `degradedFamilyCount`, `staleFamilyCount`, `missingFamilyCount`, and a `families` map keyed by source family with per-family age/source-count/status; a fresh all-empty family snapshot is valid state, while no valid family rows means the supplemental section is unavailable/stale based on family evidence. `sourceRiskCoverage` reports backend-only coverage/null rates for nested `sourceRisk.*` fields across best and alternate ranking rows; `"unknown"` venue tiers count as null-equivalent coverage gaps. Loader failures return `yieldHealth: null` and `sectionErrors.yieldHealth`.

These are permanent operator diagnostics with no pending promotion. Hydration reads the canonical compact Safety Score index/health, respects held/error branches and both original yield/safety 24-hour clocks; index integrity failures never permit publish-time fallback. `liveSafetyHydration` reports both clocks and the fallback budget. `pysInputs` is publisher metadata, not table reconciliation: both finite nonnegative integer counters and a nonzero denominator are required, otherwise status/rate remain unknown/null with a reason and source run. Comparison-anchor examples retain `maxAgeSeconds` and source run; oldest means oldest overall anchor, not oldest stale anchor.

The monthly yield queue remains permanently DISPLAY-ONLY. `queueTotals.totalItemCount` is the full visible post-disposition cohort, `publishedItemCount` is the producer's capped sample and `truncatedItemCount` is the difference (for example 146 = 40 + 106). `byKindScope="full-visible"` labels pre-cap counts; older reports are explicitly `published-sample`, never full totals. Status renders at most six per side. No disposition UI/API or human-write workflow is introduced.

`publicationHealth` is a permanent read-only diagnostic for six surfaces: DEX liquidity, yield rankings, stablecoins, DEWS, PSI and canonical Safety Score V9. Existing ledgers/accepted V9 artifacts own publication, not this projection. Loaders settle independently; failed surfaces are omitted and named in `failedSurfaces`, with `sectionErrors.publicationHealth` set. Dependency and Pipeline projections share `classifyPublicationDiagnostic`: only a newer failed/rejected attempt degrades a retained publication, and a pending candidate degrades above the shared two-hour budget (not at the exact boundary). Missing/read-failed evidence is not a healthy publication.

`dependencyHealth` is a read-only derived matrix over existing status signals. The worker combines `caches`, `crons`, `publicationHealth`, and the static registry in `shared/lib/data-dependency-registry.ts` into per-dependency status rows plus `rootCauseGroups` that group degraded/stale symptoms under the highest upstream dependency. This is operator triage metadata only: it does not perform extra D1 reads, does not change `availabilityStatus` / `dataQualityStatus`, and does not mutate publication ledgers.

`providerCircuitHealth` is a permanent read-only diagnostic. `listActiveCircuitSources` defines its inventory; bounded direct `circuit:<source>` reads own counts, independently of the retired `provider:circuit:index` row, which has no runtime reader or writer. Absent rows are valid initial closed state; malformed stored rows contribute `invalidCount`/family `invalid`, not closed counts, with bounded `invalidProviders` reasons. Full totals are independent of the 25-provider detail cap. Loader failure returns null plus a section error; public raw circuits and runtime breaker decisions are unchanged.

`canaries` is a permanent read-only admin supplement over `worker_canary_runs`, selecting the latest row **per active check ID in the selected mode**, not one atomic generation. The nine checks are DEX current publication, DEX actual global row, blacklist null identity, stablecoins exact active coverage, PSI latest sample, DEWS published generation, canonical accepted/held Safety Score V9 publication, GBP SONIA benchmark current, and USD T-bill benchmark current. Both benchmark diagnostics use shared 48-hour fetch/five-day record budgets and a known two-publication fresh streak; they do not change producer admission. Retired check IDs and other historical modes are excluded. `executionStatus: completed|failed` and `executionFailureReason` are independent of finding `status`/`severity`; absent legacy execution metadata remains unknown. The summary exposes `completedCount`, `failedCount` and `unknownExecutionCount`; invalid/future observation clocks are nonhealthy. In `status`, measured severe findings stay hard ledger findings but return cron `ok` plus named quality; failed required work remains degraded. Pending deployed-override inventory, `alert` retains stronger terminal errors and `shadow` hidden collection; `off`/`shadow` return empty/unknown status evidence. The approved final policy is `off|status`, with obsolete selections becoming `off` only after that inventory is migrated. Loader failures return `canaries: null` and `sectionErrors.canaries`. No canary finding directly changes availability/scoring or sends a condition-specific push notification.

`mintBurnReconciliation` is the permanent native conservation diagnostic, enumerated from configured contracts and canonical metadata independently of circulating-supply cache availability. `conservationVersion: 1`, per-contract identities/fingerprints, matched blocks/hashes, raw arithmetic, scan/cursor coverage and unresolved mismatches retain their existing authority. Rows expose `conservationIssue`, `coverageStatus` and `conservation`; only `criticalCount` is retained in the summary. The unmatched USD stock/flow comparison, its four metrics/context and unused native `comparedCoins`/`insufficientCount` have been retired with a clean private-client/UI cutover; no response aliases are provided. The duplicate runtime classification-warning list and its error key are also retired; the broader catalog CI custody invariant remains authoritative.

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

`discrepancy.consecutiveDivergent` is nullable: a failed required streak read returns `null` and additive `sectionErrors.discrepancy`, never fabricated zero. A successful SELECT with no global row may report the initial zero. The counter remains diagnostic; probe/status comparison does not itself establish an outage or send push notifications.

### `GET /api/reserve-attempt-history`

Admin-only per-coin attempt timeline for the live-reserve sync lane. This is the first production read path for `reserve_sync_attempt_history`; it turns triage from log grep into a bounded query.

**Query parameters**

| Param  | Type      | Default | Description                                                        |
| ------ | --------- | ------- | ------------------------------------------------------------------ |
| `coin` | `string`  | —       | Required stablecoin id (e.g. `usdc-circle`)                        |
| `limit`| `integer` | `50`    | Number of attempts to return (1–200), newest first                  |

**Response shape:** `{ "coin": string, "attempts": Array<{ stablecoinId, attemptedAt, adapterKey, breakerKey, attemptId, status, failureCategory, warningCodes, lastError, durationMs }> }`. `failureCategory` is the cron-classified failure (`network`, `upstream-http`, `parser-drift`, `validation`, `storage-write`, `circuit-open`, …); `warningCodes` are the attempt-scoped warning codes; `durationMs` reads the producer's current `metadata.durationMs`, with backward-compatible fallback to `metadata.diag.durationMs`. Only finite nonnegative numbers are accepted; absent or invalid timing stays `null`. A missing `coin` returns `400`.

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

`nonExpiring` counts every key with `expiresAt = null`, so it grows by one for each supporter key issued at `POST /api/donor-key-claims`. A rising count on a release that opened donor claims is expected, not an anomaly; filter the key list by `tier = "donor"` to separate supporter keys from deliberate operator exceptions.

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
| `tier`               | `"standard" \| "self-serve" \| "donor"` | No       | Issuance tier; defaults to `"standard"`. `"self-serve"` is the retired self-serve lane's tier (issuance path removed 2026-09-29; existing keys drain until their 60-day expiry), and `"donor"` is written by the supporter-key claim at `POST /api/donor-key-claims` |
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

Deactivation does not erase the row, wallet-bearing name, or usage metadata. For a donor privacy request, verify control of the wallet and resolve the exact donor key ID and claim prefix through the private operator lane. Deactivate that key first. Then use an operator-reviewed D1 transaction/batch restricted to that ID to delete its rows from `api_key_rate_limit`, `api_key_request_stats`, and `api_key_audit_log`, followed by its `api_keys` row. Read back that these rows are absent and that the original `api_key_donor_claims` row remains unchanged. Do not put the address or tokens in command output, audit detail, or a public feedback issue. There is no public deletion endpoint.

Keep `api_key_donor_claims` as the one-claim fence: it retains the address, prefix, and claim time even after key deletion, and another claim returns `409` when the key row is missing. Tell the requester exactly what remains; this is partial erasure. Removing the claim row is a separate, explicitly authorized reissuance decision, because an eligible wallet can then obtain a new key. The public donation ledger and any separately retained provider backups are outside this key-row deletion procedure; do not promise they have been erased.

**Response shape:** `ApiKeyMutationResponse`

### `POST /api/api-keys/:id/rotate`

Admin-only secret rotation. The old token stops working immediately and a new plaintext token is returned once. Rotation does not accept expiry input and preserves the current `expiresAt`.

For donor keys, rotation updates the claim prefix and key material in one atomic D1 batch: both writes commit or neither does. Concurrent rotations keep the claim mapped to the surviving key prefix.

Donor eligibility uses Safety Score grades at claim time, not donation time. Later grade changes alone do not revoke or change an issued key; rotation also preserves its tier, quota, and expiry.

**Response shape:** `ApiKeyRotateResponse`

Supporter keys never rotate by self-service: re-signing the claim message returns `409`, so a donor who lost a key asks through the private channel (Telegram DM to `@TokenBrice`, secondary X DM to `@PharosWatch`; constants in `shared/lib/public-api-contract.ts`), the operator verifies the donating wallet, and rotates it here. The same channel handles key-record removal requests. The key is named `donor <full lowercase address>`, so the admin list is searchable by the full address.

Correcting the ledger is a two-step operator action. When removing or correcting a donation row in `shared/data/funding/donations.json` leaves a wallet with less than $10 in qualifying stablecoin donations, the runtime does not revoke anything on its own, because eligibility is only read at claim time. Find the `donor` key whose name carries that address and deactivate it with `POST /api/api-keys/:id/deactivate`. Leave the `api_key_donor_claims` row in place: it keeps that address from claiming again, and a re-claim attempt against a deactivated key returns `403` rather than issuing a second key.

### `GET /api/backfill-dews`

Default `GET` reconstructs stored-event diagnostics. `events[].evaluation` reports availability (`available`, `partial`, `unavailable`), reasons and evaluated/expected pre-event days. Missing anchors stay unavailable. With no scored pre-event day, `predicted=null`; observed misses stay `false`. Summary `evaluableEvents` excludes these cases, `excludedEvents`/`partialEvents` disclose coverage, and `tpRate` uses only evaluable events (`null` if none); lead times cover detected events.

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

### `POST /api/trigger-digest`

Queues a deferred daily-digest regeneration, bypassing the normal 1-hour dedup check. The HTTP handler writes a bounded retryable intent into the `digest:force-run-request` D1 cache row and returns `202`; the dedicated `*/5 * * * *` digest-trigger poll slot runs due intents under the scheduled-event wall-clock and the existing `daily-digest` lease. Transient failures retry with bounded backoff for up to three attempts, while permanent or exhausted failures remain as retained `dead_letter` state.

An optional JSON body instead updates exactly one editorial gate: `{"styleGateMode":{"daily":"enforce"}}` or `{"styleGateMode":{"weekly":"shadow"}}`. Only `daily|weekly` and `shadow|enforce` are accepted; unknown fields, malformed/unscoped values, and two-kind updates return `400` without mutation. A scoped update is **mode-only**: it writes only that kind's mode key and does not queue or overwrite `digest:force-run-request`. It returns `202` with `ok`, `accepted`, the full effective `styleGateMode: {daily, weekly}`, and `"Style gate mode updated; no digest generation queued."`, without a force-run `requestId`. An empty body or `{}` remains the explicit separate daily force-run trigger and returns both effective modes alongside the request ID. Weekly changes apply to the next eligible scheduled weekly generation/recovery, never an out-of-slot recap.

Use a unique `Idempotency-Key` for each deliberate action. A scoped mode can commit before the subsequent effective-mode read or response fails; an HTTP error does not imply rollback. Reconcile both exact mode keys and the original idempotency record under ADR-27 before a new mutation. An explicit force-run can likewise have an ambiguous enqueue result; reconcile its original intent rather than manufacturing another generation. See [blocked-digest-edition.md](./runbooks/blocked-digest-edition.md#promote-or-roll-back-enforcement) for readiness and kind-local rollback.

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

### `POST /api/trigger-yield-coverage-audit`

Recomputes the coverage-audit report after reviewed yield configuration is deployed. Uses the same `runYieldCoverageAudit`, `logCronRun`, `runCronWithLease` job identity, timeout policy, and declared connection allocation as the monthly audit. The monthly schedule remains `0 6 1 * *`.

Requires Cloudflare Access authentication and `X-Pharos-Admin: 1`, like `trigger-digest`. An optional `Idempotency-Key` deduplicates retries. No request body is required.

Execution is synchronous: keep the HTTP request open. The route does not launch long-running `waitUntil()` work. The worker applies this job's normal five-minute cron timeout, and the browser ops proxy waits up to 330 seconds so a slow audit still returns its real status. For an audit that runs longer than the client timeout, inspect cron history before retrying and prefer the machine API, which bypasses the browser proxy.

| HTTP status | Meaning |
| --- | --- |
| `200` | Audit finished with cron status `ok`. Inspect `/api/status` for the actual queue-budget verdict; completion alone does not mean the queue is healthy. |
| `409` | Another manual or scheduled audit owns the `yield-coverage-audit` lease. No second audit ran. |
| `503` | Audit returned a non-healthy result, for example unavailable rankings or safety inputs. The response metadata explains why; a prior report may remain cached. |
| `500` | The audit threw or persistence failed. Check `crons["yield-coverage-audit"]` before retrying. |

The response contains `ok`, `job`, `status`, `itemCount`, and the cron's JSON-encoded `metadata`. Successful publication replaces only the audit report and review-queue output; this action does not modify hourly yield-source configuration, ranking rows, or history.

```bash
curl --fail-with-body --max-time 360 -X POST \
  https://ops-api.pharos.watch/api/trigger-yield-coverage-audit \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1"
```

See the [yield-health runbook](./runbooks/yield-health.md#recompute-after-a-coverage-drain) for acceptance checks.

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

### `GET /api/rpc-provider-trial`

Operator-only report for the Dwellir supplemental-RPC trial. It answers three questions from one read:

- credit ledger — this UTC month's metered Dwellir JSON-RPC response items against the configured cap (`budget`)
- `dwellir-evm` circuit state, so an operator can see whether the trial is currently demoted or held open (`circuit`)
- per-chain parity against an independent incumbent: retained runs, per-method availability, head lag, pinned state/log parity, first-touch and warm latency per method, latest-tag freshness, diagnostics, and pass/fail gates (`observation.chains[]`)

Diagnostic only: it never feeds scoring, public health, or the public API, and no other lane reads it. The response never contains the Dwellir API key — the report carries key presence (`budget.configured`) and credit accounting only. Registration lives in `worker/src/routes/admin-routes.ts`; the loader is `loadRpcProviderTrialReport` in `worker/src/lib/rpc-provider-parity/report.ts`.

**Query parameters:** none.

**Response shape:** `RpcProviderTrialReport` (defined in `worker/src/lib/rpc-provider-parity/types.ts`).

```json
{
  "provider": "dwellir",
  "generatedAtSec": 1780000000,
  "budget": {
    "configured": true,
    "usable": true,
    "reason": "ok",
    "window": "2026-09",
    "usedCredits": 12345,
    "capCredits": 20000000,
    "observedAtSec": 1780000000
  },
  "circuit": { "state": "closed", "consecutiveFailures": 0, "updatedAtSec": 1779999000 },
  "observation": {
    "windowStartSec": 1771000000,
    "lastRunAtSec": 1779999000,
    "runsRetained": 24,
    "chains": [
      {
        "chainId": "base",
        "dwellirHost": "api-base-mainnet-archive.n.dwellir.com",
        "comparator": { "operator": "alchemy", "host": "base-mainnet.g.alchemy.com", "source": "registry" },
        "logsComparator": { "operator": "alchemy", "host": "base-mainnet.g.alchemy.com", "source": "registry" },
        "comparatorsByStep": {
          "head": [{ "operator": "alchemy", "host": "base-mainnet.g.alchemy.com", "source": "registry" }],
          "state": [{ "operator": "alchemy", "host": "base-mainnet.g.alchemy.com", "source": "registry" }],
          "logs": [{ "operator": "alchemy", "host": "base-mainnet.g.alchemy.com", "source": "registry" }],
          "latest": []
        },
        "runs": 24,
        "skips": { "no-comparator": 0, "no-dwellir-entry": 0, "deadline": 0, "aborted": 0, "unknown": 0 },
        "lastSkip": null,
        "dwellirSuccessRate": 1,
        "headLagBlocks": { "p50": 0, "p95": 1, "samples": 24 },
        "stateParity": { "checked": 24, "matched": 24, "mismatched": 0, "lastMismatch": null },
        "logParity": { "checked": 24, "matched": 24, "mismatched": 0, "skippedReason": null },
        "prunedLogProbe": null,
        "latency": {
          "dwellir": {
            "firstTouch": {
              "head": { "p50Ms": 180, "p95Ms": 420, "samples": 24 },
              "state": { "p50Ms": null, "p95Ms": null, "samples": 0 },
              "logs": { "p50Ms": null, "p95Ms": null, "samples": 0 },
              "latest": { "p50Ms": null, "p95Ms": null, "samples": 0 }
            },
            "warm": {
              "head": { "p50Ms": 70, "p95Ms": 140, "samples": 48 },
              "state": { "p50Ms": 80, "p95Ms": 160, "samples": 24 },
              "logs": { "p50Ms": 90, "p95Ms": 180, "samples": 24 },
              "latest": { "p50Ms": 80, "p95Ms": 160, "samples": 216 }
            },
            "warmRunMedian": { "p50Ms": 80, "p95Ms": 160, "samples": 24 }
          },
          "comparator": {
            "firstTouch": {
              "head": { "p50Ms": 140, "p95Ms": 300, "samples": 24 },
              "state": { "p50Ms": null, "p95Ms": null, "samples": 0 },
              "logs": { "p50Ms": null, "p95Ms": null, "samples": 0 },
              "latest": { "p50Ms": null, "p95Ms": null, "samples": 0 }
            },
            "warm": {
              "head": { "p50Ms": null, "p95Ms": null, "samples": 0 },
              "state": { "p50Ms": 60, "p95Ms": 120, "samples": 24 },
              "logs": { "p50Ms": 70, "p95Ms": 140, "samples": 24 },
              "latest": { "p50Ms": null, "p95Ms": null, "samples": 0 }
            },
            "warmRunMedian": { "p50Ms": 60, "p95Ms": 120, "samples": 24 }
          }
        },
        "availability": {
          "dwellir": {
            "head": { "attempts": 72, "successes": 72, "capabilityRefusals": 0, "unknownRuns": 0, "successRate": 1 },
            "state": { "attempts": 24, "successes": 24, "capabilityRefusals": 0, "unknownRuns": 0, "successRate": 1 },
            "logs": { "attempts": 24, "successes": 24, "capabilityRefusals": 0, "unknownRuns": 0, "successRate": 1 },
            "latest": { "attempts": 216, "successes": 216, "capabilityRefusals": 0, "unknownRuns": 0, "successRate": 1 }
          },
          "comparator": {
            "head": { "attempts": 24, "successes": 24, "capabilityRefusals": 0, "unknownRuns": 0, "successRate": 1 },
            "state": { "attempts": 24, "successes": 24, "capabilityRefusals": 0, "unknownRuns": 0, "successRate": 1 },
            "logs": { "attempts": 24, "successes": 24, "capabilityRefusals": 0, "unknownRuns": 0, "successRate": 1 },
            "latest": { "attempts": 0, "successes": 0, "capabilityRefusals": 0, "unknownRuns": 24, "successRate": null }
          }
        },
        "latestFreshness": {
          "fresh": 24, "stale": 0, "indeterminate": 0, "unknown": 0,
          "discriminatingFresh": 24, "nonDiscriminatingFresh": 0,
          "reasons": { "served-block-in-range": 24 }, "maxNumericCalls": 10, "blockTolerance": 3, "lastStale": null,
          "sentinel": { "fresh": 24, "stale": 0, "indeterminate": 0, "unknown": 0, "discriminatingFresh": 24 },
          "tokenState": { "fresh": 24, "stale": 0, "indeterminate": 0, "unknown": 0, "discriminatingFresh": 24 }
        },
        "errorClasses": {},
        "comparatorErrorClasses": {},
        "failedSteps": {
          "dwellir": { "head": 0, "state": 0, "logs": 0, "latest": 0 },
          "comparator": { "head": 0, "state": 0, "logs": 0, "latest": 0 }
        },
        "lastComparatorFailure": null,
        "gate": { "passed": true, "failing": [] },
        "last": { "atSec": 1779999000, "dwellirHead": 21000000, "comparatorHead": 21000000, "commonBlock": 21000000 }
      }
    ]
  },
  "observationError": null
}
```

`gate.failing` separates insufficient evidence from measured failures:

- `runs`: at least 24 retained chain runs.
- `insufficient-<method>-attempts`: at least 24 non-capability attempts for each Dwellir method category (`head`, `state`, `logs`, `latest`). `success-rate:<method>` requires ≥99.5% success for that category, excluding only its own capability refusals. A skipped/unrecorded method is unknown, not a success.
- `insufficient-comparable-samples`: 24 comparable head pairs; `head-lag`: p95 lag ≤ `max(3, ceil(6 / blockTimeSec))`.
- `insufficient-state-checks` / `state-parity`: 24 performed pinned comparisons and zero mismatches.
- `insufficient-log-checks` / `log-parity`: 24 performed comparisons and zero mismatches where log history is declared available; `logs-history-none` reports a deep pruned-window trap probe instead.
- `no-log-comparator`: the newest sample explicitly lacked its reviewed logs comparator. This fails closed even when older retained runs have sufficient log checks; it is not the `logs-history-none` exemption.
- `insufficient-warm-samples`: 24 runs per operator with at least two successful warm calls. `latency` compares p95 of each run's warm median: Dwellir ≤ comparator + 500 ms. First-touch is reported, never gated; neither metric measures TLS or actual connection reuse.
- `insufficient-latest-freshness-checks`: at least 24 discriminating fresh checks or stale verdicts from the configured served-block sentinel. Where no sentinel is deployed (XDC), the token-state proof owns that floor instead. Token proof coverage is opportunistic, not an additional sufficiency requirement where a sentinel exists. `latestFreshness.sentinel` and `.tokenState` keep their separate counts, including discriminating token opportunities. `latest-state-freshness` still fails if either sub-check was stale in any retained run.

`comparator` names the newest primary head/lag/state baseline, or the planned baseline when no samples exist. `logsComparator` names its separate logs baseline (the same reference on ordinary targets); explicit `null` records an unavailable reviewed logs pin. `comparatorsByStep` lists the actual references behind each method's retained observations, including failed calls and legacy recorded comparisons, so a window spanning a comparator change is not attributed solely to the newest host. State `lastMismatch` and `lastComparatorFailure` also carry the reference actually read. A split target's comparator latency is a composite of its step-specific baselines, not a single provider measurement.

The Dwellir-only latest check keeps an explicit chain-local block-number sentinel on 36 targets: Multicall3's external getBlockNumber view at `0xca11bde05977b3631167028862be2a173976ca11` / selector `0x42cbb15c` on 34 chains, and ArbSys's external arbBlockNumber view at `0x0000000000000000000000000000000000000064` / selector `0xa3b1b31d` on Arbitrum and Robinhood. Nitro/Orbit Multicall3 returns Ethereum's L1 height, not the local L2 height; it is not a valid freshness sentinel on those targets. Each target requires a reviewed `latestStateProbe`; runtime magnitude heuristics and automatic method fallback are not used. Live Multicall3 bytecode was 3,808 bytes on 36 targets; XDC returned `0x` for both candidate sentinels, records an unavailable sentinel, and uses discriminating token-state observations for sufficiency instead.

The sentinel sequence is head H1 → `eth_call(latest)` yielding served block R → head H2, with no numeric references. The sole tolerance authority is `headLagThresholdBlocks(blockTimeSec)` in `worker/src/lib/rpc-provider-parity/report.ts`: T = `max(3, ceil(6 / blockTimeSec))`, the same six-second/minimum-three-block policy used by the head-lag gate. It is discriminating and `fresh` / `served-block-in-range` when H1−T ≤ R ≤ H2+T, or `stale` / `served-block-behind` below H1−T. This gives Arbitrum 24 blocks (0.25 seconds/block), Robinhood and HyperEVM six (one second/block), and Base three (two seconds/block). A fixed two-block allowance was insufficient for fast-chain/load-balanced skew: an Arbitrum served block 11 ahead of H2 is now inside its shared 24-block budget, not missing evidence. Ahead-of-budget results, any regressing head (which could be a reorg), or a failed step remain indeterminate; a fast advancing head does not exhaust a numeric bracket. Each sample preserves the `toleranceBlocks` actually used when acquired; summary `blockTolerance` reports the current chain's shared sentinel budget, without rewriting historical verdicts.

The 2026-10-05T19:15:06Z domain audit read H1, Multicall3, ArbSys and H2 on every one of the 37 targets. Only these two targets returned an L1-numbered Multicall3 result and a valid local ArbSys result; all other 34 deployed Multicall3 results were in their local head domain. XDC returned `0x` for both sentinels; BSC and zkSync's ArbSys calls returned RPC errors, not an available sentinel.

| Nitro target | H1 | Multicall3 (L1) | ArbSys (L2) | H2 |
| --- | ---: | ---: | ---: | ---: |
| Arbitrum | 512,015,100 | 26,128,190 | 512,015,102 | 512,015,103 |
| Robinhood | 81,024,812 | 26,128,192 | 81,024,815 | 81,024,816 |

Every target also reads its own token contract's `totalSupply(latest)` (selector `0x18160ddd`), because a fresh block-number sentinel does not establish freshness for another `(to,data)` pair. Using the first chain head H1, the post-token-call head H2, and same-probe sentinel block R when available, its numeric Dwellir-only window is `[max(0,H1−T), max(H2,R)]`, with the same shared T as the sentinel. Including R avoids falsely declaring stale a moving HyperEVM value served at H2+2. Every block in the window must be read, capped at ten (`RPC_PARITY_LATEST_MAX_NUMERIC_CALLS`); wider windows are inconclusive with no partial sampling. Any match is `fresh` / `matched-numeric-block`, but unchanged window values are `discriminating: false`: quiet-token matches are inconclusive about a token-specific stale cache, not negative freshness evidence. Discriminating token coverage is opportunistic and not a sufficiency requirement where a sentinel exists; it remains the floor on XDC. A fully covered, non-regressing, stable-hash window with no match is `stale` / `no-bracket-match` and always fails freshness. H1 and H2 headers fence the known head bracket, with H2 checked again after numeric reads; references through R do not require a separate future header. Detected reorgs, regressing heads, failed reads, or an unavailable numeric block above H2 remain indeterminate, never stale. Arbitrum, Monad, MegaETH and Cronos already exceed the token cap with stationary heads; their sentinel evidence can still satisfy freshness sufficiency.

Samples retain `sentinelFreshness` and `tokenFreshness`, including both sub-verdicts, the exact contract/selector read, acquired tolerance, heads, latest/numeric values, and token `referenceEndBlock`. The combined `latestFreshness` is stale if either check is stale; otherwise a deployed sentinel must be fresh and the token check matched or wide/inconclusive. On XDC without a deployed sentinel, the combined verdict uses the actual token verdict. A failed token read or regressing/reorg bracket never becomes a positive combined claim. A discriminating fresh sentinel remains discriminating in the combined report when a quiet token matches; token-specific discrimination remains visible separately in `.tokenState`. `lastStale` names the selected failing check's actual method, run clock, budget, heads and value/reference payload.

`latency.<operator>.firstTouch` and `.warm` contain p50/p95 and sample count for every category. The first request to an origin within the run is first-touch; later requests to that origin are warm even across targets. Per-call percentiles include failed calls; `warmRunMedian` uses successful calls only, while availability gates failures separately. `latest` includes both latest-tag reads and token numeric/header checks; the initial, post-sentinel, and post-token head reads belong to `head`. The comparator has no latest-check attempts by design.

The compressed v5 store retains the existing cache key and reads v1/v2/v3/v4 samples during seven-day retention. Legacy observations are never given fabricated token checks, contracts, selectors, or discrimination. V1 samples have unknown per-method attempts, warm latency and latest freshness; v2 fresh verdicts have unknown discrimination. V3's single comparator remains the reference for every legacy method, and v4's split-origin provenance remains intact. V5 stores both freshness sub-tuples with their exact `(to,data)` provenance and full latest/numeric values in every new sample, then derives the combined verdict when decoding. Rewritten legacy rows retain their previous newest-stale-example value policy. Split-origin calls use dictionary-encoded layouts; integer milliseconds are losslessly bit-packed and block heights delta encoded. The same per-operator bounds (20 Dwellir / four comparator calls) govern encoding and decoding. Unrecorded skip reasons remain unknown. Oldest-run pruning honors both the 240 KiB compressed row budget and the reader's 4 MiB decompressed wire ceiling, retaining at most 168 runs. Highly compressible token proofs cannot produce a gzip row that its own reader rejects; a newest run alone exceeding the raw ceiling fails persistence with `rpc-parity-raw-row-budget` instead of discarding its proof. Older readers reject v5 rows and their next write resets history; preserve the cache row before rollback.
Report reads expire runs and latest evidence older than `RPC_PARITY_RETENTION_SEC` at `generatedAtSec`, even without new writes; the exact seven-day cutoff is retained. Expired windows fail sufficiency gates.

`errorClasses` and `comparatorErrorClasses` count samples with provider failures (`range-cap`, `result-cap`, `rate-limited`, `capability`, `server-error`, `timeout`, `network`, `rpc-error`, `invalid-response`). `failedSteps` counts failed method categories per operator; `lastComparatorFailure` names its run clock, category, class, HTTP status and actual comparator reference. Invalid method result shapes are failures, not successes. HTTP 5xx stays `server-error` even if its body mentions an unsupported operation; HTTP range/result-cap bodies retain their specific class. Unavailable reads never count as state/log mismatches: both operators must answer for a comparison. Dwellir state/log reads are still attempted when the comparator's corresponding method fails; an unresolved logs pin skips that method without issuing either operator's log read. Astar's reviewed keyless pin is `https://evm.astar.network`, verified for historical USDC supply and recent/older logs on 2026-10-05.

Worldchain's reviewed keyless comparator is `https://worldchain.drpc.org` ([provider listing](https://drpc.org/chainlist/worldchain-mainnet-rpc)). Its distinct origin prevents the configured census Alchemy bearer from reaching public comparator reads. On 2026-10-05 it returned chain ID 480; USDC total supply and all 22 transaction-hash/log-index identities over the ten-block window ending at block 35,949,925 matched the official Alchemy public endpoint, with both endpoints read without authentication.

HyperEVM explicitly separates comparator roles: keyless dRPC `https://hyperliquid.drpc.org` supplies head/lag and numeric state, while the configured reth Alchemy pin `https://hyperliquid-mainnet.g.alchemy.com/v2/` supplies logs with its origin-registered bearer header. Missing Alchemy configuration/auth still permits head/numeric-state checks; logs remain unchecked with `logParity.skippedReason = "no-comparator"`, without substituting native log indices. One Alchemy head read immediately before its log read genuinely warms that separate origin; its reference and first-touch phase are recorded, without changing the primary head/lag/state baseline or the two-warm-call floor. The 2026-10-05T19:50Z numeric-state reproduction in `agents/dwellir-switch/raw/orch-hyperevm-alchemy-state.txt` found Dwellir = dRPC ≠ Alchemy in five head−64 samples with identical Dwellir/Alchemy block hashes, but all three agreed in five head−500 samples. Alchemy's value at block 47,756,020 equaled Dwellir's at later block 47,756,029: recent numeric `eth_call` tags returned newer-than-requested state on Alchemy. The 19:17Z historical supply match does not establish correctness near head.

The 2026-10-05T19:17Z log reproduction showed Dwellir/Alchemy matching 16/22/24 log identities in three pinned windows ending at blocks 47,753,799/798/797. At block 47,753,790 all four providers returned hash `0xbfcfc3f34fd4226ca24620b5e719d0cac262b6638ea82206444aae5368006ed1`, but Dwellir/Alchemy included eight transactions versus dRPC/official native's seven. The native representation omitted synthetic transaction `0x7989bc119042f05c3ee4169493d883a0409035a8c31c560a37accafc1515d08a`, whose reth receipt contains one other-token transfer at index zero; four regular USDC log indices consequently differed by one (`0x11` versus `0x10`, for example) despite identical event payloads. This is a pinned, same-hash representation difference, not evidence of a lagging node or a near-head race. The earlier 28-identity dRPC match did not cover this difference. Log identities remain exact; no normalization or exclusion turns shifted/missing logs into a pass.

The hourly lane is strictly serial (`maxConnections: 1`) with a four-minute run deadline and an eight-second request timeout clipped to remaining time. A fully covered token check adds five fixed calls (latest, post-token head, three hash reads) plus its numeric references; a too-wide check adds only the pre-read header, latest, and head. With stationary heads and R=H2, the 37 targets comprise 19 four-block token windows, 13 seven-block windows, BSC's nine-block window, and four too-wide windows: 648 total calls / 536 Dwellir credits per complete run. Allowing each feasible window to reach the ten-call cap gives 802 calls / 690 credits maximum. Those plans cost 12,864–16,560 credits/day before failures/skips. Linear extrapolation of the prior 174-call / 102-second measured maximum gives approximately 380–470 seconds, exceeding the four-minute deadline; this is planning evidence, not a live duration claim. The deadline remains bounded and the starting target rotates by `floor(atSec / 3600) % targetCount`, so partial runs share coverage instead of permanently starving one tail. Stored/report `skips` names `no-comparator`, `no-dwellir-entry`, `deadline`, and `aborted`, with latest clock/reason and unknown legacy gaps. An unavailable HyperEVM logs pin stays a retained partial sample, not a whole-chain skip.

The 2026-10-05T19:30Z live smoke of this probe completed in 31 seconds with 37/37 Dwellir heads, 187 credits, no deadline hit and no skipped chains. Both ArbSys freshness checks were fresh with zero block lag; HyperEVM's Alchemy state and exact log identities matched. Celo's comparator returned HTTP 400, so its state/log comparisons remained unchecked rather than positive parity evidence. This single-run measurement does not replace the conservative deadline planning estimate or the 24-run gates.

The 2026-10-05T19:45Z smoke after adopting the shared chain-time tolerance also completed in 31 seconds, used 187 credits, read 37/37 Dwellir heads, and had no skipped chains or deadline hit. Arbitrum and Robinhood were fresh with their recorded 24- and six-block budgets. HyperEVM's exact logs matched Alchemy, but its pinned state comparison mismatched; that remains negative parity evidence, not a freshness failure or grounds to relax exact comparison. Celo's HTTP 400 left state/log unchecked, and Manta's comparator HTTP 429 left logs unchecked. These single-run observations do not establish a 24-run gate pass.

The 2026-10-05T20:25Z smoke with the per-step comparator split completed in 40 seconds, used 189 Dwellir credits, read 37/37 Dwellir heads, and had no skipped chains or deadline hit. HyperEVM's dRPC numeric state and Alchemy exact logs both matched Dwellir; its latest sentinel and both Nitro ArbSys checks were fresh. HTTP 500 responses were observed, and Celo's comparator was correctly classified as `server-error`, leaving its state/log comparisons unchecked. This remains a single-run observation, not a 24-run gate verdict.

The 2026-10-05T22:30Z initial dual-check smoke completed in 54 seconds with 517 Dwellir credits, 37/37 heads and samples, no skipped chains and no deadline hit. HyperEVM's dRPC historical state and Alchemy exact logs matched, while its token freshness remained indeterminate (`invalid-response`); Etherlink's token check returned `rpc-error`, and zkSync's returned `invalid-response`. Worldchain's comparator `server-error` and Manta's `rate-limited` response left logs unchecked. This smoke preceded the H2-only hash-fence adjustment and raw-wire retention guard. It establishes no 24-run gate verdict.

The 2026-10-05T23:26Z two-target diagnostic rerun reproduced Dwellir `latest`-category `rpc-error` failures on the first numeric `totalSupply` call at each sentinel's R=H2+1: Etherlink returned `-32603` / “No state available for block 54982591”; Blast returned `-32000` / “header not found” for block 41216502. Both known-head hash reads succeeded and both sentinels were fresh. These unavailable ahead-of-head numeric states are indeterminate, not stale or a probe defect. The keyless call traces are retained in `agents/dwellir-switch/raw/impl-stepfail-2026-10-05T23-26-58-507Z.json`; the original full-run summary alone did not retain exact failed methods/classes.

`budget.reason` is `ok` when the ledger is readable and under cap, and otherwise `not-configured`, `provider-budget-exhausted`, or `ledger-unreadable`; `budget.usedCredits` is `null` when the ledger row could not be read. `circuit` is `null` until the `dwellir-evm` circuit has been written at least once. `observation` is `null` with `observationError` set when the stored parity samples could not be read — that is still a `200`, because a degraded sample store is exactly the state an operator needs to see, and the budget and circuit sections remain live diagnostics.

**Error responses:** `401` without a valid admin credential, as for every ops route. Diagnostic failures inside the report are reported in the body rather than as an HTTP error status.

### `POST /api/remediate-blacklist-amount-gaps`

Admin-only bounded remediation endpoint for recoverable **EVM** blacklist rows. Default candidate selection excludes Tron before applying the row limit; explicit `chainId=tron` returns `400` without reading or updating events. Tron event-time amounts require the scheduled confirmed transfer-replay lane or the guarded evidence-based operator CLI in [Blacklist Tracker](./blacklist-tracker.md), not this historical-balance route.

**Authentication:** same admin auth as other ops endpoints.

**Idempotency:** supported via optional `Idempotency-Key`.

**Inputs**

- `chainId?: string`
- `stablecoin?: BlacklistStablecoin` from the shared `BLACKLIST_STABLECOINS` set
- `limit?: number` default `25`; max `200` in dry-run mode, max `100` in write mode (`dryRun: false`) so updates commit in one atomic D1 batch — a larger write-mode limit returns `400`
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
