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
- Both roles upload private source maps (`upload_source_maps = true`), so retained stack traces resolve to original file/line. Cloudflare keeps the map for Workers Logs and never serves it; dry-run bundle artifacts stay in `.cache/release-check/`, and `npm run check:worker-package` fails when a `.map` appears under the public Pages artifact (`out/`).

Cron observability has two paths. Terminal job outcomes continue through `logCronRun()` / `cron_runs`; swallowed exceptions that should remain non-fatal use `recordCronFailure()`. Degraded, skipped, fallback, or warning conditions that should survive log retention can call `logCronEvent(db, { job, eventType, severity, message, metadata })`, which writes a latest-event record to the existing cache table under a bounded `cron:event:<job>:<eventType>` key and also emits a structured console line. Use `logCronEvent` for non-terminal operational events rather than adding TODO-backed `console.*` call sites. Price observation collection runs after the existing status-check chain every 15 minutes. Narrow exact DEX refresh and the coverage refresh for rows the exact-address lane prices run first in each slot; broad price corroboration still runs only at `:09`, ahead of `:15` publication. It is budget-only serial work, retains the slot cancellation signal and requires a valid published stablecoins cache. Each collection attempt records its outcome in budget-surface telemetry; its 900-second interval uses the existing two-interval diagnostic stale threshold, independently of provider quote TTLs. No physical trigger is added and the primary publication does not wait for corroboration. It uses the exact `cron:event:sync-stablecoins:price-corroboration` key; the status collector explicitly joins this bounded record to the stablecoin job. Newest event time wins, with higher severity breaking equal-time ties, so a newer stale-slot recovery error is preserved. Its metadata contains slot/version and bounded provider identifiers, counts and failure classes, without provider URLs, credentials or response bodies.

HTTP, API, status, and admin route logs use `logWorkerEvent()` from `worker/src/lib/structured-log.ts`. It emits one JSON console line with stable top-level fields (`scope`, `level`, `event`, `route`, `job`, `provider`, `source`, `runId`) and bounded `metadata` / error fields so Cloudflare Workers Logs stay queryable without turning high-cardinality values into top-level keys. New route logs should use `logWorkerEvent()` instead of direct string console calls.

Telegram custom logs have a narrower privacy contract in `worker/src/telegram/common/log.ts`: no raw or pseudonymous chat/user/update/callback/pending/source-event identifier is emitted. The logger accepts only low-cardinality operation fields and bounded numeric/status metadata, drops unknown keys and non-primitives at runtime, normalizes error classes to a fixed vocabulary, and scrubs URLs, secret assignments, Telegram IDs, UUIDs, and opaque hashes/tokens from allowed strings. Chat-specific incident correlation belongs to Access-authenticated D1/admin diagnostics. A failed webhook terminal processed-update marker emits `action: processed-update-terminal-marker` with a bounded `reasonClass`: `sql_rejected` (D1 rejected the write), `zero_change` (the ownership/generation/effect/mutation fence matched no row), or `fence_rejected` (the intent fence refused before the write). The thrown error, HTTP status, retry and effect fences are unchanged; no SQL text, bound value, update/chat identifier or claim token is logged. Public Workers Logs use the checked-in 0.1 head sampling rate; heavy uses 1. The external retention/Logpush decision is owned by `tokenbrice`: structured logs remain local-only in Workers Logs, with no repository-configured Logpush archive or retention duration. Evaluate Logpush when log volume justifies retention beyond the documented D1 ledgers; until then, durable operational evidence must use those ledgers rather than console retention.

Provider URLs that may embed credentials must pass through `redactProviderUrls()` / `safeErrorMessage()` before logging. The central redactor strips path/query details for Alchemy, dRPC, Dwellir, Etherscan, Telegram, Twitter/X, and Anthropic hosts, and redacts generic secret query parameters on other URLs. Structured Worker and cron metadata applies the same redaction recursively to nested strings, arrays, objects, and `Error` message/stack fields before truncation or serialization. Telegram Bot API tokens still appear in outbound URLs, so Cloudflare invocation logs must be treated as secret; removing that legacy URL-token path is an operational follow-up.

---

## Env Interface

`Env` (`worker/src/lib/env.ts`) is consumed by the HTTP and scheduled context factories. Wrangler owns `DB`, `CORS_ORIGIN`, `SELF_URL`, Access bindings and hardening mode vars; other active bindings are runtime values, typically secrets. `shared/lib/env-contract.ts` owns the cross-runtime manifest, and `npm run check:env-contract` compares Wrangler `[vars]`/D1 bindings with the Worker type contract.

`worker/src/lib/env.ts` exports the worker runtime views used by validation:

- `WORKER_RESERVED_ENV_KEYS`
- `WORKER_ACTIVE_ENV_KEYS` (`required + optional`)

Pages Ops (`functions/lib/ops-env.ts`) derives all four views; Site-data (`functions/lib/site-api-env.ts`) derives required, optional and active views. Validation reports partial Access/admin-D1/Telegram pairs, missing site-proxy/feedback/API-pepper/Banxico credentials, no-op `API_KEY_HASH_PEPPER` rotation, and Telegram `_PREVIOUS` values without their corresponding current token or secret. Ops requires team domain plus UI audience. Site-data requires `DB` for fail-closed selector POST quotas; public reads can continue without attribution. Binding ownership/requirements are in the linked inventory.

`ScheduledEnv` is the narrow shared scheduled-context view; `HeavyEnv` in `worker/src/lib/env.ts` requires no Workflow binding. Heavy shares public's D1, version metadata, compatibility, alias/module and CPU settings, without HTTP/CORS/rate-limit bindings. [The operator sunset record](process/worker-infrastructure-appendix.md#safety-score-v9-workflow-shadow-pilot) owns retirement status and rollback floor.

Heavy additionally requires `SAFETY_CAPTURE_ARCHIVE`, an R2 binding to the existing `pharos-measurements` bucket, declared only in `worker/wrangler.heavy.toml`. The scheduled publication adapter passes it into accepted-capture archiving; public has no bucket binding. The unified `Env`/`ScheduledEnv` view marks it optional for public compatibility, while `HeavyEnv` requires it and `check:worker-config` enforces the heavy bucket name/ownership. No R2 credentials are required by the Worker binding; offline archive tooling uses the operator's existing `R2_MEASUREMENTS_*` client credentials.

Heavy's operator secret inventory and provisioning are owned by [deployment prerequisites](deployment-process.md#first-heavy-deployment-prerequisites-adr-38) and the generated binding contract, not a second roster here. Dwellir admission remains key + usable shared monthly credit ledger + valid `dwellir-evm` breaker; denied admission preserves incumbent RPC order. Heavy normally consumes ready public-produced D1 stages and has Graph credentials to reconstruct exact missing/terminal DEX stages under the source lease and inherited deadline. A live source producer remains a neutral wait, never a recapture opportunity. Missing credentials still fail preflight (`missing-graph-api-key`). Reserves/recovery stay public; Heavy requires no Telegram/admin/site/Anthropic credentials.

Operational telemetry control: set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on the Worker and/or Pages site-data environment to stop low-value route/source attribution writes. This disables Worker `api_request_consumer_stats` route/source writes and Pages `site_data_request_stats` writes, while preserving API-key authentication, D1-backed rate limiting, last-used metadata updates, and per-key public API load telemetry. During keyed public-API spikes, set `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true` on the Worker to pause only `api_key_request_stats` writes; auth, rate limiting, and last-used metadata still run.

The complete key-by-key contract is in [Binding Inventory](process/worker-infrastructure-appendix.md#binding-inventory), generated from the manifest and validated by `check:env-contract`. This reference table does not independently author requirements. Collector, repair, canary, and recovery behavior is separated into [Runtime Feature Contracts](#runtime-feature-contracts); a binding's presence alone does not establish that feature's admission or publication authority.

## Runtime Feature Contracts

Measured DEX execution, including current cohorts and historical native-lane removals, is owned by the [DEX liquidity methodology](./dex-liquidity.md). This document retains only the generic cron capacity, scheduling, and retention contracts; operators should not infer removed native collectors or former schedules from this infrastructure overview.

Stablecoins cache reads retain the loader's result union: `missing-cache` requires a successful absent read; D1 rejection returns `cache-read-failed` with no observation clock. Invalid payloads remain separately named failures; only admitted payloads authorize downstream data claims.

The [DEX implementation contract](process/dex-liquidity-appendix.md#dex-liquidity-score) owns source-stage cadence/recovery, whole-coin admission/rotation, cohort eligibility, quote/target generations, exact-route evidence and transient retention. [DEX operations](process/dex-liquidity-appendix.md#v69-deploy-and-rollback-operations) owns version cutover and rollback. Active/shadow evidence stays distinct; registry presence, age, null publication clocks or an unrelated newer invocation never establish score eligibility or safe deletion. Unknown ownership, missing exact terminal/reference evidence and live artifacts remain protected. Domain cleanup cannot weaken the shared fence/publication contract.

Repair debt uses only `worker_repair_tasks`; the obsolete cache is not read/write authority. Preserve task-backed unknown-on-read-error and negative legacy-cache tests. The daily `cron-sentinel` repair-debt source reports due/stale backlog and executes enabled T1.2-safe work. `DDR_REPAIR_TASK_RUNNER_ENABLED` defaults on for unset/empty values; invalid nonempty values disable execution with warning. Reconciliation and terminal retention remain active.

Data-invariant canaries are permanent operator diagnostics, not an alert or scoring rollout. Unset `WORKER_CANARY_MODE` defaults to `off`; checked-in config uses `status`. `ACTIVE_CANARY_CHECK_IDS` owns the nine-check cohort; scheduled admission rejects missing, duplicate or unexpected IDs and incomplete measurements. The advisory latest-per-check aggregate separately disqualifies stale, materially future-clock (beyond the 60-second skew allowance) or legacy execution-unknown evidence from healthy status. DEX checks count actual current-table publication violations only for rows with a non-null `publication_generation_id` whose `publication_state` is null or not `published`; retained generationless compatibility rows are excluded. The latest published generation's actual published-row count is independently checked against its publication metadata, and the global-row check counts generation-bound `__global__` rows. Legitimate staged candidates in private run tables are not exposed-current violations. Blacklist identity completeness detects rows missing both `config_key` and `contract_address`. In `status`, completed measurements persist their original finding status/severity and return cron `ok` plus named `quality`, including severe corruption. Failed required reads, unusable contracts, incomplete cohorts and persistence failures remain operationally degraded. Each check exposes `executionStatus` and `executionFailureReason` independently of finding severity. `off` performs no canary work and does not stop independent probes or sentinel execution. There is no condition-specific push escalation, even for severe findings; operators must inspect status/ledger evidence. The separately scheduled sentinel retains its own Telegram delivery predicates.

Completed informational `skipped` findings are intentional non-measurements: they retain their skip reason/count but do not alone degrade cron `observedStatus` or add `quality`. A successfully read empty DEX publication skips the row-consistency comparison; the independent global-row check still reports missing current data as degraded. Failed required measurement work remains degraded regardless of finding status. The advisory latest-per-check canary aggregate retains its existing conservative degraded treatment of skipped evidence, rather than claiming every invariant was measured healthy.

**Deployed-override gate (2026-10-08):** status-only/no-paging policy is approved, but the complete inventory of deployed Workers/environments, dashboard/config/secret overrides and private tooling has not been recorded. Until that inventory intentionally migrates every selection to `status` or `off`, `shadow` (hidden collection/unconditional-success policy) and `alert` (stronger terminal-error policy, not an alert sender) remain accepted. After inventory closure, remove those branches and normalize obsolete selections to `off`; never remap retained historical modes into current evidence. No paging activation is planned.

Reserve recovery: `WORKER_RESERVE_RECOVERY_MODE` defaults to `off`; checked-in config uses `recover`. Checkpoints are always written. The five-minute `3/6` lane claims compatible interrupted suffixes and runs bounded config recovery under the reserve lease; redemption's three-worker resolver pool sets the replay peak. [Deploy-time configuration recovery](process/live-reserves-appendix.md#deploy-time-configuration-recovery) owns targeting, one-opportunity consumption, release visibility and acceptance.

### Project-tape placed-fetch canary

Only `project-tape` on the public-owned `dewsPsiOffset` plan may delegate through `env.HEAVY_EXECUTOR.fetch()`. DEWS and PSI remain in-process, in their original serial order. Checked-in `PROJECT_TAPE_PLACED_EXECUTOR = "on"` enables the canary; only exact `on` and `off` values are accepted. Literal `off` restores in-process projection for future slots; missing, empty or any other value also selects in-process execution and emits the named warning `placed-executor-invalid-mode` (no trimming or truthy aliases). The public driver still owns slot claim, job lease/heartbeat, deadline, child marker and terminal accounting. Heavy does not acquire another lease or write a second cron result.

The public service binding targets heavy's **default fetch** handler, never RPC or a named entrypoint. Matching Wrangler-managed `HEAVY_EXECUTOR_SHARED_SECRET` values must be provisioned on **both** scripts before enabling the canary; absence/mismatch fails closed, without local execution. Heavy has `workers_dev = false`, preview URLs disabled and no routes. Its only accepted operation is an authenticated POST of the shared project-tape protocol to the internal binding URL, not a registered public API route.

**Provisioning and recovery (operator-only):** from `worker/`, run `npx --no-install wrangler secret put HEAVY_EXECUTOR_SHARED_SECRET --config wrangler.heavy.toml` for `stablecoin-heavy`, then `npx --no-install wrangler secret put HEAVY_EXECUTOR_SHARED_SECRET --config wrangler.toml` for `stablecoin-api`. Supply the same dedicated vault secret at both interactive prompts; never print it, put it in arguments or reuse a site/admin/API credential. These commands deploy new Worker versions immediately, so use the paired-release identity/activation procedure. If the lane reports `placed-executor-not-configured` or `placed-executor-http-error` from missing/mismatched auth, reprovision the secret on **both** Workers, or set `PROJECT_TAPE_PLACED_EXECUTOR = "off"` on public and deploy the rollback configuration before the next slot. Neither action authorizes an in-slot local retry or lease/fence reset. See [deployment prerequisites](./deployment-process.md#first-heavy-deployment-prerequisites-adr-38).

The request carries the original `slotStartedAt`, event-entry clock, absolute deadline, owner, invocation and execution generation. A durable one-shot marker in the existing slot metadata admits at most one executor delivery per generation; duplicate/stale requests return `placed-executor-duplicate-or-stale`. Every projector write batch atomically checks the original live slot generation, nonterminal child and matching unexpired driver lease, plus the original child-start-based timeout. The marker is never cleared on transport/execution failure and follows existing slot retention. The projector's source-row uniqueness remains the output idempotency authority. Heavy returns the real `CronResult`, including per-class counts and D1 cost; only the driver records it. Executor guard SQL is control-plane overhead outside the projector's `d1Cost` block.

Transport failure/timeout returns `placed-executor-transport-failed` / `placed-executor-timeout`; non-2xx and invalid-result responses have separate named errors. There is **no retry or in-process fallback in that slot**: a lost response may follow a committed projection. A later normal slot resumes from the existing watermarks. Rollback changes only the flag; it never clears a live lease, resets a generation or starts a second owner.

Admission, execution and final acceptance share the inherited event-entry deadline, including a stalled executor claim. Already-started transport/executor tails are retained through `waitUntil` only to the original slot deadline plus its controlled-error reserve, subject to platform fetch-lifetime limits; they never receive a fresh work budget. Late D1 writes still face transaction-local live-driver/deadline guards. Metadata compaction explicitly preserves executor mode, colo/source, placement header, heavy version and execution generation at their original paths.

Heavy's `placement.region = "aws:eu-central-1"` is a **hint near the known EEUR primary region**, not a pinned colo, known D1 host or guarantee. Placement applies only to fetch handlers, not its scheduled jobs or RPC. Terminal metadata records `executorColo` from `request.cf.colo` (null when unavailable), its source, optional `cf-placement` and heavy version. Treat these as fetch-request evidence, not standalone proof of the physical execution location: join same-version Cloudflare Adaptive execution-colo evidence and end-to-end wall/CPU/cost before go/no-go. Require zero duplicate claims/publications and remote-colo p95 wall at most 1.5 times its FRA baseline; record the go/no-go before adding any second lane. Support case #02382680 informs but does not block qualification. See [Cloudflare placement limitations](https://developers.cloudflare.com/workers/configuration/placement/#review-limitations) and [HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/).


### V9 public response materialization

The accepted publication commits immutable, generation-bound public fragments atomically with its canonical marker; request health remains live. [Materialization, rollout and qualification](./process/worker-infrastructure-appendix.md#v9-public-response-materialization) owns admission, integrity, retirement and missing-artifact repair.

## Module Initialization

The unqualified V9 guard and memory-evidence boundary are owned by the [memory appendix](./process/worker-infrastructure-appendix.md#module-initialization-memory-evidence).

Worker scripts must be Latin-1-only: escape source code units above U+00FF as `\uXXXX`, including regex literals. One such raw character doubles V8's retained bundle source. `npm run check:worker-package` rejects these and warns on other non-ASCII; escape first-party Latin-1 too, since UTF-8 loading can retain two-byte source.

Handler factories derive Env-dependent values per invocation and pass them as parameters: `worker/src/handlers/scheduled/context.ts`, `worker/src/handlers/http/context.ts`, and per-endpoint `worker/src/routes/dependency-hydrators.ts`. They normalize credentials, build RPC capability maps and resolve freshness settings; module initialization must not capture an invocation's Env.

Two intentional module-state caveats remain: `buildChainRpcs()` registers/clears credentials in module-scoped `RPC_AUTH_BY_ORIGIN` (`worker/src/lib/chain-registry.ts`) and is not pure; `shared/lib/cloudflare-access-jwt.ts` retains the one-hour JWKS cache. The [isolate registry](process/worker-infrastructure-appendix.md#isolate-local-state-registry) owns all mutable-state inventory.

Redemption `applyOutputDependencyResolution()` uses a run-local index and immutable completed snapshot/configuration map. No global clock-keyed join may cross-contaminate concurrent runs sharing a clock.

`shared/lib/chain-rpc-registry.ts` keeps RPC profiles separate. `hasRegistryRpc()`/`registryRpcUrls()` establish inventory membership; supplemental presence does not. [ADR-40](./architecture.md#adr-40) prefers eligible Dwellir without reordering incumbents or expanding inventory.

The shared Dwellir registries own capabilities. Scheduled EVM/native reads share credit-ledger/breaker admission; missing key, denial or `DWELLIR_ROUTING_DISABLED_CHAINS` excludes Dwellir. HTTP gets no native capability. Native operations retain exact pins, header credentials and ledger-floor checks, not TRON history or Sui object-history permission.

The EVM resolver separates recent finalized state, arbitrary historical state, headers/receipts and inclusive log intervals. Recent pins bind chain/number/hash, original clocks, finalized head, age and retained floor; batch eligibility intersects actual members. BSC/Monad/zkSync remain recent-only. Unknown incumbent retention is not archive proof; HyperEVM Alchemy numeric mispins stay excluded. No hash-to-number/latest fallback.

CCIP pages use the first eligible provider's span, independent of state history; Monad retention needs an observed head. Refusal never advances cursors. Serial `noBatch`, exact IDs, per-attempt admission/credits/deadlines and run-local network-failure demotion remain. Unstarted denial is uncharged/undemoted. [Parity](./api-reference-admin.md#get-apirpc-provider-trial) is independent, diagnostic and non-promoting; preference adds no fan-out or evidence of asset acceptance.
Capped inclusive Etherscan log ranges split sequentially; exhausted request budgets return incomplete `budget-exhausted` results and recursion beyond depth 8 returns `max-recursion-depth`. A capped singleton returns `etherscan-result-cap-unsplittable`, including when its parent spans two adjacent blocks.

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
| `v9PublicationOffset` | `22,52 * * * *` | 1800 / 1320 | `22 * * * *`<br>`52 * * * *` | heavy |
| `statusSelfCheckOffset` | `9,24,39,54 * * * *` | 900 / 540 | `9 * * * *`<br>`24 * * * *`<br>`39 * * * *`<br>`54 * * * *` | public |
| `sixHourlyBlacklist` | `3 */6 * * *` | 21600 / 180 | `3 */6 * * *` | public |
| `halfHourlyMintBurnCritical` | `4,34 * * * *` | 1800 / 240 | `4 * * * *`<br>`34 * * * *` | public |
| `twoHourlyDexDiscovery` | `6 */2 * * *` | 7200 / 360 | `6 */2 * * *` | public |
| `halfHourlyMintBurnExtended` | `18,48 * * * *` | 1800 / 1080 | `18 * * * *`<br>`48 * * * *` | public |
| `halfHourlyMeasuredExecution` | `0,30 * * * *` | 1800 / 0 | `5 * * * *`<br>`35 * * * *` | public |
| `halfHourlyMeasuredExecutionSupplemental` | `15,45 * * * *` | 1800 / 900 | `20 * * * *`<br>`50 * * * *` | public |
| `halfHourlyOffset` | `10 * * * *` | 3600 / 600 | `10 * * * *` | public |
| `halfHourlyChartsOffset` | `16,46 * * * *` | 1800 / 960 | `16 * * * *`<br>`46 * * * *` | heavy |
| `dewsPsiOffset` | `26,56 * * * *` | 1800 / 1560 | `26,56 * * * *` | public |
| `fourHourlyReserveSync` | `11 */4 * * *` | 14400 / 660 | `11 */4 * * *` | public |
| `hourlyYieldSync` | `55 * * * *` | 3600 / 3300 | `55 * * * *` | public |
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

Cron expressions are source-owned by the two Wrangler configs. Logical schedule keys, physical aliases, status-tracked jobs and connection budgets live in `shared/lib/cron-jobs.ts`; dispatch chains and Worker ownership live in `shared/lib/scheduled-runner-registry.ts`. Hourly aliases preserve logical sub-hourly cadence while using Cloudflare's hourly CPU class. `runScheduledSlotWithFence()` in `worker/src/lib/scheduled-slot-fence.ts` owns claim, heartbeat, takeover and terminal fencing; `scheduled-slot-reconciliation.ts` owns stale child progress/lease cleanup, synthetic run persistence, attempt abandonment and operator event markers. The [scheduling appendix](process/worker-infrastructure-appendix.md#cron-scheduling) retains progress snapshots, child-outcome escalation and the exact owner-aware deploy-interruption evidence window. A job normally owns one schedule key; `SHARED_SCHEDULED_JOB_IDENTITIES` is the closed multi-slot allowlist (`cron-sentinel` runs from four). An unregistered/unallowlisted dispatch makes descriptor construction throw. Sharing identity shares a lease, status row and freshness reading against the registered interval. Run both cron checks after schedule/chain changes.

Regenerate the schedule inventory and the appendix's [executable-task topology/new-job checklist](process/worker-infrastructure-appendix.md#scheduled-task-topology) with `node --import tsx scripts/maintenance/generate-cron-doc-view.ts`; use `--check` for read-only freshness or select `cron-doc-view` through `check:generated-artifacts`. The generator validates source/Wrangler agreement before writing. `ScheduledTaskDescriptor` in `shared/lib/scheduled-runner-registry.ts` carries configured timeouts, lease overrides and due policies from the existing slot inputs; `worker/src/lib/cron-timeouts.ts` only projects job caps and clips them to the inherited deadline, and the scheduled context consumes descriptor lease options. Implementation names `hourly-dex-source.ts` and `four-hourly-reserves.ts` reflect actual cadence; the durable `halfHourlyOffset` and `fourHourlyReserveSync` schedule keys are unchanged. CPU-class rationale, fencing and incident interpretation remain authored contracts, not inferred from generated tables.

### Event-entry lifecycle and admission

`runScheduledSlotWithFence()` arms the inherited absolute deadline before the first D1 await, not after claim or child-protocol stamping. Same-key presweeps no longer precede admission; same-slot stale takeover remains CAS-fenced. Mandatory await boundaries recheck expiry before admitting the next stage. Replay keeps the executing event's deadline and its separate producer/source identity.

| Await boundary | Contract |
| --- | --- |
| Version first-seen stamp | Best-effort telemetry off the admission path, observed within the same deadline. Missing telemetry cannot prevent claim. |
| Slot insert/read, live-child admission, takeover/reconciliation | Mandatory fencing; expired results cannot start a runner or issue the next admission mutation. |
| Child protocol stamp, memory-lane wait, runner import | Mandatory admission; recheck before child work. Protocol stamping is required evidence, not optional version telemetry. |
| Child start/lease-owner marker, lease acquire/renew, terminal arbitration | Mandatory ownership/accounting inside the executing slot deadline. |
| Detailed progress and completion reports | Best-effort telemetry behind the inherited deadline; progress stalls cannot extend the work allowance. Dwellir credit flushes use the same bounded deadline rather than requiring a background execution-context hook. |
| Heartbeat drain, slot terminal write, failure cleanup | Work stops at the original deadline. Already-started settlement retains an observed continuation within the existing accounting reserve, never a new work budget; takeover wins over old writes. |

Public and heavy scheduled callbacks capture event entry before any lazy import and pass it to the dispatcher. Expiry returns a controlled failure even when D1 has not resolved. A late admission continuation rechecks expiry before starting anything; cleanup requires drained work and no unterminated children. Its actual in-flight promise is retained with `waitUntil` only within the existing accounting reserve, independently of the already-aborted work signal. If the isolate disappears, stale sweeping remains recovery authority. `scheduled-slot-delivery` events distinguish `delivered-not-admitted` (also duplicate/live-slot refusals) from `claimed-failed`, carrying executing slot, invocation and event-entry deadline. An absent D1 slot is not proof of missing delivery.

The existing public `digestTriggerPoll` lane starts with a DB-only sweep-only stage before outbox/demand/generation work, capped at 30 seconds and ten candidates and clipped to the inherited deadline. No trigger, fetch surface or connection reservation is added; connection peak and CPU placement stay unchanged. Global cleanup no longer shares reserve-recovery's lease/replay; reserve recovery retains targeted producer-slot preparation only. Every path imports `scheduled-slot-policy.ts`.

`scheduled-slot-sweep` events record counts, applied policies and `maxReconciliationLagSec` from policy eligibility to the sweep observation clock (null without reconciled observations). After deployment require lag within two poll intervals outside documented platform/D1 stalls; fixtures are not production acceptance. Reconciled child errors and abandonment events share `parentIncidentId`; event `childIncidentCounts` groups started and proven-not-started children without making required unstarted errors neutral.




## Shared Database Helpers

**Files:** `worker/src/lib/db.ts` owns generic D1 helpers; `worker/src/lib/db-cache.ts` owns `getCache`, `setCache`, `setCacheIfAbsent`, `setCacheIfNewer`, `getPriceCache` and `savePriceCache`.

### Remote D1 Inspection

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

