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
- renders a visible dossier-style `Suspense` fallback with coin identity, classification, section rail placeholders, and score-card scaffolding while the full client boots
- renders `ExploreNextSection` after the interactive client
- emits `BreadcrumbJsonLd` plus a Dataset JSON-LD payload

If the ID is not tracked, the server shell returns a not-found-style fallback instead of mounting the full client.

If the ID is tracked but `coin.status === "pre-launch"`, the server route returns `PreLaunchDetail` instead of mounting the normal detail client.

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
- `useMintBurnFlows()` for flow-surface availability checks
- `useStablecoinReserves(id, enabled)` for live reserve presentation when `coin.liveReservesConfig` exists

`useInfiniteDepegEvents()` is intentionally separate from the main view model and is mounted in the client only when the coin is not a NAV token.

### Returned states

The builder returns one of four states:

- `loading`
- `list-error`
- `not-found`
- `ready`

`ready` contains the fully derived detail payload: supply numbers, peg reference context, deviation metrics, derived non-USD/commodity `performanceVsUsd1y` when enough priced history exists, report card, liquidity row, redemption backstop, reserve presentation, supply history, stale-query inputs, and convenience flags like `isNavToken`, `hasFlows`, and `usesFallbackPegRate`.

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
8. `McapChart`
9. `DistributionSection`
10. `KeyInfoCard`
11. `CollateralUsageSection` when the coin is used as tracked collateral elsewhere
12. `YieldDetailSection` when the coin is marked `yieldBearing` or the cached yield rankings include a live row for that coin
13. `DexLiquidityCard`
14. `FlowsSection`
15. `DepegHistory` (suppressed for NAV tokens)
16. `FeedbackModal`

The server shell then appends `ExploreNextSection` after the client-rendered analytics stack.

### Rail vs section rules

- `LongformScrollspyNav` does not mirror every rendered section. Its top-level entries are `report-card`, `overview`, `chart`, optional `yield`, `liquidity`, `info`, and `history`.
- `DistributionSection` renders between the chart and the details stack, but it is not a top-level scrollspy entry.
- `CollateralUsageSection` renders only when at least one other tracked stablecoin derives a dependency on the current coin, and it is also outside the top-level rail.
- `FlowsSection` renders after liquidity, outside the top-level rail. When flow coverage exists it owns both `#flows` and `#flow-history`.
- `PriceTransparencyCard` lives inside `OverviewSection` under the nested `price-transparency` anchor and is hidden when `coinData.price == null`.
- `DepegHistory` is omitted for NAV tokens.
- `YieldDetailSection` decides its own empty/loading/null behavior from the cached yield rankings plus static coin metadata. Non-yield-bearing coins can still render the section when the yield stack publishes a live lending-opportunity or curated ranking row for that asset.

### Price Transparency Card

- **Component:** `PriceTransparencyCard` (`src/components/stablecoin-detail/price-transparency-card.tsx`)
- **Data:** `coinData.price`, `coinData.priceSource`, `coinData.priceConfidence`, `coinData.priceUpdatedAt` from stablecoins API; `consensusSources` and `dexPriceCheck` from peg-summary API
- **Scrollspy ID:** `price-transparency` (label: "Price Sources")
- **Mount point:** nested inside `OverviewSection` (`src/components/stablecoin-detail/overview-section.tsx`)
- **Hidden when:** `coinData.price == null`
- Shows current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No data). When protocol-redeem overrides are active, all market sources show "Not applicable". DEX Price Check section renders when `dexPriceCheck` data exists.

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

`OverviewSection` is responsible for translating reserve modes into user-visible notices:

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

| Section / Component         | Responsibility                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HeroCard`                  | Price, supply deltas, peg metrics, liquidity headline, top-level blacklist / excess-yield / DEWS badges, optional `1Y vs USD` context for eligible non-USD and commodity pegs, feedback entrypoint, and first-touch methodology hints for Peg Score / Liquidity                                                                                                                     |
| `ReportCardDetail`          | Overall Safety Score plus radar/dimension detail, contextual methodology hints, and a methodology footer line                                                                                                                                                                                                                                                                          |
| `SafetyScoreHistorySection` | Grade-transition timeline                                                                                                                                                                                                                                                                                                                                                              |
| `OverviewSection`           | AI summary, reserve treemap, reserve/live-fallback notices, redemption-backstop card with explicit fixed or documented variable fee messaging, eventual-only vs immediate-capacity messaging, reviewed source context, and resolution / confidence state when the route is configured but currently unrated, DEWS detail, and the nested `price-transparency` anchor when price data exists |
| `CoinNotices`               | Coin-specific warnings/info blocks from metadata                                                                                                                                                                                                                                                                                                                                       |
| `McapChart`                 | Historical supply / market-cap chart                                                                                                                                                                                                                                                                                                                                                   |
| `DistributionSection`       | Holder and supply distribution view between market history and the metadata stack                                                                                                                                                                                                                                                                                                       |
| `KeyInfoCard`               | Classification, collateral, peg mechanism, links, proof-of-reserves, jurisdiction                                                                                                                                                                                                                                                                                                      |
| `PriceTransparencyCard`     | Current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No data). It is rendered inside `OverviewSection` under the `price-transparency` anchor. When protocol-redeem overrides are active, all market sources show "Not applicable". DEX Price Check section renders when `dexPriceCheck` data exists |
| `YieldDetailSection`        | Yield rankings row, clickable source links, warnings, history chart, alt-source/provenance detail, and contextual PYS / Stability help. Renders for statically yield-bearing coins and for non-yield-bearing coins that currently have a published yield ranking (for example auto-discovered lending coverage).                                                                 |
| `DexLiquidityCard`          | Liquidity score, top pools, DEX-implied price context, and contextual methodology hints / footer links                                                                                                                                                                                                                                                                                 |
| `FlowsSection`              | Per-coin mint/burn summary plus the separate `flow-history` event-feed section, with contextual Pressure Shift help on the summary card; rendered below liquidity and outside the top-level scrollspy rail                                                                                                                                                                            |
| `DepegHistory`              | Historical depeg timeline for non-NAV assets                                                                                                                                                                                                                                                                                                                                           |
| `ExploreNextSection`        | Related stablecoins, compare pages, and taxonomy/deeper-navigation links                                                                                                                                                                                                                                                                                                               |

Composite-score surfaces on the detail page now share a lightweight explainability pattern:

- compact methodology hint trigger attached to the metric label
- mobile sheet / desktop tooltip behavior from the same component
- footer-level `View methodology` + `Version history` actions on the main score cards

## Protocol Lineage Surfacing

When `StablecoinMeta` includes a supported `protocolFamily` / `protocolVariant`, the detail experience now surfaces that lineage in three places:

- `HeroCard` renders a prominent protocol badge near the identity block so users can immediately recognize Liquity-family assets
- `KeyInfoCard` adds a concise "Protocol Lineage" explainer line for the classified cohort
- `ExploreNextSection` adds a cohort link into the matching protocol hub (for example Liquity family, Liquity v1, Liquity v2, or Liquity-style)

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
