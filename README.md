# Pharos — Stablecoin Analytics Dashboard

Public-facing analytics dashboard tracking 156 stablecoins (plus 2 shadow assets for PSI) across multiple peg currencies, backing types, and governance models. Pure information site — no wallet connectivity, no user accounts.

**Live at [pharos.watch](https://pharos.watch)**

## Features

- **Three-tier classification** — stablecoins categorized as CeFi, CeFi-Dependent, or DeFi based on actual dependency on centralized infrastructure, not marketing claims
- **Multi-peg support** — USD, EUR, GBP, CHF, BRL, RUB, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN, UAH, ARS, gold, silver, CPI-linked, and other peg currencies with cross-currency FX-adjusted totals
- **Peg Tracker** — continuous peg monitoring with a composite Peg Score (0–100) for every tracked stablecoin, depeg event detection with direction tracking, deviation heatmaps, and a historical timeline going back 4 years
- **Freeze & Blacklist Tracker** — real-time on-chain tracking of USDC, USDT, EURC, PAXG, and XAUT freeze/blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron with BigInt-precision amounts
- **DEX Liquidity Score** — composite liquidity score (0–100) per stablecoin from DEX pool TVL, volume, quality, durability, diversity, and cross-chain coverage
- **DEX Price Cross-Validation** — implied prices from Curve, Uniswap V3, Aerodrome, and DexScreener pools used to suppress false depeg alerts
- **Compare** — side-by-side stablecoin comparison across key metrics
- **Daily Digest** — AI-generated daily summary of market movements and notable events
- **Stability Index** — composite ecosystem health score (0–100) combining active depeg severity, depeg breadth, DEWS stress breadth, and 7-day market-cap trend
- **Stablecoin Cemetery** — 80 dead stablecoins documented with cause of death, peak market cap, and obituaries
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
- **Database:** Cloudflare D1 (SQLite — caches stablecoin data and stores blacklist/depeg/liquidity/yield/mint-burn histories)
- **Hosting:** Cloudflare Pages

## Data Sources

All external API calls go through the Cloudflare Worker. The frontend never calls external APIs directly.

| Source | Purpose | Refresh |
|--------|---------|---------|
| [DefiLlama](https://defillama.com/) | Stablecoin supply, price, chain distribution, history | 15 min |
| [DefiLlama Yields](https://yields.llama.fi/) | DEX pool TVL, volume, and composition for liquidity scoring | 30 min |
| [Curve Finance API](https://api.curve.finance/) | Pool A-factors, per-token balances, implied prices | 30 min |
| [The Graph](https://thegraph.com/) | Uniswap V3 (4 chains) + Aerodrome (Base) subgraphs for fee tiers and implied prices | 30 min |
| [CoinGecko Onchain](https://www.coingecko.com/en/api/onchain) | Primary DEX pool discovery (16 chains), locked liquidity %, fee tiers, balance approximation | 30 min |
| [GeckoTerminal](https://www.geckoterminal.com/) | Fallback pool crawl for DEX liquidity when no CoinGecko API key is configured | 30 min |
| [DexScreener](https://dexscreener.com/) | Batch token API for implied prices + search API for price fallback | 30 min |
| [CoinGecko](https://www.coingecko.com/) | Gold/silver/fiat token supply (not in DefiLlama), fallback price enrichment | 15 min (as fallback) |
| [CoinMarketCap](https://coinmarketcap.com/) | Fallback price enrichment for assets with CMC slugs | 15 min (rate-limited to 1/hour) |
| [Etherscan v2](https://etherscan.io/) | USDC, USDT, PAXG, XAUT freeze/blacklist events (EVM chains) | 20 min |
| [TronGrid](https://www.trongrid.io/) | USDT freeze events on Tron | 20 min |
| [dRPC](https://drpc.org/) / [Alchemy](https://www.alchemy.com/) | RPC reads for blacklist balance enrichment (dRPC/Alchemy) and Ethereum mint/burn event ingestion (Alchemy) | 20 min |
| [frankfurter.app](https://frankfurter.app/) | ECB FX rates for EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN | 15 min |
| [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) | Live RUB, UAH, ARS rates (ECB doesn't publish these currencies) | 15 min |
| [gold-api.com](https://gold-api.com/) | Gold and silver spot prices for commodity-pegged stablecoin peg validation | 15 min |
| [FRED (St. Louis Fed)](https://fred.stlouisfed.org/series/DGS3MO) | 3-month Treasury yield for yield benchmarking (risk-free rate, PYS `excessYield`) | Daily |
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
│   ├── page.tsx                  Homepage: stats, charts, filters, peg tracker, table
│   ├── blacklist/                Freeze & blacklist event tracker
│   ├── cemetery/                 Dead stablecoin graveyard
│   ├── compare/                  Side-by-side stablecoin comparison
│   ├── dependency-map/           Collateral dependency graph visualization
│   ├── digest/                   AI-generated daily market digest (+ digest/[date]/)
│   ├── liquidity/                DEX liquidity scores and pool breakdown
│   ├── portfolio/                Portfolio stress testing & upstream exposure
│   ├── safety-scores/            Stablecoin safety grade cards with radar charts
│   ├── stability-index/          Pharos Stability Index (ecosystem health)
│   ├── stablecoin/[id]/          Detail page per stablecoin
│   ├── stablecoins/[peg]/        Stablecoins filtered by peg currency
│   ├── status/                   System health and cron monitoring
│   └── about/                    About & methodology
├── components/                   UI components (table, charts, cards, shared sort-icon, time-range-buttons)
├── hooks/                        Data fetching hooks (TanStack Query) + shared UI hooks (useSort, useUrlFilters, useTimeRangeFilter)
└── lib/                          Frontend-only utilities (API client, charts/colors, metadata, UI helpers)

shared/                           Runtime-neutral shared boundary (`@shared/*`)
├── lib/                          Stablecoin metadata, supply/peg/classification/report-card logic, endpoint contract registry
└── types/                        Shared TypeScript types and schema helpers

worker/                           Cloudflare Worker (API + cron jobs)
├── src/
│   ├── cron/                     Scheduled data sync (sync-stablecoins, enrich-prices, detect-depegs, sync-dex-liquidity, etc.)
│   ├── api/                      REST endpoint handlers (stablecoin/detail/history/status/admin)
│   └── lib/                      D1 helpers, shared constants, depeg types, API error handler, circuit breaker
└── migrations/                   D1 SQL migration files (68 total)
```

## Infrastructure

```
Cloudflare Worker (API layer)
  ├── Cron: */15 * * * *                        → sync stablecoins (includes depeg detection + confirmation) + downstream-safe snapshot-supply retry + FX rates + PSI compute + DEWS + status self-check
  ├── Cron: 3,23,43 * * * *                     → blacklist sync
  ├── Cron: 4,24,44 * * * *                     → mint/burn critical lane
  ├── Cron: 6,26,46 * * * *                     → DEX discovery staging
  ├── Cron: 13,33,53 * * * *                    → mint/burn extended lane
  ├── Cron: 10,40 * * * *                       → stablecoin charts + DEX liquidity + yield sync
  ├── Cron: 2,7,12,17,22,27,32,37,42,47,52,57 * * * * → Telegram subscriber alerts
  ├── Cron: 0 8 * * *                           → supply snapshot + safety-grade snapshot + T-bill rate + PSI daily snapshot + USDS status
  └── Cron: 5 8 * * *                           → Bluechip sync + daily digest + discovery scan

Cloudflare D1 (SQLite database)
  ├── cache                → JSON blobs (stablecoin list, per-coin detail, charts, FX/status/ranking caches) with CAS write guard
  ├── blacklist_events     → normalized freeze/blacklist events
  ├── blacklist_sync_state → incremental sync progress (block numbers for EVM, timestamps for Tron)
  ├── depeg_events         → peg deviation events with unique constraint + direction tracking
  ├── price_cache          → historical price snapshots for depeg detection
  ├── dex_liquidity        → per-stablecoin DEX liquidity scores, pool data, HHI, depth stability
  ├── dex_liquidity_history → daily TVL/score snapshots for trend analysis
  ├── dex_prices           → DEX-implied prices from Curve, Uni V3, Aerodrome, DexScreener
  ├── onchain_supply       → per-stablecoin on-chain supply by chain (contract calls)
  ├── supply_history       → daily per-coin supply snapshots from cached stablecoins data (08:00 UTC + retry upserts)
  ├── stability_index      → daily ecosystem health scores (0–100) with trend band
  ├── stability_index_samples → high-frequency PSI samples (sub-daily granularity)
  ├── depeg_pending        → secondary confirmation queue for major stablecoin depegs
  ├── cron_runs            → cron execution log for health monitoring
  ├── daily_digest         → AI-generated daily market summaries
  └── feedback_rate_limit  → IP-based rate limiting for feedback submissions

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
- **Freshness header** — `/api/stablecoins` returns `X-Data-Age` so consumers can detect stale data
- **Atomic backfill** — depeg event backfills use transactional batch operations to prevent data loss on worker crashes
- **Retry logic** — all external API fetches use exponential backoff with configurable 404 handling
- **Circuit breakers** — per-source circuit breakers (3-strike open, 30-min probe) prevent hammering downed APIs; dual-primary price validation cross-checks DefiLlama and CoinGecko within 50 bps; CoinGecko supply fallback activates when DefiLlama is unavailable
- **Mint/burn reliability controls** — rotating config scheduling, per-chain request quotas, adaptive `eth_getLogs` range splitting, timestamp caching, degraded-run escalation, and admin-controlled chunked backfill (`/api/backfill-mint-burn`)

## Deployment

Automated via GitHub Actions (`.github/workflows/deploy-cloudflare.yml`) on push to `main`, the daily scheduled rebuild, or manual `workflow_dispatch`:

For the full operator runbook (including worktree merge flow and pre-push merge gate), see `docs/deployment-process.md`.
For mint/burn ingestion diagnostics and recovery, see `agents/process/mint-burn-ingestion.md`.

1. **Validate gate:** `npm run lint` → `npm run check:worker-boundary` → `npm run check:migrations` → `npm test` → `npm run coverage:critical` → `cd worker && npx tsc --noEmit`
2. **Worker deploy:** `npm ci` → `cd worker && npm ci` → `d1 migrations apply` → `wrangler deploy`
3. **API smoke gate:** `npm run test:smoke-api` against `SMOKE_API_BASE_URL` (or `API_BASE_URL` fallback)
4. **Pages deploy:** `npm ci` → `npx tsx scripts/sync-digests.ts` → `npm run build` → `npm run seo:check` → `wrangler pages deploy out`
5. **Post-deploy UI smoke:** `npm run test:smoke-ui` against `SMOKE_UI_URL` (or `https://pharos.watch` fallback)

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
Required GitHub variable: `API_BASE_URL`
Optional GitHub variable: `SMOKE_API_BASE_URL` (recommended when smoke-testing a dedicated API host)
Optional GitHub variable: `SMOKE_UI_URL` (for non-default frontend smoke target)

Worker secrets (set via `wrangler secret put`): `ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`, `DRPC_API_KEY`, `ALCHEMY_API_KEY`, `GRAPH_API_KEY`, `CMC_API_KEY`, `COINGECKO_API_KEY`, `ANTHROPIC_API_KEY`, `ALERT_WEBHOOK_URL`, `ADMIN_KEY`, `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GITHUB_PAT`, `FEEDBACK_IP_SALT`, `GITHUB_REPO_NODE_ID`, `GITHUB_DISCUSSION_CATEGORY_ID`

Optional mint/burn freshness env overrides (secret or plain env): `MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`, `MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC`

## License

MIT
