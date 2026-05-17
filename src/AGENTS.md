# Frontend Agent Notes

Applies to `src/**`.

## Read First

- Route-specific docs from `docs/README.md`
- `docs/architecture.md`
- Design work: `docs/design-context.md`, `docs/design-language.md`, `docs/design-tokens.md`

## Rules

See root CLAUDE.md § High-Value Gotchas for cross-cutting rules. This file only documents src-specific items.

- Preserve static-export behavior. Route metadata, sitemap coverage, and crawlability can be part of the feature contract.
- Do not edit `src/components/ui/**` shadcn primitives unless explicitly required.
- API reads should go through shared hooks and `src/lib/api.ts` instead of direct provider calls.
- Keep frontend-only utilities under `src/lib/**`; runtime-neutral logic belongs in `shared/lib/**`.

## Common Checks

- Relevant component/page Vitest suites
- `npm run build` and `npm run seo:check` for Pages-impacting changes when validation is requested
