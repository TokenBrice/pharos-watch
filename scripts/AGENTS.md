# Scripts Agent Notes

Applies to scripts, excluding worker-bound tooling under worker/scripts.

## Read First

- `docs/scripts.md`
- `docs/testing.md#ci-pipeline`
- `docs/deployment-process.md`

## Invariants

- New `process.argv` readers must use `parseStrictCliArgs` or receive an explicit policy exemption; `check:cli-args-policy` enforces enrollment.
- Registered outputs, dependency phases, lifecycle, checkability, and `autoStage` belong to the artifact registry; do not hand-edit or normalize generated outputs.
- State-changing scripts preserve documented dry-run semantics: reads are allowed, filesystem or remote mutation is not.

## Entrypoints & Generation

- `scripts/ci/` contains merge/release guardrails; `scripts/maintenance/` contains generators, audits, and operator tooling.
- `scripts/lib/cli-args.mjs` owns strict parsing; `scripts/lib/automation-registry.mjs` owns generated-artifact routing.
- Use `npm run check:generated-artifacts` for freshness and `npm run sync:staged-artifacts` for registry-selected `autoStage` outputs.

## Tests

- `scripts/__tests__/`, `scripts/maintenance/__tests__/`, and `scripts/test-utils/__tests__/`; their TypeScript coverage is selected by `tsconfig.test-typecheck.json`.

## Common Checks

- `npm run check:cli-args-policy`; `npm run check:script-entrypoints`; `npm run check:generated-artifacts`; `npm run typecheck:tests`.
