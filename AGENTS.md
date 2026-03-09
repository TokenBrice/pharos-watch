# Stablecoin Dashboard (Pharos)

Analytics dashboard tracking 156 stablecoins (+2 shadow assets for PSI). Static Next.js 16 export → Cloudflare Pages. API: Cloudflare Worker + D1.

**Live at [pharos.watch](https://pharos.watch)**

## Core Principles

- DRY/KISS/YAGNI. Minimal impact. Find root causes, no temp fixes.
- When adding a data source, update the about page.
- **Plan first**: Enter plan mode for non-trivial tasks (3+ steps). If stuck, stop and re-plan.
- **Verify before done**: Prove it works — build, type-check, test. Never claim done without evidence.
- **Be autonomous**: Fix bugs end-to-end without hand-holding. Chase logs and errors yourself.

## Folder Structure

All agents plans (design or implementation), as well as research and processes documents are placed in the `/agents/` folder.
**`/docs/` is to be used for application-related documentation only**

## Tech Stack

Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, Recharts, Cloudflare Workers + D1.

## Directory Overview

```
src/app/         — Pages (homepage, blacklist, cemetery, compare, dependency-map, depeg, digest, flows, liquidity, methodology, portfolio, privacy, safety-scores, stability-index, status, about, yield, stablecoin/[id], stablecoins/[peg])
src/components/  — UI components (ui/ = shadcn primitives, do not edit)
src/hooks/       — TanStack Query hooks + shared state hooks
src/lib/         — Frontend-only utilities (API client, charts/colors, metadata, UI helpers)
shared/lib/      — Runtime-neutral shared modules (stablecoin metadata, supply/classification/peg/report-card logic)
worker/src/cron/ — Data sync crons
worker/src/api/  — REST API handlers (including stablecoin detail, admin routes, and feedback endpoint)
worker/src/lib/  — DB helpers, constants, shared utilities
```

## Commands

```bash
npm run dev                        # Frontend dev server
npm run build                      # Build + type-check
npm run lint                       # ESLint (frontend + worker)
npm test                           # Vitest (run once)
npm run test:watch                 # Vitest (watch mode)
cd worker && npx wrangler dev      # Worker dev server (binds to localhost:8787)
cd worker && npx tsc --noEmit      # Worker type-check
```

## Key Gotchas

- **Tailwind classes must be static strings** — never construct dynamically (purge won't find them)
- **Classification labels/colors**: all in `shared/lib/classification.ts` — never define locally
- **Supply helpers**: use `getCirculatingRaw()` from `shared/lib/supply.ts`; all values are already in USD (DL converts)
- **Hook timing**: `staleTime = cron interval`, `refetchInterval = 2× cron interval`
- **Workers 6-connection limit is per-cron-trigger, not per-job** — all `ctx.waitUntil()` jobs on the same cron slot share one 6-connection pool. Consume response bodies before starting new fetch batches to release connections for sibling jobs.
- **Import alias**: `@shared/*` maps to `shared/*` (both tsconfigs + vitest). Always use `@shared/lib/...` — e.g., `@shared/lib/stablecoins`, NOT `@shared/stablecoins` (missing `/lib/` resolves to a non-existent path)
- **Worker shared boundary**: worker and frontend share runtime-neutral logic via `shared/lib/` (`@shared/*` alias); root tsconfig excludes `worker/` to avoid D1 type conflicts
- **DL list vs detail API**: The list endpoint (`stablecoins.llama.fi/stablecoins`) returns `circulating` values already in USD for all peg types. The detail endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns native currency values for non-USD pegs. Do NOT multiply list endpoint values by price — that double-converts.
- **No supply overrides**: Supply data comes from DefiLlama only. No on-chain, CMC, or DEX overrides. Prices fall back to CG → CMC → DexScreener when DL has no price.

## Topic References & Documentation

All the codebase is documented. While working, make sure to update the corresponding documentation before pushing your change. After updating a scoring methodology (Pharos Stability Index, PegScore, LiquidityScore, Report Cards), update the /methodology page as well. 

Read these when working on related code:

- **`docs/architecture.md`** — Full file tree, API endpoints
- **`docs/api-reference.md`** — Full API reference: endpoints, query params, response shapes, caching
- **`docs/classification.md`** — Classification system, peg currencies, gold/JPY/IDR stablecoins
- **`docs/dex-liquidity.md`** — Liquidity score algorithm, quality multipliers
- **`docs/stability-index.md`** — PSI formula, components, condition bands, calibration
- **`docs/report-cards.md`** — Grading dimensions, weights, thresholds, dependency propagation, portfolio analyzer, stress test
- **`docs/methodology-page.md`** — `/methodology` page section-to-source mapping and update contract
- **`docs/data-pipeline.md`** — Price enrichment, data integrity guardrails, blacklist sync
- **`docs/data-flow-map.md`** — End-to-end external source → cron → D1 → API → hook → page map
- **`docs/cemetery-and-compare.md`** — Cemetery dataset + compare-page URL/data contracts
- **`docs/dependency-map.md`** — Dependency graph data model, contagion rendering, interaction model
- **`docs/design-tokens.md`** — 3-layer design token architecture (primitives, semantic, component tokens)
- **`docs/design-language.md`** — Typography, spacing, cards, tables, charts, interactive states, loading/error patterns
- **`docs/testing.md`** — Test & lint setup, conventions, CI pipeline, adding new tests
- **`docs/deployment-process.md`** — Deploy workflow, worktree merge flow, merge gate behavior
- **`docs/feedback-pipeline.md`** — Feedback widget, POST /api/feedback, rate limiting, auto-verification, GitHub routing, env vars
- **`docs/digest-pipeline.md`** — Daily digest generation, LLM call, D1 storage, Twitter + Telegram distribution, API endpoints, frontend, SSG pipeline
- **`docs/depeg-detection.md`** — Two-stage depeg detection, thresholds, confirmation flow, event lifecycle, peg score formula
- **`docs/shadow-stablecoins.md`** — Shadow stablecoin metadata, PSI eligibility boundary, and UI exclusion rules
- **`docs/supply-snapshot.md`** — Daily supply snapshot cron, supply_history schema, supply helpers, backfill endpoint
- **`docs/blacklist-tracker.md`** — Multi-chain blacklist/freeze tracking, contract configs, balance enrichment, sync flow
- **`docs/mint-burn-flows.md`** — Mint/burn flow tracker: on-chain event sync, Flow Intensity Score, Bank Run Gauge, flight-to-quality detection, contract configs, scoring, API endpoints, frontend
- **`docs/yield-intelligence.md`** — Yield pipeline: three-tier APY resolution, PYS formula, T-bill rate, warning signals, DB schema, API endpoints, frontend
- **`docs/dews.md`** — DEWS formula, 8 sub-signals, threat bands, normalization, API endpoint
- **`docs/report-cards-timeline.md`** — Report card history tracking, grade change persistence, timeline UI
- **`docs/worker-infrastructure.md`** — Env interface, cron scheduling (4 triggers, 19 primary jobs), edge cache, CORS, admin auth, alert system, undocumented cron details (charts, USDS, bluechip)
- **`docs/telegram-alerts.md`** — Telegram webhook commands, D1 subscription tables, alert dispatch snapshots, bot ops
- **`docs/status-dashboard.md`** — `/status` architecture: admin auth, cache/cron/data-quality synthesis, endpoint probes, inline admin actions
- **`docs/scripts.md`** — Operational and CI helper scripts in `scripts/`
- **`docs/worker-and-api-limits.md`** — Hard limits for external services (Cloudflare Workers/D1, CoinGecko, DefiLlama, DexScreener, Alchemy, Etherscan, etc.). **Read before designing any new feature that touches the worker.**
