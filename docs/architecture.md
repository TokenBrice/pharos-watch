# Architecture — Full File Tree & API Endpoints

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

## Full File Tree

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
    ├── types.ts                  # All TypeScript types, filter tag system (includes ContractDeployment)
    ├── stablecoins.ts            # Master list of ~130 tracked stablecoins with classification flags + contract addresses
    ├── dead-stablecoins.ts       # 63 dead stablecoins with cause of death, peak mcap, obituaries
    ├── blacklist-contracts.ts    # Contract addresses + event configs (shared with worker)
    ├── format.ts                 # Currency, price, peg deviation, percent change formatters
    ├── supply.ts                 # Shared supply helpers: getCirculatingRaw/USD, getPrevDay/Week/MonthRaw/USD
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
├── migrations/                   # D1 SQL migrations (13 total)
└── src/
    ├── index.ts                  # Entry: fetch + scheduled handlers, CORS
    ├── router.ts                 # Route matching for API endpoints
    ├── cron/
    │   ├── sync-stablecoins.ts   # DefiLlama + CoinGecko gold → D1 (orchestrator, delegates to enrich-prices + detect-depegs)
    │   ├── enrich-prices.ts      # 4-pass price enrichment pipeline (DefiLlama, CoinGecko, DexScreener)
    │   ├── detect-depegs.ts      # Depeg event detection with DEX price cross-validation
    │   ├── sync-stablecoin-charts.ts  # Historical chart data → D1
    │   ├── sync-onchain-supply.ts # On-chain totalSupply queries → D1 (30min)
    │   ├── sync-blacklist.ts     # Etherscan/TronGrid/dRPC → D1 (incremental)
    │   ├── sync-usds-status.ts   # USDS protocol status → D1
    │   ├── sync-bluechip.ts     # Bluechip safety ratings → D1 (6h cache)
    │   └── sync-dex-liquidity.ts # DeFiLlama Yields + Curve API → D1 (10min)
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
        ├── db.ts                 # D1 read/write helpers (setCacheIfNewer CAS guard, batchExecute, buildPaginatedQuery, onchain supply)
        ├── chain-rpcs.ts         # Chain RPC endpoint config for on-chain supply queries (11 chains: EVM + Tron)
        ├── constants.ts          # Shared worker constants (DEPEG_THRESHOLD_BPS, DEX_FRESHNESS_SEC, D1_BATCH_SIZE)
        ├── depeg-helpers.ts      # Shared DepegRow interface + rowToDepegEvent() mapper
        ├── api-utils.ts          # withErrorHandler() wrapper for standardized API error handling
        └── fetch-retry.ts        # Fetch with retry + exponential backoff (configurable 404 handling)

data/
└── logos.json                    # Static stablecoin logo URLs (from CoinGecko)
```
