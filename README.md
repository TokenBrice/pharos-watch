# Pharos — Stablecoin Analytics Dashboard

Public-facing analytics dashboard tracking 142 stablecoins across multiple peg currencies, backing types, and governance models. Pure information site — no wallet connectivity, no user accounts.

**Live at [pharos.watch](https://pharos.watch)**

## Features

- **Three-tier classification** — stablecoins categorized as CeFi, CeFi-Dependent, or DeFi based on actual dependency on centralized infrastructure, not marketing claims
- **Multi-peg support** — USD, EUR, GBP, CHF, BRL, RUB, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN, UAH, ARS, gold, and silver stablecoins with cross-currency FX-adjusted totals
- **Peg Tracker** — continuous peg monitoring with a composite Peg Score (0–100) for every tracked stablecoin, depeg event detection with direction tracking, deviation heatmaps, and a historical timeline going back 4 years
- **Freeze & Blacklist Tracker** — real-time on-chain tracking of USDC, USDT, EURC, PAXG, and XAUT freeze/blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron with BigInt-precision amounts
- **DEX Liquidity Score** — composite liquidity score (0–100) per stablecoin from DEX pool TVL, volume, quality, durability, diversity, and cross-chain coverage
- **DEX Price Cross-Validation** — implied prices from Curve, Uniswap V3, Aerodrome, and DexScreener pools used to suppress false depeg alerts
- **Compare** — side-by-side stablecoin comparison across key metrics
- **Daily Digest** — AI-generated daily summary of market movements and notable events
- **Stablecoin Cemetery** — 77 dead stablecoins documented with cause of death, peak market cap, and obituaries
- **Bluechip Safety Ratings** — independent stablecoin safety ratings from the SMIDGE framework
- **Detail pages** — price chart, supply history, chain distribution, liquidity card, and safety ratings for each stablecoin
- **Status dashboard** — cron health, cache freshness, and system monitoring
- **Backing type breakdown** — RWA-backed, crypto-backed, and algorithmic
- **Yield-bearing & NAV token filters** — identify tokens that accrue yield natively
- **Research-grade data pipeline** — structural validation, concurrent write protection, depeg deduplication, and price validation guardrails
- **Dark/light mode**

## Tech Stack

- **Frontend:** Next.js 16 (App Router, static export), React 19, TypeScript (strict)
- **Styling:** Tailwind CSS v4, shadcn/ui (Radix primitives)
- **Charts:** TanStack Query, Recharts
- **API:** Cloudflare Worker (cron-based data fetching + REST endpoints)
- **Database:** Cloudflare D1 (SQLite — caches stablecoin data, logos, blacklist events, depeg events)
- **Hosting:** Cloudflare Pages

## Data Sources

All external API calls go through the Cloudflare Worker. The frontend never calls external APIs directly.

| Source | Purpose | Refresh |
|--------|---------|---------|
| [DefiLlama](https://defillama.com/) | Stablecoin supply, price, chain distribution, history | 15 min |
| [DefiLlama Yields](https://yields.llama.fi/) | DEX pool TVL, volume, and composition for liquidity scoring | 15 min |
| [Curve Finance API](https://api.curve.finance/) | Pool A-factors, per-token balances, implied prices | 15 min |
| [The Graph](https://thegraph.com/) | Uniswap V3 (4 chains) + Aerodrome (Base) subgraphs for fee tiers and implied prices | 15 min |
| [DexScreener](https://dexscreener.com/) | Batch token API for implied prices + search API for price fallback | 15 min |
| [CoinGecko](https://www.coingecko.com/) | Gold/silver/fiat token supply (not in DefiLlama), fallback price enrichment | 15 min (as fallback) |
| [CoinMarketCap](https://coinmarketcap.com/) | Fallback price enrichment for assets with CMC slugs | 15 min (rate-limited to 1/hour) |
| [Etherscan v2](https://etherscan.io/) | USDC, USDT, EURC, PAXG, XAUT freeze/blacklist events (EVM chains) | 15 min |
| [TronGrid](https://www.trongrid.io/) | USDT freeze events on Tron | 15 min |
| [dRPC](https://drpc.org/) / [Alchemy](https://www.alchemy.com/) | Archive RPC for L2 balance lookups at historical block heights | 15 min |
| [frankfurter.app](https://frankfurter.app/) | ECB FX rates for EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN | 15 min |
| [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) | Live RUB, UAH, ARS rates (ECB doesn't publish these currencies) | 15 min |
| [gold-api.com](https://gold-api.com/) | Gold and silver spot prices for commodity-pegged stablecoin peg validation | 15 min |
| [Bluechip](https://bluechip.org/) | Independent stablecoin safety ratings (SMIDGE framework) | Daily |
| [Anthropic](https://anthropic.com/) | AI-generated daily market digest | Daily |

## Getting Started

### Frontend

```bash
npm install
NEXT_PUBLIC_API_BASE=http://localhost:8787 npm run dev
```

### Worker API

```bash
cd worker
npx wrangler dev
```

To trigger crons manually:

```bash
npx wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

### Other commands

```bash
npm run build    # Production build (includes type-checking)
npm run lint     # ESLint
cd worker && npx tsc --noEmit   # Type-check worker
```

## Project Structure

```
src/                              Frontend (Next.js static export)
├── app/
│   ├── page.tsx                  Homepage: stats, charts, filters, table
│   ├── peg-tracker/              Peg monitoring: scores, heatmap, timeline
│   ├── blacklist/                Freeze & blacklist event tracker
│   ├── liquidity/                DEX liquidity scores and pool breakdown
│   ├── compare/                  Side-by-side stablecoin comparison
│   ├── digest/                   AI-generated daily market digest
│   ├── cemetery/                 Dead stablecoin graveyard
│   ├── status/                   System health and cron monitoring
│   ├── stablecoin/[id]/          Detail page per stablecoin
│   └── about/                    About & methodology
├── components/                   UI components (table, charts, cards, shared sort-icon, time-range-buttons)
├── hooks/                        Data fetching hooks (TanStack Query) + shared UI hooks (useSort, useUrlFilters, useTimeRangeFilter)
└── lib/                          Types, formatters, peg score, classification labels, shared helpers

worker/                           Cloudflare Worker (API + cron jobs)
├── src/
│   ├── cron/                     Scheduled data sync (sync-stablecoins, enrich-prices, detect-depegs, sync-dex-liquidity, etc.)
│   ├── api/                      REST endpoints (17 handlers, all wrapped with withErrorHandler)
│   └── lib/                      D1 helpers, shared constants, depeg types, API error handler
└── migrations/                   D1 SQL migrations (20 total)
```

## Infrastructure

```
Cloudflare Worker (API layer)
  ├── Cron: */15 * * * *   → sync stablecoins + charts + DEX liquidity + blacklist + USDS status + FX rates + supply snapshots
  └── Cron: 0 8 * * *      → Bluechip safety ratings + daily digest

Cloudflare D1 (SQLite database)
  ├── cache                → JSON blobs (stablecoin list, per-coin detail, charts, logos) with CAS write guard
  ├── blacklist_events     → normalized freeze/blacklist events
  ├── blacklist_sync_state → incremental sync progress (block numbers for EVM, timestamps for Tron)
  ├── depeg_events         → peg deviation events with unique constraint + direction tracking
  ├── price_cache          → historical price snapshots for depeg detection
  ├── dex_liquidity        → per-stablecoin DEX liquidity scores, pool data, HHI, depth stability
  ├── dex_liquidity_history → daily TVL/score snapshots for trend analysis
  ├── dex_prices           → DEX-implied prices from Curve, Uni V3, Aerodrome, DexScreener
  ├── supply_history       → twice-daily on-chain supply snapshots
  ├── cron_runs            → cron execution log for health monitoring
  └── daily_digest         → AI-generated daily market summaries

Cloudflare Pages
  └── Static export from Next.js
```

## Data Reliability

The data pipeline includes multiple guardrails designed for research-grade accuracy:

- **Structural validation** — API responses are validated for required fields before caching; malformed objects are dropped
- **Price validation ordering** — unreasonable prices are rejected before entering the 24-hour price cache, not after
- **Concurrent write protection** — compare-and-swap cache writes prevent slow sync runs from overwriting newer data
- **Depeg deduplication** — unique constraint on `(stablecoin_id, started_at, source)` prevents duplicate events; overlapping intervals are merged when computing peg scores
- **DEX price cross-validation** — TVL-weighted median from multiple DEX sources suppresses false depeg alerts
- **BigInt precision** — blacklist amounts use BigInt division to avoid JavaScript floating-point precision loss above 2^53
- **Cross-currency totals** — non-USD stablecoin supplies are converted via derived FX rates, not summed at face value
- **Thin peg group fallbacks** — currencies with <3 qualifying coins fall back to approximate FX rates when the median appears depegged
- **Freshness header** — `/api/stablecoins` returns `X-Data-Updated-At` so consumers can detect stale data
- **Atomic backfill** — depeg event backfills use transactional batch operations to prevent data loss on worker crashes
- **Retry logic** — all external API fetches use exponential backoff with configurable 404 handling

## Deployment

Automated via GitHub Actions (`.github/workflows/deploy-cloudflare.yml`) on push to `main`:

1. **Worker:** `npm ci` → `d1 migrations apply` → `wrangler deploy`
2. **Pages:** `npm ci` → `npm run build` → `wrangler pages deploy out`

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
Required GitHub variable: `API_BASE_URL`

Worker secrets (set via `wrangler secret put`): `ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`, `DRPC_API_KEY`, `ALCHEMY_API_KEY`, `GRAPH_API_KEY`, `CMC_API_KEY`, `METALS_API_KEY`, `ANTHROPIC_API_KEY`, `ALERT_WEBHOOK_URL`, `ADMIN_KEY`

## License

MIT
