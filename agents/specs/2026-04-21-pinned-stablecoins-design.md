# Pinned Stablecoins Design

## Request

Users want to pin stablecoins near the top of the homepage so their personal depeg watchlist is visible immediately on repeat visits. The requester explicitly accepted local-only configuration.

## Assumptions

- Pins are private, per-browser state. No account model, Worker API, D1 table, or shareable URL state is needed for the first version.
- More than one pinned stablecoin should be supported because a depeg watchlist is naturally plural.
- Pins should not change canonical data, methodology, SEO metadata, or public API responses.
- If localStorage is unavailable, the UI can still operate in-memory for the current render path and fail gracefully on persistence.

## Recommendation

Implement this as a frontend-only starred-row watchlist:

1. Add a localStorage-backed pin preference.
2. Add a compact star/unstar icon control in a locked leading table column.
3. Prioritize starred rows at the top of the current filtered table result.

This keeps the watchlist in the surface the user already scans and avoids adding another card above the table.

## UX Shape

The table row control should be an icon button left of the rank column, using a star icon from the existing lucide icon set and `pharos-focus-ring`. It must call `stopPropagation()` so it does not trigger row navigation.

## Data Model

Storage key:

```text
pharos-pinned-stablecoins
```

Value:

```ts
string[] // stablecoin ids in display order
```

Decoder behavior:

- accept arrays only
- keep only ids in `ACTIVE_IDS`
- de-duplicate while preserving stored order
- cap at a conservative maximum such as 12 to prevent layout bloat

Implementation can live in:

- `src/hooks/use-pinned-stablecoins.ts` for hook state
- `src/lib/pinned-stablecoins.ts` for pure normalization helpers

Use the existing storage utilities in `src/lib/browser-storage.ts` and the same local preference pattern used by `src/hooks/use-preferences.ts`.

## Integration Points

Relevant current files:

- `src/components/homepage-client.tsx` owns the under-fold homepage order and already has stablecoin, logo, peg-summary, stress, liquidity, and report-card data.
- `src/components/stablecoin-table.tsx` owns filtering, sorting, virtualization, CSV export, and row rendering.
- `src/components/stablecoin-table-row.tsx` owns the clickable row and star cell rendering.
- `src/components/stablecoin-table-logic.ts` owns pure filter/sort logic and is the right place for `prioritizePinnedStablecoins(...)`.
- `docs/homepage.md` should be updated because the table state contract changes.

## Table Behavior

Preferred table rule:

- Filtering/search still define the table universe.
- Sorting still defines order inside pinned and unpinned groups.
- Pinned rows that are visible under the current filters appear before unpinned rows.
- Pinned coins that are filtered out remain hidden until the filter/search changes.

This preserves filter honesty while still satisfying the "show directly" use case.

CSV export can use the current displayed table order. That is acceptable because export already follows the current lens rather than a canonical market-cap ranking.

## Out Of Scope

- Backend persistence
- Accounts or cross-device sync
- Shareable watchlist URLs
- Reordering pins by drag-and-drop
- Telegram subscriptions or alerting behavior
- Methodology version changes

## Validation

Implementation should include:

- unit tests for pin decoder normalization
- stablecoin table logic tests for pinned partition behavior
- component tests for pin/unpin storage and rendering
- `npm run lint`
- targeted `npm test -- stablecoin-table pinned-stablecoins` or equivalent
- `npm run typecheck`

Before pushing, run `npm run test:merge-gate`.
