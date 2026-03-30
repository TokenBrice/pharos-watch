# Stablecoin Dashboard Full Codebase Audit

Date: 2026-03-30
Auditor: Codex
Scope: full repository under `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, `docs/`, and `.github/workflows/`

## 1. Executive Summary

### Inventory

- Repository scale reviewed: 1,405 tracked code/test/doc files
- Frontend files: 542 under `src/`
- Shared runtime-neutral files: 129 under `shared/`
- Worker files: 623 under `worker/src/`
- Functions files: 7 under `functions/`
- Documentation files: 56 under `docs/`

### Verification Performed

- `npm run check:unused-code` -> pass
- `npm run check:shared-cycles` -> pass
- `npm run check:duplicate-exports` -> pass
- `npm run check:hotspot-ratchet` -> pass
- `npm run audit:deps` -> pass, `0` prod vulnerabilities
- `npm run lint` -> pass with `2` warnings
- `npm run typecheck` -> pass
- `cd worker && npx tsc --noEmit` -> pass
- `npm run check:doc-sync` -> pass
- `npm run check:migrations` -> pass
- `npm run check:cron-sync` -> pass
- `npm run check:sql-safety` -> pass
- `npm run check:worker-boundary` -> pass
- `npm run check:cron-connections` -> pass
- `npm run check:redemption-backstops` -> pass
- `npm run check:stablecoin-data` -> pass
- `npm test` -> pass (`364` files, `3552` tests)
- `npm run build` -> pass

### Findings Count

| Pillar | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: |
| Redundancy elimination | 2 | 3 | 1 | 6 |
| Code quality improvement | 1 | 4 | 1 | 6 |
| Sustainability and maintainability | 3 | 3 | 0 | 6 |
| Total | 6 | 10 | 2 | 18 |

### Top 5 Most Critical Findings

1. `Q1` High: malformed `stablecoins` cache JSON can abort `sync-stablecoins` price-staleness detection instead of degrading cleanly. Refs: `worker/src/cron/sync-stablecoins/stages.ts:306-318`, `worker/src/cron/sync-stablecoins/runtime.ts:122-127`
2. `S1` High: `worker/src/cron/daily-digest/collectors.ts:1-954` and `worker/src/cron/yield-sync/sources.ts:1-803` remain deferred mega-modules with very large branch counts and mixed responsibilities, creating concentrated change risk.
3. `S2` High: `worker/src/cron/sync-blacklist.ts:1-415` and `worker/src/cron/sync-fx-rates.ts:1-350` are still queued hotspots; orchestration, fallback policy, and persistence remain coupled in the cron shells.
4. `S3` High: methodology content is still embedded in oversized TSX modules, especially `src/app/methodology/sections/core/safety-scores-section.tsx:14-497`, `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:12-459`, and `src/app/methodology/scoring-changelog/content-{v5,v6,legacy}.tsx:1-304/268/354`, which makes future methodology changes expensive to review and hard to delegate.
5. `R1` High: worker cache JSON parsing is duplicated across multiple pipelines even though a parsing helper already exists, increasing the chance of inconsistent recovery behavior. Refs: `worker/src/lib/api-utils.ts:623-636`, `worker/src/cron/sync-stablecoins/shared.ts:214-224`, `worker/src/cron/sync-stablecoins/stages.ts:312-318`, `worker/src/cron/sync-yield-data.ts:527-530`, `worker/src/cron/yield-sync/publication.ts:165-176`, `worker/src/cron/dispatch-telegram-alerts.ts:512-513`

### Codebase Health Assessment

- Redundancy elimination: `7/10`
  Reason: the repo already has strong duplicate-export, unused-code, and cycle checks, but several critical pipelines still hand-roll the same JSON cache parsing and digest-history filtering logic.
- Code quality improvement: `8/10`
  Reason: build, tests, typecheck, migrations, boundary checks, and SQL-safety gates are strong; the remaining issues are concentrated in a few brittle cache/auth/error-handling seams and incomplete unit coverage around digest collectors.
- Sustainability and maintainability: `7/10`
  Reason: CI/CD, docs, lockfiles, migration safety, and architectural guardrails are mature, but the codebase still carries a small set of acknowledged hotspot files that dominate future-change risk.

### Estimated Technical Debt Profile

- Estimated codebase surface affected by significant findings: `~18%`
- Debt is concentrated in approximately a dozen files rather than spread evenly across the repo.
- The largest contributors are:
  - worker digest and yield ingestion hotspots
  - blacklist and FX cron shells
  - methodology/changelog content modules
  - duplicated cache parsing and auth-gate seams

## 2. Findings by Pillar

### A. Redundancy Elimination

#### R1. Manual cache JSON parsing is duplicated across worker pipelines despite an existing helper

- Priority: High
- Location:
  - `worker/src/lib/api-utils.ts:623-636`
  - `worker/src/cron/sync-stablecoins/shared.ts:214-224`
  - `worker/src/cron/sync-stablecoins/stages.ts:312-318`
  - `worker/src/cron/sync-yield-data.ts:527-530`
  - `worker/src/cron/yield-sync/publication.ts:165-176`
  - `worker/src/cron/dispatch-telegram-alerts.ts:512-513`
  - `worker/src/cron/yield-coverage-audit.ts:170`
- Description:
  Multiple pipelines parse D1 cache payloads manually with slightly different failure behavior. The repo already has `readCachedJsonOr503()` for API-side cache parsing, but cron code re-implements the same pattern repeatedly.
- Why it matters:
  Repeated cache parsing logic increases the odds of inconsistent fallback behavior, inconsistent logging, and latent corruption bugs. It also forces every new pipeline to re-decide how malformed cache data should behave.
- Consolidation strategy:
  Extract a worker-wide typed cache-reader helper family such as `readCachedJson()`, `readCachedJsonOrEmptyMap()`, and `readCachedJsonOrDegradedResult()`, then migrate stablecoins, yield, telegram, and alert pipelines to it.

#### R2. “Exclude weekly digest rows” SQL predicate is duplicated in four places

- Priority: Medium
- Location:
  - `worker/src/cron/daily-digest.ts:100-101`
  - `worker/src/cron/daily-digest/collectors.ts:592-606`
  - `worker/src/cron/daily-digest/collectors.ts:907-910`
  - `worker/src/cron/weekly-recap.ts:167-170`
- Description:
  The same `digest_meta` predicate excluding weekly recap rows is repeated inline as raw SQL text.
- Why it matters:
  Any future change to digest row typing or recap storage semantics can drift across these query sites and produce inconsistent historical slices.
- Consolidation strategy:
  Move the filter into a shared SQL fragment constant or helper that both daily and weekly digest code import.

#### R3. Ops UI same-origin gate logic is duplicated across two Pages Functions routes

- Priority: Medium
- Location:
  - `functions/admin/[[path]].ts:10-23`
  - `functions/api/admin/[[path]].ts:99-104`
- Description:
  Both Pages Functions independently reject requests whose origin does not match `resolveOpsUiOrigin(env)`.
- Why it matters:
  The policy is simple now, but duplicate host-gate logic is easy to change in one place and forget in the other.
- Consolidation strategy:
  Extract a small shared Pages Functions helper like `enforceOpsUiOrigin(request, env)` returning `Response | null`.

#### R4. Daily digest collectors remain a single large collector pack with repeated boilerplate

- Priority: High
- Location:
  - `worker/src/cron/daily-digest/collectors.ts:1-954`
  - Collector entrypoints: `73-99`, `100-141`, `142-217`, `218-290`, `291-329`, `330-415`, `416-541`, `542-576`, `577-702`, `703-779`, `780-835`, `836-899`, `900-954`
- Description:
  Thirteen collector functions share the same degraded-result, parse-failure, and DB-query orchestration pattern inside one file.
- Why it matters:
  The module is hard to navigate, encourages copy/paste expansion, and makes future collector additions more likely to repeat local conventions instead of shared ones.
- Consolidation strategy:
  Split into collector-family modules, for example `collectors/market.ts`, `collectors/risk.ts`, `collectors/history.ts`, and keep only shared collector primitives in `collectors/shared.ts`.

#### R5. Yield-source ingestion is split across two large source modules with overlapping source-assembly responsibility

- Priority: High
- Location:
  - `worker/src/cron/yield-sync/sources.ts:1-803`
  - `worker/src/cron/yield-sync/sources-optional-protocols.ts:1-717`
  - Related helper surface: `worker/src/cron/yield-sync/sources-helpers.ts:1-38`
- Description:
  The yield source layer mixes DL cache loading, on-chain deterministic sources, benchmark loading, RPC family telemetry, and optional protocol adapters across two already-large modules.
- Why it matters:
  Source onboarding is getting more expensive than it needs to be. The current split moved some code out, but it did not yet create a manifest-driven boundary or a stable “source family” plugin shape.
- Consolidation strategy:
  Convert source registration into explicit source-family manifests. Keep deterministic on-chain, optional protocol, and benchmark/risk-free loaders in separate modules with a single registry assembly point.

#### R6. `scripts/check-stablecoin-data.ts` carries a dead `label` field

- Priority: Low
- Location:
  - `scripts/check-stablecoin-data.ts:11-22`
  - `scripts/check-stablecoin-data.ts:27`
- Description:
  `DataFile.label` is declared and populated for every entry but is never read.
- Why it matters:
  Minor, but it is a genuine dead field in a repo that already invests in unused-code detection.
- Consolidation strategy:
  Remove the field or actually emit it in validation output.

### B. Code Quality Improvement

#### Q1. `detectPriceStaleness` can crash on malformed cache JSON instead of degrading safely

- Severity: High
- Location:
  - `worker/src/cron/sync-stablecoins/stages.ts:306-318`
  - Call site: `worker/src/cron/sync-stablecoins/runtime.ts:122-127`
- Description:
  `detectPriceStaleness()` calls `JSON.parse(previousCache.value)` with no `try/catch`. A corrupted `stablecoins` cache entry would throw during the staleness check path.
- Why it matters:
  This is a critical pipeline. Cache corruption should degrade the warning logic, not abort the sync or destabilize the run.
- Remediation:
  Reuse the guarded parse path already used by `loadPreviousStablecoinsById()` or move both call sites to a single validated cache reader. Add a regression test for malformed cache payloads.

#### Q2. Admin auth helper API is easy to misuse because request verification and env-aware verification are split awkwardly

- Severity: Medium
- Location:
  - `worker/src/lib/auth.ts:31-52`
  - `worker/src/lib/auth.ts:69-87`
  - `worker/src/handlers/http/gates.ts:34-60`
  - `worker/src/lib/route-wrappers.ts:11-47`
- Description:
  `hasValidAdminCredential()` supports env-aware JWT validation, but `requireAdmin()` and `withAdmin()` do not accept `env`; they only work because `evaluateAccessGate()` precomputes `trustedAdmin` earlier in the request path.
- Why it matters:
  The current contract is correct only if callers understand the hidden prerequisite. That is easy to miss in future handlers, tests, or refactors and creates a security-sensitive abstraction trap.
- Remediation:
  Make the contract explicit. Either:
  - rename the current helpers to make the trusted-gate prerequisite obvious, or
  - extend `requireAdmin()` / `withAdmin()` to accept `env` and perform complete verification themselves.

#### Q3. Pages ops proxy swallows upstream exception detail completely

- Severity: Medium
- Location:
  - `functions/api/admin/[[path]].ts:134-146`
- Description:
  The upstream fetch `catch` block returns generic `502` or `504` responses but drops the underlying error completely.
- Why it matters:
  This weakens operability. A transient DNS issue, TLS issue, or bad request-body stream problem is indistinguishable in logs at the place where the proxy actually sees the failure.
- Remediation:
  Log a sanitized error summary before returning the generic response. Keep secrets out of logs, but preserve the exception class and message.

#### Q4. Daily digest collector unit coverage is incomplete relative to the collector surface

- Severity: Medium
- Location:
  - Collector module: `worker/src/cron/daily-digest/collectors.ts:73-954`
  - Current direct collector imports: `worker/src/cron/__tests__/daily-digest.test.ts:146-153`
  - Current dedicated collector test blocks:
    - `worker/src/cron/__tests__/daily-digest.test.ts:939-1007`
    - `worker/src/cron/__tests__/daily-digest.test.ts:1008-1108`
    - `worker/src/cron/__tests__/daily-digest.test.ts:1109-1174`
    - `worker/src/cron/__tests__/daily-digest.test.ts:1175-1295`
    - `worker/src/cron/__tests__/daily-digest.test.ts:1296-1368`
- Description:
  Only five collectors have dedicated unit sections. Eight others currently rely on higher-level integration behavior only:
  `collectActiveDepegs`, `collectBlacklistActivity`, `collectSupplyVelocity`, `collectSafetyScores`, `collectResolvedDepegs`, `collectMintBurnFlows`, `collectHistoricalContext`, and `collectGradeTransitions`.
- Why it matters:
  This is one of the repo’s most change-prone narrative outputs. Missing direct tests make regressions harder to localize and encourage conservative “don’t touch it” behavior.
- Remediation:
  Add table-driven tests per collector family, especially for malformed JSON, empty-history, and degraded-source cases.

#### Q5. Lint warnings are tolerated by CI, so “clean” does not actually mean warning-free

- Severity: Medium
- Location:
  - `package.json:16`
  - Current warnings:
    - `scripts/check-stablecoin-data.ts:27`
    - `scripts/check-stablecoin-data.ts:30`
- Description:
  `lint` is configured as plain `eslint`, so CI passes even when warnings exist. Today the repo already carries two live warnings.
- Why it matters:
  Warning-only drift normalizes low-grade quality debt and makes it harder to notice when a warning is real versus a known false positive.
- Remediation:
  Change the lint script to `eslint --max-warnings=0`, or explicitly suppress justified warnings inline with comments so the default lint state is genuinely clean.

#### Q6. Large methodology content components reduce readability and raise review cost

- Severity: Low
- Location:
  - `src/app/methodology/sections/core/safety-scores-section.tsx:14-497`
  - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:12-459`
  - `src/app/methodology/scoring-changelog/content-v5.tsx:1-304`
  - `src/app/methodology/scoring-changelog/content-v6.tsx:1-268`
  - `src/app/methodology/scoring-changelog/content-legacy.tsx:1-354`
- Description:
  These modules are predominantly content, but they are still represented as large JSX functions with long nested markup blocks.
- Why it matters:
  They are hard to diff, hard to review for factual changes, and hard to edit safely because content and layout are intertwined.
- Remediation:
  Move static methodology/changelog prose into typed content data or MDX while keeping the section shell components in TSX.

### C. Sustainability and Maintainability

#### S1. The most important worker hotspots are still explicitly deferred, not resolved

- Impact: High
- Location:
  - `worker/src/cron/daily-digest/collectors.ts:1-954`
  - `worker/src/cron/yield-sync/sources.ts:1-803`
  - `scripts/lib/hotspot-ratchet-baseline.json:122-185`
  - `agents/plans/2026-03-29-hotspot-decomposition-backlog.md:56-63`
- Description:
  The repo knows these files are hotspots and tracks them, but both remain materially above their target budgets and are marked deferred rather than scheduled.
- Long-term consequence:
  Any future work in digest sourcing or yield-source onboarding will keep landing in the highest-risk areas of the worker. This raises onboarding cost and concentrates regression risk.
- Recommended remediation:
  Promote these two files from deferred backlog to an explicit refactor lane with milestone ownership and exit criteria, not just ratchet protection.

#### S2. Blacklist and FX sync cron shells still mix orchestration, fallback policy, and persistence

- Impact: High
- Location:
  - `worker/src/cron/sync-blacklist.ts:1-415`
  - `worker/src/cron/sync-fx-rates.ts:1-350`
  - `scripts/lib/hotspot-ratchet-baseline.json:162-177`
  - `agents/plans/2026-03-29-hotspot-decomposition-backlog.md:47-54`
- Description:
  Both files are on the maintained hotspot backlog, but the top-level shells still coordinate too many concerns.
- Long-term consequence:
  These jobs are operationally sensitive. Keeping normalization, persistence, and failure policy coupled in the entrypoint makes incidents harder to triage and increases the blast radius of routine feature work.
- Recommended remediation:
  Split each cron into:
  - input acquisition
  - normalization/decision policy
  - persistence/reporting
  Keep the entrypoint file as orchestration only.

#### S3. Methodology and changelog content remains too tightly coupled to application code

- Impact: High
- Location:
  - `src/app/methodology/sections/core/safety-scores-section.tsx:14-497`
  - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:12-459`
  - `src/app/methodology/scoring-changelog/content-v5.tsx:1-304`
  - `src/app/methodology/scoring-changelog/content-v6.tsx:1-268`
  - `src/app/methodology/scoring-changelog/content-legacy.tsx:1-354`
  - Hotspot tracking: `scripts/lib/hotspot-ratchet-baseline.json:42-103`
- Description:
  Long-form methodology and historical changelog copy is still stored as large JSX source files.
- Long-term consequence:
  Non-logic methodology updates require code reviews against application modules, which increases merge conflicts, makes factual-review delegation harder, and discourages small incremental edits.
- Recommended remediation:
  Introduce a content representation better suited to long-form documentation, such as MDX or typed content registries, while preserving the existing page shells and design language.

#### S4. Direct dependency freshness is good overall, but major upgrades are intentionally deferred and need a planned lane

- Impact: Medium
- Location:
  - `package.json:16-18`
  - `.github/dependabot.yml:11-23`
  - `.github/dependabot.yml:38-41`
  - Verified on 2026-03-30 via `npm outdated`
- Description:
  Direct dependencies are in good shape, and prod vulnerabilities are clean, but the repo is intentionally behind latest major versions for `eslint` (`9.39.4` -> `10.1.0`) and `typescript` (`5.9.3` -> `6.0.2`).
- Long-term consequence:
  Intentional major-version deferral is reasonable, but without a scheduled upgrade lane, the eventual jump gets larger and harder to validate across Next.js, ESLint, and Worker typings.
- Recommended remediation:
  Create a quarterly “toolchain major bump” maintenance task with explicit compatibility validation instead of leaving the majors perpetually ignored.

#### S5. The blocking dependency audit ignores devDependencies

- Impact: Medium
- Location:
  - `package.json:18`
  - `.github/workflows/validate-ci.yml:28`
- Description:
  The production gate runs `npm audit --audit-level=high --omit=dev`, so CI will not fail for vulnerable build/test tooling.
- Long-term consequence:
  This is acceptable for runtime production risk, but it leaves a blind spot in the developer and CI supply chain.
- Recommended remediation:
  Keep the current prod gate, but add a scheduled non-blocking full dependency audit that includes devDependencies and files an issue or alert on new findings.

#### S6. Hotspot governance prevents regressions, but it does not enforce debt burn-down

- Impact: Medium
- Location:
  - `scripts/check-hotspot-ratchet.mjs:1-29`
  - `scripts/lib/hotspot-ratchet-baseline.json:1-214`
  - `agents/plans/2026-03-29-hotspot-decomposition-backlog.md:1-63`
- Description:
  The current ratchet is effective at preventing hotspot growth, but it does not by itself force any backlog item toward completion.
- Long-term consequence:
  Deferred hotspots can remain stable but still oversized indefinitely, which is a good containment strategy but not a simplification strategy.
- Recommended remediation:
  Tie hotspot entries to roadmap ownership and periodic burn-down targets. The ratchet should remain, but the backlog needs time-bound execution, not only documentation.

## 3. Cross-Cutting Concerns

### C1. Manual cache parsing is a compound issue across redundancy, quality, and sustainability

- Connected findings: `R1`, `Q1`, `S1`
- Evidence:
  - repeated manual parsing: `worker/src/cron/sync-stablecoins/shared.ts:214-224`, `worker/src/cron/sync-stablecoins/stages.ts:312-318`, `worker/src/cron/yield-sync/publication.ts:165-176`, `worker/src/cron/sync-yield-data.ts:527-530`
  - existing helper pattern: `worker/src/lib/api-utils.ts:623-636`
- Why it is compound:
  The logic is duplicated, one instance is already brittle enough to throw on malformed cache state, and the same pattern is concentrated in hotspot worker files.

### C2. Digest pipeline change risk is concentrated in one large collector pack with incomplete direct test coverage

- Connected findings: `R4`, `Q4`, `S1`
- Evidence:
  - collector file: `worker/src/cron/daily-digest/collectors.ts:1-954`
  - direct collector tests only for a subset: `worker/src/cron/__tests__/daily-digest.test.ts:146-153`, `939-1368`
- Why it is compound:
  Repeated collector boilerplate encourages duplication, missing unit coverage reduces change confidence, and the module is already a tracked hotspot.

### C3. Auth-gate responsibility is split across layers in a way that is correct today but easy to misuse tomorrow

- Connected findings: `Q2`, `R3`, `S6`
- Evidence:
  - worker access gate: `worker/src/handlers/http/gates.ts:34-60`
  - auth helpers: `worker/src/lib/auth.ts:31-87`
  - route wrappers: `worker/src/lib/route-wrappers.ts:11-47`
  - Pages same-origin gates: `functions/admin/[[path]].ts:10-23`, `functions/api/admin/[[path]].ts:99-104`
- Why it is compound:
  The repo has secure gates, but the responsibility boundary is spread over multiple helpers and runtimes, which increases abstraction drift risk.

### C4. Long-form methodology content is both a quality and architecture issue

- Connected findings: `Q6`, `S3`
- Evidence:
  - `src/app/methodology/sections/core/safety-scores-section.tsx:14-497`
  - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:12-459`
  - `src/app/methodology/scoring-changelog/content-v5.tsx:1-304`
  - `src/app/methodology/scoring-changelog/content-v6.tsx:1-268`
  - `src/app/methodology/scoring-changelog/content-legacy.tsx:1-354`
- Why it is compound:
  The current representation hurts readability today and will increasingly hurt delegation, review, and content-only edits over time.

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q1` | Guard `detectPriceStaleness()` cache parsing and add malformed-cache regression test | `worker/src/cron/sync-stablecoins/stages.ts`, `worker/src/cron/__tests__/sync-stablecoins.test.ts` | Small | None |
| `R2` | Extract a shared `DAILY_DIGEST_FILTER` constant/helper | `worker/src/cron/daily-digest.ts`, `worker/src/cron/daily-digest/collectors.ts`, `worker/src/cron/weekly-recap.ts` | Small | None |
| `R3` | Extract shared Pages Functions ops-origin gate helper | `functions/admin/[[path]].ts`, `functions/api/admin/[[path]].ts`, `functions/lib/ops-origin.ts` or new helper | Small | None |
| `Q3` | Log sanitized upstream fetch failure detail in the ops proxy | `functions/api/admin/[[path]].ts` | Small | None |
| `R6` | Remove or use `label` and clear the current lint warnings | `scripts/check-stablecoin-data.ts` | Small | None |
| `Q5` | Decide whether warnings should fail CI and adjust lint policy | `package.json`, `.github/workflows/validate-ci.yml` | Small | None |

### Phase 2 — Targeted Refactoring

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R1` | Introduce shared worker cache JSON readers and migrate stablecoins/yield/alerts paths | `worker/src/lib/api-utils.ts` or new `worker/src/lib/cache-json.ts` helpers plus consuming cron files | Medium | `Q1` |
| `Q4` | Add direct unit coverage for the eight untested digest collectors | `worker/src/cron/__tests__/daily-digest.test.ts`, `worker/src/cron/daily-digest/collectors.ts` | Medium | None |
| `Q2` | Make admin-auth helper contracts explicit and env-aware | `worker/src/lib/auth.ts`, `worker/src/lib/route-wrappers.ts`, `worker/src/handlers/http/gates.ts` | Medium | None |
| `S5` | Add scheduled full dependency audit including devDependencies | `.github/workflows/validate-ci.yml` or new scheduled workflow, `package.json` | Medium | None |

### Phase 3 — Structural Improvements

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S2` | Split `sync-blacklist` into orchestration vs normalization/persistence modules | `worker/src/cron/sync-blacklist.ts`, `worker/src/cron/blacklist/*` | Large | `R1` recommended |
| `S2` | Split `sync-fx-rates` into orchestration vs provider/persistence policy modules | `worker/src/cron/sync-fx-rates.ts`, `worker/src/cron/sync-fx-rates-helpers.ts` | Large | None |
| `S4` | Establish scheduled TypeScript and ESLint major-upgrade lane | `package.json`, `.github/dependabot.yml`, CI validation docs | Medium | None |
| `S6` | Turn hotspot backlog items into owned roadmap tasks with exit dates | `agents/plans/2026-03-29-hotspot-decomposition-backlog.md`, planning process | Medium | None |

### Phase 4 — Strategic Overhauls

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S1`, `R4` | Re-architect digest collectors into manifest-driven collector families | `worker/src/cron/daily-digest/collectors.ts`, `worker/src/cron/daily-digest/*`, tests | Large | `Q4`, `R2` |
| `S1`, `R5` | Re-architect yield source ingestion into source-family manifests | `worker/src/cron/yield-sync/sources.ts`, `sources-optional-protocols.ts`, `sources-helpers.ts`, `resolve.ts` | Large | `R1` |
| `S3`, `Q6` | Migrate long-form methodology/changelog copy out of giant TSX modules into structured content/MDX | `src/app/methodology/**` | Large | none, but coordinate with docs/methodology review flow |

## 5. Appendices

### A. File-by-File Finding Index

| File | Findings |
| --- | --- |
| `functions/admin/[[path]].ts` | `R3`, `C3` |
| `functions/api/admin/[[path]].ts` | `R3`, `Q3`, `C3` |
| `scripts/check-stablecoin-data.ts` | `R6`, `Q5` |
| `scripts/check-hotspot-ratchet.mjs` | `S6` |
| `scripts/lib/hotspot-ratchet-baseline.json` | `S1`, `S2`, `S3`, `S6` |
| `agents/plans/2026-03-29-hotspot-decomposition-backlog.md` | `S1`, `S2`, `S6` |
| `package.json` | `Q5`, `S4`, `S5` |
| `.github/workflows/validate-ci.yml` | `Q5`, `S5` |
| `.github/dependabot.yml` | `S4` |
| `worker/src/lib/api-utils.ts` | `R1`, `C1` |
| `worker/src/lib/auth.ts` | `Q2`, `C3` |
| `worker/src/lib/route-wrappers.ts` | `Q2`, `C3` |
| `worker/src/handlers/http/gates.ts` | `Q2`, `C3` |
| `worker/src/cron/sync-stablecoins/shared.ts` | `R1`, `C1` |
| `worker/src/cron/sync-stablecoins/stages.ts` | `R1`, `Q1`, `C1` |
| `worker/src/cron/sync-stablecoins/runtime.ts` | `Q1` |
| `worker/src/cron/sync-yield-data.ts` | `R1`, `C1` |
| `worker/src/cron/yield-sync/publication.ts` | `R1`, `C1` |
| `worker/src/cron/dispatch-telegram-alerts.ts` | `R1`, `C1` |
| `worker/src/cron/yield-coverage-audit.ts` | `R1` |
| `worker/src/cron/daily-digest.ts` | `R2` |
| `worker/src/cron/daily-digest/collectors.ts` | `R2`, `R4`, `Q4`, `S1`, `C2` |
| `worker/src/cron/weekly-recap.ts` | `R2` |
| `worker/src/cron/yield-sync/sources.ts` | `R5`, `S1` |
| `worker/src/cron/yield-sync/sources-optional-protocols.ts` | `R5`, `S1` |
| `worker/src/cron/sync-blacklist.ts` | `S2` |
| `worker/src/cron/sync-fx-rates.ts` | `S2` |
| `worker/src/cron/__tests__/daily-digest.test.ts` | `Q4`, `C2` |
| `src/app/methodology/sections/core/safety-scores-section.tsx` | `Q6`, `S3`, `C4` |
| `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx` | `Q6`, `S3`, `C4` |
| `src/app/methodology/scoring-changelog/content-v5.tsx` | `Q6`, `S3`, `C4` |
| `src/app/methodology/scoring-changelog/content-v6.tsx` | `Q6`, `S3`, `C4` |
| `src/app/methodology/scoring-changelog/content-legacy.tsx` | `Q6`, `S3`, `C4` |

### B. Dependency Audit Summary

| Check | Result | Notes |
| --- | --- | --- |
| Lockfile presence | Pass | Root `package-lock.json` present and used by CI/workspaces |
| Prod vulnerability audit | Pass | `npm audit --audit-level=high --omit=dev` reported `0` vulnerabilities |
| Direct dependency freshness | Mostly current | Verified 2026-03-30 via `npm outdated`; only direct majors behind latest were `eslint` and `typescript` |
| Dependency update automation | Pass | Weekly npm Dependabot for root and worker, monthly GitHub Actions updates |
| Actions pinning | Pass | GitHub Actions are pinned by commit SHA in workflow files |
| Static analysis security | Pass | CodeQL workflow present |

### C. Glossary

- Hotspot ratchet: a guardrail that prevents already-large files from regressing further without necessarily shrinking them.
- Structural clone: code that is logically duplicated even if names or formatting differ.
- SRP violation: Single Responsibility Principle violation; one module changes for too many unrelated reasons.
- Manifest-driven registry: a pattern where feature/source definitions live in declarative entries consumed by a shared loader rather than hand-written branching.
- Degraded mode: explicit partial-service behavior where the system still runs but reports reduced confidence or freshness.
- Blast radius: the amount of unrelated behavior that can be affected by changing one module.

## Overall Conclusion

This codebase is in better shape than most applications of similar size. The deploy pipeline, documentation discipline, migration safety, and test coverage are all materially above average. The main risk is not broad decay; it is concentrated complexity in a handful of worker ingestion/orchestration files and long-form methodology content modules. Those hotspots are already known to the repo, which is good. The next step is to convert that awareness into actual backlog burn-down before the next major feature tranche lands in the same files again.
