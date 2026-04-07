# 2026-04-08 Major Toolchain Upgrade Spike

## Objective

Track the intentionally deferred major dependency cohort from the 2026-04-08 dependency hygiene tranche so it is upgraded in isolation instead of being folded into unrelated refactor work.

## Deferred majors

- `eslint@10`
- `typescript@6`

## Why deferred

- Both packages can change lint/typecheck behavior across the frontend and worker surfaces.
- This repo uses lint, root typecheck, worker typecheck, and coverage gates as merge blockers, so toolchain majors have a much wider blast radius than routine patch/minor refreshes.
- The remaining remediation tranches are already structural. Combining major toolchain changes with yield or DEX decompositions would make regressions harder to localize.

## Scope

Primary files/modules likely touched:

- `package.json`
- `worker/package.json`
- `package-lock.json`
- `eslint.config.*` or equivalent lint rule wiring, if required by `eslint@10`
- `tsconfig*.json` if `typescript@6` changes config defaults or diagnostics
- any source files that fail under tightened lint/typecheck behavior
- `docs/testing.md`
- `docs/deployment-process.md`

## Preconditions

1. Land the remaining remediation refactors first so the spike is not competing with hotspot churn.
2. Start from a clean install state:
   - `npm install`
   - `npm ls --depth=0`
3. Capture current baseline signals before version changes:
   - `npm run lint`
   - `npm run typecheck`
   - `cd worker && npx tsc --noEmit`
   - `npm test`

## Execution outline

### Phase 1 - ESLint 10 spike

1. Bump `eslint` only.
2. Run:
   - `npm run lint`
3. Fix config/rule incompatibilities without broad style churn.
4. Re-run:
   - `npm run typecheck`
   - `cd worker && npx tsc --noEmit`
   - `npm test`

### Phase 2 - TypeScript 6 spike

1. Bump root and worker TypeScript together.
2. Run:
   - `npm run typecheck`
   - `cd worker && npx tsc --noEmit`
3. Fix compiler regressions with the smallest source/config changes that preserve current runtime behavior.
4. Re-run:
   - `npm run lint`
   - `npm test`

### Phase 3 - Full validation

Run the normal deploy-surface gate:

```bash
npm run audit:deps
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm test
npm run build
npm run check:worker-boundary
npm run check:shared-cycles
npm run check:migrations
npm run check:cron-sync
npm run check:cron-connections
```

## Risk controls

- Do not combine the spike with yield, DEX, route, or pricing-pipeline refactors.
- Keep `eslint@10` and `typescript@6` in separate commits even if they share a branch.
- Prefer config compatibility fixes over repo-wide stylistic rewrites.
- If `typescript@6` exposes latent type unsafety in shared runtime contracts, fix the contract at the boundary rather than weakening compiler settings globally.

## Exit criteria

- `npm outdated` shows no remaining wanted patch/minor updates from the current cohort
- the only removed staleness items are the tracked major upgrades
- lint, typecheck, worker typecheck, test, and build all pass on the new majors
