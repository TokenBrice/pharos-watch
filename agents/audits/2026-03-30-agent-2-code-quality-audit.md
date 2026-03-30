# Agent 2 Audit: Code Quality

Date: 2026-03-30
Scope: full repository audit of `src/`, `shared/`, `worker/`, `functions/`, and `scripts/`
Auditor: Agent 2, Code Quality

## Scope And Method

This audit covered the entire tracked codebase. I built an inventory first, then reviewed the main runtime surfaces, cron pipelines, shared libraries, Pages Functions, scripts, and test suites. I also cross-checked the code against the repo guardrails and validation scripts.

Validation snapshot:

- `npm run typecheck`: passed
- `cd worker && npx tsc --noEmit`: passed
- `npm run lint`: passed with 2 warnings in `scripts/check-stablecoin-data.ts`
- `npm test`: passed (`364` files, `3552` tests)
- `npm run check:unused-code`: passed
- `npm run check:shared-cycles`: passed
- `npm run check:duplicate-exports`: passed
- `npm run check:hotspot-ratchet`: passed
- `npm run check:sql-safety`: passed
- `npm audit --omit=dev`: no production vulnerabilities

Inventory summary:

- Stack: Next.js 16 static export, Cloudflare Pages Functions, Cloudflare Worker + D1, TypeScript, Zod, Vitest, TanStack Query
- Major code areas: `src/` frontend routes/components/hooks, `shared/` runtime-neutral logic/data/types, `worker/` API + cron + runtime libraries, `functions/` Pages proxy/admin routes, `scripts/` repo validation and operational tooling
- Quality hotspots remain concentrated in worker cron orchestration and cache-boundary code rather than the frontend route layer

## Findings

### High

#### CQ-01: Stablecoins price-staleness guard fails open when the previous cache is malformed

- Severity: High
- Location:
  - `worker/src/cron/sync-stablecoins/stages.ts`, `detectPriceStaleness()`, lines `306-318`
  - `worker/src/cron/sync-stablecoins/runtime.ts`, `checkStablecoinsPriceStaleness()`, lines `107-159`
  - Related duplicate parser: `worker/src/cron/sync-stablecoins/shared.ts`, `loadPreviousStablecoinsById()`, lines `214-224`
  - Existing strict parser not reused: `worker/src/lib/stablecoins-cache.ts`, `loadStablecoinsCache()`, lines `156-180`
- Problem:
  - `detectPriceStaleness()` parses `previousCache.value` with a raw `JSON.parse(...) as { peggedAssets?: PeggedAsset[] }`.
  - `checkStablecoinsPriceStaleness()` catches parse failures, logs a warning, and then returns without blocking the write.
  - A corrupt or shape-drifted previous cache therefore disables the severe-staleness guard entirely instead of failing closed or surfacing a stronger degraded status.
- Why it matters:
  - This guard exists specifically to stop obviously stale price sets from replacing a healthier cache. The current behavior bypasses that protection in exactly the scenario where cached state is already inconsistent.
- Remediation:
  - Replace the raw parse path with `loadStablecoinsCache(db, { mode: "strict" })` or a dedicated shared decoder.
  - Treat malformed previous-cache state as a degraded, write-blocking condition for the staleness gate.
  - Remove the duplicated ad hoc cache parsing in `shared.ts` so all callers share one interpretation of stablecoin cache shape.

#### CQ-02: Yield publication guards also fail open on malformed previous rankings snapshots

- Severity: High
- Location:
  - `worker/src/cron/sync-yield-data.ts`, lines `523-534`
  - `worker/src/cron/yield-sync/publication.ts`, `validateYieldRankingsPayloadForPublish()`, lines `150-190`
  - Similar recurrence: `worker/src/cron/yield-coverage-audit.ts`, lines `166-179`
  - Tests currently codify the permissive behavior: `worker/src/cron/__tests__/sync-yield-data.test.ts`, lines `1365-1413`
- Problem:
  - Both the cron preflight path and the publish-validation helper parse the prior `yield-rankings` cache with raw `JSON.parse(...)`.
  - When parsing fails, they reset the previous rankings count to `0`, which disables the shrinkage/publish-regression guard.
- Why it matters:
  - A malformed rankings cache should be treated as an integrity problem. Instead, the code drops the baseline and permits publication using incomplete context, which undermines the very regression guard meant to prevent bad writes.
- Remediation:
  - Introduce one shared parser for the rankings snapshot shape and reuse it in the cron, publish helper, and audit code.
  - On malformed previous rankings, return a degraded no-write result instead of treating the baseline as zero.
  - Update tests so malformed previous-cache input is asserted as a blocking/degraded condition, not a permissive one.

### Medium

#### CQ-03: `daily-digest/collectors.ts` is still a monolithic collector family with repeated local parse/degrade logic

- Severity: Medium
- Location:
  - `worker/src/cron/daily-digest/collectors.ts`, `collectDewsStress()`, lines `416-535`
  - `worker/src/cron/daily-digest/collectors.ts`, `collectPsiContributors()`, lines `542-570`
  - `worker/src/cron/daily-digest/collectors.ts`, `collectYieldAnomalies()`, lines `780-829`
  - `worker/src/cron/daily-digest/collectors.ts`, `collectLiquidityShifts()`, lines `836-893`
  - `worker/src/cron/daily-digest/collectors.ts`, `collectCrossDayTrends()`, lines `900-954`
  - Hotspot budget reference: `scripts/lib/hotspot-ratchet-baseline.json`, lines `122-129`
- Problem:
  - The module remains ~955 lines with 85 branches and multiple collectors each performing their own JSON parsing, degradation tagging, and result shaping.
  - Similar failure modes are handled differently in different collectors.
- Why it matters:
  - This raises regression risk whenever the digest input schema changes and makes the module expensive to test thoroughly. The problem is not style; it is the concentration of unrelated failure semantics into one file.
- Remediation:
  - Split the collectors by domain (`dews`, `psi`, `yield`, `liquidity`, `history`).
  - Move JSON decoding and degradation helpers into typed shared functions so malformed stored payloads are handled consistently.
  - Add direct unit tests per collector module instead of one broad integration-oriented suite.

#### CQ-04: `yield-sync/sources.ts` still mixes several source families and fallback strategies in one hotspot module

- Severity: Medium
- Location:
  - `worker/src/cron/yield-sync/sources.ts`, `loadDlStablecoinPools()`, lines `133-234`
  - `worker/src/cron/yield-sync/sources.ts`, `fetchOnChainRates()`, lines `352-425`
  - `worker/src/cron/yield-sync/sources.ts`, `fetchCompoundV3SupplyRates()`, lines `439-549`
  - `worker/src/cron/yield-sync/sources.ts`, `fetchAaveV3SupplyRates()`, lines `628-763`
  - `worker/src/cron/yield-sync/sources.ts`, lines `133-803` overall
  - Hotspot budget reference: `scripts/lib/hotspot-ratchet-baseline.json`, lines `178-185`
- Problem:
  - One module owns DefiLlama ingestion, on-chain rate fetches, optional RPC telemetry, Compound V3 handling, Aave handling, and benchmark loading.
- Why it matters:
  - New source additions or source-policy changes touch a large branch-heavy surface, increasing the chance of cross-source regressions and weakening test isolation.
- Remediation:
  - Split by source family with a shared result envelope.
  - Move RPC fallback policy and optional-source telemetry into dedicated helpers or manifests so the source adapters remain focused on data acquisition.

#### CQ-05: `syncBlacklist()` still centralizes crawl orchestration, normalization, persistence, and budget control in one function

- Severity: Medium
- Location:
  - `worker/src/cron/sync-blacklist.ts`, `syncBlacklist()`, lines `70-415`
  - Hotspot budget reference: `scripts/lib/hotspot-ratchet-baseline.json`, lines `162-168`
- Problem:
  - The main cron function still owns source iteration, family-specific branching, balance hydration, persistence, counters, and final metadata assembly.
- Why it matters:
  - This makes correctness changes harder to reason about because provider behavior, pacing policy, and write semantics all live in one scope.
- Remediation:
  - Split the entrypoint into distinct orchestration, source-family normalization, and persistence/result-summary helpers.
  - Keep the top-level cron function limited to phase order, abort/deadline policy, and final status shaping.

#### CQ-06: `syncFxRates()` still combines source arbitration, fallback policy, and persistence in one path

- Severity: Medium
- Location:
  - `worker/src/cron/sync-fx-rates.ts`, `syncFxRates()`, lines `163-350`
  - Hotspot budget reference: `scripts/lib/hotspot-ratchet-baseline.json`, lines `170-176`
- Problem:
  - The cron still coordinates source loading, tertiary fallback selection, historical comparisons, persistence, and notification/error handling in one function.
- Why it matters:
  - The function is not broken, but it is dense enough that edge-case work on one provider can accidentally change the global fallback contract.
- Remediation:
  - Extract source selection, persistence, and alert/result formatting into separate helpers.
  - Keep the cron shell focused on phase sequencing and result aggregation.

#### CQ-07: Public API rate limiting intentionally fails open on D1 errors

- Severity: Medium
- Location:
  - `worker/src/lib/rate-limit.ts`, `checkPublicApiRateLimit()`, lines `71-122`
  - `worker/src/handlers/http/gates.ts`, lines `44-59`
- Problem:
  - Missing `PUBLIC_API_RATE_LIMIT_SALT` blocks requests with `503`, but runtime D1 failures during rate-limit writes are logged and then the request is allowed through.
- Why it matters:
  - This is an explicit availability tradeoff, not an accidental bug. The quality concern is that abuse protection disappears exactly during storage degradation, when the system is already under stress.
- Remediation:
  - Decide whether the intended policy is fail-open or fail-closed under D1 outage.
  - If fail-open stays intentional, surface it as a documented operational risk and emit a stronger degraded status/metric when it occurs.

#### CQ-08: Heavy malformed-JSON branches in daily-digest collectors are under-tested

- Severity: Medium
- Location:
  - Code paths:
    - `worker/src/cron/daily-digest/collectors.ts`, lines `477-487`
    - `worker/src/cron/daily-digest/collectors.ts`, lines `501-511`
    - `worker/src/cron/daily-digest/collectors.ts`, lines `551-567`
    - `worker/src/cron/daily-digest/collectors.ts`, lines `801-806`
    - `worker/src/cron/daily-digest/collectors.ts`, lines `923-938`
  - Existing tests mostly cover happy-path shaping:
    - `worker/src/cron/__tests__/daily-digest.test.ts`, lines `949-1004`
    - `worker/src/cron/__tests__/daily-digest.test.ts`, lines `1018-1105`
    - `worker/src/cron/__tests__/daily-digest.test.ts`, lines `1185-1292`
    - `worker/src/cron/__tests__/daily-digest.test.ts`, lines `1306-1365`
- Problem:
  - The collector suite covers representative outputs, but not several malformed stored-payload branches that currently rely on local degrade-and-continue handling.
- Why it matters:
  - These are exactly the branches that protect the daily digest from partial data corruption, so missing direct tests leaves important graceful-degradation behavior largely unpinned.
- Remediation:
  - Add focused tests that inject malformed `signals_json`, malformed `input_snapshot`, and malformed `warning_signals`.
  - Assert both output degradation and the recorded degraded-reason behavior, not just returned data.

#### CQ-09: The critical publish/staleness guard helpers lack direct edge-case tests

- Severity: Medium
- Location:
  - Guard code:
    - `worker/src/cron/yield-sync/publication.ts`, `validateYieldRankingsPayloadForPublish()`, lines `150-190`
    - `worker/src/cron/sync-stablecoins/runtime.ts`, `checkStablecoinsPriceStaleness()`, lines `107-159`
    - `worker/src/cron/sync-stablecoins/stages.ts`, `detectPriceStaleness()`, lines `306-318`
  - Current tests:
    - `worker/src/cron/__tests__/yield-publication.test.ts`, lines `152-239` only cover payload construction, not publish validation
    - `worker/src/cron/__tests__/sync-yield-data.test.ts`, lines `1479-1505` mock `validateYieldRankingsPayloadForPublish()` instead of exercising it
    - `worker/src/cron/__tests__/sync-stablecoins.test.ts`, lines `1217-1275` cover healthy previous-cache staleness detection only
- Problem:
  - The most important guard helpers around corrupt prior state are either untested directly or only covered through happy-path integration behavior.
- Why it matters:
  - That is how permissive malformed-cache behavior in CQ-01 and CQ-02 survived: the tests do not pin the intended failure contract at the helper boundary.
- Remediation:
  - Add direct unit tests for malformed, missing-field, and legacy-shape previous caches.
  - Assert whether the correct behavior is “block write,” “degraded no-write,” or “warn and continue,” and make the tests enforce it.

### Low

#### CQ-10: `handleDiscoveryCandidates()` uses a double assertion that can silently coerce unexpected count results to zero

- Severity: Low
- Location:
  - `worker/src/api/discovery.ts`, lines `52-66`
- Problem:
  - `COUNT(*)` is read via `((countResult.results?.[0] as Record<string, unknown>)?.total as number) ?? 0`.
  - If the result shape drifts, the handler falls back to `0` instead of failing loudly or validating the shape.
- Why it matters:
  - The blast radius is limited, but the response can become misleading without obvious operational noise.
- Remediation:
  - Type the count query result explicitly, or validate `total` with a small runtime check before returning it.

#### CQ-11: Shared-library tests are duplicated between `src` and `shared`, which blurs ownership and spends effort away from untested worker edge cases

- Severity: Low
- Location:
  - `src/lib/__tests__/format.test.ts`, lines `1-80`
  - `shared/lib/__tests__/format.test.ts`, lines `1-80`
  - `src/lib/__tests__/supply.test.ts`, lines `1-70`
  - `shared/lib/__tests__/supply.test.ts`, lines `1-47`
  - Repo-wide duplicate test basenames also include `chains.test.ts`, `daily-digest.test.ts`, `redemption-backstops.test.ts`, `report-cards.test.ts`, `stability-index.test.ts`, and `yield-rankings.test.ts`
- Problem:
  - Several frontend-side tests re-verify logic already owned by `shared/lib` instead of focusing on consumer integration behavior.
- Why it matters:
  - This is not a correctness bug by itself, but it increases maintenance cost and makes the overall test picture look stronger than it is for worker cache/corruption edge cases.
- Remediation:
  - Keep canonical behavioral tests for shared pure logic under `shared/lib/__tests__`.
  - Restrict `src` tests to integration behavior that is specific to frontend consumers.

## Top 10 Highest-Risk Findings

1. CQ-01: Stablecoins staleness guard fails open on malformed previous cache.
2. CQ-02: Yield publication guards fail open on malformed previous rankings snapshots.
3. CQ-03: `daily-digest/collectors.ts` remains a broad multi-domain hotspot with inconsistent local degradation logic.
4. CQ-04: `yield-sync/sources.ts` still mixes multiple source families and fallback policies in one hotspot.
5. CQ-05: `syncBlacklist()` is still a large multi-responsibility cron function.
6. CQ-06: `syncFxRates()` still centralizes source arbitration, fallback policy, and persistence.
7. CQ-07: Public API rate limiting disappears during D1 failures.
8. CQ-08: Daily digest malformed-JSON degradation paths are under-tested.
9. CQ-09: Guard helpers around publish/staleness decisions lack direct edge-case tests.
10. CQ-10: `discovery` silently coerces unexpected count-result shape to zero.

## Missing-Test Hotspots

- `worker/src/cron/yield-sync/publication.ts`, lines `150-190`
  - No direct tests for malformed previous `yield-rankings` cache or shrinkage-guard decisions.
- `worker/src/cron/sync-stablecoins/runtime.ts`, lines `107-159`
  - No direct tests for malformed previous `stablecoins` cache during staleness evaluation.
- `worker/src/cron/sync-stablecoins/stages.ts`, lines `306-318`
  - The raw previous-cache parse path is unpinned by unit tests.
- `worker/src/cron/daily-digest/collectors.ts`, lines `477-487`, `501-511`, `551-567`, `801-806`, `923-938`
  - Partial-corruption handling is much less tested than the happy path.
- `worker/src/cron/yield-coverage-audit.ts`, lines `166-179`
  - Rankings-cache parse failure behavior is not covered despite using the same raw-parse pattern seen elsewhere.

## Security Observations

- No critical auth, injection, or secret-handling issue was found in the current codebase audit.
- Admin gating is materially stronger than a header-presence check:
  - `worker/src/lib/auth.ts` verifies the CF Access JWT
  - `worker/src/lib/jwt-verify.ts` validates signature and claims
- SQL handling is generally disciplined:
  - parameter binding is standard in the worker code
  - `npm run check:sql-safety` passed
- Dependency posture is healthy from a security perspective:
  - `npm audit --omit=dev` reported no production vulnerabilities
  - CodeQL and Dependabot workflows are present
- The main security-relevant quality tradeoff I found is CQ-07:
  - public API rate limiting fails open when D1 is unavailable

## Residual Uncertainty

- This audit was exhaustive at repository level, but some conclusions about “missing tests” are based on absence of direct coverage rather than line-by-line coverage instrumentation output for every file.
- I did not treat acknowledged hotspot debt as a finding unless it still has a direct quality consequence today. Some large files are known debt with backlog notes, and I preserved that distinction.
- I did not flag stylistic issues, UI copy organization, or intentional availability tradeoffs unless they had a correctness, safety, or maintainability consequence.
- The repo’s guardrails are strong enough that many historical quality concerns are already addressed; the remaining risks are concentrated in malformed-cache handling and large cron orchestration modules.
