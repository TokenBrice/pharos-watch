# Validate / Deploy / LTS Gap Audit

Date: 2026-04-23
Source plan: `agents/plans/2026-04-22-refactor-implementation-plan.md` (`T2.4a`)

## Scope

Audit the current ownership split across:

- `package.json`
- `scripts/lib/validate-contract.mjs`
- `scripts/lib/deploy-impact.mjs`
- `scripts/run-node-lts-validation.mjs`
- deploy / merge-gate parity tests

Goal: document the exact remaining drift before changing authority.

## Current Ownership

### Already centralized

- CI and merge-gate share the top-level validate/deploy contract through:
  - `scripts/lib/validate-contract.mjs`
  - `scripts/lib/deploy-impact.mjs`
  - `scripts/test-merge-gate.mjs`
  - `scripts/__tests__/validate-ci-parity.test.ts`
  - `scripts/__tests__/classify-deploy-changes.test.ts`
- Pages vs worker deploy-impact classification is already split into `hasPagesDeployImpact()` and `hasWorkerDeployImpact()`.

### Still owned only in `package.json`

- The real prebuild command list still exists only in `package.json` under `validate:prebuild`.
- `scripts/lib/validate-contract.mjs` currently treats that whole list as a single opaque step: `npm run validate:prebuild`.

### Still hand-maintained in `scripts/run-node-lts-validation.mjs`

- Root validate commands are duplicated locally instead of reading the shared contract.
- Worker typecheck commands are duplicated locally instead of reading the shared contract.
- The script explicitly skips `npm run validate:prebuild` because `check:shared-cycles` is not Node 24 safe.

## Verified Gaps

### Validate contract drift

- `validate:prebuild` is not sourced from `scripts/lib/validate-contract.mjs`; it is only wrapped by it.
- This means the shared contract does not actually own the full validate plan yet.

### Deploy-impact drift

- `scripts/lib/deploy-impact.mjs` still misses Pages-impacting public-artifact generators:
  - `scripts/generate-openapi-spec.ts`
  - `scripts/generate-postman-collection.ts`

### LTS blocker

- `scripts/check-shared-cycles.mjs` still shells out through `npx --yes madge ...`.
- `scripts/run-node-lts-validation.mjs` therefore documents and enforces an explicit Node 24 skip for `validate:prebuild`.

## Implications

- `T2.4b` still needs to move the concrete prebuild command registry out of `package.json`.
- `T2.4c` still needs to:
  - fix Pages deploy-impact drift for public artifact generators
  - make `check-shared-cycles` Node 24 safe
  - collapse `validate:lts` onto the shared validate contract instead of a manual fork

## Non-gaps

- The merge gate already consumes the shared top-level validate/deploy contract.
- CI parity coverage already exists and should be preserved.
- Docs already describe the current Node 24 blocker accurately at audit time.
