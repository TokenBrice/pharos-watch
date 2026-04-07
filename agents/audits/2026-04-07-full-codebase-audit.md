# Stablecoin Dashboard Audit

Date: 2026-04-07
Scope: `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, `docs/`, root/worker package manifests, Next/Worker config, and CI workflow surface.
Method: shared inventory pass, three parallel specialist agent reviews, local source verification, and repo-native validation commands.

Validation baseline:
- Passed: `npm run audit:deps`, `npm run lint`, `npm run typecheck`, `cd worker && npx tsc --noEmit`, `npm run build`, `npm test`, `npm run check:worker-boundary`, `npm run check:shared-cycles`, `npm run check:duplicate-exports`, `npm run check:unused-code`, `npm run check:migrations`, `npm run check:cron-sync`, `npm run check:cron-connections`, `npm run check:doc-sync`, `npm run check:verified-doc-links`, `npm run check:env-contract`, `npm run check:sql-safety`, `npm run audit:pricing-providers`.
- Current workspace warning: `npm run check:hotspot-ratchet` fails on `worker/src/cron/sync-stablecoins.ts` because the file is currently 224 lines versus a 222-line baseline and its max function is 196 lines versus a 194-line baseline. This is a real signal in the checked-out workspace, but it appears tied to in-progress local changes rather than a systemic repo-wide gate failure.

## 1. Executive Summary

Total findings: 17

- Redundancy: 6 findings
- Code quality: 5 findings
- Sustainability/maintainability: 6 findings

Severity / impact mix:

- Critical: 0
- High: 6
- Medium: 10
- Low: 1

Top 5 highest-priority findings:

1. `SUS-02` High: Worker route dependency hydration relies on a wide optional `FullRouteContext`, which weakens compile-time guarantees for route-specific requirements.
2. `R-001` High: Admin endpoints still use overlapping wrapper patterns (`withAdmin`, `makeAdminRoute`, `runAdminJob`, hand-rolled auth/JSON paths), creating inconsistent infrastructure around the most privileged surface.
3. `R-003` High: DEX-liquidity provider fetchers in `worker/src/cron/dex-liquidity/fetch-primary.ts` are still structural clones inside one of the repo’s largest operational hotspots.
4. `QA-001` High: `dispatch-telegram-alerts.ts` performs an N+1 D1 query loop when resolving depeg completions, which creates avoidable latency and scaling risk on a time-sensitive cron.
5. `R-004` High: Optional yield protocol adapters repeat the same fetch/validate/normalize/error skeleton, making the yield ingestion surface grow by copy pattern rather than composition.

Codebase health scores:

- Redundancy: 7/10
  The codebase is cleaner than average on dead code and duplicate exports, but a few concentrated hotspots still grow by repeated scaffolding patterns.
- Code quality: 8/10
  Build, lint, typecheck, and 4,005 tests all pass, but there are still several correctness-adjacent quality issues in cron orchestration, freshness reporting, and heavy route clients.
- Sustainability / maintainability: 7/10
  Guardrails are strong, but the long-term risk is concentrated in hotspot files, optional runtime context wiring, and a few stale architecture assumptions in docs and routing/config.

Estimated technical debt profile:

- Significant findings affect roughly 18-22% of the codebase by change surface.
- The debt is concentrated, not diffuse: mostly worker admin/cron infrastructure, yield and DEX-liquidity ingestion, large route clients, and the site-data lane/documentation boundary.

## 2. Findings by Pillar

### Redundancy Elimination

#### R-001 — Overlapping Admin Route Scaffolding
- Importance: High
- Locations: `worker/src/lib/route-wrappers.ts:11-47`; `worker/src/lib/admin-job.ts:25-79`; `worker/src/api/api-keys.ts:25-97`; `worker/src/api/api-key-audit-log.ts:29-76`; `worker/src/api/status.ts:20-116`; `worker/src/api/status-history.ts:31-66`; `worker/src/api/request-source-stats.ts:44-220`; `worker/src/api/backfill-dews.ts:23-186`; `worker/src/api/backfill-cg-prices.ts:25-189`; `worker/src/api/backfill-blacklist-current-balances.ts:24-157`; `worker/src/api/backfill-mint-burn-prices.ts:27-194`
- Issue: The privileged API surface still has at least three competing entry patterns: direct `withAdmin(...)`, route wrapper factories, and `runAdminJob(...)`, with some handlers also building their own parse/no-store/JSON flow.
- Why it matters: This duplicates auth and request-lifecycle concerns across the most sensitive surface in the system and makes later auth/idempotency/telemetry changes expensive.
- Consolidation strategy: Standardize on one admin route shell plus one reusable admin job helper, then migrate remaining inline handlers unless they have a proven special-case need.

#### R-002 — Duplicated Response Builder Utilities
- Importance: Medium
- Locations: `worker/src/lib/api-response.ts:20-53`; `worker/src/api/api-keys.ts:15-23`; `worker/src/api/admin-actions.ts:24-31`; `worker/src/lib/rate-limit.ts:44-59`; `worker/src/lib/api-key-rate-limit.ts:44-51`
- Issue: Shared response helpers exist, but multiple files still define local JSON/no-store/Retry-After builders.
- Why it matters: Header semantics drift easily when each privileged or rate-limited surface grows its own helper.
- Consolidation strategy: Expand the shared response helper set to cover status, no-store, and Retry-After cases, then delete file-local builders.

#### R-003 — Structural Clones in DEX-Liquidity Provider Fetchers
- Importance: High
- Locations: `worker/src/cron/dex-liquidity/fetch-primary.ts:390-492`; `worker/src/cron/dex-liquidity/fetch-primary.ts:494-589`; `worker/src/cron/dex-liquidity/fetch-primary.ts:691-749`; `worker/src/cron/dex-liquidity/fetch-primary.ts:751-798`
- Issue: `fetchUniV3Data` and `fetchAerodromeData` share the same subgraph loop/error/merge shape; `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` share the same token-batch/rate-limit/deadline/append-observation shape.
- Why it matters: Provider-family changes require parallel edits inside a hotspot that is already explicitly waived in the hotspot ratchet.
- Consolidation strategy: Finish the partially started extraction by introducing descriptor-driven runners for subgraph sources and token-batch sources.

#### R-004 — Repeated Optional Yield Adapter Skeletons
- Importance: High
- Locations: `worker/src/cron/yield-sync/sources-optional-protocols.ts:171-245`; `worker/src/cron/yield-sync/sources-optional-protocols.ts:247-314`; `worker/src/cron/yield-sync/sources-optional-protocols.ts:316-381`; `worker/src/cron/yield-sync/sources-optional-protocols.ts:383-428`; `worker/src/cron/yield-sync/sources-optional-protocols.ts:430-489`; `worker/src/cron/yield-sync/sources-optional-protocols.ts:491-566`; `worker/src/cron/yield-sync/sources-optional-protocols.ts:568-647`; `worker/src/cron/yield-sync/sources-optional-protocols.ts:649-716`
- Issue: Each optional protocol adapter repeats the same fetch, shape validation, candidate filtering, normalization, and abort/error handling pattern.
- Why it matters: This file keeps expanding by source-specific scaffolding instead of small source-specific parsers, which is exactly how hotspot files become permanent sinkholes.
- Consolidation strategy: Move common fetch/validate/normalize plumbing into a shared adapter harness and keep per-protocol code limited to extraction/mapping logic.

#### R-005 — Exact Duplicate Day Parsing
- Importance: Medium
- Locations: `worker/src/api/backfill-depegs-window.ts:19-31`; `worker/src/api/backfill-stability-index.ts:18-30`
- Issue: `parseDayParam` is duplicated verbatim.
- Why it matters: This is low-level date-window parsing in admin backfill code, where subtle drift is easy and expensive to debug later.
- Consolidation strategy: Reuse the existing helper from `backfill-depegs-window.ts` everywhere that accepts `startDay` / `endDay`.

#### R-006 — Repair Scripts Reimplement Worker Backfill Logic
- Importance: Medium
- Locations: `scripts/fix-commodity-depeg-median.ts:99-138`; `scripts/fix-commodity-depeg-median.ts:147-165`; `scripts/fix-commodity-depeg-median.ts:169-203`; `scripts/fix-non-usd-depeg-fx.ts:37-55`; `scripts/fix-non-usd-depeg-fx.ts:79-117`; `worker/src/api/backfill-fx.ts:251-313`; `worker/src/api/backfill-fx.ts:329-345`
- Issue: Checked-in operational repair scripts duplicate interpolation, peer-median, and D1 batch-execution logic that already exists in worker backfill flows.
- Why it matters: Emergency repair tooling becomes harder to trust when the checked-in maintenance scripts drift from the canonical runtime path.
- Consolidation strategy: Extract runtime-neutral helpers for interpolation and D1 bulk execution, or invoke the worker backfill modules directly from scripts where possible.

### Code Quality Improvement

#### QA-001 — N+1 D1 Query in Depeg Resolution Alerts
- Severity: High
- Location: `worker/src/cron/dispatch-telegram-alerts.ts:405-442` in `dispatchTelegramAlerts`
- Problem: Resolved-depeg handling loops `previousActiveIds` and executes `SELECT ... ORDER BY ended_at DESC LIMIT 1` once per stablecoin.
- Why it matters: A single burst of resolved depegs turns into N extra D1 round-trips inside a 5-minute alert cron, directly increasing latency and failure exposure on a user-facing notification path.
- Remediation: Fetch the latest resolved rows in one batched query keyed by the candidate IDs, or precompute the latest resolved event set before the loop.

#### QA-002 — Freshness Lookup Silently Masks D1 Failures
- Severity: Medium
- Location: `worker/src/lib/api-freshness.ts:160-175` in `getLatestSuccessfulCronTimestamp`; consumed by `worker/src/api/yield-history.ts:87` and `worker/src/api/mint-burn-flows.ts:264`
- Problem: A broad catch block swallows D1 errors and returns a caller fallback, which in some paths is effectively “now”.
- Why it matters: Freshness headers and `asOf` metadata can look current during a lookup failure, which hides degraded state instead of surfacing it.
- Remediation: Return an explicit degraded/null freshness result, log the lookup failure, and let callers emit a warning instead of silently minting a fresh timestamp.

#### QA-003 — Yield Publication Coordinator Still Does Too Much
- Severity: Medium
- Location: `worker/src/cron/sync-yield-data.ts:41-462` in `syncYieldData`
- Problem: One function loads state, resolves sources, evaluates quality, computes degradation reasons, preflights publishability, persists results, prunes history, and builds the final metadata envelope.
- Why it matters: The function is readable in pieces but still too large for easy reasoning about “retain vs prune”, “ok vs degraded”, and “masked failure vs true failure” transitions in a critical hourly pipeline.
- Remediation: Continue decomposing into pure decision stages around coverage policy, publishability, and persistence/cleanup policy.

#### QA-004 — Chain Route Recomputes the Same Derived Dataset Three Times
- Severity: Medium
- Location: `src/hooks/use-chains.ts:40-98` in `useChainStablecoins`; consumed at `src/app/chains/[chain]/client.tsx:286-289`, `src/app/chains/[chain]/client.tsx:487-490`, and `src/app/chains/[chain]/client.tsx:571-576`
- Problem: The chain detail route recomputes the same full stablecoin scan, totals, and sorted coin list for composition, backing breakdown, and the table.
- Why it matters: The route is already a declared hotspot, and this multiplies O(n) derivation work while spreading route-level domain logic across three child sections.
- Remediation: Derive the chain-level coin model once in the route client or a dedicated route view-model hook, then pass the memoized result to child sections.

#### QA-005 — No Direct Test Coverage for Yield Detail UI Shell
- Severity: Medium
- Location: `src/components/yield-detail-section.tsx:292-609`
- Problem: The component owns URL-persisted source selection, loading/error/null-state branching, chart prop selection, alternative-source rendering, and in-section scrolling, but there is no direct checked-in test for it.
- Why it matters: Backend yield coverage is strong, but this UI shell is still a meaningful integration surface on the stablecoin detail route.
- Remediation: Add direct component tests for loading, error, “expected but missing” states, source toggling and URL persistence, and alternative-source selection behavior.

### Sustainability and Maintainability

#### SUS-01 — Hotspot Program Exists, But the Backlog Is Large and Persistent
- Impact: High
- Scope: `scripts/lib/hotspot-ratchet-baseline.json:50-156`; `scripts/lib/hotspot-ratchet-waivers.json:1-85`
- Issue: The repo has a disciplined hotspot ratchet, but many important files remain explicitly deferred or queued, including `src/components/contagion-graph.tsx`, `src/app/chains/[chain]/client.tsx`, `src/app/methodology/sections/core/safety-scores-section.tsx`, `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`, `worker/src/cron/dex-liquidity/fetch-primary.ts`, `worker/src/cron/yield-sync/sources-optional-protocols.ts`, and `worker/src/cron/sync-yield-data.ts`.
- Long-term consequence: The ratchet prevents silent worsening, but it does not by itself shrink the risk. Those files remain the natural place for future features, so change velocity will continue to slow.
- Recommended remediation: Convert the hotspot list into an owned refactor program with explicit tranche planning and target budgets, rather than leaving it as a passive waiver ledger.

#### SUS-02 — Route Dependency Hydration Is Typed Broadly, Not Precisely
- Impact: High
- Scope: `worker/src/routes/shared.ts:13-83`; `worker/src/handlers/http/context.ts:6-26`; `worker/src/routes/dependency-hydrators.ts:9-49`; `shared/lib/api-endpoints/definitions.ts:41-42`
- Issue: Route handlers receive a `FullRouteContext` that is the union of many optional field bags. Hydrator keys are exhaustive, but handler-specific required dependencies are still optional at the type level.
- Long-term consequence: Missing dependency wiring becomes easier to detect only at runtime or integration time, especially as more route families are added.
- Recommended remediation: Move toward dependency-keyed handler context types or per-route context factories so handler requirements are represented as non-optional compile-time obligations.

#### SUS-03 — Site-Data Proxy Still Silently Falls Back to the Public API Lane
- Impact: Medium
- Scope: `functions/lib/site-api-env.ts:5-7`; `functions/lib/site-api-env.ts:38-43`; `functions/_site-data/[[path]].ts:125-149`; `worker/wrangler.toml:15-18`
- Issue: `SITE_API_ORIGIN` is optional and defaults back to `api.pharos.watch`, even though `site-api.pharos.watch` is already configured in the worker routes.
- Long-term consequence: A production misconfiguration can silently bypass the intended lane split, muddy request attribution, and make future public API auth tightening riskier.
- Recommended remediation: Require the dedicated site-data origin in production Pages environments and fail closed when it is missing.

#### SUS-04 — Architecture and API Docs Lag the Current Route/Layout Reality
- Impact: Medium
- Scope: `docs/architecture.md:9`; `docs/architecture.md:435`; `docs/api-reference.md:165`; `docs/api-reference.md:180`; `README.md:96`; actual code in `shared/lib/api-endpoints/index.ts:1`
- Issue: Verified docs still refer to `shared/lib/api-endpoints.ts` and still describe the dedicated `site-api` host as not yet fully provisioned, while the codebase has moved to a folderized `shared/lib/api-endpoints/` module and a configured `site-api.pharos.watch` lane.
- Long-term consequence: Onboarding, incident response, and architectural reviews start from stale mental models.
- Recommended remediation: Update the architecture doc, API reference, and README to match the folderized endpoint metadata surface and current lane topology.

#### SUS-05 — Cron Trigger Budgets Are Already Near the Connection Ceiling
- Impact: Medium
- Scope: `shared/lib/cron-jobs.ts:136`; `worker/src/handlers/scheduled/quarter-hourly.ts:1`; `worker/src/handlers/scheduled/half-hourly.ts:1`; `worker/src/handlers/scheduled/daily-0805.ts:1`; `docs/worker-and-api-limits.md:48`; `worker/wrangler.toml:21-35`
- Issue: The six-connection-per-trigger model is real, and the current validated budget is already tight: `quarterHourly` is `6/6`, `halfHourlyOffset` is `5/6`, and `fourHourlyYieldSupplemental` is `5/6`.
- Long-term consequence: New fetch-heavy work will increasingly force delicate sequencing, best-effort degradation, or trigger contention.
- Recommended remediation: Treat any new network-heavy feature as trigger-isolation work first; do not append it to already saturated shared lanes without explicit rebudgeting.

#### SUS-06 — Dependency Health Is Good, But Refresh Cadence Is Drifting
- Impact: Low
- Scope: `package.json`; `worker/package.json`; `package-lock.json`
- Issue: `npm audit --omit=dev` is clean, but `npm outdated` shows routine lag on root and worker packages including `next`, `eslint-config-next`, `@tanstack/react-query`, `vitest`, `wrangler`, `viem`, and `@cloudflare/workers-types`.
- Long-term consequence: Small drifts compound into larger upgrade batches, especially around framework/tooling pairs like Next and ESLint or Wrangler and Workers types.
- Recommended remediation: Adopt a lightweight dependency refresh cadence, starting with lockstep framework/tooling pairs. Do this from a clean install state so local invalid-package drift does not get mistaken for repo intent.

## 3. Cross-Cutting Concerns

### C-001 — Admin Control Surface Is Growing Through Multiple Patterns
- Connected findings: `R-001`, `R-002`, `SUS-02`
- Compound issue: The worker has good route metadata centralization, but the admin surface still mixes multiple wrapper styles and broad optional context hydration.
- Why this matters: Privileged routes are where consistency matters most. The current design works, but every new admin endpoint increases the chance of auth, idempotency, telemetry, or response-shape drift.
- Priority: High

### C-002 — Yield Intelligence Is Expanding by Accretion
- Connected findings: `R-004`, `QA-003`, `QA-005`, `SUS-01`
- Compound issue: Optional protocol adapters repeat the same skeleton, the publication coordinator remains large, the UI shell lacks direct tests, and the hotspot program already tracks yield files as deferred.
- Why this matters: Yield is one of the repo’s richest cross-surface features, touching cron ingestion, ranking logic, caches, and detail-page UI. Continued accretion will raise both regression cost and review cost.
- Priority: High

### C-003 — DEX-Liquidity Growth Is Fighting Both Duplication and Runtime Budgets
- Connected findings: `R-003`, `SUS-05`, `SUS-01`
- Compound issue: Provider fetchers are duplicated inside a known hotspot, while the scheduler already runs close to its connection ceiling.
- Why this matters: This is not just a readability problem. It directly affects how safely new providers or fallback paths can be added.
- Priority: High

### C-004 — Chain Detail UI Hotspot Includes Repeated Computation
- Connected findings: `QA-004`, `SUS-01`
- Compound issue: The chain detail route is explicitly on the hotspot backlog and still recomputes the same dataset three times per render path.
- Why this matters: This is a concentrated example of structural and runtime inefficiency reinforcing each other in a high-visibility route.
- Priority: Medium

### C-005 — Site/API Lane Split Is Strong in Concept but Incomplete in Runtime and Docs
- Connected findings: `SUS-03`, `SUS-04`
- Compound issue: The system intends a strict split between public API and site-internal reads, but the runtime still accepts a silent fallback and the docs still describe the old topology.
- Why this matters: Operational and onboarding clarity drift together when runtime behavior and docs stop describing the same architecture.
- Priority: Medium

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R-005` | Delete the duplicate `parseDayParam` and import the shared helper. | `worker/src/api/backfill-stability-index.ts`, `worker/src/api/backfill-depegs-window.ts` | Small | None |
| `R-002` | Replace file-local JSON / Retry-After builders with shared response helpers. | `worker/src/lib/api-response.ts`, `worker/src/api/api-keys.ts`, `worker/src/api/admin-actions.ts`, `worker/src/lib/rate-limit.ts`, `worker/src/lib/api-key-rate-limit.ts` | Small | None |
| `QA-001` | Batch the resolved-depeg lookup instead of querying once per coin. | `worker/src/cron/dispatch-telegram-alerts.ts` | Small | None |
| `QA-002` | Stop swallowing freshness lookup failures as “fresh now”. | `worker/src/lib/api-freshness.ts`, `worker/src/api/yield-history.ts`, `worker/src/api/mint-burn-flows.ts` | Small | None |
| `QA-005` | Add direct tests for the yield detail UI shell. | `src/components/yield-detail-section.tsx`, new tests in `src/components/__tests__/` | Small | None |
| `SUS-04` | Refresh docs to match the folderized endpoint metadata surface and live `site-api` lane. | `docs/architecture.md`, `docs/api-reference.md`, `README.md` | Small | None |
| Workspace signal | Bring `worker/src/cron/sync-stablecoins.ts` back under hotspot budget or intentionally rebaseline only with matching decomposition notes. | `worker/src/cron/sync-stablecoins.ts`, `scripts/lib/hotspot-ratchet-baseline.json` | Small | Prefer after current local WIP stabilizes |

### Phase 2 — Targeted Refactoring

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R-001` | Standardize privileged handlers on one admin route shell and one admin-job helper. | `worker/src/lib/route-wrappers.ts`, `worker/src/lib/admin-job.ts`, `worker/src/api/status.ts`, `worker/src/api/request-source-stats.ts`, `worker/src/api/backfill-*.ts`, other admin handlers | Medium | Phase 1 response-helper cleanup helps |
| `QA-004` | Build a single chain-route view model and pass it down instead of recomputing three times. | `src/hooks/use-chains.ts`, `src/app/chains/[chain]/client.tsx` | Medium | None |
| `R-006` | Extract runtime-neutral repair helpers or reuse worker backfill modules from scripts. | `scripts/fix-commodity-depeg-median.ts`, `scripts/fix-non-usd-depeg-fx.ts`, `worker/src/api/backfill-fx.ts` | Medium | None |
| `SUS-06` | Refresh routine dependencies in bounded batches from a clean install state. | `package.json`, `worker/package.json`, lockfile / workspace install state | Medium | Prefer after current local install is realigned |

### Phase 3 — Structural Improvements

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R-003` | Introduce provider-family runners for DEX-liquidity subgraph and token-batch sources. | `worker/src/cron/dex-liquidity/fetch-primary.ts` and related helpers | Large | None |
| `R-004` | Replace full custom optional-yield adapters with a shared adapter harness plus small source parsers. | `worker/src/cron/yield-sync/sources-optional-protocols.ts` | Large | None |
| `QA-003` | Split yield publication into smaller pure phases around policy, preflight, and persistence. | `worker/src/cron/sync-yield-data.ts`, adjacent helpers | Large | `R-004` helps but is not strictly required |
| `SUS-02` | Make route dependency requirements compile-time precise instead of optional field bags. | `worker/src/routes/shared.ts`, `worker/src/routes/dependency-hydrators.ts`, `worker/src/handlers/http/context.ts`, route handler signatures | Large | `R-001` will reduce migration churn |
| `SUS-03` | Enforce a dedicated `SITE_API_ORIGIN` in production Pages environments and remove silent public fallback. | `functions/lib/site-api-env.ts`, `functions/_site-data/[[path]].ts`, Pages env config/docs | Medium | `SUS-04` docs refresh should land alongside it |
| `SUS-05` | Rebudget future cron additions around saturated trigger lanes. | `shared/lib/cron-jobs.ts`, scheduled handlers, worker docs | Large | Best tackled whenever adding new fetch-heavy features |

### Phase 4 — Strategic Overhauls

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `SUS-01` | Run a managed hotspot reduction program with explicit owners and budgets. First tranche candidates: `src/app/chains/[chain]/client.tsx`, `src/components/contagion-graph.tsx`, `src/app/methodology/sections/core/safety-scores-section.tsx`, `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`, `worker/src/cron/dex-liquidity/fetch-primary.ts`, `worker/src/cron/yield-sync/sources-optional-protocols.ts`, `worker/src/cron/sync-yield-data.ts`. | Cross-cutting frontend and worker hotspots | Large | Phases 2 and 3 should reduce the first-wave blast radius |

## 5. Appendices

### Appendix A — File-by-File Finding Index

- `worker/src/lib/route-wrappers.ts`: `R-001`
- `worker/src/lib/admin-job.ts`: `R-001`
- `worker/src/api/api-keys.ts`: `R-001`, `R-002`
- `worker/src/api/api-key-audit-log.ts`: `R-001`
- `worker/src/api/status.ts`: `R-001`
- `worker/src/api/status-history.ts`: `R-001`
- `worker/src/api/request-source-stats.ts`: `R-001`
- `worker/src/api/backfill-dews.ts`: `R-001`
- `worker/src/api/backfill-cg-prices.ts`: `R-001`
- `worker/src/api/backfill-blacklist-current-balances.ts`: `R-001`
- `worker/src/api/backfill-mint-burn-prices.ts`: `R-001`
- `worker/src/lib/api-response.ts`: `R-002`
- `worker/src/api/admin-actions.ts`: `R-002`
- `worker/src/lib/rate-limit.ts`: `R-002`
- `worker/src/lib/api-key-rate-limit.ts`: `R-002`
- `worker/src/cron/dex-liquidity/fetch-primary.ts`: `R-003`, `SUS-01`
- `worker/src/cron/yield-sync/sources-optional-protocols.ts`: `R-004`, `SUS-01`
- `worker/src/api/backfill-depegs-window.ts`: `R-005`
- `worker/src/api/backfill-stability-index.ts`: `R-005`
- `scripts/fix-commodity-depeg-median.ts`: `R-006`
- `scripts/fix-non-usd-depeg-fx.ts`: `R-006`
- `worker/src/api/backfill-fx.ts`: `R-006`
- `worker/src/cron/dispatch-telegram-alerts.ts`: `QA-001`
- `worker/src/lib/api-freshness.ts`: `QA-002`
- `worker/src/api/yield-history.ts`: `QA-002`
- `worker/src/api/mint-burn-flows.ts`: `QA-002`
- `worker/src/cron/sync-yield-data.ts`: `QA-003`, `SUS-01`
- `src/hooks/use-chains.ts`: `QA-004`
- `src/app/chains/[chain]/client.tsx`: `QA-004`, `SUS-01`
- `src/components/yield-detail-section.tsx`: `QA-005`
- `worker/src/routes/shared.ts`: `SUS-02`
- `worker/src/routes/dependency-hydrators.ts`: `SUS-02`
- `worker/src/handlers/http/context.ts`: `SUS-02`
- `shared/lib/api-endpoints/definitions.ts`: `SUS-02`
- `functions/lib/site-api-env.ts`: `SUS-03`
- `functions/_site-data/[[path]].ts`: `SUS-03`
- `worker/wrangler.toml`: `SUS-03`, `SUS-05`
- `docs/architecture.md`: `SUS-04`
- `docs/api-reference.md`: `SUS-04`
- `README.md`: `SUS-04`
- `shared/lib/cron-jobs.ts`: `SUS-05`
- `worker/src/handlers/scheduled/quarter-hourly.ts`: `SUS-05`
- `worker/src/handlers/scheduled/half-hourly.ts`: `SUS-05`
- `worker/src/handlers/scheduled/daily-0805.ts`: `SUS-05`
- `docs/worker-and-api-limits.md`: `SUS-05`
- `package.json`: `SUS-06`
- `worker/package.json`: `SUS-06`
- `package-lock.json`: `SUS-06`
- `scripts/lib/hotspot-ratchet-baseline.json`: `SUS-01`
- `scripts/lib/hotspot-ratchet-waivers.json`: `SUS-01`

### Appendix B — Dependency Audit Summary

| Check | Result | Notes |
| --- | --- | --- |
| `npm run audit:deps` | Pass | `0` production vulnerabilities |
| `npm outdated` | Low-impact drift | Minor or patch lag on `next`, `eslint-config-next`, `@tanstack/react-query`, `vitest`, `wrangler`, `viem`, `@cloudflare/workers-types` |
| `npm ls` (current workspace) | Local install drift present | Installed root packages lag declared versions for `next`, `eslint-config-next`, `@tanstack/react-query`; worker install lags declared `wrangler` and `@cloudflare/workers-types`. This is a workspace-state issue, not necessarily a committed repo defect. |
| Dependency duplication | No high-confidence finding | No redundant third-party dependency finding survived validation; the bigger issue is hotspot architecture, not library sprawl |

### Appendix C — Glossary

- Structural clone: Two code paths with the same logic shape but different names or small source-specific details.
- Hotspot ratchet: A guardrail that tracks oversized files/functions and fails when they regress further without explicit acknowledgement.
- N+1 query: A pattern where one initial decision causes one database query per item, instead of one batched query.
- Idempotency: A property where repeating the same request safely replays or no-ops instead of causing duplicate side effects.
- D1: Cloudflare’s SQLite-backed serverless database.
- Route dependency hydrator: The code that attaches environment-dependent fields to route context before a handler runs.
- Connection budget: The repo-enforced assumption that each cron trigger effectively shares a limited outbound connection pool.
- Degraded result: A deliberately partial or guarded response/run that preserves availability while surfacing loss of confidence or completeness.
