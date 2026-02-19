# Stablecoin Dashboard (Pharos)

Analytics dashboard tracking ~130 stablecoins. Static Next.js 16 export → Cloudflare Pages. API: Cloudflare Worker + D1.

**Live at [pharos.watch](https://pharos.watch)**

## Core Principles

- DRY/KISS/YAGNI. Minimal impact. Find root causes, no temp fixes.
- When adding a data source, update the about page.
- **Plan first**: Enter plan mode for non-trivial tasks (3+ steps). If stuck, stop and re-plan.
- **Verify before done**: Prove it works — build, type-check, test. Never claim done without evidence.
- **Be autonomous**: Fix bugs end-to-end without hand-holding. Chase logs and errors yourself.
- **Learn from corrections**: Record recurring mistakes in auto-memory to avoid repeating them.

## Tech Stack

Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, Recharts, TradingView LW Charts, Cloudflare Workers + D1.

## Directory Overview

```
src/app/         — Pages (homepage, peg-tracker, blacklist, cemetery, liquidity, about, stablecoin/[id])
src/components/  — UI components (ui/ = shadcn primitives, do not edit)
src/hooks/       — TanStack Query hooks + shared state hooks
src/lib/         — Types, stablecoin list, formatters, classification, peg logic
worker/src/cron/ — Data sync crons
worker/src/api/  — REST API handlers (12 endpoints)
worker/src/lib/  — DB helpers, constants, shared utilities
```

## Commands

```bash
npm run dev                        # Frontend dev server
npm run build                      # Build + type-check
cd worker && npx wrangler dev      # Worker dev server
cd worker && npx tsc --noEmit      # Worker type-check
```

## Key Gotchas

- **Tailwind classes must be static strings** — never construct dynamically (purge won't find them)
- **Classification labels/colors**: all in `src/lib/classification.ts` — never define locally
- **Supply helpers**: use `getCirculatingRaw/USD()` from `src/lib/supply.ts`; USD variants for cross-currency totals
- **Hook timing**: `staleTime = cron interval`, `refetchInterval = 2× cron interval`
- **Worker imports `src/lib/`** — root tsconfig excludes `worker/` to avoid D1 type conflicts

## Topic References

Read these when working on related code:

- **`docs/architecture.md`** — Full file tree, API endpoints
- **`docs/classification.md`** — Classification system, peg currencies, gold/JPY/IDR stablecoins
- **`docs/dex-liquidity.md`** — Liquidity score algorithm, quality multipliers, DEX price cross-validation
- **`docs/data-pipeline.md`** — Price enrichment, data integrity guardrails, blacklist sync, on-chain supply verification
