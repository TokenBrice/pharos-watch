# Coverage Page Implementation Audit

Date: 2026-04-15

## Scope

Audit-only review of `/coverage/`, covering UI clarity, accessibility, responsive behavior, data derivation, and current live feed shape. No product code was changed.

Assumptions:

- "Coverage" means active stablecoins with full worker processing, because the page uses `ACTIVE_STABLECOINS`. That is currently 180 active coins out of 190 tracked metadata entries, excluding 10 pre-launch assets and the PSI shadow assets.
- I reviewed implementation reliability and current live feed consistency. I did not independently verify every external issuer/provider fact against upstream docs.

Success criteria:

- Users can trust that an uncovered/missing state means a real coverage gap, not a loading or partial-feed artifact.
- The page makes each feature's coverage semantics clear enough to compare coins and features without needing source code knowledge.
- The matrix provides a comprehensive per-coin view of effective Pharos feature coverage.

## Verification

- Read relevant repo docs: architecture, API reference, testing, worker/API limits, design context/language/tokens.
- Reviewed implementation under `src/app/coverage/*`, `src/lib/coverage.ts`, `src/lib/coverage-page-config.ts`, `src/hooks/use-coverage-matrix-model.ts`, data-health helpers, and related schemas.
- Ran targeted tests: `npm test -- src/lib/__tests__/coverage.test.ts src/app/coverage/coverage-filtering.test.ts` (26 tests passed).
- Started local dev server and inspected `/coverage/` with Playwright at desktop and mobile viewports.
- Pulled current live same-origin JSON feeds from `https://pharos.watch/_site-data/*` at approximately 2026-04-14 22:47 UTC and recomputed the matrix with local coverage helpers.

Current computed live matrix snapshot:

- Active universe: 180 coins; stablecoin payload contains all active IDs.
- Price headline: 95/180 with >=3 sources; breakdown is 160 tracked, 20 price-only, 65 tracked with only 1-2 sources.
- Safety: 168/180.
- DEX: 159/180.
- Live reserves headline: 57/180; full reserve-view breakdown is 57 live, 32 curated-validated, 46 proof, 44 curated, 1 estimated.
- Strong redemption: 133/180; 12 heuristic and 2 configured-unrated rows are excluded from the headline.
- Yield: 89/180.
- Flows: 125/180.
- Blacklist: 6/180.
- Dependency map: 98/180.

## Ranked Findings

### 1. High: Loading and failed-feed states are rendered as real missing coverage

`useCoverageMatrixModel()` builds all rows immediately from `ACTIVE_STABLECOINS`, even before API queries have returned. Missing async data defaults to `false`, `null`, or zero market cap and is then rendered through normal missing/NR labels. The `StaleDataBanner` says data is unavailable, but the snapshot and matrix still show concrete-looking coverage counts, market-cap share, and per-coin statuses.

Observed in Playwright after mobile reload: the page displayed "Waiting for initial data" while also showing Price 0/180, Safety 0/180, DEX 0/180, market share $0, and cards sorted as if every coin had missing dynamic coverage. This is especially risky because slow or failed feeds are visually indistinguishable from legitimate coverage gaps.

Relevant code:

- `src/hooks/use-coverage-matrix-model.ts`: rows are built from static metadata without an all-required-data readiness gate.
- `src/lib/coverage.ts`: dynamic nulls resolve to "Missing", "Unknown", "NR", or "not tracked" states.

Recommendation: introduce explicit query readiness/error state into the coverage model. Until core feeds have data, show skeletons or "loading coverage" placeholders rather than final coverage counts. For partial failures, mark affected feature columns as "data unavailable" and exclude them from feature rankings/coverage totals.

### 2. High: "Live Reserves Sync" is mostly inferred from static metadata, not current live reserve availability

Reserve coverage comes from `coin.liveReservesConfig` and `getReserves(coin)`. A configured adapter becomes "Live" even if the actual reserve sync is failing, stale, or returning fallback data. The page has no all-coin live-reserve data feed, no live-reserve freshness entry, and no per-coin reserve sync health in the matrix.

This can overstate effective coverage for the feature whose label specifically promises live sync.

Relevant code:

- `src/lib/coverage.ts`: `resolveReserveCoverage()` uses metadata/config presence.
- `src/hooks/use-coverage-matrix-model.ts`: no reserve query is loaded or included in `staleQueries`.

Recommendation: either rename the column/headline to "Reserve View" and treat "Live" as configured capability, or back it with live reserve sync output/freshness so "Live" means current usable live data.

### 3. High: Blacklist coverage is static by symbol and not tied to current event/config health

Blacklist coverage is derived from `BLACKLIST_STABLECOINS` symbols only. The coverage page does not query blacklist summary/events, does not distinguish partial chain/event-family coverage, and does not reflect sync freshness or config gaps. For a tracker feature, "Tracked" should ideally mean that the active event pipeline is healthy for the relevant issuer contract family.

Relevant code:

- `src/lib/coverage.ts`: `resolveBlacklistCoverage()` checks `BLACKLIST_SYMBOLS.has(coin.symbol)`.
- `src/hooks/use-coverage-matrix-model.ts`: no blacklist query is loaded or included in `staleQueries`.

Recommendation: derive blacklist coverage from a stablecoin-ID keyed config/status feed, with chain/event-family granularity where available. At minimum, include blacklist freshness in the stale-data banner and clarify that current coverage is "configured issuer family coverage".

### 4. High: The coverage denominator is active-only, but the page copy says "tracked stablecoins"

The page says it covers tracked stablecoins, but the implementation uses `ACTIVE_STABLECOINS`, currently 180 of 190 tracked metadata entries. Pre-launch assets and PSI shadow assets are excluded. That may be the right product choice, but it is not explicit on the page.

Relevant code:

- `shared/lib/stablecoins/index.ts`: `TRACKED_STABLECOINS` includes pre-launch; `ACTIVE_STABLECOINS` excludes them.
- `src/app/coverage/page.tsx`: copy interpolates `ACTIVE_STABLECOINS.length` but says "tracked stablecoins".

Recommendation: say "180 active tracked stablecoins" and add a small note or filter for "pre-launch excluded". If the goal is truly comprehensive Pharos coverage, consider a separate pre-launch section with all features marked intentionally not applicable.

### 5. Medium-High: Row totals and feature snapshot totals use different meanings of "covered"

The snapshot uses special headline metrics for Price (>=3 sources), Reserves (live only), and Redemption (strong only), while per-coin `coverageCount` counts any `available: true` status, including price-only NAV coverage, curated/proof reserve views, and fallback DEX coverage. This is defensible, but the page does not make the difference obvious.

Impact: "Covered 8/9" on a mobile card can read like strong effective coverage even when some of those states are weaker forms of coverage than the headline metrics.

Relevant code:

- `src/lib/coverage.ts`: `buildCoverageFeatureSummary()` can use `headlineFilter`/`headlineKinds`, while `coverageCount` uses all available statuses.
- `src/app/coverage/coverage-mobile-card.tsx`: mobile cards foreground a single `Covered x/9` count.

Recommendation: split "available coverage" from "strong/live/high-confidence coverage", or expose a weighted/qualified coverage score that matches the snapshot semantics.

### 6. Medium-High: Status semantics depend on title tooltips and an incomplete legend

Most status explanations live in the `title` attribute on `CoverageBadge`. That is poor on touch devices, inconsistent for keyboard users, and not visible enough for a page whose value depends on nuanced labels like Mixed, Fallback, Proof, Curated-Validated, Price only, Heur., Config., and Node. The legend currently covers only a subset of abbreviations.

Relevant code:

- `src/app/coverage/coverage-badge.tsx`: status detail is exposed through `title`.
- `src/app/coverage/coverage-page-sections.tsx`: legend only renders `LEGEND_ITEMS`.

Recommendation: replace title-only disclosure with visible details in the legend, a row/column info affordance, or a lightweight popover that is keyboard and touch accessible. Expand the legend to all non-obvious states.

### 7. Medium: The matrix is not yet a full analysis tool for finding gaps

Filters only cover five positive feature-presence slices: redemption, live reserves, yield, flows, blacklist. There is no direct way to find "missing safety", "missing DEX", "single-source price", "fallback DEX only", "no dependency graph", "not live reserve", or "full 9/9 coverage". Feature sort ranks exist in the data model but are not exposed as column sorting.

Relevant code:

- `src/lib/coverage-page-config.ts`: `CoverageFilterKey` and `FILTER_OPTIONS`.
- `src/app/coverage/coverage-filtering.ts`: filter and sort implementation.

Recommendation: add "gaps" filters and column sort controls. Highest-value filters are missing safety, weak price sources, no DEX, no live reserves, no flows, no dependency, and fully covered.

### 8. Medium: Mobile default cards hide five of nine feature states

Mobile previews only show Price, DEX, Live Sync, and Flows. Safety, Redemption, Yield, Blacklist, and Dependency require expanding each card. That keeps cards compact, but it weakens the "comprehensive per-coin overview" goal on mobile and hides several high-value risk/coverage states.

Relevant code:

- `src/lib/coverage-page-config.ts`: `MOBILE_PREVIEW_FEATURES`.
- `src/app/coverage/coverage-mobile-card.tsx`: remaining features are inside `<details>`.

Recommendation: either preview a more representative set (Price, Safety, Reserves, Redemption, Flows) or add compact coverage-group chips before expansion.

### 9. Medium-Low: Touch targets on mobile filters are below the repo's 44px audit target

Filter chips and some reset/action buttons use `h-8` or compact padding, which is below the audit skill's 44px target for touch controls.

Relevant code:

- `src/app/coverage/coverage-page-sections.tsx`: filter buttons and empty-state suggestion buttons.
- `src/app/coverage/coverage-mobile-card.tsx`: card detail link is OK at `min-h-11`; filter controls are the main issue.

Recommendation: use `min-h-11` for mobile controls, with denser sizing only at `sm+`.

### 10. Low: The page renders both mobile cards and desktop table DOM trees

The mobile card list and desktop table are conditionally hidden with CSS breakpoints, but both are rendered for every filtered row. At 180 rows this is manageable today, but it duplicates badges/logos and increases initial DOM work.

Relevant code:

- `src/app/coverage/coverage-page-sections.tsx`: both `md:hidden` cards and `hidden md:block` table are rendered.

Recommendation: consider viewport-aware rendering or virtualization if the active universe grows materially beyond the current 180 rows.

## Positive Findings

- The page has a clear high-level structure: feature snapshot, pricing source inventory, then matrix.
- Current live data was internally consistent: every active stablecoin had a stablecoin payload row, and all seven queried feeds returned usable data.
- The implementation uses shared API paths, runtime schemas, freshness metadata, and `getCirculatingRaw()`, avoiding known supply calculation pitfalls.
- Redemption heuristic/configured states are explicitly excluded from "strong" headline coverage, which is a good trust-preserving choice.
- Targeted coverage tests are meaningful and passed.
- Desktop and mobile layouts are visually coherent with the Pharos design system and did not show console warnings or layout-breaking overflow in the checked viewports.

## Suggested Priority

1. Fix loading/partial-failure semantics before adding more filters.
2. Decide whether "effective coverage" means configured capability or current healthy data, then align reserves and blacklist to that definition.
3. Clarify active-only universe and split strong/live coverage from generic available coverage.
4. Improve status explanations and gap-finding controls.
5. Polish mobile touch targets and rendering efficiency.
