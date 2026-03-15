# Pharos — Stablecoin Analytics Dashboard

Public-facing analytics dashboard tracking 157 stablecoins (plus 2 shadow assets for PSI) across multiple peg currencies, backing types, and governance models. Pure information site — no wallet connectivity, no user accounts.

**Live at [pharos.watch](https://pharos.watch)**

## Features

- **Three-tier classification** — stablecoins categorized as CeFi, CeFi-Dependent, or DeFi based on actual dependency on centralized infrastructure, not marketing claims
- **Multi-peg support** — USD, EUR, GBP, CHF, BRL, RUB, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNH, PHP, MXN, gold, silver, and CPI-linked stablecoins with cross-currency FX-adjusted totals
- **Peg Tracker** — continuous peg monitoring with a composite Peg Score (0–100) for every tracked stablecoin, depeg event detection with direction tracking, deviation heatmaps, and a historical timeline going back 4 years
- **Freeze & Blacklist Tracker** — real-time on-chain tracking of USDC, USDT, PAXG, and XAUT freeze/blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron with BigInt-precision amounts
- **DEX Liquidity Score** — composite liquidity score (0–100) per stablecoin from DEX pool TVL, volume, quality, durability, and pair diversity
- **DEX Price Cross-Validation** — implied prices from Curve, Uniswap V3, Aerodrome, and DexScreener pools used to suppress false depeg alerts
- **Coverage Matrix** — per-feature coverage breadth across tracked coins and tracked market cap
- **Compare** — side-by-side stablecoin comparison across key metrics
- **Daily Digest** — AI-generated daily summary of market movements and notable events
- **Stability Index** — composite ecosystem health score (0–100) combining active depeg severity, depeg breadth, DEWS stress breadth, and 7-day market-cap trend
- **Stablecoin Cemetery** — 81 dead stablecoins documented with cause of death, peak market cap, and obituaries
- **Bluechip Safety Ratings** — independent stablecoin safety ratings from the SMIDGE framework
- **Redemption Backstops** — modeled issuer / protocol redemption routes with effective-exit scoring for 46 configured assets
- **Detail pages** — price chart, supply history, chain distribution, reserve card, redemption backstop card, liquidity card, and safety ratings for each stablecoin
- **Private operator status dashboard** — Access-gated cron health, cache freshness, and system monitoring on `ops.pharos.watch`
- **Backing type breakdown** — RWA-backed, crypto-backed, and algorithmic
- **Yield-bearing & NAV token filters** — identify tokens that accrue yield natively
- **Research-grade data pipeline** — structural validation, concurrent write protection, depeg deduplication, and price validation guardrails
- **Dark/light mode**

## Tech Stack

- **Frontend:** Next.js 16 (App Router, static export), React 19, TypeScript (strict)
- **Styling:** Tailwind CSS v4, shadcn/ui (Radix primitives)
- **Data fetching:** TanStack Query
- **Charts:** Recharts
- **API:** Cloudflare Worker (cron-based data fetching + REST endpoints)
- **Database:** Cloudflare D1 (SQLite — caches stablecoin data and stores blacklist/depeg/liquidity/yield/mint-burn histories)
- **Hosting:** Cloudflare Pages

## Data Sources

All external API calls and on-chain contract reads go through the Cloudflare Worker. The frontend never calls providers directly.

| Source                                                                  | Purpose                                                                                                    | Refresh                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [DefiLlama](https://defillama.com/)                                     | Stablecoin supply, price, chain distribution, history                                                      | 15 min                            |
| [Pyth Network](https://www.pyth.network/)                               | Oracle price input for the 15-minute price consensus pipeline                                              | 15 min                            |
| [Binance](https://www.binance.com/)                                     | Batch CEX spot prices for listed USD pairs                                                                 | 15 min                            |
| [Coinbase Exchange](https://exchange.coinbase.com/)                     | Per-symbol CEX spot prices for listed USD pairs                                                            | 15 min                            |
| [RedStone](https://redstone.finance/)                                   | Exact-case oracle snapshots used as an additional pricing voice                                            | 15 min                            |
| [DefiLlama Yields](https://defillama.com/yields)                        | DEX pool TVL, volume, and composition for liquidity scoring                                                | 30 min                            |
| [DefiLlama Protocols](https://defillama.com/protocols)                  | Protocol TVL context used by DEX liquidity scoring and fallback coverage checks                            | 30 min                            |
| [Curve Finance API](https://api.curve.finance/)                         | Pool A-factors, per-token balances, implied prices                                                         | 30 min                            |
| [The Graph](https://thegraph.com/)                                      | Uniswap V3 (4 chains) + Aerodrome (Base) subgraphs for fee tiers and implied prices                        | 30 min                            |
| [CoinGecko Onchain](https://www.coingecko.com/en/api/onchain)           | Discovery-stage DEX pool crawl, locked liquidity %, fee tiers, balance approximation                       | 20 min                            |
| [GeckoTerminal](https://www.geckoterminal.com/)                         | Fallback DEX pool crawl for GT-only chains or no-CoinGecko-key runs                                        | 20 min                            |
| [DexScreener](https://dexscreener.com/)                                 | Discovery fallback, DEX-implied price fallback, and last-resort price enrichment                           | Varies by pipeline (15/20/30 min) |
| [CoinGecko](https://www.coingecko.com/)                                 | Gold/silver/fiat token supply (not in DefiLlama), fallback price enrichment                                | 15 min (as fallback)              |
| [CoinMarketCap](https://coinmarketcap.com/)                             | Fallback price enrichment for assets with CMC slugs                                                        | 15 min (rate-limited to 1/hour)   |
| Direct protocol redemption contract reads                               | Authoritative redeem prices for selected wrapper assets such as cUSD, iUSD, and crvUSD                    | 15 min                            |
| Protocol reserve APIs, dashboards, and on-chain accounting reads        | Live reserve composition for live-enabled assets                                                           | Hourly                            |
| [Etherscan v2](https://etherscan.io/)                                   | USDC, USDT, PAXG, XAUT freeze/blacklist events (EVM chains)                                                | 20 min                            |
| [TronGrid](https://www.trongrid.io/)                                    | USDT freeze events on Tron                                                                                 | 20 min                            |
| [dRPC](https://drpc.org/) / [Alchemy](https://www.alchemy.com/)         | RPC reads for blacklist balance enrichment (dRPC/Alchemy) and Ethereum mint/burn event ingestion (Alchemy) | 20 min                            |
| [frankfurter.app](https://frankfurter.app/)                             | ECB FX rates for EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN                      | 15 min                            |
| [Open Exchange Rates](https://openexchangerates.org/)                   | Real-time FX cross-validation overlay for supported fiat pegs when `OPENEXCHANGERATES_API_KEY` is set     | 15 min cron (rate-limited to 1/h) |
| [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) | Live CNH, RUB, UAH, and ARS rates for peg coverage outside the ECB set                                     | 15 min                            |
| [gold-api.com](https://gold-api.com/)                                   | Gold and silver spot prices for commodity-pegged stablecoin peg validation                                 | 15 min                            |
| [FRED (St. Louis Fed)](https://fred.stlouisfed.org/series/DGS3MO)       | 3-month Treasury yield for yield benchmarking (risk-free rate, PYS `excessYield`)                          | Daily                             |
| [Bluechip](https://bluechip.org/)                                       | Independent stablecoin safety ratings (SMIDGE framework)                                                   | Daily                             |
| [Anthropic](https://anthropic.com/)                                     | AI-generated daily market digest                                                                           | Daily                             |

DEX discovery sources write to `dex_pool_staging` every 20 minutes on the dedicated discovery cron; `syncDexLiquidity()` then merges staged rows on its separate 30-minute scoring cron. DexScreener also participates in the 15-minute stablecoin price-enrichment path.

## Getting Started

Requires Node 20+ (`package.json#engines.node`). Install dependencies from the repo root; npm workspaces will wire both the frontend and `worker/` package:

```bash
npm install
```

### Frontend

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8787 npm run dev
```

### Worker API

```bash
cd worker && npx wrangler dev
```

To trigger crons manually:

```bash
cd worker && npx wrangler dev --remote --test-scheduled
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
│   ├── compare/                  Side-by-side comparison tool + static comparison landing pages
│   ├── coverage/                 Per-coin feature coverage matrix
│   ├── depeg/                    Live peg monitoring + event feed
│   ├── dependency-map/           Collateral dependency graph visualization
│   ├── digest/                   AI-generated daily market digest (+ digest/[date]/)
│   ├── flows/                    Mint/burn flow tracker
│   ├── liquidity/                DEX liquidity scores and pool breakdown
│   ├── methodology/              Detailed methodology + changelog routes
│   ├── portfolio/                Portfolio stress testing & upstream exposure
│   ├── privacy/                  Privacy policy
│   ├── safety-scores/            Stablecoin safety grade cards with radar charts
│   ├── start/                    First-time-user orientation route
│   ├── stability-index/          Pharos Stability Index (ecosystem health)
│   ├── stablecoin/[id]/          Detail page per stablecoin
│   ├── stablecoins/[peg]/        Stablecoins filtered by peg currency
│   ├── stablecoins/backing/[backing]/     Backing taxonomy landing pages
│   ├── stablecoins/governance/[governance]/ Governance taxonomy landing pages
│   ├── admin/                    Access-gated operator admin panel (ops.pharos.watch only)
│   ├── status/                   Access-gated operator status panel
│   ├── telegram/                 Telegram alerts + digest landing page
│   ├── yield/                    Yield intelligence leaderboard
│   └── about/                    About / product overview
├── components/                   UI components (table, charts, cards, shared sort-icon, time-range-buttons)
├── hooks/                        Data fetching hooks (TanStack Query) + shared UI hooks (useSort, useUrlFilters, useTimeRangeFilter)
└── lib/                          Frontend-only utilities (API client, charts/colors, metadata, UI helpers)

functions/                        Cloudflare Pages Functions for ops-host gating and `/api/admin/*` proxying
├── admin/[[path]].ts             Host gate for `/admin/` on `ops.pharos.watch`
├── api/admin/[[path]].ts         Same-origin admin proxy from `ops.pharos.watch` to `ops-api.pharos.watch`
└── lib/ops-origin.ts             Shared ops-origin resolution helper

shared/                           Runtime-neutral shared boundary (`@shared/*`)
├── lib/                          Stablecoin metadata, supply/peg/classification/report-card logic, endpoint contract registry
└── types/                        Shared TypeScript types and schema helpers

worker/                           Cloudflare Worker (API + cron jobs)
├── src/
│   ├── cron/                     Scheduled data sync (sync-stablecoins, enrich-prices, detect-depegs, sync-dex-liquidity, etc.)
│   ├── api/                      REST endpoint handlers (stablecoin/detail/history/status/admin)
│   └── lib/                      D1 helpers, shared constants, depeg types, API error handler, circuit breaker
└── migrations/                   D1 SQL migration files (74 total)
```

## Documentation

Current source-of-truth product docs live in `/docs/` and this README. `/agents/` stores working notes, plans, audits, and research history; treat it as archival context unless a file there explicitly says otherwise.

- [docs/README.md](./docs/README.md) - verified documentation index and topic map
- [docs/api-reference.md](./docs/api-reference.md) - exact API routes, query params, headers, and response contracts
- [docs/architecture.md](./docs/architecture.md) - curated file tree and architecture-significant routes
- [docs/worker-infrastructure.md](./docs/worker-infrastructure.md) - Worker env bindings, cron slots, cache/auth behavior
- [docs/stablecoin-detail-page.md](./docs/stablecoin-detail-page.md) - `/stablecoin/[id]/` route shell, section composition, and fallback/staleness rules
- [docs/live-reserves.md](./docs/live-reserves.md) - live reserve-sync config, adapter registry, API modes, and status/detail consumers
- [docs/redemption-backstops.md](./docs/redemption-backstops.md) - modeled redemption routes, effective-exit scoring, storage, and API/detail consumers
- [docs/deployment-process.md](./docs/deployment-process.md) - local merge gate and CI deploy sequence
- [docs/methodology-page.md](./docs/methodology-page.md) - `/methodology` section-to-source mapping and update contract

## Infrastructure

```
Cloudflare Worker (API layer)
  ├── Cron: */15 * * * *                        → sync stablecoins (includes depeg detection + confirmation) + downstream-safe snapshot-supply retry + FX rates + PSI compute + DEWS + status self-check
  ├── Cron: 3,23,43 * * * *                     → blacklist sync
  ├── Cron: 4,24,44 * * * *                     → mint/burn critical lane
  ├── Cron: 6,36 * * * *                         → DEX discovery staging
  ├── Cron: 13,33,53 * * * *                    → mint/burn extended lane
  ├── Cron: 10,40 * * * *                       → stablecoin charts + DEX liquidity + yield sync
  ├── Cron: 11 * * * *                          → live reserve sync + redemption backstop snapshots
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
  ├── reserve_composition  → live reserve slices per coin for live-enabled assets
  ├── reserve_sync_state   → per-coin reserve-sync freshness, status, and warnings
  ├── redemption_backstop  → current modeled redemption-route / effective-exit snapshot per configured coin
  ├── redemption_backstop_history → daily redemption-route history snapshot per configured coin
  ├── stability_index      → daily ecosystem health scores (0–100) with trend band
  ├── stability_index_samples → high-frequency PSI samples (sub-daily granularity)
  ├── depeg_pending        → secondary confirmation queue for major stablecoin depegs
  ├── stress_signals       → DEWS 15-min rolling stress signal samples
  ├── stress_signal_history → historical stress signal snapshots
  ├── mint_burn_events     → on-chain mint/burn event log (~1M rows)
  ├── mint_burn_hourly     → hourly mint/burn aggregates (~630K rows)
  ├── mint_burn_sync_state → per-config incremental sync progress
  ├── mint_burn_run_state  → round-robin scheduling state
  ├── yield_data           → per-source yield snapshots (multi-source keyed)
  ├── yield_history        → per-source historical yield timeseries
  ├── telegram_subscribers → Telegram bot subscriber registrations
  ├── telegram_subscriptions → per-subscriber alert preferences
  ├── telegram_pending_alerts → overflow alert queue
  ├── safety_grade_history → daily safety grade change snapshots
  ├── status_state         → cron/system status state machine
  ├── status_transitions   → status transition log
  ├── status_probe_runs    → external endpoint probe results
  ├── status_discrepancy_state → data quality discrepancy tracking
  ├── dex_pool_staging     → DEX discovery staging table
  ├── discovery_candidates → candidate pools pending verification
  ├── block_timestamp_cache → cached block-to-timestamp mappings
  ├── cron_leases          → single-writer cron execution fencing
  ├── cron_runs            → cron execution log for health monitoring
  ├── cron_run_progress    → per-job cron progress tracking
  ├── daily_digest         → AI-generated daily market summaries
  ├── admin_idempotency_keys → idempotency keys for admin mutations
  ├── feedback_rate_limit  → IP-based rate limiting for feedback submissions
  └── public_api_rate_limit → Distributed per-minute buckets for non-admin public API traffic

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
- **Circuit breakers** — per-source circuit breakers (3-strike open, 30-min probe) prevent hammering downed APIs; dual-primary price validation cross-checks DefiLlama and CoinGecko within 50 bps and now chooses the peg-closer candidate for fixed non-NAV pegs when sources diverge; CoinGecko supply fallback activates when DefiLlama is unavailable
- **Mint/burn reliability controls** — rotating config scheduling, per-chain request quotas, adaptive `eth_getLogs` range splitting, timestamp caching, degraded-run escalation, and admin-controlled chunked backfill (`/api/backfill-mint-burn`)

## Deployment

GitHub Actions now runs the shared validate gate on pull requests to `main` via `.github/workflows/pull-request-checks.yml`, while production deploys still run only from `.github/workflows/deploy-cloudflare.yml` on push to `main`, the daily scheduled rebuild, or manual `workflow_dispatch`:

For the full operator runbook (including worktree merge flow and pre-push merge gate), see [docs/deployment-process.md](./docs/deployment-process.md).
For the full Worker binding table, see [.env.example](./.env.example) and [docs/worker-infrastructure.md](./docs/worker-infrastructure.md).
For mint/burn ingestion diagnostics and recovery, see `agents/process/mint-burn-ingestion.md`.

1. **Validate gate:** `npm run audit:deps` → `npm run lint` → `npm run check:worker-boundary` → `npm run check:migrations` → `npm test` → `npm run coverage:critical` → `cd worker && npx tsc --noEmit`
2. **Worker deploy:** `npm ci` → `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote` → `cd worker && npx --no-install wrangler deploy` → `cd worker && npx --no-install wrangler triggers deploy`
3. **API smoke gate:** `npm run test:smoke-api` against `SMOKE_API_BASE` (fed from GitHub variable `SMOKE_API_BASE_URL`, fallback `API_BASE_URL`)
4. **Pages deploy:** `npm ci` → `npm run sync:digests` → `NEXT_PUBLIC_API_BASE=$API_BASE_URL npm run build` → `npm run seo:check` → `npx --no-install wrangler pages deploy out` (with retry in CI)
5. **Post-deploy smoke jobs:** after `deploy-pages`, CI runs these in parallel:
   - `npm run test:smoke-ui` against `SMOKE_UI_URL` (or `https://pharos.watch` fallback)
   - `npm run test:smoke-ops` against `SMOKE_OPS_UI_URL` / `SMOKE_OPS_API_BASE` using Cloudflare Access service-token headers

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
Required GitHub variable: `API_BASE_URL`
Optional GitHub variable: `SMOKE_API_BASE_URL` (recommended when smoke-testing a dedicated API host)
Optional GitHub variable: `SMOKE_UI_URL` (for non-default frontend smoke target)
Optional GitHub variables: `SMOKE_OPS_UI_URL`, `SMOKE_OPS_API_BASE`
Required ops smoke secrets: `OPS_SMOKE_CF_ACCESS_CLIENT_ID`, `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`

Worker secrets (set via `wrangler secret put`): `ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`, `DRPC_API_KEY`, `ALCHEMY_API_KEY`, `GRAPH_API_KEY`, `CMC_API_KEY`, `COINGECKO_API_KEY`, `OPENEXCHANGERATES_API_KEY`, `ANTHROPIC_API_KEY`, `ALERT_WEBHOOK_URL`, `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_PAT`, `FEEDBACK_IP_SALT`, `PUBLIC_API_RATE_LIMIT_SALT`, `GITHUB_REPO_NODE_ID`, `GITHUB_DISCUSSION_CATEGORY_ID`

Worker vars (see `.env.example` for the current surface): `CORS_ORIGIN`, `SELF_URL`, `OPS_UI_ORIGIN`, `OPS_API_ORIGIN`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_OPS_UI_AUD`, `CF_ACCESS_OPS_API_AUD`, `MAINTENANCE_MODE`

Pages Functions secrets for the same-origin ops admin proxy: `OPS_API_SERVICE_TOKEN_ID`, `OPS_API_SERVICE_TOKEN_SECRET`

Optional mint/burn freshness env overrides (secret or plain env): `MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`, `MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC`

## License

All rights reserved.
