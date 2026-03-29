# Stablecoin Dashboard Comprehensive Audit Blueprint

Date: 2026-03-29

Scope: full application audit across frontend (`src/`), shared runtime-neutral logic (`shared/`), Pages Functions (`functions/`), worker runtime (`worker/src/`), CI/tooling (`scripts/`, `.github/workflows/`), and the architecture/testing/limits docs used as source-of-truth context.

Inventory snapshot:

- `src/`: 512 files
- `shared/`: 119 files
- `functions/`: 7 files
- `worker/src/`: 586 files
- `scripts/`: 36 files
- `docs/`: 56 files

Verification pass run locally:

- `npm run audit:deps` -> passed, `0 vulnerabilities`
- `npm outdated` -> version lag on `@cloudflare/workers-types`, `eslint`, `lucide-react`, `typescript`
- `npm run check:unused-code` -> passed, but one allowlisted dead export remained
- `npm run check:worker-boundary` -> passed
- `npm run check:shared-cycles` -> passed
- `npm run check:duplicate-exports` -> passed
- `npm run check:hotspot-ratchet` -> passed
- `npm run lint` -> passed
- `npm test` -> passed, `359` files / `3511` tests
- `cd worker && npx tsc --noEmit` -> passed
- `npm run build` -> passed

The findings below include only items that were directly source-verified during consolidation.

## 1. Executive Summary

### Findings Count

| Pillar | Total | Critical | High | Medium | Low |
| --- | ---: | ---: | ---: | ---: | ---: |
| Redundancy elimination | 8 | 0 | 1 | 6 | 1 |
| Code quality | 7 | 1 | 2 | 3 | 1 |
| Sustainability / maintainability | 7 | 0 | 3 | 2 | 2 |
| Total | 22 | 1 | 6 | 11 | 4 |

### Top 5 Most Critical Findings

1. `Q1` Partial-window PSI backfills can delete historical `stability_index` rows outside the requested window.
2. `Q2` `makeIdempotentAdminRoute()` does not enforce admin auth and is a latent security footgun.
3. `S2` cron scheduling has three authorities, and an unmapped schedule can silently no-op in production.
4. `S1` endpoint dependency hydration is non-exhaustive, so route dependency changes can compile yet fail at runtime.
5. `R1` stablecoin pricing applies the same validation / metadata-write logic in multiple paths, increasing drift risk in a core pipeline.

### Overall Health Assessment

| Pillar | Score | Justification |
| --- | ---: | --- |
| Redundancy elimination | 6/10 | Guardrails exist (`unused-code`, hotspot ratchet, duplicate-export check), but core worker paths still duplicate validation, mapping, paging, and historical pricing logic. |
| Code quality | 5/10 | Lint, tests, build, and typecheck are strong, but they currently miss a confirmed destructive PSI backfill bug and a misleading auth wrapper contract. |
| Sustainability / maintainability | 6/10 | The repo is disciplined on CI and documentation, but multi-authority configuration, oversized hotspots, and leaky shared boundaries will compound maintenance cost. |

Estimated technical debt profile: approximately `17%` of the actively maintained runtime / operational code surface is touched by significant findings, concentrated in worker admin APIs, cron orchestration, pricing / FX paths, and methodology rendering.

## 2. Findings By Pillar

### Redundancy Elimination

#### `R1` High
Locations:

- `worker/src/cron/sync-stablecoins/pricing.ts:161-217`
- `worker/src/cron/sync-stablecoins/pricing.ts:252-301`

Issue: `applyPrimaryPriceResults()` and `applyGtProbeResults()` both re-run candidate validation, rejection logging, and `stampPriceMetadata(...)` mutation with only minor source-selection differences.

Why it matters: this is core price-publication logic. Any future change to validation or metadata behavior can drift between the two paths and create inconsistent pricing semantics.

Remediation: extract a single `applyValidatedPriceCandidate(...)` helper and delegate source-specific logging / filtering to small callbacks.

#### `R2` Medium
Locations:

- `worker/src/lib/authoritative-price-sources.ts:193-234`
- `worker/src/lib/authoritative-price-sources.ts:285-324`

Issue: the historical quote collection loops for the CAP cUSD and infiniFi providers duplicate timestamp normalization, nearest-block lookup, block memoization, coverage enforcement, and point assembly.

Remediation: extract a generic historical-quote collector parameterized by the provider-specific quote fetcher.

#### `R3` Medium
Locations:

- `worker/src/cron/sync-fx-rates-helpers.ts:151-179`
- `worker/src/cron/sync-fx-rates-helpers.ts:181-209`

Issue: `applySecondaryRates()` and `applyExchangeRateApiRates()` both perform the same rate inversion, validation, previous-rate fallback, and liveness marking workflow.

Remediation: consolidate into one rate-application routine with pluggable payload accessors.

#### `R4` Medium
Locations:

- `worker/src/api/blacklist.ts:128-180`
- `worker/src/api/blacklist-summary.ts:62-83`

Issue: blacklist event DB rows are mapped to the same API shape twice, including methodology fallback and explorer URLs.

Remediation: move row-to-API transformation into a shared worker mapper.

#### `R5` Medium
Locations:

- `src/lib/api.ts:155-171`
- `src/lib/api.ts:230-246`

Issue: `apiFetch()` and `apiFetchWithMeta()` duplicate the same schema-validation, warning, and graceful-degradation behavior.

Remediation: extract a single `parseApiPayload(...)` / `validateApiPayload(...)` helper shared by both call sites.

#### `R6` Medium
Locations:

- `worker/src/lib/blacklist-contracts.ts:262-289`
- `worker/src/lib/mint-burn-contracts.ts:119-159`

Issue: both modules independently resolve tracked stablecoin metadata, apply source overrides, and throw the same missing / unknown contract errors before decorating the result.

Remediation: centralize tracked runtime contract resolution in a shared helper.

#### `R7` Low
Locations:

- `worker/src/lib/runtime-credentials.ts:5-17`
- `scripts/check-unused-code.mjs:153`

Issue: `buildTwitterCreds()` appears unused in live code, but the unused-code checker suppresses it via an allowlist entry.

Why it matters: this is genuine dead code hidden from the repo’s normal cleanup guardrail.

Remediation: remove the export and allowlist entry, or add a real consumer if the abstraction is still intended.

#### `R8` Medium
Locations:

- `worker/src/cron/dex-liquidity/geckoterminal-shared.ts:10-42`
- `worker/src/lib/coingecko-onchain.ts:89-114`

Issue: token-pool pagination is duplicated for two near-identical provider APIs.

Remediation: create a shared paged token-pool crawler primitive with provider-specific URL and header adapters.

### Code Quality Improvement

#### `Q1` Critical
Location:

- `worker/src/api/backfill-stability-index.ts:68-76`
- `worker/src/api/backfill-stability-index.ts:120-123`
- `worker/src/api/backfill-stability-index.ts:132-187`
- `worker/src/api/backfill-stability-index.ts:208-216`
- Test gap: `worker/src/api/__tests__/backfill-stability-index.test.ts:245-289`

Issue: bounded PSI backfills compute only the requested window into `stability_index_rebuild`, then delete the entire `stability_index` table and reinsert only rebuilt rows.

Why it matters: a targeted maintenance run can truncate historical PSI data outside the requested range.

Remediation: make bounded runs update only the requested window or preserve out-of-range rows during the swap. Add a regression test that preloads rows before and after the requested range and asserts they survive.

#### `Q2` High
Location:

- `worker/src/lib/route-wrappers.ts:20-28`
- `worker/src/route-registry.ts:201-253`

Issue: `makeIdempotentAdminRoute()` applies idempotency and error handling but not admin auth, even though its name suggests an admin-safe wrapper.

Why it matters: this is a latent security footgun. A future maintainer can add an endpoint through this wrapper and unintentionally expose it.

Remediation: either compose `withAdmin()` into the idempotent wrapper or rename the wrapper to make its limits explicit. Add unauthorized-access contract tests for the wrapper behavior.

#### `Q3` High
Location:

- `worker/src/api/backfill-stability-index.ts:93-118`
- `worker/src/api/backfill-stability-index.ts:132-187`

Issue: PSI backfill loads complete historical depeg, supply, DEWS, and existing PSI tables into memory even for partial runs.

Why it matters: runtime cost grows with total history, not requested work, making admin recovery operations progressively slower and riskier.

Remediation: query only the required window, chunk recomputation, and avoid full-history in-memory maps for bounded runs.

#### `Q4` Medium
Locations:

- `worker/src/cron/sync-mint-burn.ts:149-778`
- `worker/src/cron/dex-liquidity/orchestrator.ts:159-730`
- `worker/src/lib/status-evaluation.ts:149-582`
- `src/components/yield-leaderboard.tsx:75-612`

Issue: these modules are monolithic and multi-responsibility, mixing orchestration, transformation, persistence, and presentation logic.

Why it matters: review cost and regression risk increase because small changes require understanding large, intertwined units.

Remediation: split orchestration from pure transforms and persistence; add narrower tests around ordering and threshold logic after decomposition.

#### `Q5` Medium
Locations:

- `src/app/methodology/sections/core-sections.tsx:29-1261`
- `src/app/methodology/sections/monitoring-sections.tsx:26-1034`
- `src/app/methodology/scoring-changelog/content.tsx:115-1170`
- `shared/lib/safety-score-version.ts:3-260`

Issue: methodology prose, changelog content, and versioned business metadata are embedded as large TS / TSX blobs.

Why it matters: code review noise rises, documentation changes require code-level editing, and business-logic drift becomes harder to isolate.

Remediation: move long-form content into MDX or structured content files and keep code focused on rendering / lookup.

#### `Q6` Medium
Locations:

- `worker/src/api/backfill-depegs.ts:100-249`
- `worker/src/api/backfill-supply-history.ts:178-257`
- `worker/src/api/backfill-stability-index.ts:32-123`
- `worker/src/api/backfill-mint-burn.ts:96-188`

Issue: admin backfill handlers repeat the same auth, selection, reporting, and batching orchestration instead of using a hardened shared runner.

Why it matters: fixes to failure handling or request semantics have to be repeated across multiple admin surfaces.

Remediation: introduce a shared admin-job runner template for auth, dry-run behavior, window / coin selection, summaries, and failure reporting.

#### `Q7` Low
Locations:

- `worker/src/lib/chain-registry.ts:46-58`
- `worker/src/lib/authoritative-price-sources.ts:7-8`

Issue: public / fallback RPC configuration is duplicated rather than centralized.

Why it matters: provider rotations can drift between subsystems.

Remediation: define all fallback RPCs in one shared registry consumed by both modules.

### Long-Term Sustainability And Maintainability

#### `S1` High
Locations:

- `shared/lib/api-endpoints.ts:3-10`
- `shared/lib/api-endpoints.ts:33-34`
- `worker/src/handlers/http/context.ts:9-56`
- `worker/src/route-registry.ts:71-118`

Issue: route dependency wiring is spread across a string union (`EndpointDependency`), optional `FullRouteContext` bags, and a non-exhaustive `switch`.

Long-term consequence: new route dependencies can compile cleanly but fail at runtime because hydration logic was not updated.

Remediation: use an exhaustive typed resolver map keyed by `EndpointDependency`, or embed dependency hydration in typed endpoint definitions so registry and context building cannot drift.

#### `S2` High
Locations:

- `worker/wrangler.toml:32-47`
- `shared/lib/cron-jobs.ts:13-27`
- `worker/src/handlers/scheduled.ts:21-45`
- `scripts/check-cron-schedule-sync.ts:1-28`

Issue: cron schedules currently have three authorities: Wrangler config, `CRON_SCHEDULES`, and `SLOT_RUNNER_BY_SCHEDULE`. The existing sync check validates only the first two. If the runner map is not updated, `handleScheduledEvent()` just returns.

Long-term consequence: a production cron can silently stop running with no deploy-time or runtime hard failure.

Remediation: centralize expression + runner metadata in one typed registry, or extend CI/runtime assertions so every schedule has exactly one runner and unknown schedules fail loudly.

#### `S3` High
Locations:

- `shared/types/core.ts:1-3`
- `shared/types/live-reserves.ts:1-21`
- `shared/lib/live-reserve-adapters.ts:1-80`

Issue: shared type modules import and re-export types from a heavyweight implementation / config module.

Long-term consequence: type-only consumers become coupled to live-reserve implementation details, making boundary refactors invasive.

Remediation: move neutral interfaces into `shared/types/live-reserves.ts`, and make `shared/lib/live-reserve-adapters.ts` depend on those types instead of the reverse.

#### `S4` Medium
Locations:

- `scripts/check-doc-sync.ts:205-234`
- `scripts/check-doc-sync.ts:484-492`
- `scripts/check-doc-counts.mjs:53-64`

Issue: documentation drift protection relies on selective coverage and regex-based source scraping.

Long-term consequence: some important docs can drift without CI catching it, while harmless code refactors can break doc checks unexpectedly.

Remediation: expand coverage to all methodology/versioned surfaces and drive doc checks from exported structured metadata instead of regex parsing.

#### `S5` Medium
Locations:

- `scripts/lib/hotspot-ratchet-baseline.json:22-86`
- `worker/src/cron/daily-digest.ts:55-435`
- `worker/src/lib/live-reserves-store.ts:196-539`
- `worker/src/cron/yield-sync/sources.ts:133-260`
- `src/app/methodology/sections/core-sections.tsx`
- `src/app/methodology/sections/monitoring-sections.tsx`

Issue: the hotspot ratchet prevents further growth, but several oversized multi-responsibility files remain accepted as long-lived exceptions.

Long-term consequence: onboarding, code review, and safe change velocity all degrade as more operational logic remains concentrated in a few hotspot files.

Remediation: turn the ratchet list into an explicit decomposition backlog with domain seams and owner assignments.

#### `S6` Low
Locations:

- `worker/src/lib/telegram-webhook-registration.ts:3`
- `worker/src/cron/status-self-check.ts:46`
- `src/lib/api.ts:16-23`
- `src/lib/site-config.ts:1-2`
- `scripts/serve-static-export.mjs:54-57`
- `functions/lib/ops-origin.ts:1-10`
- `functions/lib/ops-env.ts:3-15`

Issue: canonical site / API / ops origins are repeated across frontend, worker, scripts, and Pages Functions.

Long-term consequence: host changes become multi-file edits with predictable drift risk.

Remediation: centralize canonical origins in one shared config surface with environment overrides for scripts and runtimes.

#### `S7` Low
Scope: repo-wide dependency health

Issue: no current high-severity production vulnerabilities were found, but major version lag exists on key tooling and UI packages.

Evidence:

- `@cloudflare/workers-types` `4.20260317.1 -> 4.20260329.1`
- `eslint` `9.39.4 -> 10.1.0`
- `lucide-react` `0.577.0 -> 1.7.0`
- `typescript` `5.9.3 -> 6.0.2`

Long-term consequence: the longer toolchain majors are deferred, the harder migration becomes.

Remediation: schedule routine dependency refresh work with separate lanes for runtime-critical packages and toolchain majors.

## 3. Cross-Cutting Concerns

### `C1` PSI Backfill Safety Gap
References: `Q1`, `Q3`, `S5`

The PSI backfill path has both correctness and sustainability issues: it can truncate history on bounded runs, and it scales with full historical datasets instead of requested scope. Because it also lives in an already-hot operational area, the cost of not fixing it will rise as historical data grows.

### `C2` Admin Route Framework Fragmentation
References: `Q2`, `Q6`, `S1`

Admin-route behavior is split across handler-level auth, partial wrapper abstractions, and loosely typed dependency hydration. Today that mostly works because handlers self-police, but the design is one maintenance mistake away from an access-control regression.

### `C3` Core Data-Pipeline Drift Risk
References: `R1`, `R2`, `R3`, `R8`, `S5`

Pricing, FX, and provider paging logic are duplicated in core worker paths that already sit on the hotspot list. That is exactly where subtle behavioral divergence is expensive.

### `C4` Contract / Documentation Drift Is Managed, Not Eliminated
References: `R5`, `S4`, `Q5`

The repo has meaningful doc-sync and contract checks, but there are still multiple places where equivalent semantics are implemented twice or encoded in code-shaped prose. The result is reduced drift, not drift-proofing.

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Ref | Action | Affected Areas | Effort | Depends On |
| --- | --- | --- | --- | --- |
| `Q2` | Fix or rename `makeIdempotentAdminRoute()` so its auth contract is explicit; add unauthorized-route tests. | `worker/src/lib/route-wrappers.ts`, `worker/src/route-registry.ts`, admin route tests | Small | None |
| `R7` | Remove dead `buildTwitterCreds()` export and its allowlist entry. | `worker/src/lib/runtime-credentials.ts`, `scripts/check-unused-code.mjs` | Small | None |
| `S6` | Centralize canonical origins into shared config helpers. | `src/lib`, `worker/src/lib`, `functions/lib`, `scripts/serve-static-export.mjs` | Small | None |
| `S7` | Upgrade `@cloudflare/workers-types` first; create tracked upgrade tickets for `eslint`, `typescript`, `lucide-react`. | `package.json`, `worker/package.json`, lockfile | Small | None |
| `R5` | Extract shared API schema-validation helper. | `src/lib/api.ts` | Small | None |

### Phase 2 — Targeted Refactoring

| Ref | Action | Affected Areas | Effort | Depends On |
| --- | --- | --- | --- | --- |
| `R4` | Share blacklist event row mapping. | `worker/src/api/blacklist.ts`, `worker/src/api/blacklist-summary.ts` | Small | None |
| `R6` | Share tracked runtime contract resolution. | `worker/src/lib/blacklist-contracts.ts`, `worker/src/lib/mint-burn-contracts.ts` | Medium | None |
| `R8` | Share token-pool pagination primitive. | `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`, `worker/src/lib/coingecko-onchain.ts` | Medium | None |
| `R1` | Unify price-candidate application logic. | `worker/src/cron/sync-stablecoins/pricing.ts` | Medium | None |
| `R3` | Unify FX fallback application logic. | `worker/src/cron/sync-fx-rates-helpers.ts` | Medium | None |
| `Q6` | Create a common admin-job runner template. | worker admin backfill handlers | Medium | `Q2` |
| `Q7` | Centralize fallback RPC definitions. | `worker/src/lib/chain-registry.ts`, `worker/src/lib/authoritative-price-sources.ts` | Small | `S6` optional |

### Phase 3 — Structural Improvements

| Ref | Action | Affected Areas | Effort | Depends On |
| --- | --- | --- | --- | --- |
| `S1` | Replace route dependency `switch` with exhaustive typed hydration. | `shared/lib/api-endpoints.ts`, `worker/src/handlers/http/context.ts`, `worker/src/route-registry.ts` | Medium | `Q2` helpful |
| `S2` | Collapse cron authority sources into one typed registry and fail on unknown schedules. | `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, `worker/src/handlers/scheduled.ts`, `scripts/check-cron-schedule-sync.ts` | Medium | None |
| `S3` | Restore clean type / implementation boundaries for live reserves. | `shared/types/*`, `shared/lib/live-reserve-adapters.ts` | Medium | None |
| `R2` | Extract shared historical quote collector. | `worker/src/lib/authoritative-price-sources.ts` | Medium | `Q7` optional |
| `S4` | Replace regex-based doc sync with exported metadata / manifests. | `scripts/check-doc-sync.ts`, `scripts/check-doc-counts.mjs`, methodology version modules | Medium | `Q5` helpful |
| `S5` | Turn hotspot ratchet into explicit decomposition backlog with owners. | hotspot baseline plus affected large modules | Medium | None |

### Phase 4 — Strategic Overhauls

| Ref | Action | Affected Areas | Effort | Depends On |
| --- | --- | --- | --- | --- |
| `Q1` + `Q3` | Redesign PSI backfill into a range-safe, window-bounded, chunked rebuild flow with full regression coverage. | `worker/src/api/backfill-stability-index.ts`, PSI tests | Large | `Q2`, `S1` helpful |
| `Q4` + `S5` | Decompose large operational modules into orchestrators plus pure helpers / stores. | `sync-mint-burn`, `dex-liquidity/orchestrator`, `status-evaluation`, `yield-leaderboard`, `daily-digest`, `live-reserves-store`, `yield-sync/sources` | Large | None |
| `Q5` + `S4` | Move methodology and changelog content to MDX / structured content with generated manifests. | `src/app/methodology/**`, `shared/lib/*-version.ts`, doc checks | Large | `S4` |

## 5. Appendices

### Appendix A — File-By-File Finding Index

| File / Module | Findings |
| --- | --- |
| `worker/src/api/backfill-stability-index.ts` | `Q1`, `Q3`, `Q6` |
| `worker/src/api/__tests__/backfill-stability-index.test.ts` | `Q1` |
| `worker/src/lib/route-wrappers.ts` | `Q2` |
| `worker/src/route-registry.ts` | `Q2`, `S1` |
| `shared/lib/api-endpoints.ts` | `S1` |
| `worker/src/handlers/http/context.ts` | `S1` |
| `worker/wrangler.toml` | `S2` |
| `shared/lib/cron-jobs.ts` | `S2` |
| `worker/src/handlers/scheduled.ts` | `S2` |
| `scripts/check-cron-schedule-sync.ts` | `S2` |
| `worker/src/cron/sync-stablecoins/pricing.ts` | `R1` |
| `worker/src/lib/authoritative-price-sources.ts` | `R2`, `Q7` |
| `worker/src/cron/sync-fx-rates-helpers.ts` | `R3` |
| `worker/src/api/blacklist.ts` | `R4` |
| `worker/src/api/blacklist-summary.ts` | `R4` |
| `src/lib/api.ts` | `R5`, `S6` |
| `worker/src/lib/blacklist-contracts.ts` | `R6` |
| `worker/src/lib/mint-burn-contracts.ts` | `R6` |
| `worker/src/lib/runtime-credentials.ts` | `R7` |
| `scripts/check-unused-code.mjs` | `R7` |
| `worker/src/cron/dex-liquidity/geckoterminal-shared.ts` | `R8` |
| `worker/src/lib/coingecko-onchain.ts` | `R8` |
| `worker/src/cron/sync-mint-burn.ts` | `Q4` |
| `worker/src/cron/dex-liquidity/orchestrator.ts` | `Q4` |
| `worker/src/lib/status-evaluation.ts` | `Q4` |
| `src/components/yield-leaderboard.tsx` | `Q4` |
| `src/app/methodology/sections/core-sections.tsx` | `Q5`, `S5` |
| `src/app/methodology/sections/monitoring-sections.tsx` | `Q5`, `S5` |
| `src/app/methodology/scoring-changelog/content.tsx` | `Q5` |
| `shared/lib/safety-score-version.ts` | `Q5` |
| `worker/src/api/backfill-depegs.ts` | `Q6` |
| `worker/src/api/backfill-supply-history.ts` | `Q6` |
| `worker/src/api/backfill-mint-burn.ts` | `Q6` |
| `shared/types/core.ts` | `S3` |
| `shared/types/live-reserves.ts` | `S3` |
| `shared/lib/live-reserve-adapters.ts` | `S3` |
| `scripts/check-doc-sync.ts` | `S4` |
| `scripts/check-doc-counts.mjs` | `S4` |
| `scripts/lib/hotspot-ratchet-baseline.json` | `S5` |
| `worker/src/cron/daily-digest.ts` | `S5` |
| `worker/src/lib/live-reserves-store.ts` | `S5` |
| `worker/src/cron/yield-sync/sources.ts` | `S5` |
| `worker/src/lib/telegram-webhook-registration.ts` | `S6` |
| `worker/src/cron/status-self-check.ts` | `S6` |
| `src/lib/site-config.ts` | `S6` |
| `scripts/serve-static-export.mjs` | `S6` |
| `functions/lib/ops-origin.ts` | `S6` |
| `functions/lib/ops-env.ts` | `S6` |
| `package.json` | `S7` |
| `worker/package.json` | `S7` |

### Appendix B — Dependency Audit Summary

| Package | Current | Wanted | Latest | Scope | Note |
| --- | --- | --- | --- | --- | --- |
| `npm audit --omit=dev` | n/a | n/a | n/a | production dependencies | `0` high-severity vulnerabilities found |
| `@cloudflare/workers-types` | `4.20260317.1` | `4.20260329.1` | `4.20260329.1` | worker typing | low-risk refresh candidate |
| `eslint` | `9.39.4` | `9.39.4` | `10.1.0` | root tooling | major upgrade; plan separately |
| `lucide-react` | `0.577.0` | `0.577.0` | `1.7.0` | frontend UI | major API / icon package drift |
| `typescript` | `5.9.3` | `5.9.3` | `6.0.2` | root + worker tooling | major compiler upgrade; stage carefully |

### Appendix C — Glossary

| Term | Meaning in this report |
| --- | --- |
| Structural clone | duplicated logic with different names / small variations rather than exact copy-paste |
| Footgun | an API or abstraction that is easy for a maintainer to misuse in a dangerous way |
| Idempotency | repeated identical requests produce the same effect / response contract |
| Exhaustive mapping | a typed map that forces every allowed key / variant to be handled |
| Hotspot | a file already recognized as high-change or oversized and therefore risky to keep growing |
| Drift | behavior, docs, config, or contracts diverging across multiple supposed sources of truth |
