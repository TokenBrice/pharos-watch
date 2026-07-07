# D1 Baseline Squash #2 — Planning Doc

Planning doc for the second baseline squash of `worker/migrations/`. Execution is out of scope here; this doc captures the cadence policy, procedure outline, risk model, and open questions so a future squash can be scheduled deliberately.

## Why squash now

- The previous squash (`0000_baseline.sql`, S-014) landed on **2026-03-25**, consolidating migrations 0001–0071.
- Since then the tree has grown to **99 individual migrations** (0072–0171, excluding retired 0086 `treasury_stable_exposure_history`) plus the baseline, with **1 retired** entry recorded in the manifest.
- Total active `.sql` files under `worker/migrations/` today: **100** (verified via `find worker/migrations -maxdepth 1 -type f -name '*.sql' | wc -l`).
- Fresh-database setup currently replays the baseline plus 99 sequential migrations — well past where 0001–0071 sat before the first squash. The next squash should be planned, not reactive.

## Squash policy

Trigger a baseline squash when **either** of these conditions is met:

- **Cadence:** ~12 months since the previous baseline (target Q1 2027 for squash #2 given S-014 landed 2026-03-25), **or**
- **Count:** active individual migrations exceed **80** files past the current baseline.

Justification for the count threshold: the first squash absorbed 71 migrations and produced a 950-line baseline file. Keeping the post-baseline tail under ~80 files preserves a similar "one comprehensible squash" envelope and keeps fresh setup ledger churn bounded for new contributors and preview environments.

The thresholds are intentionally loose — neither alone forces a squash. They exist to surface the decision and force a scheduled rollout rather than letting the tree drift indefinitely.

## Execution checklist

Reference: prior squash commit `fb267826d` (`chore: squash D1 migrations 0001-0071 into baseline`).

1. **Freeze new migrations** for the squash window. Announce in the operator channel; PRs that touch `worker/migrations/` are blocked until the squash lands.
2. **Spin up a fresh scratch D1** (e.g. `stablecoin-db-squash-rehearsal`). Apply the full current migration tree from 0000 onward to that named scratch database; include the D1 remote-target flag in the apply command so the rehearsal runs against Cloudflare D1, not a local emulator.
3. **Dump the schema and required seed data** from the rehearsal DB into a single replacement `0000_baseline.sql` (idempotent `CREATE TABLE IF NOT EXISTS` style matching the existing baseline). Include any seed rows the current baseline includes (cf. existing 0000_baseline contents).
4. **Verify byte-for-byte schema equivalence** by spinning up a second fresh scratch DB with only the new baseline, then comparing `sqlite_master` rows, index lists, and trigger definitions against the rehearsal DB. Run a sampled `SELECT COUNT(*) FROM <table>` sweep across all critical tables to confirm row count parity for any seeded data.
5. **Replay safety drill on a preview Worker.** Point a preview Worker version at the squash-rehearsal DB and run the existing preview smoke set. Confirm no migration-name drift surfaces in `cron_runs`, `cron_slot_executions`, or any other ledger that records migration filenames.
6. **Archive the squashed migrations** under MANIFEST notation. Move squashed file paths into a new "Squashed Individual Migrations (Squash #2)" table block in `worker/migrations/MANIFEST.md` mirroring the format used for the 0001–0071 range. Bump the "Squash date" line to the new date and reference the squash range.
7. **Land the squash commit** with a body matching the S-014 template ("Fresh databases apply the consolidated 0000_baseline.sql then ..."). Do not amend. Follow the current repo operating rule: commit on `main` unless the operator explicitly asks for a dedicated branch/worktree for the squash window.
8. **Production deploy** during a low-traffic window. The production DB already has every migration in its ledger so it skips the new baseline; verify zero migrations execute on the production apply step.
9. **Unfreeze** new migrations after a 24h soak with no anomaly on production cron history or status probes.

## Risks and rollback

- **Risk: baseline schema drifts from production.** Mitigation: step 4's sqlite_master diff against a fresh-applied tree. If drift appears post-squash, restore production via D1 Time Travel to a bookmark captured immediately before the squash apply (retention window permitting).
- **Risk: D1 migration ledger records the new `0000_baseline.sql` as already applied on existing DBs.** This is the intended behavior (ledger keys by filename) and is the same property the first squash relied on. The only failure mode is if a future migration is ever numbered below the baseline; the MANIFEST and `check:migrations` guard against this.
- **Risk: archived migration files become unreferenceable.** Mitigation: the MANIFEST keeps the full historical filename list. Production data itself remains in D1 across the squash (no rows execute on existing DBs), so the migration tree's role is reduced to fresh-environment bootstrap once squashed.
- **Rollback path:** revert the squash commit, restore production via Time Travel to the pre-squash bookmark, redeploy the previous Worker version. The migration ledger on production is untouched by the squash itself (no rows execute), so revert is a code-only operation in the common case.

## Settled decisions (2026-05-15)

- **Target date:** **Q1 2027** (≈12 months after the first squash, which landed 2026-03-25). The active post-baseline migration count has already crossed 80 files (99 as of this update), so per the count threshold the schedule should be pulled forward rather than left pending for Q1 2027.
- **Deploy window:** **Sunday early-morning UTC** (≈03:00–05:00 UTC). Catches EU and US in deep off-hours and matches the existing low-traffic deploy pattern.
- **Migration-freeze rigor:** **Soft freeze with a documented incident-exception path.** Default policy: no PRs touch `worker/migrations/` between the freeze announcement and the squash deploy. Exception: an incident-driven hotfix may land with an explicit announce and a post-squash reconciliation pass against the rehearsal output.
- **Rehearsal scope:** **Smoke set + one full cron tick** against the rehearsal D1. Existing preview smoke alone is not enough — the cron tick confirms migration-name-drift is invisible to live code (cron_runs / cron_slot_executions ledgers), not just to smoke endpoints. 24h soak is not required; sign-off on a green cron tick.
- **Recovery beyond Time Travel:** The off-Cloudflare logical backup plan was reviewed and dropped as unwarranted for the project's current threat model (D1 has no observed data-loss incidents, Time Travel covers the realistic accident profile, and the truly-irreplaceable subset is small enough that an ad-hoc manual snapshot is sufficient if the operator wants belt-and-suspenders coverage before the squash window). Squash recovery relies on Time Travel + the migration-revert path.
