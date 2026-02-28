# Stablecoin Dashboard (Pharos)

Analytics dashboard tracking ~143 stablecoins. Static Next.js 16 export → Cloudflare Pages. API: Cloudflare Worker + D1.

**Live at [pharos.watch](https://pharos.watch)**

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
src/app/         — Pages (homepage, blacklist, cemetery, liquidity, compare, digest, stability-index, safety-scores, dependency-map, portfolio, status, about, stablecoin/[id], stablecoins/[peg])
src/components/  — UI components (ui/ = shadcn primitives, do not edit)
src/hooks/       — TanStack Query hooks + shared state hooks
src/lib/         — Types, stablecoin list, formatters, classification, peg logic
worker/src/cron/ — Data sync crons
worker/src/api/  — REST API handlers (24 endpoints + 3 inline admin + POST feedback)
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
- **Classification labels/colors**: all in `src/lib/classification.ts` — never define locally
- **Supply helpers**: use `getCirculatingRaw/USD()` from `src/lib/supply.ts`; all values are in USD
- **Hook timing**: `staleTime = cron interval`, `refetchInterval = 2× cron interval`
- **Worker imports `src/lib/`** — root tsconfig excludes `worker/` to avoid D1 type conflicts
- **DL list vs detail API**: The list endpoint (`stablecoins.llama.fi/stablecoins`) returns `circulating` values already in USD for all peg types. The detail endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns native currency values for non-USD pegs. Do NOT multiply list endpoint values by price — that double-converts.
- **No supply overrides**: Supply data comes from DefiLlama only. No on-chain, CMC, or DEX overrides. Prices fall back to CG → CMC → DexScreener when DL has no price.

## Topic References

Read these when working on related code:

- **`docs/architecture.md`** — Full file tree, API endpoints
- **`docs/api-reference.md`** — Full API reference: all endpoints (24 router handlers + 3 inline admin + POST feedback), query params, response shapes, caching
- **`docs/classification.md`** — Classification system, peg currencies, gold/JPY/IDR stablecoins
- **`docs/dex-liquidity.md`** — Liquidity score algorithm, quality multipliers
- **`docs/stability-index.md`** — PSI formula, components, condition bands, calibration
- **`docs/report-cards.md`** — Grading dimensions, weights, thresholds, dependency propagation, portfolio analyzer, stress test
- **`docs/data-pipeline.md`** — Price enrichment, data integrity guardrails, blacklist sync
- **`docs/design-tokens.md`** — 3-layer design token architecture (primitives, semantic, component tokens)
- **`docs/design-language.md`** — Typography, spacing, cards, tables, charts, interactive states, loading/error patterns
- **`docs/testing.md`** — Test & lint setup, conventions, CI pipeline, adding new tests
- **`docs/feedback-pipeline.md`** — Feedback widget, POST /api/feedback, rate limiting, auto-verification, GitHub routing, env vars
- **`docs/digest-pipeline.md`** — Daily digest generation, LLM call, D1 storage, Twitter + Telegram distribution, API endpoints, frontend, SSG pipeline
