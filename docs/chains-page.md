# Chains Page

Contract for the public chain analytics surfaces:

- `/chains/` leaderboard
- `/chains/[chain]/` per-chain profile
- Chain Health Score methodology linkage shown on the leaderboard shell

---

## Route Shape

- **Leaderboard shell:** `src/app/chains/page.tsx`
- **Leaderboard client:** `src/app/chains/client.tsx`
- **Profile shell:** `src/app/chains/[chain]/page.tsx`
- **Profile client:** `src/app/chains/[chain]/client.tsx`
- **Data hook:** `src/hooks/use-chains.ts`
- **Profile coordination hook:** `src/hooks/use-chain-profile-data.ts`
- **Primary API:** `GET /api/chains`
- **Methodology version source:** `shared/lib/methodology-versions/chain-health.ts` (compatibility re-export: `shared/lib/chains/health-version.ts`)
- **Scoring implementation:** `shared/lib/chain-health.ts`, `shared/lib/chain-aggregator.ts`, `shared/lib/chains/index.ts`
- **Shared chain UI helpers:** `src/lib/chain-ui.ts` (formatting + health band color maps)
- **Active chain derivation:** `getActiveChainIds()` in `shared/lib/chains/index.ts`

The leaderboard is public and indexable. The profile routes are statically generated from `getActiveChainIds()`, which currently returns the sorted `CHAIN_META` key set.

`CHAIN_META` membership is not only a display concern. `resolveChainId()` is what turns a raw DefiLlama supply label into a canonical chain identity, so an unregistered label is pooled into the Safety Score V9 uncanonicalized-chain-label row (`safety-score-v9-extension-supply.ts`). Above the common-mode materiality floor that pool fails closed into `unresolved-control-identity`, no matter how well the asset's other deployments are reviewed. Registering a chain is therefore the precondition for attributing its supply — it names the chain, but a reviewed `bridgeRouteRisk` route for that chain is still what clears the residual.

---

## `/chains/` Contract

`src/app/chains/page.tsx` renders a `FeaturePageShell` with:

- breadcrumb + canonical path `/chains/`
- methodology pill wired from `CHAIN_HEALTH_METHODOLOGY_VERSION` and `CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH`
- lead copy describing chain ranking by stablecoin supply and health
- `CollectionPage` + `ItemList` JSON-LD over every crawlable `/chains/[chain]/` profile route, with each item typed as `WebPage`
- FAQ structured data from the route-local `CHAINS_FAQ_JSON_LD`
- a visible `ChainDirectory` section after the FAQ, listing every generated `/chains/[chain]/` profile route

`src/app/chains/client.tsx` consumes `useChains()` plus `useStablecoins()` and renders:

- hero summary: total tracked stablecoin supply (the frost-blue "One Beam" figure, `.pharos-numeric text-frost-blue`), optional global 7d trend, chain count, and a top-chain dominance breakdown bar/legend. The page keeps its existing sequential bands rather than the shared `FeatureHeroSplit`, and intentionally retains the frost-tinted "Top N chains hold X%" concentration badge
- explicit `Unattributed` residual in the dominance breakdown when the stablecoins cache has supply that DefiLlama does not attribute to a concrete chain
- `NauticalChart`, fed by the chain snapshot plus `stablecoinsQuery.data?.peggedAssets` so the visual can attach top-stablecoin cargo/logos to each chain; the route-level harbor summary plates (`Largest port`, `Avg health`, `Fragile ports`, and health bands) render before the SVG so the chart can finish with the map itself
- `SelectedHarborPanel`, synchronized from the harbor chart and leaderboard hover/focus, showing the selected chain's exact supply, tracked share, health band, stablecoin count, dominant cargo, top cargo marks, and 7-day wake directly after the harbor map; the panel reads existing chain snapshot fields and does not change Chain Health semantics
- sortable leaderboard table rendered through `DataTableShell`
- `QueryFreshnessNotices` (preset `"chains"`, which wraps the stale-data banner) plus `QueryErrorNotice` with retry in the no-data error state
- skeleton loading states (KPI grid + table rows)
- row click and keyboard navigation into `/chains/[chain]/`
- chain logos apply `dark:invert` when `CHAIN_META[id].darkInvert` is set

Current sortable columns are:

- `Health`
- `Supply`
- `7d`
- `Global Share`
- `Stablecoins`

The `Dominant` column is a non-sortable `lg+` context column showing the largest stablecoin on each chain.

Default sort is `totalUsd desc`.

---

## `/chains/[chain]/` Contract

`src/app/chains/[chain]/page.tsx`:

- rejects unknown chain IDs with `notFound()`
- statically generates params from `getActiveChainIds()` / the current `CHAIN_META` key set
- sets canonical metadata at `/chains/[chain]/`
- builds the title/description from the mapped deployment count and leading ticker symbols when they fit the search-snippet title budget
- emits `CollectionPage` + `ItemList` JSON-LD for tracked deployments, with chain/deployment entities typed as `Thing` and no `Product` markup
- renders the live client first, then a compact server-rendered deployment anchor hub linking each tracked stablecoin on the chain to its `/stablecoin/[id]/` page, followed by related taxonomy and research route hubs

`src/app/chains/[chain]/client.tsx` uses `useChainProfileData(chainId)` and renders, in order:

1. `QueryErrorNotice` (inline banner when error + stale data)
2. `StaleDataBanner` when coordinated chain/stablecoin snapshots are stale or mismatched
3. hero card (`ChainHero`) with supply, global share, 24h/7d/30d change (all with dark-mode colors via `trendColor()`), health badge, `dark:invert` logo support, and the embedded Chain Health breakdown (the `HealthZone` factor grid) whose weight labels derive dynamically from exported constants in `chain-health.ts`
4. `ShowYourWorkPanel` rendered immediately below the hero card, exposing the factor math
5. stablecoin composition treemap — rendered only when the chain summary snapshot and stablecoins snapshot match exactly; adaptive 2/3/4-column layout with 1-3 rows, optional `Others` aggregation when the chain has more coins than display cells, and dominant span only when a coin exceeds 35% share in a 3+ column layout
6. backing-type breakdown — rendered only when the route is on a coordinated snapshot; unclassified coins shown as "Other" (zinc-colored) bucket; filter buttons update the stablecoin table by backing type
7. full stablecoin table with a screen-reader-only `<caption>` — rendered only when the route is on a coordinated snapshot
8. skeleton loading states (hero + health + composition blocks)

`useChainProfileData()` coordinates `GET /api/chains` and `GET /api/stablecoins` for the route. It renders the summary chain card as soon as the chain snapshot exists, but it keeps the composition/backing/table sections hidden until both snapshots share the same `updatedAt` value and the stablecoins snapshot has authoritative freshness metadata. The route surfaces explicit notices for the three non-happy states: missing detailed stablecoin data, mismatched snapshots, and missing freshness metadata.

`useChainStablecoins()` derives profile rows from `/api/stablecoins`, not `/api/chains`, by summing every `chainCirculating` entry that resolves to the selected canonical chain ID.

---

## Chain Health Score

The route displays the Chain Health composite and its factor detail from `GET /api/chains`. Formula, factors, weights, coverage gates, evidence precedence, bands, and current methodology version are owned by [chain-health.md](./chain-health.md) and `shared/lib/chain-health.ts`. Do not duplicate those volatile values here.

The page contract is limited to presentation: the leaderboard exposes the composite for comparison, and chain profiles show factor/evidence detail when the coordinated API snapshot provides it.

---

## API And Freshness

`useChains()` reads `GET /api/chains` with the standard 15-minute cron-aligned query preset and the endpoint's 1800-second freshness budget.

`GET /api/chains` returns body `_meta` freshness metadata plus HTTP freshness headers. When its supporting caches lag, the body `_meta.status` degrades instead of silently appearing fresh. `_meta.dependencies.reportCards` also tells the route whether a missing Chain Health score is due to stale/unavailable report-card inputs versus genuine score-coverage gaps.

`worker/src/api/chains.ts`:

- loads the strict stablecoins cache
- derives non-USD peg references from `fxFallbackRates`
- hydrates safety scores from the report-card cache when available
- computes the response via `aggregateChains(...)`
- computes `globalTotalUsd` from all tracked circulating supply, while preserving `chainAttributedTotalUsd` and `unattributedTotalUsd` for chain-specific residuals
- overwrites `updatedAt` with the stablecoins-cache timestamp
- applies freshness headers with `X-Data-Age`, exposes report-card dependency freshness in `_meta.dependencies.reportCards`, and downgrades `Cache-Control` to `no-store` when the chain snapshot or health dependency is degraded
- preserves the detailed-chain data gate in the route client by exposing freshness metadata for `useChainProfileData()`

If the stablecoins cache is unavailable or structurally invalid, the endpoint returns `503`.

---

## Update Rules

Update this file when any of the following change:

- Chain Health weights, factors, resilience tiers, or bands
- `/chains/` leaderboard columns or default sort
- `/chains/[chain]/` section order or data sourcing
- `generateStaticParams()` source of truth for chain routes
- `GET /api/chains` response fields or freshness behavior
- Health band colors in `src/lib/chain-ui.ts`

Related docs to update in the same change:

- [api-reference.md](./api-reference.md)
- [architecture.md](./architecture.md)
- [methodology-page.md](./methodology-page.md)

If the methodology version changes, also update `shared/lib/methodology-versions/chain-health.ts`, the matching entry under `shared/data/methodology-changelogs/chain-health/`, and the public methodology explanation when needed. The changelog route renders from that structured source.
