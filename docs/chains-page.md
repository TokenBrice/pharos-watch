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
- **Primary API:** `GET /api/chains`
- **Methodology version source:** `shared/lib/chain-health-version.ts`
- **Scoring implementation:** `shared/lib/chain-health.ts`, `shared/lib/chain-aggregator.ts`, `shared/lib/chains.ts`
- **Shared chain UI helpers:** `src/lib/chain-ui.ts` (formatting + health band color maps)
- **Active chain derivation:** `getActiveChainIds()` in `shared/lib/chains.ts`

The leaderboard is public and indexable. The profile routes are statically generated from `getActiveChainIds()` which returns chains that have at least one tracked stablecoin contract and a `CHAIN_META` entry.

---

## `/chains/` Contract

`src/app/chains/page.tsx` renders a `FeaturePageShell` with:

- breadcrumb + canonical path `/chains/`
- status badge `experimental`
- methodology pill wired from `CHAIN_HEALTH_METHODOLOGY_VERSION` and `CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH`
- lead copy describing chain ranking by stablecoin supply and health
- FAQ structured data from the route-local `CHAINS_FAQ_JSON_LD`
- a hidden SEO nav listing every generated `/chains/[chain]/` route

`src/app/chains/client.tsx` consumes `useChains()` and renders:

- KPI strip: total stablecoin supply, active chains, top chain (explicit sort by supply), healthiest chain
- sortable leaderboard table with `<caption>` for screen readers
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
- statically generates params from tracked contract chain IDs present in `TRACKED_STABLECOINS`
- sets canonical metadata at `/chains/[chain]/`

`src/app/chains/[chain]/client.tsx` uses `useChains()` plus `useChainStablecoins(chainId)` and renders, in order:

1. `QueryErrorNotice` (inline banner when error + stale data)
2. hero card with supply, global share, 24h/7d/30d change (all with dark-mode colors via `trendColor()`), health badge, and `dark:invert` logo support
3. Chain Health breakdown card — weight labels derived dynamically from exported constants in `chain-health.ts`
4. stablecoin composition treemap — uses `grid-cols-2` for 1-2 coins, `grid-cols-3` otherwise; dominant span only for 3+ coins
5. backing-type breakdown — unclassified coins shown as "Other" (zinc-colored) bucket
6. full stablecoin table with `<caption>` and `scope="col"` attributes
7. skeleton loading states (hero + health + composition blocks)

`useChainStablecoins()` derives profile rows from `/api/stablecoins`, not `/api/chains`, by summing every `chainCirculating` entry that resolves to the selected canonical chain ID.

---

## Chain Health Score

Current live methodology version is `1.1`.

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
- `backingDiversity`: normalized Shannon entropy across `rwa-backed`, `crypto-backed`, and `algorithmic`. Coins without backing metadata are excluded from the distribution (not defaulted to `rwa-backed`). Weight constants are exported from `chain-health.ts`.

Bands:

- `robust`: 80-100
- `healthy`: 60-79
- `mixed`: 40-59
- `fragile`: 20-39
- `concentrated`: 0-19

---

## API And Freshness

`useChains()` reads `GET /api/chains` with the standard 15-minute cron-aligned query preset.

`worker/src/api/chains.ts`:

- loads the strict stablecoins cache
- derives non-USD peg references from `fxFallbackRates`
- hydrates safety scores from the report-card cache when available
- computes the response via `aggregateChains(...)`
- overwrites `updatedAt` with the stablecoins-cache timestamp
- applies realtime cache headers with `X-Data-Age`

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

If the methodology version changes, also update `shared/lib/chain-health-version.ts` and the public changelog route at `src/app/methodology/chain-health-changelog/page.tsx`.
