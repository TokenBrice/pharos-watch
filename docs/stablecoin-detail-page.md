# Stablecoin Detail Page

Route contract for `/stablecoin/[id]/`, the central per-asset analytics surface.
> **Agent navigation** — Grep the heading you need: Route Shape · View-Model Contract · Section Order · Fallback And Staleness Rules · Section Responsibilities · Infrastructure Surfacing.

---

## Route Shape

- **Client entrypoint / compositor:** `src/app/stablecoin/[id]/client.tsx` delegates to `src/app/stablecoin/[id]/detail-content.tsx`, which composes the adjacent section-group modules under the same route
- **Yield subroute:** `src/app/stablecoin/[id]/yield/page.tsx` and `src/components/stablecoin-detail/yield-analysis-client.tsx` for yield-bearing coins and curated auto-lending workbenches; known tracked coins without a static workbench redirect to `/yield/?compare=<id>&from=detail-fallback&workbenchFallback=<id>`
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
- passes `ExploreNextSection` (and the FAQ) into `StablecoinDetailClient`, which renders them inside and immediately after the Explore zone
- emits N-level `BreadcrumbJsonLd` plus a Dataset JSON-LD payload for active assets

Active stablecoin Dataset JSON-LD is intentionally static and crawlable: `variableMeasured` advertises price, market cap, circulating supply, Peg Score, DEWS, Safety Grade, and Redemption Backstop coverage. Dataset nodes inline the Pharos `Organization` for `creator` / `publisher`, expose the CC BY 4.0 license URL, carry the stable Pharos coin URN in `identifier`, and set `sameAs` to the canonical Pharos detail URL. Provider/profile URLs belong to the nested `about` Thing's `sameAs`. Frozen assets use archive-specific historical variables, quarantined and delisted records use inactive-listing variables without live claims, and pre-launch assets use conservative `WebPage` / `Thing` JSON-LD.

If the ID is not tracked, the server shell returns a not-found-style fallback instead of mounting the full client.

If the ID is tracked but `coin.status === "pre-launch"`, the server route returns `PreLaunchDetail` instead of mounting the normal detail client.

If the ID is quarantined or delisted, the server route renders a static read-only profile with `ListingStateBanner`, the sourced lifecycle reason, FAQ, breadcrumbs, and conservative structured data. It does not mount live hooks. The Worker detail endpoint may return retained cache for historical context, but it never refreshes providers for a known non-active record; without retained cache it returns `404`.

The `/stablecoin/[id]/yield/` subroute is statically generated only for active coins that are intrinsically yield-bearing or have a curated deterministic auto-lending override. Those durable workbench routes use `noindex,follow` metadata. A lending opportunity can still appear dynamically for another active coin; when no static workbench exists, the Pages stablecoin function redirects that known coin to `/yield/?compare=<id>&from=detail-fallback&workbenchFallback=<id>` (existing yield query state is preserved) instead of serving a dead link. Unknown IDs retain normal static 404 handling. This policy removes low-value empty workbench pages from the Cloudflare export while preserving a useful handoff for runtime discoveries; see [yield-intelligence.md](./yield-intelligence.md) for the per-source APY history contract.

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
- `useReportCardsV9()` for the main Safety Score card
- `useRedemptionBackstops()` for modeled redemption routes
- `useYieldRankings()` for yield-row availability and detail context
- `useStressSignals()` for DEWS detail context
- `useBlacklistSummary()` for blacklist-support and summary badges
- `useMintBurnFlows()` for flow-surface availability checks
- `useStablecoinReserves(id, enabled)` for live reserve presentation, reserve-local retry state, and fetch progress when `coin.liveReservesConfig` exists

Depeg events are not part of the main view model. The `useInfiniteDepegEvents({ stablecoinId, autoLoadAll: true })` hook is called inside the lazily-imported `DepegHistory` component (History zone), which itself only mounts for non-NAV coins. Once mounted, it follows pagination until the complete per-coin event history is loaded. The rendered list opens folded to the newest 6 incidents with pagination hidden (`ShowAllToggle`, "Show all N incidents"); expanding restores the 25-per-page client pagination. `FlowEventFeed` (behind `FlowHistorySection`) applies the same fold to its fetched page — 6 events visible, "Show all N events" restores the server-paged view.

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

`src/app/stablecoin/[id]/detail-content.tsx` composes sections in this order for live/non-pre-launch assets (`client.tsx` delegates to this compositor):

1. `QueryFreshnessNotices` — single banner covering errors and staleness across core, historical, and enabled supplemental detail sources, driven by `viewModel.staleQueries` (in the normal section stream; `QueryErrorNotice` appears only in the `list-error` early-return branch — the not-found branch renders a plain message — not here)
2. `MobileStickySummary` identity prelude when its feature flag is enabled (mounted before the hero block)
3. `HeroCard`
4. `ExploitNoticeBanner`
5. `ListingStateBanner` for quarantined/delisted metadata when the reusable client composition is rendered; the route normally short-circuits quarantined/delisted records to its static server profile
6. `FrozenStateBanner` for frozen tracked assets with `obituary` and `frozenAt`
7. Content grid (Figma coin template): single column below `xl`; at `xl+` an `xl:grid-cols-[minmax(0,1fr)_22rem]` grid places the summary rail beside the main column. The main column opens with the hero block (items 3–6) and then holds everything in items 8–16; the rail is item 17.
8. `AiSummary` when a summary is available (directly beneath the hero block, above the scrollspy nav; the rail tops beside the hero)
9. `LongformScrollspyNav` with the `pill-tabs` emphasis — rounded-full group on the neutral control fill, elevated-neutral active pill, flanking hairline rules at `lg+`
10. Overview zone under a `SectionBanner`: `<section id="info">` first — the full-width `PegStabilityCard` (mechanism diagram + explainer on the left, the curated `collateral` and `pegMechanism` prose on the right; owns `#mechanism`), rendered when `coin.pegMechanism` exists. The section keeps its `id` regardless so the passport's `#info` fallbacks land at the top of the zone. Then an `xl:hidden` pair carrying the rail modules the hidden rail would otherwise take with it: `KeyLinksCard` (with `anchors`, owning `#attestation`) and `ContractDeployments` (owning `#contracts`) → `StablecoinSafetyScoreV9Card` (which embeds `ReservePanel` as its `rightColumn` slot when report-card data is available) → standalone `ReservePanel` when reserve data exists but report-card data is unavailable → an `xl:hidden` in-flow `CustodyCard` copy after the collateralization/failure-domain structure-card pair, rendered only when the coin passes the custody display gate (the rail copy takes over at `xl+`) → `StablecoinDepegResolverCard` when the coin has an active depeg with a DDR row → `CoinNotices` → `DEWSDetail` for non-NAV coins → `FlowsSection` when flows are supported (moved here from the Activity zone per the coin template; the flows query arms when either the overview or activity/history region approaches)
11. Context zone under a `SectionBanner`, ordered by decision weight — the zone-owned modules ("what am I holding") first, the folded review stack (reference material) last: `ContagionSnapshot` (with `UnderlyingAssetCard` or `ParentVariantsCard` passed as the variant relationship card when applicable, and `hasCollateralUsage` driving the collateral-usage row) → always-present `MintAuthoritySection` with reviewed or explicit not-reviewed state → `ReserveQualitySection` when at least one curated reserve slice carries an `assetClass` and at least one carries a `liquidityHorizon` (liquidity-led chip, asset-class mix bar, time-to-liquidate ladder, review-derived unidentified-obligor/self-exposure/top-position facts, folded per-slice risk detail; owns the `#reserve-quality` deep-link anchor, not a scrollspy pill) → `OracleLiquidationSection` when a curated `oracleRisk` profile exists (role-driven title and lead-in, tier verdict, per-branch debt-share facts, folded feeds/parameters/failure-behavior detail; owns the `#oracle` deep-link anchor, not a scrollspy pill) → the `xl:hidden` `RailCopyFold` stack, in order: `MechanismReviewPanel` when a V9 mechanism review exists for the asset (its band owns `#mechanism-review`), then in-flow `BackingMechanicsCard`, `BridgingCard`, `RegulatoryStandingCard`, `ControlPostureCard`, and `FreezeSeizureCard` copies when their respective data exists (their rail copies take over at `xl+`)
12. Market zone under a `SectionBanner` (zone id stays `liquidity`; only the banner and pill label read "Market"): `MarketDataSection` for USD-pegged, non-NAV, non-yield-bearing coins with supply history (otherwise a standalone `McapChart` inside `<section id="chart">`) → `DistributionSection` inside `<section id="distribution">` → `DexLiquidityCard` inside `<section id="dex-liquidity">`; when available, `RedemptionBackstopCard` and `PriceTransparencyCard` render as full-width stacked cards beneath it, in that order — the price-transparency `<section id="price">` carries `xl:hidden` because the rail copy takes over at `xl+`. The chart and distribution mounts moved here from the tail of the Context zone: a market chart behind every review card went unfound by the readers who wanted it, and Context readers paid for its height.
13. Activity zone under a `SectionBanner`: `YieldDetailSection` for yield-bearing coins or coins with a live ranking, and `BlacklistSection` when supported
14. History zone under a `SectionBanner`: `TapeForCoinTeaser` inside `<section id="coin-timeline">` (`xl:hidden`; the rail copy takes over at `xl+`), `SafetyScoreHistorySection`, `DepegHistory` for non-NAV coins, `DdrTrackRecordSection` directly after it for non-NAV coins (renders nothing while the DDRR review query is in flight and for coins the feed carries no reviewed publication for; owns the `#ddr-track-record` deep-link anchor), `FlowHistorySection`, and `BlacklistHistorySection`
15. Explore zone under a `SectionBanner` when `exploreNextContent` is provided
16. `faqContent` (`FaqSection`) — server-passed Q&A block rendered after the Explore zone, before the feedback modal
17. Summary rail `<aside aria-label="Coin summary rail">` (`hidden xl:block`, normal-flow page content without sticky positioning or a nested scroll container): `RailSafetySummary` → `ScoreConstructionPanel` → `AccessPosturePanel` → `CollateralizationCard` → `BackingMechanicsCard` → `CustodyCard` → `ControlPostureCard` → `FreezeSeizureCard` → `FailureDomainsCard` → `MechanismReviewPanel` → `BridgingCard` → `RegulatoryStandingCard` → `PriceTransparencyCard` → `ContractDeployments` → `TapeForCoinTeaser` → `KeyLinksCard`, with conditional cards omitted when their evidence is unavailable. Responsive duplicate cards render id-less in the rail; their `xl:hidden` in-flow copies carry the same content below `xl`. Below `xl` the custody, mechanism-review, backing-mechanics, bridging, regulatory-standing, control-posture, and freeze-seizure copies render inside `RailCopyFold` (`src/components/stablecoin-detail/rail-copy-fold.tsx`) — a collapsed-by-default native `<details>` band that keeps the title plus the card's status chip visible and folds the card body.
18. `FeedbackModal`

Active pages render only an `sr-only` server-owned `h1` before the client island so the hydrated dossier begins with the coin hero. The `Suspense` crawl-state fallback places `StablecoinDetailSeoContent` and the data-derived FAQ after its hero/loading shell, preserving meaningful static HTML without putting either block ahead of the identity. `StablecoinDetailSeoContent` also remains the static read-only profile for quarantined and delisted records. The server shell passes `ExploreNextSection` and the FAQ into `StablecoinDetailClient`; the client renders them inside and immediately after the Explore zone, respectively.

Detail experiments remain source-gated: hero verdict, depeg resolver, and the DDR reviewer feed (`depegResolverReviewer`, which gates `DdrTrackRecordSection`) default on; blacklist banner, quiet deviations, mobile sticky summary, and chart annotations default off. [`process/feature-flags.md`](./process/feature-flags.md) owns the bindings, defaults, and expiry policy.

### Scrollspy vs section rules

- `LongformScrollspyNav` renders once as a sticky horizontal pill banner after the identity zone. On `lg+` it stays full-width with the `Jump to` label and section pills centered inside the banner instead of reserving a right-side rail column, so the dossier sections keep the full content width.
- `LongformScrollspyNav` pill order is: `overview` (Risk), `context`, `liquidity` (labelled "Market"), `activity`, `history`, `explore`. Pill labels are presentation only — the zone ids, and every deep link that targets them, are stable. Child cards can still expose deep-link anchors such as `#report-card`, `#reserves`, `#reserve-quality`, `#ddr-track-record`, `#mechanism-review`, `#mint-authority`, `#redemption`, `#price`, `#chart`, `#yield`, `#flows`, `#blacklist`, `#coin-timeline`, and `#explore-next` — plus the passport sub-anchors `#mechanism` (`PegStabilityCard`), `#attestation` (the in-flow `KeyLinksCard` copy), `#jurisdiction` (the in-flow `RegulatoryStandingCard` fold), and `#contracts` (the in-flow `ContractDeployments` copy) — but they are not top-level scrollspy pills. The three in-flow anchor owners are `xl:hidden`; at `xl+` their rail twins carry `data-anchor-twin` so `alignSection` in `hero-passport-strip.tsx` still finds a visible target. `ControlPostureCard` deliberately has no anchor or scrollspy pill because its rail and in-flow copies coexist in the DOM at responsive breakpoints.
- Section ids are stable; do not rename them. In particular, the top-level Explore pill targets `#explore`; the reusable `ExploreNextSection` keeps its inner `#explore-next` anchor for existing deep links. Below `lg`, its static-comparison grid shows only the first 4 briefs — the rest stay in the DOM behind `hidden lg:flex` (links remain crawlable) with a `+N more comparison briefs` link to the peg-family page.
- The outer detail composition owns the single `#overview` anchor. Nested overview subcomponents do not publish a second `#overview` id.
- `UnderlyingAssetCard`, `ParentVariantsCard`, and `CollateralUsageSection` render inline within the context zone (inside `ContagionSnapshot`) and are not top-level scrollspy entries.
- `ControlPostureCard` renders after `CustodyCard` in the `xl+` summary rail and, as an `xl:hidden` in-flow copy folded inside `RailCopyFold`, immediately before the `FreezeSeizureCard` copy that closes the Context zone's folded review stack. It appears only when the legacy `governanceQuality` field is authored, labels the concept as **Control posture**, and explicitly presents the classification as descriptive rather than scored. Its six-cell category map has no numeric marker or safer direction; dense taxonomy, scoring, and variant distinctions stay folded behind `Classification details`. The footer links to methodology but does not claim sources or a reviewed date because the field has no dedicated sourced review object.
- `ContagionSnapshot` uses the shared dependency graph in `minimalChrome` mode, and takes the wider column (`3fr`) of the split against the variant and collateral-usage rail (`2fr`). On detail pages, crowded maps keep the compact node treatment with a 1.33x internal logo zoom; maps with 10 or fewer visible stablecoins render ticker labels and 1.5x node/text scale, and maps with 5 or fewer visible stablecoins use 2x scale. Raster token logos are capped at `MAX_RASTER_LOGO_RADIUS` so a scaled-up sparse map never upscales a 50px source into pixelation; vector logos are exempt.
- `DistributionSection` renders after the chart in the Market zone, outside the top-level rail.
- `DepegHistory` is omitted for NAV tokens, but the top-level history section remains mounted for timeline and score-history content.
- `YieldDetailSection` decides its own empty/loading/null behavior from the cached yield rankings plus static coin metadata. Non-yield-bearing coins can still render the section when the yield stack publishes a live lending-opportunity or curated ranking row for that asset.

### Compact desktop hero / SafetyGradeHero (mobile)

On `lg+` the hero starts with a desktop-only identity/action strip above the metric card: a single identity row containing the 56px coin logo (shared with the loading shell), ticker, and name, followed by the one-line description beneath it; up to three source links plus report/compare/share controls sit opposite. The loaded mobile identity uses the same logo size so hydration does not shrink the asset mark. On `<lg`, the logo sits beside only the name/ticker (and any variant chip); the classification and infrastructure chips plus the Bluechip badge move into a full-width row below that identity block so they wrap as one flow. Below it, the hero renders as a compact dossier card with no internal action/header band: a top chip rail (derived archetype verdict, peg, backing, governance, and launch date), a four-cell divider grid (`Price`, `Market Cap`, `Supply`, and the live `30d Excess` benchmark gap), then the compact passport row. The old desktop `HeroSignalsRail` no longer renders in the hero; Safety / Peg / Liquidity / DEWS live in the `xl+` summary rail. On `<lg` the hero still renders the visible identity block, mobile actions, and `SafetyGradeHero` because the Safety Score card is far down the scroll on narrow screens. The verdict chip vocabulary is `Pre-launch`, `Quarantined Record`, `Delisted Record`, `Frozen Archive`, `Distressed` (alert), `Low Safety Score` (watch), `Yield-Bearing Hybrid`, `Decentralized Benchmark`, `Institutional Default`, and `Uncategorized`, which renders nothing.

Hero tertiary metric chips below the identity block are mobile-only live signals: on `<lg` a 2x2 grid of `DEWS`, `Peg`, `Liq`, `30d Excess` with optional `1Y vs USD` beneath. On `lg+`, the compact metric grid owns the 30d benchmark gap and the summary rail owns Safety / Peg / Liquidity / DEWS. Freeze and chain facts live in the hero passport strip below.

NAV tokens are displayed as NAV in the hero Peg rail and do not consume their own peg-score, active-depeg, deviation, or depeg-event fields for verdict labeling. The `Distressed` verdict is reserved for *measured* distress — an active depeg or a DEWS `WARNING`/`DANGER` band — for every asset, NAV or not. A weak Safety Score alone resolves to `Low Safety Score` (`watch` tone), which names the measurement rather than asserting that the asset is failing; that rule keeps its place ahead of the archetype-driven yield-hybrid and benchmark rules, so a badly rated coin is still surfaced — the one branch still resolving first is the NAV + yield-bearing hybrid. `RISKY_GRADES` on the published ladder is exactly `{D, F}` — the ladder has no `D+`/`D-`. Pure NAV rows also omit the Record passport item and `DepegHistory`.

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
| Jurisdiction  | `COUNTRY_PASSPORT_CODES[jurisdiction.country]` short form (full country/regulator/license stack in the tooltip and aria), else muted `Not disclosed`                                                      | `#jurisdiction` when `buildRegulatoryStandingView` resolves (`#info` for decentralized coins and for any coin with no curated regime)                                                                                                                                                                      |
| MiCA          | `MICA_STATUS_BADGE_STYLES[status].label` (status text tone via `textCls`)                               | `#jurisdiction` (the MiCA badge in the jurisdiction block); omitted without `coin.mica`; frozen assets carry a `Historical MiCA` aria prefix                                                                                                      |
| GENIUS        | `GENIUS_STATUS_SHORT_LABELS[authorizationStatus]` (text tone via `GENIUS_STATUS_TEXT_CLS`)              | `/compliance/?regime=genius` (off-page — no in-page GENIUS section yet); omitted without `coin.genius` and for `not-applicable`/`unknown`; the aria frames _pathway_ status with `GENIUS_REGIME_STATE.effectiveDate`, never a present-day license |
| Attestor      | `ATTESTOR_PASSPORT_LABELS[attestorTier]` (full `POR_TIER_STYLES` label in the aria; tier text tone via `textCls`), or PoR type label                               | `#attestation`; omitted for decentralized coins or missing PoR                                                                                                                                                                                    |
| Issued        | launch year from loose-validated ISO `coin.launchDate`; full UTC date in the aria-label                 | `#info` (the top of the Overview zone; the full date renders nowhere else on the page); omitted while the date is absent or malformed                                                                                                                                                |

Values are authored-short and never CSS-truncated; on `<lg` the row is a snap-scroll carousel with a right-edge fade. On `lg+`, the row switches to a fixed compact grid with internal vertical dividers; `Mechanism` is omitted from the desktop row because the top verdict/classification chip rail carries that scan-level role. Hash entries intercept the click and re-align with a retry cadence of 160/480/960/1800 ms because deep targets sit below lazy sections whose height settles after the jump starts; targets carry sticky-chrome scroll clearance. Each fact has exactly one hero home, and the strip hides entirely if fewer than three facts resolve.

### Mint Authority section

`MintAuthoritySection` always renders in the Context zone. `src/lib/stablecoin-detail-mint-authority-view-model.ts` projects either a reviewed profile or an explicit `not-reviewed` view model, so missing compact review data is shown as `NR`/unknown rather than silently omitting the section. Reviewed profiles show the published V9 mint component score and posture band, the derived posture, the structural caps that posture raised, methodology badge, reviewed mint path, curated authority-posture annotation, confidence, reviewed date, primary controls, cap-mutability evidence, key-custody labels, source links, and the `mintIncidents` callout when available.

Since safety `9.1` the card renders the published V9 mint component, read through `readV9CardMintComponent` and projected by `src/lib/mint-authority-display.ts`. There is no second mint score and no browser recomputation: the same component drives the Economic Control pillar. The retired standalone engine's route/controller/bounds/posture decomposition, confidence cap, and weakest-control trace have no counterpart in the pillar and are not shown; the curated control rows, custody labels, and incident callout remain because they describe the review rather than score it.

### Mechanism Review section

`MechanismReviewPanel` renders twice: in the summary rail between failure domains and bridging at `xl+`, and as the first card in the Context zone's folded review stack below `xl`. Neither treatment carries an anchor id or a breakpoint class of its own — the in-flow copy mounts inside an `xl:hidden` `RailCopyFold` band that owns both `#mechanism-review` and the visibility gate, so the two never both show and the anchor lands on the collapsed header rather than a folded card body. Both carry the reviewed evidence behind the Backing pillar's mechanism component scores: the resolved archetype (labelled through `MECHANISM_ARCHETYPE_LABELS`), the review date, the dated analyst notes, the full labelled source list, and a link to the archetype explainer.

`src/lib/mechanism-review.ts` extracts the view at build time from `shared/data/safety-score-v9/mechanism-review-overlays-v1.json` and is a **server-only import** — the overlay JSON is roughly 1 MB and must never enter a client bundle, so `page.tsx` builds the slim view object and threads it down as a prop, the same pattern as `mechanism-collateralization.ts`.

Per-dimension mechanism quality ratings (`strong` / `adequate` / `limited` / `weak` / `failed`) are deliberately **not** extracted or published. Publishing them would introduce a public rating vocabulary, which is methodology-visible; the reviewed prose and its sources are not, because they only explain component scores the report card already publishes. A test pins the public view shape so the ratings cannot leak back in. The section hides when the asset has no overlay, or when the overlay carries no notes or no sources.

The compact rail treatment cuts the notes to a ~150-character lead (`RAIL_PROSE_LEAD_CHARS`, roughly three rail lines — a string cut, never `line-clamp`) behind one `Read more` control, because reviewed notes run to roughly 1,700 characters on the median asset and past 6,000 on the longest — neither fits a 22rem column unfolded. The in-flow section uses the full card width; notes longer than the collapse threshold render a roughly 320-character lead behind one `Read the full review` control, while shorter notes render whole without a toggle. Citations fold separately behind the `EvidenceFooter`'s `Sources (N)` control, which stays collapsed by default in both copies. Only the in-flow copy carries the `#mechanism-review` anchor.

### Access posture evidence

`AccessPosturePanel` renders the four scored access enums in the summary rail at `xl+` (compact) and inside the Safety Score card below `xl`. When `src/lib/transfer-review.ts` resolves a build-time view from `shared/data/safety-score-v9/transfer-review-overlays-v1.json` (server-only import, same slim-prop pattern), both copies gain a `How this was verified` disclosure listing every reviewed deployment: chain, scope (`Canonical` / `Bridged` / `Additional`), posture, the reviewer's written finding, and its citations. That disclosure is the evidence for restrictive postures; inventory counts belong to generated coverage audits rather than this page. Assets whose posture differs by chain carry an explicit note that the summary rows report the strictest posture. Every label is precomputed at build time so the client never imports the overlay.

### Score construction

`ScoreConstructionPanel` merges the score arithmetic and its causes into one module, because they read as one thought. It reconciles the pillar bars with the headline — pillar quality, then the measured peg multiplier, then common-mode deployment points, then any binding cap — and follows it with `Why not higher`: what was measured and found adverse, and what stayed unresolved, grouped by whose gap it is. `src/lib/safety-score-v9-waterfall.ts` builds the steps; `buildSafetyScoreV9Attribution` in the presentation module builds the causal split without rebuilding all three pillar breakdowns.

It renders twice, the same split `#price` uses: compact in the summary rail directly beneath `RailSafetySummary` at `xl+`, and `xl:hidden` inside the Safety Score card below `xl`. The rail copy drops the per-step hint lines, which triple the module's height at 22rem. The waterfall renders only when a stage actually moved the number, and its cap row is labelled `Cap applied` because `CapSection` inside the card owns the `Binding cap` heading and its reason prose.

Moving this module out of the card also retired the header trace line (`Pre-cap … · Peg x… · Deployment …`), which the module states more legibly; the header keeps only the evidence-coverage summary. Pillar rows likewise dropped the `Pillar score` label and the trailing score repeat — the header row already carries the number and its grade band, so the same value was printed three times per pillar. The score bar remains as `aria-hidden` decoration.

Inside an expanded pillar, the measurement context grid collapses behind a `Measurement detail (N)` disclosure once it exceeds two rows. That is aimed at the exit pillar's route measurements, which run to six rows of long key/value prose; its labels wrap rather than truncate, so `Selected route capacity` no longer renders as `Select…`.

The panel and the rail metric cards are complementary, not duplicative: `CollateralizationCard` carries measured ratios for reviewed CDP overlays and `BackingMechanicsCard` carries the delta-neutral, RWA credit-fund, and algorithmic metrics plus reviewed gaps, while the panel carries the narrative and provenance for reviewed archetypes — including fiat-cash and tbill, which carry no quantitative metrics at all. The source registries and their audits own the changing inventory counts.

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

### Build snapshot hydration

The compile-input generator `scripts/build-data/build-stablecoin-detail-snapshots.ts` fetches and validates the coin-scoped `/api/stablecoin/:id` response, projects it to current price, four supply checkpoints, and observation timestamps, and fetches the 90-day first-paint supply-history response. Provider token history and passthrough research fields are never stored in the compact summary. The generator writes one gitignored JSON snapshot per tracked coin under `src/generated/stablecoin-detail-snapshots/`; a missing lane is omitted rather than represented by invented data. It never projects a single row into the global stablecoin-list or peg-summary cache keys. The 90-day window matches the Market Data chart's initial selection. Selecting `1Y` or `All` enables a distinct 1,825-day supply-history query and switches both charts to that response when it arrives, so the wider controls retain their full-history meaning without adding a first-paint request. The generator enforces 8 KiB as a hard serialized-envelope cap: it drops supply history first, then the compact live summary only if necessary. An empty per-coin envelope remains valid because the static page still renders its build-time catalog metadata.

Credentialed local runs read the authoritative API (`PHAROS_API_KEY`, or `SITE_API_SHARED_SECRET` via the site-API origin). CI bootstraps and Pages release builds carry no API secret, so without a configured generator base or key the generator reads the same public GET-only `/_site-data` lane the release refresh uses (`https://stablecoin-dashboard.pages.dev/_site-data`); both the coin-detail and supply-history paths are on that lane's allowlist. A 404 for an inactive catalog record omits the lane exactly as on the authenticated path.

During static export, the server page reads only the current coin's file and passes it through the client boundary. The client seeds React Query only under the registered `stablecoin-live-summary` and per-coin supply-history keys with `dataUpdatedAt = snapshot.generatedAt`. The full `stablecoin-detail` key is not seeded. Producer-derived `staleTime` and `refetchInterval` remain unchanged, so fresh build lanes avoid their initial requests while an aged snapshot refetches normally. Peg summary remains an unseeded global query. Existing market and page-level freshness affordances use the preserved query timestamp; the snapshot is not labelled live.

Report cards, liquidity, redemption, yield, stress, flows, blacklist, and reserves remain interaction/viewport-gated. The page-wide retry action includes only failed eager or currently enabled supplemental lanes.

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
| `StablecoinSafetyScoreV9Card` | Overall Safety Score V9 plus radar/dimension detail, contextual methodology hints, and a methodology footer line; its header carries an inline coin lockup (logo · ticker · `Safety Score`) so standalone screenshots retain the subject, omitted when no symbol is passed |
| `StablecoinDepegResolverCard` | Per-coin Depeg Duration Resolver readout for active depegs. It lazy-loads after the Safety Score, fetches the shared DDR snapshot only for active-depeg detail pages, and renders only rows matching the current stablecoin before the DEWS block.                                                                                                                                                                                                                                                                    |
| `DepegHistory`                | Historical incident table plus separate public-incident and raw threshold-crossing counts, coverage-aware 90-day peg metrics, and an explicit reviewed-or-assumed PegScore coverage anchor. Zero incidents is descriptive only and is not presented as proof that the asset maintained peg before observation began. |
| `SafetyScoreHistorySection`   | Grade-transition timeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ReservePanel`                | Reserve treemap, reserve/live-fallback notices, reserve retry action, and reviewed reserve source context                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RedemptionBackstopCard`      | Liquidity-zone redemption route card. It presents one standalone route score (never the legacy effective-exit blend), distinguishes scored routes from resolved-but-unscored, configured-but-unrated, and impaired route states, and keeps eventual-only routes visible without presenting them as immediate exit capacity.                                                                                                                                                                                          |
| `CoinNotices`                 | Coin-specific warnings/info blocks from metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PegStabilityCard`            | Full-width Overview-zone module: the mechanism flow (vertical numbered steps for the three-step archetypes, bespoke horizontal diagrams for wrappers and synthetic-delta-neutral, a custom-design notice when no archetype resolves) plus the explainer CTA on the left, and the curated `collateral` / `pegMechanism` prose on the right. Owns `#mechanism`. The `tbill` archetype resolves two diagram variants from the coin's `flags.navToken` through `resolveThreeStepConfig`: NAV-accreting fund shares keep the "NAV accrues daily" third step and draw no redeem loop, while the 25 `navToken: false` coins get "`SYMBOL` minted / redeem 1:1", a redeem return arrow, and a redemption-gate stress footnote. Wrapper parent panels take the parent's flag via `parentNavToken`, never the wrapper's own — three of the seven `tbill`-parent wrappers carry the opposite flag from their parent. Replaced `KeyInfoCard`, retired 2026-08-17: its classification chips, jurisdiction, MiCA, attestor tier, and launch date are all in the hero passport strip, its regime detail in `RegulatoryStandingCard`, and its contracts list in `ContractDeployments`. |
| `KeyLinksCard`                | Rail card after `TapeForCoinTeaser` (with `xl:hidden` in-flow copy in the Overview zone) holding what the retired `KeyInfoCard` uniquely carried: the curated outbound `links` plus the proof-of-reserves attestor line and its `View reserves` link. The in-flow copy takes `anchors` and owns `#attestation`; the rail copy marks itself as that anchor's twin. Renders nothing when the coin has neither links nor an attestation. |
| `MintAuthoritySection`        | Compact mint-authority review plus the published V9 mint component. Always renders; the detail view model supplies an explicit not-reviewed/NR state when no compact review or no publication exists. The score and posture band are the Economic Control pillar's mint component, not a second engine. |
| `CustodyCard`                 | Rail card (with `xl:hidden` in-flow copy in the Overview zone) built from the reviewed `custodyProfile` (server-only field, client-projected as `custodyProfileSummary` via `projectCustodyClientSummary`): provider roster with share bars including an explicit undisclosed-share slice, segregation / bankruptcy-remoteness / rehypothecation facts with a derived posture badge, and folded sources carrying the review's uncertainty note. Gated server-side in `buildStablecoinDetailClientCoin` via `shouldDisplayCustodyModule`: an explicit curated `custodyModel` wins (suppressed only when `"onchain"`), otherwise the resolved mechanism archetype suppresses `cdp`/`algorithmic` coins; the resilience-defaults inference is deliberately not used because it would also hide genuinely custodial coins. No prose folding — the summary is one bounded sentence. |
| `RegulatoryStandingCard`      | Rail card (with `xl:hidden` in-flow copy in the Context zone, whose `RailCopyFold` band owns `#jurisdiction` — the passport's Jurisdiction and MiCA target; the rail copy is its `anchorTwin`) built from the coin's `genius` and `mica` profiles via `buildRegulatoryStandingView`: per-regime status facts (the regulator fact prefers the bounded `primaryFederalRegulator` enum; absent that, free-form regulator prose is sliced at the first delimiter with the untrimmed string carried as the FactGrid cell's `title`), the GENIUS obligations checklist (monthly attestation / redemption policy / reserve disclosure with report link and date), a badge for the strongest active regime, and merged deduplicated references. Renders only when at least one regime profile is curated and relevant; no prose folding. |
| `OracleLiquidationSection`    | Context-zone module (after `ReserveQualitySection`, last before the folded review stack) built from the reviewed `oracleRisk` profile (server-only field, client-projected as `oracleRiskSummary` via `projectOracleRiskClientSummary`): tier verdict, worst-case max-LTV / min-CR / liquidation-delay facts with percentages formatted to at most 2 decimals, and branches sorted by debt share (null shares last) with the top 6 shown inline and the remainder folded into the "Feeds, parameters & failure behavior" `ModuleDisclosure` alongside per-branch feeds, collateral parameters, liquidation mechanism/delay, backstop, and fallback/shutdown behavior. A per-branch tier kicker renders only when it diverges from the profile tier. The heading and a muted lead-in line come from `oracleRisk.role`, so the two price-authority roles never read as one thing: `collateral-pricing` titles "Collateral pricing & liquidation" and frames the feed as core solvency machinery, `coin-price-feed` titles "Price feed" and frames the exposure as sitting with whoever consumes the price. Profiles predating the field fall back to `resolveOracleRiskRole`, which mirrors the curated backfill rule. Summaries longer than ~420 characters fold to a ~320-character lead behind a "Read more" control, the same rule `BridgingCard` uses. Renders whenever a curated `oracleRisk` profile exists; owns the `#oracle` deep-link anchor, not a scrollspy pill. |
| `ReserveQualitySection`       | Context-zone module (between `MintAuthoritySection` and `OracleLiquidationSection`) built from the curated reserve slices' quality attributes plus the server-only `reserveReview` (client-projected as `reserveQualitySummary` via `projectReserveQualityClientSummary`): a liquidity-led chip (`Highly liquid` ≥90% convertible within one day, `Mostly liquid` ≥60%, `Opaque exit` when the unknown-horizon share is ≥40%, otherwise `Mixed liquidity`), a generated lede, a categorical asset-class mix bar (top 5 classes plus a folded muted tail), a time-to-liquidate ladder carrying severity tones on the bar and figure, with the unknown tier deliberately neutral (absence of evidence is not an alarm), and review-derived facts: unidentified-obligor share (`knownUnknownExposurePct`, amber when >0), self-exposure (sum of `self-reserve` non-link dispositions), top position (only when >1 slice, ≥20% share, and the slice risk is medium or worse), composition as-of date, slice count, and confidence. Per-slice asset class, horizon, risk, obligor, and risk factors fold into the "Slice detail & risk factors" `ModuleDisclosure` together with the review's composition basis and known-unknown prose. Aggregates only the curated composition — never the live reserve feed or category templates, which carry no quality attributes. The lede's convertibility clause branches on the undisclosed share, because an undisclosed liquidation timeline is an absence of evidence and never a zero: a fully undisclosed ladder emits no percentage at all ("no published exit timeline for any of the basket"), a partly undisclosed one leads with "at least X% convertible within one day" so the figure reads as a floor rather than a measurement of the whole basket, and a fully disclosed one keeps the plain "X% convertible within one day". Renders only when at least one slice has an `assetClass` and at least one has a `liquidityHorizon`; owns the `#reserve-quality` deep-link anchor, not a scrollspy pill. |
| `FreezeSeizureCard`           | Rail card (with `xl:hidden` in-flow copy that closes the Context zone's folded review stack, directly after the `ControlPostureCard` copy) built from the server-only `blacklistabilityReview` (client-projected as `blacklistabilitySummary` via `projectBlacklistabilityClientSummary`): a status chip (`Freezable`/`Possible` amber, `Not freezable` emerald, `Inherited` blue), a one-line status note that names the upstream asset when the freeze power is inherited (resolved through `variantOf`, then `mintAuthority.inheritedFrom`; inherited reviews with neither — basket-mediated protocol tokens like DAI — read "upstream in the assets this token depends on"), the review's evidence prose folded to a lead, `Freeze power`/`Basis` facts (basis = `Sourced review` / `Rationale only` / `Unsourced` provenance, not status), the source-free rationale when present, and an `EvidenceFooter` with sources and the reviewed date. Covers the *power* to freeze; `BlacklistSection` covers observed *usage*. Renders whenever a review exists; current coverage belongs to the registry audit, not a universal prose promise. Like `ControlPostureCard`, it has no anchor id because rail and in-flow copies coexist in the DOM. |
| `DdrTrackRecordSection`       | History-zone module (directly after `DepegHistory`, non-NAV coins) built from the public DDRR review feed (`useDepegResolverReview`, gated on the resolver + reviewer feature flags) via the pure `projectDdrTrackRecordSummary(data, stablecoinId)`: the accountability trail for the coin's frozen first-published DDR forecasts. Header chip `N/M correct` (emerald all-correct / amber mixed / red none), else `N maturing`, else `Unscored`. Facts: forecasts, correct ratio, median absolute duration miss, maturing, no-calls, not-called coverage rows, invalidated. Up to 6 incident rows newest-first as a ledger — date, verdict/coverage chip, actual outcome, errata marker, signed duration error — with the remainder folded into a count and a `Full DDRR review` link to `/depeg`; verdict/coverage/outcome/duration vocabulary and tones are copied verbatim from the /depeg reviewer module so both surfaces name outcomes identically. Deliberately not a forecast timeline — DDR keeps the forward-looking language (owner ruling). Renders nothing while the query is in flight and for coins with only coverage rows; owns the `#ddr-track-record` deep-link anchor, not a scrollspy pill. |
| `SafetyScoreHistorySection`   | History-zone grade timeline combining the legacy V8-compatible archive with identity-aware V2 rows. Consecutive same-grade baselines collapse into one streak; a grade-changing methodology boundary remains dated and reads `Methodology baseline`, never an organic upgrade/downgrade. |
| `BridgingCard`                | Rail card (with `xl:hidden` in-flow copy in the Context zone) built from the reviewed `bridgeRouteRisk` profile (server-only field, client-projected as `bridgeRouteRiskSummary`): route-risk tier badge, route/chain/confidence/third-party-route FactGrid, and folded sources. Summaries longer than ~420 characters fold to a ~320-character lead behind a "Read more" control. Renders only when a bridge review exists — most single-chain coins render nothing. |
| `McapChart`                   | Historical supply / market-cap chart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DistributionSection`         | Holder and supply distribution view after market history                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PriceTransparencyCard`       | Current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No feed). It is rendered in the liquidity zone under `<section id="price" aria-label="Price transparency">`. When protocol-redeem overrides are active, the individual market source rows are hidden and a single "Protocol Redemption" (Used) chip is shown instead. DEX Price Check section renders when `dexPriceCheck` data exists                                        |
| `YieldDetailSection`          | Yield rankings row, clickable source links, warnings, history chart, alt-source/provenance detail, and contextual PYS / Stability help. Renders for statically yield-bearing coins and for non-yield-bearing coins that currently have a published yield ranking (for example auto-discovered lending coverage).                                                                                                                                                                                                      |
| `DexLiquidityCard`            | Aggregate DEX market-liquidity score, source freshness, top pools, DEX-implied price context, and contextual methodology hints / footer links. It is explicitly separate from V9's single-route Exit test. For `unobserved` rows it shows an explicit no-direct-market state and an unobserved-history panel instead of hiding history entirely.                                                                                                                                                                      |
| `FlowsSection`                | Per-coin mint/burn summary in the Overview zone plus the separate History-zone `FlowHistorySection`, with contextual Pressure Shift help on the summary card. It returns `null` when unsupported; `#flows` is a deep-link anchor, not a top-level scrollspy rail item.                                                                                                                                                                                                                    |
| `BlacklistSection`            | Per-coin blacklist/freeze support summary and event context when the coin is in the blacklist tracker support set                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ExploreNextSection`          | Related stablecoins, compare pages, and taxonomy/deeper-navigation links                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FaqSection`                  | Data-derived "quick answers" Q&A (`buildStablecoinFaqItems`) rendered after the Explore zone, with `FAQPage` JSON-LD. Server-rendered in both the crawl-state fallback and the hydrated dossier so the structured-data Q&A stays visible in every render state. The "Is X safe?" answer (also mounted in the Answer First card) tiers on the release-time Safety Score grade from the committed `scores-latest` dataset mirror via `src/lib/safety-grade-snapshot.ts`, using the shared safe/neutral/risky buckets from `shared/lib/safety-grade-buckets.ts` (safe = B− and up); unrated coins and frozen/quarantined/delisted records keep grade-free wording. |

Composite-score surfaces on the detail page now share a lightweight explainability pattern:

- compact methodology hint trigger attached to the metric label
- mobile sheet / desktop tooltip behavior from the same component
- footer-level `View methodology` + `Version history` actions on the main score cards

## Infrastructure Surfacing

When `StablecoinMeta` includes one or more supported `infrastructures` entries, the detail experience surfaces that infrastructure in two places:

- `HeroCard` renders a prominent infrastructure badge near the identity block so users can immediately recognize coins that share a common technical foundation
- `ExploreNextSection` adds a cohort link into the matching infrastructure hub (for example Liquity v1, Liquity v2, or M0)
