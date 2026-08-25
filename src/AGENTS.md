# Frontend Agent Notes

Applies to `src/**`.

## Read First

- Route-specific docs from `docs/README.md`
- `docs/architecture.md`
- Design work: `docs/design-context.md`, `docs/design-language.md`, `docs/design-tokens.md`

Per-change routing is owned by `docs/doc-ownership.json`; run `node --import tsx scripts/ci/pharos-change-contract.ts` for the docs, checks, and rules that match the exact files you touch. The list above is the offline starting point, not the full contract.

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents src-specific items.

- Preserve static-export behavior. Route metadata, sitemap coverage, and crawlability can be part of the feature contract.
- When route behavior, metadata, or crawlability changes, verify the triad of `src/app/sitemap.ts`, `src/app/robots.ts`, and `public/_headers` alongside the route file.
- Do not edit `src/components/ui/**` shadcn primitives unless explicitly required.
- API reads should go through shared hooks and `src/lib/api.ts` instead of direct provider calls.
- Keep frontend-only utilities under `src/lib/**`; runtime-neutral logic belongs in `shared/lib/**`.

## Common Checks

- Relevant component/page Vitest suites
- `npm run build` and `npm run seo:check` for Pages-impacting changes when validation is requested
- `npm run check:verified-doc-links` and `npm run check:doc-source-paths` when route docs or source-path references change
