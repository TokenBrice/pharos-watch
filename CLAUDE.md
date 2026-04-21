# Stablecoin Dashboard (Pharos)

Analytics dashboard tracking 205 stablecoins (+2 shadow assets for PSI). Static Next.js 16 export to Cloudflare Pages. API: Cloudflare Worker + D1.

Live: https://pharos.watch

## Methodology

- State assumptions before non-trivial work; ask when ambiguity blocks a safe choice.
- Prefer the simplest root-cause fix. Do not add features, abstractions, fallback paths, or configurability that were not requested.
- Make surgical changes. Match existing style, avoid unrelated refactors, and remove only unused code created by your change.
- For non-trivial work, define success criteria, make a short plan, and re-plan if the approach stops making sense.
- Verify before claiming completion with the relevant build, type-check, lint, and tests.
- Surface tradeoffs or simpler alternatives when they change the implementation choice.

## Operating Rules

- Put agent-generated plans, audits, research, and process notes in `/agents/`.
- Treat `/docs/` and `README.md` as the verified documentation corpus.
- Preserve existing product and design system patterns unless explicitly asked for a redesign.
- Read only the docs relevant to the area you touch. Start with `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, and `docs/worker-and-api-limits.md`.
- For design work, read `docs/design-context.md`, `docs/design-language.md`, and `docs/design-tokens.md`.
- For methodology work, read the specific methodology doc plus its timeline doc.
- Update matching docs for behavior, API, pipeline, methodology, or data-source changes.
- If you add a data source, update the about page.
- If you change pricing pipeline, PSI, PegScore/DEWS, LiquidityScore, Report Cards, blacklist tracker, mint/burn flow, yield intelligence, or Chain Health, update `/methodology` and the relevant changelog/timeline doc.
- Methodology versions must increase numerically, not semver-style. After v5.9, use v5.91 for a minor update or v6.0 for a major update, not v5.10.
- You are logged into wrangler; use it for debugging when useful.

## Repo Map

```text
src/app/         - routes/pages
src/components/  - app components (`ui/` = shadcn primitives; do not edit)
src/hooks/       - TanStack Query hooks + shared state hooks
src/lib/         - frontend-only utilities
functions/       - Cloudflare Pages Functions
shared/lib/      - runtime-neutral shared logic
worker/src/api/  - Worker API handlers
worker/src/cron/ - Worker cron jobs
worker/src/lib/  - Worker runtime/auth/cache/helpers/constants
```

## Commands

```bash
npm run dev
npm run build
npm run lint
npm test
npm run test:watch
cd worker && npx tsc --noEmit
cd worker && npx wrangler dev
```

## Pre-Push Validation

Before pushing, run:

```bash
npm run test:merge-gate
```

Fix failures locally before pushing. The merge gate skips cleanly for non-deploy-impacting diffs and adds Pages build/SEO or worker type-check coverage for deploy-impacting diffs.

## Web Fetching

- Prefer API endpoints over scraping for CoinGecko, Etherscan, DefiLlama, and similar data sources.

## High-Value Gotchas

- Tailwind classes must be static strings.
- Classification labels and colors live in `shared/lib/classification.ts`; do not redefine them locally.
- Use `getCirculatingRaw()` from `shared/lib/supply.ts`; DefiLlama list `circulating` values are already USD-denominated.
- Do not multiply DefiLlama list-endpoint supply values by price. The detail endpoint differs for non-USD pegs.
- Do not add manual/on-chain/CMC/DEX supply overrides. Primary supply is DefiLlama, with the existing fallback path only.
- `@shared/*` maps to `shared/*`; always import via `@shared/lib/...`.
- Root TS config excludes `worker/` to avoid D1 type conflicts. Shared runtime-neutral logic belongs in `shared/lib/`.
- Hook timing rule: `staleTime = cron interval`, `refetchInterval = 2x cron interval`.
- Worker cron jobs share Cloudflare's per-trigger 6-connection pool across all `ctx.waitUntil()` work; consume response bodies before opening more fetches.
- Standard deploy applies D1 migrations before the new Worker is live. New migrations must stay backward-compatible; destructive cleanup needs a separate coordinated rollout.
