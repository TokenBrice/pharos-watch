# Coverage Page Remediation Plan

Date: 2026-04-15

Scope: remediate coverage-page audit findings except finding 3 (blacklist coverage static-by-symbol), per user instruction.

## Goals

- Do not show loading, failed, or partial-feed states as real missing coverage.
- Make reserve coverage more honest by separating configured reserve views from current effective live reserve coverage.
- Make the denominator and terminology match the active-coin implementation.
- Explain status semantics without relying on hover-only tooltips.
- Improve the matrix as a gap-finding tool.
- Improve mobile usefulness, touch targets, and avoid rendering both mobile and desktop row trees after hydration.

## Non-Goals

- Do not change blacklist coverage sourcing.
- Do not add a new external data source.
- Do not alter safety-score, liquidity, yield, mint/burn, redemption, or reserve methodology.
- Do not redesign the page outside the existing Pharos design language.

## Implementation Plan

### 1. Coverage Data Readiness And Partial-Failure Semantics

Files:

- `src/hooks/use-coverage-matrix-model.ts`
- `src/app/coverage/client.tsx`
- `src/app/coverage/coverage-page-sections.tsx`
- `src/lib/coverage.ts`

Changes:

- Add explicit model state:
  - `isInitialDataLoading`: true while required coverage feeds are still pending and no stablecoin market-cap snapshot is available.
  - `isStablecoinDataUnavailable`: true when the stablecoin list has no data and has errored.
  - `unavailableFeatures`: feature keys whose backing query errored or has no data.
- Keep the page from rendering final-looking coverage counts until the stablecoin list is loaded.
- For feature feeds that fail after stablecoin data is available, render affected statuses as a distinct `Data n/a` / `Data unavailable` state, not as `Missing`, `NR`, `Unknown`, or `—`.
- Fix stale-data `hasData` checks to use `query.data !== undefined` rather than non-empty arrays/objects, so a successful empty feed is not misclassified as unavailable.
- Add a compact data-state card for initial loading or stablecoin-feed failure, and keep the existing `StaleDataBanner` for freshness and error context.

Success criteria:

- A slow reload no longer shows `0/180` or `$0` as if it were final coverage.
- A failed individual feed does not pollute unrelated feature columns or totals.

### 2. Reserve Coverage Honesty

Files:

- `src/lib/coverage.ts`
- `src/hooks/use-coverage-matrix-model.ts`
- `src/lib/__tests__/coverage.test.ts`

Changes:

- Extend `buildCoverageRow()` with a conservative `liveReserveFresh` input derived from `reportCard.rawInputs.collateralFromLive`.
- For adapters whose display badge is `live`:
  - `liveReserveFresh === true` -> `Live`, counts in the live reserve headline.
  - `liveReserveFresh === false` -> `Configured`, does not count as live/effective coverage; detail explains that a live adapter exists but the current snapshot did not use fresh live reserve data.
  - `liveReserveFresh === null` -> `Checking`, does not count while report-card data is unavailable.
- Keep `Curated-Validated`, `Proof`, `Curated`, and `Estimated` reserve-view states available as reserve views, but do not let them count in the live reserve headline.
- Update labels/copy so the feature reads as `Reserve View` with a `Live Sync` short label, reducing the mismatch between broad reserve views and live-only headline coverage.

Success criteria:

- The reserve headline is based on fresh live reserve usage, not only configured adapter presence.
- Users can see when reserve coverage is configured but not currently counted as fresh live coverage.

### 3. Active Universe Copy

Files:

- `src/app/coverage/page.tsx`

Changes:

- Change user-facing copy from generic "tracked stablecoins" to "active tracked stablecoins".
- Add a brief note that pre-launch assets are excluded from the active matrix.

Success criteria:

- The 180 denominator no longer implies all 190 tracked metadata entries are included.

### 4. Available Vs Strong/Headline Coverage Semantics

Files:

- `src/lib/coverage.ts`
- `src/app/coverage/coverage-mobile-card.tsx`
- `src/app/coverage/coverage-page-sections.tsx`
- `src/app/coverage/coverage-filtering.ts`
- tests

Changes:

- Add `headlineCoverageCount` to `CoverageRow`, using the same per-feature headline semantics as the snapshot:
  - Price: 3+ sources.
  - Reserves: fresh live reserve status only.
  - Redemption: strong route only, excluding heuristic/configured-unrated.
  - Other features: normal availability.
- Keep `coverageCount` as broad availability, but label it `Available`.
- Surface `Headline/live` count where row totals are shown on mobile.
- Add explanatory copy near the matrix that snapshot counts use stricter thresholds for selected features.

Success criteria:

- `8/9` no longer reads as all-strong coverage when weaker states are contributing.

### 5. Status Legend And Badge Accessibility

Files:

- `src/app/coverage/coverage-badge.tsx`
- `src/lib/coverage-page-config.ts`
- `src/app/coverage/coverage-page-sections.tsx`

Changes:

- Add an accessible `aria-label` to `CoverageBadge` that includes the visible label, source count, and status detail.
- Expand the legend to cover all non-obvious states used by the page:
  - Price: Tracked, Price only, Missing, Data n/a.
  - Safety: Rated, NR.
  - DEX: Primary, Mixed, Fallback, Legacy, NR.
  - Reserves: Live, Configured, Checking, Curated-Validated, Proof, Curated, Estimated, None.
  - Redemption: Issuer, PSM, Queue, Collat., Stable, Basket, Heur., Config., Impaired.
  - Flows: Full, Partial, Lagging, Bootstr., Disabled.
  - Dependency: Node.
- Keep the legend collapsible to preserve page density.

Success criteria:

- Users can understand statuses without hover-only behavior.
- Screen-reader output includes status detail.

### 6. Gap-Finding Filters And Sorts

Files:

- `src/lib/coverage-page-config.ts`
- `src/app/coverage/coverage-filtering.ts`
- `src/app/coverage/use-coverage-filters.ts`
- `src/app/coverage/coverage-page-sections.tsx`
- tests

Changes:

- Add high-value filters:
  - `Weak price`
  - `No safety`
  - `No DEX`
  - `No live reserves`
  - `No flows`
  - `No dependency`
  - `Fully available`
  - `Fully headline/live`
- Add sort options:
  - `Least available`
  - `Most headline/live`
  - `Weakest headline/live`
  - `Weakest: Price`, `Safety`, `DEX`, `Reserves`, `Redemption`, `Yield`, `Flows`, `Dependency`
- Sort feature-specific options by `status.sortRank` ascending, then market cap descending.

Success criteria:

- Users can find both coverage gaps and strongest-coverage coins without manual scanning.

### 7. Mobile Overview Improvements

Files:

- `src/lib/coverage-page-config.ts`
- `src/app/coverage/coverage-mobile-card.tsx`

Changes:

- Change mobile preview features to a more representative default set:
  - Price, Safety, Reserves, Redemption, Flows.
- Keep the remaining features in the expanded details.
- Show both `Available` and `Headline/live` counts in the mobile card header.

Success criteria:

- Mobile users see risk/coverage-critical states before expanding each card.

### 8. Touch Targets

Files:

- `src/app/coverage/coverage-page-sections.tsx`

Changes:

- Use `min-h-11` for filter/reset/suggestion controls on mobile, with compact heights restored at `sm+` where density is acceptable.

Success criteria:

- Mobile interactive controls meet the 44px target.

### 9. Avoid Duplicate Mobile/Desktop Row Trees

Files:

- `src/app/coverage/coverage-page-sections.tsx`
- `src/hooks/use-is-mobile.ts` (reuse only)

Changes:

- Use `useIsMobile(768)` in the coverage matrix card to render mobile cards or the desktop table after hydration, instead of always rendering both trees and hiding one with CSS.
- Keep the current responsive classes as a defensive layout layer.

Success criteria:

- After hydration, only the active viewport row tree is mounted.

## Tests And Verification

- Update/extend:
  - `src/lib/__tests__/coverage.test.ts`
  - `src/app/coverage/coverage-filtering.test.ts`
- Run:
  - `npm test -- src/lib/__tests__/coverage.test.ts src/app/coverage/coverage-filtering.test.ts`
  - `npm run lint` if touched code creates lint-sensitive changes.
- Browser verification:
  - Start `npm run dev`.
  - Inspect `/coverage/` desktop and mobile.
  - Confirm no initial false `0/180` state on reload.
  - Confirm filter/sort controls work and no console warnings appear.

## Plan Review Loop

### Review Pass 1

Issues found:

1. Minor: The initial plan did not define what happens if `reportCards` is unavailable but static reserve metadata exists.
2. Minor: The plan mentioned feature-specific weakest sort for Blacklist even though blacklist sourcing is out of scope.
3. Minor: The mobile rendering optimization could cause a brief SSR/hydration mismatch if not framed as "after hydration".

Fixes applied:

1. Reserve coverage now distinguishes `Checking` for live adapters when report-card data is unavailable, while static/proof/curated reserve views remain visible.
2. Feature-specific weakest sort excludes Blacklist. Existing Blacklist positive filter may remain unchanged, but no new blacklist remediation is planned.
3. The optimization is explicitly "after hydration" and keeps responsive classes as a defensive layer.

### Review Pass 2

Remaining issues: none above minor. The plan is ready for implementation.
