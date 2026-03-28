# Stablecoin Dashboard Full Codebase Audit

Date: 2026-03-28
Scope: full repository audit across `src/`, `shared/`, `worker/`, `functions/`, `scripts/`, `docs/`, and CI workflows
Method: repo inventory, parallel multi-agent review, hotspot/guardrail inspection, dependency audit, and local verification

## 1. Executive Summary

### Inventory Snapshot

- Frontend: static-exported Next.js 16 app under `src/app/`
- Shared domain layer: runtime-neutral logic under `shared/lib/`
- Backend/API: Cloudflare Worker handlers, cron jobs, and D1 persistence under `worker/src/`
- Edge proxy/admin surface: Pages Functions under `functions/`
- Repo policy/build surface: validation scripts in `scripts/`, CI in `.github/workflows/`, docs in `docs/`

### Findings Count

| Pillar | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: |
| Redundancy elimination | 1 | 2 | 1 | 4 |
| Code quality improvement | 2 | 2 | 1 | 5 |
| Sustainability / maintainability | 2 | 2 | 1 | 5 |
| Cross-cutting compound issues | 2 | 2 | 0 | 4 |

### Top 5 Most Critical Findings

1. `Q1`: malformed JSON bodies are silently accepted by two admin POST handlers instead of returning `400`
2. `Q2`: `status-reliability.ts` fails open on D1 persistence errors and still returns success-shaped status state
3. `S1`: methodology source of truth is duplicated across docs and giant TSX render modules, raising drift risk
4. `S2`: core worker hotspot modules remain too coarse for safe long-term evolution (`status-reliability`, `live-reserves-store`, `yield-sync/sources`)
5. `R1` / `S5`: old `worker/src/cron/enrich-prices.ts` path references still exist across docs and validation metadata after the refactor to `worker/src/cron/sync-stablecoins/enrich-prices.ts`

### Overall Health Assessment

| Pillar | Score | Justification |
| --- | ---: | --- |
| Redundancy | 7/10 | Shared abstractions are generally strong, but stale path references, one dead export, and a few copy-pasted helpers remain. |
| Code quality | 7/10 | Runtime and test health are solid, but boundary validation and a few oversized control modules still create real defect risk. |
| Sustainability | 7/10 | CI, docs, and deploy automation are unusually mature, but methodology/content duplication and large subsystem files are becoming long-term drag. |

Estimated technical debt affected area: about 15-20% of the repository, concentrated in pricing/admin boundaries, status/live-reserve/yield worker subsystems, and methodology/documentation surfaces.

### Validation Snapshot

Local commands run during this audit:

- `npm audit --audit-level=high --omit=dev`: passed, 0 high/critical advisories
- `npm run lint`: passed with 3 warnings
- `npm test`: passed, 356 files / 3473 tests
- `cd worker && npx tsc --noEmit`: passed
- `npm run build`: passed
- `npm run seo:check`: passed
- `npm run check:shared-cycles`: passed
- `npm run check:duplicate-exports`: passed
- `npm run check:doc-sync`: passed
- `npm run check:cron-sync`: passed
- `npm run check:cron-connections`: passed
- `npm run check:migrations`: passed
- `npm run check:hotspot-ratchet`: passed
- `npm run check:unused-code`: failed

## 2. Findings By Pillar

### Redundancy Elimination

#### R1. Stale path references to the old enrich-prices module remain scattered across docs and validation metadata
- Severity: High
- Exact locations:
  - `scripts/check-unused-code.mjs:128`
  - `docs/worker-infrastructure.md:469`
  - `docs/pricing-pipeline-timeline.md:229`
  - `docs/methodology-page.md:30`
  - `docs/methodology-page.md:86`
  - `docs/testing.md:126`
  - `docs/data-flow-map.md:13`
  - `docs/data-pipeline.md:79`
  - `docs/data-pipeline.md:99`
  - `docs/pricing-pipeline.md:13-14`
  - `docs/pricing-pipeline.md:48`
  - `docs/pricing-pipeline.md:218`
  - `docs/pricing-pipeline.md:231`
  - `docs/architecture.md:444`
  - `docs/worker-and-api-limits.md:25`
  - `docs/worker-and-api-limits.md:93-94`
  - `docs/worker-and-api-limits.md:110`
  - `docs/worker-and-api-limits.md:112`
- Description: the pricing enrichment implementation now lives under `worker/src/cron/sync-stablecoins/enrich-prices.ts`, but repo policy metadata and several docs still point at the removed `worker/src/cron/enrich-prices.ts` path.
- Why it matters: this duplicates file-path truth across scripts and docs and already caused guard drift around `check:unused-code`.
- Consolidation strategy: update all old path references in one pass and avoid path literals in multiple policy surfaces where possible.

#### R2. Dead public re-export in the price-enrichment barrel
- Severity: Medium
- Exact locations:
  - `worker/src/cron/sync-stablecoins/enrich-prices.ts:6-13`
  - `worker/src/lib/price-validation.ts:177-218`
  - `worker/src/api/backfill-depegs.ts:12`
  - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:17-18`
- Description: `buildPriceReasonablenessOptions` is re-exported from the enrich-prices barrel, but current consumers import it directly from `worker/src/lib/price-validation.ts`.
- Why it matters: it expands the public surface without a consumer and is one of the current `check:unused-code` failures.
- Consolidation strategy: remove the dead re-export or move all consumers to the barrel and make that the actual boundary.

#### R3. Duplicate `readBodyJson()` helpers in two admin handlers
- Severity: Medium
- Exact locations:
  - `worker/src/api/backfill-mint-burn.ts:96-102`
  - `worker/src/api/remediate-blacklist-amount-gaps.ts:47-53`
- Description: both handlers define the same helper that clones the request, tries `json()`, and returns `{}` on failure.
- Why it matters: the duplication also duplicates the wrong behavior.
- Consolidation strategy: extract one shared body parser into `worker/src/lib/api-utils.ts` and reuse it.

#### R4. Three taxonomy page wrappers are near-identical copies
- Severity: Low
- Exact locations:
  - `src/app/stablecoins/backing/[backing]/page.tsx:9-29`
  - `src/app/stablecoins/governance/[governance]/page.tsx:9-34`
  - `src/app/stablecoins/protocol/[protocol]/page.tsx:9-29`
- Description: these pages differ only by slug key, page map, and not-found copy.
- Why it matters: the duplication is small today, but it creates repeated edit points for the same route pattern.
- Consolidation strategy: either add a tiny taxonomy-route factory or explicitly keep the wrappers minimal and documented.

### Code Quality Improvement

#### Q1. Two admin POST handlers silently ignore malformed JSON
- Severity: High
- Exact locations:
  - `worker/src/api/backfill-mint-burn.ts:96-102`
  - `worker/src/api/backfill-mint-burn.ts:119-145`
  - `worker/src/api/remediate-blacklist-amount-gaps.ts:47-53`
  - `worker/src/api/remediate-blacklist-amount-gaps.ts:86-105`
- Description: invalid JSON bodies are caught and converted to `{}`, after which the handlers proceed with defaults and query params.
- Why it matters: operator remediation and backfill endpoints should reject malformed input, not silently reinterpret it. Silent fallback can trigger the wrong scope or write mode.
- Recommended remediation: replace both helpers with a shared parser that returns `errorResponse(400, "Invalid JSON body")` on parse failure, while still allowing truly empty bodies where intended.

#### Q2. `status-reliability.ts` fails open on persistence errors
- Severity: High
- Exact locations:
  - `worker/src/lib/status-reliability.ts:128-138`
  - `worker/src/lib/status-reliability.ts:250-450`
  - `worker/src/lib/status-reliability.ts:458-480`
  - `worker/src/lib/status-reliability.ts:542-560`
  - `worker/src/lib/status-reliability.ts:620-689`
  - `worker/src/lib/status-reliability.ts:697-742`
- Description: the module catches D1 read/write failures, logs them, and still returns success-shaped fallback state or updated counters.
- Why it matters: this is an operator-facing reliability surface. Returning effective status updates after failed persistence makes the in-memory result look durable when it may not be.
- Recommended remediation: return explicit durability state from persistence calls and make callers surface a degraded or indeterminate result when writes fail.

#### Q3. `syncStablecoins()` is still a monolithic control function
- Severity: Medium
- Exact location: `worker/src/cron/sync-stablecoins.ts:47-339`
- Description: one 293-line function orchestrates intake, FX loading, primary pricing, fallback enrichment, GT probing, post-validation, cache write, depeg pipeline, telemetry, and error routing.
- Why it matters: it is hard to reason about stage boundaries, test stage contracts in isolation, or safely change one part without rereading the full flow.
- Recommended remediation: split it into explicit stage functions with typed stage results, for example `runIntakeStage()`, `runPrimaryPricingStage()`, `runEnrichmentStage()`, `runCachePublishStage()`, and `runDepegStage()`.

#### Q4. Coverage and methodology route surfaces have direct test gaps
- Severity: Medium
- Exact locations:
  - `src/app/coverage/client.tsx:1-441`
  - `src/app/coverage/use-coverage-filters.ts:1-76`
  - `src/app/methodology/sections/core-sections.tsx:29-1261`
  - `src/app/methodology/sections/monitoring-sections.tsx:26-1034`
  - `src/app/methodology/scoring-changelog/page.tsx:1-1203`
- Description: the repository has good library-level coverage for methodology versions and coverage helpers, but there are no matching route/hook tests under `src/app/coverage/` or `src/app/methodology/`.
- Why it matters: these files drive route composition, filtering, and high-value long-form content, so regressions can slip through while lower-level helpers still pass.
- Recommended remediation: add focused tests for `useCoverageFilters()` and a small set of route-level rendering assertions for the methodology and coverage pages.

#### Q5. Three worker scripts still emit security lint warnings for non-literal file writes
- Severity: Low
- Exact locations:
  - `worker/scripts/rebuild-blacklist-current-balances.ts:395`
  - `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts:125`
  - `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts:219`
- Description: `eslint-plugin-security` warns on non-literal `writeFileSync` targets in these maintenance scripts.
- Why it matters: the warnings are probably benign repo-local usage, but the intent is undocumented and the lint signal is left noisy.
- Recommended remediation: either validate and constrain the paths before writing, or add targeted suppressions with a rationale so the remaining lint output stays meaningful.

### Sustainability And Maintainability

#### S1. Methodology content has two live sources of truth: docs and giant TSX render modules
- Impact: High
- Exact locations:
  - `docs/methodology-page.md:45-55`
  - `docs/methodology-page.md:70-80`
  - `src/app/methodology/sections/core-sections.tsx:29-1261`
  - `src/app/methodology/sections/monitoring-sections.tsx:26-1034`
  - `src/app/methodology/scoring-changelog/page.tsx:1-1203`
- Description: methodology changes require synchronized edits across docs plus large TSX content modules that embed long-form prose and examples directly in JSX.
- Long-term consequence: review cost, merge-conflict risk, and doc/runtime drift all rise as methodology surfaces expand.
- Recommended remediation: move repeatable methodology/changelog content into structured content modules or MDX/data registries and keep TSX focused on layout.

#### S2. Three core worker subsystems remain too coarse for safe independent evolution
- Impact: High
- Exact locations:
  - `worker/src/lib/status-reliability.ts:1-780`
  - `worker/src/lib/live-reserves-store.ts:1-827`
  - `worker/src/cron/yield-sync/sources.ts:1-803`
- Description: each file mixes multiple concerns:
  - `status-reliability.ts`: hysteresis, persistence, discrepancy tracking, and alert bookkeeping
  - `live-reserves-store.ts`: persistence, parsing, freshness, scoring eligibility, and overview shaping
  - `yield-sync/sources.ts`: upstream adapters, deterministic rates, benchmark loading, and cache behavior
- Long-term consequence: these files become ownership bottlenecks, merge hotspots, and high-cost review surfaces.
- Recommended remediation: split each subsystem into narrower modules with explicit boundaries such as repo, parser, evaluator, and adapter layers.

#### S3. CI treats lint warnings as passing, including security-rule warnings
- Impact: Medium
- Exact locations:
  - `package.json:16`
  - `.github/workflows/validate-ci.yml:36-38`
  - `worker/scripts/rebuild-blacklist-current-balances.ts:395`
  - `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts:125`
  - `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts:219`
- Description: `npm run lint` is part of CI, but the command does not enforce `--max-warnings 0`, so warning debt can accumulate without failing validation.
- Long-term consequence: the validate gate looks green while known warnings remain, which weakens trust in lint as a quality signal.
- Recommended remediation: either eliminate or explicitly suppress the current warnings, then make CI fail on warnings.

#### S4. Dependency health is good on vulnerabilities, but major-version drift is starting to accumulate
- Impact: Medium
- Exact locations:
  - `package.json:63`
  - `package.json:82`
  - `package.json:90`
  - `worker/package.json:13`
- Description: `npm audit` is clean, but `npm outdated --json` shows major-version gaps on `lucide-react`, `eslint`, and `typescript` in both root and worker workspace usage.
- Long-term consequence: delaying tooling and library upgrades turns routine maintenance into larger upgrade cliffs.
- Recommended remediation: schedule a dependency refresh lane focused on framework-compatible upgrades, starting with `eslint` and `typescript`.

#### S5. Validation and documentation metadata still depend on scattered hard-coded file paths
- Impact: Low
- Exact locations:
  - `scripts/check-unused-code.mjs:128`
  - `docs/methodology-page.md:30`
  - `docs/testing.md:126`
  - `docs/worker-and-api-limits.md:25`
- Description: repo policy and documentation still embed implementation file paths directly in many places.
- Long-term consequence: refactors require many manual follow-up edits, and the probability of path drift remains high.
- Recommended remediation: centralize canonical subsystem path metadata where practical and reduce repeated path literals in repo-policy docs.

## 3. Cross-Cutting Concerns

### C1. The duplicated JSON-body helper is also the source of a real operator-safety bug
- Connected findings: `R3`, `Q1`
- Why this is compound: this is not harmless duplication. The same copy-pasted helper encodes the same incorrect fail-soft behavior in two admin write surfaces.
- Priority: High

### C2. Methodology content is both redundant and structurally hard to maintain
- Connected findings: `R1`, `Q4`, `S1`
- Why this is compound: the same domain is spread across docs, route modules, and long-form changelog pages, while direct route-level tests are sparse.
- Priority: High

### C3. Validation-surface trust depends on keeping policy scripts and docs in sync with refactors
- Connected findings: `R1`, `R2`, `S5`
- Why this is compound: one refactor left stale file-path metadata in docs and checks, and the same area also contains the current unused-export failure.
- Priority: Medium

### C4. Worker hotspots mix orchestration, persistence, and policy in the same modules
- Connected findings: `Q2`, `Q3`, `S2`
- Why this is compound: the code currently works, but these files are where future changes will be slowest and riskiest because responsibilities are not cleanly separated.
- Priority: Medium

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q1`, `R3` | Replace duplicated `readBodyJson()` helpers with one shared strict parser that returns `400` on malformed JSON | `worker/src/api/backfill-mint-burn.ts`, `worker/src/api/remediate-blacklist-amount-gaps.ts`, `worker/src/lib/api-utils.ts` | Small | None |
| `R2` | Remove the dead `buildPriceReasonablenessOptions` re-export or move consumers to the barrel intentionally | `worker/src/cron/sync-stablecoins/enrich-prices.ts` | Small | None |
| `R1`, `S5` | Update all stale `worker/src/cron/enrich-prices.ts` references in docs and repo-policy metadata | `docs/*`, `scripts/check-unused-code.mjs` | Small | None |
| `Q5`, `S3` | Resolve or explicitly suppress the three current script lint warnings, then make warnings actionable | `worker/scripts/*.ts` | Small | None |

### Phase 2 - Targeted Refactoring

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q2` | Add durability-aware return types to status persistence paths and surface write failures explicitly | `worker/src/lib/status-reliability.ts` | Medium | None |
| `Q3` | Break `syncStablecoins()` into typed stage functions with narrow contracts | `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-stablecoins/*` | Medium | None |
| `Q4` | Add direct tests for `useCoverageFilters()` and route-level rendering checks for methodology/coverage pages | `src/app/coverage/*`, `src/app/methodology/*` | Medium | None |
| `R4` | Decide whether taxonomy wrappers should use a route factory or remain intentionally duplicated | `src/app/stablecoins/*/[...]/page.tsx` | Small | None |

### Phase 3 - Structural Improvements

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S2` | Split live-reserve, status, and yield-source hotspot files into narrower modules | `worker/src/lib/live-reserves-store.ts`, `worker/src/lib/status-reliability.ts`, `worker/src/cron/yield-sync/sources.ts` | Large | Phase 2 helps |
| `S3` | Enforce `--max-warnings 0` in validation once warnings are either fixed or justified | `package.json`, `.github/workflows/validate-ci.yml` | Small-Medium | Phase 1 warning cleanup |
| `S4` | Run a dependency maintenance pass for `eslint`, `typescript`, and `lucide-react` | `package.json`, `worker/package.json` | Medium | None |

### Phase 4 - Strategic Overhauls

| Ref | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S1`, `C2` | Introduce a structured methodology/changelog content model so docs and runtime pages are not edited separately | `docs/*`, `src/app/methodology/*`, possible shared content registry | Large | Phase 2 tests recommended first |
| `S2`, `C4` | Re-architect hotspot worker subsystems into bounded modules with clearer public APIs and ownership seams | status, live reserves, yield ingestion subsystems | Large | Phase 3 subsystem splits |

## 5. Appendices

### Appendix A. File-By-File Finding Index

| File | Finding refs |
| --- | --- |
| `scripts/check-unused-code.mjs` | `R1`, `S5` |
| `docs/worker-infrastructure.md` | `R1` |
| `docs/pricing-pipeline-timeline.md` | `R1` |
| `docs/methodology-page.md` | `R1`, `S1`, `S5` |
| `docs/testing.md` | `R1`, `S5` |
| `docs/data-flow-map.md` | `R1` |
| `docs/data-pipeline.md` | `R1` |
| `docs/pricing-pipeline.md` | `R1` |
| `docs/architecture.md` | `R1` |
| `docs/worker-and-api-limits.md` | `R1`, `S5` |
| `worker/src/cron/sync-stablecoins/enrich-prices.ts` | `R2` |
| `worker/src/lib/price-validation.ts` | `R2` |
| `worker/src/api/backfill-depegs.ts` | `R2` |
| `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | `R2` |
| `worker/src/api/backfill-mint-burn.ts` | `R3`, `Q1` |
| `worker/src/api/remediate-blacklist-amount-gaps.ts` | `R3`, `Q1` |
| `src/app/stablecoins/backing/[backing]/page.tsx` | `R4` |
| `src/app/stablecoins/governance/[governance]/page.tsx` | `R4` |
| `src/app/stablecoins/protocol/[protocol]/page.tsx` | `R4` |
| `worker/src/lib/status-reliability.ts` | `Q2`, `S2` |
| `worker/src/cron/sync-stablecoins.ts` | `Q3` |
| `src/app/coverage/client.tsx` | `Q4` |
| `src/app/coverage/use-coverage-filters.ts` | `Q4` |
| `src/app/methodology/sections/core-sections.tsx` | `Q4`, `S1` |
| `src/app/methodology/sections/monitoring-sections.tsx` | `Q4`, `S1` |
| `src/app/methodology/scoring-changelog/page.tsx` | `Q4`, `S1` |
| `worker/scripts/rebuild-blacklist-current-balances.ts` | `Q5`, `S3` |
| `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts` | `Q5`, `S3` |
| `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` | `Q5`, `S3` |
| `worker/src/lib/live-reserves-store.ts` | `S2` |
| `worker/src/cron/yield-sync/sources.ts` | `S2` |
| `package.json` | `S3`, `S4` |
| `.github/workflows/validate-ci.yml` | `S3` |
| `worker/package.json` | `S4` |

### Appendix B. Dependency Audit Summary

| Package / Check | Current | Latest observed | Scope | Notes |
| --- | --- | --- | --- | --- |
| `npm audit --omit=dev` | clean | clean | prod deps | No known high/critical advisories |
| `lucide-react` | `0.577.0` | `1.7.0` | root runtime | Major drift, low immediate urgency |
| `eslint` | `9.39.4` | `10.1.0` | root dev | Major drift, coordinate with Next/Eslint config support |
| `typescript` | `5.9.3` | `6.0.2` | root + worker | Shared major drift across the workspace |
| Lockfile | `package-lock.json` present | n/a | workspace | Single root lockfile covers the workspace |

### Appendix C. Glossary

- Fail-open: returning a success-like result after an internal failure instead of forcing a degraded/error state.
- Hotspot: a file whose size, function length, or branch density makes it expensive to change safely.
- SRP violation: a module with too many unrelated reasons to change.
- Structured duplication: repeated logic or content shape with only small literal differences.
- Static export: Next.js output mode where pages are prerendered to static assets.
- Validation surface: the combined local and CI checks that gate merges and deploys.
