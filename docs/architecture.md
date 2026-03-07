# Architecture — Full File Tree & API Endpoints

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stablecoins` | Full stablecoin list with supply, price, chains. Returns `X-Data-Age` header |
| `GET /api/stablecoin/:id` | Per-coin detail (cache-aside, 5min TTL) |
| `GET /api/stablecoin-summary/:id` | Lightweight per-coin snapshot (price + aggregate supply/deltas) |
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
| `GET /api/status` | Admin status dashboard (raw/effective status, causes, confidence, staleness, probes, timeline). Requires `X-Admin-Key` header |
| `GET /api/status-history` | Admin machine-readable status timeline/probe history (`?limit=N`, max 200). Requires `X-Admin-Key` header |
| `GET /api/stability-index` | Daily Pharos Stability Index scores, bands, and component breakdowns (`?detail=true` for full history) |
| `GET /api/report-cards` | Stablecoin risk grade cards with dimension scores (peg, liquidity, resilience, decentralization, dependency) |
| `GET /api/safety-score-history` | Per-coin Safety Score grade transition history (`?stablecoin=ID&days=N`) |
| `GET /api/yield-rankings` | Pre-computed yield rankings with Pharos Yield Score, risk-adjusted metrics |
| `GET /api/yield-history` | Per-coin historical yield data (`?stablecoin=ID&days=90`) |
| `GET /api/mint-burn-flows` | Mint/burn flow data with gauge score, per-coin net-flow + pressure-shift signals, hourly timeseries (`?stablecoin=ID`, `?hours=N`) |
| `GET /api/mint-burn-events` | Individual mint/burn transfer events for a stablecoin (`?stablecoin=ID`, `?direction=`, `?chain=`, `?minAmount=`, `?limit=N&offset=M`) |
| `GET /api/stress-signals` | DEWS stress signal scores per coin (`?stablecoin=ID`, `?days=N`) |
| `POST /api/backfill-depegs` | Admin: backfill depeg events (requires `X-Admin-Key` header matching `ADMIN_KEY` secret) |
| `POST /api/backfill-supply-history` | Admin: backfill per-coin supply history (requires `X-Admin-Key`) |
| `POST /api/backfill-stability-index` | Admin: backfill historical stability index scores (requires `X-Admin-Key`) |
| `POST /api/backfill-cg-prices` | Admin: backfill CoinGecko historical prices into price_cache (requires `X-Admin-Key`) |
| `POST /api/backfill-mint-burn` | Admin: controlled mint/burn ingestion backfill by `configKey` (requires `X-Admin-Key`) |
| `POST /api/audit-depeg-history` | Admin: audit depeg events against CoinGecko price data for false positive detection (GET supports `dry-run=true` only; requires `X-Admin-Key`) |
| `POST /api/trigger-digest` | Admin: force digest regeneration bypassing 1h dedup (requires `X-Admin-Key`) |
| `POST /api/reset-blacklist-sync` | Admin: roll back blacklist sync state to re-scan missed events (requires `X-Admin-Key`) |
| `GET /api/backfill-dews` | Admin: DEWS backtest audit against historical depeg events (reports true-positive rate and lead time; requires `X-Admin-Key`) |
| `POST /api/backfill-mint-burn-prices` | Admin: backfill mint/burn event prices (requires `X-Admin-Key`) |
| `GET /api/debug-sync-state` | Admin: view blacklist sync state for all chains (requires `X-Admin-Key`) |
| `POST /api/feedback` | Public: submit feedback (bug, data-correction, feature-request). Rate-limited, auto-verified |

## Full File Tree

```
src/                              # Next.js frontend (static export)
├── app/
│   ├── page.tsx                  # Homepage: stats, safety/PSI/DEWS/flow snapshots, charts, peg tracker, filters, table
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
│   │   ├── changelog-page-utils.ts # Shared metadata + entry mapping helpers for methodology changelog routes
│   │   ├── changelog-route-factory.tsx # Config-driven wrapper factory for methodology changelog routes
│   │   ├── scoring-changelog/page.tsx  # Safety Score methodology changelog
│   │   ├── depeg-changelog/page.tsx    # Depeg/DEWS methodology changelog
│   │   ├── liquidity-score-changelog/page.tsx # Liquidity score changelog
│   │   ├── stability-index-changelog/page.tsx # PSI methodology changelog
│   │   ├── blacklist-tracker-changelog/page.tsx # Blacklist tracker changelog
│   │   ├── mint-burn-flow-changelog/page.tsx # Mint/Burn flow changelog
│   │   └── yield-changelog/page.tsx # Yield intelligence methodology changelog
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
│   ├── stablecoin/[id]/          # Detail page orchestration: section composition + modal state
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
│   ├── status/                   # Admin status dashboard (not in nav)
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── layout.tsx                # Root layout (header, footer, providers)
│   ├── error.tsx                 # Root error boundary
│   ├── not-found.tsx             # 404 page
│   ├── globals.css               # Global styles (Tailwind v4)
│   ├── sitemap.ts                # Dynamic sitemap generation
│   └── robots.ts                 # robots.txt
├── components/
│   ├── ui/                       # shadcn/ui primitives (do not edit manually)
│   ├── stablecoin-detail/        # Stablecoin detail section components (extracted from page client)
│   │   ├── hero-card.tsx
│   │   ├── overview-section.tsx
│   │   ├── chart-section.tsx
│   │   ├── info-section.tsx
│   │   ├── flows-section.tsx
│   │   ├── liquidity-section.tsx
│   │   ├── depeg-history-section.tsx
│   │   ├── safety-score-history-section.tsx
│   │   └── notices-and-summary-section.tsx
│   ├── header.tsx                # Top nav bar
│   ├── sidebar.tsx               # Sidebar navigation menu
│   ├── footer.tsx                # Site footer with data attribution
│   ├── providers.tsx             # TanStack Query + theme providers
│   ├── command-palette.tsx       # ⌘K command palette for quick navigation
│   ├── scroll-to-top.tsx         # Scroll-to-top button
│   ├── homepage-client.tsx       # Homepage interactive wrapper
│   ├── homepage-flow-overview.tsx # Homepage mint/burn snapshot block (FlowBrrrOverview wrapper)
│   ├── homepage-safety-overview.tsx # Homepage safety snapshot block (report-card distribution + largest coins)
│   ├── stablecoin-table.tsx      # Sortable table with filters
│   ├── stablecoin-table-logic.ts # Stablecoin table filtering/sorting/export helpers
│   ├── stablecoin-table-column-visibility.tsx # Stablecoin table column picker UI
│   ├── status/                   # Status dashboard component decomposition
│   ├── flow-gauge.tsx            # Shared Bank Run Gauge band configuration map (labels/colors/classes)
│   ├── flow-chart.tsx            # Mint/burn flow area chart (hourly timeseries)
│   ├── flow-table.tsx            # Per-coin flow table with pressure-shift states, volumes, and net flows
│   ├── flow-event-feed.tsx       # Live mint/burn event feed with filtering
│   ├── flow-summary-card.tsx     # Detail-page flow summary card with net-flow + pressure-shift signals
│   ├── filter-bar.tsx            # Homepage filter bar (classification dropdowns)
│   ├── kpi-bar.tsx               # Homepage KPI bar (total supply, dominance, etc.)
│   ├── category-stats.tsx        # Summary cards (total, by type, by backing)
│   ├── peg-diversity-chart.tsx   # Non-USD peg supply stacked area chart
│   ├── total-mcap-chart.tsx      # Full-width market cap area chart
│   ├── market-highlights.tsx     # Biggest depegs + fastest movers
│   ├── daily-digest.tsx          # Daily digest card component
│   ├── digest-archive-client.tsx # Digest archive list (client component)
│   ├── digest-snapshot.tsx       # Digest snapshot context display
│   ├── mcap-chart.tsx            # Market cap area chart (detail page)
│   ├── key-info-card.tsx         # Key info card: peg mechanism, issuer, collateral (detail page)
│   ├── ai-summary.tsx            # AI-generated editorial summary (detail page)
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
│   ├── eurc-blacklist-card.tsx   # EURC-specific blacklist card
│   ├── stablecoin-cemetery.tsx   # Cemetery obituary list
│   ├── cemetery-client.tsx       # Cemetery interactive client wrapper
│   ├── cemetery-tombstones.tsx   # Cemetery tombstone cards
│   ├── cemetery-charts.tsx       # Cemetery statistics charts
│   ├── stablecoin-logo.tsx       # Logo component with fallback
│   ├── coin-notice.tsx           # Coin-specific warning/info notices (detail page)
│   ├── feature-highlights.tsx    # Homepage feature highlight cards
│   ├── section-error-boundary.tsx # Section-level error boundary wrapper
│   ├── site-header.tsx           # Site header with nav and search
│   ├── bluechip-header-badge.tsx # Bluechip grade badge in header
│   ├── dex-liquidity-card.tsx    # DEX liquidity card with trend chart (detail page)
│   ├── liquidity-stats.tsx       # Liquidity page summary stat cards + protocol/chain breakdown bars
│   ├── liquidity-table.tsx       # Liquidity page sortable leaderboard table with pagination
│   ├── usds-status-card.tsx      # USDS protocol status card
│   ├── coin-selector.tsx         # Coin selector dropdown (compare page)
│   ├── comparison-chart.tsx      # Multi-series comparison line chart
│   ├── comparison-table.tsx      # Side-by-side comparison table
│   ├── report-card.tsx           # Report card component with grade, dimension scores, radar chart
│   ├── report-card-mini.tsx      # Compact report card display for compare page (+ simulation mode)
│   ├── grade-badge.tsx           # Grade letter badge component
│   ├── radar-chart.tsx           # Radar chart for report card dimensions (single + compare overlay)
│   ├── stress-test-panel.tsx     # Stress test panel (coin failure simulation)
│   ├── reserve-treemap.tsx       # Reserve composition treemap visualization
│   ├── contagion-graph.tsx       # Dependency contagion force-directed graph
│   ├── stability-index.tsx       # Stability index visualizations (sparklines, lighthouse icon)
│   ├── psi-history-chart.tsx     # PSI historical score chart
│   ├── chart-skeleton.tsx        # Loading skeleton for charts
│   ├── severity-icon.tsx         # Severity level icon
│   ├── feedback-button.tsx        # Feedback FAB button (bottom-right)
│   ├── feedback-modal.tsx        # Feedback submission modal (bug, data-correction, feature-request)
│   ├── page-error.tsx            # Shared error boundary component
│   ├── create-page-error.tsx     # Factory for route-level error.tsx wrappers
│   ├── feature-page-shell.tsx    # Shared page header/breadcrumb/status shell for feature routes
│   ├── longform-scrollspy-nav.tsx # Sticky scrollspy navigator for methodology/changelog long-form pages
│   ├── methodology-changelog-page.tsx # Shared renderer for methodology changelog pages
│   ├── methodology-version-card.tsx # Shared changelog version card
│   ├── stale-data-banner.tsx     # Stale data warning banner
│   ├── breadcrumb-json-ld.tsx    # Structured data for breadcrumbs
│   ├── faq-section.tsx           # Shared FAQ renderer (accordion UI + optional FAQPage JSON-LD script)
│   ├── sortable-table-head.tsx   # Shared sortable table header
│   ├── interactive-table-row.tsx # Shared clickable/keyboard-accessible table row wrapper
│   ├── table-pagination.tsx      # Shared pagination component
│   ├── balance-bar.tsx           # Balance ratio visualization bar
│   ├── sort-icon.tsx             # Shared sort direction arrow icon
│   ├── time-range-buttons.tsx    # Shared time range pill toggle buttons
│   ├── yield-leaderboard.tsx     # Yield rankings sortable table with score breakdown
│   ├── yield-scatter-plot.tsx    # Yield vs risk scatter chart with quadrant labels
│   └── theme-toggle.tsx          # Dark/light mode toggle
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
│   ├── use-endpoint-probes.ts    # Parallel endpoint probes (status page), shared polling helper + admin-header handling
│   ├── use-health.ts             # GET /api/health using shared polling policy helper
│   ├── use-status.ts             # GET /api/status (admin key auth) using shared polling policy helper
│   ├── use-sort.ts               # Generic useSort<K> hook (sort state, toggle, keyboard, aria)
│   ├── use-sorted-table-rows.ts  # Shared table sorting scaffold (useSort wiring + sorted row memo)
│   ├── use-table-pagination.ts   # Shared table pagination scaffold (effective page, ranges, prev/next handlers)
│   ├── use-sorted-paginated-table.ts # Shared table scaffold combining sorting + pagination state
│   ├── use-time-range-filter.ts  # Generic time range state + data filtering hook
│   ├── use-homepage-filters.ts   # Homepage filter state + URL sync
│   ├── use-prefetch-stablecoin.ts # Prefetch stablecoin detail on hover
│   ├── use-stablecoin-detail-view-model.ts # Stablecoin detail query wiring + derived view model
│   ├── use-api-query.ts          # Generic typed fetch hook wrapping TanStack Query (used by 18 data hooks)
│   ├── use-url-filters.ts        # Shared URL search param management (getParam, setParam, setParams, replaceParams)
│   ├── use-stability-index.ts    # GET /api/stability-index (daily PSI scores + history)
│   ├── use-report-cards.ts       # GET /api/report-cards (grade cards + methodology)
│   ├── use-safety-score-history.ts # GET /api/safety-score-history (per-coin grade transitions)
│   ├── use-portfolio.ts          # Portfolio holdings state, localStorage, URL sync, upstream exposure
│   ├── use-preferences.ts        # User preference state (persistent settings)
│   ├── use-stress-signals.ts     # GET /api/stress-signals (DEWS stress scores per coin)
│   ├── use-stress-test.ts        # Stress test state, computeStressedGrades invocation, impact calculation
│   └── use-yield-rankings.ts     # GET /api/yield-rankings (yield leaderboard data)
└── lib/
    ├── api.ts                    # API_BASE URL config + apiFetch<T>() typed fetch wrapper
    ├── analytics.ts              # Analytics tracking (page views, events)
    ├── blacklist-helpers.ts      # Shared blacklist helpers: isGoldStablecoin() type guard, extractGoldPrices(), computeBlacklistStats()
    ├── bluechip.ts               # BluechipGrade order, report URL base (slug map moved to worker)
    ├── chart-colors.ts           # Shared CHART_PALETTE, CHART_BLUE/GREEN/RED, RECHARTS_TOOLTIP_STYLES for Recharts charts
    ├── chart-export.ts           # Chart export utilities (PNG download)
    ├── compare-share-image.ts    # Canvas-based share/export image generator for compare page
    ├── constants.ts              # THIRTY_DAYS_SECONDS, CATEGORY_LINKS
    ├── cron-intervals.ts         # Shared cron interval constants for frontend polling policy + health config
    ├── csv-export.ts             # CSV export helpers
    ├── data-health-config.ts     # Frontend data-health freshness config
    ├── data-health.ts            # Frontend data-health derivation helpers
    ├── depeg-sort.ts             # Depeg/stress signal sorting helpers
    ├── dews-radar-utils.ts       # DEWS radar interaction helpers
    ├── dex-constants.ts          # DEX protocol name map, prettifyProtocol() helper
    ├── faq.ts                    # FAQ item type + FAQPage JSON-LD builder
    ├── flow-intensity.ts         # Mint/burn pressure-shift display + compatibility helpers
    ├── mint-burn-timeframes.ts   # Mint/burn timeframe constants/utilities
    ├── nav-config.ts             # Navigation menu structure (sidebar links, sections)
    ├── page-metadata.ts          # Shared metadata builder for feature routes
    ├── peg-landing.ts            # Peg currency landing page data helpers
    ├── peg-stability.ts          # Per-coin peg stability metrics
    ├── severity-colors.ts        # Deviation severity color mapping (threshold-based: green/amber/orange/red)
    ├── stablecoin-detail-derive.ts # Pure stablecoin detail derivations (supply/deviation/90d reference/border classes)
    └── utils.ts                  # cn() helper for Tailwind class merging

shared/                           # Runtime-neutral boundary (import via `@shared/*`)
├── index.ts                      # Curated exports for shared boundary consumers
├── types/
│   └── index.ts                  # Shared TypeScript types + Zod schemas
└── lib/
    ├── api-endpoints.ts          # Authoritative endpoint metadata + method/cache/probe/status-action helpers
    ├── strict-contract-paths.ts  # Strict API contract path exports
    ├── strict-contract-paths.json # Strict API contract path source for smoke checks
    ├── stablecoins.ts            # Tracked stablecoin metadata list
    ├── stablecoin-id-registry.ts # Canonical/external ID lookup maps + resolution helpers
    ├── supply.ts                 # Supply helper utilities
    ├── classification.ts         # Classification labels/colors + threat/style maps
    ├── mint-burn-signals.ts      # Shared mint/burn signal interpretation helpers (direction, pressure, composite state)
    ├── peg-rates.ts              # Peg reference derivation helpers
    ├── report-cards.ts           # Report-card scoring helpers
    └── ...                       # Additional pure cross-runtime modules migrated from `src/lib/`

worker/                           # Cloudflare Worker (API + cron jobs)
├── wrangler.toml                 # Worker config, D1 binding, cron triggers
├── migrations/                   # D1 SQL migrations (53 total)
└── src/
    ├── index.ts                  # Thin worker composition: delegates fetch/scheduled to handler modules
    ├── handlers/
    │   ├── http.ts               # HTTP flow: CORS, edge cache, method/auth gating, router dispatch
    │   └── scheduled.ts          # Cron flow: trigger-slot orchestration + lease-aware scheduling
    ├── router.ts                 # Router-dispatched API handlers (method gating + path dispatch from endpoint contract)
    ├── cron/
    │   ├── sync-stablecoins.ts   # DefiLlama + CoinGecko gold → D1 (orchestrator with explicit stage boundaries)
    │   ├── sync-stablecoins/
    │   │   ├── stages.ts         # Extracted sync-stablecoins stage helpers (normalize/filter/staleness/supply-history fill)
    │   │   └── supplemental-assets.ts # Extracted supplemental token fetch helpers (gold/silver/CG-only fiat overlays)
    │   ├── enrich-prices.ts      # Dual-primary price validation + 6-pass enrichment pipeline (DefiLlama, CoinGecko, CoinMarketCap, DexScreener)
    │   ├── detect-depegs.ts      # Depeg event detection + orphan event cleanup
    │   ├── sync-stablecoin-charts.ts  # Historical chart data → D1
    │   ├── snapshot-supply.ts    # Per-coin supply snapshots → D1 (daily, 8AM UTC)
    │   ├── snapshot-safety-grade-history.ts # Daily Safety Score grade transition snapshot → D1
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
    │   ├── sync-mint-burn.ts     # On-chain mint/burn event sync via Alchemy JSON-RPC (every 20min)
    │   └── status-self-check.ts  # Status reliability cron: real HTTP probes, hysteresis persistence, discrepancy/probe-failure alerts
    ├── api/
    │   ├── stablecoins.ts        # GET /api/stablecoins
    │   ├── stablecoin-detail.ts  # GET /api/stablecoin/:id (orchestrator + branch routing)
    │   ├── stablecoin-summary.ts # GET /api/stablecoin-summary/:id (lightweight per-coin snapshot)
    │   ├── stablecoin-detail/    # Stablecoin detail handler internals (focused modules)
    │   │   ├── shared.ts         # Shared cache/logging/response helpers + supply_history fallback
    │   │   ├── commodity.ts      # Commodity token upstream assembly (DL + CG fallback)
    │   │   ├── coingecko-only.ts # CoinGecko-only token branch assembly
    │   │   └── defillama.ts      # DefiLlama detail normalization (non-USD USD-conversion)
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
    │   ├── status-history.ts     # GET /api/status-history (admin)
    │   ├── stability-index.ts    # GET /api/stability-index
    │   ├── report-cards.ts       # GET /api/report-cards
    │   ├── safety-score-history.ts # GET /api/safety-score-history
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
    │   └── feedback.ts          # POST /api/feedback (public)
    └── lib/
        ├── db.ts                 # D1 read/write helpers (setCacheIfNewer CAS guard, batchExecute, buildPaginatedQuery, buildInClause, logCronRun with protected catch)
        ├── chain-rpcs.ts         # Chain RPC endpoint config (11 chains: EVM + Tron)
        ├── circuit-breaker.ts    # Per-source circuit breaker (3-strike open, 30-min probe, auto-alert on transitions)
        ├── constants.ts          # Shared worker constants (DEPEG_THRESHOLD_BPS, DEX_FRESHNESS_SEC, D1_BATCH_SIZE, MIN_VALID_ASSET_COUNT, CACHE_PROFILES, CIRCUIT_SOURCE)
        ├── auth.ts               # Timing-safe admin key comparison (SHA-256 + crypto.subtle.timingSafeEqual)
        ├── env.ts                # Worker Env typing + CSV env parsing helper for disable/override lists
        ├── alerts.ts             # Alert sending (Discord/Slack webhook notifications on cron failures)
        ├── stablecoins-cache.ts  # Shared strict/lenient loader for canonical stablecoins cache payload
        ├── safety-scores.ts      # Shared safety score snapshot helper (yield + digest consumers)
        ├── report-cards-snapshot.ts # Shared report-card snapshot builder (API + safety-grade-history cron)
        ├── peg-analytics.ts      # Shared peg analytics snapshot helper (peg-summary + report-cards consumers)
        ├── mint-burn-health-config.ts # Shared mint/burn stale thresholds + major symbol defaults
        ├── bigint.ts             # bigIntToDecimal() helper for safe BigInt-to-number conversion (used by blacklist sync)
        ├── binary-search.ts      # Generic binarySearchNearest<T>() for sorted array lookups
        ├── blacklist-contracts.ts # Blacklist contract addresses + event configs (worker-only, imports CHAIN_META)
        ├── bluechip-slugs.ts     # BLUECHIP_SLUG_MAP (worker-only, split from src/lib/bluechip.ts)
        ├── depeg-helpers.ts      # Shared DepegRow interface + rowToDepegEvent() mapper
        ├── dews.ts               # DEWS computation: 8 sub-signals, weighted average, threat bands
        ├── evm-logs.ts           # EVM log filtering & parsing (Etherscan event decoding)
        ├── coingecko.ts          # CoinGecko API key initialization (shared across crons)
        ├── coingecko-onchain.ts  # CoinGecko Onchain API client (16 chains, pool discovery, locked liquidity)
        ├── twitter.ts            # Twitter/X API client for daily digest posting
        ├── stability-index.ts    # Stability index computation helpers
        ├── backfill-query.ts     # Shared admin backfill query parsing/selection helpers (stablecoin/batch/batchSize)
        ├── api-utils.ts          # withErrorHandler(), CacheStatus (from shared types), buildCacheStatuses()
        ├── status-reliability.ts # Status hysteresis, transitions, probe/discrepancy persistence
        ├── mint-burn-contracts.ts # Mint/burn contract configs per stablecoin/chain (mint addresses, decimals)
        ├── mint-burn-scoring.ts  # Flow Intensity Score (FIS), Bank Run Gauge, flight-to-quality detection
        ├── mint-burn-pipeline/   # Shared ingestion helpers used by cron + admin backfill paths
        │   ├── types.ts          # Shared row/context/counter + sync-state mode types
        │   ├── parse.ts          # parseMintBurnLogs() + event price resolution
        │   ├── classification.ts # Bridge-aware burn classification + tx-context loader
        │   ├── context.ts        # Shared current + historical price context loading
        │   ├── persistence.ts    # Event insert, burn update, affected-hour recompute helpers
        │   └── sync-state.ts     # Sync-state read/init/upsert helpers (replace vs monotonic-max)
        ├── fetch-retry.ts        # Fetch with retry + exponential backoff, default 15s timeout (configurable 404 handling)
        ├── dexscreener.ts        # DexScreener API client (token price + pool search)
        ├── resolve-market-cap.ts # Multi-source market cap resolution (DL → CG → CMC → DexScreener)
        └── telegram.ts           # Telegram Bot API client for daily digest distribution

data/
├── logos.json                    # Static stablecoin logo URLs (from CoinGecko)
├── ai-summaries.json             # Cached AI-generated editorial summaries
└── digests.json                  # Digest archive data
```
