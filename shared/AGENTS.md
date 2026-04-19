# Shared Agent Notes

Applies to `shared/**`.

## Read First

- `docs/architecture.md`
- `docs/classification.md` for stablecoin or taxonomy work
- `docs/methodology-page.md` for scoring/versioned methodology work

## Rules

- `shared/lib/**` is runtime-neutral and must compile under both the root and Worker TypeScript targets.
- Shared code may use the repository's ES2022 TypeScript target, but it must stay runtime-neutral and avoid frontend-only or Worker-only globals unless explicitly abstracted.
- Import shared runtime logic as `@shared/lib/...` from frontend code; import shared type/schema modules as `@shared/types...`. Avoid relative cross-boundary imports.
- Do not import `worker/src/**` or frontend-only `src/**` from shared code.
- Classification labels and colors live in `shared/lib/classification.ts`; do not redefine them locally.
- Use `getCirculatingRaw()` from `shared/lib/supply.ts` for circulating-supply semantics.

## Common Checks

- `npm run check:worker-boundary`
- `npm run check:shared-cycles`
- `npm run check:stablecoin-data` when stablecoin metadata is affected
- Focused `shared/lib/__tests__` suites for touched logic
