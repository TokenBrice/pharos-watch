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

`syncBluechip()` in `worker/src/cron/sync-bluechip.ts` owns bounded batched fetching, schema normalization and merged writes through `setCacheIfNewer()`. A cache younger than six hours skips neutrally (`cache-fresh`); an open Bluechip circuit returns degraded (`bluechip-circuit-open`) without fetching. Fetch deadlines cover headers and bounded body completion. HTML is stripped from SMIDGE summaries; omitted/null categories are accepted. Invalid JSON, 404, empty/no-grade and transport failures are slug-local unresolved observations, not deletion or unrating.

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

`BluechipRatingSchema` in `shared/types/bluechip.ts` owns the cached row shape; `shared/types/core.ts` owns grades. Nullable source fields and plain-text SMIDGE summaries are reference data, not locally inferred assessments.

`lastObservedAt` is the constituent's last successful fetch, independent of map publication and Bluechip's external `dateOfRating`/`dateLastChange`. `observationState` and `observationReason` retain current/retained/stale/unknown provenance and failed-attempt or age-expiry reasons; legacy unknown clocks remain null.

---

## API Contract

`GET /api/bluechip-ratings` is implemented by `handleBluechipRatings` in `worker/src/api/cache-handlers.ts`.

- Reads the `bluechip-ratings` cache key directly.
- Starts from the `slow` cache profile (`public, s-maxage=3600, max-age=300`); freshness headers clamp TTLs to the remaining fresh runway and force `no-store` for stale or invalid future-clock responses.
- Applies freshness headers with a 43,200-second max-age budget (the `Warning: stale` header fires at 8x that, ~345,600s; `_meta.status` becomes `stale` at 12x, ~518,400s).
- Returns a top-level object keyed by canonical Pharos stablecoin ID.
- The endpoint uses `createCacheHandler()` with `BluechipRatingsMapSchema`, then reassesses each constituent's observation age; it returns 503 when the cache is missing or malformed. Response `_meta` describes the map publication, not every constituent's last observation. Legacy caches and archived V8 fixed-input captures default missing provenance to `lastObservedAt: null`, `observationState: "unknown"`, `observationReason: "legacy-observation-unknown"`.

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Usage

The registered `bluechipRatings` query (`src/hooks/api-hooks.ts`) uses the producer interval; Selector admits only eligible constituents under `isBluechipRatingCurrent`, while detail/compare display each external grade with its neutral original observation date (`Observed YYYY-MM-DD`, or `Observation date unavailable` for a missing, invalid or future clock) via `bluechipObservationText` in `src/lib/bluechip.ts`. The 48h observation states are scoring admission, not reader warnings, so retained/stale/unknown labels are not shown.

The detail badge links only to the external Bluechip report. Pharos qualification/tenure is suspended pending the V10 grade-floor review; `/about/#bluechip` states that rule without fetching a roster. Neither visible copy nor accessible labels infer Pharos tenure from Bluechip's external rating date. `src/lib/bluechip.ts` owns the external report base and grade ordering.
