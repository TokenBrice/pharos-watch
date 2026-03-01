# Worker & API Limits

Reference for every hard constraint that matters during feature development. When designing a new feature, check here first — many of these limits are already near saturation.

---

## Cloudflare Workers (Paid — $5/mo)

The entire backend runs on a single Cloudflare Worker script.

| Resource | Limit | Notes |
|---|---|---|
| **Included requests/month** | 10 M | $0.30/M over |
| **Included CPU time/month** | 30 M CPU-ms | $0.02/M over |
| **CPU time per HTTP request** | 30 s default (up to 5 min configurable) | |
| **CPU time per Cron Trigger** | Up to **15 min** | Our crons run up to 30 min wall-clock, but only ~15 min CPU |
| **Cron Triggers per Worker** | **5 max** | ⚠️ We use all 5 slots: `*/15`, `3,23,43`, `10,40`, `0 8 * * *`, and the 5th piggybacked via minute-check. New cron jobs must piggyback on existing slots |
| **Concurrent outbound fetch() per invocation** | **6** | ⚠️ Hard platform limit. DEX liquidity already batches (2 DL fetches, then 4 Curve) to stay within budget |
| **Subrequests per invocation (default)** | 1,000 | Configurable up to 10,000 via `limits.subrequests` in wrangler.toml |
| **D1 connections per invocation** | 6 simultaneous | |
| **Environment variables** | Unlimited | |

> **Key constraint**: The 6-concurrent-fetch limit is the most commonly hit platform wall. Any new feature that fans out to multiple external APIs in parallel must count fetches carefully.

---

## Cloudflare D1 (Paid — included with Workers Paid)

One D1 database (`pharos-db`). All persistent state lives here.

| Resource | Free tier | Workers Paid |
|---|---|---|
| **Storage per database** | 500 MB | **10 GB (hard limit — cannot increase)** |
| **Max databases** | 10 | 50,000 |
| **Rows read included** | 5 M/day | 25 B/month (~833 M/day) — $0.001/M over |
| **Rows written included** | 100 K/day | 50 M/month (~1.67 M/day) — $1.00/M over |
| **Concurrent connections per invocation** | 6 | 6 |
| **Concurrency model** | Single-threaded per DB | Single-threaded per DB |

> **Key constraint**: D1 is single-threaded — it processes one query at a time per database. Batch large mutations (e.g. bulk inserts) in chunks of ≤1,000 rows to stay within execution limits. The 10 GB storage cap is absolute and cannot be raised.

---

## CoinGecko (Analyst Plan — ~$129/mo)

Primary source for token prices, market caps, and DEX pool discovery.

| Resource | Limit |
|---|---|
| **Requests/minute** | 500 req/min |
| **Monthly call quota** | 500,000 calls/month |
| **Onchain (/onchain) endpoints** | 250 req/min (shared with regular quota) |
| **Addresses per request** | Up to 50 (paid plan) |
| **Overage billing** | Disabled by default (hard cutoff at quota) |

**Current usage pattern**: The CG onchain API is called during the 30-min DEX liquidity cron with 250 ms between requests (~240 req/min). The monthly quota depends on cron frequency — if all tokens are crawled each run, this can add up quickly.

**Rate limit in code**: `CG_ONCHAIN_RATE_MS = 250` ms in `worker/src/lib/coingecko-onchain.ts`

> **Key constraint**: 500,000 calls/month ÷ ~2,880 cron runs/month (every 15 min) = ~174 CG calls per cron run on average before hitting the monthly cap. The pool crawl can easily blow through this if not throttled.

---

## GeckoTerminal (Free — standalone API)

Fallback DEX pool data source when CoinGecko onchain API is unavailable.

| Resource | Limit |
|---|---|
| **Requests/minute (free)** | ~30 req/min (dynamic, load-dependent) |
| **Requests/minute (with CG Analyst key)** | 250 req/min via CoinGecko `/onchain` endpoints |

**Rate limit in code**: `GT_RATE_LIMIT_MS = 2000` ms (30 req/min) in `worker/src/cron/sync-dex-liquidity.ts`

**Crawl budget**: 15 min max wall-time within the 30-min cron window (`GT_CRAWL_BUDGET_MS`). Not all 252+ token-chain combos can be crawled per run at 30 req/min.

---

## DexScreener (Free — no API key)

Third fallback for DEX pool data.

| Resource | Limit |
|---|---|
| **Requests/minute (pairs/DEX data)** | 300 req/min |
| **Requests/minute (token profiles/boosts)** | 60 req/min |
| **Authentication** | None required |
| **Historical data** | 24 hours only |
| **Paid tier** | None publicly available |

**Rate limit in code**: `DS_RATE_LIMIT_MS = 1100` ms (~54 req/min, conservative) in `worker/src/lib/dexscreener.ts`

---

## DefiLlama (Free — no API key)

Primary source for TVL, supply data, and protocol metadata. No documented hard rate limit.

| Resource | Limit |
|---|---|
| **Authentication** | None required |
| **Rate limit** | No strict limit (cache heavily for high-volume use) |
| **Commercial use** | Permitted |
| **Data freshness** | Updated every 5–15 min depending on protocol |
| **Pro API** | Separate paid subscription (not used) |

**Endpoints used**: `stablecoins.llama.fi/stablecoins`, `coins.llama.fi`, `api.llama.fi/protocols`, `yields.llama.fi/pools`

> **Key constraint**: No hard limit, but circuit breakers (`defillama-stablecoins`, `defillama-coins`, `defillama-yields`, `defillama-protocols`) are in place. Three consecutive failures open the circuit; 30-min probe interval before half-open retry.

---

## Etherscan V2 (Free API Key)

Used for blacklist event fetching and on-chain balance lookups.

| Resource | Limit |
|---|---|
| **Requests/second** | 3 req/s |
| **Requests/day** | 100,000 |
| **Chains available on free tier** | Ethereum mainnet + select others |
| **Chains now requiring paid plan ($49/mo)** | ⚠️ Base, BNB, Avalanche, Optimism |
| **V1 API** | Deprecated — disabled after May 31, 2025 |

**Budget system in code**: `createBudget(900)` — the blacklist cron self-caps at 900 Etherscan subrequests per run (`worker/src/cron/sync-blacklist.ts`).

> **Key constraint**: If we add blacklist tracking for Base, BNB, Avalanche, or Optimism, we need the $49/month Etherscan paid plan for each chain. Currently using public RPC fallbacks for those chains.

---

## TronGrid (Free API Key)

Used for USDT-Tron blacklist event fetching.

| Resource | Limit |
|---|---|
| **Requests/second (with API key)** | 15 QPS |
| **Requests/day** | 100,000 |
| **Max API keys per account** | 3 |
| **Requests without API key** | Severely limited / rejected |

---

## Alchemy (Free Plan)

Primary RPC provider for EVM chains (Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, Tron).

| Resource | Limit |
|---|---|
| **Compute Units (CUs)/month** | 30 M CUs |
| **Throughput** | 500 CU/s (10-second rolling window) |
| **Approx. requests/sec** | ~50 RPS (for 10-CU methods like `eth_blockNumber`) |
| **`eth_call` cost** | 26 CUs |
| **Overage** | HTTP 429 — no auto-upgrade |

> **Key constraint**: The on-chain supply cron is the biggest consumer. Batch `eth_call` calls (our code supports up to 25 per batch on Alchemy). 30M CUs ÷ 26 CU/call = ~1.15 M `eth_call`s/month.

---

## dRPC (Free Plan)

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

## Anthropic Claude API (Pay-as-you-go)

Used exclusively for daily digest generation — one call per day.

| Resource | Tier 1 | Tier 4 |
|---|---|---|
| **Requests/minute** | 50 RPM | 4,000 RPM |
| **Input tokens/min (Sonnet)** | 30,000 ITPM | 2,000,000 ITPM |
| **Output tokens/min (Sonnet)** | 8,000 OTPM | 400,000 OTPM |
| **Monthly spend limit** | $100 | $5,000 |

**Current usage**: 1 call/day × 800 max output tokens = negligible. Well within any tier.

**Model in use**: `claude-sonnet-4-6` (`worker/src/cron/daily-digest.ts`). 60-second timeout.

---

## Twitter / X API (Free Tier)

Used to post the daily digest as a tweet.

| Resource | Free ($0) | Basic ($100/mo) |
|---|---|---|
| **Posts/month** | ~500 | 50,000 |
| **Reads/month** | Very limited | 15,000 |
| **Search** | ❌ | ✅ (7-day) |

**Current usage**: 1 post/day = ~30 posts/month. Fits comfortably in the free tier.

> **Key constraint**: If we ever add read operations (fetching replies, quote tweets, analytics), the free tier is essentially read-blocked. Even the Basic plan at $100/mo limits reads to 15,000/month.

---

## Telegram Bot API (Free)

Used to post the daily digest to a channel.

| Resource | Limit |
|---|---|
| **Messages/sec (single chat)** | 1 msg/s |
| **Messages/min (group/channel)** | 20 msgs/min |
| **Messages/sec (global, all chats)** | 30 msgs/s |
| **Authentication** | Bot token (free) |

**Current usage**: 1 message/day. No risk of hitting any limit.

---

## GitHub API (PAT — Free)

Used by the feedback widget to route submissions as GitHub issues or discussions.

| Resource | Limit |
|---|---|
| **Requests/hour (authenticated PAT)** | 5,000 req/hour |
| **Requests/hour (unauthenticated)** | 60 req/hour |
| **GraphQL requests/hour** | 5,000 (same pool as REST) |
| **Secondary limits** | >100 concurrent requests, rapid content creation |

**Current usage**: ~1–10 issues/discussions per day. No risk of hitting limits.

---

## Frankfurter (Free — ECB FX Rates)

Used for FX rate sync (EUR, GBP, JPY, IDR, and 10+ other currencies against USD).

| Resource | Limit |
|---|---|
| **Authentication** | None required |
| **Rate limit** | None |
| **Cost** | Free, open-source |
| **Data freshness** | Updated daily ~16:00 CET (ECB business days only) |
| **Historical data** | Back to January 4, 1999 |

> **Caveat**: RUB (Russian Ruble) is not published by the ECB due to sanctions — hardcoded fallback of $0.011 in the codebase.

---

## gold-api.com (Free)

Used for XAU (gold) and XAG (silver) spot prices.

| Resource | Limit |
|---|---|
| **Authentication** | None required |
| **Rate limit** | None documented |
| **Cost** | Free |

---

## CoinMarketCap (Basic — Free)

Fallback price source for non-USD fiat and commodity tokens when DefiLlama has no price.

| Resource | Limit |
|---|---|
| **Call credits/month** | 10,000 |
| **Approx. calls/day** | ~333 |
| **Commercial use** | ❌ Not permitted on Basic plan |
| **Rate limit** | Resets every 60 seconds |

> **Key constraint**: 10,000 credits/month is tight if used aggressively. Currently a last-resort fallback — DefiLlama and CoinGecko handle most prices. The Basic plan also prohibits commercial use; if CMC usage grows, we'd need the $29/mo Hobbyist plan.

---

## Currency API / fawazahmed0 (Free CDN)

Fallback for FX rates when Frankfurter is unavailable.

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
| Cloudflare cron trigger slots (5 max) | 0 free — all 5 used | 🔴 Any new scheduled job must piggyback |
| Cloudflare concurrent fetch() (6/invocation) | Already batching to avoid | 🔴 Cannot add more parallel fetches without refactoring |
| CoinGecko monthly quota (500K calls) | Medium — pool crawl can spike | 🟡 Monitor `/key` endpoint for usage |
| D1 storage (10 GB hard cap) | Plenty now, but supply history + liquidity history grows | 🟡 Add periodic pruning if tables grow fast |
| Etherscan free tier (chains) | Base/BNB/Avalanche/Optimism need paid plan | 🟡 Paid at $49/chain/mo if we track those |
| Alchemy free CUs (30M/month) | Tight if on-chain supply cron is frequent | 🟡 Monitor usage |
| CoinMarketCap Basic (10K credits/month) | Fine as last-resort fallback only | 🟢 |
| GeckoTerminal crawl budget (15 min/run) | Enforced by code — not all coins crawled every run | 🟢 Accepted tradeoff |
| Twitter Free tier (500 posts/month) | 1/day = ~30/month | 🟢 |
| Telegram / GitHub / Frankfurter / gold-api | No meaningful limits | 🟢 |
