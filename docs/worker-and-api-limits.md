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
- `worker/src/lib/circuit-breaker.ts`
- `worker/src/handlers/http.ts`
- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/sync-fx-rates.ts`
- `worker/src/cron/daily-digest.ts`

---

## Worker Runtime

| Constraint | Current repo value | Source | Notes |
|---|---|---|---|
| Worker CPU budget per invocation | `30000` ms | `worker/wrangler.toml` | Hard repo-configured CPU cap via `[limits].cpu_ms` |
| Cron expressions / trigger slots | `10` | `worker/wrangler.toml`, `shared/lib/cron-jobs.ts` | Public status tooling groups around these trigger slots |
| Status-tracked cron jobs | `25` | `shared/lib/cron-jobs.ts` | These are the jobs expected by `/api/status` |
| Runtime jobs actually scheduled | `26` | `shared/lib/cron-jobs.ts`, `worker/src/cron/announce-cemetery-additions.ts` | The extra runtime job is `announce-cemetery-additions`, intentionally excluded from shared status metadata |
| Public API limiter | `300 requests / 60 seconds` per IP hash | `worker/src/handlers/http.ts`, `worker/src/lib/rate-limit.ts` | Enforced through D1-backed `public_api_rate_limit`; falls back to isolate-local memory if the distributed path fails |
| Feedback limiter | `3 submissions / 10 minutes` per salted IP hash | `worker/src/api/feedback.ts`, `worker/src/lib/rate-limit.ts` | Separate from the general public API limiter |

### Connection-budget operating assumption

The scheduler is deliberately structured around the repo's six-connection-per-trigger operating constraint:

- heavy lanes get isolated trigger slots (`sync-blacklist`, `sync-mint-burn`, `sync-mint-burn-extended`, `sync-dex-discovery`)
- shared slots bundle only related work
- the quarter-hourly handler sequences jobs instead of fanning them out blindly

Treat any new fetch-heavy work added to an existing trigger slot as competing for the same trigger-wide outbound connection budget.

---

## Cron Budgeting

| Area | Current repo budget | Source | Notes |
|---|---|---|---|
| DEX discovery overall deadline | `20 minutes` | `worker/src/cron/dex-discovery/orchestrator.ts` | Shared deadline for the discovery pass before persistence/cleanup tail work |
| Blacklist sync runtime budget | `7 minutes` | `worker/src/cron/sync-blacklist.ts` | Guardrail before the trigger wrapper times out |
| Blacklist sync subrequest budget | `900` | `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/evm-logs.ts` | Covers explorer/RPC calls for a single run |
| Mint/burn global request budget | `200` | `worker/src/cron/sync-mint-burn.ts` | Shared per-run request ceiling |
| Mint/burn per-config budget (critical) | `60` | `worker/src/cron/sync-mint-burn.ts` | Prevents one hot config from consuming the full run |
| Mint/burn per-config budget (extended) | `25` | `worker/src/cron/sync-mint-burn.ts` | Lower ceiling for long-tail backlog drain |
| Mint/burn max scan range | `50,000` blocks | `worker/src/cron/sync-mint-burn.ts` | Keeps per-request log scans bounded |
| Mint/burn SQL `IN` chunk size | `90` ids | `worker/src/cron/sync-mint-burn.ts` | Current safeguard for large batched SQL |

---

## Upstream Fetch Budgets

| Path | Current repo throttle / budget | Source | Notes |
|---|---|---|---|
| CoinGecko onchain discovery | `250 ms` between requests | `worker/src/lib/rate-limit.ts` | Used by discovery crawlers |
| CoinGecko onchain crawl budget | `5 minutes` | `worker/src/lib/rate-limit.ts` | Per-source crawl budget, not full-run deadline |
| CoinGecko backfill throttle | `200 ms` between requests | `worker/src/lib/rate-limit.ts` | Used by CoinGecko backfill/admin flows |
| GeckoTerminal crawl throttle | `2000 ms` between requests | `worker/src/lib/rate-limit.ts` | Conservative crawl pacing |
| GeckoTerminal crawl budget | `3 minutes` | `worker/src/lib/rate-limit.ts` | Per-source crawl budget |
| DexScreener discovery fallback budget | `2 minutes` shared fallback window | `worker/src/lib/rate-limit.ts` | Shared with other late-stage discovery fallbacks |
| Jupiter price fallback | `50` ids/request, `5 s` timeout/request, `0` retries | `worker/src/cron/enrich-prices-passes.ts` | Solana-only enrichment pass between CMC and DexScreener |
| DexScreener price-enrichment pass | `10` total requests, `5 s` timeout/request, `45 s` total budget, `0` retries | `worker/src/cron/enrich-prices.ts` | Best-effort final fallback for missing prices; exact token-address lookups run before symbol search when available |
| CoinMarketCap fallback | `1 call / hour`, `10 s` timeout, `0` retries | `worker/src/cron/enrich-prices.ts` | Rate-limited through cache key `cmc_last_fetch` |
| Generic circuit breaker | opens after `3` consecutive failures, probes every `30 minutes` | `worker/src/lib/circuit-breaker.ts` | Used to stop hammering degraded upstreams |

### What this means operationally

- `sync-dex-liquidity` no longer owns discovery. It consumes staged output written by `sync-dex-discovery`.
- Missing-price fallback is intentionally time-bounded so a bad upstream day cannot consume the whole `sync-stablecoins` slot.
- Any new provider added to discovery or price enrichment should come with both a throttle and a hard stop budget.

---

## Request Timeouts Worth Preserving

| Area | Current timeout | Source |
|---|---|---|
| CoinMarketCap price fallback | `10_000 ms` | `worker/src/cron/enrich-prices.ts` |
| Jupiter price fallback | `5_000 ms` | `worker/src/cron/enrich-prices-passes.ts` |
| DexScreener price fallback requests | up to `5_000 ms` per request | `worker/src/cron/enrich-prices.ts` |
| Blacklist explorer / RPC reads | `15_000 ms` | `worker/src/lib/fetch-retry.ts` (default timeout) |
| Daily digest LLM call | `120_000 ms` | `worker/src/cron/daily-digest.ts` |

---

## Anthropic / Digest Runtime

Current digest generation constraints that are actually encoded in repo code:

- model: `claude-opus-4-6`
- timeout: `120_000 ms`
- cadence: daily scheduled run plus manual admin trigger

Source: `worker/src/cron/daily-digest.ts`

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
