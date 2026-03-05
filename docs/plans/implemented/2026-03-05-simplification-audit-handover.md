# Simplification Audit Handover (Context Snapshot)

**Date:** 2026-03-05  
**Status:** Ready for implementation handoff  
**Scope:** Frontend (`src/*`) + Worker (`worker/src/*`) simplification, deduplication, structural cleanup

## 1) Why this file exists

This memo preserves the full audit state because the prior working context was near limit. It captures:

1. What was already analyzed and confirmed.
2. The current prioritized implementation plan (Tier 1/2/3).
3. Concrete next actions and guardrails so execution can resume without re-discovery.

No code changes were made in the audit phase. This is a handoff artifact only.

## 2) Outputs already produced

The following planning artifacts already exist and should be treated as companion docs:

1. `docs/plans/2026-03-04-maintainability-audit-remediation-implementation-plan.md`
2. `docs/plans/2026-03-04-simplification-unified-tier1-tier2-tier3-implementation-plan.md`

This handover adds the latest concrete evidence gathered during the simplification-focused audit session and the final tiered execution sequence discussed after that audit.

## 3) Structural survey snapshot

### 3.1 Code volume (TS/TSX)

- Total (`src` + `worker/src`): **86,479 LOC**
- Largest concentration:
  1. `src/components`: 21,237
  2. `src/lib`: 15,034
  3. `worker/src/cron`: 14,136
  4. `src/app`: 11,048
  5. `worker/src/lib`: 10,615
  6. `worker/src/api`: 10,404

### 3.2 Production-heavy modules (tests excluded)

1. `src/components`: 20,960
2. `src/lib`: 11,451
3. `src/app`: 11,048
4. `worker/src/cron`: 10,289
5. `worker/src/api`: 6,709
6. `worker/src/lib`: 6,275
7. `src/hooks`: 2,039

### 3.3 Duplication baseline (jscpd)

1. **104** exact clones
2. **2,977** duplicated lines
3. **~3.18%** duplication

Largest non-test clone hotspot:

- `src/app/stability-index/client.tsx` <-> `src/app/stability-index-alt/client.tsx`
- 11 clone blocks, **1,032 cloned lines** total (largest blocks 315L and 199L)

## 4) Confirmed findings (high-confidence)

| ID | Category | Location | Issue | Impact | Effort |
| --- | --- | --- | --- | --- | --- |
| F1 | Duplication + drift risk | `src/app/stability-index/client.tsx`, `src/app/stability-index-alt/client.tsx`, both `page.tsx` | PSI and PSI-alt duplicate major logic and content, but behavior/text has drifted | High | Med/High |
| F2 | Repeated UI pattern | `src/components/*table*.tsx` (`yield`, `liquidity`, `flow`, `depeg-tracker`, `blacklist`) | Sort/paginate/table scaffolding repeated across feature tables | High | Medium |
| F3 | Structural redundancy | `src/lib/api-endpoints.ts`, `worker/src/router.ts`, `worker/src/index.ts` | Endpoint semantics duplicated across registry + router + method gates | High | High |
| F4 | Accidental complexity | `worker/src/api/stablecoin-detail.ts` | Monolithic handler with repeated stale-cache fallback branches | High | Med/High |
| F5 | Duplication | `src/app/methodology/*-changelog/page.tsx` | Near-identical wrapper pages | Medium | Low |
| F6 | Type/schema duplication | `src/hooks/use-digest-snapshot.ts`, `worker/src/api/digest-snapshot.ts`, `worker/src/cron/daily-digest.ts` | `DigestInputData` shape copied in multiple places | Medium | Low |
| F7 | Boilerplate repetition | `worker/src/api/backfill-cg-prices.ts`, `backfill-supply-history.ts`, `backfill-depegs.ts` | Repeated request parsing/validation/response patterns | Medium | Medium |
| F8 | Content duplication | Multiple feature pages with FAQ UI + JSON-LD FAQ text | FAQ content repeated in separate representations | Medium | Medium |
| F9 | Test setup duplication | Worker test suites (e.g. status/depeg-related suites) | Repeated fixtures and setup scaffolding | Medium | Medium |

## 5) Clarified item: `stability-index-alt`

`stability-index-alt` is currently an alternate PSI page and not the primary route:

1. Route exists at `/stability-index-alt/`.
2. It is not in main nav config (`src/lib/nav-config.ts` points to `/stability-index`).
3. It is marked `noindex` and canonicalized to `/stability-index/` in `src/app/stability-index-alt/page.tsx`.
4. It uses alternate visuals in `src/app/stability-index-alt/client.tsx` (`psi-atmosphere`, `psi-seismograph`, `psi-strata-chart`).

## 6) Tiered implementation plan (final agreed sequence)

## Tier 1 — Quick wins (low-risk, high-impact cleanup)

1. Remove dead/unused exports and files (validated candidates from audit).
2. Centralize digest input/types and remove duplicate interface definitions.
3. Consolidate methodology changelog wrappers into one shared renderer pattern.
4. Make FAQ content single-source-per-page (render + JSON-LD from one data object).

Expected result: immediate LOC reduction, lower drift risk, no API contract changes.

## Tier 2 — High-value refactors (medium effort)

1. Standardize the reusable table pattern (sorting/pagination/head/body plumbing).
2. Extract shared backfill request parser/validator for worker admin backfill endpoints.
3. Decompose `worker/src/api/stablecoin-detail.ts` into focused units while preserving output contract.

Expected result: lower cognitive load in high-change files; easier testing and safer edits.

## Tier 3 — Structural improvements (higher effort)

1. `stability-index-alt` decision gate:
   - Option A: retire and delete if no active product need.
   - Option B: keep but move to shared PSI core + thin presentation variants.
2. Converge endpoint metadata/routing/method gating into one endpoint-definition source.
3. Deduplicate worker test fixtures/setup into shared test utilities.

Expected result: major structural simplification and long-term consistency.

## 7) Execution packaging (recommended PR slicing)

1. **PR-01 (Tier 1A):** Dead code deletion + digest type centralization.
2. **PR-02 (Tier 1B):** Changelog wrapper consolidation + FAQ single-source rendering.
3. **PR-03 (Tier 2A):** Table pattern standardization (migrate 2-3 tables first, then remainder).
4. **PR-04 (Tier 2B):** Backfill parser extraction + stablecoin-detail decomposition.
5. **PR-05 (Tier 3A):** PSI/PSI-alt decision implementation (retire or shared core).
6. **PR-06 (Tier 3B):** Endpoint definition convergence.
7. **PR-07 (Tier 3C):** Worker test dedup and fixture library cleanup.

Rule: each PR must be green independently before starting the next.

## 8) Guardrails and validation gates

Run and record before/after each PR:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

Additional checks:

1. Contract-sensitive endpoints keep status codes and response shape unchanged.
2. No changes to scoring formulas unless explicitly planned and documented.
3. Keep Tailwind class names static (no dynamic class construction).
4. Respect worker concurrency/subrequest limits; avoid introducing new parallel fetch bursts.

## 9) Dead/unused candidates already validated during audit

1. `src/components/pharos-loader.tsx` (exported, no imports found).
2. `src/hooks/use-api-query.ts` -> `useApiQueryWithHealth` (exported, no imports found).
3. `src/components/flow-gauge.tsx` -> `FlowGauge` appears unused as a component import.
4. `src/components/flow-gauge-mini.tsx` -> `FlowGaugeMini` appears unused.

Note: `GAUGE_BANDS` from `flow-gauge.tsx` is used by:

1. `src/components/flow-summary-card.tsx`
2. `src/components/flow-gauge-mini.tsx`

Do not remove shared constants blindly when deleting component code.

## 10) Resume checklist for next engineer

1. Re-run duplication + usage scan to confirm current baseline still matches.
2. Start with Tier 1 PR-01 (lowest blast radius).
3. Capture LOC deltas and test evidence in each PR description.
4. Update relevant docs alongside any behavior-affecting refactor.
5. Keep this file updated as findings are implemented or invalidated.
