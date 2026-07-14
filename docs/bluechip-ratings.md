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
- The daily sync applies `excludeFrozenIds()` before fetching, so any mapped asset that later becomes frozen is skipped at runtime instead of being refreshed into the active ratings cache.
- Missing or unrated Bluechip rows are skipped rather than synthesized.

---

## Sync Flow

`syncBluechip()` in `worker/src/cron/sync-bluechip.ts`:

1. Skips work when the `bluechip-ratings` cache is newer than 6 hours.
2. Iterates the configured slug mappings in batches of 3, with a 500ms inter-batch delay.
3. Fetches `backend.bluechip.org/coin-data/{slug}` with the shared Worker `USER_AGENT`.
4. Discards 404s, empty payloads, and rows without a `grade`.
5. Normalizes each successful row into `BluechipRating`, accepting Bluechip category blocks that are omitted or explicitly `null`.
6. Strips HTML from SMIDGE category summaries before persistence.
7. Treats malformed/non-JSON `200` responses as slug-scoped `json-parse-failed` misses so one bad payload does not abort the full daily refresh.
8. Writes the merged map back with `setCacheIfNewer()`.

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
- The handler is a custom cache reader that appends `_meta = { updatedAt, ageSeconds, status }` to the plain-object response after reading the cached Bluechip payload.

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Usage

- `src/hooks/api-hooks.ts` exposes `useBluechipRatings()` with `CRON_24H`.
- `src/components/bluechip-header-badge.tsx` renders the external `Bluechip: <grade>` badge/link in the stablecoin detail hero so the grade is clearly separate from Pharos-owned scores.
- `src/app/compare/client.tsx` includes Bluechip data in compare-page fetch orchestration and freshness tracking.
- `worker/src/lib/report-cards-snapshot-card.ts` copies the fetched grade into report-card `rawInputs.bluechipGrade` for client-side analysis surfaces.

`src/lib/bluechip.ts` contains:
- `BLUECHIP_REPORT_BASE` (`https://bluechip.org/en/coins`)
- `GRADE_ORDER` for frontend sorting/color bucketing
