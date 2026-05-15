# D1 Baseline Squash #2 — Planning Doc

Planning doc for the second baseline squash of `worker/migrations/`. Execution is out of scope here; this doc captures the cadence policy, procedure outline, risk model, and open questions so a future squash can be scheduled deliberately.

## Why squash now

- The previous squash (`0000_baseline.sql`, S-014) landed on **2026-03-25**, consolidating migrations 0001–0071.
- Since then the tree has grown to **57 individual migrations** (0072–0129) plus the baseline, with **1 retired** entry (0086 `treasury_stable_exposure_history`).
- Total active `.sql` files under `worker/migrations/` today: **58** (verified via `ls worker/migrations/*.sql | wc -l`).
- Fresh-database setup currently replays the baseline plus 57 sequential migrations — back near where 0001–0071 sat before the first squash. The next squash should be planned, not reactive.

## Squash policy

Trigger a baseline squash when **either** of these conditions is met:

- **Cadence:** ~12 months since the previous baseline (target Q1 2027 for squash #2 given S-014 landed 2026-03-25), **or**
- **Count:** active individual migrations exceed **80** files past the current baseline.

Justification for the count threshold: the first squash absorbed 71 migrations and produced a 950-line baseline file. Keeping the post-baseline tail under ~80 files preserves a similar "one comprehensible squash" envelope and keeps fresh setup ledger churn bounded for new contributors and preview environments.

The thresholds are intentionally loose — neither alone forces a squash. They exist to surface the decision and force a scheduled rollout rather than letting the tree drift indefinitely.

## Execution checklist

Reference: prior squash commit `fb267826d` (`chore: squash D1 migrations 0001-0071 into baseline`).

1. **Freeze new migrations** for the squash window. Announce in the operator channel; PRs that touch `worker/migrations/` are blocked until the squash lands.
2. **Spin up a fresh scratch D1** (e.g. `stablecoin-db-squash-rehearsal`). Apply the full current migration tree from 0000 onward via `wrangler d1 migrations apply --remote`.
3. **Dump the schema and required seed data** from the rehearsal DB into a single replacement `0000_baseline.sql` (idempotent `CREATE TABLE IF NOT EXISTS` style matching the existing baseline). Include any seed rows the current baseline includes (cf. existing 0000_baseline contents).
4. **Verify byte-for-byte schema equivalence** by spinning up a second fresh scratch DB with only the new baseline, then comparing `sqlite_master` rows, index lists, and trigger definitions against the rehearsal DB. Run a sampled `SELECT COUNT(*) FROM <table>` sweep across all critical tables to confirm row count parity for any seeded data.
5. **Replay safety drill on a preview Worker.** Point a preview Worker version at the squash-rehearsal DB and run the existing preview smoke set. Confirm no migration-name drift surfaces in `cron_runs`, `cron_slot_executions`, or any other ledger that records migration filenames.
6. **Archive the squashed migrations** under MANIFEST notation. Move squashed file paths into a new "Squashed Individual Migrations (Squash #2)" table block in `worker/migrations/MANIFEST.md` mirroring the format used for the 0001–0071 range. Bump the "Squash date" line to the new date and reference the squash range.
7. **Land the squash commit** with a body matching the S-014 template ("Fresh databases apply the consolidated 0000_baseline.sql then ..."). Do not amend; create a new commit on a dedicated branch.
8. **Production deploy** during a low-traffic window. The production DB already has every migration in its ledger so it skips the new baseline; verify zero migrations execute on the production apply step.
9. **Unfreeze** new migrations after a 24h soak with no anomaly on production cron history or status probes.

## Risks and rollback

- **Risk: baseline schema drifts from production.** Mitigation: step 4's sqlite_master diff against a fresh-applied tree. If drift appears post-squash, restore production via D1 Time Travel to a bookmark captured immediately before the squash apply (retention window permitting).
- **Risk: D1 migration ledger records the new `0000_baseline.sql` as already applied on existing DBs.** This is the intended behavior (ledger keys by filename) and is the same property the first squash relied on. The only failure mode is if a future migration is ever numbered below the baseline; the MANIFEST and `check:migrations` guard against this.
- **Risk: archived migration files become unreferenceable.** Mitigation: the MANIFEST keeps the full historical filename list, and the off-Cloudflare backup plan (see [`d1-backup-plan.md`](./d1-backup-plan.md)) provides a second recovery path that does not depend on replay from the migration tree.
- **Rollback path:** revert the squash commit, restore production via Time Travel to the pre-squash bookmark, redeploy the previous Worker version. The migration ledger on production is untouched by the squash itself (no rows execute), so revert is a code-only operation in the common case.

## Open questions for the operator

- **Target date.** Q1 2027 cadence-trigger vs. earlier count-triggered squash; depends on migration velocity through 2026 H2.
- **Deploy window.** Preference for a weekend low-traffic window vs. weekday with full on-call coverage.
- **Recoverability SLO during the squash window.** How aggressive should the migration freeze be — strict block, or soft freeze with a documented exception path for incident-driven fixes?
- **Preview rehearsal scope.** Smoke set sufficient, or run a full cron tick on the rehearsal DB before signing off?
- **Backup interaction.** Confirm an off-Cloudflare backup (see [`d1-backup-plan.md`](./d1-backup-plan.md)) is captured immediately pre-squash so recovery beyond Time Travel retention is available if the squash needs to be undone weeks later.
