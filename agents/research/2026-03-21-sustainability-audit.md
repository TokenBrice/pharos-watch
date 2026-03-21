# Sustainability & Maintainability Audit

Date: 2026-03-21
Scope: full repository, with emphasis on architecture coherence, dependency health, configuration management, documentation drift, modularity/coupling, build/deploy pipeline fragility, and scalability bottlenecks.

## Inventory Summary

- Frontend app: `src/` Next.js 16 static export, with route shells, client views, and shared UI helpers.
- Shared domain layer: `shared/` runtime-neutral logic used by both frontend and worker.
- Worker backend: `worker/` Cloudflare Worker API, cron jobs, D1 access, and runtime helpers.
- Pages Functions: `functions/` operator UI host gate and admin API proxy.
- Repo policy/tooling: `scripts/`, `.github/workflows/`, and the checked-in docs corpus under `docs/`.

Audited primary docs:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/worker-infrastructure.md`
- `docs/operator-origin-access.md`
- `docs/deployment-process.md`

Sanity checks run for dependency health:

- `npm audit --omit=dev --json` returned 0 vulnerabilities.
- `npm outdated --json --long` reported multiple direct packages already behind `wanted/latest`.

Overall sustainability health: `6/10`.
The repo has unusually strong guardrails for a codebase this size, but the release pipeline, boundary enforcement, and request-handling surface still concentrate risk in a few places.

Estimated technical debt footprint: about `10%` of the operational control surface shows meaningful maintainability debt.

## Findings

### High

#### F1. Duplicated release pipeline logic across two production workflows

- Impact on maintainability: High
- Location: `.github/workflows/deploy-cloudflare.yml:78-232`, `.github/workflows/rebuild-pages.yml:13-118`
- Problem: The Pages build/smoke/deploy/ops-smoke sequence is duplicated in both workflows, with nearly identical `build-pages`, `smoke-ui`, `deploy-pages`, and `smoke-ops` blocks. The only real difference is the trigger surface.
- Why it matters: Any change to the release process, smoke policy, artifact handling, or deploy retry logic must be edited in two places. That is a direct drift risk and it makes the scheduled rebuild path easier to forget during future release work.
- Recommendation: Extract the shared Pages release flow into a reusable workflow or composite action, then keep the trigger-specific wrappers thin. That leaves one implementation of the build/deploy contract and removes the current copy/paste maintenance burden.

### Medium

#### F2. Worker import-boundary guard does not cover the Pages Functions runtime

- Impact on maintainability: Medium
- Location: `scripts/check-worker-import-boundary.mjs:82-88`
- Problem: The guardrail checks `src`, `shared`, and `scripts` for imports into `worker/src`, but it does not scan `functions/` at all. That leaves the Pages Functions runtime outside the enforced boundary policy.
- Why it matters: A future `functions/` file can accidentally import worker internals and CI will not catch it. That weakens the repo's architectural boundary enforcement exactly where the operator host split is most sensitive.
- Recommendation: Extend the boundary check to include `functions/` and add an explicit rule for `functions -> worker/src` imports. If some imports are intentionally allowed, encode that as a narrow allowlist instead of leaving the runtime unscanned.

#### F3. Direct dependency set is already behind the current wanted/latest releases

- Impact on maintainability: Medium
- Location: `package.json:39-80`, `worker/package.json:11-18`
- Problem: `npm outdated --json --long` shows several direct packages lagging the current workspace state, including `next`, `eslint-config-next`, `tailwindcss`, `@tanstack/react-query`, `@tanstack/react-virtual`, `jsdom`, `wrangler`, `satori`, and `@cloudflare/workers-types`.
- Why it matters: The repo is not exposed to known high-severity advisories right now, but it is already carrying version debt in the core frontend, worker, and toolchain stack. That increases the chance of bigger upgrade jumps later and keeps bug fixes, type updates, and compatibility improvements out of the tree longer than necessary.
- Recommendation: Add a regular dependency refresh cadence, update the lockfile in small batches, and keep the existing CI smoke tests as the acceptance gate for each refresh PR.

#### F4. Worker HTTP entrypoint is a central god-function

- Impact on maintainability: Medium
- Location: `worker/src/handlers/http.ts:73-185`
- Problem: One function owns CORS handling, maintenance mode, rate limiting, cache lookup/store, env validation logging, route dependency hydration, and dispatch.
- Why it matters: This concentrates unrelated policy decisions into the hottest path in the worker. Future changes to auth, cache policy, or route dependencies will keep touching the same large function, which raises the cost of testing and the risk of accidental regressions.
- Recommendation: Split the request path into small middleware-style helpers for preflight, maintenance gating, auth/rate limiting, cache handling, dependency hydration, and route dispatch. Keep the final handler as a thin orchestration layer.

## Cross-Cutting Concerns

- F1 and F3 compound each other: the duplicated workflow definitions and the lagging direct dependency set mean release engineering and dependency refreshes both require edits in multiple places. That increases the chance that a dependency update is tested in one workflow but missed in the other.
- F2 and F4 compound each other: the repo already centralizes important HTTP policy in one large entrypoint, but the boundary guard does not cover every runtime that can participate in the same architecture. That means the code is centralized without being fully protected by automation.

## Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

- F2 - Extend the boundary checker to `functions/` so worker import rules cover the Pages Functions runtime as well. Effort: small. Dependency: none.
- F3 - Refresh the direct dependency set and lockfile in small batches. Effort: small to medium. Dependency: none, but keep the current smoke gates as the acceptance criterion.

### Phase 2 - Targeted Refactoring

- F4 - Break `worker/src/handlers/http.ts` into focused middleware helpers and keep the dispatcher thin. Effort: medium. Dependency: none, but the refactor should preserve the existing route contract tests.

### Phase 3 - Structural Improvements

- F1 - Replace the duplicated workflow blocks with a reusable workflow or composite action for the Pages release pipeline. Effort: large. Dependency: align the reusable workflow shape with the current artifact and smoke expectations before cutting over both triggers.

### Phase 4 - Strategic Overhauls

- No findings in this audit required a full strategic overhaul. The current debt is concentrated in pipeline duplication, boundary enforcement, and a single high-coupling request entrypoint rather than a broken subsystem architecture.

## Appendix A - File-by-File Finding Index

- `.github/workflows/deploy-cloudflare.yml` - F1
- `.github/workflows/rebuild-pages.yml` - F1
- `scripts/check-worker-import-boundary.mjs` - F2
- `package.json` - F3
- `worker/package.json` - F3
- `worker/src/handlers/http.ts` - F4

## Appendix B - Dependency Audit Summary

| Check | Result | Notes |
| --- | --- | --- |
| `npm audit --omit=dev` | Clean | 0 vulnerabilities reported |
| `npm outdated` | Action needed | Several direct packages are behind current wanted/latest releases |
| Runtime security risk | Low | No high-severity npm advisory surfaced in the current workspace |

## Appendix C - Glossary

- Reusable workflow: a GitHub Actions workflow invoked from another workflow to keep shared release logic in one place.
- God-function: a function that accumulates too many responsibilities and becomes hard to test or reason about.
- Boundary guard: automation that prevents one runtime or layer from importing another runtime's internals.
- Drift risk: the chance that two nominally equivalent code paths diverge over time because they are maintained separately.
