# Stablecoin Detail Page

Route contract for `/stablecoin/[id]/`, the central per-asset analytics surface.

---

## Route Shape

- **Route shell:** `src/app/stablecoin/[id]/page.tsx`
- **Client composition:** `src/app/stablecoin/[id]/client.tsx` plus adjacent section-group modules under the same route
- **Yield subroute:** `src/app/stablecoin/[id]/yield/page.tsx` and `src/app/stablecoin/[id]/yield/client.tsx` for yield-bearing coins and curated auto-lending workbenches; known tracked coins without a static workbench redirect to `/yield/?compare=<id>&from=detail-fallback`
- **Primary hook:** `src/hooks/use-stablecoin-detail-view-model.ts`
- **Pure view-model facade:** `src/lib/stablecoin-detail-view-model.ts`
- **View-model owners:** `src/lib/stablecoin-detail-query-view-model.ts`, `src/lib/stablecoin-detail-hero-view-model.ts`, and `src/lib/stablecoin-detail-view-model-types.ts`
- **Section components:** `src/components/stablecoin-detail/*`

`generateStaticParams()` prebuilds one page per tracked stablecoin ID from `TRACKED_STABLECOINS`. The server route also:

- builds metadata through `buildStablecoinDetailMetadata(...)`
- injects static logo data from `data/logos.json`
- injects static AI summaries from `data/ai-summaries.json`
- renders one server-side `sr-only` `h1` for active pages before the client detail island mounts; the visible identity remains inside the client hero, while descriptions live in metadata and Dataset JSON-LD
- keeps a visible dossier-style `Suspense` fallback with coin identity, classification, section rail placeholders, and score-card scaffolding while the full client boots
- renders `ExploreNextSection` after the interactive client
- emits N-level `BreadcrumbJsonLd` plus a Dataset JSON-LD payload for active assets

Active stablecoin Dataset JSON-LD is intentionally static and crawlable: `variableMeasured` advertises price, market cap, circulating supply, Peg Score, DEWS, Safety Grade, and Redemption Backstop coverage. Dataset nodes inline the Pharos `Organization` for `creator` / `publisher`, expose the CC BY 4.0 license URL, carry the stable Pharos coin URN in `identifier`, and keep `sameAs` populated from provider/profile URLs or the canonical detail page. Frozen assets use archive-specific historical variables, quarantined and delisted records use inactive-listing variables without live claims, and pre-launch assets use conservative `WebPage` / `Thing` JSON-LD.

If the ID is not tracked, the server shell returns a not-found-style fallback instead of mounting the full client.

If the ID is tracked but `coin.status === "pre-launch"`, the server route returns `PreLaunchDetail` instead of mounting the normal detail client.

If the ID is quarantined or delisted, the server route renders a static read-only profile with `ListingStateBanner`, the sourced lifecycle reason, FAQ, breadcrumbs, and conservative structured data. It does not mount live hooks. The Worker detail endpoint may return retained cache for historical context, but it never refreshes providers for a known non-active record; without retained cache it returns `404`.

The `/stablecoin/[id]/yield/` subroute is statically generated only for active coins that are intrinsically yield-bearing or have a curated deterministic auto-lending override. Those durable workbench routes use `noindex,follow` metadata. A lending opportunity can still appear dynamically for another active coin; when no static workbench exists, the Pages stablecoin function redirects that known coin to `/yield/?compare=<id>&from=detail-fallback` instead of serving a dead link. Unknown IDs retain normal static 404 handling. This policy removes low-value empty workbench pages from the Cloudflare export while preserving a useful handoff for runtime discoveries; see [yield-intelligence.md](./yield-intelligence.md) for the per-source APY history contract.

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
- `useStablecoinReserves(id, enabled)` for live reserve presentation, reserve-local retry state, and fetch progress when `coin.liveReservesConfig` exists

Depeg events are not part of the main view model. The `useInfiniteDepegEvents({ stablecoinId, autoLoadAll: true })` hook is called inside the lazily-imported `DepegHistory` component (History zone), which itself only mounts for non-NAV coins. Once mounted, it follows pagination until the complete per-coin event history is loaded.

### Returned states

The builder returns one of four states:

- `loading`
- `list-error`
- `not-found`
- `ready`

`ready` contains the fully derived detail payload: supply numbers, peg reference context, deviation metrics, derived non-USD/commodity `performanceVsUsd1y` when enough priced history exists, report card, liquidity row, redemption backstop, reserve presentation, supply history, yield ranking, DEWS stress signal, blacklist-support state, Mint Authority review presentation state, tracked parent/child variant relationships, semantic `featureStates`, expanded stale-query inputs, and convenience flags like `isNavToken`, `isVariant`, `hasVariants`, `hasYieldSection`, `hasFlows`, and `hasBlacklist`. Optional modules use those feature states to distinguish unsupported or deferred features from valid empty data, an unavailable source, and retained stale data.

The client `loading` state now mirrors the server fallback more closely: it keeps the coin identity, classification line, and dossier framing visible instead of dropping back to anonymous skeleton blocks.

---

## Section Order

`src/app/stablecoin/[id]/client.tsx` renders sections in this order for live/non-pre-launch assets:

1. `QueryFreshnessNotices` — single banner covering errors and staleness across core, historical, and enabled supplemental detail sources, driven by `viewModel.staleQueries` (in the normal section stream; `QueryErrorNotice` appears only in the `list-error` and not-found early-return branches, not here)
2. `HeroCard`
3. `ExploitNoticeBanner`
4. `ListingStateBanner` for quarantined/delisted metadata when the reusable client composition is rendered, then `FrozenStateBanner` for frozen tracked assets with `obituary` and `frozenAt`; the route normally short-circuits quarantined/delisted records to its static server profile
5. `MobileRiskSnapshot` on `<lg`, using the current report-card/resilience payload so phone users see the grade, peg state, collateral/custody posture, and key caveat before the full report card
6. `MobileStickySummary`
7. Content grid (Figma coin template): single column below `xl`; at `xl+` an `xl:grid-cols-[minmax(0,1fr)_22rem]` grid places the summary rail beside the main column. The main column holds everything in items 8–16; the rail is item 17.
8. `AiSummary` when a summary is available (first child of the main column, so the rail tops beside it)
9. `LongformScrollspyNav` with the `pill-tabs` emphasis — rounded-full group on the neutral control fill, elevated-neutral active pill, flanking hairline rules at `lg+`
10. Overview zone under a `SectionBanner`: `<section id="info">` first — `KeyInfoCard` alone, or a `lg:grid-cols-2` split of `KeyInfoCard` (with `splitMechanism` + `contractsBelowXlOnly`) beside `PegStabilityCard` (diagram + explainer + peg-mechanism prose, owns `#mechanism` in split mode) when `coin.pegMechanism` exists → `ReportCardDetail` (which embeds `ReservePanel` as its `rightColumn` slot when report-card data is available) → standalone `ReservePanel` when reserve data exists but report-card data is unavailable → `StablecoinDepegResolverCard` when the coin has an active depeg with a DDR row → `CoinNotices` → `DEWSDetail` for non-NAV coins → `FlowsSection` when flows are supported (moved here from the Activity zone per the coin template; the flows query arms when either the overview or activity/history region approaches)
11. Context zone under a `SectionBanner`: `ContagionSnapshot` (with `UnderlyingAssetCard` or `ParentVariantsCard` passed as the variant relationship card when applicable, and `hasCollateralUsage` driving the collateral-usage row), always-present `MintAuthoritySection` with reviewed or explicit not-reviewed state, `MarketDataSection` for USD-pegged, non-NAV, non-yield-bearing coins with supply history (otherwise a standalone `McapChart` inside `<section id="chart">`), then `DistributionSection`
12. Liquidity zone under a `SectionBanner`: `DexLiquidityCard` inside `<section id="dex-liquidity">`; when available, `RedemptionBackstopCard` and `PriceTransparencyCard` render as full-width stacked cards beneath it, in that order — the price-transparency `<section id="price">` carries `xl:hidden` because the rail copy takes over at `xl+`
13. Activity zone under a `SectionBanner`: `YieldDetailSection` for yield-bearing coins or coins with a live ranking, and `BlacklistSection` when supported
14. History zone under a `SectionBanner`: `TapeForCoinTeaser` inside `<section id="coin-timeline">` (`xl:hidden`; the rail copy takes over at `xl+`), `SafetyScoreHistorySection`, `DepegHistory` for non-NAV coins, `FlowHistorySection`, and `BlacklistHistorySection`
15. Explore zone under a `SectionBanner` when `exploreNextContent` is provided
16. `faqContent` (`FaqSection`) — server-passed Q&A block rendered after the Explore zone, before the feedback modal
17. Summary rail `<aside aria-label="Coin summary rail">` (`hidden xl:block`, normal-flow page content without sticky positioning or a nested scroll container): `RailSafetySummary` (reuses `HeroSignalsRail`; the hero hides its inline copy at `xl`) → `TapeForCoinTeaser` → compact `ContractDeployments` card when curated contracts exist → compact `PriceTransparencyCard`. The compact Contracts card owns its shell, labels the header `Contracts · count`, shows a four-row deployment preview, and uses the header icon to expand/collapse all deployments in page flow. The compact Price Transparency card owns a stacked `Price Transparency` / `DEX Check` / `Sources` rail layout with header freshness, large mono prices, source-depth metadata, source status dots, and source-registry modal triggers. Rail copies render without anchor ids — the in-flow instance always owns `#price`, `#coin-timeline`, `#contracts`, and `#price-transparency` (at `xl+` the passport CHAINS jump to `#contracts` is a no-op since its in-flow target is hidden there)
18. `FeedbackModal`

`StablecoinDetailSeoContent` is rendered by the server `Suspense` fallback in `page.tsx` so crawlers see visible profile text before the client island mounts; it is not part of the client section stream above. For tracked variants, that fallback includes a crawlable variant-relationship block linking to the parent asset and up to four sibling variants so wrapper, savings, strategy-vault, and risk-absorption pages expose their parent risk context even before hydration. The server shell passes `ExploreNextSection` into `StablecoinDetailClient` as `exploreNextContent`, and the client renders it inside the Explore zone.

### Scrollspy vs section rules

- `LongformScrollspyNav` renders once as a sticky horizontal pill banner after the identity zone. On `lg+` it stays full-width with the `Jump to` label and section pills centered inside the banner instead of reserving a right-side rail column, so the dossier sections keep the full content width.
- `LongformScrollspyNav` pill order is: `overview` (Risk), `context`, `liquidity`, `activity`, `history`, `explore`. Child cards can still expose deep-link anchors such as `#report-card`, `#reserves`, `#mint-authority`, `#redemption`, `#price`, `#chart`, `#yield`, `#flows`, `#blacklist`, `#coin-timeline`, and `#explore-next` — plus the passport sub-anchors `#mechanism`, `#attestation`, `#jurisdiction`, and `#contracts` inside `KeyInfoCard` — but they are not top-level scrollspy pills.
- Section ids are stable; do not rename them. In particular, the top-level Explore pill targets `#explore`; the reusable `ExploreNextSection` keeps its inner `#explore-next` anchor for existing deep links.
- The outer detail composition owns the single `#overview` anchor. Nested overview subcomponents do not publish a second `#overview` id.
- `UnderlyingAssetCard`, `ParentVariantsCard`, and `CollateralUsageSection` render inline within the context zone (inside `ContagionSnapshot`) and are not top-level scrollspy entries.
- `ContagionSnapshot` uses the shared dependency graph in `minimalChrome` mode. On detail pages, crowded maps keep the compact node treatment with a 1.33x internal logo zoom; maps with 10 or fewer visible stablecoins render ticker labels and 2x node/logo/text scale, and maps with 5 or fewer visible stablecoins use 3x scale.
- `DistributionSection` renders after the chart, outside the top-level rail.
- `DepegHistory` is omitted for NAV tokens, but the top-level history section remains mounted for timeline and score-history content.
- `YieldDetailSection` decides its own empty/loading/null behavior from the cached yield rankings plus static coin metadata. Non-yield-bearing coins can still render the section when the yield stack publishes a live lending-opportunity or curated ranking row for that asset.

### Compact desktop hero / SafetyGradeHero (mobile)

On `lg+` the hero starts with a desktop-only identity/action strip above the metric card: a single identity row containing the 56px coin logo (shared with the loading shell), ticker, and name, followed by the one-line description beneath it; up to three source links plus report/compare/share controls sit opposite. The loaded mobile identity uses the same logo size so hydration does not shrink the asset mark. Below it, the hero renders as a compact dossier card with no internal action/header band: a top chip rail (derived archetype verdict, peg, backing, governance, and launch date), a four-cell divider grid (`Price`, `Market Cap`, `Supply`, and the live `30d Excess` benchmark gap), then the compact passport row. The old desktop `HeroSignalsRail` no longer renders in the hero; Safety / Peg / Liquidity / DEWS live in the `xl+` summary rail. On `<lg` the hero still renders the visible identity block, mobile actions, and `SafetyGradeHero` because the Safety Score card is far down the scroll on narrow screens.

Hero tertiary metric chips below the identity block are mobile-only live signals: on `<lg` a 2x2 grid of `DEWS`, `Peg`, `Liq`, `30d Excess` with optional `1Y vs USD` beneath. On `lg+`, the compact metric grid owns the 30d benchmark gap and the summary rail owns Safety / Peg / Liquidity / DEWS. Freeze and chain facts live in the hero passport strip below.

NAV tokens are displayed as NAV in the hero Peg rail and do not consume their own peg-score, active-depeg, deviation, or depeg-event fields for verdict labeling. A NAV token with weak Safety Score inputs should remain a yield/NAV instrument in the hero verdict unless an explicit non-NAV distress signal such as DEWS WARNING/DANGER is present; pure NAV rows also omit the Record passport item and `DepegHistory`.

### Hero passport strip

`HeroPassportStrip` (June 2026, mythos item 23) docks at the bottom of the `HeroCard` behind a hairline `border-t` and renders the dossier's verification facts as identity-document fields — field name in small letters above, value in mono all-caps below, no pill chrome and no jump icon. Items come from `passportItems` on the hero view model (`buildHeroPassportItems` in `stablecoin-detail-passport.ts`), scanned in two fixed clusters — _how the token works_: Mechanism, Redeemability, Minting, Freeze, Record, Chains; then _who stands behind it_: Jurisdiction, MiCA, GENIUS, Attestor, Issued:

| Field         | Value vocabulary                                                                                        | Anchor target                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism     | `MECHANISM_ARCHETYPE_SHORT_LABELS`; falls back to the backing badge label                               | `#mechanism` (`#info` when the collateral/peg-stability block is absent)                                                                                                                                                                          |
| Redeemability | `REDEMPTION_ACCESS_PASSPORT_LABELS[entry.accessModel]` (full `REDEMPTION_ACCESS_LABELS` in the aria)    | `#redemption`; omitted when no redemption-backstop record exists                                                                                                                                                                                  |
| Minting       | mint-authority `mintPathShortLabel` (full `mintPathLabel` in the aria)                                  | `#mint-authority`; omitted when the mint-authority review is `not-reviewed`                                                                                                                                                                       |
| Freeze        | `Yes` / `Possible` / `Upstream` / `No` (amber/emerald text tones)                                       | `#blacklist` for `BLACKLIST_STABLECOINS`, else `#mint-authority`, else the FreezeWatch coin filter                                                                                                                                                |
| Record        | `0 recorded` or `N incident(s)` from `pegScoreResult.eventCount` (foreground, never a green all-clear) | `#depeg-history`; omitted for NAV tokens, missing peg summary, or `depegEventCoverageLimited`                                                                                                                                                     |
| Chains        | live `coinData.chains.length`                                                                           | `#contracts` (`#info` when no curated contracts)                                                                                                                                                                                                  |
| Jurisdiction  | `jurisdiction.country`, else muted `Not disclosed`                                                      | `#jurisdiction` (`#info` for decentralized coins, where the block is absent)                                                                                                                                                                      |
| MiCA          | `MICA_STATUS_BADGE_STYLES[status].label` (status text tone via `textCls`)                               | `#jurisdiction` (the MiCA badge in the jurisdiction block); omitted without `coin.mica`; frozen assets carry a `Historical MiCA` aria prefix                                                                                                      |
| GENIUS        | `GENIUS_STATUS_SHORT_LABELS[authorizationStatus]` (text tone via `GENIUS_STATUS_TEXT_CLS`)              | `/compliance/?regime=genius` (off-page — no in-page GENIUS section yet); omitted without `coin.genius` and for `not-applicable`/`unknown`; the aria frames _pathway_ status with `GENIUS_REGIME_STATE.effectiveDate`, never a present-day license |
| Attestor      | `POR_TIER_STYLES` label (tier text tone via `textCls`), or PoR type label                               | `#attestation`; omitted for decentralized coins or missing PoR                                                                                                                                                                                    |
| Issued        | launch year from loose-validated ISO `coin.launchDate`; full UTC date in the aria-label                 | `#info` (the Key Information `Launched` proof line); omitted while the date is absent or malformed                                                                                                                                                |

Values are authored-short and never CSS-truncated; on `<lg` the row is a snap-scroll carousel with a right-edge fade. On `lg+`, the row switches to a fixed compact grid with internal vertical dividers; `Mechanism` is omitted from the desktop row because the top verdict/classification chip rail carries that scan-level role. Hash entries intercept the click and re-align with a retry cadence of 160/480/960/1800 ms because deep targets sit below lazy sections whose height settles after the jump starts; targets carry sticky-chrome scroll clearance. Each fact has exactly one hero home, and the strip hides entirely if fewer than three facts resolve.

### Mint Authority section

`MintAuthoritySection` always renders in the Context zone. `src/lib/stablecoin-detail-mint-authority-view-model.ts` projects either a reviewed profile or an explicit `not-reviewed` view model, so missing compact review data is shown as `NR`/unknown rather than silently omitting the section. Reviewed profiles show the standalone Mint Authority Score and band, methodology badge, reviewed mint path, authority posture, confidence, reviewed date, weakest controller, component breakdown, caps, primary controls, cap-mutability evidence, key-custody labels, source links, and `mintIncidents` callout when available.

The display score is computed from `shared/lib/mint-authority-scoring.ts` through the detail view model and `src/lib/mint-authority-display.ts`. It is not a selector exclusion or a Safety Score ranking input. Canonical V9 instead compiles the underlying reviewed mint path, controls, incidents, and upgradeability evidence into Economic Control facts, gaps, and caps.

### Classification taxonomy pills

Below the identity block, the classification line uses `buildGovernanceTaxonomyUrl(coin.flags.governance)`, `buildBackingTaxonomyUrl(coin.flags.backing)`, and `buildPegLandingUrl(coin.flags.pegCurrency)` (which resolves to `/stablecoins/${PEG_SLUGS[coin.flags.pegCurrency]}/` or null). Default flags render as inline sentence links; non-default flags (decentralized governance, algorithmic backing, non-USD peg) render as separate focus-ringed taxonomy pills. No handwritten slugs.

### Price Transparency Card

- **Component:** `PriceTransparencyCard` (`src/components/stablecoin-detail/price-transparency-card.tsx`)
- **Data:** `coinData.price`, `coinData.priceSource`, `coinData.priceConfidence`, `coinData.priceUpdatedAt` from stablecoins API; `consensusSources` and `dexPriceCheck` from peg-summary API
- **Deep-link ID:** `price`; the nested card still carries the legacy `price-transparency` id
- **Mount point:** liquidity zone below `#dex-liquidity`, stacked under the redemption backstop when both render
- **Hidden when:** there is no `coinData`, or both `coinData.price == null` and no `dexPriceCheck`
- Shows current price, source label, confidence badge, source-depth target (`0/3`, `1/3`, `2/3`, or `3+/3`), update recency, and a table of all known price sources with their status (Used/Available/No feed). When protocol-redeem overrides are active, the individual market source rows are hidden and a single "Protocol Redemption" (Used) chip is shown instead. DEX Price Check section renders when `dexPriceCheck` data exists.

### Reserves anchor

When reserves render, `ReservePanel` wraps the treemap block in `<section id="reserves">`. `#reserves` is a stable deep-link anchor inside the Overview zone, not a top-level scrollspy rail pill.

### Explore Next anchor

The outer Explore `SectionBanner` publishes the scrollspy target `#explore`. `ExploreNextSection` wraps itself in `<section id="explore-next">` for existing deep links. The browse grid is `sm:grid-cols-2 xl:grid-cols-3` with columns Taxonomy | Trackers | Actions. A separate Peers block above it shows up to 6 related pills (`related.slice(0, 6)`) with a `See all peers ->` header link to the peg landing page when a peg slug exists, plus a `vs {symbol}` compact-link list that opens the crawlable static comparison brief for each pair.

---

## Fallback And Staleness Rules

On the worker side, `GET /api/stablecoin/:id` now uses a small strategy layer:

- `worker/src/api/stablecoin-detail.ts` handles cache lookup, fresh/stale-cache hit decisions, and single-flight refresh de-dupe, then delegates provider selection
- `worker/src/api/stablecoin-detail/router.ts` (`routeStablecoinDetail`) owns provider selection, branching by commodity / coingecko-only / cache-backed / DefiLlama
- `worker/src/api/stablecoin-detail/commodity.ts`, `coingecko-only.ts`, `cache-fallback.ts`, and `defillama.ts` own provider-specific upstream behavior
- `worker/src/api/stablecoin-detail/shared.ts` owns cache writes, supply-history fallback loading, shared response helpers, and stale-cache vs hard-error response policy

Detail API stale-while-refresh is bounded: rows older than the 5-minute D1 TTL but younger than 24 hours are served with `Warning: 110`, `X-Data-Age`, and `Cache-Control: no-store` while a single-flight refresh runs in the background. Rows older than 24 hours are not served as stale fallback; the Worker refreshes synchronously and returns the normal upstream/supply-history fallback result.

### Reserve presentation

The detail page prefers live reserve data when the coin is live-enabled:

- `liveReserves` API result wins when available
- otherwise it falls back to `getReserves(coin)` from curated/template metadata
- authoritative `live` / `live-stale` reserve responses can carry a separate reserve badge taxonomy: `Live`, `Curated-Validated`, or `Proof`

`ReservePanel` is responsible for translating reserve modes and reserve badge semantics into user-visible notices:

- `live`
- `live-stale`
- `curated-fallback`
- `template-fallback`
- `unavailable`

Live-reserve fetch failures do not take the full page down. They surface as reserve-specific messaging inside the overview section, with a reserve-local retry action when the live-reserve hook can refetch the feed. When report-card data is unavailable, the Reserve View still renders as an Overview sibling instead of depending on the report-card right-column slot.

### Shared stale banner

The page-level stale banner starts with the five page-defining shared presets:

- `stablecoins`
- `pegSummary`
- `dexLiquidity`
- `reportCards`
- `redemptionBackstops`

It also tracks supply history, yield rankings, stress signals, and the enabled mint/burn flow, blacklist, and live-reserve sources. Optional section components use the same source status to show unavailable or stale-with-data notices with retry actions; supported zero-result and unsupported states remain distinct. Depeg history continues to manage its own local loading and error state.

### Retry behavior

`handleRetryAll()` fans out retries for:

- supply history
- stablecoins
- peg summary
- dex liquidity
- report cards
- redemption backstops
- yield rankings
- stress signals
- mint/burn flows for flow-enabled coins
- blacklist summary for blacklist-supported coins
- live reserves for live-enabled coins

That shared retry is used by the page-level error surfaces.

---

## Section Responsibilities

| Section / Component           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HeroCard`                    | Desktop identity/action strip plus compact dossier grid for price, market cap, supply, and 30d excess yield; mobile identity, price/supply deltas, peg metrics, liquidity headline, top-level blacklist / excess-yield / DEWS badges, optional `1Y vs USD` context for eligible non-USD and commodity pegs, feedback entrypoint, and first-touch methodology hints for Peg Score / Liquidity                                                                                                                          |
| `ReportCardDetail`            | Overall Safety Score plus radar/dimension detail, contextual methodology hints, and a methodology footer line                                                                                                                                                                                                                                                                                                                                                                                                         |
| `StablecoinDepegResolverCard` | Per-coin Depeg Duration Resolver readout for active depegs. It lazy-loads after the Safety Score, fetches the shared DDR snapshot only for active-depeg detail pages, and renders only rows matching the current stablecoin before the DEWS block.                                                                                                                                                                                                                                                                    |
| `DepegHistory`                | Historical incident table plus separate public-incident and raw threshold-crossing counts, coverage-aware 90-day peg metrics, and an explicit reviewed-or-assumed PegScore coverage anchor. Zero incidents is descriptive only and is not presented as proof that the asset maintained peg before observation began. |
| `SafetyScoreHistorySection`   | Grade-transition timeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ReservePanel`                | Reserve treemap, reserve/live-fallback notices, reserve retry action, and reviewed reserve source context                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RedemptionBackstopCard`      | Liquidity-zone redemption route card. It distinguishes scored routes from resolved-but-unscored, configured-but-unrated, and impaired route states; eventual-only routes remain visible without being presented as immediate exit capacity.                                                                                                                                                                                                                                                                           |
| `CoinNotices`                 | Coin-specific warnings/info blocks from metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `KeyInfoCard`                 | Classification, collateral, peg mechanism, links, proof-of-reserves, jurisdiction                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MintAuthoritySection`        | Compact, descriptive-only mint-authority review. Always renders; the detail view model supplies an explicit not-reviewed/NR state when no compact review exists. The standalone display score does not feed Safety Score V9; V9 evaluates the underlying reviewed control evidence directly. |
| `McapChart`                   | Historical supply / market-cap chart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DistributionSection`         | Holder and supply distribution view after market history                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PriceTransparencyCard`       | Current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No feed). It is rendered in the liquidity zone under `<section id="price" aria-label="Price transparency">`. When protocol-redeem overrides are active, the individual market source rows are hidden and a single "Protocol Redemption" (Used) chip is shown instead. DEX Price Check section renders when `dexPriceCheck` data exists                                        |
| `YieldDetailSection`          | Yield rankings row, clickable source links, warnings, history chart, alt-source/provenance detail, and contextual PYS / Stability help. Renders for statically yield-bearing coins and for non-yield-bearing coins that currently have a published yield ranking (for example auto-discovered lending coverage).                                                                                                                                                                                                      |
| `DexLiquidityCard`            | Liquidity score, top pools, DEX-implied price context, and contextual methodology hints / footer links. For `unobserved` rows it now shows an explicit no-direct-market state and an unobserved-history panel instead of hiding history entirely.                                                                                                                                                                                                                                                                     |
| `FlowsSection`                | Per-coin mint/burn summary plus the separate `flow-history` event-feed section, with contextual Pressure Shift help on the summary card. It renders inside the top-level `Activity` zone and returns `null` when unsupported; `#flows` is a deep-link anchor, not a top-level scrollspy rail item.                                                                                                                                                                                                                    |
| `BlacklistSection`            | Per-coin blacklist/freeze support summary and event context when the coin is in the blacklist tracker support set                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DepegHistory`                | Historical depeg timeline for non-NAV assets                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ExploreNextSection`          | Related stablecoins, compare pages, and taxonomy/deeper-navigation links                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FaqSection`                  | Data-derived "quick answers" Q&A (`buildStablecoinFaqItems`) rendered after the Explore zone, with `FAQPage` JSON-LD. Server-rendered in both the crawl-state fallback and the hydrated dossier so the structured-data Q&A stays visible in every render state.                                                                                                                                                                                                                                                       |

Composite-score surfaces on the detail page now share a lightweight explainability pattern:

- compact methodology hint trigger attached to the metric label
- mobile sheet / desktop tooltip behavior from the same component
- footer-level `View methodology` + `Version history` actions on the main score cards

## Infrastructure Surfacing

When `StablecoinMeta` includes one or more supported `infrastructures` entries, the detail experience surfaces that infrastructure in three places:

- `HeroCard` renders a prominent infrastructure badge near the identity block so users can immediately recognize coins that share a common technical foundation
- `KeyInfoCard` adds a concise "Infrastructure" explainer line for the classified cohort
- `ExploreNextSection` adds a cohort link into the matching infrastructure hub (for example Liquity v1, Liquity v2, or M0)
