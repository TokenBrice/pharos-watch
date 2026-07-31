# Worker Infrastructure

Cloudflare Worker serving the Pharos API. It handles HTTP routing, edge caching, CORS, admin auth, and scheduled runtime work. `worker/wrangler.toml` owns deployed expressions, `CRON_JOB_DEFINITIONS` owns status-tracked jobs, and `CRON_CONNECTION_BUDGET_ENTRIES` also covers budget-only scheduled surfaces. Run the cron sync and connection-budget checks for the current topology.

Execution note: the `snapshot-supply` retry path runs on the `*/15 * * * *` trigger only after a downstream-safe `sync-stablecoins` cache write. The `0 8 * * *` daily fallback additionally requires the `stablecoins` cache row to be written at or after that scheduled slot start before it can consume write-once daily artifacts.

**Deployed at:** `api.pharos.watch` (public integration API), `site-api.pharos.watch` (website-internal data lane), and `ops-api.pharos.watch` (operator lane; pair with Cloudflare Access before use)

> **Agent navigation** — Grep the heading you need: Runtime Limits and Observability · Env Interface · Module Initialization · Public API Auth and Rate Limiting · HTTP Request Handling · Cron Scheduling · Telegram Alert Bot · logCronRun() Wrapper · Alert System · Shared Database Helpers · Cron Job Ownership · Health & Status Endpoints · Key Constants.

---

## Runtime Limits and Observability

Worker runtime safety and telemetry controls are declared in `worker/wrangler.toml` and should be managed in git. The CI deploy job proves the strict Worker bundle before applying D1 migrations and then runs `wrangler deploy --strict`, so routes, triggers, bindings, and other dashboard-only edits can be overwritten on the next deployment.

```toml
compatibility_date = "2026-04-18"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
preview_urls = true

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
- `compatibility_date = "2026-04-18"` + `nodejs_compat`: top-level Wrangler runtime compatibility settings for the deployed Worker.
- `global_fetch_strictly_public`: keeps Worker-origin fetches to the Worker's own public custom domains on the public edge path. `status-self-check` depends on that behavior for production-domain canaries; without it, same-Worker custom-domain self-fetches can return internal 522s while external clients remain healthy.
- `observability.enabled`: enables Worker traces.
- `head_sampling_rate = 0.1`: samples 10% of traces.
- `observability.logs.enabled` + `invocation_logs = true`: enables Workers Logs in dashboard.
- `preview_urls = true`: keeps deployment-specific preview URLs available for explicit diagnostics without making them part of the production release gate.

Cron observability has two paths. Terminal job outcomes continue through `logCronRun()` / `cron_runs`; swallowed exceptions that should remain non-fatal use `recordCronFailure()`. Degraded, skipped, fallback, or warning conditions that should survive log retention can call `logCronEvent(db, { job, eventType, severity, message, metadata })`, which writes a latest-event record to the existing cache table under a bounded `cron:event:<job>:<eventType>` key and also emits a structured console line. Use `logCronEvent` for non-terminal operational events rather than adding TODO-backed `console.*` call sites.

HTTP, API, status, and admin route logs use `logWorkerEvent()` from `worker/src/lib/structured-log.ts`. It emits one JSON console line with stable top-level fields (`scope`, `level`, `event`, `route`, `job`, `provider`, `source`, `runId`) and bounded `metadata` / error fields so Cloudflare Workers Logs stay queryable without turning high-cardinality values into top-level keys. `npm run check:cron-console-usage` keeps its historical name but now ratchets raw `console.*` calls across cron plus HTTP/status/admin roots. It is enforced through `check:structural` for affected PR paths and every nightly/manual validation run; new route logs should use `logWorkerEvent()` instead of direct string console calls.

Telegram custom logs have a narrower privacy contract in `worker/src/lib/telegram-log.ts`: no raw or pseudonymous chat/user/update/callback/pending/source-event identifier is emitted. The logger accepts only low-cardinality operation fields and bounded numeric/status metadata, drops unknown keys and non-primitives at runtime, normalizes error classes to a fixed vocabulary, and scrubs URLs, secret assignments, Telegram IDs, UUIDs, and opaque hashes/tokens from allowed strings. Chat-specific incident correlation belongs to Access-authenticated D1/admin diagnostics. Workers Logs and invocation logs are enabled with the checked-in 0.1 head sampling rate; Cloudflare processes sampled records under account permissions. The external retention/Logpush decision is owned by `tokenbrice`: structured logs remain local-only in Workers Logs, with no repository-configured Logpush archive or retention duration. Evaluate Logpush when log volume justifies retention beyond the documented D1 ledgers; until then, durable operational evidence must use those ledgers rather than console retention.

Provider URLs that may embed credentials must pass through `redactProviderUrls()` / `safeErrorMessage()` before logging. The central redactor strips path/query details for Alchemy, dRPC, Etherscan, Telegram, Twitter/X, Anthropic-style hosts, and redacts generic secret query parameters on other URLs. Structured Worker and cron metadata applies the same redaction recursively to nested strings, arrays, objects, and `Error` message/stack fields before truncation or serialization.

---

## Env Interface

The `Env` interface is defined in `worker/src/lib/env.ts` and consumed by `worker/src/index.ts` plus the HTTP-request helper stack under `worker/src/handlers/http*.ts` and the scheduled-runtime entrypoint/context (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/scheduled/context.ts`). `DB`, `CORS_ORIGIN`, `SELF_URL`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_OPS_API_AUD`, and the active Worker hardening mode vars are set in `worker/wrangler.toml`; the remaining active bindings are runtime env values (typically provided via Cloudflare Worker secrets). The cross-runtime key manifest now lives in `shared/lib/env-contract.ts`, and `npm run check:env-contract` compares Wrangler-owned `[vars]` plus D1 bindings against `Env` so config-only binding changes cannot drift from the worker type contract.

`worker/src/lib/env.ts` still exports the worker runtime views:

- `WORKER_REQUIRED_ENV_KEYS`
- `WORKER_OPTIONAL_ENV_KEYS`
- `WORKER_RESERVED_ENV_KEYS`
- `WORKER_ACTIVE_ENV_KEYS` (`required + optional`)

The paired Pages Functions contracts live in `functions/lib/ops-env.ts` and `functions/lib/site-api-env.ts`, with the same `required` / `optional` / `reserved` / `active` shape derived from that shared manifest. Worker runtime validation logs contract errors when Access bindings are only partially configured, when admin D1 status bindings are only partially configured, when `SITE_API_SHARED_SECRET` is missing, when `GITHUB_PAT` / `FEEDBACK_IP_SALT` are missing for `POST /api/feedback`, when `API_KEY_HASH_PEPPER` is missing, when `BANXICO_TOKEN` is missing for the official MXN CETES benchmark, or when the self-serve API key email verification bindings are only partially configured. The Pages ops-proxy contract now actively requires `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD` for inbound UI JWT verification. The Pages `site-data` `DB` binding is part of the required Pages site-data contract because selector-snapshot POST quotas fail closed without it; `/_site-data/*` public-read proxy requests continue without the binding but log that attribution telemetry is disabled.

Operational telemetry control: set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on the Worker and/or Pages site-data environment to stop low-value route/source attribution writes. This disables Worker `api_request_consumer_stats` route/source writes and Pages `site_data_request_stats` writes, while preserving API-key authentication, D1-backed rate limiting, last-used metadata updates, and per-key public API load telemetry. During keyed public-API spikes, set `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true` on the Worker to pause only `api_key_request_stats` writes; auth, rate limiting, and last-used metadata still run.

Scheduled job attempt ledger: unset `WORKER_JOB_LEDGER_MODE` defaults to `off`. The checked-in Worker config currently promotes only the isolated `reserve-recovery` cohort with `WORKER_JOB_LEDGER_MODE=write` and `WORKER_JOB_LEDGER_ALLOWLIST=reserve-recovery` after a clean shadow soak. `write` makes bootstrap, heartbeat, lease-state, and terminal ledger write failures fail the owned job. This narrow-write cohort intentionally stops attempt telemetry for non-allowlisted jobs while it is active, because status reads and the raw-snapshot read-scope fingerprint follow the same mode and effective allowlist. Rollback is `shadow` with the broader observed allowlist, then `off` if writes themselves are unsafe.

Measured DEX execution has its own `0,30 * * * *` scheduled slot and `sync-cl-exit-depth` lease. The slot permits three concurrent EVM chain lanes plus serialized Solana and Tron streams and caps EVM work at 1,300 actual RPC requests and eight minutes. Whole EVM coin cohorts are admitted against a 1,220-request estimate that includes one block read per chain, deduplicated deployment verification, quote batches, refinement, and serialized Quoter confirmation; the remaining 80 requests are reserved for adaptive fragmentation and other nondeterministic overhead. A non-fitting cohort anchors the next cursor while later whole cohorts may fill remaining capacity. Solana preserves 12 cursor-rotated admissions and two serialized, exact-identity shadow reservations: HYUSD/USDC Orca and wM/USDC Raydium. The latter reads one bounded pool account before its direct quote and retains evidence only when captured mint order, liquidity, sqrt price, fee, raw output, and post-swap price replay exactly; both reservations execute before the rotating tail and missing or drifted identities degrade the lane. Tron admits the complete current SunSwap inventory because the native consumer reads one published generation and cannot combine a two-run rotation. Both streams record progress through the shared scheduled-runner path. Durable EVM cursor deferral is healthy partial coverage only while the inventory rotates within two half-hour runs; attempted quote failures, oversized coin groups, a longer rotation, or a missing/failed cursor write remain degraded. Each native stream has a seven-minute producer-scoped network deadline; Tron also uses 15-second request timeouts and admits no new request inside its final 20 seconds. Solana quote/slot/pool-account bodies and TronGrid/Smart Router bodies are hard byte-bounded under those same request deadlines before parsing. When every candidate in a successful Smart Router response is a clean V2 multi-hop path, the pinned V2 Router fallback may add three serialized TronGrid reads per quote point for its runtime, factory binding, and exact two-token quote.

The EVM lane first reserves at most one published score-bearing direction packet closest to its adapter-specific expiry, bounded to 20 estimated requests inside the same 1,220-request ceiling. The legacy Curve 3pool packet remains atomic, the reservation does not advance the durable cursor, and the remaining inventory keeps the existing whole-coin rotation.

The EVM admission estimate also counts the hook-free Uniswap V4 deployment's PoolManager, StateView, and Quoter runtime checks, the two immutable PoolManager bindings, and batched pinned pool-state reads. A transport-failed eight-call V4 quote batch recursively fragments within the reserved headroom; recovered sub-batches retain their results, while terminal singleton transport failures remain degraded. V4 source enrichment is a third serialized subgraph family, so it does not increase the source-stage connection peak.

The generation-fenced D1 target and quote tables are additive. The measured lane consumes the prior scoring generation. `sync-dex-liquidity-stage` then loads sources and builds the exact pool graph at `10,40`, storing it as bounded chunks in `dex_liquidity_scoring_stages` / `dex_liquidity_scoring_stage_chunks`. A reusable byte buffer emits schema-v1 JSONL, each conflict-idempotent direct statement owns one 192-KiB chunk, and cumulative chunk, record, and byte progress is durably reported every 24 chunks plus the final partial interval. The D1-only `sync-dex-liquidity` consumer at `16,46` prefers that source slot, can reuse that exact stage when retrying after consumption, and otherwise consumes the newest still-ready generation from the preceding 55 minutes. The consumer also uses the prior measured generation, publishes scoring surfaces and the next target inventory, and runs before charts in the same serial chain.

Transient DEX evidence is retained in D1 only. Measured quote/target generations, non-current liquidity run rows, and abandoned price run rows turn over after three hours; active/incomplete work, current publications, referenced target generations, and the complete two-hour scoring window are protected. Consumed scoring stages are deleted by the next stage cleanup and abandoned stages by two hours. Discovery staging keeps 30 hours and clears provider `raw_json` after four hours. Every cleanup is bounded and oldest-first, runs inside its owning producer, and reports cutoff, deleted rows, oldest remaining row, duration, and error without failing an otherwise successful publication. Public `dex_liquidity_history` remains at 365 days.

Fresh, independently revalidated route identities with at least two successful cycles may remain in the bounded V9 route compiler for one evidence-freshness window after rotating out of the current pool shortlist; they never rejoin liquidity, pricing, display, or target-publication surfaces. The score-eligible QuoterV2 cohorts are the owner-ratified Uniswap V3 deployments on Ethereum, Polygon, and Arbitrum; PancakeSwap V3 on Base, BSC, and Ethereum; plus the reviewed Base Aerodrome Slipstream cohort. Optimism Uniswap V3 has been retired from both the source-stage subgraph lane and the measured-execution registry. The reviewed wM/USDC Raydium CLMM direction, SunSwap V2, Fluid, generic Raydium CLMM, Orca Whirlpool, Meteora, and every other unratified or paused cohort capture only in shadow and retain an `activation-pending` capability gate. Fluid's bounded target-only copy is hydrated from canonical tracked-contract metadata after direct-source compaction, and only exact pools on the pinned Ethereum, Arbitrum, Base, or Polygon resolver deployments can become shadow targets; unsupported chains and identity-poor discovery fingerprints fail closed. Native registries encode reviewed active/shadow policy explicitly. A valid native profile enters P4 capacity and physical-pool completeness only when that policy is active; the reviewed Raydium direction remains shadow-only but still requires a captured single-segment replay matching the strict direct quote. Shadow, stale, malformed, failed, or identity-drifted profiles remain gated, and non-EVM pool identities preserve case through selection and validation. Solana reuses a still-fresh exact profile only after explicit operational collection failure; semantic or malformed history blocks that fallback. SunSwap's activation and rollback history is incident context only; current registry state is shadow and score-ineligible, while collection continues for revalidation. No stale proof or manual capacity is substituted for a current direct route. Shadow-only native quote degradation stays diagnostic in the merged cron metadata; any native invocation error and non-durable native cursor deferrals, including a Tron rate-limit tail, degrade the merged job. The Solana producer binds native case-sensitive pool/mint identities and exact raw amounts to Raydium CLMM state or Jupiter context-slot proof inside a bounded RPC slot window. The Tron producer verifies canonical SunSwap factory/pair identities and exact constant-product output against a direct SUN Smart Router route or, only when every returned candidate is a clean V2 multi-hop path, the pinned official V2 Router's factory-bound two-token quote. Because TronGrid rejects numeric historical tags, latest-only state reads must fit a bounded before/after block bracket. This lane does not make a deployment score-eligible by registry presence alone.

Hook-free Ethereum Uniswap V4 is likewise shadow-only and always retains `activation-pending`; hooked pools and all other V4 chains are unsupported in this reviewed tranche.

Current containment supersedes the SunSwap reactivation history in the preceding paragraph: the SunSwap adapter is shadow-only and cannot enter P4 capacity or completeness, while collection continues.

The reviewed Ethereum legacy Curve 3pool is a separate measured adapter, not a
generic Curve activation. Every run revalidates the pool and main-registry
runtime hashes, registry LP binding, registry/pool token order, token decimals,
and the actual pinned block timestamp before quoting. USDT and USDC each publish
an atomic pair of counter-stablecoin directions; a missing or invalid sibling
leaves the existing reserve simulation in place. Retained route-only evidence
reconstructs both siblings from the same packet or admits neither. Selected
quotes still expire after two hours for this adapter, preserving the original
quote timestamp and block; every other measured adapter keeps the one-hour
ceiling. The same two-hour history window lets three jittered half-hour cycles
coexist. Only after both directions have at least three complete cycles and
three successful observations does the measured packet become score-facing;
until then P4 keeps the reserve simulation. An exact absent-bytecode response is
semantic drift and cannot retain last-known-good evidence, while RPC
unavailability remains operational. Expired packets fall back to the reserve
model.

Repair debt: DDR repair-required events are dual-written into `worker_repair_tasks` while the existing DDR cache marker remains a status fallback. The daily `worker-repair-runner` compatibility job reads due/stale backlog counts without claiming or mutating rows. Producer reconciliation closes tasks that are no longer current, and retention prunes old terminal rows.

Data-invariant canaries: unset `WORKER_CANARY_MODE` defaults to `off`, and the checked-in Worker config now sets `status` after the shadow soak produced consecutive clean 7/7 cycles. `off` skips and writes no run, `shadow` records observed findings while the cron remains OK, `status` exposes current status-mode rows and returns degraded findings from the cron, and `alert` exposes current alert-mode rows and returns critical findings as a terminal error. In `off` or `shadow`, `/api/status.canaries` returns its empty/unknown compatibility shape without querying retained authoritative rows. The next promotion target remains `alert` only after a separate alert-routing acceptance review; roll back to `shadow` or `off` if status-mode findings are unexplained.

Reserve interruption recovery: unset `WORKER_RESERVE_RECOVERY_MODE` defaults to `off`, while the checked-in Worker config sets `shadow`. Producer checkpoints are written in every mode. The isolated recovery lane uses `off` for no scan, `shadow` for read-only eligibility/blocker telemetry, `reconcile` for generation-fenced abandonment and ready-attempt preparation without a claim, and `recover` for claim plus suffix/sidecar replay. Compatible queue hashes are filtered before the bounded candidate/claim window; shadow telemetry reports the incompatible active count without mutation. In `reconcile` or `recover`, each poll can terminally retire up to five finished-slot checkpoints whose old queue hash can never be replayed, clearing only their exact pending domain attempt. Live-reserve child dependencies are explicit: Kinesis is independent, while redemption backstops and the post-sync watchdog require reserve-queue completion; recovery preserves completed independent children instead of replaying them. `WORKER_RESERVE_FAULT_INJECTION_ENABLED` is a separate fail-closed test-harness gate: only a trimmed, case-normalized literal `true` enables arming and scheduled execution, disabling it neutralizes retained fault rows, and the production `worker/wrangler.toml` intentionally leaves it unset.

<!-- ENV-CONTRACT:WORKER-INFRASTRUCTURE:BEGIN -->
Canonical binding ownership now lives in `shared/lib/env-contract.ts`; the worker and Pages env modules derive their `required` / `optional` / `reserved` views from that manifest.

| Binding | Type | Worker | Pages ops | Pages site-data | Description |
| --- | --- | --- | --- | --- | --- |
| `DB` | `D1Database` | required | - | required | Primary D1 binding for worker reads/writes; Pages uses it for optional site-data attribution telemetry and required atomic selector-snapshot write quotas. |
| `CF_VERSION_METADATA` | `WorkerVersionMetadata` | required | - | - | Cloudflare version metadata binding attached to scheduled attempt and checkpoint telemetry for deployment correlation. |
| `TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT` | `RateLimit` | required | - | - | Cloudflare pre-authentication rate limiter for Telegram webhook requests. |
| `TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT` | `RateLimit` | required | - | - | Cloudflare pre-authentication rate limiter for Telegram Mini App session requests. |
| `TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT` | `RateLimit` | required | - | - | Cloudflare pre-authentication rate limiter for Telegram Mini App mutation requests. |
| `CORS_ORIGIN` | `string` | required | - | - | Comma-separated CORS allowlist; repo default is `https://pharos.watch,https://ops.pharos.watch`. |
| `SELF_URL` | `string` | optional | - | - | Status self-check external probe base URL. |
| `SITE_API_SHARED_SECRET` | `string` | optional | - | required | Shared secret for Pages `/_site-data/*` -> Worker `site-api` authentication via `X-Pharos-Site-Proxy-Secret`. |
| `SITE_API_SHARED_SECRET_PREVIOUS` | `string` | optional | - | - | Optional overlap secret accepted alongside `SITE_API_SHARED_SECRET` during the site-data rotation window. |
| `API_KEY_HASH_PEPPER` | `string` | optional | - | - | HMAC pepper used to hash the secret portion of public API keys. |
| `API_KEY_HASH_PEPPER_PREVIOUS` | `string` | optional | - | - | Optional overlap pepper accepted alongside `API_KEY_HASH_PEPPER` during public API key rotation. |
| `CF_ACCESS_TEAM_DOMAIN` | `string` | optional | required | - | Cloudflare Access team domain used to verify Access JWTs on worker admin requests and the Pages ops proxy. |
| `CF_ACCESS_OPS_API_AUD` | `string` | optional | - | - | Cloudflare Access audience for worker-side `ops-api.pharos.watch` JWT verification. |
| `ETHERSCAN_API_KEY` | `string` | optional | - | - | Etherscan API credential used by blacklist sync and USDS status reads. |
| `TRONGRID_API_KEY` | `string` | optional | - | - | TronGrid API credential used by Tron blacklist sync and SunSwap exact-execution reads. |
| `DRPC_API_KEY` | `string` | optional | - | - | dRPC credential used for L2 archive-node balance lookups. |
| `ALCHEMY_API_KEY` | `string` | optional | - | - | Alchemy credential used for primary chain RPC endpoints and, when enabled, Alchemy Prices API address-price augmentation. |
| `MORALIS_API_KEY` | `string` | optional | - | - | Moralis credential used for optional exact-address token-price augmentation. |
| `BIRDEYE_API_KEY` | `string` | optional | - | - | Birdeye credential used for optional targeted Solana exact-address token-price augmentation. |
| `ADDRESS_PRICE_PROVIDERS_ENABLED` | `string` | optional | - | - | Optional comma-separated allowlist for exact-address price providers. Production enables only the authenticated CoinGecko Onchain exact-address lane; the public GeckoTerminal corroboration pass remains excluded from the inline quarter-hour invocation for Worker heap safety. Unset auto-enables DexPaprika plus configured key-backed providers, and `dexscreener-address` remains explicit opt-in for the Cloudflare/WAF-protected public lane. |
| `GRAPH_API_KEY` | `string` | optional | - | - | The Graph credential used by DEX liquidity subgraph reads. |
| `ANTHROPIC_API_KEY` | `string` | optional | - | - | Anthropic credential used for daily digest generation. |
| `CMC_API_KEY` | `string` | optional | - | - | CoinMarketCap credential used by the price-fallback pass. |
| `JUPITER_API_KEY` | `string` | optional | - | - | Jupiter credential used by Solana price fallback and shadow Orca exact-route quotes against `api.jup.ag`. |
| `COINGECKO_API_KEY` | `string` | optional | - | - | CoinGecko credential used for price enrichment and depeg confirmation. |
| `VAULTS_FYI_API_KEY` | `string` | optional | - | - | Optional vaults.fyi credential for the disabled-by-default supplemental yield integration. |
| `VAULTS_FYI_ENABLED` | `string` | optional | - | - | Optional vaults.fyi supplemental yield integration flag; unset, false, or malformed values keep the integration disabled. |
| `VAULTS_FYI_RANKABLE_VAULTS` | `string` | optional | - | - | Optional CSV allowlist of vaults.fyi `network:vaultId` entries allowed to publish rankable supplemental yield rows. |
| `VAULTS_FYI_MAX_CREDITS_PER_RUN` | `string` | optional | - | - | Optional positive integer local cap for estimated vaults.fyi credit units consumed by one supplemental yield run. Production uses 13 at the four-hour cadence and can lower the effective allowance to keep the UTC-month forecast within the monthly cap. |
| `VAULTS_FYI_MAX_CREDITS_PER_MONTH` | `string` | optional | - | - | Optional positive integer local cap for estimated vaults.fyi credit units consumed during one UTC month. Fetches reserve credit allowance before provider work; telemetry warns before 75 percent projected or actual utilization. |
| `VAULTS_FYI_MAX_PAGES_PER_RUN` | `string` | optional | - | - | Optional positive integer page cap for the audit-only vaults.fyi inventory probe. |
| `GITHUB_PAT` | `string` | required | - | - | GitHub personal access token used by the feedback -> issue bridge; required to keep `POST /api/feedback` available. |
| `FEEDBACK_IP_SALT` | `string` | required | - | - | Dedicated salt for hashed-IP feedback submission throttling; required to keep `POST /api/feedback` available. |
| `API_KEY_SELF_SERVE_IP_SALT` | `string` | required | - | - | Dedicated salt for hashed-IP self-serve API key request throttling. |
| `API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER` | `string` | required | - | - | HMAC pepper used for private self-serve API request email lookup and duplicate-claim keys. |
| `API_KEY_SELF_SERVE_REQUEST_PEPPER` | `string` | required | - | - | HMAC pepper used to hash one-time self-serve API email verification tokens. |
| `RESEND_API_KEY` | `string` | required | - | - | Resend API key used to send self-serve API verification emails. |
| `API_KEY_SELF_SERVE_EMAIL_FROM` | `string` | required | - | - | Configured sender for self-serve API verification emails, e.g. `Pharos API <api@mail.pharos.watch>`. |
| `API_KEY_SELF_SERVE_EMAIL_REPLY_TO` | `string` | required | - | - | Reply-to address for self-serve API verification emails. |
| `API_KEY_SELF_SERVE_PUBLIC_BASE_URL` | `string` | required | - | - | Public website URL used to build self-serve API verification links; production value is `https://pharos.watch/api`. |
| `TWITTER_API_KEY` | `string` | optional | - | - | Twitter/X digest delivery credential. |
| `TWITTER_API_SECRET` | `string` | optional | - | - | Twitter/X digest delivery credential. |
| `TWITTER_ACCESS_TOKEN` | `string` | optional | - | - | Twitter/X digest delivery credential. |
| `TWITTER_ACCESS_TOKEN_SECRET` | `string` | optional | - | - | Twitter/X digest delivery credential. |
| `TELEGRAM_BOT_TOKEN` | `string` | optional | - | - | Telegram bot credential used for digest delivery and alert dispatch. |
| `TELEGRAM_BOT_TOKEN_PREVIOUS` | `string` | optional | - | - | Optional previous Telegram bot token marker used for rotation consistency checks. |
| `TELEGRAM_CHAT_ID` | `string` | optional | - | - | Telegram target chat/channel for digest posts and announcements. |
| `TELEGRAM_WEBHOOK_SECRET` | `string` | optional | - | - | Telegram webhook secret used to authenticate the webhook lane. |
| `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` | `string` | optional | - | - | Optional overlap Telegram webhook secret accepted during secret rotation. |
| `TELEGRAM_RECAP_ROLLOUT_MODE` | `string` | optional | - | - | Personalized recap rollout mode: `off` (default), `dark` (DB-only projection), `canary` (exact chat-ID allowlist), or `public`. |
| `TELEGRAM_RECAP_ROLLOUT_CHAT_IDS` | `string` | optional | - | - | Comma-separated exact Telegram chat IDs eligible for personalized recap canary controls and delivery; ignored outside `canary` mode. |
| `MINT_BURN_DISABLED_IDS` | `string` | optional | - | - | Mint/burn runtime disable list by stablecoin ID (CSV). |
| `MINT_BURN_DISABLED_SYMBOLS` | `string` | optional | - | - | Mint/burn runtime disable list by symbol (CSV). |
| `MINT_BURN_MAJOR_SYMBOLS` | `string` | optional | - | - | Mint/burn health-check major-symbols override (CSV). |
| `MINT_BURN_STALE_WARN_SEC` | `string` | optional | - | - | Mint/burn stale-warning threshold override (seconds). |
| `MINT_BURN_STALE_CRIT_SEC` | `string` | optional | - | - | Mint/burn stale-critical threshold override (seconds). |
| `MINT_BURN_ALERT_COOLDOWN_SEC` | `string` | optional | - | - | Mint/burn stale-alert dedupe cooldown override (seconds). |
| `OPENEXCHANGERATES_API_KEY` | `string` | optional | - | - | Open Exchange Rates credential used for FX cross-validation. |
| `BANXICO_TOKEN` | `string` | required | - | - | Banxico SIE API token required for official MXN CETES 28-day benchmark rates; when the feed fails, MXN retains the last market benchmark when available or remains unavailable for USD fallback. |
| `CLOUDFLARE_ACCOUNT_ID` | `string` | optional | - | - | Cloudflare account scope used by admin D1 status metrics. |
| `CLOUDFLARE_D1_STATUS_API_TOKEN` | `string` | optional | - | - | Cloudflare API token with D1 status/analytics read access for admin metrics. |
| `CLOUDFLARE_D1_DATABASE_ID` | `string` | optional | - | - | Target D1 database ID used by admin D1 status metrics. |
| `MAINTENANCE_MODE` | `string` | optional | - | - | Global worker kill switch; when `true`, non-`OPTIONS` traffic returns `503` maintenance responses. |
| `REQUEST_SOURCE_ATTRIBUTION_DISABLED` | `string` | optional | - | optional | Operational telemetry kill switch for low-value route/source attribution writes on Worker and Pages site-data lanes. |
| `API_KEY_REQUEST_ATTRIBUTION_DISABLED` | `string` | optional | - | - | Worker-only operational telemetry kill switch for per-key public API attribution writes. |
| `WORKER_JOB_LEDGER_MODE` | `string` | optional | - | - | Scheduled job-attempt ledger mode. `off` disables, `shadow` records best-effort telemetry, and `write` makes bootstrap, lease-state, progress-heartbeat, and terminal persistence part of the owned job contract. |
| `WORKER_JOB_LEDGER_ALLOWLIST` | `string` | optional | - | - | Optional CSV allowlist for job-attempt ledger recording. Unset records all scheduled jobs when the ledger mode is enabled. |
| `WORKER_RESERVE_RECOVERY_MODE` | `string` | optional | - | - | Reserve interruption recovery mode. Unset or `off` skips recovery scans; `shadow` reads eligibility only; `reconcile` seals abandoned attempts and prepares replay without claiming; `recover` also claims and replays prepared attempts. |
| `WORKER_RESERVE_FAULT_INJECTION_ENABLED` | `string` | optional | - | - | Explicit preview-only arming gate for reserve recovery fault injection. Only a normalized literal `true` enables the test harness; unset or any other value disables it. |
| `WORKER_CANARY_MODE` | `string` | optional | - | - | Data-invariant mode: `off` skips, `shadow` records only, `status` degrades on findings, and `alert` turns critical findings into terminal errors. |
| `OPS_UI_ORIGIN` | `string` | reserved | optional | optional | Ops UI origin override; reserved on the worker and active on Pages host-gating / same-origin checks. |
| `OPS_API_ORIGIN` | `string` | reserved | optional | - | Ops API origin override; reserved on the worker and active on the Pages admin proxy upstream hop. |
| `CF_ACCESS_OPS_UI_AUD` | `string` | reserved | required | - | Cloudflare Access audience used by the Pages ops proxy to verify the inbound UI JWT. |
| `OPS_API_SERVICE_TOKEN_ID` | `string` | - | required | - | Pages-managed Access service-token client ID used on the server-to-server hop to `ops-api.pharos.watch`. |
| `OPS_API_SERVICE_TOKEN_SECRET` | `string` | - | required | - | Pages-managed Access service-token client secret used on the server-to-server hop to `ops-api.pharos.watch`. |
| `SITE_ORIGIN` | `string` | - | - | optional | Site origin override used by the Pages `/_site-data/*` proxy when classifying production hosts. |
| `SITE_API_ORIGIN` | `string` | - | - | required | Site-data upstream origin; production Pages hosts require `https://site-api.pharos.watch`. |
| `SELECTOR_SNAPSHOTS` | `KVNamespace` | - | - | required | KV namespace binding for the Pages-only Stablecoin Picker snapshot store at `functions/selector-snapshot/[[path]].ts`; new content-addressed `s:{sid}` entries carry server-recomputed trust metadata, while legacy entries remain client-unverified. HMAC-IP write-quota counters live in D1 for atomic reservations. |
| `SELECTOR_SNAPSHOT_IP_HASH_SECRET` | `string` | - | - | required | Dedicated HMAC pepper for selector-snapshot IP rate-limit and daily-quota keys; raw IP addresses are never stored. |
| `TELEGRAM_ADOPTION_IP_HASH_SECRET` | `string` | - | - | required | Dedicated HMAC pepper for PharosWatchBot CTA telemetry per-client minute quotas; raw IP addresses are never stored. |
<!-- ENV-CONTRACT:WORKER-INFRASTRUCTURE:END -->

---

## Module Initialization

Three modules derive runtime configuration from `Env` bindings via pure functions. These are called in the scheduled context factory (`worker/src/handlers/scheduled/context.ts`) and in `worker/src/handlers/http/request-dispatch.ts`, with results passed as parameters rather than stored in module-level state:

| Function                                                | Called in             | Purpose                                              |
| ------------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| `normalizeCgApiKey(env.COINGECKO_API_KEY)`              | `fetch` + `scheduled` | Returns normalized API key for CoinGecko requests    |
| `buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY)` | `fetch` + `scheduled` | Builds chain RPC configs with Alchemy/dRPC primaries |

These are pure functions. `Env` bindings are only available inside handler functions (not at module initialization time), so values are computed fresh per-request/per-trigger via the context factory. The notable exception is `shared/lib/cloudflare-access-jwt.ts`, which intentionally keeps an in-memory JWKS cache (`jwksCache`, 1-hour TTL) at module scope to avoid refetching Cloudflare Access signing keys on every admin request.

## Public API Auth and Rate Limiting

Non-exempt `/api/*` requests on `api.pharos.watch` require a valid `X-API-Key`. Missing or invalid keys return `401 Unauthorized`.

When a valid key is present, the worker uses the D1-backed `api_key_rate_limit` table with the per-key threshold stored in `api_keys.rate_limit_per_minute` (default `120/min`; self-serve keys are issued at `30/min`). API keys carry `api_keys.traffic_class` (`external` or `site`) so request attribution can treat website-owned automation separately from third-party consumers. API-key auth or limiter dependency failures fail closed with `503 Service Unavailable` and `Retry-After: 60`. `FEEDBACK_IP_SALT` remains scoped to feedback submission hashing only.

The no-key public exceptions are `GET /api/health`, `GET /api/og/*`, `POST /api/feedback`, `POST /api/api-key-requests`, `POST /api/api-key-requests/verify`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, and `POST /api/telegram-mini-app/mutate`. The Telegram webhook is authenticated separately through `X-Telegram-Bot-Api-Secret-Token`; Telegram Mini App endpoints are authenticated through signed Telegram `initData`.

The three Telegram POST exceptions pass through path-specific Cloudflare Rate Limiting bindings before body reads, Telegram auth, D1, or request attribution. The Worker ceilings are `2,400/min` for webhook updates, `1,600/min` for Mini App sessions, and `9,600/min` for Mini App mutations per Cloudflare location; bodies are capped at 128 KiB for webhook updates and 16 KiB for Mini App requests. Zone WAF exact-path rules are separate required operator configuration, not deployed by Wrangler. The budgets, required broad-rule exclusions, telemetry contract, and rollout procedure are recorded in [`worker/config/telegram-ingress-abuse-policy.json`](../worker/config/telegram-ingress-abuse-policy.json) and [`telegram-ingress-abuse-controls.md`](./runbooks/telegram-ingress-abuse-controls.md).

Self-serve API key requests use `api_key_requests`, `api_key_request_rate_limit_v2`, `api_key_self_serve_email_claims`, and `api_key_self_serve_issuance_limits`. Request intake hashes normalized email, IP, and user-agent values with dedicated self-serve secrets, sends a Resend verification email, and only creates a key after verification. Verification uses an issuance lock on the request row plus a fixed-window issued-key cap keyed by the salted submission IP hash. Requester details are visible only through the Access-gated `ops.pharos.watch/admin-api/` UI and the admin endpoints it calls.

---

## HTTP Request Handling

### Method Routing

| Method    | Handling                                                                                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPTIONS` | Returns 204 with CORS headers (preflight)                                                                                                                                                                                                                   |
| `POST`    | `/api/feedback`, `/api/api-key-requests`, `/api/api-key-requests/verify`, `/api/telegram-webhook`, `/api/telegram-mini-app/session`, `/api/telegram-mini-app/mutate`, and mutating admin endpoints from `shared/lib/api-endpoints/`                         |
| `GET`     | Read endpoints + admin debug routes; mutating admin routes return 405 except dry-run previews such as `/api/audit-depeg-history?dry-run=true` and `/api/backfill-dews?repair=...&dry-run=true`, plus the read-only `GET /api/backfill-dews` backtest        |
| Other     | Known endpoint families with disallowed methods return 405 `{ error: "Method not allowed" }` with `Allow`; unregistered public `/api/*` paths can return auth errors first, then 404 after lane auth succeeds because no route dependencies can be hydrated |

Method/path flags (`mutatingAdmin`, `cacheBypass`, probe groups, status actions) are centralized in the folderized `shared/lib/api-endpoints/` module surface and consumed by both worker and frontend status tooling.

### Public API Auth and Rate Limiting

- `worker/src/handlers/http/gates.ts` checks the request lane in this order: `ops-api` Access auth, `site-api` shared-secret auth, then public `/api/*` key auth or explicit public exemptions.
- Registered admin `/api/*` paths and configured admin-like root families are denied on the public lane before public API-key auth or exemption handling. This includes malformed children of configured roots such as `/api/api-keys/*` and `/api/api-key-requests-admin/*`; valid Access-authenticated `ops-api.pharos.watch` admin requests keep their normal route behavior.
- Public `/api/*` routes accept `X-API-Key` tokens in the format `ph_live_<16 hex prefix>_<32 char base64url secret>`.
- Valid keys are verified from the D1-backed `api_keys` table using `key_prefix` lookup plus an HMAC-SHA256 secret hash with `API_KEY_HASH_PEPPER`.
- Valid keyed requests use the D1-backed `api_key_rate_limit` table with the per-key threshold stored in `api_keys.rate_limit_per_minute` (default `120/min`, self-serve `30/min`).
- Protected cacheable `GET` edge-cache hits can use a narrow fast path when the key was recently verified in the same isolate and is not self-serve. That path still validates the presented token against the bounded fresh auth cache and applies the bounded isolate-local limiter before serving the cached response. Cold keys, self-serve keys, expired auth-cache entries, edge-cache misses, cache-bypass routes, and non-`GET` requests keep the normal D1-backed auth and limiter path. After repeated D1 limiter failures, a 60-second isolate-local circuit opens only for protected cacheable reads and caps the fallback quota at the self-serve default; non-cacheable requests continue to fail closed with `503`.
- Requests already authorized for the `ops-api.pharos.watch` admin lane bypass the per-key limiter.
- `/api/api-key-requests` and `/api/api-key-requests/verify` are exempt from `X-API-Key`, return no-store responses, and have their own request/verification throttles in `api_key_request_rate_limit_v2`; successful issuance is additionally capped through `api_key_self_serve_issuance_limits`.
- `/api/telegram-webhook` is exempt from the gate because Telegram authenticates separately with `X-Telegram-Bot-Api-Secret-Token`.
- `/api/telegram-mini-app/session` and `/api/telegram-mini-app/mutate` are exempt from the public API-key gate because the Worker validates Telegram Mini App `initData`; they deny the site-data lane and return no-store responses.
- `site-api.pharos.watch` accepts only `GET` requests to allowlisted public-read paths and requires `X-Pharos-Site-Proxy-Secret`.
- Website-only browser reads such as `public-status-history` and `telegram-pulse` must use same-origin `/_site-data/*`, which in turn proxies to the `site-api` lane.

### Request Attribution

- Worker-side request attribution now writes minute-bucketed worker load into `api_request_consumer_stats`
- Valid protected `public-api` requests authenticated with API keys also write minute-bucketed per-key load into `api_key_request_stats`
- Pages `functions/_site-data/[[path]].ts` writes same-origin site demand into `site_data_request_stats`
- Low-value route/source attribution writes can be paused with `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true`
- Per-key public API load writes can be paused separately with `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true`
- Worker route/source, Worker per-key, and Pages site-data counters are buffered briefly in isolate-local minute buckets and flushed through D1 batches, so bursts against the same route/source or key dimension collapse into one weighted counter upsert
- both datasets are scoped to non-admin public-read traffic and exclude `/api/telegram-webhook`
- worker load is stored by:
  - `lane`: `public-api` or `site-api`
  - `consumer_class`: `site` or `external`
- keyed load is stored by:
  - `api_key_id`
  - `bucket_start`
- site demand on the public API host is recognized from:
  - `api_keys.traffic_class = 'site'` for authenticated requests
  - or browser evidence (`Origin` / `Referer` matching `https://pharos.watch`, or the frontend `Accept` marker with `Sec-Fetch-Site: same-site|same-origin`)
- Pages demand records delivery-path outcomes separately:
  - `pages-cache-hit`
  - `pages-upstream-fetch`
  - `pages-upstream-timeout`
  - `pages-upstream-error`
- this lets `/api/request-source-stats` report total site-vs-external demand while still surfacing actual worker pressure on `public-api` vs `site-api`
- the same endpoint also exposes keyed public-API summaries plus the top per-key load rows used by the `/admin/` reliability table
- retention is pruned opportunistically to the latest `35` days
- operators read the aggregate split through `GET /api/request-source-stats` on `ops-api.pharos.watch`

The kill switches are for observability degradation only. They do not disable API-key auth, D1-backed quota enforcement, public self-serve request throttles, feedback throttles, admin audit logs, or Telegram security checks. Per-key `api_key_request_stats` remain enabled when Worker route/source attribution is disabled so operators can still see keyed public API load driving limiter pressure. Setting `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true` disables only those per-key stats rows and should be reserved for public API spikes where D1 pressure is already visible elsewhere.

### Append-only D1 Retention Policy

The daily `prune-cron-history` job owns bounded cleanup for cron observability, quota, cache, canary, job-attempt, and repair-task rows only. These append-only product/audit tables are intentionally not pruned by that job:

| Table                  | Retention owner ruling                           | Why                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily_digest`         | Product archive - keep forever                   | Digest detail pages, archive rows, recent-copy context, cross-day trends, and the total-mcap ATH collector read historical `input_data`. Do not add age-based pruning unless ATH and archive dependencies are materialized or an explicit output change is accepted. |
| `admin_action_audit`   | Operator audit archive - keep forever            | Admin mutations need a durable operator audit trail.                                                                                                                                                                                                                 |
| `api_key_audit_log`    | API-key audit archive - keep forever             | API key create/update/deactivate/rotate events need a durable credential lifecycle audit trail.                                                                                                                                                                      |
| `tape_events`          | Product timeline archive - keep forever          | `/timeline/` all-time filters, permalinks, homepage event reads, and DDRR review evidence depend on historical projected events.                                                                                                                                     |
| `status_transitions`   | Operational incident archive - keep forever      | Public and admin status endpoints window their reads with query bounds instead of deleting the incident timeline.                                                                                                                                                    |
| `depeg_backfill_runs`  | Backfill audit archive - keep forever            | Replay manifests preserve repair provenance, expected fingerprints, and incomplete-run evidence for historical depeg repairs.                                                                                                                                        |
| `report_card_evidence_journal` | Bounded diagnostic provenance - 45 days and 32 rows per asset | Reserve attempt/admission/fallback records are immutable and content-addressed, but the store prunes them on each append. Exact V9 fixed inputs retain only the latest two records per asset; neither the table nor its fixed-input projection participates in scoring or public responses. |
| `safety_score_v9_supply_attribution_journal` | Bounded diagnostic provenance - 45 days and 32 rows per asset | Reviewed-deployment supply attempts record immutable accepted/rejected and aggregate-only fallback outcomes without RPC URLs, payloads, or raw errors. The current post-publication attempt is appended after loading prior evidence, so only the latest two prior rows can enter the next private V9 fixed input; scoring and public responses ignore the projection. |

### Completed D1 Schema Cleanup

The 2026-07-29 operated D1 cleanup removed stale migration-era tables from production after Time Travel verification and fresh zero-use source searches. Historical migration files still define or reference these objects for lineage and fresh-database replay until the next accepted baseline squash, but current production D1 no longer has:

| Removed production object | Current runtime path |
| --- | --- |
| `public_api_rate_limit` | Cloudflare zone rule `api-rate-limit-ip` plus keyed `api_key_rate_limit` |
| `api_request_source_stats` | `api_request_consumer_stats` and `api_key_request_stats` |
| `api_key_request_rate_limit` | `api_key_request_rate_limit_v2` |
| `feedback_submissions` | GitHub issue creation plus `feedback_rate_limit`; there is no durable submission persistence today |
| `alert_broker_conditions`, `alert_broker_deliveries` | Direct-webhook compatibility canary transport was removed; scheduled incident detection continues through cron/status telemetry |

Do not use a normal migration for destructive cleanup. Future stale-table removals still require production backup/Time Travel verification, fresh zero-use evidence, and a dedicated operated rollout after compatible Worker code has soaked.

### CORS Headers

Applied to every response via `addCorsHeaders()`:

| Header                          | Value                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Access-Control-Allow-Origin`   | matching request origin from the `CORS_ORIGIN` allowlist; omitted for foreign origins; first configured origin when the request has no `Origin` |
| `Vary`                          | `Origin`                                                                                                                                        |
| `Access-Control-Allow-Methods`  | `GET, POST, OPTIONS`                                                                                                                            |
| `Access-Control-Allow-Headers`  | `Content-Type, Idempotency-Key, X-API-Key, X-Pharos-Admin`                                                                                      |
| `Access-Control-Expose-Headers` | `X-Data-Age, Warning, Retry-After`                                                                                                              |
| `Access-Control-Max-Age`        | `86400`                                                                                                                                         |
| `X-Content-Type-Options`        | `nosniff`                                                                                                                                       |
| `Strict-Transport-Security`     | `max-age=31536000; includeSubDomains`                                                                                                           |
| `Referrer-Policy`               | `strict-origin-when-cross-origin`                                                                                                               |
| `Content-Security-Policy`       | `default-src 'none'; frame-ancestors 'none'`                                                                                                    |

`CORS_ORIGIN` is now treated as a comma-separated allowlist. If the incoming request includes an `Origin` header that matches one of the configured entries, the Worker echoes that specific origin. If the request includes a foreign `Origin`, the worker omits `Access-Control-Allow-Origin` and rejects `OPTIONS` preflights with `403`. Requests without an `Origin` header keep the existing first-allowlisted-origin fallback.

### Edge Cache Strategy

The Worker uses `caches.default` (Cloudflare's per-colo edge cache) to cache GET responses:

1. **Cache bypass rules**:
   - All non-GET requests bypass edge cache.
   - GET paths marked `cacheBypass: true` in `shared/lib/api-endpoints/` bypass edge cache (status and admin/backfill endpoints like `/api/backfill-*`, `/api/audit-depeg-history`, `/api/backfill-dews`, including their dry-run preview variants, plus activation-gated public endpoints such as `/api/report-cards/v9`).

2. **Cache check:** `caches.default.match(cacheKey)` — returns cached response if available

3. **Cache store:** `ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(...))` — successful cacheable responses are cloned **without** CORS headers before caching. CORS headers are added per-request after cache lookup to avoid caching origin-specific headers. The Worker skips edge-cache writes for responses whose `Cache-Control` contains `no-store`, `no-cache`, or `private`; those responses are intentionally not persisted in `caches.default`.

4. **Cache-Control profiles** (centralized in `shared/lib/api-cache-profiles.ts`; set by individual API handlers, with a small number of route-local special cases):

| Profile            | `Cache-Control` header                                         | Used by                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime           | `public, s-maxage=60, max-age=10`                              | health, events                                                                                                                                                                                              |
| Producer-backed    | `public, s-maxage=300, max-age=60, stale-while-revalidate=300` | stablecoins, stablecoin-summary, blacklist, blacklist-summary, depeg-events, peg-summary, mint-burn-events, chains                                                                                          |
| Per-coin           | `public, s-maxage=300, max-age=10`                             | stablecoin detail (`/api/stablecoin/:id`)                                                                                                                                                                   |
| Standard           | `public, s-maxage=300, max-age=60`                             | stablecoin-charts, redemption-backstops, usds-status, daily-digest, digest-archive, report-cards, report-cards-v9 (handler response only; endpoint bypasses edge cache to revalidate activation), stability-index, yield-rankings, mint-burn-flows, stress-signals, yield-adapter-manifest |
| Custom             | `public, s-maxage=300, max-age=300`                            | dex-liquidity; telegram-pulse uses route-local `public, max-age=300, s-maxage=300`                                                                                                                          |
| Slow               | `public, s-maxage=3600, max-age=300`                           | supply-history, bluechip-ratings, dex-liquidity-history, yield-history, safety-score-history, non-usd-share                                                                                                 |
| Archive            | `public, s-maxage=86400, max-age=3600`                         | digest-snapshot, snapshots-index                                                                                                                                                                            |
| Public status      | `public, max-age=60`                                           | public status history                                                                                                                                                                                       |
| OG image           | `public, max-age=900, s-maxage=900`                            | dynamic Worker OG images (`/api/og/*`)                                                                                                                                                                      |
| Reserve live       | `public, s-maxage=3600, max-age=300`                           | `/api/stablecoin-reserves/:id` when live reserve rows are fresh enough for the requested presentation mode                                                                                                  |
| Reserve live stale | `public, s-maxage=1800, max-age=120`                           | `/api/stablecoin-reserves/:id` when live reserve rows are stale but still usable for stale presentation                                                                                                     |
| Reserve fallback   | `public, s-maxage=300, max-age=60`                             | `/api/stablecoin-reserves/:id` fallback/static presentation mode                                                                                                                                            |
| No-store           | `no-store`                                                     | admin GETs, bypassed status/control routes, held V9 publications, and per-coin stale fallback responses                                                                                                     |
| Immutable snapshot | `public, s-maxage=31536000, max-age=31536000, immutable`       | route-local dated public snapshot payloads and per-stablecoin projections (`/api/snapshots/:date.json`, `/api/snapshot/:date/stablecoin/:id`)                                                               |

The top-level `fetch` and `scheduled` handlers load their dispatchers lazily. The HTTP route catalog keeps only endpoint metadata and loader closures eager, then initializes an API implementation module only when its endpoint is invoked; scheduled slots likewise load only their selected runner. This prevents unrelated HTTP and cron object graphs from being retained in a fresh isolate. `worker/src/routes/__tests__/lazy-route-loading.test.ts` enforces these import boundaries.

Admin `GET` routes are forced to `Cache-Control: no-store` either by `addAdminGetNoStoreHeader()` in `worker/src/router.ts` for registry-dispatched routes or by the admin route wrapper for dynamic admin handlers.

### D1 Read Snapshots And Pagination

- The retired unversioned `GET /api/report-cards` route is not registered. Runtime safety reads use only `GET /api/report-cards/v9`.
- `GET /api/report-cards/v9` is the canonical Safety Score contract backed by `cache["report-cards:v9"]` and `cache["report-cards:v9:publication-health"]`. The reader validates and projects the accepted evaluator publication into the owned public schema with complete model, policy, build, base-input, publication identity, and matching health. Missing, malformed, incomplete, or mismatched state returns `503`; the route never falls back to V8 or recomputes a score. While held it serves the last accepted snapshot with `X-Safety-Score-Status: held`, accepted-timestamp freshness headers, and `Cache-Control: no-store`.
- `GET /api/yield-rankings` hydrates Safety Score fields from the same published report-card envelope, using compute-on-read only when the published snapshot cannot be loaded. The hourly publisher stages a yield publication generation, validates the rankings payload, and publishes the `yield-rankings` cache through CAS before replacing current `yield_data` rows. If the cache write fails or CAS skips because a newer cache exists, the prior published D1 rows remain visible to downstream readers; successful cache writes then persist current/history rows and compact selected-source decisions as `published` for that generation.
- `GET /api/stablecoin/:id` serves D1 detail rows from the per-coin cache. Rows inside the 5-minute TTL use the per-coin cache profile. Rows older than the TTL but under the 24-hour max-stale ceiling are served immediately with `Warning: 110`, `X-Data-Age`, and `Cache-Control: no-store`, then refreshed through an isolate-local per-coin single-flight background refresh. Rows older than 24 hours force a synchronous refresh path and are not used as stale fallback when refresh fails.
- Event feeds support bounded offset pagination plus opaque keyset cursors. `/api/depeg-events` caps `offset` at `50,000`; `/api/mint-burn-events` and `/api/blacklist` cap `offset` at `25,000`. Blacklist exact totals are opt-in; other feeds accept `includeTotal=false` to skip exact count queries. Inexact responses mark `totalExact: false`.

### External API Monitoring Baseline

When public API usage grows, monitor these three Cloudflare dimensions first:

1. **Per-endpoint request volume**
   - Track top paths by requests and trend (`/api/stablecoin/:id`, `/api/stablecoin-summary/:id`, `/api/stablecoins`, `/api/report-cards/v9`).
   - Alert on sudden spikes (for example, >2x 24h baseline).
2. **Per-endpoint cache performance**
   - Track `CF-Cache-Status` mix (HIT vs MISS/BYPASS) and overall cache-hit ratio by path.
   - Investigate if heavy endpoints drift toward MISS-heavy traffic.
3. **Per-endpoint error rate**
   - Track 5xx rate by path (especially `502`/`503`), not just global error rate.
   - Alert when 5xx ratio breaches your SLO target (for example, >1% for 5 minutes).

This baseline is enough to catch most abuse, regression, or cache-efficiency problems early.

### Admin Auth

**File:** `worker/src/lib/auth.ts`

- Accepts only the `ops-api.pharos.watch` lane after Cloudflare Access has authenticated the caller and injected `Cf-Access-Jwt-Assertion`
- Internal worker-origin admin calls (for example `status-self-check`) simulate that same lane instead of using a shared secret
- `hasValidAdminCredential()` returns a boolean. `requireAdmin()` returns `null` when authorized or a 401 `Response` when unauthorized.
- The worker verifies `Cf-Access-Jwt-Assertion` against `CF_ACCESS_OPS_API_AUD` using the team-domain JWKS and enforces JWT claims including `aud`, `exp`, and `iss`.
- Cloudflare Access must still stay in front of `ops-api.pharos.watch`, because the worker does not authenticate callers independently of that Access layer.

### Site-Data Auth

**Files:** `functions/_site-data/[[path]].ts`, `worker/src/lib/auth.ts`, `worker/src/handlers/http/gates.ts`

- Pages Functions proxy same-origin `/_site-data/*` requests only to the exact HTTPS `SITE_API_ORIGIN=https://site-api.pharos.watch`; missing, malformed, non-HTTPS, or foreign origins return `500` before `SITE_API_SHARED_SECRET` is attached. The selector-snapshot Pages Function uses the same trusted origin and secret to recompute new share artifacts from canonical API responses. The lane gates caller `Origin` / `Referer`, forwards upstream cache-age headers without a second Pages cache lifetime, and consumes bounded bodies inside the request deadline.
- the proxy injects `X-Pharos-Site-Proxy-Secret` from `SITE_API_SHARED_SECRET` and continues to emit only the current secret during rotations
- the worker accepts that header only on `site-api.pharos.watch` or Worker preview URLs during CI rehearsal; it accepts either `SITE_API_SHARED_SECRET` or `SITE_API_SHARED_SECRET_PREVIOUS` while both are configured
- the worker allows only `GET` requests to allowlisted public-read routes from `shared/lib/site-data-lane.ts`
- site-data requests skip public API request-source telemetry so the public API attribution dataset stays scoped to `api.pharos.watch`
- overlap sequence: set `SITE_API_SHARED_SECRET_PREVIOUS` to the retiring value, deploy the new current secret everywhere that emits `X-Pharos-Site-Proxy-Secret`, keep both values active for 24 hours as operator policy, then remove `SITE_API_SHARED_SECRET_PREVIOUS`

### Router-Dispatched Status Actions

Operator admin actions are dispatched through `worker/src/router.ts` using shared endpoint definitions from `shared/lib/api-endpoints/` and worker action handlers under `worker/src/api/admin-actions.ts`. Examples:

| Endpoint                         | Auth                                         | Description                                                                                      |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /api/trigger-digest`       | `ops-api` + Access user/JWT or service token | Queues a leased background digest run with `force=true`, then returns `202 Accepted` immediately |
| `POST /api/reset-blacklist-sync` | `ops-api` + Access user/JWT or service token | Rolls back sync state: EVM −50,000 blocks, Tron −7 days                                          |
| `GET /api/debug-sync-state`      | `ops-api` + Access user/JWT or service token | Returns all `blacklist_sync_state` rows                                                          |

Additional backfill/audit actions are defined in the same registry and surfaced dynamically on `/admin/`. `POST /api/feedback` is router-dispatched too, but it is not part of the status action registry.

Every endpoint with `statusPageAction` metadata is audited at the shared router boundary after its handler returns, including read-only inspections and dry-run previews. The canonical row records only definition-owned action/path/scope metadata, the configured target query parameter (or `batch` / `invalid-target`), HTTP/result status, execution certainty, dry-run/live/inspect mode, and a SHA-256 idempotency identity. It never records request bodies, arbitrary query parameters, auth headers, raw responses, or plaintext tokens. Browser actions use only the normalized email injected from the signature-verified Pages Access JWT; caller-supplied actor headers are not forwarded. A nullable unique `(action, intent_key)` index keeps one row per keyed intent: replay responses insert only when the first audit is missing, while the non-replay original response authoritatively replaces an earlier replay placeholder. If canonical persistence fails, the router returns `503 audit_persistence_failed` while preserving replay metadata; a same-key retry replays the stored action result and backfills the audit without rerunning the effect. A catalog handler that needs richer handler-specific details must set `statusPageAction.auditMode = "handler"` and write its single audit row itself; the canonical router then opts out.

### Idempotent Admin Actions

**File:** `worker/src/lib/idempotency.ts`

These router-dispatched admin routes honor an optional `Idempotency-Key` header:

- `POST /api/backfill-depegs`
- `POST /api/backfill-supply-history`
- `POST /api/backfill-stability-index`
- `POST /api/backfill-cg-prices`
- `POST /api/backfill-yield-history`
- `POST /api/backfill-mint-burn-prices`
- `POST /api/backfill-mint-burn`
- `POST /api/backfill-tape`
- `POST /api/reclassify-atomic-roundtrips`
- `POST /api/backfill-dews`
- `POST /api/audit-depeg-history`
- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `POST /api/remediate-blacklist-amount-gaps`
- `POST /api/backfill-blacklist-current-balances`
- `POST /api/reset-cron-lease`
- `POST /api/reset-circuit-breaker`
- `POST /api/kill-cron-in-flight`
- `POST /api/api-keys`
- `POST /api/api-keys/:id/update`
- `POST /api/api-keys/:id/deactivate`
- `POST /api/api-keys/:id/rotate`
- `POST /api/telegram-pending`
- `POST /api/admin-telegram-resend`
- `POST /api/admin-telegram-broadcast`

API-key create/rotate use the sensitive-response replay mode: the first successful response returns the one-time plaintext token, while the idempotency row and every replay retain only allowlisted public key identity plus `tokenUnavailableOnReplay` recovery guidance. Redaction failure is fail-closed as `execution_unknown`; plaintext tokens are never persisted for replay.

The worker fingerprints method + path + sorted query + body for a given action key. Replays return the stored response with `X-Idempotent-Replay: true`; conflicting reuse returns `409` with `X-Idempotency-Conflict: request-mismatch` and cannot replace the original intent's audit. Reservations have an owner/generation and a separate durable execution-start transition. A stale reservation may be taken over only while execution has not started. Once execution-start is durable, terminal writes are owner/generation compare-and-swap operations and automatic takeover is prohibited: a thrown handler, an explicit unknown-certainty response, or any handler HTTP 5xx returns `503` with `error = "execution_unknown"` plus `X-Execution-Certainty: unknown`. Later requests with that key replay the same operator-reconciliation state without running the mutation again. This deliberately prefers at-most-once behavior for irreversible effects; operators must inspect the action's audit/downstream state before choosing a new key or manual repair.

### Backfill Query Helper

**File:** `worker/src/lib/backfill-query.ts`

Backfill handlers reuse shared parsing/selection helpers for `stablecoin`, `batch`, and `batchSize` query params:

- `selectBackfillCoins(...)` resolves single-coin mode (`?stablecoin=<id>`) vs batched mode (`?batch=<n>[&batchSize=<n>]`) with bounded integer parsing.
- `noCoinsInBatchResponse()` returns the canonical no-op payload `{ "message": "No coins in this batch" }`.

Current consumers:

- `worker/src/api/backfill-cg-prices.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/backfill-depegs.ts`

### Isolate-Local State Registry

<!-- ISOLATE-LOCAL-STATE:START -->
This generated inventory covers mutable module state that can survive more than one request in a Worker or Pages Functions isolate. The registry is `shared/lib/isolate-local-state-registry.ts`; its completeness test rejects new unregistered state.

| Source | State | Owner | TTL / reset semantics | Durable truth |
| --- | --- | --- | --- | --- |
| `functions/lib/client-ip-hash.ts` | `cachedSecret`<br>`cachedKey` | Pages client-IP hashing | Replaced when the supplied secret changes; otherwise resets on isolate recycle or deploy. | The runtime secret is authoritative; the non-extractable imported key is only a derived cache. |
| `functions/lib/request-attribution.ts` | `siteDataRequestRecorder` | Pages site-data attribution | Batches up to 50 entries after a 10ms delay; prune coordination is hourly and all state resets with the isolate. | D1 site_data_request_stats rows are authoritative. |
| `functions/selector-snapshot/[[path]].ts` | `postTimestampsByIpHash` | Selector snapshot POST limiter | 60-second sliding window, 10 requests per IP hash, capped at 5,000 tracked hashes; resets with the isolate. | The D1 daily quota reservation is authoritative; this is a best-effort local throttle. |
| `shared/lib/cloudflare-access-jwt.ts` | `jwksCache` | Cloudflare Access JWT verification | One-hour TTL per Access team domain; resets with the isolate. | The Cloudflare Access JWKS endpoint and each presented JWT remain authoritative. |
| `shared/lib/format.ts` | `decimalFormatterCache` | Shared decimal formatting | One Intl.NumberFormat per requested digit-range pair until isolate recycle. | Formatting inputs and locale options are authoritative; cached formatters carry no business state. |
| `shared/lib/safety-score-v9/compile.ts` | `validatedCompiledFactSets` | Safety Score V9 fact compilation | Weak object-identity marker; entries are garbage-collectable and disappear on isolate recycle. | Validated fact-set input and its digest are authoritative; the marker only proves local compilation. |
| `shared/lib/safety-score-v9/policy.ts` | `validatedPolicyEnvelopes` | Safety Score V9 policy validation | Weak object-identity marker; entries are garbage-collectable and disappear on isolate recycle. | The validated policy envelope and digest are authoritative; the marker only proves local validation. |
| `worker/src/api/og.tsx` | `wasmInitialization` | OG-image WASM initialization | One shared initialization promise per isolate; cleared after an initialization failure or isolate recycle. | The bundled WASM modules are authoritative; the promise only coalesces initialization work. |
| `worker/src/api/stablecoin-detail.ts` | `detailRefreshesInFlight` | Stablecoin-detail refresh | One promise per detail cache key until it settles, then deleted; resets with the isolate. | D1 detail cache rows and circuit-breaker state are authoritative across isolates. |
| `worker/src/cron/depeg-resolver/utils.ts` | `v9DependencyImpairmentByCoin` | Depeg resolver V9 dependency projection | Hydrated from the current V9 cards at resolver-run start; cleared when V9 publication is unavailable and resets with the isolate. | The current Safety Score V9 publication inputs and stablecoin registry statuses are authoritative; this only avoids repeated per-coin dependency scans inside one run. |
| `worker/src/cron/telegram-quiet-hours.ts` | `quietHoursTzFallbackLastLoggedAt` | Telegram quiet-hours telemetry | One fallback-log timestamp per timezone with a one-hour suppression window; resets with the isolate. | Runtime timezone resolution is authoritative; this state only suppresses duplicate logs. |
| `worker/src/handlers/http/gates.ts` | `LOGGED_ENV_ISSUES` | Worker environment validation | One logged entry per finite environment-contract issue code until isolate recycle. | The current Env bindings and validateWorkerEnvContract() result are authoritative. |
| `worker/src/lib/api-cache-read.ts` | `_cacheRead` | Persisted-cache JSON diagnostics | At most 256 LRU parse-failure contexts; resets with the isolate. | The D1 cache payload is authoritative; counters are diagnostic only. |
| `worker/src/lib/api-key-core.ts` | `_ak` | API-key authentication and fallback limiting | Key lookups are fresh for 5 seconds (2,048 entries); usage and fallback limiter maps cap at 4,096 entries, with prune and dependency-circuit coordination resetting with the isolate. | D1 API-key, rate-limit, and last-used rows are authoritative; local fallback limiting is emergency-only. |
| `worker/src/lib/auth.ts` | `timingSafeCompareKeyPromise` | Timing-safe comparison | One non-extractable HMAC key per isolate, regenerated after isolate recycle. | The compared request values remain authoritative; the key is only a local comparison primitive. |
| `worker/src/lib/circuit-breaker.ts` | `circuitRecordCacheByDb` | Provider circuit breaker | Weakly keyed by D1 binding; records have a 5-second memo TTL and reset with the isolate. | D1 cache circuit records are authoritative. |
| `worker/src/lib/cron-logger.ts` | `cronFailureCounts` | Cron failure logging | One in-memory count per job until isolate recycle. | cron_runs and durable cron-event records are authoritative; counts only tune log severity. |
| `worker/src/lib/fx-rate-state.ts` | `_fxCalendar` | FX business-day calendar | Caches computed closing-day sets by year until isolate recycle. | Deterministic calendar rules and current FX cache rows are authoritative. |
| `worker/src/lib/rate-limit.ts` | `_rl` | Feedback rate-limit cleanup | Tracks one pending prune promise and consecutive prune failures until completion or isolate recycle. | Atomic D1 feedback_rate_limit reservations are authoritative. |
| `worker/src/lib/request-source-attribution.ts` | `workerRequestRecorder`<br>`apiKeyRequestRecorder` | Worker request attribution | Each recorder batches up to 50 entries after a 10ms delay; prune coordination is hourly and all state resets with the isolate. | D1 api_request_consumer_stats and api_key_request_stats rows are authoritative. |
| `worker/src/lib/safety-score-v9-fact-set.ts` | `materializedExtensions` | Safety Score V9 extension materialization | Weak object-identity marker; entries are garbage-collectable and disappear on isolate recycle. | Schema-validated extension input is authoritative; the marker only records local materialization. |
| `worker/src/lib/status-reliability-shared.ts` | `LOGGED_STATUS_PERSISTENCE_FAILURES` | Status persistence logging | Capped at 200 code-operation keys and resets with the isolate. | D1 status state, transitions, and probe rows are authoritative; this is log-noise suppression only. |
| `worker/src/lib/telegram-log.ts` | `invalidSecretWindowStartedAt`<br>`invalidSecretWindowCount`<br>`missingSecretWindowStartedAt`<br>`missingSecretWindowCount` | Telegram webhook secret telemetry | Two secret-attempt windows reset after SECRET_AUTH_SPIKE_WINDOW_MS or isolate recycle. | Webhook authentication is evaluated from current request and Env secrets; counters only sample logs. |
| `worker/src/lib/telegram-mini-app-auth.ts` | `warnedNovelMiniAppChatTypes` | Telegram Mini App auth telemetry | One warning per novel chat_type until isolate recycle. | Signed Telegram initData and current request fields are authoritative; this only suppresses duplicate logs. |

All entries are isolate-local: they are not shared across isolates and reset on a cold start, deployment, or isolate recycle. They are optimization, local-coordination, or diagnostic aids only; durable correctness must come from D1, request inputs, configured bindings, or upstream provider responses.
<!-- ISOLATE-LOCAL-STATE:END -->

---

## Cron Scheduling

Fetch-heavy lanes are split across the expressions in `worker/wrangler.toml` so they do not compete with the quarter-hourly core pipeline for Pharos's conservative six-connection-per-invocation fetch budget or share CPU budget with DB-only availability jobs. The DEX source and publication lanes retain logical half-hour cadences but deploy as paired hourly physical expressions (`10` + `40`, and `16` + `46`). Cloudflare assigns CPU class per Cron Trigger interval, so this shape preserves the existing slot cadence while avoiding the 30-second sub-hour CPU ceiling; `[limits].cpu_ms = 300000` remains the repo cap. Any expression added near the trigger soft cap requires consolidation or an ADR-backed rebalance.

Cron expressions are source-owned in `worker/wrangler.toml`. The canonical logical schedule-key mapping, physical trigger aliases, status-tracked jobs, and connection-budget metadata live in `shared/lib/cron-jobs.ts`; dispatch chains live in `shared/lib/scheduled-runner-registry.ts`. `runScheduledSlotWithFence()` in `worker/src/lib/scheduled-slot-fence.ts` owns claim, heartbeat, takeover, and terminal ownership fencing. Stale child progress/lease cleanup, synthetic run persistence, attempt abandonment, and the operator event marker live behind the narrow `scheduled-slot-reconciliation.ts` internal stage. The fence stores compact child-job summaries in `cron_slot_executions.metadata` (`jobsRun`, `jobsSkipped`, `jobsNeutralSkipped`, `jobsDegraded`, `jobsErrored`, `budgetOnlyJobs`, and per-job outcomes) and marks the slot `degraded` or `error` when children skip/degrade/fail even if best-effort execution lets later jobs continue. Neutral expected no-op children, such as an idle `digestTriggerPoll` with no force-run request, are counted separately and never synthesize a missing `daily-digest` failure; durable started digest progress is still reconciled if its owner is abandoned. Run `npm run check:cron-sync` and `npm run check:cron-connections` after schedule or job-chain changes.

### Deployed Trigger Topology

Do not maintain a second schedule table in this document:

- `worker/wrangler.toml` owns deployed trigger expressions.
- `shared/lib/cron-jobs.ts` owns status-tracked job metadata and connection-budget entries.
- `shared/lib/scheduled-runner-registry.ts` owns expression-to-runner dispatch and serial/parallel stage topology.
- `npm run check:cron-sync` verifies schedule and dispatch parity; `npm run check:cron-connections` reports per-slot peak connection use.

Fetch-heavy work uses isolated or offset lanes so it does not compete with the quarter-hourly core pipeline. DB-only work may share a slot when ordering is explicit. Budget-only side work is modeled even when it is not a `/api/status` job. Reserve recovery remains independent of the reserve invocation it is intended to reconcile.

Safety Score V9 supply attribution uses its dedicated `+8` trigger. Exact V9 input preparation runs after successful `16,46` DEX publication in the same serial D1-only chain and is passed the published DEX generation ID; canonical compilation uses the later `22,52` trigger. The preparation step rejects a generation mismatch, while compilation fences the fixed input against the latest accepted DEX generation both before enrichment and immediately before evaluation. Since a distinct expression alone cannot prevent overlap in one Worker service, V9 lanes retain the D1-backed memory-lane lease: a prior active invocation of the same V9 schedule lane remains fail-closed, while unrelated scheduled slots cannot suppress canonical publication and later scheduled invocations wait at the lightweight dispatcher boundary before loading their runner graphs. Delayed or competing V9 work skips neutrally; a complete same-fixed-input supply-attribution generation that finished just after the scoring clock also defers neutrally instead of publishing an aggregate-only partial candidate. Producer due intervals are shortened below the consumer acceptance window so the 15-minute trigger grid captures healthy generations roughly every 30 minutes instead of drifting into a 45-minute beat; stale or identity-incompatible generations report clause-specific reasons in cron metadata. Missing Worker-version metadata degrades. The canonical compiler receives publication-exact peg provenance from the fixed-input producer's atomic D1 batch rather than reconstructing it from mutable event rows.

### Cron Slot Capacity and Connection Pool Budget

Cloudflare limits each invocation to six simultaneous outbound requests that are still waiting for response headers; a request releases that slot once headers arrive. Pharos deliberately models the stricter case as a trigger-wide **6-request budget**, so every job dispatched by one cron invocation competes inside the same static ceiling. See [Worker and API Limits](./worker-and-api-limits.md#connection-budget-operating-assumption).

`npm run check:cron-connections` reads `shared/lib/cron-jobs.ts` and sums peak `connectionGroup` usage, so sequential chains count by their maximum in-chain fetch width rather than by adding every chained job together.

Use `npm run check:cron-connections` for the live per-slot budget report. It includes the budget-only `telegram-digest-outbox-drain`, `digest-trigger-poll`, and Telegram registration reconciliation entries even though those surfaces do not create separate `/api/status` job rows.

The `sync-dex-liquidity-stage` direct API phase owns its circuit and timeout wrapper locally in `worker/src/cron/dex-liquidity/orchestrator-phases/direct-api.ts`. Protocol families run serially through `mapWithConcurrency(..., 1, ...)`, each completed result is immediately compacted to tracked pools and bounded source evidence before the next family starts, and circuit outcomes use the existing `circuit:<source>` breaker keys. Individual adapters retain their protocol-specific request/body policies. Consumed Curve response trees are also released before the scoring-stage generation is written. The static source-stage trigger declaration remains conservatively `5/6` and is enforced by `check:cron-connections` because one provider may still use its nested request width; the `sync-dex-liquidity` consumer is D1-only and shares the `16,46` slot serially with charts at `1/6`. Its generation-private publication rows stream through 15-row buffers packed as five three-row statements, reducing D1 work while preserving bounded memory, retry-idempotent replacement, and exact-generation publication fencing.

**Policy for new jobs:**

- Jobs requiring <=1 external connection may share any slot with headroom >=2.
- Jobs requiring >2 concurrent connections should get a dedicated trigger slot.
- Never add a fetching job to a slot with headroom <=1.

### Cron Error Handling Policy

Shared cron behavior is narrower than a single worker-wide tier system:

- `runLeasedCron(...)` / `logCronRun(...)` record terminal outcomes per canonical schedule/job/path and persist Worker version plus invocation identity.
- A weighted slot semaphore admits at most five live external fetches, including sidecars and budget-only work; heartbeats and ledger writes are serialized per job.
- Thrown or explicit error outcomes are recorded after terminal accounting and before rethrow.
- Degraded returns, no-write fallbacks, and producer-specific retries remain job-owned.
- Exact V9 input preparation is a neutral not-started child when its preceding DEX consumer throws, is locked, or intentionally withholds publication; an otherwise successful DEX result without an exact generation remains a fail-closed error.
- Sidecar publication returns a structured terminal outcome; failures cannot be swallowed behind a successful parent result.


## Telegram Alert Bot

- Webhook ingress (`POST /api/telegram-webhook`) receives Telegram commands and writes subscriber/subscription state into D1.
- `dispatch-telegram-alerts` diffs DEWS/depeg/safety state plus launch promotions against cached snapshots before fan-out on a dedicated 5-minute cron slot.
- `daily-digest` now appends pending cemetery additions and newly tracked coins to the next Telegram digest post after a deploy.
- Telegram delivery has a D1-authoritative transport circuit in `telegram_transport_circuit`. Authentication failures open immediately; server/network/timeout/unknown failures and chat-local 429s require the threshold across at least three distinct chats in a 60-second window. A due open circuit grants one generation-fenced owner a bounded one-to-four-distinct-chat half-open probe; concurrent claimants defer. Transport observations are pruned after five minutes and are never copied into general logs.
- Expiring operator pauses live in `telegram_delivery_pauses` with independent `fresh`, `pending`, and `admin` generations. Pause reads fail open only after expiry, resume is generation-fenced and audited, and webhook user replies are outside the admin-delivery pause.
- Each dispatch run sends up to 3,600 Telegram message attempts in parallel batches of 4 under a 14-minute hard timeout; pending-drain and fresh-send batches stop after a 4-minute soft deadline. Existing due rows drain before authoritative source-specific candidate capture and target planning. Candidate pages union relevant direct subscriptions, resolved preset targets, and global-family flags; capture and planning reuse page fan-out inputs only while preference generations match. Target pages pack complete idempotent plan units into bounded D1 transactions, then hand off bounded target pages with set-based suppression/enqueue/state changes and one grouped confirmation instead of per-target database loops. When a backlog exists, newly planned targets remain queued for the next five-minute run. Unattempted pending claims are released, and untouched fresh tails are queued. Overflow and retryable fresh-send failures are enqueued to claim-based `telegram_pending_alerts` rows for subsequent runs.
- Eventless dispatches always use the queue-only path: healthy source snapshots can seed directly, while an unavailable safety source preserves its last baseline. Neither case creates a source event or captures the subscriber cohort. Depeg worsening enters the durable fan-out path only after crossing a supported 100/250/500 bps subscriber threshold.
- The serialized personalized-recap sidecar defers when a tokened risk dispatch was locked, incomplete, or failed. Otherwise recap planning receives only the positive remainder of the five-minute shared slot after measured dispatch duration and a 30-second reserve; watchdog, cleanup, and pulse sidecars still run.
- The daily retention job removes terminal planning workflow rows after 24 hours; settled exact-replay bundles and terminal pre-authoritative targets after 14 days; expired source-less queued jobs and expired, completely unreferenced unresolved sources after 30 days; and ambiguous/audit evidence after 90 days. Active pending, claimed, sending, degraded, and `execution_unknown` evidence remains protected by the applicable recovery/audit policy. High-volume passes use 10,000-row SQL batches with a 100,000-row per-table run ceiling; target-item lineage, targets, jobs, sources, and plans are deleted in dependency order. High-growth telemetry reports cutoffs, oldest remaining/eligible timestamps, caps, duration, and an isolated family error that degrades the run without blocking unrelated retention passes.
- New queued risk rows persist source, conservative target-group scope, planning-time preference generation, and markup policy. The pending drain re-resolves current direct/preset/global/off/snooze eligibility, then generation-CASes the send transition so changed intent opens no Bot API request.
- Subscriber state now supports quiet hours plus per-subscription controls such as `dews_min_band`, `safety_mode`, and `depeg_worsening_bps_step`.

See [Telegram Alert Bot](./telegram-alerts.md) for command syntax, D1 tables, snapshot seeding behavior, and operational setup.

### Sub-Modules (not directly registered)

These files are called internally by `syncStablecoins()`, not registered as standalone cron jobs:

| File                                                      | Called from         | Documentation                           |
| --------------------------------------------------------- | ------------------- | --------------------------------------- |
| `worker/src/cron/detect-depegs.ts`                        | `syncStablecoins()` | [Depeg Detection](./depeg-detection.md) |
| `worker/src/cron/confirm-pending-depegs.ts`               | `syncStablecoins()` | [Depeg Detection](./depeg-detection.md) |
| `worker/src/cron/sync-stablecoins/enrich-prices.ts`       | `syncStablecoins()` | [Data Pipeline](./data-pipeline.md)     |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | `syncStablecoins()` | [Data Pipeline](./data-pipeline.md)     |

---

## logCronRun() Wrapper

**File:** `worker/src/lib/cron-logger.ts`

Every scheduled trigger now runs as one fenced slot in `worker/src/handlers/scheduled.ts`, keyed by shared schedule metadata plus the normalized scheduled timestamp. Inside that slot, each cron job is still wrapped with `runCronWithLease(...)` + `logCronRun(...)` via `runLeasedCron(...)` from the scheduled runtime context.

`await runScheduledSlotWithFence(db, scheduleKey, () => runner(runtime), { slotStartedAt })`

```typescript
async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
  options?: { slotStartedAt?: number | null },
): Promise<CronResult | void>;
```

**Behavior:**

- Records start time (Unix seconds)
- Records the normalized slot timestamp (`slot_started_at`) alongside per-job history/progress rows
- Exposes a `reportProgress(...)` callback; leased jobs now emit wrapper-owned milestones (`started`, `lease-acquired`, `completed`, timeout/skip states when applicable) before any cron-specific progress stages
- Executes the job function
- On normal completion: inserts row into `cron_runs` with `status = resolvedResult.status ?? "ok"`, `item_count`, and `metadata`; returned statuses such as `degraded`, `skipped_locked`, `skipped_neutral`, or `error` are preserved
- Assigns each append-only run insert an `idempotency_key`; the partial unique index makes an ambiguous committed D1 overload retry a no-op instead of duplicate telemetry
- If terminal `cron_runs` or producer-history persistence still fails after its bounded overload retries, logs the telemetry failure and returns the completed job result; an observability write cannot rewrite a fulfilled producer as failed or block dependent jobs
- On lease contention: inserts row with `status='skipped_locked'` and lease metadata
- When the job itself throws: inserts a terminal row and re-throws a typed aggregate through the slot fence
- On completion/error of a progress-reporting job: clears only the corresponding invocation's `cron_run_progress` row; an overlapping `skipped_locked` attempt cannot overwrite or delete progress backed by the active lease owner
- Returns the job's `CronResult` when the handler provides one
- Persisted cron metadata is compacted globally below 64 KiB; rich in-process results are not copied wholesale into `cron_runs`. The stablecoin producer applies its domain-aware compaction below 60 KiB, reserving 4 KiB for wrapper-owned lease and slot enrichment so publication and active-price coverage remain top-level health evidence.
- `worker_producer_history` and `worker_producer_heads` distinguish invocation completion from productive output and publication for every schedule/job/path/kind, including shared paths and budget-only surfaces. Calendar work keeps its UTC-month identity.
- History pruning is handled by the daily `prune-cron-history` job. It retains regular producer history for 30 days, budget-only history for 90 days, and calendar-keyed history for 550 days in addition to the existing cron/slot/attempt retention.

**Schema:** `cron_runs` includes schedule/path/kind, invocation/version, productivity, publication count, calendar identity, and the existing timing/status/error fields. Durable history lives in `worker_producer_history`, `worker_producer_heads`, `surface_publication_generations`, and `budget_surface_history`.

### In-flight Cron Progress

Long-running leased jobs can now surface active progress through `cron_run_progress`, which powers `/api/status` while the run is still live. Long-job heartbeats renew every 30 seconds and tolerate at most three consecutive renewal failures before the wrapper aborts controlled work. Progress UPSERTs preserve a row backed by another still-active lease, and terminal cleanup is fenced to the reporting invocation's start and slot identity. The status handler cross-checks that progress row against an active matching `cron_leases` entry before exposing it as `crons[*].inFlight`, so orphaned progress from a hard-killed invocation no longer masquerades as a live run. Suppressed orphaned progress rows and expired leases are exposed separately as `crons[*].staleArtifacts` plus summary counters.

`sync-stablecoins` now uses those cron-specific progress stages to expose its major pipeline boundaries (`intake`, `price-enrichment`, `price-enrichment-gt-probe-disabled`, `price-validation`, `staleness-check`, `cache-write`, `depeg-pipeline`, plus fallback equivalents) instead of remaining opaque for the full quarter-hourly wall-clock. The disabled GeckoTerminal milestone makes the intentional memory-boundary isolation explicit in production telemetry.

```sql
CREATE TABLE cron_run_progress (
  job TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  slot_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  stage TEXT,
  items_done INTEGER,
  items_total INTEGER,
  message TEXT,
  lease_owner TEXT,
  metadata TEXT
);
```

All leased jobs emit wrapper-owned progress milestones. Current producers with cron-specific detailed stages include:

- `sync-stablecoins`
- `sync-live-reserves`
- `sync-blacklist`
- `sync-mint-burn`
- `sync-mint-burn-extended`
- `sync-dex-discovery`
- `sync-dex-liquidity-stage`
- `sync-dex-liquidity`
- `sync-yield-data`
- `sync-yield-supplemental`
- `daily-digest`
- `weekly-recap`
- `dispatch-telegram-alerts`

### Per-Job Cron Timeouts

Each cron job receives an `AbortSignal` from `logCronRun()` that fires after a configurable timeout. Jobs that exceed their timeout are aborted and logged with `status='error'`. The signal is threaded through to `fetchWithRetry()` so that in-flight HTTP requests are also cancelled.

Some long-running jobs also enforce their own earlier wall-clock guard so they can return controlled metadata instead of hard-failing at the wrapper timeout. `sync-blacklist`, for example, self-stops scans after 10 minutes and avoids starting a new config when fewer than 60 seconds remain. Its unstarted tail is persisted as `budget_skipped`, always degrades the run, and is ordered ahead of recently attempted configs on the next due run. A separately capped amount-repair tail can start work until 10 minutes 45 seconds without changing the scan deadline; scan-exhausted runs admit at most 10 repair rows and reuse the same serial provider limiter and 900-subrequest budget. This targets 75 seconds of the 12-minute wrapper for persistence and telemetry, with the wrapper abort remaining authoritative if an already-started bounded provider call finishes late. `sync-live-reserves` keeps a 9-minute internal cursoring budget inside its 12-minute wrapper so deferred-tail state, cleanup, and cron logging have at least two minutes of headroom. `sync-mint-burn` and `sync-mint-burn-extended` keep a 9-minute self-budget inside their 10-minute wrapper timeout, pass that deadline into `eth_getLogs`, and skip the remaining config tail once fewer than 60 seconds remain for another config.

| Job                        | Timeout | Reason                                                                                                                                                                                                                 |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default                    | 5 min   | Standard jobs complete in <60s                                                                                                                                                                                         |
| `sync-stablecoins`         | 8 min   | Core quarter-hour pipeline entrypoint now includes N-source weighted primary pricing, supplemental overlays, multi-pass enrichment, and depeg processing; explicit headroom avoids timing out on bounded fallback work |
| `sync-dex-liquidity-stage` | 13 min  | External source loading and pool-graph construction, with headroom to persist the bounded generation                                                                                                                   |
| `sync-dex-liquidity`       | 13 min  | D1-only scoring, proof joins, and generation-fenced liquidity/price/history publication                                                                                                                                |
| `sync-dex-discovery`       | 13 min  | Multi-source pool staging with explicit 12-minute self-budget so the wrapper still has headroom to log a controlled degraded/error result                                                                              |
| `sync-blacklist`           | 12 min  | Multi-chain scan + balance enrichment; isolated trigger allows extended runtime                                                                                                                                        |
| `weekly-recap`             | 12 min  | Weekly Anthropic recap on the independent 08:10 Monday trigger                                                                                                                                                         |
| `sync-live-reserves`       | 12 min  | Multi-adapter reserve fetching with per-adapter timeouts                                                                                                                                                               |
| `sync-mint-burn`           | 10 min  | Multi-contract EVM log scan; isolated trigger allows extended runtime, with a 9-minute internal guard before the wrapper timeout                                                                                       |
| `sync-mint-burn-extended`  | 10 min  | Long-tail mint/burn lane with its own run-state and the same 9-minute internal guard                                                                                                                                   |
| `sync-yield-data`          | 10 min  | Multi-source yield data aggregation                                                                                                                                                                                    |
| `sync-yield-supplemental`  | 12 min  | Supplemental yield source sync; runs less frequently but covers more sources per invocation                                                                                                                            |
| `dispatch-telegram-alerts` | 4.5 min | Dedicated five-minute lane with a 4-minute send-loop soft deadline and 30 seconds for durable finalization; the shorter crash fence prevents an unabortable operation from suppressing several later slots             |
| `daily-digest`             | 14 min  | Expanded LLM generation + persistence/distribution, still below the 15-minute scheduled-trigger ceiling                                                                                                                |

Configuration: `CRON_TIMEOUT_MS` record in `worker/src/lib/cron-timeouts.ts`.

### Circuit Breakers

Most high-risk external integrations are protected by per-source circuit breakers (`worker/src/lib/circuit-breaker.ts`). State is persisted in the D1 `cache` table under keys like `circuit:defillama-stablecoins`. Breaker writes also maintain the aggregate `cache["provider:circuit:index"]` row as best-effort telemetry; individual `circuit:<source>` rows remain the execution and `/api/status.providerCircuitHealth` source of truth, and `/api/reset-circuit-breaker` removes both the source row and its index entry. Bounded low-volume fallbacks such as gold-api.com metal spot quotes, the secondary FX mirror, and ExchangeRate-API daily reference snapshots use explicit retry/timeout/cooldown behavior but are not currently circuit-gated.

- **Open threshold**: 3 consecutive failures
- **Probe interval**: 30 minutes (one request allowed to test recovery)
- **Health impact**: 3 or more public-impact open circuits degrade `/api/health`; scoped `live-reserves:*`, optional `dexscreener-liquidity` / `dexscreener-search`, and single-asset `kava-pricefeed`, `jusd-citrea-bridge`, and `aznd-curve-pool` breakers are excluded from that source-wide count. They remain in admin provider diagnostics, while reserve and exact active-price coverage own their public impact. The retired `mento-broker` and `usx-stable-pools` cache keys are no longer active sources and are filtered from Worker diagnostics.

Sources tracked (defined in `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`):

| Source key                           | Cache key                     | Used by                                                                                                                   |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `DL_STABLECOINS`                     | `defillama-stablecoins`       | `sync-stablecoins`                                                                                                        |
| `DL_STABLECOIN_DETAIL`               | `defillama-stablecoin-detail` | `GET /api/stablecoin/:id` (DefiLlama detail upstream)                                                                     |
| `DL_COINS`                           | `defillama-coins`             | `enrich-prices`, supplemental CoinGecko-id mirror pricing                                                                 |
| `DL_YIELDS`                          | `defillama-yields`            | `sync-yield-data`, `sync-dex-liquidity-stage`                                                                             |
| `DL_PROTOCOLS`                       | `defillama-protocols`         | `sync-dex-liquidity-stage`, supplemental gold protocol mcap/TVL fetches                                                   |
| `CG_PRICES`                          | `coingecko-prices`            | `enrich-prices`                                                                                                           |
| `CG_DETAIL_PLATFORMS`                | `coingecko-detail-platforms`  | `GET /api/stablecoin/:id` (CoinGecko-only detail provider)                                                                |
| `CG_MCAP`                            | `coingecko-mcap`              | `sync-stablecoins` (CG supply fallback)                                                                                   |
| `CG_ONCHAIN`                         | `coingecko-onchain`           | `enrich-prices` CoinGecko Pro onchain exact-address augmentation plus `dex-discovery` Stage 1 onchain pool crawl          |
| `CMC_PRICES`                         | `coinmarketcap-prices`        | `enrich-prices` pass 2 fallback                                                                                           |
| `DEXSCREENER_PRICES`                 | `dexscreener-prices`          | `enrich-prices` exact token-address DexScreener fallback                                                                  |
| `DEXSCREENER_LIQUIDITY`              | `dexscreener-liquidity`       | Optional DexScreener DEX liquidity/discovery pool lookups; excluded from public-impact breaker counts                     |
| `DEXSCREENER_SEARCH`                 | `dexscreener-search`          | Legacy `enrich-prices` addressless unique-symbol DexScreener search fallback; retired for new sync runs                   |
| `DEXSCREENER_ADDRESS_PRICES`         | `dexscreener-address-prices`  | `enrich-prices` targeted exact-address primary augmentation                                                               |
| `DEXPAPRIKA_PRICES`                  | `dexpaprika-prices`           | `enrich-prices` targeted exact-address primary augmentation                                                               |
| `ALCHEMY_PRICES`                     | `alchemy-prices`              | `enrich-prices` targeted exact-address primary augmentation                                                               |
| `MORALIS_PRICES`                     | `moralis-prices`              | `enrich-prices` targeted exact-address primary augmentation                                                               |
| `BIRDEYE_PRICES`                     | `birdeye-prices`              | `enrich-prices` targeted Solana exact-address primary augmentation                                                        |
| `TREASURY_RATES`                     | `treasury-rates`              | `fetch-tbill-rate`                                                                                                        |
| `ETHERSCAN`                          | `etherscan`                   | `sync-blacklist`                                                                                                          |
| `TRONGRID`                           | `trongrid`                    | `sync-blacklist` (Tron chains)                                                                                            |
| `ALCHEMY`                            | `alchemy`                     | `sync-mint-burn`                                                                                                          |
| `PYTH_PRICES`                        | `pyth-prices`                 | `enrich-prices` primary consensus                                                                                         |
| `BINANCE_PRICES`                     | `binance-prices`              | `enrich-prices` primary consensus                                                                                         |
| `KRAKEN_PRICES`                      | `kraken-prices`               | `enrich-prices` primary consensus                                                                                         |
| `BITSTAMP_PRICES`                    | `bitstamp-prices`             | `enrich-prices` primary consensus                                                                                         |
| `COINBASE_PRICES`                    | `coinbase-prices`             | `enrich-prices` primary consensus                                                                                         |
| `REDSTONE_PRICES`                    | `redstone-prices`             | `enrich-prices` primary consensus                                                                                         |
| `KAVA_PRICEFEED`                     | `kava-pricefeed`              | `enrich-prices` exact Kava USDX oracle route                                                                              |
| `JUSD_CITREA_BRIDGE`                 | `jusd-citrea-bridge`          | `enrich-prices` exact Citrea JUSD bridge route                                                                            |
| `AZND_CURVE_POOL`                    | `aznd-curve-pool`             | `enrich-prices` exact thin AZND Curve route                                                                               |
| `PROTOCOL_REDEEM`                    | `protocol-redeem`             | External live RPC-backed authoritative `protocol-redeem` overrides                                                        |
| `CURVE_ONCHAIN`                      | `curve-onchain`               | `enrich-prices` primary consensus                                                                                         |
| `CURVE_ORACLE`                       | `curve-oracle`                | `enrich-prices` crvUSD Curve oracle consensus                                                                             |
| `CURVE_LIQUIDITY_API`                | `curve-liquidity-api`         | `sync-dex-liquidity-stage` (Curve pool liquidity fetch)                                                                   |
| `FX_FRANKFURTER`                     | `fx-frankfurter`              | `sync-fx-rates` primary Frankfurter API circuit breaker                                                                   |
| `FX_REALTIME`                        | `fx-realtime`                 | `sync-fx-rates` real-time FX cross-validation                                                                             |
| `CHAINLINK_FEEDS`                    | `chainlink-feeds`             | `sync-fx-rates` Chainlink on-chain FX feed probes                                                                         |
| `JUPITER_PRICES`                     | `jupiter-prices`              | `enrich-prices` pass 3 Solana price fallback                                                                              |
| `GECKO_TERMINAL_PROBE`               | `geckoterminal-probe`         | `enrich-prices` GeckoTerminal price probe fallback                                                                        |
| `FLUID_DEX_API`                      | `fluid-dex-api`               | `sync-dex-liquidity-stage` direct Fluid DEX fetcher                                                                       |
| `BALANCER_API`                       | `balancer-api`                | `sync-dex-liquidity-stage` direct Balancer API fetcher                                                                    |
| `RAYDIUM_API`                        | `raydium-api`                 | `sync-dex-liquidity-stage` direct Raydium API fetcher                                                                     |
| `ORCA_API`                           | `orca-api`                    | `sync-dex-liquidity-stage` direct Orca API fetcher                                                                        |
| `METEORA_API`                        | `meteora-api`                 | `sync-dex-liquidity-stage` direct Meteora API fetcher                                                                     |
| `PANCAKESWAP_API`                    | `pancakeswap-api`             | `sync-dex-liquidity-stage` direct PancakeSwap V3 API fetcher                                                              |
| `AERODROME_SLIPSTREAM_API`           | `aerodrome-slipstream-api`    | `sync-dex-liquidity-stage` direct Aerodrome Slipstream fetcher                                                            |
| `VELODROME_SLIPSTREAM_API`           | `velodrome-slipstream-api`    | `sync-dex-liquidity-stage` direct Velodrome Slipstream fetcher                                                            |
| `CG_TICKER`                          | `coingecko-ticker`            | `enrich-prices` primary consensus (curated ticker corroboration)                                                          |
| `TWITTER_API`                        | `twitter-api`                 | Twitter helper (not wired into current scheduled digest delivery)                                                         |
| `TELEGRAM_API`                       | `telegram-api`                | `daily-digest` Telegram posting, `dispatch-telegram-alerts` subscriber fan-out                                            |
| `ANTHROPIC`                          | `anthropic-api`               | `daily-digest` LLM generation                                                                                             |
| `BLUECHIP`                           | `bluechip-api`                | `sync-bluechip` safety rating fetch                                                                                       |
| `VAULTS_FYI`                         | `vaults-fyi`                  | `sync-yield-supplemental` (vaults.fyi optional supplemental yield fetch, disabled by default)                             |
| `KINESIS_KAU`                        | `kinesis-kau-horizon`         | `sync-kinesis-supply` KAU chain circulation fetch                                                                         |
| `KINESIS_KAG`                        | `kinesis-kag-horizon`         | `sync-kinesis-supply` KAG chain circulation fetch                                                                         |
| `COINGECKO_CONFIRM`                  | `coingecko-confirm`           | pending depeg confirmation                                                                                                |
| `DEFILLAMA_CONFIRM`                  | `defillama-confirm`           | legacy retained state; pending depeg confirmation no longer queries DefiLlama's CoinGecko mirror                         |
| Dynamic `live-reserves:<scope>` keys | e.g. `live-reserves:infinifi` | `sync-live-reserves` per configured breaker scope; some adapters also opt into source-invariant within-run result sharing |

Primary-oracle implementation notes:

- `PYTH_PRICES` only counts as a healthy outcome when at least one requested feed resolves into a usable price; Hermes feed IDs are normalized by lowercasing and stripping an optional leading `0x`.
- `REDSTONE_PRICES` only counts as healthy when it returns at least one usable symbol. The worker queries an exact-case tracked-symbol allowlist in sequential batches of 10 and retries batch-dropped symbols individually once.
- CoinGecko Onchain pool discovery treats malformed pool members as schema-degraded while allowing omitted optional Pro attributes such as flat 24h volume, fee percentage, locked-liquidity percentage, and optional price/reserve siblings. Valid siblings still stage, and an all-invalid response cannot verify that a deployment has no pools. Breaker accounting remains transport-based for these responses.
- dRPC is an upstream RPC provider for some blacklist balance reads, but it is not a `CIRCUIT_SOURCE` key today.
- `/api/health` completes the circuit list from active `CIRCUIT_SOURCE` values plus configured `live-reserves:*` scopes, and filters retired/stale cache rows so old breaker keys do not keep surfacing as active incidents after a source is removed.
- `POST /api/reset-circuit-breaker?circuit=<source>` uses the same active-source whitelist, so operators can reset both source-wide breakers and configured scoped live-reserve breakers such as `live-reserves:usdgo-osl`.
- Scheduled handlers that write breaker state from cron outcomes now treat `degraded`, `skipped_locked`, and `skipped_neutral` as neutral by default; only explicit `ok` heals a breaker and only thrown/error outcomes count as failures unless a source-specific handler opts into stricter semantics.

---

## Shared Database Helpers

**Files:** `worker/src/lib/db.ts` for generic D1 helpers and `worker/src/lib/db-cache.ts` for cache-table helpers (`getCache`, `setCache`, `setCacheIfNewer`, `getPriceCache`, `savePriceCache`).

### Cache Table

All lightweight cron data is stored in the generic `cache` table. In the current migration tree that schema lives in `worker/migrations/0000_baseline.sql`; see [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) for the squashed lineage.

```sql
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

| Cache Key                                                  | Writer                           | Data                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stablecoins`                                              | `syncStablecoins`                | Full DefiLlama pegged assets payload                                                                                                                                                                                                                                                                                    |
| `stablecoins:invalid-last`                                 | `syncStablecoins`                | Last schema-invalid stablecoins payload (diagnostic only, never served to clients)                                                                                                                                                                                                                                      |
| `stablecoin-charts`                                        | `syncStablecoinCharts`           | Downsampled chart points                                                                                                                                                                                                                                                                                                |
| `fx-rates`                                                 | `syncFxRates`                    | FX rates (EUR, GBP, etc.)                                                                                                                                                                                                                                                                                               |
| `usds-status`                                              | `syncUsdsStatus`                 | Freeze capability + implementation address                                                                                                                                                                                                                                                                              |
| `bluechip-ratings`                                         | `syncBluechip`                   | Ratings map keyed by canonical Pharos ID                                                                                                                                                                                                                                                                                |

| `report-cards:fixed-input:exact`                            | `prepareSafetyScoreV9Input`      | Publication-exact internal compiler input. Its V8-shaped schema is retained only as the deterministic V9 compiler/replay bridge and is never served as a rating publication. |
| `safety-score-v9:supply-attribution-generation:v1`         | `syncSafetyScoreV9SupplyAttribution` | Private, bounded, content-addressed exact attribution generation containing the reviewed expected/observed asset inventory, accepted raw observations, explicit rejected outcomes, and source identity; the V9 compiler re-derives current USD partitions from this row without provider or RPC fan-out |
| `report-cards:v9-peg-provenance-seed:exact`                 | `prepareSafetyScoreV9Input`      | Compact publication-exact peg-provenance seed carrying the bridge identity and exact applicable peg-input key set. |
| `report-cards:v9`                                          | `computeSafetyScoreV9`           | Canonical checksum-verified accepted V9 evaluator publication projected by `/api/report-cards/v9`; strict consumers require full identity and completeness and never fall back to V8. |
| `report-cards:v9:publication-health`                       | `computeSafetyScoreV9`           | Strict bounded current/held state with accepted generation/time, latest attempt time, first hold time, and stable hold reasons. |
| `report-cards:v9:last-attempt`                              | `computeSafetyScoreV9`           | Internal clean/partial/held result written atomically with accepted publication and health state. Partial-publication consumers use its affected asset IDs as the active operational-suppression ledger. |
| `report-cards:v9:last-failed-attempt`                       | `computeSafetyScoreV9`           | Latest failed-attempt diagnostic with stage, bounded error metadata, and attempt time. It is isolated from the accepted-attempt ledger so a later failure cannot erase active partial-publication suppression state. |
| `safety-score-history:v2:operationally-affected`            | `snapshotSafetyGradeHistory`     | Bounded affected-ID marker retained only long enough to suppress the first clean recovery transition from organic history. |

| `peg-analytics`                                            | `prepareSafetyScoreV9Input`      | Producer-published peg-analytics snapshot; `/api/peg-summary` accepts it for up to 30 minutes and falls back to direct compute on miss/stale. |
| `detail-write-failure:<id>`                                | stablecoin detail API            | Marker written when a `detail:<id>` cache write fails or is oversized; the staleness watchdog alerts on markers fresher than 24h and prunes them after 7-day retention                                                                                                                                                  |
| `yield-rankings`                                           | `syncYieldData`                  | Pre-computed yield rankings + PYS scores                                                                                                                                                                                                                                                                                |
| `risk_free_rates`                                          | `fetchTbillRate`                 | Structured benchmark registry used by yield benchmark selection and provenance                                                                                                                                                                                                                                          |
| `risk_free_rate`                                           | `fetchTbillRate`                 | Current T-bill rate for PYS computation                                                                                                                                                                                                                                                                                 |
| `fetch-tbill-rate:gbp-retained-fallback-streak`            | `fetchTbillRate`                 | GBP SONIA retained-fallback observation streak and recovery metadata; its legacy alert timestamp is compatibility telemetry only                                                                                                                                                                                        |
| `fetch-tbill-rate:gbp-retained-fallback-alert:direct:v1`   | `fetchTbillRate`                 | Successful direct-delivery timestamp for the GBP fallback cooldown                                                                                                                                                                                                                                                      |
| `cron-staleness-watchdog:alert:<cache>:direct:v1`          | `runCronStalenessWatchdog`       | Successful direct-delivery timestamp, separate from the existing stale-observation episode marker                                                                                                                                                                                                                       |
| `status:{discrepancy-alert,probe-failure-alert}:direct:v1` | `runStatusSelfCheck`             | Successful direct-delivery timestamps; legacy `status_discrepancy_state` alert columns remain compatibility telemetry                                                                                                                                                                                                   |
| `telegram:degradation:<condition>-alerted:direct:v1`       | `runTelegramDegradationWatchdog` | Direct incident-delivery flags; the existing `*-since` and zero-send streak keys continue to own episode observation state                                                                                                                                                                                              |

**Cache access helpers:**

| Function                                        | Description                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `getCache(db, key)`                             | Returns `{ value, updatedAt }` or `null`                                                                                     |
| `setCache(db, key, value)`                      | `INSERT OR REPLACE` with current timestamp                                                                                   |
| `setCacheIfNewer(db, key, value, syncStartSec)` | Compare-and-swap: only writes if existing `updated_at <= syncStartSec`. Prevents slow cron runs from overwriting newer data. |

### Batch Execution

```typescript
async function batchExecute(
  db: D1Database,
  stmts: D1PreparedStatement[],
  chunkSize = 100, // D1_BATCH_SIZE
): Promise<number>;
```

Chunks statements into batches of 100 (D1's batch limit), executes sequentially, and returns the summed D1 `meta.changes` count across all batched statements.

### Cron Lease Primitives (Phase C)

Lease primitives are implemented in `worker/src/lib/cron-lease.ts` and are part of `worker/migrations/0000_baseline.sql`.
Scheduled slot fencing is backed by migration `0074_cron_slot_executions.sql`.

```sql
CREATE TABLE IF NOT EXISTS cron_leases (
  job TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

```sql
CREATE TABLE IF NOT EXISTS cron_slot_executions (
  slot_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  result_status TEXT,
  execution_owner TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  PRIMARY KEY (slot_key, slot_started_at)
);
```

| Function                                           | Description                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `acquireCronLease(db, job, owner, ttlSec)`         | Acquires lease for a job, or takes over when expired. Returns `true` on success, `false` if another active owner holds the lease. |
| `renewCronLease(db, job, owner, ttlSec)`           | Extends `lease_until` for the current owner. Returns `false` if ownership was lost.                                               |
| `releaseCronLease(db, job, owner)`                 | Deletes lease row only when caller still owns it.                                                                                 |
| `runCronWithLease(db, job, fn, opts)`              | Wrapper primitive: acquire → heartbeat renewals → run fn → release; returns `ok` or `skipped_locked` with metadata.               |
| `runScheduledSlotWithFence(db, slotKey, fn, opts)` | Deduplicates and heartbeats an entire trigger slot before any slot runner work begins.                                            |

Default behavior in `runCronWithLease`:

- Lease TTL defaults to `jobTimeout + 60s`
- Heartbeat defaults to `max(15s, ttl/3)`
- Owner defaults to `crypto.randomUUID()` when available
- Successful renewals reset the lease-failure counter, so only consecutive heartbeat misses can lose the lease
- The outer cron timeout now aborts the lease wrapper itself instead of only the inner job signal

### Lease Integration Status

Scheduled execution is now wired in two layers:

- `worker/src/handlers/scheduled.ts` normalizes `event.scheduledTime` into a durable slot timestamp and awaits the fenced slot inline via `runScheduledSlotWithFence(...)`, which keeps manual `/__scheduled` replays from being cancelled mid-slot by preview-only `waitUntil()` teardown semantics
- `worker/src/handlers/scheduled/context.ts` keeps per-job `runLeasedCron(...)` for job-level overlap protection, timeout logging, and progress

This means duplicate trigger deliveries for the same slot are skipped before shared-slot fan-out can reorder downstream jobs, while individual jobs inside the accepted slot still use their existing per-job leases.

The dedicated quarter-hour `cron-slot-sweeper` reconciles stale `cron_slot_executions` rows whose heartbeat has not advanced within the 35-minute slot stale window. Scheduled slot admission first pre-sweeps stale prior rows for the same schedule key. Before touching child artifacts, the sweeper atomically transitions the exact stale owner/generation/heartbeat row from `running` to `reconciling`; a concurrent heartbeat makes that claim change zero rows and leaves all child state untouched. If the claiming process dies, a later sweep can reclaim the stale `reconciling` row with the same owner/generation/heartbeat compare-and-swap and a new generation, while a fresh reconciliation claim remains protected for the full stale window. Takeovers increment `execution_generation`, and heartbeat/finalization updates require the current owner, generation, and state. A zero-change heartbeat aborts controlled work, while a late original finalizer cannot overwrite the takeover or synthetic error. After the reconciliation claim, the sweeper reconciles matching `cron_run_progress` and `cron_leases` ownership, writes an idempotent synthetic child `cron_runs` error when needed, closes the claimed slot, and writes the compact abandonment event marker. A replay repairs producer history or its head only when the existing cron row has the same deterministic synthetic key; a real terminal run under a different key remains authoritative. This keeps platform-killed scheduled events from remaining operationally `running` or `reconciling` without letting a stale observer corrupt live artifacts.

Synthetic chronology uses the original evidence clock, not sweep wall time. A started child records its original `started_at` and ends at its last durable progress heartbeat; a child proven not started uses the slot invocation time and last slot heartbeat. The later reconciliation timestamp remains metadata only, so old abandonment evidence cannot outrank a newer real cron run or producer head. Conditional `digestTriggerPoll` slots are special: absence of daily-digest progress means the poll was idle and produces no synthetic child failure, while durable started progress is still reconciled as abandoned. Status history also excludes legacy false `daily-digest` not-started rows from idle polls before its per-job history limit, without hiding genuine forced runs or abandoned-progress evidence.

### Cursor Tracking (Blacklist)

| Function                                               | Description                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `loadBlacklistConfigStates(db)`                        | Bulk-loads typed cursors plus attempt/success/skip/failure state; reads the maximum of compatibility `last_block` and `cursor_value` |
| `claimBlacklistConfigAttempt(db, state, attemptedAt)`  | Claims the exact loaded cursor/generation and increments `attempt_generation`                                                        |
| `finalizeBlacklistConfigAttempt(db, attempt, outcome)` | Monotonically dual-writes `cursor_value`/`last_block` plus outcome and safe-head state under the claimed generation                  |
| `recordBlacklistConfigSkips(db, states, skippedAt)`    | Records an unstarted budget tail without moving any cursor                                                                           |

### Price Cache

| Function                      | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `getPriceCache(db)`           | Returns `Map<assetId, { price, updatedAt }>` from `price_cache` table |
| `savePriceCache(db, entries)` | Batch upsert into `price_cache`                                       |

---

## Cron Job Ownership

Feature guides own producer-specific algorithms and schemas; this document owns shared scheduling, lease, timeout, circuit-breaker, and observability behavior.

| Producer family      | Source                                         | Feature contract                                  |
| -------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Stablecoin charts    | `worker/src/cron/sync-stablecoin-charts.ts`    | [Data Pipeline](./data-pipeline.md)               |
| USDS state           | `worker/src/cron/sync-usds-status.ts`          | [Stablecoin Data](./stablecoin-data.md)           |
| Live reserves        | `worker/src/cron/sync-live-reserves.ts`        | [Live Reserve Sync](./live-reserves.md)           |
| Redemption backstops | `worker/src/cron/sync-redemption-backstops.ts` | [Redemption Backstops](./redemption-backstops.md) |
| Kinesis supply       | `worker/src/cron/sync-kinesis-supply.ts`       | [Supply Snapshot](./supply-snapshot.md)           |
| Bluechip ratings     | `worker/src/cron/sync-bluechip.ts`             | [Bluechip Ratings](./bluechip-ratings.md)         |

## Health & Status Endpoints

### GET /api/health

Returns cache availability for key data sources. The table values are `maxAge` baselines used to calculate age ratios; they are not immediate stale cutoffs. Public health degrades above `8x maxAge` and becomes stale above `12x maxAge`, subject to stricter route-specific checks and other health floors.

The response uses the realtime cache profile (`public, s-maxage=60, max-age=10`) and participates in the Worker edge cache. This keeps the no-key public health surface bounded to roughly 60 seconds of cache lag while reducing repeated D1-backed health recomputation during browser polling and external probes.

| Cache Key           | Availability `maxAge` baseline |
| ------------------- | ------------------------------ |
| `stablecoins`       | 600s (10 min)                  |
| `stablecoin-charts` | 3,600s (1h)                    |
| `usds-status`       | 86,400s (24h)                  |
| `fx-rates`          | 1,800s (30 min)                |
| `bluechip-ratings`  | 86,400s (24h)                  |
| `dex-liquidity`     | 43,200s (12h)                  |
| `yield-data`        | 3,600s (1h)                    |
| `dews`              | 1,800s (30 min)                |

Supplemental yield aggregate cache writes remain last-good protected: an all-family empty run returns `degraded` and does not overwrite `cache["yield:supplemental-sources:v1"]`. Per-family rows are stricter ownership markers: a successful family that resolves to zero deduplicated candidates may publish an empty `yield:supplemental-sources:v1:<family>` cache to clear a previous non-empty family snapshot, while failed/malformed families leave their prior row untouched and rely on aggregate-cache fallback.

Health freshness checks for mint/burn major symbols and scheduler stale alerts use the same shared resolver in `worker/src/lib/mint-burn-health-config.ts`, including env overrides (`MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC`). The public `/api/health` status itself now follows critical-lane sync freshness (`lastSuccessfulSyncAt` + latest run status) rather than raw event recency, so quiet majors do not produce false stale health. The critical producer prunes safely valued, aggregated, and Tape-projected event rows after 8 days and hourly aggregates after 95 days in bounded oldest-first batches; retention errors degrade the producer and remain visible in its cron metadata. The advisory `mintBurn.totalEvents` value comes from the latest daily `mint-burn-growth-watchdog` `cron_runs` result instead of scanning `mint_burn_events`/`mint_burn_hourly` or reading `sqlite_sequence`; the watchdog's 2.3M-row threshold is a fail-safe for non-converging cleanup or unexpectedly large protected debt.

`/api/health` also returns a `warnings: string[]` field. Subquery failures (for example blacklist or circuit-state lookups) no longer silently degrade to zero-like values; instead the endpoint downgrades `status` and emits machine-readable warning strings while still returning `200`. Those warning strings are intentionally sanitized for public output; raw exception detail stays in worker logs.

### GET /api/status

Returns raw and effective status, recent `cron_runs`, active `cron_run_progress` rows, stale progress/lease artifacts, latest cron event markers, budget-only surface telemetry, publication-generation health, provider circuit health, data-invariant canaries, derived dependency health, data-quality metrics, state-machine metadata, synthetic probe summary, and transition timeline. It tracks the jobs in `CRON_INTERVALS` and `CRON_JOB_DEFINITIONS` from `shared/lib/cron-jobs.ts`. Budget-only scheduled surfaces are intentionally absent from `/api/status` job health but present in `CRON_CONNECTION_BUDGET_ENTRIES` for `npm run check:cron-connections` and in the top-level `budgetOnlySurfaces` array for observability.

Default reads use the raw status snapshot produced by `status-self-check` and recompute only lightweight wrappers and admin supplements. Publication health reads canonical ledgers and artifacts, including `report-cards:v9` plus matching `report-cards:v9:publication-health` for the `safety-score-v9` surface. It does not consult retired V8 report-card caches. Provider-circuit, canary, and dependency-health supplements remain advisory and do not change publication behavior. Snapshot age is bounded to 30 minutes; operators can force the live computation path with `GET /api/status?refresh=live`.

Status hysteresis transitions and self-probe history use nullable `idempotency_key` columns with partial unique indexes. The status-state batch writer and probe writer run through `runWithOverloadRetry()`, so ambiguous D1 overload retries can reapply the same state/probe write without duplicating append-only transition or probe rows.

The `probe` object returned by `/api/status` is the latest `status_probe_runs` aggregate. New split-plane rows include optional `internal`, `external`, and `internalExternalDiscrepancy` subobjects so operators can compare internal router health against the production custom-domain path. Legacy rows and cold-start fallbacks omit those optional fields.

| Job                               | Interval         | Trigger                                                     |
| --------------------------------- | ---------------- | ----------------------------------------------------------- |
| `sync-stablecoins`                | 900s (15min)     | `*/15 * * * *`                                              |
| `sync-stablecoin-charts`          | 3,600s (1h)      | `16,46 * * * *` (scheduled hourly cadence buckets)          |
| `sync-fx-rates`                   | 1,800s (30min)   | `*/15 * * * *` (scheduled 30-min cadence buckets)           |
| `stability-index`                 | 1,800s (30min)   | `26,56 * * * *`                                             |
| `compute-dews`                    | 1,800s (30min)   | `26,56 * * * *`                                             |
| `project-tape`                    | 1,800s (30min)   | `26,56 * * * *`                                             |
| `cron-slot-sweeper`               | 900s (15min)     | `9,24,39,54 * * * *`                                        |
| `status-self-check`               | 900s (15min)     | `9,24,39,54 * * * *`                                        |
| `data-invariant-canary`           | 900s (15min)     | `9,24,39,54 * * * *`                                        |
| `cron-staleness-watchdog`         | 900s (15min)     | `9,24,39,54 * * * *`                                        |
| `dispatch-telegram-alerts`        | 300s (5min)      | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`                 |
| `telegram-degradation-watchdog`   | 300s (5min)      | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`                 |
| `telegram-disambiguation-cleanup` | 300s (5min)      | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`                 |
| `telegram-pulse-snapshot`         | 300s (5min)      | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`                 |
| `sync-blacklist`                  | 21,600s (6h)     | `3 */6 * * *`                                               |
| `sync-mint-burn`                  | 1,800s (30min)   | `4,34 * * * *`                                              |
| `sync-dex-discovery`              | 7,200s (2h)      | `6 */2 * * *`                                               |
| `sync-mint-burn-extended`         | 1,800s (30min)   | `18,48 * * * *` (after the fenced V9 publication slot)      |
| `sync-dex-liquidity-stage`        | 1,800s (30min)   | logical `10,40`; physical `10` + `40` hourly triggers        |
| `sync-dex-liquidity`              | 1,800s (30min)   | logical `16,46`; physical `16` + `46` hourly triggers        |
| `sync-yield-data`                 | 3,600s (1h)      | `20 * * * *`                                                |
| `sync-yield-supplemental`         | 14,400s (4h)     | `25 */4 * * *`                                              |
| `snapshot-supply`                 | 86,400s (24h)    | `*/15 * * * *` (once per UTC date) / `0 8 * * *` (fallback) |
| `snapshot-chain-supply`           | 86,400s (24h)    | `*/15 * * * *` (once per UTC date)                          |
| `sync-v9-supply-attribution`      | 900s (15min)     | `8,23,38,53 * * * *` (30min accepted / 15min rejected cooldown) |
| `prepare-safety-score-v9-input`   | 1800s (30min)    | after successful DEX publication in the logical `16,46` slot |
| `compute-depeg-resolver`          | 900s (15min)     | `*/15 * * * *`                                              |
| `compute-safety-score-v9`         | 1800s (30min)    | `22,52 * * * *` (fenced 60-second window)                   |
| `snapshot-safety-grade-history`   | 86,400s (24h)    | `0 8 * * *`                                                 |
| `fetch-tbill-rate`                | 86,400s (24h)    | `0 8 * * *`                                                 |
| `snapshot-psi`                    | 86,400s (24h)    | `0 8 * * *`                                                 |
| `snapshot-public-dataset`         | 86,400s (24h)    | `0 8 * * *`                                                 |
| `sync-usds-status`                | 86,400s (24h)    | `0 8 * * *`                                                 |
| `sync-live-reserves`              | 14,400s (4h)     | `11 */4 * * *`                                              |
| `reserve-recovery`                | 300s (5min)      | `1,6,11,16,21,26,31,36,41,46,51,56 * * * *`                 |
| `sync-redemption-backstops`       | 14,400s (4h)     | `11 */4 * * *`                                              |
| `sync-kinesis-supply`             | 14,400s (4h)     | `11 */4 * * *`                                              |
| `reserve-post-sync-watchdog`      | 14,400s (4h)     | `11 */4 * * *`                                              |
| `sync-bluechip`                   | 86,400s (24h)    | `5 8 * * *`                                                 |
| `daily-digest`                    | 86,400s (24h)    | `5 8 * * *`                                                 |
| `weekly-recap`                    | 604,800s (7d)    | `10 8 * * *` (Monday-only)                                  |
| `prune-status-probe-runs`         | 86,400s (24h)    | `0 3 * * *`                                                 |
| `prune-cron-history`              | 86,400s (24h)    | `0 3 * * *`                                                 |
| `worker-repair-runner`            | 86,400s (24h)    | `0 3 * * *`                                                 |
| `prune-detail-cache`              | 86,400s (24h)    | `0 3 * * *`                                                 |
| `telegram-inactive-cleanup`       | 604,800s (7d)    | `0 3 * * *` (daily invocation, 7-day cache guard)           |
| `telegram-retention-cleanup`      | 86,400s (24h)    | `0 3 * * *`                                                 |
| `mint-burn-growth-watchdog`       | 86,400s (24h)    | `0 3 * * *`                                                 |
| `cron-duration-watchdog`          | 86,400s (24h)    | `0 3 * * *`                                                 |
| `yield-coverage-audit`            | 2,592,000s (30d) | `0 6 1 * *`                                                 |

A job is treated as healthy when cron telemetry is unavailable, when a fresh in-flight run exists, when the last run is fresh and `ok`/`degraded`, when the last run is a fresh `skipped_neutral` expected no-op backed by a fresh latest non-neutral `ok` or `degraded` required run, when a fresh `skipped_locked` run has another fresh `ok` run in recent history, or when a watch-tier job has no history yet. A required degraded run remains counted in degraded diagnostics even though later neutral skips inherit its availability. Otherwise the job is unhealthy, including stale history, non-fresh errors, or a neutral skip whose latest required run errored. `/api/status` also exposes `crons[*].inFlight` while a long-running leased job is active, including `stage`, `itemsDone/itemsTotal`, the last heartbeat timestamp, and a `stale` flag when the active-progress row stops updating. Only progress rows backed by a still-active matching lease are surfaced this way; orphaned rows and expired leases move to `crons[*].staleArtifacts` and increment `summary.staleCronArtifacts`, `summary.orphanedCronProgressRows`, and `summary.expiredCronLeases`. Running scheduled-slot aggregates live in `summary.scheduledSlotRunning`, `summary.scheduledSlotStaleCandidates`, and `summary.scheduledSlotOldestRunningAgeSec`. Budget-only side work lives in `budgetOnlySurfaces` with separate `summary.budgetOnlySurface*` counters, not in `crons`. When a scheduled slot is later reconciled as abandoned, `crons[*].latestEvent` on each child job in that slot can carry the latest `scheduled-slot-abandoned` marker with the schedule key, owner, and progress-stage metadata for operator triage.

The status handler now surfaces per-subsection loader failures through `sectionErrors` instead of silently swallowing them. When a subsection query fails, the affected field degrades to `null`/empty and the response still returns `200` with a machine-readable error entry for that subsection. Those subsection messages are sanitized summaries rather than raw SQL / exception text.

### GET /api/status-history

Admin timeline feed for machine consumers. Returns persisted status state, status-system staleness, latest synthetic probe aggregate, discrepancy summary, recent status transitions, and `hasMore` completeness evidence. The handler reads one sentinel row beyond the requested page (up to 201 rows for the public 200-row maximum), removes that sentinel from the response, and returns `hasMore: null` when the transition query fails so consumers cannot mistake missing evidence for a complete window.

---

## Key Constants

**File:** `worker/src/lib/constants.ts`

| Constant                        | Value                               | Purpose                               |
| ------------------------------- | ----------------------------------- | ------------------------------------- |
| `D1_BATCH_SIZE`                 | 100                                 | Max statements per D1 batch           |
| `ETHERSCAN_V2_BASE`             | `https://api.etherscan.io/v2/api`   | Etherscan unified endpoint            |
| `DEFILLAMA_BASE`                | `https://stablecoins.llama.fi`      | DefiLlama stablecoins                 |
| `DEFILLAMA_COINS`               | `https://coins.llama.fi`            | DefiLlama coin prices                 |
| `DEFILLAMA_API`                 | `https://api.llama.fi`              | DefiLlama yields/protocols            |
| `USER_AGENT`                    | `Pharos/1.0 (stablecoin analytics)` | All outbound requests                 |
| `MIN_VALID_ASSET_COUNT`         | 50                                  | Minimum assets from DL for valid sync |
| `DEXSCREENER_MIN_LIQUIDITY_USD` | 50,000                              | DexScreener pool threshold            |
