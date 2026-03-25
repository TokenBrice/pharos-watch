# Architecture — Curated File Tree & API Endpoints

## API Endpoints

Curated architecture-significant routes. Start with the [Documentation Index](./README.md) for the full docs map, or go straight to the [API Reference](./api-reference.md) for the exhaustive HTTP contract.

## Route Definition Model

Static route metadata is declared once in `shared/lib/api-endpoints.ts`. That shared descriptor list now carries path, method, admin/cache/probe/status-action metadata, plus the worker dependency-hydration hints needed for static routes. `worker/src/route-registry.ts` binds worker handlers to those shared endpoint keys, and `worker/src/router.ts` stays focused on generic dispatch plus the dynamic route patterns that cannot be enumerated statically.

| Endpoint                                     | Description                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/stablecoins`                       | Full stablecoin list with supply, price, chains. Returns `X-Data-Age` header                                                                                                                                                   |
| `GET /api/stablecoin/:id`                    | Per-coin detail (cache-aside, 5min TTL)                                                                                                                                                                                        |
| `GET /api/stablecoin-summary/:id`            | Lightweight per-coin snapshot (price + aggregate supply/deltas)                                                                                                                                                                |
| `GET /api/stablecoin-reserves/:id`           | Live or fallback reserve composition for live-enabled assets                                                                                                                                                                   |
| `GET /api/redemption-backstops`              | Modeled redemption-route and effective-exit snapshot for configured assets                                                                                                                                                     |
| `GET /api/stablecoin-charts`                 | Historical total supply chart data                                                                                                                                                                                             |
| `GET /api/blacklist`                         | Freeze/blacklist events (filterable by token, chain)                                                                                                                                                                           |
| `GET /api/depeg-events`                      | Depeg events (`?stablecoin=ID`, `?active=true`, `?limit=N&offset=M`)                                                                                                                                                           |
| `GET /api/peg-summary`                       | Per-coin peg scores + aggregate summary stats                                                                                                                                                                                  |
| `GET /api/usds-status`                       | USDS Sky protocol status                                                                                                                                                                                                       |
| `GET /api/bluechip-ratings`                  | Bluechip safety ratings (keyed by Pharos ID)                                                                                                                                                                                   |
| `GET /api/dex-liquidity`                     | DEX liquidity scores, pool data, protocol/chain breakdowns, HHI, trends (keyed by Pharos ID)                                                                                                                                   |
| `GET /api/dex-liquidity-history`             | Per-coin historical liquidity data (`?stablecoin=ID&days=90`)                                                                                                                                                                  |
| `GET /api/chains`                            | Chain-level stablecoin aggregates with Chain Health Scores, computed on-the-fly from stablecoins + report-card caches                                                                                                          |
| `GET /api/supply-history`                    | Per-coin supply history (`?stablecoin=ID&days=N`)                                                                                                                                                                              |
| `GET /api/daily-digest`                      | AI-generated daily market summary (latest)                                                                                                                                                                                     |
| `GET /api/digest-archive`                    | All daily digests, newest-first                                                                                                                                                                                                |
| `GET /api/digest-snapshot`                   | Contextual data snapshot for a specific digest date (`?date=YYYY-MM-DD` or `YYYY-MM-DD-weekly`) for SSG builds                                                                                                                |
| `GET /api/health`                            | Worker health check (includes circuit breaker states)                                                                                                                                                                          |
| `GET /api/status`                            | Admin status dashboard (raw/effective status, causes, confidence, staleness, probes, timeline). Preferred access is `ops.pharos.watch/admin/` (browser) or `ops-api.pharos.watch/api/status` with Access service-token headers |
| `GET /api/status-history`                    | Admin machine-readable status timeline/probe history (`?limit=N`, max 200). Preferred access is `ops-api.pharos.watch/api/status-history` with Access service-token headers                                                    |
| `GET /api/stability-index`                   | Latest Pharos Stability Index sample plus daily history and component breakdowns (`?detail=true` for full history)                                                                                                            |
| `GET /api/og/*`                              | Dynamic Open Graph PNG images for stablecoin detail, safety scores, depeg, and PSI share cards                                                                                                                                 |
| `GET /api/report-cards`                      | Stablecoin risk grade cards with dimension scores (peg, liquidity, resilience, decentralization, dependency)                                                                                                                   |
| `GET /api/safety-score-history`              | Per-coin Safety Score grade transition history (`?stablecoin=ID&days=N`)                                                                                                                                                       |
| `GET /api/yield-rankings`                    | Cache-backed yield rankings with live-hydrated Safety Scores and risk-adjusted metrics                                                                                                                                         |
| `GET /api/yield-history`                     | Per-coin historical yield data (`?stablecoin=ID&days=90`)                                                                                                                                                                      |
| `GET /api/mint-burn-flows`                   | Mint/burn flow data with gauge score, per-coin net-flow + pressure-shift signals, hourly timeseries (`?stablecoin=ID`, `?hours=N`)                                                                                             |
| `GET /api/mint-burn-events`                  | Individual mint/burn transfer events for a stablecoin (`?stablecoin=ID`, `?direction=`, `?chain=ethereum`, `?burnType=`, `?scope=all or counted`, `?minAmount=`, `?limit=N&offset=M`)                                       |
| `GET /api/stress-signals`                    | DEWS stress signal scores per coin (`?stablecoin=ID`, `?days=N`)                                                                                                                                                               |
| `POST /api/backfill-depegs`                  | Admin: backfill depeg events (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                                         |
| `POST /api/backfill-supply-history`          | Admin: backfill per-coin supply history (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                              |
| `POST /api/backfill-stability-index`         | Admin: backfill historical stability index scores (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                    |
| `POST /api/backfill-cg-prices`               | Admin: backfill CoinGecko historical prices into price_cache (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                         |
| `POST /api/backfill-mint-burn`               | Admin: controlled mint/burn ingestion backfill by `configKey` (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                        |
| `POST /api/reclassify-atomic-roundtrips`     | Admin: retroactively tag same-tx mint/burn noise as `flow_type='atomic_roundtrip'` (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                   |
| `POST /api/audit-depeg-history`              | Admin: audit depeg events against CoinGecko price data for false positive detection (GET supports `dry-run=true` only; preferred access: `ops-api.pharos.watch` + Access service-token headers)                                |
| `POST /api/trigger-digest`                   | Admin: force digest regeneration bypassing 1h dedup (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                  |
| `POST /api/reset-blacklist-sync`             | Admin: roll back blacklist sync state to re-scan missed events (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                       |
| `GET /api/backfill-dews`                     | Admin: DEWS backtest audit against historical depeg events (reports true-positive rate and lead time; preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                 |
| `POST /api/backfill-mint-burn-prices`        | Admin: backfill mint/burn event prices (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                               |
| `GET /api/debug-sync-state`                  | Admin: view blacklist sync state for all chains (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                      |
| `GET /api/discovery-candidates`              | Admin: list stablecoin coverage candidates surfaced by the Monday CoinGecko discovery scan plus quarter-hourly DefiLlama residual intake                                                                                      |
| `POST /api/discovery-candidates/:id/dismiss` | Admin: dismiss a discovery candidate from the status dashboard                                                                                                                                                                 |
| `POST /api/feedback`                         | Public: submit feedback (bug, data-correction, feature-request). Rate-limited, auto-verified                                                                                                                                   |
| `POST /api/telegram-webhook`                 | Telegram bot webhook (command handling, subscription management)                                                                                                                                                               |

## Telegram Subsystem Tables

| Table                             | Description                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- |
| `telegram_subscribers`            | Bot subscriber preferences (`chat_id`, alert type flags)                    |
| `telegram_subscriptions`          | Per-user coin subscriptions (`chat_id`, `stablecoin_id`)                    |
| `telegram_pending_disambiguation` | Ephemeral mid-conversation state for ticker disambiguation                  |
| `telegram_pending_alerts`         | Overflow subscriber-alert delivery queue drained by the 5-minute alert cron |

The subscription/disambiguation tables are created in `worker/migrations/0054_telegram_subscribers.sql`; the overflow queue is added by `worker/migrations/0060_telegram_pending_alerts.sql`. For the full bot flow, see [Telegram Alert Bot](./telegram-alerts.md).

## Telegram Alert Cron Job

| Job                        | Description                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-telegram-alerts` | Detects DEWS/depeg/safety/launch changes and fans out alerts to subscribers on the dedicated `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` trigger |

## File Tree Guide

Representative tree of architecture-significant files and directories. For an exhaustive inventory, use `rg --files src shared worker scripts data functions`.

```
src/                              # Next.js frontend (static export)
├── app/
│   ├── page.tsx                  # Homepage server shell: ItemList JSON-LD, desktop masthead, KPI summary, interactive dashboard client
│   ├── blacklist/                # Freeze & blacklist event tracker
│   │   ├── page.tsx
│   │   ├── layout.tsx
│   │   └── error.tsx
│   ├── cemetery/                 # Dead stablecoin graveyard
│   │   ├── page.tsx
│   │   └── error.tsx
│   ├── chains/                   # Chain analytics leaderboard (sortable by supply, Chain Health Score)
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── chains/[chain]/           # Per-chain profile (hero stats, health breakdown, composition treemap, stablecoin table)
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── compare/                  # Live compare tool root (noindex) + static comparison landing pages
│   │   ├── [slug]/page.tsx       # Static "A vs B" comparison landing pages
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── coverage/                 # Per-coin feature coverage matrix
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
│   │   ├── methodology-shared.tsx # Shared methodology page helpers, section metadata, and section-shell primitives
│   │   ├── methodology-sections.tsx # Composition root for the long-form methodology section groups
│   │   ├── sections/             # Grouped long-form methodology section modules (core + monitoring)
│   │   ├── changelog-page-utils.ts # Shared metadata + entry mapping helpers for methodology changelog routes
│   │   ├── changelog-route-factory.tsx # Config-driven wrapper factory for methodology changelog routes
│   │   ├── pricing-pipeline-changelog/page.tsx # Pricing pipeline methodology changelog
│   │   ├── scoring-changelog/page.tsx  # Safety Score methodology changelog
│   │   ├── depeg-changelog/page.tsx    # Depeg/DEWS methodology changelog
│   │   ├── liquidity-score-changelog/page.tsx # Liquidity score changelog
│   │   ├── stability-index-changelog/page.tsx # PSI methodology changelog
│   │   ├── blacklist-tracker-changelog/page.tsx # Blacklist tracker changelog
│   │   ├── mint-burn-flow-changelog/page.tsx # Mint/Burn flow changelog
│   │   ├── yield-changelog/page.tsx # Yield intelligence methodology changelog
│   │   └── chain-health-changelog/page.tsx # Chain Health Score methodology changelog
│   ├── portfolio/                # Portfolio stress testing & upstream exposure (noindex)
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── privacy/page.tsx          # Privacy policy
│   ├── safety-scores/            # Risk Lab: stablecoin safety grade cards with radar charts
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── start/                    # First-time-user orientation route ("Start Here")
│   │   └── page.tsx
│   ├── stability-index/          # Pharos Stability Index (ecosystem health)
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── upcoming/                 # Pre-launch stablecoin tracker
│   │   └── page.tsx
│   ├── stablecoin/[id]/          # Detail page orchestration: section composition + modal state
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── stablecoins/[peg]/        # Stablecoins filtered by peg currency
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── stablecoins/backing/[backing]/ # Static backing taxonomy landing pages
│   │   └── page.tsx
│   ├── stablecoins/governance/[governance]/ # Static governance taxonomy landing pages
│   │   └── page.tsx
│   ├── yield/                    # Yield intelligence leaderboard
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── telegram/                 # Telegram alerts + digest landing page
│   │   └── page.tsx
│   ├── about/                    # About / product overview
│   │   ├── page.tsx
│   │   └── error.tsx
│   ├── admin/                    # Access-gated operator admin panel (ops.pharos.watch only)
│   │   ├── page.tsx
│   │   ├── client.tsx
│   │   └── error.tsx
│   ├── status/                   # Public system-status shell (read-only, noindex)
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
│   │   ├── flows-section.tsx
│   │   ├── explore-next-section.tsx # Consolidated crawlable link hub for taxonomy, compare, and related-coin routes
│   │   ├── redemption-backstop-card.tsx
│   │   ├── safety-score-history-section.tsx
│   │   └── notices-and-summary-section.tsx
│   ├── header.tsx                # Top nav bar
│   ├── sidebar.tsx               # Sidebar navigation menu
│   ├── footer.tsx                # Site footer with data attribution
│   ├── providers.tsx             # TanStack Query + theme providers
│   ├── start-here-page.tsx       # Static onboarding/orientation page composition
│   ├── start-here-visit-marker.tsx # Client marker that retires the homepage Start Here callout after /start/ is visited
│   ├── command-palette.tsx       # ⌘K command palette for quick navigation
│   ├── scroll-to-top.tsx         # Scroll-to-top button
│   ├── homepage-client.tsx       # Homepage dashboard composition, section taxonomy framing, and first-session Start Here gating
│   ├── homepage-flow-overview.tsx # Homepage mint/burn snapshot block (FlowBrrrOverview wrapper)
│   ├── homepage-safety-overview.tsx # Homepage safety snapshot block (report-card distribution + largest coins)
│   ├── stablecoin-filtered-table.tsx # Shared hydrated table wrapper for peg/backing/governance landing pages
│   ├── stablecoin-taxonomy-page.tsx # Shared server-rendered taxonomy landing page shell
│   ├── stablecoin-table.tsx      # Sortable table with filters
│   ├── stablecoin-table-logic.ts # Stablecoin table filtering/sorting/export helpers
│   ├── liquidity-table-logic.ts  # Liquidity leaderboard sorting helpers
│   ├── flow-table-logic.ts       # Flow leaderboard sorting + badge helpers
│   ├── depeg-table-logic.ts      # Depeg tracker sorting + severity accent helpers
│   ├── blacklist-table-logic.ts  # Blacklist table sorting helpers
│   ├── yield-table-logic.ts      # Yield leaderboard sorting helpers
│   ├── stablecoin-table-column-visibility.tsx # Stablecoin table column picker UI
│   ├── status/                   # Status dashboard component decomposition
│   │   ├── page-primitives.tsx   # Status-page-only shell pieces (summary badge, section shell, notice rail, lane links)
│   │   ├── top-fold-copy.ts      # Status top-fold tone/copy config
│   │   ├── recommended-action-strip.tsx # Status hero intervention strip
│   │   ├── cron-metadata-summary.ts # Per-job cron metadata summarizer registry for cron-card
│   │   ├── cron-card.tsx         # Individual cron job health card
│   │   ├── status-banner.tsx     # Top-level status banner
│   │   ├── status-facts.tsx      # Status fact summaries
│   │   ├── format.ts             # Status-specific formatting helpers
│   │   ├── refresh-countdown.tsx # Auto-refresh countdown timer
│   │   ├── cache-freshness-table.tsx   # Cache key freshness matrix
│   │   ├── dataset-freshness-table.tsx # Dataset-level freshness table
│   │   ├── endpoint-health-grid.tsx    # Endpoint probe result grid
│   │   ├── data-quality-cards.tsx      # Data quality signal cards
│   │   ├── circuit-breaker-table.tsx   # Circuit breaker state table
│   │   ├── system-diagnostics.tsx      # System-level diagnostic panel
│   │   ├── admin-action-button.tsx     # Admin action trigger button
│   │   ├── admin-actions-panel.tsx     # Admin action shelf panel
│   │   ├── discovery-candidates.tsx    # Discovery candidate listing
│   │   ├── liquidity-health.tsx        # Liquidity sync health view
│   │   ├── price-source-health.tsx     # Price source health view
│   │   ├── reserve-sync-health.tsx     # Reserve sync health view
│   │   ├── mint-burn-reconciliation.tsx # Mint/burn reconciliation view
│   │   ├── telegram-bot-stats.tsx      # Telegram bot statistics
│   │   └── transition-timeline.tsx     # Status state transition timeline
│   ├── flow-brrr-overview.tsx    # Shared Bank Run Gauge + Minting Pressure overview shell
│   ├── flow-chart.tsx            # Mint/burn flow area chart (hourly timeseries)
│   ├── flow-table.tsx            # Per-coin flow table with pressure-shift states, volumes, and net flows
│   ├── flow-event-feed.tsx       # Live mint/burn event feed with filtering
│   ├── flow-summary-card.tsx     # Detail-page flow summary card with net-flow + pressure-shift signals
│   ├── filter-bar.tsx            # Homepage filter bar (classification dropdowns)
│   ├── kpi-bar.tsx               # Homepage KPI bar (total supply, dominance, etc.)
│   ├── category-stats.tsx        # Homepage market-structure cards (concentration, governance, collateral, peg mix)
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
│   ├── section-error-boundary.tsx # Section-level error boundary wrapper
│   ├── site-header.tsx           # Homepage desktop masthead with tracked-coin, peg, chain, and pipeline coverage pills
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
│   ├── longform-scrollspy-nav.tsx # Sticky scrollspy navigator shared by methodology, stablecoin detail, and status long-form pages
│   ├── methodology-changelog-page.tsx # Shared renderer for methodology changelog pages
│   ├── methodology-version-card.tsx # Shared changelog version card
│   ├── stale-data-banner.tsx     # Stale data warning banner
│   ├── breadcrumb-json-ld.tsx    # Structured data for breadcrumbs
│   ├── faq-section.tsx           # Shared FAQ renderer (accordion UI + optional FAQPage JSON-LD script)
│   ├── sortable-table-head.tsx   # Shared sortable table header
│   ├── data-table-shell.tsx      # Shared thin sortable-table shell (header rendering + optional pagination/top slot)
│   ├── interactive-table-row.tsx # Shared clickable/keyboard-accessible table row wrapper
│   ├── table-pagination.tsx      # Shared pagination component
│   ├── balance-bar.tsx           # Balance ratio visualization bar
│   ├── sort-icon.tsx             # Shared sort direction arrow icon
│   ├── time-range-buttons.tsx    # Shared time range pill toggle buttons
│   ├── yield-leaderboard.tsx     # Yield rankings sortable table with score breakdown
│   ├── yield-scatter-plot.tsx    # Yield vs risk scatter chart with quadrant labels
│   └── theme-toggle.tsx          # Dark/light mode toggle
├── hooks/
│   ├── use-stablecoins.ts        # GET /api/stablecoins + useSupplyHistory (`/api/supply-history`)
│   ├── use-chains.ts             # GET /api/chains → useChains() + useChainStablecoins()
│   ├── api-hooks.ts              # Consolidated low-friction GET hooks wired to shared API path builders, including stress-signal queries
│   ├── use-mint-burn-flows.ts    # GET /api/mint-burn-flows + GET /api/mint-burn-events
│   ├── use-logos.ts              # Static logos from data/logos.json
│   ├── use-blacklist-events.ts   # GET /api/blacklist
│   ├── use-depeg-events.ts       # GET /api/depeg-events
│   ├── use-endpoint-probes.ts    # Parallel endpoint probes; exports both admin-mode and public-only probe hooks, with admin probes switching to same-origin `/api/admin/*` on the ops host
│   ├── use-status.ts             # GET /api/status through the ops-host same-origin proxy
│   ├── use-status-dashboard-model.ts # Status dashboard polling orchestration + derived operator model (backed by src/lib/status/* helpers)
│   ├── use-coverage-matrix-model.ts # Coverage page query orchestration + derived row/snapshot model
│   ├── use-compare-selection.ts  # Compare page URL state, slot selection, and preset application (shared compare types live in src/lib/compare-types.ts)
│   ├── use-compare-data-model.ts # Compare page query wiring + derived chart/card/table models
│   ├── use-compare-share-actions.ts # Compare page share/download image actions + clipboard fallbacks
│   ├── use-sort.ts               # Generic useSort<K> hook (sort state, toggle, keyboard, aria)
│   ├── use-sorted-table-rows.ts  # Shared table sorting scaffold (useSort wiring + sorted row memo)
│   ├── use-table-pagination.ts   # Shared table pagination scaffold (effective page, ranges, prev/next handlers)
│   ├── use-sorted-paginated-table.ts # Shared table scaffold combining sorting + pagination state
│   ├── use-time-range-filter.ts  # Generic time range state + data filtering hook
│   ├── use-homepage-filters.ts   # Homepage filter state + URL sync
│   ├── use-start-here-callout.ts # Homepage-only first-session onboarding callout visibility + retirement
│   ├── use-prefetch-stablecoin.ts # Prefetch stablecoin detail on hover
│   ├── use-stablecoin-detail-view-model.ts # Stablecoin detail query wiring; delegates pure derivation to src/lib/stablecoin-detail-view-model.ts
│   ├── use-api-query.ts          # Generic typed fetch + polling helper wrapping TanStack Query, including shared admin-auth query helpers
│   ├── use-url-filters.ts        # Shared URL search param management (getParam, setParam, setParams, replaceParams)
│   ├── use-portfolio.ts          # Portfolio holdings state + browser persistence; delegates codec/analysis to src/lib/portfolio-*.ts
│   ├── use-preferences.ts        # User preference state (persistent settings)
│   ├── use-stress-test.ts        # Stress test state, computeStressedGrades invocation, impact calculation
│   └── use-status-history.ts     # GET /api/status-history through the ops-host same-origin proxy
└── lib/
    ├── admin-access.ts           # Ops-host detection + admin proxy/header path helpers
    ├── api.ts                    # API_BASE URL config + apiFetch<T>() typed fetch wrapper (`/api/admin/*` stays same-origin)
    ├── analytics.ts              # Analytics tracking (page views, events)
    ├── client-feature-page.tsx   # Narrow helper for repeated dynamic-client feature routes wrapped by FeaturePageShell
    ├── blacklist-helpers.ts      # Shared blacklist helpers: isGoldStablecoin() type guard, extractGoldPrices(), computeBlacklistStats()
    ├── bluechip.ts               # BluechipGrade order, report URL base (slug map moved to worker)
    ├── chart-colors.ts           # Shared CHART_PALETTE, CHART_BLUE/GREEN/RED, RECHARTS_TOOLTIP_STYLES for Recharts charts
    ├── chart-export.ts           # Chart export utilities (PNG download)
    ├── compare-config.ts         # Compare presets, color palette, and ID/symbol selection registry
    ├── compare-pages.ts          # Finite static comparison landing page registry + helpers
    ├── coverage-page-config.ts   # Coverage-page-only visual config (feature accents, filters, mobile preview, legend)
    ├── status-dashboard-model.ts # Status dashboard pure formatting and derived-data helpers
    ├── start-here-callout.ts     # Browser-persisted Start Here callout state helpers (first-session exposure + /start/ retirement)
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
    ├── json-ld.ts                # safeJsonLd() serializer escaping <, >, / for JSON-LD script injection safety
    ├── flow-intensity.ts         # Mint/burn pressure-shift display + compatibility helpers
    ├── mint-burn-timeframes.ts   # Mint/burn timeframe constants/utilities
    ├── nav-config.ts             # Navigation menu structure (sidebar links, sections)
    ├── page-metadata.ts          # Shared metadata builder + sentence-aware SEO description helpers
    ├── start-here-content.ts     # Curated onboarding copy + route mapping for the Start Here page
    ├── peg-landing.ts            # Peg currency landing page data helpers
    ├── peg-stability.ts          # Per-coin peg stability metrics
    ├── severity-colors.ts        # Deviation severity color mapping (threshold-based: green/amber/orange/red)
    ├── stablecoin-taxonomy.ts    # Governance/backing taxonomy registry + route helpers
    ├── stablecoin-detail-derive.ts # Pure stablecoin detail derivations (supply/deviation/90d reference/border classes)
    └── utils.ts                  # cn() helper for Tailwind class merging

functions/                        # Cloudflare Pages Functions for operator-host gating and admin proxying
├── admin/[[path]].ts             # Host gate for /admin/; serves on ops host, hard-404s elsewhere
├── api/admin/[[path]].ts         # Catch-all proxy for ops-only admin routes (`/api/admin/*` -> `ops-api`)
└── lib/ops-origin.ts             # Shared ops-origin resolution helper

shared/                           # Runtime-neutral boundary (import via `@shared/*`)
├── types/
│   ├── index.ts                  # Stable barrel export for shared contracts
│   ├── core.ts                   # Shared enums, metadata shapes, and common Zod schemas
│   ├── digest.ts                 # Daily digest / archive / snapshot contracts
│   ├── market.ts                 # Stablecoin list, liquidity, depeg, blacklist, and stress-signal contracts
│   ├── report-cards.ts           # Safety-score history + report-card response contracts
│   ├── redemption.ts             # Redemption backstop response contracts
│   ├── stability.ts              # Stability Index response contracts
│   ├── status.ts                 # Status / health / discovery / reconciliation contracts
│   ├── yield.ts                  # Yield rankings/history contracts
│   ├── mint-burn.ts              # Mint/burn flow, event, and sync contracts
│   └── chains.ts                 # ChainSummary, ChainsResponse, ChainHealthFactors, HealthBand
└── lib/
    ├── api-endpoints.ts          # Authoritative endpoint metadata + static worker dependency hints + status/smoke/strict-contract helpers
    ├── chain-aggregator.ts       # aggregateChains() — builds ChainSummary list from stablecoins cache + report-card snapshot
    ├── chain-health.ts           # Pure Chain Health Score computation (quality 30%, chain environment 20%, concentration 20%, peg stability 20%, backing diversity 10%)
    ├── chain-provider-registry.ts # Runtime-neutral CoinGecko/DexScreener/GeckoTerminal chain slug registry
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
├── migrations/                   # D1 SQL migration files (83) plus MANIFEST.md
└── src/
    ├── index.ts                  # Thin worker composition: delegates fetch/scheduled to handler modules
    ├── route-registry.ts         # Static route binding registry keyed by shared endpoint metadata + dependency descriptors
    ├── handlers/
    │   ├── http.ts               # HTTP orchestration: preflight, gates, edge cache, route-context build, router dispatch
    │   ├── http/                 # Focused HTTP helper modules
    │   │   ├── cors.ts           # Origin resolution + preflight / response header helpers
    │   │   ├── gates.ts          # Maintenance mode, public API rate limit, env warnings
    │   │   ├── edge-cache.ts     # Edge cache match / store policy
    │   │   └── context.ts        # Route dependency hydration from Env
    │   ├── scheduled.ts          # Thin cron entrypoint: init env-aware clients + dispatch to slot runner registry
    │   └── scheduled/            # Slot runners + shared lease/runtime context for scheduled execution
    ├── router.ts                 # Thin worker route dispatcher: shared method validation, static registry lookup, dynamic route matching
    ├── cron/
    │   ├── sync-stablecoins.ts   # DefiLlama + CoinGecko gold → D1 (orchestrator with explicit stage boundaries)
    │   ├── sync-stablecoins/
    │   │   ├── intake.ts         # Intake/fallback gate: DL fetch, structural validation, canonical remap, supplemental merge
    │   │   ├── stages.ts         # Extracted sync-stablecoins stage helpers (normalize/filter/staleness/supply-history fill)
    │   │   ├── post-enrichment.ts # Shared post-enrichment cache validation + depeg pipeline helpers
    │   │   ├── metadata.ts       # Final sync metadata and price-source health shaping
    │   │   ├── shared.ts         # Shared stablecoins-sync cache/write helpers and FX utilities
    │   │   └── supplemental-assets.ts # Extracted supplemental token fetch helpers (gold/silver/CG-only fiat overlays)
    │   ├── enrich-prices.ts      # Dual-primary price validation + 4-pass enrichment pipeline (DefiLlama, CoinGecko, CoinMarketCap, DexScreener)
    │   ├── enrich-prices-shared.ts # Leaf shared price-enrichment types/helpers used across the enrichment pipeline
    │   ├── detect-depegs.ts      # Depeg event detection + orphan event cleanup
    │   ├── sync-stablecoin-charts.ts  # Historical chart cache refresh (30-min trigger, 1h write cooldown)
    │   ├── snapshot-supply.ts    # Per-coin supply snapshots → D1 (runs on */15, writes once daily via dedup guard; primary daily run at 8AM UTC)
    │   ├── snapshot-chain-supply.ts # Daily chain-level supply snapshots → chain_supply_history (quarter-hourly slot, DB-only)
    │   ├── snapshot-safety-grade-history.ts # Daily Safety Score grade transition snapshot → D1
    │   ├── sync-live-reserves.ts # Live reserve composition sync → D1 (hourly, reserve lane)
    │   ├── reserve-adapters/    # Per-protocol live reserve adapters (29 adapters)
    │   │   ├── index.ts         # Adapter registry + dispatch
    │   │   ├── types.ts         # Leaf adapter context/result types consumed by adapters without importing the registry barrel
    │   │   └── ...              # Individual adapters (accountable, tether, circle-transparency, gho, etc.)
    │   ├── sync-redemption-backstops.ts # Redemption backstop + effective-exit snapshot sync → D1 (hourly, reserve lane)
    │   ├── sync-blacklist.ts     # Etherscan/TronGrid/dRPC → D1 (incremental)
    │   ├── sync-usds-status.ts   # USDS protocol status → D1 (daily, 8AM UTC)
    │   ├── sync-fx-rates.ts      # ECB + gold-api.com → D1 FX/commodity rates (15min, metals per-run)
    │   ├── sync-bluechip.ts      # Bluechip safety ratings → D1 (daily, 08:05 UTC)
    │   ├── dex-discovery/        # Independent 30-min staged-pool discovery pipeline
    │   │   ├── index.ts          # Barrel export
    │   │   ├── types.ts          # Discovery tiers, staged-pool rows, confidence defaults
    │   │   ├── crawl-sources.ts  # Chain-aware CG Onchain/GT/DexScreener/tickers pool crawl
    │   │   ├── persistence.ts    # Staging-table upserts, run-seq meta, cleanup
    │   │   └── orchestrator.ts   # syncDexDiscovery() main function
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
    │   ├── stability-index.ts    # Composite ecosystem health score → D1 (every 30 min, after compute-dews on the half-hourly lane)
    │   ├── snapshot-psi.ts       # Daily PSI snapshot → D1 (daily, 8AM UTC)
    │   ├── confirm-pending-depegs.ts # Secondary depeg confirmation for major coins (>$1B)
    │   ├── daily-digest.ts       # AI-generated daily market summary via Claude API (daily, 08:05 UTC)
    │   ├── weekly-recap.ts      # AI-generated weekly market recap via Claude API (Mondays, 08:05 UTC)
    │   ├── discovery-scan.ts     # Weekly stablecoin coverage discovery → D1 (Mondays, 08:05 UTC)
    │   ├── compute-dews.ts       # DEWS computation cron (every 30 min, after sync-dex-liquidity)
    │   ├── dispatch-telegram-alerts.ts # Subscriber alert fan-out for DEWS/depeg/safety shifts plus launch promotions (dedicated every-5-minute trigger)
    │   ├── yield-config.ts       # Yield source configs: pool UUIDs, source types, scoring params
    │   ├── yield-helpers.ts      # Pure yield computation helpers: Pharos Yield Score, excess yield, stability
    │   ├── fetch-tbill-rate.ts   # T-bill proxy fetcher (FRED DGS3MO)
    │   ├── sync-yield-data.ts    # Yield data sync orchestration: source load + resolution + persistence/cache stages
    │   ├── yield-sync/           # Yield sync stage modules (source loading, resolution, evaluation, publication, history)
    │   ├── sync-mint-burn.ts     # On-chain mint/burn event sync via Alchemy JSON-RPC (critical + extended 20min lanes)
    │   └── status-self-check.ts  # Status reliability cron: real HTTP probes, hysteresis persistence, discrepancy/probe-failure alerts
    ├── api/
    │   ├── cache-handlers.ts     # Cache-backed handlers: stablecoins, stablecoin-charts, bluechip-ratings, usds-status, yield-rankings
    │   ├── stablecoin-detail.ts  # GET /api/stablecoin/:id (orchestrator + branch routing)
    │   ├── stablecoin-summary.ts # GET /api/stablecoin-summary/:id (lightweight per-coin snapshot)
    │   ├── stablecoin-reserves.ts # GET /api/stablecoin-reserves/:id (live reserve composition + fallback modes)
    │   ├── redemption-backstops.ts # GET /api/redemption-backstops (current redemption / effective-exit dataset)
    │   ├── stablecoin-detail/    # Stablecoin detail handler internals (focused modules)
    │   │   ├── shared.ts         # Shared cache/logging/response helpers + supply_history fallback
    │   │   ├── commodity.ts      # Commodity token upstream assembly (DL + CG fallback)
    │   │   ├── coingecko-only.ts # CoinGecko-only token branch assembly
    │   │   └── defillama.ts      # DefiLlama detail normalization (non-USD USD-conversion)
    │   ├── chains.ts             # GET /api/chains
    │   ├── supply-history.ts     # GET /api/supply-history
    │   ├── blacklist.ts          # GET /api/blacklist
    │   ├── depeg-events.ts       # GET /api/depeg-events
    │   ├── peg-summary.ts        # GET /api/peg-summary
    │   ├── daily-digest.ts       # GET /api/daily-digest
    │   ├── digest-archive.ts    # GET /api/digest-archive
    │   ├── digest-snapshot.ts   # GET /api/digest-snapshot
    │   ├── dex-liquidity.ts      # GET /api/dex-liquidity (includes HHI, trends)
    │   ├── dex-liquidity-history.ts # GET /api/dex-liquidity-history
    │   ├── health.ts             # GET /api/health
    │   ├── status.ts             # GET /api/status (admin; raw synthesis lives in worker/src/lib/status-evaluation.ts)
    │   ├── status-history.ts     # GET /api/status-history (admin)
    │   ├── stability-index.ts    # GET /api/stability-index
    │   ├── og.tsx                # GET /api/og/* dynamic Open Graph PNG generation
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
    │   ├── reclassify-atomic-roundtrips.ts # POST /api/reclassify-atomic-roundtrips (admin)
    │   ├── stress-signals.ts    # GET /api/stress-signals (DEWS scores)
    │   ├── discovery.ts         # GET /api/discovery-candidates + POST /api/discovery-candidates/:id/dismiss
    │   ├── yield-history.ts     # GET /api/yield-history
    │   ├── mint-burn-flows.ts    # GET /api/mint-burn-flows (route-level aggregate/per-coin orchestration)
    │   ├── mint-burn-flows-shared.ts # Shared mint/burn cache, baseline, and coverage helpers
    │   ├── mint-burn-events.ts   # GET /api/mint-burn-events (paginated event log)
    │   ├── feedback.ts          # POST /api/feedback (public coordinator)
    │   ├── feedback/            # Feedback endpoint internals + durable submission ledger helpers
    │   │   ├── request.ts       # JSON parsing, validation, rate-limit/env policy
    │   │   ├── verification.ts  # Auto-verification snapshots for data corrections
    │   │   ├── submission.ts    # GitHub routing orchestration
    │   │   ├── github.ts        # GitHub REST helper
    │   │   ├── format.ts        # Issue payload formatting
    │   │   └── types.ts         # Shared feedback types and constants
    │   ├── telegram-webhook.ts  # POST /api/telegram-webhook (Telegram bot command ingress coordinator)
    │   ├── telegram-webhook-shared.ts # Telegram webhook shared constants/types/catalog
    │   ├── telegram-webhook-parsing.ts # Telegram webhook command / pending-state parsing helpers
    │   ├── telegram-webhook-messages.ts # Telegram webhook response formatting helpers
    │   └── telegram-webhook-store.ts # Telegram webhook D1 persistence helpers
    └── lib/
        ├── db.ts                 # D1 read/write helpers (setCacheIfNewer CAS guard, batchExecute, buildPaginatedQuery, buildInClause, logCronRun with protected catch)
        ├── chain-registry.ts     # Worker RPC registry and provider-map re-exports; runtime-neutral provider slugs now live in shared/lib/chain-provider-registry.ts
        ├── dex-api-types.ts      # Leaf Dex API pool/token type contracts shared across liquidity modules
        ├── evm-rpc.ts            # EVM JSON-RPC + Etherscan proxy helpers (eth_call, storage, uint256, block headers, timestamp→block search)
        ├── circuit-breaker.ts    # Per-source circuit breaker (3-strike open, 30-min probe, auto-alert on transitions)
        ├── constants.ts          # Shared worker constants (DEPEG_THRESHOLD_BPS, DEX_FRESHNESS_SEC, D1_BATCH_SIZE, MIN_VALID_ASSET_COUNT, CACHE_PROFILES, CIRCUIT_SOURCE)
        ├── auth.ts               # Admin auth helpers for ops-api Cloudflare Access JWT verification + trusted internal admin lane checks
        ├── env.ts                # Worker Env typing + CSV env parsing helper for disable/override lists
        ├── alerts.ts             # Alert sending (Discord/Slack webhook notifications on cron failures)
        ├── stablecoins-cache.ts  # Shared strict/lenient loader for canonical stablecoins cache payload
        ├── safety-scores.ts      # Shared safety score snapshot helper (yield + digest consumers)
        ├── report-cards-snapshot.ts # Shared report-card snapshot builder (API + safety-grade-history cron)
        ├── redemption-backstops-store.ts # D1 helpers for current + daily redemption-backstop snapshots
        ├── redemption-backstop-sources.ts # Redeemability capacity-source resolution + scoring inputs
        ├── peg-analytics.ts      # Shared peg analytics snapshot helper (peg-summary + report-cards consumers)
        ├── mint-burn-health-config.ts # Shared mint/burn stale thresholds + major symbol defaults
        ├── bigint.ts             # bigIntToDecimal() helper for safe BigInt-to-number conversion (used by blacklist sync)
        ├── binary-search.ts      # Generic binarySearchNearest<T>() for sorted array lookups
        ├── blacklist-contracts.ts # Blacklist event configs resolved from shared stablecoin contract metadata + CHAIN_META
        ├── bluechip-slugs.ts     # BLUECHIP_SLUG_MAP (worker-only, split from src/lib/bluechip.ts)
        ├── depeg-helpers.ts      # Shared depeg helpers: row mapper, DEX price loader, and event insert statement builder
        ├── dews.ts               # DEWS computation: 8 sub-signals, weighted average, threat bands
        ├── authoritative-price-sources.ts # Shared authoritative live/historical price provider registry for protocol-backed assets

        ├── evm-logs.ts           # EVM log filtering & parsing (Etherscan event decoding)
        ├── coingecko.ts          # CoinGecko API key initialization (shared across crons)
        ├── coingecko-onchain.ts  # CoinGecko Onchain API client (registry-backed network mapping, pool discovery, locked liquidity)
        ├── twitter.ts            # Twitter/X API client for daily digest posting
        ├── stability-index.ts    # Stability index computation helpers
        ├── backfill-query.ts     # Shared admin backfill query parsing/selection helpers (stablecoin/batch/batchSize)
        ├── api-utils.ts          # withErrorHandler(), CacheStatus (from shared types), buildCacheStatuses()
        ├── status-reliability.ts # Status hysteresis, transitions, probe/discrepancy persistence
        ├── status/               # Shared status data-quality + derived loader modules used by /api/status
        │   ├── data-quality.ts   # Stablecoins cache / blacklist gap / active-depeg / on-chain-supply quality aggregation
        │   └── derived-data.ts   # Dataset freshness, Telegram stats, and mint/burn reconciliation loaders
        ├── mint-burn-contracts.ts # Mint/burn event configs resolved from shared stablecoin contract metadata, plus explicit vault overrides
        ├── mint-burn-scoring.ts  # Flow Intensity Score (FIS), Bank Run Gauge, flight-to-quality detection
        ├── mint-burn-pipeline/   # Shared ingestion helpers used by cron + admin backfill paths
        │   ├── types.ts          # Shared row/context/counter + sync-state mode types
        │   ├── parse.ts          # parseMintBurnLogs() + event price resolution
        │   ├── classification.ts # Bridge-aware burn classification + tx-context loader
        │   ├── context.ts        # Shared current + historical price context loading
        │   ├── roundtrip-detection.ts # Same-tx mint+burn tagging for flow_type=atomic_roundtrip
        │   ├── persistence.ts    # Event insert, burn update, affected-hour recompute helpers
        │   ├── price-heal.ts     # Auto-heal recent NULL amount_usd rows from price_cache
        │   └── sync-state.ts     # Sync-state read/init/upsert helpers (replace vs monotonic-max)
        ├── fetch-retry.ts        # Fetch with retry + exponential backoff, default 15s timeout (configurable 404 handling)
        ├── dexscreener.ts        # DexScreener API client (token price + pool search)
        ├── resolve-market-cap.ts # Multi-source market cap resolution (DL → CG → CMC → DexScreener)
        ├── telegram-alerts.ts    # Telegram alert subscription parsing, filtering, and message formatting helpers
        ├── telegram-digest-appendices.ts # Pending cemetery / tracking notices appended to the next Telegram daily digest
        └── telegram.ts           # Telegram Bot API client for digest delivery and direct bot chat replies

data/
├── logos.json                    # Static stablecoin logo URLs (from CoinGecko)
├── ai-summaries.json             # Cached AI-generated editorial summaries
└── digests.json                  # Digest archive data
```

## Frontend Runtime And SEO Surface

- Indexable route families:
  - `/`
  - `/stablecoin/[id]/`
  - `/stablecoins/[peg]/`
  - `/stablecoins/governance/[governance]/`
  - `/stablecoins/backing/[backing]/`
  - `/compare/[slug]/`
  - `/digest/` and `/digest/[date]/`
  - major feature pages with standalone static copy (`/start/`, `/upcoming/`, `/blacklist/`, `/depeg/`, `/liquidity/`, `/safety-scores/`, `/stability-index/`, `/yield/`, `/flows/`, `/dependency-map/`, `/cemetery/`, `/telegram/`, `/about/`, `/methodology/`)
- Tool roots intentionally marked `noindex,follow`:
  - `/compare/`
  - `/portfolio/`
- Private operator routes marked `noindex,nofollow`:
  - `/status/`
  - `/admin/`
- Crawlable server-rendered link hubs now live on the digest archive, safety scores, liquidity, taxonomy landing pages, and stablecoin detail pages. These hubs are part of the static export and are what `npm run seo:check` validates for orphan routes, sitemap coverage, and click depth.

### Runtime host and env rules

- `src/lib/api.ts` is the frontend runtime source of truth for API origin selection.
- `NEXT_PUBLIC_API_BASE` is an optional explicit override, mainly for local `next dev` against `wrangler dev`.
- When `NEXT_PUBLIC_API_BASE` is unset, `resolveApiBase()` routes `*.pharos.watch` and `*.stablecoin-dashboard.pages.dev` to `https://api.pharos.watch`; other hosts fall back to same-origin requests so local proxy and smoke setups still work.
- `NEXT_PUBLIC_GA_ID` gates GA4 script injection in `src/app/layout.tsx`. When it is unset, the site still renders normally and no browser analytics events are emitted from `src/lib/analytics.ts`.

### Metadata and crawl ownership

- `src/lib/page-metadata.ts` is the shared helper for per-route canonical metadata, Open Graph images, Twitter cards, and sentence-aware description trimming.
- `src/app/layout.tsx` owns the sitewide metadata baseline, icons, `api.pharos.watch` preconnect, and root JSON-LD (`WebSite`, `Organization`, `WebApplication`, `SearchAction`).
- `src/app/sitemap.ts` owns indexable-route sitemap output and the `LAST_EDITED` map for static long-lived pages. Update `LAST_EDITED` when changing those routes' durable copy or methodology changelog pages so `lastModified` stays honest.
- `src/app/robots.ts` publishes the global crawl policy (`allow: /`) and the sitemap location.

---

## TypeScript Target Constraints

Root tsconfig targets ES2017 (for browser compatibility via Next.js). Worker tsconfig targets ES2021 (Cloudflare Workers runtime). Shared modules in `shared/lib/` MUST be ES2017-compatible as they compile under both targets — avoid `??=`, `||=`, `Array.at()`, and other post-ES2017 features in shared code.
