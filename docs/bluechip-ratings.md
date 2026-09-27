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
- The daily sync applies `includeActiveTrackedIds()`, so only explicitly active mapped assets are fetched. Previously observed rows remain available as labelled retained records, never renewed by a sibling's successful fetch.
- Missing, 404, empty-data and no-grade responses are unresolved observations, not authoritative deletion or unrating. No rating is synthesized for an unseen asset.

---

## Sync Flow

`syncBluechip()` in `worker/src/cron/sync-bluechip.ts`:

1. Skips work when the `bluechip-ratings` cache is newer than 6 hours and returns `status: "skipped_neutral"` with metadata reason `cache-fresh`.
2. If `shouldAttemptFetch()` returns false because the shared Bluechip circuit breaker is open, returns `status: "degraded"` with metadata reason `bluechip-circuit-open` and performs no fetch.
3. Iterates the configured slug mappings in batches of 3, with a 500ms inter-batch delay.
4. Fetches `backend.bluechip.org/coin-data/{slug}` with the shared Worker `USER_AGENT`.
5. Records 404s, empty payloads and missing grades as unresolved failures, preserving any original observation clock.
6. Normalizes each successful row into `BluechipRating`, accepting Bluechip category blocks that are omitted or explicitly `null`.
7. Strips HTML from SMIDGE category summaries before persistence.
8. Treats malformed/non-JSON `200` responses as slug-scoped `json-parse-failed` misses so one bad payload does not abort the full daily refresh.
9. Writes the merged map back with `setCacheIfNewer()`.

Failure behavior:
- If zero ratings are fetched, the cron returns `status: "degraded"`. Any retained-row reason/state changes are persisted at the **existing** map timestamp, without advancing successful publication.
- Partial success merges new observations onto retained records and returns `status: "ok"` plus `quality.reason: "partial-cache-merge"` (the CR-10 publication/quality distinction). Only successful constituents receive a new `lastObservedAt`.
- Partial refresh counts as a healthy breaker outcome when at least one slug refreshed.

### Constituent observation window

`BLUECHIP_OBSERVATION_MAX_AGE_SEC` in `shared/lib/bluechip-freshness.ts` is **two daily source-poll intervals (48 hours)**, derived from `CRON_INTERVALS["sync-bluechip"]`; `shared/lib/cron-jobs.ts` assigns `daily0805Utc`, documented in Overview above. This permits one missed daily poll, not an assertion that Bluechip revises its editorial ratings daily. At exactly 48h the observation is still within budget; beyond it the row is `stale`. The public handler and consumers reassess age, even without another successful cron.

Successful observations are `current` with no reason; unsuccessful fetches retain the original clock and become `retained` within budget, or `stale` outside it. Reasons preserve the failed attempt (`http-404`, `no-grade`, `empty-data`, transport/parse failures); age expiry without a failed-attempt reason uses `observation-expired`. Unknown legacy clocks and future clocks are `unknown`, never initialized from the map timestamp or current time.

Selector scoring, grade exclusions and recommendations admit only within-budget `current`/`retained` records; unresolved 404/no-grade/empty-data records are ineligible immediately. Stale/unknown/missing grades are unavailable inputs, not positive or negative current evidence. Detail and compare may still display the external grade with a retained/stale/unknown label. A successful later fetch restores current eligibility. The Pharos-owned designation remains suspended.

---

## Data Shape

Each cached map value is a `BluechipRating` (`shared/types/bluechip.ts`, re-exported via `shared/types/market.ts`); the grade union is defined in `shared/types/core.ts`.

| Field | Meaning |
|-------|---------|
| `grade` | Bluechip letter grade |
| `slug` | Bluechip report slug |
| `lastObservedAt` | Unix seconds of this rating's last successful fetch; `null` for legacy/unknown provenance |
| `observationState` | `current`, `retained`, `stale`, or `unknown`; derived from constituent age, not map publication |
| `observationReason` | `null` for successful current observations; machine-readable failed-attempt/expiry/unknown reason otherwise |
| `collateralization` | Numeric collateralization percentage, or `null` when Bluechip does not report it |
| `smartContractAudit` | Audit-presence boolean from Bluechip, or `null` when it is not reported |
| `dateOfRating` | Rating date string, or `null` when Bluechip does not report it |
| `dateLastChange` | Last grade-change date string or `null` |
| `smidge` | Plain-text summaries for `stability`, `management`, `implementation`, `decentralization`, `governance`, `externals` |

---

## API Contract

`GET /api/bluechip-ratings` is implemented by `handleBluechipRatings` in `worker/src/api/cache-handlers.ts`.

- Reads the `bluechip-ratings` cache key directly.
- Uses the `slow` cache profile (`public, s-maxage=3600, max-age=300`).
- Applies freshness headers with a 43,200-second max-age budget (the `Warning: stale` header fires at 8x that, ~345,600s; `_meta.status` becomes `stale` at 12x, ~518,400s).
- Returns a top-level object keyed by canonical Pharos stablecoin ID.
- The endpoint uses `createCacheHandler()` with `BluechipRatingsMapSchema`, then reassesses each constituent's observation age; it returns 503 when the cache is missing or malformed. Response `_meta` describes the map publication, not every constituent's last observation. Legacy caches and archived V8 fixed-input captures default missing provenance to `lastObservedAt: null`, `observationState: "unknown"`, `observationReason: "legacy-observation-unknown"`.

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Usage

- `src/hooks/api-hooks.ts` exposes `useBluechipRatings()` via the registered `bluechipRatings` query descriptor, whose producer interval is `CRON_BLUECHIP` (derived from `CRON_INTERVALS["sync-bluechip"]`).
- `src/components/bluechip-header-badge.tsx` renders only the external `Bluechip: <grade>` badge/report link in both responsive stablecoin detail identity layouts. While the Pharos roster is suspended, no Pharos qualification or tenure appears in visible text, link titles, or accessible labels. An external `dateOfRating` is never evidence of Pharos designation tenure.
- `src/hooks/use-selector.ts` reads the ratings map as one of the Selector's inputs.
- `src/app/about/bluechip/page.tsx` states the roster rule statically; the roster itself is suspended pending the V9 grade-floor review, so `/about/bluechip/` requests neither the ratings map nor the V9 report cards.
- `src/hooks/use-compare-data-model.ts` folds Bluechip ratings into the compare-page query slices, error propagation, `bluechipMap` projection, and refetch orchestration behind `src/components/compare/compare-client.tsx` (lazily loaded by `src/app/compare/page.tsx`).

`src/lib/bluechip.ts` contains:
- `BLUECHIP_REPORT_BASE` (`https://bluechip.org/en/coins`)
- `GRADE_ORDER` for frontend sorting/color bucketing
