# Agent 2 Code Quality Audit - 2026-04-16

Scope: code quality only for `/home/ahirice/Documents/git/stablecoin-dashboard`. Product code was not edited.

## Inventory

- Required docs reviewed: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`.
- Application shape: static Next.js 16 frontend under `src/`, shared runtime-neutral logic and data under `shared/`, Cloudflare Pages Functions under `functions/`, Cloudflare Worker/D1 API and cron jobs under `worker/src/`, local validators and smoke tooling under `scripts/`.
- Inventory command counted 1,712 tracked TS/TSX/JS/MJS files under `src`, `shared`, `worker/src`, `functions`, and `scripts`.
- Existing worktree caveat at audit start: `shared/lib/redemption-backstop-configs/offchain-issuer.ts` was already modified, and several `/agents/` notes were already untracked. I did not touch them.

## Validation Evidence

Passed:

- `npm run lint`
- `npm run typecheck`
- `npm test`: 475 files, 4,668 tests passed
- `npm run test:coverage`: 475 files, 4,668 tests passed; all-file line coverage 81.77%, branch coverage 68.35%
- `cd worker && npx tsc --noEmit`
- `npm run check:unused-code`
- `npm run check:sql-safety`: 532 files scanned
- `npm run check:shared-cycles`
- `npm run check:worker-boundary`
- `npm run check:hotspot-ratchet`
- `npm run audit:deps`: 0 high-severity production vulnerabilities
- `npm run check:stablecoin-data`: 190 canonical stablecoin entries validated
- `npm run check:env-contract`
- `npm run check:duplicate-exports`
- `npm run check:cron-connections`: all 14 triggers within budget

Caveats:

- I did not run `npm run build`, UI smoke tests, live API smoke tests, or Wrangler.
- Findings below are limited to code quality, error handling, complexity, type/data integrity, test quality, and obvious security concerns. Redundancy and long-term architecture ownership are intentionally out of scope except where they directly affect code quality.

## Findings

### Q1 - High - Portfolio reserve exposure can produce NaN for zero-sum reserve percentages

Location:

- `src/lib/portfolio-analysis.ts`, `applyReservesToRemainder`, lines 199-223
- `src/lib/portfolio-analysis.ts`, `computeUpstreamExposure`, lines 233-241 and 266-270
- Contrast: `shared/lib/report-card-resilience.ts`, `computeCollateralQualityFromReserves`, lines 99-106 guards `totalPct === 0`

Problem:

`computeUpstreamExposure()` divides by `totalPct` when allocating reserve slices. If all reserve `pct` values in a branch are zero, or if filtered non-stable reserves sum to zero, the calculation emits `NaN` USD exposure values. The shared report-card scoring path already guards this case, but the portfolio exposure path does not.

Why it matters:

Portfolio exposure is a user-facing risk calculation. A future curated-data row with zero reserve weights, or a live-imported reserve shape reused here later, can silently poison the portfolio summary with invalid numbers. This is a data-integrity bug rather than a style issue.

Concrete remediation:

Add the same guard used in report-card scoring before every percentage allocation. For example:

```ts
const totalPct = nonStableReserves.reduce((sum, reserve) => sum + reserve.pct, 0);
if (totalPct <= 0) {
  const fallback = backingFallback(backing);
  addCollateral(fallback.name, fallback.symbol, remainderUsd);
  return;
}
```

Add unit coverage for zero-sum reserves, mixed zero/nonzero reserves, and stablecoin-slice filtering that leaves no non-stable reserve weight.

### Q2 - Medium - Portfolio amount validation is inconsistent across URL, storage, and live actions

Location:

- `src/lib/portfolio-codec.ts`, `parsePortfolioUrlParam`, lines 21-26
- `src/lib/portfolio-codec.ts`, `isPortfolioHolding`, lines 79-86
- `src/hooks/use-portfolio.ts`, `addCoin` and `setAmount`, lines 116-130
- `src/app/portfolio/client.tsx`, `parseUsdInput`, lines 100-103
- `src/app/portfolio/client.tsx`, initial add path, lines 440-443

Problem:

URL holdings require `Number.isFinite(amount) && amount > 0`, but stored holdings only require `typeof amount === "number" && amount > 0`, which accepts `Infinity` from JSON such as `1e999`. Runtime actions also accept any number and the UI deliberately adds a new coin with amount `0`. That creates three subtly different validity models for the same `PortfolioHolding`.

Why it matters:

The same portfolio can round-trip differently through local storage and share URLs. Non-finite values can corrupt totals and weighted scores; zero values can persist in live state and shared URLs but are dropped on URL parse.

Concrete remediation:

Introduce one validator/coercer, for example `normalizePortfolioHolding(value): PortfolioHolding | null`, and use it in URL parsing, storage parsing, `addCoin`, and `setAmount`. Decide explicitly whether zero-amount draft rows are part of persisted state. If they are UI-only, keep draft selection outside `holdings` until the user enters a positive finite amount.

### Q3 - Medium - Stablecoin metadata schemas accept domain-invalid numeric values

Location:

- `shared/lib/stablecoins/schema.ts`, `ContractDeploymentAssetSchema`, lines 54-58
- `shared/lib/stablecoins/schema.ts`, `DependencyWeightAssetSchema`, lines 60-64
- `shared/lib/stablecoins/schema.ts`, `ReserveSliceAssetSchema`, lines 66-73
- `scripts/check-stablecoin-data.ts`, validation loop, lines 86-139

Problem:

The data schema validates numeric type only. It does not enforce that contract decimals are integers in a sane range, dependency weights are in `[0, 1]`, or reserve percentages are nonnegative and plausibly bounded. `check-stablecoin-data` layers admission checks on top, but it does not add these semantic numeric invariants.

Why it matters:

Curated stablecoin data is a system boundary for scoring, dependency risk, portfolio exposure, reserve display, and methodology outputs. A negative weight or negative reserve percentage would pass the current schema and then be handled inconsistently by downstream math.

Concrete remediation:

Tighten Zod schemas where the domain is clear:

```ts
decimals: z.number().int().min(0).max(255)
weight: z.number().min(0).max(1)
pct: z.number().min(0)
```

Add aggregate checks in `check-stablecoin-data.ts` for impossible reserve totals and dependency totals. Keep any intentional overcollateralized reserve total behavior documented and explicitly allowed.

### Q4 - Medium - Direct DEX API fetchers rely on assertions at external JSON boundaries

Location:

- `worker/src/cron/dex-liquidity/fetch-meteora.ts`, `fetchMeteoraPools`, lines 45-64 and 90-116
- `worker/src/cron/dex-liquidity/fetch-balancer.ts`, `fetchBalancerPools`, lines 80-107 and 120-135
- `worker/src/cron/dex-liquidity/fetch-raydium.ts`, `fetchRaydiumPoolsForType`, lines 37-60 and 80-90
- Higher-level catch: `worker/src/cron/dex-liquidity/orchestrator-phases.ts`, `runDirectApiFetchPhase`, lines 324-352

Problem:

These fetchers return structured degraded results for HTTP failures and some malformed shapes, but invalid JSON, `null` roots, and missing nested token objects can throw from the fetcher. The orchestrator catches that as a source-level exception, but page-level partial work and precise error classification are lost. Meteora has only a happy-path test, while Balancer/Raydium mostly test valid JSON with malformed inner shape.

Why it matters:

These providers are external and can return transient HTML, empty bodies, partial objects, or schema changes. Treating those as thrown exceptions at the provider boundary makes failures coarser and less observable than the rest of the DEX pipeline's degraded-result model.

Concrete remediation:

Add a small `readDexApiJson()` helper that catches `response.json()` failures and returns `{ ok: false, error }`. Validate root objects before nested access, preferably with small Zod schemas or hand-written type guards per provider. Add tests for invalid JSON text, `null`, and missing nested token objects for Meteora, Balancer, and Raydium.

### Q5 - Medium - Cron/provider decision functions remain high-complexity hotspots

Location:

- `worker/src/cron/dex-discovery/crawl-sources.ts`, `crawlCoin`, lines 58-486
- `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`, `analyzeDexLiquidityPostScoring`, lines 224-632
- `worker/src/cron/confirm-pending-depegs.ts`, `confirmPendingDepegs`, lines 63-400
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `fetchPrimaryPrices`, lines 459-789

Problem:

Static AST scan found these functions have branch counts from 66 to 103 and lengths from 331 to 429 lines. They mix orchestration, provider-specific parsing, policy decisions, observability, and persistence-adjacent behavior.

Why it matters:

These are correctness-sensitive paths: price publication, DEX discovery, DEX health metadata, and depeg confirmation. A branch-heavy monolith makes policy changes risky because a small edit can alter unrelated provider or persistence behavior. Existing tests are broad, but comprehension cost remains high.

Concrete remediation:

Do not rewrite wholesale. Extract one seam at a time into pure functions with characterization tests:

- `crawlCoin`: split CG onchain, GeckoTerminal, DexScreener, and CG ticker stages into stage functions returning the same `CrawlResult` fragments.
- `analyzeDexLiquidityPostScoring`: split previous-baseline loading, guard computation, drift flags, and source-family metrics.
- `confirmPendingDepegs`: extract secondary-source status collection and final promote/delete/keep decision into a pure decision table.
- `fetchPrimaryPrices`: split provider fetch fan-out from consensus assembly.

### Q6 - Medium - Large client components combine state, derivation, and rendering

Location:

- `src/components/contagion-graph.tsx`, `ContagionGraph`, lines 44-641
- `src/components/stablecoin-detail/hero-card.tsx`, `HeroCard`, lines 271-742
- `src/components/kpi-bar.tsx`, `KpiBar`, lines 281-614
- `src/components/command-palette.tsx`, `CommandPalette`, lines 43-445
- `src/app/yield/client.tsx`, `YieldClient`, lines 83-428
- `src/app/status/client.tsx`, `StatusClient`, lines 55-408
- `src/components/status/api-keys-panel.tsx`, `ApiKeysPanel`, lines 147-512

Problem:

These components are doing several jobs in one function: data derivation, interaction state, keyboard/pointer handling, filtering/sorting, conditional copy, and JSX rendering. Some helper models already exist nearby, which makes the remaining large components stand out as incomplete decompositions.

Why it matters:

Large client components are hard to test at the behavior boundary and easy to regress through incidental state coupling. They also make React hook dependency changes harder to review.

Concrete remediation:

Extract pure view-model hooks and focused subcomponents only where behavior changes are already being made. For example, in `ContagionGraph`, move tooltip projection and node/edge render model calculation into pure helpers tested alongside `contagion-graph-graph.test.ts`. For `ApiKeysPanel`, separate list rendering, mutation dialog state, and request execution state.

### Q7 - Medium - Portfolio and stress-test risk tools have insufficient behavioral coverage

Location:

- `src/hooks/use-portfolio.ts`, `usePortfolio`, lines 101-243
- `src/lib/portfolio-analysis.ts`, `computeUpstreamExposure`, lines 180-309
- `src/hooks/use-stress-test.ts`, `useStressTest`, lines 145-343
- Existing stress test coverage: `src/hooks/__tests__/use-stress-test.test.ts`, lines 1-20, covers only URL parsing
- Existing portfolio exposure coverage: `src/__tests__/portfolio-categorize.test.ts`, lines 83-178, covers grouping but not upstream exposure or hook behavior

Problem:

Coverage run shows low coverage on the core portfolio/stress areas: `use-portfolio.ts` about 2% line coverage, `portfolio-analysis.ts` about 31%, and `use-stress-test.ts` about 13%. Existing tests cover categorization/grouping and query parsing, not weighted portfolio scoring, persistence/URL round-trips, `computeUpstreamExposure`, or stress propagation outputs.

Why it matters:

These are analytics features where wrong output can mislead users even if the app does not crash. They also contain the data-integrity gaps in Q1 and Q2.

Concrete remediation:

Add focused pure tests first:

- `computeUpstreamExposure`: direct dependencies, no dependencies with reserves, zero-sum reserves, stablecoin reserve slices, unknown metadata.
- `usePortfolio`: storage migration, finite amount enforcement, zero draft behavior, share URL round-trip.
- `useStressTest`: targetable coin derivation, grade options, affected IDs, systemic-risk sorting, no-data states.

Then add one component-level test for the portfolio editor and one for the stress panel selection flow.

### Q8 - Medium - Oversized test suites make failures expensive to localize

Location:

- `worker/src/cron/__tests__/sync-yield-data.test.ts`, main suite, lines 320-3220
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`, main suite, lines 341-2728
- `worker/src/api/__tests__/status.test.ts`, full file, 2,511 lines
- `worker/src/cron/__tests__/enrich-prices.test.ts`, full file, 2,162 lines

Problem:

Several tests are multi-thousand-line files with broad shared setup and mutable mocks. This is not a runtime bug, but it is a test-quality smell: setup changes and fixture drift have a large blast radius.

Why it matters:

The suites cover critical systems and are valuable, but their size makes it harder to isolate failures, add edge cases, or see which behavior a fixture is proving. This increases the cost of maintaining the very tests that protect the high-risk worker paths.

Concrete remediation:

Split by behavior family without changing assertions: provider failure modes, cache publication, fallback behavior, persistence pruning, and metadata assertions. Move repeated mock builders to local test helper modules with explicit names. Preserve current tests as characterization coverage during the split.

### Q9 - Low - API fetch documentation comment contradicts strict validation behavior

Location:

- `src/lib/api.ts`, `resolveContractMode` and strict throw, lines 153-180
- `src/lib/api.ts`, `apiFetch` comment, lines 196-198
- Tests confirming current behavior: `src/lib/__tests__/api-fetch-contracts.test.ts`, lines 49-80

Problem:

The `apiFetch` comment says schema validation "warns on mismatch", but the implementation throws by default whenever a schema is supplied; warning behavior is explicit `contractMode: "warn"`.

Why it matters:

This is a small readability issue, but it misleads future callers at an important API boundary. A caller expecting graceful degradation may accidentally introduce a hard-failing route.

Concrete remediation:

Update the comment to say strict is default and `warn` is opt-in. Optionally rename `contractMode` call sites that intentionally use warning mode to make that behavior visible.

### Q10 - Low - Analytics script interpolates an environment value directly into inline JavaScript

Location:

- `src/app/layout.tsx`, GA script setup, lines 85-93

Problem:

`NEXT_PUBLIC_GA_ID` is interpolated into an inline script string:

```ts
gtag('config', '${process.env.NEXT_PUBLIC_GA_ID}');
```

The value is build-time configuration, not user input, so this is not an immediate vulnerability. Still, it is a JavaScript string construction footgun if the environment value is malformed.

Why it matters:

Inline script generation should avoid relying on human discipline for escaping. The fix is tiny and eliminates a class of avoidable script-breakage/XSS-adjacent risk.

Concrete remediation:

Serialize the value:

```ts
const gaId = process.env.NEXT_PUBLIC_GA_ID;
// ...
gtag('config', ${JSON.stringify(gaId)});
```

Optionally validate with `/^G-[A-Z0-9]+$/` before emitting the scripts.

## Security Notes

- No hardcoded live secrets were found by the local secret-pattern scan. Hits were documented examples or test fixtures.
- `npm run audit:deps -- --omit=dev` equivalent script reported 0 production vulnerabilities.
- SQL interpolation safety check passed for worker and worker scripts.
- `dangerouslySetInnerHTML` usage reviewed in `src/app/*` and components; JSON-LD injections use `safeJsonLd()`.

## Suggested Remediation Order

1. Q1, Q2, Q7: portfolio/stress data-integrity fixes plus tests.
2. Q4: harden direct DEX API JSON boundary handling and malformed-body tests.
3. Q3: strengthen curated-data schemas and data validator semantic checks.
4. Q5, Q6: opportunistic decomposition as each hotspot is touched.
5. Q8: split large suites incrementally after helper extraction.
6. Q9, Q10: quick documentation and script-escaping cleanup.
