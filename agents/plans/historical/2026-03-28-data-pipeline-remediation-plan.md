# 2026-03-28 Data Pipeline Remediation Plan

## Source Audit

Derived from `/agents/audits/2026-03-28-data-pipeline-audit.md`.

## Plan

1. Patch `worker/src/cron/compute-dews.ts`
   - Replace the stale hardcoded blacklist symbol map with a derived registry-backed mapping.
   - Pass `stablecoinsCache.payload.fxFallbackRates` into `derivePegRates()`.
   - Keep the write surface limited to DEWS input assembly only.

2. Add regression coverage
   - Extend `worker/src/cron/__tests__/compute-dews.test.ts` to prove:
     - `PYUSD` / `USD1` blacklist counts flow into DEWS inputs.
     - `derivePegRates()` receives `fxFallbackRates` from the stablecoins cache.
   - Extend `worker/src/cron/__tests__/sync-stablecoin-charts.test.ts` to prove old historical points are not rewritten by live FX repair.

3. Patch `worker/src/cron/sync-stablecoin-charts.ts`
   - Add a narrow recency gate around FX-based repair so only near-live points are eligible for live-FX correction.
   - Preserve existing recent corruption protection and existing stale-source skip behavior.

4. Update docs and methodology surfaces
   - Bump the Depeg/DEWS methodology version and add a changelog entry for:
     - full blacklist-signal coverage parity
     - cached FX fallback parity for thin non-USD DEWS references
   - Update:
     - `docs/dews.md`
     - `docs/depeg-dews-timeline.md`
     - `docs/data-pipeline.md`
     - `docs/worker-infrastructure.md`

5. Validate
   - Run targeted tests for the changed cron modules.
   - Run `npm run lint`.
   - Run `npm test`.
   - Run `npm run build`.
   - Run `cd worker && npx tsc --noEmit`.
   - Run `npm run test:merge-gate`.

## Plan Validation

### Residual Issues Review

1. Medium risk: methodology drift after DEWS input changes.
   - Mitigation: version bump + changelog entry + DEWS docs update.
   - Status after mitigation: closed.

2. Medium risk: chart fix could overcorrect or stop correcting recent corruption.
   - Mitigation: limit only the historical rewrite path; keep recent repair path and add regression coverage.
   - Status after mitigation: closed.

3. Medium risk: blacklist coverage fix could accidentally widen DEWS to unsupported symbols.
   - Mitigation: derive only from shared `BLACKLIST_STABLECOINS`.
   - Status after mitigation: closed.

## Plan Quality Gate

- Remaining medium issues with the plan: 0
- Plan acceptable for implementation: yes
