# Component Agent Notes

Applies to reusable product components under `src/components/`.

## Read First

- Read the owning sections returned by the router. Visual/design changes start with [Design context](../../docs/design-language.md#context).
- Token changes: [Usage guidelines](../../docs/design-tokens.md#usage-guidelines), then the matching token layer.
- Charts and data displays: [Encoding](../../docs/data-visualization.md#encoding), [Accessibility](../../docs/data-visualization.md#accessibility), and the section for the affected interaction.

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

- Run `npm run check:table-primitives` and `npm run check:shared-types-imports` as applicable.
- Run focused component tests plus `npm run test:a11y` for interaction, semantic, or visualization changes.
