# Stablecoin Detail Page

Route contract for `/stablecoin/[id]/`, the central per-asset analytics surface.

---

## Route Shape

- **Route shell:** `src/app/stablecoin/[id]/page.tsx`
- **Client composition:** `src/app/stablecoin/[id]/client.tsx`
- **Yield subroute:** `src/app/stablecoin/[id]/yield/page.tsx` and `src/app/stablecoin/[id]/yield/client.tsx` for tracked coins with `flags.yieldBearing`
- **Primary hook:** `src/hooks/use-stablecoin-detail-view-model.ts`
- **Pure view-model builder:** `src/lib/stablecoin-detail-view-model.ts`
- **Section components:** `src/components/stablecoin-detail/*`

`generateStaticParams()` prebuilds one page per tracked stablecoin ID from `TRACKED_STABLECOINS`. The server route also:

- builds metadata through `buildStablecoinDetailMetadata(...)`
- injects static logo data from `data/logos.json`
- injects static AI summaries from `data/ai-summaries.json`
- renders one server-side `sr-only` `h1` for active pages before the client detail island mounts; the visible identity remains inside the client hero, while descriptions live in metadata and Dataset JSON-LD
- keeps a visible dossier-style `Suspense` fallback with coin identity, classification, section rail placeholders, and score-card scaffolding while the full client boots
- renders `ExploreNextSection` after the interactive client
- emits N-level `BreadcrumbJsonLd` plus a Dataset JSON-LD payload for active assets

If the ID is not tracked, the server shell returns a not-found-style fallback instead of mounting the full client.

If the ID is tracked but `coin.status === "pre-launch"`, the server route returns `PreLaunchDetail` instead of mounting the normal detail client.

The `/stablecoin/[id]/yield/` subroute is generated only for yield-bearing tracked coins. Unknown IDs and tracked coins without `flags.yieldBearing` return `notFound()` and noindex metadata; see [yield-intelligence.md](./yield-intelligence.md) for the per-source APY history contract.

### Pre-launch detail variant

`PreLaunchDetail` is the server-rendered variant for tracked assets whose metadata status is still `pre-launch`.

In addition to the pre-launch dossier sections (banner, timeline, milestones, featured content, and metadata), it now includes a launch-alert CTA that:

- owns the page's visible `h1` for pre-launch assets; active assets use an `sr-only` server-rendered `h1` and keep the visible identity in the client hero
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

`ready` contains the fully derived detail payload: supply numbers, peg reference context, deviation metrics, derived non-USD/commodity `performanceVsUsd1y` when enough priced history exists, report card, liquidity row, redemption backstop, reserve presentation, supply history, yield ranking, DEWS stress signal, blacklist-support state, tracked parent/child variant relationships, stale-query inputs, and convenience flags like `isNavToken`, `isVariant`, `hasVariants`, `hasYieldSection`, `hasFlows`, and `hasBlacklist`.

The client `loading` state now mirrors the server fallback more closely: it keeps the coin identity, classification line, and dossier framing visible instead of dropping back to anonymous skeleton blocks.

---

## Section Order

`src/app/stablecoin/[id]/client.tsx` renders sections in this order for live/non-pre-launch assets:

1. `QueryErrorNotice` for supply-history failures when the rest of the page can still render
2. `StaleDataBanner` driven by the shared query freshness presets
3. `HeroCard`
4. `ExploitNoticeBanner`
5. `FrozenStateBanner` for frozen tracked assets with `obituary` and `frozenAt` metadata
6. `AiSummary` when a summary is available
7. `MobileStickySummary`
8. `LongformScrollspyNav`
9. `KeyInfoCard` (wrapped in `<section id="info">`, not surfaced in the scrollspy rail) — renders immediately after `LongformScrollspyNav`, before the Overview `SectionBanner`, so the metadata anchor is visible at the top of the dossier rather than buried deep below the chart
10. Overview zone under a `SectionBanner`: `ReportCardDetail` (which embeds `OverviewSection` as its `rightColumn` slot to render the reserves panel) → `CoinNotices` → `DEWSDetail` for non-NAV coins
11. Context zone under a `SectionBanner`: `ContagionSnapshot` (with `UnderlyingAssetCard` or `ParentVariantsCard` passed as the variant relationship card when applicable, and `hasCollateralUsage` driving the collateral-usage row), `MarketDataSection` for USD-pegged non-NAV coins with supply history (otherwise a standalone `McapChart` inside `<section id="chart">`), then `DistributionSection`
12. Liquidity zone under a `SectionBanner`: `DexLiquidityCard` inside `<section id="dex-liquidity">`; when price transparency or a redemption backstop is available, `PriceTransparencyCard` and `RedemptionBackstopCard` sit in a two-column grid beneath
13. Activity zone under a `SectionBanner`: `YieldDetailSection` for yield-bearing coins or coins with a live ranking, `FlowsSection`, and `BlacklistSection` when supported
14. History zone under a `SectionBanner`: `TapeForCoinTeaser`, `SafetyScoreHistorySection`, `DepegHistory` for non-NAV coins, `FlowHistorySection`, and `BlacklistHistorySection`
15. Explore zone under a `SectionBanner` when `exploreNextContent` is provided
16. `FeedbackModal`

`StablecoinDetailSeoContent` is rendered by the server `Suspense` fallback in `page.tsx` so crawlers see visible profile text before the client island mounts; it is not part of the client section stream above. The server shell passes `ExploreNextSection` into `StablecoinDetailClient` as `exploreNextContent`, and the client renders it inside the Explore zone.

### Rail vs section rules

- `LongformScrollspyNav` pill order is: `overview` (Risk), `context`, `liquidity`, `activity`, `history`, `explore`. Child cards can still expose deep-link anchors such as `#report-card`, `#reserves`, `#price`, `#chart`, `#yield`, `#flows`, `#blacklist`, `#coin-timeline`, and `#explore-next`, but they are not top-level rail pills.
- Section ids are stable; do not rename them. In particular, the top-level Explore pill targets `#explore`; the reusable `ExploreNextSection` keeps its inner `#explore-next` anchor for existing deep links.
- The outer detail composition owns the single `#overview` anchor. Nested overview subcomponents do not publish a second `#overview` id.
- `UnderlyingAssetCard`, `ParentVariantsCard`, and `CollateralUsageSection` render inline within the overview zone and are not top-level scrollspy entries.
- `DistributionSection` renders after the chart, outside the top-level rail.
- `DepegHistory` is omitted for NAV tokens, but the top-level history section remains mounted for timeline and score-history content.
- `YieldDetailSection` decides its own empty/loading/null behavior from the cached yield rankings plus static coin metadata. Non-yield-bearing coins can still render the section when the yield stack publishes a live lending-opportunity or curated ranking row for that asset.

### Hero signals rail (desktop) / SafetyGradeHero (mobile)

On `lg+` the hero's right column renders `HeroSignalsRail` — a four-pill stack (Safety / Peg / Liquidity / DEWS) that jumps to `#report-card` (for Safety, Peg, and DEWS) or `#liquidity`. This replaces the former desktop `SafetyGradeHero` duplicate that sat opposite the Safety Score card. On `<lg` the hero still renders `SafetyGradeHero` because the Safety Score card is far down the scroll on narrow screens.

Hero signal chips below the identity block are severity-ordered: `DEWS`, `Freezable`, `Peg`, `Liquidity`, `30d Excess`, optional `1Y vs USD`, `Chains`. The chip previously labelled `BLACKLISTABLE` now reads `Freezable` (industry term; methodology docs still use "Blacklistable" as the canonical methodology label).

### Classification taxonomy pills

Below the identity block, the classification line renders three small focus-ringed taxonomy pills (governance / backing / peg) that each route to `buildGovernanceTaxonomyUrl(coin.flags.governance)`, `buildBackingTaxonomyUrl(coin.flags.backing)`, and `/stablecoins/${PEG_SLUGS[coin.flags.pegCurrency]}/` respectively. No handwritten slugs.

### Price Transparency Card

- **Component:** `PriceTransparencyCard` (`src/components/stablecoin-detail/price-transparency-card.tsx`)
- **Data:** `coinData.price`, `coinData.priceSource`, `coinData.priceConfidence`, `coinData.priceUpdatedAt` from stablecoins API; `consensusSources` and `dexPriceCheck` from peg-summary API
- **Deep-link ID:** `price`; the nested card still carries the legacy `price-transparency` id
- **Mount point:** liquidity zone grid below `#dex-liquidity`, alongside the redemption backstop
- **Hidden when:** there is no `coinData`, or both `coinData.price == null` and no `dexPriceCheck`
- Shows current price, source label, confidence badge, source-depth target (`0/3`, `1/3`, `2/3`, or `3+/3`), update recency, and a table of all known price sources with their status (Used/Available/No data). When protocol-redeem overrides are active, all market sources show "Not applicable". DEX Price Check section renders when `dexPriceCheck` data exists.

### Reserves anchor

When reserves render, the treemap block is wrapped in `<section id="reserves">` so the scrollspy's Reserves pill scrolls to it.

### Explore Next anchor

The outer Explore `SectionBanner` publishes the scrollspy target `#explore`. `ExploreNextSection` wraps itself in `<section id="explore-next">` for existing deep links. Layout rebalanced to three equal columns at `xl+` (Taxonomy | Trackers | Compare+Related), two columns at `lg`, stacked below `lg` in order Compare+Related -> Taxonomy -> Trackers. Per-pair compare affordance now primaries `Open comparison` (filled button) with a secondary `Read the one-page brief` text link. Related pills cap at 4 entries with a `See all peers ->` overflow pill when more exist.

---

## Fallback And Staleness Rules

On the worker side, `GET /api/stablecoin/:id` now uses a small strategy layer:

- `worker/src/api/stablecoin-detail.ts` handles cache lookup, fresh-cache hits, provider selection, and shared response helpers
- `worker/src/api/stablecoin-detail/commodity.ts`, `coingecko-only.ts`, and `defillama.ts` own provider-specific upstream behavior
- `worker/src/api/stablecoin-detail/shared.ts` owns cache writes, supply-history fallback loading, and stale-cache vs hard-error response policy

Detail API stale-while-refresh is bounded: rows older than the 5-minute D1 TTL but younger than 24 hours are served with `Warning: 110`, `X-Data-Age`, and `Cache-Control: no-store` while a single-flight refresh runs in the background. Rows older than 24 hours are not served as stale fallback; the Worker refreshes synchronously and returns the normal upstream/supply-history fallback result.

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
| `OverviewSection`           | Reserve treemap, reserve/live-fallback notices, reviewed source context, and resolution / confidence state when the route is configured but currently unrated |
| `CoinNotices`               | Coin-specific warnings/info blocks from metadata                                                                                                                                                                                                                                                                                                                                            |
| `KeyInfoCard`               | Classification, collateral, peg mechanism, links, proof-of-reserves, jurisdiction                                                                                                                                                                                                                                                                                                           |
| `McapChart`                 | Historical supply / market-cap chart                                                                                                                                                                                                                                                                                                                                                        |
| `DistributionSection`       | Holder and supply distribution view after market history                                                                                                                                                                                                                                                                                                                                    |
| `PriceTransparencyCard`     | Current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No data). It is rendered in the liquidity zone under `<section id="price" aria-label="Price transparency">`. When protocol-redeem overrides are active, all market sources show "Not applicable". DEX Price Check section renders when `dexPriceCheck` data exists      |
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
| `src/components/stablecoin-detail/section-banner.tsx`               | Section banner heading shared by the detail zones   |
| `src/components/stablecoin-detail/overview-section.tsx`             | Summary, reserves, redemption backstop              |
| `src/components/stablecoin-detail/price-transparency-card.tsx`      | Price source transparency and confidence card       |
| `src/components/stablecoin-detail/flows-section.tsx`                | Detail flow section                                 |
| `src/components/stablecoin-detail/redemption-backstop-card.tsx`     | Redemption route card                               |
| `src/components/stablecoin-detail/safety-score-history-section.tsx` | Grade timeline section                              |
| `src/components/stablecoin-detail/explore-next-section.tsx`         | Post-detail navigation hub                          |
| `src/components/mcap-chart.tsx`                                     | Supply / market-cap chart (dynamic import)          |
| `src/components/peg-deviation-chart.tsx`                            | USD peg deviation chart (dynamic import; USD non-NAV only) |
| `src/components/depeg-history.tsx`                                  | Depeg event timeline (dynamic import)               |
| `src/components/key-info-card.tsx`                                  | Key info / metadata card (dynamic import)           |
| `src/components/yield-detail-section.tsx`                           | Yield detail section (dynamic import)               |
| `src/components/dex-liquidity-card.tsx`                             | DEX liquidity breakdown card (dynamic import)       |
