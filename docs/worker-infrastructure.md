# Worker Infrastructure

> **Agent navigation** — Current invariants and interfaces are below. Detailed implementation and historical decisions are retained in the [appendix](./process/worker-infrastructure-appendix.md). Read routed sections rather than either file wholesale.

Two Cloudflare scripts share one fenced D1 authority. `stablecoin-api` serves HTTP routing, edge caching, CORS, admin auth and public-owned scheduled work; `stablecoin-heavy` is scheduled-only. The union of `worker/wrangler.toml` and `worker/wrangler.heavy.toml` owns deployed expressions, `CRON_JOB_DEFINITIONS` owns status-tracked jobs, and `CRON_CONNECTION_BUDGET_ENTRIES` also covers budget-only surfaces. Run the cron sync and connection-budget checks for current topology.

Execution note: the `snapshot-supply` retry path runs on the logical quarter-hour schedule, deployed through the single-minute hourly aliases in `shared/lib/cron-jobs.ts`, only after a downstream-safe `sync-stablecoins` cache write. The `0 8 * * *` daily fallback additionally requires the `stablecoins` cache row to be written at or after that scheduled slot start before it can consume write-once daily artifacts.

**Deployed at:** `api.pharos.watch` (public integration API), `site-api.pharos.watch` (website-internal data lane), and `ops-api.pharos.watch` (operator lane; pair with Cloudflare Access before use)


---

## Runtime Limits and Observability

Worker runtime safety and telemetry controls are declared in both Wrangler configs and managed in git. CI proves both strict bundles before one D1 migration application, then deploys heavy followed by public. Routes, triggers and bindings synchronize through `wrangler deploy --strict`; dashboard-only edits can be overwritten.

```toml
compatibility_date = "2026-04-18"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
preview_urls = true
minify = true
keep_names = true

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

- `cpu_ms = 300000`: hard cap on CPU time per invocation (not wall-clock runtime). This is independent from in-app wall-clock cron timeouts in `logCronRun()`. The repository keeps this cap aligned with `worker/wrangler.toml`; Cloudflare still applies trigger-specific runtime ceilings where applicable.
- `compatibility_date = "2026-04-18"` + `nodejs_compat`: paired Public/Heavy runtime settings. Permanent qualification covers both roles at baseline/candidate dates; advance both source configs only in a gated standalone release. Heavy's isolated neutral-core smoke is not producer acceptance; see [`worker-runtime-experiments.md`](./process/worker-runtime-experiments.md).
- `global_fetch_strictly_public`: keeps Worker-origin fetches to the Worker's own public custom domains on the public edge path. `status-self-check` depends on that behavior for production-domain canaries; without it, same-Worker custom-domain self-fetches can return internal 522s while external clients remain healthy.
- `observability.enabled`: enables Worker traces.
- `head_sampling_rate`: public retains `0.1`, heavy retains `1` so moved cron/Workflow failure context is not sampled away. Both keep observability and invocation logs enabled.
- `observability.logs.enabled` + `invocation_logs = true`: enables Workers Logs in dashboard.
- `preview_urls = true` on public keeps explicit diagnostic preview URLs outside the release gate. Heavy has `workers_dev = false`, `preview_urls = false`, and no routes/custom domains.
- `minify = true` + `keep_names = true`: reduce the deployed script's source footprint while preserving function and class names for diagnostics and exported entrypoints. A Node 24 Wrangler dry-run reduced the main script from 58.61 MiB to 38.16 MiB without removing registry evidence; this is a bundle-size result, not proof of Cloudflare peak-memory safety. The compiled minified entrypoint was exercised in local workerd with the existing compatibility flags.

Cron observability has two paths. Terminal job outcomes continue through `logCronRun()` / `cron_runs`; swallowed exceptions that should remain non-fatal use `recordCronFailure()`. Degraded, skipped, fallback, or warning conditions that should survive log retention can call `logCronEvent(db, { job, eventType, severity, message, metadata })`, which writes a latest-event record to the existing cache table under a bounded `cron:event:<job>:<eventType>` key and also emits a structured console line. Use `logCronEvent` for non-terminal operational events rather than adding TODO-backed `console.*` call sites. Price observation collection runs after the existing status-check chain every 15 minutes. Narrow exact DEX refresh and the coverage refresh for rows the exact-address lane prices run first in each slot; broad price corroboration still runs only at `:09`, ahead of `:15` publication. It is budget-only serial work, retains the slot cancellation signal and requires a valid published stablecoins cache. Each collection attempt records its outcome in budget-surface telemetry; its 900-second interval uses the existing two-interval diagnostic stale threshold, independently of provider quote TTLs. No physical trigger is added and the primary publication does not wait for corroboration. It uses the exact `cron:event:sync-stablecoins:price-corroboration` key; the status collector explicitly joins this bounded record to the stablecoin job. Newest event time wins, with higher severity breaking equal-time ties, so a newer stale-slot recovery error is preserved. Its metadata contains slot/version and bounded provider identifiers, counts and failure classes, without provider URLs, credentials or response bodies.

HTTP, API, status, and admin route logs use `logWorkerEvent()` from `worker/src/lib/structured-log.ts`. It emits one JSON console line with stable top-level fields (`scope`, `level`, `event`, `route`, `job`, `provider`, `source`, `runId`) and bounded `metadata` / error fields so Cloudflare Workers Logs stay queryable without turning high-cardinality values into top-level keys. `npm run check:cron-console-usage` keeps its historical name but now ratchets raw `console.*` calls across cron plus HTTP/status/admin roots. It is enforced through `check:structural` for affected PR paths and every nightly/manual validation run; new route logs should use `logWorkerEvent()` instead of direct string console calls.

Telegram custom logs have a narrower privacy contract in `worker/src/lib/telegram/log.ts`: no raw or pseudonymous chat/user/update/callback/pending/source-event identifier is emitted. The logger accepts only low-cardinality operation fields and bounded numeric/status metadata, drops unknown keys and non-primitives at runtime, normalizes error classes to a fixed vocabulary, and scrubs URLs, secret assignments, Telegram IDs, UUIDs, and opaque hashes/tokens from allowed strings. Chat-specific incident correlation belongs to Access-authenticated D1/admin diagnostics. Public Workers Logs use the checked-in 0.1 head sampling rate; heavy uses 1. The external retention/Logpush decision is owned by `tokenbrice`: structured logs remain local-only in Workers Logs, with no repository-configured Logpush archive or retention duration. Evaluate Logpush when log volume justifies retention beyond the documented D1 ledgers; until then, durable operational evidence must use those ledgers rather than console retention.

Provider URLs that may embed credentials must pass through `redactProviderUrls()` / `safeErrorMessage()` before logging. The central redactor strips path/query details for Alchemy, dRPC, Dwellir, Etherscan, Telegram, Twitter/X, and Anthropic hosts, and redacts generic secret query parameters on other URLs. Structured Worker and cron metadata applies the same redaction recursively to nested strings, arrays, objects, and `Error` message/stack fields before truncation or serialization. Telegram Bot API tokens still appear in outbound URLs, so Cloudflare invocation logs must be treated as secret; removing that legacy URL-token path is an operational follow-up.

---

## Env Interface

`Env` (`worker/src/lib/env.ts`) is consumed by the HTTP and scheduled context factories. Wrangler owns `DB`, `CORS_ORIGIN`, `SELF_URL`, Access bindings and hardening mode vars; other active bindings are runtime values, typically secrets. `shared/lib/env-contract.ts` owns the cross-runtime manifest, and `npm run check:env-contract` compares Wrangler `[vars]`/D1 bindings with the Worker type contract.

`worker/src/lib/env.ts` still exports the worker runtime views:

- `WORKER_REQUIRED_ENV_KEYS`
- `WORKER_OPTIONAL_ENV_KEYS`
- `WORKER_RESERVED_ENV_KEYS`
- `WORKER_ACTIVE_ENV_KEYS` (`required + optional`)

Pages Ops (`functions/lib/ops-env.ts`) derives all four views; Site-data (`functions/lib/site-api-env.ts`) derives required, optional and active views. Validation reports partial Access/admin-D1/Telegram pairs, missing site-proxy/feedback/API-pepper/Banxico credentials, no-op `API_KEY_HASH_PEPPER` rotation, and Telegram `_PREVIOUS` values without their corresponding current token or secret. Ops requires team domain plus UI audience. Site-data requires `DB` for fail-closed selector POST quotas; public reads can continue without attribution. Binding ownership/requirements are in the linked inventory.

`ScheduledEnv` is the narrow shared scheduled-context view; `HeavyEnv` in `worker/src/lib/env.ts` retains the heavy-only `SAFETY_SCORE_V9_WORKFLOW` binding during the terminal retirement's resource-drain stage. Heavy uses the same `DB`, `CF_VERSION_METADATA`, compatibility date/flags, alias, module rules and CPU cap as public, without HTTP/CORS/rate-limit bindings. The pilot mode variable and cron trigger are removed. The class/export/binding remain only until complete history disposition and named-resource deletion; Cloudflare rejects removing a class while its Workflow resource still references the script.

Heavy additionally requires `SAFETY_CAPTURE_ARCHIVE`, an R2 binding to the existing `pharos-measurements` bucket, declared only in `worker/wrangler.heavy.toml`. The scheduled publication adapter passes it into accepted-capture archiving; public has no bucket binding. The unified `Env`/`ScheduledEnv` view marks it optional for public compatibility, while `HeavyEnv` requires it and `check:worker-config` enforces the heavy bucket name/ownership. No R2 credentials are required by the Worker binding; offline archive tooling uses the operator's existing `R2_MEASUREMENTS_*` client credentials.

Heavy operator secrets are exactly `COINGECKO_API_KEY`, `ALCHEMY_API_KEY`, `DRPC_API_KEY`, and `TRONGRID_API_KEY` (provisioned 2026-10-07). `DWELLIR_API_KEY` is optional supplemental RPC capacity and is absent on heavy, so `applyDwellirEndpoints` returns early and the heavy chain RPC map retains its existing registry/public endpoints without Dwellir supplementals; `ETHERSCAN_API_KEY` is read only by public lanes (blacklist, USDS status, yield, quarter-hourly) and is not provisioned. It neither requires nor reads `M0_API_KEY`; reserve producer/recovery remain public. `GRAPH_API_KEY` is explicitly absent: charts stage-recovery receives `graphApiKey: null`. Inline DEX recapture therefore fails preflight with `missing-graph-api-key` before lease acquisition, source requests or stage/target writes, rather than publishing an incomplete descriptor catalog. Heavy can consume ready public-produced D1 stages; failed :16 recapture errors, while :46 defers unusable-stage publication and reuses the prior accepted generation. Optional provider-budget/mint-burn controls remain absent to preserve defaults; heavy requires no Telegram/admin/site/Anthropic secrets.

Operational telemetry control: set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on the Worker and/or Pages site-data environment to stop low-value route/source attribution writes. This disables Worker `api_request_consumer_stats` route/source writes and Pages `site_data_request_stats` writes, while preserving API-key authentication, D1-backed rate limiting, last-used metadata updates, and per-key public API load telemetry. During keyed public-API spikes, set `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true` on the Worker to pause only `api_key_request_stats` writes; auth, rate limiting, and last-used metadata still run.

The complete key-by-key contract is in [Binding Inventory](process/worker-infrastructure-appendix.md#binding-inventory), generated from the manifest and validated by `check:env-contract`. This reference table does not independently author requirements. Collector, repair, canary, and recovery behavior is separated into [Runtime Feature Contracts](#runtime-feature-contracts); a binding's presence alone does not establish that feature's admission or publication authority.

## Runtime Feature Contracts

Measured DEX execution, including current cohorts and historical native-lane removals, is owned by the [DEX liquidity methodology](./dex-liquidity.md). This document retains only the generic cron capacity, scheduling, and retention contracts; operators should not infer removed native collectors or former schedules from this infrastructure overview.

Stablecoins cache reads retain the loader's result union: `missing-cache` requires a successful absent read; D1 rejection returns `cache-read-failed` with no observation clock. Invalid payloads remain separately named failures; only admitted payloads authorize downstream data claims.

The [DEX implementation contract](process/dex-liquidity-appendix.md#dex-liquidity-score) owns EVM oldest-packet reservation, whole-coin rotation, V4/Curve admission and cohort lifecycle.

The EVM admission estimate also counts the hook-free Uniswap V4 deployment's PoolManager, StateView, and Quoter runtime checks, the two immutable PoolManager bindings, and batched pinned pool-state reads. [DEX batch recovery](process/dex-liquidity-appendix.md#dex-liquidity-score) owns recursive transport fragmentation. V4 source enrichment is a third serialized subgraph family, so it does not increase the source-stage connection peak.

The generation-fenced D1 target and quote tables are additive. Active and shadow targets/quotes use separate producer surfaces. A quote publication stores measured and real failure outcomes plus a target-manifest digest; manifest-proven `budget-deferred` outcomes are reconstructed on read instead of being written as dense rows. [DEX scoring](./dex-liquidity.md#dex-liquidity-score) owns source-stage layout, cadence and recovery; [DEX operations](./dex-liquidity.md#v69-deploy-and-rollback-operations) owns payload-version cutover and deploy/rollback windows. Shadow targets publish daily at `06:16 UTC`. On successful hourly publications, the serial D1-only `cron-sentinel` turnover source compares per-coin route identities/evidence kinds with its compact prior-publication snapshot before V9 preparation. The half-hour native shadow collectors select Solana candidates from the current published liquidity generation, with a 24-hour freshness filter and independent Orca/Raydium cursors. These stage and recovery fences change input integrity, not the Safety formula.

Transient DEX evidence is retained in D1 only. Eligible measured quote/target generations turn over after four hours, strictly beyond their three-hour evidence freshness ceiling; non-current liquidity and abandoned price run rows retain their separate three-hour policies. Current publications and referenced targets remain protected. Candidate inserts capture the unique current leased child invocation only while its execution fence still matches. An active measured candidate is eligible only with recognized producer provenance, no validation/publication clock, exact terminal child and cron-run evidence, no live lease/progress/child/slot for that same invocation and owner, and no quote or publication-ledger reference. An unrelated newer invocation of the same job does not establish ownership of an old candidate. Age or a null publication clock alone never proves abandonment; unknown ownership, missing terminal proof, malformed reference manifests and all shadow candidates remain retained. Each measured delete drains at most 16 physical rows oldest-first before empty ledgers are removed. Consumed scoring stages are deleted by the next stage cleanup and abandoned stages by two hours. Discovery staging keeps 30 hours and clears provider `raw_json` after four hours. Cleanup reports cutoff, deleted rows, oldest remaining row, duration, and error without failing an otherwise successful publication. Public `dex_liquidity_history` remains at 365 days.

Fresh, independently revalidated route identities with at least two successful cycles may remain in the bounded V9 route compiler for one evidence-freshness window after rotating out of the current pool shortlist; they never rejoin liquidity, pricing, display, or target-publication surfaces. The score-eligible QuoterV2 cohorts are the owner-ratified Uniswap V3 deployments on Ethereum, Polygon, Arbitrum, and Celo; PancakeSwap V3 on Base, BSC, and Ethereum; plus the reviewed Base Aerodrome Slipstream cohort. Generic Raydium CLMM and Orca Whirlpool have diagnostic-only native shadow collectors with `activation-pending` gates; Meteora DLMM's measured quote collector is retired. Unratified or paused EVM cohorts capture only through an admitted shadow target inventory and dispatched collector. The Solana and Tron native measured-execution lanes and the Fluid measured overlay were removed in Liquidity Score v6.0 together with their producers, registries, schemas, and persistence wrappers; retained Raydium, Orca, SunSwap, and Fluid pools now resolve as shaped evidence outside the strict exact-route denominator, and their aggregate TVL, price, and visible-pool contributions are unchanged. See [dex-liquidity.md](./dex-liquidity.md) for the measured-execution contract. Shadow, stale, malformed, failed, or identity-drifted profiles remain gated. No stale proof or manual capacity is substituted for a current direct route. This lane does not make a deployment score-eligible by registry presence alone.

[Direct API Data Sources](process/dex-liquidity-appendix.md#direct-api-data-sources) owns BSC target-only recovery pins, exclusions and conditional retirement proof; the linked DEX implementation contract owns its shadow-only cohort and serialized subgraph budget.

The linked DEX implementation contract owns the legacy Curve 3pool paired-direction validation, maturity and expiry rules. Retained route-only evidence reconstructs both siblings from the same packet or admits neither.

Repair debt: canonical `worker_repair_tasks` is the only authority. The obsolete `cache['ddr:repair-debt:v1']` writer/reader was retired; a successful exact-key SELECT on `stablecoin-db` on 2026-10-07 returned no row, closing residue cleanup on that inspected target without a DELETE. Other preview/restore targets are not certified by that capture. Preserve negative legacy-cache regression tests and task-backed unknown-on-read-error behavior. The daily repair-debt source of `cron-sentinel` still executes queued T1.2-safe repairs when enabled and always reports due/stale backlog. `DDR_REPAIR_TASK_RUNNER_ENABLED` defaults on for unset/empty values; invalid non-empty values disable execution with a warning. Reconciliation closes no-longer-current tasks and retention prunes terminal rows; neither is retired with the obsolete cache.

Data-invariant canaries are permanent operator diagnostics, not an alert or scoring rollout. Unset `WORKER_CANARY_MODE` defaults to `off`; checked-in config uses `status`. `ACTIVE_CANARY_CHECK_IDS` owns the nine-check cohort; scheduled admission rejects missing, duplicate or unexpected IDs and incomplete measurements. The advisory latest-per-check aggregate separately disqualifies stale, materially future-clock (beyond the 60-second skew allowance) or legacy execution-unknown evidence from healthy status. DEX checks count actual current-table publication violations only for rows with a non-null `publication_generation_id` whose `publication_state` is null or not `published`; retained generationless compatibility rows are excluded. The latest published generation's actual published-row count is independently checked against its publication metadata, and the global-row check counts generation-bound `__global__` rows. Legitimate staged candidates in private run tables are not exposed-current violations. Blacklist identity completeness detects rows missing both `config_key` and `contract_address`. In `status`, completed measurements persist their original finding status/severity and return cron `ok` plus named `quality`, including severe corruption. Failed required reads, unusable contracts, incomplete cohorts and persistence failures remain operationally degraded. Each check exposes `executionStatus` and `executionFailureReason` independently of finding severity. `off` performs no canary work and does not stop independent probes or sentinel execution. There is no condition-specific push escalation, even for severe findings; operators must inspect status/ledger evidence. The separately scheduled sentinel retains its own Telegram delivery predicates.

Completed informational `skipped` findings are intentional non-measurements: they retain their skip reason/count but do not alone degrade cron `observedStatus` or add `quality`. A successfully read empty DEX publication skips the row-consistency comparison; the independent global-row check still reports missing current data as degraded. Failed required measurement work remains degraded regardless of finding status. The advisory latest-per-check canary aggregate retains its existing conservative degraded treatment of skipped evidence, rather than claiming every invariant was measured healthy.

**Deployed-override gate (2026-10-08):** status-only/no-paging policy is approved, but the complete inventory of deployed Workers/environments, dashboard/config/secret overrides and private tooling has not been recorded. Until that inventory intentionally migrates every selection to `status` or `off`, `shadow` (hidden collection/unconditional-success policy) and `alert` (stronger terminal-error policy, not an alert sender) remain accepted. After inventory closure, remove those branches and normalize obsolete selections to `off`; never remap retained historical modes into current evidence. No paging activation is planned.

Reserve recovery: `WORKER_RESERVE_RECOVERY_MODE` defaults to `off`; checked-in config uses `recover`. Checkpoints are always written. The five-minute `2/6` lane claims compatible interrupted suffixes and runs bounded config recovery under the reserve lease. [Deploy-time configuration recovery](process/live-reserves-appendix.md#deploy-time-configuration-recovery) owns targeting, one-opportunity consumption, release visibility and acceptance.

## Module Initialization

The current Zod dependency is owned by `package.json` and `worker/package.json`. Historical Zod 4.5.0 import-only comparisons against 4.4.3 reduced retained heap for the measured-execution graph from 8.52 MB to 4.97 MB and the V9 extension graph from 40.43 MB to 31.42 MB (three fresh-process samples per version). These overlapping graphs must not be added together, and import-only Node measurements do not prove Cloudflare peak-memory safety. Memory-risk releases still require a new affected production execution and correlated platform outcomes; CPU-class aliases and staggered cron minutes are not isolate memory boundaries.

Runtime configuration is derived from `Env` bindings in the scheduled context factory (`worker/src/handlers/scheduled/context.ts`) and the HTTP route-context factory (`worker/src/handlers/http/context.ts`), which runs the per-endpoint hydrators in `worker/src/routes/dependency-hydrators.ts`, with results passed as parameters rather than stored in module-level state:

| Function                                                | Called in             | Purpose                                                     |
| ------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| `normalizeCgApiKey(env.COINGECKO_API_KEY)`              | `fetch` + `scheduled` | Returns normalized API key for CoinGecko requests           |
| `buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY, { dwellirApiKey? })` | `fetch` + `scheduled` | Builds chain RPC configs from typed registry endpoints (Alchemy/dRPC/public, today's order preserved). When a Dwellir key is supplied it additionally appends one supplemental `DWELLIR_CHAINS` endpoint after every registry endpoint, and creates a supplemental-only config for pin-only chains. Scheduled runtimes rebuild with the key inside `runLeasedCron` only when the credit ledger is usable and `shouldAttemptFetch()` admits `dwellir-evm` (closed or permitted half-open probe); routes build without it. |
| `resolveMintBurnFreshnessConfig(env)`                   | `fetch` + `scheduled` | Resolves mint/burn major symbols and stale/alert thresholds |
| `createDwellirNativeCapability(env.DWELLIR_API_KEY)` | `scheduled` only | Creates a key-hiding native state-read transport after the same memoized credit-ledger + `dwellir-evm` circuit admission as EVM supplementals; passed through adapter contexts, never created by request-path hydration. |

`Env`-derived context values are computed inside handlers, not at module initialization. `buildChainRpcs()` also registers or clears credentials in the module-scoped `RPC_AUTH_BY_ORIGIN` side table in `worker/src/lib/chain-registry.ts`, so it is not pure. `shared/lib/cloudflare-access-jwt.ts` keeps an in-memory JWKS cache (`jwksCache`, 1-hour TTL) to avoid refetching Access signing keys on every admin request.

Redemption downstream-resolution disclosure is also run-local: `applyOutputDependencyResolution()` in `worker/src/lib/redemption-backstop/sources.ts` receives the completed snapshot and configuration map, builds one local resolution index, and returns changed rows without mutating builder outputs. There is no module-global clock-keyed per-run join state; concurrent runs with the same clock cannot cross-contaminate disclosure.

Public endpoint data and provider-quality exclusions live in `shared/lib/chain-rpc-registry.ts`, shared with curated supply probes and V9 supply attribution. `worker/src/lib/public-rpc-registry.ts` only performs lookups and ordered-list construction from that authority; it owns no endpoint table. The public, curated-supply, and attribution profiles intentionally preserve their distinct fallback lists rather than silently expanding runtime routes.
`chain-registry.ts` constructs RPC metadata through one private `rpcConfig` projection of `CHAIN_META`; provider guards, endpoint ordering, credentials, and state/log capability metadata remain at their existing branches.

Alchemy's additional archive state-only census endpoints use supplemental-only configs and `logsHistory: none`. A chain's presence in the RPC map does not establish registry RPC readability: consumers use `hasRegistryRpc()` or `registryRpcUrls()` for that capability. The transfer census can use archive supplemental endpoints without expanding registry or log-scan inventories; Dwellir remains appended after the existing census endpoints.

Dwellir EVM endpoint authority is `shared/lib/dwellir-chains.ts` (37 chains, including Etherlink, Cronos, Flow EVM, Pulsechain, Immutable zkEVM, Boba, Astar, and Taiko). Native endpoints and read capabilities live separately in `shared/lib/dwellir-native-endpoints.ts`: Aptos/Movement REST, TRON constant-contract HTTP, and Starknet `starknet_call`. `worker/src/lib/dwellir-native.ts` closes over the admitted key, scopes it to these fixed keyless endpoints, rejects redirects, and meters each received HTTP response (success or error) into the existing Dwellir credit buffer. It adds no mutable module state or independent admission authority. Configured/incumbent routes stay first; native fallback cannot expand TRON events/indexing or enable historical TRON state. Movement's retained-ledger floor is read from each fallback node's ledger metadata, never inferred from an archive label. Scheduled runtimes without a usable ledger or closed circuit expose neither EVM nor native Dwellir capabilities; HTTP runtimes never receive the native capability.

Endpoint transport metadata in `worker/src/lib/chain-registry.ts` may declare an inclusive `maxLogBlockSpan` and `noBatch`. The shared RPC helpers skip endpoints that cannot accommodate an explicit log range and execute no-batch groups serially with exact response IDs, deadlines and request guards. These options do not change endpoint order, state/log history classifications or inventory eligibility; absent options preserve existing batch transport and caller-selected ranges.
Every physical RPC retry rechecks the request guard, meters provider credits, and clips its timeout and backoff to the absolute deadline; batch and no-batch transports share this admission path.
Admission or deadline denial in `fetch-retry.ts` throws the typed `FetchRequestNotStartedError` sentinel, carrying the denial reason and count of earlier started attempts to that URL. Single, batch, and no-batch RPC reads stop the bounded operation with their existing unavailable result. An untried supplemental endpoint is neither charged nor demoted, so later independently admitted operations sharing the same run map may still reach it; a provider that actually failed before a denied retry remains eligible for run-local demotion.
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

### Completed D1 Schema Cleanup

The canonical operated-cleanup history, current production removals, rollback limits, and deferred queue live in [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md#completed-destructive-cleanup-operations). Do not duplicate that inventory here. Destructive cleanup remains outside the normal migration path and requires production backup/Time Travel verification, fresh zero-use evidence, and a dedicated operated rollout after compatible Worker code has soaked.

## Cron Scheduling

<!-- GENERATED-START: cron-doc-view -->
<!-- Generated by scripts/maintenance/generate-cron-doc-view.ts. Do not edit by hand. -->

UTC inventory from `shared/lib/cron-jobs.ts`, `shared/lib/cron-cadences.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/wrangler.toml` and `worker/wrangler.heavy.toml`. Public = `stablecoin-api`; heavy = scheduled-only `stablecoin-heavy`.

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

Regenerate only the schedule inventory with `node --import tsx scripts/maintenance/generate-cron-doc-view.ts`; use `--check` for read-only freshness or select `cron-doc-view` through `check:generated-artifacts`. The table validates source/Wrangler agreement before writing. CPU-class rationale, fencing and incident interpretation remain authored contracts, not inferred from the table.

## Shared Database Helpers

**Files:** `worker/src/lib/db.ts` for generic D1 helpers and `worker/src/lib/db-cache.ts` for cache-table helpers (`getCache`, `setCache`, `setCacheIfAbsent`, `setCacheIfNewer`, `getPriceCache`, `savePriceCache`).

### Remote D1 Inspection

Inspect production D1 with `wrangler d1 execute --remote --command "SELECT …"` and never with `--file`: `--file` is submitted through the D1 **import** API, so a read-only probe reports `changed_db: true` and holds a database-level import lock that blocks Worker writes for its duration. `scripts/maintenance/watch-worker-cron.mjs` (`d1Select`) already uses `--command` and is the reference.

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

