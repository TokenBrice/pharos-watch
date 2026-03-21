# Stablecoin Dashboard Codebase Audit — 2026-03-21

## 1. Executive Summary

### Findings Count

`16` pillar-scoped findings total (`15` unique underlying issues; the duplicated Pages release pipeline is counted in both Redundancy and Sustainability because it is a cross-pillar problem).

| Pillar | High | Medium | Low | Total |
| --- | --- | --- | --- | --- |
| Redundancy elimination | 1 | 3 | 1 | 5 |
| Code quality improvement | 2 | 4 | 1 | 7 |
| Sustainability / maintainability | 1 | 3 | 0 | 4 |
| Total | 4 | 10 | 2 | 16 |

### Top 5 Most Critical Findings

1. `Q1` / Auth correctness risk: JWKS caching in `worker/src/lib/jwt-verify.ts` is global rather than keyed by `teamDomain`.
2. `Q2` / Worker connection-budget risk: Telegram, Twitter, and GitHub success responses are not consistently drained, which conflicts with the repo’s documented six-connection-per-trigger constraint.
3. `R1` + `S1` / Release-pipeline drift risk: the Pages build/smoke/deploy path is duplicated across two production workflows.
4. `S2` / Boundary-enforcement gap: `functions/` is outside the automated worker-boundary check.
5. `R3` + `Q3` / Repeated provider-branch logic: `worker/src/api/stablecoin-detail.ts` duplicates fallback/cache orchestration across multiple upstream branches inside one large handler.

### Overall Health Assessment

| Pillar | Score | Justification |
| --- | --- | --- |
| Redundancy elimination | `7/10` | Existing factories and shared helpers already remove a lot of frontend repetition, but the status surface and release workflow still carry avoidable duplication. |
| Code quality improvement | `6/10` | The repo has unusually strong tests and mostly clean automated gates, but auth caching, Worker connection handling, and several oversized orchestration handlers remain real quality risks. |
| Sustainability / maintainability | `6/10` | Architecture is documented and guarded, yet CI/release duplication, incomplete boundary automation, and concentrated HTTP orchestration create long-term friction. |

### Technical Debt Profile

Estimated medium-or-higher debt footprint: roughly `12-15%` of the operationally important codebase.

This debt is concentrated in:

- Worker auth, status, and external-integration paths
- CI / release workflows
- operator-surface boundary enforcement

It is not broadly distributed across the entire frontend.

### Validation Snapshot

Current repo validation status during this audit:

- `npm test`: passed (`282` files, `2602` tests passed, `1` todo)
- `npm run build`: passed
- `cd worker && npx tsc --noEmit`: passed
- `npm run lint`: passed with `1` warning
  - `src/components/kpi-bar.tsx:405` (`react-hooks/purity` warning for `Date.now()` during render/useMemo)

### Balance Note

Redundancy produced fewer high-confidence findings than quality and sustainability. That appears genuine rather than under-analysis; the repo already uses a number of effective factories and shared helpers.

## 2. Findings By Pillar

### Redundancy Elimination

#### R1. Duplicated Pages release pipeline logic

- Severity / impact: High
- Locations:
  - `.github/workflows/deploy-cloudflare.yml:78-232`
  - `.github/workflows/rebuild-pages.yml:13-118`
- Description: The Pages release path is duplicated across two workflows: `build-pages`, `smoke-ui`, `deploy-pages`, and `smoke-ops` all repeat nearly identical checkout/setup/build/artifact/smoke/deploy logic.
- Why it matters: Every release-process change must be maintained in two places. That is direct drift risk on the production path.
- Consolidation strategy: Extract the shared Pages release flow into a reusable workflow or composite action and keep the trigger wrappers thin.

#### R2. Dead status API shim layer

- Severity / impact: Medium
- Locations:
  - `worker/src/api/status-data-quality.ts:1-1`
  - `worker/src/api/status-derived-data.ts:1-7`
  - `worker/src/api/status-supplements.ts:13-16`
  - `docs/architecture.md:503-505`
  - `docs/status-dashboard.md:137-143`
- Description: `status-data-quality.ts` and `status-derived-data.ts` are re-export shims with no behavior. The live status path imports `worker/src/lib/status/*` directly, while docs still present the shims as active modules.
- Why it matters: The files add indirection without value and are already drifting from the actual runtime structure.
- Consolidation strategy: Delete the shims, keep the `worker/src/lib/status/*` implementations as the single source of truth, and update docs to match.

#### R3. Structural clone inside the stablecoin-detail provider branches

- Severity / impact: Medium
- Locations:
  - `worker/src/api/stablecoin-detail.ts:78-111`
  - `worker/src/api/stablecoin-detail.ts:114-156`
  - `worker/src/api/stablecoin-detail.ts:167-204`
- Description: The commodity, CoinGecko-only, and DefiLlama branches all repeat the same cache-write, stale-history fallback, and stale-cache-or-error orchestration with only provider-specific fetch details changed.
- Why it matters: This is a structural clone in a high-change API path. Any fallback-policy change now has to be replicated across three branches.
- Consolidation strategy: Extract a provider-branch template or strategy runner that handles cache/fallback/error policy once and delegates only provider-specific token fetch logic.

#### R4. Duplicate fallback thresholds in the status route

- Severity / impact: Medium
- Locations:
  - `worker/src/api/status.ts:14-34`
  - `worker/src/lib/status-reliability.ts:12-24`
- Description: `fallbackState()` in `status.ts` maintains a second copy of the hysteresis and dwell thresholds that already live in `status-reliability.ts`.
- Why it matters: Tuning the canonical status policy can leave the fallback snapshot behind, producing inconsistent operator state under degraded conditions.
- Consolidation strategy: Export the canonical threshold object or a fallback-state builder from `status-reliability.ts` and reuse it from `status.ts`.

#### R5. Repeated 1800-second freshness window in status reliability

- Severity / impact: Low
- Locations:
  - `worker/src/lib/status-reliability.ts:21-24`
  - `worker/src/lib/status-reliability.ts:648-653`
- Description: `STATUS_SYSTEM_FRESHNESS_SEC` and `STATUS_DISCREPANCY_MAX_PROBE_AGE_SEC` are maintained as separate values but currently both equal `1800`.
- Why it matters: This is a small drift point in a status-policy module that already has multiple time-window constants.
- Consolidation strategy: Derive the probe age limit from the general freshness window if their semantics are intentionally aligned.

### Code Quality Improvement

#### Q1. JWKS cache is not keyed by team domain

- Severity: High
- Locations:
  - `worker/src/lib/jwt-verify.ts:47-105`
  - `worker/src/lib/__tests__/jwt-verify.test.ts:260-299`
- Description: JWKS is cached in single module-global slots (`cachedJwks`, `cachedJwksExpiry`) even though `verifyAccessJwt()` accepts `teamDomain` as an input.
- Why it matters: The cache key does not match the scope of the data. In a multi-tenant or future tenant-expansion scenario, one domain’s JWKS can be reused for another domain in the same isolate, causing auth failures or incorrect cache hits.
- Recommendation: Replace the single cache slot with a per-domain map and add a regression test that exercises two domains in one process.
- Code-level suggestion: `Map<string, { jwks: JwksResponse; expiry: number }>` keyed by `teamDomain`.

#### Q2. External integration helpers do not consistently drain success response bodies

- Severity: High
- Locations:
  - `worker/src/lib/telegram.ts:35-52`
  - `worker/src/lib/twitter.ts:106-123`
  - `worker/src/api/feedback.ts:120-130`
  - `worker/src/api/feedback.ts:152-171`
  - Supporting constraint: `docs/worker-and-api-limits.md:30-43`
- Description: `postTelegramMessage()`, `postTweet()`, and `createGitHubIssue()` return on `res.ok` without consuming or canceling the response body. `createGitHubDiscussion()` also returns on HTTP error without draining the body.
- Why it matters: This repo explicitly documents a six-connection-per-trigger operating constraint for Workers. Leaving bodies unread can hold connections open and starve later fetches in cron-heavy paths.
- Recommendation: Standardize a helper that always drains or cancels response bodies on both success and failure, then use it across Telegram, Twitter, and GitHub clients.
- Code-level suggestion: wrap fetch responses with a small `consumeResponseBody(res)` utility and call it before every early return.

#### Q3. `handleStablecoinDetail()` is a monolithic, branch-heavy handler

- Severity: Medium
- Location: `worker/src/api/stablecoin-detail.ts:24-205`
- Description: One function owns cache lookup, provider selection, circuit-breaker decisions, stale-history fallback policy, cache writes, and final error translation.
- Why it matters: This is difficult to reason about and hard to test in isolation. The current structure also amplifies the duplication described in `R3`.
- Recommendation: Split the handler into provider strategies plus a thin orchestration layer.
- Code-level suggestion: `resolveDetailProvider(meta) -> strategy`, then `runDetailStrategy({ cached, db, id, strategy, ... })`.

#### Q4. `handleFeedback()` mixes validation, policy, verification, and GitHub submission

- Severity: Medium
- Location: `worker/src/api/feedback.ts:210-320`
- Description: The route handler combines request parsing, schema validation, honeypot handling, stablecoin resolution, rate limiting, verification, and GitHub submission logic.
- Why it matters: The function has too many reasons to change and is hard to exercise by concern.
- Recommendation: Split it into a request-validation layer, a verification service, and a submission service.
- Code-level suggestion: keep `handleFeedback()` as orchestration only, with separate `verifyFeedback()` and `submitFeedback()` helpers or modules.

#### Q5. Early daily-digest collectors swallow failures into empty outputs

- Severity: Medium
- Locations:
  - `worker/src/cron/daily-digest/collectors.ts:35-55`
  - `worker/src/cron/daily-digest/collectors.ts:62-97`
  - `worker/src/cron/daily-digest/collectors.ts:103-163`
- Description: `collectActiveDepegs()`, `collectBlacklistActivity()`, and `collectSupplyVelocity()` catch query failures and return empty / `undefined` results without attaching a degraded reason.
- Why it matters: Production failures become indistinguishable from “nothing happened today,” which weakens trust in the digest and makes debugging harder.
- Recommendation: Return structured degraded metadata or append collector-specific failure reasons into digest generation state.
- Code-level suggestion: use `{ value, degradedReason }` collector results instead of raw values on failure paths.

#### Q6. Telegram pending-state parsing discards the entire row on any malformed JSON field

- Severity: Medium
- Location: `worker/src/api/telegram-webhook-parsing.ts:95-147`
- Description: `parsePendingDisambiguation()` catches any failure across multiple JSON fields and returns `null`, even if only one stored field is malformed.
- Why it matters: A partially corrupted or partially migrated row quietly erases pending bot state, which will look like random flow loss to users.
- Recommendation: Parse fields independently, log which field failed, and preserve valid sub-state where possible.
- Code-level suggestion: replace the monolithic `try/catch` with per-field parsing helpers returning `null` plus diagnostic context.

#### Q7. Impure current-time read during render path

- Severity: Low
- Location: `src/components/kpi-bar.tsx:399-417`
- Description: `useMemo()` computes PSI band duration using `Date.now()` during render.
- Why it matters: ESLint already flags this as a React purity warning. Time-based calculations inside render can create unstable output across rerenders.
- Recommendation: Derive the current day boundary from stable data outside render or from effect-driven state.
- Code-level suggestion: compute the reference timestamp once from fetched data freshness or initialize a `useState(() => Date.now())` / effect-driven clock if live time is required.

### Sustainability And Maintainability

#### S1. Duplicated Pages release pipeline logic across production workflows

- Impact on maintainability: High
- Locations:
  - `.github/workflows/deploy-cloudflare.yml:78-232`
  - `.github/workflows/rebuild-pages.yml:13-118`
- Description: The same Pages build/smoke/deploy/ops-smoke flow is maintained twice.
- Long-term consequence: Release-process changes will drift between the push/manual deploy path and the scheduled/manual rebuild path.
- Recommended remediation: Replace the duplicated blocks with a reusable workflow or composite action that owns the Pages artifact contract.

#### S2. Boundary checker omits the Pages Functions runtime

- Impact on maintainability: Medium
- Location: `scripts/check-worker-import-boundary.mjs:82-88`
- Description: The boundary guard scans `src`, `shared`, and `scripts`, but not `functions`.
- Long-term consequence: `functions/` can begin importing worker internals without CI catching it, weakening architectural isolation around the operator surface.
- Recommended remediation: Include `functions/` in the boundary scan or add a dedicated `functions -> worker/src` rule.

#### S3. Worker HTTP entrypoint is a concentrated orchestration hotspot

- Impact on maintainability: Medium
- Location: `worker/src/handlers/http.ts:73-185`
- Description: `handleHttpRequest()` owns env warnings, CORS, maintenance mode, auth, rate limiting, cache lookup/store, route dependency hydration, and dispatch.
- Long-term consequence: Future changes to request policy keep landing in the same hot path, which raises regression risk and slows onboarding.
- Recommended remediation: Break it into middleware-style helpers for preflight, maintenance gating, auth/rate limiting, cache policy, dependency hydration, and final dispatch.

#### S4. Documentation still points at obsolete status module boundaries

- Impact on maintainability: Medium
- Locations:
  - `docs/architecture.md:503-505`
  - `docs/status-dashboard.md:137-143`
  - Runtime reality:
    - `worker/src/api/status-data-quality.ts:1-1`
    - `worker/src/api/status-derived-data.ts:1-7`
- Description: Status docs still describe API-layer loaders that are now effectively dead shims.
- Long-term consequence: Architecture docs no longer describe the real code path, which increases onboarding friction and makes future refactors riskier.
- Recommended remediation: Update the docs to point at `worker/src/lib/status/data-quality.ts` and `worker/src/lib/status/derived-data.ts`, or remove those references entirely if the modules are internal.

## 3. Cross-Cutting Concerns

### C1. Release pipeline duplication is both redundancy and sustainability debt

- Connected findings: `R1`, `S1`
- Compound issue: the exact same Pages release flow is duplicated in two workflows, so both duplication risk and long-term release-process drift are present.
- Priority: High

### C2. Status-surface drift is accumulating in code and docs together

- Connected findings: `R2`, `R4`, `R5`, `S4`
- Compound issue: dead shims, duplicated thresholds, repeated freshness constants, and outdated docs all point to the same status surface losing a single source of truth.
- Priority: Medium-High

### C3. Worker connection-budget hygiene is being undermined by integration helpers

- Connected findings: `Q2`, `S3`
- Compound issue: the repo explicitly designs around a constrained Worker connection budget, but several helpers used by cron and notification paths do not consistently release responses while the request entrypoint remains highly centralized.
- Priority: High

### C4. Boundary enforcement gap weakens an otherwise strong architecture

- Connected findings: `S2`
- Compound issue: the repo has explicit import-boundary automation, but the Pages Functions runtime is outside it. That is a small implementation gap with outsized architectural impact.
- Priority: Medium-High

### C5. Large orchestration handlers are also where the redundancy is clustering

- Connected findings: `R3`, `Q3`, `Q4`
- Compound issue: `stablecoin-detail` and `feedback` are carrying both structural duplication and SRP violations, which means complexity and redundancy will keep reinforcing each other until those handlers are decomposed.
- Priority: Medium-High

### C6. Silent degradation is a recurring failure mode

- Connected findings: `Q5`, `Q6`
- Compound issue: both digest collection and Telegram pending-state parsing prefer silent fallback to explicit degraded state, which hides operational problems from maintainers and users.
- Priority: Medium

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q1` | Key JWKS cache by `teamDomain` and add a two-domain regression test | `worker/src/lib/jwt-verify.ts`, `worker/src/lib/__tests__/jwt-verify.test.ts` | Small | None |
| `Q2` | Add a shared response-drain helper and apply it to Telegram, Twitter, and GitHub clients | `worker/src/lib/telegram.ts`, `worker/src/lib/twitter.ts`, `worker/src/api/feedback.ts` | Small | None |
| `S2` | Extend the worker-boundary checker to include `functions/` | `scripts/check-worker-import-boundary.mjs` | Small | None |
| `R2` + `S4` | Remove dead status shims and update docs to match the real module paths | `worker/src/api/status-data-quality.ts`, `worker/src/api/status-derived-data.ts`, `docs/architecture.md`, `docs/status-dashboard.md` | Small | None |
| `R4` + `R5` | Deduplicate status thresholds and freshness-window constants | `worker/src/api/status.ts`, `worker/src/lib/status-reliability.ts` | Small | None |
| `Q7` | Remove `Date.now()` from render-time memo logic | `src/components/kpi-bar.tsx` | Small | None |

### Phase 2 — Targeted Refactoring

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R3` + `Q3` | Extract a provider strategy/template for `stablecoin-detail` and centralize fallback/cache policy | `worker/src/api/stablecoin-detail.ts`, `worker/src/api/stablecoin-detail/*` | Medium | Prefer after `R4/R5` cleanup if status patterns are used as a reference for policy centralization |
| `Q4` | Split `handleFeedback()` into validation, verification, and submission services | `worker/src/api/feedback.ts` | Medium | None |
| `Q5` | Return structured degraded state from digest collectors instead of silent empty outputs | `worker/src/cron/daily-digest/collectors.ts`, `worker/src/cron/daily-digest.ts` | Medium | None |
| `Q6` | Make Telegram pending-row parsing field-aware and diagnosable | `worker/src/api/telegram-webhook-parsing.ts`, related tests | Medium | None |

### Phase 3 — Structural Improvements

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R1` + `S1` | Replace duplicated Pages workflow blocks with a reusable workflow / composite action | `.github/workflows/deploy-cloudflare.yml`, `.github/workflows/rebuild-pages.yml`, optionally `.github/workflows/validate-ci.yml` | Large | None, but preserve artifact and smoke contract exactly during migration |
| `S3` | Decompose `handleHttpRequest()` into middleware-style helpers | `worker/src/handlers/http.ts`, possibly `worker/src/router.ts`, `worker/src/route-registry.ts` | Medium-Large | None |

### Phase 4 — Strategic Overhauls

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S3` + `R3` + `Q3` + `Q4` | Formalize a reusable Worker request architecture: middleware pipeline for request policy plus strategy-based provider handlers for complex endpoints | `worker/src/handlers/*`, `worker/src/router.ts`, `worker/src/route-registry.ts`, `worker/src/api/stablecoin-detail*`, `worker/src/api/feedback.ts` | Large | Best done after Phases 1-3 reduce immediate drift and correctness risks |

## 5. Appendices

### Appendix A — File-By-File Finding Index

| File | Finding IDs |
| --- | --- |
| `.github/workflows/deploy-cloudflare.yml` | `R1`, `S1` |
| `.github/workflows/rebuild-pages.yml` | `R1`, `S1` |
| `docs/architecture.md` | `R2`, `S4` |
| `docs/status-dashboard.md` | `R2`, `S4` |
| `scripts/check-worker-import-boundary.mjs` | `S2` |
| `src/components/kpi-bar.tsx` | `Q7` |
| `worker/src/api/feedback.ts` | `Q2`, `Q4` |
| `worker/src/api/stablecoin-detail.ts` | `R3`, `Q3` |
| `worker/src/api/status-data-quality.ts` | `R2` |
| `worker/src/api/status-derived-data.ts` | `R2` |
| `worker/src/api/status-supplements.ts` | `R2` |
| `worker/src/api/status.ts` | `R4` |
| `worker/src/api/telegram-webhook-parsing.ts` | `Q6` |
| `worker/src/cron/daily-digest/collectors.ts` | `Q5` |
| `worker/src/handlers/http.ts` | `S3` |
| `worker/src/lib/jwt-verify.ts` | `Q1` |
| `worker/src/lib/__tests__/jwt-verify.test.ts` | `Q1` |
| `worker/src/lib/status-reliability.ts` | `R4`, `R5` |
| `worker/src/lib/telegram.ts` | `Q2` |
| `worker/src/lib/twitter.ts` | `Q2` |

### Appendix B — Dependency Audit Summary

| Check | Result | Notes |
| --- | --- | --- |
| `npm audit --audit-level=high --omit=dev --json` | Clean | No production high-severity advisories in the checked-in root workspace |
| `cd worker && npm audit --omit=dev --json` | Clean | No production high-severity advisories in the worker workspace |
| `npm outdated --json --workspaces=false` | No direct root package drift surfaced | Root direct dependencies appear aligned with the checked-in manifest/lockfile state |
| `cd worker && npm outdated --json` | Local install drift surfaced | Reported stale installed copies of `wrangler`, `@cloudflare/workers-types`, and `satori`, but `package-lock.json` already pins the newer declared versions; this looks like a local `node_modules` drift issue rather than repo dependency debt |

### Appendix C — Glossary

- Boundary guard: automation that prevents one runtime or architectural layer from importing another layer’s internals.
- Structural clone: duplicated logic that differs only in provider-specific details, variable names, or superficial branching.
- God-function: a function with too many responsibilities, making testing and reasoning harder.
- Hysteresis: status-transition logic that intentionally requires stronger evidence to recover than to degrade, reducing flapping.
- JWKS: JSON Web Key Set, the public-key bundle used to verify JWT signatures.
- Reusable workflow: a GitHub Actions workflow invoked by other workflows to centralize shared release logic.
- Silent degradation: a failure mode where an error is converted into an empty or default result without preserving the degraded reason.
