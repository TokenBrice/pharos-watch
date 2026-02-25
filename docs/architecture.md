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
| `GET /api/supply-history` | Per-coin supply history (`?stablecoin=ID&days=N`) |
| `GET /api/daily-digest` | AI-generated daily market summary (latest) |
| `GET /api/digest-archive` | All daily digests, newest-first |
| `GET /api/health` | Worker health check |
| `GET /api/status` | Admin status dashboard (cron runs, cache freshness, data quality). Requires `X-Admin-Key` header |
| `GET /api/stability-index` | Daily Pharos Stability Index scores, bands, and component breakdowns (`?detail=true` for full history) |
| `GET /api/report-cards` | Stablecoin safety grade cards with dimension scores (peg, liquidity, safety, resilience, decentralization, dependency) |
| `GET /api/backfill-depegs` | Admin: backfill depeg events (requires `X-Admin-Key` header matching `ADMIN_KEY` secret) |
| `GET /api/backfill-supply-history` | Admin: backfill per-coin supply history (requires `X-Admin-Key`) |
| `GET /api/backfill-stability-index` | Admin: backfill historical stability index scores (requires `X-Admin-Key`) |
| `GET /api/backfill-cg-prices` | Admin: backfill CoinGecko historical prices into price_cache (requires `X-Admin-Key`) |
| `GET /api/audit-depeg-history` | Admin: audit depeg events against CoinGecko price data for false positive detection (requires `X-Admin-Key`) |
| `GET /api/trigger-digest` | Admin: force digest regeneration bypassing 1h dedup (requires `X-Admin-Key`). Handled in `index.ts`, not router |

## Full File Tree

```
src/                              # Next.js frontend (static export)
├── app/
│   ├── page.tsx                  # Homepage: stats, charts, filters, table
│   ├── peg-tracker/              # Peg monitoring: scores, heatmap, depeg timeline
│   │   ├── page.tsx              # Server component (metadata)
│   │   ├── client.tsx            # Interactive client component
│   │   └── error.tsx
│   ├── blacklist/                # Freeze & blacklist event tracker
│   │   ├── page.tsx
│   │   ├── layout.tsx
│   │   └── error.tsx
│   ├── cemetery/                 # Dead stablecoin graveyard
│   │   ├── page.tsx
│   │   └── error.tsx
│   ├── liquidity/               # DEX liquidity scores & leaderboard
│   │   ├── page.tsx              # Server component (metadata)
│   │   ├── client.tsx            # Interactive client component
│   │   └── error.tsx
│   ├── compare/                  # Side-by-side stablecoin comparison
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── stability-index/          # Pharos Stability Index (daily ecosystem health)
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── report-cards/             # Stablecoin safety grade cards with radar charts
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── digest/page.tsx           # Daily digest archive
│   ├── about/                    # About & methodology
│   │   ├── page.tsx
│   │   └── error.tsx
│   ├── status/                   # Admin status dashboard (not in nav)
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── stablecoin/[id]/          # Detail page: price chart, supply chart, chains
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── layout.tsx                # Root layout (header, footer, providers)
│   ├── error.tsx                 # Root error boundary
│   ├── loading.tsx               # Root loading skeleton
│   ├── not-found.tsx             # 404 page
│   ├── globals.css               # Global styles (Tailwind v4)
│   ├── sitemap.ts                # Dynamic sitemap generation
│   └── robots.ts                 # robots.txt
├── components/
│   ├── ui/                       # shadcn/ui primitives (do not edit manually)
│   ├── header.tsx                # Pill-style nav with active state
│   ├── footer.tsx                # Site footer with data attribution
│   ├── providers.tsx             # TanStack Query + theme providers
│   ├── homepage-client.tsx       # Homepage interactive wrapper
│   ├── stablecoin-table.tsx      # Sortable table with filters
│   ├── filter-bar.tsx            # Homepage filter bar (classification dropdowns)
│   ├── category-stats.tsx        # Summary cards (total, by type, by backing)
│   ├── governance-chart.tsx      # "Stablecoin by Type" breakdown card
│   ├── peg-type-chart.tsx        # "Alternative Peg Dominance" card
│   ├── peg-diversity-chart.tsx   # Non-USD peg supply stacked area chart
│   ├── total-mcap-chart.tsx      # Full-width market cap area chart
│   ├── chain-overview.tsx        # Horizontal bar chart (homepage)
│   ├── market-highlights.tsx     # Biggest depegs + fastest movers
│   ├── market-pulse.tsx          # AI daily digest display
│   ├── daily-digest.tsx          # Daily digest card component (exports formatDateline)
│   ├── digest-archive-client.tsx # Digest archive list (client component)
│   ├── mcap-chart.tsx            # Market cap area chart (detail page)
│   ├── key-info-card.tsx          # Key info card: peg mechanism, issuer, collateral (detail page)
│   ├── ai-summary.tsx            # AI-generated editorial summary (detail page)
│   ├── contract-addresses.tsx    # Contract address display (detail page)
│   ├── peg-tracker-stats.tsx     # Peg tracker summary statistics
│   ├── peg-tracker-summary.tsx   # Peg tracker homepage summary card
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
│   ├── eurc-blacklist-card.tsx   # EURC-specific blacklist card
│   ├── stablecoin-cemetery.tsx   # Cemetery obituary list
│   ├── cemetery-client.tsx       # Cemetery interactive client wrapper
│   ├── cemetery-tombstones.tsx   # Cemetery tombstone cards
│   ├── cemetery-timeline.tsx     # Horizontal timeline with logos
│   ├── cemetery-charts.tsx       # Cemetery statistics charts
│   ├── cemetery-summary.tsx      # Homepage cemetery summary card
│   ├── stablecoin-logo.tsx       # Logo component with fallback
│   ├── bluechip-rating-card.tsx  # Bluechip safety rating card (detail page)
│   ├── bluechip-box.tsx          # Bluechip rating box (homepage)
│   ├── dex-liquidity-card.tsx    # DEX liquidity card with trend chart (detail page)
│   ├── liquidity-box.tsx         # Liquidity box (homepage)
│   ├── liquidity-stats.tsx       # Liquidity page summary stat cards + protocol/chain breakdown bars
│   ├── liquidity-table.tsx       # Liquidity page sortable leaderboard table with pagination
│   ├── liquidity-summary.tsx     # Liquidity homepage summary card
│   ├── usds-status-card.tsx      # USDS protocol status card
│   ├── coin-selector.tsx         # Coin selector dropdown (compare page)
│   ├── comparison-chart.tsx      # Multi-series comparison line chart
│   ├── comparison-table.tsx      # Side-by-side comparison table
│   ├── page-error.tsx            # Shared error boundary component
│   ├── stale-data-banner.tsx     # Stale data warning banner
│   ├── breadcrumb-json-ld.tsx    # Structured data for breadcrumbs
│   ├── sortable-table-head.tsx   # Shared sortable table header
│   ├── table-pagination.tsx      # Shared pagination component
│   ├── balance-bar.tsx           # Balance ratio visualization bar
│   ├── sort-icon.tsx             # Shared sort direction arrow icon
│   ├── time-range-buttons.tsx    # Shared time range pill toggle buttons
│   ├── theme-toggle.tsx          # Dark/light mode toggle
│   ├── report-card.tsx            # Report card component with grade, dimension scores, radar chart
│   ├── report-card-mini.tsx       # Compact report card display for compare page
│   ├── radar-chart.tsx            # Radar chart for report card dimensions (single + compare overlay)
│   ├── stability-index.tsx        # Stability index visualizations (sparklines, lighthouse icon)
│   └── pharos-loader.tsx         # Loading spinner
├── hooks/
│   ├── use-stablecoins.ts        # GET /api/stablecoins + useSupplyHistory (GET /api/supply-history with fallback)
│   ├── use-logos.ts              # Static logos from data/logos.json
│   ├── use-stablecoin-charts.ts  # GET /api/stablecoin-charts
│   ├── use-blacklist-events.ts   # GET /api/blacklist
│   ├── use-depeg-events.ts       # GET /api/depeg-events
│   ├── use-peg-summary.ts        # GET /api/peg-summary
│   ├── use-bluechip-ratings.ts   # GET /api/bluechip-ratings
│   ├── use-dex-liquidity.ts      # GET /api/dex-liquidity
│   ├── use-dex-liquidity-history.ts # GET /api/dex-liquidity-history
│   ├── use-usds-status.ts        # GET /api/usds-status
│   ├── use-daily-digest.ts       # GET /api/daily-digest
│   ├── use-digest-archive.ts    # GET /api/digest-archive
│   ├── use-status.ts             # GET /api/status (admin key auth, manual refresh)
│   ├── use-sort.ts               # Generic useSort<K> hook (sort state, toggle, keyboard, aria)
│   ├── use-time-range-filter.ts  # Generic time range state + data filtering hook
│   ├── use-homepage-filters.ts   # Homepage filter state + URL sync
│   ├── use-prefetch-stablecoin.ts # Prefetch stablecoin detail on hover
│   ├── use-api-query.ts          # Generic typed fetch hook wrapping TanStack Query (used by 10 data hooks)
│   ├── use-url-filters.ts        # Shared URL search param management (getParam, setParam, setParams)
│   ├── use-stability-index.ts    # GET /api/stability-index (daily PSI scores + history)
│   └── use-report-cards.ts       # GET /api/report-cards (grade cards + methodology)
└── lib/
    ├── api.ts                    # API_BASE URL config + apiFetch<T>() typed fetch wrapper
    ├── bluechip.ts               # BluechipGrade order, report URL base (slug map moved to worker)
    ├── types.ts                  # All TypeScript types, filter tag system, BluechipGrade union, CacheStatus (shared with worker)
    ├── stablecoins.ts            # Master list of ~141 tracked stablecoins with classification flags, contract addresses, geckoId, protocolSlug
    ├── dead-stablecoins.ts       # 78 dead stablecoins with cause of death, peak mcap, obituaries
    ├── format.ts                 # Currency, price, peg deviation, percent change, timeAgo, duration formatters
    ├── supply.ts                 # Shared supply helpers: sumPegBuckets, getCirculatingRaw/USD, getPrevDay/Week/MonthRaw/USD, computeGovernanceBreakdown
    ├── chart-colors.ts           # Shared CHART_PALETTE, CHART_BLUE/GREEN/RED, RECHARTS_TOOLTIP_STYLES for Recharts charts
    ├── dex-constants.ts          # DEX protocol name map, prettifyProtocol() helper
    ├── constants.ts              # THIRTY_DAYS_SECONDS, CATEGORY_LINKS
    ├── peg-rates.ts              # Derives FX reference rates from median prices in data (always returns PegRatesResult with rates + sources)
    ├── report-cards.ts           # Report card scoring: 6 dimensions, grade thresholds, weights
    ├── compare-share-image.ts    # Canvas-based share/export image generator for compare page
    ├── peg-score.ts              # Composite peg score algorithm (0-100)
    ├── peg-stability.ts          # Per-coin peg stability metrics
    ├── peg-utils.ts              # Shared peg helpers: mergeDepegSeconds(), worstDeviation()
    ├── blacklist-helpers.ts      # Shared blacklist helpers: isGoldStablecoin() type guard, extractGoldPrices(), computeBlacklistStats()
    ├── classification.ts         # Single source of truth for governance/backing/peg labels, badge colors, tier colors, chart hex colors (PEG_CHART_COLORS, BLACKLIST_CHART_COLORS, GRADE_COLORS)
    ├── severity-colors.ts        # Deviation severity color mapping (threshold-based: green/amber/orange/red) + getDurabilityColor/getDurabilityBgColor
    ├── chains.ts                 # CHAIN_META: chain names, explorer URLs, evmChainId, type (single source of truth)
    └── utils.ts                  # cn() helper for Tailwind class merging

worker/                           # Cloudflare Worker (API + cron jobs)
├── wrangler.toml                 # Worker config, D1 binding, cron triggers
├── migrations/                   # D1 SQL migrations (24 total)
└── src/
    ├── index.ts                  # Entry: fetch + scheduled handlers, CORS
    ├── router.ts                 # Route matching for API endpoints
    ├── cron/
    │   ├── sync-stablecoins.ts   # DefiLlama + CoinGecko gold → D1 (orchestrator, delegates to enrich-prices + detect-depegs)
    │   ├── enrich-prices.ts      # 5-pass price enrichment pipeline (DefiLlama, CoinGecko, CoinMarketCap, DexScreener)
    │   ├── detect-depegs.ts      # Depeg event detection + orphan event cleanup
    │   ├── sync-stablecoin-charts.ts  # Historical chart data → D1
    │   ├── snapshot-supply.ts    # Per-coin supply snapshots → D1 (daily, 8AM UTC)
    │   ├── sync-blacklist.ts     # Etherscan/TronGrid/dRPC → D1 (incremental)
    │   ├── sync-usds-status.ts   # USDS protocol status → D1 (daily, 8AM UTC)
    │   ├── sync-fx-rates.ts      # ECB + gold-api.com → D1 FX/commodity rates (15min, metals per-run)
    │   ├── sync-bluechip.ts      # Bluechip safety ratings → D1 (daily, 8AM UTC)
    │   ├── sync-dex-liquidity.ts # DeFiLlama Yields + Curve API + CG Onchain → D1 (15min)
    │   ├── stability-index.ts    # Composite ecosystem health score → D1 (daily, 7:55 UTC)
    │   ├── confirm-pending-depegs.ts # Secondary depeg confirmation for major coins (>$1B)
    │   └── daily-digest.ts       # AI-generated daily market summary via Claude API (daily, 8AM UTC)
    ├── api/
    │   ├── stablecoins.ts        # GET /api/stablecoins
    │   ├── stablecoin-detail.ts  # GET /api/stablecoin/:id
    │   ├── stablecoin-charts.ts  # GET /api/stablecoin-charts
    │   ├── supply-history.ts     # GET /api/supply-history
    │   ├── blacklist.ts          # GET /api/blacklist
    │   ├── depeg-events.ts       # GET /api/depeg-events
    │   ├── peg-summary.ts        # GET /api/peg-summary
    │   ├── usds-status.ts        # GET /api/usds-status
    │   ├── bluechip.ts           # GET /api/bluechip-ratings
    │   ├── daily-digest.ts       # GET /api/daily-digest
    │   ├── digest-archive.ts    # GET /api/digest-archive
    │   ├── dex-liquidity.ts      # GET /api/dex-liquidity (includes HHI, trends)
    │   ├── dex-liquidity-history.ts # GET /api/dex-liquidity-history
    │   ├── health.ts             # GET /api/health
    │   ├── status.ts             # GET /api/status (admin)
    │   ├── stability-index.ts    # GET /api/stability-index
    │   ├── report-cards.ts       # GET /api/report-cards
    │   ├── backfill-depegs.ts    # GET /api/backfill-depegs (admin)
    │   ├── backfill-supply-history.ts # GET /api/backfill-supply-history (admin)
    │   ├── backfill-stability-index.ts # GET /api/backfill-stability-index (admin)
    │   ├── backfill-cg-prices.ts # GET /api/backfill-cg-prices (admin)
    │   └── audit-depeg-history.ts # GET /api/audit-depeg-history (admin)
    └── lib/
        ├── db.ts                 # D1 read/write helpers (setCacheIfNewer CAS guard, batchExecute, buildPaginatedQuery, logCronRun with protected catch)
        ├── chain-rpcs.ts         # Chain RPC endpoint config (11 chains: EVM + Tron)
        ├── constants.ts          # Shared worker constants (DEPEG_THRESHOLD_BPS, DEX_FRESHNESS_SEC, D1_BATCH_SIZE, MIN_VALID_ASSET_COUNT, CACHE_PROFILES, ETHERSCAN_V2_BASE)
        ├── auth.ts               # Timing-safe admin key comparison (SHA-256 + crypto.subtle.timingSafeEqual)
        ├── alerts.ts             # Alert sending (ntfy push notifications on cron failures)
        ├── bigint.ts             # bigIntToDecimal() helper for safe BigInt-to-number conversion (used by blacklist sync)
        ├── binary-search.ts      # Generic binarySearchNearest<T>() for sorted array lookups
        ├── blacklist-contracts.ts # Blacklist contract addresses + event configs (worker-only, imports CHAIN_META)
        ├── bluechip-slugs.ts     # BLUECHIP_SLUG_MAP (worker-only, split from src/lib/bluechip.ts)
        ├── depeg-helpers.ts      # Shared DepegRow interface + rowToDepegEvent() mapper
        ├── evm-logs.ts           # EVM log filtering & parsing (Etherscan event decoding)
        ├── coingecko-onchain.ts   # CoinGecko Onchain API client (12 chains, pool discovery, locked liquidity)
        ├── stability-index.ts    # Stability index computation helpers
        ├── api-utils.ts          # withErrorHandler(), CacheStatus (re-exported from src/lib/types), buildCacheStatuses()
        └── fetch-retry.ts        # Fetch with retry + exponential backoff, default 15s timeout (configurable 404 handling)

data/
└── logos.json                    # Static stablecoin logo URLs (from CoinGecko)
```
