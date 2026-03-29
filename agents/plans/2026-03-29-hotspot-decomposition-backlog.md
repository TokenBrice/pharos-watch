# Hotspot Decomposition Backlog

This note turns the hotspot ratchet into an explicit simplification program. The source of truth for tracked files and current metrics remains [`scripts/lib/hotspot-ratchet-baseline.json`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/hotspot-ratchet-baseline.json); this note summarizes the intended next move for each queued or deferred hotspot.

Each entry now carries three planning fields:
- `Owner lane`: the area responsible for the next split.
- `Next split`: the concrete decomposition target.
- `Validation`: the checks that must stay green before the backlog note and ratchet baseline are updated.

## Immediate P4 Queue
- `src/app/methodology/sections/core/safety-scores-section.tsx`
  - Owner lane: methodology content UI.
  - Next split: isolate calculator wiring, grading pipeline copy, and large tables.
  - Validation: `npm test -- src/app/methodology`, `npm run build`.
- `src/app/methodology/sections/core/liquidity-section.tsx`
  - Owner lane: methodology content UI.
  - Next split: separate table-heavy technical detail from the overview shell.
  - Validation: `npm test -- src/app/methodology`, `npm run build`.
- `src/app/methodology/sections/core/mint-burn-flow-section.tsx`
  - Owner lane: methodology content UI.
  - Next split: isolate the detailed pipeline/tables block from the shell.
  - Validation: `npm test -- src/app/methodology`, `npm run build`.
- `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`
  - Owner lane: methodology content UI.
  - Next split: extract source-arbitration and PYS deep-dive blocks if the section grows again.
  - Validation: `npm test -- src/app/methodology`, `npm run build`.
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
  - Owner lane: methodology content UI.
  - Next split: separate PegScore-specific and DEWS-specific detail blocks before adding more copy.
  - Validation: `npm test -- src/app/methodology`, `npm run build`.
- `src/app/methodology/scoring-changelog/content-v6.tsx`
  - Owner lane: methodology docs.
  - Next split: preserve major-version grouping and split again only if another large v6 tranche lands.
  - Validation: `npm run build`, `npm run check:doc-sync`.
- `src/app/methodology/scoring-changelog/content-v5.tsx`
  - Owner lane: methodology docs.
  - Next split: keep legacy v5 grouped, but do another grouping pass if that file changes materially.
  - Validation: `npm run build`, `npm run check:doc-sync`.
- `src/app/methodology/scoring-changelog/content-legacy.tsx`
  - Owner lane: methodology docs.
  - Next split: preserve the legacy split and avoid mixing current methodology changes into it.
  - Validation: `npm run build`, `npm run check:doc-sync`.
- `worker/src/cron/daily-digest.ts`
  - Owner lane: worker notifications.
  - Next split: complete. Keep future delivery/provider changes in `cron/digest/*` helpers instead of regrowing the cron shell.
  - Validation: `npm test -- worker/src/cron/__tests__/daily-digest.test.ts`, `cd worker && npx tsc --noEmit`.
- `worker/src/cron/sync-blacklist.ts`
  - Owner lane: worker monitoring pipeline.
  - Next split: post-fetch hydration is done; the remaining pass is to separate source crawling/orchestration from family-specific normalization.
  - Validation: `npm test -- worker/src/cron/blacklist`, `cd worker && npx tsc --noEmit`.
- `worker/src/cron/sync-fx-rates.ts`
  - Owner lane: worker pricing pipeline.
  - Next split: keep helper extraction and reduce orchestration size in the next pass.
  - Validation: `npm test -- worker/src/cron/__tests__/sync-fx-rates.test.ts`, `cd worker && npx tsc --noEmit`.
## Deferred Queue
- `worker/src/cron/daily-digest/collectors.ts`
  - Owner lane: worker notifications.
  - Next split: defer until digest-source scope stabilizes, then split by collector family.
  - Validation: `npm test -- worker/src/cron/__tests__/daily-digest.test.ts`, `cd worker && npx tsc --noEmit`.
- `worker/src/cron/yield-sync/sources.ts`
  - Owner lane: worker yield pipeline.
  - Next split: defer until the yield-source inventory is stable, then split by source family and manifest.
  - Validation: `npm test -- worker/src/cron/__tests__/yield-sync`, `cd worker && npx tsc --noEmit`.

## Stabilized Files

- `src/app/coverage/client.tsx`
- `worker/src/api/stablecoin-detail.ts`
- `worker/src/api/feedback.ts`
- `worker/src/handlers/http.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices.ts`
- `worker/src/lib/live-reserves-store.ts`
- `worker/src/lib/status-evaluation.ts`
- `worker/src/lib/status-reliability.ts`

These are now treated as maintained shells or facades. Keep new logic in helper modules instead of re-growing them.
