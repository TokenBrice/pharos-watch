# Worker Infrastructure

> **Agent navigation** — Current invariants and interfaces are below. Detailed implementation and historical decisions are retained in the [appendix](./process/worker-infrastructure-appendix.md). Read routed sections rather than either file wholesale.

Two Cloudflare scripts share one fenced D1 authority. `stablecoin-api` serves HTTP routing, edge caching, CORS, admin auth and public-owned scheduled work; `stablecoin-heavy` is scheduled-only. The union of `worker/wrangler.toml` and `worker/wrangler.heavy.toml` owns deployed expressions, `CRON_JOB_DEFINITIONS` owns status-tracked jobs, and `CRON_CONNECTION_BUDGET_ENTRIES` also covers budget-only surfaces. Run the cron sync and connection-budget checks for current topology.

Execution note: the `snapshot-supply` retry path runs on the logical quarter-hour schedule, deployed as the `0/15/30/45 * * * *` hourly aliases, only after a downstream-safe `sync-stablecoins` cache write. The `0 8 * * *` daily fallback additionally requires the `stablecoins` cache row to be written at or after that scheduled slot start before it can consume write-once daily artifacts.

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

Telegram custom logs have a narrower privacy contract in `worker/src/lib/telegram/log.ts`: no raw or pseudonymous chat/user/update/callback/pending/source-event identifier is emitted. The logger accepts only low-cardinality operation fields and bounded numeric/status metadata, drops unknown keys and non-primitives at runtime, normalizes error classes to a fixed vocabulary, and scrubs URLs, secret assignments, Telegram IDs, UUIDs, and opaque hashes/tokens from allowed strings. Chat-specific incident correlation belongs to Access-authenticated D1/admin diagnostics. Workers Logs and invocation logs are enabled with the checked-in 0.1 head sampling rate; Cloudflare processes sampled records under account permissions. The external retention/Logpush decision is owned by `tokenbrice`: structured logs remain local-only in Workers Logs, with no repository-configured Logpush archive or retention duration. Evaluate Logpush when log volume justifies retention beyond the documented D1 ledgers; until then, durable operational evidence must use those ledgers rather than console retention.

Provider URLs that may embed credentials must pass through `redactProviderUrls()` / `safeErrorMessage()` before logging. The central redactor strips path/query details for Alchemy, dRPC, Etherscan, Telegram, Twitter/X, Anthropic-style hosts, and redacts generic secret query parameters on other URLs. Structured Worker and cron metadata applies the same redaction recursively to nested strings, arrays, objects, and `Error` message/stack fields before truncation or serialization. Telegram Bot API tokens still appear in outbound URLs, so Cloudflare invocation logs must be treated as secret; removing that legacy URL-token path is an operational follow-up.

---

## Env Interface

`Env` (`worker/src/lib/env.ts`) is consumed by the HTTP and scheduled context factories. Wrangler owns `DB`, `CORS_ORIGIN`, `SELF_URL`, Access bindings and hardening mode vars; other active bindings are runtime values, typically secrets. `shared/lib/env-contract.ts` owns the cross-runtime manifest, and `npm run check:env-contract` compares Wrangler `[vars]`/D1 bindings with the Worker type contract.

`worker/src/lib/env.ts` still exports the worker runtime views:

- `WORKER_REQUIRED_ENV_KEYS`
- `WORKER_OPTIONAL_ENV_KEYS`
- `WORKER_RESERVED_ENV_KEYS`
- `WORKER_ACTIVE_ENV_KEYS` (`required + optional`)

Pages contracts (`functions/lib/ops-env.ts`, `functions/lib/site-api-env.ts`) derive the same four views. Validation reports partial Access/admin-D1/Telegram pairs, missing site-proxy/feedback/API-pepper/Banxico credentials, and no-op pepper rotation (including Telegram `_PREVIOUS` markers). Ops requires team domain plus UI audience. Site-data requires `DB` for fail-closed selector POST quotas; public reads can continue without attribution. Binding ownership/requirements are in the linked inventory.

`ScheduledEnv` is the narrow shared scheduled-context view; `HeavyEnv` in `worker/src/lib/env.ts` retains the heavy-only `SAFETY_SCORE_V9_WORKFLOW` binding during the terminal retirement's resource-drain stage. Heavy uses the same `DB`, `CF_VERSION_METADATA`, compatibility date/flags, alias, module rules and CPU cap as public, without HTTP/CORS/rate-limit bindings. The pilot mode variable and cron trigger are removed. The class/export/binding remain only until complete history disposition and named-resource deletion; Cloudflare rejects removing a class while its Workflow resource still references the script.

Heavy additionally requires `SAFETY_CAPTURE_ARCHIVE`, an R2 binding to the existing `pharos-measurements` bucket, declared only in `worker/wrangler.heavy.toml`. The scheduled publication adapter passes it into accepted-capture archiving; public has no bucket binding. The unified `Env`/`ScheduledEnv` view marks it optional for public compatibility, while `HeavyEnv` requires it and `check:worker-config` enforces the heavy bucket name/ownership. No R2 credentials are required by the Worker binding; offline archive tooling uses the operator's existing `R2_MEASUREMENTS_*` client credentials.

Heavy operator secrets are exactly `COINGECKO_API_KEY`, `ALCHEMY_API_KEY`, `DRPC_API_KEY`, and `TRONGRID_API_KEY` (provisioned 2026-10-07). `DWELLIR_API_KEY` is optional supplemental RPC capacity and is absent on heavy, so `applyDwellirEndpoints` returns early and the heavy chain RPC map holds only the Alchemy/dRPC registry endpoints; `ETHERSCAN_API_KEY` is read only by public lanes (blacklist, USDS status, yield, quarter-hourly) and is not provisioned. It neither requires nor reads `M0_API_KEY`; reserve producer/recovery remain public. `GRAPH_API_KEY` is explicitly absent: charts stage-recovery receives `graphApiKey: null`. Inline DEX recapture therefore fails preflight with `missing-graph-api-key` before lease acquisition, source requests or stage/target writes, rather than publishing an incomplete descriptor catalog. Heavy can consume ready public-produced D1 stages; failed :16 recapture errors, while :46 defers unusable-stage publication and reuses the prior accepted generation. Optional provider-budget/mint-burn controls remain absent to preserve defaults; heavy requires no Telegram/admin/site/Anthropic secrets.

Operational telemetry control: set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on the Worker and/or Pages site-data environment to stop low-value route/source attribution writes. This disables Worker `api_request_consumer_stats` route/source writes and Pages `site_data_request_stats` writes, while preserving API-key authentication, D1-backed rate limiting, last-used metadata updates, and per-key public API load telemetry. During keyed public-API spikes, set `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true` on the Worker to pause only `api_key_request_stats` writes; auth, rate limiting, and last-used metadata still run.

The complete key-by-key contract is in [Binding Inventory](process/worker-infrastructure-appendix.md#binding-inventory), generated from the manifest and validated by `check:env-contract`. This reference table does not independently author requirements. Collector, repair, canary, and recovery behavior is separated into [Runtime Feature Contracts](#runtime-feature-contracts); a binding's presence alone does not establish that feature's admission or publication authority.

## Runtime Feature Contracts

Measured DEX execution, including current cohorts and historical native-lane removals, is owned by the [DEX liquidity methodology](./dex-liquidity.md). This document retains only the generic cron capacity, scheduling, and retention contracts; operators should not infer removed native collectors or former schedules from this infrastructure overview.

Stablecoins cache reads retain the loader's result union: `missing-cache` requires a successful absent read; D1 rejection returns `cache-read-failed` with no observation clock. Invalid payloads remain separately named failures; only admitted payloads authorize downstream data claims.

The EVM lane first reserves at most one published score-bearing direction packet closest to its adapter-specific expiry, bounded to 20 estimated requests inside the same 1,220-request ceiling. The legacy Curve 3pool packet remains atomic, the reservation does not advance the durable cursor, and the remaining inventory keeps the existing whole-coin rotation.

The EVM admission estimate also counts the hook-free Uniswap V4 deployment's PoolManager, StateView, and Quoter runtime checks, the two immutable PoolManager bindings, and batched pinned pool-state reads. A transport-failed eight-call V4 quote batch recursively fragments within the reserved headroom; recovered sub-batches retain their results, while terminal singleton transport failures remain degraded. V4 source enrichment is a third serialized subgraph family, so it does not increase the source-stage connection peak.

The generation-fenced D1 target and quote tables are additive. Active and shadow targets/quotes use separate producer surfaces. A quote publication stores measured and real failure outcomes plus a target-manifest digest; manifest-proven `budget-deferred` outcomes are reconstructed on read instead of being written as dense rows. `sync-dex-liquidity-stage` builds the exact source graph hourly at `:10` in bounded chunks in `dex_liquidity_scoring_stages` / `dex_liquidity_scoring_stage_chunks`: D1 layout schema v1, payload v4 with the frozen registry-read evaluation clock. The normal D1-only `:16` consumer publishes prices, liquidity/history and active measured targets hourly, shadow targets daily at `06:16 UTC`. Exact-slot inline recovery requires Graph credentials, the source-stage lease and deadline headroom; keyless heavy refuses it as `missing-graph-api-key`. At :46, a ready unconsumed stage may publish; an unusable stage or refused recovery preserves prior-generation reuse without rewriting DEX surfaces. A pre-cutover v3 payload is rejected at :16; :46 reuses the prior publication, and the next :10 produces v4. Deploy/rollback outside :08–:17 (see [DEX operations](./dex-liquidity.md#v69-deploy-and-rollback-operations)). On successful hourly publications, the serial D1-only `cron-sentinel` turnover source compares per-coin route identities/evidence kinds with its compact prior-publication snapshot before V9 preparation. The half-hour collector reuses the latest Solana targets until daily refresh. These stage and recovery fences change input integrity, not the Safety formula.

Transient DEX evidence is retained in D1 only. Eligible measured quote/target generations turn over after four hours, strictly beyond their three-hour evidence freshness ceiling; non-current liquidity and abandoned price run rows retain their separate three-hour policies. Current publications and referenced targets remain protected. Candidate inserts capture the unique current leased child invocation only while its execution fence still matches. An active measured candidate is eligible only with recognized producer provenance, no validation/publication clock, exact terminal child and cron-run evidence, no live lease/progress/child/slot for that same invocation and owner, and no quote or publication-ledger reference. An unrelated newer invocation of the same job does not establish ownership of an old candidate. Age or a null publication clock alone never proves abandonment; unknown ownership, missing terminal proof, malformed reference manifests and all shadow candidates remain retained. Each measured delete drains at most 16 physical rows oldest-first before empty ledgers are removed. Consumed scoring stages are deleted by the next stage cleanup and abandoned stages by two hours. Discovery staging keeps 30 hours and clears provider `raw_json` after four hours. Cleanup reports cutoff, deleted rows, oldest remaining row, duration, and error without failing an otherwise successful publication. Public `dex_liquidity_history` remains at 365 days.

Fresh, independently revalidated route identities with at least two successful cycles may remain in the bounded V9 route compiler for one evidence-freshness window after rotating out of the current pool shortlist; they never rejoin liquidity, pricing, display, or target-publication surfaces. The score-eligible QuoterV2 cohorts are the owner-ratified Uniswap V3 deployments on Ethereum, Polygon, Arbitrum, and Celo; PancakeSwap V3 on Base, BSC, and Ethereum; plus the reviewed Base Aerodrome Slipstream cohort. The separately validated hook-free Ethereum Uniswap V4 cohort is also score-eligible through its pinned PoolManager, StateView, and Quoter path. Optimism Uniswap V3 has been retired from both the source-stage subgraph lane and the measured-execution registry. Generic Raydium CLMM, Orca Whirlpool, Meteora, and every other unratified or paused EVM cohort capture only in shadow and retain an `activation-pending` capability gate. The Solana and Tron native measured-execution lanes and the Fluid measured overlay were removed in Liquidity Score v6.0 together with their producers, registries, schemas, and persistence wrappers; retained Raydium, Orca, SunSwap, and Fluid pools now resolve as shaped evidence outside the strict exact-route denominator, and their aggregate TVL, price, and visible-pool contributions are unchanged. See [dex-liquidity.md](./dex-liquidity.md) for the measured-execution contract. Shadow, stale, malformed, failed, or identity-drifted profiles remain gated. No stale proof or manual capacity is substituted for a current direct route. This lane does not make a deployment score-eligible by registry presence alone.

BNB Chain Uniswap V3 remains shadow-only. Its six-chain Uniswap subgraph family is capped at five concurrent requests; BSC is a permanent execution-only candidate input of the measured cohort, never fee enrichment or DEX price consensus. A bounded target-only recovery pins the official factory, exact pool binding, token order, fee, slot state, balances and reviewed QuoterV2 deployment. Its conditional retirement waits for source-exclusive retained-pool replacement/loss/outage proof and mature BSC publication; the recovery is not removed by this engineering pass.

Hook-free Ethereum Uniswap V4 is active and score-eligible. Base, BSC, Arbitrum, Polygon and Tempo remain reviewed shadow collectors, not scoring coverage. One runtime-neutral reviewed registry owns lifecycle and pins for both public validation and Worker consumers. Unichain V4, Hybra V3 and XSwap V3 measured cohorts are retired without removing ordinary venue discovery or generic RPC transport. Loaded target catalogs are checked against current lane/deployment policy before RPC admission, so old pointers cannot requote retired or moved-lane identities. Hooked identities remain unsupported permanent collision evidence, not a shadow execution programme.

The reviewed Ethereum legacy Curve 3pool is a separate measured adapter, not a
generic Curve activation. Every run revalidates the pool and main-registry
runtime hashes, registry LP binding, registry/pool token order, token decimals,
and the actual pinned block timestamp before quoting. USDT and USDC each publish
an atomic pair of counter-stablecoin directions; a missing or invalid sibling
leaves the existing reserve simulation in place. Retained route-only evidence
reconstructs both siblings from the same packet or admits neither. Selected
quotes expire after three hours, preserving the original quote timestamp and
block. Every measured adapter shares that ceiling, independently of the hourly
score-bearing publication cadence. The three-hour history window lets repeated
half-hour cycles coexist. Only after both directions have at least three complete cycles and
three successful observations does the measured packet become score-facing;
until then P4 keeps the reserve simulation. An exact absent-bytecode response is
semantic drift and cannot retain last-known-good evidence, while RPC
unavailability remains operational. Expired packets fall back to the reserve
model.

Repair debt: canonical `worker_repair_tasks` is the only authority. The obsolete `cache['ddr:repair-debt:v1']` writer/reader was retired; a successful exact-key SELECT on `stablecoin-db` on 2026-10-07 returned no row, closing residue cleanup on that inspected target without a DELETE. Other preview/restore targets are not certified by that capture. Preserve negative legacy-cache regression tests and task-backed unknown-on-read-error behavior. The daily repair-debt source of `cron-sentinel` still executes queued T1.2-safe repairs when enabled and always reports due/stale backlog. `DDR_REPAIR_TASK_RUNNER_ENABLED` defaults on for unset/empty values; invalid non-empty values disable execution with a warning. Reconciliation closes no-longer-current tasks and retention prunes terminal rows; neither is retired with the obsolete cache.

Data-invariant canaries are permanent operator diagnostics, not an alert or scoring rollout. Unset `WORKER_CANARY_MODE` defaults to `off`; checked-in config uses `status`. `ACTIVE_CANARY_CHECK_IDS` owns the nine-check cohort; missing, duplicate, extra, stale, future-clock or legacy execution-unknown evidence cannot claim a complete healthy cohort. DEX checks count actual current-table publication violations only for rows with a non-null `publication_generation_id` whose `publication_state` is null or not `published`; retained generationless compatibility rows are excluded. The latest published generation's actual published-row count is independently checked against its publication metadata, and the global-row check counts generation-bound `__global__` rows. Legitimate staged candidates in private run tables are not exposed-current violations. Blacklist identity completeness detects rows missing both `config_key` and `contract_address`. In `status`, completed measurements persist their original finding status/severity and return cron `ok` plus named `quality`, including severe corruption. Failed required reads, unusable contracts, incomplete cohorts and persistence failures remain operationally degraded. Each check exposes `executionStatus` and `executionFailureReason` independently of finding severity. `off` performs no canary work and does not stop independent probes or sentinel execution. There is no condition-specific push escalation, even for severe findings; operators must inspect status/ledger evidence. The separately scheduled sentinel retains its own Telegram delivery predicates.

Completed informational `skipped` findings are intentional non-measurements: they retain their skip reason/count but do not alone degrade cron `observedStatus` or add `quality`. A successfully read empty DEX publication skips the row-consistency comparison; the independent global-row check still reports missing current data as degraded. Failed required measurement work remains degraded regardless of finding status. The advisory latest-per-check canary aggregate retains its existing conservative degraded treatment of skipped evidence, rather than claiming every invariant was measured healthy.

**Deployed-override gate (2026-10-08):** status-only/no-paging policy is approved, but the complete inventory of deployed Workers/environments, dashboard/config/secret overrides and private tooling has not been recorded. Until that inventory intentionally migrates every selection to `status` or `off`, `shadow` (hidden collection/unconditional-success policy) and `alert` (stronger terminal-error policy, not an alert sender) remain accepted. After inventory closure, remove those branches and normalize obsolete selections to `off`; never remap retained historical modes into current evidence. No paging activation is planned.

Reserve recovery: `WORKER_RESERVE_RECOVERY_MODE` defaults to `off`; checked-in config uses `recover`. Checkpoints are always written. The five-minute `2/6` lane claims compatible interrupted suffixes and runs bounded config recovery under the reserve lease. [Deploy-time configuration recovery](process/live-reserves-appendix.md#deploy-time-configuration-recovery) owns targeting, one-opportunity consumption, release visibility and acceptance.

## Module Initialization

The runtime pins Zod 4.5.0 for lower schema-initialization memory. Local import-only comparisons against 4.4.3 reduced retained heap for the measured-execution graph from 8.52 MB to 4.97 MB and the V9 extension graph from 40.43 MB to 31.42 MB (three fresh-process samples per version). These overlapping graphs must not be added together, and import-only Node measurements do not prove Cloudflare peak-memory safety. Memory-risk releases still require a new affected production execution and correlated platform outcomes; CPU-class aliases and staggered cron minutes are not isolate memory boundaries.

Runtime configuration is derived from `Env` bindings in the scheduled context factory (`worker/src/handlers/scheduled/context.ts`) and the HTTP route-context factory (`worker/src/handlers/http/context.ts`), which runs the per-endpoint hydrators in `worker/src/routes/dependency-hydrators.ts`, with results passed as parameters rather than stored in module-level state:

| Function                                                | Called in             | Purpose                                                     |
| ------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| `normalizeCgApiKey(env.COINGECKO_API_KEY)`              | `fetch` + `scheduled` | Returns normalized API key for CoinGecko requests           |
| `buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY, { dwellirApiKey? })` | `fetch` + `scheduled` | Builds chain RPC configs from typed registry endpoints (Alchemy/dRPC/public, today's order preserved). When a Dwellir key is supplied it additionally appends one supplemental `DWELLIR_CHAINS` endpoint after every registry endpoint, and creates a supplemental-only config for pin-only chains. Scheduled runtimes rebuild with the key inside `runLeasedCron` only when the credit ledger is usable and the `dwellir-evm` circuit is closed; routes build without it. |
| `resolveMintBurnFreshnessConfig(env)`                   | `fetch` + `scheduled` | Resolves mint/burn major symbols and stale/alert thresholds |
| `createDwellirNativeCapability(env.DWELLIR_API_KEY)` | `scheduled` only | Creates a key-hiding native state-read transport after the same memoized credit-ledger + `dwellir-evm` circuit admission as EVM supplementals; passed through adapter contexts, never created by request-path hydration. |

These are pure functions. `Env` bindings are only available inside handler functions (not at module initialization time), so values are computed fresh per-request/per-trigger via the context factory. The notable exception is `shared/lib/cloudflare-access-jwt.ts`, which intentionally keeps an in-memory JWKS cache (`jwksCache`, 1-hour TTL) at module scope to avoid refetching Cloudflare Access signing keys on every admin request.

Redemption downstream-resolution disclosure is also run-local: `applyOutputDependencyResolution()` in `worker/src/lib/redemption-backstop/sources.ts` receives the completed snapshot and configuration map, builds one local resolution index, and returns changed rows without mutating builder outputs. There is no module-global clock-keyed per-run join state; concurrent runs with the same clock cannot cross-contaminate disclosure.

Public endpoint data and provider-quality exclusions live in `shared/lib/chain-rpc-registry.ts`, shared with curated supply probes and V9 supply attribution. `worker/src/lib/public-rpc-registry.ts` only performs lookups and ordered-list construction from that authority; it owns no endpoint table. The public, curated-supply, and attribution profiles intentionally preserve their distinct fallback lists rather than silently expanding runtime routes.
`chain-registry.ts` constructs RPC metadata through one private `rpcConfig` projection of `CHAIN_META`; provider guards, endpoint ordering, credentials, and state/log capability metadata remain at their existing branches.

Alchemy's additional archive state-only census endpoints use supplemental-only configs and `logsHistory: none`. A chain's presence in the RPC map does not establish registry RPC readability: consumers use `hasRegistryRpc()` or `registryRpcUrls()` for that capability. The transfer census can use archive supplemental endpoints without expanding registry or log-scan inventories; Dwellir remains appended after the existing census endpoints.

Dwellir EVM endpoint authority is `shared/lib/dwellir-chains.ts` (37 chains, including Etherlink, Cronos, Flow EVM, Pulsechain, Immutable zkEVM, Boba, Astar, and Taiko). Native endpoints and read capabilities live separately in `shared/lib/dwellir-native-endpoints.ts`: Aptos/Movement REST, TRON constant-contract HTTP, and Starknet `starknet_call`. `worker/src/lib/dwellir-native.ts` closes over the admitted key, scopes it to these fixed keyless endpoints, rejects redirects, and meters each received HTTP response (success or error) into the existing Dwellir credit buffer. It adds no mutable module state or independent admission authority. Configured/incumbent routes stay first; native fallback cannot expand TRON events/indexing or enable historical TRON state. Movement's retained-ledger floor is read from each fallback node's ledger metadata, never inferred from an archive label. Scheduled runtimes without a usable ledger or closed circuit expose neither EVM nor native Dwellir capabilities; HTTP runtimes never receive the native capability.

Endpoint transport metadata in `worker/src/lib/chain-registry.ts` may declare an inclusive `maxLogBlockSpan` and `noBatch`. The shared RPC helpers skip endpoints that cannot accommodate an explicit log range and execute no-batch groups serially with exact response IDs, deadlines and request guards. These options do not change endpoint order, state/log history classifications or inventory eligibility; absent options preserve existing batch transport and caller-selected ranges.
Every physical RPC retry rechecks the request guard, meters provider credits, and clips its timeout and backoff to the absolute deadline; batch and no-batch transports share this admission path.
Admission or deadline denial in `fetch-retry.ts` throws the typed `FetchRequestNotStartedError` sentinel, carrying the denial reason and count of earlier started attempts to that URL. Single, batch, and no-batch RPC reads stop the bounded operation with their existing unavailable result. An untried supplemental endpoint is neither charged nor demoted, so later independently admitted operations sharing the same run map may still reach it; a provider that actually failed before a denied retry remains eligible for run-local demotion.
Capped inclusive explorer log ranges split sequentially down to singleton blocks; only a capped singleton is unsplittable, including when its parent spans two adjacent blocks.

---

## HTTP Request Handling

### HTTP request handling entry

Select the contract affected by the request path rather than reading the entire HTTP chapter:

- Routing and browser responses: [Method Routing](process/worker-infrastructure-appendix.md#method-routing), [CORS Headers](process/worker-infrastructure-appendix.md#cors-headers), and [Edge Cache Strategy](process/worker-infrastructure-appendix.md#edge-cache-strategy).
- Public credentials and traffic: [Public API Auth and Rate Limiting](process/worker-infrastructure-appendix.md#public-api-auth-and-rate-limiting) and [Request Attribution](process/worker-infrastructure-appendix.md#request-attribution).
- Privileged callers: [Admin Auth](process/worker-infrastructure-appendix.md#admin-auth), [Site-Data Auth](process/worker-infrastructure-appendix.md#site-data-auth), and [Idempotent Admin Actions](process/worker-infrastructure-appendix.md#idempotent-admin-actions).
- Stateful reads and maintenance: [D1 Read Snapshots And Pagination](process/worker-infrastructure-appendix.md#d1-read-snapshots-and-pagination), [Append-only D1 Retention Policy](process/worker-infrastructure-appendix.md#append-only-d1-retention-policy), and [Isolate-Local State Registry](process/worker-infrastructure-appendix.md#isolate-local-state-registry).

The [API reference](./api-reference.md) owns endpoint contracts; the [admin reference](./api-reference-admin.md#admin-endpoint-entry) owns operator-only routes.

### Completed D1 Schema Cleanup

The canonical operated-cleanup history, current production removals, rollback limits, and deferred queue live in [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md#completed-destructive-cleanup-operations). Do not duplicate that inventory here. Destructive cleanup remains outside the normal migration path and requires production backup/Time Travel verification, fresh zero-use evidence, and a dedicated operated rollout after compatible Worker code has soaked.

## Cron Scheduling

Cron expressions are source-owned by the two Wrangler configs. Logical schedule keys, physical aliases, status-tracked jobs and connection budgets live in `shared/lib/cron-jobs.ts`; dispatch chains and Worker ownership live in `shared/lib/scheduled-runner-registry.ts`. Hourly aliases preserve logical sub-hourly cadence while using Cloudflare's hourly CPU class. `runScheduledSlotWithFence()` in `worker/src/lib/scheduled-slot-fence.ts` owns claim, heartbeat, takeover and terminal fencing; `scheduled-slot-reconciliation.ts` owns stale child progress/lease cleanup, synthetic run persistence, attempt abandonment and operator event markers. Reconciled child rows preserve bounded `progressSnapshot` evidence before cleanup, and slot events expose shallow `abandonedProgress` entries with validated counts, reserve coin/adapter identifiers and aggregate I/O/timing counters. `metadataStatus` names missing/malformed/oversized input. Last-known progress is diagnostic context, not interruption attribution. Compact slot metadata retains child-job counts/outcomes (`jobsRun`, `jobsSkipped`, `jobsNeutralSkipped`, `jobsDegraded`, `jobsErrored`, `budgetOnlyJobs`), and degraded/error children escalate the slot even when best-effort work continues. A stale child is deploy-neutral only when its executing UUID differs from the **registry owner's** current verified UUID, the stale slot heartbeat is no more than 15 seconds newer than child progress, progress leads the heartbeat by at most `resolveScheduledSlotPolicy(slot.slot_key).heartbeatSec`, and latest life evidence `max(slot.updated_at, progress.updated_at)` falls from 15 seconds before to 120 seconds after the owner's immutable `worker-version-activated:<uuid>` timestamp, with activation no later than the sweep. A missing slot UUID can use the dying invocation's `cron_run_progress.metadata.workerVersion`; another script's reconciler UUID cannot substitute for owner deployment evidence. This directional alignment admits eviction between slot ticks without admitting a slot that continued heartbeating after its child stopped. Zero progress past child start is not required. Activation clocks come from Cloudflare `created_on`, never CI wall time; first-seen evidence stays diagnostic, and absent/out-of-window activation stays error/abandoned. Idle neutral no-op children never synthesize missing daily-digest failures, but durable started digest progress is reconciled when abandoned. A job normally owns one schedule key; `SHARED_SCHEDULED_JOB_IDENTITIES` is the closed multi-slot allowlist (`cron-sentinel` runs from four). An unregistered/unallowlisted dispatch makes descriptor construction throw. Sharing identity shares a lease, status row and freshness reading against the registered interval. Run both cron checks after schedule/chain changes.

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
| USDS state           | `worker/src/cron/sync-usds-status.ts`          | [Stablecoin Data](./stablecoin-data.md)           |
| Live reserves        | `worker/src/cron/sync-live-reserves.ts`        | [Live Reserve Sync](./live-reserves.md)           |
| Redemption backstops | `worker/src/cron/sync-redemption-backstops.ts` | [Redemption Backstops](./redemption-backstops.md) |
| Kinesis supply       | `worker/src/cron/sync-kinesis-supply.ts`       | [Supply Snapshot](./supply-snapshot.md)           |
| Bluechip ratings     | `worker/src/cron/sync-bluechip.ts`             | [Bluechip Ratings](./bluechip-ratings.md)         |

