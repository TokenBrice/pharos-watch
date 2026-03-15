# Stablecoin Dashboard (Pharos)

Analytics dashboard tracking 157 stablecoins (+2 shadow assets for PSI). Static Next.js 16 export → Cloudflare Pages. API: Cloudflare Worker + D1.

**Live at [pharos.watch](https://pharos.watch)**

## Folder Structure

All agent-produced plans, audits, research, and process notes live in the `/agents/` folder. Treat `/agents/` as a working-artifact archive, not as the canonical source of truth over live code or `/docs/`.
**`/docs/` is the verified application documentation corpus**

## cmcs — Orchestration

While in cmcs workflow, you are the **orchestrator**. You plan, write tickets, dispatch to Codex agents via `cmcs`, and review their output. You do NOT implement code directly unless trivial.

**cmcs docs live in the cmcs repo — read from there:**
- `/home/ahirice/Documents/git/cmcs/docs/cmcs-base.md` — dispatch, ticket format, commands, review protocol
- `/home/ahirice/Documents/git/cmcs/docs/model-selection.md` — model catalog, selection heuristics, failure modes
- `/home/ahirice/Documents/git/cmcs/docs/cmcs-large-implementation-preparation.md` — large project preparation process

### Pharos-Specific cmcs Rules

- **D1 scale awareness:** For tickets that create admin/batch/retroactive endpoints, specify worst-case data volume in the ticket. Require per-ID batched SQL for tables over 100K rows. Never use UPDATE-with-JOIN across large tables — D1 CPU limits will kill it.
- **Smoke tests must be self-contained:** Any smoke test commands in tickets or execution handovers must include required auth tokens or use public endpoints. Don't assume the reviewer has env vars set.

**Post-merge checklist (Pharos):**
1. Run `npm install` if `package.json` changed
2. Run full build + type-check (`npm run build && cd worker && npx tsc --noEmit`)
3. Run tests (`npm test`)
4. Check for duplicate exports/constants from parallel worktree merges
5. Delete the worktree only after confirming all commits are reachable on main

**Plan cleanup:** After all phases are merged and validated, move the implementation plan to `agents/plans/historical/`.

## Core Principles

- DRY/KISS/YAGNI. Minimal impact. Find root causes, no temp fixes.
- When adding a data source, update the about page.
- **Plan first**: Enter plan mode for non-trivial tasks (3+ steps). If stuck, stop and re-plan.
- **Verify before done**: Prove it works — build, type-check, test. Never claim done without evidence.
- **Be autonomous**: Fix bugs end-to-end without hand-holding. Chase logs and errors yourself.
- **Learn from corrections**: Record recurring mistakes in auto-memory to avoid repeating them.

## Tech Stack

Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, Recharts, Cloudflare Workers + D1.

## Directory Overview

```
src/app/         — Pages (homepage, admin, blacklist, cemetery, compare, coverage, dependency-map, depeg, digest, flows, liquidity, methodology, portfolio, privacy, safety-scores, stability-index, start, status, telegram, about, yield, stablecoin/[id], stablecoins/[peg], stablecoins/backing/[backing], stablecoins/governance/[governance])
src/components/  — UI components (ui/ = shadcn primitives, do not edit)
src/hooks/       — TanStack Query hooks + shared state hooks
src/lib/         — Frontend-only utilities (API client, charts/colors, metadata, UI helpers)
functions/       — Cloudflare Pages Functions for ops-host gating and `/api/admin/*` proxying
shared/lib/      — Runtime-neutral shared modules (stablecoin metadata, supply/classification/peg/report-card logic)
worker/src/cron/ — Data sync crons
worker/src/api/  — REST API handlers (router-dispatched endpoints + dynamic stablecoin detail)
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

## Web Fetching

- **APIs first**: When fetching data from CoinGecko, Etherscan, DefiLlama, etc., always prefer their API endpoints over scraping web pages. APIs are structured, reliable, and rarely return 403s.
- **agent-browser for everything else**: For websites, docs pages, and any URL that returns a 403 with `WebFetch`, use `agent-browser` (headless browser CLI, globally installed). It bypasses bot detection and renders JS-heavy pages.

## Key Gotchas

- **Tailwind classes must be static strings** — never construct dynamically (purge won't find them)
- **Classification labels/colors**: all in `shared/lib/classification.ts` — never define locally
- **Supply helpers**: use `getCirculatingRaw()` from `shared/lib/supply.ts`; all values are already in USD (DL converts)
- **Hook timing**: `staleTime = cron interval`, `refetchInterval = 2× cron interval`
- **Workers 6-connection limit is per-cron-trigger, not per-job** — all `ctx.waitUntil()` jobs on the same cron slot share one 6-connection pool. Consume response bodies before starting new fetch batches to release connections for sibling jobs.
- **Worker shared boundary**: worker and frontend share runtime-neutral logic via `shared/lib/` (`@shared/*` alias); root tsconfig excludes `worker/` to avoid D1 type conflicts
- **DL list vs detail API**: The list endpoint (`stablecoins.llama.fi/stablecoins`) returns `circulating` values already in USD for all peg types. The detail endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns native currency values for non-USD pegs. Do NOT multiply list endpoint values by price — that double-converts.
- **No manual/on-chain/CMC/DEX supply overrides**: primary supply comes from DefiLlama, with CoinGecko market-cap fallback only for supplemental non-DefiLlama assets and full-cache fallback when the DefiLlama stablecoins source is unavailable.

## Topic References & Documentation

All the codebase is documented. While working, make sure to update the corresponding documentation before pushing your change. After updating a scoring methodology (Pharos Stability Index, PegScore, LiquidityScore, Report Cards), update the /methodology page as well. 

Read these when working on related code:

- **`docs/architecture.md`** — Curated file tree, API endpoints
- **`docs/api-reference.md`** — Full API reference: endpoints, query params, response shapes, caching
- **`docs/classification.md`** — Classification system, peg currencies, gold/JPY/IDR stablecoins
- **`docs/bluechip-ratings.md`** — Bluechip sync coverage, cache/API contract, and frontend consumers
- **`docs/dex-liquidity.md`** — Liquidity score algorithm, quality multipliers
- **`docs/stability-index.md`** — PSI formula, components, condition bands, calibration
- **`docs/report-cards.md`** — Grading dimensions, weights, thresholds, dependency propagation, portfolio analyzer, stress test
- **`docs/methodology-page.md`** — `/methodology` page section-to-source mapping and update contract
- **`docs/homepage.md`** — `/` dashboard composition, filter/query contract, and Start Here callout behavior
- **`docs/start-page.md`** — `/start/` onboarding route, curated route map, and homepage integration contract
- **`docs/data-pipeline.md`** — Price enrichment, data integrity guardrails, blacklist sync
- **`docs/data-flow-map.md`** — End-to-end external source → cron → D1 → API → hook → page map
- **`docs/stablecoin-detail-page.md`** — `/stablecoin/[id]/` route shell, section composition, and fallback/staleness rules
- **`docs/cemetery-and-compare.md`** — Cemetery dataset + compare-page URL/data contracts
- **`docs/dependency-map.md`** — Dependency graph data model, contagion rendering, interaction model
- **`docs/design-context.md`** — Users, brand personality, aesthetic direction, anti-references, design principles
- **`docs/design-tokens.md`** — 3-layer design token architecture (primitives, semantic, component tokens)
- **`docs/design-language.md`** — Typography, spacing, cards, tables, charts, interactive states, loading/error patterns
- **`docs/testing.md`** — Test & lint setup, conventions, CI pipeline, adding new tests
- **`docs/deployment-process.md`** — Deploy workflow, worktree merge flow, merge gate behavior
- **`docs/about-page.md`** — `/about/` section contract, data-source copy surface, and update rules
- **`docs/coverage-page.md`** — `/coverage/` matrix contract, source mapping, and update rules
- **`docs/feedback-pipeline.md`** — Feedback widget, POST /api/feedback, rate limiting, auto-verification, GitHub routing, env vars
- **`docs/digest-pipeline.md`** — Daily digest generation, LLM call, D1 storage, Twitter + Telegram distribution, API endpoints, frontend, SSG pipeline
- **`docs/depeg-detection.md`** — Two-stage depeg detection, thresholds, confirmation flow, event lifecycle, peg score formula
- **`docs/shadow-stablecoins.md`** — Shadow stablecoin metadata, PSI eligibility boundary, and UI exclusion rules
- **`docs/supply-snapshot.md`** — Daily supply snapshot cron, supply_history schema, supply helpers, backfill endpoint
- **`docs/live-reserves.md`** — Live reserve sync config, adapter registry, storage, API modes, and detail/status consumers
- **`docs/redemption-backstops.md`** — Redemption-route configs, effective-exit scoring, storage, API endpoint, and detail/report-card consumers
- **`docs/blacklist-tracker.md`** — Multi-chain blacklist/freeze tracking, contract configs, balance enrichment, sync flow
- **`docs/mint-burn-flows.md`** — Mint/burn flow tracker: on-chain event sync, Flow Intensity Score, Bank Run Gauge, flight-to-quality detection, contract configs, scoring, API endpoints, frontend
- **`docs/yield-intelligence.md`** — Yield pipeline: four-tier APY resolution, PYS formula, T-bill rate, warning signals, DB schema, API endpoints, frontend
- **`docs/dews.md`** — DEWS formula, 8 sub-signals, threat bands, normalization, API endpoint
- **`docs/report-cards-timeline.md`** — Safety score methodology version changelog (v1.0 through current)
- **`docs/worker-infrastructure.md`** — Env interface, cron scheduling (10 trigger slots, 25 scheduled runtime jobs / 24 status-tracked jobs), edge cache, CORS, admin auth, alert system, undocumented cron details (charts, cemetery announcements, USDS, bluechip)
- **`docs/telegram-alerts.md`** — Telegram webhook commands, D1 subscription tables, alert dispatch snapshots, bot ops
- **`docs/status-dashboard.md`** — `/status` architecture: admin auth, cache/cron/data-quality synthesis, endpoint probes, inline admin actions
- **`docs/scripts.md`** — Operational and CI helper scripts in `scripts/`
- **`docs/worker-and-api-limits.md`** — Repo-enforced runtime budgets, throttle constants, and external-provider assumptions to re-check before designing any new worker feature.
- **`docs/pricing-pipeline.md`** — Multi-source price consensus, authoritative overrides, confidence model, validation
- **`docs/portfolio-page.md`** — `/portfolio/` stress testing, presets, share codec, upstream exposure analysis
- **`docs/privacy-page.md`** — `/privacy/` content contract, GA4 scope, cookie/retention details
- **`docs/operator-origin-access.md`** — Pages Functions host gating for ops.pharos.watch, admin API proxy
- **`docs/stability-index-timeline.md`** — PSI methodology version changelog
- **`docs/depeg-dews-timeline.md`** — Depeg detection + DEWS methodology version changelog
- **`docs/blacklist-tracker-timeline.md`** — Blacklist tracker methodology version changelog
- **`docs/mint-burn-flows-timeline.md`** — Mint/burn flow methodology version changelog
- **`docs/yield-intelligence-timeline.md`** — Yield intelligence methodology version changelog
- **`docs/liquidity-score-timeline.md`** — Liquidity score methodology version changelog

## Design Context

See **`docs/design-context.md`** for users, brand personality, aesthetic direction, anti-references, and design principles. Read before any frontend/UI work.
