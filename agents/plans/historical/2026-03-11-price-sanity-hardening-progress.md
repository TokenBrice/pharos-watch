# Price Sanity Hardening — Progress Tracker

**Last updated:** 2026-03-11

## Current State

**Active ticket:** Post-deploy gate verification  
**Current gate:** Gates B-E pending formal verification/closure  
**Next action:** Complete the remaining observation and downstream sign-off steps before declaring the rollout fully verified
**Current branch:** `main`
**Last verified commit:** `d0b33a4c`

## Ticket Checklist

### TICKET-001 — Characterization Tests
- [x] Started
- [x] Completed
- [x] Targeted verification passed
- [x] Notes captured below

### TICKET-002 — Additive Validation Core
- [x] Started
- [x] Completed
- [x] Targeted verification passed
- [x] Notes captured below

### TICKET-003 — Shadow Mode + Telemetry
- [x] Started
- [x] Completed
- [x] Targeted verification passed
- [x] Deployed
- [ ] Observation window completed
- [x] Notes captured below

### TICKET-004 — Sync / Arbitration Enforcement
- [x] Started
- [x] Completed
- [x] Targeted verification passed
- [x] Deployed
- [ ] Observation window completed
- [x] Notes captured below

### TICKET-005 — DEX Enforcement
- [x] Started
- [x] Completed
- [x] Targeted verification passed
- [x] Deployed
- [ ] Observation window completed
- [x] Notes captured below

### TICKET-006 — Backfill Enforcement
- [x] Started
- [x] Completed
- [x] Targeted verification passed
- [x] Notes captured below

### TICKET-007 — Downstream Regression Review
- [x] Started
- [x] Completed
- [x] Downstream checks passed
- [x] Notes captured below

### TICKET-008 — Docs + Cleanup
- [x] Started
- [x] Completed
- [x] Final doc verification passed
- [x] Notes captured below

## Gate Checklist

### Gate A
- [x] TICKET-001 complete before any runtime behavior change

### Gate B
- [x] TICKET-003 deployed
- [ ] 24h observation completed
- [ ] Shadow mismatches explained
- [ ] Top USD assets reviewed
- [ ] Canary assets reviewed

### Gate C
- [x] TICKET-004 deployed
- [ ] 24h observation completed
- [ ] Sync behavior stable
- [ ] Canary assets reviewed

### Gate D
- [x] TICKET-005 deployed
- [ ] DEX observation window completed
- [ ] No canary asset unexpectedly lost all usable observations

### Gate E
- [x] TICKET-007 complete
- [ ] DEWS reviewed
- [ ] PSI reviewed
- [ ] digest reviewed
- [ ] report cards / safety scores reviewed
- [ ] mint-burn reviewed
- [ ] peg summary reviewed
- [ ] homepage reviewed
- [ ] compare reviewed
- [ ] dependency map reviewed

## Canary Review Log

Use this section to record actual outcomes for the required canaries:

- `eurc-circle`:
- `jpyc-jpyc`:
- `brz-transfero`:
- `xaut-tether`:
- `paxg-pax-gold`:
- `kau-kinesis`:
- `cgo-comtech`:
- `ggbr-goldfish-gold`:
- `kag-kinesis`:
- `ousg-ondo-finance`:
- `ustb-superstate`:
- `fpi-frax`:
- `isc-international-stable-currency`:
- current tracked USDS ID:

## Commit Log

- TICKET-001: characterization tests added for BRL alias, KAU/CGO/ GGBR commodity canaries, OUSG/FPI behavior, non-USD dual-primary divergence, and stale-FX sync vs enrichment contrast
- TICKET-002: additive `worker/src/lib/price-validation.ts` core added with canonical context builder, reference loader, structured validator, and pure unit coverage
- TICKET-003: sync and DEX shadow-validation metadata added without changing live acceptance; sync sample mismatches capped, DEX shadow counters emitted into cron metadata
- Deployment commit: `e7f4a5f9 feat(worker): add price-sanity shadow validation telemetry`
- TICKET-004: sync now uses reference-driven dual-primary selection for fixed pegs and honors the new validator for primary/cached admission; local verification passed, deployment still pending
- TICKET-005: DEX observation validation now loads references once per orchestrator and enforces the new validator for scoring/discovery observation acceptance; local verification passed, deployment still pending
- TICKET-006: historical backfill extraction now validates each price point against its direct peg reference in `historical_backfill` mode; local verification passed
- TICKET-007: downstream regression suite passed for DEWS, PSI, digest, report-card snapshot, safety scores, mint-burn flows, peg summary, status, and frontend stablecoin consumers
- TICKET-008: data-pipeline, DEX-liquidity, depeg-detection, data-flow-map, and README docs updated to match the new validation behavior

## Incident / Drift Log

Record anything that blocks progression:

- Workspace contains pre-existing non-task changes before execution start:
  - moved 2026-03-10 plan files between `agents/plans/` and `agents/plans/historical/`
  - unrelated modification in `shared/lib/stablecoins.ts`
  These should not be reverted by the price-sanity work unless explicitly required by a later ticket.
- TICKET-001 verification passed:
  - `npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts worker/src/api/__tests__/backfill-depegs-helpers.test.ts`
- TICKET-002 verification passed:
  - `npm test -- --run worker/src/lib/__tests__/price-validation.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts worker/src/api/__tests__/backfill-depegs-helpers.test.ts worker/src/cron/__tests__/sync-fx-rates.test.ts`
  - `cd worker && npx tsc --noEmit`
- TICKET-003 verification passed:
  - `npm test -- --run worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/api/__tests__/status.test.ts`
  - `npm run build`
- TICKET-003 deployed directly with Wrangler:
  - `cd worker && npx wrangler deploy`
  - current version id observed after deploy: `72e30c26-2ba1-4bca-b613-bdbb9e14d3f2`
- Initial post-deploy observation captured from production:
  - `sync-stablecoins`: `priceValidationShadow.compared=994`, `mismatched=5`, mismatch stages = `dual_primary_apply`, `post_enrichment_reject`
  - `sync-dex-discovery`: `priceValidationShadow.comparedObs=2`, `deltaAccepted=0`
  - `sync-dex-liquidity`: `priceValidationShadow.comparedObs=1089`, `deltaAccepted=0`
- Gate B remains open until the full 24h observation window is completed and the canary mismatches are reviewed.
- Canonical deployment path corrected:
  - commits pushed to `main`: `e7f4a5f9`, `8d4813b9`
  - GitHub Actions deploy run `22943416958` completed successfully
  - worker deploy, API smoke, Pages deploy, and UI smoke all passed
  - earlier manual Wrangler-deploy observations should be treated as superseded by the GitHub deployment
- Full enforcement deployment completed:
  - commit pushed to `main`: `d0b33a4c`
  - GitHub Actions deploy run `22946313474` completed successfully
  - worker deploy, API smoke, Pages deploy, and UI smoke all passed
- User-directed override:
  - user explicitly instructed execution to continue before the full Gate B 24h window completed
  - current partial Gate B observations before override:
    - `sync-stablecoins`: 3 additional runs, stable mismatch profile (`5 / 994`, deep-downside cases only)
    - `sync-dex-discovery`: 2 additional runs, `deltaAccepted=0`
    - `sync-dex-liquidity`: 2 additional runs, `deltaAccepted=0`
- TICKET-004 local verification passed:
  - `npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/sync-stablecoins-stages.test.ts worker/src/cron/__tests__/detect-depegs.test.ts`
  - `cd worker && npx tsc --noEmit`
- TICKET-005 local verification passed:
  - `npm test -- --run worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts worker/src/cron/__tests__/sync-fx-rates.test.ts worker/src/api/__tests__/peg-summary.test.ts`
  - `npm run lint`
- TICKET-006 local verification passed:
  - `npm test -- --run worker/src/api/__tests__/backfill-depegs-helpers.test.ts worker/src/api/__tests__/backfill-depegs.test.ts worker/src/cron/__tests__/detect-depegs.test.ts`
  - `cd worker && npx tsc --noEmit`
- TICKET-007 local verification passed:
  - `npm test -- --run worker/src/cron/__tests__/compute-dews.test.ts worker/src/cron/__tests__/daily-digest.test.ts worker/src/cron/__tests__/stability-index.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/api/__tests__/stability-index.test.ts worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/stress-signals.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/safety-scores.test.ts src/lib/__tests__/stablecoin-detail-view-model.test.ts src/lib/__tests__/stablecoin-schema-compat.test.ts src/components/__tests__/comparison-table.test.tsx`
- Final full verification passed:
  - `npm run build`
  - `npm run lint`
  - `npm test`
  - `cd worker && npx tsc --noEmit`
- Current formal verification state:
  - implementation is fully deployed
  - Gates B-E remain open until observation/manual sign-off completes

## Resume Checklist

After a context reset:

1. Read this file first
2. Confirm the active ticket
3. Confirm the current gate
4. Check `git status --short`
5. Re-run the current ticket’s targeted verification
6. Resume only when this file matches the repository state
