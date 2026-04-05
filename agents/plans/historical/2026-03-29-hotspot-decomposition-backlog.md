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
- `shared/lib/report-cards.ts`
  - Owner lane: shared scoring and report cards.
  - Next split: separate scoring families, blacklist/live-slice enrichment, and response shaping from the main module.
  - Validation: `npm test -- shared/lib/__tests__/report-cards.test.ts worker/src/api/__tests__/report-cards.test.ts`, `npm run typecheck`.
- `src/components/contagion-graph.tsx`
  - Owner lane: frontend analytics UI.
  - Next split: extract graph math, legend/filter state, and rendering layers into dedicated helpers/components.
  - Validation: `npm test -- src/components`, `npm run build`.
- `src/app/chains/[chain]/client.tsx`
  - Owner lane: frontend chain detail route.
  - Next split: keep route-level tests in place and continue extracting section-local view models from the route shell.
  - Validation: `npm test -- src/app/chains/[chain]/client.test.tsx`, `npm run build`.
- `worker/src/cron/dispatch-telegram-alerts.ts`
  - Owner lane: worker notifications.
  - Next split: isolate alert candidate selection, message rendering, and delivery policy into separate modules.
  - Validation: `npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`, `cd worker && npx tsc --noEmit`.
- `worker/src/cron/dex-liquidity/scoring.ts`
  - Owner lane: worker liquidity pipeline.
  - Next split: split score-family calculations and reusable transforms before adding more heuristics.
  - Validation: `npm test -- worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`, `cd worker && npx tsc --noEmit`.
- `worker/src/cron/sync-live-reserves.ts`
  - Owner lane: worker reserves pipeline.
  - Next split: separate adapter execution, persistence, and summary/publication assembly from the cron shell.
  - Validation: `npm test -- worker/src/cron/__tests__/sync-live-reserves.test.ts`, `cd worker && npx tsc --noEmit`.
- `worker/src/cron/yield-config.ts`
  - Owner lane: worker yield pipeline.
  - Next split: split the adapter registry into manifest families before the config surface grows further.
  - Validation: `npm test -- worker/src/cron/__tests__/yield-config-registry.test.ts`, `cd worker && npx tsc --noEmit`.

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
