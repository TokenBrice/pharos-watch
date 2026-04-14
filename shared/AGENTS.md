# Shared Agent Notes

Applies to `shared/**`.

## Read First

- `docs/architecture.md`
- `docs/classification.md` for stablecoin or taxonomy work
- `docs/methodology-page.md` for scoring/versioned methodology work

## Rules

- `shared/lib/**` is runtime-neutral and must compile under both root ES2017 and Worker ES2021 targets.
- Avoid post-ES2017 syntax in shared modules, including `??=`, `||=`, and `Array.at()`.
- Import shared modules as `@shared/lib/...` from frontend code.
- Do not import `worker/src/**` or frontend-only `src/**` from shared code.
- Classification labels and colors live in `shared/lib/classification.ts`; do not redefine them locally.
- Use `getCirculatingRaw()` from `shared/lib/supply.ts` for circulating-supply semantics.

## Common Checks

- `npm run check:worker-boundary`
- `npm run check:shared-cycles`
- `npm run check:stablecoin-data` when stablecoin metadata is affected
- Focused `shared/lib/__tests__` suites for touched logic
