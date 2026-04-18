# Worker & API Limits

Reference for limits we can verify from repo code and checked-in config.

This document intentionally focuses on:

- limits enforced in code
- budgets encoded in config
- runtime assumptions the scheduler is explicitly designed around

It intentionally does **not** treat vendor pricing-plan quotas as source of truth. Cloudflare, CoinGecko, Alchemy, Etherscan, Anthropic, X, and similar providers can change those independently of this repo. Re-check official vendor docs or your live account dashboard before making spend-sensitive or capacity-sensitive changes.

---

## Primary Sources

- `worker/wrangler.toml`
- `shared/lib/cron-jobs.ts`
- `worker/src/lib/rate-limit.ts`
- `worker/src/lib/api-keys.ts`
- `worker/src/lib/circuit-breaker.ts`
- `worker/src/handlers/http/gates.ts`
- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices.ts`
- `worker/src/cron/sync-fx-rates.ts`
- `worker/src/cron/publish-report-card-cache.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/sync-yield-supplemental.ts`

---

## Worker Runtime

| Constraint                       | Current repo value                              | Source                                                        | Notes                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker CPU budget per invocation | `30000` ms                                      | `worker/wrangler.toml`                                        | Hard repo-configured CPU cap via `[limits].cpu_ms`                                                                                                           |
| Cron expressions / trigger slots | `16`                                            | `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts` | Public status tooling groups around these trigger slots; the shared runner registry is the dispatch authority checked by `npm run check:cron-sync`; `check:cron-connections` models chained jobs with `connectionGroup` metadata. 2026-04-17: added `daily0300Utc` slot for `prune-status-probe-runs` (90d retention). |
| Status-tracked cron jobs         | `30`                                            | `shared/lib/cron-jobs.ts`                                     | These are the jobs expected by `/api/status`                                                                                                                 |
| Runtime jobs actually scheduled  | `30`                                            | `shared/lib/cron-jobs.ts`                                     | Runtime scheduling now matches the shared status metadata set; cemetery/tracking appendices are folded into daily digest delivery instead of a separate cron |
| Public API limiter               | `300 requests / 60 seconds` per IP hash         | `worker/src/handlers/http/gates.ts`, `worker/src/lib/rate-limit.ts` | Legacy limiter for exempt public routes and protected routes when API-key auth is not satisfied/enforced; enforced through D1-backed `public_api_rate_limit`; after `3` consecutive D1 limiter failures, the worker enters a bounded `503` emergency block with `Retry-After: 60` |
| API key default limiter          | `120 requests / 60 seconds` per key             | `worker/src/lib/api-keys.ts`                                   | Protected public routes with a valid `X-API-Key` use the D1-backed `api_key_rate_limit` table; per-key overrides are stored in `api_keys.rate_limit_per_minute`            |
| Feedback limiter                 | `3 submissions / 10 minutes` per salted IP hash | `worker/src/api/feedback.ts`, `worker/src/lib/rate-limit.ts`  | Separate from the general public API limiter                                                                                                                 |
| Request attribution telemetry retention | `35 days`                                 | `worker/src/lib/request-source-attribution.ts`, `functions/lib/request-attribution.ts` | Total site-vs-external demand, worker-lane load, and per-key public-API load buckets in `api_request_consumer_stats` / `site_data_request_stats` / `api_key_request_stats` are pruned opportunistically |

### Connection-budget operating assumption

The scheduler is deliberately structured around the repo's six-connection-per-trigger operating constraint:

- heavy lanes get isolated trigger slots (`sync-blacklist`, `sync-mint-burn`, `sync-mint-burn-extended`, `sync-dex-discovery`)
- shared slots bundle only related work
- the quarter-hourly handler sequences jobs instead of fanning them out blindly

Treat any new fetch-heavy work added to an existing trigger slot as competing for the same trigger-wide outbound connection budget.

For `sync-stablecoins`, failed upstream responses must be consumed or canceled before later passes start. Leaving non-OK bodies unread can strand the same trigger-local connection slots and starve the late fallback phase (`CoinMarketCap` -> `Jupiter` -> `DexScreener`).

The same rule applies to Worker-side integration clients. Telegram delivery, X posting, and GitHub feedback submission should always consume or cancel response bodies before returning so one idle stream does not pin a scarce connection slot.

---

## Cron Budgeting

| Area                                   | Current repo budget | Source                                                            | Notes                                                                       |
| -------------------------------------- | ------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| DEX discovery overall deadline         | `12 minutes`        | `worker/src/cron/dex-discovery/orchestrator.ts`                   | Shared deadline for the discovery pass before persistence/cleanup tail work |
| DEX discovery per-coin budget          | `25 seconds`        | `worker/src/cron/dex-discovery/orchestrator.ts`                   | Prevents one slow coin from consuming the whole staging lane |
| Live reserve sync overall deadline     | `12 minutes`        | `worker/src/lib/cron-lease.ts`                                    | Explicit wrapper budget for the serialized reserve loop before the rest of the 4-hourly slot |
| Live reserve adapter I/O peak          | `2` outbound operations per adapter attempt | `worker/src/cron/reserve-adapters/concurrency.ts`, `shared/lib/cron-jobs.ts` | Coin loop is serialized, but individual adapters can fan out internally; shared fetch/RPC helpers enforce the per-attempt limiter |
| Yield publication overall deadline     | `10 minutes`        | `worker/src/lib/cron-lease.ts`                                    | Dedicated hourly `sync-yield-data` timeout after moving off the half-hourly lane |
| Yield supplemental overall deadline    | `12 minutes`        | `worker/src/lib/cron-lease.ts`                                    | Dedicated 4-hour `sync-yield-supplemental` timeout for optional protocol families |
| Live reserve history retention         | `90 days`           | `worker/src/lib/live-reserves-store-write.ts`                     | `reserve_composition_history` and `reserve_sync_attempt_history` are pruned during reserve-sync cleanup |
| Blacklist sync runtime budget          | `7 minutes`         | `worker/src/cron/sync-blacklist.ts`                               | Guardrail before the trigger wrapper times out                              |
| Blacklist sync subrequest budget       | `900`               | `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/evm-logs.ts` | Covers explorer/RPC calls for a single run                                  |
| Blacklist amount-recovery batch        | `100` rows / run    | `worker/src/cron/blacklist/amount-recovery.ts`                    | Conservative hourly EVM recovery cap; statements are chunked through the shared D1 batch helper and stay under the sync subrequest budget |
| Mint/burn global request budget        | `200`               | `worker/src/cron/sync-mint-burn.ts`                               | Shared per-run request ceiling                                              |
| Mint/burn per-config budget (critical) | `60`                | `worker/src/cron/sync-mint-burn.ts`                               | Prevents one hot config from consuming the full run                         |
| Mint/burn per-config budget (extended) | `25`                | `worker/src/cron/sync-mint-burn.ts`                               | Lower ceiling for long-tail backlog drain                                   |
| Mint/burn max scan range               | `50,000` blocks     | `worker/src/cron/sync-mint-burn.ts`                               | Keeps per-request log scans bounded                                         |
| Mint/burn SQL `IN` chunk size          | `90` ids            | `worker/src/cron/sync-mint-burn.ts`                               | Current safeguard for large batched SQL                                     |
| Mint/burn event insert batch size      | `50` statements     | `worker/src/lib/mint-burn-pipeline/persistence.ts`                | Each insert binds 18 values; chunked to stay below D1 batch bind ceilings   |

---

## Upstream Fetch Budgets

| Path                                  | Current repo throttle / budget                                               | Source                                    | Notes                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CoinGecko onchain discovery           | `250 ms` between requests                                                    | `worker/src/lib/rate-limit.ts`            | Used by discovery crawlers                                                                                         |
| CoinGecko onchain crawl budget        | `5 minutes`                                                                  | `worker/src/lib/rate-limit.ts`            | Per-source crawl budget, not full-run deadline                                                                     |
| CoinGecko backfill throttle           | `200 ms` between requests                                                    | `worker/src/lib/rate-limit.ts`            | Used by CoinGecko backfill/admin flows                                                                             |
| GeckoTerminal crawl throttle          | `2000 ms` between requests                                                   | `worker/src/lib/rate-limit.ts`            | Conservative crawl pacing                                                                                          |
| GeckoTerminal crawl budget            | `3 minutes`                                                                  | `worker/src/lib/rate-limit.ts`            | Per-source crawl budget                                                                                            |
| GeckoTerminal probe budget            | `3 minutes` per `sync-stablecoins` run                                       | `worker/src/lib/constants.ts`             | Prevents the serialized soft-source cross-check from consuming the full 8-minute stablecoin sync timeout           |
| DexScreener discovery fallback budget | `2 minutes` shared fallback window                                           | `worker/src/lib/rate-limit.ts`            | Shared with other late-stage discovery fallbacks                                                                   |
| Jupiter price fallback                | `50` ids/request, `5 s` timeout/request, `0` retries                         | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | Solana-only enrichment pass between CMC and DexScreener                                                            |
| DexScreener price-enrichment pass     | `10` total requests, `5 s` timeout/request, `45 s` total budget, `0` retries | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | Best-effort final fallback for missing prices; exact token-address lookups run first, and symbol search is reserved for addressless assets |
| CoinMarketCap fallback                | `1 call / hour`, `10 s` timeout, `0` retries                                 | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | Rate-limited through cache key `cmc_last_fetch`                                                                    |
| Generic circuit breaker               | opens after `3` consecutive failures, probes every `30 minutes`              | `worker/src/lib/circuit-breaker.ts`       | Used to stop hammering degraded upstreams                                                                          |

### What this means operationally

- `sync-dex-liquidity` no longer owns discovery. It consumes staged output written by `sync-dex-discovery`.
- `sync-dex-discovery` is deliberately best-effort. Short per-source request timeouts and the 12-minute shared budget are there to force a partial `degraded` result before the platform can hard-kill the invocation.
- Missing-price fallback is intentionally time-bounded so a bad upstream day cannot consume the whole `sync-stablecoins` slot.
- Any new provider added to discovery or price enrichment should come with both a throttle and a hard stop budget.

---

## Request Timeouts Worth Preserving

| Area                                | Current timeout              | Source                                            |
| ----------------------------------- | ---------------------------- | ------------------------------------------------- |
| CoinMarketCap price fallback        | `10_000 ms`                  | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` |
| Jupiter price fallback              | `5_000 ms`                   | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` |
| DexScreener price fallback requests | up to `5_000 ms` per request | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` |
| Ops admin status proxy reads       | `20_000 ms` for `/api/status` and `/api/status-history` | `functions/api/admin/[[path]].ts` |
| Live reserve adapter attempt        | `20_000 ms`                  | `worker/src/cron/sync-live-reserves.ts`                    |
| Live reserve D1 finalize timeout    | `30_000 ms`                  | `worker/src/cron/sync-live-reserves-core.ts`               |
| Blacklist explorer / RPC reads      | `15_000 ms`                  | `worker/src/lib/fetch-retry.ts` (default timeout)          |
| Daily digest LLM call (outer)       | `12 * 60_000 ms`             | `worker/src/lib/constants.ts`                              |
| Daily digest per-attempt fetch      | `11 * 60_000 ms`             | `worker/src/cron/digest/platform.ts` (`DIGEST_FETCH_PER_ATTEMPT_TIMEOUT_MS`) |

---

## Anthropic / Digest Runtime

Current digest generation constraints that are actually encoded in repo code:

- model: `claude-opus-4-7`
- thinking: adaptive (`thinking.type = "adaptive"`)
- reasoning effort: xhigh (`output_config.effort = "xhigh"`) — dropped from `max` on 2026-04-18 after runaway-thinking exhausted `max_tokens` twice (`stopReason=max_tokens` with only a `signature_delta` at both 16k and 32k). `max` has no constraint on thinking depth on Opus 4.7; `xhigh` is Anthropic's recommended level for complex editorial work and Claude Code's own default.
- Anthropic outer timeout: `12 * 60_000 ms` (12 min), bound by `AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)` in `platform.ts`
- per-attempt fetch timeout: `11 * 60_000 ms` (11 min), local to `requestDigestCopy`; safety net so a single stalled attempt cannot consume the outer budget
- retry depth for the digest Anthropic call: `2` (max 3 attempts); the outer `AbortSignal` caps total wall time regardless
- corrective retry skip: if first-pass elapsed `>= 50%` of the outer budget (6 min), the in-process retry after quality failures is skipped; the parse is accepted with `qualityIssues` flagged `degraded`
- daily cron lease (wrapper timeout): `14 * 60_000 ms` (14 min), leaves ~2 min under Cloudflare's 15-min scheduled-event ceiling for D1 persistence, Telegram/Twitter delivery, and cron_runs logging
- daily-digest heartbeat override: `heartbeatSec = 30`, `maxRenewFailures = 3` (see `worker/src/handlers/scheduled/context.ts` — default policy unchanged for other jobs)
- weekly cron lease: `12 * 60_000 ms` (12 min)
- max_tokens: `64000` daily, `64000` weekly — Anthropic's documented floor for Opus 4.7 at `xhigh`/`max` effort with adaptive thinking. Earlier settings of 16k → 32k at `effort: "max"` both hit `stop_reason=max_tokens` with no text emitted; the root-cause fix on 2026-04-18 lowered effort to `xhigh` and raised the ceiling to 64k in one change.
- cadence: daily scheduled run plus deferred manual admin trigger (see "Manual trigger runtime model" below)
- cost envelope (approximate, assuming single-attempt runs): Opus 4.7 input ~$5/Mtok, output ~$25/Mtok. Daily worst-case at 64k tokens ≈ $4.80; weekly worst-case at 64k ≈ $4.80. Annualized ≈ $2000 at cap. Actual usage is typically much lower since most runs don't approach the cap; the ceiling exists to survive adaptive-thinking-heavy runs. Monitor `usage.output_tokens` via the digest:last-trigger-result cache key or cron_runs metadata.

### Manual trigger runtime model

`POST /api/trigger-digest` does **not** execute the digest synchronously. It writes a `digest:force-run-request` flag into the `cache` D1 table and returns 202. A dedicated `*/5 * * * *` cron slot (`digestTriggerPoll`) reads the flag on its next tick and runs the digest under scheduled-event wall-clock (15 min). Outcome is persisted to `digest:last-trigger-result` for ops-UI visibility.

This two-step model exists because Cloudflare Workers terminate HTTP-triggered `ctx.waitUntil()` callbacks after ~30 seconds of tail work once the response is sent to the client — an Opus 4.7 digest run takes 5–10 min, so `waitUntil`-based execution dies silently without writing a `cron_runs` row or a digest. Per Cloudflare's documented semantics: *"When the client disconnects, all tasks associated with that request are canceled. Use `event.waitUntil()` to delay cancellation for another 30 seconds."* That extension is not enough for a digest run. Scheduled events have no such tail cap — they get the full 15-minute wall-clock.

Source: `worker/src/api/admin-actions.ts` (enqueue-only HTTP handler), `worker/src/handlers/scheduled/digest-trigger-poll.ts` (polling consumer).

Source: `worker/src/lib/constants.ts` (Anthropic timeout/retries), `worker/src/lib/cron-lease.ts` (`CRON_TIMEOUT_MS` per-job lease budget), `worker/src/cron/digest/platform.ts` (model/thinking/effort, per-attempt timeout, corrective-retry skip), `worker/src/cron/daily-digest.ts` and `worker/src/cron/weekly-recap.ts` (max_tokens), `worker/src/handlers/scheduled/context.ts` (`PER_JOB_LEASE_OPTIONS` heartbeat override)

This doc deliberately does not restate Anthropic account-tier RPM / token-plan numbers because those are not repo-enforced.

---

## Design Guidance

Before adding a worker feature that touches external services:

1. Pick the trigger slot first. Shared slots are a capacity decision, not just a schedule decision.
2. Add explicit throttle constants and an overall time budget before writing the fetch loop.
3. Prefer chunked / batched writes and bounded SQL fan-out.
4. Add or reuse a circuit breaker when the feature depends on a flaky upstream.
5. Update this doc only with limits the repo actually enforces or depends on architecturally.

If you need current provider-plan quotas, verify them outside the repo before relying on them.
