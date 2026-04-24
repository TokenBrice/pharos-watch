# Non-USD / Alt-Peg Page Concept

Date: 2026-04-23

## Goal

Explore a dedicated Pharos route for stablecoins outside the USD peg so the homepage can stop carrying three medium-density charts in the Research Surfaces band and the non-USD market can become a first-class research surface.

This page should answer four questions quickly:

1. How large is the non-USD market now, and how fast is it growing?
2. Is that growth broad-based, or concentrated in a few pegs and a few coins?
3. Which peg markets matter most right now?
4. Where should the user click next to inspect a specific peg cohort or coin?

## Assumptions

- This is a feature page, not just a filtered table view.
- We should preserve Pharos' current shell and chart language rather than invent a new visual system.
- We should prefer an MVP that uses existing hooks/endpoints before adding new worker routes.
- Commodity pegs belong on the page. The user language was "non-USD / alt-peg", and the current homepage grouping already treats commodities as part of the broader non-USD story.

## Repo-grounded starting point

Relevant existing pieces:

- `src/components/total-mcap-chart.tsx`
- `src/components/peg-diversity-chart.tsx`
- `src/components/non-usd-share-chart.tsx`
- `src/components/category-stats.tsx`
- `src/components/peg-distribution-grid.tsx`
- `src/lib/peg-taxonomy.ts`
- `worker/src/api/non-usd-share.ts`

Current data already available without backend work:

- Historical total by peg currency from `GET /api/stablecoin-charts`
- Historical non-USD share split (fiat non-USD vs commodities) from `GET /api/non-usd-share`
- Live coin list, supply deltas, chain footprint from `GET /api/stablecoins`
- Live peg/stress context from `GET /api/peg-summary`
- Liquidity context from `GET /api/dex-liquidity`
- Structure/risk context from `GET /api/report-cards`

Useful scope numbers from the checked-in registry:

- `204` active stablecoins total
- `50` active non-USD / alt-peg coins
- `41` fiat non-USD coins
- `9` commodity coins
- `18` active non-USD peg currencies
- Largest alt-peg cohorts by coin count: `EUR (13)`, `GOLD (8)`, then `BRL / VAR / CHF / JPY / AUD (3 each)`

## Route recommendation

Preferred:

- Path: `/alt-pegs/`
- Visible title: `Non-USD Stablecoins`

Why:

- It reads like a feature route, which matches the intended behavior better than a taxonomy route.
- It avoids implying "just another stablecoin table".
- It can still deep-link into the existing peg taxonomy routes (`/stablecoins/eur/`, `/stablecoins/gold/`, etc.).

Acceptable alternative:

- `/non-usd-stablecoins/`

I would avoid:

- `/stablecoins/non-usd/`

That path sounds like a simple filtered browse page, while the real value here is historical structure and market navigation.

## Recommended page shape

Use `FeaturePageShell`, not a bespoke homepage-style shell.

Suggested narrative:

### 1. Header + market snapshot

Do not open with six equal KPI cards. Open with one dominant story card and a compact supporting rail.

Header copy:

- Eyebrow: `Market Structure`
- H1: `Non-USD Stablecoins`
- Lead: `Euro, gold, real, yen, CPI-linked, and other stablecoin markets outside dollar dominance.`

Supporting stat rail:

- Non-USD market cap
- Share of total stablecoin market
- Fiat non-USD vs commodity split
- Tracked alt-peg coins / peg currencies

Right-side summary module:

- A horizontal stacked bar for current market composition
- Top 3 peg cohorts by share
- A single sentence on whether growth is broadening or concentrating

### 2. Primary chart: non-USD share of total market

This should become the hero chart of the page, larger than it is on the homepage.

Base it on `src/components/non-usd-share-chart.tsx`, but upgrade the framing:

- Full-width chart
- Keep the existing stacked area split: `Commodities` vs `Fiat non-USD`
- Add a sidecar summary for:
  - current share
  - 1-year change
  - 3-year range high/low
- Keep time-range buttons

This chart answers the page's top question fastest: "is the non-USD market actually becoming meaningful?"

### 3. Current distribution by peg currency

This is the biggest missing piece on the homepage today.

Recommended module:

- Ranked horizontal bar table, not a treemap

Each row:

- Peg currency
- Current market cap
- Share of alt-peg market
- Coin count
- Largest coin in cohort
- Link to cohort page

Why a ranked table instead of a treemap:

- Better scanability for a dense financial dashboard
- Easier to compare small cohorts
- Easier to add secondary metadata without decorative clutter

This is the section that lets users understand "what exists beyond USD" immediately.

### 4. Historical growth by peg cohort

Move `src/components/peg-diversity-chart.tsx` here and let it breathe.

Recommended changes:

- Full-width instead of half-width
- Toggle set:
  - `All alt-pegs`
  - `Fiat only`
  - `Commodities only`
- Show the top cohorts individually, keep the tail merged into `Other`
- Preserve the current legend treatment

This section answers "which non-USD markets have actually grown over time?"

### 5. Market drivers table

A dedicated leaderboard for the coins driving the page-level story.

Suggested columns:

- Rank in alt-peg market
- Coin
- Peg
- Market cap
- 30d growth
- Peg deviation / Peg Score
- Liquidity score
- Chains

This should be alt-peg-only and default-sorted by market cap.

This is more useful here than reusing the global homepage `CategoryStats` card, which is currently optimized for the entire stablecoin market rather than the non-USD slice.

### 6. Structure and risk cross-sections

Compact stat-card row, filtered to alt-pegs only.

Suggested cards:

- Governance mix: CeFi / CeFi-Dependent / DeFi
- Backing mix: RWA / crypto / algorithmic
- Chain concentration: Ethereum share, top-3 chains share, multichain vs single-chain
- Stress monitor: active depegs, worst live deviation, weakest liquidity cohort

These should feel analytical, not decorative. Keep them tighter than the homepage `CategoryStats`.

### 7. Browse by cohort

Finish with a peg directory that links into the existing taxonomy pages.

Recommended treatment:

- Group by `Fiat`, `Commodity`, `Other`
- Each cohort card shows:
  - peg label
  - coin count
  - current market cap
  - leading names
  - CTA into `/stablecoins/[peg]/`

This is where the page becomes a navigation hub instead of just an explanatory dashboard.

## Visual direction

Stay inside current Pharos rules:

- Dark-first, dense, and calm
- Monospace numbers everywhere important
- Semantic color by peg category, not decorative gradients
- No generic KPI-tile hero

The memorable visual move should be the contrast between:

- one dominant full-width "share of total market" chart
- one ranked distribution block that makes the long tail of peg currencies legible

That is more Pharos than trying to add a flashy new aesthetic layer.

## What should move off the homepage

Move these three intact in spirit, but not necessarily unchanged in exact layout:

- `TotalMcapChart`
- `PegDiversityChart`
- `NonUsdShareChart`

Homepage replacement:

- Keep a compact teaser block for alt-pegs in the Research Surfaces band
- One sentence, one small stat strip, one CTA: `Open Alt-Peg Market`

That keeps the homepage informative without forcing three medium-detail charts into a crowded band.

## MVP scope

Reasonable first version with no new backend endpoint:

1. New route using `FeaturePageShell`
2. Larger `NonUsdShareChart`
3. Larger `PegDiversityChart`
4. Move `TotalMcapChart` here if the page is positioned as "market structure beyond USD", or drop it if the route should stay purely alt-peg-focused
5. Add current distribution module derived from latest `stablecoin-charts` point plus `stablecoins` metadata
6. Add alt-peg leaderboard derived from `stablecoins`, `peg-summary`, `dex-liquidity`, and `report-cards`
7. Add cohort browse cards linking to existing peg taxonomy routes

## One key product choice

Decide whether `TotalMcapChart` belongs here permanently.

Two valid directions:

- Keep it here as page context: it shows the total market regime that non-USD share sits inside.
- Leave it on the homepage and make this route purely about alt-peg structure.

My preference:

- Keep `NonUsdShareChart` and `PegDiversityChart` on the new page for sure
- Only move `TotalMcapChart` if the homepage needs the space badly

`TotalMcapChart` is still a whole-market chart, so it is the least native of the three to an alt-peg-only route.

## Good v2 extensions

If the first version lands well, these would add real value:

- Per-peg delta chips: `7d`, `30d`, `90d`
- "Broadening vs concentrating" indicator using top-3 and top-5 alt-peg share
- Chain map for alt-pegs only
- Depeg history summary for non-USD cohorts
- Issuer concentration summary inside each peg cohort

## Recommendation

Ship this as a first-class feature page, not as a hidden homepage overflow area.

The strongest version is:

- a dominant historical share chart
- a ranked current distribution module
- a market-driver table
- a cohort directory

That combination would make the page genuinely useful for understanding the non-USD market, not just "the place where the homepage charts moved to".
