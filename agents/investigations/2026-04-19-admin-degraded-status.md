# 2026-04-19 Admin Degraded Status Investigation

## Summary

`/admin/` reported degraded because public health saw stale DEWS freshness. The immediate public-health issue was remediated with a targeted DEWS refresh. The underlying half-hourly DEX-liquidity lane recovered on the next observed slot, but it is operating close to the configured Worker CPU budget.

## Timeline

- 2026-04-19 10:40:50 UTC: last successful `sync-dex-liquidity` before the alert window.
- 2026-04-19 10:44:10 UTC: last successful `freshness:dews` before manual action.
- 2026-04-19 16:37:48 UTC: ran `POST /api/backfill-dews?repair=refresh-current` through `ops-api.pharos.watch`.
- 2026-04-19 16:38:04 UTC: `/api/health` returned `healthy`; DEWS age was 16s.
- 2026-04-19 16:40:48 UTC: next half-hourly slot entered `sync-dex-liquidity`.
- 2026-04-19 16:44:45 UTC: half-hourly slot finished `ok`, including `sync-dex-liquidity`, `compute-dews`, and `stability-index`.

## Findings

- The alert was real enough to act on: DEWS was about 11.8x over its 30-minute freshness budget and close to the 12x stale cutoff.
- Other public-impact surfaces were healthy at the time of remediation: mint/burn was fresh, blacklist amount gaps were zero, and no public-impact circuit breakers were open.
- The blocked sequence was the half-hourly chain: `sync-stablecoin-charts` completed, then `sync-dex-liquidity` acquired a lease without downstream `compute-dews` or `stability-index` completion.
- Manual DEWS refresh succeeded with 160 rows written and no validation failures. The repair execution was marked degraded because it used stale DEX-liquidity input, which was expected before the DEX lane recovered.
- The next observed half-hourly slot recovered naturally and refreshed DEX-liquidity plus downstream DEWS/PSI.
- Wrangler tail reported about 30,512ms CPU time for the successful 16:40 scheduled invocation, very close to the configured 30,000ms Worker CPU budget.

## Residual Risk

The incident appears transient after the 16:40 recovery, but the half-hourly slot has little CPU headroom. A DEX-liquidity run with slightly more CPU work may be killed by the platform before cron error logging or lease cleanup runs, leaving stale `cron_slot_executions` rows and blocking downstream jobs for that slot.

Recommended follow-up: reduce CPU pressure in the half-hourly DEX-liquidity path or decouple DB-only downstream jobs (`compute-dews`, `stability-index`) so a DEX-liquidity overrun cannot age DEWS/PSI into degraded health.
