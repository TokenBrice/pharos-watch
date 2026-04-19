# Stablecoin Detail Page

Route contract for `/stablecoin/[id]/`, the central per-asset analytics surface.

---

## Route Shape

- **Route shell:** `src/app/stablecoin/[id]/page.tsx`
- **Client composition:** `src/app/stablecoin/[id]/client.tsx`
- **Primary hook:** `src/hooks/use-stablecoin-detail-view-model.ts`
- **Pure view-model builder:** `src/lib/stablecoin-detail-view-model.ts`
- **Section components:** `src/components/stablecoin-detail/*`

`generateStaticParams()` prebuilds one page per tracked stablecoin ID from `TRACKED_STABLECOINS`. The server route also:

- builds metadata through `buildStablecoinDetailMetadata(...)`
- injects static logo data from `data/logos.json`
- injects static AI summaries from `data/ai-summaries.json`
- renders a server-side `sr-only` `h1` for active pages so the initial HTML keeps one stable page heading without duplicating the visible client hero
- keeps a visible dossier-style `Suspense` fallback with coin identity, classification, section rail placeholders, and score-card scaffolding while the full client boots
- renders `ExploreNextSection` after the interactive client
- emits N-level `BreadcrumbJsonLd` plus a Dataset JSON-LD payload for active assets

If the ID is not tracked, the server shell returns a not-found-style fallback instead of mounting the full client.

If the ID is tracked but `coin.status === "pre-launch"`, the server route returns `PreLaunchDetail` instead of mounting the normal detail client.

### Pre-launch detail variant

`PreLaunchDetail` is the server-rendered variant for tracked assets whose metadata status is still `pre-launch`.

In addition to the pre-launch dossier sections (banner, timeline, milestones, featured content, and metadata), it now includes a launch-alert CTA that:

- promotes `@PharosWatchBot`
- renders the exact command users can copy and paste for that asset
- uses `/subscribe launch <coin.id>` so the copied command is deterministic even when a ticker is ambiguous
- renders immediately below the expected-launch/timeline block, before the milestone/activity section

---

## View-Model Contract

`useStablecoinDetailViewModel()` gathers the detail page's shared query state, then delegates all derived formatting and fallback logic to `buildStablecoinDetailViewModel(...)`.

### Query inputs

The hook currently wires these sources:

- `useSupplyHistory(id)` for the chart series
- `useStablecoins()` for the canonical cached stablecoin snapshot
- `usePegSummary()` for peg score and depeg metadata
- `useDexLiquidity()` for liquidity score and DEX context
- `useReportCards()` for the main Safety Score card
- `useRedemptionBackstops()` for modeled redemption routes
- `useYieldRankings()` for yield-row availability and detail context
- `useStressSignals()` for DEWS detail context
- `useBlacklistSummary()` for blacklist-support and summary badges
- `useMintBurnFlows()` for flow-surface availability checks
- `useStablecoinReserves(id, enabled)` for live reserve presentation when `coin.liveReservesConfig` exists

`useInfiniteDepegEvents()` is intentionally separate from the main view model. The hook is called unconditionally to preserve React hook order, but both `enabled` and `autoLoadAll` are true only when the detail view is ready and the coin is not a NAV token.

### Returned states

The builder returns one of four states:

- `loading`
- `list-error`
- `not-found`
- `ready`

`ready` contains the fully derived detail payload: supply numbers, peg reference context, deviation metrics, derived non-USD/commodity `performanceVsUsd1y` when enough priced history exists, report card, liquidity row, redemption backstop, reserve presentation, supply history, yield ranking, DEWS stress signal, blacklist-support state, stale-query inputs, and convenience flags like `isNavToken`, `hasYieldSection`, `hasFlows`, and `hasBlacklist`.

The client `loading` state now mirrors the server fallback more closely: it keeps the coin identity, classification line, and dossier framing visible instead of dropping back to anonymous skeleton blocks.

---

## Section Order

`src/app/stablecoin/[id]/client.tsx` renders sections in this order for live/non-pre-launch assets:

1. `QueryErrorNotice` for supply-history failures when the rest of the page can still render
2. `StaleDataBanner` driven by the shared query freshness presets
3. `HeroCard`
4. `ExploitNoticeBanner`
5. `LongformScrollspyNav`
6. `ReportCardDetail` + `SafetyScoreHistorySection`
7. `NoticesAndSummarySection` (wraps `OverviewSection`, `CoinNotices`, and the nested `PriceTransparencyCard` anchor)
8. `KeyInfoCard`
9. `CollateralUsageSection` when the coin is used as tracked collateral elsewhere
10. `YieldDetailSection` when the coin is marked `yieldBearing` or the cached yield rankings include a live row for that coin
11. `McapChart`
12. `DistributionSection`
13. `DexLiquidityCard`
14. `FlowsSection`
15. `BlacklistSection` while blacklist summary data is still loading for a supported symbol, or after load only when that supported symbol has recorded blacklist events
16. `DepegHistory` (suppressed for NAV tokens)
17. `FeedbackModal`

The server shell then appends `ExploreNextSection` after the client-rendered analytics stack.

### Rail vs section rules

- `LongformScrollspyNav` pill order is: `report-card` (Safety), `overview`, optional `reserves`, optional `price`, `chart` (Market), optional `yield`, `liquidity`, optional `flows`, optional `blacklist`, `history`, `explore-next`. This is the current rail order; it does not strictly mirror DOM order because `YieldDetailSection` renders before `McapChart`. Optional pills appear only when their source data is present (`reserves != null`, `hasPriceTransparency`, `hasYieldSection`, `hasFlows`, `hasBlacklist`).
- Section ids are stable; do not rename them. In particular: the Safety pill still targets `#report-card`, and the Market pill still targets `#chart`.
- `CollateralUsageSection` renders inline within the overview zone and is not a top-level scrollspy entry.
- `DistributionSection` renders after the chart, outside the top-level rail.
- `DepegHistory` is omitted for NAV tokens.
- `YieldDetailSection` decides its own empty/loading/null behavior from the cached yield rankings plus static coin metadata. Non-yield-bearing coins can still render the section when the yield stack publishes a live lending-opportunity or curated ranking row for that asset.

### Hero signals rail (desktop) / SafetyGradeHero (mobile)

On `lg+` the hero's right column renders `HeroSignalsRail` — a four-pill stack (Safety / Peg / Liquidity / DEWS) that jumps to `#report-card` (for Safety, Peg, and DEWS) or `#liquidity`. This replaces the former desktop `SafetyGradeHero` duplicate that sat opposite the Safety Score card. On `<lg` the hero still renders `SafetyGradeHero` because the Safety Score card is far down the scroll on narrow screens.

Hero signal chips below the identity block are severity-ordered: `DEWS`, `Freezable`, `Peg`, `Liquidity`, `Excess Yield`, optional `1Y vs USD`, `Chains`. The chip previously labelled `BLACKLISTABLE` now reads `Freezable` (industry term; methodology docs still use "Blacklistable" as the canonical methodology label).

### Classification taxonomy pills

Below the identity block, the classification line renders three small focus-ringed taxonomy pills (governance / backing / peg) that each route to `buildGovernanceTaxonomyUrl(coin.flags.governance)`, `buildBackingTaxonomyUrl(coin.flags.backing)`, and `/stablecoins/${PEG_SLUGS[coin.flags.pegCurrency]}/` respectively. No handwritten slugs.

### Price Transparency Card

- **Component:** `PriceTransparencyCard` (`src/components/stablecoin-detail/price-transparency-card.tsx`)
- **Data:** `coinData.price`, `coinData.priceSource`, `coinData.priceConfidence`, `coinData.priceUpdatedAt` from stablecoins API; `consensusSources` and `dexPriceCheck` from peg-summary API
- **Scrollspy ID:** `price` (label: "Price"); replaces the former `price-transparency` id
- **Mount point:** nested inside `OverviewSection` (`src/components/stablecoin-detail/overview-section.tsx`)
- **Hidden when:** there is no `coinData`, or both `coinData.price == null` and no `dexPriceCheck`
- Shows current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No data). When protocol-redeem overrides are active, all market sources show "Not applicable". DEX Price Check section renders when `dexPriceCheck` data exists.

### Reserves anchor

When reserves render, the treemap block is wrapped in `<section id="reserves">` so the scrollspy's Reserves pill scrolls to it.

### Explore Next anchor

`ExploreNextSection` wraps itself in `<section id="explore-next">` so the scrollspy's terminal Explore pill is reachable. Layout rebalanced to three equal columns at `xl+` (Taxonomy | Trackers | Compare+Related), two columns at `lg`, stacked below `lg` in order Compare+Related -> Taxonomy -> Trackers. Per-pair compare affordance now primaries `Open comparison` (filled button) with a secondary `Read the one-page brief` text link. Related pills cap at 4 entries with a `See all peers ->` overflow pill when more exist.

---

## Fallback And Staleness Rules

On the worker side, `GET /api/stablecoin/:id` now uses a small strategy layer:

- `worker/src/api/stablecoin-detail.ts` handles cache lookup, fresh-cache hits, provider selection, and shared response helpers
- `worker/src/api/stablecoin-detail/commodity.ts`, `coingecko-only.ts`, and `defillama.ts` own provider-specific upstream behavior
- `worker/src/api/stablecoin-detail/shared.ts` owns cache writes, supply-history fallback loading, and stale-cache vs hard-error response policy

### Reserve presentation

The detail page prefers live reserve data when the coin is live-enabled:

- `liveReserves` API result wins when available
- otherwise it falls back to `getReserves(coin)` from curated/template metadata
- authoritative `live` / `live-stale` reserve responses can carry a separate reserve badge taxonomy: `Live`, `Curated-Validated`, or `Proof`

`OverviewSection` is responsible for translating reserve modes and reserve badge semantics into user-visible notices:

- `live`
- `live-stale`
- `curated-fallback`
- `template-fallback`
- `unavailable`

Live-reserve fetch failures do not take the full page down. They surface as reserve-specific messaging inside the overview section.

### Shared stale banner

The page-level stale banner is built from five shared presets in the view model:

- `stablecoins`
- `pegSummary`
- `dexLiquidity`
- `reportCards`
- `redemptionBackstops`

Those presets intentionally track the major page-defining datasets rather than every nested query. Yield and depeg-history sections manage their own local empty/error/loading states.

### Retry behavior

`handleRetryAll()` fans out retries for:

- supply history
- stablecoins
- peg summary
- dex liquidity
- report cards
- redemption backstops

That shared retry is used by the page-level error surfaces.

---

## Section Responsibilities

| Section / Component         | Responsibility                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HeroCard`                  | Price, supply deltas, peg metrics, liquidity headline, top-level blacklist / excess-yield / DEWS badges, optional `1Y vs USD` context for eligible non-USD and commodity pegs, feedback entrypoint, and first-touch methodology hints for Peg Score / Liquidity                                                                                                                             |
| `ReportCardDetail`          | Overall Safety Score plus radar/dimension detail, contextual methodology hints, and a methodology footer line                                                                                                                                                                                                                                                                               |
| `SafetyScoreHistorySection` | Grade-transition timeline                                                                                                                                                                                                                                                                                                                                                                   |
| `OverviewSection`           | AI summary, reserve treemap, reserve/live-fallback notices, redemption-backstop card with explicit fixed or documented variable fee messaging, eventual-only vs immediate-capacity messaging, reviewed source context, and resolution / confidence state when the route is configured but currently unrated, DEWS detail, and the nested `price` anchor when price data exists |
| `CoinNotices`               | Coin-specific warnings/info blocks from metadata                                                                                                                                                                                                                                                                                                                                            |
| `KeyInfoCard`               | Classification, collateral, peg mechanism, links, proof-of-reserves, jurisdiction                                                                                                                                                                                                                                                                                                           |
| `McapChart`                 | Historical supply / market-cap chart                                                                                                                                                                                                                                                                                                                                                        |
| `DistributionSection`       | Holder and supply distribution view after market history                                                                                                                                                                                                                                                                                                                                    |
| `PriceTransparencyCard`     | Current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No data). It is rendered inside `OverviewSection` under `<section id="price" aria-label="Price transparency">`. When protocol-redeem overrides are active, all market sources show "Not applicable". DEX Price Check section renders when `dexPriceCheck` data exists      |
| `YieldDetailSection`        | Yield rankings row, clickable source links, warnings, history chart, alt-source/provenance detail, and contextual PYS / Stability help. Renders for statically yield-bearing coins and for non-yield-bearing coins that currently have a published yield ranking (for example auto-discovered lending coverage).                                                                            |
| `DexLiquidityCard`          | Liquidity score, top pools, DEX-implied price context, and contextual methodology hints / footer links. For `unobserved` rows it now shows an explicit no-direct-market state and an unobserved-history panel instead of hiding history entirely.                                                                                                                                       |
| `FlowsSection`              | Per-coin mint/burn summary plus the separate `flow-history` event-feed section, with contextual Pressure Shift help on the summary card; rendered below liquidity and included in the top-level scrollspy rail when `hasFlows` is true                                                                                                                                                       |
| `BlacklistSection`          | Per-coin blacklist/freeze support summary and event context when the coin is in the blacklist tracker support set                                                                                                                                                                                                                                                                          |
| `DepegHistory`              | Historical depeg timeline for non-NAV assets                                                                                                                                                                                                                                                                                                                                                |
| `ExploreNextSection`        | Related stablecoins, compare pages, and taxonomy/deeper-navigation links                                                                                                                                                                                                                                                                                                                    |

Composite-score surfaces on the detail page now share a lightweight explainability pattern:

- compact methodology hint trigger attached to the metric label
- mobile sheet / desktop tooltip behavior from the same component
- footer-level `View methodology` + `Version history` actions on the main score cards

## Infrastructure Surfacing

When `StablecoinMeta` includes one or more supported `infrastructures` entries, the detail experience surfaces that infrastructure in three places:

- `HeroCard` renders a prominent infrastructure badge near the identity block so users can immediately recognize coins that share a common technical foundation
- `KeyInfoCard` adds a concise "Infrastructure" explainer line for the classified cohort
- `ExploreNextSection` adds a cohort link into the matching infrastructure hub (for example Liquity v1, Liquity v2, or M0)

---

## File Index

| File                                                                | Role                                                |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| `src/app/stablecoin/[id]/page.tsx`                                  | Static params, metadata, JSON-LD, server shell      |
| `src/app/stablecoin/[id]/client.tsx`                                | Client-side section composition and dynamic imports |
| `src/hooks/use-stablecoin-detail-view-model.ts`                     | Query wiring + aggregate retry handler              |
| `src/lib/stablecoin-detail-view-model.ts`                           | Pure derivation and fallback assembly               |
| `src/components/stablecoin-detail/hero-card.tsx`                    | Detail hero surface                                 |
| `src/components/stablecoin-detail/notices-and-summary-section.tsx`  | Overview + notices wrapper                          |
| `src/components/stablecoin-detail/overview-section.tsx`             | Summary, reserves, redemption backstop              |
| `src/components/stablecoin-detail/price-transparency-card.tsx`      | Price source transparency and confidence card       |
| `src/components/stablecoin-detail/flows-section.tsx`                | Detail flow section                                 |
| `src/components/stablecoin-detail/redemption-backstop-card.tsx`     | Redemption route card                               |
| `src/components/stablecoin-detail/safety-score-history-section.tsx` | Grade timeline section                              |
| `src/components/stablecoin-detail/explore-next-section.tsx`         | Post-detail navigation hub                          |
| `src/components/mcap-chart.tsx`                                     | Supply / market-cap chart (dynamic import)          |
| `src/components/depeg-history.tsx`                                  | Depeg event timeline (dynamic import)               |
| `src/components/key-info-card.tsx`                                  | Key info / metadata card (dynamic import)           |
| `src/components/yield-detail-section.tsx`                           | Yield detail section (dynamic import)               |
| `src/components/dex-liquidity-card.tsx`                             | DEX liquidity breakdown card (dynamic import)       |
