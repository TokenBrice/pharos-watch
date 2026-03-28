# Structural Simplification Audit — 2026-03-28

## Executive Summary

The codebase is generally healthy: the stack is coherent, guardrails are strong, and obvious dead code or circular dependency problems are already being caught by repo checks. Complexity is concentrated in a few high-churn areas rather than spread everywhere: worker routing, stablecoin sync orchestration, methodology content, and scheduled cron slot composition. The biggest structural issue is partial centralization: several areas have a canonical abstraction, but important outliers still bypass it, which creates second registries, duplicated prose/data, and large “special case” files. If the recommendations below are implemented cleanly, the repo should lose roughly **1.5k-2.5k LOC** while becoming easier to reason about.

## Structural Survey

### High-level architecture

- `src/app/`: Next.js App Router entry points and route shells for the static Pages export.
- `src/components/`: UI composition; most page-level client rendering lives here.
- `src/hooks/` + `src/lib/`: frontend query/model helpers and page logic.
- `shared/lib/` + `shared/types/`: runtime-neutral domain rules, version metadata, registries, and contracts used by both frontend and worker.
- `functions/`: Cloudflare Pages Functions used mainly as glue/proxy for ops-host access.
- `worker/src/api/`: Worker HTTP handlers.
- `worker/src/cron/`: ingestion, enrichment, scoring, and publication jobs.
- `worker/src/lib/`: worker-specific helpers, DB/cache helpers, scoring/runtime infrastructure.

### Code volume concentration

| Area | Files | Approx lines |
| --- | ---: | ---: |
| `worker/src/cron` | 254 | 69,687 |
| `worker/src/lib` | 186 | 37,861 |
| `src/components` | 235 | 39,921 |
| `worker/src/api` | 113 | 22,258 |
| `src/app` | 104 | 17,674 |
| `shared/lib` | 99 | 16,812 |

Largest non-test hotspots in this audit pass:

- `src/app/methodology/scoring-changelog/page.tsx`
- `src/app/methodology/sections/core-sections.tsx`
- `src/app/methodology/sections/monitoring-sections.tsx`
- `shared/lib/api-endpoints.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/enrich-prices-passes.ts`
- `worker/src/handlers/scheduled/context.ts`
- `worker/src/lib/live-reserves-store.ts`

### Boundaries

- Core domain logic: mostly `shared/lib/*`, plus scoring/query logic in `worker/src/lib/*`.
- Infrastructure/glue: `worker/src/router.ts`, `worker/src/route-registry.ts`, `worker/src/handlers/*`, `functions/*`.
- Configuration/metadata: `shared/lib/*-version.ts`, `shared/lib/api-endpoints.ts`, `shared/lib/cron-jobs.ts`, `shared/data/stablecoins/*`.

### Stack / dependency overlap

- Frontend: Next.js 16, React 19, TanStack Query, Tailwind 4, Radix, Recharts.
- Worker: Cloudflare Worker + D1 + Wrangler.
- Validation/testing: Zod, Vitest, ESLint.
- No meaningful redundant dependency families stood out in this pass; the stack is more structurally redundant than library-redundant.

## Findings Table

| # | Category | Location | Description | Impact | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Structural redundancy | `shared/lib/api-endpoints.ts`, `worker/src/router.ts`, `worker/src/route-registry.ts` | Routing metadata is centralized only halfway; dynamic routes and handler binding still live in parallel registries. | High | Med |
| 2 | Duplication | `src/app/methodology/scoring-changelog/page.tsx`, `shared/lib/safety-score-version.ts` | Safety Score changelog content is duplicated across shared metadata and a bespoke 1.2k-line page. | High | Med |
| 3 | Duplication / accidental complexity | `src/app/methodology/sections/core-sections.tsx`, `src/app/methodology/sections/monitoring-sections.tsx` | Responsive diagram/layout JSX is repeated section-by-section, producing two large methodology monoliths. | Med-High | Med |
| 4 | Pattern drift | `worker/src/handlers/scheduled/*.ts` | Cron slot handlers reimplement the same leased-job wrapper and sequential/parallel orchestration patterns. | Med | Low-Med |
| 5 | Inconsistent patterns | `worker/src/api/blacklist.ts`, `worker/src/api/mint-burn-events.ts`, `worker/src/api/yield-history.ts`, `worker/src/lib/api-utils.ts` | API handlers only partially use shared parsing/helpers, so query validation and response scaffolding are repeated inconsistently. | Med | Med |
| 6 | Boundary leak | `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/enrich-prices.ts`, `worker/src/cron/sync-stablecoins/*` | Stablecoin sync is conceptually one pipeline but physically split across sibling modules/folders with cross-imported stage logic. | Med | High |

## Detailed Recommendations

### 1. Unify worker routing into one real route registry

**What exists now**

- `shared/lib/api-endpoints.ts` defines paths, methods, probe metadata, status-page actions, and dependency hints.
- `worker/src/route-registry.ts` binds static endpoint keys to handlers.
- `worker/src/router.ts` separately owns dynamic `RegExp` routes for detail/reserves/summary/OG/dismiss endpoints.

**What is wrong**

- Changes to one route family require touching multiple files and concepts.
- The “single source of truth” claim is only partially true; dynamic routes still bypass it.
- The canary/detail endpoints mix operational probes with actual router concerns in the same config surface.

**What to do**

- Collapse static and dynamic handler registration into one registry structure inside the worker.
- Keep `shared/lib/api-endpoints.ts` focused on shared transport metadata only.
- Represent dynamic routes as route descriptors with explicit param parsers instead of ad hoc regex tables in `worker/src/router.ts`.
- Remove the canary-as-route-key pattern; treat canaries as probe metadata over existing routes rather than pseudo-endpoints with hard-coded IDs.

**What to watch out for**

- Preserve method validation and Access-gated admin behavior exactly.
- Do not break status-page probe metadata or dependency hydration.
- OG wildcard routes and `/discovery-candidates/:id/dismiss` need explicit matching behavior after consolidation.

### 2. Make Safety Score changelog use the same data-driven system as every other methodology changelog

**What exists now**

- `shared/lib/safety-score-version.ts` already stores version/date/title/summary/impact metadata.
- `src/app/methodology/scoring-changelog/page.tsx` defines a second, bespoke changelog rendering system with its own `VersionCard`, `Pill`, and repeated per-version JSX prose.
- Other changelog routes use `createMethodologyChangelogRoute()` directly.

**What is wrong**

- Version metadata is duplicated in two places and will drift.
- The largest methodology page is also the least standardized one.
- Reusable changelog infrastructure exists but the heaviest page bypasses it.

**What to do**

- Move rich per-version detail content into structured data or per-version content fragments keyed by the shared changelog entries.
- Make the scoring page render from `SAFETY_SCORE_CHANGELOG` the same way the liquidity, yield, and other changelogs do.
- Delete local `Pill`, `VersionCard`, `WeightRow`, and repeated version title/date literals unless they are promoted into shared reusable primitives.

**What to watch out for**

- The scoring page contains richer historical detail than other changelogs; preserve that fidelity.
- Keep stable anchor IDs so existing links do not break.

### 3. Replace repeated desktop/mobile methodology diagrams with shared content primitives

**What exists now**

- `core-sections.tsx` and `monitoring-sections.tsx` both repeat the same pattern: facts, worked example, then two versions of the same flow diagram (`hidden md:flex` and `md:hidden`).
- The same visual structure is retyped for PSI, Safety Score, Liquidity, Mint/Burn, Yield, and DEWS sections.

**What is wrong**

- A large chunk of these files is layout duplication, not domain content.
- Small style or accessibility changes have to be applied to many hand-authored blocks.
- The methodology files are hard to scan because content and presentation are tightly interleaved.

**What to do**

- Introduce one small shared renderer for step diagrams/cards in `methodology-shared.tsx`.
- Convert repeated desktop/mobile diagram pairs into data arrays passed to that renderer.
- Keep the prose local; only factor the repeated card-grid/arrow/stack layout.

**What to watch out for**

- Do not over-generalize all long-form methodology content into JSON blobs.
- Preserve the existing visual language and section-specific copy; only mutualize repeated layout.

### 4. Standardize cron slot orchestration helpers

**What exists now**

- `daily-0800.ts`, `daily-0805.ts`, `quarter-hourly.ts`, and `half-hourly.ts` each define a local `run*Job()` wrapper with identical try/catch behavior around `runtime.runLeasedCron(...)`.
- `mint-burn-slot.ts` already proves the codebase accepts shared slot orchestration when it materially reduces duplication.

**What is wrong**

- The repeated wrapper logic adds noise around the actual job topology.
- Slot files read longer than the orchestration they express.
- Error handling wording and null-return semantics are easy to let drift.

**What to do**

- Add one shared slot helper in `worker/src/handlers/scheduled/` for “best-effort leased job” execution.
- Rewrite the four slot files to describe only the sequence/parallelism and dependency conditions.
- Keep specialized logic local where it actually differs, like stale-cache alerts or post-success freshness checks.

**What to watch out for**

- Preserve the current connection-budget ordering; do not hide the execution topology behind a generic framework.
- Avoid building a mini scheduler DSL. A tiny helper is enough.

### 5. Finish converging API handlers on shared parsing and response helpers

**What exists now**

- `worker/src/lib/api-utils.ts` already provides `parseQueryParams()`, `parseStablecoinHistoryQuery()`, `handleStablecoinHistoryRequest()`, `buildMethodologyEnvelope()`, and `jsonFreshResponse()`.
- Some handlers use them heavily (`yield-history.ts`, `depeg-events.ts`).
- Others still hand-roll enum validation, required param checks, freshness response assembly, and pagination scaffolding (`blacklist.ts`, `mint-burn-events.ts`, several admin handlers).

**What is wrong**

- The same operation is performed multiple ways across adjacent handlers.
- Manual query validation inflates handler size and increases contract drift risk.
- The API layer feels less uniform than it actually is.

**What to do**

- Add small shared helpers for common enum-param patterns and required stablecoin-filter parsing.
- Convert paginated event handlers to a common builder where possible: parse filters, build SQL conditions, fetch rows, attach freshness/methodology metadata.
- Start with `blacklist.ts` and `mint-burn-events.ts`; they already resemble the same template.

**What to watch out for**

- Preserve endpoint-specific error text when it is part of a tested contract.
- Do not force every handler into the same abstraction if it saves only a few lines.

### 6. Co-locate the stablecoin sync pipeline so one pipeline lives in one folder

**What exists now**

- `worker/src/cron/sync-stablecoins.ts` is the orchestrator.
- Important stages live under `worker/src/cron/sync-stablecoins/*`.
- Price enrichment stages for the same pipeline live outside that folder in `enrich-prices.ts`, `enrich-prices-primary.ts`, `enrich-prices-passes.ts`, and `enrich-prices-shared.ts`.

**What is wrong**

- The boundary is conceptual noise, not a real subsystem split.
- The sync pipeline reads as one workflow but is physically scattered.
- `PeggedAsset` and price-enrichment helpers are imported across a fake folder boundary, which increases navigation cost.

**What to do**

- Move `enrich-prices*.ts` under `worker/src/cron/sync-stablecoins/`.
- Turn `worker/src/cron/sync-stablecoins.ts` into a thin index/orchestrator over a co-located pipeline package.
- Keep only genuinely standalone pricing utilities outside the folder.

**What to watch out for**

- This is a structural cleanup, so stage it carefully and keep tests green at each move.
- Avoid renaming exported functions unless there is a real clarity gain.

## Prioritized Action Plan

### Tier 1 — Quick wins

- Standardize cron slot wrappers (`worker/src/handlers/scheduled/*.ts`).
- Finish shared API parsing convergence for the paginated event/history handlers.
- Keep the current dependency stack; no library cleanup pass is justified right now.

### Tier 2 — High-value refactors

- Convert Safety Score changelog to the shared changelog route pattern.
- Extract shared methodology diagram/layout primitives from the large methodology section files.
- Simplify route registration so handler binding and path matching stop living in parallel structures.

### Tier 3 — Structural improvements

- Re-home the stablecoin sync pricing stages into one folder/package boundary.
- Split `shared/lib/api-endpoints.ts` by concern if route unification still leaves it acting as a god file.

### Defer or skip

- Thin frontend page wrappers created by `createClientFeaturePage()` are repetitive but acceptable; they are already standardized and low-risk.
- Thin query hooks in `src/hooks/api-hooks.ts` are also acceptable boilerplate; collapsing them further would trade clarity for cleverness.
- No dead-code purge is warranted from this audit pass: `check:unused-code`, `check:duplicate-exports`, and `check:shared-cycles` are clean.

## Validation Run

- `npm run check:unused-code`
- `npm run check:duplicate-exports`
- `npm run check:shared-cycles`
