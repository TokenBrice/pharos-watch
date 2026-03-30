# Stablecoin Dashboard Codebase Audit

Date: 2026-03-30
Scope: full repository review across `src/`, `shared/`, `worker/`, `functions/`, `scripts/`, root config, and CI/workflow surfaces.

## 1. Executive Summary

### Totals

- Total findings: 18
- Redundancy elimination: 6 findings
- Code quality improvement: 6 findings
- Sustainability and maintainability: 6 findings

### Severity / Impact Breakdown

- Critical: 0
- High: 6
- Medium: 11
- Low: 1

### Top 5 Most Critical Findings

1. `R1 / S1` Validation policy is duplicated across local merge-gate code and CI workflow definitions, creating drift risk in the deployment gate.
2. `Q2 / S2` `[chains]/client.tsx` is a 788-line route client with no dedicated tests, leaving a large user-facing surface under-protected.
3. `Q3 / S2` `shared/lib/report-cards.ts` is a 907-line god module mixing methodology, scoring, and presentation concerns.
4. `Q4 / S2` `worker/src/cron/daily-digest/collectors.ts` is a 954-line multi-responsibility collector module that concentrates query, transform, and degradation logic.
5. `Q6 / S6` Legacy `stablecoins` cache compatibility paths remain spread through status, digest, and supplement code, increasing silent-degradation risk and slowing contract hardening.

### Overall Health Assessment

- Redundancy: `7/10`
  - The repo already passes duplicate-export, unused-code, and cycle checks, but still carries a few high-value structural duplications in CI policy, hook wrappers, and admin route handling.
- Code quality: `6/10`
  - Core quality is stronger than average for a codebase this size, but several large files centralize too many concerns and some critical UI/runtime paths are under-tested.
- Sustainability / maintainability: `6/10`
  - The codebase has unusually strong guardrails, docs, and deployment discipline, but hotspot concentration, allowlist-heavy tooling, and partial cross-version validation still create long-term drag.

### Technical Debt Profile

- Estimated codebase affected by significant findings: `~25-30%`
- Rationale:
  - Most files are structurally sound and covered by guardrails.
  - Debt is concentrated in a relatively small set of high-churn, high-impact modules and platform-policy surfaces.

### Guardrails Observed

These checks were run locally and passed:

- `npm run check:unused-code`
- `npm run check:duplicate-exports`
- `npm run check:shared-cycles`
- `npm run check:worker-boundary`
- `npm run check:hotspot-ratchet`
- `npm run audit:deps`

Interpretation:

- The repo’s baseline hygiene is good.
- The findings below are mostly above the threshold of what the current automated guardrails can detect, or they are explicitly hidden behind allowlists / compatibility shims.

## 2. Findings by Pillar

### Redundancy Elimination

#### R1. Validation policy is duplicated between local merge-gate code and CI

- Severity: High
- Location:
  - `scripts/test-merge-gate.mjs:15-44`
  - `scripts/test-merge-gate.mjs:55-107`
  - `.github/workflows/validate-ci.yml:21-62`
  - `.github/workflows/deploy-cloudflare.yml:32-40`
- Description:
  - The same validate contract is encoded twice: once as JavaScript command arrays in the merge gate, and again as explicit workflow steps in CI.
  - The repo mitigates this with parity tests, but the architecture still depends on keeping two representations in sync.
- Why it matters:
  - Drift here directly weakens deploy safety or slows developer feedback with inconsistent gates.
- Consolidation strategy:
  - Extract a single machine-readable validation manifest and generate both the merge-gate command plan and CI workflow steps from it, or move the CI validate body to a single reusable script entrypoint.

#### R2. API hook wrappers are mostly descriptor-level duplication

- Severity: Medium
- Location:
  - `src/hooks/api-hooks.ts:51-248`
  - `src/hooks/use-api-query.ts:22-48`
  - `src/hooks/use-api-query.ts:103-156`
- Description:
  - `useBluechipRatings`, `useDexLiquidity`, `usePegSummary`, `useReportCards`, `useRedemptionBackstops`, `useStabilityIndex`, `useYieldRankings`, `useStressSignals`, and similar hooks repeat the same shape:
    query key + API path + cron interval + schema + optional meta age.
- Why it matters:
  - The duplication is easy to maintain now, but every new endpoint expands a boilerplate surface that must stay aligned with freshness and schema rules.
- Consolidation strategy:
  - Introduce a typed endpoint-query descriptor table and derive the simple wrappers from a common factory.

#### R3. Admin route handling overlaps across three abstractions

- Severity: Medium
- Location:
  - `worker/src/lib/route-wrappers.ts:11-47`
  - `worker/src/lib/admin-job.ts:25-44`
  - `worker/src/api/status.ts:19-103`
  - `worker/src/api/status-history.ts:31-67`
  - `worker/src/api/admin-actions.ts:74-126`
- Description:
  - Admin auth, request parsing, idempotency, and JSON response shaping are split across:
    `withAdmin`, `makeAdminRoute*`, `runAdminJob`, and handler-local wrappers.
  - Some handlers use route wrappers, some use `runAdminJob`, and some inline `withAdmin` directly.
- Why it matters:
  - Responsibility boundaries are blurred, which makes admin-route behavior harder to standardize and review.
- Consolidation strategy:
  - Choose one canonical admin route abstraction with optional body parsing and idempotency hooks, then migrate direct usages to that single pattern.

#### R4. `backfill-depegs.ts` preserves an unused public re-export facade

- Severity: Medium
- Location:
  - `worker/src/api/backfill-depegs.ts:29-49`
  - `scripts/check-unused-code.mjs:94-106`
- Description:
  - `backfill-depegs.ts` re-exports helpers from `backfill-fx.ts` and `backfill-price-sources.ts` “to preserve public API”.
  - The unused-code checker has to allowlist those exports, which is strong evidence that the façade is not meaningfully consumed by runtime code.
- Why it matters:
  - This adds maintenance surface without clear runtime value and weakens the unused-code guardrail.
- Consolidation strategy:
  - Remove the compatibility re-exports unless a real consumer still requires them; point tests and callers at the extracted modules directly.

#### R5. Dormant yield-history backfill utility is only partially live

- Severity: Medium
- Location:
  - `worker/src/cron/yield-history-backfill.ts:58-107`
  - `worker/src/cron/__tests__/yield-history-backfill.test.ts:1-31`
- Description:
  - The file contains a private `_backfillYieldHistory()` flow plus an inline note: “Wire to an admin endpoint when needed.”
  - Only `buildBackfillRows()` is exercised in tests; the actual backfill execution path is not wired into runtime routing or cron dispatch.
- Why it matters:
  - This is effectively parked production logic that still requires review and dependency maintenance.
- Consolidation strategy:
  - Either remove the dormant execution path or expose it through a supported admin route with end-to-end tests and documentation.

#### R6. `StatusClient` duplicates shell rendering across loading, error, and empty states

- Severity: Low
- Location:
  - `src/app/status/client.tsx:110-155`
  - `src/app/status/client.tsx:175-220`
- Description:
  - The same `FeaturePageShell` scaffolding and intro copy are repeated in three early-return branches before the main render path.
- Why it matters:
  - Low impact, but it creates a small local duplication hotspot in an already large route component.
- Consolidation strategy:
  - Extract a tiny `StatusShell` wrapper or a single state renderer for loading/error/empty cases.

### Code Quality Improvement

#### Q1. API contract handling is stricter than the comments suggest

- Severity: High
- Location:
  - `src/lib/api.ts:97-132`
  - `src/lib/api.ts:140-171`
  - `src/lib/api.ts:176-227`
  - `src/hooks/use-api-query.ts:15-48`
  - `src/hooks/use-api-query.ts:103-156`
- Description:
  - `resolveContractMode()` defaults to `"strict"` whenever a schema is provided.
  - Comments on `apiFetch()` still describe warn-and-return-as-is behavior as the default schema behavior.
- Why it matters:
  - This is a correctness and operability issue: small contract drift on any schema-backed endpoint can now hard-fail a page instead of degrading gracefully, and the comments mislead maintainers about that behavior.
- Recommendation:
  - Make the default explicit and align the docs.
  - Prefer endpoint-driven strictness: strict only for the intentionally strict contract surfaces, warn mode elsewhere unless the caller opts in.

#### Q2. The chain profile client is a large untested user-facing route

- Severity: High
- Location:
  - `src/app/chains/[chain]/client.tsx:1-788`
  - Scope observation: no matching dedicated test file under `src/app/chains/**/__tests__/`
- Description:
  - The route client is 788 lines and carries dense UI, filtering, health interpretation, and table rendering logic without dedicated route-level coverage.
- Why it matters:
  - This is a large, user-visible surface where regressions in composition, sorting, empty states, or responsive layout could ship undetected.
- Recommendation:
  - Add route-level tests covering the main rendering branches, sort/filter interactions, and degraded-data cases.
  - Split view-model derivation from rendering so more logic can be tested without DOM-heavy setups.

#### Q3. `shared/lib/report-cards.ts` is a god module

- Severity: High
- Location:
  - `shared/lib/report-cards.ts:1-907`
- Description:
  - The module mixes methodology constants, grade labels, display color maps, multiple dimension scorers, dependency derivation, and narrative detail-string formatting.
- Why it matters:
  - It violates single-responsibility boundaries and makes methodology changes riskier than necessary.
  - It is also harder to test or review changes in isolation.
- Recommendation:
  - Split into:
    - scoring core
    - methodology constants / versioned thresholds
    - UI-facing presentation constants
    - dependency and reserve adapters

#### Q4. Daily digest collectors concentrate too many responsibilities in one file

- Severity: High
- Location:
  - `worker/src/cron/daily-digest/collectors.ts:1-954`
  - `worker/src/cron/daily-digest/input.ts:9-25`
- Description:
  - The collectors file combines SQL access, signal derivation, degraded-mode handling, formatting, and collector orchestration helpers for many distinct digest data domains.
- Why it matters:
  - The file is large enough to slow code review and make unrelated digest changes collide.
  - One regression can affect multiple independent sections of the digest build.
- Recommendation:
  - Split by collector family, for example:
    - market stress
    - blacklist / depeg events
    - mint-burn / liquidity / yield
    - safety / grades / historical context

#### Q5. DEX liquidity scoring remains monolithic even after surrounding decomposition

- Severity: Medium
- Location:
  - `worker/src/cron/dex-liquidity/scoring.ts:1-843`
- Description:
  - The scoring module still owns multiple scoring stages, aggregation logic, and persistence-oriented calculations in a single runtime unit.
- Why it matters:
  - This limits focused reasoning and increases the risk of cross-effect changes when adjusting a single metric or weight.
- Recommendation:
  - Separate:
    - pool normalization helpers
    - score component calculations
    - composite assembly
    - persistence payload building

#### Q6. Legacy stablecoins-cache compatibility paths are spread through critical flows

- Severity: Medium
- Location:
  - `worker/src/lib/stablecoins-cache.ts:59-198`
  - `worker/src/api/status-supplements.ts:80-148`
  - `worker/src/lib/status/data-quality.ts:57-84`
  - `worker/src/cron/daily-digest/input.ts:52-87`
  - Additional spread visible via `allowLegacyArray: true` / `mode: "lenient"` across status, digest, DEWS, PSI, and liquidity consumers
- Description:
  - The cache loader still supports legacy array payloads and lenient degradation modes, and many critical consumers opt into those paths.
- Why it matters:
  - This improves availability during malformed-cache events, but it also means malformed or legacy payloads can keep flowing deeper into the system with filtered / partial semantics.
- Recommendation:
  - Normalize and hard-fail at the cache write boundary.
  - Keep only one narrow compatibility reader for migration windows, with a removal deadline and telemetry.

### Sustainability and Maintainability

#### S1. Deploy-surface validation policy still has two sources of truth

- Impact: High
- Scope:
  - `scripts/test-merge-gate.mjs:15-107`
  - `.github/workflows/validate-ci.yml:21-76`
  - `.github/workflows/deploy-cloudflare.yml:32-40`
- Description:
  - The codebase correctly validates many concerns before deploy, but the policy is encoded in both JS and YAML.
- Long-term consequence:
  - Every new guardrail or command change requires editing multiple surfaces and relying on parity tests to catch misses.
- Recommended remediation:
  - Move the command inventory to one shared manifest or executable validation script and reduce workflows to orchestration only.

#### S2. Hotspot concentration is still too high in several key modules

- Impact: High
- Scope:
  - `worker/src/cron/daily-digest/collectors.ts:1-954`
  - `shared/lib/report-cards.ts:1-907`
  - `worker/src/cron/dex-liquidity/scoring.ts:1-843`
  - `src/app/chains/[chain]/client.tsx:1-788`
  - `src/lib/coverage.ts:1-783`
  - Backlog reference: `agents/plans/2026-03-29-hotspot-decomposition-backlog.md:1-54`
- Description:
  - The hotspot ratchet is preventing growth, but several structurally large files are still carrying broad domain responsibility.
- Long-term consequence:
  - Review latency, merge conflicts, onboarding cost, and regression risk all stay elevated even if file size stops growing.
- Recommended remediation:
  - Treat the existing hotspot backlog as an active program with owners, dates, and split targets, not just a ratchet ledger.

#### S3. The unused-code checker relies on a very large allowlist

- Impact: Medium
- Scope:
  - `scripts/check-unused-code.mjs:20-161`
- Description:
  - The allowlist contains well over a hundred exceptions spanning frontend, shared, worker, mocks, and API helpers.
- Long-term consequence:
  - The check still provides value, but every extra exception increases the chance that genuinely stale exports hide inside the approved set.
- Recommended remediation:
  - Split the allowlist into categories:
    - intentional public/test API
    - generated / runtime-specific exceptions
    - temporary debt exceptions
  - Fail CI on growth in the temporary-debt category.

#### S4. Node 24 compatibility is only partially rehearsed

- Impact: Medium
- Scope:
  - `package.json:8-10`
  - `worker/package.json:4-6`
  - `.github/workflows/validate-ci.yml:63-76`
- Description:
  - The engine range allows Node 24, but the `validate-node24` job only runs `lint` and `typecheck`.
  - It does not run tests, build, or smoke checks.
- Long-term consequence:
  - A future Node 24 behavioral change can slip past CI even though the repo advertises support for it.
- Recommended remediation:
  - Add at least `npm run build` and a critical test subset on Node 24, or narrow the supported engine range until full validation exists.

#### S5. Active and reserved env contracts are broader than the live runtime actually needs

- Impact: Medium
- Scope:
  - `worker/src/lib/env.ts:39-86`
  - `worker/src/lib/env.ts:124-145`
  - `functions/lib/ops-env.ts:19-37`
  - `functions/lib/ops-env.ts:43-64`
- Description:
  - Both worker and Pages Functions expose “reserved” bindings for future use alongside active bindings.
- Long-term consequence:
  - This increases configuration and documentation load, and can confuse audits because the runtime contract is broader than the executable behavior.
- Recommended remediation:
  - Keep future bindings in docs or a separate future-contract export until they are executable requirements.

#### S6. The route registry is still largely hand-wired despite rich endpoint metadata

- Impact: Medium
- Scope:
  - `shared/lib/api-endpoints.ts:1-240`
  - `worker/src/route-registry.ts:142-233`
  - `worker/src/route-registry.ts:252-336`
- Description:
  - Endpoint metadata is already centralized, but handler binding and dynamic route wiring remain mostly manual.
- Long-term consequence:
  - New routes still require touching a large registry file, and wiring mistakes are easy to make even with contract tests.
- Recommended remediation:
  - Move toward typed route descriptor objects where metadata and handler registration live together, or generate the static registry from a single descriptor table.

## 3. Cross-Cutting Concerns

### C1. Validation policy drift risk

- Connected findings: `R1`, `S1`
- Compound issue:
  - The same deploy validation rules are duplicated across local and CI surfaces.
  - This is both redundant and operationally risky because drift weakens release confidence.
- Priority:
  - High

### C2. Oversized core modules concentrate both correctness risk and maintenance cost

- Connected findings: `Q2`, `Q3`, `Q4`, `Q5`, `S2`
- Compound issue:
  - Several of the largest files are also the most behaviorally important: chain profiles, report cards, daily digest, and DEX liquidity scoring.
  - Their size is not just style debt; it directly affects testability, reviewability, and team velocity.
- Priority:
  - High

### C3. Compatibility shims are degrading guardrail strength

- Connected findings: `R4`, `Q6`, `S3`, `S5`
- Compound issue:
  - Unused re-export façades, legacy-array cache support, and large allowlists are all ways of preserving compatibility at the cost of sharper guardrails.
- Priority:
  - Medium-High

### C4. Admin-route infrastructure has redundant patterns and blurred ownership

- Connected findings: `R3`, `S6`
- Compound issue:
  - Admin auth, idempotency, request parsing, and route registration are distributed across multiple abstractions with partial overlap.
- Priority:
  - Medium

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

- `R4`
  - Action: remove unused compatibility re-exports from `worker/src/api/backfill-depegs.ts` and delete the corresponding allowlist entries.
  - Affected: `worker/src/api/backfill-depegs.ts`, `scripts/check-unused-code.mjs`
  - Effort: small
  - Depends on: none

- `R5`
  - Action: delete dormant `_backfillYieldHistory()` runtime logic or promote it to a real admin route.
  - Affected: `worker/src/cron/yield-history-backfill.ts`
  - Effort: small
  - Depends on: product decision on whether the feature should exist

- `R6`
  - Action: extract common `FeaturePageShell` state wrapper in status page.
  - Affected: `src/app/status/client.tsx`
  - Effort: small
  - Depends on: none

- `S5`
  - Action: move reserved env keys into a separate future-contract export or doc-only registry.
  - Affected: `worker/src/lib/env.ts`, `functions/lib/ops-env.ts`, docs
  - Effort: small
  - Depends on: none

### Phase 2 — Targeted Refactoring

- `R2`
  - Action: replace descriptor-level API hook duplication with a typed endpoint-hook factory.
  - Affected: `src/hooks/api-hooks.ts`, `src/hooks/use-api-query.ts`
  - Effort: medium
  - Depends on: none

- `R3`
  - Action: standardize admin route handling on one abstraction.
  - Affected: `worker/src/lib/route-wrappers.ts`, `worker/src/lib/admin-job.ts`, selected handlers
  - Effort: medium
  - Depends on: none

- `Q1`
  - Action: align API contract behavior and comments; make strictness explicit per endpoint.
  - Affected: `src/lib/api.ts`, `src/hooks/use-api-query.ts`, related tests
  - Effort: medium
  - Depends on: none

- `Q2`
  - Action: add route-level tests for chain profile client and extract view-model logic where practical.
  - Affected: `src/app/chains/[chain]/client.tsx`, new `src/app/chains/**/__tests__/...`
  - Effort: medium
  - Depends on: none

- `Q6`
  - Action: reduce legacy-array / lenient cache parsing to a single compatibility boundary.
  - Affected: `worker/src/lib/stablecoins-cache.ts`, status/digest consumers
  - Effort: medium
  - Depends on: schema/write-boundary agreement

- `S3`
  - Action: categorize and shrink the unused-code allowlist.
  - Affected: `scripts/check-unused-code.mjs`
  - Effort: medium
  - Depends on: `R4` and any cleanup of stale exports

- `S4`
  - Action: expand Node 24 CI coverage beyond lint/typecheck.
  - Affected: `.github/workflows/validate-ci.yml`
  - Effort: medium
  - Depends on: CI time budget

### Phase 3 — Structural Improvements

- `R1 / S1`
  - Action: establish a single source of truth for validation commands and generate local/CI consumers from it.
  - Affected: `scripts/test-merge-gate.mjs`, `.github/workflows/validate-ci.yml`, deployment workflow call sites
  - Effort: medium
  - Depends on: agreement on manifest format

- `Q5 / S2`
  - Action: split DEX liquidity scoring into smaller calculation modules.
  - Affected: `worker/src/cron/dex-liquidity/scoring.ts`
  - Effort: medium-large
  - Depends on: preserving current tests and ratchet expectations

- `S6`
  - Action: collapse route metadata and handler binding into a typed route descriptor system.
  - Affected: `shared/lib/api-endpoints.ts`, `worker/src/route-registry.ts`, `worker/src/router.ts`
  - Effort: medium-large
  - Depends on: `R3` if admin-route abstraction is simplified first

### Phase 4 — Strategic Overhauls

- `Q3 / S2`
  - Action: break `shared/lib/report-cards.ts` into scoring, methodology, dependency, and presentation layers.
  - Affected: `shared/lib/report-cards.ts`, consumers in worker and frontend, docs/tests
  - Effort: large
  - Depends on: stable public API plan for score consumers

- `Q4 / S2`
  - Action: decompose daily-digest collectors by domain family and isolate shared SQL helpers.
  - Affected: `worker/src/cron/daily-digest/collectors.ts`, `worker/src/cron/daily-digest/input.ts`, tests
  - Effort: large
  - Depends on: preserving degraded-reason semantics and existing digest tests

- `Q2 / S2`
  - Action: split chain profile page into smaller page-model and section components.
  - Affected: `src/app/chains/[chain]/client.tsx`
  - Effort: large
  - Depends on: adding tests first to preserve behavior during the split

## 5. Appendices

### A. File-by-File Finding Index

- `.github/workflows/deploy-cloudflare.yml`
  - `R1`, `S1`
- `.github/workflows/validate-ci.yml`
  - `R1`, `S1`, `S4`
- `functions/lib/ops-env.ts`
  - `S5`
- `scripts/check-unused-code.mjs`
  - `R4`, `S3`
- `scripts/test-merge-gate.mjs`
  - `R1`, `S1`
- `shared/lib/api-endpoints.ts`
  - `S6`
- `shared/lib/report-cards.ts`
  - `Q3`, `S2`
- `src/app/chains/[chain]/client.tsx`
  - `Q2`, `S2`
- `src/app/status/client.tsx`
  - `R6`
- `src/hooks/api-hooks.ts`
  - `R2`
- `src/hooks/use-api-query.ts`
  - `Q1`, `R2`
- `src/lib/api.ts`
  - `Q1`
- `worker/src/api/admin-actions.ts`
  - `R3`
- `worker/src/api/backfill-depegs.ts`
  - `R4`
- `worker/src/api/status.ts`
  - `R3`
- `worker/src/api/status-history.ts`
  - `R3`
- `worker/src/api/status-supplements.ts`
  - `Q6`
- `worker/src/cron/daily-digest/collectors.ts`
  - `Q4`, `S2`
- `worker/src/cron/daily-digest/input.ts`
  - `Q6`
- `worker/src/cron/dex-liquidity/scoring.ts`
  - `Q5`, `S2`
- `worker/src/cron/yield-history-backfill.ts`
  - `R5`
- `worker/src/lib/admin-job.ts`
  - `R3`
- `worker/src/lib/env.ts`
  - `S5`
- `worker/src/lib/route-wrappers.ts`
  - `R3`
- `worker/src/lib/stablecoins-cache.ts`
  - `Q6`
- `worker/src/route-registry.ts`
  - `S6`

### B. Dependency Audit Summary

| Surface | Count | Notes |
| --- | ---: | --- |
| Root runtime dependencies | 25 | Query/UI/chart/runtime packages, all in active use |
| Root dev dependencies | 17 | Testing, linting, TS, formatting, build tooling |
| Worker runtime dependencies | 2 | `satori`, `@cf-wasm/resvg` |
| Worker dev dependencies | 3 | Wrangler + worker TS types |

Additional observations:

- `npm audit --audit-level=high --omit=dev` returned `0 vulnerabilities`.
- No obvious redundant third-party packages were found in the actively used runtime set.
- The largest dependency-management risk is not known CVEs; it is policy duplication and partial multi-version validation (`S1`, `S4`).

### C. Glossary

- Allowlist debt
  - A code-quality check that remains valuable but is weakened by a growing exception list.
- Compatibility shim
  - Temporary code that preserves behavior for legacy callers or payloads after an internal refactor.
- God module
  - A module that owns too many unrelated responsibilities, making it hard to change safely.
- Hotspot
  - A file or module that is both structurally large and likely to accumulate frequent or risky change.
- Idempotency wrapper
  - Infrastructure that ensures repeated identical admin requests do not execute the same mutation multiple times.
- Single source of truth
  - One authoritative representation of a rule or configuration that downstream consumers derive from.

## Closing Notes

- This codebase is materially healthier than the median application of similar size.
- The highest-value work is not broad cleanup; it is reducing a few concentrated structural hotspots and collapsing duplicated platform policy into single authoritative definitions.
