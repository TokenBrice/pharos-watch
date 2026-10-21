# Pharos API Admin Reference

> **Agent navigation** — Read [auth/idempotency](#admin-auth-and-idempotency) and [endpoint entry](#admin-endpoint-entry), then grep the exact route heading. Families: status/history · API keys · DEWS repair · digest/yield triggers · blacklist/RPC diagnostics · action log · Telegram broadcast.

This operator-only companion to [api-reference.md](./api-reference.md) is not published through `/docs/` or listed in `PUBLIC_DOCS`.

## Admin Auth And Idempotency

Admin endpoints are authenticated only on the `ops-api.pharos.watch` host. Cloudflare Access must authenticate the caller first, then inject `Cf-Access-Jwt-Assertion` for the worker. `worker/src/lib/auth.ts` verifies that JWT against the configured Access audience (`CF_ACCESS_OPS_API_AUD`) and team domain (`CF_ACCESS_TEAM_DOMAIN`) via `shared/lib/cloudflare-access-jwt.ts`, including signature, `aud`, `exp`, and `iss` checks. Browser operators should use `https://ops.pharos.watch/admin/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access; the Pages proxy verifies the inbound UI Access token against `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD`, requires an interactive Access token (`type: "app"`), and accepts the token from `Cf-Access-Jwt-Assertion` when Cloudflare forwards it or from the same-origin `cf-access-token` / `CF_Authorization` carrier when the browser is operating off an existing Access session. Mutating requests still require same-origin `Origin`.

Mutating admin calls also require `X-Pharos-Admin: 1` after Cloudflare Access authentication. Browser proxy calls forward that header from the operator UI and additionally require same-origin `Origin`; direct `ops-api` automation must send the header along with the Access service-token credentials.

The website-internal read lane is separate from Cloudflare Access. `site-api.pharos.watch` accepts allowlisted `GET` public-read paths and requires `X-Pharos-Site-Proxy-Secret`, which Pages proxies inject server-to-server from `SITE_API_SHARED_SECRET`. All Pages hosts — production and preview — must configure `SITE_API_ORIGIN=https://site-api.pharos.watch`; the Pages proxies fail closed with `500` when that binding is missing or is not the canonical HTTPS origin. The `/_site-data/*` lane additionally accepts requests only when the browser `Origin` header (or `Referer` as a fallback) matches the configured `SITE_ORIGIN` / `OPS_UI_ORIGIN` hostnames or the Pages project/preview hostname family in `shared/lib/runtime-origins.ts`. Public browser traffic must not call `site-api.pharos.watch` directly.

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

A nonempty `Idempotency-Key` of at most 128 characters (after trimming) enables request fingerprinting and owner/generation-fenced reservation on those routes; an empty or overlong key is ignored. Terminal responses echo `Idempotency-Key` plus `X-Idempotent-Replay`. Replays do not rerun the action; a different request fingerprint returns `409`. Only an abandoned reservation whose execution never started can be reclaimed after its takeover window.

Once execution has been marked as started, an unconfirmed outcome is never retried automatically. An in-flight duplicate, a handler throw or `5xx` response, or a terminal response that cannot be confirmed as persisted returns `503` with `error: "execution_unknown"`; subsequent requests with the same key also return `503` with `X-Idempotent-Replay: true` and do not invoke the handler again. `execution_unknown` rows are exempt from the seven-day terminal TTL, so the original key can never age out and reserve a fresh row. Operators must reconcile whether the external effect occurred before deciding whether to submit a new idempotency key.

A stale started reservation stays terminally `execution_unknown`: it is never handed back for automatic re-execution. Operators must reconcile those keys; any future automated reconciliation requires an action-specific design, not a generic reopening callback.

API-key update and rotate use prefix-fenced writes. `POST /api/api-keys/:id/update` sets only the fields present in the validated body and is fenced on the key prefix observed by the request, so a concurrent deactivation is never undone by an unrelated `{name}` update; `POST /api/api-keys/:id/rotate` is fenced on the same prefix in the batch that moves the donor claim. When the fence does not match, both return `409` (`API key changed concurrently; re-read it before updating`/`… before rotating`) instead of a silently lost write, and the caller must re-read the key before retrying.

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

Historical rebuilds and staged captures run through `worker/scripts/one-shot-backfill.ts`, not HTTP or the dashboard; their former routes are unregistered. Recurring `backfill-dews`, blacklist remediation/reset, digest and yield-audit triggers remain here with their existing authentication/idempotency contracts. CLI writes use Wrangler authentication and are not covered by HTTP idempotency reservations. Ordinary jobs use D1 commands; jobs requiring destructive multi-statement atomicity additionally require `--allow-atomic-import`, which acknowledges temporary live D1 unavailability. See [One-shot historical backfills](./runbooks/one-shot-backfills.md#operator-contract), [transport safety](./runbooks/one-shot-backfills.md#transport-safety) and [interruption reconciliation](./runbooks/one-shot-backfills.md#interruption-and-cleanup) for the job registry and contracts.

### `GET /api/status`

Full admin dashboard: cron run history, cache freshness for all keys, data quality metrics, Telegram bot subscriber stats, and operator reconciliation signals.

Dedicated asset-scoped circuit outages do not count as source-wide degradation; the shared `protocol-redeem` circuit does. `shared/types/pricing-source-health.ts` owns distribution buckets; a supported bucket does not imply any current asset uses it.

**Response shape:** `StatusResponseSchema` / `StatusResponse` in `shared/types/status/response.ts` (exported through `shared/types/index.ts`). This illustrative excerpt omits required fields and is not a schema-valid fixture. The schema owns the complete envelope; the [status backend contract](./status-dashboard.md#backend-contract-get-apistatus) owns health evaluation.

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
  "crons": {
    "sync-stablecoins": {
      "runs": [{ "startedAt": 1771856400, "durationMs": 41200, "status": "ok" }, ...],
      "confirmedOutputAt": 1771856441,
      "inFlight": null,
      "healthy": true,
      ...
    }
  },
  "sectionErrors": {},
  "telegramBot": { "deliverySli": { ... }, ... },
  "priceSourceHealth": { "sourceDepthDistribution": { "0": 3, "1": 15, ... }, ... },
  ...
}
```

The status backend owns [cron health](./status-dashboard.md#cron-health-model), [availability](./status-dashboard.md#availability-status), [data quality](./status-dashboard.md#data-quality-status) and [live-reserve sync health](./status-dashboard.md#live-reserve-sync-health), including monitoring windows, cohort floors, threshold precedence, critical/watch distinctions, degraded-run inheritance and shared public-health floors. `itemCount` is the recorded attempt's count, not a current catalog census; `dataQuality.totalStablecoins` uses known exact active-price expected coverage, falling back to cached active canonical assets.

Reserve deferred-tail fields (`runBudgetTruncated`, `deferredCoins`, `deferredAt`, `nextCursorStablecoinId`) expose the last budget stop; `persistentlyStaleIndependentCoins` identifies independent-source failures and `writeTimeoutUncertain` identifies attempts whose authority readback was inconclusive. Raw diagnostics remain visible even when feed reviews remove coins from the health cohort.


`producerHeads` contains every canonical schedule/job/path/kind identity, including shared producer paths and budget-only surfaces. `observed=false` explicitly represents an identity that has not run since the history schema deployed. Observed rows separate `lastInvokedAt`/`lastCompletedAt` from `lastProductiveAt` and `lastPublicationAt`, and include invocation ID, Worker version, outcome/error, and invocation/productive counters.
`invocationCount` and `productiveCount` count retained producer-history rows, maintained transactionally by source-table triggers in `worker_producer_retained_counts`; they are not lifetime counters or completion-time snapshots. Status reads join one counter per head instead of aggregating invocation history. Retention deletes therefore change counts immediately even without another invocation, while latest productive/publication evidence remains retained in the head.

`crons[*].inFlight` is present when a leased cron is actively reporting `cron_run_progress` and the matching `cron_leases` row is still active for the same owner. It includes `startedAt`, `updatedAt`, `stage`, optional `itemsDone/itemsTotal`, optional `message/metadata`, and a `stale` flag when the heartbeat stops updating. High-SLO jobs such as DEX liquidity, yield publication/supplemental sync, digest generation, and Telegram dispatch include stage metadata with `providerFamily`, `phase`, `countTotals`, and, where relevant, `cursor` / `deferredTail` summaries; `/api/status` reads those summaries from `cron_run_progress` and does not add producer-table scans for them.

For hysteresis and DB-sentinel behavior, see [overall status](./status-dashboard.md#overall-status); for unavailable Telegram tables and subscriber metrics, see [Telegram bot metrics](./status-dashboard.md#telegram-bot-metrics).

`telegramBot.deliverySli` is the bounded operational delivery read model over `telegram_jobs` and `telegram_deliveries`. Its envelope is always fail-visible:

- `availability` is `available` only when the complete SLI query succeeds; otherwise it is `unavailable`.
- `quality` is `complete`, `partial`, or `empty` for an available rollup, and `unavailable` on query failure.
- `freshness` is `fresh`, `stale`, or `empty` for an available rollup, and `unknown` on query failure.
- `acceptanceDefinition` is the literal `telegram_bot_api_accepted_not_user_receipt`. Fields such as `planToTelegramAcceptance`, `telegramAccepted`, and `telegramAcceptanceRate` mean Telegram's Bot API accepted a send request. They are not evidence that an end user received, opened, or read the message.
- `rollup` contains the bounded window, evidence age, detection-to-plan and plan-to-acceptance latency, acceptance-before-TTL coverage, authoritative outcomes, preference-change cancellations, unresolved backlog buckets, observed errors, execution-unknown outcomes, and terminal failed/blocked/expired rows. It is `null` on query failure; failure never becomes an all-zero or healthy rollup.

`sectionErrors` is a machine-readable map of subsection loader failures. When an individual status subsection fails (for example Telegram stats, CoinGecko price drift, D1 usage telemetry, liquidity health, reserve drift, or mint/burn reconciliation), `/api/status` still returns `200`, keeps the unaffected sections intact, and records the degraded subsection under `sectionErrors` with a stable `code` plus an operator-facing sanitized `message`. Raw exception text, SQL fragments, and table names stay in logs, not in the response body.

**Cron summary contract.** Each `crons[job]` entry is a per-job summary: verdict (`healthy`, `telemetryUnknown`/`telemetryUnknownReason`, `bootstrap`), `confirmedOutputAt` (newest confirmed output clock in the bounded history read; `null` is not proof of no output), `inFlight` without progress metadata, `staleArtifacts`, `latestEvent`, and `runs` — newest first, `runs[0]` is the latest attempt (there is no `lastRun`/`recentRuns`). `runs` holds the ten-row display window plus appended inheritance evidence (latest required attempts, fresh proven-satisfied readback). Each run is a lightweight outcome: `startedAt`, `durationMs`, `status`, `error` bounded to 500 chars, `degradedReason`, `itemCount`, `rawStatus`, `reason`, `skippedReason`, `childDisposition`, `workerVersion`, `qualityReasons`, and abandonment timing (`activeDurationMs`, `progressUpdatedAt`, `reconciledAt`, `reconciliationDelayMs`). Runs carry **no metadata**. `latestRunFacts` carries only the registry-selected keys of the latest attempt's metadata (`CRON_STATUS_LATEST_FACT_KEYS`, `worker/src/lib/status/cron-status-summary.ts`): dispatch delivery counters for `dispatch-telegram-alerts`, `synced`/`total`/`nextCursorStablecoinId` for `sync-live-reserves`, `slowestProbes` for `status-self-check`. Full metadata is served per job by [`GET /api/status-cron-detail`](#get-apistatus-cron-detail). Projected on the 2026-10-18 baseline (3,421,068 B), the default response drops to ~555 KB.

In the detail response for `dispatch-telegram-alerts`, `cron.runs[0].metadata.deliveryV2` carries the run's job and delivery counters: job creation (`alertJobId`, `alertJobCreated`, `freezeJobsCreated`, `freezeState`, `freezeBelowRealtimeThreshold`, `freezeSkippedNoAudience`, `freezeRetractedCancelled`), fan-out (`fanoutPages`, `deliveriesPlanned`, `suppressedDuplicate`, `jobsFailedClosed`, `jobsCancelled`, `cappedRows`), roll-up (`rollupState`, `rollupSentChats`, `freezeBatchState`), drain (`claimed`, `sent`, `retried`, `failed`, `blocked`, `unknown`, `cancelled`, `drainStoppedReason`, `heldKinds`), sweep (`sweepSendingToUnknown`, `sweepExpired`, `jobsDone`) and `planningErrors`. Top-level metadata keeps the expanded `eventsDetected` counters (`depegTriggered`, `depegResolved`, `depegWorsening`, `suppressedMethodologyChanges`), `presetFailure`, `snapshotSeeded` and `noWorkRun`. Retained raw metadata from retired pipelines may still contain historical fields; absence is not a synthetic zero. Use `telegramBot.deliverySli` for bounded row-authoritative delivery outcomes.

The same cron metadata also exposes the live safety-alert source contract:

- `safetyAlertSourceState`
- `safetyAlertSourceAgeSeconds`
- `safetyAlertsSuppressed`
- `safetyAlertSourceGeneration`

When `safetyAlertsSuppressed=true`, DEWS/depeg/reserve/freeze alerts can still continue, but safety-grade alerts remain paused until `compute-safety-score-v9` accepts a fresh canonical publication and the Telegram lane reseeds its prior snapshot.

For self-check freshness fallbacks, optional split-plane probe evidence and D1 monitoring, see [synthetic self-check](./status-dashboard.md#synthetic-self-check). Dataset coverage is defined by `DatasetFreshnessSchema` in `shared/types/status/core.ts` and `DATASET_FRESHNESS_TARGETS` in `worker/src/lib/status/derived-data.ts`; discovery-backlog timestamps are not dataset freshness.

`dataQuality.repairDebt` summarizes low-priority repair/backfill backlog separately from foreground publication health. It reports `status`, `openCount`, `oldestAgeSec`, `byKind`, `availabilityEscalated`, `nextRunnerDueAt`, and `source` from active `worker_repair_tasks` rows. The legacy DDR-specific `ddrRepairDebt*` fields remain populated for compatibility from active DDR task `subject_id`/`payload_json` details and continue to drive the `ddr_repair_debt_present` data-quality warning.

`priceSourceHealth` is derived from the final `sync-stablecoins` asset payload and summarizes resolved price-source distribution, active canonical source-depth buckets (`sourceDepthDistribution`, keyed by `consensusSources.length` buckets `0`, `1`, `2`, `3`, `4`, `5+`), confidence buckets, total assets, and the timestamp of the latest successful price-health snapshot. CoinGecko-vs-Pharos divergence details live in the separate `coingeckoPriceDiff` block.

The [CoinGecko price-drift card](./status-dashboard.md#coingecko-price-drift-card) owns quote admission, failure/null interpretation and comparison limitations. The [D1 usage card](./status-dashboard.md#d1-usage-card) owns telemetry clocks, reuse/fallback, capacity thresholds and advisory forecasts. Neither browser polling nor a diagnostic query refreshes an upstream producer observation.

API-only D1 `tableGrowth` carries daily reviewed-name/family row counts/deltas, nullable timestamp attribution, top growers and `failedTables` for unreadable/invalid counts. Its serving age is at most 50 hours; rows are not byte sizes and same-day cache reuse is not an independent observation. The D1 card does not render the per-table census.

`liquidityHealth` uses the newest `sync-dex-liquidity` run carrying `metadata.sourceCoverage` within twice the expected interval; newer cadence-reuse runs without coverage are skipped. Missing or older evidence yields `null`. `sourceRunStartedAt` preserves the selected measurement clock. The projection summarizes row/value/major-asset coverage, failed sources, and current/previous coverage classes.

`yieldHealth` is derived only from existing yield cache rows and cron metadata: `yield-rankings`, per-family `yield:supplemental-sources:v1:*`, `yield-coverage-audit`, and `crons["sync-yield-data"]`. `rankingStatus` uses the `yield-data` ratio override (`>2x` degraded, `>4x` stale); missing or stale rankings are public-critical because `/api/yield-rankings` and `/yield/` depend on them. `rankingCountDelta` and `previousRankingCount` come from `sync-yield-data` source-coverage metadata, with a fallback to the top-level severe-coverage-guard metadata when publication is blocked before normal source coverage is assembled. Safety coverage is admin-watch below `0.75`; supplemental age uses producer-owned per-family budgets from `getSupplementalFamilyStaleThresholdSec`, not a uniform 6h cutoff; coverage-audit age is admin-watch above 45d. `yieldHealth.benchmarkRegistry` evaluates every benchmark key used by published rows, including row counts and fallback-selection counts; any used fallback is degraded, while a missing or older-than-48h used benchmark is stale. The legacy `yieldHealth.benchmark` field remains the USD-only compatibility view. `yieldHealth.supplemental` reports `familyCount`, `freshFamilyCount`, `degradedFamilyCount`, `staleFamilyCount`, `missingFamilyCount`, and a `families` map keyed by source family with per-family age/source-count/status; a fresh all-empty family snapshot is valid state, while no valid family rows means the supplemental section is unavailable/stale based on family evidence. `sourceRiskCoverage` reports backend-only coverage/null rates for nested `sourceRisk.*` fields across best and alternate ranking rows; `"unknown"` venue tiers count as null-equivalent coverage gaps. Loader failures return `yieldHealth: null` and `sectionErrors.yieldHealth`.

These are permanent operator diagnostics with no pending promotion. Hydration reads the canonical compact Safety Score index/health, respects held/error branches and both original yield/safety 24-hour clocks; index integrity failures never permit publish-time fallback. `liveSafetyHydration` reports both clocks and the fallback budget. `pysInputs` is publisher metadata, not table reconciliation: both finite nonnegative integer counters and a nonzero denominator are required, otherwise status/rate remain unknown/null with a reason and source run. Comparison-anchor examples retain `maxAgeSeconds` and source run; oldest means oldest overall anchor, not oldest stale anchor.

The monthly yield queue remains permanently DISPLAY-ONLY. `queueTotals.totalItemCount` is the full visible post-disposition cohort, `publishedItemCount` is the producer's capped sample and `truncatedItemCount` is the difference (for example 146 = 40 + 106). `byKindScope="full-visible"` labels pre-cap counts; older reports are explicitly `published-sample`, never full totals. Status renders at most six per side. No disposition UI/API or human-write workflow is introduced.

`publicationHealth` is a permanent read-only diagnostic for six surfaces: DEX liquidity, yield rankings, stablecoins, DEWS, PSI and canonical Safety Score V9. Existing ledgers/accepted V9 artifacts own publication, not this projection. Loaders settle independently; failed surfaces are omitted and named in `failedSurfaces`, with `sectionErrors.publicationHealth` set. Dependency and Pipeline projections share `classifyPublicationDiagnostic`: only a newer failed/rejected attempt degrades a retained publication, and a pending candidate degrades above the shared two-hour budget (not at the exact boundary). Missing/read-failed evidence is not a healthy publication.

`dependencyHealth` is a read-only derived matrix over existing status signals. The worker combines `caches`, `crons`, `publicationHealth`, and the static registry in `shared/lib/data-dependency-registry.ts` into per-dependency status rows plus `rootCauseGroups` that group degraded/stale symptoms under the highest upstream dependency. This is operator triage metadata only: it does not perform extra D1 reads, does not change `availabilityStatus` / `dataQualityStatus`, and does not mutate publication ledgers.

`providerCircuitHealth` is a permanent read-only diagnostic. `listActiveCircuitSources` defines its inventory; bounded direct `circuit:<source>` reads own counts, independently of the retired `provider:circuit:index` row, which has no runtime reader or writer. Absent rows are valid initial closed state; malformed stored rows contribute `invalidCount`/family `invalid`, not closed counts, with bounded `invalidProviders` reasons. Full totals are independent of the 25-provider detail cap. Loader failure returns null plus a section error; public raw circuits and runtime breaker decisions are unchanged.

`canaries` is a permanent read-only admin supplement over `worker_canary_runs`, selecting the latest row **per active check ID in the selected mode**, not one atomic generation. The nine checks are DEX current publication, DEX actual global row, blacklist null identity, stablecoins active coverage (banded by `classifyStablecoinPublicationGap`: under 1% missing is `ok`, up to 10% `degraded`, beyond that `error`), PSI latest sample, DEWS published generation, canonical accepted/held Safety Score V9 publication, GBP SONIA benchmark current, and USD T-bill benchmark current. Both benchmark diagnostics use shared 48-hour fetch/five-day record budgets and a known two-publication fresh streak; they do not change producer admission. Retired check IDs and other historical modes are excluded. `executionStatus: completed|failed` and `executionFailureReason` are independent of finding `status`/`severity`; absent legacy execution metadata remains unknown. The summary exposes `completedCount`, `failedCount` and `unknownExecutionCount`; invalid/future observation clocks are nonhealthy. In `status`, measured severe findings stay hard ledger findings but return cron `ok` plus named quality; failed required work remains degraded. Pending deployed-override inventory, `alert` retains stronger terminal errors and `shadow` hidden collection; `off`/`shadow` return empty/unknown status evidence. The approved final policy is `off|status`, with obsolete selections becoming `off` only after that inventory is migrated. Loader failures return `canaries: null` and `sectionErrors.canaries`. No canary finding directly changes availability/scoring or sends a condition-specific push notification.

`mintBurnReconciliation` is the permanent native conservation diagnostic, enumerated from configured contracts and canonical metadata independently of circulating-supply cache availability. `conservationVersion: 1`, per-contract identities/fingerprints, matched blocks/hashes, raw arithmetic, scan/cursor coverage and unresolved mismatches retain their existing authority. Rows expose `conservationIssue`, `coverageStatus` and `conservation`; only `criticalCount` is retained in the summary. The unmatched USD stock/flow comparison, its four metrics/context and unused native `comparedCoins`/`insufficientCount` have been retired with a clean private-client/UI cutover; no response aliases are provided. The duplicate runtime classification-warning list and its error key are also retired; the broader catalog CI custody invariant remains authoritative.

### `GET /api/status-cron-detail`

Access-protected per-job cron detail, fetched when an operator opens a job. Query: `job` (required canonical job id; `400` when missing, `404` when unknown). Reads are scoped to that job (history, lease, progress) plus slot-event markers. Response (`no-store`, `StatusCronDetailResponseSchema` in `shared/types/status/cron.ts`): `{ timestamp, job, cron, sectionErrors }`. `cron` has the same verdict fields and run window as the `/api/status` summary, but each `runs[]` entry also carries the full persisted `metadata` and untruncated `error`, and `inFlight.metadata` is included. `sectionErrors` names failed companion reads (`cron_progress_query_failed`, `cron_lease_query_failed`, `scheduled_slot_event_query_failed`); an empty field after a failed read is not evidence of idleness or absence. A failed history read keeps `healthy: null` with `telemetryUnknownReason`.

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

Admin-only per-coin attempt timeline for the live-reserve sync lane, querying `reserve_sync_attempt_history`.

**Query parameters**

| Param  | Type      | Default | Description                                                        |
| ------ | --------- | ------- | ------------------------------------------------------------------ |
| `coin` | `string`  | —       | Required stablecoin id (e.g. `usdc-circle`)                        |
| `limit`| `integer` | `50`    | Number of attempts to return (1–200), newest first                  |

**Response shape:** `{ "coin": string, "attempts": Array<{ stablecoinId, attemptedAt, adapterKey, breakerKey, attemptId, status, failureCategory, warningCodes, lastError, durationMs }> }`. `failureCategory` is the cron-classified failure (`network`, `upstream-http`, `parser-drift`, `validation`, `storage-write`, `circuit-open`, …); `warningCodes` are the attempt-scoped warning codes; `durationMs` reads the producer's current `metadata.durationMs`, with backward-compatible fallback to `metadata.diag.durationMs`. Only finite nonnegative numbers are accepted; absent or invalid timing stays `null`. A missing `coin` returns `400`.

### `GET /api/request-source-stats`

Admin-only, Access-protected, `no-store` operational demand measurement. Worker source events and ordinary Pages upstream responses are sampled independently per eligible request at 1/64; only Pages transport timeout/error observations use certainty capture. Legacy recorded counters remain historical inputs during their 35-day drain. This is not a public scoring methodology change.

The top-line `site` bucket combines:

- same-origin `/_site-data/*` upstream attempts recorded by the Pages Function; the retired outer Cache API path may still appear in historical windows
- `api.pharos.watch` requests attributed to browser evidence (`Origin` / `Referer` / frontend `Accept` marker + same-site fetch metadata)
- `api.pharos.watch` requests authenticated with API keys carrying the legacy `trafficClass="site"` label (no longer writable; see `POST /api/api-keys/:id/update`)

The top-line `external` bucket is `api.pharos.watch` traffic not classified as site. Admin routes and `/api/telegram-webhook` remain excluded. Worker-lane `site-api` work overlaps Pages demand and is never added again to top-line totals.

**Query parameters**

| Param         | Type      | Default | Description                                                             |
| ------------- | --------- | ------- | ----------------------------------------------------------------------- |
| `measurementVersion` | `integer` | required | Must be exactly `2`; absent/unsupported values return `400` with reason `attribution-measurement-version-required`. Old admin tabs must reload. |
| `hours`       | `integer` | `24`    | Window size in hours (`1`–`840`, currently 35 days)                     |
| `bucketSec`   | `integer` | `3600`  | Time-bucket rollup size in seconds (`60`–`86400`)                       |
| `routeLimit`  | `integer` | `20`    | Max per-route rows returned in the route breakdown (`1`-`100`)          |
| `apiKeyLimit` | `integer` | `25`    | Max per-key rows returned in the keyed public-API breakdown (`1`-`100`) |

Malformed numeric params return `400`; out-of-range numeric params are clamped to the documented bounds.

**Response shape:** `ApiRequestAttributionResponse` in `shared/contracts/request-source.ts` (`@pharos/contracts/request-source`). Required `measurementVersion: 2` and `policyId: "request-source-bernoulli-64-v1"` identify operational telemetry, not scoring methodology. Each aggregate/row has a required `measurement` object keyed by its count/share fields:

- `kind`: `observed`, `estimated`, `mixed`, or `unavailable`; sampled contributions can never be labeled observed.
- `recordedCount`: unsampled legacy/per-key observations; `observedSampleCount` and `probabilityStrata[{inverseRate,observedSampleCount}]`: selected observations, not expanded counts. Weighted count = recorded count + `SUM(sample_count * inverse_rate)`; variance estimate = `SUM(sample_count * inverse_rate * (inverse_rate - 1))`.
- `coverage`: `best-effort` or `unknown`, never a capture-completeness guarantee. `reason` is nullable and machine-readable (`low-sample`, `no-observations`, `invalid-key-regime`, `legacy-keyed-exceeds-source`). `standardError` is null for unavailable or fewer than 30 sampled events; otherwise counts use square-root variance and shares use a delta-method percentage-point error.
- Empty sampled observations may have point estimate zero with `estimated/low-sample`, not proof of zero requests. Failed reads return an error, never a populated zero response. Pages transport timeout/error observations and per-key counts remain unsampled; upstream HTTP responses, including non-2xx responses, remain ordinary 1/64 delivery observations.

All queries use the same `[from,to)` observation window and preserve minute resolution. Full-window totals do not depend on route/key limits or the UI's latest-eight-bucket display. Shares are derived after summing weighted inputs, not averaged or clamped.

The seven aggregate dimensions share one bounded SQL source read. Dimension expansion uses a `VALUES` relation rather than a seven-arm compound `SELECT`, because production D1 permits at most five terms in a compound `SELECT`; the four legacy/sample source arms remain within that limit.

`ApiRequestAttributionResponse` includes:

- `generatedAt` — Unix seconds when the response was generated
- `window` — requested `from`/`to`, `durationSec`, `bucketSizeSec`, `routeLimit`, `apiKeyLimit`, and current `retentionDays`
- `totals` — aggregate `siteRequests`, `externalRequests`, `totalRequests`, `siteSharePct`, `externalSharePct`
- `siteDelivery` — `totalSiteRequests` plus Pages delivery counters and `publicApiSiteRequests` (`pagesCacheHits` is historical-only; current Pages traffic records upstream fetch/timeout/error counters)
- `lanes[]` — worker-load split by `lane` (`public-api`, `site-api`) with the same site/external counters
- `routes[]` — normalized per-route breakdown sorted by total demand volume
- `buckets[]` — time-series rollups using the requested `bucketSec`
- `keyedPublicApi` — summary of authenticated protected `public-api` traffic (`keyedRequests`, `unkeyedRequests`, share percentages, total keys in window, and truncation metadata)
- `apiKeys[]` — top API keys by keyed request volume with masked token, traffic class, active/expiry metadata, rate limit, request count, and keyed/public-api share percentages
- `scope` — measurement-inclusion flags for total site demand, worker load, and retired Pages cache-hit telemetry; `includesPagesProxyCacheHits` is always `true`, not evidence that cache-hit rows exist in the window

Key summaries use recorded `api_key_request_stats.request_count`. Each new writer increments `request_count` and `source_v2_request_count` atomically in its existing upsert, even when the independent source sample is rejected; old writers leave the default-zero marker unchanged. Legacy unkeyed demand is legacy public traffic minus `SUM(request_count-source_v2_request_count)`; new unkeyed demand comes directly from sampled `authentication_class='unkeyed'` rows. Their sum plus recorded keyed load owns each key's public share denominator, which can differ from the independently estimated Worker lane total. Impossible legacy subtraction or a marker outside `0..request_count` makes unkeyed/total/share values null with typed unavailable metadata; recorded key counts, keyed shares, omission totals and unrelated demand remain visible. No subtraction-and-clamp fallback exists.

### `GET /api/api-keys`

Admin-only API key inventory. Returns masked tokens plus metadata, but never returns stored secret material. Expired keys remain listed for operator review; callers should use `isActive` plus `expiresAt` to distinguish `active`, `expired`, and deliberate non-expiring exceptions.

**Response shape:** `ApiKeyListResponse` (defined in `shared/contracts/api-keys.ts`)

### `GET /api/api-keys/lifecycle-summary`

Admin-only counts projection for the Triage workspace. Returns aggregate credential lifecycle counts and the 7-day rotate/deactivate anomaly count without exposing API-key row metadata, owner emails, masked tokens, audit actors, or audit detail payloads.

**Response shape:** `CredentialLifecycleSummaryResponse` (defined in `shared/contracts/api-keys.ts`)

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
| `ownerEmail`         | `string \| null`       | No       | Optional owner contact; null clears it. |
| `tier`               | `ApiKeyTier \| null`   | No       | Vocabulary in `shared/contracts/api-keys.ts`; omission/null defaults to `"standard"`. |
| `rateLimitPerMinute` | `integer \| null`      | No       | Per-key threshold (`1`–`10000`); omission/null defaults to `120`. |
| `expiresAt`          | `integer \| null`      | No       | Unix timestamp when the key should expire. Omit to use the default 90-day expiry. Send `null` only for a deliberate non-expiring exception. |

**Response shape:** `ApiKeyCreateResponse`

**Success status:** `201 Created`

`token` is returned once, never persisted for keyed replay (`tokenUnavailableOnReplay: true`, `recovery`). Save it immediately or rotate the identified key. `key.expiresAt` reflects the stored default or explicit expiry.

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

`trafficClass` is ignored, not writable; a body with no recognized update fields returns `400`. The request lane is derived in `worker/src/handlers/http/gates.ts`, so issuance writes `"external"` and existing rows retain their attribution label.

`tier` uses the canonical `API_KEY_TIER_VALUES` vocabulary from `@pharos/contracts/api-keys`. The API Management editor preserves a key's canonical tier during unrelated metadata edits, including donor keys; intentional operator tier changes remain available. Only an unknown historical free-form tier defaults to standard in the editor.

**Response shape:** `ApiKeyMutationResponse`

Send `expiresAt: null` only for a deliberate non-expiring exception. Existing keys created before the expiry migration keep `expiresAt = null` until an operator changes them.

### `POST /api/api-keys/:id/deactivate`

Admin-only deactivation sets `isActive=false` in D1 and clears the current isolate's auth cache. Previously cached standard-key GETs on another isolate may remain authorized for the remaining five-second cache TTL; donor/self-serve keys bypass that cache.

Deactivation does not erase the row, wallet-bearing name, or usage metadata. For a donor privacy request, verify control of the wallet and resolve the exact donor key ID and claim prefix through the private operator lane. Deactivate that key first. Then use an operator-reviewed D1 transaction/batch restricted to that ID to delete its rows from `api_key_rate_limit`, `api_key_request_stats`, and `api_key_audit_log`, followed by its `api_keys` row. Read back that these rows are absent and that the original `api_key_donor_claims` row remains unchanged. Do not put the address or tokens in command output, audit detail, or a public feedback issue. There is no public deletion endpoint.

Keep `api_key_donor_claims` as the one-claim fence: it retains the address, prefix, and claim time even after key deletion, and another claim returns `409` when the key row is missing. Tell the requester exactly what remains; this is partial erasure. Removing the claim row is a separate, explicitly authorized reissuance decision, because an eligible wallet can then obtain a new key. The public donation ledger and any separately retained provider backups are outside this key-row deletion procedure; do not promise they have been erased.

Keyed create/rotate replay records in `admin_idempotency_keys.response_body` can retain `name` (including the donor address) and `ownerEmail` after the listed rows are deleted. Disclose that retention; do not delete idempotency fences to claim erasure, especially permanent `execution_unknown` records.

**Response shape:** `ApiKeyMutationResponse`

### `POST /api/api-keys/:id/rotate`

Admin-only rotation replaces the D1 secret and clears local auth cache; the standard-key cross-isolate TTL caveat above still applies. Plaintext is returned once; keyed replays return `tokenUnavailableOnReplay` and `recovery`, not `token`. No expiry input is accepted; `expiresAt` is preserved.

For donor keys, rotation updates the claim prefix and key material in one atomic D1 batch: both writes commit or neither does. Concurrent rotations keep the claim mapped to the surviving key prefix.

Donor eligibility uses Safety Score grades at claim time, not donation time. Later grade changes alone do not revoke or change an issued key; rotation also preserves its tier, quota, and expiry.

**Response shape:** `ApiKeyRotateResponse`

Supporter keys never rotate by self-service: re-signing an active or orphaned claim returns `409`; a deactivated claim returns `403`. A donor who lost a key uses the private channel (Telegram DM to `@TokenBrice`, secondary X DM to `@PharosWatch`; constants in `shared/lib/public-api-contract.ts`); the operator verifies the wallet and rotates it here. The same channel handles removal requests. The key name `donor <full lowercase address>` is searchable in the admin list.

Correcting the ledger is a two-step operator action. When removing or correcting a donation row in `shared/data/funding/donations.json` leaves a wallet with less than $10 in qualifying stablecoin donations, the runtime does not revoke anything on its own, because eligibility is only read at claim time. Find the `donor` key whose name carries that address and deactivate it with `POST /api/api-keys/:id/deactivate`. Leave the `api_key_donor_claims` row in place: it keeps that address from claiming again, and a re-claim attempt against a deactivated key returns `403` rather than issuing a second key.

### `GET /api/backfill-dews`

`backfill-dews?mode=backtest-metrics` is the primary calibration path over stored daily history/curated anchors (precision/recall, false-positive days, false negatives, P50/P90 lead time, churn, transition stability and cohort metrics). Default reconstruction is diagnostic, not a complete live-signal/trust-gate replay; unevaluable events retain `predicted=null`, excluded/partial coverage and missing supply anchors rather than false negatives. `repair=refresh-current` republishes current rows under the live $1M DEX trust floor; `repair=prune-history` deletes bounded daily windows whose retained snapshots lack DEX trust metadata. GET allows backtests/read-only `dry-run=true` repair previews; mutations require POST and operator Access service-token authentication.

Default `GET` reconstructs stored-event diagnostics. `events[].evaluation` reports availability (`available`, `partial`, `unavailable`), reasons and evaluated/expected pre-event days. Missing anchors stay unavailable. With no scored pre-event day, `predicted=null`; observed misses stay `false`. Summary `evaluableEvents` excludes these cases, `excludedEvents`/`partialEvents` disclose coverage, and `tpRate` uses only evaluable events (`null` if none); lead times cover detected events.

Use `GET /api/backfill-dews?mode=backtest-metrics` for the curated anchor fixture metrics described below. Use `GET /api/backfill-dews?repair=...&dry-run=true` for repair previews; mutating repair runs are `POST`-only.

### `GET /api/backfill-dews?mode=backtest-metrics`

Read-only calibration harness over curated historical depeg onsets (`BACKTEST_ANCHORS`), using retained `stress_signal_history` daily observations rather than rerunning today's live scoring formula.

**Authentication:** admin only (same Cloudflare Access gate as the rest of `/api/backfill-dews`).

**Granularity and coverage:** `"daily"`. The inclusive interval `[onsetAt - 14 days, onsetAt]` requires a valid observation at every UTC midnight inside its exact bounds. Intraday onsets require 14 daily observations; midnight onsets include both endpoints (15 observations). A valid observation has a finite score in `[0, 100]` and a recognized threat band. Only fully observed windows are scored: `detected=true` means at least one `ALERT` / `WARNING` / `DANGER`, `false` means a fully observed non-alert window, and `null` means missing/partial coverage, even if a partial window contains an alert. A midnight onset's snapshot counts with zero lead time.

**Denominators:** `evaluableAnchors` excludes all null outcomes; `excludedAnchors` includes absent and partial windows, with `partialAnchors` disclosed separately. Overall and peg-cohort recall use only evaluable anchors and are `null` when none are evaluable. `falseNegativeIncidents` counts only fully observed misses (zero when no anchors are evaluable). Lead-time percentiles and aggregate churn use scored anchors only; churn is `null` without evaluable anchors.

**Negative controls:** the production control registry intentionally remains empty until independently verified calm windows are admitted. Every control uses the same complete-daily-coverage requirement. Its `falsePositiveDays` is `null` for missing/partial coverage, otherwise the observed alert-day count, including measured zero. Aggregate `falsePositiveDays` and `precision` are unavailable (`null`) without fully observed negative-control exposure; `precisionUnavailableReason` is `no-observed-negative-control-exposure`. `cohortMetrics` discloses `negativeControlCount`, `evaluableNegativeControlCount` and `observedNegativeControlDays` (only scored exposure).

With controls, the legacy diagnostic precision ratio is detected incident anchors divided by detected incident anchors plus control alert-days. These are different sampling units, not a statistically validated incident-level precision model. A zero denominator yields `precision=null` with `no-positive-outcomes`; otherwise the unavailable reason is null. No new negative controls or live DEWS methodology changes are implied.

**Response excerpt** (additional metrics/cohorts and negative controls come from `handleBacktestMetrics` in `worker/src/api/backfill-dews.ts`)

```json
{
  "detectionRate": 0.75,
  "precision": null,
  "precisionUnavailableReason": "no-observed-negative-control-exposure",
  "falsePositiveDays": null,
  "evaluableAnchors": 4,
  "excludedAnchors": 0,
  "leadTimeDaysP50": 4,
  "leadTimeDaysP90": 11,
  "granularity": "daily",
  "perAnchor": [
    {
      "stablecoinId": "usdc-circle",
      "onsetAt": 1679400000,
      "detected": true,
      "leadTimeDays": 2,
      "firstAlertBand": "WARNING",
      "evaluation": {
        "availability": "available",
        "reasons": [],
        "observedDays": 14,
        "expectedDays": 14
      }
    }
  ]
}
```

| Field             | Type                         | Description                                                                                     |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `detectionRate`, `recall` | `number \| null` | Fraction of fully observed anchors with at least `ALERT`; `null` without evaluable anchors |
| `leadTimeDaysP50` | `number \| null`             | 50th-percentile lead time in days across detected anchors; `null` when no anchors were detected |
| `leadTimeDaysP90` | `number \| null`             | 90th-percentile lead time in days across detected anchors; `null` when no anchors were detected |
| `granularity`     | `"daily"`                    | Snapshot granularity used to compute lead time                                                  |
| `perAnchor`       | `BacktestMetricsPerAnchor[]` | One entry per anchor in the fixture (see below)                                                 |

**`BacktestMetricsPerAnchor`**

| Field            | Type                                       | Description                                                                       |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `stablecoinId`   | `string`                                   | Pharos stablecoin ID of the anchor                                                |
| `onsetAt`        | `number`                                   | Unix seconds of the curated depeg onset                                           |
| `detected`       | `boolean \| null`                          | Scored detection outcome; `null` for all incomplete daily windows |
| `leadTimeDays`   | `number \| null`                           | Days from first elevated snapshot to onset; populated only when `detected=true` |
| `firstAlertBand` | `"ALERT" \| "WARNING" \| "DANGER" \| null` | First observed elevated band, including in partial windows; null if none observed |
| `alertDays`      | `number`                                   | Count of elevated (`ALERT`/`WARNING`/`DANGER`) snapshots inside the 14-day window  |
| `bandTransitions`| `number`                                   | Number of band changes across those elevated snapshots                            |
| `pegType`        | `string \| null`                           | `pegged<PEG_CURRENCY>` for PSI-eligible anchors; `null` otherwise                  |
| `evaluation`     | `object`                                   | `availability` (`available`, `partial`, `unavailable`), `reasons`, `observedDays`, `expectedDays` |

`evaluation.reasons` is empty for complete coverage, `history-unavailable` for no retained rows, or `incomplete-daily-history` when rows exist but do not cover all required midnights with valid observations. Per-anchor `alertDays`, `firstAlertBand` and `bandTransitions` describe retained observations, not a scored outcome for excluded windows.

### `GET /api/backfill-dews?repair=refresh-current&dry-run=true`

Current-state DEWS repair preview under the live `$1M` DEX trust floor, with candidate IDs and source/validation diagnostics. It is not an exact execution plan: execution rereads inputs and excludes malformed-core-input assets that preview can retain.

### `POST /api/backfill-dews?repair=refresh-current`

Immediately republishes current `stress_signals` rows under the live `$1M` DEX trust floor. The response includes the dry-run preview payload plus the executed `computeAndStoreDEWS()` summary.

### `GET /api/backfill-dews?repair=prune-history&dry-run=true`

Bounded DEWS prune preview: returns `totalMatchingRows`, an up-to-50-row `candidateRowsSample`, optional `stablecoin` scope, and the post-window history boundary.

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

Queues deferred digest generation. An empty body, `{}`, or `{"kind":"daily"}` selects daily regeneration and bypasses its normal 1-hour dedup check. `{"kind":"weekly"}` selects weekly recovery on Monday UTC only; it preserves the weekly edition and channel dedup guards. A weekly intent expires when its requested UTC date ends, so it cannot backfill or generate another day's edition. The HTTP handler writes a bounded retryable intent into the `digest:force-run-request` D1 cache row and returns `202`; the dedicated `*/5 * * * *` digest-trigger poll slot runs due intents under the scheduled-event wall-clock and the selected job's existing lease. Transient failures retry with bounded backoff for up to three attempts, while permanent or exhausted failures remain as retained `dead_letter` state. A deliberate weekly intent has its own bounded attempt budget; it does not erase cron history or raise the automatic weekly recovery cap.

An optional JSON body instead updates exactly one editorial gate: `{"styleGateMode":{"daily":"enforce"}}` or `{"styleGateMode":{"weekly":"shadow"}}`. Only `daily|weekly` and `shadow|enforce` are accepted; unknown fields, malformed/unscoped values, and two-kind updates return `400` without mutation. A scoped update is **mode-only**: it writes only that kind's mode key and does not queue or overwrite `digest:force-run-request`. It returns `202` with `ok`, `accepted`, the full effective `styleGateMode: {daily, weekly}`, and `"Style gate mode updated; no digest generation queued."`, without a force-run `requestId`. An empty body or `{}` remains the explicit separate daily force-run trigger and returns both effective modes alongside the request ID. Weekly changes apply to the next eligible scheduled weekly generation/recovery, never an out-of-slot recap.

A JSON body of `{"llmProfile":{"daily":"heavy"}}` (or `weekly`, or `"standard"`) instead sets exactly one kind's digest generation profile in the D1 `digest:llm-profile:<kind>` key. It is likewise **profile-only**: it does not queue generation, returns `202` with the full effective `llmProfile: {daily, weekly}` and `"Digest LLM profile updated; no digest generation queued."`, and returns `400` without mutation for unscoped, two-kind, unknown-value, or combined (`kind`/`styleGateMode`) payloads. A failed post-write read surfaces as an error rather than a guessed state; reconcile the key as for a mode update. The scheduled jobs read a missing, invalid, or unreadable profile as `standard`. See [digest-pipeline.md](./digest-pipeline.md#llm-call) for what `heavy` runs.

Generation `kind` and `styleGateMode` cannot be combined in one request. Use a unique `Idempotency-Key` for each deliberate action. A scoped mode can commit before the subsequent effective-mode read or response fails; an HTTP error does not imply rollback. Reconcile both exact mode keys and the original idempotency record under ADR-27 before a new mutation. An explicit force-run can likewise have an ambiguous enqueue result; reconcile its original intent rather than manufacturing another generation. See [blocked-digest-edition.md](./runbooks/blocked-digest-edition.md#promote-or-roll-back-enforcement) for readiness and kind-local rollback.

**Response excerpt** (the full response also includes `styleGateMode: {daily, weekly}`)

```json
{
  "ok": true,
  "accepted": true,
  "requestId": "manual-digest-...",
  "message": "Digest trigger queued; will execute on the next polling tick (≤5 min)."
}
```

**Status:** `202 Accepted`

The worker no longer uses HTTP `waitUntil()` for this action. It enqueues the intent in D1 and returns immediately so the Access-gated ops proxy does not need to hold the HTTP request open for the full Anthropic generation window. The scheduled poll logs each run against the selected `daily-digest` or `weekly-recap` cron history and persists a compact `digest:last-trigger-result` cache entry for D1 inspection/future UI surfacing, including retry state, retained dead letters, and manual `skipped_locked` outcomes when another digest run already holds the lease. The current admin panel shows the daily enqueue result from the browser session; it does not yet render the persisted poll outcome or expose weekly recovery.

Unhandled pre-enqueue failures return unkeyed `500` with `{ "error": "Internal Server Error" }`, or keyed `503 execution_unknown`.

### `POST /api/trigger-yield-coverage-audit`

Recomputes the coverage-audit report after reviewed yield configuration is deployed. Uses the same `runYieldCoverageAudit`, `logCronRun`, `runCronWithLease` job identity, timeout policy, and declared connection allocation as the monthly audit. The monthly schedule remains `0 6 1 * *`.

Requires Cloudflare Access authentication and `X-Pharos-Admin: 1`, like `trigger-digest`. An optional `Idempotency-Key` deduplicates retries. No request body is required.

Execution is synchronous: keep the HTTP request open. The route does not launch long-running `waitUntil()` work. The worker applies this job's normal five-minute cron timeout, and the browser ops proxy waits up to 330 seconds so a slow audit still returns its real status. For an audit that runs longer than the client timeout, inspect cron history before retrying and prefer the machine API, which bypasses the browser proxy.

| HTTP status | Meaning |
| --- | --- |
| `200` | Audit finished with cron status `ok`. Inspect `/api/status` for the actual queue-budget verdict; completion alone does not mean the queue is healthy. |
| `409` | Another manual or scheduled audit owns the `yield-coverage-audit` lease. No second audit ran. |
| `503` | Non-healthy audit result. Unkeyed responses carry explanatory metadata; keyed failures become `execution_unknown`. A prior report may remain cached. |
| `500` | Unkeyed throw or persistence failure; keyed requests return `503 execution_unknown`. Check `crons["yield-coverage-audit"]` before retrying. |

`ok` responses include `job`, `status`, `itemCount`, and JSON-encoded `metadata`; keyed `5xx` failures use `execution_unknown`. Publication replaces the audit report and review queue, not hourly yield-source configuration, ranking rows, or yield history. Execution does record cron/producer history.

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

Operator-only report for Dwellir RPC parity and method-scoped routing readiness. It answers three questions from one read:

- credit ledger — this UTC month's local Dwellir credits against the configured cap (`budget`): attempted EVM JSON-RPC members (including retries, errors and no-response attempts) plus received native HTTP responses. This is conservative admission accounting, not the vendor's billed responses, which exclude error members; see [Metered supplemental provider budgets](./worker-and-api-limits.md#metered-supplemental-provider-budgets)
- `dwellir-evm` circuit state, so an operator can see whether the trial is currently demoted or held open (`circuit`)
- per-chain parity against an independent incumbent: retained runs, per-method availability, head lag, pinned state/log parity, first-touch and warm latency per method, latest-tag freshness, diagnostics, and pass/fail gates (`observation.chains[]`)

Diagnostic only: it never feeds scoring, public health, or the public API, and no other lane reads it. The response never contains the Dwellir API key — the report carries key presence (`budget.configured`) and credit accounting only. Registration lives in `worker/src/routes/admin-routes.ts`; the loader is `loadRpcProviderTrialReport` in `worker/src/lib/rpc-provider-parity/report.ts`.

This section owns the live report, freshness, retention and comparison contract. Dated probe captures, comparator reproductions and storage-capacity replays live in [RPC provider trial evidence](./process/worker-infrastructure-appendix.md#rpc-provider-trial-evidence); they are not current availability or rollout acceptance.

**Query parameters:** none.

**Response shape:** `RpcProviderTrialReport`, with per-chain `RpcParityChainSummary`, in `worker/src/lib/rpc-provider-parity/types.ts`. This illustrative excerpt is not a complete fixture; use those types for all per-method, comparator, window and failure fields.

```text
{
  "provider": "dwellir",
  "generatedAtSec": 1780000000,
  "budget": { "configured": true, "usable": true, "reason": "ok", ... },
  "circuit": { "state": "closed", "consecutiveFailures": 0, ... },
  "observation": {
    "runsRetained": 24,
    "chains": [{
      "chainId": "base",
      "routing": { "statePlacement": "primary", "logScan": true },
      "headLagBlocks": { "p50": 0, "p95": 1, "samples": 24 },
      "stateParity": { "checked": 24, "matched": 24, "mismatched": 0, ... },
      "gate": { "passed": true, "failing": [] },
      ...
    }],
    ...
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

`routing.statePlacement` is `preferred` when scheduled key/budget/circuit admission permits Dwellir and the chain is not disabled, otherwise `unavailable`. Preference is method/pin-scoped, not inventory membership or proof of a physical request. `routing.logScan` reports full-history log capability under that admission; retained-only Monad ranges still need an explicit interval/head check at the resolver. `DWELLIR_ROUTING_DISABLED_CHAINS` excludes listed production routes. CCIP state/log selection is independent, and page widths follow the first eligible provider. The read does not advance an open circuit to half-open; the next scheduled run may admit a cooled circuit. [ADR-40](./architecture.md#adr-40) records owner-approved capacity preference, not a claim that every trial gate passes or Dwellir is uniformly faster. Parity retains canonical independent incumbents, never compares Dwellir with itself and never automatically promotes providers.

`lastFailures` retains the newest five failed-call diagnostics per chain across both operators, newest first: `operator`, `step`, `method`, `blockParam` (tag/hex quantity/number, `fromBlock-toBlock` for `eth_getLogs`, or null; strings at most 64 characters), `httpStatus`, `rpcCode`, `message`, `errorClass`, and call clock `atSec`. Messages are sanitized with the safe-error helper, redact the actual configured header and URL-query authentication material before truncation, and are at most 160 characters. No URLs, keys, headers or full request/body payloads are retained. Older rows have no fabricated failure detail.

The Dwellir-only latest check keeps an explicit chain-local block-number sentinel on 36 targets: Multicall3's external getBlockNumber view at `0xca11bde05977b3631167028862be2a173976ca11` / selector `0x42cbb15c` on 34 chains, and ArbSys's external arbBlockNumber view at `0x0000000000000000000000000000000000000064` / selector `0xa3b1b31d` on Arbitrum and Robinhood. Nitro/Orbit Multicall3 returns Ethereum's L1 height, not the local L2 height; it is not a valid freshness sentinel on those targets. Each target requires a reviewed `latestStateProbe`; runtime magnitude heuristics and automatic method fallback are not used. Live Multicall3 bytecode was 3,808 bytes on 36 targets; XDC returned `0x` for both candidate sentinels, records an unavailable sentinel, and uses discriminating token-state observations for sufficiency instead.

The sentinel sequence is head H1 → `eth_call(latest)` yielding served block R → head H2, with no numeric references. The sole tolerance authority is `headLagThresholdBlocks(blockTimeSec)` in `worker/src/lib/rpc-provider-parity/report.ts`: T = `max(3, ceil(6 / blockTimeSec))`, the same six-second/minimum-three-block policy used by the head-lag gate. It is discriminating and `fresh` / `served-block-in-range` when H1−T ≤ R ≤ H2+T, or `stale` / `served-block-behind` below H1−T. This gives Arbitrum 24 blocks (0.25 seconds/block), Robinhood and HyperEVM six (one second/block), and Base three (two seconds/block). A fixed two-block allowance was insufficient for fast-chain/load-balanced skew: an Arbitrum served block 11 ahead of H2 is now inside its shared 24-block budget, not missing evidence. Ahead-of-budget results, any regressing head (which could be a reorg), or a failed step remain indeterminate; a fast advancing head does not exhaust a numeric bracket. Each sample preserves the `toleranceBlocks` actually used when acquired; summary `blockTolerance` reports the current chain's shared sentinel budget, without rewriting historical verdicts.

Every target also reads its own token contract's `totalSupply(latest)` (selector `0x18160ddd`), because a fresh block-number sentinel does not establish freshness for another `(to,data)` pair. Using the first chain head H1, the post-token-call head H2, and same-probe sentinel block R when available, its numeric Dwellir-only window is `[max(0,H1−T), max(H2,R)]`, with the same shared T as the sentinel. Including R avoids falsely declaring stale a moving HyperEVM value served at H2+2. Before numeric reads, H2 > H1+1 is indeterminate / `bracket-ancestry-gap`: no extra ancestry RPCs are made, and a fresh sentinel cannot turn that token bracket into a positive combined claim. Otherwise, every block in the window must be read, capped at ten (`RPC_PARITY_LATEST_MAX_NUMERIC_CALLS`); wider windows are inconclusive with no partial sampling. A match in a proven same-head hash or adjacent-head parent-hash bracket is `fresh` / `matched-numeric-block`, but unchanged window values are `discriminating: false`: quiet-token matches are inconclusive about a token-specific stale cache, not negative freshness evidence. Discriminating token coverage is opportunistic and not a sufficiency requirement where a sentinel exists; it remains the floor on XDC. A complete stable-hash H1=H2 window without a match is `stale` / `no-bracket-match`; advancing-head misses stay indeterminate / `moving-bracket-no-match`. H1 and H2 headers fence the known head bracket, with H2 checked again after numeric reads; references through R do not require a separate future header. Detected reorgs, regressing heads, failed reads, or an unavailable numeric block above H2 remain indeterminate, never stale. Arbitrum, Monad, MegaETH and Cronos already exceed the token cap with stationary heads; their sentinel evidence can still satisfy freshness sufficiency.

Samples retain `sentinelFreshness` and `tokenFreshness`, including both sub-verdicts, the exact contract/selector read, acquired tolerance, heads, latest/numeric values, and token `referenceEndBlock`. The combined `latestFreshness` is stale if either check is stale; otherwise a deployed sentinel must be fresh and the token check matched or was `bracket-too-wide`. On XDC without a deployed sentinel, the combined verdict uses the actual token verdict. A failed token read or regressing/reorg bracket never becomes a positive combined claim. A discriminating fresh sentinel remains discriminating in the combined report when a quiet token matches; token-specific discrimination remains visible separately in `.tokenState`. `lastStale` names the selected failing check's actual method, run clock, budget, heads and value/reference payload.

`latency.<operator>.firstTouch` and `.warm` contain p50/p95 and sample count for every category. The first request to an origin within the run is first-touch; later requests to that origin are warm even across targets. Per-call percentiles include failed calls; `warmRunMedian` uses successful calls only, while availability gates failures separately. `latest` now counts only actual latest-tag calls; numeric near-head state reads are `reference`, block-header reads are `header`, and initial/post-sentinel/post-token heads remain `head`. Pre-v6 mixed calls appear only in `legacy-latest` and cannot satisfy `success-rate:latest` or its attempt floor. Historical pinned state/log checks remain `state` / `logs`; the comparator performs no latest check.

A numeric reference strictly above the served H2 that returns a not-found / `HeaderNotFound` / “No state available” / “header not found” RPC error records `reference-unavailable`. It increments `availability.<operator>.reference.referenceUnavailable`, never successes, and is excluded from the provider-availability denominator and provider failure aggregates. The token bracket and combined freshness stay indeterminate with that reason, even alongside a fresh sentinel. The same error at/below H2 or on an actual latest-tag call remains a provider failure. `served-block-behind` and complete stable-bracket `no-bracket-match` stale detection are unchanged.

The compressed v7 store retains `rpc:provider-parity:dwellir:v1` and reads v1–v6. Exact detailed runs keep dictionary-encoded layouts, lossless millisecond timings, delta-encoded heights and full dual-check values/provenance (20 Dwellir / four comparator calls maximum). Oldest detailed runs are byte-pruned under the unchanged 240 KiB serialized compressed-envelope and 4 MiB raw ceilings; seven days / 168 runs are upper bounds, not a guaranteed detailed window. `observation.windowStartSec` / `windowDurationSec` name that actual retained span; chain `windowStartSec`, `windowEndSec` and `windowDurationSec` name only the current host's actual detailed samples. Latency, head lag, `runs`, `dwellirSuccessRate`, failure diagnostics and error/failed-step aggregates use these details.

V7 additionally retains compact per-run gate counters independently for seven days / 168 hourly runs; detailed byte pruning never removes them. `gateWindow` names each chain's counter span and sample count. `stateParity`, `logParity`, per-method `availability` and both latest-freshness counters/gates use this window, preserving mismatches, provider failures and stale verdicts after their detailed run is pruned. Sparse state mismatch identities retain their run clock, block and actual comparator; stale identities retain their clock, reason, contract/selector, heads and acquired budget. Exact stale token values remain available only while their detailed proof is retained. Head-lag/warm-latency and minimum-run gates still require 24 actual detailed samples; comparison/attempt/freshness floors remain 24. No synthetic calls, timings, token values or missing historical coverage are inferred.

Legacy rows seed counters only from still-retained evidence: a mismatch already byte-pruned before v7 cannot be recovered. V1's unknown attempts/timings/freshness, v2's unknown discrimination, v3's single comparator and v4's split provenance remain unchanged; mixed pre-v6 calls remain `legacy-latest`. Detailed failure messages keep the newest-five policy. Appended targets preserve history; changed Dwellir hosts reset only that target's detailed and counter windows, including on report reads. Reordering targets resets history. An oversized newest raw run fails persistence with `rpc-parity-raw-row-budget`. **Rollback:** v1–v6 readers reject v7; preserve/export the exact cache row before rolling back. The old reader's next write resets history rather than interpreting v7 counters. Restoring a saved v6 row loses evidence collected since that backup.

Report reads expire detailed runs, gate counters and latest evidence older than `RPC_PARITY_RETENTION_SEC` at `generatedAtSec`, even without writes; the exact seven-day cutoff is retained. Expired windows fail sufficiency gates.

`errorClasses` and `comparatorErrorClasses` count samples with provider failures (`range-cap`, `result-cap`, `rate-limited`, `capability`, `server-error`, `timeout`, `network`, `rpc-error`, `invalid-response`). `failedSteps` counts failed method categories per operator; `lastComparatorFailure` names its run clock, category, class, HTTP status and actual comparator reference. Invalid method result shapes are failures, not successes. HTTP 5xx stays `server-error` even if its body mentions an unsupported operation; HTTP range/result-cap bodies retain their specific class. Unavailable reads never count as state/log mismatches: both operators must answer for a comparison. Dwellir state/log reads are still attempted when the comparator's corresponding method fails; an unresolved logs pin skips that method without issuing either operator's log read. Astar's reviewed keyless pin is `https://evm.astar.network`, verified for historical USDC supply and recent/older logs on 2026-10-05.

Worldchain's reviewed keyless comparator is `https://worldchain.drpc.org` ([provider listing](https://drpc.org/chainlist/worldchain-mainnet-rpc)). Its distinct origin prevents the configured census Alchemy bearer from reaching public comparator reads.

HyperEVM explicitly separates comparator roles: keyless dRPC `https://hyperliquid.drpc.org` supplies head/lag and numeric state, while the configured reth Alchemy pin `https://hyperliquid-mainnet.g.alchemy.com/v2/` supplies logs with its origin-registered bearer header. Missing Alchemy configuration/auth still permits head/numeric-state checks; logs remain unchecked with `logParity.skippedReason = "no-comparator"`, without substituting native log indices. One Alchemy head read immediately before its log read genuinely warms that separate origin; its reference and first-touch phase are recorded, without changing the primary head/lag/state baseline or the two-warm-call floor.

Log identities remain exact; no normalization or exclusion turns shifted/missing logs into a pass.

The hourly lane is strictly serial (`maxConnections: 1`) with a four-minute run deadline and an eight-second request timeout clipped to remaining time. A fully covered token check adds five fixed calls (latest, post-token head, three hash reads) plus its numeric references; a too-wide check adds only the pre-read header, latest, and head. With stationary heads and R=H2, the 37 targets comprise 19 four-block token windows, 13 seven-block windows, BSC's nine-block window, and four too-wide windows: 648 total calls / 536 Dwellir credits per complete run. Allowing each feasible window to reach the ten-call cap gives 802 calls / 690 credits maximum. Those plans cost 12,864–16,560 credits/day before failures/skips. Measured full-chain passes can fit within the four-minute deadline; the cap bounds slow-run wall time rather than assuming every complete pass must exceed it. The deadline remains bounded and the starting target rotates by `floor(atSec / 3600) % targetCount`, so partial runs share coverage instead of permanently starving one tail. Stored/report `skips` names `no-comparator`, `no-dwellir-entry`, `deadline`, and `aborted`, with latest clock/reason and unknown legacy gaps. An unavailable HyperEVM logs pin stays a retained partial sample, not a whole-chain skip.

A transport timeout assigned less than the full eight-second request budget is a lane `deadline` stop on either operator: the incomplete chain is skipped, not counted as a provider failure or method attempt. Full-length timeouts remain provider failures, even at the run-deadline boundary. Parent-signal cancellation remains `aborted`; HTTP/RPC failures that actually answer remain measured failures. Existing failures are not retroactively relabeled.

`budget.reason` is `ok` when the ledger is readable and under cap; otherwise `not-configured`, `provider-budget-exhausted`, or `ledger-unreadable`. `budget.usedCredits` is `null` when the key is unconfigured or the ledger is unreadable. An absent circuit row yields a closed `circuit` object with zero failures and `updatedAtSec: null`; `circuit: null` means its read failed. `observation` is `null` with `observationError` set when stored parity samples cannot be read. Diagnostic failures still return `200`, preserving independently available budget/circuit evidence.

**Error responses:** `401` without a valid admin credential, as for every ops route. Diagnostic failures inside the report are reported in the body rather than as an HTTP error status.

### `POST /api/remediate-blacklist-amount-gaps`

Admin-only bounded remediation endpoint for recoverable **EVM** blacklist rows. Default candidate selection excludes Tron before applying the row limit; explicit `chainId=tron` returns `400` without reading or updating events. Tron event-time amounts require the scheduled confirmed transfer-replay lane or the guarded evidence-based operator CLI in [Blacklist Tracker](./blacklist-tracker.md), not this EVM receipt-recovery route. EVM amountless events remain unavailable with `event_time_unproven`; neither preceding-block balances nor unbound burn transfers prove the amount at the target log position. An unavailable amount cannot trigger EURC mirror-zero suppression. Existing amounts and suppressed history are not blindly rewritten.

Event-amount remediation does not hydrate chain RPC endpoints or require a dRPC key: emitted destroy amounts use Etherscan receipt evidence, while unproved amountless events remain unavailable. Independent current-balance snapshots retain their own RPC provider configuration.

**Authentication:** same admin auth as other ops endpoints.

**Idempotency:** supported via optional `Idempotency-Key`.

**Inputs** — Query parameters or JSON body; body overrides follow numeric-query validation.

- `chainId?: string`
- `stablecoin?: BlacklistStablecoin` from the shared `BLACKLIST_STABLECOINS` set
- `limit?: number` default `25`; max `200` in dry-run mode, max `100` in write mode (`dryRun: false`) so updates commit in one atomic D1 batch — a larger write-mode limit returns `400`
- `dryRun?: boolean` default `true`
- `onlyMissingProvenance?: boolean` default `false`; set `true` to restrict the pass to legacy rows missing contract/config provenance
- `maxAttempts?: number` default `25`, clamped to `0`–`10000`; selects rows with attempt count at most this value, or disables that filter at `0`

**Dry-run response excerpt** (also returns `filters`, `truncated`, budget diagnostics, and `sample`)

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

**Write-enabled response excerpt** (also returns `filters`, candidate/resolution counts, truncation/budget diagnostics, and `cacheInvalidation`)

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

Returns recent audited actions (actor, target, result, HTTP status, details), including dispatched catalog inspections/previews and handler-owned events. Internal probes, payload-conflict replays, and pre-dispatch method/access rejections are excluded.

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

Sends a pre-rendered maintenance/broadcast message to Telegram subscribers via the pending queue. Live calls submit one message per target chat per chunk; dedupe conflicts update only eligible pending rows, never rows already sending, sent, or execution-unknown. The dispatch cron delivers them with the same per-chat rate-limit isolation and wall-clock retry semantics as regular alerts. Handler-owned audit writes are best-effort; some early rejections are not logged.

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

`sample` lists up to the first 5 target chat IDs (sorted ascending) — useful for sanity-checking the scope filter before going live. `targetMessageCount` covers only the fleet rows; when the supplied canary is also in the selected scope, it is excluded from that count. No Bot API call or queue write occurs during dry-run. Successful dry-runs and HTML preflight failures both attempt admin audit writes.

**Live response (`dryRun: false`)**

```json
{
  "enqueued": 1247,
  "jobId": "broadcast:0123456789abcdef0123456789abcdef",
  "canary": {
    "chatId": "123456789",
    "chunksSent": 1
  },
  "deliveryEstimate": {
    "projectedPendingMessages": 1247,
    "estimatedDrainTimeSec": 300,
    "minimumTtlReserveSec": 900,
    "remainingTtlReserveSec": 2400,
    "hasMaterialTtlReserve": true
  }
}
```

Before enqueue, live execution requires the generic `telegram-api` circuit to admit sends and sends the exact chunks to the private canary. A rejected, uncertain, or incomplete canary prevents the fleet job. On success the request records one `broadcast:<digest>` job (`jobId`) with the 45-minute admin TTL; the five-minute dispatcher fans it out to the scope, excluding the canary chat, and drains it at broadcast priority behind risk alerts. `enqueued` reports the projected non-canary chat/chunk messages (`fleetChatCount * chunkCount`).

**Error responses:** `400` for invalid JSON, empty or over-16,000-character `messageHtml`, unknown `scope`, non-boolean `dryRun`, malformed `canaryChatId`, or a live request without `canaryChatId`. `422` for malformed/unsupported Telegram HTML or a canary rejected for formatting/bad-request reasons. `409` when the projected fleet backlog cannot retain the hard 15-minute reserve inside the 45-minute admin TTL, or when the `telegram-api` circuit is open (`reason: "transport-outage"`). `503` covers a non-formatting canary failure; unkeyed `500` covers a missing live bot token or unhandled failures. Keyed `5xx` outcomes return `503 execution_unknown`, without these bodies. Canary rejection bodies report `fleetEnqueued: 0`.
