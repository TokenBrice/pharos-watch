# Depeg Handoff Investigation: SUSD and USDA

Date: 2026-04-12

## Scope

Investigated reported duplicate depeg events for:

- `susd-synthetix` / SUSD
- `usda-avalon` / USDA

Production D1 was queried read-only through `wrangler d1 execute stablecoin-db --remote`.

## Findings

The current live detector is not creating duplicate open rows. A production query for duplicate active rows returned no rows:

```sql
SELECT stablecoin_id, symbol, COUNT(*) AS open_count, GROUP_CONCAT(id) AS ids
FROM depeg_events
WHERE ended_at IS NULL
GROUP BY stablecoin_id
HAVING COUNT(*) > 1;
```

The reported issue is a backfill-to-live handoff seam. In both reported cases, a `source='backfill'` row was clipped at `2026-03-06 19:32:25 UTC` with `recovery_price = NULL`, then a `source='live'` row opened at `2026-03-06 20:02:24 UTC`.

| asset | backfill id | live id | backfill start UTC | backfill end UTC | live start UTC | gap | recovery price |
| --- | ---: | ---: | --- | --- | --- | ---: | --- |
| SUSD | 45077 | 84559 | 2025-11-04 23:01:15 | 2026-03-06 19:32:25 | 2026-03-06 20:02:24 | 1799 sec | null |
| USDA | 28703 | 84557 | 2025-12-30 21:00:51 | 2026-03-06 19:32:25 | 2026-03-06 20:02:24 | 1799 sec | null |

Supply-history daily price samples also support continuity:

| asset | samples | min price | max price | samples >= 0.99 |
| --- | ---: | ---: | ---: | ---: |
| SUSD, 2025-11-05 through 2026-04-12 | 159 | 0.6011620128 | 0.9856014015 | 0 |
| USDA, 2025-12-31 through 2026-04-12 | 103 | 0.9824064323 | 0.9899245897 | 0 |

The same handoff pattern also exists for `uusd-youves`:

| asset | backfill id | live id | backfill start UTC | backfill end UTC | live start UTC | gap | recovery price |
| --- | ---: | ---: | --- | --- | --- | ---: | --- |
| UUSD | 61446 | 84563 | 2025-09-24 18:02:56 | 2026-03-06 19:32:25 | 2026-03-06 20:02:24 | 1799 sec | null |

## Code Context

- `worker/src/cron/detect-depegs.ts` merges duplicate open events at run start, but only rows with `ended_at IS NULL`.
- `worker/src/api/backfill-depegs.ts` intentionally preserves live rows when replacing backfill rows.
- `worker/src/api/backfill-depegs-extraction.ts` can set `endedAt = lastTs` with `recoveryPrice = null` when a replayed open event reaches the end of an old bounded replay window.
- `worker/src/api/audit-depeg-history.ts` has `repair=synthetic-splits`, but its current 500 bps resume/previous-peak gate catches SUSD and UUSD, not USDA.

## Repair Implication

This is not a live ingestion dedup regression. It is stale historical data that needs a one-time backfill-to-live merge.

Recommended repair shape:

- Preserve the live row id as the keeper.
- Move its `started_at`, `start_price`, and `peg_reference` to the backfill row's start values.
- Preserve the worst peak across the pair.
- Keep `ended_at = NULL` and `recovery_price = NULL`.
- Delete the backfill row.
- Recompute affected PSI days.

Pairs to repair:

- SUSD: merge `45077` into `84559`.
- USDA: merge `28703` into `84557`.
- Consider UUSD: merge `61446` into `84563`.

## Repair Log

Completed on 2026-04-12.

Merged all three matching production handoff pairs:

| asset | deleted backfill id | live keeper id | repaired live start UTC | repaired peak bps | ended_at |
| --- | ---: | ---: | --- | ---: | --- |
| SUSD | 45077 | 84559 | 2025-11-04 23:01:15 | -4225 | null |
| USDA | 28703 | 84557 | 2025-12-30 21:00:51 | -197 | null |
| UUSD | 61446 | 84563 | 2025-09-24 18:02:56 | -1517 | null |

Post-repair verification:

- `SELECT ... WHERE id IN (45077,84559,28703,84557,61446,84563)` now returns only the three live keeper rows.
- Duplicate-open check (`HAVING COUNT(*) > 1`) returns zero rows.
- Backfill-to-live seam query (`source='backfill'` followed by same-direction `source='live'`, `recovery_price IS NULL`, gap <= 1800 sec) returns zero rows.
- Ran `POST /api/backfill-stability-index?startDay=2025-09-24&endDay=2026-04-11`; response: `daysBackfilled=200`, `daysEvaluated=200`, `daysChanged=55`, `skippedInsufficientData=0`, `maxAbsoluteScoreDelta=95.1`.
- Post-rebuild dry-run of the same PSI range returned `daysChanged=0`, `maxAbsoluteScoreDelta=0`.
