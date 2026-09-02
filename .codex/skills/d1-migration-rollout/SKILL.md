---
name: d1-migration-rollout
description: Use when adding, reviewing, squashing, deploying, or rolling back Pharos D1 migrations or schema cleanup.
---

# D1 Migration Rollout

## Purpose

Route D1 schema work through manifest lineage, pre-Worker ordering, compatibility checks, and rollback evidence.
Keep baseline and cleanup policy in the migration owners; this skill coordinates the rollout proof.

## Read first

- `worker/migrations/AGENTS.md`
- `worker/migrations/MANIFEST.md`; read [Baseline (0000)](../../../worker/migrations/MANIFEST.md#baseline-0000), [Rollout Safety](../../../worker/migrations/MANIFEST.md#rollout-safety), and [Rollback Procedure](../../../worker/migrations/MANIFEST.md#rollback-procedure)
- [D1 Baseline Squash Policy](../../../docs/process/d1-baseline-squash-plan.md#preconditions), [Procedure](../../../docs/process/d1-baseline-squash-plan.md#procedure), and [Failure And Recovery](../../../docs/process/d1-baseline-squash-plan.md#failure-and-recovery)
- [Shared Database Helpers](../../../docs/worker-infrastructure.md#shared-database-helpers) and [Completed D1 Schema Cleanup](../../../docs/worker-infrastructure.md#completed-d1-schema-cleanup)
- [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence) and [Concurrency and Rollback Scope](../../../docs/deployment-process.md#concurrency-and-rollback-scope)
- [D1 connectivity first checks](../../../docs/runbooks/db-connectivity.md#first-checks)
- `worker/migrations/0000_baseline.sql` and `worker/migrations/EXPECTED_SCHEMA.txt`

## Procedure

1. **Inventory `worker/migrations/MANIFEST.md`.** Run `npm run check:migrations`, identify the next unused sequence, and preserve every deployed filename and historical lineage.
2. **Author the SQL under `worker/migrations/`.** Add the required `-- rollout-safety: backward-compatible` header, update the manifest in the same change, and keep the still-live Worker able to read and write during deployment.
3. **Rehearse the [D1 baseline procedure](../../../docs/process/d1-baseline-squash-plan.md#procedure) when squashing.** Use two fresh named D1 databases, compare schema objects, indexes, triggers, and seed counts, and record only approved cleanup differences in the manifest.
4. **Order deployment from the [CI deploy sequence](../../../docs/deployment-process.md#ci-deploy-sequence).** Run `npm run check:migrations`, `npm run check:sql-safety`, and `npm run typecheck:worker`; migrations apply remotely before the new Worker is live.
5. **Separate cleanup via [Completed D1 Schema Cleanup](../../../docs/worker-infrastructure.md#completed-d1-schema-cleanup).** Require production backup/Time Travel evidence, fresh zero-use evidence, and a dedicated operated rollout after compatible Worker code has soaked; do not hide drops in a normal migration.
6. **Prepare rollback from the [manifest rollback procedure](../../../worker/migrations/MANIFEST.md#rollback-procedure).** Preserve the pre-window bookmark, deployed Worker version, migration ledger, and schema comparison. Restore D1 only for unexpected data/schema mutation; Worker rollback alone does not reverse D1.
7. **Verify the [D1 connectivity first checks](../../../docs/runbooks/db-connectivity.md#first-checks) after release.** Check the first affected read/write or scheduled path and retain the migration, activation, and operational evidence separately.

## Verification

- `npm run check:migrations`
- `npm run check:sql-safety`
- `npm run typecheck:worker`
- `npx vitest run worker/src/lib/__tests__/db-cache.test.ts worker/src/api/__tests__/health.test.ts`

## Do not

- Treat `worker/migrations/0000_baseline.sql` as an upgrade for existing databases; it is fresh-database-only.
- Reuse a historical sequence or filename, or renumber a migration that reached production.
- Ship a non-backward-compatible change while the previous Worker can still serve traffic.
- Put destructive cleanup in the normal migration path; it needs a separate coordinated rollout and evidence.
- Claim D1 rollback from a Worker rollback, or restore without a verified pre-window Time Travel point.

## Handoff

Report migration filenames and manifest state, fresh/production rehearsal results, exact checks, deploy ordering, rollback bookmark/version evidence, first affected-path result, and any cleanup or restore follow-up.
