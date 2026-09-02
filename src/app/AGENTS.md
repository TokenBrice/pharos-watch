# App Router Agent Notes

Applies to `src/app/` route entrypoints, layouts, metadata, and route-local UI.

## Read First

- Route-spec examples: [homepage](../../docs/homepage.md), [screener](../../docs/screener-page.md), [stablecoin detail](../../docs/stablecoin-detail-page.md)
- [Frontend runtime and SEO](../../docs/architecture.md#frontend-runtime-and-seo-surface)

## Invariants

- Preserve static export (`next.config.ts`); `npm run build` is the only full render proof.
- Keep server components by default; introduce a client boundary only for browser state, effects, or interaction.
- Keep public-route membership and crawl policy aligned across `src/lib/public-route-inventory.ts`, `src/app/sitemap.ts`, `src/app/robots.ts`, and `public/_headers`.
- Next.js 16 differs from prior versions: read the matched App Router guide in `node_modules/next/dist/docs/` before using framework APIs.

## Entrypoints & generation

- `src/app/` owns App Router pages, layouts, route handlers, metadata, and `src/app/globals.css`; route-specific behavior stays with its owning page spec.
- Generated route families flow from their registries into the public inventory and sitemap; do not maintain a second route roster.

## Tests

- Keep route-specific tests colocated under `src/app/`; shared sitemap, robots, and route contracts live in `src/app/__tests__/`.

## Common checks

- Pages/SEO: `npm run seo:check`; full render/export: `npm run build`.
- Sensitive or host-policy routes: `npm run check:sensitive-page-copy` and `npm run check:site-csp-sync`.
