# D1 Migration Authoring

Use this policy for every file added to `worker/migrations/`. The active and historical migration inventory remains authoritative in `worker/migrations/MANIFEST.md`.

## Additive migrations

1. Select the next unused sequence from the manifest. Never rename or reuse a deployed filename.
2. Add `-- rollout-safety: backward-compatible` to the migration.
3. Keep the previous Worker able to read and write while the migration runs before the new Worker deploys. New required columns need a default; table, column, and index removal belongs in a later coordinated cleanup.
4. Add the active migration row to the manifest and run `npm run check:migrations`.

Additive migrations do not need data-migration metadata.

## Reviewed data migrations

`DELETE FROM`, `UPDATE` (including `UPDATE OR REPLACE` and `schema.table`-qualified targets), `REPLACE INTO` (SQLite's spelling of `INSERT OR REPLACE`), and `INSERT ... ON CONFLICT ... DO UPDATE` can mutate rows used by the still-running old Worker. A new migration containing one of these statements must include both headers:

```sql
-- rollout-safety: backward-compatible
-- data-migration: reviewed
```

It must also add a row to the manifest's **Reviewed Data Migrations** table documenting:

- the exact predicate and rows affected;
- why the old Worker remains compatible throughout the migration;
- the pre-deploy Time Travel bookmark and rollback plan; and
- the expected minimum or maximum affected-row bound.

The migration gate replays each reviewed data migration from its immediate pre-migration schema, seeds representative existing rows for every DML target, and then executes the migration. A table created by the same migration has no pre-migration rows, so its state is covered by the fresh replay instead of a seeded fixture. A new pre-existing target table requires a representative fixture in `scripts/ci/check-worker-migrations.ts`; an empty fresh-database replay is not sufficient evidence. Migration 0236 is the only annotation grandfather and remains approved through its explicit manifest row.

A data-migration annotation is review evidence, not permission for destructive cleanup. If the previous Worker can no longer use the affected rows, use a separate cleanup rollout after the compatible Worker has soaked.

## Rollback and deployment

Before applying reviewed DML, retain the D1 Time Travel bookmark, deployed Worker version, migration ledger, expected predicate, and expected row bound. Migrations apply before Worker deployment. A Worker rollback does not reverse D1 data changes; restore from the recorded bookmark only when the migration caused unexpected mutation.

For baseline consolidation and remote rehearsal, follow [D1 Baseline Squash Policy](./d1-baseline-squash-plan.md). Remote read-only inspection uses `wrangler d1 execute --remote --command`, never `--file`.

## Verification

Run:

```bash
npm run check:migrations
npx vitest run scripts/__tests__/check-worker-migrations*.test.ts
```

`check:migrations` verifies manifest parity, rollout annotations, reviewed-DML evidence, seeded pre-migration replay, complete fresh replay, and `EXPECTED_SCHEMA.txt` object parity.
