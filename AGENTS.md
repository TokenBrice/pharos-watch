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
src/app/         — Pages (homepage, blacklist, cemetery, compare, dependency-map, depeg, digest, flows, liquidity, methodology, portfolio, privacy, safety-scores, stability-index, start, status, telegram, about, yield, stablecoin/[id], stablecoins/[peg], stablecoins/backing/[backing], stablecoins/governance/[governance])
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
- **`docs/worker-infrastructure.md`** — Env interface, cron scheduling (9 trigger slots, 22 named runtime jobs), edge cache, CORS, admin auth, alert system, undocumented cron details (charts, USDS, bluechip)
- **`docs/telegram-alerts.md`** — Telegram webhook commands, D1 subscription tables, alert dispatch snapshots, bot ops
- **`docs/status-dashboard.md`** — `/status` architecture: admin auth, cache/cron/data-quality synthesis, endpoint probes, inline admin actions
- **`docs/scripts.md`** — Operational and CI helper scripts in `scripts/`
- **`docs/worker-and-api-limits.md`** — Hard limits for external services (Cloudflare Workers/D1, CoinGecko, DefiLlama, DexScreener, Alchemy, Etherscan, etc.). **Read before designing any new feature that touches the worker.**

## Design Context

### Users

Crypto-native DeFi participants who actively monitor stablecoin health — checking market conditions, peg stability, and risk signals regularly to inform financial decisions. The core audience is still power-user-leaning, even when onboarding or discovery surfaces get simpler. They value density, precision, and speed-to-insight over softness or consumer-app hand-holding.

### Brand Personality

**Vigilant, precise, distinctive.** Pharos is a lighthouse — it watches every peg so you don't have to. The tone is practitioner-built, not corporate, and the product should feel unmistakable rather than merely competent. It earns trust through completeness and specificity, but it should also carry a unique vibe that separates it from generic analytics dashboards.

### Emotional Design

**Calm by default, urgent when needed.** The steady state is composed and analytical — the user feels informed and in control. When risk signals fire (depeg events, DEWS alerts, PSI band shifts), the interface shifts tone to communicate urgency without panic.

### Aesthetic Direction

- **Theme**: Dark-first financial dashboard (light mode supported)
- **References**: DeFi-native research products with strong data density and practical crypto analytics, but Pharos should not collapse into looking like another interchangeable dashboard
- **Brand accent**: Frost-blue `oklch(0.72 0.14 248)` — used sparingly for navigation active states and brand touches
- **Fonts**: Geist Sans (UI) + Geist Mono (all numbers) — monospace numbers signal precision and trust
- **Color use**: Semantic first — color communicates state (health, risk, trend direction), not empty decoration
- **Design bar**: Avoid generic SaaS sameness; every major surface should feel authored and recognizably Pharos

### Anti-References (what Pharos must NOT look like)

- **Web3 marketing pages**: Purple gradients, glassmorphism, buzzword-heavy, style over substance
- **Corporate fintech**: Sterile, over-polished, feels like a bank app — no personality
- **Generic SaaS dashboards**: Cookie-cutter admin panels with big empty cards, interchangeable KPI tiles, and safe pastel gradients
- **Derivative crypto analytics clones**: Anything that feels like a reskinned DefiLlama or generic trading terminal without its own point of view

### Design Principles

1. **Data density over decoration** — every pixel earns its place by communicating information
2. **Calm authority, not loud urgency** — steady state is composed; risk signals shift the tone
3. **Precision as personality** — monospace numbers, exact percentages, named bands — trust through specificity
4. **Semantic color only** — color communicates state (health, risk, trend), never decoration
5. **Crypto-native, not mass-market** — simplify navigation when needed, but do not sand off the power-user edge
6. **Distinctive, not generic** — Pharos should feel authored and memorable, never like a template or a clone
