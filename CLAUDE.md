# Stablecoin Dashboard (Pharos)

Public-facing analytics dashboard tracking ~130 stablecoins across multiple peg currencies, backing types, and governance models. Pure information site — no wallet connectivity, no user accounts.

**Live at [pharos.watch](https://pharos.watch)**

# Development approach

Follow DRY/KISS/YAGNI principles.
When a new data source is added, update the about page to mention it.
After large code changes, especially if structural, check the your claude.md and the readme file, and update if needed.

## Tech Stack

- **Next.js 16** (App Router, static export to Cloudflare Pages)
- **React 19** with `use()` for async params
- **TypeScript** (strict mode)
- **Tailwind CSS v4** (PostCSS-based, no tailwind.config — styles in `globals.css`)
- **shadcn/ui** (Radix primitives: table, card, badge, tabs, toggle-group, skeleton, etc.)
- **TanStack Query** (data fetching, caching, polling)
- **Recharts** (area charts, pie charts on detail page)
- **TradingView Lightweight Charts** (price time-series on detail page)
- **next-themes** (dark/light mode)
- **Cloudflare Workers** (API layer — cron-based data fetching + REST endpoints)
- **Cloudflare D1** (SQLite database — caches stablecoin data, blacklist events, depeg events, price history)

## Infrastructure & Deployment

```
Cloudflare Workers (stablecoin-api)
  ├── Cron: */5 * * * *   → syncStablecoins (DefiLlama + CoinGecko gold) + syncStablecoinCharts
  ├── Cron: */10 * * * *  → syncDexLiquidity (DeFiLlama Yields + Curve API)
  ├── Cron: */15 * * * *  → syncBlacklist (Etherscan/TronGrid/dRPC) + syncUsdsStatus
  ├── Cron: 0 */2 * * *   → syncFxRates (frankfurter.app + Exchange Rate API for RUB) + syncBluechip
  └── API endpoints (see below)

Cloudflare D1 (stablecoin-db)
  ├── cache              → JSON blobs (stablecoin list, per-coin detail, charts, logos)
  ├── blacklist_events   → normalized blacklist/freeze events
  ├── blacklist_sync_state → incremental sync progress per chain+contract
  ├── depeg_events       → peg deviation events with severity tracking
  ├── price_cache        → historical price snapshots for depeg detection
  ├── dex_liquidity      → per-stablecoin DEX liquidity scores, HHI, depth stability, and pool data
  ├── dex_liquidity_history → daily TVL/score snapshots for trend analysis
  └── dex_prices         → DEX-implied prices from Curve pools for cross-validation

Cloudflare Pages (stablecoin-dashboard)
  └── Static export from Next.js (output: "export")
```

**Data flow:** Worker crons fetch from external APIs → store in D1 → Worker API serves from D1 → Browser fetches from Worker API.

**API keys:** `ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`, `DRPC_API_KEY`, and `ADMIN_KEY` are Worker secrets (set via `wrangler secret put`). They are NOT exposed in the frontend bundle.

### Local Development

```bash
# Terminal 1: Worker API
cd worker && npx wrangler dev
# Trigger crons manually: curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"

# Terminal 2: Frontend
NEXT_PUBLIC_API_BASE=http://localhost:8787 npm run dev
```

### Deployment

Automated via `.github/workflows/deploy-cloudflare.yml` on push to `main`:
1. Worker: `npm ci` → `d1 migrations apply` → `wrangler deploy`
2. Pages: `npm ci` → `npm run build` (with `NEXT_PUBLIC_API_BASE`) → `wrangler pages deploy out`

GitHub secrets required: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
GitHub variable: `API_BASE_URL` (Worker URL)

### One-time Cloudflare Setup

1. `cd worker && npx wrangler d1 create stablecoin-db` — copy `database_id` into `wrangler.toml`
2. `npx wrangler d1 migrations apply stablecoin-db --remote`
3. `npx wrangler secret put ETHERSCAN_API_KEY`
4. `npx wrangler secret put TRONGRID_API_KEY`
5. `npx wrangler secret put DRPC_API_KEY`
6. `npx wrangler secret put ADMIN_KEY` (for `/api/backfill-depegs` auth)
7. `npx wrangler deploy`
8. Create Pages project, set `NEXT_PUBLIC_API_BASE` env var

## Data Sources

- **DefiLlama** (`stablecoins.llama.fi`, `coins.llama.fi`) — primary source for stablecoin supply, price, chain distribution, and history
- **CoinGecko** — gold-pegged stablecoin data (XAUT, PAXG are not in DefiLlama's stablecoin API), fallback price enrichment, supply overrides for coins with corrupted upstream data
- **DexScreener** — best-effort price fallback (Pass 4) for assets DefiLlama and CoinGecko both miss, using on-chain DEX pair data filtered by liquidity
- **Etherscan v2** — USDC, USDT, EURC, PAXG, XAUT freeze/blacklist events across EVM chains
- **TronGrid** — USDT freeze/blacklist events on Tron
- **dRPC** — archive RPC for L2 balance lookups at historical block heights (Etherscan v2 free plan doesn't support `eth_call` on L2s)
- **Bluechip** (`backend.bluechip.org`) — independent stablecoin safety ratings using the SMIDGE framework. Refreshed every 6 hours
- **DeFiLlama Yields** (`yields.llama.fi`) — DEX pool TVL, trading volume, and pool composition across all protocols and chains. Used for DEX liquidity scoring
- **Curve Finance API** (`api.curve.finance`) — pool-level amplification coefficients (A-factor) and per-token balances for quality-adjusted TVL weighting and imbalance detection
- **Exchange Rate API** (`open.er-api.com`) — live RUB/USD rate, since the ECB does not publish ruble rates (sanctions). Falls back to hardcoded rate if unavailable

All external API calls go through the Cloudflare Worker. The frontend never calls external APIs directly.

Logos are stored as a static JSON file (`data/logos.json`), not fetched at runtime.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stablecoins` | Full stablecoin list with supply, price, chains. Returns `X-Data-Updated-At` header |
| `GET /api/stablecoin/:id` | Per-coin detail (cache-aside, 5min TTL) |
| `GET /api/stablecoin-charts` | Historical total supply chart data |
| `GET /api/blacklist` | Freeze/blacklist events (filterable by token, chain) |
| `GET /api/depeg-events` | Depeg events (`?stablecoin=ID`, `?active=true`, `?limit=N&offset=M`) |
| `GET /api/peg-summary` | Per-coin peg scores + aggregate summary stats |
| `GET /api/usds-status` | USDS Sky protocol status |
| `GET /api/bluechip-ratings` | Bluechip safety ratings (keyed by Pharos ID) |
| `GET /api/dex-liquidity` | DEX liquidity scores, pool data, protocol/chain breakdowns, HHI, trends (keyed by Pharos ID) |
| `GET /api/dex-liquidity-history` | Per-coin historical liquidity data (`?stablecoin=ID&days=90`) |
| `GET /api/health` | Worker health check |
| `GET /api/backfill-depegs` | Admin: backfill depeg events (requires `X-Admin-Key` header matching `ADMIN_KEY` secret) |

## Architecture

```
src/                              # Next.js frontend (static export)
├── app/
│   ├── page.tsx                  # Homepage: stats, charts, filters, table
│   ├── peg-tracker/              # Peg monitoring: scores, heatmap, depeg timeline
│   │   ├── page.tsx              # Server component (metadata)
│   │   └── client.tsx            # Interactive client component
│   ├── blacklist/                # Freeze & blacklist event tracker
│   │   ├── page.tsx
│   │   └── layout.tsx
│   ├── cemetery/page.tsx         # Dead stablecoin graveyard
│   ├── liquidity/               # DEX liquidity scores & leaderboard
│   │   ├── page.tsx              # Server component (metadata)
│   │   └── client.tsx            # Interactive client component
│   ├── about/page.tsx            # About & methodology
│   ├── stablecoin/[id]/          # Detail page: price chart, supply chart, chains
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── layout.tsx                # Root layout (header, footer, providers)
│   ├── error.tsx                 # Root error boundary
│   ├── sitemap.ts                # Dynamic sitemap generation
│   └── robots.ts                 # robots.txt
├── components/
│   ├── ui/                       # shadcn/ui primitives (do not edit manually)
│   ├── header.tsx                # Pill-style nav with active state
│   ├── footer.tsx                # Site footer with data attribution
│   ├── providers.tsx             # TanStack Query + theme providers
│   ├── homepage-client.tsx       # Homepage interactive wrapper
│   ├── stablecoin-table.tsx      # Sortable table with filters
│   ├── category-stats.tsx        # Summary cards (total, by type, by backing)
│   ├── governance-chart.tsx      # "Stablecoin by Type" breakdown card
│   ├── peg-type-chart.tsx        # "Alternative Peg Dominance" card
│   ├── total-mcap-chart.tsx      # Full-width market cap area chart
│   ├── chain-overview.tsx        # Horizontal bar chart (homepage)
│   ├── market-highlights.tsx     # Biggest depegs + fastest movers
│   ├── price-chart.tsx           # TradingView LW chart (detail page)
│   ├── supply-chart.tsx          # Recharts area chart (detail page)
│   ├── chain-distribution.tsx    # Recharts pie chart (detail page)
│   ├── peg-tracker-stats.tsx     # Peg tracker summary statistics
│   ├── peg-heatmap.tsx           # Real-time peg deviation heatmap
│   ├── peg-leaderboard.tsx       # Ranked coins by peg score
│   ├── depeg-timeline.tsx        # 4-year depeg event timeline
│   ├── depeg-feed.tsx            # Depeg event list
│   ├── depeg-history.tsx         # Per-coin depeg history (detail page)
│   ├── blacklist-table.tsx       # Blacklist event table
│   ├── blacklist-chart.tsx       # Blacklist event chart
│   ├── blacklist-stats.tsx       # Blacklist summary stats
│   ├── blacklist-filters.tsx     # Blacklist page filters
│   ├── blacklist-summary.tsx     # Homepage blacklist summary card
│   ├── stablecoin-cemetery.tsx   # Cemetery obituary list
│   ├── cemetery-tombstones.tsx   # Cemetery tombstone cards
│   ├── cemetery-timeline.tsx     # Horizontal timeline with logos
│   ├── cemetery-charts.tsx       # Cemetery statistics charts
│   ├── cemetery-summary.tsx      # Homepage cemetery summary card
│   ├── stablecoin-logo.tsx       # Logo component with fallback
│   ├── bluechip-rating-card.tsx   # Bluechip safety rating card (detail page)
│   ├── dex-liquidity-card.tsx     # DEX liquidity card with trend chart (detail page)
│   ├── usds-status-card.tsx      # USDS protocol status card
│   ├── liquidity-stats.tsx       # Liquidity page summary stat cards + protocol/chain breakdown bars
│   ├── liquidity-table.tsx       # Liquidity page sortable leaderboard table with pagination
│   ├── sort-icon.tsx             # Shared sort direction arrow icon (used by 3 tables)
│   ├── time-range-buttons.tsx    # Shared time range pill toggle buttons (used by 2 charts)
│   ├── theme-toggle.tsx          # Dark/light mode toggle
│   └── pharos-loader.tsx         # Loading spinner
├── hooks/
│   ├── use-stablecoins.ts        # GET /api/stablecoins
│   ├── use-logos.ts              # Static logos from data/logos.json
│   ├── use-stablecoin-charts.ts  # GET /api/stablecoin-charts
│   ├── use-blacklist-events.ts   # GET /api/blacklist
│   ├── use-depeg-events.ts       # GET /api/depeg-events
│   ├── use-peg-summary.ts        # GET /api/peg-summary
│   ├── use-bluechip-ratings.ts   # GET /api/bluechip-ratings
│   ├── use-dex-liquidity.ts      # GET /api/dex-liquidity
│   ├── use-dex-liquidity-history.ts # GET /api/dex-liquidity-history
│   ├── use-usds-status.ts        # GET /api/usds-status
│   ├── use-sort.ts               # Generic useSort<K> hook (sort state, toggle, keyboard, aria)
│   ├── use-time-range-filter.ts  # Generic time range state + data filtering hook
│   └── use-url-filters.ts        # Shared URL search param management (getParam, setParam, setParams)
└── lib/
    ├── api.ts                    # API_BASE URL config (from NEXT_PUBLIC_API_BASE env var)
    ├── bluechip.ts               # Bluechip slug map, grade order, report URL base
    ├── types.ts                  # All TypeScript types, filter tag system
    ├── stablecoins.ts            # Master list of ~118 tracked stablecoins with classification flags
    ├── dead-stablecoins.ts       # 62 dead stablecoins with cause of death, peak mcap, obituaries
    ├── blacklist-contracts.ts    # Contract addresses + event configs (shared with worker)
    ├── format.ts                 # Currency, price, peg deviation, percent change formatters
    ├── supply.ts                 # Shared supply helpers: getCirculatingRaw/USD, getPrevDay/Week/MonthRaw/USD, getPrevMonthUSD
    ├── chart-colors.ts           # Shared CHART_PALETTE for Recharts charts
    ├── peg-config.ts             # PEG_META: labels + Tailwind colors per peg currency
    ├── constants.ts              # THIRTY_DAYS_SECONDS, CATEGORY_LINKS
    ├── peg-rates.ts              # Derives FX reference rates from median prices in data
    ├── peg-score.ts              # Composite peg score algorithm (0-100)
    ├── peg-stability.ts          # Per-coin peg stability metrics
    ├── peg-utils.ts              # Shared peg helpers: mergeDepegSeconds(), worstDeviation()
    ├── blacklist-helpers.ts      # Shared blacklist helpers: isGoldStablecoin(), extractGoldPrices(), computeBlacklistStats()
    ├── classification.ts         # Single source of truth for governance/backing/peg labels, badge colors, tier colors
    ├── severity-colors.ts        # Deviation severity color mapping (threshold-based: green/amber/orange/red)
    └── utils.ts                  # cn() helper for Tailwind class merging

worker/                           # Cloudflare Worker (API + cron jobs)
├── wrangler.toml                 # Worker config, D1 binding, cron triggers
├── migrations/                   # D1 SQL migrations (12 total)
└── src/
    ├── index.ts                  # Entry: fetch + scheduled handlers, CORS
    ├── router.ts                 # Route matching for API endpoints
    ├── cron/
    │   ├── sync-stablecoins.ts   # DefiLlama + CoinGecko gold → D1 (orchestrator, delegates to enrich-prices + detect-depegs)
    │   ├── enrich-prices.ts      # 4-pass price enrichment pipeline (DefiLlama, CoinGecko, DexScreener)
    │   ├── detect-depegs.ts      # Depeg event detection with DEX price cross-validation
    │   ├── sync-stablecoin-charts.ts  # Historical chart data → D1
    │   ├── sync-blacklist.ts     # Etherscan/TronGrid/dRPC → D1 (incremental)
    │   ├── sync-usds-status.ts   # USDS protocol status → D1
    │   ├── sync-bluechip.ts     # Bluechip safety ratings → D1 (6h cache)
    │   └── sync-dex-liquidity.ts # DeFiLlama Yields + Curve API → D1 (10min) — decomposed into 8 named sub-functions with orchestrator
    ├── api/
    │   ├── stablecoins.ts        # GET /api/stablecoins
    │   ├── stablecoin-detail.ts  # GET /api/stablecoin/:id
    │   ├── stablecoin-charts.ts  # GET /api/stablecoin-charts
    │   ├── blacklist.ts          # GET /api/blacklist
    │   ├── depeg-events.ts       # GET /api/depeg-events
    │   ├── peg-summary.ts        # GET /api/peg-summary
    │   ├── usds-status.ts        # GET /api/usds-status
    │   ├── bluechip.ts           # GET /api/bluechip-ratings
    │   ├── dex-liquidity.ts     # GET /api/dex-liquidity (includes HHI, trends)
    │   ├── dex-liquidity-history.ts # GET /api/dex-liquidity-history
    │   ├── health.ts             # GET /api/health
    │   └── backfill-depegs.ts    # GET /api/backfill-depegs (admin)
    └── lib/
        ├── db.ts                 # D1 read/write helpers (setCacheIfNewer CAS guard, batchExecute, buildPaginatedQuery)
        ├── constants.ts          # Shared worker constants (DEPEG_THRESHOLD_BPS, DEX_FRESHNESS_SEC, D1_BATCH_SIZE)
        ├── depeg-helpers.ts      # Shared DepegRow interface + rowToDepegEvent() mapper
        ├── api-utils.ts          # withErrorHandler() wrapper for standardized API error handling
        └── fetch-retry.ts        # Fetch with retry + exponential backoff (configurable 404 handling)

data/
└── logos.json                    # Static stablecoin logo URLs (from CoinGecko)
```

## Stablecoin Classification System

Each stablecoin in `src/lib/stablecoins.ts` has flags:

### Type (governance field internally)

Three-tier system reflecting actual dependency on centralized infrastructure:

| Tier | Label | Meaning | Examples |
|------|-------|---------|----------|
| `centralized` | CeFi | Fully centralized issuer, custody, and redemption | USDT, USDC, PYUSD, FDUSD |
| `centralized-dependent` | CeFi-Dep | Decentralized governance/mechanics but depends on centralized custody, off-chain collateral, or centralized exchanges | DAI, USDS, USDe, GHO, FRAX, crvUSD, sUSD |
| `decentralized` | DeFi | Fully on-chain collateral, no centralized custody dependency | LUSD, BOLD, ZCHF, BEAN |

The key distinction for `centralized-dependent`: these protocols may have on-chain governance and smart contract mechanics, but they ultimately rely on off-chain t-bill deposits, centralized exchange positions (delta-neutral), or significant USDC/USDT collateral. Calling them "decentralized" would be misleading. For example, crvUSD's peg keepers use centralized stablecoins (USDC, USDT, USDP), and sUSD V3 added USDC as core collateral on Base.

### Backing

| Value | Meaning |
|-------|---------|
| `rwa-backed` | Backed by real-world assets (fiat reserves, treasuries, gold) |
| `crypto-backed` | Backed by on-chain crypto collateral |
| `algorithmic` | Maintains peg via algorithmic mechanisms |

### Peg Currency

`USD`, `EUR`, `GBP`, `CHF`, `BRL`, `RUB`, `GOLD`, `VAR` (variable/CPI-linked), `OTHER`

### Boolean Flags

- `yieldBearing` — token itself accrues yield (e.g., USDY, USDe, BUIDL)
- `rwa` — backed by real-world assets like treasuries/bonds (distinct from `rwa-backed` which also includes plain fiat reserves)
- `navToken` — price appreciates over time as yield accrues (USYC, USDY, TBILL, YLDS). Excluded from peg deviation metrics; table shows "NAV" instead of bps. Also used for CPI-indexed tokens (FPI) — table shows "CPI" for VAR-pegged navTokens

### Additional Metadata

- `collateral?: string` — description of the collateral backing
- `pegMechanism?: string` — description of the peg maintenance mechanism
- `goldOunces?: number` — troy ounces of gold per token (for gold-pegged stablecoins)
- `proofOfReserves?: ProofOfReserves` — proof of reserves configuration
- `links?: StablecoinLink[]` — external links (website, docs, twitter)
- `jurisdiction?: Jurisdiction` — regulatory jurisdiction

## Non-USD Peg Handling

Peg deviation for non-USD stablecoins requires knowing the USD value of the peg currency. `src/lib/peg-rates.ts` derives this by computing the median price among stablecoins of each `pegType` (from DefiLlama data) with >$1M supply. This avoids hardcoding FX rates. The deviation is then `((price / pegRef) - 1) * 10000` basis points.

For thin peg groups (GBP, CHF, BRL, RUB — often <3 qualifying coins), a `FALLBACK_RATES` map provides approximate FX rates. If the median from <3 coins deviates >10% from the fallback, the fallback is used instead. This prevents a single depegged coin from becoming its own reference rate (which would always show 0 bps deviation).

## Gold Stablecoins (XAUT, PAXG)

These use synthetic IDs (`gold-xaut`, `gold-paxg`) since they're not in DefiLlama's stablecoin API. Data comes from CoinGecko, shaped into DefiLlama-compatible format by the Worker's `sync-stablecoins` cron, and merged into the `peggedAssets` array before caching. Gold token price normalization handles both 1-gram and 1-troy-ounce tokens via the `goldOunces` field. Historical TVL is fetched from the DefiLlama protocol API to populate `circulatingPrevDay/Week/Month` with actual values (instead of copying current mcap). When historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.

## Price Enrichment Pipeline

`enrichMissingPrices()` in `worker/src/cron/enrich-prices.ts` uses a 4-pass system for assets with missing or zero prices:

1. **Pass 1:** Contract address → DefiLlama coins API (with multi-chain fallback)
2. **Pass 2:** CoinGecko ID → DefiLlama CoinGecko proxy
3. **Pass 3:** CoinGecko ID → CoinGecko direct API
4. **Pass 4:** Symbol → DexScreener search API (best-effort, filtered by >$50K liquidity, peg-type-aware price cap: $1K for fiat stables, $100K for gold)

**Price validation ordering:** `isReasonablePrice()` runs **before** `savePriceCache()` so that unreasonable enriched prices never enter the 24-hour cache. This prevents a single bad API response from poisoning the cache across multiple sync cycles.

## DEX Liquidity Score

`syncDexLiquidity()` in `sync-dex-liquidity.ts` runs every 10 minutes and computes a composite liquidity score (0-100) per stablecoin from 6 components:

| Component | Weight | Source | How Computed |
|-----------|--------|--------|-------------|
| **TVL Depth** | 30% | DeFiLlama Yields | Log-scale using effective TVL (quality-adjusted, metapool-deduped): $100K→20, $1M→40, $10M→60, $100M→80, $1B+→100 |
| **Volume Activity** | 20% | DeFiLlama Yields | Volume/TVL ratio. 0→0, 0.5→100 |
| **Pool Quality** | 20% | Curve API + DeFiLlama | Quality-adjusted TVL using mechanism × balance health × pair quality multipliers (see below) |
| **Durability** | 15% | DeFiLlama Yields + History | 40% organic fraction, 25% TVL stability, 20% volume consistency, 15% maturity |
| **Pair Diversity** | 7.5% | DeFiLlama Yields | Pool count, diminishing returns: min(100, poolCount × 5) |
| **Cross-chain** | 7.5% | DeFiLlama Yields | 1 chain→15, 2→40, 3→60, 5→80, 8+→100 |

Data sources: DeFiLlama Yields API (single request for all ~18K pools) + Curve Finance API (per-chain requests for A-factor, balance data, registry IDs, and metapool structure). Zero additional API calls vs v1 — all new data was already in existing responses.

### Quality Multipliers (v2)

| Pool Type | Multiplier | Detection |
|-----------|-----------|-----------|
| Curve StableSwap A≥500 | 1.0x | `registryId` not containing `crypto` + A≥500 |
| Curve StableSwap A<500 | 0.85x | `registryId` not containing `crypto` + A<500 |
| Curve CryptoSwap | 0.5x | `registryId` containing `crypto`/`twocrypto`/`tricrypto` |
| Uniswap V3 1bp | 1.1x | fee tier ≤ 100 |
| Uniswap V3 5bp | 0.85x | fee tier ≤ 500 |
| Uniswap V3 30bp+ | 0.4x | fee tier > 500 |
| Fluid DEX | 0.85x | project contains `fluid` |
| Balancer Stable | 0.85x | project contains `balancer` + stable pattern |
| Balancer Weighted | 0.4x | project contains `balancer`, non-stable |
| Generic AMM | 0.3x | fallback |

### Pool Quality Adjustments

- **Balance health**: Continuous `Math.pow(balanceRatio, 1.5)` instead of binary threshold — ratio 0.8→0.72, 0.5→0.35, 0.3→0.16
- **Pair quality**: Co-token scored using Pharos governance classification (CeFi→1.0, DeFi→0.9, CeFi-Dep→0.8) + static map for volatile assets (WETH→0.65, WBTC→0.6, unknown→0.3). Multi-asset pools use best co-token score
- **MetaPool TVL dedup**: Uses `usdTotalExcludingBasePool` to prevent double-counting base pool liquidity across ~322 Curve metapools
- **Effective TVL**: `poolTvl × mechanismMultiplier × balanceHealth × pairQuality`, summed across all pools

### Data Quality Filters

- `isBroken === true` Curve pools: skipped
- Dead/rugged/deprecated protocols (from DeFiLlama Protocols API): excluded from `dexProjects` set
- `exposure === "single"` pools (lending deposits, not DEX liquidity): skipped
- CryptoSwap pools: correctly classified via `registryId` instead of being treated as StableSwap

### Pool Stress Index (0-100)

Per-pool stress metric: `35×(1-balanceRatio) + 25×(1-organicFraction) + 20×immaturityPenalty + 20×(1-pairQuality)`. TVL-weighted average stored as `avg_pool_stress`.

### Durability Score (0-100)

Per-stablecoin durability metric combining: organic fee fraction (40%), TVL stability from 30-day CV (25%), volume consistency from 30-day CV (20%), and oldest pool maturity (15%). Stored as `durability_score`.

### Storage

Stored in D1 `dex_liquidity` table (migration 0009 + 0012) with per-stablecoin aggregate metrics, protocol/chain TVL breakdowns, top 10 pools as JSON columns, plus v2 columns: `avg_pool_stress`, `weighted_balance_ratio`, `organic_fraction`, `effective_tvl_usd`, `durability_score`, `score_components_json`. Stablecoins with no DEX presence get score 0.

### Additional Liquidity Metrics

- **Concentration HHI**: Herfindahl-Hirschman Index computed from pool TVL shares before top-10 truncation. Range 0–1 (1.0 = single pool, 0 = evenly distributed). Stored as `concentration_hhi` column.
- **Depth Stability**: Coefficient of variation of daily TVL over 30-day rolling window, inverted to 0–1 scale (1.0 = perfectly stable). Computed from `dex_liquidity_history` table. Requires ≥7 days of data. Stored as `depth_stability` column.
- **TVL Trends**: 24h and 7d percentage changes computed from daily history snapshots. Returned as `tvlChange24h`/`tvlChange7d` in the API response.
- **Daily Snapshots**: One snapshot per stablecoin per day in `dex_liquidity_history` table (migration 0010). Written on first sync invocation after UTC midnight. Stores TVL, 24h volume, and liquidity score.

## DEX Price Cross-Validation

`dex_prices` table (migration 0011) stores DEX-implied USD prices extracted from Curve StableSwap pools. Updated every 10 minutes during `syncDexLiquidity()` at zero additional API cost — Curve pool responses already include per-token `coins[].usdPrice`.

**Price extraction pipeline:**
1. During Curve API parsing, collect price observations for each tracked stablecoin from pools with TVL ≥ $50K and balance ratio ≥ 0.3
2. Compute TVL-weighted median per stablecoin (robust against single distorted pool)
3. Compare with primary price from D1 cache to compute `deviation_from_primary_bps`
4. Store in `dex_prices` with top 5 source pools as JSON

**Confirmation gate in `detectDepegEvents()` (`worker/src/cron/detect-depegs.ts`):**
- When primary price shows depeg (≥100bps), check DEX price
- If DEX price is fresh (<20 min) and shows coin at peg (<100bps): **suppress** new depeg event (likely false positive)
- If DEX unavailable, stale, or confirms depeg: open event normally
- Only affects **opening new** events — existing event updates/closures unchanged
- ~30-40 stablecoins covered by Curve; ~80 fall through to primary-only detection

**API exposure:**
- `/api/dex-liquidity`: adds `dexPriceUsd`, `dexDeviationBps`, `priceSourceCount`, `priceSourceTvl`, `priceSources` fields
- `/api/peg-summary`: adds optional `dexPriceCheck` per coin with `{ dexPrice, dexDeviationBps, agrees, sourcePools, sourceTvl }`

**Frontend:**
- `dex-liquidity-card.tsx`: shows DEX-implied price section when available
- `peg-heatmap.tsx`: amber "!" badge on tiles where DEX disagrees with primary

## Filter System

Filters on the homepage use a multi-group AND logic:
- 4 groups: Peg, Type, Backing, Features
- Single selection per group
- Selections across groups combine with AND
- Defined in `page.tsx` as `FILTER_GROUPS`, tags generated by `getFilterTags()` in `types.ts`

## Key Patterns

- **Circulating supply**: Use shared helpers from `src/lib/supply.ts` — `getCirculatingRaw(coin)` for raw sums, `getCirculatingUSD(coin, rates)` for FX-converted totals. Same pattern for `getPrevDayRaw/USD`, `getPrevWeekRaw/USD`, `getPrevMonthRaw/USD`. For cross-currency totals (e.g. homepage "Total Tracked" stat), always use the USD variants which multiply each peg-denominated value by its FX rate from `derivePegRates()`
- **Classification labels/colors**: All governance, backing, and peg labels plus badge/tier color maps are centralized in `src/lib/classification.ts`. Import from there instead of defining locally
- **Sort state**: Use `useSort<K>()` from `src/hooks/use-sort.ts` + `<SortIcon>` from `src/components/sort-icon.tsx` for all sortable tables
- **Time range filtering**: Use `useTimeRangeFilter()` from `src/hooks/use-time-range-filter.ts` + `<TimeRangeButtons>` from `src/components/time-range-buttons.tsx` for charts with range toggles
- **URL filter state**: Use `useUrlFilters()` from `src/hooks/use-url-filters.ts` for pages that persist filter state in URL search params
- **Peg interval merge**: Use `mergeDepegSeconds()` and `worstDeviation()` from `src/lib/peg-utils.ts` — shared between peg-score.ts and peg-stability.ts
- **Blacklist stats**: Use `isGoldStablecoin()`, `extractGoldPrices()`, `computeBlacklistStats()` from `src/lib/blacklist-helpers.ts`
- **Worker error handling**: All API handlers are wrapped with `withErrorHandler()` from `worker/src/lib/api-utils.ts` for standardized 500 responses
- **Worker batch writes**: Use `batchExecute()` from `worker/src/lib/db.ts` for chunked D1 batch operations (respects D1_BATCH_SIZE limit)
- **Worker pagination**: Use `buildPaginatedQuery()` from `worker/src/lib/db.ts` for WHERE + OFFSET/LIMIT SQL construction
- **Worker depeg types**: Use `DepegRow` interface and `rowToDepegEvent()` mapper from `worker/src/lib/depeg-helpers.ts`
- **Worker constants**: Use `DEPEG_THRESHOLD_BPS`, `DEX_FRESHNESS_SEC`, `D1_BATCH_SIZE` from `worker/src/lib/constants.ts`
- **Tailwind class names**: Must be complete static strings — never construct classes dynamically (e.g., `color.replace("text-", "bg-")` won't work because Tailwind purges undetected classes)
- **DefiLlama API quirk**: `/stablecoincharts/all` returns both `totalCirculating` (native currency units) and `totalCirculatingUSD` (USD-converted). Always use `totalCirculatingUSD` for cross-currency comparisons
- **Price guards**: DefiLlama sometimes returns non-number prices. All formatters guard with `typeof price !== "number"` checks. `formatCurrency()` handles negative values (`-$5.00M` not `$-5.00M`) and non-finite values (returns `"N/A"`)
- **Worker imports shared code**: The worker imports `types.ts`, `blacklist-contracts.ts`, `stablecoins.ts`, `peg-rates.ts`, and `peg-score.ts` from `../../../src/lib/` — wrangler's esbuild resolves these. The root `tsconfig.json` excludes `worker/` to avoid type conflicts with D1 types
- **BigInt precision**: `decodeUint256()` in `sync-blacklist.ts` uses BigInt division (`raw / divisor` + `raw % divisor`) to avoid precision loss above 2^53. All balance-decoding callsites (EVM, dRPC, Tron) follow this pattern
- **Table sort consistency**: 24h/7d columns sort by **percentage** change, not absolute dollar delta. This ensures small coins with large % moves sort correctly relative to large coins with tiny % changes
- **Hook timing policy**: TanStack Query hooks use `staleTime = cron interval`, `refetchInterval = 2× cron interval`. E.g., useStablecoins: 5min/10min (*/5 cron), useBlacklistEvents: 15min/30min (*/15 cron), useBluechipRatings: 2h/4h (*/2h cron)

## Data Integrity Guardrails

The sync pipeline includes multiple layers of validation to prevent bad data from reaching users:

1. **Structural validation**: DefiLlama response must contain 50+ assets with valid `id`, `name`, `symbol`, and `circulating` fields. Malformed objects are dropped before caching
2. **Supply sanity floor**: Cache write is skipped if total tracked supply falls below $100B (current total ~$230B). Prevents a partial DefiLlama outage from showing $0 market cap
3. **Price validation ordering**: `isReasonablePrice()` rejects prices outside peg-type bounds **before** `savePriceCache()`, not after. Prevents bad enriched prices from persisting in the 24h cache
4. **Concurrent cron guard**: `setCacheIfNewer()` uses a compare-and-swap pattern — a slow sync run can't overwrite a newer run's data. Uses `syncStartSec` as CAS guard
5. **Detail JSON validation**: `stablecoin-detail.ts` parses response JSON before caching; skips cache on parse failure
6. **fetchWithRetry**: Retries on 404 by default (configurable via `{ passthrough404: true }`). Chart sync now also uses `fetchWithRetry` instead of bare `fetch`
7. **Depeg dedup**: `UNIQUE INDEX (stablecoin_id, started_at, source)` prevents duplicate depeg events. Partial index on `ended_at IS NULL` speeds up open-event queries
8. **Depeg interval merge**: `computePegScore()` and `computePegStability()` merge overlapping depeg intervals before summing duration, preventing double-counted depeg time
9. **Depeg direction handling**: If a coin flips from below-peg to above-peg (or vice versa) without recovering, the old event is closed and a new one opened with the correct direction
10. **Peg score consistency**: Both the detail page and peg-summary API use the same tracking window: `Math.min(dataStart, fourYearsAgo)`. This ensures identical peg scores on different pages
11. **Backfill atomicity**: `backfill-depegs.ts` runs DELETE + INSERT in a single `db.batch()` call (D1 batch is transactional), preventing data loss if the worker crashes mid-operation
12. **OFFSET/LIMIT safety**: SQL queries in `depeg-events.ts` and `blacklist.ts` use `LIMIT -1` when offset > 0 but no limit is set (bare OFFSET is invalid SQLite). Values are parameterized, not interpolated
13. **Freshness header**: `/api/stablecoins` returns `X-Data-Updated-At` header from the cache timestamp, allowing consumers to detect stale data

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:
- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.

## Commands

```bash
# Frontend
npm run dev      # Development server
npm run build    # Production build (also runs TypeScript checking)
npm run lint     # ESLint

# Worker
cd worker
npx wrangler dev                   # Local worker dev server
npx wrangler deploy                # Deploy worker to Cloudflare
npx wrangler d1 migrations apply stablecoin-db --local   # Apply migrations locally
npx wrangler d1 migrations apply stablecoin-db --remote  # Apply migrations to prod
npx tsc --noEmit                   # Type-check worker code
```
