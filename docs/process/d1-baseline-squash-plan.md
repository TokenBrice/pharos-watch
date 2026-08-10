# D1 Baseline Squash Policy

Use this procedure to consolidate the post-baseline tail in `worker/migrations/`. The migration files and `worker/migrations/MANIFEST.md` are the inventory source of truth; this document intentionally does not duplicate their current counts or range.

## Scheduling Gate

The latest squash (`0000_baseline.sql`, S-03 / P4-01) landed on 2026-07-30 and consolidated migrations 0001–0227. Review another squash when either condition is met:

- about 12 months have passed since the previous baseline; or
- more than 80 active migrations have accumulated after the baseline.

Run `npm run check:migrations` for the current active/retired inventory. Crossing a threshold starts scheduling and rehearsal; it does not authorize an unsupervised production change.

## Preconditions

- Schedule a Sunday low-traffic window, normally 03:00-05:00 UTC.
- Announce a soft migration freeze. Incident fixes may proceed only with an explicit announcement and a new rehearsal after the fix lands.
- Record the current D1 Time Travel bookmark and deployed Worker version.
- Use named scratch D1 databases and the remote-target flag for rehearsal. Do not validate a production squash only against the local emulator.
- Use the latest squash commit `5ea2d360f` as the implementation reference, then re-check current Wrangler behavior before executing.

## Procedure

1. Apply the complete current migration tree to a fresh rehearsal D1 database.
2. Export the resulting schema and required seed rows into a replacement `0000_baseline.sql`, following the existing idempotent baseline style.
3. Apply the proposed squashed tree to a second fresh D1 database.
4. Compare `sqlite_master`, index lists, trigger definitions, and seeded row counts between both scratch databases. Any difference blocks the squash.
5. Point a preview Worker at the second database. Run the preview smoke set and one full cron tick; verify the cron ledgers and status probes show no migration-name coupling.
6. Move every absorbed filename into a new squash block in `worker/migrations/MANIFEST.md`. Keep retired entries and historical filenames explicit, and leave only the new baseline plus the unsquashed tail on disk.
7. Run `npm run check:migrations` and the normal focused Worker checks. Land the baseline, manifest, and file removals as one logical commit.
8. During the production window, run the normal migration/deploy path and verify that the existing production database executes zero migration SQL for the squash. Existing databases already record the absorbed filenames; the replacement baseline is for fresh databases.
9. Observe a full cron tick and the standard production probes, then keep the migration freeze through a 24-hour soak.

## Failure And Recovery

- A rehearsal mismatch is a hard stop. Fix the generated baseline or restore the original tree and repeat both scratch-database runs.
- If production attempts to execute migration SQL, stop before the Worker deploy and investigate ledger/filename drift.
- If only the Worker is faulty, redeploy the previous Worker version. Do not restore D1 for a code-only failure.
- If production data or schema was unexpectedly mutated, use the pre-window Time Travel bookmark, restore the prior migration tree, and redeploy the previous Worker.
- Do not renumber unsquashed migrations or reuse retired filenames. `worker/migrations/MANIFEST.md` and `npm run check:migrations` enforce that history.
