# Status Dashboard

Operational reference for the split status surfaces: public `/status/` read-only health monitoring and Access-gated route-based operator workspaces under `/admin/` and `/admin-api/`, including backend status computation, hysteresis, discrepancy detection, endpoint probing, guarded actions, credential operations, and durable audit history.

> **Agent navigation** — Grep the heading you need: Frontend Flow (query/host seams) · Backend Contract (`GET /api/status`) · Timestamp admission · Cron health model · Resource-pressure evidence · Data quality status · Public status projection · Live reserve sync health · Telegram bot metrics · Synthetic self-check · History endpoint · Guarded Admin Actions · Price Source Health Card · D1 Usage Card · Matched-block integrity · Rendering And Refresh Contract · Source Owners.

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
- The public health payload is the status self-check's 15-minute projection in the dedicated `status:public-health-snapshot:v1` cache key (`{version: 1, producedAt, publicHealth}`); `/api/health` reads only that key plus its live scheduler overlay, and performs a live assessment only when the snapshot is missing, stale or unreadable, or its cached scheduler state is unhealthy. Operator-only Telegram lifecycle diagnostics live on `/api/status`.
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

Public `/status/` is read-only, public/indexable, and uses public read endpoints. Access-gated `/admin/` and `/admin-api/` are private/noindex. `ADMIN_WORKSPACES` in `src/lib/admin-workspaces.ts` owns stable workspace navigation; `OpsShell` omits public navigation, tape, feedback and footer. Workspace clients mount only their own queries and active modes: Triage answers act/watch, Pipeline inspects producers, Reliability owns endpoint/demand reads, Crons owns attempts, Actions owns mutations, Comms owns delivery/audience evidence, History owns transitions/audits, and API Management owns credential inventory/mutations. Triage reads only counts from `/api/api-keys/lifecycle-summary`; missing counts are Unknown, never zero.

API Management drafts preserve every canonical `API_KEY_TIER_VALUES` member, including donor, through unrelated edits and saves. Only unknown historical free-form tiers fall back to standard; operators may still deliberately select a different canonical tier.

History orders admin-action attempts and credential-audit mutation receipts together while retaining their separate source records and outcomes. Neither key/action similarity nor matching timestamps prove a shared request identity. Without a shared durable identity, even a single nearby pair remains separate; a failed retry or unknown/post-write response never replaces a recorded mutation receipt.

`InboxRow` in `src/app/admin/status-dashboard/triage-summary.tsx` owns row presentation. Triage and incident history share `getCausesVerdict`: public-impacting/critical causes mean Act now; other causes mean Watch. Recurrence is descriptive co-occurrence, not causal attribution. Material-duration and unknown-coverage causes remain independently actionable. Unknown/stale evidence cannot answer the operator question. Rows without a transition use the named cron's last success for duration; next primary opportunity and freshness budget come from the cron registry, not an inferred catch-up promise. Triage and Actions share recommendations. Recovery hold preserves required consecutive-check progress; public headline, raw held status and `/api/health` remain distinct evidence.

Triage keeps failed cron-history evidence in Crons attention as unavailable, with the named summary reason; Actions shows unavailable cron badges rather than zero errors. Pipeline attention likewise retains source-specific unknowns: failed price-cache, blacklist-gap and on-chain reads render unavailable for that source only, without hiding independently measured siblings or changing global health thresholds.

The public route follows [Public status projection](#public-status-projection), not the worst admin diagnostic. `src/lib/status/public-status.ts` falls back to `projectPublicStatus` for legacy payloads without headline/components. The site's status links use `PUBLIC_HEADLINE_TONE`. Thirty-day component bars use the worst observed state per UTC day; days before `publicHistoryStartedAt` are unknown, never operational. Public history is bounded (`hasMore`), and failed reads are not empty logs. A live recovery awaiting persistence is marked pending the next check.
Dashboard public-health notices retain named warnings, mint/burn sync details and blacklist gaps; when none are supplied, they reuse non-operational component summaries from that same projection.

Public availability keeps source-specific boundaries:

- Blacklist missing-amount severity uses shared ratio bands (≥1% degraded input, ≥2% stale input; either degrades the component); unavailable ratio evidence degrades, while recent-gap count alone is Watch.
- Cache availability uses shared age ratios (>8× degraded, >12× stale, or a tighter per-cache override). Projection maps these to delayed/degraded, and outage only past twice the stale band. Cached fallback or degraded/unknown input quality degrades even inside the age budget. Producer-source warnings may remain admin-only until the public availability budget is breached.
- Cache endpoint warnings use cache-specific freshness (`yield-data`: two hourly intervals), distinct from the public availability budget.
- Mint/burn freshness is primary, but a fresh cache cannot hide an unhealthy latest critical-lane run.
- `shared/lib/circuit-sources.ts` owns public impact: only active `source-wide` registry scope contributes. Asset-scoped, optional, retired and dynamic `live-reserves:*` breakers remain diagnostics; exact price coverage/reserve health owns their impact. `protocol-redeem` remains source-wide even if one member serves a single asset, and legacy retired keys stay excluded.

### Data hooks

`src/hooks/admin-api-hooks.ts` owns operator reads through same-origin `/api/admin/*`, with fixed ops-proxy query scope, no browser-held secret, and the shared `CRON_1MIN` polling budget (`staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0`). Public read hooks live in `src/hooks/api-hooks.ts`. Resources-menu health polling is enabled only while open: initial evidence is Checking and a failed refetch is Unavailable despite retained data; it is not an always-on site-wide poll.

`use-endpoint-probes.ts` owns bounded public/admin browser probes. Public canaries are reserved for `/status/`, use the same-origin `/_site-data/*` lane and a 15-minute stale/30-minute refetch budget with no retry; admin probes use `/api/admin/*` and the operator polling budget. Health/probe clocks are separate, each overdue against its own interval. Missing samples are Loading while pending, otherwise Unknown, never Healthy. Mutation routes are listed but never auto-probed.

Probe HTTP and semantic outcomes remain distinct. `/api/health` and `/api/status` HTTP 200 responses can be unhealthy; degraded/stale samples are not mislabeled transport failures. `getProbeDisplayStatus` classifies each sample once, so combined HTTP/semantic failure is one stale sample and totals reconcile. Missing blacklist gap fields violate the health contract (`Invalid health probe response`); explicit `db-unavailable`/`blacklist-read-failed` with present null counters is valid unavailable evidence and cannot stay healthy. Null evidence is never zero. Worker self-check transport counts exclude semantic warnings.

`use-public-status-history.ts` calls `/_site-data/public-status-history` with explicit `24h|7d|30d` windows. The runway has a fixed 30-day query independent of the selected transition-log window. A rejected read makes the runway unavailable; the log retains prior rows on refetch failure but displays the error if no rows survive. `shared/lib/status-public-impact.ts` owns the public cause allowlist: only warning/critical causes open incidents. Circuit/mint-burn query failures affect availability; cache-query/cache-warning info diagnostics and admin-only reserve, ratio, on-chain/watch causes do not open incidents. Recovery rows remain once an incident opens. `currentStatus` comes from live `assessPublicHealth`, not hysteresis; `lastChangedAt` is known only when the newest retained transition ends in that live state. Uptime overlays live health on today, leaving unobserved prior days unknown. Coverage uses the latest publication-bearing stablecoins run; bounded causes reserve space for non-info active-price gaps.

`useStatusHistory()` reads `/api/admin/status-history` with rolling `6h|24h|7d|30d` windows. Failed or completeness-unknown history reads show error/retry, never an empty-history claim (`sectionErrors.transitions` identifies transition failure). Deployment history uses independent public/heavy script names, verified UUIDs and activation markers from `workerVersions`, never the latest producer-head singleton. Missing markers are unavailable; commit/ID and causal attribution remain Unknown.

`useRequestSourceStats()` polls the default 24-hour window in hourly buckets with bounded route/key breakdowns. Site demand includes Pages hits/upstream attempts plus public API requests attributed to browser evidence or website-owned keys. Worker-lane public-api/site-api demand stays separate; total site demand is not Worker load.

Demand reads explicitly opt into `measurementVersion=2`. Worker source events and ordinary Pages upstream HTTP responses are independently sampled at 1/64; transport timeout/error observations are captured at certainty. `Est.` marks weighted counts/shares, sample size/rate and low precision remain visible, and empty sampled observations never say “No requests.” Recorded per-key counts and captured Pages transport failures stay unsampled. Public-key shares use recorded keyed plus directly estimated unkeyed demand; inconsistent legacy/regime evidence renders unavailable, never a clamped zero. Old recorded counters remain additive historical inputs during the 35-day drain. Operational evidence gaps do not alter public-health status; totals remain full-window despite route/key limits or the latest-eight-bucket display.

The operator proxy (`functions/api/admin/[[path]].ts`) host-gates to `ops.pharos.watch`, permits registry-owned admin routes, strips the prefix and forwards to `ops-api.pharos.watch` with Access service credentials. It verifies the UI Access JWT (`CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_OPS_UI_AUD`, assertion header or same-origin session fallback), injects normalized human email for audit and ignores browser actor headers. Browser request headers are limited to Accept, Content-Type, Idempotency-Key and X-Pharos-Admin; response headers are narrowed to the proxy's allowlist, preserving execution certainty/replay, retry and freshness evidence. Upstream timeout returns 504; other network failures or Access redirects return 502.

The pure `status-dashboard-model.ts` and memoized `use-critical-ops-model.ts` rebuild only on evidence changes or crossing `STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs`. Relative clocks are leaf-owned; see [Rendering And Refresh Contract](#rendering-and-refresh-contract). Live refresh must not re-run hash alignment or move an operator mid-scroll. Diagnostics mount only while open, and only probe/status divergence raises a new signal; latency-only failure reports passing probes separately from slow p95.

Reliability consumers import builders directly; `reliability-workspace-model.ts` owns only contracts, modes and verdict helpers, never imports or reexports its builders. Endpoint path sanitization belongs to `reliability-workspace-endpoint-builder.ts`, keeping copied diagnostics and table paths consistent without a runtime dependency cycle.

Cron semantics belong to [Cron health model](#cron-health-model); `deriveCronVerdict` in `src/lib/cron-workbench-model.ts` owns the operator verdict. Registry group/cadence/impact and next primary opportunity are not physical-trigger membership or catch-up promises. Public-critical jobs past twice cadence or with ≥2 failures need action; single/watch failures, warnings and public-critical findings are Watch; successful admin-watch findings stay neutral. Fresh in-flight evidence is Running without replacing the previous terminal outcome; unknown is Unavailable. A neutral skip never lends time/runtime to an inherited failure. Bounded history retains required-attempt/readback evidence rather than hiding it behind newer skips. Slot metadata distinguishes successful, degraded, errored and neutral children so best-effort continuation cannot hide failed children. Budget-only surfaces remain separate from `crons`; orphaned progress/expired leases are stale artifacts, not running work.

For optional Telegram telemetry, missing means Unknown. Current dispatch retry and permanent-failure counts come from `telegram_deliveries`; no absent counter is interpreted as zero. Delivery health and audience eligibility stay separate: the eligible alert audience counts chats that can receive matching alerts, not attempted, failed or delivered messages. Safety/reserve source suppression can degrade the workspace even when the latest dispatch is `ok`; its reason names each suppressed family and the recorded source state instead of claiming the dispatch itself degraded. Dispatch errors and permanent failures still take precedence, followed by backlog, rate limiting and retries. Suppression remains fail-closed.

### Endpoint groups

`shared/lib/api-endpoints/` owns public/admin read probe groups and manual action membership. Manual mutations are never loop-probed; registry metadata, not a copied endpoint list, controls admission.

---

## Backend Contract (`GET /api/status`)

Source: `worker/src/api/status.ts`

`workerVersions: { public: Marker | null, heavy: Marker | null }` is owned by `shared/types/status/response.ts`. Each marker is `{ scriptName, workerVersion, activatedAt }`, read directly from the deploy-verified `worker-active-version:<role>` cache key by `getActiveWorkerVersionMarker()` in `worker/src/lib/worker-version-first-seen.ts`. Missing/malformed evidence is null; failed D1 reads add the named `sectionErrors.workerVersions` / `worker_versions_query_failed` error, never a latest-run guess. Per-run `workerVersion` scalars remain execution UUIDs. The public three-lane liveness aggregate retains its history/budgets; independent heavy delivery evidence extends the query and GitHub monitor with separate heavy budgets.

The [history endpoint](#history-endpoint-get-apistatus-history) owns timeline responses and completeness evidence.

Shared raw-status evaluator: `worker/src/lib/status-evaluation.ts`

`worker/src/lib/status-reliability-shared.ts` owns the shared severity ordering (`SEVERITY`) and `maxStatus` aggregation primitive. Evaluation rules and state helpers import that lower-level authority directly; rules do not depend on evaluation state.
Reserve assessment calls `evaluateReserveCompositionStatus()` in `status/evaluation-rules.ts` directly from raw evaluation, supplemental loading and history; `status/evaluation-state.ts` owns confidence scoring only.

Shared public-health floor: `worker/src/lib/public-health-assessment.ts`, backed by the pure helpers in `shared/lib/cache-health.ts` and `shared/lib/public-health.ts`

The assessment's existing `safetyScoreImpactStatus` floors raw admin availability and overall; effective status retains hysteresis. Sole authority `getPublicSafetyScoreStatus()` uses accepted-publication age, never attempt age, with the existing public budget/outage grace. Public-impacting warning/critical Triage causes distinguish `safety_score_publication_unavailable`, `safety_score_publication_missing`, `safety_score_publication_held` and `safety_score_publication_stale`, retaining available generation identity, clock and budget, plus actual hold reason codes.

`PUBLIC_CIRCUIT_IMPACT_QUORUM` in `shared/lib/public-health.ts` is the sole source-wide circuit quorum
authority (3), shared by public grading and admin cause thresholds. Public circuit reasons retain the full
open count plus up to 12 sorted source keys (80 characters each). Unavailable circuit/scheduler reasons retain
their named subreason. A change in these bounded identities writes one deduplicated public cause-change
event, without resetting the component's `since`; changing failure clocks or source-map ordering alone does
not create an event. Source identity in older count-only history remains unknown.

Public/operator copy uses actual health warning evidence; unknown codes remain visible. Blacklist read failures expose null measurements with `unavailableReason: blacklist-read-failed|db-unavailable`; successful empty reads retain zeros. Browser probes and cards admit this unavailable branch without claiming zero gaps. Critical-duration labels use only the warning's named price-gap IDs; other missing prices stay in the separate coverage warning. Thresholds and recovery policy are unchanged.

The public `HealthResponse.blacklist` contract (`shared/types/status/public-health.ts`) makes all five measurements nullable: `totalEvents`, `missingAmounts`, `recentMissingAmounts`, `recentWindowSec`, and `missingRatio`. A failed read sets these to `null` and supplies `unavailableReason: "blacklist-read-failed"`; an unavailable database supplies `"db-unavailable"`. The reason is nullable/optional for available or retained payloads. Consumers must show unavailable measurements, not zero events, zero gaps, or a healthy ratio. A successful empty observation may publish numeric zeros.

Read failures use the ADR-29 `PublicHealthReadResult` boundary and cannot restore healthy diagnostics. Circuit reads publish `HealthResponse.circuits: null` with `circuitsUnavailableReason: "circuits-read-failed"` (or `"db-unavailable"`); successful reads still publish the circuit record map. Mint/burn critical read failures publish nullable `sync.freshnessStatus` / `sync.criticalLaneHealthy` and `unavailableReason: "mint-burn-read-failed"` or `"mint-burn-output-read-failed"`; DB failure uses `"db-unavailable"`. Unread major counts/symbols are nullable. The existing `queryErrors` fields carry `"mint-burn-output-read-failed"` / `"mint-burn-count-read-failed"` for their respective failed reads; a failed advisory count does not invalidate an independently observed healthy writer. Operator causes `circuit_query_failed` and `mint_burn_health_query_failed` are warning-severity and degrade availability rather than overriding unavailable evidence to healthy.

Yield safety reads the live publication identity and publication-health evidence through independent `PublicHealthReadResult` boundaries, so one failed sibling does not discard or mislabel the other's read outcome. Either failure degrades availability. The internal assessment's optional `yieldSafetyQueryErrors` carries `liveIdentity` and `publicationHealth` separately (`null` for a successful read); public warnings use the sanitized codes `yield-safety-live-identity-read-failed` and `yield-safety-publication-health-read-failed`. `getPublicHealthEvidenceReadFailures()` emits `yield-safety-live-identity:read-failed` / `yield-safety-publication-health:read-failed` only for the siblings that actually failed.

When the DB sentinel fails, `/api/status` publishes `dataQuality: null` with `sectionErrors.dataQuality.code: "db-unavailable"`, nullable summary measurements with `summary.unavailableReason: "db-unavailable"`, and `reserveComposition.status: "unavailable"` / `reason: "db-unavailable"` with null coverage and counts. A successful empty reserve cohort remains distinct and may be healthy with observed zeros. `summary.transitionsLast24h` is nullable: a failed or absent aggregate carries `transitionsUnavailableReason: "status-transitions-read-failed"` plus the same `sectionErrors.statusTransitions.code`; DB failure carries `"db-unavailable"`. A successfully counted zero remains `0` with no unavailable reason. History shows unavailable count/flapping evidence instead of assuming no transitions.

FX health admits its publication clock with canonical `assessFreshnessTimestamp` (60-second allowed skew): excessive future clocks publish null `ageSeconds` / `publishedAt`, `timestampReason: "future-timestamp"`, and a stale availability floor. Per-peg provenance continues to use the shared `assessFxPegAdmission` path: source clocks more than 300 seconds ahead already reject with `source-time-future`, used in `fx-source-provenance-unknown:<peg>=<reason>`; rejected clocks never create a healthy source claim. Blacklist cards also preserve partial evidence: `recentMissingAmounts: null` means recent gap evidence unavailable, not “no new gaps”.

DEX `liquidityHealth.baselineReadFailures` retains named coverage-count, global-TVL, top-ten, cron-history, coverage-class, watchlist and per-coin read failures. Required guard-read failures hold the accepted generation with `required-baseline-read-failed`; successful empty bootstrap remains publishable. A failed top-ten read makes both current-on-prior-membership and previous top-ten totals null; failed coverage/history makes the prior coverage null, and failed global/history makes the value baseline null. Unread previous coverage classes are null, not an all-zero mix. The card renders unavailable prior evidence and the named reasons; optional class/drift failures do not add publication holds.

Related extracted loaders:

- `worker/src/lib/status/derived-data.ts`
  - `getDatasetFreshness()`
  - `getMintBurnReconciliation()`
  - empty fallback builders for dataset freshness / reserve composition
- `worker/src/lib/status/data-quality.ts`
  - canonical stablecoins-cache / blacklist-gap / active-depeg / on-chain-supply quality aggregation

`datasetFreshness.safetyGrades` describes the accepted **Safety Score publication**, including the
original clock of a held publication, not daily grade history. `shared/lib/status-dataset-freshness.ts`
owns public labels and cadence owners for both the Worker and table; this row belongs to
`compute-safety-score-v9` (1,800-second cadence). `snapshot-safety-grade-history` remains an independent
daily cron row. Private table/publication/cron-output read targets stay in `derived-data.ts`.

The backend contract is split into bounded sections. Select the evidence family affected by the change:

- Request/read boundaries: [Auth and caching](#auth-and-caching) and [Timestamp admission](#timestamp-admission).
- Execution and capacity evidence: [Cron health model](#cron-health-model), [Resource-pressure evidence](#resource-pressure-evidence), and [Cron error escalation](#cron-error-escalation).
- Status computation: [Availability status](#availability-status), [Data quality status](#data-quality-status), and [Overall status](#overall-status).
- Source supplements: [Live reserve sync health](#live-reserve-sync-health), [Yield health summary](#yield-health-summary), and [Telegram bot metrics](#telegram-bot-metrics).
- Self-observation: [Synthetic self-check](#synthetic-self-check). Historical transitions are owned by the [history endpoint](#history-endpoint-get-apistatus-history).

## Auth and caching

- Requires a valid admin credential (`requireAdmin`)
- Response cache policy: `Cache-Control: no-store`
- Even when the persisted operator assessment snapshot (`status:raw-snapshot:v1`, payload v2) is fresh, `/api/status` reads current cron history, progress, leases, and scheduled slots through `loadCronHealth()`. Per-job availability, cron/slot summary counts, and the informational cron availability causes (`degraded_cron_warning`, `watch_cron_error_runs`, `watch_unhealthy_crons_present`, and the `cron_*_query_failed` notices) all describe that one live read at the response `timestamp`, so a cause count never disagrees with its `summary` counterpart in the same response; the aggregate assessment, caches, and expensive supplements retain the persisted assessment generation. A failed live cron read remains unknown rather than replaying a cached success.
- Every health/status request live-reads `schedulerLiveness` from actual D1 slot starts, including fresh-snapshot paths. The public aggregate and its three lanes remain unchanged; `schedulerLiveness.heavy` adds independent registry-owned heavy delivery evidence (`scheduleKey`, `lastStartedAt`, `ageSeconds`, `warningAfterSec`, `staleAfterSec`, `status`, `unavailableReason`). Cached unhealthy scheduler floors for either role force live recomputation to clear only obsolete scheduler causes; independent blockers remain. Admin snapshots are bypassed when reserve review applicability changes, and pre-feature reserve projections are rejected.
- Cached `/api/health` responses retain `assessedAt` as the original evidence assessment clock while `timestamp` records the current request. The cheap snapshot path advances admitted cache ages and re-evaluates the current cache impact floor and public components without rerunning the full assessment. Existing raw/quality blockers remain floors; only scheduler evidence is read live. Full assessments set both clocks to the request time.

The operator assessment envelope `status:raw-snapshot:v1` uses payload version 2 (`{version: 2, producedAt, cronJobs, raw, supplements?}`). It holds the aggregate assessment, caches, budget-only surfaces, scheduler liveness and supplements, but no per-job cron records and no public health: `cronJobs` preserves cohort identity for admission while `/api/status` always live-reads cron history through `loadCronHealth()`. Public health is published separately to `status:public-health-snapshot:v1` (`{version: 1, producedAt, publicHealth}`), which `/api/health` reads alongside its live scheduler overlay. A version-1 raw-snapshot row is unreadable and is served by the live fallback until the next self-check.

`StatusResponseSchema` validates retained nested sections at the query boundary. Raw snapshot admission reuses those schemas before any dereference: malformed causes, caches or other required sections return `unreadable` and trigger live recomputation. Only absent optional `budgetOnlySurfaces` defaults to `[]`; additive top-level fields remain passthrough-compatible.

`computeRawStatus()` now performs the DB sentinel first and returns an explicit stale fallback snapshot when that sentinel fails, instead of throwing before the dashboard can show operator-visible degraded state.

**Rules this contract carries.** Two repo-wide data-integrity rules are load-bearing here and are recorded as
ADRs in `architecture.md`: **R3** ([ADR-30](./architecture.md#adr-30)) — a published
freshness verdict names the budget it used and the generation it describes, with input quality in separate
fields — and **R4** ([ADR-31](./architecture.md#adr-31)) — a non-`ok` terminal status carries a machine-readable reason, and terminal
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

Cron progress admits both `startedAt` and `updatedAt` against the reader clock with this same allowance before a heartbeat can establish availability or suppress an earlier error. Rejected clocks leave `inFlight: null` and retain the progress row's diagnostic fields in optional `inFlightUnavailable`, with `stale: true`, raw clock evidence and `timestampReason`. Required numeric clocks in admitted `inFlight` remain unchanged for existing readers. Terminal and confirmed-output evidence are evaluated independently.

`FreshnessIndicator` keeps its generation in `<time datetime>` and state in `data-state`, and
discloses the exact effective predicate budget in `data-stale-after-ms`. Timestamp help names
that same threshold in human-readable units: stale means age strictly greater than the budget.
Compact chips retain their existing 2× headroom; noncompact chips use the supplied budget exactly,
including the redemption card's already doubled budget. Disclosure does not change timers,
visibility handling, freshness windows or transition-only screen-reader announcements.

Ordinary cache, table fallback, cron fallback and yield-health clocks use that same admission boundary.
Rejected clocks expose null ages and the exact `timestampReason` (yield rankings use
`rankingTimestampReason`), never a negative age or a clamped healthy future generation.

Dataset freshness uses canonical `assessFreshnessTimestamp` with an explicit **zero future-skew
allowance** at the read boundary. Missing, non-finite or future clocks publish a null dataset value
and `datasetFreshness.unavailableReasons[dataset]` (`missing-timestamp`, `invalid-timestamp`, or
`future-timestamp`). An admitted observed zero remains zero. The table also rejects invalid retained
clocks and renders unavailable, never a future clock clamped to zero-age “on time”.

Cached public health ages each admitted cache from its immutable `publishedAt`. Legacy evidence without
that clock advances its original measured age by the elapsed time since `assessedAt` (or the retained
assessment's original `timestamp` when `assessedAt` is absent). Null ages and rejected clocks remain
unavailable; the passage of time cannot admit previously rejected evidence. Cache generation identity,
age budgets and independent input-quality fields remain unchanged.

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

Status reliability, hysteresis, evaluation and probes share the schema-derived `StatusHealthValue` from `shared/types/status/core.ts` through direct type imports. This health vocabulary is distinct from cron execution outcomes below; canonical imports do not change wire values or hysteresis thresholds.

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

Duration-watchdog summaries treat runtime and slot-abandonment breach evidence independently.
Only a validated empty string array renders `none`; absent, null, non-array or malformed-member
evidence renders `unavailable`, without discarding a valid sibling dimension. Sentinel-nested
summaries retain each source's status and reason (or its supplied error when no reason exists),
so a failed source is not presented as a clean no-breach observation.

Daily and weekly digest generation share `degraded` / `anthropic-circuit-open` terminals when Anthropic's circuit blocks generation. Missing Anthropic credentials are an intentional `skipped_neutral` / `missing-api-key` outcome, not a delivery-channel failure; required channel credentials still use degraded delivery accounting. Other deliberate no-work outcomes carry named neutral reasons. None of these no-generation attempts advances the confirmed output clock; the logger persists `outputPublishedAt: null` and projects the terminal reason into `degraded_reason`.

The [persistence appendix](#cron-metadata-persistence-budget) owns write-time byte budgets and diagnostic compaction. Consumer fields/counters retain their shape and unavailable values; persistence limits never drop evidence or prevent terminal accounting.



The retired `compute-safety-score-v9-workflow` observer is no longer a registered producer or freshness/watchdog obligation. Historical failures remain in D1 as forensic evidence. Raw snapshot loading compares the payload's entire `cronJobs` cohort against the current registered cohort; mismatches invalidate the whole assessment and trigger live recomputation, including severity. Filtering a retired job while preserving its cached OOM severity is not a valid cutover. Newly produced post-activation snapshots must use the current cohort, and genuine canonical/other failures remain visible.

Scheduled attempt evidence is independent of detailed in-flight progress: every protocol-v1 child has a
durable `scheduled_child_attempts` start marker before work, including progress-suppressed jobs. Real and
synthetic terminals arbitrate one deterministic full attempt identity under the executing slot fence.
Equal repeated lease-owner reports skip the write.
Replay retains producer source identity while naming its recovery execution fence. Reconciliation proves
`not_started` only when a due protocol-v1 child has no marker; legacy missing evidence is
`execution_unknown`, projected as an error/abandoned producer with explicit uncertainty, not success
or a zero item count. Last durable activity durations are lower bounds, not reconstructed runtimes.
Producer invocation aggregates and confirmed publication clocks remain separate from attempt terminals.
`worker/src/lib/cron-outcomes.ts` owns outcome projections/folding: errors outrank degraded/nonneutral
skips, which outrank `ok`; locked skips are nonneutral and neutral skips stay neutral. Fence admission
status, child `resultStatus` and productivity remain distinct. Execution deadlines and the centralized
slot/child silence policy do not change the freshness windows below.

Successful observers report `ok` plus `metadata.quality` for semantic service degradation, stale producer output, detail-write markers, missing digest editions, duration/abandonment trends, and sustained DEX turnover. These findings do not increment `degradedCrons`; fresh operational `degraded` attempts still inherit behind neutral skips. The workbench shows findings on a successful run as a neutral `Findings` chip; they make a public-critical job `Watch` and leave an admin-watch observer `OK`, without changing execution state or group degraded totals. DEX source-stage and scoring quality findings also make those producer jobs `Watch`, so source failures and confirmed liquidity drift remain in the default attention queue without promoting their public-health criticality. Observation success never renews a producer's output clock.

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
consumer publication. Reserve recovery reports an `ok` poll during next-slot lookahead or same-role graph
deferral only after the current producer is verified finished. It also reports an `ok` poll with reason
`producer-slot-live` while the exact current `fourHourlyReserveSync` slot is `running`, has no finished
clock, has a non-future heartbeat within `resolveScheduledSlotPolicy("fourHourlyReserveSync").slotSilenceSec`,
and remains younger than that policy's `hardDeadSec`. Nested `producerPriority.reason` retains the work-admission
reason `producer-slot-priority`; `producerPriority.condition` distinguishes `producer-slot-live` from
`current-slot-unfinished`. This completed protected poll proves no reserve publication and never relaxes
recovery mutation admission. A missing slot claim, unreadable producer evidence, non-running unfinished slot,
stale/future heartbeat, or hard-dead slot cannot renew availability; a valid finished slot, including a finished
error, continues through the existing recovery path.
Subject to a successful history read, cron availability is healthy when:

- A fresh non-stale `crons[*].inFlight` heartbeat exists (without advancing the output clock), or
- The latest attempt is fresh and `ok`/`degraded`, and its latest confirmed output is within
  `2 * expectedIntervalSec`. That output can come from an earlier attempt: cadence reuse and
  `already_written_today` do not erase it or renew its clock. Control-plane jobs instead accept a fresh
  `ok`/`degraded` observation, or
- A fresh `skipped_neutral` attempt inherits such evidence from the latest required successful or locked run, or
- Last run status is `skipped_neutral` whose `metadata.reason` is in `PROVEN_SATISFIED_NEUTRAL_SKIP_REASONS`
  (`shared/lib/cron-jobs.ts`: `same_day_snapshot_exists`, `weekly-recap-exists`) — the skip follows a
  successful precheck read of the period's write-once artifact. Quarter-hourly daily-snapshot admission
  retains this proof only in the finished parent slot's `metadata.jobs[]`, with its actual `observedAt`
  clock; status projects it as a zero-work neutral observation (`source: scheduled-slot-admission`).
  It creates no child/lease/cron rows and never advances the confirmed output/publication clock.
  The bounded parent-slot read admits only explicit neutral `same_day_snapshot_exists` observations;
  generic `before_daily_slot`, unfinished parents and invalid/future observation clocks prove nothing.
  Such a readback also supersedes an earlier fresh error for the same period in `summary.cronErrors`
  (the error row and its machine-readable reason stay in history; one transient precheck read failure must not keep
  a write-once daily artifact's producer red until the next day's real run). An inherited `degraded` run stays a
  warning: the artifact existing proves availability, not that the producing run's inputs were clean.
  Later generic neutral admissions retain this fresh readback evidence; a required attempt after the
  readback supersedes it, so a newer error still wins, or
- Last run status is `skipped_locked` **and** there is a fresh `ok` run with confirmed output in the same freshness window, including output recovered beyond the displayed attempts, or
- The job is **not** reported healthy when the cron-history query itself failed: `crons[*].healthy` is `null` with `crons[*].telemetryUnknown = true` and `crons[*].telemetryUnknownReason` naming the failed read, and the job is excluded from unhealthy/error counters rather than reported falsely unhealthy or falsely healthy, or
- The job is a watch-tier bootstrap (`crons[*].bootstrap = true`): no required non-neutral attempt yet and at most one recorded run. Critical-tier jobs always require real availability evidence. The admin describes this as an initial admission window, without claiming a successful run

History-derived wire summary counters are null on a failed history read, with `summary.cronHistoryUnavailableReason: "cron-history-read-failed"` and `sectionErrors.crons` carrying the same code. A successful empty history keeps numeric zero and an explicit null reason. The optional reason admits legacy rolling-deploy payloads; `summary.unavailableReason: "db-unavailable"` remains reserved for whole-DB loss. Lease, progress and running-slot aggregate measurements retain their own read outcomes: failed history alone never nulls independently observed companion counts.

Optional lease, progress, slot-event and running-slot reads share failure normalization, but retain independent failure flags and structured event/source identities; required cron history keeps its separate unavailable boundary.

The display starts with ten runs. A full window with fewer than two required attempts triggers an indexed, two-row required-attempt lookup; duplicate evidence is removed. A fresh proven-satisfied readback is recovered separately when absent, preserving error supersession behind generic admissions. Appended attempts/readbacks keep verdicts attributable in `crons[*].runs` (newest first, behind the ten-row display window) and remain visible in the admin history. A full window without fresh confirmed `ok` output also triggers the bounded `CONFIRMED_CRON_OUTPUT_AT_SQL` aggregate, retaining successful and degraded output clocks separately; no-op attempts never renew publication. Duration trends count only executed `ok`/`degraded`/`error` attempts, excluding admission skips from averages and sample floors; cap-hit and graceful-deferral policy is unchanged.

Conditional retry/poll membership is authored in `ScheduledTaskDescriptor.due` (the slot plan's `taskPolicies`) in `shared/lib/scheduled-runner-registry.ts`; `CONDITIONALLY_ADMITTED_SCHEDULED_TASKS` is a derived view. A missed slot does not prove those children were required: their demand/output prechecks must first admit work. Reconciliation therefore does not invent a failure for an unstarted conditional child. Status excludes retained `error` rows only when the exact registered job/schedule pair carries `reason = "stale-slot-reconciled"` and `childDisposition = "not_started"`; raw database records remain intact. Started/unknown attempts, actual read failures, and canonical scheduled obligations remain actionable. This exclusion never creates publication evidence or renews output freshness.
Admin last-completed text is `Unknown` with the failed-read reason when telemetry is unavailable. A readable window lacking success says `No successful run in recent history`, never claims absence across all history.

Otherwise the job is unhealthy, including stale history, non-fresh errors, or a generic neutral skip (no
proven-satisfied reason) whose latest required run errored or lacks confirmed output. A required degraded run
remains counted in diagnostics behind neutral skips; fresh `ok` runs with quality findings also count as warnings.

A fresh recovery attempt does not keep `/status` degraded just because the last completed run failed: while a leased cron runs with a fresh heartbeat, availability treats the lane as live and card history keeps the previous completed run.

The admin cron workbench resolves a neutral skip against the latest required non-neutral run before building its
attention filter, using the same proven-satisfied vocabulary: the newest served `skipped_neutral` row proving the
period's artifact exists clears an inherited failure when it is no older than that required run, even behind later
generic admissions; with no inherited warning or failure the row is not an attention verdict. Known V9 admission reasons replace the generic no-work label with the actual condition, such as
`competing slot active` or `core slot not ready`. The row keeps an attention verdict when backend availability
still lacks required success evidence, so the neutral attempt outcome does not hide a starved producer. Inherited
degraded outcomes retain warning treatment, inherited failures remain unhealthy unless superseded by a
proven-satisfied skip, and stale neutral skips remain attention verdicts.

Scheduled-slot abandonment is surfaced separately from child job runtime failures. When a later trigger reconciles a stale `cron_slot_executions` row, `/api/status` can attach `crons[*].latestEvent` with `eventType = "scheduled-slot-abandoned"` to each child job in that slot; the marker includes the schedule key, slot owner, and abandoned child progress stage. Synthetic child rows with `metadata.reason = "stale-slot-reconciled"` remain in `crons[*].runs` for audit history, except legacy false `daily-digest` not-started rows from idle `digestTriggerPoll` slots, which are excluded before the per-job history limit. Genuine forced digest outcomes and abandoned started-progress rows remain visible. The sentinel's duration source excludes synthetic reconciliation rows from runtime averages and reports proven publication, not-started children, publication failures, terminal-accounting unknowns, and real child failures as separate lifecycle counters. Remediation: [`docs/runbooks/cron-slot-abandonment.md`](./runbooks/cron-slot-abandonment.md).

Synthetic timestamps preserve the evidence clock: started-child abandonment uses the original start and last durable progress heartbeat, while a proven not-started child uses the original slot invocation and last slot heartbeat. Reconciliation wall time remains metadata, so older synthetic evidence cannot outrank a newer real success or producer head. An idle conditional digest poll never synthesizes a `daily-digest` failure; durable started progress is still reconciled. The cron workbench labels the active child `Abandoned`, derives runtime from its last heartbeat, and displays reconciliation delay separately. Synthetic downstream children with `childDisposition = "not_started"` render as `Not started: upstream abandoned` with runtime `N/A`; explicit dependency markers with `skippedReason = "upstream-incomplete:<job>"`, `upstream-failure:<job>`, or `upstream-blocked:<job>` render as not started with the corresponding prerequisite state, also with runtime `N/A`, and expose the prerequisite job as table evidence. These rows retain their raw error or degraded audit status so availability accounting still records the missed required execution. High-ratio abandonment remains metadata-visible for the full 7-day lookback, but it only keeps the watchdog degraded while at least one matching abandoned slot is less than 24 hours old.

Mint/burn public freshness uses the same grace window before warning: `/api/mint-burn-flows` and `/flows` stay `fresh` through `2 * expectedIntervalSec` for the critical lane (`60m` at the current cadence), then degrade/stale afterward. `/api/status` reuses that public-health floor once real sync telemetry exists. A fresh, explicitly healthy critical lane with an execution warning is operational with a named component notice and info `mint_burn_public_degraded` cause (Watch), not a service incident. Missing clocks/evidence, unhealthy critical lanes and freshness breaches retain their impact.

For the split DEX pipeline:

- `sync-dex-discovery` surfaces crawl-progress metadata (`coinsCrawled`, `poolsDiscovered`, `tierBreakdown`, `budgetExhausted`, `failedCoins`, `failedCoinErrors`) so operators can tell whether the staging crawl is still feeding the scorer and which source path failed per coin.
- `sync-dex-liquidity-stage` independently reports the hourly `:10` source/pool handoff, including generation, slot, chunk/record/byte totals, source failures, and fallback signals. Failed/partial sources and direct-API warnings populate the same canonical quality reasons as the scoring consumer, while a successful source handoff remains `ok`.
- `sync-dex-liquidity` reports the exact-slot `16,46` scoring/publication consumer. Its metadata retains staged source diagnostics through `failedSources`, `fallbackMode`, `sourceCoverage`, staged-pool merge counters, and staged skip-reason breakdowns for exact-identity vs unique-derived-identity dedup. Confirmed drift and failed/partial source findings populate canonical `metadata.quality.reasons` even when publication succeeds with `ok`, making them visible as `Watch` findings without inventing an execution failure. Critical source failures, publication failures, and active publication guards retain their operational degradation behavior.
- `sync-mint-burn` is now the critical lane, while `sync-mint-burn-extended` drains long-tail backlog on its own offset schedule. The status surface tracks them independently so extended backlog pressure does not mask critical freshness.
- `crons[*].inFlight` exposes live `cron_run_progress` state (`stage`, `itemsDone`, `itemsTotal`, `message`, `updatedAt`, `stale`) for long-running leased jobs such as blacklist, mint/burn, DEX discovery, stablecoin price enrichment, and yield evaluation. The API suppresses orphaned progress rows once their matching lease is gone, so `running-stale` means "still leased but heartbeat stalled", not "some old progress row never got cleaned up". Suppressed rows and expired leases are available in `crons[*].staleArtifacts` for operator cleanup/readout.
- `status-self-check` records its monitoring, probe, computation, and publication phases. A distinct `route-probe:<path>` stage is persisted before each selected route so abandonment evidence identifies the last entered probe without progress coalescing hiding it; a phase alone does not identify the allocation responsible for a memory termination.
- `summary.scheduledSlotRunning`, `summary.scheduledSlotStaleCandidates`, and `summary.scheduledSlotOldestRunningAgeSec` expose running scheduled-slot rows. The detail query remains capped at 25 rows ordered by oldest heartbeat, but both `scheduledSlotRunning` and `scheduledSlotStaleCandidates` come from full-population SQL window aggregates rather than the capped page. Stale candidates have heartbeats at least ten minutes old, and the oldest-first page preserves the correct oldest running and stale ages; `budgetOnlySurface*` summary counters separately report missing, stale, or error telemetry for budget-only side work.
- `sync-live-reserves` now emits structured metadata (`synced`, `failed`, `skipped`, `warningCount`, `coinsWithWarnings`, `coinsWithErrors`, `breakerKeys`) summarized in the cron card.
- `sync-redemption-backstops` keeps market-implied route impairments visible through `availabilityDegraded` metadata and impaired rows, but those expected row-level availability states do not by themselves mark the cron run degraded. The capacity coverage floor (`unresolvedMissingCapacity` above `missingCapacityOkThreshold`) is published the same way, under `metadata.quality.reason = "capacity-coverage-floor"`; only unresolved routes, a stale liquidity feed, no active configured rows or post-write warnings degrade the run.

Demand-refreshed detail rows use `detail-write-failure:*` markers rather than a cron age budget. Recovery cleanup deletes only the exact scanned marker key, `updated_at`, and value while the current corresponding detail row still has a later write clock. A concurrent replacement, including a different value written in the same second, is retained for reassessment; `updated_at` alone is not a unique generation. Expired-marker pruning remains bounded independently of recovery cleanup.

## Resource-pressure evidence

Cron detail displays **current progress** and **last terminal** resource evidence separately; it never combines measurements across attempts. Both use the validated `ResourcePressureSchema` block from the Access-protected `GET /api/status-cron-detail?job=<job>`: `cron.inFlight.metadata` for current progress and `cron.runs[0].metadata` for the last terminal. The block records phase and observation time, source body/cache/entry caps, concurrent decode policy, input/catalog admission, actual streamed intake, estimated retained cache and estimate basis, rejection count, guard, and reconciliation platform evidence. The default `/api/status` summary omits progress metadata and carries only the registry-selected `latestRunFacts`, so full run metadata is served only by the detail endpoint. Generic metadata summaries append the same resource phase/intake/guard lines.

Resource presentation follows detail-read admission: disabled reads are not requested, pending reads are loading, and failed reads name the same detail failure. A failed refresh retains previously admitted evidence with a refresh-failure warning. Progress/lease read failures make only current-progress resource evidence unavailable; a failed cron-history read makes terminal resource evidence unavailable with `telemetryUnknownReason`, without hiding an independently valid progress block. Missing or invalid blocks are unavailable for the labelled attempt, not proof that the runtime never measured telemetry. Only a successfully read, validated block with `guard: "not-measured"` establishes that state for its own attempt.

`logCronRun()` ingests evidence before progress suppression/coalescing and carries the latest snapshot into success or thrown terminals; an equally recent result snapshot wins. Persisted metadata compaction preserves the complete block. Synthetic reconciliation preserves the last durable observation clock and measurements, adding only its existing proven `platform-abandoned` or `platform-interrupted` classification with source `slot-reconciliation`. Neither classification proves Cloudflare OOM or CPU exhaustion.

Legacy missing/invalid blocks, nullable counters and unknown platform outcomes render as **unavailable**, never zero or healthy-green reassurance. `heapUsedBytes` is always null and the detail explicitly says **Heap unavailable** (`workers-runtime-no-heap-api`): Workers has no usable production heap API, and the installed unenv process-memory implementation is a zero stub. Body bytes and conservative cache estimates exclude in-flight decode allocations, warmed graphs, native storage and concurrent invocation heap. See [per-job resource evidence](./worker-and-api-limits.md#per-job-resource-evidence) for policy/accounting boundaries.

The hourly **Worker Memory Monitor** GitHub artifact/incident supplies [external sampled memory and Adaptive kill evidence](./worker-and-api-limits.md#per-job-resource-evidence); it adds no `/api/status` fields/card/polling, does not mutate `platformOutcome`, and does not change status severity.

## Availability status

Computed from public cache impact, public mint/burn impact, public Safety Score publication impact, circuit health, D1 capacity pressure, and availability-impacting cron availability. Blacklist gap health contributes to `/api/health` public status and the admin data-quality/status rollup, not directly to the availability floor.

Scheduler delivery is an independent availability axis: the newest actual start across `fiveMinuteReserveRecovery`, `fiveMinuteTelegramAlerts`, and `digestTriggerPoll` must be within the shared 600-second warning / 1200-second stale budgets (strictly greater than the boundary escalates). Recovery polls each minute; the other two retain five minutes. Historical field `lastFiveMinuteStartedAt` and lane identities remain unchanged. `scheduled_delivery_stalled` is warning/critical; missing, future, or unreadable starts yield `scheduler_liveness_unavailable`, never healthy. Overall MAX is diagnostic only: hourly starts cannot mask short-cadence delivery loss. Partial lane loss stays diagnostic while another canonical lane starts. See [delivery stall runbook](./runbooks/cron-delivery-stall.md).

Scheduler liveness validates and ages public and heavy slot starts against `unixepoch()` selected in the same D1 statement as their start maxima. `schedulerLiveness.observedAt` is that database observation clock, not the enclosing request or self-check assessment timestamp; separate raw/public reads may have different observation clocks. Starts later than their own database observation remain invalid. A missing, non-finite, non-positive or unreadable database observation clock makes both roles unavailable with `slot-start-query-failed`; the retained caller timestamp in `observedAt` on that unavailable path is diagnostic context only and never admits delivery or supplies an age.

Heavy delivery is a separate gate, resolved from plans with `worker: "heavy"` in `shared/lib/scheduled-runner-registry.ts`, choosing the shortest logical cadence (currently the 15-minute `v9SupplyAttributionOffset` lane). Its evidence is `MAX(started_at)` for that slot, never scheduled clocks or child completions. `STATUS_HEAVY_SCHEDULER_LIVENESS_THRESHOLDS` owns the warning budget of 1800 seconds (two missed 15-minute slots) and stale budget of 2700 seconds; escalation is strictly above each boundary. `heavy_scheduled_delivery_stalled` is warning/critical and floors public health/admin availability; `heavy_scheduler_liveness_unavailable` yields a degraded floor with a machine-readable unavailable reason. Public starts cannot mask heavy loss. The shared “Scheduled delivery” card on `/status/` and the admin workspace displays public and heavy evidence separately with both budgets and any unavailable reason.

- `stale` if any of:
  - any shared cache impact is `stale`
  - the public mint/burn lane is `stale`
  - the shared Safety Score publication floor is `stale` (the public Safety component is in outage)
  - D1 capacity threshold state is `critical`
  - any availability-critical cron has two or more consecutive failed runs
  - `availabilityImpactingUnhealthyCrons >= 2`
- `degraded` if any of:
  - any shared cache impact is `degraded`
  - the public mint/burn lane is `degraded` (once the lane has emitted real sync telemetry)
  - the shared Safety Score publication floor is `degraded` (held, missing/unavailable publication evidence, or accepted scores past their existing freshness budget)
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

Counted cron causes (`cron_error_runs`, `unhealthy_crons_present`, `multiple_unhealthy_crons`, `watch_unhealthy_crons_present`, `watch_cron_error_runs`, `degraded_cron_warning`) name the jobs behind the count: the message ends `Jobs: <id>, ...` (first six, then "and N more") and `subjects` carries every job id, sourced from `CronHealthSnapshot.cronFindingJobs`. Persisted transitions therefore record which job opened an incident.

Runbook links are intentionally sparse. `withRunbook()` in `worker/src/lib/status/evaluation-rules.ts` attaches `runbookUrl` only for registered cause codes; `RUNBOOK_BY_CODE` is the owning map. Public-impact causes such as `cache_ratio_*`, `mint_burn_public_*`, `open_circuit_groups`, and `cron_error_runs` can appear without a Runbook link.

Each cron definition now carries `statusImpact: "critical" | "watch"` in `shared/lib/cron-jobs.ts`. Only critical lanes can degrade `availabilityStatus` through cron availability; watch-tier cron failures stay operator-visible through cron rows, info causes, `summary.watchUnhealthyCrons`, and `summary.cronErrors`. Independent public output floors still apply: a watch-tier Safety producer cannot leave admin availability healthy while its accepted Safety publication is held, unavailable or stale.

FX source freshness is also cadence-aware now. `/api/health` and `/api/status` still expose `fx-rates.sourceStatus`, but intraday sources use age windows while ECB/secondary daily sources compare their published source date against the next expected business-day or calendar-day rollover. Business-daily ECB references now use the TARGET closing-day calendar as part of that rollover check, so Good Friday, Easter Monday, New Year's Day, Labour Day, Christmas Day, and Boxing Day do not produce false lag warnings. Realtime OXR / Chainlink overlays no longer erase a fresh daily fiat source date when they are only refining the current daily reference stack, and commodity pegs can now refresh from the fresh `stablecoins` cache when `gold-api.com` is unavailable from Workers, so the status surface does not fall into false intraday staleness during later provider outages. One-step daily lag stays operator-visible as `degraded`, while only `stale` FX sources are excluded from downstream price validation.

Unknown FX provenance is never healthy. A present non-USD rate whose metadata generation cannot be verified, whose source mode is absent, or whose intraday source has no (or a future) source time makes `fx-rates` at least `degraded` with `healthy: false`, `degraded: true`, and a machine-readable `degradedReason` (`fx-metadata-<identity>` or `fx-source-provenance-unknown:<peg>=<reason>,…`); public health then reports it under `cache-quality-degraded`. The same per-peg assessment drives pricing, so health and price validation cannot disagree about an unknown source. See [Pricing Pipeline](./pricing-pipeline.md) for the generation and admission contract.

## Data quality status

Computed from publication/price coverage, blacklist gaps, on-chain integrity and reserve health. Read-failure impact is source-specific.
`DATA_QUALITY_STATUS_RULES` in `worker/src/lib/status/evaluation-rules.ts` is the single ordered rule list. Cause order is preserved before overall-cause retention caps are applied.

Compact Pipeline summaries honor `stablecoinsCacheStatus`, `blacklistGapStatus`, `onchainSupplyQueryStatus` and `onchainSupplyMonitoring` before formatting counts. Unread source placeholders never become zero missing prices, zero gaps or zero stale feeds. These evidence gaps keep Pipeline in Triage attention without changing the severity thresholds below; successful observed zeros and healthy sibling measurements remain visible.

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
  - exact stablecoin publication coverage is unknown, has a count mismatch without IDs, omits an asset without admissible materiality evidence, or exceeds the count/share breadth limits (`getStablecoinPublicationImpactStatus`); bounded evidenced omissions retain an info `stablecoin_publication_incomplete` cause and public warning without degrading the service-wide verdict, while component materiality remains independent
  - exact active-price coverage is unreadable or has a day-old gap on a material asset (`activePriceCoverageImpactStatus === "degraded"` from `active_price_coverage_unknown`, or from an unacknowledged alert-eligible gap at `generationsElevated` = 96 consecutive missing generations — one day at the 15-minute cadence, including gaps past `generationsCritical`); materiality uses the same $1B authority and dated last-known evidence policy below
  - `missingPriceRatio > 0.18`
  - `blacklistMissingRatio >= 0.01` (1%)
  - `onchainStaleRatio >= 0.1` when `onchainSupplyTrackedCoins >= 10`
  - `onchainDivergenceRatio >= 0.1` when `onchainSupplyTrackedCoins >= 10`
  - `reserveComposition.status === "degraded"`
- `healthy` with an info `blacklist_gaps_recent` cause when `blacklistRecentMissingAmounts >= <!-- GENERATED-START: status-blacklist-recent-watch-threshold -->5<!-- GENERATED-END: status-blacklist-recent-watch-threshold -->` (last 24h) but the missing share is below 1%: a burst of freezes awaiting amount recovery is a watch signal, not a degraded surface. The public `/api/health` blacklist impact uses the same ratio-only rule.
- Non-gating info causes `price_gap_reviews_expiring` and `reserve_feed_reviews_expiring` remind operators when a review currently acknowledging a missing price or matched stale/erroring reserve feed has `0 < expiresAt - nowSec <= STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC` (48 hours, inclusive, defined in `shared/lib/status-thresholds.ts`); dormant reviews are excluded. Each cause lists IDs by soonest expiry and links to [review renewal](./runbooks/review-renewal.md); reminders do not change public health or status transitions.
- else `healthy`

### Missing-price ratio bands

`missingPriceRatio` stays ratio-based as the active catalog changes; elevated counts are advisory before the degraded band.

| Band | Enter | Cause code | Severity | Drives `dataQualityStatus`? |
|---|---|---|---|---|
| elevated | ≥ 15% | `missing_prices_elevated` | info | no — advisory only |
| degraded | > 18% | `missing_prices_degraded` | warning | yes → `degraded` |
| stale    | > 45% | `missing_prices_stale`    | critical | yes → `stale`    |

The `missing_prices_elevated` info cause exists to preserve operator observability in the 15-18% band without forcing a visible status transition.

### Active-price gap duration bands

`missingPriceRatio` counts assets, not gap duration. Duration escalates independently using per-asset `consecutiveMissingGenerations`, only for unacknowledged alert-eligible gaps. Every gap is named; only a material asset (market cap ≥ `durationMaterialMarketCapUsd` = $1B, or unknown) changes the impact status:

| Band | Enter (consecutive missing generations) | `activePriceCoverageImpactStatus` (material asset) | `/api/health` warning |
| ---- | --------------------------------------- | -------------------------------------------------- | --------------------- |
| elevated | ≥ 96 — one day at the current `sync-stablecoins` cadence | `degraded` | `active-price-coverage-incomplete:<ids>` |
| critical | ≥ 672 — one week | `degraded` (never `stale`) | additionally `active-price-coverage-critical-duration:<ids>` |
| unknown continuity | prior coverage read failed or was malformed; streak is null with `streakUnavailableReason` | `degraded` for material unacknowledged gaps | `active-price-coverage-incomplete:<ids>`; no invented critical duration |

All three thresholds live in `STATUS_MISSING_PRICE_THRESHOLDS` (`generationsElevated`, `generationsCritical`, `durationMaterialMarketCapUsd`), and the shared verdict helper `assessActivePriceGapDuration` (`shared/lib/status-thresholds.ts`) derives both the public-health impact status and the evaluator's cause from the same evidence. The ratio bands above are unchanged and still drive the `missing_prices_*` causes. The duration dimension is a data-quality verdict, not an availability one. A material gap degrades `/api/health` and names the asset but never reports the surface stale. Historical incident provenance: `git:c61e500386d30cb837ff7da0838d2ca57c27bb31:docs/status-dashboard.md`. The service materiality threshold is $1B: a long-running gap below that size remains a named warning, so isolated smaller-asset failures do not degrade the whole application. This threshold governs service coverage, not the importance of an individual asset to its holders. When a material gap does degrade public health, the state machine records it under the dedicated public-impacting `active_price_coverage_duration_degraded` cause (`worker/src/lib/status/evaluation-rules.ts`), so the incident and its recovery stay in `/api/public-status-history`; the ordinary `active_price_coverage_incomplete` warning stays admin-only. A gap past the critical band is a catalog decision — re-source the price, add a reviewed price-gap acknowledgement, or retire the asset — rather than a fetch gap to wait out. See [Adding a Stablecoin](./process/adding-a-stablecoin.md).

Missing-price `affectedMarketCapUsd` is null if any affected asset lacks admitted current circulating supply; price counts remain observed independently. Explicit zero supply contributes zero, not unavailable.

Publication component materiality and price-gap duration share `STATUS_MISSING_PRICE_THRESHOLDS.durationMaterialMarketCapUsd` ($1B); this threshold is not raised to clear a listing incident. Current-generation caps are unscaled. An absent row retains `lastKnownMarketCapUsd`, `lastKnownMarketCapObservedAt`, and `lastKnownMarketCapSource` (`publication` or `supply_history`) while current `marketCapUsd` stays null. Materiality tests retained cap × `STATUS_LAST_KNOWN_MARKET_CAP_GROWTH_FACTOR` (2), never publishes that scaled value as a measurement, and accepts evidence only through `STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC` (30 days inclusive). Missing, malformed, future or older evidence fails closed. The producer seeds absent-row evidence from its previous cache/supply clock, prior gap/publication clock, then an absent-ID-only `supply_history` read; repeated gaps never renew that date. `getStablecoinPublicationComponentStatus` retains the material asset's degraded component, while `getStablecoinPublicationImpactStatus` separately bounds service-wide impact by count/share. Pipeline controls and Triage reuse evaluator cause severity: bounded evidenced omissions are Watch; broad or unverified omissions remain actionable. Missing cause evidence never downgrades an incomplete listing.

| Publication policy | Threshold / public impact | Cause severity |
| --- | --- | --- |
| Component materiality authority | current cap ≥ $1B, or retained cap × 2 ≥ $1B | degraded listing component; service-wide severity depends on breadth/evidence |
| Last-known evidence validity | 30 days inclusive, original non-future observation clock required | unavailable evidence: warning, service degraded |
| Asset-scoped breadth limits | at most `STATUS_PUBLICATION_IMMATERIAL_MISSING_MARGIN` (3) IDs **and** at most `STATUS_PUBLICATION_ASSET_SCOPED_MAX_SHARE` (1%) of expected active IDs | bounded evidenced omissions: info, service healthy; either limit exceeded: warning, service degraded |
| Unknown / unnamed count mismatch | fail closed immediately | warning, service degraded |


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
- `datasetFreshness`: admitted confirmed output/publication clocks for operational domains, with optional per-dataset `unavailableReasons`; `DATASET_FRESHNESS_TARGETS` in `worker/src/lib/status/derived-data.ts` owns private read targets, while `shared/lib/status-dataset-freshness.ts` binds labels and producer cadence. The informational table retains its 2x-cadence grace basis and intentional 8x/12x on-time/aging/late bands; these are not overall-status or Safety methodology thresholds.
- `summary`: compact availability and diagnostics rollup (`unhealthyCrons`, `availabilityImpactingUnhealthyCrons`, `watchUnhealthyCrons`, `degradedCrons`, `cronErrors`, `availabilityImpactingCronErrors`, `availabilityImpactingConsecutiveCronErrors`, `staleCronArtifacts`, `expiredCronLeases`, `orphanedCronProgressRows`, `diagnosticIssueCount`, `worstCacheRatio`, `transitionsLast24h`)
  A failed history read makes only the history-derived cron counts unavailable; see [Cron health model](#cron-health-model) for `cronHistoryUnavailableReason` and independent companion-read provenance.
- `producerHeads`: one row per canonical schedule/job/path/kind, including budget-only paths, with separate last invocation/completion, productive output, publication, invocation ID, Worker version, and observed/missing state
- `workerVersions`: independently verified public/heavy activation markers; nullable evidence, not inferred current execution versions.
- `/api/status` intentionally omits the legacy top-level `gtProbe`, `priceProviderDiagnostics`, `cacheBlobSizes`, and `alertBroker` projections. The retired alert-broker summary is neither assessed nor published on any surface; DB and capacity health floors remain authoritative.

## Public status projection

Since 2026-10-13 the public `/status/` verdict is a component projection, not the worst raw input. `shared/lib/public-status-components.ts` owns it (`projectPublicStatus`); labels, scope copy and colours live in `shared/lib/classification/operational-status.ts`.

- **Components.** Ten reader-facing components (`PUBLIC_STATUS_COMPONENT_IDS`): website and API, stablecoin listings and prices, historical charts, risk signals, Safety Scores, DEX liquidity, yield, mint and burn flows, freeze and blacklist events, scheduled data refresh. Every cache lane in `CACHE_AVAILABILITY_MAX_AGE_SEC` maps to exactly one component (`PUBLIC_CACHE_COMPONENT`, registry-iterating test). Risk signals retains DEWS and Bluechip; Safety Scores covers Pharos scores and their publication independently.
- **States.** `operational`, `delayed`, `degraded`, `outage`. Age-graded inputs (cache ages, public and heavy scheduler delivery, mint/burn sync) are `delayed` past their first band, `degraded` past their stale band, and `outage` only past `PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER` (2) times the stale band, which proves the stale state persisted for a further full budget. Each age verdict carries `budget` (`delayedAfterSec`, `degradedAfterSec`, `outageAfterSec`). Quality and coverage inputs (cache quality, cached fallback, publication, active-price coverage, yield safety, blacklist amounts, open source-wide circuits, D1 capacity) are `degraded` at most. Unreadable evidence is `degraded` with a named reason (R2). A failed database sentinel is the only outage without grace.
- **Safety Scores.** Public assessment reads the canonical `report-cards:v9:publication-health` sidecar even when yield has no safety snapshot, sharing that read with yield's independent availability check. `acceptedAtSec` and `acceptedPublicationGenerationId` name the accepted generation; a newer `attemptedAtSec` never renews freshness. A held publication is degraded with `safety-score-publication-held` and bounded `safety-score-publication-held:<code>` reasons (including `redemption-stale`). Accepted age strictly past `API_FRESHNESS_MAX_AGE_SEC.reportCards` degrades immediately: its delayed and degraded bands coincide with that existing budget, with the standard outage grace at twice the budget. Fresh accepted scores remain operational. Missing, malformed, unreadable, or invalid-clock publication evidence degrades with a named unavailable/read/timestamp reason, never operational.
- **Headline.** `major-outage` when the database fails, a core component (website and API, stablecoin listings and prices) is in outage, or two components are; `partial-outage` for one non-core outage; then `degraded`, `delayed`, `operational`. Only bounded asset-scoped listing/price reasons are excluded from service-wide escalation. A material missing listing can therefore keep its component degraded while the headline says **Systems operational with notices**. A cache failure on that same component still escalates. `affected` includes notice-bearing components even on an operational headline.
- **Compatibility.** `/api/health` keeps the three-level `status` as the worst service-impact input (probe semantics, API consumers), not the worst warning or component notice, and adds `headline` and `components`. If no service-impact finding explains a non-healthy `status`, the projection reports `website-api` degraded with `unattributed-public-health:<status>`; an informational notice cannot mask an unexplained failure.
  The frontend's `resolvePublicProjection()` uses served headline/components when present and the shared projector otherwise; fallback notice copy does not maintain a second public-impact projection.
- **Checked clock.** The public hero displays `assessedAt`, not the time a cached payload was served. Legacy responses without it use their original `timestamp`. A live scheduler read has its own D1 `observedAt` and cannot renew the assessment clock.
- **Persistence and `since`.** The status self-check reconciles the projection into `status_state` / `status_transitions` under scope `public` (`worker/src/lib/status/public-status-state.ts`). A row is written when the headline or any component state changes, a newly monitored component is enrolled, or bounded circuit/scheduler cause identity changes; `since` carries forward while a component keeps its state, and the first observation has no known start. Operator readers filter scope `global`, so the two streams never mix. `/api/health` re-projects over advancing cache ages and the live scheduler overlay, keeping persisted `since` only for components whose state did not change.
- **Public history.** `/api/public-status-history` serves the `public` rows (`source: "public"`, with `headline` and non-operational `components`) and, only for time before `publicHistoryStartedAt`, legacy operator transitions filtered by the public-impact allowlist (`source: "legacy"`; read with an upper bound at the cutover so post-cutover operator rows cannot crowd them out). `componentHistoryStartedAt` carries each component's first actual persisted observation. Existing monitored IDs retain the original public-history start when the state is upgraded; a newly added ID starts at its first reconciliation, even if operational. Bars leave earlier days unknown instead of inventing Safety Score history. Missing component-start evidence also stays unknown. `boundary` contains `{ at, components }` from the latest schema-admitted public transition at or before the requested window, ordered by observation time then row id; it is null when unavailable, malformed or separated from the returned rows by truncation. Historical bars use this persisted seed and in-window public rows, never the current live verdict or the oldest row's headline-level `from` value. Legacy cached responses without a seed leave the unproven interval as no data. `hasMore` marks a bounded page (R7); bars leave days before the oldest loaded row as no data. An operator incident still open at the cutover is closed there and labelled as handed off to the component log. `currentStatus` stays the worst raw input; `lastChangedAt` compares public rows against the headline's level and legacy rows against `currentStatus`.
- **Sampling limits.** Public rows are written only by the status self-check (four runs an hour). A scheduler stall stops those runs, so a stall that recovers between runs, or a Worker rollback gap, leaves no public row; `/api/health` still reports the live overlay. The daily bars include that live verdict only in today's cell when its own assessment clock (`assessedAt`, otherwise the original `timestamp`) falls within today and is not in the future. A new outage cannot repaint earlier days, and a live recovery cannot erase an outage already observed during today. When `/api/health` falls back to a live assessment (snapshot missing or its scheduler state unhealthy), `since` is null.
- **Thresholds.** `PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER` and `MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO` live in `shared/lib/public-health.ts`, not `shared/lib/status-thresholds.ts`, because the latter is a pinned Safety Score V9 evaluation input.

### Proportionate impact and triage rationale

Per-asset isolation (R8) requires distinguishing an incomplete asset from a failed publication service. One known listing missing from 396 (0.25%) can be important to that asset's reader without making every product unavailable. It remains named, and a material asset still degrades the listings component; the unchanged $1B boundary is not tuned upward. Two unwaived price gaps likewise remain visible Watch findings unless material duration or other existing floors establish a service incident. A fresh, healthy mint/burn lane's degraded execution warning proves incomplete work, not stale output (R4), so it is a component notice rather than an availability outage. No missing price, supply, failed read or unknown clock is converted to healthy data (R1/R2).

Public component history is deliberately more granular than overall uptime: an asset-scoped material listing loss can colour its own component bar degraded while the persisted headline/legacy level is operational/healthy. Fresh mint/burn notices do not create degraded bars. State changes continue through `reconcilePublicStatusState`, which uses the same projection as live health; old observed incidents are not rewritten or erased. Raw snapshots/edge caches can retain the prior policy verdict until the next assessment; effective admin recovery still follows hysteresis. Triage's `normalizeStatusIssues` and `getCausesVerdict` consume the same cause severity/public-impact authority: bounded listing and fresh mint/burn notices are info/Watch, small unwaived prices are warning/Watch, and unknown or service-impacting warning/critical causes remain Act now.

The raw-verdict attribution guard accepts every non-operational component finding, including asset-scoped listing/price findings. Attribution is separate from headline severity: a retained raw `degraded` verdict explained by a bounded component notice must not create a fictitious Website and API incident. Only a raw failure with no non-operational finding gets `unattributed-public-health:*`; purely operational notices alone do not explain it.

The public-impact allowlist in `shared/lib/status-public-impact.ts` is the legacy-history/admin-triage authority, not a rule that every warning degrades the current headline. Its complete cause families map as follows:

| Cause codes | Component / service-wide treatment |
| --- | --- |
| `cache_ratio_stale`, `cache_ratio_degraded`, `cache_freshness_unavailable` | Registry-owned cache component; existing age/unknown bands escalate headline |
| `cache_freshness_query_failed`, `cache_warning` | Info diagnostics do not open incidents; actual missing/unclean cache evidence independently degrades its component |
| `fx_cached_fallback` | Stablecoin data fallback; degraded component/headline (warning legacy cause after its existing streak) |
| `mint_burn_public_stale`, `mint_burn_public_degraded`, `mint_burn_health_query_failed` | Mint/burn age, unhealthy or unreadable critical lane escalates; fresh healthy execution notice is info/Watch and operational component |
| `safety_score_publication_unavailable`, `safety_score_publication_missing`, `safety_score_publication_held`, `safety_score_publication_stale` | Safety Scores; unchanged unavailable/held/age floor escalates headline |
| `active_price_coverage_duration_degraded`, `active_price_coverage_unknown` | Stablecoin prices; material duration or unknown evidence escalates |
| `stablecoin_publication_incomplete`, `stablecoin_publication_unknown` | Listing component materiality retained; bounded evidenced loss is info/Watch, broad/unverified/unknown loss escalates service |
| `open_circuit_groups`, `circuit_query_failed` | Scheduled data refresh; source-wide quorum or unavailable evidence escalates |
| `cron_error_runs`, `multiple_unhealthy_crons`, `unhealthy_crons_present` | Critical-lane operator availability/legacy history; current public headline uses independently observed public output components |
| `db_unhealthy` | All components outage immediately; major outage |
| `scheduled_delivery_stalled`, `scheduler_liveness_unavailable`, `heavy_scheduled_delivery_stalled`, `heavy_scheduler_liveness_unavailable` | Scheduled data refresh; each role's age/unknown bands independently escalate |

Current component projection additionally grades D1 storage capacity, cache input quality, blacklist amount coverage and yield-safety availability from their public health evidence, even where no legacy allowlisted cause exists. D1 **rows-written allowance** forecasts are cost diagnostics, not storage failure; reserve cohort seven-day p95 is historical reliability, not proof of currently stale reserves. These remain ops-only: a recovered p95 breach becomes informational when recent completion evidence proves recovery, while current or unverified breaches remain warnings. Review-expiry reminders and fresh degraded-attempt counts also remain Watch; none alone degrades public uptime.


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
  Selected telemetry is admitted through the shared `LiquidityHealthSchema`, including explicit run identity and `metadata.failedSources`; incomplete or malformed evidence yields `liquidityHealth: null` plus `sectionErrors.liquidityHealth.code: "liquidity_health_extraction_failed"`. Values are not coerced or defaulted: complete observed zero/false telemetry stays valid, as do deliberately nullable prior baselines/classes with their named `baselineReadFailures`. A malformed section does not discard unrelated supplements.
- `yieldHealth`: admin-only yield health summary sourced from existing cache rows and cron metadata (`yield-rankings`, `yield:supplemental-sources:v1:*`, `yield-coverage-audit`, and `sync-yield-data`). It reports ranking count/update age, previous-vs-current ranking-count delta, live-safety hydration coverage, per-family supplemental cache age, per-key benchmark registry health, coverage-audit age, source-risk field coverage, comparison-anchor freshness, latest cron status, a field-level status, status-impact class, and the yield runbook link. The retired legacy USD-only `benchmark` projection is no longer published.
- `publicationHealth`: admin-only read-only publication generation summary for `dex-liquidity`, `yield-rankings`, `stablecoins`, `dews`, `psi`, and `safety-score-v9`. The V9 surface is derived from the canonical `report-cards:v9` publication and matching publication-health row; it does not consult the retired V8 compact cache.
- `dependencyHealth`: admin-only derived dependency matrix built from existing `caches`, `crons`, and `publicationHealth` plus `shared/lib/data-dependency-registry.ts`. Cache-backed signals use the same override-aware availability ratio bands as public cache health, so `maxAge` remains a baseline rather than an immediate stale cutoff; producer-source degradation remains independently visible. It groups degraded/stale downstream symptoms under the most likely stale upstream dependency (for example DEX liquidity -> DEWS/report-card/redemption symptoms) without changing `availabilityStatus`, `dataQualityStatus`, or publication behavior.
- `canaries`: permanent admin-only diagnostics, selecting the latest structural row per active ID in the selected `status`/`alert` mode, not an atomic generation. `expectedCheckIds`, `presentCheckIds` and `missingCheckIds` name the nine-ID roster; `totalChecks` is the present count. Retired IDs are excluded. Only complete, fresh, valid-clock observations with known completed execution and clean findings are healthy. Per-check `executionStatus`/`executionFailureReason` separate measurement from severity; `completedCount`, `failedCount` and `unknownExecutionCount` preserve legacy unknowns. In `status`, severe completed findings stay severe in the ledger while cron reports `ok` plus quality; failed reads/cohorts/persistence remain non-ok. `off`/`shadow` expose empty/unknown evidence. The approved final policy is `off|status`; old-mode rejection remains gated on deployed-override inventory as documented in [Worker infrastructure](./worker-infrastructure.md). Checks cover DEX publication/global identity, blacklist identity, active coverage, PSI/DEWS, canonical accepted/held V9 and USD/GBP benchmarks using shared freshness authority. None supplies score/availability authority or condition-specific push escalation.
- `worker_canary_runs` retention is 14 days; the current status reads only active check IDs and does not depend on older retained rows.
- `coingeckoPriceDiff`: admin-only live CoinGecko comparison summary for active tracked assets with `geckoId`, including the compare count, mismatch count, threshold, and the flagged rows where the Pharos reported price is more than 5% away from a freshness-qualified CoinGecko spot quote
- `d1Usage`: permanent admin-only D1 telemetry (`databaseSizeBytes`, `numTables`, `readReplicationMode`, 24-hour query/row volumes) plus `capacity`, ops-only `quota`, and API-only cached `tableGrowth`. `capacity.hourlyMinMax24h` preserves the trailing-24h min/max/swing across hourly observations so intra-day size swings stay visible; `quota` projects rows read/written (24h × 30) against the paid included allowances with 80%/95% ops-only floors. Neither quota cause feeds public health. Normal responses reuse the 15-minute producer snapshot (30-minute TTL), with live fallback when missing/stale. The daily reviewed-name/family census reports rows, deltas, nullable timestamp attribution, top growers and `failedTables`; invalid/missing counts never become zero. It is served for at most 50 hours; partial failures preserve the rest of the measured cohort. Row counts are not disk sizes and the cohort is not the full database table count.
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

`corruptCoins` counts rows where a matching latest-success snapshot exists in D1 but fails strict integrity validation, so the system fails closed to fallback presentation instead of serving truncated or malformed live data. When a coin has both an old latest-success snapshot and a newer failing attempt state, the overview prioritizes the active `error` / `degraded` attempt classification over generic `stale` labeling so status surfaces reflect live incidents.

`reserveComposition` is derived from:

- coins with `liveReservesConfig`
- `reserve_composition`
- `reserve_sync_state`

Behavior:

- bootstrap suppresses freshness/coverage gates until the first successful live reserve sync; uncertain writes still take precedence and return `degraded`. Normal bounded continuation never degrades coverage.
- only matched `reserve_composition` + `reserve_sync_state.last_success_at` pairs count as live snapshots; orphaned or split-write rows lack a live snapshot and follow the stale/error/missing classification
- coins currently failing before their first successful snapshot count as `errorCoins`, not `missingCoins`
- reserve health uses the matched-review-adjusted cohort, retaining the unchanged floors:
  - uncertain writes return `degraded` first; deferred share is not a health threshold
  - otherwise bootstrap or an empty health cohort is healthy; a nonempty post-bootstrap cohort with zero fresh feeds is stale
  - remaining cohorts degrade below 0.75 fresh coverage, below 0.5 authoritative coverage, or for an unacknowledged persistently stale independent feed
- low raw counts of degraded/missing reserve feeds no longer degrade `dataQualityStatus` on their own if coverage remains above those thresholds
- the Reserves tab retains individual feed failures as Watch findings; its severity follows aggregate reserve health, with verified mint/burn conservation mismatches remaining Critical
- the page renders a dedicated `Live Reserve Sync` card in the pipeline lane
- an unavailable reserve overview renders **Unavailable / Unknown** in Live Reserve Sync, Score impact, triage and pipeline readiness; it never renders 0% coverage or a clear recovery queue
- the card also breaks fresh clean snapshots into evidence-quality cohorts: `independentFreshEligible`, `independentFreshUnverified`, `staticValidatedFresh`, and `weakProbeFresh`
- `persistentlyStaleIndependentCoins` retains the complete raw list; `unacknowledgedPersistentlyStaleIndependentCoins` owns its health gate. `healthConfiguredCoins`, `healthFreshCoins`, and `healthAuthoritativeFreshCoins` exclude each matched review's actual contribution. `acknowledgedFeeds` carries reason, evidence, owner, review date, and expiry; expired/invalid IDs re-arm gates and emit info causes even on otherwise healthy observations.
- Matched in-use reserve reviews also emit `reserve_feed_reviews_expiring` during their final 48 hours, without changing reserve status; [review renewal](./runbooks/review-renewal.md) preserves the raw quarantine and automatic gate re-arming at expiry.
- `writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path, meaning ops should treat the authoritative state as ambiguous until the next clean run
- `inProgressCoins` reports unfinished work only with a fresh non-future checkpoint heartbeat and either the exact live producer slot inside its hard-dead bound, or a running continuation child with an unexpired recovery claim. A `continuation_pending` frontier awaiting the next poll is normal, not budget truncation or a failed/skipped per-coin attempt. `deferredCoins` retains recorded legacy per-coin deferrals and interrupted checkpoint debt without positive continuation evidence; it excludes intentional handoffs. `nextCursorStablecoinId` and `cursorRecordedAt` retain the sole frontier during active work and continuation. Missing/unreadable evidence never proves completion.
- `cohort` exposes `slotStartedAt`, persisted `completedAt` (null until the tail completes), `ageSec` (elapsed source-slot→completion, or open-cohort elapsed time), `continuationPending`, `completedCohorts`, and `completionP95Sec`. Seven-day completed checkpoint samples are grouped by source slot, not invocation/attempt; no completed samples means null p95, not zero. `recentCompletionMaxSec` independently measures the maximum duration among cohorts whose first completion falls in the last 24 hours, including long-running roots older than seven days. No recent samples, absent legacy evidence, or a capped query cannot prove recovery. The checkpoint completion clock includes redemption and watchdog settlement. A completed cohort's duration does not grow across the four-hour cadence.
- `sync-live-reserves` terminal metadata preserves real adapter/persistence/circuit outcomes independently from `continuationPending`; bounded `reasons[]` can name `reserve-continuation-pending` while the admitted slice returns `ok`. A partial checkpoint child is `continuation_pending`, never `not_started`; untouched checkpoint suffixes do not write artificial skipped attempts or renew publication clocks.
- `adapterReliability` is a 30-day per-adapter rollup over `reserve_sync_attempt_history`, with `successRate = ok / attempts` and rows ordered by attempts descending. It is retained with the 15-minute self-check snapshot and rendered on the `Live Reserve Sync` card.
- `hasReserveScoreInputHold` in `shared/lib/status-thresholds.ts` owns the shared hold banner: non-healthy status, deferred/truncated/uncertain work, authoritative coverage below 0.5, or null required evidence triggers a hold. Coverage below 1.0 alone does not.
- the per-coin attempt timeline is admin-API-only (`GET /api/reserve-attempt-history?coin=<id>&limit=<n>`), returning the last-N attempts newest first, with status, failure category, warning codes, last error, and duration parsed from `metadata.durationMs` first or legacy `metadata.diag.durationMs` as fallback
- Ops causes include `reserve_sync_write_uncertain` and `reserve_cohort_slo_exceeded`. `STATUS_RESERVE_COHORT_SLO` in `shared/lib/status-thresholds.ts` is the single D7 authority: warn strictly beyond 30 minutes for an open cohort, a recent completed cohort, or seven-day nearest-rank full-cohort p95. Exactly 30 minutes is within target. A lagging p95 becomes **info** only when at least one completion is observed in the 24-hour recovery window, every observed completion meets the SLO, and the current open cohort is not over age. Preserve the p95, sample count and cause; missing recent evidence retains warning severity. On 2026-10-21, p95 was 3,691s despite 14 consecutive healthy completions (maximum 1,498s), illustrating why the rolling statistic must not imply ongoing failure. This is an ops diagnostic, not a public-health floor or admission override. Ordinary continuation does not degrade reserve status; actual evidence coverage and uncertain writes retain their gates. Authority and history still commit atomically.

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
| `latestCronStatus`, `latestCronStartedAt` | `crons["sync-yield-data"].runs[0]` status/startedAt from the live `/api/status` cron read; absent run evidence is null, independently of metadata | Existing cron-health impact; no separate escalation |

A supplemental family without a cache-row timestamp is not admitted from its payload timestamp alone. Its status remains `unknown`, with null `ageSec` and `sourceCount`, `timestampReason: "missing-timestamp"`, and `unavailableReason: "supplemental-malformed"`; a missing clock never becomes an observed zero.

## Telegram bot metrics

`GET /api/status` includes a `telegramBot` block derived from:

- `telegram_subscribers`
- `telegram_subscriptions`
- `telegram_preset_subscriptions`
- `telegram_jobs` / `telegram_deliveries` (pending backlog and delivery-SLI rollups)
- `telegram_processed_updates`

It also folds in the lifecycle snapshot plus `cron_runs` (inactive-subscriber cleanup) and cached preset query-failure counters; `worker/src/lib/status/telegram-bot-stats.ts` is authoritative. Mini App usage (`telegram_usage_daily`) is not part of this block — it is served by `/api/telegram-pulse`.

Parsed dispatch suppression flags preserve three states: `true`, `false`, and `null`. Missing or malformed safety/reserve suppression telemetry renders as unavailable rather than making the positive claim that alerts were not suppressed.

The UI consumes the typed block and dispatch metadata; missing optional telemetry is Unknown, never zero. Live safety source states remain explicit while independent DEWS/depeg/launch fan-out continues.

`GET /api/status.telegramBot` aggregates known/alert-enabled/deliverable chats; explicit and preset-implied follows, active preset followers and average explicit follows; six-family enablement and top-coin explicit/preset splits. Delivery fields include `pendingDeliveries`, `oldestPendingDeliveryAgeSec`, `pendingDeliveryBacklog` (`claimable`/`due`, `deferred`, `sending`, `executionUnknown`, `sentCleanup`, `expired`, `nearTtl`), `retryErrorClassCounts`, `customPreferenceChats`, `quietHoursEnabledChats`, `lifecycleSnapshot`, `quality`, `deliverySli`, and nonzero `presetQueryFailures`.

Recent sending stays separate. Active executionUnknown counts unexpired `unknown` delivery rows plus `sending` rows older than 15 minutes, with the oldest unknown age. Expired unknown rows remain evidence. `deliverySli` is a bounded 24h rollup over alert-family jobs and their delivery rows (broadcast and digest excluded; `suppressed_duplicate` counts as cancelled, with reason `duplicate_prior_delivery`; terminal failed/blocked/expired rows stand in for dead letters), with availability/quality/freshness: acceptance means Bot API accepted, not received/opened/read. Query failure returns availability/quality unavailable, freshness unknown and rollup null, never zeroes.

Current run/breakdown comes from the Access-protected `GET /api/status-cron-detail?job=dispatch-telegram-alerts` → `cron.runs[0].metadata`: `subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`, `snapshotSeeded`, `cappedAtLimit`, and the `deliveryV2` drain counters (claimed, sent, retried, failed, blocked, unknown, cancelled, suppressed duplicates). The default summary's `latestRunFacts` retains the current counters needed by Comms, not retired fresh-send or per-family compatibility metrics. Comms renders the bounded `deliverySli` rollup with evidence freshness/quality; failed SLI reads remain unavailable. Historical cron metadata remains available only in raw cron detail, not as current measurements.

## Synthetic self-check

The logical `statusSelfCheckOffset` lane runs `status-self-check`, `data-invariant-canary`, and `cron-sentinel` every 15 minutes. `shared/lib/cron-jobs.ts` owns its separate hourly physical trigger expressions; `shared/lib/scheduled-runner-registry.ts` owns the lane plan and budget-only work. The sentinel retains the freshness and digest-publication watchdog state keys, transition rules, 30-minute cooldowns, and operator-alert wording. Watchdog transitions commit only after successful operator-alert delivery; absent credentials, failed delivery, or cooldown suppression leave them pending. Weekly checks remain active after Monday's deadline using Monday-scoped state. Producer-adjacent modes own turnover/reserve observations; the daily mode owns duration, mint/burn growth, and repair debt. Public health reads nested daily growth/repair metadata with the retired growth row as a rollout fallback. Use the [canonical cron table](./worker-infrastructure.md#cron-scheduling) for cadence, physical aliases, Worker roles and slot identities; the runner registry owns job chains and budget-only work.

Every sentinel run publishes `metadata.mode` and a first-class `metadata.sourceStatuses` map. Non-`ok` runs with attributable current-source evidence use `metadata.reason: <mode>:<source>:<status>`; no current evidence yields `<mode>:no-current-source-evidence`. `metadata.ruleIds` inventories every registered source across modes, including non-current states; conditions live in `worker/src/cron/cron-sentinel-rules.ts`. The daily invocation is reached only through `runDailyCronSentinel`; `runCronSentinel` dispatches the status, turnover, and reserve-post-sync modes.

`metadata.firedRuleIds` records only fired predicates from current sources, unlike the configured `ruleIds` inventory. The sentinel preserves the worst current-source status; thrown evidence reads/writes remain failures. Malformed retained state is an error while current, but after expiry remains visible with `lastStatus: error` without affecting aggregate status or quality. An attempted failed operator alert is `operator-alert-delivery-failed`; cooldown and absent credentials leave transitions pending without failing execution.

Stale-slot cleanup has no status-tracked sweeper job. Same-slot takeover reconciles the displaced owner's artifacts before work resumes; the bounded digest-poll sweep discovers other stale lanes, while reserve recovery targets only its producer slot. Reconciliation preserves real terminal child rows, classifies incomplete children from durable progress, lease, cron-history and publication evidence, and writes `scheduled-slot-abandoned` markers without deleting a renewed or newer owner.

`status-self-check` then:

1. Probes critical public reads and selected admin read endpoints in two explicit planes:
   - internal self-check probes use router-dispatched `GET` requests when a Worker `ExecutionContext` is available. They exercise handler routing and dependency hydration for app/router isolation, but bypass the Worker HTTP access gate, public rate-limit gate, custom-domain routing, and edge-cache path. If the cron is invoked without `ExecutionContext`, the same self-check set falls back to real HTTPS probes against `SELF_URL`.
   - external production probes always use real HTTPS `fetch()` calls through the production custom domains with a 10s timeout per endpoint: `https://api.pharos.watch/api/health`, `https://site-api.pharos.watch/api/health` when `SITE_API_SHARED_SECRET` is configured, a `site-api.pharos.watch` access-gate probe expecting `401` or `403` when that shared secret is absent, and `https://ops-api.pharos.watch/api/status-history?limit=1`.
   - the ops API canary expects a blocking response (`302` or `403`); a successful open response is treated as `ops-api-access-gate-open-or-unreachable`. This smoke accepts any redirect Location and does not verify Access identity or authenticated ops availability. The site target likewise proves only negative-auth gating when the trimmed shared secret is absent.
   - internal-router timings reflect uncached worker handler execution, not browser-visible edge-cache latency. External timings reflect the production edge path.
   - non-health response bodies are canceled rather than downloaded. The V9 handler still authenticates all immutable fragments before successful headers, so its probe includes D1 round trips and integrity CPU, not ordinary body-download time. Its [bounded fragment-read optimization](./process/worker-infrastructure-appendix.md#v9-public-response-materialization) does not alter probe thresholds or percentile calculations. D1 await wall time includes round-trip/queueing overhead and must not be reported as SQL execution CPU.
   - `/api/health` is parsed semantically: valid `200` bodies with `status: degraded|stale` set `ok: false` / `error: reported-degraded|stale`, contribute semantic status and `details.failed`, but are excluded from connectivity counts. Discrepancy increments only on effective/probe divergence. Separate `transportStatus` and `semanticStatus` accompany combined `probeStatus`. Invalid payloads, failed/access-gate probes and absent connectivity samples remain `probe-execution-failed`. Successful connectivity samples with zero failures but p95 above the healthy transport band use `probe-latency-exceeded`; the cron remains `degraded`, including when the probe transport band is `stale`. Persistence and evidence-read failures retain their higher-priority reasons. Probe thresholds, semantic quality findings and discrepancy/streak behavior are unchanged. `/api/status` is evaluated separately through `computeRawStatus()` and `reconcileStatusState()`.
   - `semanticStatus` is `null` with `semanticStatusReason: probe-semantic-evidence-unavailable` when no admitted health result was observed. Broken payloads or failed transport cannot create a positive semantic claim. The rotating internal and fixed external populations are unequal; plane divergence supports triage, not causal outage or paging inference.
   - cache-backed bootstrap probes (`/api/usds-status`, `/api/bluechip-ratings`, `/api/yield-rankings`) suppress internal-router `503` failures when both the permanent observed marker and retained producer cron rows are absent. The marker is seeded only on this `503` path, so pruned history can misclassify a previously run producer; no-context HTTPS fallback does not apply bootstrap suppression.
2. Persists probe aggregate to `status_probe_runs`.
3. Reconciles raw status into persisted effective state.
4. Tracks divergence streak and probe-failure streak in `status_discrepancy_state`.
5. Exposes the sustained-divergence and sustained-probe-failure streaks as `discrepancyStreak` / `probeFailureStreak` in the cron metadata, alongside the internal/external comparison so operators can separate app/router regressions from custom-domain, Access, routing, cache, and edge-path regressions. There is no outbound alert transport; escalation is operator-driven from the status surfaces.
   - A failed discrepancy SELECT stops before UPSERT and exposes both counters as unavailable (`null`); a successfully read absent row may initialize counters. The UI prints an unavailable streak explicitly. Probe-failure streak means transport/contract failure **or internal/external divergence**, not transport failures alone; effective/probe divergence is a distinct diagnostic. Neither changes status authority or emits a condition-specific push notification.

All five required stores (`status_probe_runs`, `status_state`, `status:raw-snapshot:v1`, `status:public-health-snapshot:v1`, `status_discrepancy_state`) must succeed, including required reads. Failure returns `status-self-check-persistence-failed`, lists `failedOutputs`, and sets `outputPublishedAt: null`; this takes precedence. Explicit `evidenceReadFailures` collect current DB, cron, scheduler, public-health, data-quality and supplement outcomes, independently of presentation error wording; failures return `status-self-check-evidence-read-failed`, not a semantic service finding. Hysteresis and probe thresholds are unchanged.

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
and `streakDegradedRuns`, counting degraded confirmed publications since the last clean confirmed publication (`null` when the producer-history read failed — an unreadable streak is never published as `0`). Failed, deferred, and no-op candidates neither contaminate a retained clean generation nor clear published degraded quality. Execution failures remain cron/dependency diagnostics; freshness continues aging the accepted publication. A failed producer-history read
itself publishes `degraded: null` with `degradedReason:
"producer-history-unreadable"` (rules R2/R4): unreadable quality evidence is
unknown, never clean, even behind a valid in-budget sentinel. A cache is
also unknown with `producer-publication-unconfirmed` when confirmed producer
output is absent or predates the sentinel, or its retained generation ID differs
from the served generation. DEX terminal metadata supplies that generation ID;
lanes without it use the confirmed output clock. This prevents a publication
followed by a terminal failure from borrowing an older generation's clean verdict.
A cache is
`healthy` only when it is inside its band **and** its quality verdict is
explicitly clean, so a table fallback that is age-fresh, a good sentinel whose
confirmed publication has degraded input quality, and a good sentinel whose quality evidence could
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
The retired `last_alert_at` / `last_probe_alert_at` columns have no live code/test-mock use. Their class-(i) removal follows C10 in `worker/migrations/MANIFEST.md`; preserve all rows, scope keys, live counters and timestamps. No sender is reintroduced.

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

`GET /api/admin-action-log?limit=100` feeds persistent execution history. The Actions and History workspaces reconcile current-session intents only when the canonical action path and `details.idempotencyKeyHash` match the session request's SHA-256 `Idempotency-Key` hash. One matched identity contributes one persisted activity, retaining its authoritative outcome, actor, target and audit clock alongside session-local status, in-flight state and scope context. Different hashes remain distinct regardless of display labels, mode text or nearby timestamps. Historical rows without identity evidence remain separate persisted provenance; session-only results stay explicitly labeled until their durable row is available. Raw idempotency keys are not added to audit history.

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


High confidence means independent agreeing sources or a validated authoritative override; correlated list-aggregator agreement may be single-source rather than independent corroboration. Value-weighted display changes neither source independence/freshness nor confidence assignment. Missing-price health remains separate; missing and acknowledged assets receive no invented price.

## CoinGecko Price Drift Card

`CoinGeckoPriceDiffCard` (`src/components/status/coingecko-price-diff.tsx`) reads the admin `/api/status` supplement. It flags active tracked assets with `geckoId`, a current comparable Pharos price, and a live CoinGecko difference above 5%, sorted by `diffPct` descending. The batched `simple/price` read admits only upstream timestamps accepted by the shared freshness validator; missing, invalid, stale or materially future timestamps are not comparable. A failed lookup returns `null` and `sectionErrors.coingeckoPriceDiff`, not a no-drift claim.

The retained operator-only historical depeg audit is separate from this live card. Its [sample-admission and completeness contract](./runbooks/one-shot-backfills.md#audit-depeg-history) rejects malformed or out-of-window millisecond clocks before price validation and reports `rejectedByTimestampCount`; rejected temporal evidence cannot establish a confirmed, disputed or false-positive verdict. It neither changes the live drift threshold nor automatically rewrites retained audit provenance.

## D1 Usage Card

`D1UsageCard` (`src/components/status/d1-usage-card.tsx`) reads the admin status snapshot; boundaries and health impact belong to [D1 capacity signals](./runbooks/db-connectivity.md#capacity-signals). Optional `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_STATUS_API_TOKEN` and `CLOUDFLARE_D1_DATABASE_ID` enable REST info plus concurrent trailing-24h GraphQL analytics. Missing bindings yield null; config/read failures set `sectionErrors.d1Usage`.

Measurements normally come from the 15-minute self-check and remain valid for 30 minutes, not a Cloudflare fetch per browser poll. Live fallback may refresh capacity history; observations coalesce by UTC hour without hourly-throttling the fetch, while `capacity.hourlyMinMax24h` retains the trailing-24h extremes. Displayed bytes use binary units while the platform limit remains decimal 10 GB. Per-table census is API-only, reuses same-UTC-day cache under the cron lease (not a separate claim), and has a 50-hour serving budget. Growth/exhaustion forecasts use the shortest valid regression and remain advisory; utilization thresholds own health. The projected-monthly `quota` floors are a separate ops-only cost signal and never appear in public health.

## Mint/Burn Reconciliation Card

The operator card is **Mint/Burn Integrity**, a permanent per-contract native conservation diagnostic. The API field name `mintBurnReconciliation` remains; `conservationVersion: 1` identifies the native verdict. Configured active identities are enumerated independently of supply-cache/comparison availability, using the same active-ID universe as the producer; retained configs for excluded variants or cash equivalents do not create permanent lag/missing-evidence warnings. The unmatched circulating-supply comparison and unused native summary counts are retired without aliases; older payloads without native proof remain unverified.

### Matched-block integrity

The existing mint/burn producers write compact audit records into `cache` under `mint-burn:conservation:<configKey>`. Status reads these records in bounded batches; it never makes archive RPC calls. Each record identifies the contract, decimals, config fingerprint, audit time, exact block boundaries/hashes, raw mint/burn totals, supply delta and residual in native integer units. Raw events include amounts below the public cutoff and atomic/bridge activity.

The published `mintBurnReconciliation` projection omits `configFingerprint` after validating the cached
record against the current configuration. The shared record schema permits that omission for status
payloads; cached evidence still requires an exact fingerprint match for admission. No fingerprint-less
cached record can certify a conservation pass.


A successful record proves the reviewed law exactly: by default, `rawMint - rawBurn = totalSupply(toBlock) - totalSupply(fromBlock)` for logs after the displayed opening checkpoint through the closing checkpoint; USDO instead records net raw shares against the `totalShares` delta (`units: "raw-shares"`). The card shows individual contract ranges; different ranges are not added into a fabricated coin-wide 24-hour audit. This is a latest-scan integrity check, not a proof of complete historical coverage or issuer reserves.

- **Verified:** every configured contract has an eligible, valid, matching-identity passing audit whose observation and closing checkpoint are both no older than 75 minutes, whose lane's latest completed scan is inside the public freshness window and ended `ok` or `degraded`, whose stored sync cursor is at or beyond the audit's opening block, and whose lane's observed chain head is at or beyond its closing block. The row's `coverageStatus` reports flow-coverage health separately: a config whose scan cadence is stretched by the extended lane's budget deferral can read `lagging` while its audited window remains verified.
- **Critical:** an identity-valid, arithmetically verified native mismatch remains unresolved. An unavailable later attempt does not clear it; verified recovery is required.
- **Unverified:** missing, stale, malformed, unsupported, partial or otherwise unusable audit evidence. A changed contract/config fingerprint cannot inherit a previous pass.

The committed evidence sidecar `worker/src/lib/mint-burn-conservation-reviewed.json` is the only list of admitted and explicitly unsupported identities, with per-identity reviewer evidence and audited windows for admitted entries. Exact identities and their conservation laws are reviewed explicitly; an `unsupported` entry carries a reason from the fixed vocabulary in `worker/src/lib/mint-burn-conservation.ts`, and unsupported configs remain visible and unverified. `m-m0` is explicitly unsupported (`rebasing-supply-without-events`) because its index accrues over time. Adding another asset requires proving a compatible law and adding the exact contract identity to the sidecar. A reviewed coin does not automatically admit a replacement contract.

The [reviewed alternative laws](./mint-burn-flows.md#raw-token-conservation) cover USDT `config-events` (Issue/Redeem plus conservation-only DestroyedBlackFunds, guarded by `deprecated()`), OUSD `transfer-plus-vault-yield` (Transfer net plus vault yield minus fee, with rebase pairing, saturation, identity and upgrade guards), and USDO `usdo-bonus-multiplier-shares` (multiplier replay, exact `totalShares` law and closing-view checks, recorded in raw shares). Conservation-only events are fetched in the same scan but never become public flow rows; public Mint/Burn Flow methodology is unchanged.

The API row retains `conservation`, `coverageStatus` and native `conservationIssue`; the summary retains `criticalCount`. Public flow classifications, dust thresholds, prices, market caps and Safety Scores are unchanged.

The retired completed-hour USD-flow versus daily-circulation comparison cannot establish ingestion integrity: windows, scopes and valuations do not match, and no threshold repairs comparability. Net conservation alone also cannot detect omitted offsetting event pairs; producers verify retrieved eligible identities against parsed output and stored native fields before publishing a pass, alongside scan-coverage guards.

Producer behavior, budgets and recovery are documented in [Mint/Burn Flows: Raw token conservation](./mint-burn-flows.md#raw-token-conservation).

## Rendering And Refresh Contract

- No workspace owns a free-running root clock. Query evidence refreshes re-anchor the model; relative-time labels tick only inside `FreshnessIndicator` leaves.
- Collapsed disclosures mount content only while open, keeping healthy diagnostic tables and verbose evidence out of the hidden DOM.
- Triage auto-expansion runs once on the first render with definite evidence. Later issues update the collapsed summary without moving the operator mid-task.
- Refetches retain the last successful payload and surface background failures through `WorkspaceStatusBoundary`.

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

Worker D1 table-growth types derive from their runtime schema outputs in `status/d1-usage.ts` (including defaulted `failedTables`); supplement types derive from `status/raw-snapshot.ts` schemas while retaining the shared `StatusSectionErrors` key restriction.

## Cron Implementation Appendix

### Cron metadata persistence budget

`worker/src/lib/cron-metadata-persistence.ts` owns write-time UTF-8 admission: **8 KiB per job** by default,
including scheduler/lease identity. Explicit exceptions preserve existing consumer contracts: **16 KiB**
for `sync-dex-liquidity` source coverage; **32 KiB** for each mint/burn lane's cursor/head coverage and
`sync-live-reserves` exact breaker names / warning cohorts; **64 KiB minus one byte** for
`sync-stablecoins` complete missing-asset continuity and `cron-sentinel` nested source /
stale-generation evidence. These are ceilings, not producer targets.

Above budget, named forensic diagnostics (`adapterLatency`, `priceSourceAttemptLedger`,
`providerDiagnostics`, `fullAssets`, `bridgeJoinDiagnostics`) are summarized first. Remaining unread
collections can move into bounded `diagnostics`; compaction records its original size, budget and omitted
diagnostic count. Consumer-read fields stay at their original paths and retain their complete shape:
publication/reason/quality, mode, stale rows and source evidence, `resourcePressure`, `d1Cost`, retention /
truncation flags, coverage, ledger and scheduler identity. `breakerKeys` remains an exact list because the
reserve summary renders names; `activePriceCoverage` retains full missing IDs/state because the next run
and public health reconstruct streaks from it. These two fields must not become counts. If contractual
evidence alone exceeds its job exception, terminal persistence still proceeds with
`persistenceCompaction.overBudget: true` and a warning log naming the job, budget and actual persisted
bytes. Consumer evidence is never dropped to meet the budget, and a budget exception cannot prevent
terminal accounting. Normally compacted rows carry `overBudget: false`.

`cron_runs.metadata` is the sole rich terminal payload. Producer history keeps only `mxLedger*` activation
evidence plus accepted-terminal arbitration scalars; the child-attempt table stores fencing columns, not
another JSON copy. Live `cron_run_progress` remains a separate bounded, temporary observation. Lease
normalization never sacrifices consumer evidence to reserve space for adapter diagnostics.

Scheduler-normalized row and validation counters (`rowsRead`, `rowsWritten`, `rowsDropped`,
`validationFailures`) preserve explicit `null` and use `null` for missing measurements. Numeric values
come from producer observations: zero means an observed zero, not absent telemetry. `itemCount` is not
a write count and does not populate `rowsWritten`. Terminal compaction retains these values unchanged;
forensic consumers must treat null as unavailable and must not reinterpret historical defaults as measured counts.
