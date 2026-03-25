# Stablecoin Dashboard (Pharos)

Analytics dashboard tracking 181 stablecoins (+2 shadow assets for PSI). Static Next.js 16 export → Cloudflare Pages. API: Cloudflare Worker + D1.

**Live at [pharos.watch](https://pharos.watch)**

## Folder Structure

All agent-produced plans, audits, research, and process notes live in the `/agents/` folder. Treat `/agents/` as a working-artifact archive, not as the canonical source of truth over live code or `/docs/`.
**`/docs/` is the verified application documentation corpus**

## Core Principles

- DRY/KISS/YAGNI. Minimal impact. Find root causes, no temp fixes.
- When adding a data source, update the about page.
- **Plan first**: Enter plan mode for non-trivial tasks (3+ steps). If stuck, stop and re-plan.
- **Verify before done**: Prove it works — build, type-check, test. Never claim done without evidence.
- **Be autonomous**: Fix bugs end-to-end without hand-holding. Chase logs and errors yourself.
- **Learn from corrections**: Record recurring mistakes in auto-memory to avoid repeating them.

## Tech Stack

Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, Recharts, Cloudflare Workers + D1.

- You are logged into wrangler: feel free to use it for debugging.

## Directory Overview

```
src/app/         — Pages (homepage, admin, blacklist, cemetery, chains, chains/[chain], compare, coverage, dependency-map, depeg, digest, flows, liquidity, methodology, portfolio, privacy, safety-scores, stability-index, start, status, telegram, about, yield, stablecoin/[id], stablecoins/[peg], stablecoins/backing/[backing], stablecoins/governance/[governance])
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

## Pre-Push Validation

**Before pushing to any branch, always run the local merge gate:**

```bash
npm run test:merge-gate
```

This mirrors the full CI validation suite (lint, all checks, tests, coverage, worker typecheck). Do NOT push until it passes. The git pre-push hook enforces this automatically for pushes to `main`, but you should run it manually for any branch to catch failures before CI.

If the merge gate fails, fix the issue locally and re-run — do not push hoping CI will pass.

## Web Fetching

- **APIs first**: When fetching data from CoinGecko, Etherscan, DefiLlama, etc., always prefer their API endpoints over scraping web pages. APIs are structured, reliable, and rarely return 403s.
- **cmux browser for everything else**: For websites, docs pages, visual verification, form interaction, and any URL that returns a 403 with `WebFetch`, use `cmux browser` (built into the terminal session). It provides full browser automation: navigation, DOM interaction, JS eval, screenshots, and session persistence. See [`agents/process/cmux-browser.md`](agents/process/cmux-browser.md) for the full command reference and [upstream docs](https://cmux.com/docs/browser-automation).

## Key Gotchas

- **Tailwind classes must be static strings** — never construct dynamically (purge won't find them)
- **Classification labels/colors**: all in `shared/lib/classification.ts` — never define locally
- **Supply helpers**: use `getCirculatingRaw()` from `shared/lib/supply.ts`; all values are already in USD (DL converts)
- **Hook timing**: `staleTime = cron interval`, `refetchInterval = 2× cron interval`
- **Workers 6-connection limit is per-cron-trigger, not per-job** — all `ctx.waitUntil()` jobs on the same cron slot share one 6-connection pool. Consume response bodies before starting new fetch batches to release connections for sibling jobs.
- **Worker shared boundary**: worker and frontend share runtime-neutral logic via `shared/lib/` (`@shared/*` alias); root tsconfig excludes `worker/` to avoid D1 type conflicts
- **DL list vs detail API**: The list endpoint (`stablecoins.llama.fi/stablecoins`) returns `circulating` values already in USD for all peg types. The detail endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns native currency values for non-USD pegs. Do NOT multiply list endpoint values by price — that double-converts.
- **No manual/on-chain/CMC/DEX supply overrides**: primary supply comes from DefiLlama, with CoinGecko market-cap fallback only for supplemental non-DefiLlama assets and full-cache fallback when the DefiLlama stablecoins source is unavailable.

## Documentation

All the codebase is documented in `/docs/`. Filenames are self-descriptive. While working, update the corresponding doc before pushing. After updating a scoring methodology (PSI, PegScore, LiquidityScore, Report Cards), update both the `/methodology` page and the relevant `*-timeline.md` changelog in `/docs/`.

See **`docs/design-context.md`** before any frontend/UI work.
