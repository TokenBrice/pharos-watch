# Frontend Agent Notes

Applies to `src/`.

## Read First

- Read the routed owning sections and `docs/architecture.md#frontend-runtime-and-seo-surface`.
- Design work: start with `docs/design-language.md#context`; token changes also use `docs/design-tokens.md#usage-guidelines` and its matching layer section.

## Rules

- Preserve static-export behavior and keep route metadata and crawlability aligned.
- `src/lib/public-route-inventory.ts`, `src/app/sitemap.ts`, and `src/app/robots.ts` own the route/SEO triad; check `public/_headers` when crawl or host behavior changes.
- API reads should use shared hooks and `src/lib/api.ts`; runtime-neutral logic belongs in `shared/lib/`.
- Never publish a display-capped or clamped value as a statistic (rule R7, ADR-34 in `docs/architecture.md`): a headline count, total, or ratio comes from the authoritative set, never from the `.slice()` that renders rows — keep the bound visible instead (`Top N of M`).

## Generated artifacts

- `src/generated/docs-metadata.json` and `src/generated/sitemap-dates.json` are git-history-derived build-time outputs; refresh with `npm run bootstrap:generated:history`.
- `src/generated/stablecoin-static-data.ts` and `src/generated/command-palette-search-data.ts` are generator-owned projections re-exported by `src/lib/stablecoin-static-data.ts` and `src/lib/command-palette-search-data.ts`; refresh with `npm run bootstrap:generated`.
- Generator ownership and phases live in `scripts/lib/automation-registry.mjs`; never hand-edit generated outputs.

## Common Checks

- Focused tests live under `src/app/`, `src/lib/__tests__/`, `src/hooks/__tests__/`, and `src/components/__tests__/`.
- For Pages-impacting changes, follow `docs/testing.md` § “Smallest adequate check per area”.
