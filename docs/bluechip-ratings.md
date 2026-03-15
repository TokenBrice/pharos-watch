# Bluechip Ratings

Independent stablecoin safety ratings fetched from Bluechip and exposed through a cached public API.

---

## Overview

- **Source:** `https://backend.bluechip.org/coin-data/{slug}`
- **Cron:** `sync-bluechip` (`worker/src/cron/sync-bluechip.ts`)
- **Schedule:** daily at `5 8 * * *`
- **Storage:** D1 `cache` row with key `bluechip-ratings`
- **API:** `GET /api/bluechip-ratings`

This subsystem is a reference-data sync, not a Pharos-owned scoring model. There is no local methodology versioning layer; Pharos stores and serves Bluechip's latest published grades plus stripped SMIDGE summaries.

---

## Coverage

Coverage is defined explicitly in `worker/src/lib/bluechip-slugs.ts`.

- `BLUECHIP_SLUG_MAP` contains 19 Bluechip slugs mapped to canonical Pharos IDs.
- Only coins present in both systems are fetched.
- Missing or unrated Bluechip rows are skipped rather than synthesized.

Current map covers:
- `usdc`, `usdt`, `dai`, `lusd`, `bold`, `pyusd`, `paxg`, `xaut`, `gusd`, `usdp`, `eurc`, `fdusd`, `frax`, `gho`, `tusd`, `rlusd`, `xsgd`, `ousd`, `cetes`

---

## Sync Flow

`syncBluechip()` in `worker/src/cron/sync-bluechip.ts`:

1. Skips work when the `bluechip-ratings` cache is newer than 6 hours.
2. Iterates the 19 slug mappings in batches of 3, with a 500ms inter-batch delay.
3. Fetches `backend.bluechip.org/coin-data/{slug}` with the shared Worker `USER_AGENT`.
4. Discards 404s, empty payloads, and rows without a `grade`.
5. Normalizes each successful row into `BluechipRating`.
6. Strips HTML from SMIDGE category summaries before persistence.
7. Writes the merged map back with `setCacheIfNewer()`.

Failure behavior:
- If zero ratings are fetched, the cron returns `status: "degraded"` and preserves the previous cache.
- Partial success is accepted; only fulfilled slug fetches are written.

---

## Data Shape

Each cached map value is a `BluechipRating`:

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
- Applies freshness headers with a 43,200-second stale threshold.
- Returns a top-level object keyed by canonical Pharos stablecoin ID.

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Usage

- `src/hooks/api-hooks.ts` exposes `useBluechipRatings()` with `CRON_24H`.
- `src/components/bluechip-header-badge.tsx` renders the external Bluechip badge/link on stablecoin detail pages.
- `src/app/compare/client.tsx` includes Bluechip data in compare-page fetch orchestration and freshness tracking.
- `src/hooks/use-coverage-matrix-model.ts` hydrates `bluechipGrade` into `/coverage` rows via `useBluechipRatings()`.
- `worker/src/lib/report-cards-snapshot.ts` copies the fetched grade into report-card `rawInputs.bluechipGrade` for client-side analysis surfaces.

`src/lib/bluechip.ts` contains:
- `BLUECHIP_REPORT_BASE` (`https://bluechip.org/en/coins`)
- `GRADE_ORDER` for frontend sorting/color bucketing

---

## File Index

| File | Role |
|------|------|
| `worker/src/lib/bluechip-slugs.ts` | Explicit Bluechip slug → Pharos ID coverage map |
| `worker/src/cron/sync-bluechip.ts` | Daily fetch + normalization + cache write |
| `worker/src/api/cache-handlers.ts` | Public cache-passthrough handler for `/api/bluechip-ratings` |
| `src/hooks/api-hooks.ts` | TanStack Query hook export for `useBluechipRatings()` |
| `src/components/bluechip-header-badge.tsx` | Detail-page badge and outbound Bluechip link |
| `src/lib/bluechip.ts` | Frontend sort/base URL helpers |
