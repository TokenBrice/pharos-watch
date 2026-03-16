# Chain Analytics — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Mockups:** `.superpowers/brainstorm/1815514-1773668826/` (chains-leaderboard.html, chain-detail.html)

## Summary

A chain-centric analytics feature for Pharos: a leaderboard ranking blockchain networks by stablecoin supply and a per-chain health score, plus per-chain profile pages showing composition, backing breakdown, health sub-factors, and a full stablecoin table. Chains become a first-class dimension alongside stablecoins, with a Pharos-native Chain Health Score that projects existing per-coin quality signals (safety grades, peg stability, concentration, backing diversity) onto chains.

## Motivation

Users want to assess stablecoin activity per blockchain — where is capital sitting, which chains are growing, how concentrated a chain's stablecoin mix is. Pharos already has the underlying data (`chainCirculating` per stablecoin from DefiLlama) but surfaces it only as a chain count on detail pages. This feature flips the perspective: chain as the base unit.

## Routes

| Route | Purpose |
|-------|---------|
| `/chains/` | Chain leaderboard — sortable table of all chains with stablecoin activity |
| `/chains/[chain]/` | Chain profile — hero stats, composition, backing breakdown, stablecoin table |

URL keys use `CHAIN_META` IDs (e.g., `ethereum`, `arbitrum`, `solana`). Both routes use `generateStaticParams` from active chains (chains where at least one tracked stablecoin has `current > 0`).

## API Endpoint

### `GET /api/chains`

Computes chain aggregates on-the-fly from the stablecoins cache. No new cron or cache key needed for the summary — edge-cached with `CACHE_PROFILES.realtime` (`s-maxage=60, max-age=10`) plus a 600-second freshness threshold, matching the existing stablecoins endpoint pattern.

**Response:**

```typescript
interface ChainSummary {
  id: string;                    // CHAIN_META key, e.g. "ethereum"
  name: string;                  // display name from CHAIN_META
  logoPath: string;              // from CHAIN_META
  type: "evm" | "tron" | "other";
  totalUsd: number;              // sum of chainCirculating[chain].current across all stablecoins
  change24h: number;             // absolute USD delta vs circulatingPrevDay
  change24hPct: number;
  change7d: number;
  change7dPct: number;
  change30d: number;
  change30dPct: number;
  stablecoinCount: number;       // stablecoins deployed on this chain
  dominantStablecoin: {          // largest stablecoin by supply on this chain; ties broken by global market cap
    id: string;
    symbol: string;
    share: number;               // 0–1, fraction of chain total
  };
  dominanceShare: number;        // chain's share of global stablecoin supply (0–1)
  healthScore: number | null;    // 0–100 composite Chain Health Score (null if insufficient data)
  healthBand: string | null;     // "robust" | "healthy" | "mixed" | "fragile" | "concentrated"
  healthFactors: {               // sub-factor breakdown for the chain profile page
    concentration: number;       // 0–100, inverted HHI
    quality: number | null;      // 0–100, supply-weighted safety score average
    pegStability: number;        // 0–100, supply-weighted peg proximity
    backingDiversity: number;    // 0–100, normalized Shannon entropy of backing types
  };
}

interface ChainsResponse {
  chains: ChainSummary[];
  globalTotalUsd: number;
  updatedAt: number;
  healthMethodologyVersion: string; // e.g. "1.0", for traceability and future recalibration
}
```

**Computation logic:**
1. Read stablecoins cache (already-parsed `StablecoinData[]`)
2. Read report card cache via `loadReportCardCache(db)` — provides `Record<stablecoinId, { score, grade }>` for health score quality factor
3. Iterate all coins; for each `chainCirculating` entry, accumulate into a `Map<chainId, accumulator>` tracking supply, deltas, per-coin supply shares, safety scores, price deviations, and backing types
4. For each chain, compute deltas from prevDay/prevWeek/prevMonth sums
5. For each chain, compute health score sub-factors and composite (see Chain Health Score section)
6. Look up `CHAIN_META` for display metadata; skip chains not in `CHAIN_META`
7. Deduplicate alias chains: some chains have multiple keys in `CHAIN_META` with the same display name (e.g., `hyperliquid` and `hyperliquid-l1`). Group by display name, use the key that DefiLlama actually reports supply under as the canonical ID. If both keys carry supply, sum them. The canonical key becomes the URL slug for `/chains/[chain]/`.
8. Exclude chains with zero total supply
9. Sort by `totalUsd` descending

### Chain detail page data

The chain profile page does not need its own endpoint. It uses:

- **`/api/chains`** — hero stats (total supply, deltas, rank, dominance). Fetched via `useChains()` hook; detail page filters to its chain.
- **`/api/stablecoins`** — existing payload. Detail page filters to coins where `chainCirculating[chainId].current > 0` and reads per-chain supply, deltas, and coin metadata.

Both are already cached by TanStack Query from other pages.

## Chain Health Score

A Pharos-native composite score (0–100) that projects existing per-coin quality signals onto chains. No equivalent exists elsewhere — DeFi chain rankings are purely supply-based. This score answers: "how healthy is the stablecoin foundation of this chain?"

### Sub-Factors

| Factor | Weight | Range | Formula |
|--------|--------|-------|---------|
| **Quality** | 35% | 0–100 | Supply-weighted average of safety scores from report card cache. Uses the numeric `score` field (0–100) directly from `ReportCardScoreEntry` — no grade-to-number conversion needed. Unrated coins (not present in report card cache) default to 40 (conservative). |
| **Concentration** | 25% | 0–100 | `100 × (1 − HHI)` where HHI = sum of squared supply shares on the chain. Single-stablecoin chain → HHI = 1.0 → score 0. Even split among N coins → score ≈ `100 × (1 − 1/N)`. |
| **Peg Stability** | 25% | 0–100 | Supply-weighted average of per-coin peg proximity scores. Per-coin deviation in bps: `abs(price − pegRef) / pegRef × 10000`. Per-coin score: `max(0, 100 − deviationBps / 5)`. A coin at exact peg = 100; 500 bps off = 0. Peg reference is computed via `derivePegRates(peggedAssets, TRACKED_META_BY_ID, fxFallbackRates)` then `getPegReference(pegType, rates, meta.commodityOunces)` — required for non-USD pegs (EUR, GOLD, JPY, etc.). Coins without a price use 50 (neutral). |
| **Backing Diversity** | 15% | 0–100 | Normalized Shannon entropy of the backing-type distribution (RWA-backed, crypto-backed, algorithmic). `100 × H / ln(3)` where `H = −Σ(p × ln(p))` across the three categories. Monoculture = 0; equal three-way split = 100. Backing types from `StablecoinMeta.flags.backing`. |

### Composite

```
healthScore = 0.35 × quality + 0.25 × concentration + 0.25 × pegStability + 0.15 × backingDiversity
```

### Bands

| Band | Range | Meaning |
|------|-------|---------|
| Robust | 80–100 | Diverse, high-quality, stable stablecoin ecosystem |
| Healthy | 60–79 | Solid foundation with minor concentration or quality gaps |
| Mixed | 40–59 | Notable risks from concentration, lower-grade coins, or limited diversity |
| Fragile | 20–39 | High concentration or dominated by lower-quality stablecoins |
| Concentrated | 0–19 | Near-total dependence on a single stablecoin or poor quality |

### Calibration Table

Expected scores for well-known chains under the proposed formula. Supply distributions are approximate; safety scores are illustrative estimates (actual values depend on live report card data). The purpose is to verify the formula produces a defensible ranking and to give implementers concrete test targets.

**Assumed safety scores for calibration:** USDT ≈ 75, USDC ≈ 88, DAI ≈ 72, USDe ≈ 60, unrated ≈ 40.

| Chain | Concentration | Quality | Peg Stability | Backing Div. | **Composite** | **Band** | Key Driver |
|-------|:---:|:---:|:---:|:---:|:---:|--------|------------|
| Arbitrum | 69 | 77 | 98 | 60 | **78** | Healthy | Most balanced USDC/USDT split + meaningful crypto-backed presence |
| Ethereum | 62 | 76 | 98 | 47 | **74** | Healthy | Large and diverse, but USDT concentration (54%) limits score |
| Base | 45 | 83 | 98 | 45 | **72** | Healthy | High quality (73% USDC) offset by heavy single-coin concentration |
| Solana | 49 | 81 | 98 | 34 | **70** | Healthy | Similar pattern to Base — USDC-dominant, limited backing diversity |
| BSC | 36 | 74 | 97 | 34 | **64** | Healthy | USDT-heavy (79%), lower quality tail, weak diversity |
| Tron | 4 | 75 | 99 | 5 | **53** | Mixed | 98% USDT — extreme concentration tanks score despite decent quality |

**What the ranking validates:**
- Arbitrum leads because it has the best balance across all four dimensions — not just the biggest, but the most well-rounded stablecoin ecosystem.
- Ethereum scores well but is penalized for USDT's 54% dominance — an unintuitive but defensible result.
- Tron is correctly flagged as "Mixed" despite having a high-quality dominant stablecoin. A chain that depends 98% on one asset is fragile regardless of that asset's individual rating.
- The formula meaningfully differentiates chains that look identical by supply alone (Base vs Solana vs BSC all have similar supply but different health profiles).

**Weight sensitivity:** if Tron's score feels too low or Arbitrum's too high, adjust the concentration weight (currently 25%). Raising it penalizes single-coin chains harder; lowering it favors quality over distribution. The 35/25/25/15 split was chosen to keep quality as the primary signal while ensuring extreme concentration cannot be masked by a strong dominant coin.

### Null Handling

`healthScore` is `null` in two cases:
1. **Report card cache unavailable** — when `loadReportCardCache(db)` returns `kind: "error"` (missing, stale, or parse-failed), the quality sub-factor is null for all chains and no composite scores are emitted.
2. **Insufficient coverage on a specific chain** — when fewer than 50% of the chain's supply by value has a report card grade, quality is null for that chain only.

The other three sub-factors (concentration, peg stability, backing diversity) are always computable regardless of report card cache availability. When `healthScore` is null, the chain profile page shows the three computable sub-factors individually but omits the composite.

**New deployments note:** if a stablecoin was recently deployed on a chain (e.g., within the last 7 days), `circulatingPrevWeek` may be 0, producing a 100% `change7d`. This is technically correct. No special capping is applied, but the implementer may consider a "new" badge or tooltip annotation for chains where >25% of supply appeared within the delta window.

### Data Sources (server-side)

- **Quality**: `loadReportCardCache(db)` — D1 cache key `report_card_cache`. One read, already used by mint-burn-flows handler.
- **Concentration**: Derived from `chainCirculating` supply shares (already computed in step 3).
- **Peg Stability**: Derived from `price` field in stablecoins cache + peg reference from `TRACKED_META_BY_ID`.
- **Backing Diversity**: Derived from `StablecoinMeta.flags.backing` via `TRACKED_META_BY_ID` (static, imported at module level).

Total additional I/O: one D1 cache read. Everything else is in-memory computation.

## D1 Schema

New table for per-chain supply history (enables trend charts once data accumulates):

```sql
CREATE TABLE chain_supply_history (
  chain_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  total_usd REAL NOT NULL,
  stablecoin_count INTEGER NOT NULL,
  PRIMARY KEY (chain_id, snapshot_date)
);
```

~50 chains x 1 row/day = ~50 rows/day. Negligible storage growth.

## Cron

New stage in the existing daily `snapshot-supply` cron. After writing aggregate supply to `supply_history`, the stage:

1. Reads the stablecoins cache
2. Aggregates per-chain totals (same logic as the `/api/chains` handler)
3. Batch-inserts one row per chain into `chain_supply_history`

No new cron trigger slot needed — piggybacks on the existing supply snapshot.

## Frontend Pages

### `/chains/` — Chain Leaderboard

**Structure:**
- Breadcrumb: Home / Chains
- Page title + subtitle
- KPI strip (4 cards): total stablecoin supply, active chain count, top chain dominance, highest health score chain
- Sortable table with progressive column disclosure (same pattern as homepage stablecoin table column visibility dropdown):
  - **Default visible:** Rank, Chain (logo + name + type badge), Health (score + colored band badge), Supply, 7d change %, Global Share (bar + percentage)
  - **Available via column toggle:** 24h change %, 30d change %, Stablecoin Count, Dominant Stablecoin (symbol + share)
- Rows are clickable, linking to `/chains/[chain]/`
- Default sort: by Supply descending. Health is a compelling secondary sort for users who care about quality over size.

**Data source:** `useChains()` hook fetching `GET /api/chains`.

### `/chains/[chain]/` — Chain Profile

**Structure:**
- Breadcrumb: Home / Chains / {Chain Name}
- Hero card: chain logo, name, type badge from `CHAIN_META.type` (EVM / Tron / Other), rank pill, health score badge (score + band + color), 5-stat KPI bar (total supply, global share, 24h/7d/30d changes in absolute + percentage)
- Health Score breakdown card: four sub-factor gauges (Quality, Concentration, Peg Stability, Backing Diversity), each showing a 0–100 score with a contextual label. Placed after the hero, before composition. Uses the `healthFactors` fields from the API. If composite is null (insufficient quality data), the card shows the three computable sub-factors and a note explaining why the composite is unavailable.
- Supply History section: hidden at MVP; rendered once `chain_supply_history` has accumulated enough data to chart (powered by deferred `GET /api/chain-history` endpoint)
- Stablecoin Composition section (two-panel):
  - Left: treemap visualization showing supply distribution (top 5 stablecoins + "N others" block). Blocks are clickable, linking to `/stablecoin/[id]/`.
  - Right: ranked breakdown list with proportional bars, supply values, and share percentages
- Supply by Backing Type: horizontal stacked bar with legend (RWA-backed, crypto-backed, algorithmic). Backing type comes from `StablecoinMeta.flags.backing` (static metadata in `shared/lib/stablecoins/`), not from the DefiLlama API payload. The `useChainStablecoins` hook must join against `TRACKED_STABLECOINS` or `getStablecoinMeta()` to resolve each coin's backing type.
- All Stablecoins table: sortable list of all stablecoins deployed on this chain. Columns: Rank, Stablecoin (logo + name + symbol), Peg, Supply on Chain, Chain Share (bar + %), 24h/7d/30d change %. Rows link to `/stablecoin/[id]/`.

**Data sources:** `useChains()` for hero stats + `useStablecoins()` for composition/table (both existing hooks or thin wrappers).

## Navigation

### Sidebar

"Chains" in the **Data** group, first position:

```
Data:
  Chains              ← new (Layers icon from lucide-react)
  Liquidity Tracker
  Depeg Tracker
  Mint/Burn Flows
  Blacklist Tracker
```

Added to `NAV_GROUPS` in `src/lib/nav-config.ts`.

### Contextual links

**From stablecoin detail pages:**
- Key Info Card: chain logos/names in the contract addresses section become links to `/chains/[chain]/`
- Hero Card: the "X chains" count links to a popover or the chain with the largest share

**From chain detail pages:**
- Stablecoin table rows link to `/stablecoin/[id]/`
- Treemap blocks link to `/stablecoin/[id]/`
- Breadcrumb links back to `/chains/`

## Hooks

### `useChains()`

New TanStack Query hook fetching `GET /api/chains`.

- `staleTime`: matches stablecoins cron interval (15 minutes)
- `refetchInterval`: 2x cron interval (30 minutes)
- Returns `ChainsResponse` with sorted chain summaries

### `useChainStablecoins(chainId: string)`

Derived hook. Reads from `useStablecoins()` (existing), filters to coins with `chainCirculating[chainId].current > 0`, enriches each with:
- `supplyOnChain`: `chainCirculating[chainId].current`
- `chainShare`: supply on chain / chain total
- Per-chain deltas computed from `chainCirculating[chainId].circulatingPrevDay`, `.circulatingPrevWeek`, `.circulatingPrevMonth` (the per-chain fields, not the top-level global peg-bucket fields)

No additional fetch — pure derivation from cached data.

## Static Generation

`generateStaticParams` for `/chains/[chain]/` produces params from active chains only — chains where at least one tracked stablecoin has `chainCirculating[chainId].current > 0` at build time. This keeps build output lean (~50 pages, not 108+).

Unknown or inactive chain slugs return 404. This is consistent with the route definition on line 22 and follows the same pattern as `/stablecoins/[peg]/`, `/stablecoins/backing/[backing]/`, etc.

## Scope Boundaries

### In scope (MVP)

- `/api/chains` endpoint (including Chain Health Score computation)
- Chain Health Score: composite + 4 sub-factors (quality, concentration, peg stability, backing diversity)
- `chain_supply_history` D1 table + snapshot cron stage
- `/chains/` leaderboard page (with health score column)
- `/chains/[chain]/` profile page (hero with health badge, health breakdown card, composition treemap + breakdown, backing bar, stablecoin table)
- Sidebar nav entry
- Contextual chain links from stablecoin detail Key Info Card

### Deferred

- Supply history trend chart (needs accumulated data)
- Chain history API endpoint (`GET /api/chain-history?chain=X`)
- Activity metrics (mint/burn flow volume per chain, DEX liquidity TVL per chain)
- Health score history tracking (snapshot health scores alongside supply for trend analysis)
- Cross-chain flow signals (capital migration detection)
- Chain filter on the homepage stablecoin table

## Documentation Updates

After implementation:
- Add chain analytics section to `docs/architecture.md`
- Add `/api/chains` to `docs/api-reference.md`
- Add `chain_supply_history` to `docs/supply-snapshot.md`
- Add chains cron stage to `docs/worker-infrastructure.md`
- Update `docs/data-flow-map.md` with chain data flow
- Update the about page with chains as a feature
- Add Chain Health Score to `docs/methodology-page.md` section mapping
- Add `/methodology` section explaining health score formula, sub-factors, and bands
- Update `CLAUDE.md` Directory Overview to include `/chains/` and `/chains/[chain]/` routes
