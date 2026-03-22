# 2026-03-21 Full Codebase Audit

Scope: full repository audit across `src/`, `shared/`, `worker/`, `functions/`, `scripts/`, `.github/`, and the relevant docs corpus. The audit combined three parallel specialist passes with local verification. Inventory covered 904 files total, including 816 source files under `src/`, `shared/`, `worker/`, and `functions/`.

Validation baseline used for this report:

- Passed: `npm run lint`
- Passed: `npm run build`
- Passed: `cd worker && npx tsc --noEmit`
- Passed: `npm run check:worker-boundary`
- Passed: `npm run check:migrations`
- Passed: `npm run check:cron-sync`
- Passed: `npm run check:doc-counts`
- Passed: `npm run check:doc-sync`
- Passed: `npm run check:duplicate-exports`
- Passed: `npm run check:redemption-backstops`
- Passed: `npm run check:unused-code`
- Passed: `npm run check:hotspot-ratchet`
- Passed: `npm run audit:deps`
- Failed: `npm test` in `src/lib/__tests__/reserve-coinid-validation.test.ts:20-42` because the warning budget `<= 12` is now exceeded; a focused rerun observed 13 warnings

## 1. Executive Summary

### Totals

| Pillar | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: |
| Redundancy elimination | 1 | 5 | 2 | 8 |
| Code quality improvement | 3 | 7 | 0 | 10 |
| Sustainability / maintainability | 2 | 5 | 2 | 9 |
| **Total** | **6** | **17** | **4** | **27** |

No Critical-severity issue was confirmed during this audit.

### Top 5 Most Important Findings

1. `QLT-001` — `worker/src/lib/status-evaluation.ts` can misreport cron telemetry failure as platform staleness, creating false stale incidents.
2. `QLT-004` — `worker/src/cron/sync-fx-rates.ts` bypasses the intended Open Exchange Rates cooldown when a request succeeds but yields zero usable rates.
3. `SUS-001` — reserve metadata governance has drifted far enough that `npm test` now fails on the reserve `coinId` warning budget.
4. `SUS-005` — Pages releases are coupled to the live production digest API at build time, making releases non-reproducible and externally dependent.
5. `QLT-005` — `worker/src/lib/status-reliability.ts` silently swallows persistence failures in the status hysteresis path, hiding degradation in the authoritative incident record.

### Overall Health

| Pillar | Score | Justification |
| --- | ---: | --- |
| Redundancy elimination | 6.5 / 10 | Broad dead-code and duplicate-export drift is well controlled, but there are still several medium-sized structural clones in UI routes/components and worker flows. |
| Code quality improvement | 5.5 / 10 | The biggest problems are operational correctness, hidden failure modes, brittle tests, and oversized stateful modules. |
| Sustainability / maintainability | 6.0 / 10 | Documentation and CI are stronger than average, but routing/configuration dispersion, build/runtime coupling, limited hotspot coverage, and import cycles increase future change cost. |

### Technical Debt Profile

High- and medium-impact findings touch roughly 40 files/modules directly. Weighted by the size of the implicated worker cron/status modules and large frontend client surfaces, about 25% of production LOC sits inside modules affected by significant findings. Debt is concentrated rather than uniform: worker status/cron code, static route wiring, release/build plumbing, and several large client components account for most of the risk.

## 2. Findings by Pillar

### Redundancy Elimination

Repo-native dead-code and duplicate-export checks were clean. I did not confirm broad dead modules, unused exports, or redundant third-party libraries beyond the targeted duplications below.

#### RED-001 | High

- Locations: `worker/src/api/telegram-webhook.ts:244-268`, `301-319`, `348-367`, `461-487`, `491-511`, `515-540`
- Problem: the `runCoinResolutionFlow()` completion work is duplicated for `subscribe`, `unsubscribe`, and `set` in both the initial command path and the disambiguation-reply path. The duplicated lambdas perform the same persistence and summary-message work.
- Why it matters: behavior changes must be patched in two places per action, which is exactly the kind of duplication that drifts in operator-facing workflows.
- Consolidation: move action-specific completion behavior into a handler registry such as `completionHandlers.subscribe/unsubscribe/set`, then pass that registry into both call sites.

#### RED-002 | Medium

- Locations: `src/components/dex-liquidity-card.tsx:77-125`, `127-177`; `src/components/liquidity-stats.tsx:37-57`, `58-122`, `124-176`
- Problem: chain/protocol breakdown rendering is reimplemented in two components. Both sort aggregates, assign fallback colors, filter tiny slices, and render stacked bars plus legends independently.
- Why it matters: the display thresholds already diverge (`1%` vs `0.5%`). Even if the threshold difference is intentional, the rendering logic is duplicated and will drift.
- Consolidation: extract shared `BreakdownBar` and `BreakdownLegend` primitives with configurable thresholds and formatting.

#### RED-003 | Medium

- Locations: `src/app/stablecoins/backing/[backing]/page.tsx:9-44`, `src/app/stablecoins/governance/[governance]/page.tsx:9-44`, `src/app/compare/[slug]/page.tsx:15-47`
- Problem: three slug-backed routes repeat the same “load by slug, emit fallback metadata, call `notFound()` when missing” boilerplate.
- Why it matters: backing and governance are near-identical now, and compare follows the same pattern; each new slug-backed route raises the same duplication cost.
- Consolidation: add a small route helper/factory that takes `paramKey`, `pages`, `pageBySlug`, and fallback metadata.

#### RED-004 | Medium

- Locations: `src/components/daily-digest.tsx:46-67`, `175-196`
- Problem: digest paragraph parsing and rendering logic is duplicated between full and preview variants.
- Why it matters: a formatting fix must be applied twice, which is unnecessary given the parsing rules are identical.
- Consolidation: extract a shared paragraph tokenizer/renderer and pass typography variants from the parent layouts.

#### RED-005 | Medium

- Locations: `src/app/safety-scores/client.tsx:452-514`, `519-580`
- Problem: mobile and desktop control blocks duplicate the same grade-filter buttons, sort buttons, and defunct-toggle behavior.
- Why it matters: only layout differs. Control behavior can drift across breakpoints.
- Consolidation: split out shared `GradeFilterButtons`, `SortButtons`, and `ShowDefunctToggle` components.

#### RED-006 | Low

- Locations: `src/app/stability-index/client.tsx:289-313`, `315-339`
- Problem: `HistoryStats` and `HistoryStatsMobile` duplicate the same empty state, band-color lookup, item mapping, and subtitle rendering.
- Why it matters: this is low-risk but pure view duplication.
- Consolidation: keep one `HistoryStats` component with a compact/mobile style variant.

#### RED-007 | Low

- Locations: `worker/src/lib/fx-rate-state.ts:76-85`, `worker/src/lib/price-validation.ts:89-98`, `worker/src/cron/mint-burn/run-state.ts:6-14`, `16-24`
- Problem: small record/set normalizers are copy-pasted with only validation or case-transform rules changed.
- Why it matters: the repeated iteration-and-filter pattern adds noise and obscures intent.
- Consolidation: extract generic helpers such as `sanitizeRecordValues()` and `normalizeStringSet(transform)`.

#### RED-008 | Low

- Locations: `worker/src/lib/og-templates/safety-scores-card.tsx:140-181`, `184-225`
- Problem: the “Top 3 safest” and “Bottom 3 riskiest” sections render the same row structure twice with only heading text/color and source array changed.
- Why it matters: any OG layout adjustment has to be mirrored manually.
- Consolidation: extract a `PerformerList` subcomponent parameterized by title, accent color, and coin list.

### Code Quality Improvement

No obvious critical injection or auth bug was confirmed during this audit. The main quality problems are operational misclassification, hidden failures, test brittleness, and oversized untested surfaces.

#### QLT-001 | High

- Location: `worker/src/lib/status-evaluation.ts:197-224`, `293-329`, `385-390`, `505-512`
- Problem: if the `cron_runs` query fails, every cron gets an empty run list and is treated as unhealthy. That can force availability to `stale` even when the scheduler is actually healthy.
- Why it matters: telemetry failure is being reported as platform failure, which produces false incidents and erodes operator trust.
- Remediation: add an explicit `unknown` cron state for history-query failure, exclude it from `unhealthyCrons` and `anyCronError`, and add a regression test covering `cronHistoryQueryFailed`.

#### QLT-004 | High

- Location: `worker/src/cron/sync-fx-rates.ts:572-618`
- Problem: the Open Exchange Rates cooldown key `fx-oxr-last-fetch` is written only when `realtimeRates.size > 0`. If OXR responds but validation yields zero usable rates, the job retries every 15 minutes instead of respecting the intended 55-minute throttle.
- Why it matters: this creates avoidable upstream pressure and distorts circuit-breaker/rate-limit behavior.
- Remediation: persist a last-attempt timestamp on any completed OXR request and keep a separate success timestamp if needed.

#### QLT-005 | High

- Location: `worker/src/lib/status-reliability.ts:201-214`, `230-254`, `269-290`, `323-348`, `400-422`, `431-465`, `480-499`, `553-615`, `625-664`
- Problem: the status hysteresis persistence path silently swallows D1 failures and migration drift, returning fallback values with no operator-visible degradation signal.
- Why it matters: these writes back the authoritative incident-state record. Silent persistence loss undermines every downstream status-history and discrepancy feature.
- Remediation: log once per failure class, surface a degraded diagnostic flag or section error in the status payload, and add tests for missing migrations and write failures.

#### QLT-002 | Medium

- Location: `worker/src/lib/status-evaluation.ts:473-503`
- Problem: generic `cacheWarnings` are emitted only in the `else if` branch after FX-source checks, so stale/degraded FX source data suppresses all other cache warnings.
- Why it matters: concurrent freshness problems are hidden from operators.
- Remediation: make `cacheWarnings` a separate `if` block so FX warnings and general cache warnings can coexist.

#### QLT-003 | Medium

- Location: `worker/src/api/feedback/request.ts:54-72`
- Problem: the feedback handler consumes rate-limit quota before confirming that `GITHUB_PAT` is configured.
- Why it matters: users can burn submission attempts against a misconfigured service and still receive a `503`.
- Remediation: validate required secrets first, then apply rate limiting only when the request can actually proceed.

#### QLT-006 | Medium

- Location: `functions/api/admin/[[path]].ts:131-140`
- Problem: the Pages admin proxy forwards to the operator API without any timeout.
- Why it matters: a stalled upstream hangs until platform timeout and collapses timeout vs fetch-failure diagnostics into the same `502`.
- Remediation: wrap the upstream call in `AbortSignal.timeout(...)`, map timeout to `504`, and add a proxy timeout test.

#### QLT-007 | Medium

- Location: `worker/src/cron/confirm-pending-depegs.ts:207-224`; related batch helper `worker/src/lib/cex-tickers.ts:83-115`
- Problem: `fetchBinancePrices()` fetches the full Binance ticker snapshot in one call, but `confirmPendingDepegs` invokes it inside the per-pending-row loop.
- Why it matters: outbound latency scales with row count, which increases timeout risk and wastes the batching helper.
- Remediation: fetch the Binance map once before the loop and reuse it for all rows.

#### QLT-008 | Medium

- Location: `worker/src/cron/__tests__/confirm-pending-depegs.test.ts:170-348`; related network path `worker/src/lib/cex-tickers.ts:88-115`
- Problem: the test suite mocks `fetchWithRetry` but does not intercept `fetch`, while the CEX branch still calls `fetchBinancePrices()`. An isolated local run passed, but test determinism and runtime still depend on live Binance availability.
- Why it matters: external network in unit tests creates latent CI flakiness and makes failures harder to diagnose.
- Remediation: inject or mock the CEX price loader, or stub `global.fetch` in this suite so the CEX path is deterministic.

#### QLT-009 | Medium

- Location: `src/lib/__tests__/reserve-coinid-validation.test.ts:20-42`
- Problem: the test uses a hardcoded global threshold `warnings.length <= 12` for reserve-link warnings. The current dataset has already grown past that budget.
- Why it matters: this is brittle regression detection tied to dataset size, not to a specific defect. It currently breaks `npm test`.
- Remediation: replace the global ceiling with an explicit allowlist or snapshot of accepted warnings, or assert only on newly introduced unlinked reserve references.

#### QLT-010 | Medium

- Location: `src/components/contagion-graph.tsx:71-781`, `src/app/admin/client.tsx:128-778`; only related model coverage found in `src/lib/__tests__/status-dashboard-model.test.ts:1-184`
- Problem: these are large, stateful UI surfaces with hover, drag, keyboard, focus-mode, and incident rendering logic, but I found no direct component tests for them.
- Why it matters: model-level tests do not protect rendering, interaction, and focus-management regressions.
- Remediation: add React Testing Library coverage for graph focus/keyboard/drag behavior and the admin dashboard’s critical rendering and expansion flows.

### Sustainability and Maintainability

Core docs and CI are stronger than average for this repo size. The main maintainability issues are architectural dispersion, release/build coupling, limited coverage of existing guardrails, and a few persistent structural exceptions.

#### SUS-001 | High impact

- Scope: `src/lib/__tests__/reserve-coinid-validation.test.ts:20-42`, `shared/data/stablecoins/usd-minor.json:1916-1926`, `7038-7055`, `7129-7138`, `8112-8114`
- Issue: reserve metadata governance has drifted enough that the warning-budget test now fails. The dataset still contains reserve slices that reference tracked stablecoins or stablecoin baskets without stable `coinId` linkage.
- Long-term consequence: reserve methodology traceability becomes harder to maintain, data QA degrades into threshold tuning, and test failures stop distinguishing real regressions from backlog.
- Recommended remediation: replace the global warning budget with an explicit exception list, backfill missing `coinId`s where deterministic, and document justified unresolved cases in reserve methodology docs.

#### SUS-005 | High impact

- Scope: `scripts/sync-digests.ts:7-55`, `.github/workflows/pages-release.yml:16-19`, `.github/workflows/deploy-cloudflare.yml:78-95`
- Issue: Pages builds fetch digest data directly from the live production API (`https://api.pharos.watch/api/digest-archive`) during the build.
- Long-term consequence: releases are not reproducible from the repo state alone; frontend deploys can fail or produce different static artifacts depending on production API health and data timing.
- Recommended remediation: produce digest data as a CI artifact tied to the commit or environment under release, or build Pages against the just-deployed worker/environment instead of a hardcoded production endpoint.

#### SUS-002 | Medium impact

- Scope: `scripts/lib/hotspot-ratchet.mjs:5-12`
- Issue: the hotspot ratchet only guards four files: `worker/src/api/stablecoin-detail.ts`, `worker/src/api/feedback.ts`, `worker/src/handlers/http.ts`, and `worker/src/cron/sync-stablecoins.ts`.
- Long-term consequence: much larger files such as `src/app/methodology/sections/core-sections.tsx`, `src/app/coverage/client.tsx`, `worker/src/cron/daily-digest/collectors.ts`, `worker/src/cron/sync-fx-rates.ts`, and `worker/src/lib/status-evaluation.ts` can continue growing without any ratchet pressure.
- Recommended remediation: expand the target set to the current top hotspot files or generate the target list from a maintained baseline of the largest modules.

#### SUS-003 | Medium impact

- Scope: `worker/src/route-registry.ts:1-213`, `worker/src/router.ts:1-139`, `worker/src/handlers/http/context.ts:7-53`, `shared/lib/api-endpoints.ts:1-257`
- Issue: route metadata, dependency declarations, runtime wiring, and client-facing endpoint definitions are spread across four separate files.
- Long-term consequence: adding or changing an endpoint requires synchronized edits in multiple places, which raises drift risk and makes onboarding slower.
- Recommended remediation: move toward a single declarative route registry that co-locates path metadata, handler wiring, dependency requirements, and shared client definitions.

#### SUS-004 | Medium impact

- Scope: `scripts/test-merge-gate.mjs:88-128`, `.github/workflows/validate-ci.yml:23-40`
- Issue: the local merge gate runs a narrower command plan than CI validate. CI always runs `audit:deps`, worker-boundary checks, migrations, cron/doc sync, duplicate-export checks, unused-code checks, hotspot-ratchet, `npm test`, and coverage; the merge gate only runs a subset based on file heuristics.
- Long-term consequence: developers can get a green local gate while missing checks that mainline CI will enforce, increasing iteration latency and confidence gaps.
- Recommended remediation: make the local merge gate invoke the same canonical validate pipeline, or at minimum include all non-negotiable guardrails regardless of file classification.

#### SUS-006 | Medium impact

- Scope: `scripts/check-unused-code.mjs:10-25`, `27-35`, `65-85`
- Issue: the unused-code detector reports only modules under selected prefixes, and unused named exports under an even smaller prefix set.
- Long-term consequence: dead code can accumulate in uncovered areas such as many UI components, hooks, and cron modules while the repo still reports a clean unused-code pass.
- Recommended remediation: widen reportable prefixes to all runtime code, then manage intentional exceptions with allowlists instead of excluding entire categories.

#### SUS-009 | Medium impact

- Scope: `worker/src/cron/enrich-prices.ts:7`, `74-90`; `worker/src/cron/enrich-prices-passes.ts:21-24`; `worker/src/lib/authoritative-price-sources.ts:3`; `worker/src/cron/reserve-adapters/index.ts:1-79`; representative adapter `worker/src/cron/reserve-adapters/accountable.ts:1-3`
- Issue: an import-graph check (`npx madge --circular ...`) found 31 circular dependencies. At least one is a true runtime cycle between `enrich-prices.ts` and `enrich-prices-passes.ts`; the reserve-adapter barrel also creates a wide type/barrel cycle.
- Long-term consequence: cycles make module ownership opaque, complicate extraction/refactoring work, and increase the chance of accidental initialization-order bugs.
- Recommended remediation: move shared pipeline types/helpers into leaf modules, and invert pass registration so the orchestrator depends on passes without the passes importing back into the orchestrator.

#### SUS-007 | Low impact

- Scope: `worker/migrations/MANIFEST.md:61-84`, `scripts/check-worker-migrations.mjs:121-127`
- Issue: historical duplicate migration prefixes `0056` and `0061` are documented and suppressed.
- Long-term consequence: this does not break current replay validation, but it creates a permanent tooling exception and raises the cognitive load of migration review.
- Recommended remediation: keep the existing allowlist frozen, document clearly that no new duplicate prefixes are allowed, and preserve replay validation as the enforcement point.

#### SUS-008 | Low impact

- Scope: `package.json:58`, `76`, `80`; `worker/package.json:12-18`
- Issue: dependency health is generally good and `npm audit --omit=dev` is clean, but the manifest trails a few small patch releases (`next` `16.2.0 -> 16.2.1`, `eslint-config-next` `16.2.0 -> 16.2.1`, `tailwindcss` `4.2.1 -> 4.2.2`).
- Long-term consequence: low immediate risk, but patch lag reduces the margin for bugfix uptake and ecosystem alignment.
- Recommended remediation: batch these patch updates into the next routine dependency maintenance window.

## 3. Cross-Cutting Concerns

### CCG-001 — Status Reliability Is Concentrated in Large Coupled Modules

- References: `QLT-001`, `QLT-002`, `QLT-005`, `QLT-010`, `SUS-002`, `SUS-009`
- Why this is compound: the status subsystem has both correctness defects and maintainability pressure. False stale incidents, hidden persistence failures, and weak UI interaction coverage are all landing in modules that are already very large and mostly un-ratcheted.
- Priority: high, because fixing the correctness bugs without reducing module pressure will only slow the next round of maintenance.

### CCG-002 — Reserve Metadata Governance Has Shifted from Explicit Modeling to Threshold Management

- References: `SUS-001`, `QLT-009`, `RED-007`
- Why this is compound: missing reserve linkages are causing both sustainability debt and immediate test brittleness. The system currently uses a global warning budget instead of explicit exception management, while reserve-related normalization/utilities remain fragmented.
- Priority: high, because this is already breaking `npm test` and weakens methodology traceability.

### CCG-003 — Release Confidence Depends on Environment More Than Repo State

- References: `SUS-004`, `SUS-005`, `SUS-008`, `QLT-006`
- Why this is compound: Pages releases depend on production API state, the local merge gate is weaker than CI, and the admin proxy has weak timeout behavior. Together, these issues make build and operational behavior more environment-dependent than commit-dependent.
- Priority: high, because it affects release determinism and operator debugging.

### CCG-004 — API Surface Area Is Growing Without a Single Source of Truth

- References: `RED-003`, `RED-001`, `SUS-003`, `SUS-009`
- Why this is compound: slug routes, Telegram completion flows, route metadata, dependency injection, and parts of the worker import graph all show the same pattern: the same domain decisions are encoded in multiple places.
- Priority: medium-high, because duplication and architectural dispersion are reinforcing each other.

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `QLT-003` | Validate feedback secrets before rate limiting | `worker/src/api/feedback/request.ts` | Small | None |
| `QLT-006` | Add explicit upstream timeout and `504` mapping to the Pages admin proxy | `functions/api/admin/[[path]].ts` | Small | None |
| `QLT-007` | Fetch Binance prices once per run instead of per pending row | `worker/src/cron/confirm-pending-depegs.ts` | Small | None |
| `QLT-009`, `SUS-001` | Replace the reserve warning ceiling with an explicit allowlist and backfill obvious missing `coinId`s | `src/lib/__tests__/reserve-coinid-validation.test.ts`, `shared/data/stablecoins/usd-minor.json` | Small | None |
| `RED-003`, `RED-004`, `RED-006`, `RED-007`, `RED-008` | Remove straightforward UI/helper duplication | the affected route/components/worker utility files | Small | None |
| `SUS-008` | Apply safe patch-level dependency updates | `package.json`, lockfile | Small | None |

### Phase 2 — Targeted Refactoring

| Refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `RED-001` | Introduce Telegram completion handler registry shared by command and disambiguation paths | `worker/src/api/telegram-webhook.ts` | Medium | None |
| `RED-002`, `RED-005` | Extract shared liquidity and safety-score control primitives | `src/components/dex-liquidity-card.tsx`, `src/components/liquidity-stats.tsx`, `src/app/safety-scores/client.tsx` | Medium | None |
| `QLT-002`, `QLT-008`, `QLT-010` | Improve diagnostic quality and add deterministic UI/test coverage | `worker/src/lib/status-evaluation.ts`, `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`, `src/components/contagion-graph.tsx`, `src/app/admin/client.tsx` | Medium | None |
| `SUS-004`, `SUS-006` | Align local merge gate with CI and widen unused-code coverage | `scripts/test-merge-gate.mjs`, `scripts/check-unused-code.mjs` | Medium | None |

### Phase 3 — Structural Improvements

| Refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `QLT-001`, `QLT-005` | Rework status-state error modeling so telemetry failure and persistence failure are explicit degraded states | `worker/src/lib/status-evaluation.ts`, `worker/src/lib/status-reliability.ts`, related tests | Large | Phase 1 test stabilization helps |
| `QLT-004` | Split FX cooldown tracking into last-attempt and last-success semantics | `worker/src/cron/sync-fx-rates.ts` | Medium | None |
| `SUS-002` | Expand hotspot ratchet coverage to the current largest modules | `scripts/lib/hotspot-ratchet.mjs`, hotspot baseline | Medium | None |
| `SUS-003`, `SUS-009` | Consolidate route metadata/dependencies and break worker import cycles | `worker/src/route-registry.ts`, `worker/src/router.ts`, `worker/src/handlers/http/context.ts`, `shared/lib/api-endpoints.ts`, `worker/src/cron/enrich-prices*.ts`, `worker/src/cron/reserve-adapters/*` | Large | Best done after quick duplication cleanup |

### Phase 4 — Strategic Overhauls

| Refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `SUS-005` | Decouple Pages builds from the live production API and make digest data release-artifact based | `scripts/sync-digests.ts`, Pages workflows, release process docs | Large | None |
| `QLT-001`, `QLT-004`, `QLT-010`, `SUS-002`, `SUS-009` | Decompose the largest worker/frontend hotspot modules into smaller units with explicit test seams | status/fx worker modules, `src/app/admin/client.tsx`, `src/components/contagion-graph.tsx`, other ratcheted hotspot files | Large | Phase 3 architectural work should land first |

## 5. Appendices

### Appendix A — File-by-File Finding Index

| File / module | Findings |
| --- | --- |
| `.github/workflows/deploy-cloudflare.yml` | `SUS-005` |
| `.github/workflows/pages-release.yml` | `SUS-005` |
| `.github/workflows/validate-ci.yml` | `SUS-004` |
| `functions/api/admin/[[path]].ts` | `QLT-006` |
| `package.json` | `SUS-008` |
| `scripts/check-unused-code.mjs` | `SUS-006` |
| `scripts/check-worker-migrations.mjs` | `SUS-007` |
| `scripts/lib/hotspot-ratchet.mjs` | `SUS-002` |
| `scripts/sync-digests.ts` | `SUS-005` |
| `scripts/test-merge-gate.mjs` | `SUS-004` |
| `shared/data/stablecoins/usd-minor.json` | `SUS-001` |
| `shared/lib/api-endpoints.ts` | `SUS-003` |
| `src/app/admin/client.tsx` | `QLT-010` |
| `src/app/compare/[slug]/page.tsx` | `RED-003` |
| `src/app/safety-scores/client.tsx` | `RED-005` |
| `src/app/stability-index/client.tsx` | `RED-006` |
| `src/app/stablecoins/backing/[backing]/page.tsx` | `RED-003` |
| `src/app/stablecoins/governance/[governance]/page.tsx` | `RED-003` |
| `src/components/contagion-graph.tsx` | `QLT-010` |
| `src/components/daily-digest.tsx` | `RED-004` |
| `src/components/dex-liquidity-card.tsx` | `RED-002` |
| `src/components/liquidity-stats.tsx` | `RED-002` |
| `src/lib/__tests__/reserve-coinid-validation.test.ts` | `QLT-009`, `SUS-001` |
| `src/lib/__tests__/status-dashboard-model.test.ts` | `QLT-010` |
| `worker/migrations/MANIFEST.md` | `SUS-007` |
| `worker/package.json` | `SUS-008` |
| `worker/src/api/telegram-webhook.ts` | `RED-001` |
| `worker/src/api/feedback/request.ts` | `QLT-003` |
| `worker/src/cron/__tests__/confirm-pending-depegs.test.ts` | `QLT-008` |
| `worker/src/cron/confirm-pending-depegs.ts` | `QLT-007` |
| `worker/src/cron/enrich-prices-passes.ts` | `SUS-009` |
| `worker/src/cron/enrich-prices.ts` | `SUS-009` |
| `worker/src/cron/mint-burn/run-state.ts` | `RED-007` |
| `worker/src/cron/reserve-adapters/accountable.ts` | `SUS-009` |
| `worker/src/cron/reserve-adapters/index.ts` | `SUS-009` |
| `worker/src/cron/sync-fx-rates.ts` | `QLT-004`, `SUS-002` |
| `worker/src/handlers/http/context.ts` | `SUS-003` |
| `worker/src/lib/authoritative-price-sources.ts` | `SUS-009` |
| `worker/src/lib/cex-tickers.ts` | `QLT-007`, `QLT-008` |
| `worker/src/lib/fx-rate-state.ts` | `RED-007` |
| `worker/src/lib/og-templates/safety-scores-card.tsx` | `RED-008` |
| `worker/src/lib/price-validation.ts` | `RED-007` |
| `worker/src/lib/status-evaluation.ts` | `QLT-001`, `QLT-002`, `SUS-002` |
| `worker/src/lib/status-reliability.ts` | `QLT-005` |
| `worker/src/route-registry.ts` | `SUS-003` |
| `worker/src/router.ts` | `SUS-003` |

### Appendix B — Dependency Audit Summary

Manifest-level summary; local installed `node_modules` was behind the lockfile in a few places during the audit, but `npm ci --ignore-scripts --dry-run` succeeded, so lockfile integrity is intact and that drift is treated as workstation state rather than repo debt.

| Item | Current repo state | Latest / result | Assessment | Action |
| --- | --- | --- | --- | --- |
| Security audit | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities | Healthy | None |
| Lockfile integrity | `package-lock.json` | `npm ci --ignore-scripts --dry-run` succeeded | Healthy | None |
| `next` | `16.2.0` | `16.2.1` | Low patch lag | Update in next maintenance batch |
| `eslint-config-next` | `16.2.0` | `16.2.1` | Low patch lag | Update alongside `next` |
| `tailwindcss` | `4.2.1` | `4.2.2` | Low patch lag | Update in same batch |
| Redundant dependencies | none confirmed | none confirmed | Healthy | None |

### Appendix C — Glossary

- **Structural clone**: duplicated logic that is not text-identical but follows the same control flow and behavior with superficial naming/layout differences.
- **Dead shim**: a module or wrapper that still exists in the graph but adds no value beyond forwarding or preserving an obsolete interface.
- **SRP violation**: a Single Responsibility Principle violation; one unit is doing more than one reason-to-change.
- **Hotspot ratchet**: a guardrail that prevents already-large or complex files from growing further.
- **Hysteresis**: deliberate status-transition damping so a signal does not flap rapidly between states.
- **Circuit breaker**: a failure-tracking mechanism that temporarily suppresses retries to unstable upstreams.
- **Cached fallback**: serving stale-but-usable data while the primary live source is unavailable.
- **Barrel cycle**: a circular dependency introduced by importing through an index/barrel module that also imports its children.
- **Strict contract**: an API surface expected to preserve response shape/behavior closely enough to justify contract tests.
- **Idempotent admin action**: an operator-triggered action designed to be safe against duplicate submissions.
