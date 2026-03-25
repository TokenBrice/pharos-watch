# 2026-03-21 Audit Remediation Implementation Plan

> Execution plan for the findings in `agents/audits/2026-03-21-comprehensive-codebase-audit.md`.
> Scope covers all `15` unique issues represented by the `16` pillar-scoped findings in that audit.

## Objective

Execute the audit findings in a way that:

- fixes correctness and operational-risk issues first
- removes drift and dead indirection next
- decomposes the highest-complexity worker paths without changing public contracts unnecessarily
- adds lightweight automation to prevent dead code and hotspot complexity from regressing
- leaves the repo with stronger automated guardrails than the current baseline

## Source Findings Covered

This plan covers every finding from the consolidated audit:

1. `R1` / `S1` duplicated Pages release workflow logic
2. `R2` dead status API shim layer
3. `R3` stablecoin-detail provider-branch structural clone
4. `R4` duplicate status fallback thresholds
5. `R5` repeated status freshness constant
6. `Q1` JWKS cache not keyed by `teamDomain`
7. `Q2` unread success response bodies in Worker integration helpers
8. `Q3` monolithic `handleStablecoinDetail()`
9. `Q4` monolithic `handleFeedback()`
10. `Q5` daily-digest collectors swallow failures into empty outputs
11. `Q6` Telegram pending-state parsing discards entire rows on partial corruption
12. `Q7` `Date.now()` in render-time memo logic
13. `S2` boundary checker omits `functions/`
14. `S3` `handleHttpRequest()` is a central orchestration hotspot
15. `S4` status docs no longer match runtime structure

## Constraints

- Keep public API behavior stable unless the current behavior hides broken state or introduces correctness risk.
- Avoid broad architectural rewrites before the correctness / drift fixes are merged.
- Preserve Cloudflare Worker connection-budget behavior and cron scheduling assumptions.
- Update docs whenever runtime structure, pipeline behavior, or operator expectations change.
- Prefer small, reviewable PRs with disjoint file scopes.

## Non-Goals

- No methodology changes to PSI, DEWS, report cards, liquidity scoring, mint/burn scoring, or yield scoring.
- No product redesign or route redesign.
- No wholesale router rewrite in the same PR as endpoint behavior changes.
- No dependency refresh campaign. The final audit did not retain package drift as a repo finding; the stale package reports observed during analysis were local install drift, not checked-in manifest debt.

## Execution Principles

- Fix fail-closed correctness issues before maintainability cleanup.
- Remove duplicated policy only after identifying the canonical source of truth.
- When decomposing large handlers, preserve behavior first and move logic second.
- Prefer characterization tests before refactors in critical Worker paths.
- Do not mix CI/workflow restructuring with application runtime refactors in the same PR.

## Mandatory Validation Gates

Run after every merged phase:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
```

Additional repo guardrails to run where relevant:

```bash
npm run check:worker-boundary
```

## Targeted Test Suites By Area

Use these during implementation:

```bash
npx vitest run worker/src/lib/__tests__/jwt-verify.test.ts
npx vitest run worker/src/api/__tests__/stablecoin-detail.test.ts worker/src/api/__tests__/stablecoin-detail-commodity.test.ts worker/src/api/__tests__/stablecoin-detail-defillama.test.ts
npx vitest run worker/src/api/__tests__/feedback.test.ts
npx vitest run worker/src/api/__tests__/status.test.ts worker/src/lib/__tests__/status-reliability.test.ts
npx vitest run worker/src/cron/__tests__/daily-digest.test.ts
npx vitest run worker/src/api/__tests__/telegram-webhook.test.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts
npx vitest run worker/src/__tests__/index.fetch.test.ts
npx vitest run functions/__tests__/admin-host-gate.test.ts functions/__tests__/ops-admin-proxy.test.ts functions/__tests__/ops-env.test.ts
```

Recommended smoke checks after the CI/workflow workstream:

```bash
npm run test:smoke-api -- --base-url https://api.pharos.watch
npm run test:smoke-ui -- --url https://pharos.watch
npm run test:smoke-ops
```

## Likely Docs To Update

- `docs/architecture.md`
- `docs/status-dashboard.md`
- `docs/testing.md`
- `docs/deployment-process.md`
- `docs/worker-infrastructure.md`
- `docs/operator-origin-access.md`
- `docs/scripts.md`

## Recommended PR Sequence

```text
PR 1  Auth correctness + connection draining
PR 2  Boundary guard + frontend purity warning
PR 3  Status drift cleanup + docs alignment
PR 4  Stablecoin detail refactor
PR 5  Feedback handler decomposition
PR 6  Digest degraded-state propagation
PR 7  Telegram parsing hardening
PR 8  Worker HTTP middleware decomposition
PR 9  Pages workflow deduplication
PR 10 Repo hygiene automation + complexity ratchets
PR 11 Final cleanup, docs sweep, and regression closure
```

This ordering keeps the early PRs small and reduces the chance that later structural work lands on top of known correctness bugs.

## Dependency Graph

```text
W1 JWKS cache fix ------------------------------┐
W2 response draining ---------------------------┤
W3 boundary guard ------------------------------┤
W4 KPI purity fix ------------------------------┤
                                               ├--> W11 http.ts decomposition
W5 status shim removal + docs ------------------┤
W6 status thresholds/constants convergence -----┘

W7 stablecoin-detail refactor -> independent but should land before any router/request-architecture overhaul
W8 feedback decomposition -> independent
W9 digest degradation surfacing -> independent
W10 telegram parsing hardening -> independent
W12 Pages workflow deduplication -> independent of runtime refactors; safer late in the plan
W13 unused-code / dead-export automation -> safest after the cleanup work has removed known dead layers
W14 complexity ratchets -> depend on post-refactor baselines from W7/W8/W11
```

## Phase 0 - Baseline And Characterization

### Purpose

Create a stable baseline before changing auth, status, workflow, and critical Worker orchestration paths.

### Tasks

1. Capture representative responses for:
   - `GET /api/status`
   - `GET /api/stablecoin/usdt-tether`
   - `POST /api/feedback` test fixture paths
2. Save current behavior expectations for:
   - `verifyAccessJwt()` JWKS caching
   - `handleStablecoinDetail()` success / fallback / stale-cache behavior
   - daily digest collector failure semantics
   - Telegram pending-row parsing behavior on malformed state
   - line-count / hotspot baselines for:
     - `worker/src/api/stablecoin-detail.ts`
     - `worker/src/api/feedback.ts`
     - `worker/src/handlers/http.ts`
     - `worker/src/cron/sync-stablecoins.ts`
3. Record current workflow behavior:
   - build artifact name
   - smoke job ordering
   - deploy retry semantics
   - ops-smoke environment expectations

### Exit Criteria

- Existing behavior is documented in tests or captured fixtures for every path that will be structurally refactored.

---

## Phase 1 - Correctness And Guardrails

### W1. Key JWKS cache by `teamDomain`

**Findings:** `Q1`

**Files**

- `worker/src/lib/jwt-verify.ts`
- `worker/src/lib/__tests__/jwt-verify.test.ts`

**Implementation**

1. Replace the single cache slots with a per-domain cache map.
2. Keep the same 1-hour TTL semantics.
3. Preserve the existing public function signatures.
4. Update `_resetJwksCache()` so tests still reset all domains.
5. Add a regression test proving that two domains in one process do not share JWKS cache state.

**Acceptance Criteria**

- Same-domain repeated verification reuses cached JWKS.
- Different-domain verification fetches domain-specific JWKS.
- No auth regression in same-domain tests.

**Validation**

```bash
npx vitest run worker/src/lib/__tests__/jwt-verify.test.ts
```

**Risk**

Low. Purely internal caching logic with isolated tests.

### W2. Standardize response draining for integration fetches

**Findings:** `Q2`

**Files**

- `worker/src/lib/telegram.ts`
- `worker/src/lib/twitter.ts`
- `worker/src/api/feedback.ts`
- optionally shared helper location such as `worker/src/lib/api-utils.ts` or a new `worker/src/lib/fetch-body.ts`

**Implementation**

1. Introduce a small helper that consumes or cancels response bodies safely on both success and failure.
2. Apply it to:
   - `postTelegramMessage()`
   - `postTweet()`
   - `createGitHubIssue()`
   - `createGitHubDiscussion()`
3. Preserve existing error messages and return semantics.
4. Add tests or assertions where current suites already mock the external fetches.

**Acceptance Criteria**

- All success and non-success branches release response bodies consistently.
- Existing Telegram, Twitter, and feedback behavior remains unchanged.

**Validation**

```bash
npx vitest run worker/src/api/__tests__/feedback.test.ts worker/src/api/__tests__/telegram-webhook.test.ts
```

**Risk**

Low to medium. External API mocks need to continue matching the updated body-consumption behavior.

### W3. Extend the import-boundary checker to `functions/`

**Findings:** `S2`

**Files**

- `scripts/check-worker-import-boundary.mjs`
- potentially `docs/testing.md`

**Implementation**

1. Add `functions/` to the frontend/runtime-side scan set.
2. Decide whether `functions -> worker/src` is forbidden wholesale or requires a small allowlist.
3. Keep the current worker-to-frontend checks unchanged.
4. If new false positives appear, handle them explicitly rather than weakening the rule.

**Acceptance Criteria**

- CI fails if `functions/` imports `worker/src` internals.
- Existing codebase passes the updated check.

**Validation**

```bash
npm run check:worker-boundary
```

**Risk**

Low.

### W4. Remove impure `Date.now()` from render-time memo logic

**Findings:** `Q7`

**Files**

- `src/components/kpi-bar.tsx`
- any related tests under `src/components/__tests__/`

**Implementation**

1. Replace the render-time `Date.now()` read with a stable timestamp source.
2. Prefer deriving the cutoff from existing fetched data or a stable state initializer.
3. Preserve current UX semantics for PSI day-counting.

**Acceptance Criteria**

- `npm run lint` no longer reports the `react-hooks/purity` warning.
- KPI display behavior remains unchanged.

**Validation**

```bash
npm run lint
npx vitest run src/components/__tests__/*
```

**Risk**

Low.

---

## Phase 2 - Status Surface Convergence

### W5. Remove dead status shims and align documentation

**Findings:** `R2`, `S4`

**Files**

- `worker/src/api/status-data-quality.ts`
- `worker/src/api/status-derived-data.ts`
- `docs/architecture.md`
- `docs/status-dashboard.md`

**Implementation**

1. Confirm no runtime imports depend on the shim files.
2. Delete the dead re-export shims.
3. Update docs to reference:
   - `worker/src/lib/status/data-quality.ts`
   - `worker/src/lib/status/derived-data.ts`
4. Verify any internal imports or test fixtures do not rely on the deleted file paths.

**Acceptance Criteria**

- No dead status shim files remain.
- Docs describe the actual status-module structure.

**Validation**

```bash
npx vitest run worker/src/api/__tests__/status.test.ts worker/src/lib/__tests__/status-reliability.test.ts
npm run build
```

**Risk**

Low.

### W6. Converge status thresholds and freshness constants

**Findings:** `R4`, `R5`

**Files**

- `worker/src/api/status.ts`
- `worker/src/lib/status-reliability.ts`

**Implementation**

1. Identify the canonical policy home. It should be `status-reliability.ts`.
2. Export either:
   - the threshold object directly, or
   - a helper that builds fallback state from canonical thresholds.
3. Remove duplicated numeric literals from `status.ts`.
4. Derive the discrepancy probe max-age from the shared freshness window if semantics are truly identical.
5. Extend tests so threshold drift would be caught in future.

**Acceptance Criteria**

- One source of truth exists for status thresholds.
- One source of truth exists for the 1800-second freshness policy.
- `/api/status` output remains unchanged unless explicitly intended.

**Validation**

```bash
npx vitest run worker/src/api/__tests__/status.test.ts worker/src/lib/__tests__/status-reliability.test.ts
```

**Risk**

Low to medium. This is policy consolidation in an operator-critical path.

---

## Phase 3 - Endpoint And Collector Refactors

### W7. Refactor `stablecoin-detail` into provider strategies

**Findings:** `R3`, `Q3`

**Files**

- `worker/src/api/stablecoin-detail.ts`
- `worker/src/api/stablecoin-detail/shared.ts`
- `worker/src/api/stablecoin-detail/commodity.ts`
- `worker/src/api/stablecoin-detail/coingecko-only.ts`
- `worker/src/api/stablecoin-detail/defillama.ts`
- related tests

**Implementation**

1. Add characterization tests first if current coverage does not lock down all three branches.
2. Extract common orchestration concerns:
   - cache lookup / fresh-hit return
   - fallback loading from `supply_history`
   - cache write scheduling
   - stale-cache fallback vs hard error
   - circuit-breaker outcome recording
3. Keep provider-specific fetch / normalization logic in dedicated strategy helpers.
4. Preserve current response shape and cache TTL behavior.

**Acceptance Criteria**

- Public response shape is unchanged.
- All existing provider branches still pass their branch-specific tests.
- Fallback behavior is centralized rather than triplicated.

**Validation**

```bash
npx vitest run worker/src/api/__tests__/stablecoin-detail.test.ts worker/src/api/__tests__/stablecoin-detail-commodity.test.ts worker/src/api/__tests__/stablecoin-detail-defillama.test.ts
```

**Risk**

Medium. This touches a high-traffic endpoint with multiple fallback paths.

### W8. Decompose `handleFeedback()` into services

**Findings:** `Q4`

**Files**

- `worker/src/api/feedback.ts`
- possibly new helpers under `worker/src/api/feedback-*` or `worker/src/lib/`

**Implementation**

1. Split the current logic into three layers:
   - request validation and normalization
   - verification / rate-limit / policy checks
   - GitHub submission
2. Keep the top-level route handler thin.
3. Reuse the response-drain helper introduced in `W2`.
4. Preserve current status codes, error strings, and GitHub routing behavior.

**Acceptance Criteria**

- Each concern can be tested independently.
- Endpoint behavior is unchanged for valid and invalid submissions.

**Validation**

```bash
npx vitest run worker/src/api/__tests__/feedback.test.ts
```

**Risk**

Medium.

### W9. Propagate degraded-state information from daily-digest collectors

**Findings:** `Q5`

**Files**

- `worker/src/cron/daily-digest/collectors.ts`
- `worker/src/cron/daily-digest.ts`
- relevant tests

**Implementation**

1. Introduce a collector result shape that can carry both value and degraded reason.
2. Update `collectActiveDepegs()`, `collectBlacklistActivity()`, and `collectSupplyVelocity()` to emit degraded reasons instead of silently pretending there is no signal.
3. Propagate those reasons into digest metadata and logs.
4. Keep the public digest format stable unless an existing internal field can hold degradation metadata.

**Acceptance Criteria**

- Collector query failures are observable in generation state.
- “No signal” and “collector failed” are distinguishable.

**Validation**

```bash
npx vitest run worker/src/cron/__tests__/daily-digest.test.ts
```

**Risk**

Medium. Changes are internal but affect operator trust in digest output.

### W10. Harden Telegram pending-state parsing

**Findings:** `Q6`

**Files**

- `worker/src/api/telegram-webhook-parsing.ts`
- `worker/src/api/telegram-webhook.ts`
- Telegram webhook tests

**Implementation**

1. Replace the single catch-all parse block with field-level parsing helpers.
2. Preserve valid sub-state when one stored field is malformed.
3. Log which field failed and on which pending action type.
4. Add malformed-row regression tests.

**Acceptance Criteria**

- Partial row corruption no longer wipes the entire pending state by default.
- Failure modes are diagnosable in logs and tests.

**Validation**

```bash
npx vitest run worker/src/api/__tests__/telegram-webhook.test.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts
```

**Risk**

Medium.

---

## Phase 4 - Request Architecture And CI Pipeline

### W11. Decompose `handleHttpRequest()` into middleware-style helpers

**Findings:** `S3`

**Files**

- `worker/src/handlers/http.ts`
- possibly `worker/src/router.ts`
- possibly new helper modules under `worker/src/handlers/` or `worker/src/lib/`
- related entrypoint tests

**Implementation**

1. Add characterization tests if the current entrypoint tests do not already lock down:
   - CORS behavior
   - maintenance mode
   - auth and rate limiting
   - edge-cache hit / miss behavior
   - route dependency hydration
2. Split the handler into small helpers:
   - preflight handling
   - maintenance-mode gate
   - admin/public auth and rate-limit gate
   - edge-cache policy
   - route context dependency hydration
   - final dispatch and cache write
3. Keep the top-level `handleHttpRequest()` as orchestration only.

**Acceptance Criteria**

- No behavior change in `fetch` entrypoint tests.
- The top-level handler becomes materially smaller and easier to reason about.

**Validation**

```bash
npx vitest run worker/src/__tests__/index.fetch.test.ts
npx vitest run worker/src/api/__tests__/router-contract.test.ts
```

**Risk**

Medium to high. This is the hottest Worker path; refactor only after Phase 1 correctness fixes land.

### W12. Deduplicate the Pages release workflow

**Findings:** `R1`, `S1`

**Files**

- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/rebuild-pages.yml`
- optionally new reusable workflow under `.github/workflows/`
- `docs/testing.md`
- `docs/deployment-process.md`

**Implementation**

1. Extract the shared Pages release sequence into one reusable workflow or composite action.
2. Preserve:
   - artifact name
   - smoke ordering
   - deploy retry logic
   - ops-smoke environment contract
3. Keep `deploy-cloudflare.yml` responsible for change detection and worker path branching.
4. Keep `rebuild-pages.yml` as a thin scheduled/manual wrapper around the shared Pages workflow.
5. Update docs to reflect the new workflow topology.

**Acceptance Criteria**

- Only one implementation of the Pages build/smoke/deploy flow remains.
- Push/manual deploys and scheduled rebuilds still exercise equivalent Pages release logic.

**Validation**

- Static review of workflow graph and environment usage
- Trigger a dry-run PR path or manual workflow run in GitHub before deleting the old duplicated blocks

**Risk**

Medium. CI changes can fail only in GitHub, so this needs cautious rollout and one manual validation run.

---

## Phase 5 - Maintenance Guardrails And Recurrence Prevention

### W13. Add unused-code and dead-export detection to repo guardrails

**Supports:** `R2`, `S4`, overall redundancy-reduction goal

**Files**

- `scripts/` (new script)
- `package.json`
- `.github/workflows/validate-ci.yml`
- `docs/testing.md`
- optionally `docs/scripts.md`

**Implementation**

1. Add a repo-local static analysis script for:
   - unused exports
   - unreferenced internal modules
   - dead shim files
2. Make the script aware of framework-required entrypoints so it does not flag:
   - Next.js route files
   - Worker entrypoints / route registry
   - Pages Functions handlers
   - test-only fixtures
3. Start with a reviewed allowlist if needed, but keep it narrow and documented.
4. Add it to the validate workflow once the codebase is clean enough to pass reliably.

**Acceptance Criteria**

- A dead shim like the removed status re-export layer would be caught automatically.
- The guardrail is specific enough to avoid noisy false positives on framework files.

**Validation**

```bash
node scripts/<new-unused-code-check>.mjs
```

**Risk**

Medium. The value is high, but false positives will make the check useless if the script is too naive. It should ship only after a clean allowlist review.

### W14. Add hotspot complexity regression ratchets

**Supports:** `Q3`, `Q4`, `S3`, overall code-quality goal

**Files**

- `scripts/` (new complexity-report / ratchet script)
- `package.json`
- `.github/workflows/validate-ci.yml`
- `docs/testing.md`
- optionally `docs/scripts.md`

**Implementation**

1. Create a script that reports size / complexity signals for critical hotspots.
2. Start with explicit targets instead of whole-repo thresholds:
   - `worker/src/api/stablecoin-detail.ts`
   - `worker/src/api/feedback.ts`
   - `worker/src/handlers/http.ts`
   - `worker/src/cron/sync-stablecoins.ts`
3. Use a regression model rather than arbitrary hard ceilings:
   - fail only if a hotspot grows beyond the new post-refactor baseline
   - allow intentional increases through an explicit baseline update flow
4. Keep the first version simple:
   - file lines
   - function lines
   - branching count proxies if practical
5. Add the script to CI after W7, W8, and W11 establish cleaner baselines.

**Acceptance Criteria**

- Future PRs cannot quietly re-grow the major hotspot files past the remediated baseline.
- The ratchet is narrow and explainable enough for reviewers to trust.

**Validation**

```bash
node scripts/<new-complexity-ratchet>.mjs
```

**Risk**

Medium. Overly aggressive thresholds will create friction; this should be a hotspot-focused ratchet, not a repo-wide style policy.

---

## Phase 6 - Final Closure

### W15. Final documentation and regression sweep

**Findings:** closes residual `S4` and ensures all prior work is reflected

**Files**

- `docs/architecture.md`
- `docs/status-dashboard.md`
- `docs/testing.md`
- `docs/deployment-process.md`
- any additional docs touched by runtime or workflow changes

**Implementation**

1. Verify docs match the post-remediation runtime structure and workflow layout.
2. Remove stale references introduced by deleted files or moved helper responsibilities.
3. Re-run the full validation gates.
4. Re-check the audit file and mark each finding as resolved, deferred, or intentionally left unchanged.

**Acceptance Criteria**

- No plan-covered finding remains unresolved without an explicit defer reason.
- Docs match runtime behavior and repo structure.

**Validation**

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
npm run check:worker-boundary
```

---

## Workstream Matrix

| Workstream | Findings | Effort | Can run in parallel? |
| --- | --- | --- | --- |
| `W1` JWKS cache fix | `Q1` | Small | Yes |
| `W2` response draining | `Q2` | Small | Yes |
| `W3` boundary guard | `S2` | Small | Yes |
| `W4` KPI purity fix | `Q7` | Small | Yes |
| `W5` status shim removal + docs | `R2`, `S4` | Small | After status baseline is understood |
| `W6` status policy convergence | `R4`, `R5` | Small | Best with `W5`, not parallel to it |
| `W7` stablecoin-detail refactor | `R3`, `Q3` | Medium | Yes, after Phase 1 |
| `W8` feedback decomposition | `Q4` | Medium | Yes, after `W2` |
| `W9` digest degraded state | `Q5` | Medium | Yes |
| `W10` Telegram parsing hardening | `Q6` | Medium | Yes |
| `W11` http.ts decomposition | `S3` | Medium-Large | No, keep isolated |
| `W12` workflow deduplication | `R1`, `S1` | Large | Yes, but safer late |
| `W13` unused-code / dead-export automation | supports `R2`, `S4` | Medium | Yes, after main cleanup |
| `W14` complexity ratchets | supports `Q3`, `Q4`, `S3` | Medium | After hotspot refactors establish clean baselines |
| `W15` closure sweep | residual | Small | Final only |

## Definition Of Done

The remediation is complete when:

1. Every finding in the consolidated audit is either resolved or explicitly deferred with a reason.
2. The full validation gate passes:
   - `npm run lint`
   - `npm test`
   - `cd worker && npx tsc --noEmit`
   - `npm run build`
   - `npm run check:worker-boundary`
3. Status docs and workflow docs match the final runtime structure.
4. The Pages workflow duplication is removed without losing deploy-path coverage.
5. The large Worker handlers are materially smaller and their key policies are covered by targeted tests.
