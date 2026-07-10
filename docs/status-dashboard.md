# Status Dashboard

Operational reference for the split status surfaces: public `/status/` read-only health monitoring and Access-gated route-based operator workspaces under `/admin/` and `/admin-api/`, including backend status computation, hysteresis, discrepancy detection, endpoint probing, guarded actions, credential operations, and durable audit history.

---

## Scope

The operator dashboard combines ten signals:

1. Cache freshness (`/api/status` -> `caches`)
2. Cron health (`/api/status` -> `crons`)
3. Data quality (`/api/status` -> `dataQuality`)
4. Status state machine (`/api/status` -> `state`, `timeline`, `causes`, `summary`)
5. Synthetic status probes (`/api/status` -> `probe`, `discrepancy`)
6. Live reserve sync health (`/api/status` -> `reserveComposition`)
7. Yield health (`/api/status` -> `yieldHealth`)
8. Publication and dependency health (`/api/status` -> `publicationHealth`, `dependencyHealth`)
9. Live endpoint probing (`useEndpointProbes`) + filtered history (`useStatusHistory`)
10. Site-vs-external demand attribution (`useRequestSourceStats` -> `GET /api/request-source-stats`)

The repo now ships two related surfaces:

- `/status/`: public, read-only health board backed by `/api/health` plus public browser probes
- `/admin/`: Triage workspace
- `/admin/pipeline/`: data-quality, market, reserve, yield, storage, integrity, and discovery workbench
- `/admin/reliability/`: endpoint, dependency, demand, and cache reliability workbench
- `/admin/crons/`: grouped scheduler workbench
- `/admin/actions/`: guarded operator action catalog and execution history
- `/admin/comms/`: Telegram delivery operations and audience coverage
- `/admin/history/`: incident, action, and credential activity history
- `/admin-api/`: API-key inventory and lifecycle workbench

The active frontend operator mode is now:

- `ops.pharos.watch`: Cloudflare Access-protected operator host. The browser uses same-origin Pages Functions routes under `/api/admin/*`, and those functions proxy to `ops-api.pharos.watch` with a service token.

`/admin/` and `/admin-api/` are hard-blocked outside `ops.pharos.watch` via Pages host-gate functions. `/status/` is now public and read-only.

---

## Frontend Flow

### Route and metadata

- Public page: `src/app/status/page.tsx`
- Public client: `src/app/status/client.tsx`
- Operator page: `src/app/admin/page.tsx`
- Operator layout: `src/app/admin/layout.tsx`
- Ops chrome: `src/components/ops-shell.tsx`
- Workspace registry: `src/lib/admin-workspaces.ts`
- Workspace clients: `src/app/admin/{pipeline,reliability,crons,actions,comms,history}/client.tsx`
- API-management client: `src/app/admin-api/client.tsx`
- Ops host gate: `functions/admin/[[path]].ts`
- Ops proxy route: `functions/api/admin/[[path]].ts`
- Pure derived-data helpers: `src/lib/status-dashboard-model.ts`
- Decomposed UI components: `src/components/status/*`
- The shared `OpsShell` owns compact private chrome, route navigation, theme, public-status, and sign-out controls. It does not mount the public event tape, public navigation, feedback control, or public footer.
- The `/admin/` Triage workspace provides the command-center top fold:
  - a compact triage header with the three independent verdict axes (`Service`, `Evidence`, and `Intervention`), recovery-hold context, `FreshnessIndicator`, and `RefreshCountdown`
  - blocker, cron-error, public-health, watch, reserve-drift, and classification-warning summary badges
  - deduplicated blockers and a `Needs attention` queue ordered by severity, public impact, age, and stable registry order
  - a state-machine / probe / discrepancy diagnostics disclosure whose deep content mounts only while open; it auto-expands only on the first evaluated signal after evidence loads, and later signals surface a `New signal` badge on the collapsed summary instead of forcing the section open (`src/app/admin/use-auto-expand.ts`)
  - a promoted `Recommended Now` action strip derived from blocking causes and unhealthy cron lanes
  - explicit stale-client, public-health divergence, and background-fetch notices that preserve the last good payload
  - a compact `Credentials` lifecycle summary (`src/components/status/credential-summary-card.tsx`): active, expiring-soon, expired, and non-expiring counts plus a 7-day rotate/deactivate audit-anomaly count, derived from the existing `/api/api-keys` inventory and global audit-log reads with the same predicates as the API Management summary. It renders counts only — no rows, editors, or mutations — and links lifecycle work to `/admin-api/`. Missing evidence renders as `Unknown`, never zero.
- `/admin/` disables indexing (`robots: { index: false, follow: false }`)
- `/status/` stays read-only, uses only public read endpoints, and is public/indexable through its route metadata and sitemap entry
- The public `/status/` top fold uses `PublicStatusHero`: a headline row, conditional warning paragraph, four-metric strip, and compact metadata footer with browser-sync timing and refresh control.
- The public `/status/` top fold also keeps the `Status runway` explicitly fixed to the last 30 days; the `24h` / `7d` / `30d` pills now belong only to the transition log below so filter changes do not silently reframe the hero summary
- `src/components/status/public-status-hero.tsx`
  - Renders the public-monitor hero with:
    - a status narrative headline instead of the old single-word + four-card metric template
    - a warning line only when the public status is not healthy or warnings are present
    - four compact metric tiles for cache pressure, browser probes, mint/burn sync, and circuit breakers
    - a compact footer for health sample time, public-query sync floor, and browser probe freshness
- `src/components/status/uptime-bar.tsx`
  - Renders the fixed 30-day public `Status runway` with explicit labeling (`Last 30d`) so the hero summary keeps a stable scope even while the transition table is filtered
- The public `Overview` lane uses flatter signal cards for mint/burn sync, blacklist ingestion, optional Telegram bot health, and impacted public surfaces
- The public blacklist-ingestion card keeps historical low-ratio amount gaps visible, but only recent or threshold-crossing gaps inherit warning/stale treatment; this matches the shared blacklist gap thresholds instead of flagging any non-zero backlog as degraded
- Public cache freshness tables show the shared cache-age ratio bands (`>8x` degraded, `>12x` stale), while the hero and impacted-surface callouts follow the full shared cache-impact floor: missing cache rows and stale cache age remain stale, and cached-fallback mode degrades a lane even when the age ratio is still inside target. Stale or degraded producer-source freshness can still appear as an admin `/api/status` warning cause without becoming a public impacted-surface callout by itself until the public availability budget is breached.
- The public mint/burn card, hero tile, and impacted-surface callout now follow the same backend lane contract as `/api/health`: sync freshness is primary, but a fresh cache still degrades publicly when the critical mint/burn lane's latest run is unhealthy
- The public circuit-breaker hero tile, reliability summary badge, and public breaker table use the same public-impact circuit key filter as `/api/health`: `live-reserves:*`, `dexscreener-liquidity`, and `dexscreener-search` breaker states remain available in the raw health payload and admin reliability view, but they do not make the public `/status/` surface report an open public-impact breaker
- Public `Overview` and `Reliability` lane shells use theme-aware tinted gradients with elevated inner cards so light mode keeps the same hierarchy without inheriting the dark-only monitor slabs

### Data hooks

- `src/hooks/use-status.ts`
  - `useStatus()` — calls `GET /api/status` through same-origin `/api/admin/status` on `ops.pharos.watch` via `useAdminPollingQuery`
  - Query key uses the fixed ops-proxy scope; no browser-held secret is involved
  - `staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0` (via `CRON_1MIN` cadence)
- `src/hooks/api-hooks.ts`
  - Owns the shared low-friction query wrappers for `GET /api/health`, `GET /api/peg-summary`, `GET /api/dex-liquidity`, `GET /api/report-cards`, `GET /api/yield-rankings`, and related read endpoints
  - This is the live source of truth for `useHealth()` / `usePegSummary()` and the other cache-backed read hooks used by the dashboard model
- `src/hooks/use-endpoint-probes.ts`
  - Probes **public + admin** endpoint probe groups with `staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0`
  - Public probes use the same-origin `/_site-data/*` website lane; admin probes use same-origin `/api/admin/*` on the ops host
  - Manual/admin mutation actions are listed but intentionally not auto-probed
  - `/api/health` and `/api/status` are parsed semantically, so `200` responses with `status/overallStatus = degraded|stale` count as unhealthy in the browser probe summaries
  - Also exports `usePublicEndpointProbes()` for the public `/status/` page, which probes only the public endpoint group
- `src/hooks/use-public-status-history.ts`
  - Calls `GET /api/public-status-history` through same-origin `/_site-data/public-status-history` on website hosts
  - Uses the endpoint's explicit `window=24h|7d|30d` filter instead of approximating windows with row-count-only limits
  - The public page binds one fixed `30d` query for the runway and a separate user-selected query for the transition log, so the hero summary and history table no longer fight over the same state
  - **Public-impact filter (2026-04-13):** `/api/public-status-history` filters the state-machine transitions down to public-impact incidents whose causes include at least one public-facing impact code (`cache_ratio_*`, `cache_freshness_query_failed`, `cache_warning`, `fx_cached_fallback`, `mint_burn_public_*`, `mint_burn_health_query_failed`, `open_circuit_groups`, `circuit_query_failed`, `cron_error_runs`, `multiple_unhealthy_crons`, `unhealthy_crons_present`, `db_unhealthy`). Producer-only source freshness causes such as `fx_source_*`, admin-only data-quality causes (`missing_prices_*`, `blacklist_gaps_*`, `reserve_sync_*`, `onchain_*`, `watch_*`), and any `info`-severity cause are excluded from opening a public incident. Once a public-impact incident is retained, the endpoint also retains the recovery path needed to return that incident to `healthy`, even when the recovery rows only carry info-level causes. The endpoint sources its `currentStatus` field from `assessPublicHealth` (matching `/api/health`) instead of the hysteresis-smoothed admin `status_state.current_status`, so the `/status/` page hero badge and the uptime bar / transition timeline always agree.
- `src/hooks/use-status-history.ts`
  - Calls `GET /api/status-history` through same-origin `/api/admin/status-history` on `ops.pharos.watch`
  - Query key uses the fixed ops-proxy scope; no browser-held secret is involved
  - Adds rolling windows (`6h`, `24h`, `7d`, `30d`) for timeline drilldown
- `src/hooks/use-request-source-stats.ts`
  - Calls `GET /api/request-source-stats` through same-origin `/api/admin/request-source-stats` on `ops.pharos.watch`
  - Polls the default `24h` window with `1h` buckets, a top-5 route breakdown, and a top-25 keyed public-API breakdown
  - Measures total site-vs-external demand across same-origin `/_site-data/*` plus `api.pharos.watch`
  - Top-line `site` demand includes Pages cache hits, Pages upstream fetch attempts, and `api.pharos.watch` requests attributed to browser evidence or website-owned API keys
  - Worker-lane telemetry remains visible separately so operators can distinguish total demand from actual `public-api` vs `site-api` worker load, and the admin reliability lane now adds an API-key load table for authenticated protected public traffic
  - Uses the same admin polling cadence as the other operator-only reads (`staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0`)
- `functions/api/admin/[[path]].ts`
  - Cloudflare Pages Functions catch-all for operator-only admin routes
  - Host-gates to `ops.pharos.watch` so public hostnames cannot use the proxy
  - Strips `/api/admin` and forwards to `ops-api.pharos.watch` with `CF-Access-Client-Id` / `CF-Access-Client-Secret`
  - Allows only admin routes and shared dynamic-admin matches from `shared/lib/api-endpoints/`
  - Verifies the operator's UI Access token against `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD`, accepting either `Cf-Access-Jwt-Assertion` or a same-origin `cf-access-token` / `CF_Authorization` session token when the assertion header is absent
  - Forwards only `Accept`, `Content-Type`, `Idempotency-Key`, and `X-Pharos-Admin` from the browser request; after signature verification, it injects the normalized human email from the UI Access JWT for audit attribution and ignores browser-supplied actor headers
  - Reflects a narrowed response-header set (`Allow`, `Cache-Control`, `Content-Type`, `Idempotency-Key`, `Warning`, `X-Data-Age`, `X-Execution-Certainty`, `X-Idempotent-Replay`) back into the app shell
  - Converts upstream timeouts into operator-visible `504` JSON errors; non-timeout fetch failures and Access redirect responses still return `502`
- Workspace clients own only the queries their route requires. Triage does not mount credential inventory rows, endpoint matrices, cache tables, or healthy cron rows; Reliability owns endpoint/demand reads, History owns transition and audit reads, and API Management owns credential lifecycle mutations. Triage additionally reads the credential inventory and global audit log for its counts-only lifecycle summary.
- `src/lib/status-dashboard-model.ts`
  - Provides pure status derivations and cron group construction without owning React polling or a root five-second clock
- `src/hooks/use-critical-ops-model.ts`
  - Builds the memoized Triage/Actions dashboard model from status, public health, and critical browser probes
  - The model is memoized on its actual data dependencies and rebuilds only when query evidence changes or a required query crosses the staleness boundary (`STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs`); there is no free-running interval clock at the workspace root
  - Relative-time labels (dashboard fetch age, diagnostics sync floor) self-update inside the `FreshnessIndicator` leaf component instead of rerendering the workspace
- `src/lib/status/action-recommendations.ts`
  - Shared recommendation engine reused by the status model and status UI components
- `src/lib/status/cron-config.ts`
  - Shared cron display metadata lookup used by both the status model and cron UI
- `src/components/longform-scrollspy-nav.tsx`
  - Applies sticky section navigation without re-running hash alignment on every live refresh, so polling does not snap operators back to an anchored section mid-scroll
- `src/components/status/telegram-bot-stats.tsx`
  - Renders delivery health, shared backlog-policy evidence, permanent failures, retries, dispatch results, and per-alert delivery before a separate audience-coverage section. Missing optional telemetry remains `Unknown`, never zero.
- Cron telemetry is grouped by trigger slot and rendered as a matrix:
  - 15-minute core ingestion / score recompute
  - 5-minute Telegram dispatch lane for subscriber alerts
  - 30-minute on-chain intake jobs (`sync-mint-burn` on `4,34`, `sync-mint-burn-extended` on `13,43`) shown together in the half-hourly group but labeled as isolated triggers
  - 30-minute charts / liquidity jobs plus the decoupled DEWS / PSI DB-only trigger
  - hourly core yield publisher (`sync-yield-data`); `sync-blacklist` is on a dedicated 6-hourly trigger, and the reserve + redemption + Kinesis lane is on a dedicated 4-hourly trigger; `sync-dex-discovery` is on a dedicated 2-hourly trigger
  - daily snapshot / digest / coverage-discovery jobs
  - The default attention filter does not mount healthy rows; operators can search and filter by state, impact, trigger group, and running status
  - Trigger boundaries remain visible, with severity ordering inside each group and stable registry order for ties
  - Rows show state, impact class, operator-friendly label, raw job id, trigger, last run, last good run, readable/exact duration, item count, and evidence markers
  - A selected-row detail panel owns full metadata, error text, in-flight progress, attempt records, stale artifacts, latest events, and accessible recent-run outcomes
  - Slot execution metadata includes compact child outcome counts (`jobsAttempted`, `jobsSucceeded`, legacy `jobsRun`, `jobsSkipped`, `jobsNeutralSkipped`, `jobsDegraded`, `jobsErrored`, `budgetOnlyJobs`) so a best-effort slot can surface degraded/error children without hiding later jobs that still ran. Expected no-op skips, such as an empty manual digest poll, increment `jobsNeutralSkipped` instead of `jobsSkipped`.
  - Budget-only scheduled surfaces are exposed separately through `budgetOnlySurfaces` instead of being folded into `crons`: Telegram registration reconciliation, the durable alert-broker delivery drain, and the manual digest-trigger poll report cache-backed checked-at time, duration, due/processed counts, outcome, skip reason, and bounded metadata. Broker retry telemetry is independent of Telegram bot-token preflight.
  - When a leased job is still running, rows and the detail panel surface `running` / `running-stale` state from `crons[*].inFlight`
  - Orphaned progress rows and expired leases are suppressed from `crons[*].inFlight` and exposed as `crons[*].staleArtifacts`, with aggregate counters in `summary.staleCronArtifacts`, `summary.orphanedCronProgressRows`, and `summary.expiredCronLeases`
  - Shared display metadata now comes from `shared/lib/cron-jobs.ts`, which also feeds worker interval expectations
  - Job-specific metadata summaries are resolved through `src/components/status/cron-metadata-summary.ts` and clamped in the row/details split
- The operator UI uses fixed route workspaces instead of a single scrolling lane stack:
  - `Triage`: current incident state, blockers, watch count, recommended action, last transition, query freshness, raw diagnostics, and a counts-only credential lifecycle summary linking to API Management
  - `Pipeline`: URL-backed tab inspection for `Quality`, `Markets`, `Reserves`, `Yield`, `Storage`, `Integrity`, and `Discovery`; inactive modes are not mounted
  - Mint/burn reconciliation now defaults to the six highest-severity rows and exposes the long insufficient-source tail behind a `See all` disclosure button
  - `Reliability`: URL-backed `Impact`, `Endpoints`, `Dependencies`, `Demand`, and `Cache` modes; manual mutation routes are excluded from default probe noise
  - `Crons`: grouped, filterable attention workbench with a sticky selected-row evidence panel and separately grouped budget-only surfaces
  - `Actions`: searchable intent/risk catalog with one shared execution dialog, direct dry runs where supported, structured results, and persistent action history
  - `Comms`: delivery-first Telegram operations followed by separate audience coverage
  - `History`: window, severity, surface, cause, and public-impact filters plus correlated incident, action, and credential activity
  - `API Management`: attention-first, searchable, filterable, sortable, paginated credential inventory with one selected-row editor and one-time token acknowledgement
- Workspace order is stable for operator muscle memory: `Triage`, `Pipeline`, `Reliability`, `Crons`, `Actions`, `Comms`, `History`, and `API Management`. Urgency stays in Triage rather than reordering navigation.

### Endpoint groups

Probe groups are sourced from `shared/lib/api-endpoints/`:

- `public`: user-facing read endpoints
- `admin`: admin read endpoints
- `manual`: operator-triggered actions (shown in UI, not loop-probed)

---

## Backend Contract (`GET /api/status`)

Source: `worker/src/api/status.ts`

Shared raw-status evaluator: `worker/src/lib/status-evaluation.ts`

Shared public-health floor: `worker/src/lib/public-health-assessment.ts`, backed by the pure helpers in `shared/lib/cache-health.ts` and `shared/lib/public-health.ts`

Related extracted loaders:

- `worker/src/lib/status/derived-data.ts`
  - `getDatasetFreshness()`
  - `getTelegramBotStats()`
  - `getMintBurnReconciliation()`
  - empty fallback builders for dataset freshness / reserve composition
- `worker/src/lib/status/data-quality.ts`
  - canonical stablecoins-cache / blacklist-gap / active-depeg / on-chain-supply quality aggregation

### Auth and caching

- Requires a valid admin credential (`requireAdmin`)
- Response cache policy: `Cache-Control: no-store`

`computeRawStatus()` now performs the DB sentinel first and returns an explicit stale fallback snapshot when that sentinel fails, instead of throwing before the dashboard can show operator-visible degraded state.

### Cron health model

`CRON_INTERVALS` defines expected cadence per job (seconds). A cron is healthy when:

- A fresh non-stale `crons[*].inFlight` heartbeat exists for the job, or
- Last run exists within `2 * expectedIntervalSec`
- Last run status is `ok`, or
- Last run status is `degraded` (warning-only fallback mode), or
- Last run status is `skipped_neutral` (expected no-op) **and** the latest non-neutral required run in recent history is a fresh `ok`, or
- Last run status is `skipped_locked` **and** there is a fresh `ok` run in the same freshness window

Operational nuance: a fresh recovery attempt should not keep `/status` degraded purely because the most recent completed run failed. When a leased cron is actively running and its heartbeat is fresh, availability treats that lane as live again while still preserving the previous completed run in card history.

Scheduled-slot abandonment is surfaced separately from child job runtime failures. When a later trigger reconciles a stale `cron_slot_executions` row, `/api/status` can attach `crons[*].latestEvent` with `eventType = "scheduled-slot-abandoned"` to each child job in that slot; the marker includes the schedule key, slot owner, and abandoned child progress stage. Synthetic child rows with `metadata.reason = "stale-slot-reconciled"` remain in `recentRuns` for audit history, but the duration watchdog excludes them from runtime averages and reports slot abandonment as an infrastructure/runtime-instability signal instead. High-ratio abandonment remains metadata-visible for the full 7-day lookback, but it only keeps the watchdog degraded while at least one matching abandoned slot is less than 24 hours old.

Mint/burn public freshness now uses the same grace window before warning: `/api/mint-burn-flows` and `/flows` stay `fresh` through `2 * expectedIntervalSec` for the critical lane (`60m` at the current cadence), then degrade/stale afterward. `/api/status` now reuses that same public-health floor for availability once the critical lane has emitted real sync telemetry, so admin and public surfaces no longer drift on fresh-but-degraded mint/burn runs.

For the split DEX pipeline:

- `sync-dex-discovery` surfaces crawl-progress metadata (`coinsCrawled`, `poolsDiscovered`, `tierBreakdown`, `budgetExhausted`, `failedCoins`, `failedCoinErrors`) so operators can tell whether the staging crawl is still feeding the scorer and which source path failed per coin.
- `sync-dex-liquidity` `degraded` explicitly captures non-fatal upstream degradation (critical source-family failures or near-guard coverage drops), with machine-readable metadata (`failedSources`, `fallbackMode`, `sourceCoverage`, staged-pool merge counters, and staged skip-reason breakdowns for exact-identity vs unique-derived-identity dedup).
- `sync-mint-burn` is now the critical lane, while `sync-mint-burn-extended` drains long-tail backlog on its own offset schedule. The status surface tracks them independently so extended backlog pressure does not mask critical freshness.
- `crons[*].inFlight` exposes live `cron_run_progress` state (`stage`, `itemsDone`, `itemsTotal`, `message`, `updatedAt`, `stale`) for long-running leased jobs such as blacklist, mint/burn, DEX discovery, stablecoin price enrichment, and yield evaluation. The API suppresses orphaned progress rows once their matching lease is gone, so `running-stale` means "still leased but heartbeat stalled", not "some old progress row never got cleaned up". Suppressed rows and expired leases are available in `crons[*].staleArtifacts` for operator cleanup/readout.
- `summary.scheduledSlotRunning`, `summary.scheduledSlotStaleCandidates`, and `summary.scheduledSlotOldestRunningAgeSec` expose running scheduled-slot rows; `budgetOnlySurface*` summary counters separately report missing, stale, or error telemetry for budget-only side work.
- `sync-live-reserves` now emits structured metadata (`synced`, `failed`, `skipped`, `warningCount`, `coinsWithWarnings`, `coinsWithErrors`, `breakerKeys`) summarized in the cron card.
- `sync-redemption-backstops` keeps market-implied route impairments visible through `availabilityDegraded` metadata and impaired rows, but those expected row-level availability states do not by themselves mark the cron run degraded.

### Availability status

Computed from public cache impact, public mint/burn impact, circuit health, and availability-impacting cron availability. Blacklist gap health contributes to `/api/health` public status and the admin data-quality/status rollup, not directly to the availability floor.

- `stale` if any of:
  - any shared cache impact is `stale`
  - the public mint/burn lane is `stale`
  - any availability-critical cron has two or more consecutive failed runs
  - `availabilityImpactingUnhealthyCrons >= 2`
- `degraded` if any of:
  - any shared cache impact is `degraded`
  - the public mint/burn lane is `degraded` (once the lane has emitted real sync telemetry)
  - `openCircuitGroups >= 3`
  - any availability-critical cron has a single failed run
  - `availabilityImpactingUnhealthyCrons > 0`
- else `healthy`

`degraded` cron runs are counted separately in `summary.degradedCrons` and shown in the cron UI, but they do not by themselves mark availability degraded.

`openCircuitGroups` here means public-impact circuit groups only. Dynamic per-coin `live-reserves:*` breakers still render in the reliability tables, but they do not degrade availability on their own because reserve sync already has its own data-quality lane and thresholds.

Runbook links are intentionally sparse. `worker/src/lib/status/evaluation-causes.ts` attaches `runbookUrl` only for cause codes with maintained operator runbooks; public-impact causes such as `cache_ratio_*`, `cache_freshness_query_failed`, `mint_burn_public_*`, `open_circuit_groups`, `circuit_query_failed`, and `cron_error_runs` can appear without a Runbook link until a dedicated runbook is written.

Each cron definition now carries `statusImpact: "critical" | "watch"` in `shared/lib/cron-jobs.ts`. Only critical lanes can degrade `availabilityStatus`; watch-tier cron failures stay operator-visible through cron rows, info causes, `summary.watchUnhealthyCrons`, and `summary.cronErrors`.

FX source freshness is also cadence-aware now. `/api/health` and `/api/status` still expose `fx-rates.sourceStatus`, but intraday sources use age windows while ECB/secondary daily sources compare their published source date against the next expected business-day or calendar-day rollover. Business-daily ECB references now use the TARGET closing-day calendar as part of that rollover check, so Good Friday, Easter Monday, New Year's Day, Labour Day, Christmas Day, and Boxing Day do not produce false lag warnings. Realtime OXR / Chainlink overlays no longer erase a fresh daily fiat source date when they are only refining the current daily reference stack, and commodity pegs can now refresh from the fresh `stablecoins` cache when `gold-api.com` is unavailable from Workers, so the status surface does not fall into false intraday staleness during later provider outages. One-step daily lag stays operator-visible as `degraded`, while only `stale` FX sources are excluded from downstream price validation.

### Data quality status

Computed from missing prices + blacklist gaps + on-chain supply monitor, with best-effort query failures treated as diagnostics instead of automatic degradation:

- `stale` if any of:
  - stablecoins cache is unavailable/corrupt (`dataQuality.stablecoinsCacheStatus === "error"`)
  - `missingPriceRatio > 0.45`
  - `blacklistMissingRatio >= 0.02` (2%)
  - `blacklistRecentMissingAmounts >= 25` (last 24h)
  - `staleOnchainSupply >= 10`
  - `onchainSupplyDivergences >= 25`
  - `onchainStaleRatio >= 0.25` when `onchainSupplyTrackedCoins >= 10`
  - `onchainDivergenceRatio >= 0.25` when `onchainSupplyTrackedCoins >= 10`
  - `reserveComposition.status === "stale"`
- `degraded` if any of:
  - stablecoins cache is degraded but still usable (`dataQuality.stablecoinsCacheStatus === "degraded"`, currently legacy-array payloads only)
  - `missingPriceRatio > 0.18`
  - `blacklistRecentMissingAmounts >= 5` (last 24h)
  - `blacklistMissingRatio >= 0.01` (1%)
  - `onchainStaleRatio >= 0.1` when `onchainSupplyTrackedCoins >= 10`
  - `onchainDivergenceRatio >= 0.1` when `onchainSupplyTrackedCoins >= 10`
  - `reserveComposition.status === "degraded"`
- else `healthy`

#### Missing-price ratio bands (2026-04-13)

The `missingPriceRatio` thresholds were raised on 2026-04-13 to eliminate boundary flapping at the ~15% operating point. At the time of that change, the active set was 181 stablecoins with a baseline of ~26-27 persistently missing prices. The active set has since grown, so the status rule stays ratio-based rather than baking in a fixed active-count threshold. The pre-fix 15.00% degraded boundary produced 3+ visible `healthy↔degraded` transitions per day purely from counting noise.

| Band | Enter | Cause code | Severity | Drives `dataQualityStatus`? |
|---|---|---|---|---|
| elevated | ≥ 15% | `missing_prices_elevated` | info | no — advisory only |
| degraded | > 18% | `missing_prices_degraded` | warning | yes → `degraded` |
| stale    | > 45% | `missing_prices_stale`    | critical | yes → `stale`    |

The `missing_prices_elevated` info cause exists to preserve operator observability in the 15-18% band without forcing a visible status transition.

`dataQuality.sourceFailures` still records failed data-quality subqueries, but those failures now emit info-level causes and increment `summary.diagnosticIssueCount` instead of degrading `dataQualityStatus` on their own. Only the stablecoins cache remains a hard dependency in this path.

Mint/burn freshness classification (`computeMintBurnSyncFreshnessStatus` in `worker/src/lib/mint-burn-health-config.ts`) keys off the critical-lane sync age against a `60m` window (`2 * expectedIntervalSec`): `fresh` ≤ `60m`, `degraded` ≤ `90m` (1.5x), `stale` beyond — the same floor described under Availability status above. The file's `majorSymbols` default (`USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`) feeds backfill auto-select ordering; its `6h`/`24h` `MINT_BURN_STALE_WARN_SEC`/`MINT_BURN_STALE_CRIT_SEC` env defaults are not currently wired into the freshness bands.

The public `/api/health` lane now keys mint/burn freshness to the critical-lane sync timestamp / latest run status rather than raw event timestamps, matching the `/flows` semantics and avoiding quiet-period false stale alerts.

`dataQuality.onchainSupplyMonitoring === "unavailable"` renders in the quality cards and emits an info-level `onchain_monitor_unavailable` cause. This cause appears in the diagnostics watch list but does not affect health status.

`onchainSupplyTrackedCoins` now counts only stablecoins with at least one `onchain_supply` update inside the active monitoring window (`3d`). Older historical rows stay in D1 for audit/debug use, but they no longer count toward `staleOnchainSupply` or `onchainStaleRatio`.

Blacklist gap telemetry now also exposes operator diagnostics for historical recovery work:

- `blacklistOldestRecoverableAgeSec`
- `blacklistNeverAttemptedCount`
- `blacklistRepeatedFailureCount`

These fields do not currently change the health thresholds by themselves, but they make stranded historical gap cohorts visible in `/api/status`.

Ratio-based on-chain stale/degraded thresholds are also gated until the active monitor has at least `10` tracked coins. Below that floor, the admin still shows the live divergence/staleness counts, but those ratios are informational and do not by themselves escalate global status.

### Overall status

`rawOverallStatus` is the worse of `availabilityStatus` and `dataQualityStatus` (`healthy < degraded < stale`).

`overallStatus` is the **effective** status after hysteresis state-machine reconciliation:

- `healthy -> degraded`: requires 2 consecutive raw degraded checks
- `healthy -> stale`: immediate on raw stale
- `degraded -> stale`: requires 2 consecutive raw stale checks
- `degraded -> healthy`: requires 3 consecutive raw healthy checks (+ dwell)
- `stale -> degraded`: requires 2 consecutive raw degraded checks (+ stale dwell)
- `stale -> healthy`: requires 3 consecutive raw healthy checks (+ stale dwell)

Additional response fields:

- `confidence`: normalized status confidence (0.1–1.0)
- `causes`: structured trigger list (`availability`, `dataQuality`, `overall`)
- `state`: state-machine counters and thresholds
- `staleness`: freshness of status-system evaluations
- `probe`: latest synthetic probe aggregate
- `discrepancy`: divergence between effective status and synthetic probe status
- `timeline`: recent status transitions
- `telegramBot`: admin-only Telegram bot subscriber aggregates (`null` when Telegram tables are unavailable)
- `datasetFreshness`: last successful writer-evaluation timestamps for key operational domains (`stablecoins`, `blacklist`, `mintBurn`, `supply`, `safetyGrades`, `yield`, `depegs`, `dews`, `digest`, `discoveryCandidates`)
- `summary`: compact availability and diagnostics rollup (`unhealthyCrons`, `availabilityImpactingUnhealthyCrons`, `watchUnhealthyCrons`, `degradedCrons`, `cronErrors`, `availabilityImpactingCronErrors`, `availabilityImpactingConsecutiveCronErrors`, `staleCronArtifacts`, `expiredCronLeases`, `orphanedCronProgressRows`, `diagnosticIssueCount`, `worstCacheRatio`, `transitionsLast24h`)
- `producerHeads`: one row per canonical schedule/job/path/kind, including budget-only paths, with separate last invocation/completion, productive output, publication, invocation ID, Worker version, and observed/missing state
- `alertBroker`: active/pending/critical condition counts, oldest incident, bounded condition keys, failed deliveries, missing targets, and query health; the same summary contributes to public `/api/health` so shared facts classify consistently

### Cron error escalation

Availability escalation on cron errors follows a transient-vs-sustained split:

- A **single** transient failed run on an availability-critical cron (`sync-stablecoins`, `sync-fx-rates`, `sync-blacklist`, `sync-mint-burn`) surfaces as a `cron_error_runs` **warning** and sets `availabilityStatus` to `degraded`. This avoids flipping public state on rare upstream-caused single-sample flakes such as DefiLlama returning a truncated response body at the :30 slot.
- **Two or more consecutive** failed runs on the same critical cron escalate to `stale` via `summary.availabilityImpactingConsecutiveCronErrors > 0`.
- Multiple critical crons simultaneously unhealthy (`summary.availabilityImpactingUnhealthyCrons >= 2`) also escalate to `stale`.
- Cache-age stale (`worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale`) and the `publicAvailabilityFloor` (circuit outages, mint/burn sync stale) paths remain unchanged.
- `reserveComposition`: live reserve sync coverage summary (`configuredCoins`, `freshCoins`, `staleCoins`, `missingCoins`, `degradedCoins`, `errorCoins`, `corruptCoins`, `independentFreshEligible`, `independentFreshUnverified`, `staticValidatedFresh`, `weakProbeFresh`, `persistentlyStaleIndependentCoins`, `writeTimeoutUncertain`, `deferredCoins`, `runBudgetTruncated`, `deferredAt`, `nextCursorStablecoinId`, `cursorTailState`, `cursorTailError`, `cursorRecordedAt`, `cursorTailCompletedAt`, `cursorTailFailedAt`, `runBudgetTruncationCount`, `historyWriteGaps`, `lastSuccessAt`, `oldestFreshAgeSec`, `status`, `freshCoverageRatio`, `authoritativeFreshCoverageRatio`). Any persistent stale independent feed keeps the reserve composition status at least `degraded` even if aggregate fresh coverage remains high.
- `yieldHealth`: admin-only yield health summary sourced from existing cache rows and cron metadata (`yield-rankings`, `yield:supplemental-sources:v1`, `yield-coverage-audit`, and `sync-yield-data`). It reports ranking count/update age, previous-vs-current ranking-count delta, live-safety hydration coverage, supplemental cache age, benchmark age/fallback mode, coverage-audit age, source-risk field coverage, comparison-anchor freshness, latest cron status, a field-level status, status-impact class, and the yield runbook link.
- `publicationHealth`: admin-only read-only publication generation summary for surfaces with existing ledgers or cache/table-backed publication metadata. It reports `dex-liquidity`, `yield-rankings`, `stablecoins`, `dews`, `psi`, and `report-card-cache`; migrated `surface_publication_generations` rows win when present, and stablecoins/DEWS/PSI/report-card cache otherwise derive current published generations from their existing canonical cache/table artifacts without changing publisher behavior.
- `dependencyHealth`: admin-only derived dependency matrix built from existing `caches`, `crons`, and `publicationHealth` plus `shared/lib/data-dependency-registry.ts`. It groups degraded/stale downstream symptoms under the most likely stale upstream dependency (for example DEX liquidity -> DEWS/report-card/redemption symptoms) without changing `availabilityStatus`, `dataQualityStatus`, or publication behavior.
- `canaries`: admin-only latest structural canary results from `worker_canary_runs`, written by `data-invariant-canary` when `WORKER_CANARY_MODE` is enabled. It covers DEX publication/current-row invariants, stablecoins-cache active coverage, PSI/DEWS latest samples, and report-card cache generation/methodology freshness without changing producer behavior.
- `coingeckoPriceDiff`: admin-only live CoinGecko comparison summary for active tracked assets with `geckoId`, including the compare count, mismatch count, threshold, and the flagged rows where the Pharos reported price is more than 5% away from CoinGecko spot
- `d1Usage`: admin-only live D1 database telemetry (`databaseSizeBytes`, `numTables`, `readReplicationMode`, `readQueries24h`, `writeQueries24h`, `rowsRead24h`, `rowsWritten24h`) plus an additive `capacity` assessment with 60/75/90% state, 30-day growth, next-threshold, and exhaustion forecasts, sourced from Cloudflare's D1 control-plane and analytics APIs when the dedicated worker bindings are configured
- `reserveDrift`: optional array of coins where the independent live-derived collateral quality score diverges from curated by more than 15 points (`coinId`, `liveCollateralScore`, `curatedCollateralScore`, `delta`), sorted by delta descending. Omitted when no drift exceeds the threshold.
- `classificationWarnings`: optional array of decentralized-governance coins where centralized custody fraction exceeds 50% (`coinId`, `governance`, `centralizedCustodyPct`, `threshold`). Signals potential governance reclassification candidates. Omitted when no warnings.

For event-backed domains, `datasetFreshness` follows the writer rather than the latest emitted event so quiet periods do not look falsely late:

- `blacklist`: last successful `sync-blacklist` run, not `MAX(blacklist_events.timestamp)`
- `mintBurn`: last successful critical/extended mint-burn writer run, not `MAX(mint_burn_events.timestamp)`
- `depegs`: last successful `sync-stablecoins` run, not `MAX(depeg_events.started_at)`
- `discoveryCandidates`: last successful coverage writer run, not `MAX(discovery_candidates.last_seen)`

`dataQuality` now also exposes:

- `stablecoinsCacheStatus`: `ok | degraded | error`
- `stablecoinsCacheReason`: machine-readable reason when the stablecoins cache is unavailable or transitional
- `blacklistGapStatus`: `ok | failed`
- `activeDepegStatus`: `ok | failed`
- `onchainSupplyQueryStatus`: `ok | failed | unavailable`
- `repairDebt`: structured repair/backfill backlog summary (`status`, `openCount`, `oldestAgeSec`, `byKind`, `availabilityEscalated`, `nextRunnerDueAt`, `source`). It prefers `worker_repair_tasks` aggregates and falls back to `cache["ddr:repair-debt:v1"]` during the DDR dual-write rollout.
- `ddrRepairDebtStatus` / `ddrRepairDebtCount` / `ddrRepairDebtEvents`: backward-compatible DDR-specific repair-debt fields sourced from the existing cache marker until the repair-task table has been observed for a full rollout cycle.
- `sourceFailures`: list of failed best-effort subqueries with machine-readable source keys and error messages

This prevents `/status` from silently treating a broken stablecoins cache as `0 / 0` healthy price coverage.

When one of those best-effort subqueries fails, `/api/status` keeps unaffected status lanes healthy, records the issue under `sourceFailures` / `sectionErrors`, increments `summary.diagnosticIssueCount`, and renders the affected card as diagnostic amber instead of silently showing a misleading `0`.

Cache freshness for `dex-liquidity`, `yield-data`, and `dews` now prefers producer-owned `cache` sentinels (`freshness:*`) instead of live `MAX(...)` scans over the hot publish tables. If the sentinel is missing during rollout, `/api/status` falls back to the legacy table query; if the lookup itself fails, it can still fall back to the latest successful producer cron timestamp and adds a `cache_freshness_query_failed` info cause instead of auto-promoting the lane to public `stale`.

The public `/api/health` companion endpoint now returns a `warnings` array for these best-effort failures, and the status page model treats that as additional public-health context instead of assuming zero-like data is real.

### Live reserve sync health

`reserveComposition` is derived from:

- coins with `liveReservesConfig`
- `reserve_composition`
- `reserve_sync_state`

Behavior:

- bootstrap is suppressed until the first successful live reserve sync exists
- only matched `reserve_composition` + `reserve_sync_state.last_success_at` pairs count as live snapshots; orphaned or split-write rows are treated as missing
- coins currently failing before their first successful snapshot count as `errorCoins`, not `missingCoins`
- after bootstrap, reserve health is coverage-based:
  - `status: "stale"` when `freshCoins === 0`
  - `status: "degraded"` when `freshCoverageRatio < 0.75`, `authoritativeFreshCoverageRatio < 0.5`, any independent feed is persistently stale, any write is uncertain, the cursor tail is incomplete, the deferred tail is high-share, or run-budget truncation repeats
  - `status: "healthy"` otherwise
- low raw counts of degraded/missing reserve feeds no longer degrade `dataQualityStatus` on their own if coverage remains above those thresholds
- the page renders a dedicated `Live Reserve Sync` card in the pipeline lane
- the card also breaks fresh clean snapshots into evidence-quality cohorts: `independentFreshEligible`, `independentFreshUnverified`, `staticValidatedFresh`, and `weakProbeFresh`
- `persistentlyStaleIndependentCoins` lists independent feeds older than the persistent-stale threshold and keeps the reserve sync card/action cause degraded until the source recovers
- `writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path, meaning ops should treat the authoritative state as ambiguous until the next clean run
- `runBudgetTruncated`, `deferredCoins`, `deferredAt`, and `nextCursorStablecoinId` expose whether the latest live-reserve run stopped at its internal budget and where the next run will resume
- `cursorTailState`, `cursorTailError`, `cursorRecordedAt`, `cursorTailCompletedAt`, `cursorTailFailedAt`, and `runBudgetTruncationCount` expose deferred-tail partial write state and repeated truncation pressure
- `historyWriteGaps` lists authoritative current snapshots whose matching composition-history or attempt-history row is missing
- Data-quality causes now include `reserve_sync_budget_truncated`, `reserve_sync_tail_incomplete`, `reserve_sync_write_uncertain`, and `reserve_sync_history_write_gap`; one-off low-share truncation is warning-level observability, while repeated/high-share truncation and uncertain writes can degrade reserve health before freshness collapses

### Yield health summary

`yieldHealth` is exposed on the admin `/api/status` payload and rendered by `YieldHealthCard` in the Pipeline lane. It does not read live upstreams and does not change yield scoring, source arbitration, methodology, or `/yield/` route behavior.

| Field | Source | Threshold | Failure mode | Status impact | Runbook |
| --- | --- | --- | --- | --- | --- |
| `rankingCount`, `rankingUpdatedAt`, `rankingAgeSec`, `rankingStatus` | `cache["yield-rankings"]` payload + row `updated_at` | hourly producer; `>8x` degraded, `>12x` stale | missing/malformed rankings become `stale` | public-critical when stale/missing because public yield reads depend on it | `docs/runbooks/yield-health.md` |
| `safetyCoverage` | `yield-rankings.provenance.safetySnapshot` | degraded below `0.75` coverage | missing provenance is `unknown` | admin-watch only; sparse safety hydration does not change public status by itself | `docs/runbooks/yield-health.md` |
| `supplemental` | aggregate `cache["yield:supplemental-sources:v1"]` plus per-family `cache["yield:supplemental-sources:v1:*"]` rows | degraded above 6h per family | missing per-family rows increment `missingFamilyCount`; stale supplemental coverage only reduces optional source breadth | admin-watch unless a future PR explicitly promotes a source family to critical | `docs/runbooks/yield-health.md` |
| `benchmark` | `yield-rankings.provenance.benchmark` | degraded above 48h or whenever fallback mode is active | missing provenance is `unknown`; retained fallback is degraded, stale retained fallback is stale | admin-watch; benchmark fallback is already visible in yield provenance and cron status | `docs/runbooks/yield-health.md` |
| `coverageAudit` | `cache["yield-coverage-audit"].updated_at` | degraded above 45d | missing cache is `unknown` | admin-watch; monthly audit gaps do not affect public yield availability | `docs/runbooks/yield-health.md` |
| `sourceRiskCoverage` | selected and retained alternate `sourceRisk.*` rows in `cache["yield-rankings"]` | degraded when any core field is below `0.75` coverage: `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, or `sourceRiskScore` | missing `venueRiskTier` and `venueRiskTier="unknown"` count as missing evidence, not high risk; no separate stale tier | admin-watch; neutral-fallback evidence gaps do not make public rankings stale | `docs/runbooks/yield-health.md` |
| `comparisonAnchorFreshness` | `crons["sync-yield-data"].lastRun.metadata.sourceCoverage.comparisonAnchorFreshness` | degraded when `staleAnchorCount > 0` | missing sync metadata is `unknown`; stale examples are bounded and may be truncated | admin-watch; does not change source arbitration, scoring, or publication eligibility | `docs/runbooks/yield-health.md` |
| `latestCronStatus`, `latestCronStartedAt` | `crons["sync-yield-data"].lastRun` | existing cron health rules | absent cron metadata is `null` | inherited from cron health; no separate escalation | `docs/runbooks/yield-health.md` |

### Telegram bot metrics

The `/status` payload now includes a `telegramBot` block derived from:

- `telegram_subscribers`
- `telegram_subscriptions`
- `telegram_pending_disambiguation`
- `telegram_pending_alerts`

The UI uses that block plus `crons["dispatch-telegram-alerts"].lastRun.metadata` to show:

- total known chats
- alert-enabled and alert-ready chats (including global all-stablecoin follows)
- total coin follows and average follows per subscribed chat
- pending disambiguation replies
- pending delivery backlog
- alert-type adoption counts
- custom-preference adoption and quiet-hours adoption
- muted / misconfigured chat counts
- top subscribed stablecoins
- live safety-alert source state (`ok`, `missing`, `corrupt`, `stale`, `wrong-generation`)
- whether safety alerts are currently suppressed while DEWS/depeg/launch fan-out continues
- latest dispatch delivery stats (`subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`, `freshRetryQueued`, `freshPermanentFailures`, `pendingRetryQueued`, `pendingDropped`)

### Synthetic self-check

The isolated `9,24,39,54 * * * *` status lane runs `cron-slot-sweeper` before `status-self-check`. The sweeper closes stale `cron_slot_executions` across all slot keys, clears expired child leases/progress rows, writes `scheduled-slot-abandoned` event markers, and inserts synthetic child `cron_runs` error rows when an expired child lease had no terminal run row. It also sends a cooldown-gated alert when abandoned slots are reconciled, so a stopped heartbeat is visible before the next same schedule key fires.

`status-self-check` then:

1. Probes critical public reads and selected admin read endpoints in two explicit planes:
   - internal self-check probes use router-dispatched `GET` requests when a Worker `ExecutionContext` is available. They exercise handler routing and dependency hydration for app/router isolation, but bypass the Worker HTTP access gate, public rate-limit gate, custom-domain routing, and edge-cache path. If the cron is invoked without `ExecutionContext`, the same self-check set falls back to real HTTPS probes against `SELF_URL`.
   - external production probes always use real HTTPS `fetch()` calls through the production custom domains with a 10s timeout per endpoint: `https://api.pharos.watch/api/health`, `https://site-api.pharos.watch/api/health` when `SITE_API_SHARED_SECRET` is configured, a `site-api.pharos.watch` access-gate probe expecting `401` or `403` when that shared secret is absent, and `https://ops-api.pharos.watch/api/status-history?limit=1`.
   - the ops API canary expects Cloudflare Access/admin gating to block the unauthenticated request (`302` or `403`); a successful open response is treated as `ops-api-access-gate-open-or-unreachable`.
   - internal-router timings reflect uncached worker handler execution, not browser-visible edge-cache latency. External timings reflect the production edge path.
   - `/api/health` is parsed semantically: a `200` response with body `status: degraded|stale` downgrades the synthetic probe instead of counting as healthy-on-transport. `/api/status` is not probed by this synthetic endpoint loop; it is evaluated separately through `evaluateStatusAndPersist()`.
   - cache-backed bootstrap probes (`/api/usds-status`, `/api/bluechip-ratings`, `/api/yield-rankings`) are treated as bootstrap misses rather than hard failures only while their producing cron has never recorded a run
2. Persists probe aggregate to `status_probe_runs`.
3. Reconciles raw status into persisted effective state.
4. Tracks divergence streak and probe-failure streak in `status_discrepancy_state`.
5. Sends alert on sustained divergence and independently alerts on sustained probe failures (3+ consecutive failing checks). Alert bodies include the internal/external comparison so operators can separate app/router regressions from custom-domain, Access, routing, cache, and edge-path regressions.

The cron metadata now includes:

- `probeMode` / `probeBaseUrl`
- `probePlanes.internal` / `probePlanes.external`, each with status, counts, p95 latency, and observed origins
- `internalExternalDiscrepancy`, with `reason` values such as `in-sync`, `external-worse`, and `internal-worse`
- Bootstrap misses are persisted in `status_probe_runs.details.bootstrapMisses`; they are not returned as a top-level cron metadata field.
- `freshnessDiagnostics` when raw status had to fall back from a freshness sentinel to table or cron evidence
- `latencySummary` (`minMs`, `medianMs`, `p95Ms`, `maxMs`)
- `slowestProbes` (top slow endpoints for the run)

`GET /api/status` returns the latest persisted aggregate in `probe`. New rows include optional `probe.internal`, `probe.external`, and `probe.internalExternalDiscrepancy` fields read from `status_probe_runs.details_json`; legacy rows omit those optional fields.

`status_discrepancy_state` persists both divergence and probe-failure alert state:
`consecutive_divergent`, `last_divergent_at`, `last_alert_at`,
`consecutive_probe_failures`, `last_probe_failure_at`, and `last_probe_alert_at`.

### History endpoint (`GET /api/status-history`)

Admin machine-readable timeline endpoint for internal tooling and incident audits.

Response includes:

1. persisted state snapshot
2. status-system staleness
3. latest probe aggregate
4. discrepancy summary
5. transition list (`limit` query param, max 200)
6. `hasMore` completeness evidence (`true` when another matching row exists, `false` for a complete matching window, and `null` when completeness could not be determined)

The incident-history workspace only makes negative deployment-correlation statements for a fresh response with `hasMore === false`. Row-limited, retained, fallback, and indeterminate results remain visibly partial and keep correlation Unknown.

---

## Endpoint Probing

Source: `src/hooks/use-endpoint-probes.ts`

- Probe timeout: 5s for public endpoints and 20s for browser admin probes. The Pages ops proxy upstream budget is 20s for `/api/status` and `/api/status-history`, 45s for `/api/audit-depeg-history`, and the default 10s for all other admin proxy paths (which can return `504` once that 10s upstream timeout elapses).
- Bounded browser probing uses a worker pool capped at 6 concurrent requests (`ENDPOINT_PROBE_CONCURRENCY`), with `Promise.all` only coordinating those workers rather than fanning out every endpoint at once.
- Admin probe paths are now same-origin `/api/admin/*` calls on the ops host
- The dashboard labels these as **browser-origin probes** to distinguish them from the worker-origin `status-self-check` synthetic probe stored in `/api/status`
- Parameterized routes should probe `probePath` values from registry (for example `/api/mint-burn-events?stablecoin=usdt-tether`) to avoid expected `400` validation responses. `GET /api/status-probe-history` uses `/api/status-probe-history?path=%2Fapi%2Fhealth` as its stable admin canary so the browser probe loop validates the route without hitting the endpoint's required-query guard.
- The stablecoin-detail probe also uses a curated canary `probePath` rather than the heaviest history payload, so route-health checks are less sensitive to oversized per-coin datasets.
- Routes without a stable canary URL are intentionally excluded from automatic probe coverage. `GET /api/digest-snapshot` is omitted because it requires a valid `date` that must map to a real stored digest; dated public snapshot detail routes are omitted because valid dates come from `GET /api/snapshots/index`.
- Returned result shape: `{ path, status, latencyMs, error? }`

### Parameterized Endpoint Probes

Three public dynamic route registrations in `shared/lib/api-endpoints/` keep parameterized `path` values for documentation and use explicit `probePath` canaries for status checks:

| Endpoint Key                 | Registered Path                          | Probe Path                     | Rationale                                                |
| ---------------------------- | ---------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| `stablecoin-detail`   | `/api/stablecoin/:id`            | `/api/stablecoin/pyusd-paypal` | Lighter payload than USDT avoids timeout false negatives |
| `stablecoin-summary`  | `/api/stablecoin-summary/:id`    | `/api/stablecoin-summary/usdt-tether` | Snapshot route health check                              |
| `stablecoin-reserves` | `/api/stablecoin-reserves/:id` | `/api/stablecoin-reserves/iusd-infinifi` | Live reserves route health check                         |

Handler bindings remain the dynamic descriptors in `worker/src/routes/dynamic-routes.ts`; status probes substitute the `probePath` before dispatch.

These are **not part of the public API contract**. Canary IDs may change without notice if the underlying coins are removed from tracking. External integrators should use the parameterized routes documented in the API reference.

Manual actions are rendered from `getStatusPageActions()` and executed only on user confirmation.

---

## Guarded Admin Actions

Status-page manual actions are router-dispatched from shared endpoint metadata (`shared/lib/api-endpoints/`):

- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `GET /api/debug-sync-state`
- `POST /api/remediate-blacklist-amount-gaps`
- `POST /api/backfill-blacklist-current-balances`
- `POST /api/backfill-depegs`
- `POST /api/backfill-supply-history`
- `POST /api/backfill-cg-prices`
- `POST /api/backfill-yield-history`
- `POST /api/backfill-stability-index`
- `POST /api/backfill-mint-burn-prices`
- `POST /api/backfill-mint-burn`
- `POST /api/backfill-tape`
- `POST /api/reclassify-atomic-roundtrips`
- `GET /api/audit-depeg-history?dry-run=true`
- `GET /api/backfill-dews`

The UI uses these actions in two ways:

- a searchable intent/risk catalog in the `Actions` workspace
- contextual recommendations derived from blocking causes and availability-impacting cron lanes (`Recommended now`)

The catalog groups inspect, dry-run, recovery, communication, and destructive behavior. Shared endpoint metadata is canonical for risk, scope, prerequisites, expected duration, dry-run support, result mode, and audit ownership. One provider-owned execution dialog handles confirmation, readiness, direct dry run, structured results, raw debugging output, and focus restoration.

Mutations use one stable `Idempotency-Key` per operator intent. Double submission coalesces, known replay reuses the same result, and an uncertain response keeps the same key available for a safe retry; starting a genuinely new intent creates a new key. The proxy preserves `Idempotency-Key`, `X-Idempotent-Replay`, and `X-Execution-Certainty`, so the browser can distinguish confirmed, replayed, and unknown outcomes.

Every router-dispatched status-page action is written to `admin_action_audit_log`, including validation failures, handler errors, execution-unknown responses, and idempotent replay. The catalog audit wrapper stores allowlisted metadata only and hashes the idempotency identity; it never stores authorization, tokens, raw request bodies, or raw responses. Migration `0186_admin_action_audit_intent_key.sql` adds the nullable intent identity and a partial unique constraint on `(action, intent_key)` so replay backfills missing audit rows without duplicating authoritative executions.

Any handler response at HTTP 5xx after idempotent execution has started is converted to durable `execution_unknown`; the same key replays that unknown state and never runs the effect again. If the action result exists but its canonical audit write fails, the router returns `503 audit_persistence_failed` with the same idempotency metadata. Retrying that key replays the stored result and attempts to backfill the audit row without repeating the action.

`GET /api/admin-action-log?limit=100` feeds persistent execution history. The Actions and History workspaces reconcile it with current-session state, but session-only results remain explicitly labeled until the deployed backend can return their durable row.

`POST /api/backfill-mint-burn` is operator-safe from the status page even without an explicit `configKey`: the worker auto-selects the most behind tracked mint/burn config with a critical-first / major-symbol-first policy and returns the selected config in the response payload.

Mutating admin paths are protected by method guardrails:

- `GET` on mutating admin path -> `405` with `Allow: POST`
- missing or invalid action targets fail validation before handler dispatch
- uncertain execution returns `X-Execution-Certainty: unknown` and remains retryable with the same intent key

---

## Coverage Discovery Card

**Component:** `DiscoveryCandidatesCard` (`src/components/status/discovery-candidates.tsx`)

Renders in the Admin Pipeline `Discovery` tab. Shows stablecoins tracked by CoinGecko or DefiLlama that Pharos does not yet monitor. Each row displays symbol, name, a source badge (`CG` / `DL` / `Both`), market cap, days seen, and a dismiss button. Admin auth is required for the dismiss action (`POST /api/discovery-candidates/:id/dismiss`). The card is fed by `GET /api/status` via its embedded `discoveryCandidates` supplement, which reads active candidates directly from D1; `GET /api/discovery-candidates` remains available as a direct admin endpoint for focused candidate inspection.

## Price Source Health Card

**Component:** `PriceSourceHealthCard` (`src/components/status/price-source-health.tsx`)

Renders in the Admin Pipeline `Markets` tab next to `LiquidityHealthCard` and the CoinGecko drift watchlist. Shows the current price confidence distribution across all tracked stablecoins:

- **Confidence tiles** — colored metric tiles for `High`, `Single-source`, `Low`, `Fallback`, and `Missing` counts
- **Source breakdown line** — which price sources contributed to the current sync, including protocol redemption quotes when they override thin market pricing
- **Source-depth distribution** — backend-only status metadata keyed by active canonical `consensusSources.length` buckets (`0`, `1`, `2`, `3`, `4`, `5+`)
- **Missing tile** — count of assets whose current price source is `missing`
- **Last sync age** — how old the price-health snapshot is

Distribution and confidence data is sourced from `sync-stablecoins` cron metadata stored in the most recent `cron_runs` row. The source-depth distribution is added by the status supplement from the cached stablecoins payload so it reflects active canonical assets without changing the pricing cron metadata contract.

## CoinGecko Price Drift Card

**Component:** `CoinGeckoPriceDiffCard` (`src/components/status/coingecko-price-diff.tsx`)

Renders in the Admin Pipeline `Markets` tab after the price-source and liquidity health cards. It shows tracked assets that:

- have a configured `geckoId`
- still have a current comparable Pharos price in the cached stablecoins payload
- differ from live CoinGecko spot by more than `5%`

Each row displays:

- stablecoin symbol and name
- Pharos reported price
- CoinGecko spot price
- current Pharos price source and confidence tag
- absolute percentage difference badge

Data is sourced from the admin-only `GET /api/status` payload. The worker supplement filters the cached stablecoin payload down to the active tracked assets with `geckoId`, batches a CoinGecko `simple/price` fetch, compares the current prices, and sorts flagged rows by `diffPct` descending. When the CoinGecko lookup fails, the card degrades to `null` and the worker records `sectionErrors.coingeckoPriceDiff`.

## D1 Usage Card

**Component:** `D1UsageCard` (`src/components/status/d1-usage-card.tsx`)

Renders in the Admin Pipeline `Storage` tab beside pipeline freshness. It shows:

- current D1 database size
- current utilization state against the 10 GB ceiling
- next-threshold and exhaustion forecast when at least three samples span 24 hours
- table count
- read-replication mode and region
- trailing 24-hour read/write query counts
- trailing 24-hour rows-read/rows-written counts

Data is sourced from the admin-only `GET /api/status` payload. The worker supplement uses the same Cloudflare D1 info + analytics calls that `wrangler d1 info` uses: a D1 control-plane fetch for database metadata plus a GraphQL `d1AnalyticsAdaptiveGroups` query over the trailing 24 hours. The scheduled status self-check records at most one capacity sample per UTC hour and routes threshold transitions through the durable alert broker. The field stays `null` until `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_STATUS_API_TOKEN`, and `CLOUDFLARE_D1_DATABASE_ID` are configured on the worker. Loader/config failures are surfaced through `sectionErrors.d1Usage`.

## Mint/Burn Reconciliation Card

**Component:** `MintBurnReconciliationCard` (`src/components/status/mint-burn-reconciliation.tsx`)

Renders after the Liquidity Health section. It compares:

- 24h configured canonical issuance-chain mint/burn net flow from `mint_burn_hourly`
- 24h matching chain-supply delta from the cached stablecoins payload's `chainCirculating[canonicalChainId].current - circulatingPrevDay`

Each row shows:

- stablecoin symbol
- reconciliation status (`ok`, `warn`, `critical`, `insufficient-source`)
- coverage hint (`full`, `partial-history`, `bootstrapping`, or `unknown`)
- absolute USD difference
- raw flow net, raw chain delta, and ratio

Severity thresholds are defined in `shared/lib/status-thresholds.ts` (`STATUS_RECONCILIATION_THRESHOLDS`): critical at ≥$100M absolute or ≥30% ratio, warn at ≥$25M or ≥12%.

This is an operator integrity signal, not a public user-facing score. Large gaps typically mean one of:

- flow coverage is still partial or newly bootstrapping
- upstream chain distribution moved in a way the mint/burn tracker does not capture
- ingestion or classification logic needs review

---

## Operator Workspace Rollout (2026-07-10)

- Replaced the single long operator page with eight stable route workspaces and private ops-only chrome.
- Separated service state, evidence quality, and intervention need so a healthy availability verdict cannot hide missing or stale evidence.
- Added focused Pipeline, Reliability, Cron, Actions, Comms, History, and API-key workbenches with URL-backed modes and bounded mounting.
- Made catalog actions and credential lifecycle mutations replay-safe, surfaced execution certainty through the proxy, and unified durable action/credential activity in History.
- Added sanitized authenticated browser fixtures across 320, 390, 768, 1024, and 1440 px plus axe, 200% text reflow, light/dark, forced-colors, and reduced-motion coverage.

## Rendering and Refresh Model (2026-07-11)

- No workspace owns a free-running root clock. The Triage/Actions model hook re-anchors when query evidence refreshes and wakes again only at the per-query staleness boundary, so wall-clock time cannot rebuild the dashboard model between those events. Relative-time labels tick inside `FreshnessIndicator` leaves.
- Collapsed `<details>` disclosures mount their content only while open (`src/components/status/lazy-details.tsx`): healthy endpoint-probe, cache-freshness, and circuit-breaker tables, budget-only surface evidence rows, and the Triage diagnostics panel keep no hidden subtree in the DOM when closed.
- Triage auto-expansion is evaluated once, during the first render that carries definite evidence, so the primary shell paints in its final layout. Late-arriving issues badge the collapsed diagnostics summary; they never force a section open or move the operator mid-task.
- Refetches keep the last successful payload visible; `WorkspaceStatusBoundary` shows a background-failure notice instead of blanking the workspace.
- Default Triage render budgets are guarded by `src/app/admin/__tests__/triage-budgets.test.tsx`: under 60 interactive main-area controls and under 100 table body rows on the initial healthy render, with the diagnostics disclosure closed and unmounted.
- Display-font assets: an earlier ops-host review observed 404s for the licensed `ABCWhyteInktrap-Regular.woff2` / `ABCWhyteInktrap-Bold.woff2` files. Clean builds intentionally standardize on the tracked Bricolage Grotesque display face and emit no references to the licensed Whyte files (they are gitignored and staged only via `npm run install:whyte-fonts`), so the ops origin no longer issues those requests. The ops chrome uses the same tracked font stack as the public host.

---

## Related Files

| File                                                 | Role                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/status/client.tsx`                          | Public read-only system health board backed by `/api/health` plus public browser probes                                                                                                                                                                                                |
| `src/app/admin/layout.tsx`                           | Ops-host-only layout that composes `OpsShell` with the shared action execution provider                                                                                                                                                                                                  |
| `src/components/ops-shell.tsx`                       | Private header, workspace navigation, theme/public-status controls, sign-out, host gate, and skip target                                                                                                                                                                                  |
| `src/lib/admin-workspaces.ts`                        | Stable route registry and legacy hash-to-workspace mapping                                                                                                                                                                                                                                |
| `src/app/admin/*/client.tsx`                         | Route-owned polling and focused Pipeline, Reliability, Cron, Actions, Comms, and History workbenches                                                                                                                                                                                       |
| `src/app/admin-api/client.tsx`                       | Private searchable, filterable, paginated API-key inventory and lifecycle workbench                                                                                                                                                                                                       |
| `functions/admin/[[path]].ts`                        | Pages Functions host gate for `/admin/`; returns `404` outside `ops.pharos.watch`, otherwise serves the static admin route asset                                                                                                                                                       |
| `src/components/status/*`                            | Decomposed status UI modules (banner, facts, diagnostics, probe grid, admin actions, API keys, Telegram telemetry, cards, and tables). Admin cron rows are grouped by trigger slot, show trigger/isolation metadata, and keep verbose run metadata behind a selected-row detail panel. |
| `src/components/status/telegram-bot-stats.tsx`       | Telegram delivery operations, backlog policy, retry/failure evidence, per-alert results, and separately grouped audience coverage                                                                                                                                                         |
| `src/components/status/discovery-candidates.tsx`     | Discovery candidates card — untracked stablecoin list with dismiss actions                                                                                                                                                                                                             |
| `src/components/status/price-source-health.tsx`      | Price source health card — confidence distribution, source breakdown, divergences                                                                                                                                                                                                      |
| `src/components/status/yield-health.tsx`             | Yield health card — rankings count/freshness/delta, safety hydration coverage, supplemental cache age, benchmark fallback/age, coverage-audit age/queue, and runbook link                                                                                                               |
| `src/components/status/mint-burn-reconciliation.tsx` | Mint/burn reconciliation card — 24h canonical-chain flow vs chain-supply delta diagnostics                                                                                                                                                                                             |
| `src/lib/status/public-status.ts`                    | Public impacted-surface derivation that maps `/api/health` status causes to affected public pages and APIs                                                                                                                                                                             |
| `worker/src/api/status-supplements.ts`               | Admin `/api/status` supplement loader for liquidity health, yield health, price-source diagnostics, GT probe state, D1 usage, and CoinGecko drift data                                                                                                                                  |
| `src/hooks/use-status.ts`                            | Shared polling policy for `/api/status` (`staleTime=60s`, `refetchInterval=120s`) through the ops-host same-origin proxy                                                                                                                                                               |
| `src/hooks/api-hooks.ts`                             | Shared read hooks consumed by the dashboard model (`useHealth`, `usePegSummary`, `useDexLiquidity`, `useReportCards`, `useYieldRankings`)                                                                                                                                              |
| `src/hooks/use-endpoint-probes.ts`                   | Shared polling policy for endpoint probes (`staleTime=60s`, `refetchInterval=120s`); admin probes switch to same-origin proxy mode on the ops host                                                                                                                                     |
| `src/hooks/use-status-history.ts`                    | Shared polling policy for `/api/status-history` + dashboard time-window filters through the ops-host same-origin proxy                                                                                                                                                                 |
| `functions/api/admin/[[path]].ts`                    | Pages Functions admin proxy: ops-host gating, upstream method/path allowlisting, and service-token forwarding to `ops-api.pharos.watch`                                                                                                                                                |
| `shared/lib/status-thresholds.ts`                    | Single source of truth for all status thresholds (cache ratios, missing prices, blacklist gaps, on-chain supply, price confidence bands, yield health, reconciliation, discovery mcap) — imported by both worker and frontend                                                          |
| `shared/lib/cron-jobs.ts`                            | Shared cron expressions, display grouping, trigger isolation metadata, and per-job intervals used by both frontend and worker                                                                                                                                                          |
| `shared/lib/api-endpoints/`                        | Shared endpoint contract metadata: paths, probe groups, method/cache flags, status-page actions                                                                                                                                                                                        |
| `worker/src/routes/registry.ts`                      | Single worker-side static route definition list keyed by shared endpoint metadata                                                                                                                                                                                                      |
| `worker/src/router.ts`                               | Route dispatcher: static registry lookup plus dynamic stablecoin/discovery/OG matching                                                                                                                                                                                                 |
| `worker/src/api/status.ts`                           | Raw status synthesis + effective state response                                                                                                                                                                                                                                        |
| `worker/src/api/status-history.ts`                   | Machine-readable status timeline/history endpoint                                                                                                                                                                                                                                      |
| `worker/src/api/health.ts`                           | Public health endpoint for cache/circuit observability                                                                                                                                                                                                                                 |
| `worker/src/lib/status-reliability.ts`               | Stable facade exporting the status reliability layer used by API/cron callers                                                                                                                                                                                                           |
| `worker/src/lib/status/yield-health.ts`              | Yield health summary loader; reads existing yield cache rows and cron metadata only                                                                                                                                                                                                     |
| `worker/src/lib/status-state-store.ts`               | Hysteresis state persistence, snapshots, and transition history                                                                                                                                                                                                                         |
| `worker/src/lib/status-probe-store.ts`               | Probe-run persistence and latest-probe loading                                                                                                                                                                                                                                          |
| `worker/src/lib/status-discrepancy-store.ts`         | Divergence/probe-failure streak persistence and alert timestamps                                                                                                                                                                                                                        |
| `worker/src/lib/status-discrepancy-view.ts`          | Derived discrepancy view-model assembly                                                                                                                                                                                                                                                 |
| `worker/src/cron/status-self-check.ts`               | Real-HTTP self-probe + divergence/probe-failure alert cron                                                                                                                                                                                                                             |
