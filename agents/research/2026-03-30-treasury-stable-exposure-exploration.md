# Treasury Stable Exposure Exploration

Date: 2026-03-30

## Prompt

Explore a feature that ranks protocol / organization treasuries by their stablecoin holdings, then reuses Pharos portfolio scoring to show:

- which treasuries hold the most decentralized stablecoins
- which reach thresholds like 5% decentralized stablecoin exposure
- absolute and percentage exposure to decentralized stablecoins
- stable treasury composition by stablecoin

Suggested source: DefiLlama Treasuries.

## Bottom Line

This is product-fit positive and technically plausible, but it is **not** "just a UI add at the bottom of `/portfolio/`" unless treasury data access is already solved.

The existing portfolio logic is reusable for the scoring and exposure math. The main blocker is upstream treasury ingestion:

1. DefiLlama documents Treasuries as a **pro-only** API surface (`GET /api/treasuries` on `pro-api.llama.fi`).
2. The public `defillama.com/treasuries` page is Cloudflare-protected in headless fetches, so page scraping would be brittle and operationally weak.
3. Because `/portfolio/` is a static Next route and the current portfolio tool is client-only, any authenticated treasury feed belongs in the Worker, not the browser.

## What Already Fits

### 1. Portfolio holdings model is already the right shape

The current portfolio workspace reduces everything to:

- `coinId`
- `amount` in USD

That maps cleanly to a treasury's stablecoin sleeve once balances are normalized to tracked Pharos IDs.

### 2. Portfolio scoring already uses report cards as weighted inputs

The existing portfolio hook computes:

- weighted overall Safety Score / grade
- weighted dimension scores
- upstream exposure views

That means a treasury with stablecoin holdings can be scored with the same math as a user portfolio, provided we can produce a holdings array.

### 3. DefiLlama ID mapping is already mostly solved

Pharos already maintains `REGISTRY_BY_LLAMA_ID`, so if treasury token breakdowns come through DefiLlama token IDs or symbols that can be resolved to DefiLlama stablecoin IDs, the normalization layer is straightforward for tracked names.

## Where The Current Product Does Not Fit Yet

### 1. `/portfolio/` is currently personal and fully client-side

The current route:

- has no dedicated `/api/portfolio` endpoint
- stores holdings in `localStorage`
- shares state through `?p=...`

That is the wrong execution model for a global treasury leaderboard. A treasury list needs a server-owned dataset with freshness metadata.

### 2. The current exposure view is per-portfolio, not cross-entity analytics

The page can show one synthetic portfolio at a time. It does not currently support:

- a list of many portfolios
- entity-level filtering/sorting
- ranking by decentralized stable share or dollar amount
- stable-only treasury coverage flags

### 3. Treasury balances need a stable denominator contract

The user request mixes two possible denominators:

- `% of full treasury in decentralized stablecoins`
- `% of stablecoin sleeve in decentralized stablecoins`

Both are useful, but they answer different questions and should not be conflated.

## Recommended Data Contract

Treat this as a new Worker-owned dataset, not an extension of browser `usePortfolio()` state.

Suggested shape:

```ts
interface TreasuryStableExposureEntity {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  chain: string | null;
  logo: string | null;
  source: "defillama-treasuries";
  updatedAt: number;
  treasuryUsd: number | null;
  stableTrackedUsd: number;
  stableTrackedPctOfTreasury: number | null;
  decentralizedStableUsd: number;
  decentralizedStablePctOfTreasury: number | null;
  decentralizedStablePctOfStableSleeve: number | null;
  weightedSafetyScore: number | null;
  weightedSafetyGrade: ReportCardGrade;
  holdings: Array<{
    coinId: string;
    usd: number;
    pctOfTreasury: number | null;
    pctOfStableSleeve: number;
  }>;
  coverage: {
    trackedStableUsd: number;
    untrackedStableUsd: number;
    nonStableUsd: number | null;
    trackedCoveragePct: number | null;
  };
}
```

Key rules:

- `treasuryUsd` is the full treasury if the upstream provides it.
- `stableTrackedUsd` is only the part mapped to Pharos-tracked stablecoins.
- `weightedSafetyScore` uses only `stableTrackedUsd`.
- Rankings should expose both treasury-relative and stable-sleeve-relative percentages.

## Recommended Architecture

### Option A: Proper product implementation

1. Add Worker-side treasury ingest
   - new cron job or piggyback on a low-contention slot only if the upstream/API budget is safe
   - fetch DefiLlama treasuries from the authenticated pro API
   - normalize token breakdowns into stablecoin holdings
   - write a cached snapshot to D1 `cache`

2. Add public API endpoint
   - `GET /api/treasury-stable-exposure`
   - optional filters: category, sort, search, minStableUsd, minDecentralizedStablePct

3. Add shared types + API path
   - `shared/types/treasury-stable-exposure.ts`
   - `shared/lib/api-endpoints.ts`

4. Add frontend query hook
   - `useTreasuryStableExposure()`

5. Add a new section on `/portfolio/`
   - keep the personal portfolio tool intact
   - append a clearly separate "Treasury Stable Exposure" leaderboard section below it

### Option B: Lowest-risk MVP

Skip cron first. Serve a read-through Worker handler that:

- fetches treasury data on request
- caches the processed snapshot in `cache`
- returns the latest successful snapshot on upstream failure

This is faster to ship but weaker operationally. It also couples public reads to a paid upstream path unless cache behavior is carefully fail-closed.

## Why Reusing The Portfolio Module Still Makes Sense

The right reuse boundary is **math and presentation primitives**, not the entire page state model.

Reuse:

- weighted grade math from `usePortfolio`
- upstream exposure math from `computeUpstreamExposure()` / `computeGroupedExposure()`
- report-card-backed holdings rendering patterns

Do not reuse directly:

- `localStorage` persistence
- `?p=` sharing codec
- manual coin entry workflow

## Normalization Layer Needed

The implementation hinges on one adapter:

`DefiLlama treasury token breakdown -> tracked Pharos stablecoin holdings`

That adapter must:

1. detect stablecoin rows from the treasury feed
2. resolve each row to a canonical Pharos `coinId`
3. drop or separately bucket untracked stablecoins
4. preserve full-treasury totals so percentages remain honest

Likely matching order:

1. DefiLlama stablecoin ID if present
2. exact contract/address mapping if provided
3. canonical ticker + upstream metadata fallback

This must be conservative. False-positive mapping is worse than missing coverage.

## Product Metrics Worth Shipping

Primary ranking columns:

- `Decentralized Stable $`
- `Decentralized Stable % of Treasury`
- `Decentralized Stable % of Stable Sleeve`
- `Tracked Stable Sleeve $`
- `Weighted Stable Safety Grade`
- `Largest Stablecoin Position`

Useful filters:

- only show treasuries with `trackedStableUsd >= X`
- only show treasuries with `decentralizedStablePctOfTreasury >= 5`
- category
- chain

Useful secondary chips:

- CeFi / CeFi-Dependent / DeFi split
- RWA / crypto-backed / algorithmic split
- top 3 stablecoin holdings

## Risks And Caveats

### 1. Upstream access risk

This is the main risk. If there is no DefiLlama Pro key available, the feature should not be designed around scraping the public website.

### 2. Coverage honesty

Not every treasury token breakdown will map cleanly to Pharos-tracked stablecoins. The UI needs explicit coverage disclosure.

### 3. Denominator confusion

"Most decentralized treasury" can mean:

- treasury-level composition
- stable-sleeve composition
- dependency-adjusted exposure

Those should be shown as separate metrics.

### 4. Methodology surface creep

If this becomes more than "portfolio math applied to treasury holdings" and introduces a new ranking methodology, it becomes its own methodology surface and should get dedicated docs, not just a footer note on `/portfolio/`.

## Smallest Coherent Rollout

Phase 1:

- ingest treasury dataset
- normalize tracked stablecoin holdings
- expose leaderboard API
- render list on `/portfolio/`
- show composition bars and weighted safety grade
- include coverage badges

Phase 2:

- add threshold filters like `>= 5% decentralized stablecoins`
- add stable-sleeve vs total-treasury toggle
- add per-treasury detail drawer

Phase 3:

- add share cards / compare mode
- add alerting or historical treasury stable allocation changes if the upstream supports time series

## Recommendation

Proceed only if DefiLlama Pro treasury access is available or approved.

If it is available, this is a good feature candidate:

- strong fit with Pharos positioning
- high reuse of existing stablecoin scoring
- differentiated from generic treasury dashboards because Pharos can score the **quality** of treasury stable exposure, not just the balances

If access is not available, do not greenlight implementation yet. The honest next step is validating upstream access and sample payloads, then designing the normalization adapter against the real `tokenBreakdowns` shape.
