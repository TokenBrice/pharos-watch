# Structural Simplification Refactoring Plan

Date: 2026-04-14

Scope: read-only simplification, deduplication, and structural-elegance audit of `/home/ahirice/Documents/git/stablecoin-dashboard`.

## Assumptions

- This audit should not change product behavior or source code.
- Functional, tested provider-specific complexity is acceptable when the provider semantics are genuinely different.
- A recommendation should delete code, reduce repeated code, or at least hold total line count roughly constant while making the code easier to reason about.
- Existing validated docs are the source of architectural intent.

## Survey

High-level architecture:

- `src/app/`: Next.js static-export routes and route clients.
- `src/components/`: reusable UI, app-specific tables/charts/cards, and `ui/` shadcn primitives.
- `src/hooks/`: TanStack Query wrappers, query/view-model hooks, and browser state helpers.
- `src/lib/`: frontend-only utilities and presentation models.
- `shared/lib/` and `shared/types/`: runtime-neutral registries, scoring logic, endpoint descriptors, stablecoin metadata, schemas, and constants.
- `worker/src/api/`: Cloudflare Worker HTTP handlers.
- `worker/src/cron/`: scheduled pipelines and provider ingestion.
- `worker/src/lib/`: Worker runtime helpers, storage, auth, cache, provider, and scoring utilities.
- `worker/src/routes/` and `worker/src/handlers/`: Worker routing, access gates, CORS, request attribution, and scheduled-trigger dispatch.
- `functions/`: Cloudflare Pages Functions proxies for `/_site-data/*` and ops-admin traffic.
- `scripts/`: validation, build, deployment, SEO, doc-sync, and guardrail tooling.

Module volume measured across TS/TSX/JS/MJS/CSS/JSON/MD/SQL/TOML-like files, including tests and data:

| Area | Files | Lines |
| --- | ---: | ---: |
| `worker/src` | 807 | 168,191 |
| `src` | 658 | 91,592 |
| `shared` | 172 | 44,856 |
| `docs` | 59 | 19,951 |
| `scripts` | 57 | 8,507 |
| `functions` | 16 | 1,695 |
| `data` | 3 | 1,483 |

Runtime complexity concentration:

| Area | Files | Lines |
| --- | ---: | ---: |
| `worker/src/cron` | 351 | 84,325 |
| `worker/src/lib` | 273 | 49,588 |
| `src/components` | 290 | 44,636 |
| `worker/src/api` | 137 | 30,338 |
| `shared/lib` | 145 | 21,638 |
| `src/app` | 152 | 20,469 |
| `src/lib` | 125 | 16,831 |
| `src/hooks` | 74 | 6,422 |

Stack and dependency surface:

- Frontend: Next.js 16 static export, React 19, Tailwind 4, Radix/shadcn, TanStack Query, TanStack Virtual, Recharts, D3 force layout, Lucide.
- Worker/API: Cloudflare Worker, Pages Functions, D1, Wrangler, Satori/Resvg for OG images, Viem for selected chain calls.
- Validation/tooling: TypeScript, ESLint, Vitest, Zod, custom guardrail scripts.
- Dependency redundancy finding: no obvious overlapping package dependencies serving the same role. Recharts and D3-force serve distinct charting vs graph-layout roles; TanStack Virtual has a concrete use in the large stablecoin table; `react-tweet`, `cmdk`, and `html-to-image` are narrow but used.

Local guardrail checks run:

- `npm run check:unused-code`: passed, no dead internal modules or unused named exports found.
- `npm run check:duplicate-exports`: passed.
- `npm run check:shared-cycles`: passed for `shared`, `worker/src`, and `src`.
- `npm run check:worker-boundary`: passed.
- `npm run check:hotspot-ratchet`: passed.

## 1. Executive Summary

The codebase is healthy for its size: core runtime boundaries are documented, endpoint and cron metadata have real single-source registries, and structural guardrails catch dead code, cycles, duplicate exports, and worker/frontend boundary violations. The biggest structural issue is that some policy-rich modules still mix provider fan-in, trust decisions, state mutation, result shaping, and telemetry in one place, especially the primary pricing path and pricing-source registry data. The highest-value simplification is not package removal; it is deleting repeated policy boilerplate and converging onto the registries and helpers the repo already owns. A realistic full-plan reduction is about 500-800 production LOC before tests, or roughly 350-650 net LOC after focused tests are added.

## 2. Findings Table

| # | Category | Location | Description | Impact | Effort |
|---|---|---|---|---|---|
| 1 | Accidental complexity | `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | `fetchPrimaryPrices()` mixes candidate discovery, circuit checks, provider fetch fan-out, outcome recording, quote assembly, consensus, post-consensus hardening, and stats mutation. | High | Medium |
| 2 | Duplication | `shared/lib/pricing-source-registry-*.ts` | Pricing-source entries repeat the same capability/default flag blocks across soft aggregator, soft DEX, fallback search, hard market, hard oracle, and hard protocol sources. | High | Medium |
| 3 | Duplication | `worker/src/api/backfill-depegs.ts`, `worker/src/api/backfill-stability-index.ts`, `worker/src/api/backfill-dews.ts` | Admin backfill day-window parsing and validation is repeated around the shared `parseDayParam()` primitive. | Medium | Low |
| 4 | Parallel definitions | `shared/types/core.ts`, `shared/lib/stablecoins/schema.ts` | Stablecoin metadata types and asset schemas describe the same entities with duplicated enum value lists and field definitions. | Medium | Medium |
| 5 | Accidental complexity | `src/components/stablecoin-table.tsx` | The main table still owns query-derived view state, column preferences, virtual scrolling, header rendering, row rendering, empty state, and export actions in one 700-line component. | Medium | Medium |
| 6 | Layer elimination | `worker/src/lib/live-reserves-store-parsing.ts`, `worker/src/lib/live-reserves-store-records.ts`, `worker/src/lib/live-reserves-store-view.ts` | Tiny re-export shims add import indirection inside the live-reserve store boundary without meaningful separation. | Low | Low |
| 7 | Duplication | `worker/src/cron/reserve-adapters/*transparency.ts`, `re-metrics.ts`, `sgforge-coinvertible.ts` | HTML reserve adapters repeat `requireHtmlInput(config.inputs.primary, adapter)` plus `fetchTextWithRetry(input.url, signal, 15_000, ctx)`. | Low | Low |
| 8 | Inconsistent patterns | `src/hooks/use-compare-data-model.ts`, `src/hooks/use-stablecoin-reserves.ts`, `src/hooks/use-api-query.ts` | Most polling hooks use shared query helpers, but compare/reserves still carry manual URL construction or local interval literals. | Medium | Low |
| 9 | Inconsistent patterns | `src/components/blacklist-chart.tsx`, `src/components/blacklist-status-charts.tsx`, `src/components/chart-primitives.tsx` | Chart axis/grid defaults are partly centralized, but several charts still inline the same Recharts tick/grid config. | Low | Low |
| 10 | Defer/low-value duplication | `src/app/methodology/sections/**` | Methodology content repeats facts/preconditions blocks and desktop/mobile diagram markup; real, but mostly content-heavy and low operational risk. | Low | Medium |

## 3. Detailed Recommendations

### 1. Split and simplify primary pricing provider fan-in

What exists now:

- `fetchPrimaryPrices()` begins at `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:94`.
- It computes candidates and circuit state at lines 116-158.
- It owns provider fetch fan-out and repeated `try`/`catch`/`recordOutcome()` blocks at lines 206-423.
- It assembles per-asset quote bundles, runs consensus, mutates stats, and logs disagreements at lines 433-560.
- It then applies post-consensus pool hardening and soft-only flags at lines 547-558 and continues into additional passes later in the file.

What is wrong:

- The same function is doing orchestration, provider transport, trust policy, consensus materialization, telemetry, and stats accounting.
- Provider fetches repeat an error-handling pattern: check abort, log provider-specific failure, and record the circuit outcome.
- The result is hard to review safely because a small provider change requires holding the whole pricing decision path in memory.

What to do:

- Keep the same file boundary for the first pass, but carve the function into local pure/near-pure phases:
  - `buildPrimaryPricePlan()` for candidates, symbols, feed IDs, source maps, and allowed circuits.
  - `collectPrimaryQuoteMaps()` for provider fetches and circuit outcome recording.
  - `buildPrimaryConsensusResults()` for the per-asset `PrimaryCollectedQuotes`, `buildPrimarySourceCandidates()`, `computePriceConsensus()`, and stat updates.
  - `applyPrimaryPostConsensusHardening()` for DefiLlama-list single-source downgrades, pool challenger hardening, and soft-only tagging.
- Add a small local helper for provider fetches with this shape: run body, treat abort as fatal, log non-abort errors, record `recordOutcome(db, source, success)`. Use it for CoinGecko ticker, Pyth, Binance, Kraken, Bitstamp, Coinbase, RedStone, and Curve. Keep CoinGecko simple-price batching custom because it has stale-row filtering and partial batch failure semantics.
- Do not introduce a generic provider framework. Keep the helper local and delete it if the provider set shrinks below three concrete uses.

What to watch out for:

- Preserve aborted-signal behavior exactly; current code rethrows aborts.
- Preserve CoinGecko stale-row filtering, CG ticker `successfulResponses > 0`, and Curve oracle best-effort behavior, which currently has no circuit outcome.
- Run `worker/src/cron/__tests__/sync-stablecoins.test.ts`, `worker/src/cron/__tests__/enrich-prices.test.ts`, pricing provider audit, and critical contracts after implementation.

### 2. Replace repeated pricing-source flag blocks with local source presets

What exists now:

- Soft aggregator entries repeat capability defaults in `shared/lib/pricing-source-registry-aggregators.ts:3-102`.
- Soft DEX and fallback-search entries repeat the same flag surfaces in `shared/lib/pricing-source-registry-dex-search.ts:3-156`.
- Hard market/oracle/protocol entries repeat similar defaults in `shared/lib/pricing-source-registry-market-feeds.ts:3-230`.

What is wrong:

- The registry is the right source of truth, but each entry restates many policy defaults that are implied by its family or trust tier.
- Adding a source currently invites copy/paste of 10-15 booleans, raising the chance of a stale or contradictory flag.

What to do:

- Add a local `definePricingSource()` or family-specific preset helpers in the pricing-source registry module family, not a global framework.
- Keep required fields explicit: `key`, `label`, `shortLabel`, `trustTier`, `freshnessKind`, `maxTrustedAgeSec`, `defaultWeight`, and true semantic exceptions.
- Encode defaults for common families:
  - soft aggregator/default soft source
  - soft DEX
  - fallback search
  - hard market
  - hard oracle
  - hard protocol
  - cached replay
- Convert entries to sparse overrides, preserving all current effective values.

What to watch out for:

- This is methodology-sensitive. Snapshot the effective `PRICING_SOURCE_REGISTRY` before and after and assert deep equality in a focused test.
- Avoid deriving behavior purely from `trustTier` if an existing source is an exception; use explicit family preset names or explicit overrides.

### 3. Centralize admin backfill day-window parsing

What exists now:

- Shared primitives exist in `worker/src/api/backfill-depegs-window.ts:19-63`.
- `handleBackfillDepegs()` repeats start/end/context-day validation at `worker/src/api/backfill-depegs.ts:79-108`.
- `handleBackfillStabilityIndex()` repeats start/end parsing and invalid-date response at `worker/src/api/backfill-stability-index.ts:64-76`.
- `handlePruneHistoryRepair()` repeats another variant at `worker/src/api/backfill-dews.ts:237-252`.

What is wrong:

- The same admin query contract has three response variants and slightly different error messages.
- Future repairs can drift on milliseconds-vs-seconds parsing, defaulting, or `startDay <= endDay` behavior.

What to do:

- Add `parseOptionalDayWindow(url, options)` in `backfill-depegs-window.ts`.
- Return either `{ startDay, endDay, hasExplicitWindow, usedDefaultWindow, replayWindow? }` or a `Response`.
- Let callers pass bounds/defaults:
  - backfill-depegs: nullable start/end and optional `contextDays`.
  - stability-index: clamp to earliest/latest completed days and allow the existing zero-work response when the clamped range is empty.
  - DEWS prune: default to `DEWS_TRUST_REPAIR_WINDOW_START_DAY` and today.
- Delete local date validation blocks after callers adopt the helper.

What to watch out for:

- Keep the existing stability-index "no completed UTC days" success response; do not turn that case into a 400.
- Keep the `contextDays` validation range from `MAX_BACKFILL_REPLAY_CONTEXT_DAYS`.

### 4. Reduce parallel stablecoin metadata type/schema drift

What exists now:

- `StablecoinMeta` and supporting types live as TypeScript interfaces/unions in `shared/types/core.ts:11-180` and beyond.
- The stablecoin data Zod schema restates many value lists and fields in `shared/lib/stablecoins/schema.ts:16-180`.
- Some value arrays are already reused from `shared/types/core.ts`, but backing, peg currency, proof-of-reserves, notice type, launch phase, featured content type, status, and cause-of-death values are local to the schema.

What is wrong:

- This is a classic parallel type/schema surface: TypeScript can say a field or enum exists while the JSON validator encodes a different list.
- Because the stablecoin data files are large and business-critical, drift here is costly to diagnose.

What to do:

- First low-risk pass: export value arrays and Zod enums for the missing local lists from `shared/types/core.ts` or a nearby runtime-neutral metadata-values module, then import them into `shared/lib/stablecoins/schema.ts`.
- Avoid a big-bang conversion of `StablecoinMeta` to `z.infer<typeof StablecoinMetaAssetSchema>` until after the value-list duplication is gone and tests are stable.
- Add or extend a test that asserts the schema accepts a minimal object for each exported literal group if that coverage is not already present.

What to watch out for:

- `StablecoinMeta` is widely imported; do not destabilize it for a minor deletion win.
- `DeadStablecoin` belongs to the data validation surface too, but it has a different lifecycle than active stablecoin metadata.

### 5. Split the virtualized stablecoin table by responsibility

What exists now:

- `src/components/stablecoin-table.tsx` owns sort/preference state at lines 196-258, virtualizer state at lines 271-287, table chrome at lines 314-359, row rendering at lines 365-604, and empty-state rendering at lines 612-681.
- `src/components/stablecoin-table-logic.ts` already holds filtering, sorting, and CSV export logic.
- Shared table primitives exist in `src/components/sortable-table-head.tsx`, `src/components/table-toolbar.tsx`, and `src/components/table-pagination.tsx`.

What is wrong:

- The row renderer is large enough that small presentational changes are risky to review.
- The component is the only large table that must remain virtualized, but it still does not need to own every cell and empty-state branch inline.

What to do:

- Keep virtualization local; do not force this table into `DataTableShell`.
- Extract a `StablecoinVirtualRow` component receiving only `coin`, `index`, `visibleSet` or `isVisible`, format/context props, and row actions.
- Extract `StablecoinTableEmptyState` with the existing clear/search/filter/popular-coin behavior.
- Move `getRowRiskLevel()` and cell-level badge label formatting into `stablecoin-table-logic.ts` if it stays pure.

What to watch out for:

- The row `role="link"`, keyboard handling, `stopPropagation()` on the nested `Link`, prefetch behavior, row height, and virtual padding rows are all behavioral details.
- This may hold total LOC roughly constant on the first pass; the value is reducing the main file's change surface.

### 6. Delete live-reserve store re-export shims

What exists now:

- `worker/src/lib/live-reserves-store.ts` is the intended public barrel.
- `worker/src/lib/live-reserves-store-parsing.ts` is two re-export lines.
- `worker/src/lib/live-reserves-store-records.ts` is two re-export lines.
- `worker/src/lib/live-reserves-store-view.ts` is seven re-export lines.
- Internal modules import through those shims, for example `worker/src/lib/live-reserves-store-response.ts:14`.

What is wrong:

- These files add another name for the same functions without hiding implementation detail. The names also imply separate layers that are not present.

What to do:

- Update internal imports to point directly at `live-reserves-store-row-decoding.ts`, `live-reserves-store-legacy.ts`, or `live-reserves-store-overview.ts`.
- Keep the top-level `live-reserves-store.ts` public barrel.
- Delete the three shim files once internal imports no longer need them.

What to watch out for:

- External callers should continue to import through `worker/src/lib/live-reserves-store.ts`; do not spread internal implementation imports outside the live-reserves-store boundary.

### 7. Add a reserve-adapter helper for primary HTML fetches

What exists now:

- `fetchCircleReserves()` repeats HTML input/fetch boilerplate at `worker/src/cron/reserve-adapters/circle-transparency.ts:135-141`.
- The same pattern appears in `fdusd-transparency.ts:86-92`, `re-metrics.ts:277-283`, and `sgforge-coinvertible.ts:111-117`.
- `fetchTextWithRetry()` already owns cached text fetch behavior in `worker/src/cron/reserve-adapters/request.ts:132-161`.

What is wrong:

- Adapter fetch wrappers become noisy even when the adapter's real work is parsing/normalizing the disclosure.

What to do:

- Add `fetchPrimaryHtmlInput(config, adapterName, signal, ctx, timeoutMs = 15_000)` next to the other reserve adapter helpers.
- Replace the four identical 15-second patterns first.
- Optionally convert `mento.ts` and `usdai-proof-of-reserves.ts` only if the timeout and input semantics match.

What to watch out for:

- Do not hide adapters that intentionally fetch a non-primary input or use a different timeout.
- Preserve request-cache keys because `fetchTextWithRetry()` currently caches by URL and timeout.

### 8. Bring compare/reserve query hooks back to the shared polling pattern

What exists now:

- Shared polling policy is encoded in `createPollingQueryOptions()` at `src/hooks/use-api-query.ts:51-66`.
- `useCompareDataModel()` builds two `useQueries()` arrays manually at `src/hooks/use-compare-data-model.ts:99-121`; one path hardcodes `/api/mint-burn-flows?...` instead of `API_PATHS.mintBurnFlows()`.
- `useStablecoinReserves()` derives live polling from a literal `3_600_000` at `src/hooks/use-stablecoin-reserves.ts:9-14`.

What is wrong:

- The repo has a stale-time rule (`staleTime = cron interval`, `refetchInterval = 2x cron interval`), but `useCompareDataModel()` only sets `staleTime`.
- Manual URL construction bypasses the endpoint path helpers that the rest of the app uses.

What to do:

- Replace the mint/burn path string in `useCompareDataModel()` with `API_PATHS.mintBurnFlows({ stablecoin: id, hours: flowHours })`.
- Use `createApiQueryFn()` where no custom parser is needed.
- Add `refetchInterval: 2 * CRON_1H` and `2 * CRON_20MIN` for the compare `useQueries()` entries, or add a tiny `createPollingUseQueryOptions()` helper only if multiple `useQueries()` call sites need it.
- Replace `RESERVES_CRON_INTERVAL = 3_600_000` with `CRON_1H` from `src/lib/cron-intervals.ts`.

What to watch out for:

- `useStablecoinReserves()` intentionally has fallback/live-stale short polling. Preserve `FALLBACK_STALE_TIME` and `FALLBACK_REFETCH_INTERVAL`.
- `useCompareDataModel()` fetches per-selected-coin data; avoid introducing new queries when `selectedIds` is empty.

### 9. Extend existing chart primitives to non-time categorical charts where it deletes config

What exists now:

- Chart primitives provide shared axis/grid/tooltip defaults in `src/components/chart-primitives.tsx:7-103`.
- Several time-series charts already use them.
- `blacklist-chart.tsx:118-143` and `blacklist-status-charts.tsx:76-97` still inline the same monotone tick font, axis line, tick line, and grid style for categorical charts.

What is wrong:

- The axis visual language is centralized for time-series charts but repeated for simple categorical charts.

What to do:

- Add a `CategoricalXAxis` primitive only if at least two categorical charts can use it immediately.
- Use existing `MonoYAxis` and `TimeGrid` or rename `TimeGrid` to a neutral `ChartGrid` if the semantics are no longer time-specific.
- Convert `blacklist-chart` and `blacklist-status-charts` first; leave complex multi-axis cemetery charts for later unless the conversion is mechanical.

What to watch out for:

- Some charts need angled labels, wider y-axis widths, or dual axes. Keep those as explicit props, not hidden defaults.

### 10. Defer methodology content cleanup unless touching those sections anyway

What exists now:

- Methodology helper components exist in `src/app/methodology/methodology-shared.tsx:94-150`.
- Sections repeatedly render `MethodologyFacts` then a "Preconditions & Failure Modes" block; one example is `src/app/methodology/sections/core/safety-scores-section.tsx:34-53`.
- The safety-score section duplicates desktop/mobile diagram markup at `src/app/methodology/sections/core/safety-scores-section.tsx:65-152`.

What is wrong:

- This is real repetition, but it is mostly long-form public content rather than operational logic.
- Over-abstracting prose can make content harder to edit and review.

What to do:

- Defer broad methodology cleanup.
- When a methodology section is already being edited, introduce a small `MethodologyPreconditions` helper and a data-driven diagram component only for the current section.
- Do not build a generic methodology DSL.

What to watch out for:

- Methodology pages have versioning and doc-sync implications. Any content change must preserve methodology version rules and corresponding timeline/changelog docs.

## 4. Prioritized Action Plan

### Tier 1 - Quick wins

1. Delete live-reserve store shim files after direct internal import updates.
2. Centralize admin backfill day-window parsing in `backfill-depegs-window.ts`.
3. Replace compare mint/burn raw URL construction with `API_PATHS.mintBurnFlows()` and add missing compare-query `refetchInterval`s.
4. Replace the reserve hook's `3_600_000` literal with `CRON_1H` while preserving fallback short polling.
5. Add and use `fetchPrimaryHtmlInput()` for the four identical reserve HTML adapters.
6. Convert the two simple blacklist chart axis blocks to existing/new chart primitives.

### Tier 2 - High-value refactors

1. Add pricing-source registry presets/default helpers and assert effective registry equality.
2. Split `fetchPrimaryPrices()` into plan, collection, consensus, and post-consensus hardening phases; add a local provider outcome helper for repeated fetch blocks.
3. Extract `StablecoinVirtualRow` and `StablecoinTableEmptyState` from `stablecoin-table.tsx`.

### Tier 3 - Structural improvements

1. Reduce stablecoin metadata type/schema drift by exporting missing value arrays from the runtime-neutral type layer and importing them into the Zod asset schema.
2. Consider a later, test-first conversion of more `StablecoinMeta` subtypes to schema-derived types only after the value-list cleanup proves stable.

### Defer or skip

1. Broad methodology-page abstraction: defer unless a section is already being edited.
2. Provider-specific reserve adapters: keep adapter-specific parsing local unless two or more adapters share a concrete transport/normalization step.
3. Large DEX liquidity and mint/burn coordinator splits: real simplification targets, but already covered by deeper module-level audits; handle in dedicated, test-heavy tranches rather than mixing into quick dedup work.
4. Package dependency removal: no obvious redundant dependency is currently worth removing from this audit alone.

