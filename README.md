# Pharos — Stablecoin Analytics Dashboard

Public-facing analytics dashboard tracking 191 stablecoins in repo metadata: 181 active assets on public data surfaces, 10 pre-launch entries, plus 2 shadow assets used only for PSI history. Pure information site — no wallet connectivity, no user accounts.

**Live at [pharos.watch](https://pharos.watch)**

## Features

- **Three-tier classification** — stablecoins categorized as CeFi, CeFi-Dependent, or DeFi based on actual dependency on centralized infrastructure, not marketing claims
- **Multi-peg support** — USD, EUR, GBP, CHF, BRL, RUB, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNH, PHP, MXN, gold, silver, and CPI-linked stablecoins with cross-currency FX-adjusted totals
- **Peg Tracker** — 15-minute peg monitoring with a composite Peg Score (0–100) for every tracked stablecoin, depeg event detection with direction tracking, deviation heatmaps, and a historical timeline going back 4 years
- **Freeze & Blacklist Tracker** — hourly on-chain tracking of USDC, USDT, PAXG, XAUT, PYUSD, and USD1 freeze/blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron with BigInt-precision amounts
- **DEX Liquidity Score** — composite liquidity score (0–100) per stablecoin from DEX pool TVL, volume, quality, durability, and pair diversity
- **DEX Price Cross-Validation** — implied prices from Curve, Uniswap V3, Aerodrome and Velodrome Slipstream, Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap, and DexScreener pools used to suppress false depeg alerts
- **Coverage Matrix** — per-feature coverage breadth across tracked coins and tracked market cap
- **Upcoming Stablecoins** — pre-launch tracker with phase, peg, and backing filters plus schedule-drift badges
- **Chains** — per-chain stablecoin leaderboard and profile pages with Chain Health Score breakdowns
- **Compare** — side-by-side stablecoin comparison across key metrics
- **Daily Digest** — AI-generated daily summary of market movements and notable events
- **Stability Index** — composite ecosystem health score (0–100) combining active depeg severity, depeg breadth, DEWS stress breadth, and 7-day market-cap trend
- **Stablecoin Cemetery** — 87 dead stablecoins documented with cause of death, peak market cap, and obituaries
- **Bluechip Safety Ratings** — independent stablecoin safety ratings from the SMIDGE framework
- **Redemption Backstops** — modeled issuer / protocol redemption routes with effective-exit scoring for 140 configured assets
- **Detail pages** — full analytics dossiers for tracked live assets plus dedicated pre-launch detail views, with conditional reserve, redemption backstop, liquidity, and safety surfaces when data exists
- **Public status page + private operator admin** — read-only system health on `/status/`, plus Access-gated monitoring and recovery controls on `ops.pharos.watch/admin/`
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

All external API calls and on-chain contract reads go through the Cloudflare Worker. The frontend never calls providers directly. Key live sources are listed below; the grouped source families on `/about/` and in `docs/about-page.md` are the fuller source-of-truth summary when this table is intentionally condensed.

| Source                                                                  | Purpose                                                                                                    | Refresh                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [DefiLlama](https://defillama.com/)                                     | Stablecoin supply, price, chain distribution, history                                                      | 15 min                            |
| [Pyth Network](https://www.pyth.network/)                               | Oracle price input for the 15-minute price consensus pipeline                                              | 15 min                            |
| [Binance](https://www.binance.com/)                                     | Batch CEX spot prices for listed USD pairs                                                                 | 15 min                            |
| [Kraken](https://www.kraken.com/)                                       | Batch CEX spot prices for listed USD pairs                                                                 | 15 min                            |
| [Bitstamp](https://www.bitstamp.net/)                                   | Batch CEX spot prices for listed USD pairs                                                                 | 15 min                            |
| [Coinbase Exchange](https://exchange.coinbase.com/)                     | Per-symbol CEX spot prices for listed USD pairs                                                            | 15 min                            |
| [RedStone](https://redstone.finance/)                                   | Exact-case oracle snapshots used as an additional pricing voice                                            | 15 min                            |
| [Chainlink Data Feeds](https://data.chain.link/)                        | Reference-feed overlays for supported fiat and commodity pegs                                              | 15 min                            |
| [DefiLlama Yields](https://defillama.com/yields)                        | DEX pool TVL, volume, and composition for liquidity scoring                                                | 30 min                            |
| [DefiLlama Protocols](https://api.llama.fi/protocols)                   | Protocol TVL context used by DEX liquidity scoring and fallback coverage checks                            | 30 min                            |
| [Curve Finance API](https://api.curve.finance/)                         | Pool A-factors, per-token balances, implied prices                                                         | 30 min                            |
| [The Graph](https://thegraph.com/)                                      | Uniswap V3 (4 chains) + Aerodrome (Base) subgraphs for fee tiers and implied prices                        | 30 min                            |
| [CoinGecko Onchain](https://docs.coingecko.com/reference/top-pools-contract-address) | Discovery-stage DEX pool crawl, locked liquidity %, fee tiers, balance approximation                       | 30 min                            |
| [GeckoTerminal](https://www.geckoterminal.com/)                         | Fallback DEX pool crawl for GT-only chains or no-CoinGecko-key runs                                        | 30 min                            |
| [DexScreener](https://dexscreener.com/)                                 | Discovery fallback, DEX-implied price fallback, and last-resort price enrichment                           | Varies by pipeline (15/30 min)    |
| [Jupiter Price API](https://developers.jup.ag/docs/price)               | Solana-specific fallback price enrichment for tracked mint addresses                                       | 15 min (as fallback)              |
| Direct DEX APIs (Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap, Aerodrome Slipstream, Velodrome Slipstream) | Direct pool/liquidity reads that supplement DefiLlama, Curve, Graph, and crawl-based DEX coverage         | 30 min                            |
| [CoinGecko](https://www.coingecko.com/)                                 | Gold/silver/fiat token supply (not in DefiLlama), fallback price enrichment                                | 15 min (as fallback)              |
| [CoinMarketCap](https://coinmarketcap.com/)                             | Fallback price enrichment for assets with CMC slugs                                                        | 15 min (rate-limited to 1/hour)   |
| Direct protocol redemption contract reads                               | Authoritative redeem prices for selected wrapper assets such as Cap cUSD and infiniFi iUSD                | 15 min                            |
| Protocol reserve APIs, dashboards, and on-chain accounting reads        | Live reserve composition for live-enabled assets                                                           | Hourly                            |
| [Etherscan v2](https://etherscan.io/)                                   | USDC, USDT, PAXG, XAUT, PYUSD, and USD1 freeze/blacklist events (EVM chains)                              | Hourly                            |
| [TronGrid](https://www.trongrid.io/)                                    | USDT and USD1 freeze/blacklist events on Tron                                                              | Hourly                            |
| [dRPC](https://drpc.org/) / [Alchemy](https://www.alchemy.com/)         | RPC reads for blacklist balance enrichment (dRPC/Alchemy) and Ethereum mint/burn event ingestion (Alchemy) | Hourly / 20 min                   |
| [api.frankfurter.dev](https://api.frankfurter.dev/v1/latest)           | ECB FX rates for EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN                      | 15 min                            |
| [Open Exchange Rates](https://openexchangerates.org/)                   | Real-time FX cross-validation overlay for supported fiat pegs when `OPENEXCHANGERATES_API_KEY` is set      | 15 min cron (rate-limited to 1/h) |
| [fawazahmed0/currency-api](https://github.com/fawazahmed0/currency-api) | Secondary live FX mirror for CNH, RUB, UAH, and ARS, plus full-set fallback coverage when Frankfurter fails | 15 min                            |
| [ExchangeRate-API](https://www.exchangerate-api.com/)                   | Tertiary live full-set FX fallback when both Frankfurter and the secondary FX mirrors are unavailable      | 15 min                            |
| [gold-api.com](https://gold-api.com/)                                   | Gold and silver spot prices for commodity-pegged stablecoin peg validation                                 | 15 min                            |
| [FRED (St. Louis Fed)](https://fred.stlouisfed.org/series/DGS3MO) / ECB Data API / SIX delayed SARON guest access | USD, EUR, and CHF benchmark rates for yield benchmarking (`excessYield`)                                   | Daily                             |
| [Bluechip](https://bluechip.org/)                                       | Independent stablecoin safety ratings (SMIDGE framework)                                                   | Daily                             |
| [Anthropic](https://anthropic.com/)                                     | AI-generated daily market digest                                                                           | Daily                             |

DEX discovery sources write to `dex_pool_staging` every 30 minutes on the dedicated discovery cron; `syncDexLiquidity()` then merges staged rows on its separate 30-minute scoring cron. DexScreener also participates in the 15-minute stablecoin price-enrichment path.

## Getting Started

Requires Node 22+ (`package.json#engines.node`, `.nvmrc`). Install dependencies from the repo root; npm workspaces will wire both the frontend and `worker/` package:

```bash
npm install
```

### Frontend

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8787 npm run dev
```

`NEXT_PUBLIC_API_BASE` is mainly a local-dev override for `next dev` against `wrangler dev`. When it is unset, browser reads on `pharos.watch`, `ops.pharos.watch`, and `*.stablecoin-dashboard.pages.dev` go through same-origin `/_site-data/*`. Production Pages hosts (`pharos.watch`, `ops.pharos.watch`) require `SITE_API_ORIGIN` and proxy that lane with `SITE_API_SHARED_SECRET` to the dedicated `site-api` origin; preview/local hosts may still fall back to `https://api.pharos.watch` for rehearsal when `SITE_API_ORIGIN` is intentionally unset. Direct browser calls still use `https://api.pharos.watch` only for exempt public routes such as feedback submission and OG image fetches. Local static smoke/proxy setups can keep `NEXT_PUBLIC_API_BASE` empty. `NEXT_PUBLIC_GA_ID` is optional and only injects GA4 when set at build time.

### Worker API

```bash
cd worker && npx wrangler dev
```

To trigger crons manually:

```bash
cd worker && npx wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

### Local Development Setup

**Frontend-only (`npm run dev`)**
Minimum: `NEXT_PUBLIC_API_BASE` -- point to production (`https://api.pharos.watch`) or local worker (`http://localhost:8787`).

**Worker-only (`cd worker && npx wrangler dev`)**
Requires D1 bindings and external API keys. See `worker/src/lib/env.ts` for the full binding contract and `.env.example` for all keys.

**Full-stack local**
Both sets above. Run `npm run dev` and `cd worker && npx wrangler dev` in separate terminals.

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
│   ├── chains/                   Chain analytics leaderboard + per-chain profiles
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
│   ├── upcoming/                 Pre-launch stablecoin tracker
│   ├── stablecoin/[id]/          Detail page per stablecoin
│   ├── stablecoins/[peg]/        Stablecoins filtered by peg currency
│   ├── stablecoins/backing/[backing]/     Backing taxonomy landing pages
│   ├── stablecoins/governance/[governance]/ Governance taxonomy landing pages
│   ├── stablecoins/infrastructure/[infrastructure]/ Infrastructure landing pages
│   ├── admin/                    Access-gated operator admin panel (ops.pharos.watch only)
│   ├── status/                   Public system-status dashboard (read-only, indexable)
│   ├── telegram/                 Telegram alerts + digest landing page
│   ├── yield/                    Yield intelligence leaderboard
│   ├── changelog/                Weekly release notes
│   └── about/                    About / product overview
├── components/                   UI components (table, charts, cards, shared sort-icon, time-range-buttons)
├── hooks/                        Data fetching hooks (TanStack Query) + shared UI hooks (useSort, useUrlFilters, useTimeRangeFilter)
└── lib/                          Frontend-only utilities (API client, charts/colors, metadata, UI helpers)

functions/                        Cloudflare Pages Functions for same-origin website/ops proxying
├── _site-data/[[path]].ts        Same-origin website data proxy; production hosts require `SITE_API_ORIGIN`, preview/local hosts may use the public-API fallback
├── admin/[[path]].ts             Host gate for `/admin/` on `ops.pharos.watch`
├── api/admin/[[path]].ts         Same-origin admin proxy from `ops.pharos.watch` to `ops-api.pharos.watch`
├── lib/ops-env.ts                Shared Pages Functions env contract for ops-host gating and admin proxying
├── lib/ops-origin.ts             Shared ops-origin resolution helper
├── lib/proxy-utils.ts            Shared proxy request/response helpers
├── lib/request-attribution.ts    Request source attribution for analytics counters
├── lib/upstream-proxy.ts         Generic upstream proxy with shared-secret injection
├── lib/site-api-env.ts           Shared Pages Functions env contract for the `/_site-data/*` proxy
└── lib/site-data-origin.ts       Shared site-data host-allowlist helper

shared/                           Runtime-neutral shared boundary (`@shared/*`)
├── lib/                          Stablecoin metadata, supply/peg/classification/report-card logic, runtime origins, endpoint + site-data route registries
└── types/                        Shared TypeScript types and schema helpers

worker/                           Cloudflare Worker (API + cron jobs)
├── src/
│   ├── cron/                     Scheduled data sync (sync-stablecoins, enrich-prices, detect-depegs, sync-dex-liquidity, etc.)
│   ├── api/                      REST endpoint handlers (stablecoin/detail/history/status/admin)
│   └── lib/                      D1 helpers, shared constants, depeg types, API error handler, circuit breaker
└── migrations/                   D1 baseline + post-squash SQL migrations plus `MANIFEST.md`
```

## Documentation

Current source-of-truth product docs live in `/docs/` and this README. `/agents/` stores working notes, plans, audits, and research history; treat it as archival context unless a file there explicitly says otherwise.

- [docs/README.md](./docs/README.md) - verified documentation index and topic map
- [docs/api-reference.md](./docs/api-reference.md) - exact API routes, query params, headers, and response contracts
- [docs/architecture.md](./docs/architecture.md) - curated file tree and architecture-significant routes
- [docs/worker-infrastructure.md](./docs/worker-infrastructure.md) - Worker env bindings, cron slots, cache/auth behavior
- [docs/worker-and-api-limits.md](./docs/worker-and-api-limits.md) - runtime budgets, rate limits, and provider assumptions
- [docs/stablecoin-detail-page.md](./docs/stablecoin-detail-page.md) - `/stablecoin/[id]/` route shell, section composition, and fallback/staleness rules
- [docs/upcoming-page.md](./docs/upcoming-page.md) - `/upcoming/` pre-launch tracker contract, filters, and crawlability
- [docs/chains-page.md](./docs/chains-page.md) - `/chains/` and `/chains/[chain]/` route contracts plus Chain Health Score wiring
- [docs/live-reserves.md](./docs/live-reserves.md) - live reserve-sync config, adapter registry, API modes, and status/detail consumers
- [docs/redemption-backstops.md](./docs/redemption-backstops.md) - modeled redemption routes, effective-exit scoring, storage, and API/detail consumers
- [docs/deployment-process.md](./docs/deployment-process.md) - local merge gate and CI deploy sequence
- [docs/testing.md](./docs/testing.md) - lint/test/coverage workflow, CI gates, and helper inventory
- [docs/methodology-page.md](./docs/methodology-page.md) - `/methodology` section-to-source mapping and update contract

## Infrastructure

Runtime host split:

- website UI: `https://pharos.watch`
- website data lane: same-origin `/_site-data/*` -> `SITE_API_ORIGIN` on production hosts; preview/local rehearsal may fall back to `https://api.pharos.watch`
- external integration API: `https://api.pharos.watch`
- operator UI/API: `https://ops.pharos.watch` / `https://ops-api.pharos.watch`

```
Cloudflare Worker (API layer)
  ├── Cron: */15 * * * *                        → sync stablecoins (includes depeg detection + confirmation) + downstream-safe snapshot-supply retry + snapshot-chain-supply + FX rates
  ├── Cron: 9,24,39,54 * * * *                  → status self-check
  ├── Cron: 3 * * * *                           → blacklist sync
  ├── Cron: 4,24,44 * * * *                     → mint/burn critical lane
  ├── Cron: 6,36 * * * *                         → DEX discovery staging (30 min)
  ├── Cron: 13,33,53 * * * *                    → mint/burn extended lane
  ├── Cron: 10,40 * * * *                       → stablecoin charts + DEX liquidity + DEWS + PSI
  ├── Cron: 11 * * * *                          → live reserve sync + redemption backstop snapshots + Kinesis supply + collateral drift check
  ├── Cron: 20 * * * *                          → yield sync
  ├── Cron: 25 */4 * * *                        → supplemental yield sync
  ├── Cron: 2,7,12,17,22,27,32,37,42,47,52,57 * * * * → Telegram subscriber alerts
  ├── Cron: 0 8 * * *                           → supply snapshot + safety-grade snapshot + T-bill rate + PSI daily snapshot + USDS status
  ├── Cron: 5 8 * * *                           → Bluechip sync + daily digest + weekly recap (Mondays) + discovery scan (Mondays)
  └── Cron: 0 6 1 * *                           → monthly yield coverage audit

Cloudflare D1 (SQLite database)
  ├── cache                → JSON blobs (stablecoin list, per-coin detail, charts, FX/status/ranking caches) with CAS write guard
  ├── blacklist_events     → normalized freeze/blacklist events
  ├── blacklist_current_balances → active blacklist address current-balance cache
  ├── blacklist_sync_state → incremental sync progress (block numbers for EVM, timestamps for Tron)
  ├── depeg_events         → peg deviation events with unique constraint + direction tracking
  ├── price_cache          → historical price snapshots for depeg detection
  ├── dex_liquidity        → per-stablecoin DEX liquidity scores, pool data, HHI, depth stability
  ├── dex_liquidity_history → daily TVL/score snapshots for trend analysis
  ├── dex_prices           → DEX-implied prices from Curve, Uni V3, Aerodrome, Fluid, Balancer, Raydium, Orca, and DexScreener
  ├── dex_price_challengers → published qualifying individual challenger pools used for pool-challenge and depeg-confirmation reads
  ├── dex_price_challenger_snapshots → latest per-coin challenger snapshot metadata (published_at, has_rows, source coverage completeness)
  ├── onchain_supply       → per-stablecoin on-chain supply by chain (contract calls)
  ├── supply_history       → daily per-coin supply snapshots from cached stablecoins data (08:00 UTC + retry upserts)
  ├── chain_supply_history → daily per-chain supply aggregates for historical analysis
  ├── reserve_composition  → live reserve slices per coin for live-enabled assets
  ├── reserve_composition_history → historical reserve composition snapshots per coin per attempt
  ├── reserve_sync_state   → per-coin reserve-sync freshness, status, and warnings
  ├── reserve_sync_attempt_history → per-attempt history for reserve syncs
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
  ├── telegram_pending_disambiguation → pending command disambiguation state
  ├── safety_grade_history → daily safety grade change snapshots
  ├── status_state         → cron/system status state machine
  ├── status_transitions   → status transition log
  ├── status_probe_runs    → external endpoint probe results
  ├── status_discrepancy_state → data quality discrepancy tracking
  ├── dex_pool_staging     → DEX discovery staging table
  ├── dex_discovery_meta   → DEX discovery backoff tracking per coin per source
  ├── discovery_candidates → candidate pools pending verification
  ├── block_timestamp_cache → cached block-to-timestamp mappings
  ├── cron_leases          → single-writer cron execution fencing
  ├── cron_runs            → cron execution log for health monitoring
  ├── cron_run_progress    → per-job cron progress tracking
  ├── cron_slot_executions → cron slot execution deduplication tracking
  ├── daily_digest         → AI-generated daily market summaries
  ├── admin_idempotency_keys → idempotency keys for admin mutations
  ├── feedback_submissions → durable feedback submission log
  ├── feedback_rate_limit  → IP-based rate limiting for feedback submissions
  ├── public_api_rate_limit → Distributed per-minute buckets for non-admin public API traffic
  ├── api_keys             → API key registrations for authenticated public API access
  ├── api_key_rate_limit   → per-key rate-limit state for authenticated API consumers
  ├── api_key_audit_log    → audit trail for API key lifecycle events
  ├── api_key_request_stats → per-key request-volume tracking
  ├── api_request_source_stats → per-source API request attribution counters
  ├── api_request_consumer_stats → per-consumer API request attribution counters
  ├── site_data_request_stats → site-data proxy request attribution counters
  └── kv_config            → general key-value config store for runtime settings

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
- **Retry logic** — the shared `fetchWithRetry()` helper provides exponential backoff with opt-in 404 passthrough, while some provider integrations use bespoke timeout/retry handling when batching or raw upstream semantics require it
- **Circuit breakers** — per-source circuit breakers (3-strike open, 30-min probe) prevent hammering downed APIs; dual-primary price validation cross-checks DefiLlama and CoinGecko within 50 bps and now chooses the peg-closer candidate for fixed non-NAV pegs when sources diverge; CoinGecko supply fallback activates when DefiLlama is unavailable
- **Mint/burn reliability controls** — rotating config scheduling, per-chain request quotas, adaptive `eth_getLogs` range splitting, timestamp caching, degraded-run escalation, and admin-controlled chunked backfill (`/api/backfill-mint-burn`)

## Deployment

GitHub Actions now runs the shared validate gate on pull requests to `main` via `.github/workflows/pull-request-checks.yml`, while production deploys run from `.github/workflows/deploy-cloudflare.yml` on push to `main` or manual `workflow_dispatch`. A separate `.github/workflows/rebuild-pages.yml` handles the daily scheduled Pages rebuild (08:15 UTC, after digest generation):

For the canonical delivery workflow (including worktree merge flow and the repo pre-push merge gate), see [docs/deployment-process.md](./docs/deployment-process.md).
For the full Worker, Pages Functions, and frontend runtime binding table, see [.env.example](./.env.example) and [docs/worker-infrastructure.md](./docs/worker-infrastructure.md).
For mint/burn ingestion diagnostics and recovery, see `agents/process/mint-burn-ingestion.md`.

1. **Validate gate:** `npm run audit:deps` → `npm run audit:pricing-providers` → `npm run lint` → `npm run typecheck` → `npm run check:worker-boundary` → `npm run check:shared-cycles` → `npm run check:migrations` → `npm run check:cron-sync` → `npm run check:cron-connections` → `npm run check:doc-counts` → `npm run check:verified-doc-links` → `npm run check:doc-sync` → `npm run check:env-contract` → `npm run check:duplicate-exports` → `npm run check:redemption-backstops` → `npm run check:unused-code` → `npm run check:hotspot-ratchet` → `npm run check:sql-safety` → `npm run check:stablecoin-data` → `npm run build` + `npm run seo:check` when Pages-impacting files changed → `npm test` → `npm run coverage:critical` → `cd worker && npx tsc --noEmit` when worker-impacting files changed
2. **Worker candidate upload + preview smoke:** `npm ci` → capture the currently live Worker version ID → `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote` → `cd worker && npx --no-install wrangler versions upload` → `npm run test:smoke-api` against that uploaded preview URL
3. **Worker promotion:** `cd worker && npx --no-install wrangler versions deploy <uploaded-version>@100` → `cd worker && npx --no-install wrangler triggers deploy`
4. **Production API smoke gate:** `npm run test:smoke-api` against `SMOKE_API_BASE` (fed from GitHub variable `SMOKE_API_BASE_URL`, fallback `API_BASE_URL`); if this fails after promotion, CI auto-rolls the Worker back to the previously live version
5. **Pages prepare path:** `npm ci` → fetch `/api/digest-archive` once into `data/digests.json` → `npm run build` → `npm run seo:check` → serve `out/` locally through `npm run serve:static-export` → `npm run test:smoke-ui -- --url http://127.0.0.1:4173`; when both worker and Pages changed, this stage runs against the uploaded worker preview URL in parallel with worker promotion and production API smoke
6. **Pages publish path:** after the production API smoke passes, publish the already verified artifact with `npx --no-install wrangler pages deploy out` (with retry in CI), then smoke the real `https://pharos.watch` host
7. **Worker-only live UI smoke:** worker-only deploys still smoke `https://pharos.watch` against the new worker/API when the static export was unchanged
8. **Post-deploy ops smoke:** `npm run test:smoke-ops` runs after `pages-publish` on Pages-including deploys, or after `smoke-api` + `smoke-ui-live` on worker-only deploys

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
Optional GitHub secret: `SMOKE_API_KEY` (authenticated smoke tests when public API auth is active)
Required GitHub variable: `API_BASE_URL`
Optional GitHub variable: `SMOKE_API_BASE_URL` (recommended when smoke-testing a dedicated API host)
Optional GitHub variables: `SMOKE_OPS_UI_URL`, `SMOKE_OPS_API_BASE`
Required ops smoke secrets: `OPS_SMOKE_CF_ACCESS_CLIENT_ID`, `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`

Worker secrets (set via `wrangler secret put`): `ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`, `DRPC_API_KEY`, `ALCHEMY_API_KEY`, `GRAPH_API_KEY`, `CMC_API_KEY`, `COINGECKO_API_KEY`, `OPENEXCHANGERATES_API_KEY`, `ANTHROPIC_API_KEY`, `ALERT_WEBHOOK_URL`, `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_PAT`, `FEEDBACK_IP_SALT`, `PUBLIC_API_RATE_LIMIT_SALT`, `SITE_API_SHARED_SECRET`, `API_KEY_HASH_PEPPER`, `CLOUDFLARE_D1_STATUS_API_TOKEN`

`PUBLIC_API_RATE_LIMIT_SALT` is required for deployed public API traffic. If it is unset, the worker logs a configuration error and returns `503` for non-admin public `/api/*` requests instead of falling back to a built-in salt.

Worker vars (see `.env.example` for the current surface): active worker bindings are `CORS_ORIGIN`, `SELF_URL`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_OPS_API_AUD`, `MAINTENANCE_MODE`, `PUBLIC_API_AUTH_MODE`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID`. `OPS_UI_ORIGIN`, `OPS_API_ORIGIN`, and `CF_ACCESS_OPS_UI_AUD` remain reserved on the worker side for cross-runtime contract alignment and future Pages-side Access validation.

Pages Functions secrets for the same-origin ops admin proxy: `OPS_API_SERVICE_TOKEN_ID`, `OPS_API_SERVICE_TOKEN_SECRET`

Frontend build/runtime vars: `NEXT_PUBLIC_API_BASE` (optional local-dev override) and `NEXT_PUBLIC_GA_ID` (optional GA4 injection)

Optional mint/burn freshness env overrides (secret or plain env): `MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`, `MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC`

## License

Pharos is open source under the [MIT License](./LICENSE).
