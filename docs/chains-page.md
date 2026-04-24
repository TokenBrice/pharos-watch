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
- **Methodology version source:** `shared/lib/chain-health-version.ts`
- **Scoring implementation:** `shared/lib/chain-health.ts`, `shared/lib/chain-aggregator.ts`, `shared/lib/chains.ts`
- **Shared chain UI helpers:** `src/lib/chain-ui.ts` (formatting + health band color maps)
- **Active chain derivation:** `getActiveChainIds()` in `shared/lib/chains.ts`

The leaderboard is public and indexable. The profile routes are statically generated from `getActiveChainIds()`, which currently returns the sorted `CHAIN_META` key set.

---

## `/chains/` Contract

`src/app/chains/page.tsx` renders a `FeaturePageShell` with:

- breadcrumb + canonical path `/chains/`
- status badge `mature`
- methodology pill wired from `CHAIN_HEALTH_METHODOLOGY_VERSION` and `CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH`
- lead copy describing chain ranking by stablecoin supply and health
- FAQ structured data from the route-local `CHAINS_FAQ_JSON_LD`
- a hidden SEO nav listing every generated `/chains/[chain]/` route

`src/app/chains/client.tsx` consumes `useChains()` plus `useStablecoins()` and renders:

- hero summary: total tracked stablecoin supply, optional global 7d trend, chain count, and a top-chain dominance breakdown bar/legend
- explicit `Unattributed` residual in the dominance breakdown when the stablecoins cache has supply that DefiLlama does not attribute to a concrete chain
- `NauticalChart`, fed by the chain snapshot plus `stablecoinsQuery.data?.peggedAssets` so the visual can attach top-stablecoin cargo/logos to each chain
- sortable leaderboard table rendered through `DataTableShell`
- `QueryErrorNotice` with retry and `StaleDataBanner` (preset `"chains"`)
- skeleton loading states (KPI grid + table rows)
- row click and keyboard navigation into `/chains/[chain]/`
- chain logos apply `dark:invert` when `CHAIN_META[id].darkInvert` is set

Current sortable columns are:

- `Health`
- `Supply`
- `7d`
- `Global Share`
- `Stablecoins`

Default sort is `totalUsd desc`.

---

## `/chains/[chain]/` Contract

`src/app/chains/[chain]/page.tsx`:

- rejects unknown chain IDs with `notFound()`
- statically generates params from `getActiveChainIds()` / the current `CHAIN_META` key set
- sets canonical metadata at `/chains/[chain]/`

`src/app/chains/[chain]/client.tsx` uses `useChainProfileData(chainId)` and renders, in order:

1. `QueryErrorNotice` (inline banner when error + stale data)
2. `StaleDataBanner` when coordinated chain/stablecoin snapshots are stale or mismatched
3. hero card with supply, global share, 24h/7d/30d change (all with dark-mode colors via `trendColor()`), health badge, and `dark:invert` logo support
4. Chain Health breakdown card — weight labels derived dynamically from exported constants in `chain-health.ts`
5. stablecoin composition treemap — rendered only when the chain summary snapshot and stablecoins snapshot match exactly; adaptive 2/3/4-column layout with 1-3 rows, optional `Others` aggregation when the chain has more coins than display cells, and dominant span only when a coin exceeds 35% share in a 3+ column layout
6. backing-type breakdown — rendered only when the route is on a coordinated snapshot; unclassified coins shown as "Other" (zinc-colored) bucket; filter buttons update the stablecoin table by backing type
7. full stablecoin table with a screen-reader-only `<caption>` — rendered only when the route is on a coordinated snapshot
8. skeleton loading states (hero + health + composition blocks)

`useChainProfileData()` coordinates `GET /api/chains` and `GET /api/stablecoins` for the route. It renders the summary chain card as soon as the chain snapshot exists, but it keeps the composition/backing/table sections hidden until both snapshots share the same `updatedAt` value and the stablecoins snapshot has authoritative freshness metadata. The route surfaces explicit notices for the three non-happy states: missing detailed stablecoin data, mismatched snapshots, and missing freshness metadata.

`useChainStablecoins()` derives profile rows from `/api/stablecoins`, not `/api/chains`, by summing every `chainCirculating` entry that resolves to the selected canonical chain ID.

---

## Chain Health Score

Current live methodology version is `1.2`.

`shared/lib/chain-health.ts` computes the composite as:

```text
0.30 × quality
+ 0.20 × chainEnvironment
+ 0.20 × concentration
+ 0.20 × pegStability
+ 0.10 × backingDiversity
```

Factors:

- `quality`: supply-weighted Safety Score average; unrated coins default to `40`, but the factor returns `null` if rated supply is below 50% of chain supply
- `chainEnvironment`: resilience tier mapping from `shared/lib/chains.ts` (`1 -> 100`, `2 -> 60`, `3 -> 20`)
- `concentration`: `100 * (1 - HHI)`
- `pegStability`: supply-weighted peg proximity; missing prices contribute a neutral `50`
- `backingDiversity`: normalized Shannon entropy across the two active backing cohorts, `rwa-backed` and `crypto-backed`. Coins without backing metadata are excluded from the distribution (not defaulted to `rwa-backed`). Weight constants are exported from `chain-health.ts`.

Bands:

- `robust`: 80-100
- `healthy`: 60-79
- `mixed`: 40-59
- `fragile`: 20-39
- `concentrated`: 0-19

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

If the methodology version changes, also update `shared/lib/chain-health-version.ts`, [chain-health-timeline.md](./chain-health-timeline.md), and the public changelog route at `src/app/methodology/chain-health-changelog/page.tsx`.
