# Stablecoin Dashboard (Pharos)

Analytics dashboard tracking 181 stablecoins (+2 shadow assets for PSI). Static Next.js 16 export -> Cloudflare Pages. API: Cloudflare Worker + D1.

Live: https://pharos.watch

## Core Rules

- Keep changes minimal, direct, and root-cause driven. No temporary fixes.
- For non-trivial work, make a plan first. Re-plan if the approach stops being coherent.
- Verify before claiming completion. Run the relevant build, type-check, lint, and tests.
- Update the matching docs for any behavior, API, pipeline, or methodology change.
- If you add a data source, update the about page.
- If you change PSI, PegScore, LiquidityScore, Report Cards, DEWS, blacklist, mint/burn, or yield methodology, also update `/methodology` and the relevant timeline doc.
- You are logged into wrangler: feel free to use it for debugging.

## Working Set

- Put agent-generated plans, audits, and research notes in `/agents/`.
- Treat `/docs/` as the verified documentation corpus.
- Preserve existing product and design system patterns unless the task is explicitly a redesign.

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
worker/src/lib/  - Worker DB/helpers/constants
```

## Commands

```bash
npm run dev
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
cd worker && npx wrangler dev
```

## Pre-Push Validation

**Before pushing to any branch, always run the local merge gate:**

```bash
npm run test:merge-gate
```

This mirrors the full CI validation suite (lint, all checks, tests, coverage, worker typecheck), plus the Pages build and SEO checks that now run in shared CI. Do NOT push until it passes. In the standard npm setup, the repo pre-push hook is configured automatically via `prepare` and runs the merge gate for every push. If hooks are disabled locally, run it manually before pushing.
If the merge gate fails, fix the issue locally and re-run. Do not push hoping CI will pass.

## High-Value Gotchas

- Tailwind classes must be static strings.
- Classification labels and colors live in `shared/lib/classification.ts`; do not redefine them locally.
- Use `getCirculatingRaw()` from `shared/lib/supply.ts`; DefiLlama list `circulating` values are already USD-denominated.
- `@shared/*` maps to `shared/*`; always import via `@shared/lib/...`.
- Root TS config excludes `worker/` to avoid D1 type conflicts. Shared runtime-neutral logic belongs in `shared/lib/`.
- Hook timing rule: `staleTime = cron interval`, `refetchInterval = 2x cron interval`.
- Worker cron jobs share Cloudflare's per-trigger 6-connection pool across all `ctx.waitUntil()` work; consume response bodies before opening more fetches.
- Do not multiply DefiLlama list-endpoint supply values by price. The detail endpoint differs for non-USD pegs.
- Do not add manual/on-chain/CMC/DEX supply overrides. Primary supply is DefiLlama, with the existing fallback path only.
- Standard deploy applies D1 migrations before the new Worker is live. New migrations must stay backward-compatible; destructive cleanup needs a separate coordinated rollout.

## Documentation

- Read only the docs relevant to the area you touch, not the entire docs tree.
- Start with `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, and `docs/worker-and-api-limits.md`.
- Then read the area-specific doc for the feature or pipeline you are changing.
- For design work, use `docs/design-context.md`, `docs/design-language.md`, and `docs/design-tokens.md`.
- For methodology work, use the specific methodology doc plus its timeline doc.

## Browser Automation

`cmux browser` is available in the terminal for interacting with web pages — use it when `WebFetch` returns a 403 or when you need DOM interaction, visual verification, or form submission. Full command reference: [`agents/process/cmux-browser.md`](agents/process/cmux-browser.md). Upstream docs: https://cmux.com/docs/browser-automation.

## Design Summary

- Pharos is a data-dense, dark-first, crypto-native analytics product for power users.
- Default tone is calm and precise; risk states should feel urgent without becoming noisy.
- Use semantic color for meaning, not decoration.
- Preserve the established Pharos visual language: frost-blue accents, Geist Sans for UI, Geist Mono for numeric precision.
- Avoid generic SaaS dashboards, corporate fintech polish, and clichéd Web3 marketing aesthetics.
