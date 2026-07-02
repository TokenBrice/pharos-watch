# Worker Infrastructure

Cloudflare Worker serving the Pharos API. Handles HTTP routing, edge caching, CORS, admin auth, and scheduled runtime work across 19 cron expressions / runner slots. `CRON_INTERVALS` / `/api/status` track the 47 `CRON_JOB_DEFINITIONS` jobs across 18 job-bearing slots; `CRON_CONNECTION_BUDGET_ENTRIES` also includes budget-only scheduled surfaces such as Telegram registration reconciliation and the separate `*/5 * * * *` digest-trigger poll slot. The digest-trigger poll is the 19th runner slot and executes manual digest requests under the `daily-digest` lease rather than registering as its own status job.

Execution note: the `snapshot-supply` retry path runs on the `*/15 * * * *` trigger only after a downstream-safe `sync-stablecoins` cache write. The `0 8 * * *` daily fallback additionally requires the `stablecoins` cache row to be written at or after that scheduled slot start before it can consume write-once daily artifacts.

**Deployed at:** `api.pharos.watch` (public integration API), `site-api.pharos.watch` (website-internal data lane), and `ops-api.pharos.watch` (operator lane; pair with Cloudflare Access before use)

> **Agent navigation** — ~1,260 lines; Grep the heading you need instead of reading wholesale: Runtime Limits and Observability · Env Interface · Module Initialization · Public API Auth and Rate Limiting · HTTP Request Handling · Cron Scheduling · Telegram Alert Bot · logCronRun() Wrapper · Alert System · Shared Database Helpers · Undocumented Cron Details · Health & Status Endpoints · Key Constants · File Index.

---

## Runtime Limits and Observability

Worker runtime safety and telemetry controls are declared in `worker/wrangler.toml` and should be managed in git (the CI deploy job now runs `wrangler versions upload`, preview smoke against the uploaded candidate, direct Workers Deployments API promotion through `.github/scripts/deploy-worker-version.mjs`, and then `wrangler triggers deploy`, so dashboard-only edits can be overwritten on the next deployment).

```toml
compatibility_date = "2026-04-18"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
preview_urls = true

[limits]
cpu_ms = 30000

[observability]
enabled = true
head_sampling_rate = 0.1

[observability.logs]
enabled = true
invocation_logs = true
```

- `cpu_ms = 30000`: hard cap on CPU time per invocation (not wall-clock runtime). This is independent from in-app wall-clock cron timeouts in `logCronRun()`. Raised from 5000 to give isolated cron triggers comfortable headroom; higher Cloudflare ceilings are vendor-plan details and are intentionally not treated as repo source of truth here.
- `compatibility_date = "2026-04-18"` + `nodejs_compat`: top-level Wrangler runtime compatibility settings for the deployed Worker.
- `global_fetch_strictly_public`: keeps Worker-origin fetches to the Worker's own public custom domains on the public edge path. `status-self-check` depends on that behavior for production-domain canaries; without it, same-Worker custom-domain self-fetches can return internal 522s while external clients remain healthy.
- `observability.enabled`: enables Worker traces.
- `head_sampling_rate = 0.1`: samples 10% of traces.
- `observability.logs.enabled` + `invocation_logs = true`: enables Workers Logs in dashboard.
- `preview_urls = true`: keeps per-version preview URLs available so CI can smoke an uploaded Worker version before production promotion.

Cron observability has two paths. Terminal job outcomes continue through `logCronRun()` / `cron_runs`; swallowed exceptions that should remain non-fatal use `recordCronFailure()`. Degraded, skipped, fallback, or warning conditions that should survive log retention can call `logCronEvent(db, { job, eventType, severity, message, metadata })`, which writes a latest-event record to the existing cache table under a bounded `cron:event:<job>:<eventType>` key and also emits a structured console line. Use `logCronEvent` for non-terminal operational events rather than adding TODO-backed `console.*` call sites.

HTTP, API, status, and admin route logs use `logWorkerEvent()` from `worker/src/lib/structured-log.ts`. It emits one JSON console line with stable top-level fields (`scope`, `level`, `event`, `route`, `job`, `provider`, `source`, `runId`) and bounded `metadata` / error fields so Cloudflare Workers Logs stay queryable without turning high-cardinality values into top-level keys. `npm run check:cron-console-usage` keeps its historical name but now ratchets raw `console.*` calls across cron plus HTTP/status/admin roots; new route logs should use `logWorkerEvent()` instead of direct string console calls.

Provider URLs that may embed credentials must pass through `redactProviderUrls()` / `safeErrorMessage()` before logging. The central redactor strips path/query details for Alchemy, dRPC, Etherscan, Telegram, Twitter/X, Anthropic-style hosts, and redacts generic secret query parameters on other URLs.

---

## Env Interface

The `Env` interface is defined in `worker/src/lib/env.ts` and consumed by `worker/src/index.ts` plus the HTTP-request helper stack under `worker/src/handlers/http*.ts` and the scheduled-runtime entrypoint/context (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/scheduled/context.ts`). `DB`, `CORS_ORIGIN`, `SELF_URL`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_OPS_API_AUD`, and the Worker hardening shadow-mode vars are set in `worker/wrangler.toml`; the remaining active bindings are runtime env values (typically provided via Cloudflare Worker secrets). The cross-runtime key manifest now lives in `shared/lib/env-contract.ts`, and `npm run check:env-contract` compares Wrangler-owned `[vars]` plus D1 bindings against `Env` so config-only binding changes cannot drift from the worker type contract.

`worker/src/lib/env.ts` still exports the worker runtime views:

- `WORKER_REQUIRED_ENV_KEYS`
- `WORKER_OPTIONAL_ENV_KEYS`
- `WORKER_RESERVED_ENV_KEYS`
- `WORKER_ACTIVE_ENV_KEYS` (`required + optional`)

The paired Pages Functions contracts live in `functions/lib/ops-env.ts` and `functions/lib/site-api-env.ts`, with the same `required` / `optional` / `reserved` / `active` shape derived from that shared manifest. Worker runtime validation logs contract errors when Access bindings are only partially configured, when admin D1 status bindings are only partially configured, when `SITE_API_SHARED_SECRET` is missing, when `GITHUB_PAT` / `FEEDBACK_IP_SALT` are missing for `POST /api/feedback`, when `API_KEY_HASH_PEPPER` is missing, when `BANXICO_TOKEN` is missing for the official MXN CETES benchmark, or when the self-serve API key email verification bindings are only partially configured. The Pages ops-proxy contract now actively requires `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD` for inbound UI JWT verification. The Pages `site-data` `DB` binding is part of the required Pages site-data contract because selector-snapshot POST quotas fail closed without it; `/_site-data/*` public-read proxy requests continue without the binding but log that attribution telemetry is disabled.

Operational telemetry control: set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on the Worker and/or Pages site-data environment to stop low-value route/source attribution writes. This disables Worker `api_request_consumer_stats` route/source writes and Pages `site_data_request_stats` writes, while preserving API-key authentication, D1-backed rate limiting, last-used metadata updates, and per-key public API load telemetry. During keyed public-API spikes, set `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true` on the Worker to pause only `api_key_request_stats` writes; auth, rate limiting, and last-used metadata still run.

Scheduled job attempt ledger: unset `WORKER_JOB_LEDGER_MODE` defaults to `off`, but the checked-in Worker config now sets `shadow` with `WORKER_JOB_LEDGER_ALLOWLIST=sync-dex-discovery,sync-live-reserves,sync-dex-liquidity,sync-stablecoins,sync-yield-data`. This records best-effort scheduled-job attempts in `worker_job_attempts` for the long-job watchlist without changing cron execution, leases, or `cron_runs`; `write` is reserved for later promotion and currently behaves like `shadow`. Leave the allowlist in place until attempt, heartbeat, terminal-state, status, and prune behavior have soaked cleanly.

Repair task runner: unset `WORKER_REPAIR_RUNNER_MODE` defaults to `off`, but the checked-in Worker config now sets `shadow`. DDR repair-required events are dual-written into `worker_repair_tasks` while the existing DDR cache marker remains a status fallback. `shadow` records due/stale backlog telemetry without claiming rows. `enabled` runs a bounded DB-only daily 03:00 batch that claims at most five due repair tasks, closes DDR tasks already resolved by event links/deletes, and defers unresolved manual DDR repairs.

Data-invariant canaries: unset `WORKER_CANARY_MODE` defaults to `off`, but the checked-in Worker config now sets `shadow`. The DB/cache-only `data-invariant-canary` job runs in the status self-check slot, records structural findings in `worker_canary_runs` and `/api/status.canaries`, and does not change producer publication behavior. Promote to `status` only after shadow rows are stable and any degraded/error checks are understood.

<!-- ENV-CONTRACT:WORKER-INFRASTRUCTURE:BEGIN -->
Canonical binding ownership now lives in `shared/lib/env-contract.ts`; the worker and Pages env modules derive their `required` / `optional` / `reserved` views from that manifest.

| Binding | Type | Worker | Pages ops | Pages site-data | Description |
| --- | --- | --- | --- | --- | --- |
| `DB` | `D1Database` | required | - | required | Primary D1 binding for worker reads/writes; Pages uses it for optional site-data attribution telemetry and required atomic selector-snapshot write quotas. |
| `CORS_ORIGIN` | `string` | required | - | - | Comma-separated CORS allowlist; repo default is `https://pharos.watch,https://ops.pharos.watch`. |
| `SELF_URL` | `string` | optional | - | - | Status self-check external probe base URL. |
| `SITE_API_SHARED_SECRET` | `string` | optional | - | required | Shared secret for Pages `/_site-data/*` -> Worker `site-api` authentication via `X-Pharos-Site-Proxy-Secret`. |
| `SITE_API_SHARED_SECRET_PREVIOUS` | `string` | optional | - | - | Optional overlap secret accepted alongside `SITE_API_SHARED_SECRET` during the site-data rotation window. |
| `API_KEY_HASH_PEPPER` | `string` | optional | - | - | HMAC pepper used to hash the secret portion of public API keys. |
| `API_KEY_HASH_PEPPER_PREVIOUS` | `string` | optional | - | - | Optional overlap pepper accepted alongside `API_KEY_HASH_PEPPER` during public API key rotation. |
| `CF_ACCESS_TEAM_DOMAIN` | `string` | optional | required | - | Cloudflare Access team domain used to verify Access JWTs on worker admin requests and the Pages ops proxy. |
| `CF_ACCESS_OPS_API_AUD` | `string` | optional | - | - | Cloudflare Access audience for worker-side `ops-api.pharos.watch` JWT verification. |
| `ETHERSCAN_API_KEY` | `string` | optional | - | - | Etherscan API credential used by blacklist sync and USDS status reads. |
| `TRONGRID_API_KEY` | `string` | optional | - | - | TronGrid API credential used by the Tron blacklist-sync lane. |
| `DRPC_API_KEY` | `string` | optional | - | - | dRPC credential used for L2 archive-node balance lookups. |
| `ALCHEMY_API_KEY` | `string` | optional | - | - | Alchemy credential used for primary chain RPC endpoints and, when enabled, Alchemy Prices API address-price augmentation. |
| `MORALIS_API_KEY` | `string` | optional | - | - | Moralis credential used for optional exact-address token-price augmentation. |
| `BIRDEYE_API_KEY` | `string` | optional | - | - | Birdeye credential used for optional targeted Solana exact-address token-price augmentation. |
| `ADDRESS_PRICE_PROVIDERS_ENABLED` | `string` | optional | - | - | Optional comma-separated allowlist for exact-address price providers; unset auto-enables DexPaprika plus configured key-backed providers. Use `none` to disable, or include `dexscreener-address` only for explicit opt-in to that Cloudflare/WAF-protected public lane. |
| `GRAPH_API_KEY` | `string` | optional | - | - | The Graph credential used by DEX liquidity subgraph reads. |
| `ALERT_WEBHOOK_URL` | `string` | optional | - | - | Webhook URL used for Discord/Slack-style error alerts. |
| `ANTHROPIC_API_KEY` | `string` | optional | - | - | Anthropic credential used for daily digest generation. |
| `CMC_API_KEY` | `string` | optional | - | - | CoinMarketCap credential used by the price-fallback pass. |
| `JUPITER_API_KEY` | `string` | optional | - | - | Jupiter credential used by the Solana price-fallback pass against `api.jup.ag`. |
| `COINGECKO_API_KEY` | `string` | optional | - | - | CoinGecko credential used for price enrichment and depeg confirmation. |
| `VAULTS_FYI_API_KEY` | `string` | optional | - | - | Optional vaults.fyi credential for the disabled-by-default supplemental yield integration. |
| `VAULTS_FYI_ENABLED` | `string` | optional | - | - | Optional vaults.fyi supplemental yield integration flag; unset, false, or malformed values keep the integration disabled. |
| `VAULTS_FYI_RANKABLE_VAULTS` | `string` | optional | - | - | Optional CSV allowlist of vaults.fyi `network:vaultId` entries allowed to publish rankable supplemental yield rows. |
| `VAULTS_FYI_MAX_CREDITS_PER_RUN` | `string` | optional | - | - | Optional positive integer local cap for estimated vaults.fyi credit units consumed by one supplemental yield run. |
| `VAULTS_FYI_MAX_CREDITS_PER_MONTH` | `string` | optional | - | - | Optional positive integer local cap for estimated vaults.fyi credit units consumed during one UTC month. |
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
| `WORKER_JOB_LEDGER_MODE` | `string` | optional | - | - | Scheduled Worker job-attempt ledger mode. Unset or `off` disables writes; `shadow` records best-effort telemetry without changing execution; `write` is reserved for later promotion and currently behaves like `shadow`. |
| `WORKER_JOB_LEDGER_ALLOWLIST` | `string` | optional | - | - | Optional CSV allowlist for job-attempt ledger recording. Unset records all scheduled jobs when the ledger mode is enabled. |
| `WORKER_REPAIR_RUNNER_MODE` | `string` | optional | - | - | Worker repair-task runner mode. Unset or `off` disables repair processing; `shadow` records due/stale backlog telemetry without claiming rows; `enabled` lets the daily DB-only runner claim, close, or defer a small batch. |
| `WORKER_CANARY_MODE` | `string` | optional | - | - | Worker data-invariant canary mode. Unset or `off` skips writes; `shadow`, `status`, and `alert` record structural canary telemetry without changing producer behavior. |
| `OPS_UI_ORIGIN` | `string` | reserved | optional | optional | Ops UI origin override; reserved on the worker and active on Pages host-gating / same-origin checks. |
| `OPS_API_ORIGIN` | `string` | reserved | optional | - | Ops API origin override; reserved on the worker and active on the Pages admin proxy upstream hop. |
| `CF_ACCESS_OPS_UI_AUD` | `string` | reserved | required | - | Cloudflare Access audience used by the Pages ops proxy to verify the inbound UI JWT. |
| `OPS_API_SERVICE_TOKEN_ID` | `string` | - | required | - | Pages-managed Access service-token client ID used on the server-to-server hop to `ops-api.pharos.watch`. |
| `OPS_API_SERVICE_TOKEN_SECRET` | `string` | - | required | - | Pages-managed Access service-token client secret used on the server-to-server hop to `ops-api.pharos.watch`. |
| `SITE_ORIGIN` | `string` | - | - | optional | Site origin override used by the Pages `/_site-data/*` proxy when classifying production hosts. |
| `SITE_API_ORIGIN` | `string` | - | - | required | Site-data upstream origin; production Pages hosts require `https://site-api.pharos.watch`. |
| `SELECTOR_SNAPSHOTS` | `KVNamespace` | - | - | required | KV namespace binding for the Pages-only Stablecoin Picker snapshot store at `functions/selector-snapshot/[[path]].ts`; stores content-addressed `s:{sid}` entries. Hashed-IP write-quota counters live in D1 for atomic reservations. |
<!-- ENV-CONTRACT:WORKER-INFRASTRUCTURE:END -->

---

## Module Initialization

Three modules derive runtime configuration from `Env` bindings via pure functions. These are called in the scheduled context factory (`worker/src/handlers/scheduled/context.ts`) and in `worker/src/handlers/http/request-dispatch.ts`, with results passed as parameters rather than stored in module-level state:

| Function                                                | Called in             | Purpose                                              |
| ------------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| `normalizeCgApiKey(env.COINGECKO_API_KEY)`              | `fetch` + `scheduled` | Returns normalized API key for CoinGecko requests    |
| `buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY)` | `fetch` + `scheduled` | Builds chain RPC configs with Alchemy/dRPC primaries |
| `normalizeWebhookUrl(env.ALERT_WEBHOOK_URL)`            | `scheduled`           | Returns normalized webhook URL for error alerts      |

These are pure functions. `Env` bindings are only available inside handler functions (not at module initialization time), so values are computed fresh per-request/per-trigger via the context factory. The notable exception is `shared/lib/cloudflare-access-jwt.ts`, which intentionally keeps an in-memory JWKS cache (`jwksCache`, 1-hour TTL) at module scope to avoid refetching Cloudflare Access signing keys on every admin request.

## Public API Auth and Rate Limiting

Non-exempt `/api/*` requests on `api.pharos.watch` require a valid `X-API-Key`. Missing or invalid keys return `401 Unauthorized`.

When a valid key is present, the worker uses the D1-backed `api_key_rate_limit` table with the per-key threshold stored in `api_keys.rate_limit_per_minute` (default `120/min`; self-serve keys are issued at `30/min`). API keys carry `api_keys.traffic_class` (`external` or `site`) so request attribution can treat website-owned automation separately from third-party consumers. API-key auth or limiter dependency failures fail closed with `503 Service Unavailable` and `Retry-After: 60`. `FEEDBACK_IP_SALT` remains scoped to feedback submission hashing only.

The no-key public exceptions are `GET /api/health`, `GET /api/og/*`, `POST /api/feedback`, `POST /api/api-key-requests`, `POST /api/api-key-requests/verify`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, and `POST /api/telegram-mini-app/mutate`. The Telegram webhook is authenticated separately through `X-Telegram-Bot-Api-Secret-Token`; Telegram Mini App endpoints are authenticated through signed Telegram `initData`.

Self-serve API key requests use `api_key_requests`, `api_key_request_rate_limit_v2`, `api_key_self_serve_email_claims`, and `api_key_self_serve_issuance_limits`. Request intake hashes normalized email, IP, and user-agent values with dedicated self-serve secrets, sends a Resend verification email, and only creates a key after verification. Verification uses an issuance lock on the request row plus a fixed-window issued-key cap keyed by the salted submission IP hash. Requester details are visible only through the Access-gated `ops.pharos.watch/admin-api/` UI and the admin endpoints it calls.

---

## HTTP Request Handling

### Method Routing

| Method    | Handling                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `OPTIONS` | Returns 204 with CORS headers (preflight)                                                                            |
| `POST`    | `/api/feedback`, `/api/api-key-requests`, `/api/api-key-requests/verify`, `/api/telegram-webhook`, `/api/telegram-mini-app/session`, `/api/telegram-mini-app/mutate`, and mutating admin endpoints from `shared/lib/api-endpoints/` |
| `GET`     | Read endpoints + admin debug routes; mutating admin routes return 405 except dry-run previews such as `/api/audit-depeg-history?dry-run=true` and `/api/backfill-dews?repair=...&dry-run=true`, plus the read-only `GET /api/backfill-dews` backtest |
| Other     | Known endpoint families with disallowed methods return 405 `{ error: "Method not allowed" }` with `Allow`; unregistered public `/api/*` paths can return auth errors first, then 404 after lane auth succeeds because no route dependencies can be hydrated |

Method/path flags (`mutatingAdmin`, `cacheBypass`, probe groups, status actions) are centralized in the folderized `shared/lib/api-endpoints/` module surface and consumed by both worker and frontend status tooling.

### Public API Auth and Rate Limiting

- `worker/src/handlers/http/gates.ts` checks the request lane in this order: `ops-api` Access auth, `site-api` shared-secret auth, then public `/api/*` key auth or explicit public exemptions.
- Registered admin `/api/*` paths and configured admin-like root families are denied on the public lane before public API-key auth or exemption handling. This includes malformed children of configured roots such as `/api/api-keys/*`, `/api/api-key-requests-admin/*`, and `/api/discovery-candidates/*`; valid Access-authenticated `ops-api.pharos.watch` admin requests keep their normal route behavior.
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

### Stale D1 Schema Inventory

Several migration-era tables are intentionally schema-retained until a separate destructive D1 cleanup rollout runs. Current Worker code does not read or write:

| Table | Replaced by / current runtime path | Cleanup status |
| --- | --- | --- |
| `public_api_rate_limit` | Cloudflare zone rule `api-rate-limit-ip` plus keyed `api_key_rate_limit` | stale schema-retained table |
| `api_request_source_stats` | `api_request_consumer_stats` and `api_key_request_stats` | queued in `worker/migrations/MANIFEST.md` for dedicated destructive cleanup; 2026-07-02 zero-use check found no runtime readers/writers outside historical migrations/docs |
| `api_key_request_rate_limit` | `api_key_request_rate_limit_v2` | queued in `worker/migrations/MANIFEST.md` for dedicated destructive cleanup after the completed May 2026 v2 rollout; 2026-07-02 zero-use check found no runtime readers/writers outside historical migrations/docs |
| `feedback_submissions` | GitHub issue creation plus `feedback_rate_limit`; no durable submission persistence today | stale schema-retained table unless feedback D1 persistence is deliberately reintroduced |

Do not drop these in a normal migration. Destructive cleanup requires production backup/Time Travel verification, fresh zero-use evidence, and a dedicated rollout after compatible Worker code has soaked.

### CORS Headers

Applied to every response via `addCorsHeaders()`:

| Header                          | Value                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Access-Control-Allow-Origin`   | matching request origin from the `CORS_ORIGIN` allowlist; omitted for foreign origins; first configured origin when the request has no `Origin` |
| `Vary`                          | `Origin`                                                                                        |
| `Access-Control-Allow-Methods`  | `GET, POST, OPTIONS`                                                                            |
| `Access-Control-Allow-Headers`  | `Content-Type, Idempotency-Key, X-API-Key, X-Pharos-Admin`                                      |
| `Access-Control-Expose-Headers` | `X-Data-Age, Warning, Retry-After`                                                              |
| `Access-Control-Max-Age`        | `86400`                                                                                         |
| `X-Content-Type-Options`        | `nosniff`                                                                                       |
| `Strict-Transport-Security`     | `max-age=31536000; includeSubDomains`                                                           |
| `Referrer-Policy`               | `strict-origin-when-cross-origin`                                                               |
| `Content-Security-Policy`       | `default-src 'none'; frame-ancestors 'none'`                                                    |

`CORS_ORIGIN` is now treated as a comma-separated allowlist. If the incoming request includes an `Origin` header that matches one of the configured entries, the Worker echoes that specific origin. If the request includes a foreign `Origin`, the worker omits `Access-Control-Allow-Origin` and rejects `OPTIONS` preflights with `403`. Requests without an `Origin` header keep the existing first-allowlisted-origin fallback.

### Edge Cache Strategy

The Worker uses `caches.default` (Cloudflare's per-colo edge cache) to cache GET responses:

1. **Cache bypass rules**:
   - All non-GET requests bypass edge cache.
   - GET paths marked `cacheBypass: true` in `shared/lib/api-endpoints/` bypass edge cache (status and admin/backfill endpoints like `/api/backfill-*`, `/api/audit-depeg-history`, `/api/backfill-dews`, including their dry-run preview variants).

2. **Cache check:** `caches.default.match(cacheKey)` — returns cached response if available

3. **Cache store:** `ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(...))` — successful cacheable responses are cloned **without** CORS headers before caching. CORS headers are added per-request after cache lookup to avoid caching origin-specific headers. The Worker skips edge-cache writes for responses whose `Cache-Control` contains `no-store`, `no-cache`, or `private`; those responses are intentionally not persisted in `caches.default`.

4. **Cache-Control profiles** (centralized in `shared/lib/api-cache-profiles.ts`; set by individual API handlers, with a small number of route-local special cases):

| Profile  | `Cache-Control` header                 | Used by                                                                                                                                                            |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Realtime | `public, s-maxage=60, max-age=10`      | health, events                                                                                                                     |
| Producer-backed | `public, s-maxage=300, max-age=60, stale-while-revalidate=300` | stablecoins, stablecoin-summary, blacklist, blacklist-summary, depeg-events, peg-summary, mint-burn-events, chains |
| Per-coin | `public, s-maxage=300, max-age=10`     | stablecoin detail (`/api/stablecoin/:id`)                                                                                                                          |
| Standard | `public, s-maxage=300, max-age=60`     | stablecoin-charts, redemption-backstops, usds-status, daily-digest, digest-archive, report-cards, stability-index, yield-rankings, mint-burn-flows, stress-signals, yield-adapter-manifest |
| Custom   | `public, s-maxage=300, max-age=300`    | dex-liquidity; telegram-pulse uses route-local `public, max-age=300, s-maxage=300`                                                                                  |
| Slow     | `public, s-maxage=3600, max-age=300`   | supply-history, bluechip-ratings, dex-liquidity-history, yield-history, safety-score-history, non-usd-share                                                        |
| Archive  | `public, s-maxage=86400, max-age=3600` | digest-snapshot, snapshots-index                                                                                                                                   |
| Public status | `public, max-age=60`             | public status history                                                                                                                                              |
| OG image | `public, max-age=900, s-maxage=900`    | dynamic Worker OG images (`/api/og/*`)                                                                                                                             |
| Reserve live | `public, s-maxage=3600, max-age=300` | `/api/stablecoin-reserves/:id` when live reserve rows are fresh enough for the requested presentation mode                                                       |
| Reserve live stale | `public, s-maxage=1800, max-age=120` | `/api/stablecoin-reserves/:id` when live reserve rows are stale but still usable for stale presentation                                                          |
| Reserve fallback | `public, s-maxage=300, max-age=60` | `/api/stablecoin-reserves/:id` fallback/static presentation mode                                                                                                  |
| No-store | `no-store`                            | admin GETs, bypassed status/control routes, and per-coin stale fallback responses                                                                                   |
| Immutable snapshot | `public, s-maxage=31536000, max-age=31536000, immutable` | route-local dated public snapshot payloads and per-stablecoin projections (`/api/snapshots/:date.json`, `/api/snapshot/:date/stablecoin/:id`) |

Admin `GET` routes are forced to `Cache-Control: no-store` either by `addAdminGetNoStoreHeader()` in `worker/src/router.ts` for registry-dispatched routes or by the admin route wrapper for dynamic admin handlers.

### D1 Read Snapshots And Pagination

- `GET /api/report-cards` serves the cron-published `cache["report-cards:snapshot"]` private cache envelope in the common path. The envelope pins a cache generation and Safety Score methodology version; if it is missing, malformed, generation-mismatched, or methodology-mismatched, the handler computes a fallback snapshot on read and returns the same public wire shape.
- `GET /api/yield-rankings` hydrates Safety Score fields from the same published report-card envelope, using compute-on-read only when the published snapshot cannot be loaded. The hourly publisher stages a yield publication generation, validates the rankings payload, and publishes the `yield-rankings` cache through CAS before replacing current `yield_data` rows. If the cache write fails or CAS skips because a newer cache exists, the prior published D1 rows remain visible to downstream readers; successful cache writes then persist current/history rows and compact selected-source decisions as `published` for that generation.
- `GET /api/stablecoin/:id` serves D1 detail rows from the per-coin cache. Rows inside the 5-minute TTL use the per-coin cache profile. Rows older than the TTL but under the 24-hour max-stale ceiling are served immediately with `Warning: 110`, `X-Data-Age`, and `Cache-Control: no-store`, then refreshed through an isolate-local per-coin single-flight background refresh. Rows older than 24 hours force a synchronous refresh path and are not used as stale fallback when refresh fails.
- Event feeds support bounded offset pagination plus opaque keyset cursors. `/api/depeg-events` caps `offset` at `50,000`; `/api/mint-burn-events` caps `offset` at `25,000`. Callers can pass `includeTotal=false` to skip exact count queries; the response then marks `totalExact: false`.

### External API Monitoring Baseline

When public API usage grows, monitor these three Cloudflare dimensions first:

1. **Per-endpoint request volume**
   - Track top paths by requests and trend (`/api/stablecoin/:id`, `/api/stablecoin-summary/:id`, `/api/stablecoins`, `/api/report-cards`).
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

- Pages Functions on `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, and subdomains of `stablecoin-dashboard.pages.dev` proxy same-origin `/_site-data/*` requests to the explicit `SITE_API_ORIGIN` target on every host (production and preview); when that binding is missing the proxy returns `500`. The lane also gates on the caller's `Origin` header (or `Referer` as a fallback); only `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, and subdomains of `stablecoin-dashboard.pages.dev` are accepted.
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
- `POST /api/bulk-dismiss-discovery-candidates`
- `POST /api/telegram-pending`
- `POST /api/admin-telegram-resend`
- `POST /api/admin-telegram-broadcast`

The worker fingerprints method + path + sorted query + body for a given action key. Replays return the stored response with `X-Idempotent-Replay: true`; conflicting reuse returns `409`. When handler execution throws, the worker first tries to clear the pending reservation so the same key can be retried normally. If that cleanup cannot be confirmed, it stores a deterministic failure replay for that key and subsequent repeats return a replayed `500` response until the reservation expires.

### Backfill Query Helper

**File:** `worker/src/lib/backfill-query.ts`

Backfill handlers reuse shared parsing/selection helpers for `stablecoin`, `batch`, and `batchSize` query params:

- `selectBackfillCoins(...)` resolves single-coin mode (`?stablecoin=<id>`) vs batched mode (`?batch=<n>[&batchSize=<n>]`) with bounded integer parsing.
- `noCoinsInBatchResponse()` returns the canonical no-op payload `{ "message": "No coins in this batch" }`.

Current consumers:

- `worker/src/api/backfill-cg-prices.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/backfill-depegs.ts`

### Module-Level State

Most module-level mutable state was eliminated in the parameter-passing refactor. Remaining intentional isolate-local state is allowlisted here:

| Module | State | Purpose | Reset / TTL behavior |
| --- | --- | --- | --- |
| `shared/lib/cloudflare-access-jwt.ts` | `jwksCache` | Cloudflare Access signing-key cache | 1-hour TTL; auth still re-fetches when cold or expired |
| `worker/src/lib/rate-limit.ts` | `IsolateLocalState` limiter/prune state | Public API limiter emergency counters and pending prune coordination | Resets on isolate recycle/deploy; D1 remains source of truth |
| `worker/src/lib/api-key-core.ts` | API-key cache, last-used throttle, per-key prune state | Short-lived key lookup cache and write-throttling for API-key metadata | 5-second fresh key cache TTL (entries are deleted on expiry, no stale window); usage updates are best-effort and D1 remains source of truth |
| `worker/src/lib/request-source-attribution.ts` | Worker route/source and per-key attribution buffers plus prune bucket/promise | Collapses same-route and same-key Worker attribution bursts into batched D1 upserts and avoids duplicate attribution-prune work inside one Worker isolate | Resets on isolate recycle/deploy; D1 remains source of truth |
| `functions/lib/request-attribution.ts` | Pages attribution buffer plus prune bucket/promise | Collapses same-route site-data attribution bursts into batched D1 upserts and avoids duplicate attribution-prune work inside one Pages Functions isolate | Resets on isolate recycle/deploy; D1 remains source of truth |

**Constraints:**

- State persists within one isolate but resets on cold starts, deployments, or isolate recycle.
- State is NOT shared across isolates.
- Each entry above is an optimization or local coordination aid; persistent correctness must come from D1, request inputs, or provider responses.

---

## Cron Scheduling

This worker declares 19 cron expressions in `worker/wrangler.toml`. Fetch-heavy lanes are split across separate trigger slots so they do not compete with the quarter-hourly core pipeline for the Workers per-trigger 6-connection fetch pool or share CPU budget with DB-only availability jobs.

Cron expressions are source-owned in `worker/wrangler.toml`. The canonical schedule-key mapping, status-tracked jobs, and connection-budget metadata live in `shared/lib/cron-jobs.ts`; dispatch chains live in `shared/lib/scheduled-runner-registry.ts`. `runScheduledSlotWithFence()` stores compact child-job summaries in `cron_slot_executions.metadata` (`jobsRun`, `jobsSkipped`, `jobsNeutralSkipped`, `jobsDegraded`, `jobsErrored`, `budgetOnlyJobs`, and per-job outcomes) and marks the slot `degraded` or `error` when children skip/degrade/fail even if best-effort execution lets later jobs continue. Neutral expected no-op children, such as an empty manual digest poll, are counted separately so they do not make a healthy slot look skipped. Run `npm run check:cron-sync` and `npm run check:cron-connections` after schedule or job-chain changes.

### Trigger 1: `*/15 * * * *` (every 15 minutes)

| Job                              | Function                                                                                   | File                                              | Documentation                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `sync-fx-rates`                  | `syncFxRates()`                                                                            | `worker/src/cron/sync-fx-rates.ts`                | [Data Pipeline](./data-pipeline.md), [Classification](./classification.md)   |
| `sync-stablecoins`               | `syncStablecoins()`                                                                        | `worker/src/cron/sync-stablecoins.ts`             | [Data Pipeline](./data-pipeline.md), [Depeg Detection](./depeg-detection.md) |
| `snapshot-supply` _(retry path)_ | `snapshotSupply()` (chained after `sync-stablecoins`)                                      | `worker/src/cron/snapshot-supply.ts`              | [Supply Snapshot Pipeline](./supply-snapshot.md)                             |
| `snapshot-chain-supply`          | `snapshotChainSupply()` (chained after `snapshot-supply`, DB-only, 0 external connections) | `worker/src/cron/snapshot-chain-supply.ts`        | [Supply Snapshot Pipeline](./supply-snapshot.md)                             |
| `publish-report-card-cache`      | `publishReportCardCache()` (chained after safe `sync-stablecoins`, DB-only)                | `worker/src/cron/publish-report-card-cache.ts`    | [Risk Lab](./report-cards.md), [Chains Page](./chains-page.md)               |
| `compute-depeg-resolver`         | `computeDepegResolver()` (resolves canonical incidents, seals/publishes DDR readiness/backstop outcomes, rebuilds DDRR) | `worker/src/cron/compute-depeg-resolver.ts`       | [Depeg Duration Resolver](./depeg-resolver.md)                               |
| _(inline)_                       | Stale-cache health alert                                                                   | `worker/src/handlers/scheduled/quarter-hourly.ts` | This doc (below)                                                             |

**Execution model:** Jobs in this slot are run sequentially in `worker/src/handlers/scheduled/quarter-hourly.ts` to respect the Workers shared 6-connection fetch pool per cron trigger. `sync-fx-rates` runs first so Chainlink / FX probes get a clean fetch window before the heavier stablecoin pricing pipeline consumes the slot budget. `sync-stablecoins` now reports explicit capability metadata:

- `capabilities.stablecoinsCache`
- `capabilities.depegPipeline`

`snapshot-supply` retry requires the stablecoins-cache capability. Both `snapshot-supply` and `snapshot-chain-supply` write once per UTC date, keyed on the `snapshotDate` stored in a `cache` table marker (`snapshot-supply:last-write` / `snapshot-chain-supply:last-write`), so the quarter-hourly slot produces exactly one snapshot per UTC day, written by the first healthy run after UTC midnight. `sync-stablecoins` runs the optional serialized GeckoTerminal soft-source probe under a 90-second cap that is clipped further when earlier phases run long, preserving a 90-second tail before the 8-minute stablecoin cron timeout. `publish-report-card-cache` also requires the stablecoins-cache capability and publishes both the full `report-cards:snapshot` envelope for common read paths and the smaller methodology-versioned score cache used by Chain Health/OG consumers, without relying on the yield cron. `compute-depeg-resolver` is DB-only after cache reads: it resolves canonical DDR incidents, evaluates forecast readiness, records healthy/unhealthy lock opportunities, seals one immutable `public_prediction` prediction or no-call per incident when the first healthy run observes readiness `>0.75` or when the first healthy run reaches the 72h backstop, finalizes first-publication manifests before projecting `cache["depeg-resolver:snapshot"]`, and rebuilds `cache["depeg-resolver-review:snapshot"]` from first-publication exposure, errata, and policy-universe coverage. Degraded readiness/backstop runs record `lock_deferred` state instead of freezing predictions/no-calls; incidents that recover or become terminal before a healthy lock are reported as pre-lock coverage outcomes; and publication failures surface as retry/failure coverage debt rather than public predictions. Repair-required DDR events are tracked through `cache["ddr:repair-debt:v1"]` and `/api/status` data-quality warnings instead of turning an otherwise published DDR run into a scheduler outage. Old `sticky-24h-v1` exposures remain reviewable with their original policy metadata. DDRR failures are reported in cron metadata without failing an already-written DDR snapshot unless the cron abort signal fires. `stability-index` and `compute-dews` run on the decoupled half-hourly DB-only trigger (Trigger 9). `sync-dex-liquidity` still refreshes every 30 minutes on its own lane, while `sync-stablecoin-charts` now uses a separate half-hourly charts trigger with the same 1-hour write cooldown, and `sync-yield-data` still publishes on its own hourly post-DEX trigger.

**Inline staleness alert:** After sync-stablecoins completes, if the `stablecoins` cache is older than 1800 seconds (30 min), `sendAlert()` fires a webhook notification. This is a health check — not a cron job itself.

### Trigger 2: `9,24,39,54 * * * *` (status self-check - isolated offset)

| Job                         | Function                       | File                                            | Documentation                             |
| --------------------------- | ------------------------------ | ----------------------------------------------- | ----------------------------------------- |
| `cron-slot-sweeper`         | `runCronSlotSweeper()`         | `worker/src/cron/cron-slot-sweeper.ts`          | [Status Dashboard](./status-dashboard.md) |
| `status-self-check`         | `runStatusSelfCheck()`         | `worker/src/cron/status-self-check.ts`          | [Status Dashboard](./status-dashboard.md) |
| `data-invariant-canary`     | `runDataInvariantCanary()`     | `worker/src/cron/data-invariant-canary.ts`      | This doc |
| `cron-staleness-watchdog`   | `runCronStalenessWatchdog()`   | `worker/src/cron/cron-staleness-watchdog.ts`    | [Status Dashboard](./status-dashboard.md) |

Dedicated quarter-hourly offset trigger for stale-slot sweeping, public/admin status probes, DB/cache-only data-invariant canaries, and freshness alerting. It runs at :09/:24/:39/:54 so status probes, structural checks, and Tier-1 cache staleness checks do not compete with the heavier quarter-hourly stablecoin pricing slot. `cron-slot-sweeper` runs first and reconciles stale `cron_slot_executions` across all schedule keys, writes `scheduled-slot-abandoned` event markers, synthesizes child `cron_runs` error rows for expired leases when needed, and sends a cooldown-gated alert when abandoned slots are closed before the next same schedule key fires. `status-self-check` then persists a compacted raw `/api/status` computation to `cache["status:raw-snapshot:v1"]` with a compare-and-swap write; `/api/status` serves that snapshot while it is no more than 30 minutes old and falls back to live computation when it is missing, stale, or unreadable. The compacted snapshot keeps each lane's latest run metadata for operator summaries while trimming older recent-run metadata, long strings, and large arrays before writing the cache row. When `WORKER_CANARY_MODE` is enabled, `data-invariant-canary` runs after the self-check and records structural findings for DEX publication rows, stablecoins cache active coverage, PSI/DEWS latest samples, and report-card cache methodology/freshness in `worker_canary_runs` without opening outbound connections. The DEX current-publication canary compares the latest published generation's row count to rows with that generation id and `publication_state = 'published'`; retained legacy or older published rows are recorded as metadata so inactive historical rows do not trip the active-set publication check.

The self-check now records separate internal and external probe planes. Internal probes use router-dispatched `GET` requests when the scheduled invocation has `ExecutionContext`, rotating the deeper public/admin probe set across up to three 15-minute buckets so every registered deep probe is covered within 45 minutes without adding scheduled fetch volume. Those probes isolate Worker routing, handler code, and dependency hydration, but intentionally bypass Cloudflare custom-domain routing, Access, public rate limiting, and edge cache. External production canaries always use real HTTPS through the production custom domains: public API health on `api.pharos.watch`, site API health on `site-api.pharos.watch` when `SITE_API_SHARED_SECRET` is configured, a site API access-gate check expecting `401` or `403` when that shared secret is absent, and an unauthenticated ops API gate check on `ops-api.pharos.watch`. The ops canary expects Access/admin blocking (`302` or `403`); other statuses are treated as route/gate failures. `/api/status` exposes the latest `probe.internal`, `probe.external`, and `probe.internalExternalDiscrepancy` values when the persisted probe row contains the split-plane details, and status alerts include that comparison segment. The watchdog reuses the same freshness-sentinel/table fallback status builder as `/api/health`, records producer/endpoint/availability thresholds on each observation, alerts through `ALERT_WEBHOOK_URL` only when watched availability-impacting caches exceed the availability budget, and dedupes stale alerts through the D1 `cache` table.

### Trigger 3: `3 */6 * * *` (blacklist — dedicated, every 6h)

| Job              | Function          | File                                | Documentation                               |
| ---------------- | ----------------- | ----------------------------------- | ------------------------------------------- |
| `sync-blacklist` | `syncBlacklist()` | `worker/src/cron/sync-blacklist.ts` | [Blacklist Tracker](./blacklist-tracker.md) |

Dedicated 6-hourly trigger for blacklist sync. Blacklist events are infrequent enough (~1–3 per week network-wide across the tracked issuer set) that 6h cadence is sufficient; the cursor advancement logic in `sync-blacklist.ts` is resilient to missed runs. Uses Etherscan for supported chains, chain RPC log scans (Alchemy/public fallback) for Base/Optimism/Avalanche/BSC, dRPC for historical L2 balance reads, and TronGrid for Tron (with TronGrid circuit breaker gating). Gets its own 6-connection pool and CPU budget.

### Trigger 4: `4,34 * * * *` (mint/burn critical — dedicated, every 30 min)

| Job              | Function                       | File                                | Documentation    |
| ---------------- | ------------------------------ | ----------------------------------- | ---------------- |
| `sync-mint-burn` | `syncMintBurn()` critical lane | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

Dedicated trigger for the critical mint/burn lane. Uses Alchemy JSON-RPC plus the Alchemy circuit breaker. Bridge-aware transaction context is batched at 20 transaction hashes per HTTP request with at most three concurrent batch requests, and timestamp/bridge-classification phases inherit the lane's 9-minute self-budget so a single high-volume config stops with partial-frontier diagnostics instead of hitting the 10-minute wrapper timeout. Moved from 20-minute to 30-minute cadence alongside the extended lane. `MINT_BURN_CRITICAL_LANE_INTERVAL_SEC` (in `worker/src/lib/mint-burn-health-config.ts`) anchors the public freshness SLA (`MAX_AGE = interval × 2`), which is therefore 60 minutes — still well inside the 6h operator-alert threshold.

### Trigger 5: `6 */2 * * *` (DEX discovery — dedicated, every 2h)

| Job                  | Function             | File                                            | Documentation                             |
| -------------------- | -------------------- | ----------------------------------------------- | ----------------------------------------- |
| `sync-dex-discovery` | `syncDexDiscovery()` | `worker/src/cron/dex-discovery/orchestrator.ts` | [DEX Liquidity Score](./dex-liquidity.md) |

Dedicated 2-hourly trigger for DEX pool discovery. Uses strictly sequential fetches (1 connection at a time) from CoinGecko/GeckoTerminal/DexScreener. Stages pools for later merge by `sync-dex-liquidity`. Pool discovery is slow-moving (new pools appear with new deployments, not intraday) and the orchestrator already tiers work across runs; 2h cadence keeps Tier-1 coins ≤2h stale while halving GT/CG/DS crawl traffic relative to the previous 30-min cadence. The lane is best-effort by design: a 12-minute shared budget plus 25-second per-coin cap force partial `degraded` completion before the Worker nears its platform wall-clock ceiling. Discovery reserves a D1 finalization tail before staging, cleanup, and telemetry writes so a long crawl can return controlled metadata rather than being killed during publication.

### Trigger 6: `13,43 * * * *` (mint/burn extended — dedicated, every 30 min)

| Job                       | Function                       | File                                | Documentation    |
| ------------------------- | ------------------------------ | ----------------------------------- | ---------------- |
| `sync-mint-burn-extended` | `syncMintBurn()` extended lane | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

This offset schedule exists so long-tail mint/burn backfill pressure cannot starve the critical lane (which runs at `4,34`, staggered 9 minutes earlier). It uses a separate `mint_burn_run_state.job` key (`sync-mint-burn-extended`) and warning-only coverage semantics. Moved from 20-minute to 30-minute cadence in the same change that bumped the critical lane.

### Trigger 7: `10,40 * * * *` (DEX liquidity — dedicated, every 30 min)

| Job                  | Function             | File                                            | Documentation                             |
| -------------------- | -------------------- | ----------------------------------------------- | ----------------------------------------- |
| `sync-dex-liquidity` | `syncDexLiquidity()` | `worker/src/cron/dex-liquidity/orchestrator.ts` | [DEX Liquidity Score](./dex-liquidity.md) |

**Execution model:** This slot is dedicated to `sync-dex-liquidity` so the heavy scoring path has a full scheduled invocation budget to itself. `sync-dex-liquidity` consumes initial DeFiLlama and Curve JSON bodies inside timeout-covered reads before later enrichment stages, and the `defillama-protocols` cache is a compact protocol-category snapshot rather than the full upstream payload. It still stages its protocol-native DEX fetchers only after Curve and subgraph enrichment have consumed their response bodies, and the newer Meteora / PancakeSwap / Slipstream lanes follow the same sequencing rule rather than overlapping the earlier fetch-heavy phase. UniV3 subgraph queries continue to run in parallel across chains for reduced wall-clock time. The direct-API phase is modeled at a 5-connection static peak because nested protocol fetchers can overlap inside the two-protocol phase cap; this remains below Cloudflare's 6-connection ceiling but is treated as full for new fetch-heavy work. Current-row publication is active-set scoped, so inactive tracked assets can remain in history without being mirrored into the public `dex_liquidity` current table. DEWS and PSI were moved to Trigger 9 so a platform-level DEX-liquidity CPU kill cannot starve the DB-only publication jobs.

`sync-dex-liquidity` metadata now tracks both row coverage and value coverage. In addition to `currentCoverage` / `previousCoverage`, the cron records `currentGlobalTvl`, `previousGlobalTvl`, top-10 covered TVL, row/value guard flags, current/previous coverage-class distribution, and persistence diagnostics (`generationId`, expected/candidate/current generation row counts, `placeholderRowsWritten`, orphan-row cleanup status, historical snapshot write status). The scorer writes candidate rows to `dex_liquidity_run_rows`, validates that the active-asset rows plus the `__global__` row are complete, and only then mirrors the generation into the public `dex_liquidity` table and marks the generation published. `/status` surfaces the coverage slice through the Liquidity Health card, while the raw cron metadata keeps the persistence diagnostics available for operator debugging.

While the run is leased, `cron_run_progress` now exposes DEX stage summaries for source loading, subgraph enrichment, protocol-native direct API fetches, pool processing, scoring, and persistence. Each stage carries `providerFamily`, `phase`, and relevant `countTotals` / fallback-source metadata so `/api/status` can show where a long DEX run is spending time without adding D1 table scans.

### Trigger 8: `16,46 * * * *` (stablecoin charts — dedicated, every 30 min)

| Job                      | Function                 | File                                        | Documentation    |
| ------------------------ | ------------------------ | ------------------------------------------- | ---------------- |
| `sync-stablecoin-charts` | `syncStablecoinCharts()` | `worker/src/cron/sync-stablecoin-charts.ts` | This doc (below) |

**Execution model:** This slot is dedicated to `sync-stablecoin-charts`. Successful writes are still capped at once per hour via `stablecoin-charts:last-write`, so alternate runs return `cooldown_active` immediately. The dedicated lane keeps the lightweight chart refresh from consuming the same invocation budget as DEX scoring while preserving the existing publish cadence.

### Trigger 9: `26,56 * * * *` (DEWS / PSI / Tape — DB-only, every 30 min)

| Job               | Function                          | File                                 | Documentation                                  |
| ----------------- | --------------------------------- | ------------------------------------ | ---------------------------------------------- |
| `compute-dews`    | `computeAndStoreDEWS()`           | `worker/src/cron/compute-dews.ts`    | [DEWS](./dews.md)                              |
| `stability-index` | `computeAndStoreStabilityIndex()` | `worker/src/cron/stability-index.ts` | [Pharos Stability Index](./stability-index.md) |
| `project-tape`    | `projectTape()`                   | `worker/src/cron/project-tape.ts`    | [Tape / Timeline](./tape-page.md)              |

**Execution model:** The slot runs `compute-dews`, `stability-index`, then `project-tape` as DB-only jobs. It is offset sixteen minutes after the `10,40` DEX-liquidity slot so normal DEX runs can publish fresh liquidity inputs first, but it remains a separate scheduled invocation. If DEX-liquidity overruns CPU budget or is killed by the platform, this slot still runs against the last available tables and records any stale DEX-liquidity input as degraded source coverage plus `dependencies.dexLiquidity` publication-generation diagnostics in DEWS metadata. The cron-staleness watchdog also emits a DEX-to-DEWS recovery check so operators can distinguish a recovered DEX root from a downstream DEWS catch-up delay. The tape projector materializes timeline events from already-written source tables after those risk computations finish; snapshot-style projectors fetch prior rows with grouped D1 queries instead of per-coin lookup loops, and cron progress records the active tape class during a run.

### Trigger 10: `11 */4 * * *` (every 4h at :11 — reserve + redemption lane)

| Job                         | Function                    | File                                           | Documentation                                     |
| --------------------------- | --------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `sync-live-reserves`        | `syncLiveReserves()`        | `worker/src/cron/sync-live-reserves.ts`        | This doc (below)                                  |
| `sync-redemption-backstops` | `syncRedemptionBackstops()` | `worker/src/cron/sync-redemption-backstops.ts` | [Redemption Backstops](./redemption-backstops.md) |
| `sync-kinesis-supply`       | `syncKinesisSupply()`       | `worker/src/cron/sync-kinesis-supply.ts`       | This doc (below)                                  |
| `reserve-post-sync-watchdog` | reserve drift/cache checks | `worker/src/handlers/scheduled/hourly-live-reserves.ts` | This doc (below)                                  |

**Connection budget:** dedicated 4-hourly trigger for reserve and redemption tuning. Jobs run sequentially so live reserve adapters finish before redemption backstop sync consumes reserve metadata. Kinesis supply sync adds 2 sequential HTTP fetches (1 connection peak). The named `reserve-post-sync-watchdog` child records the former post-child drift/cache/stale-source work in `cron_runs`, honors the slot abort signal, writes the Telegram reserve-drift snapshot, and sends stale-reserve alerts when the adapter lane has missed roughly three 4-hourly runs. Moved from hourly to 4-hourly because most reserve attestations (Chainlink PoR, Ethena, Tether transparency, etc.) update daily or weekly — hourly polling was wasted RPC + HTTP traffic. `LIVE_RESERVE_FRESHNESS_SEC = 48h` at the API layer keeps consumer-facing "fresh" classification unaffected.

### Trigger 11: `20 * * * *` (hourly at :20 — core yield publication)

| Job               | Function          | File                                                                  | Documentation                                 |
| ----------------- | ----------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `sync-yield-data` | `syncYieldData()` | `worker/src/cron/sync-yield-data.ts` + `worker/src/cron/yield-sync/*` | [Yield Intelligence](./yield-intelligence.md) |

**Connection budget:** dedicated hourly trigger for the core publisher. The job consumes cached DEX pools plus the cached supplemental yield snapshot, keeps deterministic on-chain reads to a single in-flight lane, and is allowed a larger app-level timeout because it no longer shares the half-hourly slot.

`sync-yield-data` reports in-flight progress for preflight, state loading, source resolution, evaluation, coverage-guard decisions, and publication. Progress metadata includes the provider family (`yield`, `yield-source-cache`, or `yield-publication`), phase, tracked-yield count totals, supplemental fallback mode, degradation reasons, and cache/published-generation state.

### Trigger 12: `25 */4 * * *` (every 4 hours at :25 — yield supplemental lane)

| Job                       | Function                  | File                                         | Documentation                                 |
| ------------------------- | ------------------------- | -------------------------------------------- | --------------------------------------------- |
| `sync-yield-supplemental` | `syncYieldSupplemental()` | `worker/src/cron/sync-yield-supplemental.ts` | [Yield Intelligence](./yield-intelligence.md) |

**Connection budget:** dedicated multi-hour trigger for the heavier optional yield families (Morpho, Pendle, Yearn/Kong, Beefy, Compound V3, Aave V3, Royco Dawn). It writes a cache snapshot that the hourly publisher consumes, so protocol-API stalls reduce optional coverage instead of blocking `yield-rankings`.

`sync-yield-supplemental` reports source-family fetch, dedupe, aggregate-cache, per-family cache, and completion stages. Per-family cache stages include a `cursor.family` value plus source-family count totals, and completion metadata includes `sourceCoverage.sourceFamilyCounts` for emitted candidates, `sourceCoverage.sourceFamilyInventoryCounts` for audit inventory probes, and `sourceCoverage.sourceFamilySummaries` with compact per-family status, emitted counts, inventory counts, budget flags, cap flags, and bounded missing-target examples. This keeps optional-yield stalls diagnosable from `/api/status` while still relying on the same cache writes the job already performs.

### Trigger 13: `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` (Telegram dispatch — dedicated, every 5 min)

| Job                        | Function                   | File                                          | Documentation                              |
| -------------------------- | -------------------------- | --------------------------------------------- | ------------------------------------------ |
| `dispatch-telegram-alerts` | `dispatchTelegramAlerts()` | `worker/src/cron/dispatch-telegram-alerts.ts` | [Telegram Alert Bot](./telegram-alerts.md) |
| `telegram-degradation-watchdog` | `runTelegramDegradationWatchdog()` | `worker/src/cron/telegram-degradation-watchdog.ts` | [Telegram Alert Bot](./telegram-alerts.md) |
| `telegram-disambiguation-cleanup` | `cleanExpiredDisambiguations()` | `worker/src/api/telegram-store/disambiguation.ts` | [Telegram Alert Bot](./telegram-alerts.md) |
| `telegram-pulse-snapshot` | `publishTelegramPulseSnapshot()` | `worker/src/api/telegram-pulse.ts` | [Telegram Alert Bot](./telegram-alerts.md) |

Dedicated trigger for Telegram work. Isolated from the quarter-hourly pipeline so subscriber fan-out gets its own 6-connection pool and CPU budget. Before status-tracked jobs run, the slot best-effort reconciles Telegram command suggestions, bot profile metadata, the default Mini App menu button, and webhook registration when a bot token is configured. Those serial Bot API calls are modeled as the budget-only `telegram-registration-reconciliation` entry in `CRON_CONNECTION_BUDGET_ENTRIES`; they are not separate `cron_runs` rows, but each slot writes compact cache-backed telemetry that `/api/status.budgetOnlySurfaces` exposes. Subscriber fan-out uses up to 4 of 6 available connections for parallel `sendBatch()` sends. Up to 3,600 subscriber message attempts per run; `dispatch-telegram-alerts` still has a 14-minute hard app timeout and 30-second lease heartbeat, but pending-drain and fresh-send loops stop starting Telegram batches after a 4-minute soft deadline, releasing unattempted pending claims or queueing the untouched fresh tail so slow Bot API runs yield the next 5-minute trigger interval. Discovery writes durable alert job/target manifests, target statuses reconcile by dedupe key, and overflow/retryable fresh-send failures are enqueued to claim-based `telegram_pending_alerts` rows in D1 for subsequent runs. After alert dispatch, the watchdog records Telegram degradation signals, the DB-only `telegram-disambiguation-cleanup` sidecar prunes expired mid-conversation state, and `telegram-pulse-snapshot` publishes the public pulse cache so `/api/telegram-pulse` is snapshot-first in the common path.

Safety-grade fan-out on this lane is now gated by the generation-aware live source cache `cache["alert:safety-source-cache"]`, written only by `publish-report-card-cache`. If that source is missing, corrupt, stale, or from the wrong generation, only safety alerts are suppressed; DEWS/depeg/launch alerts continue. The same cache row carries optional compact `explain` snapshots for safety-alert `Reason:` lines; the worker test suite enforces the current serialized-size budget.

`dispatch-telegram-alerts` now reports circuit-check, source-loading, snapshot-seed, event-detection, pending-drain, fanout-load, delivery, and completion stages. The metadata includes provider families, event/pending count totals, cursor state for the pending queue, and a `deferredTail` summary (`total`, `due`, `deferred`, `expired`, `nearTtl`, oldest pending age, estimated drain time) sourced from the existing pending-capacity reads.

### Trigger 14: `*/5 * * * *` (manual digest trigger poll)

| Job surface | Function | File | Documentation |
| ----------- | -------- | ---- | ------------- |
| `daily-digest` lease consumer | `runDigestTriggerPollSlot()` | `worker/src/handlers/scheduled/digest-trigger-poll.ts` | [Digest Pipeline](./digest-pipeline.md) |

This slot polls the `digest:force-run-request` cache key written by `POST /api/trigger-digest`. When a request is pending, it runs `generateDailyDigest(db, anthropicApiKey, buildTwitterCreds(env), true, buildTelegramCreds(env), signal, reportProgress)` under the existing `daily-digest` lease, clears or preserves the flag according to the lease outcome, and writes `digest:last-trigger-result` for the ops UI. It also records every poll, including the expected no-pending-request path, under the budget-only `digest-trigger-poll` telemetry key surfaced by `/api/status.budgetOnlySurfaces`. It is a runner slot, not a separate status-tracked cron job. `npm run check:cron-connections` still models it as the budget-only `digest-trigger-poll` entry with the same one-connection peak used by the daily digest chain.

Forced digest runs inherit the `daily-digest` progress stream, including preflight, input collection, Anthropic generation, persistence, and delivery stages. Twitter/X and Telegram digest delivery both atomically claim same-day idempotency markers before posting and roll those markers back only when delivery fails; if a marker claim fails, the channel aborts before sending so a cache outage cannot create duplicate digests on the next run.

### Trigger 15: `0 8 * * *` (daily at 08:00 UTC — snapshots & lightweight fetchers)

| Job                             | Function                       | File                                               | Documentation                                    |
| ------------------------------- | ------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| `snapshot-supply`               | `snapshotSupply()`             | `worker/src/cron/snapshot-supply.ts`               | [Supply Snapshot Pipeline](./supply-snapshot.md) |
| `snapshot-safety-grade-history` | `snapshotSafetyGradeHistory()` | `worker/src/cron/snapshot-safety-grade-history.ts` | [Risk Lab](./report-cards.md)                    |
| `snapshot-psi`                  | `snapshotPsiDaily()`           | `worker/src/cron/snapshot-psi.ts`                  | [Pharos Stability Index](./stability-index.md)   |
| `snapshot-public-dataset`       | `snapshotPublicDataset()`      | `worker/src/cron/snapshot-public-dataset.ts`       | This doc (below)                                 |
| `sync-usds-status`              | `syncUsdsStatus()`             | `worker/src/cron/sync-usds-status.ts`              | This doc (below)                                 |
| `fetch-tbill-rate`              | `fetchTbillRate()`             | `worker/src/cron/fetch-tbill-rate.ts`              | [Yield Intelligence](./yield-intelligence.md)    |

**Connection budget:** snapshot jobs are D1-only (0 external connections). `snapshot-supply` and `snapshot-public-dataset` receive the scheduled slot start as a stablecoins-cache freshness floor, so the 08:00 fallback cannot write from the previous 07:45 quarter-hourly cache while the fresh 08:00 `sync-stablecoins` run is still publishing. `snapshot-public-dataset` runs after the safety-grade and PSI daily snapshots, waits and reloads the stablecoins cache up to four times over an 8-minute retry window when it only sees a pre-slot cache row, and then freshness-gates its report-card and PSI inputs before writing the immutable dated public snapshot row; if DEWS or DEX section reads fail, the run returns `degraded` with explicit `missingSections` metadata and does not insert a partial public snapshot. Its app-level cron timeout is 10 minutes to leave D1/compression tail room after the cache wait. `fetch-tbill-rate` (NY Fed, ECB, FRED, Treasury, SIX, and central-bank benchmark fetches, still serialized inside one job) and `sync-usds-status` (Etherscan) are chained sequentially on the external-fetch branch to keep this trigger conservative on connection use. A failed `fetch-tbill-rate` run no longer suppresses `sync-usds-status`; peak external usage is 1 connection. `fetch-tbill-rate` also tracks the GBP SONIA retained-fallback streak in `cache["fetch-tbill-rate:gbp-retained-fallback-streak"]`; after 2 consecutive daily `gbp-sonia-compounded-index-failed-retained` runs it emits the shared webhook alert and a `cron:event:fetch-tbill-rate:gbp-retained-fallback-repeated` event. The 24-hour re-alert cooldown starts only after the webhook send succeeds, so transient webhook failures remain retryable on the next run.

### Trigger 16: `5 8 * * *` (daily at 08:05 UTC — digest and Bluechip fetchers)

| Job              | Function                | File                                | Documentation                           |
| ---------------- | ----------------------- | ----------------------------------- | --------------------------------------- |
| `sync-bluechip`  | `syncBluechip()`        | `worker/src/cron/sync-bluechip.ts`  | This doc (below)                        |
| `daily-digest`   | `generateDailyDigest()` | `worker/src/cron/daily-digest.ts`   | [Digest Pipeline](./digest-pipeline.md) |
| `weekly-recap`   | `generateWeeklyRecap()` | `worker/src/cron/weekly-recap.ts`   | [Digest Pipeline](./digest-pipeline.md) |

**Connection budget:** `sync-bluechip` (3 parallel batch connections) and `daily-digest` / `weekly-recap` (1 long-lived Anthropic API call at a time because the recap is chained after the daily digest) use <=4 concurrent external connections. The 5-minute offset from Trigger 14 ensures PSI snapshot data is available for the daily digest without an explicit chain dependency. `weekly-recap` runs Monday-only and returns immediately on other days. Reliability is failure-contained at the job level for this slot: a thrown `sync-bluechip`, `daily-digest`, or `weekly-recap` run is recorded independently and no longer aborts the rest of the 08:05 lane before the remaining jobs can settle.

`daily-digest` and `weekly-recap` report digest-specific in-flight stages for preflight, input collection, Anthropic generation, persistence, Telegram/Twitter delivery, skips, and completion. Metadata includes provider family, phase, prompt/input counts, quality issue counts, delivery status, and weekly cursor boundaries where relevant.

### Trigger 17: `10 8 * * *` (daily at 08:10 UTC — coverage discovery)

| Job              | Function             | File                                | Documentation                       |
| ---------------- | -------------------- | ----------------------------------- | ----------------------------------- |
| `discovery-scan` | `runDiscoveryScan()` | `worker/src/cron/discovery-scan.ts` | [Data Pipeline](./data-pipeline.md) |

**Connection budget:** isolated daily trigger for the weekly CoinGecko stablecoin category scan. The job runs Monday-only and returns immediately on other days; isolating it keeps the 08:05 digest/Bluechip lane at 4/6 peak connections.

### Trigger 18: `0 6 1 * *` (monthly at 06:00 UTC on the 1st)

| Job                    | Function                  | File                                      | Documentation                                 |
| ---------------------- | ------------------------- | ----------------------------------------- | --------------------------------------------- |
| `yield-coverage-audit` | `runYieldCoverageAudit()` | `worker/src/cron/yield-coverage-audit.ts` | [Yield Intelligence](./yield-intelligence.md) |

Runs once a month on the 1st at 06:00 UTC. Scans unmatched high-TVL DeFiLlama pools and flags missing protocols as high-confidence or review-needed expansion candidates.

### Trigger 19: `0 3 * * *` (daily at 03:00 UTC — TTL pruning)

| Job                       | Function                    | File                                             | Documentation            |
| ------------------------- | --------------------------- | ------------------------------------------------ | ------------------------ |
| `prune-status-probe-runs` | `runPruneStatusProbeRuns()` | `worker/src/cron/prune-status-probe-runs.ts`     | [Status Dashboard](./status-dashboard.md) |
| `prune-cron-history`      | `runPruneCronHistory()`     | `worker/src/cron/prune-cron-history.ts`          | This doc                 |
| `worker-repair-runner`    | `runRepairTaskRunner()`     | `worker/src/cron/repair-task-runner.ts`          | This doc                 |
| `prune-detail-cache`      | `runPruneDetailCache()`     | `worker/src/cron/prune-detail-cache.ts`          | This doc                 |
| `telegram-inactive-cleanup` | `runTelegramInactiveCleanup()` | `worker/src/cron/telegram-inactive-cleanup.ts` | [Telegram Alert Bot](./telegram-alerts.md) |
| `telegram-retention-cleanup` | `runTelegramRetentionCleanup()` | `worker/src/cron/telegram-retention-cleanup.ts` | [Telegram Alert Bot](./telegram-alerts.md) |
| `mint-burn-growth-watchdog` | `runMintBurnGrowthWatchdog()` | `worker/src/cron/mint-burn-growth-watchdog.ts` | [Mint/Burn Flows](./mint-burn-flows.md) |
| `cron-duration-watchdog` | `runCronDurationWatchdog()` | `worker/src/cron/cron-duration-watchdog.ts` | This doc |

Housekeeping slot. `prune-status-probe-runs` enforces the status-probe retention window, `prune-cron-history` deletes `cron_runs` rows older than 7 days, terminal `worker_job_attempts` / `worker_repair_tasks` rows older than 7 days, and `cron_slot_executions` rows older than 14 days. `worker-repair-runner` then runs the `WORKER_REPAIR_RUNNER_MODE`-gated, DB-only repair-task consumer: off is a no-op, shadow reads due/stale backlog counts only, and enabled claims at most five due rows before closing already-resolved DDR repair tasks or deferring unresolved manual DDR repairs for a later pass. `prune-detail-cache` deletes `detail:*` cache rows whose coin id is no longer in `READABLE_IDS` (orphans incl. legacy numeric keys) or whose row is older than 7 days (demand-refreshed rows past 24h force the cold-miss refresh on access anyway), `telegram-inactive-cleanup` trims inactive Telegram subscriber state, and `telegram-retention-cleanup` prunes Telegram dead letters, alert-job audit rows, usage aggregates, chat diagnostics, and processed-update dedupe rows. Telegram retention deletes are capped per table per run and expose per-table `cappedAtLimit` metadata so backlog pressure is visible without letting the shared TTL lane run unbounded DELETEs. `mint-burn-growth-watchdog` counts `mint_burn_events` rows against the append-only growth budget (alert threshold 2.3M rows ≈ the agreed ~5 GB D1 revisit point) and webhook-alerts with a 7-day redelivery cooldown when exceeded. `cron-duration-watchdog` now reports two separate 7-day signals: job runtime budget pressure from `cron_runs`, and scheduled-slot abandonment from `cron_slot_executions`. Runtime pressure excludes synthetic child rows whose metadata reason is `stale-slot-reconciled`, and still alerts when a job's average crosses 80% of its explicit `CRON_TIMEOUT_MS` ceiling, hits that cap 3+ times, or records 3+ `runBudgetTruncated` runs. Slot abandonment alerts when a runner slot, especially `hourlyYieldSync`, repeatedly stops heartbeating and is reconciled later as abandoned, but only after at least 3 abandoned slots, a 10% abandonment ratio in the 7-day lookback, and at least one abandoned slot in the last 24 hours. Older high-ratio abandonment remains visible in watchdog metadata for trend review without degrading the watchdog. Low-ratio abandonment also remains metadata-only. Both signals share the 7-day webhook cooldown. The scheduled-runner contract test requires every `CRON_JOB_DEFINITIONS` entry to have a positive finite `CRON_TIMEOUT_MS` budget, so new status-tracked jobs cannot silently inherit an unwatched default.

### Cron Slot Capacity and Connection Pool Budget

Workers enforce a **6 concurrent fetch connections** limit per cron trigger invocation. All jobs sharing a trigger slot share this pool. Exceeding 6 causes `fetch()` to queue or fail.

`npm run check:cron-connections` reads `shared/lib/cron-jobs.ts` and sums peak `connectionGroup` usage, so sequential chains count by their maximum in-chain fetch width rather than by adding every chained job together.

Use `npm run check:cron-connections` for the live per-slot budget report. It includes the budget-only `digest-trigger-poll` and Telegram registration reconciliation entries even though those surfaces do not create separate `/api/status` job rows.

Fetch-heavy provider phases should use `worker/src/lib/provider-execution.ts` for lane permits, provider-local permits, timeout signal composition, circuit gating, and response-body policy. `createProviderExecutionContextForJob()` derives the lane ceiling from `CRON_CONNECTION_BUDGET_ENTRIES` and refuses budgets above the repo's 5/6 headroom-full limit. The first production pilot is the `sync-dex-liquidity` direct API phase: it keeps the existing two-provider fetch cap, wraps each protocol provider in a provider policy, and records circuit outcomes through the existing `circuit:<source>` breaker keys.

**Policy for new jobs:**

- Jobs requiring <=1 external connection may share any slot with headroom >=2.
- Jobs requiring >2 concurrent connections should get a dedicated trigger slot.
- Never add a fetching job to a slot with headroom <=1.

### Cron Error Handling Policy

Shared cron behavior is narrower than a single worker-wide tier system:

- `runLeasedCron(...)` / `logCronRun(...)` record `ok`, `error`, and lease-skip outcomes per job in `cron_runs`
- thrown job errors trigger `sendAlert()` and are re-thrown unless the scheduled slot catches them locally to keep sibling jobs running
- retries, degraded returns, no-write fallbacks, and cooldowns are job-specific rather than enforced by one shared classification layer
- fire-and-forget cleanup work may use `.catch()` when failure should not crash the main cron path

There is no shared 10-minute alert-dedup layer in the worker today. Any cooldown or dedupe behavior is implemented by individual jobs when needed.

## Telegram Alert Bot

- Webhook ingress (`POST /api/telegram-webhook`) receives Telegram commands and writes subscriber/subscription state into D1.
- `dispatch-telegram-alerts` diffs DEWS/depeg/safety state plus launch promotions against cached snapshots before fan-out on a dedicated 5-minute cron slot.
- `daily-digest` now appends pending cemetery additions and newly tracked coins to the next Telegram digest post after a deploy.
- Telegram sends are gated by the `telegram-api` circuit breaker to avoid hammering the Bot API during upstream issues.
- Each dispatch run sends up to 3,600 Telegram message attempts in parallel batches of 4 under a 14-minute hard timeout; pending-drain and fresh-send batches stop after a 4-minute soft deadline. Unattempted pending claims are released, and untouched fresh tails are queued. Overflow and retryable fresh-send failures are enqueued to claim-based `telegram_pending_alerts` rows for subsequent runs.
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
  alertFn?: (title: string, message: string) => Promise<unknown> | void,
  options?: { slotStartedAt?: number | null },
): Promise<CronResult | void>;
```

**Behavior:**

- Records start time (Unix seconds)
- Records the normalized slot timestamp (`slot_started_at`) alongside per-job history/progress rows
- Exposes a `reportProgress(...)` callback; leased jobs now emit wrapper-owned milestones (`started`, `lease-acquired`, `completed`, timeout/skip states when applicable) before any cron-specific progress stages
- Executes the job function
- On normal completion: inserts row into `cron_runs` with `status = resolvedResult.status ?? "ok"`, `item_count`, and `metadata`; returned statuses such as `degraded`, `skipped_locked`, `skipped_neutral`, or `error` are preserved
- On lease contention: inserts row with `status='skipped_locked'` and lease metadata
- On error: inserts row with `status='error'` and error message, calls `sendAlert()`, re-throws
- On completion/error of a progress-reporting job: clears the corresponding `cron_run_progress` row
- Returns the job's `CronResult` when the handler provides one
- History pruning is handled by the daily `prune-cron-history` job on `0 3 * * *`, not by `logCronRun()` inline. That job deletes `cron_runs` rows older than 7 days, terminal `worker_job_attempts` / `worker_repair_tasks` rows older than 7 days, and `cron_slot_executions` rows older than 14 days.

**Schema:** `cron_runs(job, started_at, duration_ms, status, item_count, metadata, error, slot_started_at)`

### In-flight Cron Progress

Long-running leased jobs can now surface active progress through `cron_run_progress`, which powers `/api/status` while the run is still live. Long-job heartbeats renew every 30 seconds and tolerate at most three consecutive renewal failures before the wrapper aborts controlled work. The status handler cross-checks that progress row against an active matching `cron_leases` entry before exposing it as `crons[*].inFlight`, so orphaned progress from a hard-killed invocation no longer masquerades as a live run. Suppressed orphaned progress rows and expired leases are exposed separately as `crons[*].staleArtifacts` plus summary counters.

`sync-stablecoins` now uses those cron-specific progress stages to expose its major pipeline boundaries (`intake`, `price-enrichment`, `price-validation`, `staleness-check`, `cache-write`, `depeg-pipeline`, plus fallback equivalents) instead of remaining opaque for the full quarter-hourly wall-clock.

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
- `sync-dex-liquidity`
- `sync-yield-data`
- `sync-yield-supplemental`
- `daily-digest`
- `weekly-recap`
- `dispatch-telegram-alerts`

### Per-Job Cron Timeouts

Each cron job receives an `AbortSignal` from `logCronRun()` that fires after a configurable timeout. Jobs that exceed their timeout are aborted and logged with `status='error'`. The signal is threaded through to `fetchWithRetry()` so that in-flight HTTP requests are also cancelled.

Some long-running jobs also enforce their own earlier wall-clock guard so they can return controlled metadata instead of hard-failing at the wrapper timeout. `sync-blacklist`, for example, self-stops after 10 minutes and avoids starting a new config when fewer than 60 seconds remain. `sync-live-reserves` keeps a 9-minute internal cursoring budget inside its 12-minute wrapper so deferred-tail state, cleanup, and cron logging have at least two minutes of headroom. `sync-mint-burn` and `sync-mint-burn-extended` keep a 9-minute self-budget inside their 10-minute wrapper timeout, pass that deadline into `eth_getLogs`, and skip the remaining config tail once fewer than 60 seconds remain for another config. A small blacklist skipped contract tail within the current bounded tolerance (15% of configs, capped at 10 contracts) is reported without degrading the run by itself, while subrequest exhaustion, incomplete scans, or larger skipped tails remain degraded budget pressure.

| Job                       | Timeout | Reason                                                                                                                                                                                                    |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default                   | 5 min   | Standard jobs complete in <60s                                                                                                                                                                            |
| `sync-stablecoins`        | 8 min   | Core quarter-hour pipeline entrypoint now includes N-source weighted primary pricing, supplemental overlays, multi-pass enrichment, and depeg processing; explicit headroom avoids timing out on bounded fallback work |
| `sync-dex-liquidity`      | 13 min  | 150+ pool crawl, with headroom below the platform wall-clock limit                                                                                                                                        |
| `sync-dex-discovery`      | 13 min  | Multi-source pool staging with explicit 12-minute self-budget so the wrapper still has headroom to log a controlled degraded/error result                                                                 |
| `sync-blacklist`          | 12 min  | Multi-chain scan + balance enrichment; isolated trigger allows extended runtime                                                                                                                           |
| `weekly-recap`            | 12 min  | Weekly Anthropic recap, chained after the daily digest on Mondays                                                                                                                                         |
| `sync-live-reserves`      | 12 min  | Multi-adapter reserve fetching with per-adapter timeouts                                                                                                                                                  |
| `sync-mint-burn`          | 10 min  | Multi-contract EVM log scan; isolated trigger allows extended runtime, with a 9-minute internal guard before the wrapper timeout                                                                          |
| `sync-mint-burn-extended` | 10 min  | Long-tail mint/burn lane with its own run-state and the same 9-minute internal guard                                                                                                                       |
| `sync-yield-data`         | 10 min  | Multi-source yield data aggregation                                                                                                                                                                       |
| `sync-yield-supplemental` | 12 min  | Supplemental yield source sync; runs less frequently but covers more sources per invocation                                                                                                               |
| `dispatch-telegram-alerts` | 14 min | Dedicated Telegram fan-out lane with a 4-minute send-loop soft deadline, leaving scheduled-event headroom for pending enqueue/release, sidecars, and logging                                             |
| `daily-digest`            | 14 min  | Expanded LLM generation + persistence/distribution, still below the 15-minute scheduled-trigger ceiling                                                                                                   |

Configuration: `CRON_TIMEOUT_MS` record in `worker/src/lib/cron-lease.ts`.

### Circuit Breakers

Most high-risk external integrations are protected by per-source circuit breakers (`worker/src/lib/circuit-breaker.ts`). State is persisted in the D1 `cache` table under keys like `circuit:defillama-stablecoins`. Breaker writes also maintain the aggregate `cache["provider:circuit:index"]` row as best-effort telemetry; individual `circuit:<source>` rows remain the execution and `/api/status.providerCircuitHealth` source of truth, and `/api/reset-circuit-breaker` removes both the source row and its index entry. Bounded low-volume fallbacks such as gold-api.com metal spot quotes, the secondary FX mirror, and ExchangeRate-API daily reference snapshots use explicit retry/timeout/cooldown behavior but are not currently circuit-gated.

- **Open threshold**: 3 consecutive failures
- **Probe interval**: 30 minutes (one request allowed to test recovery)
- **Alerts**: Webhook alert fires on open and close transitions
- **Health impact**: 3 or more public-impact open circuits degrade `/api/health`; scoped `live-reserves:*` breakers plus `dexscreener-liquidity` and `dexscreener-search` are excluded from that public-health count, while smaller or excluded circuit failures still surface in the circuit list

Sources tracked (defined in `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`):

| Source key                           | Cache key                     | Used by                                                                                                                   |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `DL_STABLECOINS`                     | `defillama-stablecoins`       | `sync-stablecoins`                                                                                                        |
| `DL_STABLECOIN_DETAIL`               | `defillama-stablecoin-detail` | `GET /api/stablecoin/:id` (DefiLlama detail upstream)                                                                     |
| `DL_COINS`                           | `defillama-coins`             | `enrich-prices`, supplemental CoinGecko-id mirror pricing                                                                 |
| `DL_YIELDS`                          | `defillama-yields`            | `sync-yield-data`, `sync-dex-liquidity`                                                                                   |
| `DL_PROTOCOLS`                       | `defillama-protocols`         | `sync-dex-liquidity`, supplemental gold protocol mcap/TVL fetches                                                         |
| `CG_PRICES`                          | `coingecko-prices`            | `enrich-prices`                                                                                                           |
| `CG_DETAIL_PLATFORMS`                | `coingecko-detail-platforms`  | `GET /api/stablecoin/:id` (CoinGecko-only detail provider)                                                                |
| `CG_MCAP`                            | `coingecko-mcap`              | `sync-stablecoins` (CG supply fallback)                                                                                   |
| `CG_DISCOVERY`                       | `coingecko-discovery`         | `discovery-scan`                                                                                                          |
| `CG_ONCHAIN`                         | `coingecko-onchain`           | `enrich-prices` CoinGecko Pro onchain exact-address augmentation plus `dex-discovery` Stage 1 onchain pool crawl          |
| `CMC_PRICES`                         | `coinmarketcap-prices`        | `enrich-prices` pass 2 fallback                                                                                           |
| `DEXSCREENER_PRICES`                 | `dexscreener-prices`          | `enrich-prices` exact token-address DexScreener fallback                                                                  |
| `DEXSCREENER_LIQUIDITY`              | `dexscreener-liquidity`       | Optional DexScreener DEX liquidity/discovery pool lookups; excluded from public-impact breaker counts                     |
| `DEXSCREENER_SEARCH`                 | `dexscreener-search`          | Legacy `enrich-prices` addressless unique-symbol DexScreener search fallback; retired for new sync runs                  |
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
| `PROTOCOL_REDEEM`                    | `protocol-redeem`             | External live RPC-backed authoritative `protocol-redeem` overrides                                                        |
| `CURVE_ONCHAIN`                      | `curve-onchain`               | `enrich-prices` primary consensus                                                                                         |
| `CURVE_ORACLE`                       | `curve-oracle`                | `enrich-prices` crvUSD Curve oracle consensus                                                                             |
| `CURVE_LIQUIDITY_API`                | `curve-liquidity-api`         | `sync-dex-liquidity` (Curve pool liquidity fetch)                                                                         |
| `FX_FRANKFURTER`                     | `fx-frankfurter`              | `sync-fx-rates` primary Frankfurter API circuit breaker                                                                   |
| `FX_REALTIME`                        | `fx-realtime`                 | `sync-fx-rates` real-time FX cross-validation                                                                             |
| `CHAINLINK_FEEDS`                    | `chainlink-feeds`             | `sync-fx-rates` Chainlink on-chain FX feed probes                                                                         |
| `JUPITER_PRICES`                     | `jupiter-prices`              | `enrich-prices` pass 3 Solana price fallback                                                                              |
| `GECKO_TERMINAL_PROBE`               | `geckoterminal-probe`         | `enrich-prices` GeckoTerminal price probe fallback                                                                        |
| `FLUID_DEX_API`                      | `fluid-dex-api`               | `sync-dex-liquidity` direct Fluid DEX fetcher                                                                             |
| `BALANCER_API`                       | `balancer-api`                | `sync-dex-liquidity` direct Balancer API fetcher                                                                          |
| `RAYDIUM_API`                        | `raydium-api`                 | `sync-dex-liquidity` direct Raydium API fetcher                                                                           |
| `ORCA_API`                           | `orca-api`                    | `sync-dex-liquidity` direct Orca API fetcher                                                                              |
| `METEORA_API`                        | `meteora-api`                 | `sync-dex-liquidity` direct Meteora API fetcher                                                                           |
| `PANCAKESWAP_API`                    | `pancakeswap-api`             | `sync-dex-liquidity` direct PancakeSwap V3 API fetcher                                                                    |
| `AERODROME_SLIPSTREAM_API`           | `aerodrome-slipstream-api`    | `sync-dex-liquidity` direct Aerodrome Slipstream fetcher                                                                  |
| `VELODROME_SLIPSTREAM_API`           | `velodrome-slipstream-api`    | `sync-dex-liquidity` direct Velodrome Slipstream fetcher                                                                  |
| `CG_TICKER`                          | `coingecko-ticker`            | `enrich-prices` primary consensus (curated ticker corroboration)                                                          |
| `TWITTER_API`                        | `twitter-api`                 | Twitter helper (not wired into current scheduled digest delivery)                                                         |
| `TELEGRAM_API`                       | `telegram-api`                | `daily-digest` Telegram posting, `dispatch-telegram-alerts` subscriber fan-out                                            |
| `ANTHROPIC`                          | `anthropic-api`               | `daily-digest` LLM generation                                                                                             |
| `BLUECHIP`                           | `bluechip-api`                | `sync-bluechip` safety rating fetch                                                                                       |
| `KINESIS_KAU`                        | `kinesis-kau-horizon`         | `sync-kinesis-supply` KAU chain circulation fetch                                                                         |
| `KINESIS_KAG`                        | `kinesis-kag-horizon`         | `sync-kinesis-supply` KAG chain circulation fetch                                                                         |
| `COINGECKO_CONFIRM`                  | `coingecko-confirm`           | pending depeg confirmation                                                                                                |
| `DEFILLAMA_CONFIRM`                  | `defillama-confirm`           | pending depeg confirmation                                                                                                |
| Dynamic `live-reserves:<scope>` keys | e.g. `live-reserves:infinifi` | `sync-live-reserves` per configured breaker scope; some adapters also opt into source-invariant within-run result sharing |

Primary-oracle implementation notes:

- `PYTH_PRICES` only counts as a healthy outcome when at least one requested feed resolves into a usable price; Hermes feed IDs are normalized by lowercasing and stripping an optional leading `0x`.
- `REDSTONE_PRICES` only counts as healthy when it returns at least one usable symbol. The worker queries an exact-case tracked-symbol allowlist in sequential batches of 10 and retries batch-dropped symbols individually once.
- dRPC is an upstream RPC provider for some blacklist balance reads, but it is not a `CIRCUIT_SOURCE` key today.
- `/api/health` completes the circuit list from active `CIRCUIT_SOURCE` values plus configured `live-reserves:*` scopes, and filters retired/stale cache rows so old breaker keys do not keep surfacing as active incidents after a source is removed.
- `POST /api/reset-circuit-breaker?circuit=<source>` uses the same active-source whitelist, so operators can reset both source-wide breakers and configured scoped live-reserve breakers such as `live-reserves:usdgo-osl`.
- Scheduled handlers that write breaker state from cron outcomes now treat `degraded`, `skipped_locked`, and `skipped_neutral` as neutral by default; only explicit `ok` heals a breaker and only thrown/error outcomes count as failures unless a source-specific handler opts into stricter semantics.

---

## Alert System

**File:** `worker/src/lib/alerts.ts`

```typescript
export function normalizeWebhookUrl(url: string | undefined): string | null;
export async function sendAlert(
  webhookUrl: string | null | undefined,
  title: string,
  message: string,
): Promise<boolean>;
```

Auto-detects webhook format from URL:

| URL contains               | Format                                             |
| -------------------------- | -------------------------------------------------- |
| `discord.com/api/webhooks` | Discord embed (red, `[Pharos] {title}`, timestamp) |
| Anything else              | Slack markdown (`*[Pharos] {title}*\n{message}`)   |

`sendAlert()` returns `true` only when the webhook responds with `2xx`. Non-2xx responses and fetch errors are logged with status/context, and failures never propagate to caller control flow.

`fetch-tbill-rate` uses the shared alert helper for repeated GBP SONIA retained benchmark fallback. The first retained run only writes streak metadata; the second consecutive daily retained run sends `GBP SONIA retained benchmark fallback` and records a cron event. It stores `lastAlertedAt` only when the webhook send succeeds, so failed or unconfigured webhook attempts do not start the 24-hour suppression window. A fresh GBP market observation resets the streak and records `gbp-retained-fallback-recovered`.

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

| Cache Key                  | Writer                   | Data                                                                                   |
| -------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `stablecoins`              | `syncStablecoins`        | Full DefiLlama pegged assets payload                                                   |
| `stablecoins:invalid-last` | `syncStablecoins`        | Last schema-invalid stablecoins payload (diagnostic only, never served to clients)     |
| `stablecoin-charts`        | `syncStablecoinCharts`   | Downsampled chart points                                                               |
| `fx-rates`                 | `syncFxRates`            | FX rates (EUR, GBP, etc.)                                                              |
| `usds-status`              | `syncUsdsStatus`         | Freeze capability + implementation address                                             |
| `bluechip-ratings`         | `syncBluechip`           | Ratings map keyed by canonical Pharos ID                                               |
| `report-cards:snapshot`    | `publishReportCardCache` | Private generation/methodology-pinned cache envelope carrying the full report-card API payload for `/api/report-cards` and yield hydration reads |
| `report_card_cache`        | `publishReportCardCache` | Compact Safety Score map for lightweight consumers; payload includes `methodologyVersion` and is rejected when it does not match the current Safety Score methodology |
| `peg-analytics`            | `publishReportCardCache` | Producer-published peg-analytics snapshot (`pegData` + daily depeg counters); `/api/peg-summary` accepts it for up to 30 min (2x producer cadence) and falls back to direct compute on miss/stale |
| `detail-write-failure:<id>` | stablecoin detail API   | Marker written when a `detail:<id>` cache write fails or is oversized; the staleness watchdog alerts on markers fresher than 24h and prunes them after 7-day retention |
| `yield-rankings`           | `syncYieldData`          | Pre-computed yield rankings + PYS scores                                               |
| `risk_free_rates`          | `fetchTbillRate`         | Structured benchmark registry used by yield benchmark selection and provenance         |
| `risk_free_rate`           | `fetchTbillRate`         | Current T-bill rate for PYS computation                                                |
| `fetch-tbill-rate:gbp-retained-fallback-streak` | `fetchTbillRate` | GBP SONIA retained-fallback streak, last alert timestamp, and recovery metadata |

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

The dedicated quarter-hour `cron-slot-sweeper` reconciles stale `cron_slot_executions` rows whose heartbeat has not advanced within the 35-minute slot stale window. Scheduled slot admission now first pre-sweeps stale prior rows for the same schedule key before accepting the new slot, reducing duplicate-running ambiguity when the platform killed a previous invocation. Before closing the stale slot, the sweeper reconciles matching `cron_run_progress` and `cron_leases` ownership. If a progress row has a matching expired lease and no completed child cron row for that slot, the reconciler writes a synthetic terminal `cron_runs` row with `metadata.reason = "stale-slot-reconciled"`, then clears the progress/lease artifacts. The stale slot is marked `finished` / `error` with metadata explaining what was reconciled, and the reconciler writes a compact `cache["cron:event:<slot>:scheduled-slot-abandoned"]` marker containing the slot key, owner, and abandoned child progress stage. Accepted slots also count failed heartbeat writes in `slotHeartbeatFailures` metadata when finalizing. That keeps platform-killed scheduled events from remaining operationally `running` forever, gives interrupted child work an auditable terminal row, and lets `/api/status` surface the latest slot-abandoned event without scanning old slot rows.

### Block Tracking (Blacklist)

| Function                             | Description                                     |
| ------------------------------------ | ----------------------------------------------- |
| `getLastBlock(db, configKey)`        | Returns last processed block/timestamp, or 0    |
| `setLastBlock(db, configKey, block)` | `INSERT OR REPLACE` into `blacklist_sync_state` |

### Price Cache

| Function                      | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `getPriceCache(db)`           | Returns `Map<assetId, { price, updatedAt }>` from `price_cache` table |
| `savePriceCache(db, entries)` | Batch upsert into `price_cache`                                       |

---

## Undocumented Cron Details

The three crons below were previously only listed by filename in [Architecture](./architecture.md). Their full algorithms are documented here.

### sync-stablecoin-charts

**File:** `worker/src/cron/sync-stablecoin-charts.ts`
**Schedule:** `16,46 * * * *` (dedicated half-hourly trigger; successful writes are capped at once per hour)
**Data source:** DefiLlama aggregate chart history + structural supplemental tracked-asset overlays from D1 `supply_history`

**Algorithm:**

1. Read `stablecoin-charts:last-write`; if the previous successful write is <1 hour old, return immediately with `cooldown_active`
2. Fetch full chart history from DefiLlama (single GET request)
3. Validate: must receive array with ≥100 data points
4. FX rate corruption fix:
   - Read cached FX rates from the `fx-rates` cache key
   - Only points within the recent live-reference window are eligible for repair; older history is left untouched because the current FX cache is not a historical reference series
   - For each eligible chart point, validate implied FX rate: `totalCirculatingUSD[key] / totalCirculating[key]`
   - If rate falls outside tolerance band (`fxRate / RATE_TOLERANCE` to `fxRate * RATE_TOLERANCE`), recompute the USD value using the current cached FX rate
   - `RATE_TOLERANCE = 3` (accepts 1/3× to 3× of expected rate)
5. Reconcile structurally supplemental tracked assets:
   - Load the active tracked coins whose canonical detail provider is not DefiLlama (for example CoinGecko-only wrappers and commodity tokens)
   - Query their daily `supply_history` rows from D1 in chunks of 90 ids, keeping each statement below the D1 bind ceiling
   - Align each coin's last known `circulating_usd` value at or before each DefiLlama chart point, then add it into the chart point's `totalCirculatingUSD`
6. Downsample to adaptive time buckets:
   - Last 90 days: daily (86,400s intervals)
   - 90 days to 2 years: weekly (604,800s intervals)
   - Older than 2 years: monthly (2,592,000s intervals)
7. If the downsampled payload has fewer than 10 points, return `status: "degraded"` and skip publication
8. Write to cache via `setCacheIfNewer()` (CAS — won't overwrite newer data) and update `stablecoin-charts:last-write`

**Read-time hydration:** `GET /api/stablecoin-charts` still serves the cached array with normal freshness headers, but before serializing it appends or replaces the trailing point with a live aggregate built from the current `stablecoins` cache. This keeps the homepage total-market-cap chart endpoint aligned with the KPI card even when the downsampled cache's latest historical point is UTC-midnight or when the current stablecoins payload is using a temporary supply fallback for a tracked supplemental asset.

**D1 bind guard:** run metadata includes `supplementalHistoryChunks` and `supplementalHistoryMaxBindCount` so operators can confirm supplemental chart overlays stayed chunked when the non-DefiLlama tracked-asset set grows.

**Cooldown guard:** alternate half-hourly runs skip the upstream fetch entirely when the 1-hour write cooldown is still active.

### sync-usds-status

**File:** `worker/src/cron/sync-usds-status.ts`
**Schedule:** `0 8 * * *` (daily at 08:00 UTC)
**Data source:** Etherscan V2 API (on-chain reads)

**Purpose:** Monitors whether the USDS token contract has been upgraded to include freeze/blacklist capability (which it currently does not have).

**Constants:**

| Constant              | Value                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `USDS_PROXY`          | `0xdC035D45d973E3EC169d2276DDab16f1e407384F`                                    |
| `IMPL_SLOT`           | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` (ERC-1967) |
| `NO_FREEZE_IMPLS`     | `0x1923dfee706a8e78157416c29cbccfde7cdf4102` (Set)                              |
| `IS_BLOCKED_SELECTOR` | `0xe4c0aaf4` (keccak256 of `isBlocked(address)`)                                |
| `STALE_HOURS`         | 20                                                                              |

**Algorithm:**

1. Check cache freshness: if `usds-status` cache is <20 hours old, skip
2. Read implementation address from ERC-1967 storage slot via `eth_getStorageAt`
3. If implementation is in `NO_FREEZE_IMPLS`: `freezeCapabilityPresent = false` (known safe impl)
4. Otherwise: probe the proxy with `eth_call` using `isBlocked(address(0))` selector
   - If call returns exactly 32 bytes (a valid ABI-encoded word): freeze function exists (`freezeCapabilityPresent = true`)
   - If call reverts: no freeze function (`freezeCapabilityPresent = false`)
   - If probe fails entirely: preserve cached status, don't update
5. Store `{ freezeCapabilityPresent, freezeActive, implementationAddress, lastChecked }` via `setCacheIfNewer()` (`freezeActive` is a backward-compatible alias)
6. If the cache write fails after provider checks succeeded, return `status: "degraded"` with `reason: "cache-write-failed"` instead of recording a clean success

### sync-live-reserves

**File:** `worker/src/cron/sync-live-reserves.ts`
**Schedule:** `11 */4 * * *` (every 4 hours at :11 UTC)
**Data source:** Protocol-specific reserve APIs and on-chain vault/accounting reads via adapter registry (`worker/src/cron/reserve-adapters/`)

**Purpose:** Syncs live reserve composition from protocol data APIs into the `reserve_composition` D1 table and records per-coin operational state in `reserve_sync_state`. Each coin with `liveReservesConfig` declares an adapter, semantics, source inputs, and optional breaker scope. The shared adapter registry also classifies reserve shape (`sourceModel`) and evidence strength (`evidenceClass`). The cron iterates configured coins sequentially, delegates each coin to a single execution helper (breaker decision, adapter/fallback execution, validation, finalize), only reuses fetched results for adapters explicitly marked `source-invariant`, and persists both successful snapshots and failed/degraded sync state. Warning-bearing snapshots remain visible on reserve detail/status surfaces, but report-card collateral passthrough only consumes fresh authoritative `independent` evidence whose latest sync state is `ok`. For the full adapter/config/API contract, see [live-reserves.md](./live-reserves.md).

**D1 table: `reserve_composition`**

| Column          | Type    | Description                           |
| --------------- | ------- | ------------------------------------- |
| `stablecoin_id` | TEXT PK | Pharos coin ID                        |
| `slices`        | TEXT    | JSON-serialized `ReserveSlice[]`      |
| `fetched_at`    | INTEGER | Unix seconds of last successful sync  |
| `source`        | TEXT    | Adapter key used (e.g., `"infinifi"`) |
| `metadata` / warning fields / adapter classification | TEXT / INTEGER | Snapshot telemetry, warning summary, and source-model/evidence-class columns |
| `attempt_id` | TEXT | Attempt-fencing identifier for rejecting orphaned partial writes |

Only coins with `liveReservesConfig` set in their metadata appear in this table. One row per coin (latest snapshot only). A row is only considered an authoritative live snapshot when it matches the coin’s `reserve_sync_state.last_success_at`.

**D1 table: `reserve_sync_state`**

| Column              | Type    | Description                                         |
| ------------------- | ------- | --------------------------------------------------- |
| `stablecoin_id`     | TEXT PK | Pharos coin ID                                      |
| `adapter_key`       | TEXT    | Adapter key used for the last attempt               |
| `breaker_key`       | TEXT    | Per-source circuit-breaker key                      |
| `last_attempted_at` | INTEGER | Unix seconds of the latest sync attempt             |
| `last_success_at`   | INTEGER | Unix seconds of the latest successful live snapshot |
| `last_status`       | TEXT    | `ok`, `degraded`, `error`, or `skipped`             |
| `warning_count`     | INTEGER | Count of warnings returned by the adapter           |
| `warnings`          | TEXT    | JSON-serialized warning objects                     |
| `last_error`        | TEXT    | Last failure message, if any                        |
| `metadata`          | TEXT    | Adapter-specific operational metadata               |
| `last_attempt_id` / `pending_attempt_id` / `last_success_attempt_id` | TEXT | Attempt-fencing identifiers for correlating sync state with composition rows |

**Registered adapters:**

The authoritative adapter registry lives in `shared/lib/live-reserve-adapters-definitions.ts`, with worker implementations registered from `worker/src/cron/reserve-adapters/index.ts`. Coin-to-adapter assignment is source metadata: inspect `liveReservesConfig.adapter` in `shared/data/stablecoins/coins/*.json`, or run `npm run check:doc-counts` to verify the registered-adapter count that primary docs expose.

This doc intentionally avoids a hand-maintained adapter-by-coin table because live reserve coverage changes frequently and stale enumerations have caused drift. For current coverage, use `docs/live-reserves.md`, the adapter registry files above, and the checked-in stablecoin metadata.

**Operational behavior:**

- Circuit breakers are keyed per source identity (`live-reserves:<scope>`), not as one global `live-reserves` source.
- Within-run fetched-result reuse is opt-in via adapter registry metadata (`sharedSourceMode = "source-invariant"`). This currently applies to M0, Mento, Reservoir, and Sky/MakerCore; coin-aware adapters such as Frax do not share cached results across coins.
- The cron writes `reserve_sync_state` on every path, including degraded/error/skipped outcomes.
- Successful snapshots write `reserve_composition` and `reserve_sync_state` together in one D1 batch, and downstream readers ignore orphaned composition rows that do not have a matching successful sync state.
- Adapter warnings are reserved for unresolved material mapping drift. Known Ethena alt-collateral that is intentionally bucketed into `Other crypto collateral` does not emit warnings, and infiniFi dust farms that round to `0%` in the displayed mix do not keep the run-level cron degraded.
- Cron result status is explicit:
  - `ok` when at least one configured coin synced and `failed + skipped <= ceil(total * 0.1)`
  - `degraded` when at least one configured coin synced and `failed + skipped > ceil(total * 0.1)`
  - `error` when no configured coin synced successfully and at least one coin failed or was skipped

**Adding a new adapter:** Create `worker/src/cron/reserve-adapters/<protocol>.ts`, register it in `index.ts`, and add a structured `liveReservesConfig` to the coin metadata. The cron, reserve API, status surface, and detail-page fallback logic all consume that config.

### sync-redemption-backstops

**File:** `worker/src/cron/sync-redemption-backstops.ts`  
**Schedule:** `11 */4 * * *` (every 4 hours at :11 UTC, immediately after `sync-live-reserves`)  
**Data source:** Stablecoins cache, DEX liquidity snapshot, redemption-backstop config registry, and live reserve-sync metadata where available

**Purpose:** Builds the current `redemption_backstop` dataset for redeemable assets and writes daily rows to `redemption_backstop_history`. This sync is deliberately separate from report-card generation so redeemability remains a first-class worker dataset with its own cron visibility, API surface, and methodology versioning.

Current reserve-sync support distinguishes direct and proxy live-capacity telemetry. Only adapters that explicitly expose immediate redemption capacity can drive `sourceMode = dynamic`, while fee-only adapters (for example `single-asset`) are now restricted to fee telemetry only. Reserve-sync routes require a fresh authoritative snapshot with scoring-grade freshness evidence; degraded snapshots still fail closed by default, but redemption can selectively keep a live lower bound when the only blocking warning class is explicitly allowlisted as a reserve-completeness issue rather than a broken-capacity signal. When public docs publish a hard primary-market buffer floor, reserve-sync routes can also fall back to a reviewed documented ratio instead of remaining unrated.

Cron result status is thresholded rather than all-or-nothing:

- `ok` when all routes resolve cleanly, or when the only unrated rows are a tiny `missing-capacity` tail within `ceil(configured * 1%)`
- `degraded` when any route fails, is missing from cache, hits another unresolved state, the `missing-capacity` tail exceeds that budget, or DEX liquidity input freshness is stale
- `error` when zero routes resolve to usable scored rows

### sync-kinesis-supply

**File:** `worker/src/cron/sync-kinesis-supply.ts`
**Schedule:** `11 */4 * * *` (every 4 hours at :11 UTC, after `sync-redemption-backstops`)
**Data source:** Kinesis Horizon `/coin_in_circulation` endpoint (KAU and KAG chains)

**Purpose:** Fetches circulation, cumulative mint, and cumulative redemption totals from the two Kinesis Stellar-fork blockchains. Writes circulation to the `onchain_supply` table for independent supply verification against DefiLlama/CoinGecko. Caches full totals in the `cache` table under `kinesis-kinesis-kau-totals` / `kinesis-kinesis-kag-totals` for future flow-delta computation.

**Endpoints:**

- KAU: `https://kau-mainnet.kinesisgroup.io/coin_in_circulation`
- KAG: `https://kag-mainnet.kinesisgroup.io/coin_in_circulation`

**Circuit breakers:** `KINESIS_KAU` and `KINESIS_KAG` (independent per chain).

### sync-bluechip

**File:** `worker/src/cron/sync-bluechip.ts`
**Schedule:** `5 8 * * *` (daily at 08:05 UTC)
**Data source:** `https://backend.bluechip.org/coin-data/{slug}`

**Purpose:** Fetches safety ratings from bluechip.org for 19 tracked stablecoins.

**Constants:**

| Constant      | Value                                    |
| ------------- | ---------------------------------------- |
| `STALE_HOURS` | 6                                        |
| `API_BASE`    | `https://backend.bluechip.org/coin-data` |
| Batch size    | 3 concurrent requests                    |
| Batch delay   | 500ms between batches                    |
| Max retries   | 2 per request                            |

**Algorithm:**

1. Check cache freshness: if `bluechip-ratings` cache is <6 hours old, skip
2. Fetch ratings for all 19 slugs in `BLUECHIP_SLUG_MAP` (file: `shared/lib/bluechip-slugs.ts`)
   - Processed in batches of 3, with 500ms delay between batches
   - Each request uses `fetchWithRetry()` with `maxRetries: 2`
3. For each response, extract:
   - `grade` (A+ through F)
   - `collateralization` (percentage)
   - `smartContractAudit` (boolean)
   - `dateOfRating`, `dateLastChange`
   - `smidge`: 6 category summaries (stability, management, implementation, decentralization, governance, externals) — HTML stripped via regex
4. Merge any freshly fetched rows onto the previous cache map so missed slugs do not disappear from the published payload
5. Treat malformed/non-JSON `200` responses as slug-scoped failures (`json-parse-failed`) instead of aborting the whole cron on a raw parser exception
6. If zero ratings fetched: preserve existing cache, don't overwrite
7. If only a subset of slugs succeeded: store the merged map and return `status: "degraded"` with `fallbackMode: "partial-cache-merge"`; this degraded partial-refresh path does not count as a circuit-breaker failure as long as at least one fresh slug was recovered
8. Store `Record<string, BluechipRating>` (keyed by canonical Pharos ID) via `setCacheIfNewer()`

**Tracked coins:** USDC, USDT, DAI, LUSD, BOLD, PYUSD, PAXG, XAUT, GUSD, USDP, EURC, FDUSD, FRAX, GHO, TUSD, RLUSD, XSGD, OUSD, CETES.

---

## Health & Status Endpoints

### GET /api/health

Returns cache freshness for key data sources, with per-source staleness thresholds:

The response uses the realtime cache profile (`public, s-maxage=60, max-age=10`) and participates in the Worker edge cache. This keeps the no-key public health surface bounded to roughly 60 seconds of cache lag while reducing repeated D1-backed health recomputation during browser polling and external probes.

| Cache Key           | Stale threshold |
| ------------------- | --------------- |
| `stablecoins`       | 600s (10 min)   |
| `stablecoin-charts` | 3,600s (1h)     |
| `usds-status`       | 86,400s (24h)   |
| `fx-rates`          | 1,800s (30 min) |
| `bluechip-ratings`  | 86,400s (24h)   |
| `dex-liquidity`     | 43,200s (12h)   |
| `yield-data`        | 3,600s (1h)     |
| `dews`              | 1,800s (30 min) |

Supplemental yield aggregate cache writes remain last-good protected: an all-family empty run returns `degraded` and does not overwrite `cache["yield:supplemental-sources:v1"]`. Per-family rows are stricter ownership markers: a successful family that resolves to zero deduplicated candidates may publish an empty `yield:supplemental-sources:v1:<family>` cache to clear a previous non-empty family snapshot, while failed/malformed families leave their prior row untouched and rely on aggregate-cache fallback.

Health freshness checks for mint/burn major symbols and scheduler stale alerts use the same shared resolver in `worker/src/lib/mint-burn-health-config.ts`, including env overrides (`MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC`). The public `/api/health` status itself now follows critical-lane sync freshness (`lastSuccessfulSyncAt` + latest run status) rather than raw event recency, so quiet majors do not produce false stale health. The advisory `mintBurn.totalEvents` value comes from the latest daily `mint-burn-growth-watchdog` `cron_runs` result instead of scanning `mint_burn_events`/`mint_burn_hourly` or reading `sqlite_sequence`.

`/api/health` also returns a `warnings: string[]` field. Subquery failures (for example blacklist or circuit-state lookups) no longer silently degrade to zero-like values; instead the endpoint downgrades `status` and emits machine-readable warning strings while still returning `200`. Those warning strings are intentionally sanitized for public output; raw exception detail stays in worker logs.

### GET /api/status

Returns raw and effective status, recent `cron_runs`, active `cron_run_progress` rows, stale progress/lease artifacts, latest cron event markers, budget-only surface telemetry, publication-generation health, provider circuit health, data-invariant canaries, derived dependency health, data-quality metrics, state-machine metadata, synthetic probe summary, and transition timeline. Tracks 47 cron jobs across 18 job-bearing runner slots via `CRON_INTERVALS` and `CRON_JOB_DEFINITIONS` in `shared/lib/cron-jobs.ts`. Budget-only scheduled surfaces are intentionally absent from `/api/status` job health but present in `CRON_CONNECTION_BUDGET_ENTRIES` for `npm run check:cron-connections` and in the top-level `budgetOnlySurfaces` array for observability. That includes Telegram registration reconciliation and the `*/5 * * * *` digest-trigger poll slot:

Default reads use the raw status snapshot produced by `status-self-check` and recompute only the lightweight response wrappers, current status-state/probe/timeline views, and admin supplements. Publication health is one of those live admin supplements: it reads existing `dex_liquidity_publication_generations` and `yield_publication_generations` rows into `publicationHealth`, reads migrated `surface_publication_generations` rows when present, and falls back to the validated canonical `stablecoins` cache, `stress_signals_latest`/`cache["dews"]`, `stability_index_samples`, and `cache["report_card_cache"]` for stablecoins, DEWS, PSI, and report-card cache publication status until writers are migrated. `providerCircuitHealth` reads authoritative `circuit:<source>` cache rows for the bounded active provider allowlist into open/half-open breaker counts by provider family; loader failures surface as `sectionErrors.providerCircuitHealth` and do not change availability. `canaries` reads the latest row per check from `worker_canary_runs`; loader failures surface as `sectionErrors.canaries` and do not change availability. `dependencyHealth` is then derived in-process from the raw cache/cron maps, `publicationHealth`, and `shared/lib/data-dependency-registry.ts`; it performs no additional D1 reads and is advisory only. Snapshot age is bounded to 30 minutes; operators can force the previous live raw computation path with `GET /api/status?refresh=live`.

Status hysteresis transitions and self-probe history use nullable `idempotency_key` columns with partial unique indexes. The status-state batch writer and probe writer run through `runWithOverloadRetry()`, so ambiguous D1 overload retries can reapply the same state/probe write without duplicating append-only transition or probe rows.

The `probe` object returned by `/api/status` is the latest `status_probe_runs` aggregate. New split-plane rows include optional `internal`, `external`, and `internalExternalDiscrepancy` subobjects so operators can compare internal router health against the production custom-domain path. Legacy rows and cold-start fallbacks omit those optional fields.

| Job                             | Interval         | Trigger                                           |
| ------------------------------- | ---------------- | ------------------------------------------------- |
| `sync-stablecoins`              | 900s (15min)     | `*/15 * * * *`                                    |
| `sync-stablecoin-charts`        | 3,600s (1h)      | `16,46 * * * *` (1h cooldown)                     |
| `sync-fx-rates`                 | 1,800s (30min)   | `*/15 * * * *` (30-min cooldown)                  |
| `stability-index`               | 1,800s (30min)   | `26,56 * * * *`                                   |
| `compute-dews`                  | 1,800s (30min)   | `26,56 * * * *`                                   |
| `project-tape`                  | 1,800s (30min)   | `26,56 * * * *`                                   |
| `cron-slot-sweeper`             | 900s (15min)     | `9,24,39,54 * * * *`                              |
| `status-self-check`             | 900s (15min)     | `9,24,39,54 * * * *`                              |
| `data-invariant-canary`         | 900s (15min)     | `9,24,39,54 * * * *`                              |
| `cron-staleness-watchdog`       | 900s (15min)     | `9,24,39,54 * * * *`                              |
| `dispatch-telegram-alerts`      | 300s (5min)      | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`       |
| `telegram-degradation-watchdog` | 300s (5min)      | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`       |
| `telegram-disambiguation-cleanup` | 300s (5min)    | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`       |
| `telegram-pulse-snapshot`       | 300s (5min)      | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`       |
| `sync-blacklist`                | 21,600s (6h)     | `3 */6 * * *`                                     |
| `sync-mint-burn`                | 1,800s (30min)   | `4,34 * * * *`                                    |
| `sync-dex-discovery`            | 7,200s (2h)      | `6 */2 * * *`                                     |
| `sync-mint-burn-extended`       | 1,800s (30min)   | `13,43 * * * *`                                   |
| `sync-dex-liquidity`            | 1,800s (30min)   | `10,40 * * * *`                                   |
| `sync-yield-data`               | 3,600s (1h)      | `20 * * * *`                                      |
| `sync-yield-supplemental`       | 14,400s (4h)     | `25 */4 * * *`                                    |
| `snapshot-supply`               | 86,400s (24h)    | `*/15 * * * *` (once per UTC date) / `0 8 * * *` (fallback) |
| `snapshot-chain-supply`         | 86,400s (24h)    | `*/15 * * * *` (once per UTC date)                |
| `publish-report-card-cache`     | 900s (15min)     | `*/15 * * * *`                                    |
| `compute-depeg-resolver`        | 900s (15min)     | `*/15 * * * *`                                    |
| `snapshot-safety-grade-history` | 86,400s (24h)    | `0 8 * * *`                                       |
| `fetch-tbill-rate`              | 86,400s (24h)    | `0 8 * * *`                                       |
| `snapshot-psi`                  | 86,400s (24h)    | `0 8 * * *`                                       |
| `snapshot-public-dataset`       | 86,400s (24h)    | `0 8 * * *`                                       |
| `sync-usds-status`              | 86,400s (24h)    | `0 8 * * *`                                       |
| `sync-live-reserves`            | 14,400s (4h)     | `11 */4 * * *`                                    |
| `sync-redemption-backstops`     | 14,400s (4h)     | `11 */4 * * *`                                    |
| `sync-kinesis-supply`           | 14,400s (4h)     | `11 */4 * * *`                                    |
| `reserve-post-sync-watchdog`    | 14,400s (4h)     | `11 */4 * * *`                                    |
| `sync-bluechip`                 | 86,400s (24h)    | `5 8 * * *`                                       |
| `daily-digest`                  | 86,400s (24h)    | `5 8 * * *`                                       |
| `weekly-recap`                  | 604,800s (7d)    | `5 8 * * *`                                       |
| `discovery-scan`                | 604,800s (7d)    | `10 8 * * *` (Monday-only)                        |
| `prune-status-probe-runs`       | 86,400s (24h)    | `0 3 * * *`                                       |
| `prune-cron-history`            | 86,400s (24h)    | `0 3 * * *`                                       |
| `worker-repair-runner`          | 86,400s (24h)    | `0 3 * * *`                                       |
| `prune-detail-cache`            | 86,400s (24h)    | `0 3 * * *`                                       |
| `telegram-inactive-cleanup`     | 604,800s (7d)    | `0 3 * * *` (daily invocation, 7-day cache guard) |
| `telegram-retention-cleanup`    | 86,400s (24h)    | `0 3 * * *`                                       |
| `mint-burn-growth-watchdog`     | 86,400s (24h)    | `0 3 * * *`                                       |
| `cron-duration-watchdog`        | 86,400s (24h)    | `0 3 * * *`                                       |
| `yield-coverage-audit`          | 2,592,000s (30d) | `0 6 1 * *`                                       |

A job is treated as healthy when cron telemetry is unavailable, when a fresh in-flight run exists, when the last run is fresh and `ok`/`degraded`, when the last run is a fresh `skipped_neutral` expected no-op backed by a fresh latest non-neutral `ok` required run, when a fresh `skipped_locked` run has another fresh `ok` run in recent history, or when a watch-tier job has no history yet. Otherwise it is unhealthy, including stale history, non-fresh errors, or a neutral skip whose latest required run was degraded/error. `/api/status` also exposes `crons[*].inFlight` while a long-running leased job is active, including `stage`, `itemsDone/itemsTotal`, the last heartbeat timestamp, and a `stale` flag when the active-progress row stops updating. Only progress rows backed by a still-active matching lease are surfaced this way; orphaned rows and expired leases move to `crons[*].staleArtifacts` and increment `summary.staleCronArtifacts`, `summary.orphanedCronProgressRows`, and `summary.expiredCronLeases`. Running scheduled-slot aggregates live in `summary.scheduledSlotRunning`, `summary.scheduledSlotStaleCandidates`, and `summary.scheduledSlotOldestRunningAgeSec`. Budget-only side work lives in `budgetOnlySurfaces` with separate `summary.budgetOnlySurface*` counters, not in `crons`. When a scheduled slot is later reconciled as abandoned, `crons[*].latestEvent` on each child job in that slot can carry the latest `scheduled-slot-abandoned` marker with the schedule key, owner, and progress-stage metadata for operator triage.

The status handler now surfaces per-subsection loader failures through `sectionErrors` instead of silently swallowing them. When a subsection query fails, the affected field degrades to `null`/empty and the response still returns `200` with a machine-readable error entry for that subsection. Those subsection messages are sanitized summaries rather than raw SQL / exception text.

### GET /api/status-history

Admin timeline feed for machine consumers. Returns persisted status state, status-system staleness, latest synthetic probe aggregate, discrepancy summary, and recent status transitions.

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

---

## File Index

| File                                               | Role                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/src/index.ts`                              | Thin worker entry: delegates `fetch`/`scheduled` to handler modules                                                                                                   |
| `worker/src/handlers/http/request-dispatch.ts`                      | HTTP request orchestration: preflight, gates, edge cache lookup/write, route-context build, router dispatch                                                           |
| `worker/src/handlers/http/cors.ts`                 | CORS origin resolution, preflight response, and response-header decoration                                                                                            |
| `worker/src/handlers/http/gates.ts`                | Maintenance-mode gate, public API rate limiting, and one-time env-contract warnings                                                                                   |
| `worker/src/handlers/http/context.ts`              | Route dependency hydration from `Env` into `FullRouteContext`                                                                                                         |
| `worker/src/handlers/http/edge-cache.ts`           | Edge cache match/store policy for cacheable GET requests                                                                                                              |
| `worker/src/handlers/scheduled.ts`                 | Thin cron entrypoint: env-aware init + cron-expression-to-slot-runner dispatch                                                                                        |
| `worker/src/handlers/scheduled/context.ts`         | Shared scheduled runtime context: lease-aware `runLeasedCron`, slot config, stablecoins capability parsing                                                            |
| `worker/src/handlers/scheduled/*.ts`               | Per-trigger slot runners (quarter-hourly, isolated 30-min mint/burn lanes, half-hourly charts/DEX liquidity, decoupled DEWS/PSI, 2-hourly DEX discovery, 6-hourly blacklist, 4-hourly reserve slot, Telegram, and daily slots) |
| `worker/src/lib/env.ts`                            | Worker Env interface + `parseCsvEnv()` helper for CSV-based runtime overrides                                                                                         |
| `worker/wrangler.toml`                             | Deployment config: custom domain, cron triggers, D1 binding, vars                                                                                                     |
| `worker/src/lib/db.ts`                             | Database helpers: `batchExecute`, block tracking                                                                                                                      |
| `worker/src/lib/db-cache.ts`                       | Cache CRUD: `getCache`, `setCache`, `setCacheIfNewer`, `getPriceCache`, `savePriceCache`                                                                              |
| `worker/src/lib/cron-logger.ts`                    | `logCronRun` wrapper and `CronResult` type                                                                                                                            |
| `worker/src/lib/cron-lease.ts`                     | Cron lease primitives: `acquireCronLease`, `runCronWithLease`, `CRON_TIMEOUT_MS`                                                                                      |
| `worker/src/lib/auth.ts`                           | Admin auth: verifies the `ops-api` Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`)                                                                                  |
| `worker/src/lib/alerts.ts`                         | Webhook alerts: auto-detects Discord/Slack format                                                                                                                     |
| `worker/src/lib/constants.ts`                      | Shared constants: API URLs, thresholds, cache profiles                                                                                                                |
| `shared/lib/cron-jobs.ts`                          | Shared cron expressions, per-job intervals, `CRON_INTERVALS`, and status-page grouping/trigger metadata                                                               |
| `shared/lib/status-thresholds.ts`                  | Shared status threshold constants for frontend + worker data-quality/status bands                                                                                     |
| `worker/src/lib/blacklist-gaps.ts`                 | Shared blacklist gap query helper (Tron null-amount exclusion + recent window)                                                                                        |
| `worker/src/lib/chain-registry.ts`                 | Unified chain mappings + chain RPC configs: Alchemy/dRPC/public fallback for 11 chains                                                                                |
| `worker/src/lib/coingecko.ts`                      | CoinGecko init: free/pro URL switching, auth headers                                                                                                                  |
| `shared/lib/bluechip-slugs.ts`                     | Bluechip slug → canonical Pharos ID mapping (19 coins)                                                                                                                |
| `worker/src/lib/mint-burn-health-config.ts`        | Shared mint/burn freshness defaults, env override resolver, sync freshness evaluator                                                                                   |
| `worker/src/lib/dex-liquidity.ts`                  | Shared `dex_liquidity` table loader (`loadDexLiquidityMap`)                                                                                                           |
| `worker/src/lib/redemption-backstop-sources.ts`    | Redemption-route resolver: capacity models, docs, costs, and effective-exit scoring inputs                                                                            |
| `worker/src/lib/redemption-backstops-store.ts`     | D1 snapshot storage + `GET /api/redemption-backstops` response builder                                                                                                |
| `worker/src/lib/psi-recompute.ts`                  | Shared historical PSI day-input builder used by audit/backfill admin APIs                                                                                             |
| `worker/src/lib/mint-burn-contracts.ts`            | Mint/burn event configs resolved from shared stablecoin contracts, plus explicit vault overrides, `startBlock`, and per-config tiering metadata                       |
| `worker/src/lib/mint-burn-scoring.ts`              | FIS computation, gauge bands, flight-to-quality detection (pure functions)                                                                                            |
| `worker/src/cron/sync-stablecoin-charts.ts`        | Chart sync: DefiLlama charts, FX fix, downsampling                                                                                                                    |
| `worker/src/cron/sync-mint-burn.ts`                | Mint/burn flow sync: Alchemy log scanning (Transfer + custom topics), hourly aggregation                                                                              |
| `worker/src/cron/sync-redemption-backstops.ts`     | 4-hourly redemption-route snapshot sync used by detail pages and report cards                                                                                         |
| `worker/src/cron/sync-kinesis-supply.ts`           | 4-hourly Kinesis Horizon supply sync: KAU/KAG circulation, mint, and redemption totals                                                                                |
| `worker/src/cron/sync-usds-status.ts`              | USDS freeze monitor: ERC-1967 proxy inspection                                                                                                                        |
| `worker/src/cron/sync-bluechip.ts`                 | Bluechip ratings: batch fetch from bluechip.org                                                                                                                       |
| `worker/src/cron/snapshot-safety-grade-history.ts` | Daily Safety Score grade history snapshot writer (seed + grade-change events)                                                                                         |
| `worker/src/cron/status-self-check.ts`             | Status reliability self-check: internal router probes, explicit production-domain external probes, hysteresis persistence, discrepancy + probe-failure alerting       |
| `worker/src/lib/status-reliability.ts`             | Stable facade for status reliability imports                                                                                                                          |
| `worker/src/lib/status-state-store.ts`             | Status hysteresis state persistence, snapshots, and transition history                                                                                                |
| `worker/src/lib/status-probe-store.ts`             | Status self-probe persistence helpers                                                                                                                                 |
| `worker/src/lib/status-discrepancy-store.ts`       | Divergence/probe-failure streak persistence and alert markers                                                                                                         |
| `worker/src/lib/status-discrepancy-view.ts`        | Discrepancy view assembly from effective status + probe summary                                                                                                       |
| `worker/migrations/0000_baseline.sql`              | Baseline schema for `cache`, blacklist tables, cron leases, and the rest of the pre-0072 D1 surface                                                                   |

---

### Migration Baseline

The D1 migration tree was squashed on 2026-03-25. `worker/migrations/0000_baseline.sql` now represents historical migrations `0001` through `0071`, and fresh databases apply that baseline before the remaining checked-in incremental migrations (`0072+`).

Normal production deploy still applies D1 migrations before the new worker binary is live. Because of that ordering, the default path only supports backward-compatible migrations: new migration files starting at `0071` must include `-- rollout-safety: backward-compatible` and avoid destructive table/column drop-or-rename patterns. Any destructive cleanup needs a separate coordinated rollout after the new worker code is already serving. See also [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) for the rollback runbook, the baseline lineage, and the enforced rollout-safety contract.
