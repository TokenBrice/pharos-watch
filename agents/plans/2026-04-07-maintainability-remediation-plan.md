# Maintainability Remediation Plan — 2026-04-07

## Scope

Implement the full set of maintainability and production-risk fixes identified in the 2026-04-07 audit, including the sustainability roadmap items.

## Sequence

1. Fix PSI degraded-input publication and API observability.
2. Preserve live-reserve fallback-chain failure context.
3. Split `worker/src/lib/api-utils.ts` into focused modules behind a compatibility barrel.
4. Add explicit numeric range policies and move public endpoints to reject out-of-range values.
5. Decompose `worker/src/api/backfill-depegs.ts` into replay, preview, and extraction modules.
6. Consolidate shared Pages proxy orchestration.
7. Factor mint/burn flow cache/fallback/freshness scaffolding.
8. Extract safety-score and PSI route view-model logic.
9. Add direct route-client regression tests for both routes.
10. Update docs and rerun the full validation surface.

## Validation target

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `cd worker && npx tsc --noEmit`
- `npm run build`
