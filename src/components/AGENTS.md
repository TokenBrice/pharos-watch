# Component Agent Notes

Applies to reusable product components under `src/components/`.

## Read First

- [Design language](../../docs/design-language.md)
- [Design tokens](../../docs/design-tokens.md)
- [Data visualization](../../docs/data-visualization.md)
- [Design context](../../docs/design-context.md)

## Invariants

- Tailwind classes must be static strings; this root rule is prose-enforced.
- Do not edit `src/components/ui/` shadcn primitives unless explicitly required.
- Classification labels and colors come only from `shared/lib/classification.ts`.
- Product tables use `src/components/table/` primitives; `npm run check:table-primitives` enforces the allowed raw-table exceptions.

## Entrypoints & generation

- Reusable product UI starts in `src/components/`; primitives live in `src/components/ui/`, utilities/tokens originate in `src/app/globals.css` and `src/styles/tokens/`, and this subtree has no generated output.

## Tests

- Tests live in `src/components/__tests__/` or beside the component; accessibility coverage runs with `npm run test:a11y`.

## Common checks

- Run `npm run check:table-primitives`, `npm run check:client-registry-imports`, and `npm run check:shared-types-imports` as applicable.
- Run focused component tests plus `npm run test:a11y` for interaction, semantic, or visualization changes.
