# D1 Migration Authoring

Policy for every new `worker/migrations/` file; `worker/migrations/MANIFEST.md` owns the active/historical inventory.

## Additive migrations

The first three migrations in the reference and quantity rollout introduce the fields below. Before either Worker activates, apply all pending migrations through 0318. The [release procedure](../deployment-process.md#reference-and-supply-rollout) records the migration floor and deployment order.

| Migration | Additive change | Retained compatibility |
| --- | --- | --- |
| `0306_supply_history_native_quantity.sql` | Adds nullable native quantity, USD valuation price and valuation observation clock to `supply_history`. | Existing rows preserve dated USD supply and market-price evidence. Null quantity remains unavailable. |
| `0307_depeg_event_observation_references.sql` | Adds nullable peak and recovery references, peak quote domain, admitted coverage JSON and disposition to `depeg_events`. | Existing IDs and event fields remain readable. Null columns represent legacy evidence. |
| `0308_api_key_donor_transfer_credits.sql` | Adds an initially empty ledger keyed by supporter address, chain, transaction and transfer discriminator. | The transaction-keyed credit ledger and all prior credits remain available across Worker rollback. |

The schema changes populate no historical evidence. Run any quantity backfill, depeg repair or legacy receipt resolution through its reviewed write path after schema application.

The rollout also applies [`0315_mint_burn_rollback_protection.sql`](../../worker/migrations/0315_mint_burn_rollback_protection.sql), [`0316_supply_history_guard_native_unavailable.sql`](../../worker/migrations/0316_supply_history_guard_native_unavailable.sql), [`0317_depeg_pending_closure_rollback_guard.sql`](../../worker/migrations/0317_depeg_pending_closure_rollback_guard.sql), and [`0318_supply_history_guard_legacy_snapshot.sql`](../../worker/migrations/0318_supply_history_guard_legacy_snapshot.sql). Migration 0315 rewrites reviewed mint/burn rows and guards legacy classification and publication policy. Migration 0316 keeps a legacy price repair from restoring an implied quantity on an explicitly unavailable daily snapshot. Migration 0317 preserves clocked closure pendings if legacy confirmation would change the recorded benchmark or publish an inconsistent peak. Migration 0318 protects a legacy first close when its stock matches an assessment in the live cache and guards measured quantities against incompatible legacy repairs. Migrations 0316 through 0318 add triggers without rewriting history. The guards stay installed on Worker rollback.

1. Select the next unused sequence from the manifest. Never rename or reuse a deployed filename.
2. Add `-- rollout-safety: backward-compatible` to the migration.
3. Keep the previous Worker able to read and write while the migration runs before the new Worker deploys. New required columns need a default; table, column, and index removal belongs in a later coordinated cleanup.
4. Add the active migration row to the manifest and run `npm run check:migrations`.

Additive migrations do not need data-migration metadata.

Index-only migration `0303_tape_query_indexes.sql` installs the large-flow, freeze attempted-time, Telegram retry-error and reserve attempt-time access paths before the indexed Tape reader activates. Worker rollback retains all four indexes. The [manifest rollback note](../../worker/migrations/MANIFEST.md#rollback-procedure) owns bookmark/version evidence and first affected-path acceptance; successful index creation alone proves no runtime recovery.

Additive debt-table example `0280_mint_burn_dirty_hours.sql` precedes the maintenance writer: no baseline change, legacy seeding or business-row rewrite. Worker rollback retains schema/debt. Keep the verified pre-window Time Travel bookmark, ledger and Worker versions; observe source enqueue and first atomic rebuild separately from schema application. Restore D1 only for unexpected schema/data mutation.

`0281_mint_burn_scan_coverage.sql` likewise installs an empty prospective-evidence table before its writer; observe durable proof roundtrips before activating public readers. Never seed history from cursors, event ages or cron metadata. Worker rollback retains fingerprinted proof; old-writer cursor advances prove no scanned interval. Keep the pre-window bookmark, ledger and Worker identities; schema application is not writer-soak acceptance.

## Reviewed data migrations

`DELETE FROM`, `UPDATE` (including `UPDATE OR REPLACE` and `schema.table`-qualified targets), `REPLACE INTO` (SQLite's spelling of `INSERT OR REPLACE`), and `INSERT ... ON CONFLICT ... DO UPDATE` can mutate rows used by the still-running old Worker. A new migration containing one of these statements must include both headers:

```sql
-- rollout-safety: backward-compatible
-- data-migration: reviewed
```

It must also add a row to the manifest's **Reviewed Data Migrations** table documenting all four fields below. Empty or whitespace-only cells fail the gate with the migration filename and missing field:

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

Fresh/seeded temporary replays use supported Node's built-in `node:sqlite` `DatabaseSync`, never external `sqlite3` or fallback. Native database-open errors fail the gate.
