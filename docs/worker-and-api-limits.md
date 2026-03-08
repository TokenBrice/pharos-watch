# Worker & API Limits

Reference for repo-relevant operational limits. The code-backed source of truth here is the cited cron schedules, throttle constants, and handler behavior; third-party quota/pricing notes should be re-verified against vendor docs before making spend-sensitive changes.

---

## Cloudflare Workers

The entire backend runs on a single Cloudflare Worker script.

| Resource | Limit | Notes |
|---|---|---|
| **Included requests/month** | 10 M | $0.30/M over |
| **Included CPU time/month** | 30 M CPU-ms | $0.02/M over |
| **CPU time per HTTP request** | 30 s default (up to 5 min configurable) | |
| **CPU time per Cron Trigger** | 30 s if the schedule runs more than once per hour; 15 min otherwise | Platform default. This repo additionally sets `cpu_ms = 5000` in `worker/wrangler.toml`, so our effective per-invocation CPU cap is 5 s unless reconfigured |
| **Cron Triggers** | No current per-worker cap; account quota applies | Cloudflare removed the old per-worker trigger cap. This repo currently uses 4 cron expressions: `*/15`, `3,23,43`, `10,40`, `0 8 * * *` |
| **Concurrent outbound fetch() per invocation** | **6** | ⚠️ Hard platform limit. DEX liquidity already batches (2 DL fetches, then 4 Curve) to stay within budget |
| **Subrequests per invocation (Workers Standard default)** | 10,000 | Configurable higher on Workers Paid; the old 1,000-subrequest cap was removed |
| **D1 connections per invocation** | 6 simultaneous | |
| **Environment variables** | Unlimited | |

> **Key constraint**: The 6-concurrent-fetch limit is the most commonly hit platform wall. Any new feature that fans out to multiple external APIs in parallel must count fetches carefully. **This limit is shared across all `ctx.waitUntil()` jobs on the same cron slot** — e.g. `sync-dex-liquidity` and `sync-yield-data` both run on `10,40` and must budget their combined connections to stay under 6. Consume response bodies promptly to release connections for sibling jobs.

---

## Cloudflare D1

One D1 database (`stablecoin-db`). All persistent state lives here.

| Resource | Free tier | Workers Paid |
|---|---|---|
| **Storage per database** | 500 MB | **10 GB (hard limit — cannot increase)** |
| **Max databases** | 10 | 50,000 |
| **Rows read included** | 5 M/day | 25 B/month (~833 M/day) — $0.001/M over |
| **Rows written included** | 100 K/day | 50 M/month (~1.67 M/day) — $1.00/M over |
| **Concurrent connections per invocation** | 6 | 6 |
| **Concurrency model** | Single-threaded per DB | Single-threaded per DB |

> **Key constraint**: D1 is single-threaded — it processes one query at a time per database. Batch large mutations (e.g. bulk inserts) in chunks of ≤1,000 rows to stay within execution limits. The 10 GB storage cap is absolute and cannot be raised.
>
> `sync-yield-data` follows this by batching high-volume `yield_history` reads (previous exchange rates, previous TVL rows, 30d APY history) and grouping rows in-memory instead of issuing per-coin queries.

---

## CoinGecko

Primary source for token prices, market caps, and DEX pool discovery.

| Resource | Limit |
|---|---|
| **Requests/minute** | 500 req/min |
| **Monthly call quota** | 500,000 calls/month |
| **Onchain (/onchain) endpoints** | 250 req/min (shared with regular quota) |
| **Addresses per request** | Up to 50 (paid plan) |
| **Overage billing** | Disabled by default (hard cutoff at quota) |

**Current usage pattern**: The CG onchain API is called during the 30-min DEX liquidity cron with 250 ms between requests (~240 req/min). The monthly quota depends on cron frequency — if all tokens are crawled each run, this can add up quickly. `sync-yield-data` also adds 1 regular CoinGecko `/simple/price` call per run for the conservative LUSD B.Protocol APR.

**Rate limit in code**: `RATE_LIMITS.COINGECKO_ONCHAIN_MS = 250` ms in `worker/src/lib/rate-limit.ts` (used by `worker/src/lib/coingecko-onchain.ts`)

> **Key constraint**: 500,000 calls/month ÷ ~1,440 cron runs/month (every 30 min) = ~347 CG calls per cron run on average before hitting the monthly cap. The pool crawl can still blow through this if not throttled.

---

## GeckoTerminal

Fallback DEX pool data source when CoinGecko onchain API is unavailable.

| Resource | Limit |
|---|---|
| **Requests/minute (free)** | ~30 req/min (dynamic, load-dependent) |
| **Requests/minute (with CG Analyst key)** | 250 req/min via CoinGecko `/onchain` endpoints |

**Rate limit in code**: `GECKO_TERMINAL_MS = 2000` ms (30 req/min) in `worker/src/lib/rate-limit.ts`, used by `worker/src/cron/dex-liquidity/fetch-crawlers.ts`

**Crawl budget**: 8 min max wall-time within the 30-min cron window (`CRAWL_BUDGETS.GECKO_TERMINAL_MS`). This intentionally leaves enough room for the post-crawl scoring and persistence phases before the 13-minute app timeout / 15-minute Cloudflare wall-clock cap.

---

## DexScreener

Third fallback for DEX pool data.

| Resource | Limit |
|---|---|
| **Requests/minute (pairs/DEX data)** | 300 req/min |
| **Requests/minute (token profiles/boosts)** | 60 req/min |
| **Authentication** | None required |
| **Historical data** | 24 hours only |
| **Paid tier** | None publicly available |

**Rate limit in code**: `RATE_LIMITS.DEXSCREENER_MS = 1100` ms (~54 req/min, conservative) in `worker/src/lib/rate-limit.ts` (used by `worker/src/lib/dexscreener.ts`)

---

## DefiLlama

Primary source for TVL, supply data, and protocol metadata. No documented hard rate limit.

| Resource | Limit |
|---|---|
| **Authentication** | None required |
| **Rate limit** | No strict limit (cache heavily for high-volume use) |
| **Commercial use** | Permitted |
| **Data freshness** | Updated every 5–15 min depending on protocol |
| **Pro API** | Separate paid subscription (not used) |

**Endpoints used**: `stablecoins.llama.fi/stablecoins`, `coins.llama.fi`, `api.llama.fi/protocols`, `yields.llama.fi/pools`

> **Key constraint**: No hard limit, but circuit breakers (`defillama-stablecoins`, `defillama-coins`, `defillama-yields`, `defillama-protocols`, `coingecko-prices`, `coingecko-mcap`, `treasury-rates`) are in place. Three consecutive failures open the circuit; 30-min probe interval before half-open retry.

---

## Etherscan V2

Used for supported-chain blacklist log fetching and Ethereum L1 on-chain balance lookups. Mint/burn flows have been migrated to Alchemy.

| Resource | Limit |
|---|---|
| **Requests/second** | 5 req/s |
| **Requests/day** | 100,000 |
| **Chains available on free tier** | Multi-chain via `chainid` parameter, but Base/BNB/Avalanche/Optimism log access requires a paid plan |
| **L2 historical `eth_call` via Etherscan free** | Limited / unreliable for several L2s (we use dRPC for L2 balance lookups) |
| **V1 API** | Deprecated — disabled after May 31, 2025 |

**Budget system in code**: `createBudget(900)` — the blacklist cron self-caps at 900 Etherscan subrequests per run (`worker/src/cron/sync-blacklist.ts`).

> **Key constraint**: Blacklist sync is hard-capped to 900 Etherscan subrequests/run. Historical L2 balance lookups are routed through dRPC archive RPC instead of Etherscan `eth_call`, and Base/BNB/Avalanche/Optimism log scans must use chain RPC (`eth_getLogs`) rather than Etherscan free-tier `getLogs`.

---

## TronGrid

Used for USDT-Tron blacklist event fetching.

| Resource | Limit |
|---|---|
| **Requests/second (with API key)** | 15 QPS |
| **Requests/day** | 100,000 |
| **Max API keys per account** | 3 |
| **Requests without API key** | Severely limited / rejected |

---

## Alchemy

Primary RPC provider for mint/burn ingestion and shared chain-RPC utilities (Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, Tron).

| Resource | Limit |
|---|---|
| **Compute Units (CUs)/month** | 30 M CUs |
| **Throughput** | 500 CU/s (10-second rolling window) |
| **Approx. requests/sec** | ~50 RPS (for 10-CU methods like `eth_blockNumber`) |
| **`eth_call` cost** | 26 CUs |
| **Overage** | HTTP 429 — no auto-upgrade |

> **Key constraint**: Mint/burn flow sync is the largest steady Alchemy consumer. Batch `eth_call` calls (where used) support up to 25 per batch. 30M CUs ÷ 26 CU/call = ~1.15 M `eth_call`s/month.

**Mint/burn usage**: `sync-mint-burn` now uses Alchemy for all `eth_getLogs` and `eth_blockNumber` calls.
Steady-state: ~35 getLogs + 4 blockNumbers + ~30 batch timestamp lookups per run → ~3,000 CUs/run.
72 runs/day × 30 days → ~6.5M CUs/month (22% of 30M free-tier CU cap).

**Yield sync usage**: When Ethereum RPC is backed by Alchemy, `sync-yield-data` adds 2 `eth_call`s per 30-minute run for the conservative LUSD B.Protocol source (~2,880 `eth_call`s/month).

**Per-chain `eth_getLogs` block range limits (PAYG):**
| Chain | Limit |
|---|---|
| Ethereum, Arbitrum, Base, Optimism | Unlimited |
| Avalanche | 10,000 blocks |
| Polygon | 2,000 blocks |

---

## dRPC

Primary RPC for Gnosis, Fantom, and Celo (chains not supported well by Alchemy free).

| Resource | Limit |
|---|---|
| **Throughput (normal conditions)** | ~2,100 CU/s (~250 `eth_call`/s) |
| **Throughput (high-demand minimum)** | ~50,400 CU/min (~40 `eth_call`/s) |
| **Regional adjustments** | May reduce further during peak load |
| **API key** | Required |

---

## The Graph (Decentralized Network)

Used for Uniswap V3 subgraph queries (pool discovery on Ethereum, Base, Arbitrum, Polygon).

| Resource | Limit |
|---|---|
| **Query model** | Pay-per-query in GRT |
| **Free queries/month** | ~100,000 via hosted service |
| **API key** | Required (`GRAPH_API_KEY`) |
| **Cost** | ~$0.0001–0.001 per query (varies by indexer) |
| **Latency** | Variable (decentralized indexers) |

---

## Anthropic Claude API

Used exclusively for daily digest generation — one call per day.

| Resource | Tier 1 | Tier 4 |
|---|---|---|
| **Requests/minute** | 50 RPM | 4,000 RPM |
| **Input tokens/min (Sonnet)** | 30,000 ITPM | 2,000,000 ITPM |
| **Output tokens/min (Sonnet)** | 8,000 OTPM | 400,000 OTPM |
| **Monthly spend limit** | $100 | $5,000 |

**Current usage**: 1 call/day × 800 max output tokens = negligible. Well within any tier.

**Model in use**: `claude-opus-4-6` (`worker/src/cron/daily-digest.ts`). 120-second timeout.

---

## Twitter / X API

Used to post the daily digest as a tweet.

| Resource | Free ($0) | Basic ($100/mo) |
|---|---|---|
| **Posts/month** | ~500 | 50,000 |
| **Reads/month** | Very limited | 15,000 |
| **Search** | ❌ | ✅ (7-day) |

**Current usage**: 1 post/day = ~30 posts/month. Fits comfortably in the free tier.

> **Key constraint**: If we ever add read operations (fetching replies, quote tweets, analytics), the free tier is essentially read-blocked. Even the Basic plan at $100/mo limits reads to 15,000/month.

---

## Telegram Bot API

Used to post the daily digest to a channel.

| Resource | Limit |
|---|---|
| **Messages/sec (single chat)** | 1 msg/s |
| **Messages/min (group/channel)** | 20 msgs/min |
| **Messages/sec (global, all chats)** | 30 msgs/s |
| **Authentication** | Bot token (free) |

**Current usage**: 1 message/day. No risk of hitting any limit.

---

## GitHub API

Used by the feedback widget to route submissions as GitHub issues or discussions.

| Resource | Limit |
|---|---|
| **Requests/hour (authenticated PAT)** | 5,000 req/hour |
| **Requests/hour (unauthenticated)** | 60 req/hour |
| **GraphQL requests/hour** | 5,000 (same pool as REST) |
| **Secondary limits** | >100 concurrent requests, rapid content creation |

**Current usage**: ~1–10 issues/discussions per day. No risk of hitting limits.

---

## Frankfurter

Used for FX rate sync (EUR, GBP, JPY, IDR, and 10+ other currencies against USD).

| Resource | Limit |
|---|---|
| **Authentication** | None required |
| **Rate limit** | None |
| **Cost** | Free, open-source |
| **Data freshness** | Updated daily ~16:00 CET (ECB business days only) |
| **Historical data** | Back to January 4, 1999 |

> **Caveat**: Frankfurter is not sufficient for every tracked fiat peg. CNH is sourced separately, and RUB (Russian Ruble) still has a hardcoded fallback of $0.011 if the secondary feed is unavailable.

---

## gold-api.com

Used for XAU (gold) and XAG (silver) spot prices.

| Resource | Limit |
|---|---|
| **Authentication** | None required |
| **Rate limit** | None documented |
| **Cost** | Free |

---

## CoinMarketCap

Fallback price source for non-USD fiat and commodity tokens when DefiLlama has no price.

| Resource | Limit |
|---|---|
| **Call credits/month** | 10,000 |
| **Approx. calls/day** | ~333 |
| **Commercial use** | ❌ Not permitted on Basic plan |
| **Rate limit** | Resets every 60 seconds |

> **Key constraint**: 10,000 credits/month is tight if used aggressively. Currently a last-resort fallback — DefiLlama and CoinGecko handle most prices. The Basic plan also prohibits commercial use; if CMC usage grows, we'd need the $29/mo Hobbyist plan.

---

## Currency API / fawazahmed0

Used to extend FX coverage beyond Frankfurter, including CNH, and as the secondary source for RUB/UAH/ARS.

| Resource | Limit |
|---|---|
| **Authentication** | None |
| **Rate limit** | None (static CDN JSON file) |
| **Cost** | Free |
| **CDN** | `cdn.jsdelivr.net` + `latest.currency-api.pages.dev` |

---

## Summary: Most Constrained Resources

| Constraint | Current headroom | Risk |
|---|---|---|
| Cloudflare cron expressions | 4 configured in this repo; no current per-worker cap | 🟢 Scheduling headroom exists, but piggyback existing slots unless cadence truly differs |
| Cloudflare concurrent fetch() (6/invocation) | Already batching to avoid | 🔴 Cannot add more parallel fetches without refactoring |
| CoinGecko monthly quota (500K calls) | Medium — pool crawl can spike | 🟡 Monitor `/key` endpoint for usage |
| D1 storage (10 GB hard cap) | Plenty now, but supply history + liquidity history grows | 🟡 Add periodic pruning if tables grow fast |
| Etherscan free tier (chains) | Base/BNB/Avalanche/Optimism need paid plan | 🟡 Paid at $49/chain/mo if we track those |
| Alchemy PAYG CUs (30M free + $0.40/M over) | ~6.5M CUs/month for supply + mint/burn combined | 🟢 Plenty of headroom |
| CoinMarketCap Basic (10K credits/month) | Fine as last-resort fallback only | 🟢 |
| GeckoTerminal crawl budget (8 min/run) | Enforced by code — not all coins crawled every run | 🟢 Accepted tradeoff |
| Twitter Free tier (500 posts/month) | 1/day = ~30/month | 🟢 |
| Telegram / GitHub / Frankfurter / gold-api | No meaningful limits | 🟢 |
