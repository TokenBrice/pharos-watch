# Branch Coverage Ratchet Follow-Up

Date: 2026-04-20

Related finding: `S-08` from `agents/audits/2026-04-20-multi-agent-codebase-audit.md`

## Scope

The Phase 3 coverage pass adds focused tests around DEX subgraph helpers, OG rendering paths, DEWS UI states, and blacklist amount recovery. It does not introduce a CI-enforced branch-coverage ratchet yet.

## Target Directories

- `worker/src/api/**`
- `worker/src/cron/dex-liquidity/**`
- `worker/src/cron/blacklist/**`
- `worker/src/lib/**`

## Baseline Target

Use a fresh `npm run test:coverage` report to establish per-directory branch baselines, then enforce non-regression with a command that generates its own coverage artifact or runs after coverage generation in CI/local merge gate.

## Deferral Rationale

The current validation pipeline already has `coverage:critical`. Adding a branch ratchet changes CI runtime and ordering because coverage is generated after `validate:prebuild`. It should land as a dedicated guardrail PR that updates `.github/workflows/validate-ci.yml`, `scripts/test-merge-gate.mjs`, `scripts/lib/validate-contract.mjs`, deploy-impact classification, and parity tests together.

## Validation Target

- `npm run test:coverage`
- New branch-ratchet command once implemented
- `npm test -- scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts`
