# Coverage Page Contract

Contract for the public `/coverage/` route. This page explains which Pharos features are available per active stablecoin and gives users both count coverage and market-cap coverage.

---

## Purpose

The coverage page answers two questions:

1. Which Pharos features are available for a given stablecoin right now?
2. How broad is each feature across the tracked universe, by both coin count and tracked market cap?

The page is intentionally product-facing, not admin-facing. It should describe user-visible coverage, not internal cron health.

---

## Route Shape

- **Route:** `/coverage/`
- **Server shell:** `src/app/coverage/page.tsx`
- **Client implementation:** `src/app/coverage/client.tsx`
- **Error boundary:** `src/app/coverage/error.tsx`
- **Core helpers:** `src/lib/coverage-matrix-model.ts`, `src/lib/coverage.ts`, `src/lib/coverage/*`
- **Structured data:** `src/app/coverage/page.tsx` emits the static methodological `Dataset` descriptor through a JSON-LD `<script>` in the page shell; `FaqSection includeJsonLd` in `src/app/coverage/client.tsx` owns FAQ JSON-LD. The Dataset descriptor is metadata-only: it inlines the Pharos `Organization` for `creator` / `publisher`, includes the Pharos data license URL, a `urn:pharos:dataset:coverage` identifier, and `sameAs` pointing at `/coverage/`, while deliberately avoiding live metric values or private `/_site-data/*` URLs.

The page uses `createClientFeaturePage(...)`, which wraps the route in the shared feature-page shell for public client-heavy surfaces. It remains indexable like the rest of the public feature routes.

---

## Coverage Dimensions

The matrix currently exposes these columns:

- `Price & Depeg`
- `Safety Score`
- `DEX Price`
- `Reserve View`
- `Redemption Backstop`
- `Yield`
- `Flows`
- `Freezable Status`
- `MiCA`
- `GENIUS`
- `Dependency Map`
- `Mint Authority`

Status semantics are intentionally user-facing:

- `Price & Depeg`: `Tracked`, `Price only` (NAV-priced assets), or `Missing`
- `Safety Score`: `Rated` or `NR`
- `DEX Price`: `Primary`, `Mixed`, `Fallback`, `Legacy`, `Not Covered`, `Unknown`, or `Data n/a`
- `Reserve View`: `Score-grade`, `Configured`, `Checking`, `Curated-Validated`, `Proof`, `Curated`, `Estimated`, or `None`
- query-backed columns can also emit `Data n/a` while an upstream dataset is unavailable
- `Redemption Backstop`: `Issuer`, `PSM`, `Queue`, `Collat.`, `Stable`, `Basket`, `Modeled`, `Heur.`, `Resolved`, `Config.`, `Impaired`, `Not Covered`, or `Data n/a`
- `Yield`: `Ranked`, `Gap`, or `Data n/a`
- `Flows`: `Full`, `Partial`, `Lagging`, `Bootstr.`, `Unknown`, `Disabled`, `Not Covered`, or `Data n/a`
- `Freezable Status`: `Live`, `Yes`, `Upstream`, `Possible`, `No`, or `Data n/a`
- `MiCA`: `Authorized`, `Pending`, `Transitional`, `Non-Comp.`, `Out Scope`, or `Not Assessed`
- `GENIUS`: `PPSI Approved`, `State Qualified`, `Filing Pending`, `Issuer Intent`, `None Found`, `Not Applicable`, `Unknown`, or `Not Assessed`
- `Dependency Map`: `Both`, `Dep.`, `Hub`, `No deps`, `Gap`, or `Data n/a`
- `Mint Authority`: `No priv.`, `Governed`, `Multisig`, `Issuer`, `Bridge`, `Inherited`, or `Unknown`, with optional score-band breakdowns

### Mint Authority Coverage

Mint Authority coverage counts curated review breadth first, then appends posture-band breakdowns from the published V9 mint component. The curation-route buckets stay curated because they describe which review path an asset is on; only the `score-*` buckets read the publication. `Unknown` means no compact mint-authority review is available; stablecoin detail pages always render the Mint Authority section, showing an explicit `Not reviewed by Pharos` / `Mint control posture: NR` state when no reviewed data exists, while score-oriented aggregate surfaces treat the row as `NR`.

Authority posture bands belong in detail text/tooltips only; do not add posture buckets to the coverage headline, risk ranking, or default sort. Score-band chips use `Hardened`, `Governed`, `Managed`, `Concentrated`, `Exposed`, and `NR`.

---

## Source Of Truth Per Column

The page deliberately mixes structural coverage and live dataset coverage. The implementation entrypoint is `src/hooks/use-coverage-matrix-model.ts`, which wraps `src/lib/coverage-matrix-model.ts`, builds one `CoverageRow` per active stablecoin, and resolves each column through the feature modules under `src/lib/coverage/`.

| Column                | Hook / field used on `/coverage/`                                                                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Price & Depeg`       | `usePegSummary().data.coins[].id`, `consensusSources`, `priceConfidence` plus `ACTIVE_STABLECOINS[*].flags.navToken`                                                                                                                                       | `Tracked` requires a live peg-summary row. NAV tokens intentionally map to `Price only` even without depeg logic. The headline summary is stricter: it counts only rows with at least 3 consensus price sources.                                                                                                                                                                                          |
| `Safety Score`        | `useReportCardsV9().data.cards[].score`                                                                                                                                                                                                             | Coverage is `Rated` only when the report card has a non-null overall score.                                                                                                                                                                                                                                                                                                                               |
| `DEX Price`           | `useDexLiquidity().data[id].coverageClass`                                                                                                                                                                                                                 | User-facing badge labels are mapped from liquidity `coverageClass`.                                                                                                                                                                                                                                                                                                                                       |
| `Reserve View`        | `ACTIVE_STABLECOINS[*].liveReserveAdapter` (the client-registry projection of the server-only `liveReservesConfig.adapter`) mapped through `shared/lib/live-reserve-display.ts`; `reportCard.backingFromLiveReserves`; otherwise `getReserves(coin)` from `@shared/lib/reserve-templates`                                      | Detail-page reserve views are split from score-grade live reserve inputs. The row shows `Score-grade` whenever the current V9 report-card snapshot compiled Backing reserve exposures from accepted live reserves, including scoring-eligible feeds whose detail-page badge remains `Proof`; configured live adapters that did not qualify render as `Configured`.                                                                                                                       |
| `Redemption Backstop` | `useRedemptionBackstops().data.coins[id]`                                                                                                                                                                                                                  | The matrix reflects the live redemption-backstop snapshot exposed by the worker dataset, not static coin metadata alone. Configured-but-unrated routes render as `Config.`, resolved-but-unscored routes render as `Resolved`, impaired routes render as `Impaired`, and low-confidence heuristic routes render as `Heur.`; none count as covered in the headline metric.                              |
| `Yield`               | `useYieldRankings().data.rankings[].id`                                                                                                                                                                                                                    | Coverage reflects current inclusion in the yield rankings, not theoretical yield-bearing eligibility.                                                                                                                                                                                                                                                                                                     |
| `Flows`               | `useMintBurnFlows().data.coins[].coverage.status`                                                                                                                                                                                                          | Mirrors the configured issuance-chain mint/burn coverage state exposed on `/flows`. Quiet assets can prove mature windows from completed block-scan span when no retained event row remains, so aggregate retention does not regress established coverage to `Bootstr.`.                                                                                                                              |
| `Freezable Status`    | `getResolvedBlacklistStatus(coin.id)` from `src/lib/blacklist-status.ts`, reading the reviewed client-registry `blacklistStatus`; `BLACKLIST_STABLECOINS` only upgrades direct-true assets into the `Live` event-tracker bucket                                                                 | Reviewed freeze/blacklist exposure across every active stablecoin. `Live` means direct freeze controls plus live FreezeWatch event tracking; `Yes`, `Upstream`, `Possible`, and `No` are reviewed status states and all count as available coverage.                                                                                                                                                       |
| `MiCA`                | `ACTIVE_STABLECOINS[*].mica` from the client registry                                                                                                                                                                                                       | Static compliance sidecar metadata merged into the generated client registry. `Authorized`, `Pending`, `Transitional`, `Non-Comp.`, and `Out Scope` are reviewed assessment states and count as assessed coverage. Missing metadata renders `Not Assessed` and is the coverage gap; it must not be interpreted as in scope, out of scope, authorized, or non-compliant. |
| `GENIUS`              | `ACTIVE_STABLECOINS[*].genius.authorizationStatus` from the compact client registry projection                                                                                                                                                              | Static GENIUS implementation-watch metadata generated from compliance sidecars. `PPSI Approved`, `State Qualified`, `Filing Pending`, `Issuer Intent`, `None Found`, `Not Applicable`, and `Unknown` are reviewed assessment states and count as assessed coverage. Missing metadata renders `Not Assessed`. |
| `Dependency Map`      | `useReportCardsV9().data.cards[].dependencies` (the published serial/basket summary) plus `useReportCardsV9().data.dependencyGraph.edges`                                                                                                                                              | `buildV9DependencyCoverageFacts(...)` filters graph edges to live report-card IDs and classifies each coin as both dependent/upstream, dependent-only, upstream-only, resolved with no tracked dependency, or an unmapped gap when dependency evidence exists but no live edge remains. The coverage page does not fall back to the static graph when report-card data is unavailable; it emits `Data n/a`. |
| `Mint Authority`      | `coin.mintAuthoritySummary` from the slim client registry projection (curation routes) plus the published V9 mint component (`cards[].breakdowns.control.components`)                                                                                                                                           | Structural coverage of curated mint-authority reviews. Reviewed statuses count as available; `Unknown` does not. The row also exposes the published V9 mint posture band where the publication carries one.                                                                                                                                                               |

Additional page-level sources:

| Page element                                                                               | Source                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Base coin universe                                                                         | `ACTIVE_STABLECOINS` (the `CLIENT_ACTIVE_STABLECOINS` alias) from `@shared/lib/stablecoins/client-registry`                           |
| Market-cap weights                                                                         | `/api/stablecoins` via `useStablecoins()`, using `getCirculatingRaw()` on the cached list payload                                     |
| Peg/backing/governance labels in each row                                                  | `coin.flags.*` from tracked metadata, formatted through `@shared/lib/classification` short-label maps                                 |
| Pricing-source tiles                                                                       | `usePegSummary().data.coins[].consensusSources`, grouped into market sources vs authoritative overrides in `useCoverageMatrixModel()` |
| Snapshot insight cards (`Source target`, `Widest reach`, `Tightest reach`, `Cap skew`) | Derived from the same per-feature summaries and per-row source-depth counts used by the feature snapshot rows                         |
| Safety Score input coverage                                                             | Canonical V9 report-card publication via `useReportCardsV9()`, summarized by `buildDataCoverageModel(...)`                            |

---

## Feature Snapshot

The feature snapshot leads the page. It is the first stop for users who want to understand total Pharos coverage before drilling into individual assets. It is framed as the route's signature full-width hero under the shared [Feature-page heroes](./design-language.md#feature-page-heroes) rule: a compact header strip carries the frost-blue "One Beam" = the active-coin universe count, with neutral `.pharos-numeric` avg-reach % and tracked-surfaces sub-metrics, and the stacked-bar breadth chart reads as the drawn metaphor full-width beneath.

Every row shows:

- a headline count aligned to the feature's summary rule
- a stacked count bar showing status segments against the active-coin denominator, using the same color vocabulary as the breakdown chips
- percent of tracked coins, or the feature-specific eligible coin set when a feature only applies to a subset
- percent of tracked market cap, or the feature-specific eligible market cap when a feature only applies to a subset
- compact per-feature breakdown chips
- direct link to the underlying surface when one exists

For `Reserve View`, the headline metric intentionally emphasizes score-grade live reserve inputs only. `Configured`, `Curated-Validated`, `Proof`, curated, and estimated reserve views still appear in the breakdown so the row distinguishes detail-page reserve coverage from live reserve data that actually entered report-card collateral scoring.

For `Redemption Backstop`, the headline metric intentionally emphasizes strong redemption coverage only. Low-confidence heuristic routes, resolved-but-unscored routes, configured-but-unrated routes, and impaired routes still appear in the breakdown so the row does not imply the modeled registry disappeared.

For `Price & Depeg`, the headline metric intentionally emphasizes breadth with corroborated pricing. A coin still renders `Tracked` in the matrix with fewer than 3 sources, but the feature snapshot headline only counts rows whose `consensusSources` depth is at least 3.

For `Freezable Status`, the headline metric is resolved-status coverage across the active universe. The breakdown distinguishes `Live` FreezeWatch event-tracked assets from direct `Yes`, `Upstream`, `Possible`, and `No` states; it no longer treats only direct-blacklistable assets as the denominator.

Breakdowns are intentionally dense and should stay short:

- DEX: `primary / mixed / fallback`
- Reserve view: `score-grade / configured / checking / curated-validated / proof / curated / estimated`
- Redemption: `heuristic / resolved / configured / impaired / issuer / psm / queue / collateral / stable / basket / data n/a`
- Flows: `full / partial / lagging / bootstrapping / unknown / data n/a`
- Price: `tracked / price-only`
- Freezable status: `live / yes / upstream / possible / no`
- MiCA: `authorized / pending / transitional / non-compliant / out-of-scope / not assessed`
- GENIUS: `ppsi approved / state qualified / filing pending / issuer intent / none found / not applicable / unknown / not assessed`
- Mint Authority: `no privileged / governed / multisig / issuer/backend / bridge / inherited / unknown / score-hardened / score-governed / score-managed / score-concentrated / score-exposed / score-nr`

#### Source count enrichment

When `consensusSources` data is available from the peg-summary API, the "Tracked" badge shows a source count suffix: "Tracked (5 sources)" (or "Tracked (5)" in compact mode). Tooltip expands to show confidence level and source names (e.g., "High confidence — CoinGecko, DefiLlama, Pyth Network"). The feature snapshot breakdown adds a secondary source-depth distribution: `5+ sources: N · 3-4: N · 1-2: N`. The snapshot header also includes a compact `Source target` tile for the `>=3` candidate-source count and market-cap reach.

If a feature gains richer user-facing states, update the relevant resolver under `src/lib/coverage/`, its export surface in `src/lib/coverage.ts`, and this document.

---

## UX Contract

- The feature snapshot comes first and answers the breadth question before the page shifts into source context and per-coin inspection.
- The expandable Safety Score input-coverage card follows the feature snapshot. Its collapsed view shows evaluated inputs and missing-data ownership, or publication-hold context in place of the counts when the publication is held; its disclosure retains owner explanations, per-pillar counts, and missing-input reasons.
- The pricing-source card renders after the feature snapshot when consensus-source data is available.
- Search filters by name and ticker.
- Quick filters are grouped as tier filters (`All coins`, `Fully available`, `Fully headline`), feature filters (`Redemption`, `Yield`, `Reserves`, `Flows`, `Blacklist` for the freezable-status column), and gap filters (`No Safety`, `No DEX`, `No Reserves`, `2 sources`, `Weak price`, `No Flows`, `No Dependency`). `No Dependency` now means unresolved dependency-map coverage (`Gap` or `Data n/a`), not "no upstream dependency."
- The `Reserves` quick filter is intentionally strict: it matches only rows where `statuses.reserves.kind === "live"`, the score-grade live reserve state, not `Curated-Validated` or `Proof`.
- Default sort is descending live market cap. The sort control stays a grouped `<select>` but is reskinned to the pill/token visual; discrete quick filters use `pharos-control-pill`, and every digit-bearing cell uses `.pharos-numeric`.
- On small screens, the matrix adapts into scan-first per-coin cards that preview the highest-signal statuses and expand for the remaining states. Mobile renders the result set in batches with explicit "show next" and collapse controls so large filtered sets do not mount hundreds of cards before the user asks for them.
- From `md` upward, the full comparison table renders with the first column sticky.
- The per-coin matrix renders after the pricing-source card and is explicitly positioned as the asset-level drill-down surface.
- A compact `CoverageLensSummary` block sits above the matrix to show the active search/filter lens and the tracked market-cap share currently in view.
- The status legend remains an inline disclosure above the matrix; there is no separate full-page explainer block.
- Shared stale-data banners surface freshness problems from the stablecoins, peg-summary, dex-liquidity, redemption-backstops, yield-rankings, mint-burn-flows, and report-cards queries without collapsing the structural coverage view.

The page should continue to render meaningfully when some live datasets are temporarily unavailable. In that case, the matrix still renders with structural coverage where possible and uses the shared stale-data banner to surface data-health issues.

## Structured Data Contract

The `/coverage/` page emits a conservative `Dataset` JSON-LD node for the visible coverage matrix. The descriptor is static and methodological: it names the coverage fields, links the page to the public API documentation/catalog, and intentionally omits live metric values, `DataDownload` entries, `dateModified`, and `/_site-data/*` proxy URLs.

---

## Update Rules

Update this page when any of the following change:

- a new user-facing feature becomes per-coin and has partial coverage
- an existing feature changes its coverage source of truth
- a status label or meaning changes
- the table gains or loses a column

If the change also affects route inventory, update [Architecture](./architecture.md) and the [Documentation Index](./README.md).
