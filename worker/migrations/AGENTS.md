# Worker Migration Agent Notes

Applies to worker/migrations and its D1 schema lineage.

## Read First

- `worker/migrations/MANIFEST.md`
- `docs/process/d1-baseline-squash-plan.md`
- `docs/worker-infrastructure.md#completed-d1-schema-cleanup`

## Invariants

- `worker/migrations/0000_baseline.sql` is fresh-database-only; existing databases continue through the active tail recorded in the manifest.
- Never reuse a historical sequence or filename, including entries absorbed into the baseline; `check:migrations` enforces tree/manifest inventory but review guards renumbering.
- Migrations run before the new Worker is live, so additions stay backward-compatible; destructive cleanup requires a separate coordinated rollout.

## Entrypoints & Generation

- `worker/migrations/MANIFEST.md` owns baseline, active-tail, retired-lineage, and cleanup inventory.
- Add SQL under `worker/migrations/` at the next unused sequence and update the manifest in the same change; no generator owns migration SQL.

## Tests

- Migration SQL has no colocated suite; exercise affected stores in `worker/src/lib/__tests__/` and affected handlers in `worker/src/api/__tests__/`.

## Common Checks

- `npm run check:migrations`; `npm run check:sql-safety`.
