# Stablecoin Dashboard Simplification Audit

Date: 2026-03-20
Scope: frontend (`src/`), shared runtime-neutral logic (`shared/`), worker/API (`worker/`), Pages Functions (`functions/`), and repo tooling (`scripts/`)

## 1. Executive Summary

The codebase is healthy in the sense that it already has clear top-level runtime boundaries: a static Next.js frontend in `src/`, runtime-neutral domain logic in `shared/`, and a Cloudflare Worker/D1 backend in `worker/`, with thin Pages Functions glue in `functions/`. The stack is coherent: Next 16, React 19, TanStack Query, Tailwind/shadcn, Recharts, Zod, and a Cloudflare Worker/D1 backend with no obvious overlapping dependency families doing the same job. Complexity is concentrated in `src/components` (31.7k non-test lines), `worker/src/cron` (27.1k), `worker/src/lib` (16.3k), `src/app` (15.8k), `shared/lib` (14.0k), and `worker/src/api` (11.3k).

The single biggest structural issue is repeated domain logic living in adjacent modules instead of having one clear owner. The same parsing, normalization, selection, and response-control steps are reimplemented across worker cron jobs, API routes, page clients, and "lib" modules, which means fixes tend to fan out across multiple files and layers. That also causes boundary leaks: frontend domain code depends on component modules, and worker cron code reaches into API modules.

If the recommendations below are implemented, the realistic reduction is about 7k-10k TypeScript/TSX lines, or roughly 6-8% of non-test executable code. The reduction is larger if the static stablecoin registries are moved out of executable TypeScript into checked-in data assets.

## 2. Findings Table

| # | Category | Location | Description | Impact | Effort |
|---|----------|----------|-------------|--------|--------|
| 1 | Duplication | `worker/src/cron/dex-discovery/crawl-sources.ts`, `worker/src/cron/dex-liquidity/fetch-crawlers.ts`, `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`, `worker/src/cron/dex-liquidity/fetch-primary.ts` | DEX pool parsing, orderbook aggregation, and token-price observation mapping are duplicated across discovery and liquidity pipelines | High | High |
| 2 | Duplication | `worker/src/api/telegram-webhook.ts` | Subscribe/unsubscribe/set flows repeat the same coin-resolution and disambiguation state machine | High | Medium |
| 3 | Structural redundancy | `worker/src/route-registry.ts`, many `worker/src/api/*.ts` | Error handling is owned in two places: many handlers are wrapped with `withErrorHandler()` in their module and then wrapped again in the route registry | Medium | Low |
| 4 | Accidental complexity | `src/lib/status-dashboard-model.ts`, `src/lib/compare-config.ts`, `src/hooks/use-compare-selection.ts`, `worker/src/cron/status-self-check.ts`, `worker/src/api/status.ts` | Domain logic crosses layer boundaries: lib code imports component modules and cron code imports API modules | Medium | Medium |
| 5 | Dead code | `src/hooks/use-copy-to-clipboard.ts`, `src/hooks/use-stress-signals.ts`, `docs/architecture.md`, `docs/dews.md` | Unused hooks and compatibility shims remain in tree, and docs still point at the obsolete DEWS hook path | Medium | Low |
| 6 | Duplication | `src/app/stablecoin/[id]/page.tsx`, `src/components/pre-launch-detail.tsx` | The "related stablecoins" similarity-scoring logic is duplicated in two stablecoin-detail entry paths | Low | Low |
| 7 | Duplication | `src/components/compare-empty-state.tsx`, `src/components/portfolio-empty-state.tsx` | Preset cards repeat the same card shell, logo strip, chip list, and keyboard-click plumbing with only data-shape differences | Low | Low |
| 8 | Duplication | `src/components/stablecoin-detail/hero-card.tsx`, `src/components/cemetery-charts.tsx` | Large responsive/chart components contain self-duplication instead of sharing small substructures | Medium | Medium |
| 9 | Structural/data complexity | `shared/lib/stablecoins/*`, `shared/lib/dead-stablecoins.ts` | Large static registries are encoded as executable TypeScript, inflating hot files and review noise | Medium | Medium |

## 3. Detailed Recommendations

### 1. Consolidate duplicated DEX crawling and normalization logic

**What exists now**

- GeckoTerminal pool parsing is duplicated between discovery and liquidity crawlers:
  - `worker/src/cron/dex-discovery/crawl-sources.ts` around the `parseGtPool` / `buildNewPool` usage and staged-pool assembly
  - `worker/src/cron/dex-liquidity/fetch-crawlers.ts` around the matching `parseGtPool` / `buildNewPool` usage
- CoinGecko orderbook ticker aggregation is duplicated:
  - `worker/src/cron/dex-discovery/crawl-sources.ts`
  - `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- Token-price observation mapping is duplicated in multiple subgraph batch paths:
  - `worker/src/cron/dex-liquidity/fetch-primary.ts`

**What is wrong**

The duplication is not just presentational. It is domain logic: source normalization, plausibility checks, pool identity mapping, and synthetic TVL/price construction. Any change to DEX quality, price plausibility, token resolution, or source-family semantics now requires synchronized edits across multiple files. This is a classic regression surface: discovery and liquidity can silently diverge while both still "work."

**What to do**

Pick a single owner for each concern and collapse the copies:

- Create one shared GeckoTerminal/CoinGecko pool-normalization helper used by both discovery and liquidity.
- Create one shared "aggregate CoinGecko tickers by exchange" helper used by discovery and liquidity fallback code.
- Create one shared "map priced token candidates to stablecoin observations" helper used by the repeated `fetch-primary.ts` branches.
- Keep the differences as parameters only: protocol name, identity builder inputs, minimum TVL, and whether staged pools or price observations are emitted.

This should reduce code in four files and make future DEX-source changes one-edit instead of many-edit work.

**What to watch out for**

- Discovery and liquidity do not produce identical outputs; avoid an abstraction that hides the actual emitted shape.
- Preserve current request pacing and connection-budget behavior from `docs/worker-and-api-limits.md`.
- Keep logs source-specific; shared helpers should accept a label rather than hardcoding one.

### 2. Collapse Telegram webhook disambiguation into one action runner

**What exists now**

- `worker/src/api/telegram-webhook.ts` repeats the same resolution flow for `subscribe`, `unsubscribe`, and `set`:
  - resolve tickers
  - handle `not_found`
  - handle `ambiguous`
  - persist pending disambiguation
  - execute the final action
- The same resolution pattern appears both in the initial command handlers and again in the pending-selection continuation path.

**What is wrong**

This file is already large, and the duplicated branches are state-machine code, not harmless view duplication. Bug fixes in ticker resolution, pending-state persistence, or message generation can easily land in one path and miss another. The existing jscpd result already flags this file.

**What to do**

- Extract a single "resolve or persist pending action" function that returns one of:
  - `not_found`
  - `ambiguous`
  - `complete`
- Make action-specific behavior injectable:
  - how to persist pending payload
  - what to execute on completion
  - which success message to return
- Keep the action verbs explicit; do not build a generic command framework. Three concrete cases are enough.

**What to watch out for**

- Preserve `subscribe`-specific alert-type payloads and `set`-specific command payloads.
- Do not break `/cancel` and pending TTL semantics.
- Keep messaging output stable enough for existing tests.

### 3. Remove double `withErrorHandler()` ownership in the worker

**What exists now**

- Many API modules already export wrapped handlers, for example:
  - `worker/src/api/blacklist.ts`
  - `worker/src/api/depeg-events.ts`
  - `worker/src/api/status.ts`
  - `worker/src/api/report-cards.ts`
  - `worker/src/api/dex-liquidity.ts`
- `worker/src/route-registry.ts` then wraps many of those handlers again with `withErrorHandler()`.
- Other handlers, such as `worker/src/api/chains.ts`, are not wrapped at module level and rely on the registry wrapper instead.

**What is wrong**

The error boundary has no single owner. That creates redundant try/catch layers, inconsistent logging behavior, and extra noise when tracing request execution. This is structural redundancy with no product value.

**What to do**

Standardize on one pattern:

- Preferred: route/router owns the error boundary, handlers export plain async functions.
- Acceptable alternative: handlers own the boundary, and the registry stops wrapping already-safe handlers.

Whichever pattern you choose, apply it everywhere. Do not keep the current mixed state.

**What to watch out for**

- Dynamic routes in `worker/src/router.ts` must still pass through the same single error boundary.
- Preserve endpoint-specific error labels in logs.
- Re-run API contract tests after the cleanup; behavior should not change.

### 4. Restore clean layer boundaries in frontend and worker

**What exists now**

- `src/lib/status-dashboard-model.ts` imports:
  - `src/components/status/action-recommendations.ts`
  - `src/components/status/cron-config.ts`
- `src/lib/compare-config.ts` imports types from:
  - `src/components/coin-selector.tsx`
  - `src/components/compare-empty-state.tsx`
- `src/hooks/use-compare-selection.ts` also depends on the component-owned `CoinOption` type.
- `worker/src/cron/status-self-check.ts` imports `evaluateStatusAndPersist` from `worker/src/api/status.ts`.

**What is wrong**

These are inverted dependencies. A folder named `lib` is supposed to be usable by components, not coupled back to component files. A cron job importing an API module is the same smell on the backend. This makes it harder to tell where the domain model actually lives and increases the risk of circular or hidden coupling.

**What to do**

- Move status-page domain helpers (`deriveStatusActionRecommendations`, cron display metadata) out of `src/components/status/` into `src/lib/status/`.
- Move shared compare types like `CoinOption` and `ComparePreset` into `src/lib/compare-types.ts` or `shared/types` if they become runtime-neutral.
- Move `evaluateStatusAndPersist` out of `worker/src/api/status.ts` into `worker/src/lib/status-evaluation.ts` or similar, then let both API and cron import that.

This is mostly relocation and type ownership cleanup, not behavior change.

**What to watch out for**

- Keep frontend-only code out of `shared/`.
- Do not move UI-only strings or classnames into worker/shared.
- Preserve current test imports to avoid churn larger than necessary.

### 5. Delete unused hooks and remove the docs drift they leave behind

**What exists now**

- `src/hooks/use-copy-to-clipboard.ts` has no repo usage.
- `src/hooks/use-stress-signals.ts` is an unused compatibility re-export; live code imports from `src/hooks/api-hooks.ts` instead.
- Docs still reference the obsolete DEWS hook path:
  - `docs/architecture.md`
  - `docs/dews.md`

**What is wrong**

These files look active because they sit in normal source locations, but they add maintenance surface without serving production code. Worse, the docs keep the obsolete path alive in readers' heads, so new code is more likely to follow the wrong entry point.

**What to do**

- Delete `src/hooks/use-copy-to-clipboard.ts` unless a real caller is added.
- Delete `src/hooks/use-stress-signals.ts` and update the docs to point to `src/hooks/api-hooks.ts`.
- If backward compatibility is still desired for external callers, that should be handled at the import site documentation level, not as an unused source shim.

**What to watch out for**

- Search docs, historical notes, and code comments before deletion.
- If the copy hook is meant to return soon, move it to a task/spec instead of leaving it as dormant source.

### 6. Extract one shared related-stablecoin scoring helper

**What exists now**

- `src/app/stablecoin/[id]/page.tsx` defines `getRelatedStablecoins()`.
- `src/components/pre-launch-detail.tsx` defines `getRelatedActiveCoins()`.
- Both functions score candidates the same way:
  - same governance = +3
  - same backing = +2
  - same peg = +1

**What is wrong**

This is small, but it is a domain rule duplicated across the two stablecoin-detail entry paths. If the ranking logic changes, the pre-launch page and live detail page can drift.

**What to do**

- Move the scoring helper to `src/lib/stablecoin-taxonomy.ts` or `src/lib/related-stablecoins.ts`.
- Reuse it from both the live-detail and pre-launch-detail paths.

**What to watch out for**

- Keep the helper frontend-only; it depends on tracked metadata, not worker logic.
- Preserve output ordering so related-coin sections do not churn unexpectedly.

### 7. Merge the compare and portfolio preset-card patterns

**What exists now**

- `src/components/compare-empty-state.tsx` and `src/components/portfolio-empty-state.tsx` each implement:
  - clickable card shell
  - keyboard activation
  - logo strip
  - chip list
  - short explanatory footer copy

**What is wrong**

The two components solve the same presentational problem with slightly different payload shapes. This is exactly the kind of repeated UI pattern that becomes annoying to restyle or make accessible later.

**What to do**

- Extract one small preset-card component that accepts:
  - title
  - description
  - preview coin IDs
  - chip nodes
  - footer copy
  - click handler
- Keep page-specific wrappers for the data shaping.

**What to watch out for**

- Do not over-generalize beyond these two cases.
- Preserve the featured-card variant used by compare presets.

### 8. Remove self-duplication inside high-traffic components

**What exists now**

- `src/components/stablecoin-detail/hero-card.tsx` duplicates title, price, and metric-card markup between mobile and desktop sections.
- `src/components/cemetery-charts.tsx` duplicates the same donut-chart scaffolding twice for count vs peak market cap.

**What is wrong**

These are not catastrophic, but they create noisy files where visual changes require touching two nearly identical blocks. The hero card is especially important because it is a primary user-facing surface and already a large file.

**What to do**

- In `hero-card.tsx`, factor out the repeated title block, price block, and metric-card content into tiny local subcomponents and let layout containers vary by breakpoint.
- In `cemetery-charts.tsx`, replace the two donut implementations with one `CauseOfDeathDonut` that accepts the prepared dataset and value formatter.

**What to watch out for**

- Keep the final markup stable for snapshot/component tests.
- Avoid a broad design rewrite; this is a deletion refactor, not a visual change.

### 9. Move large static registries out of executable TypeScript

**What exists now**

- The biggest files in the repo are data-heavy registry modules:
  - `shared/lib/stablecoins/usd-minor.ts`
  - `shared/lib/stablecoins/usd-major.ts`
  - `shared/lib/stablecoins/non-usd.ts`
  - `shared/lib/dead-stablecoins.ts`
- `shared/lib/stablecoins/index.ts` then reconstructs canonical ordering and lookup maps from those modules.

**What is wrong**

These files are mostly content, but because they are encoded as executable TS they:

- inflate code-search noise
- slow review of metadata-only changes
- make merge conflicts more painful
- make the "code volume" look larger than the real logic volume

**What to do**

- Move the raw registry data to checked-in JSON/TSV/YAML assets under `data/` or `shared/data/`.
- Keep a thin typed loader/factory in `shared/lib/stablecoins/index.ts` to build `TRACKED_STABLECOINS`, `ACTIVE_STABLECOINS`, and maps.
- Preserve the current canonical order explicitly in data, not in a long TS string array if possible.

**What to watch out for**

- Preserve type validation at load time.
- Keep comments/metadata provenance somewhere reviewable if they are useful.
- If any runtime consumers depend on functions embedded in the current TS objects, do not move those parts blindly.

## 4. Prioritized Action Plan

### Tier 1 - Quick wins

- Remove dead hooks and docs drift:
  - delete `src/hooks/use-copy-to-clipboard.ts`
  - delete `src/hooks/use-stress-signals.ts`
  - update `docs/architecture.md` and `docs/dews.md`
- Extract one shared related-stablecoin scoring helper and reuse it in both detail entry paths.
- Merge the compare/portfolio preset-card shell into one small shared component.
- Remove self-duplication in `src/components/cemetery-charts.tsx`.
- Standardize worker error handling so `withErrorHandler()` is owned in one place only.

### Tier 2 - High-value refactors

- Collapse Telegram webhook disambiguation into one action-resolution runner.
- Clean layer inversions:
  - move status dashboard domain helpers out of `src/components/status/`
  - move compare shared types out of component files
  - move `evaluateStatusAndPersist` out of `worker/src/api/status.ts`
- Reduce `src/components/stablecoin-detail/hero-card.tsx` by extracting shared responsive substructures.

### Tier 3 - Structural improvements

- Consolidate DEX crawling/normalization helpers so discovery and liquidity share the same source-specific logic.
- Move large static registries out of executable TypeScript and keep typed loaders thin.

### Defer or skip

- Do not aggressively abstract the page shells already handled by `createClientFeaturePage()` and `createPageError()`. Those abstractions are paying rent.
- Do not chase the small comparator maps in the table-logic files. They are repetitive, but they are also direct and readable.
- Do not reorganize reserve adapters purely for symmetry. They are adapter-shaped by nature and already isolated enough.
