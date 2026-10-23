# Worker Infrastructure

> **Agent navigation** — Current invariants and interfaces are below. Detailed implementation and historical decisions are retained in the [appendix](./process/worker-infrastructure-appendix.md). Read routed sections rather than either file wholesale.

Two Cloudflare scripts share one fenced D1 authority. `stablecoin-api` serves HTTP routing, edge caching, CORS, admin auth and public-owned scheduled work; `stablecoin-heavy` owns heavy scheduled plans and one authenticated private `project-tape` fetch executor, with no public routes. The union of `worker/wrangler.toml` and `worker/wrangler.heavy.toml` owns deployed expressions, `CRON_JOB_DEFINITIONS` owns status-tracked jobs, and `CRON_CONNECTION_BUDGET_ENTRIES` also covers budget-only surfaces. Run the cron sync and connection-budget checks for current topology.

Execution note: the `snapshot-supply` retry path runs on the logical quarter-hour schedule, deployed through the single-minute hourly aliases in `shared/lib/cron-jobs.ts`, only after a downstream-safe `sync-stablecoins` cache write. The `0 8 * * *` daily fallback additionally requires the `stablecoins` cache row to be written at or after that scheduled slot start before it can consume write-once daily artifacts.

**Deployed at:** `api.pharos.watch` (public integration API), `site-api.pharos.watch` (website-internal data lane), and `ops-api.pharos.watch` (operator lane; pair with Cloudflare Access before use)


---

## Runtime Limits and Observability

Worker runtime safety and telemetry controls are declared in both Wrangler configs and managed in git. CI proves both strict bundles before one D1 migration application, then deploys heavy followed by public. Routes, triggers and bindings synchronize through `wrangler deploy --strict`; dashboard-only edits can be overwritten.

`npm run check:worker-config` owns runtime safety and paired Public/Heavy configuration; `npm run check:doc-sync` verifies that this TOML snippet matches `worker/wrangler.toml`.

```toml
compatibility_date = "2026-04-18"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
preview_urls = true
minify = true
keep_names = true
upload_source_maps = true

[alias]
"#pharos-full-catalog" = "./src/lib/full-stablecoin-catalog.ts"

[[rules]]
type = "Text"
globs = ["**/coins.worker-full.generated.json"]
fallthrough = true

[limits]
cpu_ms = 300000

[observability]
enabled = true
head_sampling_rate = 0.1

[observability.logs]
enabled = true
invocation_logs = true
```
- CPU caps are compute time, independent of wall-clock cron timeouts; Cloudflare still applies trigger-specific ceilings.
- Qualify compatibility changes for both roles at baseline/candidate dates in a dedicated release; Heavy neutral smoke is not producer acceptance. See [runtime experiments](./process/worker-runtime-experiments.md).
- `global_fetch_strictly_public` keeps custom-domain self-fetches on the public edge; production canaries depend on it.
- Public sampling is `0.1`, Heavy `1`; both retain invocation logs. Public preview URLs are diagnostic, outside the release gate; Heavy has no public routing or preview URL.
- Minification preserves diagnostic names. Bundle-size reduction/local workerd success is not Cloudflare peak-memory acceptance.
- Both roles upload private JS/TS source maps (`upload_source_maps = true`) for original file/line stack traces. The packed catalog ships separately as a Text module, not map source content. Cloudflare never serves these maps; dry-run artifacts stay in `.cache/release-check/`. `check:worker-package` reports every map's gzip size, enforces a 13,500,000-byte budget, and rejects maps under public Pages assets (`out/`).


Use `logCronRun()` for terminal outcomes, `recordCronFailure()` for non-fatal exceptions, `logCronEvent()` for durable non-terminal events, and `logWorkerEvent()` for structured route logs. [Logging and privacy details](process/worker-infrastructure-appendix.md#logging-and-privacy-details) owns bounded metadata, price-corroboration telemetry, Telegram privacy, recursive credential redaction and retention. Provider URLs must be redacted before logging; invocation logs containing Telegram Bot API URLs remain secret.

---

## Env Interface

`Env` (`worker/src/lib/env.ts`) projects the shared binding manifest through a Worker-local platform type map; shared code imports no Worker globals. Wrangler owns deployed bindings and vars, checked against manifest key/type metadata by `npm run check:env-contract`. Operator requirement status is separate from ingress requiredness: `GITHUB_PAT`, `FEEDBACK_IP_SALT`, and `BANXICO_TOKEN` remain optional properties, with missing credentials reported by runtime validation.

`worker/src/lib/env.ts` exports the worker runtime views used by validation:

- `WORKER_RESERVED_ENV_KEYS`
- `WORKER_ACTIVE_ENV_KEYS` (`required + optional`)

Pages inventories are queried directly through `shared/lib/env-contract.ts`, not eager exports from the proxy modules. Validation reports partial Access/admin-D1/Telegram pairs, missing site-proxy/feedback/API-pepper/Banxico credentials, no-op `API_KEY_HASH_PEPPER` rotation, and Telegram `_PREVIOUS` values without their corresponding current token or secret. Ops requires team domain plus UI audience. Site-data requires `DB` for fail-closed selector POST quotas; public reads can continue without attribution. Binding ownership/requirements are in the linked inventory.

`ScheduledEnv` is the narrow shared scheduled-context view; `HeavyEnv` in `worker/src/lib/env.ts` requires no Workflow binding. Heavy shares public's D1, version metadata, compatibility, alias/module and CPU settings, without HTTP/CORS/rate-limit bindings. [The operator sunset record](process/worker-infrastructure-appendix.md#safety-score-v9-workflow-shadow-pilot) owns retirement status and rollback floor.

Heavy additionally requires `SAFETY_CAPTURE_ARCHIVE`, an R2 binding to the existing `pharos-measurements` bucket, declared only in `worker/wrangler.heavy.toml`. The scheduled publication adapter passes it into accepted-capture archiving; public has no bucket binding. The unified `Env`/`ScheduledEnv` view marks it optional for public compatibility, while `HeavyEnv` requires it and `check:worker-config` enforces the heavy bucket name/ownership. No R2 credentials are required by the Worker binding; offline archive tooling uses the operator's existing `R2_MEASUREMENTS_*` client credentials.

Heavy's operator secret inventory and provisioning are owned by [deployment prerequisites](deployment-process.md#first-heavy-deployment-prerequisites-adr-38) and the generated binding contract, not a second roster here. Dwellir admission remains key + usable shared monthly credit ledger + valid `dwellir-evm` breaker; denied admission preserves incumbent RPC order. Heavy normally consumes ready public-produced D1 stages and has Graph credentials to reconstruct exact missing/terminal DEX stages under the source lease and inherited deadline. A live source producer remains a neutral wait, never a recapture opportunity. Missing credentials still fail preflight (`missing-graph-api-key`). Reserves/recovery stay public; Heavy requires no Telegram/admin/site/Anthropic credentials.

Operational telemetry control: set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on the Worker and/or Pages site-data environment to stop low-value route/source attribution writes. This disables Worker `api_request_source_samples` and Pages `site_data_request_samples` writes (including certainty transport observations), while preserving API-key authentication, D1-backed rate limiting, last-used metadata updates, and per-key public API load telemetry. During keyed public-API spikes, set `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true` on the Worker to pause only `api_key_request_stats` writes; auth, rate limiting, and last-used metadata still run.

Request-source reads require `measurementVersion=2`. [Request Attribution](process/worker-infrastructure-appendix.md#request-attribution) owns the reader-before-writer migration, sampling/estimate semantics, daily bounded retention and rollback floor.

The complete key-by-key contract is in [Binding Inventory](process/worker-infrastructure-appendix.md#binding-inventory), generated from the manifest and validated by `check:env-contract`. This reference table does not independently author requirements. Collector, repair, canary, and recovery behavior is separated into [Runtime Feature Contracts](#runtime-feature-contracts); a binding's presence alone does not establish that feature's admission or publication authority.

## Runtime Feature Contracts

Measured DEX execution, including current cohorts and historical native-lane removals, is owned by the [DEX liquidity methodology](./dex-liquidity.md). This document retains only the generic cron capacity, scheduling, and retention contracts; operators should not infer removed native collectors or former schedules from this infrastructure overview.

Stablecoins cache reads retain the loader's result union: `missing-cache` requires a successful absent read; D1 rejection returns `cache-read-failed` with no observation clock. Invalid payloads remain separately named failures; only admitted payloads authorize downstream data claims.

The [DEX implementation contract](process/dex-liquidity-appendix.md#dex-liquidity-score) owns source-stage cadence/recovery, whole-coin admission/rotation, cohort eligibility, quote/target generations, exact-route evidence and transient retention. [DEX operations](process/dex-liquidity-appendix.md#v69-deploy-and-rollback-operations) owns version cutover and rollback. Active/shadow evidence stays distinct; registry presence, age, null publication clocks or an unrelated newer invocation never establish score eligibility or safe deletion. Unknown ownership, missing exact terminal/reference evidence and live artifacts remain protected. Domain cleanup cannot weaken the shared fence/publication contract.

Repair debt uses only `worker_repair_tasks`; the obsolete cache is not read/write authority. Preserve task-backed unknown-on-read-error and negative legacy-cache tests. The daily `cron-sentinel` repair-debt source reports due/stale backlog and executes enabled T1.2-safe work. `DDR_REPAIR_TASK_RUNNER_ENABLED` defaults on for unset/empty values; invalid nonempty values disable execution with warning. Reconciliation and terminal retention remain active.

Data-invariant canaries are permanent operator diagnostics, not an alert or scoring rollout. Unset `WORKER_CANARY_MODE` defaults to `off`; checked-in config uses `status`. `ACTIVE_CANARY_CHECK_IDS` owns the nine-check cohort; scheduled admission rejects missing, duplicate or unexpected IDs and incomplete measurements. The advisory latest-per-check aggregate separately disqualifies stale, materially future-clock (beyond the 60-second skew allowance) or legacy execution-unknown evidence from healthy status. DEX checks count actual current-table publication violations only for rows with a non-null `publication_generation_id` whose `publication_state` is null or not `published`; retained generationless compatibility rows are excluded. The latest published generation's actual published-row count is independently checked against its publication metadata, and the global-row check counts generation-bound `__global__` rows. Legitimate staged candidates in private run tables are not exposed-current violations. Blacklist identity completeness detects rows missing both `config_key` and `contract_address`. In `status`, completed measurements persist their original finding status/severity and return cron `ok` plus named `quality`, including severe corruption. Failed required reads, unusable contracts, incomplete cohorts and persistence failures remain operationally degraded. Each check exposes `executionStatus` and `executionFailureReason` independently of finding severity. `off` performs no canary work and does not stop independent probes or sentinel execution. There is no condition-specific push escalation, even for severe findings; operators must inspect status/ledger evidence. The separately scheduled sentinel retains its own Telegram delivery predicates.

Completed informational `skipped` findings are intentional non-measurements: they retain their skip reason/count but do not alone degrade cron `observedStatus` or add `quality`. A successfully read empty DEX publication skips the row-consistency comparison; the independent global-row check still reports missing current data as degraded. Failed required measurement work remains degraded regardless of finding status. The advisory latest-per-check canary aggregate retains its existing conservative degraded treatment of skipped evidence, rather than claiming every invariant was measured healthy.

**Deployed-override gate (2026-10-08):** status-only/no-paging policy is approved, but the complete inventory of deployed Workers/environments, dashboard/config/secret overrides and private tooling has not been recorded. Until that inventory intentionally migrates every selection to `status` or `off`, `shadow` (hidden collection/unconditional-success policy) and `alert` (stronger terminal-error policy, not an alert sender) remain accepted. After inventory closure, remove those branches and normalize obsolete selections to `off`; never remap retained historical modes into current evidence. No paging activation is planned.

Reserve recovery: `WORKER_RESERVE_RECOVERY_MODE` defaults to `off`; checked-in config uses `recover`. Checkpoints are always written. The five-minute `3/6` lane `fiveMinuteReserveRecovery` (`:01/:06/…/:56`) claims compatible suffixes and, when none is claimed, runs config recovery on the same opportunity under the reserve lease. Redemption's three-worker pool sets the replay peak. [Deploy-time configuration recovery](process/live-reserves-appendix.md#deploy-time-configuration-recovery) owns targeting, one-opportunity consumption and acceptance.

### Project-tape placed-fetch canary


Only `project-tape` on public's `dewsPsiOffset` may delegate through heavy's private default-fetch service binding; DEWS and PSI remain serial/in-process. `PROJECT_TAPE_PLACED_EXECUTOR` accepts exact `on`/`off`; checked-in `on` requires matching secrets on both Workers. Invalid modes warn and run locally; failed remote execution never retries or falls back within the slot.

The public driver retains the original deadline, generation, lease and terminal accounting. Executor delivery is one-shot and every write is fenced; rollback affects future slots only. Placement is a fetch-only hint, not a pinned location. [Placed-fetch operation and qualification](process/worker-infrastructure-appendix.md#project-tape-placed-fetch-details) owns secret provisioning, failure diagnostics, transport/settlement guards, evidence and the mandatory go/no-go before any second lane.


### V9 public response materialization

With heavy `SAFETY_V9_DEFERRED_MATERIALIZATION = "on"`, acceptance commits first and a follow-up step stages immutable, generation-bound public fragments and selects them atomically while that generation is still accepted; `"off"` (checked in) selects them inside the acceptance batch. Readers serve the previously selected whole generation meanwhile; request health remains live. [Materialization, rollout and qualification](./process/worker-infrastructure-appendix.md#v9-public-response-materialization) owns admission, integrity, retirement and missing-artifact repair.

## Module Initialization


Escape non-ASCII Worker source (`\uXXXX`), including regex literals: raw code units above U+00FF double retained V8 source, and even Latin-1 UTF-8 can retain two-byte source. `check:worker-package` enforces the Latin-1 guard, not peak-memory acceptance.

Derive Env/credentials per invocation, never during module initialization. Import API-key owner leaves directly, keeping admin mutation code outside eager HTTP gates. Inventory isolate state; redemption joins stay run-local and immutable, never globally clock-keyed.

RPC inventory is not capability. Dwellir needs key, ledger/breaker admission and an enabled chain; preference cannot reorder incumbents or expand inventory. HTTP has no native capability. Native reads require exact pins, header credentials, ledger floors, manual redirects and non-2xx rejection. Admit history/finality evidence; never assume archives or fall back to latest/hash-to-number.

Single-URL JSON-RPC transport shares authenticated POST/envelope validation, not provider policy: eligibility, failover/demotion, admission, credits and partial log-context recovery remain caller-owned. Parity diagnostics retain their independent measured transport.

Economic-supply leaf readers retain no pin or result cache. The invocation-local orchestrator owns sequential phases, route rejection names and diagnostics; mandatory finalized-header freshness includes the reserved capture deadline before quantity reads, while optional finalized preference retains its reviewed-lag fallback.

[Initialization/RPC details](process/worker-infrastructure-appendix.md#initialization-and-rpc-boundaries) owns implementation names, cache lifetimes, chain exceptions and the [memory boundary](process/worker-infrastructure-appendix.md#module-initialization-memory-evidence). [Read admission](process/worker-infrastructure-appendix.md#rpc-read-admission-details) governs decoding, recovery, timestamps, ancestry and capped-log completeness; failures cannot manufacture state.



---

## HTTP Request Handling

### HTTP request handling entry

Select the contract affected by the request path rather than reading the entire HTTP chapter:

- Routing and browser responses: [Method Routing](process/worker-infrastructure-appendix.md#method-routing), [CORS Headers](process/worker-infrastructure-appendix.md#cors-headers), and [Edge Cache Strategy](process/worker-infrastructure-appendix.md#edge-cache-strategy).
- Public credentials and traffic: [Public API Auth and Rate Limiting](process/worker-infrastructure-appendix.md#public-api-auth-and-rate-limiting) and [Request Attribution](process/worker-infrastructure-appendix.md#request-attribution).
- Privileged callers: [Admin Auth](process/worker-infrastructure-appendix.md#admin-auth), [Site-Data Auth](process/worker-infrastructure-appendix.md#site-data-auth), and [Idempotent Admin Actions](process/worker-infrastructure-appendix.md#idempotent-admin-actions).
- Stateful reads and maintenance: [D1 Read Snapshots And Pagination](process/worker-infrastructure-appendix.md#d1-read-snapshots-and-pagination), [Append-only D1 Retention Policy](process/worker-infrastructure-appendix.md#append-only-d1-retention-policy), and [Isolate-Local State Registry](process/worker-infrastructure-appendix.md#isolate-local-state-registry).

The [API reference](./api-reference.md) owns endpoint contracts; the [admin reference](./api-reference-admin.md#admin-endpoint-entry) owns operator-only routes.

[API Endpoint Authoring: Source Of Truth](./api-endpoint-authoring.md#source-of-truth) owns the path/method and auth/cache/site-data metadata inventory; the appendix retains request-order and handler semantics.

### Compact website transports

Site-only projections retain independent query identities and original producer evidence; the [compact transport index](./process/worker-infrastructure-appendix.md#compact-website-transports) links their owning contracts.

### Completed D1 Schema Cleanup

The canonical operated-cleanup history, current production removals, rollback limits, and deferred queue live in [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md#completed-destructive-cleanup-operations). Do not duplicate that inventory here. Destructive cleanup remains outside the normal migration path and requires production backup/Time Travel verification, fresh zero-use evidence, and a dedicated operated rollout after compatible Worker code has soaked.

## Cron Scheduling

<!-- GENERATED-START: cron-doc-view -->
<!-- Generated by scripts/maintenance/generate-cron-doc-view.ts. Do not edit by hand. -->

UTC inventory from `shared/lib/cron-jobs.ts`, `shared/lib/cron-cadences.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/wrangler.toml` and `worker/wrangler.heavy.toml`. Public = `stablecoin-api`; heavy = private `stablecoin-heavy` (scheduled plans plus the project-tape fetch executor).

Interval / offset are logical-slot seconds, not job freshness or delivery evidence. Aliases can move without changing logical slot identity. The monthly cron owns calendar firing dates.

| Logical slot key | Logical cron | Interval / offset (s) | Physical trigger expression(s) | Worker role |
| --- | --- | --- | --- | --- |
| `quarterHourly` | `*/15 * * * *` | 900 / 0 | `0 * * * *`<br>`15 * * * *`<br>`30 * * * *`<br>`45 * * * *` | public |
| `v9SupplyAttributionOffset` | `8,23,38,53 * * * *` | 900 / 480 | `8 * * * *`<br>`23 * * * *`<br>`38 * * * *`<br>`53 * * * *` | heavy |
| `depegResolverOffset` | `13,28,43,58 * * * *` | 900 / 780 | `13 * * * *`<br>`28 * * * *`<br>`43 * * * *`<br>`58 * * * *` | public |
| `v9PublicationOffset` | `22 * * * *` | 3600 / 1320 | `22 * * * *`<br>`52 * * * *` | heavy |
| `statusSelfCheckOffset` | `9,24,39,54 * * * *` | 900 / 540 | `9 * * * *`<br>`24 * * * *`<br>`39 * * * *`<br>`54 * * * *` | public |
| `sixHourlyBlacklist` | `3 */6 * * *` | 21600 / 180 | `3 */6 * * *` | public |
| `halfHourlyMintBurnCritical` | `4,34 * * * *` | 1800 / 240 | `4 * * * *`<br>`34 * * * *` | public |
| `twoHourlyDexDiscovery` | `6 */6 * * *` | 21600 / 360 | `6 */6 * * *` | public |
| `halfHourlyMintBurnExtended` | `18 * * * *` | 3600 / 1080 | `18 * * * *` | public |
| `halfHourlyMeasuredExecution` | `0,30 * * * *` | 1800 / 0 | `5 * * * *`<br>`35 * * * *` | public |
| `halfHourlyMeasuredExecutionSupplemental` | `15,45 * * * *` | 1800 / 900 | `20 * * * *`<br>`50 * * * *` | public |
| `halfHourlyOffset` | `10 * * * *` | 3600 / 600 | `10 * * * *` | public |
| `halfHourlyChartsOffset` | `16,46 * * * *` | 1800 / 960 | `16 * * * *`<br>`46 * * * *` | heavy |
| `dewsPsiOffset` | `26,56 * * * *` | 1800 / 1560 | `26,56 * * * *` | public |
| `fourHourlyReserveSync` | `11 */4 * * *` | 14400 / 660 | `11 */4 * * *` | public |
| `hourlyYieldSync` | `55 */2 * * *` | 7200 / 3300 | `55 */2 * * *` | public |
| `fourHourlyYieldSupplemental` | `25 */4 * * *` | 14400 / 1500 | `25 */4 * * *` | public |
| `fiveMinuteTelegramAlerts` | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` | 300 / 120 | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` | public |
| `fiveMinuteReserveRecovery` | `1,6,11,16,21,26,31,36,41,46,51,56 * * * *` | 300 / 60 | `1,6,11,16,21,26,31,36,41,46,51,56 * * * *` | public |
| `digestTriggerPoll` | `*/5 * * * *` | 300 / 0 | `*/5 * * * *` | public |
| `daily0300Utc` | `0 3 * * *` | 86400 / 10800 | `3 3 * * *` | public |
| `daily0800Utc` | `0 8 * * *` | 86400 / 28800 | `0 8 * * *` | public |
| `daily0805Utc` | `5 8 * * *` | 86400 / 29100 | `5 8 * * *` | public |
| `daily0810Utc` | `10 8 * * *` | 86400 / 29400 | `10 8 * * *` | public |
| `monthlyYieldAudit` | `0 6 1 * *` | 2592000 / 21600 | `0 6 1 * *` | public |

<!-- GENERATED-END: cron-doc-view -->

Cron expressions are source-owned by the two Wrangler configs. Logical schedule keys, physical aliases, status-tracked jobs and connection budgets live in `shared/lib/cron-jobs.ts`; dispatch chains and Worker ownership live in `shared/lib/scheduled-runner-registry.ts`. Hourly aliases preserve logical sub-hourly cadence while using Cloudflare's hourly CPU class. `runScheduledSlotWithFence()` in `worker/src/lib/scheduled-slot-fence.ts` owns claim, heartbeat, takeover and terminal fencing; `scheduled-slot-reconciliation.ts` owns stale child progress/lease cleanup, synthetic run persistence, attempt abandonment and operator event markers. The [scheduling appendix](process/worker-infrastructure-appendix.md#cron-scheduling) retains progress snapshots, child-outcome escalation and owner-aware Worker-version forensics. A job normally owns one schedule key; `SHARED_SCHEDULED_JOB_IDENTITIES` is the closed multi-slot allowlist (`cron-sentinel` runs from four). An unregistered/unallowlisted dispatch makes descriptor construction throw. Sharing identity shares a lease, status row and freshness reading against the registered interval. Run both cron checks after schedule/chain changes.

Slot execution uses ordered stages of serial task chains: chains within a stage run concurrently, and every chain settles before the next stage starts. Canonical bindings derive one stage directly from `plan.jobChains`. Manual reserve stages retain checkpoint filtering and await the reserve head before Kinesis during recovery; Telegram retains its serial critical lane before registration. Chain stop predicates retain not-started terminal records for blocked successors.

Scheduler consumers read producer cadence directly from `CRON_SCHEDULE_CADENCES`: daily snapshot catch-up uses `daily0800Utc.offsetSec`, manual digest retry backoff uses `digestTriggerPoll.intervalSec`, and the two-hourly yield lane's supplemental catch-up uses `fourHourlyYieldSupplemental.intervalSec`. The staleness watchdog uses `CRON_RUNS_RETENTION_SEC` from `shared/lib/retention-policy.ts` to exclude producers whose observation threshold outlives retained history. These authorities do not replace independently reviewed freshness policies such as DEX evidence windows.

Regenerate the schedule inventory and the appendix's [executable-task topology/new-job checklist](process/worker-infrastructure-appendix.md#scheduled-task-topology) with `node --import tsx scripts/maintenance/generate-cron-doc-view.ts`; use `--check` for read-only freshness or select `cron-doc-view` through `check:generated-artifacts`. The generator validates source/Wrangler agreement before writing. `ScheduledTaskDescriptor` in `shared/lib/scheduled-runner-registry.ts` carries configured timeouts, lease overrides and due policies from the existing slot inputs; `worker/src/lib/cron-timeouts.ts` only projects job caps and clips them to the inherited deadline, and the scheduled context consumes descriptor lease options. Implementation names `hourly-dex-source.ts` and `four-hourly-reserves.ts` reflect actual cadence; the durable `halfHourlyOffset` and `fourHourlyReserveSync` schedule keys are unchanged. CPU-class rationale, fencing and incident interpretation remain authored contracts, not inferred from generated tables.

Due Aave-only refreshes follow safe stablecoins publication before snapshots. The full child has a 45-second wall-clock cap and requires 60 seconds of snapshot headroom, within the original slot deadline. Independent-family budgets, triggers and the serial `4/6` peak stay unchanged; [Yield operations](./yield-intelligence-operations.md#slot-context) owns deferral and settlement.

Charts-offset preparation derives the due stablecoins slot from logical time. Its [bounded D1 readiness fence](process/report-cards-appendix.md#canonical-publication) changes no trigger or fetch peak. First-run acceptance: expected-slot publication clock equals captured source, compiler accepts, and mint/burn FTQ stays fresh; a missing/failed source defers without replacing input.

### Event-entry lifecycle and admission

`runScheduledSlotWithFence()` arms the inherited absolute deadline before the first D1 await, not after claim or child-protocol stamping. Same-key presweeps no longer precede admission; same-slot stale takeover remains CAS-fenced. Mandatory await boundaries recheck expiry before admitting the next stage. Replay keeps the executing event's deadline and its separate producer/source identity.
Decoders must terminate synchronously; ambiguous claim acknowledgements require exact owned-generation readback. [Lifecycle recovery details](process/worker-infrastructure-appendix.md#event-entry-recovery-details) retains these boundaries without granting fresh deadlines.

The [same recovery contract](process/worker-infrastructure-appendix.md#event-entry-recovery-details) specifies every mandatory/best-effort await boundary, bounded settlement, delivery incidents and the DB-only `digestTriggerPoll` sweep. No continuation grants fresh work time; production reconciliation must meet its two-poll-interval lag requirement outside documented platform/D1 stalls.

### Missed-slot catch-up

Cloudflare delivers cron late, duplicated, cancelled, or not at all. Opt-in lanes in `SLOT_CATCH_UP_POLICIES` (`shared/lib/scheduled-slot-catch-up-policy.ts`; currently `quarterHourly`, `halfHourlyMintBurnCritical`, `dewsPsiOffset`, `hourlyYieldSync` and `twoHourlyDexDiscovery`) get one catch-up per slot. `fourHourlyReserveSync` is excluded: the reserve-recovery lane already sweeps its abandoned slot and replays the checkpoint under the same slot identity, so a catch-up reopen would race that replay. Heavy-Worker lanes (`halfHourlyChartsOffset`, `v9PublicationOffset`) are excluded because the heavy Worker has no Queue consumer. Instead, the hourly V9 publication's `:52` alias (`V9_PUBLICATION_SECOND_CHANCE`) is a conditional second chance under its own `:52` slot identity: it skips neutrally with `v9-publication-hourly-already-accepted` once publication health holds an acceptance from the current hour, and otherwise publishes after a missed, abandoned, skipped, held or failed `:22` (an unreadable health row degrades as `v9-publication-second-chance-unknown`). The `:46` charts tick re-prepares the V9 input when the hour's `:16` capture never committed, so that run gets a fresh capture. Detection is zero-fetch and runs from two hosts. The five-minute `fiveMinuteReserveRecovery` lane (`:01/:06/…`) runs it first, bounded to 15 s, because the digest poll suffers the same delivery lag as the lanes it watches: on 2026-10-23 a 12:30 quarterHourly abandonment was reconciled at 12:43 by an eight-minute-late poll, after its window had closed. The `digestTriggerPoll` stage runs it after its global stale-slot sweep, as a backstop. Each host considers only the lane's latest slot past its grace and not inside the next natural slot's margin. Both derive from the lane cadence I: grace = min(2I/5, 10 min) and margin = min(I/5, 15 min), so quarterHourly is 6/3 min, the 30-minute mint/burn and DEWS/PSI lanes 10/6 min, and the two-hourly yield and six-hourly DEX discovery lanes 10/15 min. The 10-minute grace cap covers observed delivery lag plus the six-minute long-runner slot silence; the 15-minute margin cap exceeds every catch-up lane's task timeout. Outside every window it reads nothing, but with the six-hourly window open about 93% of the time that is now rare. Otherwise one batched primary-key read (`rows_read` 4 measured in production with two lanes) returns each due slot row and lane marker; an already-armed slot stops there. Only the reserve-recovery host reconciles a due slot itself, through a targeted one-row sweep and only when the probe shows that row already past the shared stale policy. Steady-state cost is at most one read per reserve-recovery run and per digest poll, about 576 reads per day (estimated under 10 rows each with five lanes) and no writes. Every window spans at least one run of each host. A slot with no `cron_slot_executions` row is `never-delivered`; a slot that the reconciler finished with `STALE_SLOT_ERROR` is `abandoned`. A forward-only `scheduled-catch-up:<lane>` cache marker makes arming one-shot, and the hint goes onto the existing public `pharos-reserve-continuation` Queue. The executor is the Queue consumer, not a minute cron lane: the consumer gets the configured 300 s CPU, while these runners are measured to fail in the 30-second sub-hourly cron class. It acknowledges the hint before any work, rechecks the window, and runs the lane's normal runner through `runScheduledSlotWithFence()` under the missed slot's own identity. It inserts a never-delivered row, or CAS-reopens a stale-abandoned terminal exactly once at the next generation. A live or ordinarily finished original always wins, and a late original arriving after the claim sees running/finished and is deduplicated by the ordinary slot fence. The catch-up's controlled deadline is the earlier of the lane's longest task timeout and its next natural slot (`resolveSlotCatchUpDeadlineMs()`). Because the shared consumer has `max_concurrency = 1`, this is also the worst-case latency one catch-up adds to a reserve continuation hint: quarterHourly 9 minutes (cut at its next natural slot), mint/burn critical 10, DEWS/PSI 5 (its default 5-minute task timeout), yield 12 (its supplemental task cap) and DEX discovery 13, each plus the 60-second controlled-error reserve. If every lane misses in overlapping windows, the hints run back to back: at most 49 minutes plus five reserves (54 minutes) of added continuation latency. That delays hints, not reserve progress: the five-minute reserve-recovery cron lane keeps replaying cohort checkpoints throughout. At most one catch-up per lane-slot exists, and the reserve cron fallback stays active. `check:cron-connections` reports each catch-up lane as a non-cron `slot-catch-up:<lane>` surface carrying that lane's declared peak, because the hint runs as its own single-message invocation. Children keep `producerKind = scheduled-job` on purpose, so a productive catch-up renews producer freshness through the same producer head as the natural run; the `catchUp` metadata, not a producer kind, is what distinguishes it. `catchUp` metadata (trigger, armedAt, armedByInvocationId, claimedAt, `recoveredFrom`) is stamped on the slot row, on every terminal rewrite including stale reconciliation, and on each child's `cron_runs` metadata. The duration watchdog still counts a recovered slot as abandoned. Catch-ups record no worker-version first-seen evidence. `WORKER_SLOT_CATCH_UP_MODE` is checked in `on`; deploying `off` stops arming and consumes hints neutrally. Cron expressions and cadences are unchanged.

Scheduler measurement semantics and bounded cache pruning follow the [maintenance details](process/worker-infrastructure-appendix.md#database-maintenance-details).




## Shared Database Helpers

**Files:** `worker/src/lib/db.ts` owns generic D1 helpers; `worker/src/lib/db-cache.ts` owns `getCache`, `setCache`, `setCacheIfAbsent`, `setCacheIfNewer`, `getPriceCache` and `savePriceCache`.

[Inspection](#remote-d1-inspection).

## Remote D1 Inspection

From `worker/`, use `npx --no-install wrangler d1 execute stablecoin-db --remote --json --command "SELECT ..."` (or root with global `--config worker/wrangler.toml`). Never `--file`: D1's import API reports `changed_db: true` even for SELECT and locks writes. Reference: `scripts/maintenance/watch-worker-cron.mjs` (`d1Select`).

A 7403 account-unauthorized failure supplies no rows, not evidence of missing/zero state. Successful SELECT is observation-time database evidence, not an on-chain pin or authority to release quarantined values.

---

## Cron Job Ownership

Feature guides own producer-specific algorithms and schemas; this document owns shared scheduling, lease, timeout, circuit-breaker, and observability behavior.

| Producer family      | Source                                         | Feature contract                                  |
| -------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Stablecoin charts    | `worker/src/cron/sync-stablecoin-charts.ts`    | [Supply Pipeline](./supply-snapshot.md#supply-pipeline) |
| USDS state           | `worker/src/cron/sync-usds-status.ts`          | [USDS Status API](./api-reference.md#get-apiusds-status) |
| Live reserves        | `worker/src/cron/sync-live-reserves.ts`        | [Live Reserve Sync](./live-reserves.md)           |
| Redemption backstops | `worker/src/cron/sync-redemption-backstops.ts` | [Redemption Backstops](./redemption-backstops.md) |
| Kinesis supply       | `worker/src/cron/sync-kinesis-supply.ts`       | [On-chain monitoring](./status-dashboard.md#data-quality-status) (monitoring only) |
| Bluechip ratings     | `worker/src/cron/sync-bluechip.ts`             | [Bluechip Ratings](./bluechip-ratings.md)         |
| Yield benchmarks     | `worker/src/cron/fetch-tbill-rate.ts`          | [Benchmark publication and recovery validation](./runbooks/yield-benchmark-fallback-stale.md#validation) |

