# 2026-03-29 Audit Remediation Execution Plan

Scope: execute the actionable findings from [2026-03-29-full-codebase-audit-blueprint.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-29-full-codebase-audit-blueprint.md) with emphasis on correctness, duplication removal, and maintainability improvements that can land safely in one implementation branch.

## Goal

Reduce the current audit surface to zero unresolved medium-or-higher implementation issues in the changes delivered by this branch, while preserving public behavior and keeping repo guardrails green.

## Closure Status

Status: completed on `2026-03-29`.

Resolved directly in code:
- `Q1` through `Q4`
- `R1` through `R16`
- `S1` through `S3`

Addressed with validated tooling evidence:
- `S4` dependency lag is now partially remediated and fully triaged.
- `lucide-react` was upgraded to `1.7.0` and validated.
- `eslint` remains on `9.39.4` because the current Next lint stack does not support `eslint@10` cleanly in this repo.
- `typescript` remains on `5.9.3` because the installed `@typescript-eslint` toolchain does not yet support TypeScript `6` here.

Net result:
- No unresolved audit findings remain that require additional code changes in this branch.
- The only non-upgraded dependency-major items are closed as ecosystem-blocked, with current versions verified as healthy by `npm audit`, `lint`, `typecheck`, build, and test passes.

## Workstreams

### WS1 Trust-Boundary And Quality Fixes

Targets:
- `Q1` Binance circuit outcome recording
- `Q2` fail-closed handling for unexpected `dex_prices` failures
- `Q3` Bluechip cache schema validation on read/write paths
- `Q4` digest prompt log redaction

Files:
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/sync-bluechip.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `worker/src/cron/daily-digest.ts`
- related worker tests
- shared Bluechip schema surface if needed

Validation:
- targeted worker tests for confirm-pending-depegs, sync-bluechip, report-cards snapshot, dex-liquidity contracts, daily-digest
- `cd worker && npx tsc --noEmit`

### WS2 Quick-Win Deduplication

Targets:
- `R12` shared PSI chart-data builder
- `R13` shared blacklist path/param builder
- `R15` duplicate sidebar tokens
- `R16` variant-scanner prefix/suffix helper
- `R9` generic PSI JSON decode helper
- `R10` shared discovery-candidate mapper
- `R7` reserve-sync-state row mapper

Files:
- `src/components/psi-history-chart.tsx`
- `src/app/stability-index/client.tsx`
- `src/lib/blacklist-api.ts`
- `src/hooks/use-blacklist-events.ts`
- `src/styles/tokens/semantic.css`
- `worker/src/cron/yield-sync/variant-scanner.ts`
- `worker/src/api/stability-index.ts`
- `worker/src/api/discovery.ts`
- `worker/src/api/status-supplements.ts`
- `worker/src/lib/live-reserves-store.ts`
- related tests

Validation:
- targeted frontend and worker unit tests
- `npm run lint`
- `npm test`

### WS3 Shared-Origin And Maintainability Cleanup

Targets:
- `S3` shared OG/origin helper usage
- `S2` explicit hotspot simplification program with owners and next actions
- partial `S1` improvement by documenting and tightening the doc-sync authority surface without changing methodology semantics

Files:
- `shared/lib/runtime-origins.ts`
- `src/lib/page-metadata.ts`
- selected route metadata call sites
- `docs/testing.md`
- `agents/plans/2026-03-29-hotspot-decomposition-backlog.md`
- optional doc-sync helper/docs if low-risk

Validation:
- `npm run check:doc-sync`
- `npm run check:hotspot-ratchet`
- `npm run build`

## Execution Order

1. Fix quality/trust-boundary issues first so later refactors operate on safer primitives.
2. Collapse the nearby duplication while those files are already open.
3. Centralize origin handling and formalize the hotspot backlog.
4. Run targeted tests after each workstream, then full validation at the end.

## Risks And Mitigations

- Risk: worker trust-boundary changes alter degraded-mode behavior.
  - Mitigation: keep the missing-table fallback, but fail closed for all other DB errors and cover both branches with tests.
- Risk: shared Bluechip schema rejects legacy cache payloads.
  - Mitigation: define the schema from the current runtime shape and add tests for malformed and valid legacy-compatible values.
- Risk: origin-helper cleanup changes metadata URLs.
  - Mitigation: centralize URL construction only, keep canonical host values unchanged, and verify with `npm run build`.
- Risk: hotspot/program docs drift from the actual ratchet baseline.
  - Mitigation: reference the baseline file directly and update docs in the same change.

## Validation Contract

Targeted:

```bash
npm test -- worker/src/cron/__tests__/confirm-pending-depegs.test.ts
npm test -- worker/src/cron/__tests__/sync-bluechip.test.ts
npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts
npm test -- src/lib/__tests__/stablecoin-detail-view-model.test.ts src/lib/__tests__/public-status.test.ts src/components/__tests__/yield-source-sheet.test.tsx
```

Repository-wide:

```bash
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm test
npm run build
npm run check:unused-code
npm run check:shared-cycles
npm run check:hotspot-ratchet
npm run check:doc-sync
```

Stretch gate if the touched-file classifier requires it:

```bash
npm run test:merge-gate
```

## Plan Self-Review

Initial review found two medium planning risks:
- The original audit mixed strategic hotspot work with immediate correctness fixes.
- The doc-sync modernization scope could balloon if treated as a full rewrite.

Plan adjustment:
- Split immediate execution into three bounded workstreams.
- Limit this branch’s doc-sync work to authority tightening and keep a full parser/manifest rewrite out of scope unless it becomes necessary to clear a failing check.

Result:
- Remaining plan issues: `0` medium, `0` high.

## Final Validation

Executed successfully on the live worktree:

```bash
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm test
npm run build
npm run check:unused-code
npm run check:shared-cycles
npm run check:hotspot-ratchet
npm run check:doc-sync
npm audit
npm ls eslint lucide-react typescript --depth=0
```

Observed results:
- `npm test`: `362` files passed, `3534` tests passed, `1` todo
- `npm audit`: `0` vulnerabilities
- `npm run test:merge-gate`: skipped cleanly because merged diff vs `origin/main` was `0` files on the uncommitted worktree
