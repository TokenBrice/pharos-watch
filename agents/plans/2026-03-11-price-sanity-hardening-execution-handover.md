# Price Sanity Hardening — Execution Handover

**Prepared:** 2026-03-11  
**Status:** Ready for future single-agent execution after context reset

This document is the resume/runbook for implementing the price-sanity hardening plan without needing to rediscover the codebase or reinterpret the plan.

## Read Order After Context Reset

Read these in this order:

1. [2026-03-11-price-sanity-hardening-progress.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-progress.md)
2. [2026-03-11-price-sanity-hardening-execution-handover.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-execution-handover.md)
3. [2026-03-11-price-sanity-hardening-implementation-plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-implementation-plan.md)
4. [2026-03-11-price-sanity-hardening-design.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-design.md)

If context is still tight after that, prioritize:

- progress tracker current state
- current ticket in the implementation plan
- canary asset matrix
- gate conditions

## What This Work Changes

This effort hardens the price-sanity system used by:

- primary stablecoin price ingestion
- fallback enrichment
- DEX observation acceptance
- historical depeg backfill

The critical downstream consequences are:

- `stablecoins` cache publication
- `price_cache` writes and reuse
- `dex_prices` generation
- depeg detection and peg summary
- DEWS / PSI / digest / report-card inputs
- frontend surfaces that read `/api/stablecoins`

## Source Documents

- Design: [2026-03-11-price-sanity-hardening-design.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-design.md)
- Implementation plan: [2026-03-11-price-sanity-hardening-implementation-plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-implementation-plan.md)
- Progress tracker: [2026-03-11-price-sanity-hardening-progress.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-11-price-sanity-hardening-progress.md)
- Deployment process: [docs/deployment-process.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md)

The implementation plan is the canonical ticket source. There are no separate ticket files for this effort.

There are also no external artifact copy steps in this project. Everything required for execution is already in the repository.

## Execution Model

This is a **single-agent, sequential** implementation.

Do not parallelize tickets.  
Do not combine tickets.  
Do not skip shadow/observation gates.

Recommended branch:

```bash
git switch feat/price-sanity-hardening 2>/dev/null || git switch -c feat/price-sanity-hardening
```

Recommended cadence:

- one ticket at a time
- one clean verification run at the end of each ticket
- one commit per ticket or per safe sub-step
- update the progress tracker immediately after each stop point

When a gate requires live observation after deploy, use the normal deployment workflow from [docs/deployment-process.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md). This handover does not redefine deployment; it only defines what must be checked before and after the deploy.

## Ticket Order

1. TICKET-001 — characterization tests
2. TICKET-002 — additive validation core
3. TICKET-003 — shadow mode + telemetry
4. Gate B observation window
5. TICKET-004 — sync/arbitration enforcement
6. Gate C observation window
7. TICKET-005 — DEX enforcement
8. Gate D observation window
9. TICKET-006 — backfill enforcement
10. TICKET-007 — downstream regression review
11. Gate E sign-off
12. TICKET-008 — docs + cleanup

## Hard Gates

These gates are mandatory:

- Gate A: no runtime behavior changes before TICKET-001 is complete
- Gate B: TICKET-003 shadow mode must be deployed and observed before TICKET-004
- Gate C: sync enforcement must stabilize before DEX enforcement
- Gate D: DEX enforcement must stabilize before backfill enforcement
- Gate E: downstream regression review must pass before final docs/sign-off

## Pre-Flight Before Starting Any Ticket

Run:

```bash
git status --short
git branch --show-current
npm run build
cd worker && npx tsc --noEmit && cd ..
```

Then confirm:

- workspace is clean enough to proceed
- current branch is the intended feature branch
- no unrelated partially-finished ticket is still in progress
- progress tracker matches reality

## Canary Assets To Check Throughout

Always keep these in mind:

- `eurc-circle`
- `jpyc-jpyc`
- `brz-transfero`
- `xaut-tether`
- `paxg-pax-gold`
- `kau-kinesis`
- `cgo-comtech`
- `ggbr-goldfish-gold`
- `kag-kinesis`
- `ousg-ondo-finance`
- `ustb-superstate`
- `fpi-frax`
- `isc-international-stable-currency`
- the current tracked USDS ID if present in metadata

## Commands By Ticket

### TICKET-001

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts
```

### TICKET-002

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts \
  worker/src/cron/__tests__/sync-fx-rates.test.ts
cd worker && npx tsc --noEmit
```

### TICKET-003

```bash
npm test -- --run \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/api/__tests__/status.test.ts
npm run build
```

### TICKET-004

```bash
npm test -- --run \
  worker/src/cron/__tests__/enrich-prices.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/cron/__tests__/sync-stablecoins-stages.test.ts \
  worker/src/cron/__tests__/detect-depegs.test.ts
cd worker && npx tsc --noEmit
```

### TICKET-005

```bash
npm test -- --run \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/cron/__tests__/sync-fx-rates.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts
npm run lint
```

### TICKET-006

```bash
npm test -- --run \
  worker/src/api/__tests__/backfill-depegs-helpers.test.ts \
  worker/src/api/__tests__/backfill-depegs.test.ts \
  worker/src/cron/__tests__/detect-depegs.test.ts
cd worker && npx tsc --noEmit
```

### TICKET-007

```bash
npm test -- --run \
  worker/src/cron/__tests__/compute-dews.test.ts \
  worker/src/cron/__tests__/daily-digest.test.ts \
  worker/src/cron/__tests__/stability-index.test.ts \
  worker/src/api/__tests__/mint-burn-flows.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts \
  worker/src/api/__tests__/stability-index.test.ts \
  worker/src/api/__tests__/stress-signals.test.ts \
  worker/src/lib/__tests__/report-cards-snapshot.test.ts \
  worker/src/lib/__tests__/safety-scores.test.ts \
  src/lib/__tests__/stablecoin-detail-view-model.test.ts \
  src/lib/__tests__/stablecoin-schema-compat.test.ts \
  src/components/__tests__/comparison-table.test.tsx
```

### TICKET-008

```bash
npm run build
npm run lint
```

## Observation Windows

### After TICKET-003

Wait and observe at least 24 hours of scheduled runs before starting TICKET-004.

Review:

- `sync-stablecoins` cron metadata shadow counters
- DEX shadow counters if surfaced
- canary mismatches

Recommended remote check if `ADMIN_KEY` is available:

```bash
curl -s https://pharos.watch/api/status \
  -H "Authorization: Bearer ${ADMIN_KEY}" | head -c 4000
```

Look for:

- `crons.sync-stablecoins.lastRun.metadata.priceValidationShadow`
- any shadow fields exposed for DEX/liquidity runs

Fallback if admin auth is not available:

- inspect worker logs for `sync-stablecoins`
- inspect the latest successful cron metadata through the status dashboard UI

Do not continue if:

- canary mismatches are unexplained
- top USD assets show unexplained shadow drift
- commodity or low-nominal FX canaries lose prices unexpectedly

### After TICKET-004

Wait and observe at least 24 hours before TICKET-005.

Review:

- sync metadata
- canary stablecoins payload behavior
- cache-poisoning guard still firing in intended cases only

Recommended checks:

```bash
curl -s https://pharos.watch/api/stablecoins | head -c 4000
curl -s https://pharos.watch/api/status \
  -H "Authorization: Bearer ${ADMIN_KEY}" | head -c 4000
```

### After TICKET-005

Wait and observe at least one full day of DEX scoring + discovery cycles before TICKET-006.

Review:

- canary DEX observation counts
- gold / silver / JPY / BRL behavior
- no per-loop DB regression symptoms

Recommended checks:

```bash
curl -s "https://pharos.watch/api/peg-summary" | head -c 4000
curl -s https://pharos.watch/api/status \
  -H "Authorization: Bearer ${ADMIN_KEY}" | head -c 4000
```

## Manual Smoke Checklist

Before final sign-off, answer these explicitly:

- Did any canary lose a legitimate current price?
- Did any canary gain a clearly bad current price?
- Did any canary lose all DEX observations unexpectedly?
- Did NAV tokens remain exempt from false `$1` anchoring?
- Did fractional commodities use the right unit size everywhere?
- Did DEWS, PSI, digest, report cards, and mint/burn continue to behave sensibly?

## Recommended Local Full Verification Before Merge

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

## Post-Deploy Smoke Checks

If a deploy happens during the future implementation session, check:

```bash
curl -s https://pharos.watch/api/stablecoins | head
curl -s "https://pharos.watch/api/peg-summary" | head
curl -s "https://pharos.watch/api/stability-index" | head
curl -s "https://pharos.watch/api/stress-signals" | head
curl -s "https://pharos.watch/api/mint-burn-flows" | head
curl -s "https://pharos.watch/api/daily-digest" | head
```

If `ADMIN_KEY` is available, also check:

```bash
curl -s https://pharos.watch/api/status \
  -H "Authorization: Bearer ${ADMIN_KEY}" | head -c 4000
```

Spot-check the major frontend surfaces manually:

- homepage
- compare
- dependency map
- safety scores
- stablecoin detail page for one commodity token and one NAV token

## Rollback

No D1 migration is planned in this work. Rollback is code-only.

Rollback principle:

- prefer reverting the most recent enforcement ticket
- if behavior is ambiguous, revert to the last known-good shadow-only state
- keep telemetry if possible, so postmortem review still has data

Suggested rollback order:

1. revert TICKET-008 if docs-only issue
2. revert TICKET-007 if downstream review changes were unsafe
3. revert TICKET-006 if backfill behavior regressed
4. revert TICKET-005 if DEX behavior regressed
5. revert TICKET-004 if sync behavior regressed
6. if needed, revert to TICKET-003 shadow-only state

## Stop Conditions

Stop immediately and update the progress tracker if:

- shadow drift is not explainable
- canary assets behave unexpectedly
- downstream tests begin failing in unexplained ways
- runtime behavior contradicts the design doc

Do not “push through” uncertainty on this project area.

## Resume Protocol After Another Context Reset

If another reset happens mid-implementation:

1. Read the progress tracker
2. Check `git status --short`
3. Check the last completed commit
4. Re-run the current ticket’s targeted verification command
5. Re-open the implementation plan at the current ticket
6. Only continue after the local state and the progress tracker agree
