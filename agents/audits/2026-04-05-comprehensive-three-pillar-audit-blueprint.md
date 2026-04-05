# Comprehensive Three-Pillar Audit Blueprint

Date: 2026-04-05
Repo: `/Users/ahirice/Documents/git/stablecoin-dashboard`
Scope: full application audit across redundancy elimination, code quality, and long-term sustainability/maintainability

This report consolidates:

- local inventory and validation work
- a parallel redundancy audit
- a parallel code-quality audit
- a parallel sustainability audit

## 1. Executive Summary

### Validation Baseline

Verified locally before finalizing the audit:

- Passed: `npm run lint`
- Passed: `npm run typecheck`
- Passed: `npm test`
- Passed: `npm run build`
- Passed: `cd worker && npx tsc --noEmit`
- Passed: `npm run audit:deps`
- Passed: `npm run check:unused-code`
- Passed: `npm run check:shared-cycles`
- Passed: `npm run check:worker-boundary`
- Passed: `npm run check:duplicate-exports`
- Passed: `npm run check:sql-safety`
- Passed: `npm run check:hotspot-ratchet`
- Passed: `npm run check:doc-sync`
- Passed: `npm run check:migrations`
- Passed: `npm run check:cron-sync`
- Passed: `npm run check:cron-connections`
- Passed: `npm run check:stablecoin-data`
- Passed: `npm run check:redemption-backstops`
- Passed: `npm run audit:pricing-providers`
- Failed: `npm run check:doc-counts`
  - Drift: `docs/live-reserves.md` and `docs/architecture.md` still say 32 live-reserve adapters; source now has 33

Dependency freshness checked against the registry:

- Root patch/minor lag: `next` `16.2.1 -> 16.2.2`, `eslint-config-next` `16.2.1 -> 16.2.2`, `@tanstack/react-query` `5.95.2 -> 5.96.2`, `@types/node` `25.5.0 -> 25.5.2`
- Worker patch/minor lag: `@cloudflare/workers-types` `4.20260329.1 -> 4.20260405.1`, `viem` `2.47.6 -> 2.47.10`, `wrangler` `4.78.0 -> 4.80.0`
- Major available but not urgent by default: `typescript` `5.9.3 -> 6.0.2`, `eslint` `9.39.4 -> 10.2.0`
- Security posture: `npm audit --audit-level=high --omit=dev` reported `0` production vulnerabilities

### Findings Count

| Pillar | Critical | High | Medium | Low | Total |
| --- | --- | --- | --- | --- | --- |
| Redundancy Elimination | 0 | 0 | 5 | 1 | 6 |
| Code Quality | 0 | 1 | 2 | 0 | 3 |
| Sustainability / Maintainability | 0 | 0 | 4 | 0 | 4 |
| Total | 0 | 1 | 11 | 1 | 13 |

### Top 5 Most Critical Findings

1. `Q1` High: `worker/src/lib/idempotency.ts:50-141` can leave admin idempotency reservations stuck in `PENDING` when action execution throws and cleanup delete also fails.
2. `S1` Medium: `docs/live-reserves.md:12` and `docs/architecture.md:483` are already out of sync with the live-reserve adapter registry, and `npm run check:doc-counts` currently fails because of it.
3. `Q2` Medium: the main Worker ingress branch logic in `worker/src/handlers/http/request-dispatch.ts:10-79`, `worker/src/handlers/http/request-source.ts:5-43`, and `worker/src/lib/request-source-attribution.ts:28-76` lacks direct branch-level tests.
4. `S4` Medium: `worker/src/route-registry.ts:83-335` and `worker/src/handlers/http/context.ts:11-71` form a large hand-maintained API assembly surface that will get harder to evolve as endpoints keep growing.
5. `R3` Medium: four chart surfaces repeat the same shell logic instead of reusing a common wrapper, increasing UI maintenance drift in `src/components/psi-history-chart.tsx:149-161`, `src/components/total-mcap-chart.tsx:22-37`, `src/components/non-usd-share-chart.tsx:55-60`, and `src/components/peg-diversity-chart.tsx:75-80`.

### Health Ratings

| Pillar | Score | Justification |
| --- | --- | --- |
| Redundancy Elimination | 7/10 | Shared primitives are generally strong, but a handful of duplicated UI shells and worker transforms still create avoidable drift surfaces. |
| Code Quality | 7/10 | The repo is green on lint/type/build/test and has strong API-level coverage, but a real idempotency failure mode and unpinned ingress branches remain. |
| Sustainability / Maintainability | 8/10 | CI, deployment, docs, and boundaries are unusually disciplined; the remaining debt is mostly glue-layer synchronization and central orchestration surfaces. |

### Technical Debt Profile

Estimated significant debt footprint: roughly 3-4% of the runtime/docs/ops surface.

The debt is concentrated in:

- Worker admin retry/idempotency behavior
- Worker ingress and request-attribution branch coverage
- docs/CI contract drift
- repeated chart and adapter scaffolding
- a few large manual orchestration seams

## 2. Findings by Pillar

### Pillar A: Redundancy Elimination

#### R1. Duplicate metric-tile primitive in status cards

- Severity: Medium
- Locations:
  - `src/components/status/d1-usage-card.tsx:23-38`
  - `src/components/status/liquidity-health.tsx:11-26`
  - existing consolidation target: `src/components/metric-stat-card.tsx:5-64`
- Description:
  - Two status cards define the same local `Metric` component shape instead of reusing the existing `MetricStatCard` primitive.
- Consolidation strategy:
  - Replace the local tiles with `MetricStatCard`, or add a very small `StatusMetricCard` wrapper if these cards need one shared variant.

#### R2. Repeated chart-shell scaffolding across major chart components

- Severity: Medium
- Locations:
  - `src/components/psi-history-chart.tsx:149-161`
  - `src/components/total-mcap-chart.tsx:22-37`
  - `src/components/non-usd-share-chart.tsx:55-60`
  - `src/components/peg-diversity-chart.tsx:75-80`
- Description:
  - The same animation gating, `CHART_DRAW_IN`/`CHART_NO_ANIM` switching, container sizing, and chart-shell loading behavior are reimplemented in multiple chart components.
- Consolidation strategy:
  - Extract a shared chart-shell hook or wrapper that owns animation toggling, sizing, and the card/skeleton shell, leaving series/tooltips to the leaf charts.

#### R3. Commodity price-history parsing duplicated in two API paths

- Severity: Medium
- Locations:
  - `worker/src/api/backfill-supply-history.ts:109-115`
  - `worker/src/api/stablecoin-detail/commodity.ts:50-60`
- Description:
  - Both code paths parse the same CoinGecko price payload shape, read the same `coingecko:${geckoId}` history key, and normalize the result into a timestamp-sorted series.
- Consolidation strategy:
  - Extract a shared `loadCoinGeckoPriceSeries()` helper for the Worker commodity-history surface.

#### R4. Reserve-adapter bucket-to-slice assembly is duplicated

- Severity: Medium
- Locations:
  - `worker/src/cron/reserve-adapters/ethena.ts:81-123`
  - `worker/src/cron/reserve-adapters/falcon.ts:137-180`
  - reusable target already exists nearby: `worker/src/cron/reserve-adapters/slice-math.ts:136-158`
- Description:
  - Both adapters do the same bucket-total to `slicesFromValues()` conversion and emit similar immediate-redeemable metadata, differing mostly in labels and bucket names.
- Consolidation strategy:
  - Add a small helper that takes bucket keys plus display metadata and returns the slice/metadata structure.

#### R5. Kraken and Bitstamp ticker reducers duplicate the same shape

- Severity: Medium
- Locations:
  - `worker/src/lib/cex-tickers.ts:100-135`
  - `worker/src/lib/cex-tickers.ts:138-172`
- Description:
  - Both fetchers iterate provider rows, resolve a symbol, derive midpoint-or-last price, and populate the same `Map<string, number>`.
- Consolidation strategy:
  - Extract a shared reducer helper that accepts normalized rows plus symbol and price callbacks.

#### R6. Null-guarded `formatCurrency(value, 1)` wrappers duplicated in two components

- Severity: Low
- Locations:
  - `src/components/status/discovery-candidates.tsx:12-15`
  - `src/components/stablecoin-detail/redemption-backstop-card.tsx:19-22`
- Description:
  - Both helpers do the same thing: return an em dash for `null`, otherwise call `formatCurrency(value, 1)`.
- Consolidation strategy:
  - Inline the call sites or add one small shared semantic helper if that formatting pattern should be canonical.

### Pillar B: Code Quality Improvement

#### Q1. Idempotency cleanup can strand a reservation in `PENDING`

- Severity: High
- Location:
  - `worker/src/lib/idempotency.ts`, `runIdempotentAdminAction`, `50-141`
- Description:
  - If `execute()` throws, the code tries to delete the pending reservation row. If that cleanup delete also fails, the code only logs a warning and the comment itself acknowledges the key may be stuck in `PENDING`.
- Why it matters:
  - The affected admin action becomes retry-hostile for the lifetime of the reservation row, which is the opposite of the contract idempotency is meant to provide.
- Remediation:
  - Make failure handling deterministic: either mark the row as a terminal failure state or guarantee pending reservations cannot survive a failed execution. Add explicit tests for `execute()` rejection and cleanup-delete failure.

#### Q2. Core request ingress lacks direct branch-level tests

- Severity: Medium
- Locations:
  - `worker/src/handlers/http/request-dispatch.ts`, `handleHttpRequestImpl`, `10-79`
  - `worker/src/handlers/http/request-source.ts`, `createRequestSourceRecorder`, `5-43`
  - `worker/src/lib/request-source-attribution.ts`, `recordWorkerRequestAttribution`, `28-76`
- Description:
  - The Worker front door handles preflight, maintenance mode, auth/access gating, cache reads, not-found handling, route dispatch, request-source attribution, and cache writeback, but those branches are only indirectly exercised today.
- Why it matters:
  - This is the highest-blast-radius request path in the Worker. A regression in auth, cache, or telemetry behavior can slip through without a branch-specific failure pointing to the cause.
- Remediation:
  - Add focused tests for preflight, maintenance, access-gate rejection, cache hit, route-not-found, normal dispatch, and request-source recorder branches for admin, site-api, and public-api traffic, plus attribution prune failure coverage.

#### Q3. Telegram bot status aggregation is monolithic and tightly coupled

- Severity: Medium
- Location:
  - `worker/src/lib/status/derived-data.ts`, `getTelegramBotStats`, `93-219`
- Description:
  - One helper owns the large aggregate SQL, type coercion, metric derivation, and API output shaping for Telegram status stats.
- Why it matters:
  - Metric changes become fragile because query logic and output mapping move together. That raises the cost of testing and makes future changes harder to reason about.
- Remediation:
  - Split the query into smaller metric groups, move SQL into named constants, and map each result set with smaller pure functions backed by focused tests.

### Pillar C: Sustainability and Maintainability

#### S1. Canonical docs are out of sync with the live-reserve registry

- Impact: Medium
- Locations:
  - `shared/lib/live-reserve-adapters.ts:255-556`
  - `worker/src/cron/reserve-adapters/index.ts:41-97`
  - `docs/live-reserves.md:12`
  - `docs/architecture.md:483`
- Description:
  - Source now defines 33 live-reserve adapters, but the main docs still say 32.
- Long-term consequence:
  - The docs stop being reliable onboarding and planning artifacts, and the repo already proves the drift by failing `npm run check:doc-counts`.
- Remediation:
  - Update the docs immediately and rerun `npm run check:doc-counts`. While touching the docs, spot-check other count-based claims that are not yet guardrailed.

#### S2. Validate-contract docs omit a CI-enforced step

- Impact: Medium
- Locations:
  - `scripts/lib/validate-contract.mjs:1-32`
  - `.github/workflows/validate-ci.yml:48-58`
  - `docs/deployment-process.md:56-79`
  - `docs/testing.md:195-199`
- Description:
  - The real validate contract and CI both run `npm run audit:pricing-providers`, but the human-facing validate descriptions omit it.
- Long-term consequence:
  - Contributors can believe they reproduced the full local/CI contract when they did not.
- Remediation:
  - Update the docs or derive the checklist text from `scripts/lib/validate-contract.mjs` so documentation cannot drift from the actual command plan.

#### S3. Workflow scaffolding is repeated across multiple YAML files

- Impact: Medium
- Locations:
  - `.github/workflows/validate-ci.yml:24-102`
  - `.github/workflows/pages-prepare.yml:20-97`
  - `.github/workflows/pages-publish.yml:15-57`
  - `.github/workflows/deploy-cloudflare.yml:14-260`
  - `.github/workflows/pages-release.yml:20-33`
  - `.github/workflows/rebuild-pages.yml:15-46`
- Description:
  - Checkout/setup/cache/npm-ci/smoke patterns are reused by copy rather than by a smaller shared unit.
- Long-term consequence:
  - Changes to Node versions, cache keys, environment wiring, or smoke behavior require coordinated YAML edits and create CI drift risk.
- Remediation:
  - Extract the shared setup/smoke scaffolding into a composite action or smaller reusable workflow, leaving the top-level workflows to coordinate only release orchestration.

#### S4. Route registry and dependency hydration form a large manual assembly surface

- Impact: Medium
- Locations:
  - `worker/src/route-registry.ts:83-335`
  - `worker/src/handlers/http/context.ts:11-71`
- Description:
  - The current route system is type-safe and coherent, but every endpoint change still touches a centralized registry and a separate dependency hydration table.
- Long-term consequence:
  - As the endpoint surface grows, central switchboard maintenance becomes the main scaling bottleneck for API evolution.
- Remediation:
  - Split route registration/hydration by domain or derive the hydration layer from endpoint metadata so endpoint families own smaller change surfaces.

## 3. Cross-Cutting Concerns

### C1. Docs and contract drift are recurring failure modes

- Connected findings: `S1`, `S2`
- Why this matters:
  - The repo has strong source-of-truth discipline, but count-based docs and command-list docs can still drift when they are manually repeated.
- Priority:
  - High leverage because the fix is small and the repo already has automation to catch part of the problem.

### C2. Central orchestration seams are healthy today but expensive to evolve

- Connected findings: `Q3`, `S3`, `S4`, `R2`
- Why this matters:
  - Routing, status aggregation, workflows, and chart shells are all coherent, but each is maintained as a broad manual assembly surface. That raises change friction more than defect count.
- Priority:
  - Strategic; best handled with targeted decomposition rather than rewrites.

### C3. High-blast-radius Worker entry/control paths still depend too much on indirect coverage

- Connected findings: `Q1`, `Q2`
- Why this matters:
  - The risk is concentrated in admin retry logic and the Worker front door, where small regressions can affect availability, auth, cache behavior, or telemetry.
- Priority:
  - Immediate, because the remediation is mostly tests plus one deterministic failure-handling change.

### C4. Last-mile duplication remains in places where drift is expensive

- Connected findings: `R1`, `R3`, `R4`, `R5`, `R6`
- Why this matters:
  - These are not giant clone swamps, but they live in UI shells and external-data adapters where consistency matters.
- Priority:
  - Medium; worth cleaning as opportunistic refactors or bundled improvements.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Ref | Action | Files / modules | Effort | Depends on |
| --- | --- | --- | --- | --- |
| S1 | Update live-reserve adapter counts and rerun `npm run check:doc-counts` | `docs/live-reserves.md`, `docs/architecture.md`, registry references in `shared/lib/live-reserve-adapters.ts` and `worker/src/cron/reserve-adapters/index.ts` | Small | None |
| S2 | Add `npm run audit:pricing-providers` to the documented validate contract | `docs/deployment-process.md`, `docs/testing.md`, `scripts/lib/validate-contract.mjs` | Small | None |
| Q2 | Add direct tests for ingress branches and request-source recorder behavior | `worker/src/handlers/http/request-dispatch.ts`, `worker/src/handlers/http/request-source.ts`, `worker/src/lib/request-source-attribution.ts` | Small | None |
| R1 | Replace local status-card metric tiles with `MetricStatCard` | `src/components/status/d1-usage-card.tsx`, `src/components/status/liquidity-health.tsx`, `src/components/metric-stat-card.tsx` | Small | None |
| R6 | Remove the duplicated null-guarded currency wrappers | `src/components/status/discovery-candidates.tsx`, `src/components/stablecoin-detail/redemption-backstop-card.tsx` | Small | None |

### Phase 2 - Targeted Refactoring

| Ref | Action | Files / modules | Effort | Depends on |
| --- | --- | --- | --- | --- |
| Q1 | Make idempotency cleanup deterministic and add explicit failure-path tests | `worker/src/lib/idempotency.ts`, `worker/src/lib/__tests__/idempotency.test.ts` | Medium | Q2-style test scaffolding helpful but not required |
| R3 | Extract a shared Worker helper for commodity CoinGecko price-series loading | `worker/src/api/backfill-supply-history.ts`, `worker/src/api/stablecoin-detail/commodity.ts` | Medium | None |
| R4 | Extract shared reserve-adapter bucket-to-slice assembly | `worker/src/cron/reserve-adapters/ethena.ts`, `worker/src/cron/reserve-adapters/falcon.ts`, `worker/src/cron/reserve-adapters/slice-math.ts` | Medium | None |
| R5 | Deduplicate Kraken/Bitstamp ticker reduction logic | `worker/src/lib/cex-tickers.ts` | Medium | None |
| Q3 | Split Telegram bot status aggregation into smaller query/mapping helpers | `worker/src/lib/status/derived-data.ts` | Medium | Add focused metric tests |

### Phase 3 - Structural Improvements

| Ref | Action | Files / modules | Effort | Depends on |
| --- | --- | --- | --- | --- |
| S3 | Extract common CI setup/smoke scaffolding into reusable workflow or composite action | `.github/workflows/validate-ci.yml`, `.github/workflows/pages-prepare.yml`, `.github/workflows/pages-publish.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`, `.github/workflows/deploy-cloudflare.yml` | Medium | Phase 1 doc cleanup recommended first to reduce review noise |
| S4 | Split route registration and dependency hydration by API family, or generate hydration from metadata | `worker/src/route-registry.ts`, `worker/src/handlers/http/context.ts`, adjacent endpoint metadata | Large | None |
| R2 | Introduce a shared chart shell for animation/container/loading behavior | `src/components/psi-history-chart.tsx`, `src/components/total-mcap-chart.tsx`, `src/components/non-usd-share-chart.tsx`, `src/components/peg-diversity-chart.tsx` | Medium | Best after chart primitive surface is stable |

### Phase 4 - Strategic Overhauls

No Phase 4 rewrites are justified right now.

The codebase does not need re-architecture-by-default. The right path is targeted decomposition of the central seams above, not a platform rewrite.

## 5. Appendices

### A. Complete File-by-File Finding Index

| File | Finding refs |
| --- | --- |
| `src/components/status/d1-usage-card.tsx` | `R1` |
| `src/components/status/liquidity-health.tsx` | `R1` |
| `src/components/metric-stat-card.tsx` | `R1` |
| `src/components/status/discovery-candidates.tsx` | `R6` |
| `src/components/stablecoin-detail/redemption-backstop-card.tsx` | `R6` |
| `src/components/psi-history-chart.tsx` | `R2` |
| `src/components/total-mcap-chart.tsx` | `R2` |
| `src/components/non-usd-share-chart.tsx` | `R2` |
| `src/components/peg-diversity-chart.tsx` | `R2` |
| `worker/src/api/backfill-supply-history.ts` | `R3` |
| `worker/src/api/stablecoin-detail/commodity.ts` | `R3` |
| `worker/src/cron/reserve-adapters/ethena.ts` | `R4` |
| `worker/src/cron/reserve-adapters/falcon.ts` | `R4` |
| `worker/src/cron/reserve-adapters/slice-math.ts` | `R4` |
| `worker/src/lib/cex-tickers.ts` | `R5` |
| `worker/src/lib/idempotency.ts` | `Q1` |
| `worker/src/handlers/http/request-dispatch.ts` | `Q2` |
| `worker/src/handlers/http/request-source.ts` | `Q2` |
| `worker/src/lib/request-source-attribution.ts` | `Q2` |
| `worker/src/lib/status/derived-data.ts` | `Q3` |
| `shared/lib/live-reserve-adapters.ts` | `S1` |
| `worker/src/cron/reserve-adapters/index.ts` | `S1` |
| `docs/live-reserves.md` | `S1` |
| `docs/architecture.md` | `S1` |
| `scripts/lib/validate-contract.mjs` | `S2` |
| `.github/workflows/validate-ci.yml` | `S2`, `S3` |
| `docs/deployment-process.md` | `S2` |
| `docs/testing.md` | `S2` |
| `.github/workflows/pages-prepare.yml` | `S3` |
| `.github/workflows/pages-publish.yml` | `S3` |
| `.github/workflows/deploy-cloudflare.yml` | `S3` |
| `.github/workflows/pages-release.yml` | `S3` |
| `.github/workflows/rebuild-pages.yml` | `S3` |
| `worker/src/route-registry.ts` | `S4` |
| `worker/src/handlers/http/context.ts` | `S4` |

### B. Dependency Audit Summary

| Surface | Result | Notes |
| --- | --- | --- |
| Production vulnerabilities | Healthy | `npm audit --audit-level=high --omit=dev` reported `0` vulnerabilities |
| Patch/minor currency | Slight lag | Several packages are one patch/minor behind, especially `next`, `eslint-config-next`, `@tanstack/react-query`, `wrangler`, `viem`, and `@cloudflare/workers-types` |
| Major-version pressure | Present but not urgent | `typescript` `6.0.2` and `eslint` `10.2.0` exist, but no evidence suggests a forced migration now |
| Lockfile integrity | Healthy | Single workspace lockfile is present and used by CI/cache |
| CI dependency checks | Healthy | Validate workflow runs `audit:deps`; scheduled dependency audit covers dev dependencies separately |

### C. Glossary

| Term | Meaning |
| --- | --- |
| Idempotency reservation | The row created before an admin action executes so retries with the same key can be replayed safely |
| Branch-level test | A test that intentionally exercises a specific control-flow path rather than only a broad integration outcome |
| Orchestration seam | A file or function that mostly coordinates other systems rather than owning one isolated rule |
| Clone pair | Two code blocks that are structurally the same with only superficial differences |
| Shared primitive | A reusable helper/component intended to be the canonical implementation of a repeated pattern |

