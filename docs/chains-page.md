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
- **Methodology version source:** `shared/lib/methodology-versions/registry.ts`
- **Scoring implementation:** `shared/lib/chains/health.ts`, `shared/lib/chains/aggregator.ts`, `shared/lib/chains/index.ts`
- **Chain registry and identity:** `shared/types/chain-identity.ts` owns `CHAIN_META`, chain types, and display-name/alias normalization; `shared/lib/chains/index.ts` owns derived provider maps and resilience tiers.
- **Shared chain UI helpers:** `src/lib/chain-ui.ts` (formatting; re-exports the health band maps)
- **Health band presentation authority:** `shared/lib/classification/chain-health.ts` (labels, hex, pennant count, badge/text/fill classes; consumed by the frontend, the Harbor scene and the Worker OG cards)
- **Harbor view model and geometry:** `shared/lib/harbor-scene.ts`, `shared/lib/harbor-scene-geometry.ts` (runtime-neutral; Worker-importable)
- **Harbor island:** `src/components/harbor/` (`HarborHero`, `HarborSceneSvg`, `HarborRecordCard`, `HarborLegend`, `HarborSelectionProvider`)
- **Active chain derivation:** `getActiveChainIds()` in `shared/lib/chains/index.ts`

The freshness wire contract is `ChainsFreshnessMetaSchema` in `shared/types/chains.ts`, composed from the shared API metadata schemas. Its optional `dependencies` object requires `reportCards` when present; only that dependency may report `unavailable`, while the envelope uses `fresh`, `degraded`, or `stale`. Since 2026-09-28 the unused V8 fields `_meta.dependencies.reportCards.inputsStale` and `staleInputs` are removed from the public contract. Dependency status, age, and reason retain their existing semantics.

Chain supply history is a separate internal forward baseline collected by `worker/src/cron/snapshot-chain-supply.ts`; it is not read by this live API or chart. The 2026-10-08 decision keeps collection enabled. A public historical supply chart remains activation-gated on product scope, an explicit provenance-approved UTC baseline strictly after 2026-04-08, range/gap semantics and measured bounded reader capacity. The latest completion marker cannot certify the archive, missing days cannot become zero/interpolated values, and a missing/rejected reader packet never authorizes stopping the collector. See [Supply Snapshot](./supply-snapshot.md#chain_supply_history).

The leaderboard is public and indexable. The profile routes are statically generated from `getActiveChainIds()`, which currently returns the sorted `CHAIN_META` key set.

`CHAIN_META` membership is not only a display concern. `resolveChainId()` is what turns a raw DefiLlama supply label into a canonical chain identity, so an unregistered label is pooled into the Safety Score V9 uncanonicalized-chain-label row (`worker/src/lib/safety-score-v9/extension-supply.ts`). Above the common-mode materiality floor that pool fails closed into `unresolved-control-identity`, no matter how well the asset's other deployments are reviewed. Registering a chain is therefore the precondition for attributing its supply — it names the chain, but a reviewed `bridgeRouteRisk` route for that chain is still what clears the residual.

RISE (`rise`, EVM chain ID 4153, explorer `https://explorer.risechain.com`, resilience tier 3), Somnia (`somnia`, EVM chain ID 5031, explorer `https://explorer.somnia.network`, resilience tier 3), and Filecoin (`filecoin`, EVM chain ID 314, explorer `https://filecoin.blockscout.com`, resilience tier 2) are registered chain profiles. Filecoin contract addresses identify its FEVM interface. The DefiLlama stablecoin chain labels `RISE`, `Somnia`, and `Filecoin` resolve through the canonical keys/display names without redundant aliases. Each registration supplies its official chain artwork and joins the statically generated chain-profile directory.

Somnia and Filecoin have verified CoinGecko asset-platform/onchain-network and GeckoTerminal network registrations, enabling token-pool discovery. Filecoin's USDFC endpoint returned four pools at review; Somnia's USDso endpoint returned an empty pool census, not an unsupported-chain response. RISE has no verified token-pool provider registration and retains the unsupported-scope explanation. No DexScreener registration was verified for any of these three chains.

The official keyless RISE, Somnia, and Filecoin endpoints are registered only in `SUPPLY_RPC_DEFAULTS` for latest-state supply reads, after live `eth_chainId`, `totalSupply()`, and `decimals()` probes. They are intentionally absent from `PUBLIC_RPC_URLS` and `buildChainRpcs`: those consumers, including the transfer-materiality fallback, currently label public registry endpoints as archive/full-log capable, which this review did not establish. Filecoin's official RPC documentation guarantees only recent state for most public endpoints. Registration does not introduce a curated aggregate-supply roster, change a coin's market-cap source, or assert archive/log-history support. Alchemy, Dwellir, Moralis, DexPaprika, and Birdeye slugs are not added without separate verification.

Zilliqa (`zilliqa`, `type: "other"`, no EVM chain ID, explorer `https://viewblock.io/zilliqa`, explicit resilience tier 2) identifies the Scilla/ZRC-2 network. This registration identifies Scilla/ZRC-2 deployments, not Zilliqa's separate EVM interface. The DefiLlama `Zilliqa` label resolves through the registry name without a redundant alias, joining XSGD supply to its issuer-native route and eight reviewed controls. XSGD uses the issuer's `zil1…` token address; native control identities retain RPC `0x…` ByStr20 addresses. The supply-probe family resolver rejects both address forms because this chain is non-EVM and has no native supply reader. With no `providers` block, DEX census records `unsupported_scope` (`DEX_DISCOVERY_UNSUPPORTED_SCOPE_REASON`: "No registered token-pool provider supports this chain"), not a failed EVM/pool query or liquidity evidence. Control evidence is a dated latest-state observation bracketed by native tx-block heights, never a historical state pin. Arc remains registered as `arc` (EVM 5042, resilience tier 3), likewise without pool providers.

Dwellir's runtime-neutral roster lives in `shared/lib/dwellir-chains.ts` and covers 37 EVM identities. `flow` is explicitly the EVM identity, not a Cadence route. Growth measurements establish Polygon and Berachain archive state, observed (not vendor-guaranteed) Plasma archive state, recent-only Arc state with a regional retained log window, and a moving Monad retained-log window. Inclusive log spans are Ethereum/Monad 1,000 blocks, Astar 1,024, and other verified log hosts 10,000; full-history capability is distinct from runtime log admission.

After scheduled key, usable-budget and valid-circuit admission, Dwellir is primary for state reads on Mantle, Sonic, Gnosis, Tempo and Plasma, immediately after Alchemy on Base, and supplemental-last elsewhere (including Base without Alchemy). `DWELLIR_ROUTING_DISABLED_CHAINS` restores supplemental-last routing and excludes listed chains from logs. Log inclusion requires membership in `DWELLIR_LOG_SCAN_CHAINS` and full history. Denied admission preserves the original map, request-path maps never enable Dwellir, and chain readability and all consumer inventories are unchanged. Supplemental-aware supply, transfer census and reserve reads retain their existing target/historical gates; no aggregate supply roster or market-cap source changes.
Plasma's Dwellir archive history is observed (non-zero year-old token state on 2026-10-11), not vendor-guaranteed, and the parity monitor checks only near-head state, so it would not detect lost history. Historical Plasma reads rely on a pruned node answering with a JSON-RPC error (as Polygon's full node did), which falls through to the public endpoint; a pruned node that silently served wrong state would not be caught.
Hash-pinned EIP-1898 `eth_call` reads were verified on Mantle, Sonic, Gnosis and Base Dwellir hosts on 2026-10-11 around 21:41Z, and on Tempo and Plasma on 2026-10-12 around 06:22Z: at head−200,000, `totalSupply` matched the numeric-block value and differed from latest, while fake canonical hashes returned errors.

Dwellir's log allowlist currently contains Gnosis only: span-guarded, map-aware `eth_getLogs` batches (blacklist scans and other map-aware log readers) can use Dwellir first. Mint/burn retains its existing Alchemy routes.

---

## `/chains/` Contract

`src/app/chains/page.tsx` renders a `FeaturePageShell` with:

- breadcrumb + canonical path `/chains/`
- methodology pill wired from `CHAIN_HEALTH_METHODOLOGY_VERSION` and `CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH`
- lead copy describing chain ranking by stablecoin supply and health
- `CollectionPage` + `ItemList` JSON-LD over every crawlable `/chains/[chain]/` profile route, with each item typed as `WebPage`
- FAQ structured data emitted by the route's `FaqSection includeJsonLd`
- a visible `ChainDirectory` section after the FAQ, listing every generated `/chains/[chain]/` profile route

`src/app/chains/client.tsx` consumes `useChains()` and renders:

- hero summary: total tracked stablecoin supply (the frost-blue "One Beam" figure, `.pharos-numeric text-frost-blue`), optional global 7d trend, the count of chains with observed supply (labelled as such, since the top strip's Chains count is the full chain registry), and a top-chain dominance breakdown bar/legend. The bar is a neutral ink ramp (largest chain darkest) with chain logos in the legend: the Harbor below owns the page's hues (cargo, health flags, beam), so no chain takes a categorical colour that a cargo or flag also uses. The page keeps its existing sequential bands rather than the shared `FeatureHeroSplit`, and intentionally retains the frost-tinted "Top N chains hold X%" concentration badge
- supply coverage: excluded global assets and chain observations are counted from `supplyCoverage`; affected totals/rows and detail supply/global share are labelled partial, never recomputed
- explicit `Unattributed` residual in the dominance breakdown when the stablecoins cache has supply that DefiLlama does not attribute to a concrete chain. Legend percentages are always shares of `globalTotalUsd` (`dominanceShare`, never rescaled); when chain rows over-attribute supply the bar geometry normalizes to `dominanceGeometryTotalUsd` (the larger raw chain total) and a `Chain rows exceed global supply by X%` legend entry discloses `attributionDiscrepancyUsd` instead of hiding it
- `HarborSelectionProvider`, the sole owner of `location.hash` on `/chains/`: `#chain-<id>` pins that chain on load and on `hashchange`; pinning writes the hash with `replaceState` (no history entry) and unpinning clears it. Leaderboard row hover/focus lights the matching berth (or the tail barge); "Show in table" scrolls to and highlights the row (smooth only when motion is allowed). Barges have no hash.
- `HarborHero` (Harbor 2.0, client-only; the leaderboard is the equivalent surface and a "Skip the harbor" link precedes the scene). A light isometric harbor in the Cemetery's visual language on the scene kit (`shared/lib/scene/`, `src/components/scene/`), built by the pure `buildHarborScene` view model and `buildHarborGeometry`:
  - **Unit:** one container = $1B of observed chain supply (linear, fixed; never auto-switches), bays of 10 containers ($10B) with a gap between bays. A ship's last container is fractional; fractions below 0.06 draw at a display-only sliver floor that never reaches a label. Beyond `MAX_BAYS_PER_TIER` (16 bays, $160B) containers stack a further tier from the stern and the legend says so.
  - **Berths:** chains ≥ $1B are ships (max 16), moored like piano keys with every bow on one quay line, largest north; chains ≥ $100M are small craft (max 24) on a jetty, one fractional container each; every other chain (and any beyond the caps) is pooled on a `+N more chains · $X` barge whose count and sum come from the full chain list (R7). `unattributedTotalUsd` rides a separate hatched barge with no flag; when chain rows over-attribute (`attributionDiscrepancyUsd > 0`) there is no unattributed barge and a caption discloses the excess. Drawn containers sum to `chainAttributedTotalUsd + unattributedTotalUsd` within $1 (tested).
  - **Cargo:** containers filled bow → stern with USDT, USDC, then Other (every other coin, including coins outside the top 5), split two-tone at the exact boundary; the first whole container of a USDT/USDC run of ≥ 3 carries a `T`/`C` stencil. Hues are `HARBOR_CARGO_HEX` (categorical `CHART_PALETTE` slots clear of the band colours and frost blue); the neutral dominance bar keeps them from colliding with any chain colour on the same screen.
  - **Health:** a band-coloured signal flag on the quay bollard whose pennant count repeats the band (robust 0 … concentrated 4) with the score in mono; Robust flies a swallowtail (forked fly) so it reads apart from Healthy by shape as well as hue; a null band is a bare mast with an `NR` plate (with the report-card reason when `_meta.dependencies.reportCards` is not fresh).
  - **7d:** wake chevrons astern, linear in `change7dPct` to ±10% with a break mark beyond and the exact % as a label; none under 0.5%. Wakes draw in neutral ink, the chevron direction alone saying growth or decline; only moves of ±5% (`WAKE_HUE_PCT`) or more take the green/red hue; `change7dPct: null` with positive growth reads "new", never 0%.
  - **Partial supply:** `unavailableSupplyObservationCount > 0` adds a hatched stern cap and a ◐ on the label; the card says the supply is a lower bound.
  - **Retained:** `_meta.status` not `fresh` (or a query error with retained data) desaturates the scene, draws flags outline-only and stamps "Retained · as of HH:MM UTC".
  - **Interaction:** one roving tab stop on the largest ship (↑/↓ rank order, Home/End), hover/focus tag, click/Enter/Space pins a record card (docked ≥ 1280 px on the open water nearest the berth that covers the fewest hull and quay-label samples, `placeOnFreeWater` in `src/components/harbor/harbor-placement.ts`, which also places the tag; falling back to the kit's beside-the-berth docking when the visible band is too short, in flow 761–1279 px, a bottom sheet ≤ 760 px) with exact supply, `dominanceShare`, band/score or NR reason, the five cargo rows, 7d $ and %, and links to the profile and the table row; Escape or a click on the water unpins. The lighthouse beam follows the lit berth and jumps (no tween). There is no ambient motion: the former 7-second auto-sweep, star sky, fog verdict and `DOMINANCE DRAFT` label are removed.
  - **Phone (≤ 760 px):** a portrait plan with hulls running left → right and bays 2 along × 5 across so a container face stays ≥ 5 px; labels sit above each bow.
  - **Capacity:** `validateHarborCapacity` checks container face ≥ 6 px at 1440 px / ≥ 5 px at 390 px, no berth overlap, the height budget and conservation, on fixtures (today, ×2, ×4, one chain, 150 chains).
- sortable leaderboard table rendered through `DataTableShell`
- `QueryFreshnessNotices` (preset `"chains"`, which wraps the stale-data banner) plus `QueryErrorNotice` with retry in the no-data error state
- skeleton loading states (KPI grid + table rows)
- row click and keyboard navigation into `/chains/[chain]/`
- chain logos apply `dark:invert` when `CHAIN_META[id].darkInvert` is set

Current sortable columns are:

- `Health`
- `Supply`
- `7d`
- `Global Share`
- `Stablecoins`

The `Dominant` column is a non-sortable `lg+` context column showing the largest stablecoin on each chain.

Default sort is `totalUsd desc`.

---

## `/chains/[chain]/` Contract

`src/app/chains/[chain]/page.tsx`:

- rejects unknown chain IDs with `notFound()`
- statically generates params from `getActiveChainIds()` / the current `CHAIN_META` key set
- sets canonical metadata at `/chains/[chain]/`
- builds the title from leading ticker symbols when they fit the search-snippet budget; the description includes mapped deployment count and leading symbols
- emits `CollectionPage` + `ItemList` JSON-LD for tracked deployments, with chain/deployment entities typed as `Thing` and no `Product` markup
- renders the live client first, then a compact server-rendered deployment anchor hub linking each tracked stablecoin on the chain to its `/stablecoin/[id]/` page, a `Next Check` CTA (compare cohort + alerts), and finally related taxonomy and research route hubs

`src/app/chains/[chain]/client.tsx` uses `useChainProfileData(chainId)` and renders, in order:

1. `QueryErrorNotice` (inline banner when error + stale data)
2. `StaleDataBanner` when the chain snapshot is stale
3. hero card (`ChainHero`) with supply, global share, 24h/7d/30d change (deltas and percentages pair current supply only with known historical anchors for each window; missing coin history and chain windows with no pairs render as “—”, while explicit zero history remains known; all with dark-mode colors via `trendColor()`), health badge, `dark:invert` logo support, and the embedded Chain Health breakdown (the `HealthZone` factor grid) whose weight labels derive dynamically from exported constants in `shared/lib/chains/health.ts`
4. `ShowYourWorkPanel` rendered immediately below the hero card, exposing the factor math
5. stablecoin composition grid — rendered from `chainDetail.coins` when the chain summary exists; adaptive 2/3/4-column layout with 1-3 rows, optional `Others` aggregation when the chain has more coins than display cells, and dominant span only when a coin exceeds 35% share in a 3+ column layout
6. backing-type breakdown — rendered from `chainDetail.coins`; unclassified coins shown as "Other" (zinc-colored) bucket; filter buttons update the stablecoin table by backing type
7. full stablecoin table with a screen-reader-only `<caption>` — rendered from `chainDetail.coins`
8. skeleton loading states inside the hero card only (market metrics + the Chain Health zone); detail rows remain empty until the chain-scoped response supplies them

`useChainProfileData()` reads one chain-scoped response, `GET /api/chains?chain=<id>`. The summary and detail rows therefore share one `updatedAt` and freshness identity; there is no second stablecoins query or cross-snapshot consistency gate. The Worker includes `chainDetail` only when the requested chain is known, and its `totalUsd` plus each coin's `chainShare` use that chain's local denominator.
Coverage-listed chains with no numerical row render unavailable supply with retry, not the untracked/removed fallback. Detail metrics disclose the excluded chain observations and global assets independently.

`useChainDetail(chainId)` is the parameterized query hook for that response. Profile rows are not recomputed in the browser from `/api/stablecoins`; the removed `useChainStablecoins()` path must not be reintroduced.

---

## Chain Health Score

The route displays the Chain Health composite and its factor detail from `GET /api/chains`. Formula, factors, weights, coverage gates, evidence precedence, bands, and current methodology version are owned by [chain-health.md](./chain-health.md) and `shared/lib/chains/health.ts`. Do not duplicate those volatile values here.

The page contract is limited to presentation: the leaderboard exposes the composite for comparison, and chain profiles show factor/evidence detail when the coordinated API snapshot provides it. A `null` factor on a loaded chain renders `NR` (loading still shows `—`). The peg-stability row adds a coverage note whenever coverage is not complete: the observed share (floored to a whole percent, so partial coverage never reads as 100%) and missing-reference supply, or NR when nothing was observed. Partial coverage displays the observed-only factor, never a neutral placeholder; the note stays visible whether or not the composite clears the peg-coverage gate owned by [chain-health.md](./chain-health.md). The reader retains the neutral-imputation explanation only for cached pre-v1.6 payloads. When the composite is `null` while `quality` is rated, the hero explains that peg-stability coverage is below the published minimum (`PEG_COVERAGE_COMPOSITE_MIN`) and states the observed share; a `null` quality keeps the safety-coverage explanation.

---

## API And Freshness

`useChains()` reads `GET /api/chains` with the standard 15-minute cron-aligned query preset and the endpoint's 1800-second freshness budget. `useChainDetail(chainId)` reads the same endpoint with `?chain=<id>` and receives the full per-chain coin rows in `chainDetail`.

`GET /api/chains` returns body `_meta` freshness metadata plus HTTP freshness headers. When its supporting caches lag, the body `_meta.status` degrades instead of silently appearing fresh. `_meta.dependencies.reportCards` also tells the route whether a missing Chain Health score is due to stale/unavailable report-card inputs versus genuine score-coverage gaps.

Every positive-supply chain in the response carries exactly `min(stablecoinCount, 5)` `topStablecoins` rows. The shared response schema rejects older or partial payloads that do not meet this contract, so the leaderboard does not merge a second stablecoins snapshot into the chain snapshot.

When `chain` is supplied, `chainDetail` contains the active aggregate coins for that canonical chain, sorted by descending chain-local supply. Each row includes canonical `chainShare` and 24h/7d/30d change ratios; the detail total is the denominator for those shares. The unclassified backing bucket remains `other`, distinct from worker health or data-quality buckets.

Chain, coin-detail and global 24h/7d/30d ratios retain `null` for positive supply grown from an observed zero baseline; absolute chain/coin deltas remain valid. Observed zero-to-zero is no change (`0`), not missing history.

`worker/src/api/chains.ts`:

- loads the strict stablecoins cache and restricts it to active core-aggregate assets (`isActiveChainAggregateAsset`), which scopes every downstream peg rate, aggregate, and total
- derives non-USD peg references from `fxFallbackRates`; missing commodity references are withheld rather than defaulted to `$1`
- hydrates safety scores only from a fresh accepted report-card publication; a held, stale, or unavailable source leaves the score map empty
- computes the response via `aggregateChains(...)`, optionally with the requested canonical detail chain
- computes `globalTotalUsd` from all observed tracked circulating supply (assets with absent/empty/invalid buckets are excluded and counted in `supplyCoverage.aggregateUnavailableAssetCount`); `chainAttributedTotalUsd` is the raw, unclamped sum of the published chain rows, `attributionDiscrepancyUsd` the signed difference from the global total, `unattributedTotalUsd` its positive residual and `dominanceGeometryTotalUsd` the bar-geometry denominator; unobserved asset-chain rows are excluded from chain totals and counted per chain (`unavailableSupplyObservationCount`) and in `supplyCoverage`, which also names chains left with no observed row
- overwrites `updatedAt` with the stablecoins-cache timestamp
- applies freshness headers with `X-Data-Age`, exposes report-card dependency freshness in `_meta.dependencies.reportCards`, and downgrades `Cache-Control` to `no-store` when the chain snapshot or health dependency is degraded

If the stablecoins cache is unavailable or structurally invalid, the endpoint returns `503`.

---

## Update Rules

Update this file when any of the following change:

- Chain Health weights, factors, resilience tiers, or bands
- `/chains/` leaderboard columns or default sort
- `/chains/[chain]/` section order or data sourcing
- `generateStaticParams()` source of truth for chain routes
- `GET /api/chains` response fields or freshness behavior
- Health band colors or pennant counts in `shared/lib/classification/chain-health.ts` (frontend and Worker read the same source)
- Harbor encodings, thresholds or interaction in `shared/lib/harbor-scene*.ts` / `src/components/harbor/`

Related docs to update in the same change:

- [api-reference.md](./api-reference.md)
- [architecture.md](./architecture.md)
- [methodology-page.md](./methodology-page.md)

If the methodology version changes, also update `shared/lib/methodology-versions/registry.ts`, the matching entry under `shared/data/methodology-changelogs/chain-health/`, and the public methodology explanation when needed. The changelog route renders from that structured source.
