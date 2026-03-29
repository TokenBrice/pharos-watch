# Hotspot Decomposition Backlog

This note turns the hotspot ratchet into an explicit simplification program. The source of truth for tracked files and current metrics remains [`scripts/lib/hotspot-ratchet-baseline.json`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/hotspot-ratchet-baseline.json); this note summarizes the intended next move for each queued or deferred hotspot.

## Immediate P4 Queue

- `worker/src/cron/sync-stablecoins.ts`
  - Split orchestration from persistence and degraded-mode recovery.
- `src/app/methodology/sections/core/safety-scores-section.tsx`
  - Next split should isolate calculator wiring, grading pipeline copy, and large tables.
- `src/app/methodology/sections/core/liquidity-section.tsx`
  - Follow-up should separate table-heavy technical detail from the overview shell.
- `src/app/methodology/sections/core/mint-burn-flow-section.tsx`
  - Keep the shell split; next pass should isolate the detailed pipeline/tables block.
- `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`
  - Extract source-arbitration and PYS deep-dive blocks if the section grows again.
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
  - Split PegScore-specific and DEWS-specific detail blocks before adding more copy.
- `src/app/methodology/scoring-changelog/content-v6.tsx`
  - Keep major-version grouping; split again only if another large v6 tranche lands.
- `src/app/methodology/scoring-changelog/content-v5.tsx`
  - Legacy v5 history is still dense enough to justify another grouping pass if edited.
- `src/app/methodology/scoring-changelog/content-legacy.tsx`
  - Preserve the legacy split and avoid mixing current methodology changes into it.
- `worker/src/cron/daily-digest.ts`
  - Isolate cron orchestration from delivery/idempotency concerns.
- `worker/src/cron/sync-blacklist.ts`
  - Separate crawling, normalization, and balance hydration phases.
- `worker/src/cron/sync-fx-rates.ts`
  - Keep helper extraction; next split should reduce orchestration size.
- `worker/src/lib/live-reserves-store.ts`
  - Separate read/query helpers, write paths, and integrity reporting.
- `worker/src/lib/status-reliability.ts`
  - Extract persistence and alert-throttling from discrepancy classification.

## Deferred Queue

- `src/app/coverage/client.tsx`
  - Defer until the methodology/content split settles; then split state orchestration from rendering.
- `worker/src/cron/daily-digest/collectors.ts`
  - Defer until digest-source scope stabilizes; then split by collector family.
- `worker/src/cron/yield-sync/sources.ts`
  - Defer until the yield-source inventory is stable; then split by source family and manifest.

## Stabilized Files

- `worker/src/api/stablecoin-detail.ts`
- `worker/src/api/feedback.ts`
- `worker/src/handlers/http.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices.ts`
- `worker/src/lib/status-evaluation.ts`

These are now treated as maintained shells. Keep new logic in helper modules instead of re-growing them.
