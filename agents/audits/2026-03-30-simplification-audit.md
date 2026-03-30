# Simplification Audit - 2026-03-30

## 1. Executive Summary

The codebase is fundamentally healthy: boundaries are documented, shared runtime-neutral logic is mostly respected, and the repo already contains guardrails for unused code, hotspot growth, duplicate exports, and doc drift. The main complexity concentration is real rather than accidental bloat: `worker/src` carries the majority of business and integration logic, while a smaller set of large frontend route shells own too much state derivation and rendering at once.

The single biggest structural issue is endpoint and route orchestration spread across parallel registries. A new API route currently touches shared endpoint metadata, worker handler wiring, dynamic matching rules, and dependency hydration, which increases ceremony, raises the chance of drift, and makes the HTTP surface harder to reason about than the underlying handlers themselves.

Runtime code volume is about 188k LOC across 1,027 runtime files. Most of it sits in `worker/src` (~77k LOC), `src/components` (~36k), `src/app` (~18k), and `shared/lib` (~13k). If the recommendations below are implemented cleanly, a realistic reduction is about 5-8% of runtime LOC, with a larger improvement in cognitive load than the raw line count suggests.

### Architecture snapshot

- Frontend app shell: `src/app`, `src/components`, `src/hooks`, `src/lib`
- Worker API + cron engine: `worker/src/api`, `worker/src/cron`, `worker/src/lib`, `worker/src/handlers`
- Shared domain/core logic: `shared/lib`, `shared/types`
- Configuration and data: `shared/data`, `worker/migrations`, `scripts/lib`, route/version registries
- Infrastructure/glue: `functions/` Pages proxy functions, Next/ESLint/Vitest/Wrangler config, CI guardrail scripts

### Tech stack and dependency overlap

- Frontend: Next.js 16, React 19, TanStack Query, Tailwind v4, shadcn/Radix primitives, Recharts, d3-force
- Worker/runtime: Cloudflare Workers, D1, Wrangler
- Validation/types: TypeScript, Zod
- Testing/tooling: Vitest, ESLint, Prettier, repo-specific guardrail scripts

No major dependency redundancy stood out. The stack is coherent; the simplification work should focus on code structure, not package churn.

## 2. Findings Table

| # | Category | Location | Description | Impact | Effort |
|---|----------|----------|-------------|--------|--------|
| 1 | Over-engineering | `shared/lib/api-endpoints.ts`, `worker/src/route-registry.ts`, `worker/src/router.ts`, `worker/src/handlers/http/context.ts` | One HTTP surface is described across four parallel layers plus reverse-consistency checks. | High | Med |
| 2 | Accidental complexity | `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-stablecoins/stages.ts`, `worker/src/cron/sync-stablecoins/enrich-prices*.ts` | Stablecoin pricing/publish flow is split by implementation detail rather than by a minimal stage model. | High | High |
| 3 | Multi-responsibility modules | `src/components/homepage-client.tsx`, `src/components/kpi-bar.tsx`, `src/app/chains/[chain]/client.tsx` | Large route/UI shells mix data loading, derived metrics, state, animation, and rendering. | High | Med |
| 4 | Duplication | `src/lib/coverage.ts` | Coverage status logic repeats the same status-construction pattern across nine feature families. | Med | Med |
| 5 | Duplication | `src/components/providers.tsx`, `src/components/theme-toggle.tsx`, `src/components/sidebar.tsx`, `src/components/command-palette.tsx` | Theme toggling behavior is implemented four different ways with inconsistent side effects. | Med | Low |
| 6 | Duplication | `src/hooks/use-status.ts`, `src/hooks/use-status-history.ts`, `src/hooks/use-endpoint-probes.ts` | Admin polling hooks repeat the same proxy/auth/query plumbing. | Med | Low |
| 7 | Inconsistent pattern | `src/components/stablecoin-taxonomy-page.tsx`, `src/app/stablecoins/[peg]/page.tsx`, `src/lib/static-slug-page.ts` | Three taxonomy routes use a shared shell, while peg routes manually rebuild the same page shape. | Low | Low |

## 3. Detailed Recommendations

### 1. Collapse the worker HTTP route ceremony

**What exists now**

- Shared route/path/admin/probe metadata lives in `shared/lib/api-endpoints.ts`.
- Static handler wiring lives separately in `worker/src/route-registry.ts`.
- Method validation and no-store header adjustment live in `worker/src/router.ts`.
- Dependency hydration lives in `worker/src/handlers/http/context.ts`.
- The worker currently has 52 endpoint definitions and 52 top-level API handler files.

Key references:

- `shared/lib/api-endpoints.ts:22-35`
- `shared/lib/api-endpoints.ts:71-118`
- `worker/src/route-registry.ts:143-235`
- `worker/src/route-registry.ts:287-338`
- `worker/src/router.ts:13-44`
- `worker/src/handlers/http/context.ts:9-60`

**What is wrong**

- Adding or changing a route is too ceremonial: the route contract is not actually in one place.
- Static and dynamic routes use different models, which leaks routing mechanics into feature work.
- Reverse checks at the bottom of `route-registry.ts` are a sign that the source of truth is split.
- Dependency hydration is keyed indirectly through endpoint metadata instead of being visually adjacent to the handler that needs it.

**What to do**

- Collapse `router.ts` into `route-registry.ts` or vice versa so there is one worker-side routing module.
- Replace the current `ENDPOINT_DEFINITIONS + STATIC_ROUTE_HANDLERS_BY_KEY` dual structure with a single registry object per route that contains:
  - path/pattern
  - allowed methods
  - admin/cache/probe metadata
  - dependency list
  - handler
- Keep shared `API_PATHS` for frontend path generation, but stop using a separate shared endpoint-definition list as the worker's authoritative routing source.
- Keep shared helpers only for data the frontend and worker both consume directly, such as path builders and probe-path derivation.

**What to watch out for**

- Status-page probe grouping and admin action metadata currently depend on `shared/lib/api-endpoints.ts`; preserve those exports or move them in one pass.
- Dynamic admin routes and ID-based stablecoin routes need to keep canonical-ID validation behavior.
- This touches routing and auth, so contract tests around method gating and probe paths should stay in the validation set.

### 2. Reframe `sync-stablecoins` around a smaller stage model

**What exists now**

- `worker/src/cron/sync-stablecoins.ts` is a shell, but the actual flow still hops across `stages.ts`, `enrich-prices.ts`, `enrich-prices-primary.ts`, and `enrich-prices-passes.ts`.
- Pricing logic is split into:
  - intake and structural cleanup
  - primary multi-source fetch and consensus
  - sequential fallback enrichment passes
  - Geckoterminal probe
  - post-enrichment validation/publish/depeg work

Key references:

- `worker/src/cron/sync-stablecoins.ts:28-216`
- `worker/src/cron/sync-stablecoins/stages.ts:354-415`
- `worker/src/cron/sync-stablecoins/stages.ts:431-520`
- `worker/src/cron/sync-stablecoins/enrich-prices.ts:35-130`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:91-260`
- `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:49-260`

**What is wrong**

- The code is split, but not yet simplified. The mental model is still "find the right helper among many similarly named modules."
- Sequential fallback passes use repeated local counters, try/catch blocks, and custom logging instead of one obvious pass list.
- `stages.ts` mixes pure normalization helpers, D1 reads, structural validation, and the stage runner itself.
- Testing can only be comprehensive because the suite is large, not because the stage contracts are especially easy to understand.

**What to do**

- Keep the outer four-stage model explicit:
  1. intake
  2. primary pricing
  3. fallback enrichment
  4. publish/post-publish
- Move pure helpers such as `normalizeChainCirculating`, canonical dedupe, and price staleness summary into narrowly named pure modules under `sync-stablecoins/`.
- Convert fallback enrichment into a manifest-driven ordered array of pass definitions:
  - label
  - runner
  - stats key
  - failure label
- Have one loop execute the fallback passes and collect counts/failures, instead of one block per provider.
- Trim `stages.ts` so it only coordinates stage entry/exit and returns typed stage results.

**What to watch out for**

- Preserve current connection-budget behavior and abort semantics.
- Do not reintroduce supply overrides or relax the stale-write fail-closed behavior.
- This area is already heavily tested; keep the existing test surface but add a smaller unit around the fallback-pass manifest if the manifest is introduced.

### 3. Split the large frontend "page brains" by local view model, not by generic abstraction

**What exists now**

- `src/components/homepage-client.tsx` owns dynamic imports, query coordination, stale/error banners, filter toolbar state, derived report-card maps, and section composition.
- `src/components/kpi-bar.tsx` owns six queries, market-wide metric derivation, PSI display logic, DEWS formatting, animation setup, skeletons, and both mobile/desktop rendering.
- `src/app/chains/[chain]/client.tsx` mixes health scoring UI, treemap layout heuristics, filter state, table behavior, and route-shell control flow.

Key references:

- `src/components/homepage-client.tsx:107-157`
- `src/components/homepage-client.tsx:305-469`
- `src/components/homepage-client.tsx:481-611`
- `src/components/kpi-bar.tsx:294-459`
- `src/components/kpi-bar.tsx:559-719`
- `src/app/chains/[chain]/client.tsx:108-282`
- `src/app/chains/[chain]/client.tsx:285-730`
- `src/app/chains/[chain]/client.tsx:732-788`

**What is wrong**

- The files are understandable only if the reader keeps too much derived state in their head.
- A UI change and a data change are coupled in the same module, which widens review scope.
- Reuse is not the problem; local reasoning is. These files need smaller seams, not a shared dashboard framework.

**What to do**

- Extract pure view-model helpers first, not shared UI kits:
  - homepage: query aggregation, toolbar chip derivation, and section readiness helpers
  - KPI bar: market snapshot metrics and DEWS/PSI summary derivation
  - chain page: composition layout calculation and backing-breakdown totals
- Then extract only clearly bounded leaf sections where the view model is already stable.
- Keep the route shell as a composition root and keep component props concrete.
- Avoid inventing a generic "dashboard section" abstraction; this codebase does not need it.

**What to watch out for**

- Keep animation timing and mobile/desktop variations close enough to the render layer that they stay easy to tweak.
- Avoid moving hooks into helpers; the target is pure derivation extraction, not hook indirection.

### 4. Convert coverage status resolution into declarative per-feature tables

**What exists now**

- `src/lib/coverage.ts` defines feature metadata, nine `resolve*Coverage` functions, summary builders, and row assembly in one 783-line module.
- Most resolver functions follow the same pattern: map an input enum/flag to `kind`, `label`, `tone`, `available`, `sortRank`, and `detail`.

Key references:

- `src/lib/coverage.ts:102-179`
- `src/lib/coverage.ts:193-211`
- `src/lib/coverage.ts:213-636`
- `src/lib/coverage.ts:638-783`

**What is wrong**

- The repeated `createStatus(...)` calls are not individually complex, but together they make the file noisy and expensive to scan.
- Adding or editing one coverage feature means touching a monolith that also owns summary text and row construction.
- The underlying pattern is declarative, but the implementation is mostly imperative switches.

**What to do**

- Keep one small `createStatus` helper.
- Replace most resolver switch branches with per-feature lookup tables keyed by coverage class or enum value.
- Leave only the truly computed cases imperative, such as price-source counts and reserve heuristics.
- Move summary-breakdown label generation into a sibling helper module if it remains long after the resolver cleanup.

**What to watch out for**

- Preserve sort-rank semantics exactly; the coverage page depends on those.
- Preserve the price-source metadata attachment path for `price.sourceCount`, `sourceNames`, and `priceConfidence`.

### 5. Centralize theme toggling behavior

**What exists now**

- Theme switching logic is implemented in:
  - `src/components/providers.tsx`
  - `src/components/theme-toggle.tsx`
  - `src/components/sidebar.tsx`
  - `src/components/command-palette.tsx`

Key references:

- `src/components/providers.tsx:27-59`
- `src/components/theme-toggle.tsx:9-34`
- `src/components/sidebar.tsx:108-145`
- `src/components/command-palette.tsx:189-215`

**What is wrong**

- The theme operation is one user action but has different side effects depending on where it is triggered.
- Analytics tracking is present in some places and absent in others.
- Toast behavior exists only on the global-shortcut path.

**What to do**

- Extract one `useThemeToggle()` hook or one plain helper that returns:
  - `isDark`
  - `nextTheme`
  - `toggleTheme()`
- Put analytics and optional toast behavior behind that single implementation.
- Make all callers use that helper and keep their local UI only for presentation.

**What to watch out for**

- Keep the existing hydration guard where the icon depends on mounted theme state.
- Decide explicitly whether command-palette theme changes should track analytics and/or show toasts, then make that behavior uniform.

### 6. Standardize admin polling hooks on one helper

**What exists now**

- `useStatus` and `useStatusHistory` both build admin proxy paths, pass `buildAdminFetchInit()`, use the same polling cadence, and disable retries.
- `useEndpointProbes` uses the same admin path/auth concepts inside its manual probe loop.

Key references:

- `src/hooks/use-status.ts:10-25`
- `src/hooks/use-status-history.ts:19-43`
- `src/hooks/use-endpoint-probes.ts:148-246`

**What is wrong**

- The same admin-fetch policy is encoded repeatedly.
- Any change to admin proxy behavior or query scoping requires touching multiple hooks.
- The hooks already share the same conceptual operation: "poll an admin-scoped resource every minute with no retry."

**What to do**

- Add one narrow helper for admin-scoped polling query creation.
- Use it in `useStatus` and `useStatusHistory`.
- Reuse the same request-path/header helper inside endpoint probing so the admin/public split is expressed once.

**What to watch out for**

- Keep public endpoint probes callable without admin credentials.
- Do not over-generalize; this only needs to cover current admin polling patterns.

### 7. Converge peg landing pages with the taxonomy route pattern

**What exists now**

- Backing, governance, and protocol landing pages all use the shared taxonomy shell and shared slug-page helpers.
- Peg landing pages reimplement the shell, metadata, JSON-LD list, and directory rendering manually.

Key references:

- `src/components/stablecoin-taxonomy-page.tsx:15-109`
- `src/app/stablecoins/backing/[backing]/page.tsx:9-29`
- `src/app/stablecoins/governance/[governance]/page.tsx:9-34`
- `src/app/stablecoins/protocol/[protocol]/page.tsx:9-29`
- `src/app/stablecoins/[peg]/page.tsx:20-129`
- `src/lib/static-slug-page.ts:10-45`

**What is wrong**

- One operation, "stablecoin taxonomy landing page," now has two implementation patterns.
- The peg page duplicates directory/schema work that already exists in `StablecoinTaxonomyPage`.
- This is low risk but it increases drift risk in SEO and shell changes.

**What to do**

- Either extend `StablecoinTaxonomyPage` to handle peg pages, or create one shared variant for "taxonomy-with-client-body" and move peg routes onto it.
- Reuse `static-slug-page.ts`-style helpers for metadata and param resolution where practical.
- Keep peg-specific content limited to the client body and peg-specific intro copy.

**What to watch out for**

- Peg pages have slightly different metadata wording and client body wiring; keep those differences explicit instead of burying them in conditionals.

## 4. Prioritized Action Plan

### Tier 1 - Quick wins

- Centralize theme toggling and remove the four separate implementations.
- Standardize admin polling hooks on one helper.
- Converge peg landing pages with the existing taxonomy page pattern.

### Tier 2 - High-value refactors

- Collapse the worker HTTP route ceremony into one authoritative worker-side route registry.
- Convert coverage status resolution into declarative per-feature tables.
- Extract pure view-model helpers from `homepage-client`, `kpi-bar`, and `chains/[chain]/client`.

### Tier 3 - Structural improvements

- Reframe `sync-stablecoins` around a smaller explicit stage model and a manifest-driven fallback-pass loop.

### Defer or skip

- Dependency changes: no meaningful package overlap was found, so dependency churn is not justified.
- Reserve-adapter and yield-source fan-out: both are large, but they represent many real concrete cases, not obvious abstraction mistakes. Revisit only when their inventories stabilize or another growth wave lands.

