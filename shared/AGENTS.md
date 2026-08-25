# Shared Agent Notes

Applies to `shared/**`.

## Read First

- `docs/architecture.md`
- `docs/classification.md` for stablecoin or taxonomy work
- `docs/methodology-page.md` for scoring/versioned methodology work

Per-change routing is owned by `docs/doc-ownership.json`; run `node --import tsx scripts/ci/pharos-change-contract.ts` for the docs, checks, and rules that match the exact files you touch. The list above is the offline starting point, not the full contract.

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents shared-specific items.

- `shared/lib/**` is runtime-neutral and must compile under both the root and Worker TypeScript targets.
- Shared code may use the repository's ES2022 TypeScript target, but it must stay runtime-neutral and avoid frontend-only or Worker-only globals unless explicitly abstracted.
- Do not import `worker/src/**` or frontend-only `src/**` from shared code.

## Common Checks

- `npm run lint` for the ADR-2 worker import boundary
- `npm run check:stablecoin-data` when stablecoin metadata is affected
- Focused `shared/lib/__tests__` suites for touched logic
