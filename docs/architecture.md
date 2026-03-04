# Architecture — Full File Tree & API Endpoints

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stablecoins` | Full stablecoin list with supply, price, chains. Returns `X-Data-Age` header |
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
| `GET /api/digest-snapshot` | Contextual data snapshot for a specific digest date (`?date=YYYY-MM-DD`) for SSG builds |
| `GET /api/health` | Worker health check (includes circuit breaker states) |
| `GET /api/status` | Admin status dashboard (cron runs, cache freshness, data quality). Requires `X-Admin-Key` header |
| `GET /api/stability-index` | Daily Pharos Stability Index scores, bands, and component breakdowns (`?detail=true` for full history) |
| `GET /api/report-cards` | Stablecoin risk grade cards with dimension scores (peg, liquidity, resilience, decentralization, dependency) |
| `GET /api/yield-rankings` | Pre-computed yield rankings with Pharos Yield Score, risk-adjusted metrics |
| `GET /api/yield-history` | Per-coin historical yield data (`?stablecoin=ID&days=90`) |
| `GET /api/mint-burn-flows` | Mint/burn flow data with gauge score, per-coin FIS, hourly timeseries (`?stablecoin=ID`, `?hours=N`) |
| `GET /api/mint-burn-events` | Individual mint/burn transfer events for a stablecoin (`?stablecoin=ID`, `?direction=`, `?chain=`, `?minAmount=`, `?limit=N&offset=M`) |
| `GET /api/stress-signals` | DEWS stress signal scores per coin (`?stablecoin=ID`, `?days=N`) |
| `POST /api/backfill-depegs` | Admin: backfill depeg events (requires `X-Admin-Key` header matching `ADMIN_KEY` secret) |
| `POST /api/backfill-supply-history` | Admin: backfill per-coin supply history (requires `X-Admin-Key`) |
| `POST /api/backfill-stability-index` | Admin: backfill historical stability index scores (requires `X-Admin-Key`) |
| `POST /api/backfill-cg-prices` | Admin: backfill CoinGecko historical prices into price_cache (requires `X-Admin-Key`) |
| `POST /api/backfill-mint-burn` | Admin: controlled mint/burn ingestion backfill by `configKey` (requires `X-Admin-Key`) |
| `POST /api/audit-depeg-history` | Admin: audit depeg events against CoinGecko price data for false positive detection (GET supports `dry-run=true` only; requires `X-Admin-Key`) |
| `GET /api/trigger-digest` | Admin: force digest regeneration bypassing 1h dedup (requires `X-Admin-Key`). Handled in `index.ts`, not router |
| `GET /api/reset-blacklist-sync` | Admin: roll back blacklist sync state to re-scan missed events (requires `X-Admin-Key`). Handled in `index.ts`, not router |
| `GET /api/backfill-dews` | Admin: DEWS backtest audit against historical depeg events (reports true-positive rate and lead time; requires `X-Admin-Key`) |
| `POST /api/backfill-mint-burn-prices` | Admin: backfill mint/burn event prices (requires `X-Admin-Key`) |
| `GET /api/debug-sync-state` | Admin: view blacklist sync state for all chains (requires `X-Admin-Key`). Handled in `index.ts`, not router |
| `POST /api/feedback` | Public: submit feedback (bug, data-correction, feature-request). Rate-limited, auto-verified |

## Full File Tree

```
src/                              # Next.js frontend (static export)
├── app/
│   ├── page.tsx                  # Homepage: stats, charts, peg tracker, filters, table
│   ├── blacklist/                # Freeze & blacklist event tracker
│   │   ├── page.tsx
│   │   ├── layout.tsx
│   │   └── error.tsx
│   ├── cemetery/                 # Dead stablecoin graveyard
│   │   ├── page.tsx
│   │   └── error.tsx
│   ├── compare/                  # Side-by-side stablecoin comparison
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── dependency-map/           # Collateral dependency graph visualization
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── depeg/                    # Depeg Tracker: live peg monitoring, DEWS, heatmap, event feed
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── digest/                   # Daily digest archive
│   │   ├── page.tsx
│   │   └── [date]/page.tsx       # Historical digest by date
│   ├── flows/                    # Mint/burn flow tracker
│   │   ├── page.tsx
│   │   └── layout.tsx
│   ├── liquidity/                # DEX liquidity scores & leaderboard
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── methodology/              # Detailed methodology documentation
│   │   ├── page.tsx
│   │   ├── error.tsx
│   │   ├── scoring-changelog/page.tsx  # Safety Score methodology changelog
│   │   ├── depeg-changelog/page.tsx    # Depeg/DEWS methodology changelog
│   │   ├── liquidity-score-changelog/page.tsx # Liquidity score changelog
│   │   ├── stability-index-changelog/page.tsx # PSI methodology changelog
│   │   ├── blacklist-tracker-changelog/page.tsx # Blacklist tracker changelog
│   │   └── mint-burn-flow-changelog/page.tsx # Mint/Burn flow changelog
│   ├── portfolio/                # Portfolio stress testing & upstream exposure
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── privacy/page.tsx          # Privacy policy
│   ├── safety-scores/            # Risk Lab: stablecoin safety grade cards with radar charts
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── stability-index/          # Pharos Stability Index (ecosystem health)
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── stablecoin/[id]/          # Detail page: price chart, supply chart, chains
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── stablecoins/[peg]/        # Stablecoins filtered by peg currency
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── yield/                    # Yield intelligence leaderboard
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── about/                    # About & methodology
│   │   ├── page.tsx
│   │   └── error.tsx
│   ├── stability-index-alt/      # Alternative PSI visualization (seismograph, strata)
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── status/                   # Admin status dashboard (not in nav)
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
│   ├── header.tsx                # Top nav bar
│   ├── sidebar.tsx               # Sidebar navigation menu
│   ├── footer.tsx                # Site footer with data attribution
│   ├── providers.tsx             # TanStack Query + theme providers
│   ├── command-palette.tsx       # ⌘K command palette for quick navigation
│   ├── scroll-to-top.tsx         # Scroll-to-top button
│   ├── homepage-client.tsx       # Homepage interactive wrapper
│   ├── stablecoin-table.tsx      # Sortable table with filters
│   ├── flow-gauge.tsx             # Bank Run Gauge visualization (full-size)
│   ├── flow-gauge-mini.tsx       # Compact gauge for homepage/detail page
│   ├── flow-chart.tsx            # Mint/burn flow area chart (hourly timeseries)
│   ├── flow-table.tsx            # Per-coin flow table with FIS, volumes, net flows
│   ├── flow-event-feed.tsx       # Live mint/burn event feed with filtering
│   ├── flow-summary-card.tsx     # Summary card for homepage/detail page
│   ├── filter-bar.tsx            # Homepage filter bar (classification dropdowns)
│   ├── kpi-bar.tsx               # Homepage KPI bar (total supply, dominance, etc.)
│   ├── category-stats.tsx        # Summary cards (total, by type, by backing)
│   ├── peg-type-chart.tsx        # "Alternative Peg Dominance" card
│   ├── peg-diversity-chart.tsx   # Non-USD peg supply stacked area chart
│   ├── total-mcap-chart.tsx      # Full-width market cap area chart
│   ├── chain-overview.tsx        # Horizontal bar chart (homepage)
│   ├── market-highlights.tsx     # Biggest depegs + fastest movers
│   ├── market-pulse.tsx          # AI daily digest display
│   ├── daily-digest.tsx          # Daily digest card component (exports formatDateline)
│   ├── digest-archive-client.tsx # Digest archive list (client component)
│   ├── digest-archive-summary.tsx # Digest archive summary stats
│   ├── digest-snapshot.tsx       # Digest snapshot context display
│   ├── mcap-chart.tsx            # Market cap area chart (detail page)
│   ├── key-info-card.tsx         # Key info card: peg mechanism, issuer, collateral (detail page)
│   ├── ai-summary.tsx            # AI-generated editorial summary (detail page)
│   ├── contract-addresses.tsx    # Contract address display (detail page)
│   ├── detail-section-nav.tsx    # In-page section navigation (detail page)
│   ├── peg-gauge.tsx             # Peg score gauge visualization
│   ├── peg-heatmap.tsx           # Real-time peg deviation heatmap
│   ├── depeg-feed.tsx            # Depeg event list
│   ├── depeg-history.tsx         # Per-coin depeg history (detail page)
│   ├── dews-badge.tsx            # DEWS threat level badge
│   ├── dews-detail.tsx           # DEWS detail breakdown (detail page)
│   ├── dews-summary.tsx          # DEWS summary card (homepage)
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
│   ├── coin-notice.tsx           # Coin-specific warning/info notices (detail page)
│   ├── feature-highlights.tsx    # Homepage feature highlight cards
│   ├── section-error-boundary.tsx # Section-level error boundary wrapper
│   ├── site-header.tsx           # Site header with nav and search
│   ├── bluechip-rating-card.tsx  # Bluechip safety rating card (detail page)
│   ├── bluechip-box.tsx          # Bluechip rating box (homepage)
│   ├── bluechip-header-badge.tsx # Bluechip grade badge in header
│   ├── dex-liquidity-card.tsx    # DEX liquidity card with trend chart (detail page)
│   ├── liquidity-box.tsx         # Liquidity box (homepage)
│   ├── liquidity-stats.tsx       # Liquidity page summary stat cards + protocol/chain breakdown bars
│   ├── liquidity-table.tsx       # Liquidity page sortable leaderboard table with pagination
│   ├── liquidity-summary.tsx     # Liquidity homepage summary card
│   ├── usds-status-card.tsx      # USDS protocol status card
│   ├── coin-selector.tsx         # Coin selector dropdown (compare page)
│   ├── comparison-chart.tsx      # Multi-series comparison line chart
│   ├── comparison-table.tsx      # Side-by-side comparison table
│   ├── report-card.tsx           # Report card component with grade, dimension scores, radar chart
│   ├── report-card-mini.tsx      # Compact report card display for compare page (+ simulation mode)
│   ├── report-cards-summary.tsx  # Report cards page summary stats
│   ├── grade-badge.tsx           # Grade letter badge component
│   ├── radar-chart.tsx           # Radar chart for report card dimensions (single + compare overlay)
│   ├── stress-test-panel.tsx     # Stress test panel (coin failure simulation)
│   ├── reserve-treemap.tsx       # Reserve composition treemap visualization
│   ├── contagion-graph.tsx       # Dependency contagion force-directed graph
│   ├── stability-index.tsx       # Stability index visualizations (sparklines, lighthouse icon)
│   ├── stability-index-summary.tsx # PSI summary stats for homepage
│   ├── psi-history-chart.tsx     # PSI historical score chart
│   ├── psi-atmosphere.tsx        # PSI atmospheric particle visualization
│   ├── psi-seismograph.tsx       # PSI seismograph waveform visualization
│   ├── psi-strata-chart.tsx      # PSI strata (geological layers) breakdown chart
│   ├── chart-skeleton.tsx        # Loading skeleton for charts
│   ├── severity-icon.tsx         # Severity level icon
│   ├── feedback-button.tsx        # Feedback FAB button (bottom-right)
│   ├── feedback-modal.tsx        # Feedback submission modal (bug, data-correction, feature-request)
│   ├── page-error.tsx            # Shared error boundary component
│   ├── create-page-error.tsx     # Factory for route-level error.tsx wrappers
│   ├── feature-page-shell.tsx    # Shared page header/breadcrumb/status shell for feature routes
│   ├── methodology-changelog-page.tsx # Shared renderer for methodology changelog pages
│   ├── methodology-version-card.tsx # Shared changelog version card
│   ├── stale-data-banner.tsx     # Stale data warning banner
│   ├── breadcrumb-json-ld.tsx    # Structured data for breadcrumbs
│   ├── sortable-table-head.tsx   # Shared sortable table header
│   ├── table-pagination.tsx      # Shared pagination component
│   ├── balance-bar.tsx           # Balance ratio visualization bar
│   ├── sort-icon.tsx             # Shared sort direction arrow icon
│   ├── time-range-buttons.tsx    # Shared time range pill toggle buttons
│   ├── yield-leaderboard.tsx     # Yield rankings sortable table with score breakdown
│   ├── yield-scatter-plot.tsx    # Yield vs risk scatter chart with quadrant labels
│   ├── theme-toggle.tsx          # Dark/light mode toggle
│   └── pharos-loader.tsx         # Loading spinner
├── hooks/
│   ├── use-stablecoins.ts        # GET /api/stablecoins + useSupplyHistory (GET /api/supply-history with fallback)
│   ├── use-mint-burn-flows.ts    # GET /api/mint-burn-flows + GET /api/mint-burn-events
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
│   ├── use-digest-snapshot.ts    # GET /api/digest-snapshot (per-date context)
│   ├── use-endpoint-probes.ts    # Parallel endpoint health probes (status page)
│   ├── use-health.ts             # GET /api/health (auto-refresh 60s)
│   ├── use-status.ts             # GET /api/status (admin key auth, manual refresh)
│   ├── use-sort.ts               # Generic useSort<K> hook (sort state, toggle, keyboard, aria)
│   ├── use-time-range-filter.ts  # Generic time range state + data filtering hook
│   ├── use-homepage-filters.ts   # Homepage filter state + URL sync
│   ├── use-prefetch-stablecoin.ts # Prefetch stablecoin detail on hover
│   ├── use-api-query.ts          # Generic typed fetch hook wrapping TanStack Query (used by 10 data hooks)
│   ├── use-url-filters.ts        # Shared URL search param management (getParam, setParam, setParams)
│   ├── use-stability-index.ts    # GET /api/stability-index (daily PSI scores + history)
│   ├── use-report-cards.ts       # GET /api/report-cards (grade cards + methodology)
│   ├── use-portfolio.ts          # Portfolio holdings state, localStorage, URL sync, upstream exposure
│   ├── use-preferences.ts        # User preference state (persistent settings)
│   ├── use-stress-signals.ts     # GET /api/stress-signals (DEWS stress scores per coin)
│   ├── use-stress-test.ts        # Stress test state, computeStressedGrades invocation, impact calculation
│   └── use-yield-rankings.ts     # GET /api/yield-rankings (yield leaderboard data)
└── lib/
    ├── api.ts                    # API_BASE URL config + apiFetch<T>() typed fetch wrapper
    ├── api-endpoints.ts          # Shared API endpoint registry (worker method/cache rules + status probes/actions)
    ├── analytics.ts              # Analytics tracking (page views, events)
    ├── bluechip.ts               # BluechipGrade order, report URL base (slug map moved to worker)
    ├── types.ts                  # All TypeScript types, filter tag system, BluechipGrade union, DependencyWeight, ReserveSlice (with coinId/depType), RawDimensionInputs, CacheStatus (shared with worker)
    ├── reserve-templates.ts      # Reserve composition templates, getReserves(), deriveDependencies() (reserve slices → DependencyWeight[])
    ├── stablecoins.ts            # Master list of tracked stablecoins with classification flags, contract addresses, geckoId, protocolSlug
    ├── shadow-stablecoins.ts     # Shadow stablecoins (UST, IRON) tracked in cemetery but not in main list
    ├── dead-stablecoins.ts       # 78 dead stablecoins with cause of death, peak mcap, obituaries
    ├── format.ts                 # Currency, price, peg deviation, percent change, timeAgo, duration formatters
    ├── supply.ts                 # Shared supply helpers: sumPegBuckets, getCirculatingRaw/USD, getPrevDay/Week/MonthRaw/USD, computeGovernanceBreakdown
    ├── chart-colors.ts           # Shared CHART_PALETTE, CHART_BLUE/GREEN/RED, RECHARTS_TOOLTIP_STYLES for Recharts charts
    ├── chart-export.ts           # Chart export utilities (PNG download)
    ├── csv-export.ts             # CSV export helpers
    ├── dex-constants.ts          # DEX protocol name map, prettifyProtocol() helper
    ├── constants.ts              # THIRTY_DAYS_SECONDS, CATEGORY_LINKS
    ├── nav-config.ts             # Navigation menu structure (sidebar links, sections)
    ├── page-metadata.ts          # Shared metadata builder for feature routes
    ├── peg-rates.ts              # Derives FX reference rates from median prices in data (always returns PegRatesResult with rates + sources)
    ├── peg-landing.ts            # Peg currency landing page data helpers
    ├── report-cards.ts           # Report card scoring: 5 dimensions, grade thresholds, weights, computeStressedGrades()
    ├── compare-share-image.ts    # Canvas-based share/export image generator for compare page
    ├── peg-score.ts              # Composite peg score algorithm (0-100)
    ├── peg-stability.ts          # Per-coin peg stability metrics
    ├── peg-utils.ts              # Shared peg helpers: mergeDepegSeconds(), worstDeviation()
    ├── psi-colors.ts             # PSI condition band color mapping
    ├── psi-eligible.ts           # PSI eligibility logic (which coins qualify for index)
    ├── blacklist-helpers.ts      # Shared blacklist helpers: isGoldStablecoin() type guard, extractGoldPrices(), computeBlacklistStats()
    ├── classification.ts         # Single source of truth for governance/backing/peg labels, badge colors, tier colors, chart hex colors (PEG_CHART_COLORS, BLACKLIST_CHART_COLORS, GRADE_COLORS)
    ├── severity-colors.ts        # Deviation severity color mapping (threshold-based: green/amber/orange/red) + getDurabilityColor/getDurabilityBgColor
    ├── chains.ts                 # CHAIN_META: chain names, explorer URLs, evmChainId, type (single source of truth)
    └── utils.ts                  # cn() helper for Tailwind class merging

worker/                           # Cloudflare Worker (API + cron jobs)
├── wrangler.toml                 # Worker config, D1 binding, cron triggers
├── migrations/                   # D1 SQL migrations (48 total)
└── src/
    ├── index.ts                  # Entry: fetch + scheduled handlers, CORS
    ├── router.ts                 # Route matching for API endpoints
    ├── cron/
    │   ├── sync-stablecoins.ts   # DefiLlama + CoinGecko gold → D1 (orchestrator, delegates to enrich-prices + detect-depegs)
    │   ├── enrich-prices.ts      # Dual-primary price validation + 6-pass enrichment pipeline (DefiLlama, CoinGecko, CoinMarketCap, DexScreener)
    │   ├── detect-depegs.ts      # Depeg event detection + orphan event cleanup
    │   ├── sync-stablecoin-charts.ts  # Historical chart data → D1
    │   ├── snapshot-supply.ts    # Per-coin supply snapshots → D1 (daily, 8AM UTC)
    │   ├── sync-blacklist.ts     # Etherscan/TronGrid/dRPC → D1 (incremental)
    │   ├── sync-usds-status.ts   # USDS protocol status → D1 (daily, 8AM UTC)
    │   ├── sync-fx-rates.ts      # ECB + gold-api.com → D1 FX/commodity rates (15min, metals per-run)
    │   ├── sync-bluechip.ts      # Bluechip safety ratings → D1 (daily, 8AM UTC)
    │   ├── dex-liquidity/        # DeFiLlama Yields + Curve API + CG Onchain → D1 (every 30min)
    │   │   ├── index.ts           # Barrel re-export
    │   │   ├── types.ts           # All interfaces and type aliases
    │   │   ├── constants.ts       # API URLs, subgraph IDs, GraphQL queries, quality maps
    │   │   ├── pool-helpers.ts    # Pure functions: classification, scoring, normalization
    │   │   ├── fetch-primary.ts   # DL Yields/Protocols, Curve, Uni V3, Aerodrome, token batches
    │   │   ├── fetch-crawlers.ts  # CG/GT per-token pool crawl + merge
    │   │   ├── fetch-fallbacks.ts # DexScreener + CG tickers fallbacks
    │   │   ├── process-pools.ts   # Match DL pools to stablecoins with enrichment
    │   │   ├── scoring.ts         # Composite scores, HHI, depth stability, DEX prices
    │   │   ├── persistence.ts     # D1 writes (scores table, history snapshots)
    │   │   └── orchestrator.ts    # 10-step syncDexLiquidity() main function
    │   ├── stability-index.ts    # Composite ecosystem health score → D1 (every 15 min, after sync-stablecoins)
    │   ├── snapshot-psi.ts       # Daily PSI snapshot → D1 (daily, 8AM UTC)
    │   ├── confirm-pending-depegs.ts # Secondary depeg confirmation for major coins (>$1B)
    │   ├── daily-digest.ts       # AI-generated daily market summary via Claude API (daily, 8AM UTC)
    │   ├── compute-dews.ts       # DEWS computation cron (every 15min, after sync-stablecoins)
    │   ├── yield-config.ts       # Yield source configs: pool UUIDs, source types, scoring params
    │   ├── yield-helpers.ts      # Pure yield computation helpers: Pharos Yield Score, excess yield, stability
    │   ├── fetch-tbill-rate.ts   # T-bill proxy fetcher (FRED DGS3MO)
    │   ├── sync-yield-data.ts    # Yield data sync cron: DeFiLlama yields → D1 + rankings cache
    │   └── sync-mint-burn.ts     # On-chain mint/burn event sync via Alchemy JSON-RPC (every 20min)
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
    │   ├── digest-snapshot.ts   # GET /api/digest-snapshot
    │   ├── dex-liquidity.ts      # GET /api/dex-liquidity (includes HHI, trends)
    │   ├── dex-liquidity-history.ts # GET /api/dex-liquidity-history
    │   ├── health.ts             # GET /api/health
    │   ├── status.ts             # GET /api/status (admin)
    │   ├── stability-index.ts    # GET /api/stability-index
    │   ├── report-cards.ts       # GET /api/report-cards
    │   ├── backfill-depegs.ts    # POST /api/backfill-depegs (admin)
    │   ├── backfill-supply-history.ts # POST /api/backfill-supply-history (admin)
    │   ├── backfill-stability-index.ts # POST /api/backfill-stability-index (admin)
    │   ├── backfill-cg-prices.ts # POST /api/backfill-cg-prices (admin)
    │   ├── audit-depeg-history.ts # POST /api/audit-depeg-history (admin; GET dry-run only)
    │   ├── backfill-dews.ts     # GET /api/backfill-dews (admin)
    │   ├── backfill-mint-burn-prices.ts # POST /api/backfill-mint-burn-prices (admin)
    │   ├── backfill-mint-burn.ts # POST /api/backfill-mint-burn (admin)
    │   ├── stress-signals.ts    # GET /api/stress-signals (DEWS scores)
    │   ├── yield-rankings.ts    # GET /api/yield-rankings
    │   ├── yield-history.ts     # GET /api/yield-history
    │   ├── mint-burn-flows.ts    # GET /api/mint-burn-flows (aggregate + per-coin modes)
    │   ├── mint-burn-events.ts   # GET /api/mint-burn-events (paginated event log)
    │   └── feedback.ts          # POST /api/feedback (public, handled in index.ts not router)
    └── lib/
        ├── db.ts                 # D1 read/write helpers (setCacheIfNewer CAS guard, batchExecute, buildPaginatedQuery, logCronRun with protected catch)
        ├── chain-rpcs.ts         # Chain RPC endpoint config (11 chains: EVM + Tron)
        ├── circuit-breaker.ts    # Per-source circuit breaker (3-strike open, 30-min probe, auto-alert on transitions)
        ├── constants.ts          # Shared worker constants (DEPEG_THRESHOLD_BPS, DEX_FRESHNESS_SEC, D1_BATCH_SIZE, MIN_VALID_ASSET_COUNT, CACHE_PROFILES, CIRCUIT_SOURCE)
        ├── auth.ts               # Timing-safe admin key comparison (SHA-256 + crypto.subtle.timingSafeEqual)
        ├── alerts.ts             # Alert sending (ntfy push notifications on cron failures)
        ├── bigint.ts             # bigIntToDecimal() helper for safe BigInt-to-number conversion (used by blacklist sync)
        ├── binary-search.ts      # Generic binarySearchNearest<T>() for sorted array lookups
        ├── blacklist-contracts.ts # Blacklist contract addresses + event configs (worker-only, imports CHAIN_META)
        ├── bluechip-slugs.ts     # BLUECHIP_SLUG_MAP (worker-only, split from src/lib/bluechip.ts)
        ├── depeg-helpers.ts      # Shared DepegRow interface + rowToDepegEvent() mapper
        ├── dews.ts               # DEWS computation: 8 sub-signals, weighted average, threat bands
        ├── evm-logs.ts           # EVM log filtering & parsing (Etherscan event decoding)
        ├── coingecko.ts          # CoinGecko API key initialization (shared across crons)
        ├── coingecko-onchain.ts  # CoinGecko Onchain API client (15 chains, pool discovery, locked liquidity)
        ├── twitter.ts            # Twitter/X API client for daily digest posting
        ├── stability-index.ts    # Stability index computation helpers
        ├── api-utils.ts          # withErrorHandler(), CacheStatus (re-exported from src/lib/types), buildCacheStatuses()
        ├── mint-burn-contracts.ts # Mint/burn contract configs per stablecoin/chain (mint addresses, decimals)
        ├── mint-burn-scoring.ts  # Flow Intensity Score (FIS), Bank Run Gauge, flight-to-quality detection
        ├── fetch-retry.ts        # Fetch with retry + exponential backoff, default 15s timeout (configurable 404 handling)
        ├── dexscreener.ts        # DexScreener API client (token price + pool search)
        ├── resolve-market-cap.ts # Multi-source market cap resolution (DL → CG → CMC → DexScreener)
        └── telegram.ts           # Telegram Bot API client for daily digest distribution

data/
├── logos.json                    # Static stablecoin logo URLs (from CoinGecko)
├── ai-summaries.json             # Cached AI-generated editorial summaries
└── digests.json                  # Digest archive data
```
