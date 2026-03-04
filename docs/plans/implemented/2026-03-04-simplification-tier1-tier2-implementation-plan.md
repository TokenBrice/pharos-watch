# Simplification Refactor Implementation Plan — Tier 1 + Tier 2

**Date:** 2026-03-04  
**Status:** Proposed (implementation-ready)  
**Owner:** Engineering  
**Scope:** Simplification, deduplication, and structural convergence for low/medium risk workstreams.

## 1. Objective

Execute all Tier 1 and Tier 2 refactors from the audit with behavior parity, measurable code deletion, and clear sequencing that supports autonomous implementation without additional architectural decisions.

Primary outcomes:

1. Remove dead code and duplicate contracts.
2. Standardize repeated page and endpoint patterns.
3. Reduce change-surface for future features and fixes.

## 2. Scope

In scope:

1. Remove unused `use-yield-history` hook.
2. Deduplicate status response types (`worker/src/api/status.ts` vs `src/lib/types.ts`).
3. Extract shared stablecoin history query parsing for worker endpoints.
4. Collapse repetitive route error wrappers with a shared factory.
5. Normalize Radix dependency usage (single import strategy).
6. Consolidate repeated methodology changelog page scaffolding (6 pages).
7. Extract shared feature page shell/metadata builder for repeated top-level pages.
8. Centralize endpoint registry used by worker routing/cache rules and status-page probes/actions.

Out of scope:

1. Mint/burn pipeline split.
2. Stablecoin detail page decomposition.
3. Global schema/interface strategy migration beyond target Tier 1/2 items.

## 3. Guardrails

1. No user-facing feature additions.
2. No endpoint shape changes unless explicitly listed and contract-tested.
3. Prefer deletion over new abstraction; only extract when 3+ concrete callsites exist.
4. Keep Tailwind classes static strings.
5. Keep current cron cadence, cache TTL semantics, and admin auth semantics unchanged.
6. Update relevant docs for each changed subsystem before completion.

## 4. Baseline Targets

Approximate optimization target for Tier 1+2:

1. Net code reduction: 900-1,700 LOC.
2. Eliminate at least 3 multi-file duplication clusters.
3. Reduce endpoint definition drift points from 4+ files to 1 source-of-truth module.

## 5. Execution Order

Implement in this order to minimize merge conflicts and regression risk:

1. W1 dead code removal.
2. W2 status type dedup.
3. W3 worker query parser extraction.
4. W4 error wrapper factory.
5. W5 Radix dependency normalization.
6. W6 changelog renderer consolidation.
7. W7 feature page shell/metadata helper.
8. W8 endpoint registry centralization.

Rationale:

1. Tier 1 first creates low-risk cleanup and shared primitives.
2. Tier 2 then migrates repetitive structures using primitives.
3. Endpoint registry last avoids mid-stream churn while page and worker edits are in flight.

## 6. Work Packages

## W1 — Remove Unused Yield History Hook (Tier 1)

### Current State

`src/hooks/use-yield-history.ts` is unused in app/components/hooks callsites.

### File Changes

1. Delete: `src/hooks/use-yield-history.ts`
2. Update docs: `docs/architecture.md` hook inventory section.

### Implementation Steps

1. Delete the file.
2. Run `rg -n "useYieldHistory\\(" src` to ensure no references remain.
3. Remove hook mention from architecture docs.

### Risks

1. Hidden dynamic import usage (unlikely).

### Verification

1. `npm run lint`
2. `npm run build`
3. `rg -n "useYieldHistory\\(" src` returns no hits.

## W2 — Deduplicate Status Types (Tier 1)

### Current State

`worker/src/api/status.ts` defines local `CronRun`, `CronStatus`, `DataQuality`, and `StatusResponse` duplicated in `src/lib/types.ts`.

### File Changes

1. Modify: `worker/src/api/status.ts`
2. Use `import type { StatusResponse, CronRun, CronStatus, DataQuality } from "../../../src/lib/types";`
3. Remove local interfaces from `worker/src/api/status.ts`.

### Implementation Steps

1. Replace local interface declarations with shared type-only imports.
2. Keep runtime behavior untouched.
3. Ensure no worker runtime import of Zod values is introduced.

### Risks

1. Accidental value import from `src/lib/types.ts` can pull frontend runtime dependencies.

### Verification

1. `cd worker && npx tsc --noEmit`
2. `npm run test -- worker/src/api/__tests__/status.test.ts`
3. `npm run build`

## W3 — Shared Stablecoin History Query Parser (Tier 1)

### Current State

`supply-history`, `yield-history`, and `dex-liquidity-history` duplicate query parsing/validation for `stablecoin` and `days`.

### File Changes

1. Modify: `worker/src/lib/api-utils.ts`
2. Add helper:
   - `parseStablecoinHistoryQuery(url, opts)`
   - returns either `{ stablecoinId, days, cutoff }` or `Response` error.
3. Modify:
   - `worker/src/api/supply-history.ts`
   - `worker/src/api/yield-history.ts`
   - `worker/src/api/dex-liquidity-history.ts`
4. Add tests:
   - `worker/src/lib/__tests__/api-utils.test.ts`
   - endpoint tests where message behavior must remain stable.

### Helper Contract

1. Preserve exact error messages:
   - missing ID: `Missing ?stablecoin= parameter`
   - invalid ID: `Invalid stablecoin ID`
2. Preserve per-endpoint day defaults/ranges:
   - supply-history: `365, 1..1825`
   - yield-history: `90, 1..365`
   - dex-liquidity-history: `90, 1..365`

### Risks

1. Unintended change to day bounds or error responses can break tests/clients.

### Verification

1. `npm run test -- worker/src/lib/__tests__/api-utils.test.ts`
2. `npm run test -- worker/src/api/__tests__/supply-history.test.ts worker/src/api/__tests__/yield-history.test.ts worker/src/api/__tests__/dex-liquidity-history.test.ts`
3. `npm run lint`

## W4 — Route Error Wrapper Factory (Tier 1)

### Current State

Many `src/app/**/error.tsx` files are nearly identical wrappers around `PageError`.

### File Changes

1. Add: `src/components/create-page-error.tsx` (client utility factory).
2. Modify repetitive route files to one-liner defaults:
   - `src/app/about/error.tsx`
   - `src/app/blacklist/error.tsx`
   - `src/app/cemetery/error.tsx`
   - `src/app/compare/error.tsx`
   - `src/app/depeg/error.tsx`
   - `src/app/dependency-map/error.tsx`
   - `src/app/flows/error.tsx`
   - `src/app/liquidity/error.tsx`
   - `src/app/methodology/error.tsx`
   - `src/app/portfolio/error.tsx`
   - `src/app/safety-scores/error.tsx`
   - `src/app/stability-index/error.tsx`
   - `src/app/stability-index-alt/error.tsx`
   - `src/app/status/error.tsx`
   - `src/app/yield/error.tsx`

### Implementation Steps

1. Create factory:
   - accepts `title` and optional `displayName`.
   - returns component with Next error signature.
2. Migrate each route error file to use factory.
3. Keep root `src/app/error.tsx` unchanged.

### Risks

1. `error.tsx` must remain client components; factory file must include `"use client"`.

### Verification

1. `npm run build` (validates route-level error component signatures).
2. `npm run lint`.

## W5 — Normalize Radix Dependency Usage (Tier 1)

### Current State

`src/components/ui/sheet.tsx` imports from `radix-ui`, while the rest of codebase uses scoped Radix packages.

### File Changes

1. Modify: `src/components/ui/sheet.tsx`
2. Move import to `@radix-ui/react-dialog` API pattern.
3. Update `package.json`:
   - add `@radix-ui/react-dialog` if missing.
   - remove `radix-ui` dependency.
4. Update lockfile.

### Implementation Steps

1. Refactor `SheetPrimitive` import shape with no runtime behavior change.
2. Remove now-unused `radix-ui`.
3. Validate no remaining `from "radix-ui"` imports.

### Risks

1. Type surface mismatch if import style is not converted correctly.

### Verification

1. `rg -n 'from "radix-ui"' src worker` returns no hits.
2. `npm run build`
3. `npm run lint`

## W6 — Consolidate Methodology Changelog Pages (Tier 2)

### Current State

Six changelog pages duplicate `Pill`, `VersionCard`, breadcrumb, and layout structures with minor config differences.

### File Changes

1. Add shared renderer component:
   - `src/components/methodology-changelog-page.tsx`
2. Optional shared card subcomponent:
   - `src/components/methodology-version-card.tsx`
3. Migrate pages:
   - `src/app/methodology/blacklist-tracker-changelog/page.tsx`
   - `src/app/methodology/depeg-changelog/page.tsx`
   - `src/app/methodology/liquidity-score-changelog/page.tsx`
   - `src/app/methodology/mint-burn-flow-changelog/page.tsx`
   - `src/app/methodology/stability-index-changelog/page.tsx`
   - `src/app/methodology/yield-changelog/page.tsx`
4. Keep `src/app/methodology/scoring-changelog/page.tsx` out of this package (unique structure).

### Shared Renderer Contract

Inputs:

1. Page title.
2. Breadcrumb label/path.
3. Version label.
4. Accent class.
5. Entries normalized to:
   - `version`, `title`, `date`, `summary`, `impact[]`, `commits[]`, `reconstructed`.

Outputs:

1. Same visual structure and metadata behavior as current pages.

### Implementation Steps

1. Build normalized entry adapters inside each page for differing impact keys.
2. Keep metadata per page local if it differs materially.
3. Replace inline duplicated components with shared renderer.

### Risks

1. Accidentally changing wording/date formatting semantics.

### Verification

1. `npm run build`
2. Manual spot-check each of 6 pages for card rendering and commit list.

## W7 — Shared Feature Page Shell + Metadata Builder (Tier 2)

### Current State

Multiple top-level pages duplicate breadcrumb nav, title block, status badge, version history link, and social metadata structure.

### File Changes

1. Add metadata helper:
   - `src/lib/page-metadata.ts`
2. Add shared header shell:
   - `src/components/feature-page-shell.tsx`
3. Migrate targeted pages (minimal-risk set first):
   - `src/app/compare/page.tsx`
   - `src/app/dependency-map/page.tsx`
   - `src/app/portfolio/page.tsx`
   - `src/app/liquidity/page.tsx`
   - `src/app/depeg/page.tsx`
   - `src/app/yield/page.tsx`
   - `src/app/safety-scores/page.tsx`
   - `src/app/stability-index/page.tsx`

### Metadata Helper Contract

Input:

1. `title`, `description`, `canonical`, `ogImage`, optional `ogWidth/ogHeight`, optional robots overrides.

Output:

1. `Metadata` object with consistent `alternates`, `openGraph`, and `twitter` structure.

### Shell Contract

Input:

1. Breadcrumb label/path.
2. H1 title.
3. Optional `FeatureStatusBadge` props.
4. Optional methodology version + changelog path.
5. Lead paragraphs.
6. Optional children slots for FAQ blocks/scripts.

Output:

1. Existing visual/semantic output with reduced duplication.

### Risks

1. Over-generalizing pages with unique content.

### Mitigation

1. Keep page-specific FAQ/script blocks local and pass only repeated header structure through shell.

### Verification

1. `npm run build`
2. Manual check for canonical URLs and OG image URLs in generated metadata.

## W8 — Central Endpoint Registry (Tier 2)

### Current State

Endpoint paths/method rules/cache skip/probe groups are duplicated in:

1. `worker/src/index.ts`
2. `worker/src/router.ts`
3. `src/hooks/use-endpoint-probes.ts`
4. `src/app/status/client.tsx`

### File Changes

1. Add shared registry:
   - `src/lib/api-endpoints.ts`
2. Include typed endpoint definitions:
   - path
   - allowed methods
   - admin-required
   - mutating-admin flag
   - cache-bypass flag
   - probe group (`public`, `admin`, `manual`)
   - status-page action eligibility
3. Modify:
   - `worker/src/index.ts` (method guard + cache skip + inline-admin classification via registry)
   - `worker/src/router.ts` (mutating admin path guard via registry)
   - `src/hooks/use-endpoint-probes.ts` (derive endpoint groups from registry)
   - `src/app/status/client.tsx` (action path constants pulled from registry)

### Implementation Steps

1. Create registry constants and helper functions:
   - `isMutatingAdminPath(path)`
   - `isCacheBypassPath(path)`
   - `getProbePaths(group)`
2. Preserve special case:
   - `/api/audit-depeg-history?dry-run=true` GET allowance.
3. Convert existing local arrays/sets to registry consumers.

### Risks

1. Path mismatch can break admin actions or method guards.

### Mitigation

1. Add/extend router contract tests and status action tests.

### Verification

1. `npm run test -- worker/src/api/__tests__/router-contract.test.ts`
2. `npm run test -- src/hooks/__tests__/*endpoint*` (or add targeted tests if absent)
3. `npm run build`

## 7. Documentation Updates Required

Update docs in same PRs where behavior/structure changes:

1. `docs/architecture.md`
   - remove deleted `use-yield-history`.
   - document new shared components/helpers where relevant.
2. `docs/api-reference.md`
   - no endpoint behavior changes expected; update only if any method contract text changes during W8.
3. `docs/testing.md`
   - add any new targeted tests added in W3/W8.
4. `docs/worker-infrastructure.md`
   - update method-routing/inline-admin/cache-skip description if registry replaces local sets.

## 8. Validation Matrix

Run after each work package:

1. `npm run lint`
2. `npm run build`
3. `npm test`
4. `cd worker && npx tsc --noEmit`

Run targeted suites for high-risk packages:

1. W3: supply/yield/dex history endpoint tests + `api-utils` tests.
2. W8: router contract tests + endpoint probe/status action tests.

## 9. PR Slicing

Recommended PR sequence:

1. PR-1: W1 + W2 + W3 (low-risk backend/frontend cleanup).
2. PR-2: W4 + W5 (UI scaffolding + dependency normalization).
3. PR-3: W6 (methodology changelog consolidation only).
4. PR-4: W7 (feature page shell + metadata helper migration).
5. PR-5: W8 (endpoint registry centralization + tests).

## 10. Rollback Strategy

1. Keep each work package isolated in dedicated commits.
2. If W8 introduces route regressions, rollback only registry consumers while retaining shared module.
3. If W7 over-generalizes, rollback per-page migration selectively and keep helper for already stable pages.

## 11. Definition of Done

Tier 1+2 is complete when all conditions are true:

1. All 8 work packages merged.
2. No behavior regressions in route methods, admin actions, or status page probes.
3. Net code reduction achieved with duplicated patterns removed.
4. Documentation updates merged with code changes.
5. Full validation matrix passes on CI.
