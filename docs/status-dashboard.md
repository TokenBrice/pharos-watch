# Status Dashboard

Operational reference for the split status surfaces: public `/status/` read-only health monitoring and Access-gated route-based operator workspaces under `/admin/` and `/admin-api/`, including backend status computation, hysteresis, discrepancy detection, endpoint probing, guarded actions, credential operations, and durable audit history.

> **Agent navigation** — Grep the heading you need: Scope · Frontend Flow · Backend Contract (`GET /api/status`) · Endpoint Probing · Guarded Admin Actions · Price Source Health Card · CoinGecko Price Drift Card · D1 Usage Card · Mint/Burn Reconciliation Card · Rendering And Refresh Contract · Source Owners.

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
- The public health payload is the status self-check's 15-minute snapshot projection; `/api/health` performs a live assessment only when the snapshot is missing or unusable. Operator-only Telegram lifecycle diagnostics live on `/api/status`.
- `/admin/`: Triage workspace
- `/admin/pipeline/`: data-quality, market, reserve, yield, storage, and integrity workbench
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
- Ops host gates: `functions/admin/[[path]].ts` and `functions/admin-api/[[path]].ts`, both using `functions/lib/ops-asset-host-gate.ts`
- Ops proxy route: `functions/api/admin/[[path]].ts`
- Pure derived-data helpers: `src/lib/status-dashboard-model.ts`
- Decomposed UI components: `src/components/status/*`
- The shared `OpsShell` owns compact private chrome, route navigation, theme, public-status, and sign-out controls. It does not mount the public event tape, public navigation, feedback control, or public footer.
- The `/admin/` Triage workspace provides the command-center top fold:
  - a compact triage header with the three independent verdict axes (`Service`, `Evidence`, and `Intervention`), recovery-hold context, `FreshnessIndicator`, and a direct refresh control
  - impacting, warning, maintenance, watch, cron-error, public-health, and reserve-drift summary badges
  - deduplicated blockers and a `Needs attention` queue ordered lexicographically by severity, public impact, evidence risk, persistence, count, and stable workspace order; recommended actions stay attached to their causal lane instead of adding a duplicate Actions entry
  - a state-machine / probe / discrepancy diagnostics disclosure whose deep content mounts only while open; it auto-expands only on the first evaluated signal after evidence loads, and later signals surface a `New signal` badge on the collapsed summary instead of forcing the section open (`src/app/admin/use-auto-expand.ts`)
  - a promoted `Recommended Now` action strip derived from blocking causes and unhealthy cron lanes
  - explicit stale-client, public-health divergence, and background-fetch notices that preserve the last good payload
  - a compact `Credentials` lifecycle summary (`src/components/status/credential-summary-card.tsx`): active, expiring-soon, expired, and non-expiring counts plus a 7-day rotate/deactivate audit-anomaly count, served by the counts-only `/api/api-keys/lifecycle-summary` endpoint with the same predicates as the API Management summary. It renders counts only — no rows, editors, or mutations — and links lifecycle work to `/admin-api/`. Missing evidence renders as `Unknown`, never zero.
- `/admin/` disables indexing (`robots: { index: false, follow: false }`)
- `/status/` stays read-only, uses only public read endpoints, and is public/indexable through its route metadata and sitemap entry
- The public `/status/` top fold uses `PublicStatusHero`: a headline row with health/probe fetch-freshness indicators and refresh control, conditional warning paragraph, four-metric strip, and compact metadata footer.
- The public `/status/` top fold also keeps the `Status runway` explicitly fixed to the last 30 days; the `24h` / `7d` / `30d` pills now belong only to the transition log below so filter changes do not silently reframe the hero summary
- `src/components/status/public-status-hero.tsx`
  - Renders the public-monitor hero with:
    - a status narrative headline instead of the old single-word + four-card metric template
    - a warning line only when the public status is not healthy or warnings are present
    - four compact metric tiles for cache pressure, browser probes, circuit breakers, and mint/burn sync
    - a compact footer for health sample time and the impacted-cache-lane count when non-zero
- `src/components/status/uptime-bar.tsx`
  - Renders the fixed 30-day public `Status runway` with explicit labeling (`Last 30d`) so the hero summary keeps a stable scope even while the transition table is filtered
- The public `Overview` lane uses flatter signal cards for mint/burn sync, blacklist ingestion, optional Telegram bot health, and impacted public surfaces
- The public blacklist-ingestion card keeps low-ratio amount gaps visible and shows recent gaps in supporting copy; severity follows the shared missing-amount ratio bands (`>=1%` degraded, `>=2%` stale; unavailable ratio evidence is degraded). Recent-gap count alone is a watch signal, not a severity gate.
- Public cache freshness tables show the shared cache-age ratio bands (`>8x` degraded, `>12x` stale, or a tighter per-cache override — see "Per-cache availability overrides" below), while the hero and impacted-surface callouts follow the full shared cache-impact floor: missing cache rows and stale cache age remain stale, and cached-fallback mode degrades a lane even when the age ratio is still inside target. Stale or degraded producer-source freshness can still appear as an admin `/api/status` warning cause without becoming a public impacted-surface callout by itself until the public availability budget is breached.
- Cache-table endpoint warning labels apply the same cache-specific fresh boundary: `yield-data` warns after two hourly intervals, rather than the generic eight. Endpoint basis and availability budget remain separately displayed when they differ.
- The public mint/burn card, hero tile, and impacted-surface callout now follow the same backend lane contract as `/api/health`: sync freshness is primary, but a fresh cache still degrades publicly when the critical mint/burn lane's latest run is unhealthy
- The public circuit-breaker hero tile, reliability summary badge, and public breaker table derive the same public-impact filter as `/api/health` from `shared/lib/circuit-sources.ts`. Only `source-wide` registry scope contributes to source-wide degradation; dedicated `asset-scoped`, `optional`, retired, and dynamic `live-reserves:*` keys do not. Scoped breakers remain available in raw health and admin diagnostics while exact active-price coverage and reserve sync own their public impact. The shared `protocol-redeem` family remains source-wide even when one member serves a single asset. Retired keys stay excluded in legacy payloads and are not added to the active Worker inventory.
- Public `Overview` and `Reliability` lane shells use theme-aware tinted gradients with elevated inner cards so light mode keeps the same hierarchy without inheriting the dark-only monitor slabs

### Data hooks

- `src/hooks/admin-api-hooks.ts` — `useStatus()`
  - `useStatus()` — calls `GET /api/status` through same-origin `/api/admin/status` on `ops.pharos.watch` via `useAdminPollingQuery`
  - Query key uses the fixed ops-proxy scope; no browser-held secret is involved
  - `staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0` (via the `CRON_1MIN` ops budget); automatic refetches run every two minutes
- `src/hooks/api-hooks.ts`
  - Owns the shared low-friction query wrappers for `GET /api/health`, `GET /api/peg-summary`, `GET /api/dex-liquidity`, `GET /api/report-cards/v9`, `GET /api/yield-rankings`, and related read endpoints
  - This is the live source of truth for `useHealth()` / `usePegSummary()` and the other cache-backed read hooks used by the dashboard model
  - Desktop `Resources` enables `useHealth()` only while open. `System Status` shows the live public verdict; a failed refetch overrides retained data with neutral `Unavailable`, and an initial read shows `Checking`. No always-on masthead health dot: that would add `/api/health` polling to every desktop page.
- `src/hooks/use-endpoint-probes.ts`
  - Probes **public + admin** endpoint probe groups with `staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0`
  - Public `/status/` browser canaries use only `/api/health`, `/api/stablecoins`, `/api/peg-summary`, `/api/dex-liquidity`, and `/api/report-cards/v9`, with `staleTime: 900_000`, `refetchInterval: 1_800_000`, `retry: 0`
  - The public hero keeps health/probe fetch clocks separate, each using its hook's polling interval as the overdue budget. Missing probe samples show Loading while pending, otherwise Unknown (including failed or empty results), never Healthy.
  - Public probes use the same-origin `/_site-data/*` website lane; admin probes use same-origin `/api/admin/*` on the ops host
  - Manual/admin mutation actions are listed but intentionally not auto-probed
  - `/api/health` and `/api/status` are parsed semantically, so `200` responses with `status/overallStatus = degraded|stale` count as unhealthy in the browser probe summaries
  - A `/api/health` body missing blacklist gap-counter fields fails the semantic contract and is reported `stale` with `error: "Invalid health probe response"`. An explicit `db-unavailable` or `blacklist-read-failed` reason with `missingAmounts`, `missingRatio`, and `recentMissingAmounts` present as null is accepted as unavailable evidence; a healthy top-level status is downgraded to degraded. Missing evidence is never defaulted to zero.
  - `EndpointHealthGrid` classifies every probe once through `getProbeDisplayStatus`, so a response that is both HTTP-failing and semantically degraded counts as one stale sample and renders one badge; the headline sentence always sums to the sample total
  - `usePublicEndpointProbes()` is reserved for the public `/status/` page and does not inherit the full operator endpoint list
- `src/hooks/use-public-status-history.ts`
  - Calls `GET /api/public-status-history` through same-origin `/_site-data/public-status-history` on website hosts
  - Uses the endpoint's explicit `window=24h|7d|30d` filter instead of approximating windows with row-count-only limits
  - The public page binds one fixed `30d` query for the runway and a separate user-selected query for the transition log, so the hero summary and history table no longer fight over the same state
  - A rejected history query marks the 30-day runway unavailable. The transition log displays the read failure when no transitions are retained; a failed refetch with retained transitions continues showing those rows without a separate error notice.
  - **Public-impact filter:** `shared/lib/status-public-impact.ts` owns the cause-code allowlist; only `warning` or `critical` causes can open a public incident. It includes cache availability, exact publication/price-coverage failures, critical cron failures, DB failure, and both public/heavy scheduler delivery gates. `circuit_query_failed` and `mint_burn_health_query_failed` are warning-severity availability failures; `cache_freshness_query_failed` and `cache_warning` are info-only diagnostics. Admin-only ratio, reserve, on-chain, and watch causes cannot open an incident. Once an incident opens, `worker/src/api/public-status-history.ts` also retains its recovery path, including info-only recovery rows. `currentStatus` comes from a live `assessPublicHealth` read, not persisted hysteresis; `lastChangedAt` is the newest retained public transition only when it ends in that live status, otherwise null. The uptime rail overlays live health onto today and leaves earlier days unknown when no transitions are retained. Exact coverage reads use the latest publication-bearing stablecoins run, and the capped overall cause list reserves capacity for non-info active-price coverage causes.
- `src/hooks/admin-api-hooks.ts` — `useStatusHistory()`
  - Calls `GET /api/status-history` through same-origin `/api/admin/status-history` on `ops.pharos.watch`
  - Query key uses the fixed ops-proxy scope; no browser-held secret is involved
  - Adds rolling windows (`6h`, `24h`, `7d`, `30d`) for timeline drilldown
- `src/hooks/admin-api-hooks.ts` — `useRequestSourceStats()`
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
  - Reflects a narrowed response-header set (`Allow`, `Cache-Control`, `Content-Type`, `Idempotency-Key`, `Retry-After`, `Warning`, `X-Data-Age`, `X-Execution-Certainty`, `X-Idempotent-Replay`) back into the app shell
  - Converts upstream timeouts into operator-visible `504` JSON errors; non-timeout fetch failures and Access redirect responses still return `502`
- Workspace clients own only the queries their route requires. Triage does not mount credential inventory rows, endpoint matrices, cache tables, or healthy cron rows; Reliability owns endpoint/demand reads, History owns transition and audit reads, and API Management owns credential lifecycle mutations. Triage additionally reads the counts-only credential lifecycle summary endpoint; full inventory and audit rows stay in API Management and History.
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
  - Renders delivery health, shared backlog-policy evidence, permanent failures, retries, dispatch results, and per-alert delivery before a separate audience-coverage section. Missing optional telemetry remains `Unknown`, never zero — except an absent `freshRetryQueued` on a dispatch that completed `ok` with `pendingRetryQueued` present, which reads as a legacy pre-breakdown row and counts as zero retries.
- Cron telemetry is grouped by registry cadence/display group and rendered as a matrix:
  - Groups and job membership come from `CRON_GROUPS` and each job's `group` in `shared/lib/cron-jobs.ts`, not one group per physical trigger. Schedules and offsets come from that registry and `shared/lib/cron-cadences.ts`; see the [canonical cron table](./worker-infrastructure.md#cron-scheduling).
  - Jobs that own a dedicated isolated trigger can render inside a shared cadence group but stay labeled as isolated triggers
  - The default attention filter does not mount healthy rows; operators can search and filter by state, impact, trigger group, and running status
  - Display-group boundaries remain visible, with severity ordering inside each group and stable registry order for ties
  - Rows show state, impact class, operator-friendly label, raw job id, trigger, last run, last good run, readable/exact duration, item count, and evidence markers
  - A selected-row detail panel owns full metadata, error text, in-flight progress, attempt records, stale artifacts, latest events, and accessible recent-run outcomes
  - Slot execution metadata includes compact child outcome counts (`jobsAttempted`, `jobsSucceeded`, legacy `jobsRun`, `jobsSkipped`, `jobsNeutralSkipped`, `jobsDegraded`, `jobsErrored`, `budgetOnlyJobs`) so a best-effort slot can surface degraded/error children without hiding later jobs that still ran. Expected no-op skips, such as an empty manual digest poll, increment `jobsNeutralSkipped` instead of `jobsSkipped`.
  - Budget-only scheduled surfaces are exposed separately through `budgetOnlySurfaces` instead of being folded into `crons`: Telegram registration reconciliation, the Telegram digest outbox drain, and the manual digest-trigger poll report cache-backed checked-at time, duration, due/processed counts, outcome, skip reason, and bounded metadata.
  - When a leased job is still running, rows and the detail panel surface `running` / `running-stale` state from `crons[*].inFlight`
  - Orphaned progress rows and expired leases are suppressed from `crons[*].inFlight` and exposed as `crons[*].staleArtifacts`, with aggregate counters in `summary.staleCronArtifacts`, `summary.orphanedCronProgressRows`, and `summary.expiredCronLeases`
  - Shared display metadata now comes from `shared/lib/cron-jobs.ts`, which also feeds worker interval expectations
  - Job-specific metadata summaries are resolved through `src/components/status/cron-metadata-summary.ts` and clamped in the row/details split
- The operator UI uses fixed route workspaces instead of a single scrolling lane stack:
  - `Triage`: current incident state, blockers, watch count, recommended action, last transition, query freshness, raw diagnostics, and a counts-only credential lifecycle summary linking to API Management
  - `Pipeline`: URL-backed tab inspection for `Quality`, `Markets`, `Reserves`, `Yield`, `Storage`, and `Integrity`; inactive modes are not mounted
  - Mint/burn reconciliation now defaults to the six highest-severity rows and exposes the long insufficient-source tail behind a `See all` disclosure button
  - `Reliability`: URL-backed `Impact`, `Endpoints`, `Dependencies`, `Demand`, and `Cache` modes; manual mutation routes are excluded from default probe noise, and the Dependencies public-service breaker list uses the same public-impact filter as `/api/health` while retaining excluded breakers in provider diagnostics
  - `Crons`: grouped, filterable attention workbench with a selected-row evidence panel that is sticky at `xl` and above, and separately grouped budget-only surfaces
  - `Actions`: searchable intent/risk catalog with one shared execution dialog, direct dry runs where supported, structured results, and persistent action history
  - `Comms`: delivery-first Telegram operations followed by separate audience coverage
  - `History`: window, severity, surface, cause, and public-impact filters plus correlated incident, action, and credential activity
  - History renders independent public/heavy script names, verified version UUIDs and activation times from `workerVersions`, never the latest producer-head singleton. Missing markers explicitly show unavailable; deployment commit/ID and causal transition attribution remain Unknown.
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

`workerVersions: { public: Marker | null, heavy: Marker | null }` is owned by `shared/types/status/response.ts`. Each marker is `{ scriptName, workerVersion, activatedAt }`, read directly from the deploy-verified `worker-active-version:<role>` cache key by `getActiveWorkerVersionMarker()` in `worker/src/lib/worker-version-first-seen.ts`. Missing/malformed evidence is null; failed D1 reads add the named `sectionErrors.workerVersions` / `worker_versions_query_failed` error, never a latest-run guess. Per-run `workerVersion` scalars remain execution UUIDs. The public three-lane five-minute liveness aggregate is unchanged; independent heavy delivery evidence extends the query and GitHub monitor with separate heavy budgets.

The [history endpoint](#history-endpoint-get-apistatus-history) owns timeline responses and completeness evidence.

Shared raw-status evaluator: `worker/src/lib/status-evaluation.ts`

Shared public-health floor: `worker/src/lib/public-health-assessment.ts`, backed by the pure helpers in `shared/lib/cache-health.ts` and `shared/lib/public-health.ts`

Public/operator copy uses actual health warning evidence; unknown codes remain visible. Blacklist read failures expose null measurements with `unavailableReason: blacklist-read-failed|db-unavailable`; successful empty reads retain zeros. Browser probes and cards admit this unavailable branch without claiming zero gaps. Critical-duration labels use only the warning's named price-gap IDs; other missing prices stay in the separate coverage warning. Thresholds and recovery policy are unchanged.

The public `HealthResponse.blacklist` contract (`shared/types/status/public-health.ts`) makes all five measurements nullable: `totalEvents`, `missingAmounts`, `recentMissingAmounts`, `recentWindowSec`, and `missingRatio`. A failed read sets these to `null` and supplies `unavailableReason: "blacklist-read-failed"`; an unavailable database supplies `"db-unavailable"`. The reason is nullable/optional for available or retained payloads. Consumers must show unavailable measurements, not zero events, zero gaps, or a healthy ratio. A successful empty observation may publish numeric zeros.

Read failures use the ADR-29 `PublicHealthReadResult` boundary and cannot restore healthy diagnostics. Circuit reads publish `HealthResponse.circuits: null` with `circuitsUnavailableReason: "circuits-read-failed"` (or `"db-unavailable"`); successful reads still publish the circuit record map. Mint/burn critical read failures publish nullable `sync.freshnessStatus` / `sync.criticalLaneHealthy` and `unavailableReason: "mint-burn-read-failed"` or `"mint-burn-output-read-failed"`; DB failure uses `"db-unavailable"`. Unread major counts/symbols are nullable. The existing `queryErrors` fields carry `"mint-burn-output-read-failed"` / `"mint-burn-count-read-failed"` for their respective failed reads; a failed advisory count does not invalidate an independently observed healthy writer. Operator causes `circuit_query_failed` and `mint_burn_health_query_failed` are warning-severity and degrade availability rather than overriding unavailable evidence to healthy.

When the DB sentinel fails, `/api/status` publishes `dataQuality: null` with `sectionErrors.dataQuality.code: "db-unavailable"`, nullable summary measurements with `summary.unavailableReason: "db-unavailable"`, and `reserveComposition.status: "unavailable"` / `reason: "db-unavailable"` with null coverage and counts. A successful empty reserve cohort remains distinct and may be healthy with observed zeros. `summary.transitionsLast24h` is nullable: a failed or absent aggregate carries `transitionsUnavailableReason: "status-transitions-read-failed"` plus the same `sectionErrors.statusTransitions.code`; DB failure carries `"db-unavailable"`. A successfully counted zero remains `0` with no unavailable reason. History shows unavailable count/flapping evidence instead of assuming no transitions.

FX health admits its publication clock with canonical `assessFreshnessTimestamp` (60-second allowed skew): excessive future clocks publish null `ageSeconds` / `publishedAt`, `timestampReason: "future-timestamp"`, and a stale availability floor. Per-peg provenance continues to use the shared `assessFxPegAdmission` path: source clocks more than 300 seconds ahead already reject with `source-time-future`, used in `fx-source-provenance-unknown:<peg>=<reason>`; rejected clocks never create a healthy source claim. Blacklist cards also preserve partial evidence: `recentMissingAmounts: null` means recent gap evidence unavailable, not “no new gaps”.

Related extracted loaders:

- `worker/src/lib/status/derived-data.ts`
  - `getDatasetFreshness()`
  - `getMintBurnReconciliation()`
  - empty fallback builders for dataset freshness / reserve composition
- `worker/src/lib/status/data-quality.ts`
  - canonical stablecoins-cache / blacklist-gap / active-depeg / on-chain-supply quality aggregation

The backend contract is split into bounded sections. Select the evidence family affected by the change:

- Request/read boundaries: [Auth and caching](#auth-and-caching) and [Timestamp admission](#timestamp-admission).
- Execution and capacity evidence: [Cron health model](#cron-health-model), [Resource-pressure evidence](#resource-pressure-evidence), and [Cron error escalation](#cron-error-escalation).
- Status computation: [Availability status](#availability-status), [Data quality status](#data-quality-status), and [Overall status](#overall-status).
- Source supplements: [Live reserve sync health](#live-reserve-sync-health), [Yield health summary](#yield-health-summary), and [Telegram bot metrics](#telegram-bot-metrics).
- Self-observation: [Synthetic self-check](#synthetic-self-check). Historical transitions are owned by the [history endpoint](#history-endpoint-get-apistatus-history).

## Auth and caching

- Requires a valid admin credential (`requireAdmin`)
- Response cache policy: `Cache-Control: no-store`
- Even when the 15-minute assessment snapshot is fresh, `/api/status` reads current cron history, progress, leases, and scheduled slots through `loadCronHealth()`. Per-job availability, cron/slot summary counts, and the informational cron availability causes (`degraded_cron_warning`, `watch_cron_error_runs`, `watch_unhealthy_crons_present`, and the `cron_*_query_failed` notices) all describe that one live read at the response `timestamp`, so a cause count never disagrees with its `summary` counterpart in the same response; the aggregate assessment, caches, and expensive supplements retain the persisted assessment generation. A failed live cron read remains unknown rather than replaying a cached success.
- Every health/status request live-reads `schedulerLiveness` from actual D1 slot starts, including fresh-snapshot paths. The public aggregate and its three lanes remain unchanged; `schedulerLiveness.heavy` adds independent registry-owned heavy delivery evidence (`scheduleKey`, `lastStartedAt`, `ageSeconds`, `warningAfterSec`, `staleAfterSec`, `status`, `unavailableReason`). Cached unhealthy scheduler floors for either role force live recomputation to clear only obsolete scheduler causes; independent blockers remain. Admin snapshots are bypassed when reserve review applicability changes, and pre-feature reserve projections are rejected.

`StatusResponseSchema` validates retained nested sections at the query boundary. Raw snapshot admission reuses those schemas before any dereference: malformed causes, caches, crons or other required sections return `unreadable` and trigger live recomputation. Only absent optional `budgetOnlySurfaces` defaults to `[]`; additive top-level fields remain passthrough-compatible.

`computeRawStatus()` now performs the DB sentinel first and returns an explicit stale fallback snapshot when that sentinel fails, instead of throwing before the dashboard can show operator-visible degraded state.

**Rules this contract carries.** Two repo-wide data-integrity rules are load-bearing here and are recorded as
ADRs in [`architecture.md`](./architecture.md#architectural-decision-records): **R3** (ADR-30) — a published
freshness verdict names the budget it used and the generation it describes, with input quality in separate
fields — and **R4** (ADR-31) — a non-`ok` terminal status carries a machine-readable reason, and terminal
status separates "did the work happen" from "were the inputs perfect". Their additive publication fields live
in `CacheStatusSchema` (`shared/types/status/schema-primitives.ts`): `healthyMaxRatio` and `healthyMaxAge` for
the band, `publishedAt` for the immutable cache/fallback evidence clock and sentinel-backed `generationId`,
and `degraded` / `degradedReason` / `streakDegradedRuns` for input quality. Sentinel generation identity is
required and compared with the served DEWS pointer, liquidity global row, or yield-ranking publication in
the same D1 read. Missing/mismatched identities invalidate the sentinel; fallbacks retain their observed
table/confirmed-output clock but no generation ID. Dependency ages advance from these immutable clocks.
The per-field behaviour is specified under Cron health model, Cron error escalation, and Synthetic self-check below.

## Timestamp admission

`api-freshness-age.ts` owns timestamp assessment independently of each consumer's age budget.
Status readers reject missing/non-finite clocks and timestamps more than the existing 60-second
allowance ahead of their read clock; the inclusive allowance still yields age zero. The producer
oracle returns a null age and `timestampReason` (`missing-timestamp`, `invalid-timestamp`, or
`future-timestamp`) instead of classifying invalid evidence as fresh. Consumers retain their
existing freshness bands. Captured-run consumers can supply a separate read clock or explicit
allowance: DEWS uses wall time during hydration so an overlapping producer published after run
start is not falsely rejected.

Ordinary cache, table fallback, cron fallback and yield-health clocks use that same admission boundary.
Rejected clocks expose null ages and the exact `timestampReason` (yield rankings use
`rankingTimestampReason`), never a negative age or a clamped healthy future generation.

Cache freshness sentinels retain strict future-clock rejection with no skew allowance.
Their validation clock is D1 `unixepoch()` from the same cache SELECT, rather than
the earlier self-check run clock. A generation published during endpoint probes is
therefore admissible, while a timestamp ahead of the database read remains invalid.
The existing caller clock and freshness budgets still own age-band assessment.

Raw status snapshots validate both cache and payload generation clocks, returning `unreadable`
with a timestamp reason on invalid evidence. Persisted status-state reads return unavailable
state/staleness and report `status_state_invalid_timestamp`. Invalid probes cannot establish
divergence: discrepancy diagnostics expose `probe-invalid-timestamp` and a null age. These are
timestamp-admission corrections, not changes to cadence, hysteresis, age budgets or alert policy.

Canary PSI/DEWS checks use the named `CANARY_INCIDENT_MAX_AGE_SEC` four-hour incident
policy, distinct from endpoint freshness and Telegram flow tolerated-context budgets.

## Cron health model

**Terminal status and publication evidence are separate (R4).** `degraded` means required work was incomplete;
it does not prove either publication or absence of publication. A completed job with only input-quality findings
returns `ok` with `metadata.quality` (including growth capacity warnings and Bluechip partial-cache merges).
Mixed producers can publish usable output while another required stage fails; their confirmed output clock
advances independently of their degraded attempt. Held cohorts, failed writes, no-row attempts, retained reserve
fallbacks and lost CAS writes cannot advance that clock. A deliberately published empty snapshot is real output.
`createCronResult` requires `metadata.reason: string` at compile time for every non-`ok` status, including skips.
Direct `CronResult` producers retain the logger's runtime defense: unresolved degraded/error reasons become
`unspecified-<status>` and warn in the Worker log. `cron_runs.degraded_reason` remains the terminal reason;
successful-run quality reasons remain visible in status diagnostics and operator night-watch findings.
Every retained cron run projects a nonblank `cron_runs.degraded_reason` as optional `degradedReason`.
The admin detail summary prefers that column over legacy metadata and appends a generic reason for
unknown jobs or column-only rows; canonical quality findings append without replacing specialized
summaries. `degradedCrons` counts fresh degraded execution statuses only (including inheritance
behind neutral skips), never successful `metadata.quality` findings or legacy blacklist maintenance
warnings. Errors and freshness remain independently evaluated.

The retired `compute-safety-score-v9-workflow` observer is no longer a registered producer or freshness/watchdog obligation. Historical failures remain in D1 as forensic evidence. Raw snapshot loading compares the entire cached cron membership against the current registered cohort; mismatches invalidate the whole assessment and trigger live recomputation, including severity. Filtering a retired job while preserving its cached OOM severity is not a valid cutover. Newly produced post-activation snapshots must use the current cohort, and genuine canonical/other failures remain visible.

Scheduled attempt evidence is independent of detailed in-flight progress: every protocol-v1 child has a
durable `scheduled_child_attempts` start marker before work, including progress-suppressed jobs. Real and
synthetic terminals arbitrate one deterministic full attempt identity under the executing slot fence.
Replay retains producer source identity while naming its recovery execution fence. Reconciliation proves
`not_started` only when a due protocol-v1 child has no marker; legacy missing evidence is
`execution_unknown`, projected as an error/abandoned producer with explicit uncertainty, not success
or a zero item count. Last durable activity durations are lower bounds, not reconstructed runtimes.
Producer invocation aggregates and confirmed publication clocks remain separate from attempt terminals.
`worker/src/lib/cron-outcomes.ts` owns outcome projections/folding: errors outrank degraded/nonneutral
skips, which outrank `ok`; locked skips are nonneutral and neutral skips stay neutral. Fence admission
status, child `resultStatus` and productivity remain distinct. Execution deadlines and the centralized
slot/child silence policy do not change the freshness windows below.

Successful observers report `ok` plus `metadata.quality` for semantic service degradation, stale producer output, detail-write markers, missing digest editions, duration/abandonment trends, and sustained DEX turnover. These findings do not increment `degradedCrons`; fresh operational `degraded` attempts still inherit behind neutral skips. The workbench includes findings in Attention and labels successful observations “Succeeded with findings” without changing execution state or group degraded totals. Observation success never renews a producer's output clock.

`CRON_INTERVALS` owns producer cadence. The staleness watchdog's one-statement fact loader in
`worker/src/lib/status/freshness-oracle.ts` preserves latest attempt/status separately from the latest
confirmed output clock (`lastSuccessAt`). `cron-output.ts` owns the shared evidence boundary used by the
logger, cron health, public mint/burn health, endpoint freshness and cron-backed dataset freshness. New rows persist `metadata.outputPublishedAt`
(the actual generation clock where available, otherwise confirmed completion) or explicit `null`; metadata
compaction preserves this clock and quality reasons. Legacy rows require affirmative publication metadata
or an `ok` result with a positive output count; an unannotated degraded attempt is not success.
A legacy blacklist scan with positive, equal attempted/succeeded/quiet configuration counts and zero
coverage failures is a confirmed quiet observation even when it inserts no events. Explicit no-output
markers still override this legacy evidence.
Canary and DEWS budgets remain separate named policies; they do not call this producer fact loader.
Status uses a `2x` window; the watchdog retains its `2x`/`3x` policy. Watchdog stale observations preserve `publishedAt`, nullable `generationId`, `assessedAt`, and all budgets in cron metadata through status projections.
Canonical control-plane jobs with `freshnessSurface: "none"` require a completed observation rather than a
consumer publication. Subject to a successful history read, cron availability is healthy when:

- A fresh non-stale `crons[*].inFlight` heartbeat exists (without advancing the output clock), or
- The latest attempt is fresh and `ok`/`degraded`, and its latest confirmed output is within
  `2 * expectedIntervalSec`. That output can come from an earlier attempt: cadence reuse and
  `already_written_today` do not erase it or renew its clock. Control-plane jobs instead accept a fresh
  `ok`/`degraded` observation, or
- A fresh `skipped_neutral` attempt inherits such evidence from the latest required successful or locked run, or
- Last run status is `skipped_neutral` whose `metadata.reason` is in `PROVEN_SATISFIED_NEUTRAL_SKIP_REASONS`
  (`shared/lib/cron-jobs.ts`: `same_day_snapshot_exists`, `weekly-recap-exists`) — the skip was recorded only after a
  successful precheck read found the period's write-once artifact, so it is fresh positive evidence the period's
  output exists. Such a skip also supersedes an earlier fresh error for the same period in `summary.cronErrors`
  (the error row and its machine-readable reason stay in history; one transient precheck read failure must not keep
  a write-once daily artifact's producer red until the next day's real run). An inherited `degraded` run stays a
  warning: the artifact existing proves availability, not that the producing run's inputs were clean.
  Later generic neutral admissions retain this fresh readback evidence; a required attempt after the
  readback supersedes it, so a newer error still wins, or
- Last run status is `skipped_locked` **and** there is a fresh `ok` run with confirmed output in the same window, or
- The job is **not** reported healthy when the cron-history query itself failed: `crons[*].healthy` is `null` with `crons[*].telemetryUnknown = true` and `crons[*].telemetryUnknownReason` naming the failed read, and the job is excluded from unhealthy/error counters rather than reported falsely unhealthy or falsely healthy, or
- The job is a watch-tier bootstrap (`crons[*].bootstrap = true`): no required non-neutral attempt yet and at most one recorded run. Critical-tier jobs always require real availability evidence

The display retains ten runs. A full window with fewer than two required attempts triggers an indexed, two-row required-attempt lookup; duplicate evidence is removed. A fresh proven-satisfied readback is recovered separately when absent, preserving error supersession behind generic admissions. Appended attempts/readbacks keep verdicts attributable in `recentRuns`. A full window without confirmed output also triggers the bounded `CONFIRMED_CRON_OUTPUT_AT_SQL` aggregate; no-op attempts never renew publication. Duration trends count only executed `ok`/`degraded`/`error` attempts, excluding admission skips from averages and sample floors; cap-hit and graceful-deferral policy is unchanged.
Admin last-completed text is `Unknown` with the failed-read reason when telemetry is unavailable. A readable window lacking success says `No successful run in recent history`, never claims absence across all history.

Otherwise the job is unhealthy, including stale history, non-fresh errors, or a generic neutral skip (no
proven-satisfied reason) whose latest required run errored or lacks confirmed output. A required degraded run
remains counted in diagnostics behind neutral skips; fresh `ok` runs with quality findings also count as warnings.

A fresh recovery attempt does not keep `/status` degraded just because the last completed run failed: while a leased cron runs with a fresh heartbeat, availability treats the lane as live and card history keeps the previous completed run.

The admin cron workbench resolves a neutral skip against the latest required non-neutral run before building its
attention filter, using the same proven-satisfied vocabulary: the newest served `skipped_neutral` row proving the
period's artifact exists clears an inherited failure when it is no older than that required run, even behind later
generic admissions; with no inherited warning or failure the row renders as **Skipped**, not **Unhealthy**. Known V9 admission reasons replace the generic no-work label with the actual condition, such as
`competing slot active` or `core slot not ready`. The row remains under `Needs attention` when backend availability
still lacks required success evidence, so the neutral attempt outcome does not hide a starved producer. Inherited
degraded outcomes retain warning treatment, inherited failures remain unhealthy unless superseded by a
proven-satisfied skip, and stale neutral skips remain unhealthy.

Scheduled-slot abandonment is surfaced separately from child job runtime failures. When a later trigger reconciles a stale `cron_slot_executions` row, `/api/status` can attach `crons[*].latestEvent` with `eventType = "scheduled-slot-abandoned"` to each child job in that slot; the marker includes the schedule key, slot owner, and abandoned child progress stage. Synthetic child rows with `metadata.reason = "stale-slot-reconciled"` remain in `recentRuns` for audit history, except legacy false `daily-digest` not-started rows from idle `digestTriggerPoll` slots, which are excluded before the per-job history limit. Genuine forced digest outcomes and abandoned started-progress rows remain visible. The sentinel's duration source excludes synthetic reconciliation rows from runtime averages and reports proven publication, not-started children, publication failures, terminal-accounting unknowns, and real child failures as separate lifecycle counters. Remediation: [`docs/runbooks/cron-slot-abandonment.md`](./runbooks/cron-slot-abandonment.md).

Synthetic timestamps preserve the evidence clock: started-child abandonment uses the original start and last durable progress heartbeat, while a proven not-started child uses the original slot invocation and last slot heartbeat. Reconciliation wall time remains metadata, so older synthetic evidence cannot outrank a newer real success or producer head. An idle conditional digest poll never synthesizes a `daily-digest` failure; durable started progress is still reconciled. The cron workbench labels the active child `Abandoned`, derives runtime from its last heartbeat, and displays reconciliation delay separately. Synthetic downstream children with `childDisposition = "not_started"` render as `Not started: upstream abandoned` with runtime `N/A`; explicit dependency markers with `skippedReason = "upstream-incomplete:<job>"`, `upstream-failure:<job>`, or `upstream-blocked:<job>` render as not started with the corresponding prerequisite state, also with runtime `N/A`, and expose the prerequisite job as table evidence. These rows retain their raw error or degraded audit status so availability accounting still records the missed required execution. High-ratio abandonment remains metadata-visible for the full 7-day lookback, but it only keeps the watchdog degraded while at least one matching abandoned slot is less than 24 hours old.

Mint/burn public freshness uses the same grace window before warning: `/api/mint-burn-flows` and `/flows` stay `fresh` through `2 * expectedIntervalSec` for the critical lane (`60m` at the current cadence), then degrade/stale afterward. `/api/status` reuses that public-health floor for availability once the critical lane has emitted real sync telemetry, so admin and public surfaces agree on fresh-but-degraded mint/burn runs.

For the split DEX pipeline:

- `sync-dex-discovery` surfaces crawl-progress metadata (`coinsCrawled`, `poolsDiscovered`, `tierBreakdown`, `budgetExhausted`, `failedCoins`, `failedCoinErrors`) so operators can tell whether the staging crawl is still feeding the scorer and which source path failed per coin.
- `sync-dex-liquidity-stage` independently reports the hourly `:10` source/pool handoff, including generation, slot, chunk/record/byte totals, source failures, and fallback signals.
- `sync-dex-liquidity` reports the exact-slot `16,46` scoring/publication consumer. Its `degraded` result retains staged source diagnostics and explicitly captures non-fatal upstream degradation or near-guard coverage drops, with machine-readable `failedSources`, `fallbackMode`, `sourceCoverage`, staged-pool merge counters, and staged skip-reason breakdowns for exact-identity vs unique-derived-identity dedup.
- `sync-mint-burn` is now the critical lane, while `sync-mint-burn-extended` drains long-tail backlog on its own offset schedule. The status surface tracks them independently so extended backlog pressure does not mask critical freshness.
- `crons[*].inFlight` exposes live `cron_run_progress` state (`stage`, `itemsDone`, `itemsTotal`, `message`, `updatedAt`, `stale`) for long-running leased jobs such as blacklist, mint/burn, DEX discovery, stablecoin price enrichment, and yield evaluation. The API suppresses orphaned progress rows once their matching lease is gone, so `running-stale` means "still leased but heartbeat stalled", not "some old progress row never got cleaned up". Suppressed rows and expired leases are available in `crons[*].staleArtifacts` for operator cleanup/readout.
- `status-self-check` records its monitoring, probe, computation, and publication phases. A distinct `route-probe:<path>` stage is persisted before each selected route so abandonment evidence identifies the last entered probe without progress coalescing hiding it; a phase alone does not identify the allocation responsible for a memory termination.
- `summary.scheduledSlotRunning`, `summary.scheduledSlotStaleCandidates`, and `summary.scheduledSlotOldestRunningAgeSec` expose running scheduled-slot rows. The detail query remains capped at 25 rows, but `scheduledSlotRunning` comes from the query's full-window count rather than the capped page; `budgetOnlySurface*` summary counters separately report missing, stale, or error telemetry for budget-only side work.
- `sync-live-reserves` now emits structured metadata (`synced`, `failed`, `skipped`, `warningCount`, `coinsWithWarnings`, `coinsWithErrors`, `breakerKeys`) summarized in the cron card.
- `sync-redemption-backstops` keeps market-implied route impairments visible through `availabilityDegraded` metadata and impaired rows, but those expected row-level availability states do not by themselves mark the cron run degraded. The capacity coverage floor (`unresolvedMissingCapacity` above `missingCapacityOkThreshold`) is published the same way, under `metadata.quality.reason = "capacity-coverage-floor"`; only unresolved routes, a stale liquidity feed, no active configured rows or post-write warnings degrade the run.

## Resource-pressure evidence

Cron detail displays **current progress** and **last terminal** resource evidence separately; it never combines measurements across attempts. Both use the validated `ResourcePressureSchema` block in `crons[*].inFlight.metadata` / `lastRun.metadata`: phase and observation time, source body/cache/entry caps, concurrent decode policy, input/catalog admission, actual streamed intake, estimated retained cache and estimate basis, rejection count, guard, and reconciliation platform evidence. Generic metadata summaries append the same resource phase/intake/guard lines.

`logCronRun()` ingests evidence before progress suppression/coalescing and carries the latest snapshot into success or thrown terminals; an equally recent result snapshot wins. Persisted metadata compaction preserves the complete block. Synthetic reconciliation preserves the last durable observation clock and measurements, adding only its existing proven `platform-abandoned` or `platform-interrupted` classification with source `slot-reconciliation`. Neither classification proves Cloudflare OOM or CPU exhaustion.

Legacy missing/invalid blocks, nullable counters and unknown platform outcomes render as **unavailable**, never zero or healthy-green reassurance. `heapUsedBytes` is always null and the detail explicitly says **Heap unavailable** (`workers-runtime-no-heap-api`): Workers has no usable production heap API, and the installed unenv process-memory implementation is a zero stub. Body bytes and conservative cache estimates exclude in-flight decode allocations, warmed graphs, native storage and concurrent invocation heap. See [per-job resource evidence](./worker-and-api-limits.md#per-job-resource-evidence) for policy/accounting boundaries.

## Availability status

Computed from public cache impact, public mint/burn impact, circuit health, D1 capacity pressure, and availability-impacting cron availability. Blacklist gap health contributes to `/api/health` public status and the admin data-quality/status rollup, not directly to the availability floor.

Scheduler delivery is an independent availability axis: the newest actual start across `fiveMinuteReserveRecovery`, `fiveMinuteTelegramAlerts`, and `digestTriggerPoll` must be within the shared 600-second warning / 1200-second stale budgets (strictly greater than the boundary escalates). `scheduled_delivery_stalled` is warning/critical; missing, future, or unreadable starts yield `scheduler_liveness_unavailable` and a degraded floor, never healthy. Overall MAX is diagnostic only: an hourly slot cannot mask five-minute delivery loss. Partial lane loss stays diagnostic while another canonical lane starts. See [delivery stall runbook](./runbooks/cron-delivery-stall.md).

Heavy delivery is a separate gate, resolved from plans with `worker: "heavy"` in `shared/lib/scheduled-runner-registry.ts`, choosing the shortest logical cadence (currently the 15-minute `v9SupplyAttributionOffset` lane). Its evidence is `MAX(started_at)` for that slot, never scheduled clocks or child completions. `STATUS_HEAVY_SCHEDULER_LIVENESS_THRESHOLDS` owns the warning budget of 1800 seconds (two missed 15-minute slots) and stale budget of 2700 seconds; escalation is strictly above each boundary. `heavy_scheduled_delivery_stalled` is warning/critical and floors public health/admin availability; `heavy_scheduler_liveness_unavailable` yields a degraded floor with a machine-readable unavailable reason. Public starts cannot mask heavy loss. The shared “Scheduled delivery” card on `/status/` and the admin workspace displays public and heavy evidence separately with both budgets and any unavailable reason.

- `stale` if any of:
  - any shared cache impact is `stale`
  - the public mint/burn lane is `stale`
  - D1 capacity threshold state is `critical`
  - any availability-critical cron has two or more consecutive failed runs
  - `availabilityImpactingUnhealthyCrons >= 2`
- `degraded` if any of:
  - any shared cache impact is `degraded`
  - the public mint/burn lane is `degraded` (once the lane has emitted real sync telemetry)
  - circuit or critical mint/burn health evidence could not be read (`circuit_query_failed`, `mint_burn_health_query_failed`)
  - D1 capacity threshold state is `warning`, or the D1 capacity assessment could not be read
  - `openCircuitGroups >= 3`
  - any availability-critical cron has a single failed run
  - `availabilityImpactingUnhealthyCrons > 0`
- else `healthy`

`degraded` cron runs count separately in `summary.degradedCrons` and show in the cron UI, but do not by themselves degrade availability.

Unmeasured cache ratios are null in `summary.worstCacheRatio`; `cache_freshness_unavailable` names missing/invalid evidence without a numeric value. Observed finite ratios, including a real 99x breach, remain measured statistics.

Triage cache urgency uses key-aware `getCacheImpactStatus`, matching Reliability: default 8x/12x bands, yield 2x/4x, and cached-fallback degradation. Missing age/budget remains evidence risk, not a fabricated ratio.

Storage maps published capacity to Healthy (`normal`), Watch (`watch`/`warning`), or Critical (`critical`), counting one issue for non-normal capacity. Present usage metrics without capacity remain Unknown with one evidence issue; utilization thresholds stay owned by the capacity runbook.

`openCircuitGroups` here means public-impact circuit groups only, derived from `CIRCUIT_SOURCE_REGISTRY.scope`. Dynamic per-coin `live-reserves:*` and dedicated single-asset pricing-route breakers still render in the reliability tables, but they do not degrade availability on their own because reserve sync and exact active-price coverage already own those asset-scoped diagnostics. Unknown circuit keys conservatively remain source-wide.

Price-source health buckets cover every non-retired pricing-source registry key, including `kava-pricefeed`, `mento-fpmm`, `mento-broker`, and `protocol-redeem-cached-rate` emitted by fallback providers, plus the registry-only `aerodrome-onchain` and `velodrome-onchain` keys. The explicit bucket tuple is checked against the registry rather than its own re-export.

Runbook links are intentionally sparse. `withRunbook()` in `worker/src/lib/status/evaluation-rules.ts` attaches `runbookUrl` only for registered cause codes; `RUNBOOK_BY_CODE` is the owning map. Public-impact causes such as `cache_ratio_*`, `mint_burn_public_*`, `open_circuit_groups`, and `cron_error_runs` can appear without a Runbook link.

Each cron definition now carries `statusImpact: "critical" | "watch"` in `shared/lib/cron-jobs.ts`. Only critical lanes can degrade `availabilityStatus`; watch-tier cron failures stay operator-visible through cron rows, info causes, `summary.watchUnhealthyCrons`, and `summary.cronErrors`.

FX source freshness is also cadence-aware now. `/api/health` and `/api/status` still expose `fx-rates.sourceStatus`, but intraday sources use age windows while ECB/secondary daily sources compare their published source date against the next expected business-day or calendar-day rollover. Business-daily ECB references now use the TARGET closing-day calendar as part of that rollover check, so Good Friday, Easter Monday, New Year's Day, Labour Day, Christmas Day, and Boxing Day do not produce false lag warnings. Realtime OXR / Chainlink overlays no longer erase a fresh daily fiat source date when they are only refining the current daily reference stack, and commodity pegs can now refresh from the fresh `stablecoins` cache when `gold-api.com` is unavailable from Workers, so the status surface does not fall into false intraday staleness during later provider outages. One-step daily lag stays operator-visible as `degraded`, while only `stale` FX sources are excluded from downstream price validation.

Unknown FX provenance is never healthy. A present non-USD rate whose metadata generation cannot be verified, whose source mode is absent, or whose intraday source has no (or a future) source time makes `fx-rates` at least `degraded` with `healthy: false`, `degraded: true`, and a machine-readable `degradedReason` (`fx-metadata-<identity>` or `fx-source-provenance-unknown:<peg>=<reason>,…`); public health then reports it under `cache-quality-degraded`. The same per-peg assessment drives pricing, so health and price validation cannot disagree about an unknown source. See [Pricing Pipeline](./pricing-pipeline.md) for the generation and admission contract.

## Data quality status

Computed from publication/price coverage, blacklist gaps, on-chain integrity and reserve health. Read-failure impact is source-specific.

- `stale` if any of:
  - stablecoins cache is unavailable/corrupt (`dataQuality.stablecoinsCacheStatus === "error"`)
  - `missingPriceRatio > 0.45`
  - `blacklistMissingRatio >= 0.02` (2%)
  - `staleOnchainSupply >= 10`
  - `onchainSupplyDivergences >= 25`
  - `onchainStaleRatio >= 0.25` when `onchainSupplyTrackedCoins >= 10`
  - `onchainDivergenceRatio >= 0.25` when `onchainSupplyTrackedCoins >= 10`
  - `reserveComposition.status === "stale"`
- `degraded` if any of:
  - stablecoins cache is degraded but still usable (`dataQuality.stablecoinsCacheStatus === "degraded"`, currently legacy-array payloads only)
  - exact stablecoin publication coverage is unknown, has a count mismatch without IDs, omits any material/unverified asset, or exceeds the three-immaterial-ID breadth margin (`getStablecoinPublicationImpactStatus`); one to three proven-small omissions retain `stablecoin_publication_incomplete` as an info cause and the public `stablecoin-publication-incomplete:<ids>` warning without degrading health
  - exact active-price coverage is unreadable or has a day-old gap on a material asset (`activePriceCoverageImpactStatus === "degraded"` from `active_price_coverage_unknown`, or from an unacknowledged alert-eligible gap at `generationsElevated` = 96 consecutive missing generations — one day at the 15-minute cadence, including gaps past `generationsCritical`); materiality uses the same $100M authority and dated last-known evidence policy below
  - `missingPriceRatio > 0.18`
  - `blacklistMissingRatio >= 0.01` (1%)
  - `onchainStaleRatio >= 0.1` when `onchainSupplyTrackedCoins >= 10`
  - `onchainDivergenceRatio >= 0.1` when `onchainSupplyTrackedCoins >= 10`
  - `reserveComposition.status === "degraded"`
- `healthy` with an info `blacklist_gaps_recent` cause when `blacklistRecentMissingAmounts >= <!-- GENERATED-START: status-blacklist-recent-watch-threshold -->5<!-- GENERATED-END: status-blacklist-recent-watch-threshold -->` (last 24h) but the missing share is below 1%: a burst of freezes awaiting amount recovery is a watch signal, not a degraded surface. The public `/api/health` blacklist impact uses the same ratio-only rule.
- Non-gating info causes `price_gap_reviews_expiring` and `reserve_feed_reviews_expiring` remind operators when a review currently acknowledging a missing price or matched stale/erroring reserve feed has `0 < expiresAt - nowSec <= STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC` (48 hours, inclusive, defined in `shared/lib/status-thresholds.ts`); dormant reviews are excluded. Each cause lists IDs by soonest expiry and links to [review renewal](./runbooks/review-renewal.md); reminders do not change public health or status transitions.
- else `healthy`

### Missing-price ratio bands (2026-04-13)

The `missingPriceRatio` thresholds were raised on 2026-04-13 to stop boundary flapping: the former 15.00% degraded boundary sat at the ~15% operating point (181 active stablecoins, ~26-27 persistently unpriced) and produced 3+ `healthy↔degraded` transitions a day from counting noise. The rule stays ratio-based as the active set grows.

| Band | Enter | Cause code | Severity | Drives `dataQualityStatus`? |
|---|---|---|---|---|
| elevated | ≥ 15% | `missing_prices_elevated` | info | no — advisory only |
| degraded | > 18% | `missing_prices_degraded` | warning | yes → `degraded` |
| stale    | > 45% | `missing_prices_stale`    | critical | yes → `stale`    |

The `missing_prices_elevated` info cause exists to preserve operator observability in the 15-18% band without forcing a visible status transition.

### Active-price gap duration bands (2026-09-21)

`missingPriceRatio` counts assets; it says nothing about how long a gap has lasted. Nine of 335 active assets (2.7%) sat below the 15% elevated band while `aznd-mu-digital` published a $16.3 M market cap with no accepted price for 5,957 consecutive 15-minute generations (~62 days). The duration dimension therefore escalates independently of the ratio, from the per-asset `consecutiveMissingGenerations` in the coverage payload and only for unacknowledged alert-eligible gaps. Every such gap is named; only a gap on a material asset (market cap ≥ `durationMaterialMarketCapUsd` = $100M, or unknown) changes the impact status:

| Band | Enter (consecutive missing generations) | `activePriceCoverageImpactStatus` (material asset) | `/api/health` warning |
| ---- | --------------------------------------- | -------------------------------------------------- | --------------------- |
| elevated | ≥ 96 — one day at the current `sync-stablecoins` cadence | `degraded` | `active-price-coverage-incomplete:<ids>` |
| critical | ≥ 672 — one week | `degraded` (never `stale`) | additionally `active-price-coverage-critical-duration:<ids>` |
| unknown continuity | prior coverage read failed or was malformed; streak is null with `streakUnavailableReason` | `degraded` for material unacknowledged gaps | `active-price-coverage-incomplete:<ids>`; no invented critical duration |

All three thresholds live in `STATUS_MISSING_PRICE_THRESHOLDS` (`generationsElevated`, `generationsCritical`, `durationMaterialMarketCapUsd`), and the shared verdict helper `assessActivePriceGapDuration` (`shared/lib/status-thresholds.ts`) derives both the public-health impact status and the evaluator's cause from the same evidence. The ratio bands above are unchanged and still drive the `missing_prices_*` causes. The duration dimension is a data-quality verdict, not an availability one. A material gap degrades `/api/health` and names the asset but never reports the surface stale (a 2026-09-22 release briefly did, turning the status page, browser probes and deploy acceptance stale over seven minor assets). Since 2026-09-23 a long-running gap on a sub-$100M asset is a named warning only, so one thin unpriced asset cannot degrade the whole application. When a material gap does degrade public health, the state machine records it under the dedicated public-impacting `active_price_coverage_duration_degraded` cause (`worker/src/lib/status/evaluation-rules.ts`), so the incident and its recovery stay in `/api/public-status-history`; the ordinary `active_price_coverage_incomplete` warning stays admin-only. A gap past the critical band is a catalog decision — re-source the price, add a reviewed price-gap acknowledgement, or retire the asset — rather than a fetch gap to wait out. See [Adding a Stablecoin](./process/adding-a-stablecoin.md).

Missing-price `affectedMarketCapUsd` is null if any affected asset lacks admitted current circulating supply; price counts remain observed independently. Explicit zero supply contributes zero, not unavailable.

Publication omissions and price-gap duration share `STATUS_MISSING_PRICE_THRESHOLDS.durationMaterialMarketCapUsd` ($100M). Current-generation caps are unscaled. An absent row retains `lastKnownMarketCapUsd`, `lastKnownMarketCapObservedAt`, and `lastKnownMarketCapSource` (`publication` or `supply_history`) in verbose and compact continuity; the payload's current `marketCapUsd` stays null. Materiality tests retained cap × `STATUS_LAST_KNOWN_MARKET_CAP_GROWTH_FACTOR` (2), never publishes that scaled value as a measured cap, and accepts evidence only through `STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC` (30 days inclusive). The month accommodates intermittent daily snapshots; doubling bounds growth risk. Missing, malformed, future-dated, or older evidence fails closed. `/api/health` adds no read: the producer seeds from its previous cache/supply clock, prior gap/publication clock, then one absent-ID-only `supply_history` read when needed; carried evidence never renews its date.

| Publication policy | Threshold / public impact | Cause severity |
| --- | --- | --- |
| Materiality authority | current cap ≥ $100M, or retained cap × 2 ≥ $100M | `stablecoin_publication_incomplete`: warning, degraded |
| Last-known evidence validity | 30 days inclusive, original non-future observation clock required | unavailable evidence: warning, degraded |
| Minor breadth margin | `STATUS_PUBLICATION_IMMATERIAL_MISSING_MARGIN` = 3; isolated upstream tail churn is advisory, four omissions indicate a breadth incident | one–three immaterial: info, healthy; more: warning, degraded |
| Unknown / unnamed count mismatch | fail closed immediately | warning, degraded |


`ActivePriceCoverageHealthSchema` in `shared/types/status/core.ts` is the single coverage wire authority. Unreadable current coverage has `status: "unknown"`, null counts/affected market cap/maximum streak and `unavailableReason` (`coverage-missing`, `coverage-read-failed`, or `coverage-malformed`). Data-quality ratios use independently readable cache rows rather than coercing those unknown counts to zero; cause metrics omit unknown values. A failed previous-generation read does not erase current measured gaps or restart their streak at one. Compact metadata retains null continuity and its reason, and reviewed acknowledgements are recomputed before warnings or provider escalation.

`dataQuality.sourceFailures` still records failed data-quality subqueries, but those failures now emit info-level causes and increment `summary.diagnosticIssueCount` instead of degrading `dataQualityStatus` on their own. Only the stablecoins cache remains a hard dependency in this path.

Mint/burn freshness classification (`computeMintBurnSyncFreshnessStatus` in `worker/src/lib/mint-burn-health-config.ts`) keys off the critical-lane sync age against a `60m` window (`2 * expectedIntervalSec`): `fresh` ≤ `60m`, `degraded` ≤ `90m` (1.5x), `stale` beyond — the same floor described under Availability status above. The file's `majorSymbols` default (`USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`) feeds backfill auto-select ordering; its `6h`/`24h` `MINT_BURN_STALE_WARN_SEC`/`MINT_BURN_STALE_CRIT_SEC` env defaults are not currently wired into the freshness bands.

The public `/api/health` lane now keys mint/burn freshness to the critical-lane sync timestamp / latest run status rather than raw event timestamps, matching the `/flows` semantics and avoiding quiet-period false stale alerts.

`dataQuality.onchainSupplyMonitoring === "unavailable"` renders in the quality cards and emits an info-level `onchain_monitor_unavailable` cause. This cause appears in the diagnostics watch list but does not affect health status.

`onchainSupplyTrackedCoins` now counts only stablecoins with at least one `onchain_supply` update inside the active monitoring window (`3d`). Older historical rows stay in D1 for audit/debug use, but they no longer count toward `staleOnchainSupply` or `onchainStaleRatio`. Per-coin snapshots become stale after two `sync-kinesis-supply` producer cycles (eight hours at the current four-hour cadence), so a healthy multi-hourly lane does not create a false warning between runs.

Blacklist gap telemetry now also exposes operator diagnostics for historical recovery work:

- `blacklistOldestRecoverableAgeSec`
- `blacklistNeverAttemptedCount`
- `blacklistRepeatedFailureCount`

These fields do not currently change the health thresholds by themselves, but they make stranded historical gap cohorts visible in `/api/status`.

Ratio-based on-chain stale/degraded thresholds are also gated until the active monitor has at least `10` tracked coins. Below that floor, the admin still shows the live divergence/staleness counts, but those ratios are informational and do not by themselves escalate global status.

## Overall status

`rawOverallStatus` is the worse of `availabilityStatus` and `dataQualityStatus` (`healthy < degraded < stale`).

`overallStatus` is the **effective** status after hysteresis state-machine reconciliation:

At request time the admin advertises the worse of persisted `state.currentStatus` and live scheduler impact, without writing state. The hysteresis state below remains cron-owned; a stall can therefore become visible before the next status cron.

- `healthy -> degraded`: requires 2 consecutive raw degraded checks
- `healthy -> stale`: immediate on raw stale
- `degraded -> stale`: requires 2 consecutive raw stale checks
- `degraded -> healthy`: requires 3 consecutive raw healthy checks (+ dwell)
- `stale -> degraded`: requires 2 consecutive raw degraded checks (+ stale dwell)
- `stale -> healthy`: requires 3 consecutive raw healthy checks (+ stale dwell)

`/api/health` evaluates current public-impact evidence directly and fails closed when required evidence is unreadable; it does not reuse the persisted effective state. A newly degraded sample can therefore make `/api/health` and the public `/status/` page degraded while `/status.overallStatus` remains healthy until the second consecutive status self-check. The desktop `Resources` menu's status row follows `/api/health`, while operator diagnostics expose both the raw and effective states.

Additional response fields:

- `confidence`: normalized status confidence (0.1–1.0)
- `causes`: structured trigger list (`availability`, `dataQuality`, `overall`)
- `state`: state-machine counters and thresholds
- `staleness`: freshness of status-system evaluations
- `probe`: latest synthetic probe aggregate
- `discrepancy`: divergence between effective status and synthetic probe status
- `timeline`: recent status transitions
- `telegramBot`: admin-only Telegram bot subscriber aggregates (`null` when Telegram tables are unavailable)
- `datasetFreshness`: confirmed output/publication clocks for operational domains; `DATASET_FRESHNESS_TARGETS` in `worker/src/lib/status/derived-data.ts` owns the table, publication-pointer, and cron-output evidence for each field
- `summary`: compact availability and diagnostics rollup (`unhealthyCrons`, `availabilityImpactingUnhealthyCrons`, `watchUnhealthyCrons`, `degradedCrons`, `cronErrors`, `availabilityImpactingCronErrors`, `availabilityImpactingConsecutiveCronErrors`, `staleCronArtifacts`, `expiredCronLeases`, `orphanedCronProgressRows`, `diagnosticIssueCount`, `worstCacheRatio`, `transitionsLast24h`)
- `producerHeads`: one row per canonical schedule/job/path/kind, including budget-only paths, with separate last invocation/completion, productive output, publication, invocation ID, Worker version, and observed/missing state
- `workerVersions`: independently verified public/heavy activation markers; nullable evidence, not inferred current execution versions.
- `/api/status` intentionally omits the legacy top-level `gtProbe`, `priceProviderDiagnostics`, `cacheBlobSizes`, and `alertBroker` projections. The retired alert-broker summary is neither assessed nor published on any surface; DB and capacity health floors remain authoritative.

## Cron error escalation

Availability escalation on cron errors follows a transient-vs-sustained split:

- A **single** fresh failed run on an availability-critical cron (the `statusImpact: "critical"` cohort in `shared/lib/cron-jobs.ts`, including yield publication) surfaces as a `cron_error_runs` **warning** and sets `availabilityStatus` to `degraded`, unless a fresh in-flight recovery or proven-satisfied readback supersedes it.
- **Two or more consecutive** failed runs on the same critical cron escalate to `stale` via `summary.availabilityImpactingConsecutiveCronErrors > 0`.
- Multiple critical crons simultaneously unhealthy (`summary.availabilityImpactingUnhealthyCrons >= 2`) also escalate to `stale`.
- Cache-age stale (any cache whose override-aware impact status is `stale`, per `getCacheImpactStatus` / `getCacheRatioThresholds`) and the `publicAvailabilityFloor` (circuit outages, mint/burn sync stale, D1 capacity pressure) paths remain unchanged.
- `reserveComposition`: live reserve coverage and recovery summary (see [Live reserve sync health](#live-reserve-sync-health)). An unacknowledged persistently stale independent feed keeps the status at least `degraded`; matched operational reviews preserve the raw stale list but exclude their matched contributions from the health cohort.
  Failed overview reads instead return `status: "unavailable"`, `reason: "reserve_composition_query_failed"`, and null observations (including counts, ratios, arrays, queue flags and clocks). `reserve_sync_query_failed` is a warning that degrades data quality; neither an empty healthy cohort nor a retained generation is invented. A successfully read empty cohort retains genuine zero observations.
  Status evaluation preserves that unavailable branch without running numeric coverage or stale-feed array rules, so a failed reserve read still returns the degraded status response rather than aborting the endpoint.
  The `shared/lib/status-reserve-composition.ts` factory owns this unavailable shape for Worker evaluation and status contract fixtures.
- `liquidityHealth`: admin-only DEX liquidity coverage summary derived from the newest `sync-dex-liquidity` run that actually carries `metadata.sourceCoverage`, within that cron's `2 * expectedIntervalSec` freshness budget. The half-hourly cadence only remeasures once per hour, so the cadence-reuse `skipped_neutral` partner run persists `sourceCoverage: null`; the supplement falls back to the previous `ok` run's measurement instead of publishing `null` beside a populated cron entry. `sourceRunStartedAt` names the run the numbers came from, and a sync stalled beyond the budget publishes `null` — no stale coverage presented as current.
- `yieldHealth`: admin-only yield health summary sourced from existing cache rows and cron metadata (`yield-rankings`, `yield:supplemental-sources:v1:*`, `yield-coverage-audit`, and `sync-yield-data`). It reports ranking count/update age, previous-vs-current ranking-count delta, live-safety hydration coverage, per-family supplemental cache age, per-key benchmark registry health, coverage-audit age, source-risk field coverage, comparison-anchor freshness, latest cron status, a field-level status, status-impact class, and the yield runbook link. The retired legacy USD-only `benchmark` projection is no longer published.
- `publicationHealth`: admin-only read-only publication generation summary for `dex-liquidity`, `yield-rankings`, `stablecoins`, `dews`, `psi`, and `safety-score-v9`. The V9 surface is derived from the canonical `report-cards:v9` publication and matching publication-health row; it does not consult the retired V8 compact cache.
- `dependencyHealth`: admin-only derived dependency matrix built from existing `caches`, `crons`, and `publicationHealth` plus `shared/lib/data-dependency-registry.ts`. Cache-backed signals use the same override-aware availability ratio bands as public cache health, so `maxAge` remains a baseline rather than an immediate stale cutoff; producer-source degradation remains independently visible. It groups degraded/stale downstream symptoms under the most likely stale upstream dependency (for example DEX liquidity -> DEWS/report-card/redemption symptoms) without changing `availabilityStatus`, `dataQualityStatus`, or publication behavior.
- `canaries`: permanent admin-only diagnostics, selecting the latest structural row per active ID in the selected `status`/`alert` mode, not an atomic generation. `expectedCheckIds`, `presentCheckIds` and `missingCheckIds` name the nine-ID roster; `totalChecks` is the present count. Retired IDs are excluded. Only complete, fresh, valid-clock observations with known completed execution and clean findings are healthy. Per-check `executionStatus`/`executionFailureReason` separate measurement from severity; `completedCount`, `failedCount` and `unknownExecutionCount` preserve legacy unknowns. In `status`, severe completed findings stay severe in the ledger while cron reports `ok` plus quality; failed reads/cohorts/persistence remain non-ok. `off`/`shadow` expose empty/unknown evidence. The approved final policy is `off|status`; old-mode rejection remains gated on deployed-override inventory as documented in [Worker infrastructure](./worker-infrastructure.md). Checks cover DEX publication/global identity, blacklist identity, active coverage, PSI/DEWS, canonical accepted/held V9 and USD/GBP benchmarks using shared freshness authority. None supplies score/availability authority or condition-specific push escalation.
- `worker_canary_runs` retention is 14 days; the current status reads only active check IDs and does not depend on older retained rows.
- `coingeckoPriceDiff`: admin-only live CoinGecko comparison summary for active tracked assets with `geckoId`, including the compare count, mismatch count, threshold, and the flagged rows where the Pharos reported price is more than 5% away from a freshness-qualified CoinGecko spot quote
- `d1Usage`: permanent admin-only D1 telemetry (`databaseSizeBytes`, `numTables`, `readReplicationMode`, 24-hour query/row volumes) plus `capacity` and API-only cached `tableGrowth`. Normal responses reuse the 15-minute producer snapshot (30-minute TTL), with live fallback when missing/stale. The daily reviewed-name/family census reports rows, deltas, nullable timestamp attribution, top growers and `failedTables`; invalid/missing counts never become zero. It is served for at most 50 hours; partial failures preserve the rest of the measured cohort. Row counts are not disk sizes and the cohort is not the full database table count.
- `reserveDrift`: permanent curation watchlist, sorted descending, for fresh independent live/curated collateral-score differences above 15 points. Successful clean measurement is `[]`; unavailable/failed reads omit it and expose `sectionErrors.reserveDrift`. Triage shows Unknown on absence/error, not zero. The Metadata Integrity card is its sole detailed list; the score-input panel retains reserve-health explanations without a duplicate table.
- The duplicate runtime classification-warning list, schema, and error path are retired. Custody calculations, governance labels, scores and the broader catalog classification invariant remain unchanged.

For event-backed domains, `datasetFreshness` follows confirmed writer output rather than the latest emitted event, so quiet periods do not look falsely late. The cron-backed fields use `CONFIRMED_CRON_OUTPUT_AT_SQL`, not simply the latest `ok` attempt:

- `blacklist`: confirmed `sync-blacklist` output, not `MAX(blacklist_events.timestamp)`
- `mintBurn`: confirmed critical/extended mint-burn output, not `MAX(mint_burn_events.timestamp)`
- `depegs`: confirmed `sync-stablecoins` output, not `MAX(depeg_events.started_at)`

The `dex_pricing_bridge_stale` diagnostic compares the `dex-liquidity` dataset publication age with its descriptor's endpoint budget (14,400 seconds; the exact boundary remains eligible). Its `dexLiquidityAgeSeconds` metric does not measure individual `dex_prices` observations, whose independent trust window remains 4,500 seconds.

The `dews_downstream_of_dex_liquidity` diagnostic groups the DEX lane's upstream failure under `dews` once the `dews` cache is outside its own published band and the `dex-liquidity` cache is more than twice its availability budget (`maxAge`, 43,200 seconds) behind. It always emits `warning` severity, and a DEX lane inside that multiple stays silent even when both caches are unhealthy.

`dataQuality` now also exposes:

- `stablecoinsCacheStatus`: `ok | degraded | error`
- `stablecoinsCacheReason`: machine-readable reason when the stablecoins cache is unavailable or transitional
- `stablecoinPublication`: active-stablecoin publication coverage (`complete | incomplete | unknown`) with expected/present/waived counts and missing active IDs
- `blacklistGapStatus`: `ok | failed`
- `activeDepegStatus`: `ok | failed`
- `onchainSupplyQueryStatus`: `ok | failed | unavailable`
- `repairDebt`: structured repair/backfill backlog summary (`status`, `openCount`, `oldestAgeSec`, `byKind`, `availabilityEscalated`, `nextRunnerDueAt`, `source`) from active `worker_repair_tasks` rows.
- `ddrRepairDebtStatus` / `ddrRepairDebtCount` / `ddrRepairDebtEvents`: backward-compatible DDR-specific repair-debt fields derived from active DDR task rows (`subject_id` and `payload_json`).
- `sourceFailures`: list of failed best-effort subqueries with machine-readable source keys and error messages

This stops `/status` from treating a broken stablecoins cache as `0 / 0` healthy price coverage.

When one of those best-effort subqueries fails, `/api/status` keeps unaffected status lanes healthy, records the issue under `sourceFailures` / `sectionErrors`, increments `summary.diagnosticIssueCount`, and renders the affected card as diagnostic amber instead of silently showing a misleading `0`.

Cache freshness for `dex-liquidity`, `yield-data`, and `dews` prefers producer-owned `cache` sentinels (`freshness:*`). Without an admitted sentinel, DEX-liquidity and yield-data try legacy table freshness queries, then the latest confirmed producer-output timestamp (`CONFIRMED_CRON_OUTPUT_AT_SQL`) if the table clock is absent or the query fails. DEWS instead reads `dews:published-generation`; a missing, invalid, or unreadable pointer does not use cron fallback, so freshness remains unavailable and public cache impact is `stale`. Lookup failures also add a `cache_freshness_query_failed` info cause; that cause does not suppress the cache availability floor.

`sync-yield-data` writes its sentinel inside every applied rankings publication batch, regardless of input quality. The sentinel's `generationId` and `updatedAt` match the winning rankings generation; CAS losers and failed batches cannot advance it. Coverage below 0.75 still gates quality via `safety-snapshot-coverage`; a held safety snapshot uses the nongating `safety-snapshot-held` advisory without renewing the safety clock or permitting destructive cleanup.

**Per-cache availability overrides.** Availability ratio bands are the global `>8x` degraded / `>12x` stale by default, except where `STATUS_CACHE_RATIO_OVERRIDES` in `shared/lib/status-thresholds.ts` tightens a specific cache. `yield-data` overrides to `>2x` degraded / `>4x` stale against its post-V9 `sync-yield-data` budget: two missed publishes flip the cache entry to `healthy:false` and degrade both public cache impact and the availability `statusFloor`, while a single missed publish stays healthy. This closes the honesty gap where the global bands let multi-hour-stale yield rankings still read publicly `healthy` even though the admin endpoint-budget lane already flags the lane at 1x. The override is threaded through `getCacheFreshnessStatus`/`getCacheImpactStatus` (public rollup in `shared/lib/public-health.ts`), the worker `buildCacheStatuses` `healthy` and `statusFloor` computation, and the status-page recompute in `src/lib/status/public-status.ts`; all other caches keep the global bands. See `docs/architecture.md` ADR-9.
Public Cache Freshness and admin Reliability cache mode preserve each key through `getCacheImpactStatus`: `yield-data` uses `>2x` / `>4x`, fresh cached fallback is degraded, and unavailable age/budget remains Unknown in Reliability.

**Sentinel-backed cache verdicts name their band (R3).** `healthyMaxRatio` is `12` by default and `2` for `yield-data`; `healthyMaxAge = maxAge × healthyMaxRatio`. An admitted age within that ceiling is necessary, not sufficient, for `healthy`: producer quality must also be explicitly clean. An age-fresh fallback or unreadable quality can publish `healthy: false`. FX uses its separate source-provenance and expected-peg admission gates. Public cache availability uses `getCacheImpactStatus` independently of those quality fields.

The public `/api/health` companion endpoint now returns a `warnings` array for these best-effort failures, and the status page model treats that as additional public-health context instead of assuming zero-like data is real.

## Live reserve sync health

`reserveComposition` is derived from:

- coins with `liveReservesConfig`
- `reserve_composition`
- `reserve_sync_state`

Behavior:

- bootstrap suppresses freshness/coverage gates until the first successful live reserve sync; uncertain writes or a materially deferred tail still take precedence and return `degraded`
- only matched `reserve_composition` + `reserve_sync_state.last_success_at` pairs count as live snapshots; orphaned or split-write rows lack a live snapshot and follow the stale/error/missing classification
- coins currently failing before their first successful snapshot count as `errorCoins`, not `missingCoins`
- reserve health uses the matched-review-adjusted cohort, retaining the unchanged floors:
  - uncertain writes or a run-budget-truncated deferred share of at least 0.25 return `degraded` first
  - otherwise bootstrap or an empty health cohort is healthy; a nonempty post-bootstrap cohort with zero fresh feeds is stale
  - remaining cohorts degrade below 0.75 fresh coverage, below 0.5 authoritative coverage, or for an unacknowledged persistently stale independent feed
- low raw counts of degraded/missing reserve feeds no longer degrade `dataQualityStatus` on their own if coverage remains above those thresholds
- the page renders a dedicated `Live Reserve Sync` card in the pipeline lane
- an unavailable reserve overview renders **Unavailable / Unknown** in Live Reserve Sync, Score impact, triage and pipeline readiness; it never renders 0% coverage or a clear recovery queue
- the card also breaks fresh clean snapshots into evidence-quality cohorts: `independentFreshEligible`, `independentFreshUnverified`, `staticValidatedFresh`, and `weakProbeFresh`
- `persistentlyStaleIndependentCoins` retains the complete raw list; `unacknowledgedPersistentlyStaleIndependentCoins` owns its health gate. `healthConfiguredCoins`, `healthFreshCoins`, and `healthAuthoritativeFreshCoins` exclude each matched review's actual contribution. `acknowledgedFeeds` carries reason, evidence, owner, review date, and expiry; expired/invalid IDs re-arm gates and emit info causes even on otherwise healthy observations.
- Matched in-use reserve reviews also emit `reserve_feed_reviews_expiring` during their final 48 hours, without changing reserve status; [review renewal](./runbooks/review-renewal.md) preserves the raw quarantine and automatic gate re-arming at expiry.
- `writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path, meaning ops should treat the authoritative state as ambiguous until the next clean run
- `runBudgetTruncated`, `deferredCoins`, `deferredAt`, and `nextCursorStablecoinId` expose whether the latest live-reserve run stopped at its internal budget and where the next run will resume
- `adapterReliability` is a 30-day per-adapter rollup over `reserve_sync_attempt_history`, with `successRate = ok / attempts` and rows ordered by attempts descending. It is retained with the 15-minute self-check snapshot and rendered on the `Live Reserve Sync` card.
- `hasReserveScoreInputHold` in `shared/lib/status-thresholds.ts` owns the shared hold banner: non-healthy status, deferred/truncated/uncertain work, authoritative coverage below 0.5, or null required evidence triggers a hold. Coverage below 1.0 alone does not.
- the per-coin attempt timeline is admin-API-only (`GET /api/reserve-attempt-history?coin=<id>&limit=<n>`), returning the last-N attempts newest first, with status, failure category, warning codes, last error, and duration parsed from `metadata.durationMs` first or legacy `metadata.diag.durationMs` as fallback
- Data-quality causes include `reserve_sync_budget_truncated` and `reserve_sync_write_uncertain`; one-off low-share truncation is warning-level observability, while high-share truncation and uncertain writes can degrade reserve health before freshness collapses. Authority and history now commit atomically, so there is no history-gap producer or reconciliation cause.

## Yield health summary

`yieldHealth` is exposed on the admin `/api/status` payload and rendered by `YieldHealthCard` in the Pipeline lane. It does not read live upstreams and does not change yield scoring, source arbitration, methodology, or `/yield/` route behavior.

The [Yield Health threshold table](./runbooks/yield-health.md#threshold-table) owns the operator budgets, eligibility denominators, and per-surface escalation rules. This summary owns the status payload fields and their impact, not a second threshold table.

| Field | Source and unavailable evidence | Status impact |
| --- | --- | --- |
| `rankingCount`, `rankingUpdatedAt`, `rankingAgeSec`, `rankingStatus` | `cache["yield-rankings"]` payload + row clock; missing/malformed arrays or rows are `stale` with `rankingUnavailableReason`; validated empty arrays count as zero | Stale or missing rankings are public-critical; degraded rankings are watch-only |
| `safetyCoverage` | Cached publisher `provenance.safetySnapshot`; missing provenance is `unknown`, not a live-hydration measurement | Admin-watch |
| `supplemental` | Per-family `yield:supplemental-sources:v1:*` rows; missing/malformed envelopes are `unknown` with family `unavailableReason` and increment `missingFamilyCount`; validated empty families remain healthy | Admin-watch; optional source breadth |
| `benchmarkRegistry` | Used ranking keys + benchmark provenance; missing/unknown used keys stay explicit; fetched-but-unused keys are diagnostic only | Admin-watch; benchmark feed quality remains distinct from proxy selection |
| `coverageAudit` | `cache["yield-coverage-audit"]` payload + row clock; missing/malformed detector evidence is `unknown`; complete zero counts/empty arrays remain valid | Admin-watch; queue is read-only |
| `sourceRiskCoverage` | Selected and retained alternate `sourceRisk.*` evidence; missing/`unknown` venue tiers are evidence gaps, not high risk; empty eligible denominators are null | Admin-watch; evidence gaps do not make rankings stale |
| `comparisonAnchorFreshness` | Publisher metadata `sourceCoverage.comparisonAnchorFreshness`; missing metadata is `unknown`; stale examples are bounded and may be truncated | Field-level admin-watch, excluded from the aggregate `yieldHealth.status`; no scoring/arbitration/publication change |
| `latestCronStatus`, `latestCronStartedAt` | Publisher `lastRun`; absent run evidence is null, independently of metadata | Existing cron-health impact; no separate escalation |

A supplemental family without a cache-row timestamp is not admitted from its payload timestamp alone. Its status remains `unknown`, with null `ageSec` and `sourceCount`, `timestampReason: "missing-timestamp"`, and `unavailableReason: "supplemental-malformed"`; a missing clock never becomes an observed zero.

## Telegram bot metrics

`GET /api/status` includes a `telegramBot` block derived from:

- `telegram_subscribers`
- `telegram_subscriptions`
- `telegram_preset_subscriptions` (global all-stablecoin follows)
- `telegram_pending_disambiguation`
- `telegram_pending_alerts`
- `telegram_processed_updates` (webhook effect-state backlog)
- `telegram_recap_preferences` and `telegram_recap_targets` (recap telemetry)

It also folds in the lifecycle snapshot and delivery-SLI rollups (`telegram_alert_source_events`, `telegram_alert_job_targets`, `telegram_alert_dead_letters`) plus `cron_runs` (inactive-subscriber cleanup) and cached preset query-failure counters; `worker/src/lib/status/telegram-bot-stats.ts` is authoritative. Mini App usage (`telegram_usage_daily`) is not part of this block — it is served by `/api/telegram-pulse`.

Parsed dispatch suppression flags preserve three states: `true`, `false`, and `null`. Missing or malformed safety/reserve suppression telemetry renders as unavailable rather than making the positive claim that alerts were not suppressed.

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

## Synthetic self-check

The logical `statusSelfCheckOffset` lane runs `status-self-check`, `data-invariant-canary`, and `cron-sentinel` every 15 minutes. `shared/lib/cron-jobs.ts` owns its separate hourly physical trigger expressions; `shared/lib/scheduled-runner-registry.ts` owns the lane plan and budget-only work. The sentinel retains the freshness and digest-publication watchdog state keys, transition rules, 30-minute cooldowns, and operator-alert wording. Watchdog transitions commit only after successful operator-alert delivery; absent credentials, failed delivery, or cooldown suppression leave them pending. Weekly checks remain active after Monday's deadline using Monday-scoped state. Producer-adjacent modes own turnover/reserve observations; the daily mode owns duration, mint/burn growth, and repair debt. Public health reads nested daily growth/repair metadata with the retired growth row as a rollout fallback. Use the [canonical cron table](./worker-infrastructure.md#cron-scheduling) for cadence, physical aliases, Worker roles and slot identities; the runner registry owns job chains and budget-only work.

Every sentinel run publishes `metadata.mode` and a first-class `metadata.sourceStatuses` map. Non-`ok` runs with attributable current-source evidence use `metadata.reason: <mode>:<source>:<status>`; no current evidence yields `<mode>:no-current-source-evidence`. `metadata.ruleIds` inventories every registered source across modes, including non-current states; conditions live in `worker/src/cron/cron-sentinel-rules.ts`. The daily invocation is reached only through `runDailyCronSentinel`; `runCronSentinel` dispatches the status, turnover, and reserve-post-sync modes.

`metadata.firedRuleIds` records only fired predicates from current sources, unlike the configured `ruleIds` inventory. The sentinel preserves the worst current-source status; thrown evidence reads/writes remain failures. Malformed retained state is an error while current, but after expiry remains visible with `lastStatus: error` without affecting aggregate status or quality. An attempted failed operator alert is `operator-alert-delivery-failed`; cooldown and absent credentials leave transitions pending without failing execution.

Stale-slot cleanup no longer has a status-tracked sweeper job. Every fenced scheduled invocation pre-sweeps stale prior rows for its own schedule key, and a same-slot takeover reconciles the displaced owner's artifacts before work resumes. The five-minute reserve-recovery lane retains the unscoped sweep so a killed lane is still discovered promptly. Reconciliation preserves real terminal child rows, classifies incomplete children from durable progress, lease, cron-history, and producer-publication evidence, and writes `scheduled-slot-abandoned` event markers without deleting a renewed or newer owner.

`status-self-check` then:

1. Probes critical public reads and selected admin read endpoints in two explicit planes:
   - internal self-check probes use router-dispatched `GET` requests when a Worker `ExecutionContext` is available. They exercise handler routing and dependency hydration for app/router isolation, but bypass the Worker HTTP access gate, public rate-limit gate, custom-domain routing, and edge-cache path. If the cron is invoked without `ExecutionContext`, the same self-check set falls back to real HTTPS probes against `SELF_URL`.
   - external production probes always use real HTTPS `fetch()` calls through the production custom domains with a 10s timeout per endpoint: `https://api.pharos.watch/api/health`, `https://site-api.pharos.watch/api/health` when `SITE_API_SHARED_SECRET` is configured, a `site-api.pharos.watch` access-gate probe expecting `401` or `403` when that shared secret is absent, and `https://ops-api.pharos.watch/api/status-history?limit=1`.
   - the ops API canary expects a blocking response (`302` or `403`); a successful open response is treated as `ops-api-access-gate-open-or-unreachable`. This smoke accepts any redirect Location and does not verify Access identity or authenticated ops availability. The site target likewise proves only negative-auth gating when the trimmed shared secret is absent.
   - internal-router timings reflect uncached worker handler execution, not browser-visible edge-cache latency. External timings reflect the production edge path.
   - `/api/health` is parsed semantically: valid `200` bodies with `status: degraded|stale` set `ok: false` / `error: reported-degraded|stale`, contribute semantic status and `details.failed`, but are excluded from connectivity counts. Discrepancy increments only on effective/probe divergence. Separate `transportStatus` and `semanticStatus` accompany combined `probeStatus`. Invalid payloads, failed/access-gate probes and exceeded transport bands remain `probe-execution-failed`. `/api/status` is evaluated separately through `computeRawStatus()` and `reconcileStatusState()`.
   - `semanticStatus` is `null` with `semanticStatusReason: probe-semantic-evidence-unavailable` when no admitted health result was observed. Broken payloads or failed transport cannot create a positive semantic claim. The rotating internal and fixed external populations are unequal; plane divergence supports triage, not causal outage or paging inference.
   - cache-backed bootstrap probes (`/api/usds-status`, `/api/bluechip-ratings`, `/api/yield-rankings`) suppress internal-router `503` failures when both the permanent observed marker and retained producer cron rows are absent. The marker is seeded only on this `503` path, so pruned history can misclassify a previously run producer; no-context HTTPS fallback does not apply bootstrap suppression.
2. Persists probe aggregate to `status_probe_runs`.
3. Reconciles raw status into persisted effective state.
4. Tracks divergence streak and probe-failure streak in `status_discrepancy_state`.
5. Exposes the sustained-divergence and sustained-probe-failure streaks as `discrepancyStreak` / `probeFailureStreak` in the cron metadata, alongside the internal/external comparison so operators can separate app/router regressions from custom-domain, Access, routing, cache, and edge-path regressions. There is no outbound alert transport; escalation is operator-driven from the status surfaces.
   - A failed discrepancy SELECT stops before UPSERT and exposes both counters as unavailable (`null`); a successfully read absent row may initialize counters. The UI prints an unavailable streak explicitly. Probe-failure streak means transport/contract failure **or internal/external divergence**, not transport failures alone; effective/probe divergence is a distinct diagnostic. Neither changes status authority or emits a condition-specific push notification.

All four required stores (`status_probe_runs`, `status_state`, `status:raw-snapshot:v1`, `status_discrepancy_state`) must succeed, including required reads. Failure returns `status-self-check-persistence-failed`, lists `failedOutputs`, and sets `outputPublishedAt: null`; this takes precedence. Explicit `evidenceReadFailures` collect current DB, cron, scheduler, public-health, data-quality and supplement outcomes, independently of presentation error wording; failures return `status-self-check-evidence-read-failed`, not a semantic service finding. Hysteresis and probe thresholds are unchanged.

The cron metadata now includes:

- `probeMode` / `probeBaseUrl`
- `probePlanes.internal` / `probePlanes.external`, each with status, counts, p95 latency, and observed origins
- `internalExternalDiscrepancy`, with `reason` values such as `in-sync`, `external-worse`, and `internal-worse`
- Bootstrap misses are persisted in `status_probe_runs.details.bootstrapMisses`; they are not returned as a top-level cron metadata field.
- `freshnessDiagnostics` when raw status had to fall back from a freshness sentinel to table or cron evidence
- `latencySummary` (`minMs`, `medianMs`, `p95Ms`, `maxMs`): shared conventional median averages even middle pairs; p95 uses shared nearest-rank (95), including classification. Empty connectivity populations remain stale, not healthy zero-latency observations.
- `slowestProbes` (top slow endpoints for the run)

A freshness sentinel records **which generation is served** (R3), never whether
that generation's inputs were clean. Input quality travels beside it, on every
sentinel-backed cache status: `degraded`, `degradedReason`
(`freshness-sentinel-missing` / `freshness-sentinel-unreadable` /
`freshness-sentinel-invalid:<reason>` / the latest producer quality reason, falling back to `producer-quality-reason-unavailable`)
and `streakDegradedRuns` (`null` when the producer-history read failed — an
unreadable streak is never published as `0`). A failed producer-history read
itself publishes `degraded: null` with `degradedReason:
"producer-history-unreadable"` (rules R2/R4): unreadable quality evidence is
unknown, never clean, even behind a valid in-budget sentinel. A cache is
`healthy` only when it is inside its band **and** its quality verdict is
explicitly clean, so a table fallback that is age-fresh, a good sentinel whose
producer has degraded since, and a good sentinel whose quality evidence could
not be read all publish an unhealthy lane. `/api/health` folds the quality
verdict into its own `status` and names it in `warnings` as
`cache-quality-degraded: <key>:<reason>` for degraded evidence or
`cache-quality-unknown: <key>:<reason>` for unreadable evidence;
`/api/status` availability keeps measuring freshness alone.

Cron sentinel sources are a distinct control-plane aggregate. Every source stays visible in `sourceStatuses`
and `sources`: expired observations expose `status: "expired"`, `lastStatus`, `observedAt`, `intervalSec`,
and `maxAgeSec`; never-observed and explicitly disabled sources are distinguished as `missing` and `disabled`.
At exactly two producer intervals (capped at 48h), evidence still contributes; beyond that budget it has
**no automatic aggregate status or quality impact**. Another mode cannot erase current findings, and a neutral
or locked skip does not renew a source clock. Source intervals derive from `CRON_SCHEDULE_CADENCES`.

`GET /api/status` returns the latest persisted aggregate in `probe`. New rows include optional `probe.internal`, `probe.external`, and `probe.internalExternalDiscrepancy` fields read from `status_probe_runs.details_json`; legacy rows omit those optional fields.

`GET /api/status-probe-history` was retired on 2026-08-09. `status_probe_runs` still stores one aggregate per cycle. Direct D1 reads expose `created_at`, `status` and a bounded detail sample in `details_json`, not exhaustive per-path pass/fail history:

```sql
SELECT created_at, status, details_json
FROM status_probe_runs
WHERE created_at >= CAST(strftime('%s', 'now') AS INTEGER) - 7 * 86400
ORDER BY created_at DESC
LIMIT 3000;
```

`details_json.failed` contains the **first ten non-ok observations**, including valid semantic `reported-degraded|stale` findings as well as transport/contract failures. Entries carry path, status, error and latency; absence is not proof that a path succeeded or was sampled. Aggregate `sampleCount`, `passCount` and `failCount` use the full population before this display cap; valid semantic findings are excluded from connectivity counts, so pass + fail need not equal sample count. Probes run every logical 15 minutes.

Those rows are pruned by `prune-status-probe-runs` (`worker/src/cron/prune-status-probe-runs.ts`) in the registry's `daily0300Utc` logical slot (`0 3 * * *`), currently dispatched by the physical `3 3 * * *` trigger. Anything older than 90 days is eligible. Each run deletes at most 10,000 oldest eligible IDs through one subselect-capped DELETE; at 15-minute cadence steady state is about 8,600 rows. The job touches only `status_probe_runs`; transition history and live discrepancy counters are retained independently.

`status_discrepancy_state` persists the divergence and probe-failure streaks:
`consecutive_divergent`, `last_divergent_at`, `consecutive_probe_failures`, and `last_probe_failure_at`.
The retired `last_alert_at` / `last_probe_alert_at` columns remain physically present but have no live code/test-mock use. Their class-(i) drop follows C10 in `worker/migrations/MANIFEST.md`: compatible public/heavy/private/external/rollback deploy-and-soak/floor evidence, fresh all-scope zero-use and bounded inventory, a verified pre-window Time Travel bookmark, and separately approved maintenance/recovery. Preserve every row, scope key, live counter and timestamp with before/after comparison. Indefinite R2 export and a restore receipt are not required for class (i). No sender is reintroduced.

## History endpoint (`GET /api/status-history`)

Admin machine-readable timeline endpoint for internal tooling and incident audits.

Response includes:

1. persisted state snapshot
2. status-system staleness
3. latest probe aggregate
4. discrepancy summary
5. transition list (`limit` query param, max 200)
6. `hasMore` completeness evidence (`true` when another matching row exists, `false` for a complete matching window, and `null` when completeness could not be determined)

The incident-history workspace makes negative deployment-correlation statements when history data exists, the query has no error, and `hasMore === false`. This proves completeness, not freshness: cached data remains eligible during background refetch or after the query freshness window expires. Row-limited, failed-refetch retained, fallback, and indeterminate results keep correlation Unknown.

Absent state authority yields `status-missing`; unreadable authority yields `status-unreadable` plus `sectionErrors.state`. Both discrepancy comparisons have null status severity/delta, never an invented healthy/in-sync verdict. Probe read issues are separately exposed in `sectionErrors.probe`.

Delivery status is request-time evidence, but transition history is cron-sampled. A stall and recovery entirely between status observations cannot create invented historical transitions; the external monitor's issue/run is separate incident evidence.

---

## Endpoint Probing

Source: `src/hooks/use-endpoint-probes.ts`

- Probe timeout: 5s for public endpoints and 20s for browser admin probes. Pages proxy budgets come from endpoint `opsProxyTimeoutMs` metadata: 20s for status/history, 330s for the yield coverage audit, and 10s by default. The audit is a manual action, not an automatic browser probe; upstream timeout returns `504`.
- Bounded browser probing uses a worker pool capped at 6 concurrent requests (`ENDPOINT_PROBE_CONCURRENCY`), with `Promise.all` only coordinating those workers rather than fanning out every endpoint at once.
- Admin probe paths are now same-origin `/api/admin/*` calls on the ops host
- The dashboard labels these as **browser-origin probes** to distinguish them from the worker-origin `status-self-check` synthetic probe stored in `/api/status`
- Parameterized routes should probe `probePath` values from registry (for example `/api/mint-burn-events?stablecoin=usdt-tether`) to avoid expected `400` validation responses.
- The stablecoin-detail probe also uses a curated canary `probePath` rather than the heaviest history payload, so route-health checks are less sensitive to oversized per-coin datasets. Its expected `refresh scheduled` stale-while-revalidate warning remains transport-healthy for at most two cache TTLs when `X-Data-Age` is valid; older scheduled refreshes, missing age evidence, explicit `refresh failed` warnings, and other freshness warnings remain stale.
- Routes without a stable canary URL are intentionally excluded from automatic probe coverage. `GET /api/digest-snapshot` is omitted because it requires a valid `date` that must map to a real stored digest; dated public snapshot detail routes are omitted because valid dates come from `GET /api/snapshots/index`.
- Returned result shape: `{ path, status, latencyMs, error?, semanticStatus?, semanticScope?, semanticDetail? }`

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

Status-page manual actions are router-dispatched from shared endpoint metadata (`shared/lib/api-endpoints/`). The catalog is every endpoint carrying `statusPageAction` in `shared/lib/api-endpoints/definitions.ts`.

The UI uses these actions in two ways:

- a searchable intent/risk catalog in the `Actions` workspace
- contextual recommendations derived from blocking causes and availability-impacting cron lanes (`Recommended now`)

The catalog groups inspect, dry-run, recovery, communication, and destructive behavior. Shared endpoint metadata is canonical for risk, scope, prerequisites, expected duration, dry-run support, result mode, and audit ownership. Single-asset execution uses the tracked client registry picker and derives the endpoint's canonical stablecoin ID or symbol from that selection; arbitrary free-form targets are not accepted. One provider-owned execution dialog handles confirmation, readiness, direct dry run, structured results, raw debugging output, and focus restoration.

Mutations keep one `Idempotency-Key` per intent: double submission coalesces, replay reuses the result, uncertain retries retain the key, and new intents get new keys. The proxy preserves `Idempotency-Key`, `X-Idempotent-Replay`, and `X-Execution-Certainty`. Unknown results always say “Outcome needs reconciliation” and failed results “Action failed”, even with no structured body; absence never proves completion.

Handler-dispatched operator catalog actions are audited in `admin_action_audit`, including handler validation failures, errors, unknown execution, and idempotent replay. Internal probes, payload-conflict replays, and method/access rejections before dispatch are outside this ledger. The wrapper stores allowlisted metadata and a hashed intent identity, never credentials or raw bodies. The active baseline's nullable intent key and partial unique `(action, intent_key)` constraint let replay backfill a missing row without duplicating the execution.

An unconfirmed handler response at HTTP 5xx after idempotent execution has started is returned as `execution_unknown`; the Worker attempts to persist that terminal state. A successful write makes the same key replay it. If the terminal write fails, durable terminal unknown evidence is not guaranteed, but the started reservation remains the recovery fence. If the action result exists but its canonical audit write fails, the router returns `503 audit_persistence_failed` with the original idempotency key/replay marker and `X-Execution-Certainty: audit-incomplete`. Retrying that key replays the stored result and attempts to backfill the audit row without repeating the action.

`GET /api/admin-action-log?limit=100` feeds persistent execution history. The Actions and History workspaces reconcile it with current-session state, but session-only results remain explicitly labeled until the deployed backend can return their durable row.

Persisted audit coverage boundary (intentional):

- Catalog actions are audited after handler dispatch, subject to the exclusions above. A failed audit write is surfaced as `503 audit_persistence_failed`, not proof of durable history; reaching the Worker alone does not establish audit coverage.
- Executions that never reach the Worker (client network failure or abort before a response) can only exist as session-scoped entries; they are labeled `session` in the workbench and legitimately disappear on reload. Their idempotency key remains reusable for a safe retry that will produce the durable row.
- The remaining non-catalog operator mutation — `POST /api/admin-telegram-broadcast` — emits a handler-level `admin_action_audit` record; credential lifecycle mutations audit into `api_key_audit_log` instead and surface through the API Management and History workspaces. The other handler-audited operator routes (cron lease/kill controls, circuit-breaker reset, Telegram pending/resend/delivery-control) were retired on 2026-08-09, and the self-serve API-key request decisions (`api_key_request_reject`, `api_key_request_release_claim`) were removed with their lane on 2026-09-29; historical rows for all of them remain.

Historical rebuilds are no longer dashboard actions. Run the reviewed command from [One-shot historical backfills](./runbooks/one-shot-backfills.md); recurring repairs remain in the complete action catalog.

Mutating admin paths are protected by method guardrails:
- `GET` on POST-only mutating admin routes -> `405` with `Allow: POST`; `/api/backfill-dews` permits inspection GET without `repair` or with `dry-run=true`, while live repair remains POST-only
- missing or invalid action targets fail validation before handler dispatch
- uncertain execution returns `X-Execution-Certainty: unknown` and remains retryable with the same intent key

---

## Price Source Health Card

**Component:** `PriceSourceHealthCard` (`src/components/status/price-source-health.tsx`)

Renders in the Admin Pipeline `Markets` tab next to `LiquidityHealthCard` and the CoinGecko drift watchlist. Shows the current price confidence distribution for the active stablecoin catalog when the producer supplies an `active` breakdown; older snapshots are explicitly labeled as full-cache counts:

- **Confidence tiles** — raw counts for `High`, `Single-source`, `Low`, and `Fallback`, with severity based on their share of **priced circulating USD value** across all peg buckets. `High` is green at ≥90%, amber at ≥80%, otherwise red. `Low` is neutral below 1%, amber at ≥1%, red at ≥5%. `Single` and `Fallback` remain neutral. The 90/80% coverage floors and 1/5% low-exposure ceilings are reviewed operational thresholds, not statistical estimates or changes to pricing methodology. Legacy payloads without value sums use count-share text and neutral confidence colors.
- **Missing tile** — active assets with no usable price, including active catalog rows absent from the payload; this does not discard upstream missing-price rows. The tile number and severity count only **unacknowledged** gaps: the producer subtracts active assets covered by a valid, unexpired price-gap review (`STABLECOIN_PRICE_GAP_REVIEWS`), so an expired or malformed review automatically re-alerts on the next sync, and the sub-line shows how many gaps are acknowledged (0 green, ≤3 amber, >3 red on the unacknowledged count).
- **Value-share sub-lines** — confidence tiles show e.g. `96.5% of value` only when `supplyCoverage.complete === true`. Partial or legacy coverage keeps confidence severity neutral and uses asset-count percentages instead; the card names observed/unavailable supply members and labels any supported dollar sum as a known priced-supply subtotal. No observed supply renders priced supply unavailable, never a measured $0.
- **Source breakdown line** — which price sources contributed to the current sync, including protocol redemption quotes when they override thin market pricing
- **Source-depth distribution** — backend-only status metadata keyed by active canonical `consensusSources.length` buckets (`0`, `1`, `2`, `3`, `4`, `5+`)
- **Full-cache context** — original cache-wide row, missing, and confidence counts remain visible below the active tiles, including upstream assets outside the active catalog
- **Last sync age** — how old the price-health snapshot is

Distribution and confidence data comes from the latest `sync-stablecoins` cron metadata. Top-level distributions retain full-cache scope; `active` supplies catalog membership, confidence value subtotals, priced-value denominator, and reviewed missing counts. Markets and the Missing tile share acknowledgement subtraction and canonical missing-price severity, falling back to full-cache counts for legacy snapshots. Raw/acknowledged totals remain context, not alerts. The status supplement adds source-depth counts from active canonical cached assets; prices and confidence assignments are unchanged.

Monetary exposure fields are known subtotals. `supplyCoverage` names `complete`, `observedCount`, and `unavailableCount` over priced rows in the same scope. An unavailable supply is not measured zero; incomplete or legacy-unverified coverage must not certify full-cohort value shares or value-based severity. Explicit zero counts as observed.


**Calibration evidence (2026-09-23 review):** `high` means independent agreeing sources or a validated authoritative override; `single-source` also includes correlated two-list-aggregator agreement deliberately downgraded to avoid false corroboration. Neither source independence nor freshness is weakened by the display change. The original 85/70% row-share bands were moved into shared constants by `c71b109bf6` (2026-03-13); list-aggregator hardening predates the current incident (`49415ec28e`, 2026-04-17, already refactored that rule). Read-only production D1 history, retained for seven days, gave final daily samples September 15–22 at 34–40% high-confidence rows. September 22 intraday runs ranged from 93 to 133 high rows, with promoted-DEX availability varying alongside the count. This limited history does not establish a months-long baseline or rule out individual source regressions.

The public `/api/stablecoins` request required an API key, so the review read its canonical D1 `cache['stablecoins']` instead. In the later all-peg-bucket active snapshot, high confidence covered 134 assets and $323.27B (96.95% of priced value); single-source 167 assets and $9.77B (2.93%); low 19 assets and $391.03M (0.117%); fallback seven assets and $10.44M (0.003%). Eight missing assets held $37.66M and were excluded only from the **priced-value denominator**, not the missing count. Thus row-count red was not evidence of economically broad confidence failure. Value-weighted colors preserve a material-exposure alarm while counts and source breakdowns retain the long-tail and per-provider evidence. Missing-price health remains a separate signal; neither missing nor acknowledged assets are assigned invented prices.

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

Data is sourced from the admin-only `GET /api/status` payload. The worker supplement filters the cached stablecoin payload down to the active tracked assets with `geckoId`, batches a CoinGecko `simple/price` fetch with upstream timestamps, and compares only quotes accepted by the shared CoinGecko freshness validator. Missing, invalid, stale, or materially future timestamps are not comparable. Flagged rows are sorted by `diffPct` descending. When the CoinGecko lookup fails, the card degrades to `null` and the worker records `sectionErrors.coingeckoPriceDiff`.

## D1 Usage Card

**Component:** `D1UsageCard` (`src/components/status/d1-usage-card.tsx`)

Renders in the Admin Pipeline `Storage` tab beside pipeline freshness. It shows:

- current D1 database size
- current utilization state, with boundaries and health impact owned by [`docs/runbooks/d1-capacity-and-runtime-experiments.md`](./runbooks/d1-capacity-and-runtime-experiments.md)
- 24h, 72h, 7d, and 30d growth regressions with sample count and observed span
- next-threshold and exhaustion forecast from the shortest valid regression
- table count
- read-replication mode and region
- trailing 24-hour read/write query counts
- trailing 24-hour rows-read/rows-written counts

Data is sourced from the admin-only `GET /api/status` payload. Optional dedicated bindings (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_STATUS_API_TOKEN`, `CLOUDFLARE_D1_DATABASE_ID`) enable REST database info plus a concurrent trailing-24h GraphQL `d1AnalyticsAdaptiveGroups` query; missing bindings yield null and read/config errors surface through `sectionErrors.d1Usage`. Measurements normally run in the 15-minute self-check snapshot, valid for 30 minutes; browser polls do not each imply Cloudflare fetches. Live fallback can refresh hourly capacity history. Capacity observations coalesce by UTC hour; network fetches are not hourly-throttled. The card labels binary-scaled bytes KiB/MiB/GiB/TiB; Cloudflare's limit remains decimal 10 GB. The per-table census is **API-only**, not rendered by this card: same-UTC-day cache reuse under the cron lease, not a separate claim, with a 50-hour serving budget. Forecasts are advisory shortest-valid-window regressions; existing utilization thresholds remain health authority.

## Mint/Burn Reconciliation Card

The operator card is **Mint/Burn Integrity**, a permanent per-contract native conservation diagnostic. The API field name `mintBurnReconciliation` remains; `conservationVersion: 1` identifies the native verdict. Configured identities are enumerated independently of supply-cache/comparison availability. The unmatched circulating-supply comparison and unused native summary counts are retired without aliases; older payloads without native proof remain unverified.

### Matched-block integrity

The existing mint/burn producers write compact audit records into `cache` under `mint-burn:conservation:<configKey>`. Status reads these records in bounded batches; it never makes archive RPC calls. Each record identifies the contract, decimals, config fingerprint, audit time, exact block boundaries/hashes, raw mint/burn totals, supply delta and residual in native integer units. Raw events include amounts below the public cutoff and atomic/bridge activity.

A successful record proves the reviewed law exactly: by default, `rawMint - rawBurn = totalSupply(toBlock) - totalSupply(fromBlock)` for logs after the displayed opening checkpoint through the closing checkpoint; USDO instead records net raw shares against the `totalShares` delta (`units: "raw-shares"`). The card shows individual contract ranges; different ranges are not added into a fabricated coin-wide 24-hour audit. This is a latest-scan integrity check, not a proof of complete historical coverage or issuer reserves.

- **Verified:** every configured contract has an eligible, valid, matching-identity passing audit whose observation and closing checkpoint are both no older than 75 minutes, whose lane's latest completed scan is inside the public freshness window and ended `ok` or `degraded`, whose stored sync cursor is at or beyond the audit's opening block, and whose lane's observed chain head is at or beyond its closing block. The row's `coverageStatus` reports flow-coverage health separately: a config whose scan cadence is stretched by the extended lane's budget deferral can read `lagging` while its audited window remains verified.
- **Critical:** an identity-valid, arithmetically verified native mismatch remains unresolved. An unavailable later attempt does not clear it; verified recovery is required.
- **Unverified:** missing, stale, malformed, unsupported, partial or otherwise unusable audit evidence. A changed contract/config fingerprint cannot inherit a previous pass.

The committed evidence sidecar `worker/src/lib/mint-burn-conservation-reviewed.json` is the only list of admitted and explicitly unsupported identities, with per-identity reviewer evidence and audited windows for admitted entries. Exact identities and their conservation laws are reviewed explicitly; an `unsupported` entry carries a reason from the fixed vocabulary in `worker/src/lib/mint-burn-conservation.ts`, and unsupported configs remain visible and unverified. `m-m0` is explicitly unsupported (`rebasing-supply-without-events`) because its index accrues over time. Adding another asset requires proving a compatible law and adding the exact contract identity to the sidecar. A reviewed coin does not automatically admit a replacement contract.

The [reviewed alternative laws](./mint-burn-flows.md#raw-token-conservation) cover USDT `config-events` (Issue/Redeem plus conservation-only DestroyedBlackFunds, guarded by `deprecated()`), OUSD `transfer-plus-vault-yield` (Transfer net plus vault yield minus fee, with rebase pairing, saturation, identity and upgrade guards), and USDO `usdo-bonus-multiplier-shares` (multiplier replay, exact `totalShares` law and closing-view checks, recorded in raw shares). Conservation-only events are fetched in the same scan but never become public flow rows; public Mint/Burn Flow methodology is unchanged.

The API row retains `conservation`, `coverageStatus` and native `conservationIssue`; the summary retains `criticalCount`. Public flow classifications, dust thresholds, prices, market caps and Safety Scores are unchanged.

### Historical rationale for comparison retirement

The former completed-hour USD flow versus upstream daily circulation comparison used unmatched windows, scopes and valuations and is no longer queried, rendered or used for row ordering. Source history can be current-only and upstream daily boundaries can differ; no diagnostic threshold fixes comparability.

The September 15 investigation retrieved 3,115 raw mint/burn events for the frozen thirteen-asset cohort. All thirteen native conservation equations matched exactly, and all 1,627 retrieved eligible event identities matched stored records. USD1/USDS source windows spanned approximately 46 hours; small-event filtering and source circulation/valuation definitions explained why the legacy comparison could not establish an ingestion failure. Exact net equality alone cannot detect a provider omitting offsetting mint/burn pairs; the producer also checks retrieved eligible events against parsed output and reads back their stored native fields before publishing a pass. Existing scan coverage guards remain necessary.

Reviewed upstream definition differences remain explanatory context:

| Asset | Definition that prevents comparison | Evidence |
| --- | --- | --- |
| DAI | Supply adds internal DSR savings balances to ERC-20 supply | [Upstream adapter](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/adapters/peggedAssets/dai/index.ts) |
| USDD | Supply includes internal savings balances and legacy-token circulation | [Upstream adapter](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/adapters/peggedAssets/usdd/index.ts) |
| crvUSD | Circulating protocol debt changes independently of pre-minted inventory | [Upstream adapter](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/adapters/peggedAssets/crvusd/index.ts) |
| JPYC | Supply subtracts issuer and redemption wallet balances | [Upstream adapter](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/adapters/peggedAssets/jpycoin/index.ts) |
| EURCV / alUSD | Supply subtracts unreleased wallet balances | [Upstream registry](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/peggedData/peggedData.ts) |
| TRYB | Supply subtracts an unreleased wallet balance | [Upstream registry](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/peggedData/peggedData.ts) |
| frxUSD | Supply subtracts a treasury balance | [Upstream adapter](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/adapters/peggedAssets/frax-usd/index.ts) |
| fxUSD | Supply includes fstETH and ffrxETH contracts as well as fxUSD | [Upstream registry](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/peggedData/peggedData.ts) |
| M | Earning-index accrual changes supply without mint/burn events | [Token implementation](https://github.com/m0-foundation/protocol/blob/main/src/MToken.sol) |
| OUSD | Rebases change supply without mint/burn events | [Token implementation](https://github.com/OriginProtocol/origin-dollar/blob/master/contracts/contracts/token/OUSD.sol) |

The upstream-specific explanations apply only to DefiLlama supply; M/OUSD accrual is intrinsic to the token. Numeric source gaps are not thresholds fitted to make a row green. A separate issuer-circulation audit would need matched source observations plus treasury, bridge, debt and accrual adjustments. It must not replace the canonical public DefiLlama USD supply.

Producer behavior, budgets and recovery are documented in [Mint/Burn Flows: Raw token conservation](./mint-burn-flows.md#raw-token-conservation).

## Rendering And Refresh Contract

- No workspace owns a free-running root clock. Query evidence refreshes re-anchor the model; relative-time labels tick only inside `FreshnessIndicator` leaves.
- Collapsed disclosures mount content only while open, keeping healthy diagnostic tables and verbose evidence out of the hidden DOM.
- Triage auto-expansion runs once on the first render with definite evidence. Later issues update the collapsed summary without moving the operator mid-task.
- Refetches retain the last successful payload and surface background failures through `WorkspaceStatusBoundary`.
- Initial healthy Triage render budgets are enforced by `src/app/admin/__tests__/triage-budgets.test.tsx`.

## Source Owners

| Area | Owner |
| --- | --- |
| Public status surface | `src/app/status/client.tsx`, `src/lib/status/public-status.ts` |
| Private workspace shell and routes | `src/app/admin/`, `src/components/ops-shell.tsx`, `src/lib/admin-workspaces.ts` |
| Status components | `src/components/status/` |
| Frontend polling | `src/hooks/admin-api-hooks.ts`, `src/hooks/use-endpoint-probes.ts` |
| Same-origin operator proxy | `functions/api/admin/[[path]].ts` |
| Thresholds, cron metadata, endpoint registry | `shared/lib/status-thresholds.ts`, `shared/lib/cron-jobs.ts`, `shared/lib/api-endpoints/` |
| Status APIs and persistence | `worker/src/api/status.ts`, `worker/src/api/status-history.ts`, `worker/src/lib/status/`, `worker/src/lib/status-state-store.ts` |
| Synthetic verification | `worker/src/cron/status-self-check.ts` |
