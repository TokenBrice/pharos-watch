# Price Sanity Hardening — Progress Tracker

**Last updated:** 2026-03-11

## Current State

**Active ticket:** Gate B observation window  
**Current gate:** Gate B pending deploy + observation  
**Next action:** Deploy the current branch, observe shadow validation metadata for at least 24 hours, then decide whether TICKET-004 can begin
**Current branch:** `main`
**Last verified commit:** `6952d4ef`

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
- [ ] Started
- [ ] Completed
- [ ] Targeted verification passed
- [ ] Deployed
- [ ] Observation window completed
- [ ] Notes captured below

### TICKET-005 — DEX Enforcement
- [ ] Started
- [ ] Completed
- [ ] Targeted verification passed
- [ ] Deployed
- [ ] Observation window completed
- [ ] Notes captured below

### TICKET-006 — Backfill Enforcement
- [ ] Started
- [ ] Completed
- [ ] Targeted verification passed
- [ ] Notes captured below

### TICKET-007 — Downstream Regression Review
- [ ] Started
- [ ] Completed
- [ ] Downstream checks passed
- [ ] Notes captured below

### TICKET-008 — Docs + Cleanup
- [ ] Started
- [ ] Completed
- [ ] Final doc verification passed
- [ ] Notes captured below

## Gate Checklist

### Gate A
- [x] TICKET-001 complete before any runtime behavior change

### Gate B
- [ ] TICKET-003 deployed
- [ ] 24h observation completed
- [ ] Shadow mismatches explained
- [ ] Top USD assets reviewed
- [ ] Canary assets reviewed

### Gate C
- [ ] TICKET-004 deployed
- [ ] 24h observation completed
- [ ] Sync behavior stable
- [ ] Canary assets reviewed

### Gate D
- [ ] TICKET-005 deployed
- [ ] DEX observation window completed
- [ ] No canary asset unexpectedly lost all usable observations

### Gate E
- [ ] TICKET-007 complete
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
- TICKET-004:
- TICKET-005:
- TICKET-006:
- TICKET-007:
- TICKET-008:

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

## Resume Checklist

After a context reset:

1. Read this file first
2. Confirm the active ticket
3. Confirm the current gate
4. Check `git status --short`
5. Re-run the current ticket’s targeted verification
6. Resume only when this file matches the repository state
