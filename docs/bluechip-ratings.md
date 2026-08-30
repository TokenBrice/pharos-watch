# Bluechip Ratings

Independent stablecoin safety ratings fetched from Bluechip and exposed through a cached public API.

---

## Overview

- **Source:** `https://backend.bluechip.org/coin-data/{slug}`
- **Cron:** `sync-bluechip` (`worker/src/cron/sync-bluechip.ts`)
- **Schedule:** `daily0805Utc` (`5 8 * * *`)
- **Storage:** D1 `cache` row with key `bluechip-ratings`
- **API:** `GET /api/bluechip-ratings`

This subsystem is a reference-data sync, not a Pharos-owned scoring model. There is no local methodology versioning layer; Pharos stores and serves Bluechip's latest published grades plus stripped SMIDGE summaries.

---

## Coverage

Coverage is defined explicitly in `shared/lib/bluechip-slugs.ts`; do not copy its volatile roster or count into this document.

- `BLUECHIP_SLUG_MAP` maps supported Bluechip slugs to canonical Pharos IDs.
- Only coins present in both systems are fetched.
- The daily sync applies `includeActiveTrackedIds()`, so only explicitly active mapped assets are fetched; inactive lifecycle states are never re-fetched, but the cron merges fresh rows onto the previous cache, so a rating cached while the asset was active is retained until the cache key is rewritten.
- Missing or unrated Bluechip rows are skipped rather than synthesized.

---

## Sync Flow

`syncBluechip()` in `worker/src/cron/sync-bluechip.ts`:

1. Skips work when the `bluechip-ratings` cache is newer than 6 hours and returns no `status` with metadata reason `cache-fresh`.
2. If `shouldAttemptFetch()` returns false because the shared Bluechip circuit breaker is open, returns `status: "degraded"` with metadata reason `bluechip-circuit-open` and performs no fetch.
3. Iterates the configured slug mappings in batches of 3, with a 500ms inter-batch delay.
4. Fetches `backend.bluechip.org/coin-data/{slug}` with the shared Worker `USER_AGENT`.
5. Discards 404s, empty payloads, and rows without a `grade`.
6. Normalizes each successful row into `BluechipRating`, accepting Bluechip category blocks that are omitted or explicitly `null`.
7. Strips HTML from SMIDGE category summaries before persistence.
8. Treats malformed/non-JSON `200` responses as slug-scoped `json-parse-failed` misses so one bad payload does not abort the full daily refresh.
9. Writes the merged map back with `setCacheIfNewer()`.

Failure behavior:
- If zero ratings are fetched, the cron returns `status: "degraded"` and preserves the previous cache.
- Partial success is accepted, but fresh rows are now merged onto the previous cache instead of replacing it wholesale. When only a subset of slugs succeeds, the cron returns `status: "degraded"` with `fallbackMode: "partial-cache-merge"` and preserves the last good values for missed slugs.
- Degraded partial-refresh runs still count as a healthy breaker outcome when at least one slug refreshed, so repeated partial merges do not incorrectly open the Bluechip API circuit.

---

## Data Shape

Each cached map value is a `BluechipRating` (`shared/types/bluechip.ts`, re-exported via `shared/types/market.ts`); the grade union is defined in `shared/types/core.ts`.

| Field | Meaning |
|-------|---------|
| `grade` | Bluechip letter grade |
| `slug` | Bluechip report slug |
| `collateralization` | Numeric collateralization percentage |
| `smartContractAudit` | Audit-presence boolean from Bluechip |
| `dateOfRating` | Rating date string |
| `dateLastChange` | Last grade-change date string or `null` |
| `smidge` | Plain-text summaries for `stability`, `management`, `implementation`, `decentralization`, `governance`, `externals` |

---

## API Contract

`GET /api/bluechip-ratings` is implemented by `handleBluechipRatings` in `worker/src/api/cache-handlers.ts`.

- Reads the `bluechip-ratings` cache key directly.
- Uses the `slow` cache profile (`public, s-maxage=3600, max-age=300`).
- Applies freshness headers with a 43,200-second max-age budget (the `Warning: stale` header fires at 8x that, ~345,600s; `_meta.status` becomes `stale` at 12x, ~518,400s).
- Returns a top-level object keyed by canonical Pharos stablecoin ID.
- The endpoint is the shared `createCacheHandler()` factory bound to the `bluechip-ratings` cache key and `BluechipRatingsMapSchema`; it returns 503 when the cache row is missing or the payload fails validation, and otherwise appends `_meta = { updatedAt, ageSeconds, status }` to the plain-object response.

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Usage

- `src/hooks/api-hooks.ts` exposes `useBluechipRatings()` via the registered `bluechipRatings` query descriptor, whose producer interval is `CRON_BLUECHIP` (derived from `CRON_INTERVALS["sync-bluechip"]`).
- `src/components/bluechip-header-badge.tsx` renders the external `Bluechip: <grade>` badge/link plus the Pharos-owned `Pharos Bluechip · since YYYY-MM` link to `/about/bluechip/` in the stablecoin detail hero, so the external grade stays clearly separate from Pharos-owned scores.
- `src/hooks/use-selector.ts` reads the ratings map as one of the Selector's inputs.
- `src/app/about/bluechip/active-list.tsx` renders the Pharos Bluechip roster from the ratings map plus V9 report cards.
- `src/hooks/use-compare-data-model.ts` folds Bluechip ratings into the compare-page query slices, error propagation, `bluechipMap` projection, and refetch orchestration behind `src/components/compare/compare-client.tsx` (lazily loaded by `src/app/compare/page.tsx`).

`src/lib/bluechip.ts` contains:
- `BLUECHIP_REPORT_BASE` (`https://bluechip.org/en/coins`)
- `GRADE_ORDER` for frontend sorting/color bucketing
