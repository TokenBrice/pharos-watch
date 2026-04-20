# Depeg Repair Script Consolidation Follow-Up

Date: 2026-04-20

Related finding: `R-08` from `agents/audits/2026-04-20-multi-agent-codebase-audit.md`

## Scope

The Phase 3 remote-D1 hardening pass makes the root depeg repair scripts dry-run by default, brings them under SQL-safety scanning, and removes shell-string Wrangler execution. It does not fully retire or consolidate the bootstrap repair scripts into the Worker admin replay helpers.

Remaining redundancy:

- `scripts/fix-non-usd-depeg-fx.ts`
- `scripts/fix-commodity-depeg-median.ts`
- `worker/src/api/backfill-depegs-replay.ts`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts`

## Target Remediation

- Decide whether the root `fix-*` scripts are still needed after the current backfill history repair window.
- If still needed, move shared query/replay/delete/update construction into a runtime-neutral helper used by both root scripts and Worker/admin replay paths.
- If no longer needed, remove the root scripts and the matching `docs/scripts.md` entries.

## Validation Target

- `npm run check:sql-safety`
- `npm test -- scripts/__tests__/remote-d1.test.ts scripts/__tests__/sql-interpolation-safety.test.ts`
- Targeted replay/backfill tests for any shared helper extraction.
