# Stablecoin Dashboard Multi-Agent Codebase Audit

Date: 2026-03-30  
Scope: full repository review across `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, `.github/workflows/`, and the repo guardrail surface.

Supporting sub-agent notes:
- `agents/audits/2026-03-30-codebase-audit.md`
- `agents/audits/2026-03-30-full-codebase-audit.md`
- `agents/audits/2026-03-30-agent-2-code-quality-audit.md`

## 1. Executive Summary

### Totals

| Pillar | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: |
| Redundancy elimination | 2 | 3 | 1 | 6 |
| Code quality improvement | 2 | 3 | 1 | 6 |
| Sustainability and maintainability | 3 | 3 | 0 | 6 |
| Total | 7 | 9 | 2 | 18 |

### Top 5 Most Critical Findings

1. `Q1` High: malformed `stablecoins` cache JSON can disable or abort severe-staleness protection in the most important sync path. Refs: `worker/src/cron/sync-stablecoins/stages.ts:306-318`, `worker/src/cron/sync-stablecoins/runtime.ts:107-147`
2. `Q2` High: malformed previous `yield-rankings` cache data weakens shrinkage guards by resetting prior publication count to zero. Refs: `worker/src/cron/sync-yield-data.ts:523-534`, `worker/src/cron/yield-sync/publication.ts:150-176`
3. `S1` High: the two most important worker hotspots are still explicitly deferred rather than decomposed: `worker/src/cron/daily-digest/collectors.ts:1-954` and `worker/src/cron/yield-sync/sources.ts:1-803`
4. `R2` High: deploy validation policy is duplicated across local merge-gate code and CI workflow definitions, so release safety depends on keeping JS and YAML in sync. Refs: `scripts/test-merge-gate.mjs:15-107`, `.github/workflows/validate-ci.yml:21-76`, `.github/workflows/deploy-cloudflare.yml:32-40`
5. `S3` High: hotspot governance has blind spots. Several large production files are not tracked by the hotspot ratchet at all, including `shared/lib/report-cards.ts:1-908`, `worker/src/cron/yield-config.ts:1-854`, `worker/src/cron/dex-liquidity/scoring.ts:1-844`, `worker/src/cron/dispatch-telegram-alerts.ts:1-821`, `worker/src/cron/sync-live-reserves.ts:1-528`, and `src/components/contagion-graph.tsx:1-804`

### Overall Codebase Health

- Redundancy: `7/10`
  The repo already passes unused-code, duplicate-export, and cycle checks, but several high-value duplications remain in policy definition, cache parsing, and admin/runtime glue.
- Code quality: `7/10`
  Build, typecheck, tests, migrations, SQL-safety, and dependency audit are all green, but a few malformed-cache paths fail open and several critical branches are under-tested.
- Sustainability: `6/10`
  CI/CD and docs discipline are materially above average, but large acknowledged hotspots and a few monitoring blind spots still dominate future change risk.

### Technical Debt Profile

- Estimated significant debt surface: `~20-25%`
- Most of that debt is concentrated in roughly a dozen high-churn modules rather than spread evenly across the repo.

### Verification Performed

The following were run locally for this audit and passed unless noted:

- `npm run check:unused-code`
- `npm run check:duplicate-exports`
- `npm run check:shared-cycles`
- `npm run check:worker-boundary`
- `npm run check:hotspot-ratchet`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:sql-safety`
- `npm run check:doc-sync`
- `npm run check:migrations`
- `npm run check:stablecoin-data`
- `npm run audit:deps`
- `npm run lint`
  Result: passed with 2 warnings in `scripts/check-stablecoin-data.ts:27-30`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm test`
  Result: 364 files, 3552 tests passed
- `npm run build`

## 2. Findings by Pillar

### A. Redundancy Elimination

#### R1. Worker cache JSON parsing is duplicated across multiple pipelines

- Severity: High
- Location:
  - `worker/src/lib/api-utils.ts:623-636`
  - `worker/src/cron/sync-stablecoins/shared.ts:214-224`
  - `worker/src/cron/sync-stablecoins/stages.ts:312-318`
  - `worker/src/cron/sync-yield-data.ts:523-534`
  - `worker/src/cron/yield-sync/publication.ts:165-176`
  - `worker/src/cron/dispatch-telegram-alerts.ts:512-513`
  - `worker/src/cron/yield-coverage-audit.ts:166-178`
- Description:
  Multiple worker pipelines manually `JSON.parse()` cached D1 payloads with slightly different fallback and logging behavior, even though a shared cache-read helper pattern already exists on the API side.
- Consolidation strategy:
  Extract a typed worker cache-reader helper family and migrate cron consumers to one authoritative parsing and degrade-policy surface.

#### R2. Deploy validation policy exists in both JS and YAML

- Severity: High
- Location:
  - `scripts/test-merge-gate.mjs:15-107`
  - `.github/workflows/validate-ci.yml:21-76`
  - `.github/workflows/deploy-cloudflare.yml:32-40`
- Description:
  The same validation contract is maintained in local merge-gate code and CI workflow steps.
- Consolidation strategy:
  Move the command inventory into one machine-readable manifest or reusable validate script and have local and CI runners consume that single source.

#### R3. Weekly-digest exclusion SQL is duplicated

- Severity: Medium
- Location:
  - `worker/src/cron/daily-digest.ts:100-101`
  - `worker/src/cron/daily-digest/collectors.ts:592-606`
  - `worker/src/cron/daily-digest/collectors.ts:907-910`
  - `worker/src/cron/weekly-recap.ts:167-170`
- Description:
  The raw SQL predicate that excludes weekly recap rows from daily digest history is repeated in four places.
- Consolidation strategy:
  Extract one shared SQL fragment/helper for digest history filtering.

#### R4. Ops UI same-origin gate logic is duplicated across Pages Functions routes

- Severity: Medium
- Location:
  - `functions/admin/[[path]].ts:10-23`
  - `functions/api/admin/[[path]].ts:99-104`
- Description:
  Both Pages Functions independently enforce the same ops-origin gate.
- Consolidation strategy:
  Create a shared Pages Functions helper that returns `Response | null` and use it in both routes.

#### R5. Admin route handling overlaps across multiple abstractions

- Severity: Medium
- Location:
  - `worker/src/lib/route-wrappers.ts:11-47`
  - `worker/src/lib/admin-job.ts:25-44`
  - `worker/src/api/admin-actions.ts:74-126`
  - `worker/src/api/status.ts:19-104`
  - `worker/src/api/status-history.ts:31-67`
- Description:
  Admin auth, request parsing, idempotency, and job orchestration are split across `withAdmin`, `make*AdminRoute`, `runAdminJob`, and handler-local conventions.
- Consolidation strategy:
  Choose one canonical admin-route abstraction with optional body parsing and idempotency support, then migrate the mixed call sites.

#### R6. Test ownership is duplicated across `src` and `shared`

- Severity: Low
- Location:
  - `src/lib/__tests__/format.test.ts:1-80`
  - `shared/lib/__tests__/format.test.ts:1-80`
  - `src/lib/__tests__/supply.test.ts:1-80`
  - `shared/lib/__tests__/supply.test.ts:1-47`
- Description:
  A small but real subset of utility behavior is tested twice across frontend and shared suites, with overlapping assertions for the same shared helpers.
- Consolidation strategy:
  Keep the canonical logic tests with the shared module and leave frontend suites to integration-specific behavior only.

### B. Code Quality Improvement

#### Q1. `detectPriceStaleness()` can throw on malformed cached JSON

- Severity: High
- Location:
  - `worker/src/cron/sync-stablecoins/stages.ts:306-318`
  - `worker/src/cron/sync-stablecoins/runtime.ts:107-147`
- Description:
  `detectPriceStaleness()` does an unguarded `JSON.parse(previousCache.value)`. If the cache row is malformed, the staleness guard path throws instead of degrading cleanly.
- Why it matters:
  This is on the primary `sync-stablecoins` path. A malformed prior cache should never disable or destabilize the write block intended to stop stale-price publication.
- Remediation:
  Reuse the guarded parsing path already present elsewhere in the stablecoins sync code and add a regression test for malformed `stablecoins` cache entries.

#### Q2. Yield publication shrinkage guards fail open on malformed prior rankings cache

- Severity: High
- Location:
  - `worker/src/cron/sync-yield-data.ts:523-534`
  - `worker/src/cron/yield-sync/publication.ts:150-176`
- Description:
  Both the preview guard and the publish guard catch parse failures and reset previous published count to `0`.
- Why it matters:
  Corrupted historical cache data weakens the very guard meant to prevent accidental ranking collapse.
- Remediation:
  Treat malformed prior cache as a degraded or blocking condition rather than as “no previous data”, and add targeted tests for that branch.

#### Q3. Public API rate limiting intentionally fails open on D1 errors

- Severity: Medium
- Location:
  - `worker/src/lib/rate-limit.ts:71-122`
  - `worker/src/handlers/http/gates.ts:44-59`
- Description:
  If the distributed D1 limiter fails, requests are allowed through.
- Why it matters:
  This is a conscious availability tradeoff, but during DB degradation the abuse-protection layer disappears entirely.
- Remediation:
  Keep the current behavior if availability is paramount, but document it as a security tradeoff and consider a bounded emergency fallback mode or alert escalation when this path is hit.

#### Q4. The ops proxy swallows upstream exception detail

- Severity: Medium
- Location:
  - `functions/api/admin/[[path]].ts:128-147`
- Description:
  Upstream fetch failures return generic `502` or `504` responses with no local logging of the exception class or message.
- Why it matters:
  It reduces diagnosability right at the edge where the proxy can still distinguish timeout, DNS, TLS, or request-stream failures.
- Remediation:
  Log a sanitized error summary before returning the generic response.

#### Q5. The chain profile route client is large and lacks dedicated route tests

- Severity: Medium
- Location:
  - `src/app/chains/[chain]/client.tsx:1-788`
  - Scope observation: no dedicated test file under `src/app/chains/**/__tests__/`
- Description:
  The route client is a large user-facing composition surface that mixes view-model derivation, sorting, responsive rendering, and degraded-data handling without its own route-level test file.
- Why it matters:
  Regressions in one of the richer frontend routes can slip through while component and utility tests still pass.
- Remediation:
  Add route-level tests for main render branches, filter/sort behavior, and degraded states, then split more view-model logic out of the component.

#### Q6. Lint warnings are tolerated by CI

- Severity: Low
- Location:
  - `package.json:16`
  - `.github/workflows/validate-ci.yml:36-38`
  - Live warnings:
    - `scripts/check-stablecoin-data.ts:27-30`
- Description:
  `eslint` is run without `--max-warnings=0`, so the repo can claim a green lint pass while still accumulating warning debt.
- Why it matters:
  Warning drift makes it harder to distinguish justified exceptions from newly introduced quality noise.
- Remediation:
  Either tighten lint to fail on warnings or explicitly suppress justified warnings inline so a green lint run is truly warning-free.

### C. Sustainability and Maintainability

#### S1. The two most important worker hotspots remain deferred

- Impact: High
- Location:
  - `worker/src/cron/daily-digest/collectors.ts:1-954`
  - `worker/src/cron/yield-sync/sources.ts:1-803`
  - `scripts/lib/hotspot-ratchet-baseline.json:122-185`
  - `agents/plans/2026-03-29-hotspot-decomposition-backlog.md:56-63`
- Description:
  Both files are explicitly recognized hotspots, but both are still deferred rather than scheduled for decomposition.
- Long-term consequence:
  Future digest-source and yield-source changes will keep landing in the two highest-risk worker modules.
- Recommended remediation:
  Promote both files from ratchet-protected debt to owned roadmap work with dates, scope, and exit criteria.

#### S2. `sync-blacklist()` and `sync-fx-rates()` still centralize too many concerns

- Impact: High
- Location:
  - `worker/src/cron/sync-blacklist.ts:70-415`
  - `worker/src/cron/sync-fx-rates.ts:163-350`
  - `scripts/lib/hotspot-ratchet-baseline.json:162-177`
- Description:
  Both cron shells still mix orchestration, fallback policy, normalization, persistence, counters, and final metadata.
- Long-term consequence:
  Operationally sensitive jobs stay hard to review, hard to delegate, and high-blast-radius when provider logic changes.
- Recommended remediation:
  Reduce each shell to orchestration only and move normalization/persistence into narrower submodules.

#### S3. Hotspot coverage has blind spots

- Impact: High
- Location:
  - Tracked backlog surface: `scripts/lib/hotspot-ratchet-baseline.json:1-214`
  - Representative untracked large files:
    - `shared/lib/report-cards.ts:1-908`
    - `worker/src/cron/yield-config.ts:1-854`
    - `worker/src/cron/dex-liquidity/scoring.ts:1-844`
    - `worker/src/cron/dispatch-telegram-alerts.ts:1-821`
    - `worker/src/cron/sync-live-reserves.ts:1-528`
    - `src/components/contagion-graph.tsx:1-804`
    - `src/app/chains/[chain]/client.tsx:1-788`
- Description:
  The hotspot ratchet works for tracked files, but several very large production modules are outside the tracked set entirely.
- Long-term consequence:
  Large, risky files can remain effectively unmanaged if they are never added to the ratchet backlog.
- Recommended remediation:
  Expand hotspot governance to cover the next tier of large, high-churn production files, not just the current backlog.

#### S4. Long-form methodology and changelog content is still embedded in giant TSX files

- Impact: Medium
- Location:
  - `src/app/methodology/sections/core/safety-scores-section.tsx:14-497`
  - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:12-459`
  - `src/app/methodology/scoring-changelog/content-v5.tsx:1-304`
  - `src/app/methodology/scoring-changelog/content-v6.tsx:1-268`
  - `src/app/methodology/scoring-changelog/content-legacy.tsx:1-354`
- Description:
  Long-form content is stored as large JSX modules instead of as content-oriented structures.
- Long-term consequence:
  Methodology edits remain expensive to review, diff, and delegate, and code-review throughput suffers for mostly textual changes.
- Recommended remediation:
  Move long-form methodology content into MDX or typed content registries while keeping the current page shells and design system.

#### S5. Node 24 compatibility is only partially validated

- Impact: Medium
- Location:
  - `package.json:8-10`
  - `worker/package.json:4-6`
  - `.github/workflows/validate-ci.yml:63-76`
- Description:
  The repo advertises `>=22 <25`, but the Node 24 job runs only lint and typecheck.
- Long-term consequence:
  Runtime or build regressions specific to Node 24 can slip through despite the published engine range.
- Recommended remediation:
  Add at least build and critical tests under Node 24, or narrow the engine range until fuller validation exists.

#### S6. The blocking dependency audit ignores devDependencies

- Impact: Medium
- Location:
  - `package.json:18`
  - `.github/workflows/validate-ci.yml:36`
- Description:
  The production gate runs `npm audit --audit-level=high --omit=dev`, so CI will not fail for vulnerable build/test tooling.
- Long-term consequence:
  Production runtime risk is covered, but the CI and developer supply chain still has a blind spot.
- Recommended remediation:
  Keep the current prod gate, but add a scheduled full audit that includes devDependencies and alerts or files issues on new findings.

## 3. Cross-Cutting Concerns

### C1. Cache parsing is a compound redundancy + correctness + sustainability issue

- Connected findings: `R1`, `Q1`, `Q2`, `S1`
- Evidence:
  - duplicated parsing across stablecoins, yield, telegram, and audit flows
  - malformed-cache guard failures in `sync-stablecoins` and yield publication
- Why it matters:
  This is not just repeated code. It is repeated code at precisely the points where stale or malformed cached state should be handled most carefully.

### C2. Validation policy drift is both a redundancy problem and a release-process risk

- Connected findings: `R2`, `S5`, `S6`
- Evidence:
  - duplicated validate contract in JS and YAML
  - partial Node 24 coverage
  - prod-only dependency audit
- Why it matters:
  The pipeline is strong, but the remaining gaps are at the contract-definition layer rather than in basic CI hygiene.

### C3. Large hotspot modules and missing direct tests reinforce each other

- Connected findings: `Q5`, `S1`, `S2`, `S3`
- Evidence:
  - large untracked route/client and worker modules
  - deferred worker hotspots
  - under-tested rich route composition surface
- Why it matters:
  Large files without the right direct tests become the files the team is least willing to simplify, which locks the debt in place.

### C4. Admin and ops boundary logic is duplicated while diagnostics remain thin

- Connected findings: `R4`, `R5`, `Q4`
- Evidence:
  - duplicated Pages Functions host-gate logic
  - overlapping admin-route abstractions
  - ops proxy exception detail dropped at the edge
- Why it matters:
  Operational surfaces need both consistency and diagnosability; the repo is close, but these pieces still drift apart.

### C5. Methodology content is a quality and architecture problem, not just a docs problem

- Connected findings: `S4`, `Q5`
- Evidence:
  - large TSX content modules
  - large route/client composition files
- Why it matters:
  Content-heavy application areas are currently edited like code-heavy modules, which hurts long-term delegation and review speed.

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q1` | Guard `detectPriceStaleness()` cache parsing and add malformed-cache regression coverage | `worker/src/cron/sync-stablecoins/stages.ts`, `worker/src/cron/__tests__/sync-stablecoins.test.ts` | Small | None |
| `Q2` | Treat malformed prior `yield-rankings` cache as degraded/blocking instead of `0` prior rows | `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/publication.ts`, tests | Small | None |
| `R3` | Extract one shared weekly-digest exclusion fragment/helper | `worker/src/cron/daily-digest.ts`, `worker/src/cron/daily-digest/collectors.ts`, `worker/src/cron/weekly-recap.ts` | Small | None |
| `R4` | Extract shared ops-origin gate helper for Pages Functions | `functions/admin/[[path]].ts`, `functions/api/admin/[[path]].ts`, helper module | Small | None |
| `Q4` | Log sanitized upstream exception detail in the ops proxy | `functions/api/admin/[[path]].ts` | Small | None |
| `Q6` | Remove the current lint warnings and decide whether CI should fail on warnings | `scripts/check-stablecoin-data.ts`, `package.json`, `.github/workflows/validate-ci.yml` | Small | None |

### Phase 2 — Targeted Refactoring

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R1` | Build typed worker cache-reader helpers and migrate manual parsing sites | `worker/src/lib/api-utils.ts` or `worker/src/lib/cache-json.ts`, plus stablecoins/yield/telegram consumers | Medium | `Q1`, `Q2` |
| `R5` | Collapse admin auth/idempotency/request parsing into one route abstraction | `worker/src/lib/route-wrappers.ts`, `worker/src/lib/admin-job.ts`, selected handlers | Medium | None |
| `Q5` | Add dedicated route-level tests for the chain profile client and pull more state derivation out of the component | `src/app/chains/[chain]/client.tsx`, new tests | Medium | None |
| `R6` | Consolidate duplicated shared utility tests to one canonical suite per shared module | `src/lib/__tests__/format.test.ts`, `shared/lib/__tests__/format.test.ts`, `src/lib/__tests__/supply.test.ts`, `shared/lib/__tests__/supply.test.ts` | Medium | None |
| `S6` | Add a scheduled full dependency audit including devDependencies | workflow or scheduled script | Medium | None |

### Phase 3 — Structural Improvements

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R2` | Replace duplicated local/CI validate definitions with one authoritative validation manifest or script | `scripts/test-merge-gate.mjs`, `.github/workflows/validate-ci.yml`, deploy workflow call sites | Medium | None |
| `S2` | Split `sync-blacklist()` into orchestration vs normalization/persistence modules | `worker/src/cron/sync-blacklist.ts`, `worker/src/cron/blacklist/*` | Large | `R1` recommended |
| `S2` | Split `sync-fx-rates()` into orchestration vs provider/persistence policy modules | `worker/src/cron/sync-fx-rates.ts`, `worker/src/cron/sync-fx-rates-helpers.ts` | Large | None |
| `S5` | Expand Node 24 validation to build + critical tests, or narrow the engine range | `package.json`, `.github/workflows/validate-ci.yml` | Medium | None |
| `S3` | Expand hotspot governance to the next tier of large production files | `scripts/lib/hotspot-ratchet-baseline.json`, backlog note | Medium | None |

### Phase 4 — Strategic Overhauls

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S1` | Re-architect daily digest collectors into collector-family modules with shared primitives | `worker/src/cron/daily-digest/collectors.ts`, `worker/src/cron/daily-digest/*`, tests | Large | `R3`, targeted collector tests |
| `S1` | Re-architect yield source ingestion into source-family manifests and a stable registry assembly point | `worker/src/cron/yield-sync/sources.ts`, `sources-optional-protocols.ts`, `sources-helpers.ts`, `resolve.ts` | Large | `R1` |
| `S4` | Move long-form methodology/changelog copy out of giant TSX modules into content-oriented structures | `src/app/methodology/**` | Large | Coordinate with docs/methodology review flow |
| `S3`, `Q5` | Decompose currently untracked large production modules after tests land, starting with `shared/lib/report-cards.ts`, `worker/src/cron/sync-live-reserves.ts`, and `src/app/chains/[chain]/client.tsx` | those modules and dependents | Large | Test scaffolding first |

## 5. Appendices

### A. File-by-File Finding Index

| File | Findings |
| --- | --- |
| `functions/admin/[[path]].ts` | `R4` |
| `functions/api/admin/[[path]].ts` | `R4`, `Q4` |
| `scripts/test-merge-gate.mjs` | `R2` |
| `.github/workflows/validate-ci.yml` | `R2`, `Q6`, `S5`, `S6` |
| `.github/workflows/deploy-cloudflare.yml` | `R2` |
| `worker/src/lib/api-utils.ts` | `R1` |
| `worker/src/cron/sync-stablecoins/shared.ts` | `R1` |
| `worker/src/cron/sync-stablecoins/stages.ts` | `R1`, `Q1` |
| `worker/src/cron/sync-stablecoins/runtime.ts` | `Q1` |
| `worker/src/cron/sync-yield-data.ts` | `R1`, `Q2` |
| `worker/src/cron/yield-sync/publication.ts` | `R1`, `Q2` |
| `worker/src/cron/dispatch-telegram-alerts.ts` | `R1` |
| `worker/src/cron/yield-coverage-audit.ts` | `R1` |
| `worker/src/cron/daily-digest.ts` | `R3` |
| `worker/src/cron/daily-digest/collectors.ts` | `R3`, `S1` |
| `worker/src/cron/weekly-recap.ts` | `R3` |
| `worker/src/lib/route-wrappers.ts` | `R5` |
| `worker/src/lib/admin-job.ts` | `R5` |
| `worker/src/api/admin-actions.ts` | `R5` |
| `worker/src/api/status.ts` | `R5` |
| `worker/src/api/status-history.ts` | `R5` |
| `worker/src/lib/rate-limit.ts` | `Q3` |
| `worker/src/handlers/http/gates.ts` | `Q3` |
| `src/app/chains/[chain]/client.tsx` | `Q5`, `S3` |
| `package.json` | `Q6`, `S5`, `S6` |
| `scripts/check-stablecoin-data.ts` | `Q6` |
| `worker/src/cron/yield-sync/sources.ts` | `S1` |
| `worker/src/cron/sync-blacklist.ts` | `S2` |
| `worker/src/cron/sync-fx-rates.ts` | `S2` |
| `scripts/lib/hotspot-ratchet-baseline.json` | `S1`, `S2`, `S3` |
| `agents/plans/2026-03-29-hotspot-decomposition-backlog.md` | `S1`, `S2`, `S3` |
| `src/app/methodology/sections/core/safety-scores-section.tsx` | `S4` |
| `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx` | `S4` |
| `src/app/methodology/scoring-changelog/content-v5.tsx` | `S4` |
| `src/app/methodology/scoring-changelog/content-v6.tsx` | `S4` |
| `src/app/methodology/scoring-changelog/content-legacy.tsx` | `S4` |

### B. Dependency Audit Summary

| Check | Result | Notes |
| --- | --- | --- |
| Root lockfile | Pass | `package-lock.json` present and used by CI |
| Prod dependency audit | Pass | `npm audit --audit-level=high --omit=dev` found `0` vulnerabilities |
| Direct dependency freshness | Mostly current | Verified via `npm outdated`; only direct majors behind latest were `eslint` and `typescript` |
| Dependabot | Pass | Weekly npm updates for root and worker, monthly GitHub Actions updates |
| Actions pinning | Pass | Workflow actions pinned by commit SHA |
| Static analysis security | Pass | CodeQL workflow present |
| Dev dependency audit | Gap | Not part of the blocking validate surface today |

### C. Glossary

- Fail-open
  A protective mechanism that allows requests or writes to continue when its own dependency fails.
- Hotspot ratchet
  A guardrail that prevents selected large files from getting bigger, without automatically shrinking them.
- Manifest-driven registry
  A pattern where sources/routes/features are declared as structured entries and assembled centrally rather than by hand-written branching.
- Structural clone
  Repeated logic that differs only superficially, such as variable names or minor formatting.
- Write block
  A deliberate guard that stops publishing new data when confidence or freshness checks fail.

## Closing Assessment

This repository is materially healthier than the median codebase of similar size. The guardrails, test suite, migration safety checks, deploy flow, and docs discipline are strong. The next tranche of technical debt work should not be broad cleanup. It should focus on a small number of concentrated risks: malformed-cache guard behavior, duplicated cache parsing, validation-policy duplication, and a handful of large tracked and untracked hotspot modules that still dominate future change cost.
