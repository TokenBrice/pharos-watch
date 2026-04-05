# Comprehensive Three-Pillar Codebase Audit

**Date:** 2026-04-03
**Scope:** Full codebase — 988 source files, 163K LoC, 379 test files
**Build status at time of audit:** All green (build, worker typecheck, lint, tests)

---

## 1. Executive Summary

### Finding Totals

| Pillar | Critical | High | Medium | Low | Total |
|--------|----------|------|--------|-----|-------|
| Redundancy | 0 | 0 | 8 | 13 | 21 |
| Code Quality | 2 | 5 | 11 | 8 | 26 |
| Sustainability | 0 | 0 | 4 | 10 | 14 |
| **Totals** | **2** | **5** | **23** | **31** | **61** |

### Top 5 Most Critical Findings

1. **[Critical] `sim-balances.ts:253,290` — `.json()` called without `.ok` check** — Silent data corruption risk in treasury balance reporting if `fetchWithRetry` returns a non-OK passthrough response.

2. **[Critical] `intake.ts:96` — Non-null assertion on conditionally-assigned `llamaRes`** — Core stablecoin sync pipeline would crash on any refactor that alters the `dlAllowed` branching logic.

3. **[High] `weekly-recap.ts:99` — Division by zero** — `mcaps[0]` can be `0`, producing `Infinity` in the weekly digest prompt.

4. **[High] `enrich-prices-passes.ts:760` — Non-null assertion after filter** — Could produce malformed Jupiter API request with `undefined` in the IDs parameter.

5. **[High] `env.ts:148-150,161` — Non-null assertions on env vars** — Runtime crash in worker startup if env config validation logic drifts.

### Health Ratings (1-10)

| Pillar | Score | Justification |
|--------|-------|---------------|
| **Redundancy** | **8/10** | Strong centralized formatting in `shared/lib/format.ts`, shared query infrastructure, zero dead module files. Redundancy is limited to "last-mile" formatter wrappers and EVM selector constants. |
| **Code Quality** | **7/10** | Excellent type discipline (zero `as any`, zero `@ts-ignore` in production), solid auth/SQL-injection/CORS/XSS defenses. Deductions for fragile non-null assertion patterns in critical pipelines and low frontend test coverage. |
| **Sustainability** | **9/10** | Clean three-layer architecture with enforced boundaries. 19-command merge gate, SHA-pinned CI, blue-green deploys, ratchet-based coverage. Lean dependency set. Comprehensive docs with automated staleness detection. |

### Technical Debt Profile

~5% of the codebase is affected by significant findings (medium or above). The debt is concentrated in:
- Non-null assertion fragility in the pricing/sync pipeline (~15 instances across 8 files)
- Formatter duplication in frontend components (~12 local re-implementations)
- EVM selector constant scattering across reserve adapters (4 constants x 3-4 declarations each)

---

## 2. Findings by Pillar

### Pillar 1: Redundancy

#### Medium Severity

**R-M1. Signed currency formatting — 3 duplicate implementations + inline usage**
- `src/components/flow-brrr-overview.tsx:66` — `formatSignedCurrency(value)`
- `src/components/kpi-bar.tsx:44` — `formatSignedCompactCurrency(value, decimals)`
- Inline in `coin-flow-card.tsx:59`, `comparison-table.tsx:229,389`, `flow-summary-card.tsx:90`
- Strategy: Add `formatSignedCurrency(value, decimals?)` to `shared/lib/format.ts`, replace all 9 call sites.

**R-M2. `timeAgo()` re-implemented despite existing shared export**
- `shared/lib/format.ts:187` — canonical `timeAgo(epochSec)` already exported
- `src/components/stablecoin-detail/price-transparency-card.tsx:30` — `formatTimeAgo()` pure duplicate with null-guard
- Strategy: Use `timeAgo()` from shared with a null-guard wrapper.

**R-M3. `trendColor` vs `getNetColor` — overlapping color helpers**
- `src/lib/chain-ui.ts:38-42` — `trendColor(value)`: green >= 0, red < 0, uses `text-emerald-600`
- `shared/lib/format.ts:198-202` — `getNetColor(value)`: green > 0, red < 0, muted = 0, uses `text-emerald-700`
- Strategy: Unify into a single parametric helper with optional `zeroClass`.

**R-M4. Duplicate `formatUsd` local helpers**
- `src/app/portfolio/client.tsx:89-101` — `formatUsd` with non-abbreviated precision
- `src/components/treasury-stable-exposure-table.tsx:24-32` — `formatUsd` duplicating `formatCompactUsd`
- Strategy: Replace treasury version with `formatCompactUsd`. Portfolio version needs non-abbreviated mode — add to shared if needed.

**R-M5. Score-to-color mapping — 5+ variants with different thresholds**
- `src/lib/severity-colors.ts:100` — `getScoreColor` (80/60/40)
- `src/lib/severity-colors.ts:105` — `pegScoreColor` (90/70)
- `src/lib/severity-colors.ts:118` — `getDurabilityColor` (70/40)
- `src/lib/yield-constants.ts:18` — `getPysColor` (40/20)
- `src/components/stablecoin-detail/redemption-backstop-card.tsx:24` — `scoreToneClass` (80/65/50/35)
- Strategy: Extract parametric `scoreToColorClass(value, thresholds)` in `severity-colors.ts`.

**R-M6. EVM selector constants duplicated 3-4 times each**
- `DECIMALS_SELECTOR` ("0x313ce567") — 3 declarations across `chainlink-nav.ts:16`, `chainlink-por.ts:9`, `chainlink-feeds.ts:5`
- `TOTAL_SUPPLY_SELECTOR` ("0x18160ddd") — 4 declarations across `helpers.ts:38`, `chainlink-nav.ts:17`, `gho.ts:18`, `supplemental-assets.ts:14`
- `LATEST_ROUND_DATA_SELECTOR` ("0xfeaf968c") — 3 declarations
- `BALANCE_OF_SELECTOR` ("0x70a08231") — in `helpers.ts:39` + inline-hardcoded in `balance-providers.ts:42,87,126,272`
- Strategy: Extract all to `worker/src/lib/evm-selectors.ts`.

**R-M7. Duplicated `parseChainlinkLatestRoundData` in two variants**
- `worker/src/cron/reserve-adapters/chainlink.ts:7` — unsigned parsing, takes `(hex, sourceLabel)`
- `worker/src/lib/chainlink-feeds.ts:98` — signed-int256 parsing, takes `(hex)`
- Strategy: Unify into one function with signed parsing (more correct) and optional `sourceLabel`.

**R-M8. Three overlapping JSON parse/decode systems**
- `safeJsonParse` in `worker/src/lib/api-utils.ts:218` — silent fallback
- `readCachedJson`/`readCachedJsonOr503` in `api-utils.ts:628,646` — status discriminated union
- `decodeCachedJson` in `worker/src/lib/cache-json.ts` — full discriminated union with normalize pipeline
- Strategy: Migrate `readCachedJson` call sites to `decodeCachedJson`. Keep `safeJsonParse` for its explicit best-effort contract.

#### Low Severity

**R-L1. `formatChainUsd` is a zero-logic passthrough**
- `src/lib/chain-ui.ts:4-6` — `return formatCompactUsd(value)` with no added logic
- Strategy: Import `formatCompactUsd` directly in the 2 consumer files. Remove `formatChainUsd`.

**R-L2. `formatMcap` reinvents `formatCurrency`**
- `src/components/status/discovery-candidates.tsx:12-16`
- Strategy: Replace with `formatCurrency(mcap, 1)`.

**R-L3. `formatBillions` reinvents `formatCompactUsd`**
- `src/components/total-mcap-chart.tsx:23-26`
- Strategy: Replace with `formatCompactUsd(value)`.

**R-L4. Local `abbreviate()` partially duplicates shared `abbreviateNumber`**
- `src/components/kpi-bar.tsx:49-55` — returns `{ short, suffix }` for count-up animation
- Strategy: Extract tier logic from shared source; keep structural return.

**R-L5. `formatSignedPercent` null-guard wrapper (em-dash vs hyphen)**
- `src/components/yield-detail-section.tsx:57-60`
- Strategy: Marginal — document or unify null representation.

**R-L6. Dead constant `EDITORIAL_TITLE_CLASS`**
- `src/lib/digest.ts:13` — exported but never imported
- Strategy: Remove.

**R-L7. `formatChartNumber` creates `Intl.NumberFormat` on every call**
- `src/components/yield-history-chart-model.ts:91-96` — called from chart axis ticks
- Strategy: Memoize or pre-create the formatter instance.

**R-L8. `formatUnits` duplicates `decimalStringFromBigInt`**
- `worker/src/cron/reserve-adapters/chainlink-nav.ts:46` — private function
- `worker/src/cron/reserve-adapters/slice-math.ts:61` — exported, same logic
- Strategy: Import from `slice-math.ts`.

**R-L9. `bigIntToDecimal` vs `decimalNumberFromBigInt` overlap**
- `worker/src/lib/bigint.ts:4` vs `worker/src/cron/reserve-adapters/slice-math.ts:74`
- Strategy: Consolidate to one (prefer string-based approach).

**R-L10. Chainlink POR/NAV structural overlap**
- `chainlink-por.ts` and `chainlink-nav.ts` share selector declarations, fetch pattern, staleness validation
- Strategy: Extract shared feed-read-validate function into `chainlink.ts`.

**R-L11. Frontend-only helpers in `shared/lib/format.ts`**
- `getNetColor`, `getNetPrefix`, `formatChartPercent`, `formatChartDate` — never imported by worker
- Strategy: Move to `src/lib/format.ts` to tighten shared boundary. Low priority.

**R-L12. `viem` in root `package.json` but only used by worker**
- Only imported in `worker/src/cron/reserve-adapters/crvusd.ts` and `worker/src/cron/dex-liquidity/fetch-slipstream.ts`
- Strategy: Move to `worker/package.json`.

**R-L13. Timestamp formatting — 4 partially overlapping approaches**
- `shared/lib/format.ts` exports `formatEventDate`, `formatChartDate`, `timeAgo`, `formatElapsedSeconds`
- `src/lib/status-dashboard-model.ts` exports `formatTimestampSeconds`, `formatTimestampMs`
- `src/lib/data-health.ts` exports `formatDataHealthTimestamp`, `formatHealthAge`
- `src/components/status/format.ts` exports `formatLatency`, `formatInterval`
- Strategy: Consolidate `formatTimestampSeconds`/`formatTimestampMs` (just `new Date(x).toLocaleString()`) into shared.

---

### Pillar 2: Code Quality

#### Critical Severity

**Q-C1. `sim-balances.ts:253,290` — `.json()` called on non-OK response**
- `fetchWithRetry` returns `null` on total failure but can return non-OK responses for passthrough statuses. No `.ok` check before `.json()`.
- Risk: Silent data corruption in treasury wallet balance reporting.
- Fix: Add `if (!response.ok) throw new Error(...)` before `.json()` calls.

**Q-C2. `intake.ts:96` — Non-null assertion on conditionally-assigned `llamaRes`**
- `llamaRes` is assigned inside `if (dlAllowed)` block. The `!` assertion hides the null dereference.
- Risk: Core stablecoin sync cron crash on any refactor altering branching.
- Fix: Replace `llamaRes!` with explicit null guard that falls back to CoinGecko.

#### High Severity

**Q-H1. `weekly-recap.ts:85-99` — Division by zero on `mcaps[0]`**
- `((mcaps[mcaps.length - 1] - mcaps[0]) / mcaps[0]) * 100` — if `mcaps[0]` is `0`, produces `Infinity`.
- Risk: Corrupted weekly digest prompt.
- Fix: Guard `mcaps[0] === 0`.

**Q-H2. `enrich-prices-passes.ts:760` — Non-null assertion on `mint` after filter**
- `.filter(entry => ... && entry.mint).map(entry => entry.mint!)` — TypeScript doesn't narrow across filter/map boundary.
- Risk: Malformed Jupiter API request with `undefined` in IDs.
- Fix: Use `.flatMap(entry => entry.mint ? [entry.mint] : [])`.

**Q-H3. `collectors-market.ts:243` — Non-null assertion on `intensity` in sort**
- `.sort((a, b) => Math.abs(b.intensity!) - Math.abs(a.intensity!))` after `.filter()` narrowing.
- Risk: If filter condition relaxed, `null` values produce silent misranking.
- Fix: Cast via `as number` after filter, or use type guard.

**Q-H4. `detect-depegs.ts:346,351` — Array `[0]` indexing without defensive guard**
- `const keeper = rows[0]` in else path where `rows.length >= 2` — safe but fragile.
- Risk: Potential crash in depeg event deduplication if refactored.
- Fix: Add `if (!keeper) continue;` after line 351.

**Q-H5. `env.ts:148-150,161` — Non-null assertions on environment variables**
- `env.CLOUDFLARE_ACCOUNT_ID!.trim()` etc., guarded by `hasConfiguredValue()` but not type-narrowed.
- Risk: Runtime crash if env config validation logic drifts.
- Fix: Use a type guard that narrows the type, or assert-and-throw.

#### Medium Severity

**Q-M1. Pervasive catch-and-log-only in cron jobs (97 instances)**
- Throughout `worker/src/cron/`. Intentional resilience pattern, but several locations mask systemic failures:
  - `daily-digest/collectors-risk.ts:77,208,277,332` — four collectors silently return empty data on D1 failure
  - `dex-liquidity/persistence.ts:196,276` — orphan cleanup failures logged but cron reports success
- Fix: Propagate partial failure counts in `CronResult.metadata`.

**Q-M2. 91 parameterless `catch {}` blocks**
- Most intentional (JSON parse fallbacks, localStorage), but some lack comments:
  - `yield-sync/cache.ts:126,458` — no comment on why parse failure is expected
  - `api/health.ts:40` — health endpoint swallowing errors silently
  - `handlers/scheduled/context.ts:55` — execution context setup failure
- Fix: Add `/* expected: ... */` comments. For `health.ts:40`, log at `warn` level.

**Q-M3. `peg-heatmap.tsx:94,159` — Non-null assertions in UI rendering**
- `.filter(c => c.currentDeviationBps !== null)` then `.sort((a, b) => Math.abs(b.currentDeviationBps!) - ...)`
- Fix: Use typed filter: `.filter((c): c is typeof c & { currentDeviationBps: number } => ...)`.

**Q-M4. `hero-card.tsx:571,587,591,660,671,676` — 6 non-null assertions on prev-period values**
- Ternary-guarded (`hasPrevDay ? ... prevDay! : "---"`), logically safe but 6 instances in one component.
- Fix: Compute narrowed variable once: `const safePrevDay = prevDay ?? 0;`.

**Q-M5. `use-endpoint-probes.ts:47` — Non-null assertion on `adminAccess`**
- `buildAdminApiPath(path, adminAccess!)` — function signature doesn't enforce the coupling.
- Fix: Add explicit guard: `if (!adminAccess) return { path, headers: undefined };`.

**Q-M6. `portfolio/client.tsx:35` — Non-null assertion on `llamaId`**
- `.filter(d => d.llamaId).map(d => d.llamaId!)` — same filter-then-assert pattern.
- Fix: Use `.flatMap(d => d.llamaId ? [d.llamaId] : [])`.

**Q-M7. `dispatchTelegramAlerts` — 530-line monolithic function**
- `worker/src/cron/dispatch-telegram-alerts.ts:290-825` — handles snapshot comparison, change detection for 5 alert types, subscriber lookup, message building, batched sending, retry queuing, circuit breaker tracking.
- Fix: Extract into phases: `detectChanges()`, `routeToSubscribers()`, `sendMessages()`, `persistState()`.

**Q-M8. `ContagionGraph` — 803 lines, 7 `useState`, mixed concerns**
- `src/components/contagion-graph.tsx` — manages simulation, drag, keyboard, tooltip/hover, focus filtering, SVG rendering.
- Fix: Extract `useDrag`, `useTooltip`, `useGraphKeyboard` hooks.

**Q-M9. Frontend page components have minimal test coverage (6%)**
- `src/app/` — 114 page files, only 7 test files.
- Fix: Add integration tests for critical pages (homepage, stablecoin detail, stability index).

**Q-M10. `src/components/` has low test coverage (20%)**
- 199 component files, 40 test files. Complex interactive components (contagion-graph, hero-card, charts) lack tests.
- Fix: Prioritize components with conditional rendering and user interaction.

**Q-M11. `shared/lib/` test coverage is moderate (35%)**
- 89 source files, 31 test files. Core computation modules should be higher.
- Fix: Ensure all scoring/classification logic has unit tests, especially `api-endpoints.ts` (830 lines).

#### Low Severity

**Q-L1. Single `as any` in test code only** — `reserve-adapter-validate.test.ts:31`. No production `as any`.

**Q-L2. Zero `@ts-ignore` or `@ts-expect-error` in entire codebase** — Excellent type discipline.

**Q-L3. API input validation is comprehensive** — `parseQueryParams`, `resolveStablecoinId`, format checks. No gaps.

**Q-L4. `tron-source.ts:140` — `.json()` without `.ok` check** — Safe under current `fetchWithRetry` contract but fragile.
- Fix: Add `if (!res.ok) return null;`.

**Q-L5. `yield-sync/resolve.ts:409,454` — Non-null assertions after `.filter()`** — Same pattern as M3/M6.

**Q-L6. `HeroCardProps` has 18 props** — Borderline but signals the component may be doing too much.
- Fix: Group into composite props (`supplyMetrics`, `pegMetrics`).

**Q-L7. Repetitive subscriber dispatch loops in telegram alerts**
- `dispatch-telegram-alerts.ts:583-666` — same structural pattern repeated 6 times.
- Fix: Extract `routeEventToSubscribers(specificSubs, globalSubs, event, appendFn)`.

**Q-L8. SQL column interpolation in alerts lacks allowlist comment (mitigated)**
- `dispatch-telegram-alerts.ts:238,274` — values from hardcoded `const` objects, not exploitable.
- Fix: Add `const VALID_ALERT_COLUMNS = new Set(...)` check matching project convention.

---

### Pillar 3: Sustainability & Maintainability

#### Medium Severity

**S-M1. `PeggedAsset` mutation bag in pricing pipeline**
- `worker/src/cron/sync-stablecoins/` — 16 files, 5.3K lines. Each enrichment pass mutates the shared array in-place.
- No type-level guarantee about which fields are filled after each stage. New contributors need significant ramp-up.
- Fix: Consider progressive type refinement (`RawAsset` -> `PricedAsset` -> `ValidatedAsset`) or at minimum TSDoc annotations per stage.

**S-M2. Global mutable state in rate-limit and request-source modules**
- `worker/src/lib/rate-limit.ts:18-23` — `consecutivePublicApiRateLimitFailures` accumulates across requests in same isolate, could falsely trigger emergency 503 block.
- `worker/src/lib/request-source-attribution.ts:21-22` — similar pattern.
- Fix: Document isolate-lifetime semantics. Consider time-based window for failure counter decay.

**S-M3. Circuit breaker state stored in general cache table**
- `worker/src/lib/circuit-breaker.ts` — `LIKE 'circuit:%'` pattern match on `cache` table can't use index efficiently. Documented TOCTOU race is accepted.
- Fix: Move to dedicated table with indexed `source` column if performance becomes a concern.

**S-M4. Configuration distributed across 10+ files in `shared/lib/`**
- `depeg-config.ts`, `dews-config.ts`, `pricing-provider-config.ts`, `pricing-source-registry.ts`, `yield-config.ts`, `status-thresholds.ts`, `ops-limits.ts`, `api-freshness.ts`, `reserve-templates.ts`, `redemption-backstop-configs/`
- No single config surface inventory. Operator tuning may require checking 5-8 files.
- Fix: Create a configuration surface index doc. Not urgent.

#### Low Severity

**S-L1. Wrangler cron schedules duplicated as raw strings**
- `worker/wrangler.toml:34-48` duplicates `CRON_SCHEDULES` from `shared/lib/cron-jobs.ts:13-27`. Adding a schedule to code without updating wrangler = silent failure.
- Fix: Add CI check verifying alignment. Partially mitigated by `SLOT_RUNNER_BY_SCHEDULE` satisfies check.

**S-L2. Stablecoin addition touches many files**
- Category JSON + `canonical-order.json` + potentially `yield-config.ts`, `pricing-source-registry.ts`, `live-reserve-adapters.ts`, `blacklist-contracts.ts`.
- Fix: No immediate action. Consider generated derived config if count approaches 300+.

**S-L3. Cron timeouts in separate hardcoded lookup table**
- `worker/src/lib/cron-lease.ts:3-17` — `CRON_TIMEOUT_MS` disconnected from `CRON_JOB_DEFINITIONS_BASE`.
- Fix: Co-locate timeouts with job definitions or add CI check.

**S-L4. `@radix-ui/react-popover` missing `^` prefix**
- `package.json:55` — `"1.1.15"` (exact) while other Radix packages use `^` ranges. Likely unintentional.
- Fix: Add `^` prefix.

**S-L5. `react-tweet` and `cmdk` exact-pinned**
- `package.json` — `"react-tweet": "3.3.0"`, `"cmdk": "1.1.1"`. Prevents automatic patch updates.
- Fix: Consider `~` ranges or document pinning rationale.

**S-L6. Merge gate serial execution**
- `scripts/test-merge-gate.mjs` — 19+ commands run sequentially. Could take several minutes.
- Fix: Consider parallelizing independent checks. Low priority (correctness > speed).

**S-L7. Doc staleness risk with 55 doc files**
- Mitigated by `check:doc-counts` and `check:doc-sync` CI checks.
- Fix: Consider expanding automated doc-sync coverage over time.

**S-L8. 66% global coverage threshold is moderate**
- `vitest.config.ts:37` — Reasonable floor given per-file critical thresholds up to 80% and ratchet mechanism.
- Fix: No immediate action. Per-file thresholds are the better lever.

**S-L9. Positive: Exceptionally thorough pipeline** — 19 automated checks, SHA-pinned actions, blue-green deploys, local/CI parity.

**S-L10. Positive: Clean three-layer boundary** — No production cross-layer violations. Shared types with Zod validation.

---

## 3. Cross-Cutting Concerns

### CC-1. Non-null assertion fragility across pipelines (Redundancy + Quality)

**Findings:** Q-C2, Q-H2, Q-H3, Q-H4, Q-H5, Q-M3, Q-M4, Q-M5, Q-M6, Q-L5

The `.filter().map(x => x!)` pattern appears ~15 times across critical code paths. This is a codebase-wide pattern, not isolated incidents. TypeScript does not propagate narrowing across `.filter()` into chained `.sort()` or `.map()` callbacks. The pattern is logically safe today but introduces a class of refactoring hazard.

**Compound risk:** A single change to a filter predicate silently passes `null`/`undefined` through to downstream operations in pricing, depeg detection, weekly digest, and UI rendering.

**Unified fix:** Adopt typed filter guards: `.filter((x): x is T & { field: number } => x.field != null)` as a codebase convention. Or use `.flatMap(x => x.field ? [x.field] : [])` for the map-after-filter pattern.

### CC-2. Formatter duplication + testing gap (Redundancy + Quality)

**Findings:** R-M1, R-M2, R-M3, R-M4, R-M5, R-L1–R-L5, Q-M9, Q-M10

The frontend has ~12 local re-implementations of shared formatters, AND frontend components have only 20% test coverage. These compound: duplicated formatting logic is the exact kind of code that should have tests to catch drift, but currently doesn't.

**Compound risk:** Formatting inconsistencies across pages that would be caught by tests if the formatters were centralized and tested.

**Unified fix:** Consolidate formatters first (Phase 2), then add tests for the centralized formatters (Phase 2), then add component tests that verify formatting output (Phase 3).

### CC-3. Pricing pipeline complexity + mutation pattern (Quality + Sustainability)

**Findings:** Q-M7, S-M1, R-M7, R-M8

The pricing pipeline (`sync-stablecoins/`, 16 files, 5.3K lines) combines:
- The largest monolithic function in the codebase (530-line `dispatchTelegramAlerts`)
- A mutable-object-passing pattern with no type-level stage guarantees
- Duplicated Chainlink round-data parsers across two subsystems
- Overlapping JSON decode systems

**Compound risk:** This is the most complex and hardest-to-onboard subsystem. Changes to the pricing pipeline carry the highest risk of unintended side effects.

**Unified fix:** Address in Phase 3. Progressive type refinement + extracted Chainlink parser + stage decomposition.

### CC-4. Error masking in cron jobs + circuit breaker storage (Quality + Sustainability)

**Findings:** Q-M1, Q-M2, S-M3

97 catch-and-log-only patterns in cron jobs mean partial failures are invisible. The circuit breaker that should surface external dependency failures stores state in a general cache table with a `LIKE` pattern match that can't use indexes efficiently.

**Compound risk:** A slow degradation of data quality could go undetected — individual sub-collectors fail silently, and the circuit breaker's health query is inefficient.

**Unified fix:** Propagate partial failure counts to `CronResult.metadata` (Phase 2). Move circuit breaker to dedicated table (Phase 3).

---

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins (small effort, high/immediate impact)

| Ref | Action | Files | Effort |
|-----|--------|-------|--------|
| Q-C1 | Add `.ok` check before `.json()` in `sim-balances.ts` | 1 file | Small |
| Q-C2 | Replace `llamaRes!` with explicit null guard in `intake.ts` | 1 file | Small |
| Q-H1 | Guard `mcaps[0] === 0` in `weekly-recap.ts` | 1 file | Small |
| Q-H4 | Add `if (!keeper) continue` in `detect-depegs.ts` | 1 file | Small |
| Q-L4 | Add `.ok` check in `tron-source.ts` | 1 file | Small |
| R-L6 | Remove dead `EDITORIAL_TITLE_CLASS` constant | 1 file | Small |
| R-L1 | Remove `formatChainUsd` passthrough, import `formatCompactUsd` directly | 3 files | Small |
| R-L2 | Replace `formatMcap` with `formatCurrency` | 1 file | Small |
| R-L3 | Replace `formatBillions` with `formatCompactUsd` | 1 file | Small |
| S-L4 | Add `^` to `@radix-ui/react-popover` version | 1 file | Small |
| R-L12 | Move `viem` to `worker/package.json` | 2 files | Small |
| Q-L8 | Add allowlist validation comment for alert column interpolation | 1 file | Small |

### Phase 2 — Targeted Refactoring (medium effort, clear ROI)

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| Q-H2, Q-H3, Q-M3, Q-M4, Q-M5, Q-M6, Q-L5 | Adopt typed filter guards / `.flatMap()` pattern across ~15 call sites | ~10 files | Medium | — |
| Q-H5 | Replace env var `!` assertions with type guards | 1 file | Small | — |
| R-M1, R-M2, R-M4 | Consolidate formatter duplicates into `shared/lib/format.ts` | ~12 files | Medium | — |
| R-M5 | Extract parametric `scoreToColorClass()` | ~6 files | Medium | — |
| R-M3 | Unify `trendColor`/`getNetColor` | 3 files | Small | — |
| R-M6 | Extract EVM selectors to `worker/src/lib/evm-selectors.ts` | ~8 files | Medium | — |
| R-M7 | Unify `parseChainlinkLatestRoundData` | 3 files | Small | R-M6 |
| R-L8, R-L9 | Consolidate `formatUnits`/`bigIntToDecimal` | 4 files | Small | R-M6 |
| Q-M1 | Add partial failure counts to `CronResult.metadata` | ~6 files | Medium | — |
| Q-M2 | Add `/* expected: ... */` comments to uncommented `catch {}` blocks | ~5 files | Small | — |
| Q-M7, Q-L7 | Decompose `dispatchTelegramAlerts` into phases + extract subscriber dispatch helper | 1 file | Medium | — |

### Phase 3 — Structural Improvements (higher effort, long-term payoff)

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| Q-M8 | Extract `useDrag`, `useTooltip`, `useGraphKeyboard` from `ContagionGraph` | 4 files | Medium | — |
| Q-M9, Q-M10 | Add integration tests for critical pages and complex components | ~10 new files | Large | Phase 2 formatters |
| Q-M11 | Increase `shared/lib/` test coverage for scoring/classification modules | ~8 new files | Medium | — |
| R-M8 | Migrate `readCachedJson` call sites to `decodeCachedJson` | ~8 files | Medium | — |
| S-M2 | Document isolate-lifetime semantics; add time-based window for rate-limit failure counter | 2 files | Small | — |
| S-M3 | Move circuit breaker to dedicated table with indexed `source` column | 3 files + migration | Medium | — |
| S-L1 | Add CI check for wrangler.toml <-> cron-jobs.ts alignment | 1 new script | Small | — |
| S-L3 | Co-locate cron timeouts with job definitions | 2 files | Small | — |
| S-M4 | Create configuration surface index doc | 1 new doc | Small | — |

### Phase 4 — Strategic Overhauls (major effort, requires careful planning)

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| S-M1 | Progressive type refinement in pricing pipeline (`RawAsset` -> `PricedAsset` -> `ValidatedAsset`) | ~16 files | Large | Phase 2 (Chainlink unification) |
| R-L10 | Extract shared Chainlink feed-read-validate function, merge POR/NAV structural overlap | ~5 files | Medium | R-M6, R-M7 |
| R-L11 | Move frontend-only helpers out of `shared/lib/format.ts` | ~15 files | Medium | Phase 2 formatters |

---

## 5. Appendices

### 5A. File-by-File Finding Index

| File | Findings |
|------|----------|
| `worker/src/lib/sim-balances.ts` | Q-C1 |
| `worker/src/cron/sync-stablecoins/intake.ts` | Q-C2 |
| `worker/src/cron/weekly-recap.ts` | Q-H1 |
| `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | Q-H2 |
| `worker/src/cron/daily-digest/collectors-market.ts` | Q-H3 |
| `worker/src/cron/detect-depegs.ts` | Q-H4 |
| `worker/src/lib/env.ts` | Q-H5 |
| `worker/src/cron/dispatch-telegram-alerts.ts` | Q-M7, Q-L7, Q-L8, R-L10(structural) |
| `worker/src/cron/daily-digest/collectors-risk.ts` | Q-M1 |
| `worker/src/cron/dex-liquidity/persistence.ts` | Q-M1 |
| `worker/src/cron/yield-sync/cache.ts` | Q-M2 |
| `worker/src/api/health.ts` | Q-M2 |
| `worker/src/handlers/scheduled/context.ts` | Q-M2 |
| `worker/src/cron/yield-sync/resolve.ts` | Q-L5 |
| `worker/src/cron/blacklist/tron-source.ts` | Q-L4 |
| `worker/src/cron/reserve-adapters/chainlink-nav.ts` | R-M6, R-M7, R-L8 |
| `worker/src/cron/reserve-adapters/chainlink-por.ts` | R-M6, R-M7 |
| `worker/src/cron/reserve-adapters/chainlink.ts` | R-M7 |
| `worker/src/cron/reserve-adapters/helpers.ts` | R-M6 |
| `worker/src/cron/reserve-adapters/gho.ts` | R-M6 |
| `worker/src/cron/reserve-adapters/slice-math.ts` | R-L8, R-L9 |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | R-M6 |
| `worker/src/cron/blacklist/balance-providers.ts` | R-M6 |
| `worker/src/lib/chainlink-feeds.ts` | R-M6, R-M7 |
| `worker/src/lib/bigint.ts` | R-L9 |
| `worker/src/lib/api-utils.ts` | R-M8 |
| `worker/src/lib/cache-json.ts` | R-M8 |
| `worker/src/lib/rate-limit.ts` | S-M2 |
| `worker/src/lib/request-source-attribution.ts` | S-M2 |
| `worker/src/lib/circuit-breaker.ts` | S-M3 |
| `worker/src/lib/cron-lease.ts` | S-L3 |
| `worker/wrangler.toml` | S-L1 |
| `shared/lib/cron-jobs.ts` | S-L1 |
| `shared/lib/format.ts` | R-M2, R-M3, R-L11 |
| `src/components/contagion-graph.tsx` | Q-M8 |
| `src/components/peg-heatmap.tsx` | Q-M3 |
| `src/components/stablecoin-detail/hero-card.tsx` | Q-M4, Q-L6 |
| `src/components/stablecoin-detail/price-transparency-card.tsx` | R-M2 |
| `src/components/stablecoin-detail/redemption-backstop-card.tsx` | R-M5 |
| `src/components/flow-brrr-overview.tsx` | R-M1 |
| `src/components/kpi-bar.tsx` | R-M1, R-L4 |
| `src/components/coin-flow-card.tsx` | R-M1 |
| `src/components/comparison-table.tsx` | R-M1 |
| `src/components/flow-summary-card.tsx` | R-M1 |
| `src/components/total-mcap-chart.tsx` | R-L3 |
| `src/components/treasury-stable-exposure-table.tsx` | R-M4 |
| `src/components/yield-detail-section.tsx` | R-L5 |
| `src/components/yield-history-chart-model.ts` | R-L7 |
| `src/components/status/discovery-candidates.tsx` | R-L2 |
| `src/hooks/use-endpoint-probes.ts` | Q-M5 |
| `src/app/portfolio/client.tsx` | Q-M6, R-M4 |
| `src/lib/chain-ui.ts` | R-L1, R-M3 |
| `src/lib/severity-colors.ts` | R-M5 |
| `src/lib/yield-constants.ts` | R-M5 |
| `src/lib/digest.ts` | R-L6 |
| `package.json` | R-L12, S-L4, S-L5 |

### 5B. Dependency Audit Summary

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| next | 16.x | Current | Latest major |
| react | 19.x | Current | Latest major |
| @tanstack/react-query | 5.x | Current | |
| tailwindcss | 4.x | Current | |
| recharts | 3.x | Current | |
| zod | 4.x | Current | |
| viem | 2.x | Current | Should move to worker/package.json |
| satori | (worker) | Current | OG image generation |
| vitest | 4.1 | Current | |
| typescript | ~5.9.0 | Current | Aligned root + worker |
| @cloudflare/workers-types | 4.x (date-pinned) | Current | Appropriate for Workers |
| d3-force | ^3.0.0 | Current (3.x line) | Monitor for v4 migration |
| react-tweet | 3.3.0 (exact) | Current | Consider `~` range |
| cmdk | 1.1.1 (exact) | Current | Consider `~` range |

No abandoned, unmaintained, or vulnerable dependencies detected. 29 direct root deps + 5 worker deps = lean set.

### 5C. Positive Findings Summary

The audit surfaced many areas of strong engineering that should be preserved:

- **Zero `as any` in production code**, zero `@ts-ignore`/`@ts-expect-error`
- **SQL injection defenses** — consistent parameterized queries, allowlist-guarded column interpolation, `buildInClause()` helper
- **Auth** — Cloudflare Access JWT with proper claim validation, JWKS rotation, timing-safe comparison
- **CORS** — explicit allowlist, `Vary: Origin`, security headers (HSTS, CSP, X-Content-Type-Options)
- **XSS** — all `dangerouslySetInnerHTML` usage goes through `safeJsonLd()` escaping for JSON-LD scripts only
- **No hardcoded secrets** in production code
- **19-command merge gate** with local/CI parity, SHA-pinned GitHub Actions
- **Blue-green worker deploys** with auto-rollback
- **Ratchet-based test coverage** preventing regression on critical files
- **Smoke tests** covering API, UI, and ops surfaces post-deploy
- **Clean three-layer boundary** — no production cross-layer violations
- **Cron idempotency** — lease-based fencing with heartbeat and stale takeover
- **No N+1 query patterns** in API handlers
- **379 test files** with per-file critical thresholds
- **Comprehensive docs** — 55 doc files with automated staleness detection

### 5D. Glossary

| Term | Definition |
|------|------------|
| Non-null assertion (`!`) | TypeScript's `!` postfix operator, which tells the compiler to trust that a value is not `null`/`undefined`. Bypasses type checking — if wrong, produces runtime crash. |
| Typed filter guard | A `.filter()` callback with a return type annotation (`: x is T`) that narrows the array element type for downstream operations. |
| TOCTOU | Time-of-check to time-of-use race condition — checking a condition and acting on it are not atomic. |
| Isolate reuse | Cloudflare Workers may reuse the same V8 isolate for multiple requests. Module-level `let` variables persist across requests within the same isolate. |
| Circuit breaker | Pattern that stops calling a failing external service after repeated failures, allowing periodic "half-open" probes to test recovery. |
| Ratchet mechanism | Coverage threshold that only moves up — once a file reaches a higher coverage %, the new value becomes the floor. |
| D1 | Cloudflare's serverless SQLite database service. |
| PSI | Pharos Stability Index — the project's composite stablecoin health score. |
| DEWS | Depeg Early Warning System — real-time deviation monitoring. |
