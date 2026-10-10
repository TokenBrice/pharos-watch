---
name: d1-migration-rollout
description: Use when adding, reviewing, squashing, deploying, or rolling back Pharos D1 migrations or schema cleanup.
---

# D1 Migration Rollout

## Trigger And Exclusions

Use for D1 schema/migration rollout, not routine database queries. Owner policies hold baseline, cleanup, and recovery detail.

## Classify The Operation

Select additive SQL, reviewed row-mutating DML, baseline squash, destructive cleanup, deployment, or rollback before reading branch context; combine only the applicable branches.

## Mandatory Core

- `worker/migrations/AGENTS.md`; [Additive migrations](../../../docs/process/d1-migrations.md#additive-migrations), [Rollback and deployment](../../../docs/process/d1-migrations.md#rollback-and-deployment), and [Rollout Safety](../../../worker/migrations/MANIFEST.md#rollout-safety).
- Inventory `worker/migrations/MANIFEST.md` for the next unused sequence and historical lineage. Never reuse/renumber a deployed filename. `worker/migrations/0000_baseline.sql` is fresh-database-only, never an upgrade for existing databases; `worker/migrations/EXPECTED_SCHEMA.txt` owns expected objects.
- Migrations run before the new Worker is live. Preserve previous-Worker reads/writes, add `-- rollout-safety: backward-compatible`, and update the manifest. Destructive cleanup requires a separate coordinated rollout, not an annotation in the normal path.
- Worker rollback does not reverse D1. Unexpected data/schema mutation alone warrants D1 restore, with a verified pre-window Time Travel point; never claim restoration from a Worker rollback.

## Branch Reads And Actions

- **Additive SQL:** inspect the affected schema and [Shared Database Helpers](../../../docs/worker-infrastructure.md#shared-database-helpers); preserve old-Worker compatibility, including defaults for new required columns.
- **Reviewed DML:** read [Reviewed data migrations](../../../docs/process/d1-migrations.md#reviewed-data-migrations). The detector in `scripts/ci/check-worker-migrations.ts` wins. Add `-- data-migration: reviewed` and the manifest row with exact predicate, old-Worker compatibility, pre-deploy bookmark/rollback, and affected-row bounds. New pre-existing targets need representative seeded fixtures in that checker; empty fresh replay is insufficient.
- **Baseline squash only:** read [Baseline (0000)](../../../worker/migrations/MANIFEST.md#baseline-0000), squash [preconditions](../../../docs/process/d1-baseline-squash-plan.md#preconditions), [procedure](../../../docs/process/d1-baseline-squash-plan.md#procedure), and [failure/recovery](../../../docs/process/d1-baseline-squash-plan.md#failure-and-recovery). Compare two fresh named remote databases; record only approved cleanup differences. Before applying to an existing target, prove the exact `0000_baseline.sql` filename is in its ledger and no baseline is pending; otherwise stop for a reviewed adoption plan. Absorbed filenames do not prove adoption.
- **Destructive cleanup only:** read [Completed D1 Schema Cleanup](../../../docs/worker-infrastructure.md#completed-d1-schema-cleanup). Require backup/Time Travel evidence, fresh zero-use evidence, and a dedicated operated rollout after compatible Worker code has soaked.
- **Deploy/rollback:** read [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence), [Concurrency and Rollback Scope](../../../docs/deployment-process.md#concurrency-and-rollback-scope), and [Rollback Procedure](../../../worker/migrations/MANIFEST.md#rollback-procedure). Preserve pre-window bookmark, deployed Worker version, ledger and schema comparison. After release, use [D1 connectivity first checks](../../../docs/runbooks/db-connectivity.md#first-checks) and inspect the first affected read/write or scheduled path; retain migration, activation and operational proof separately.

## Checks Owned By The Verifier

The assigned verifier runs checks after writers finish; implementation agents hand off the applicable commands and evidence requirements.

- Schema/SQL: `npm run check:migrations`, `npm run check:sql-safety`, `npm run typecheck:worker`.
- Affected database/health paths: `npx vitest run worker/src/lib/__tests__/db-cache.test.ts worker/src/api/__tests__/health.test.ts`.
- Squash, cleanup, and rollout use their branch-specific rehearsal/operational gates; remote work requires authorization, not merely tool access.

## Completion Evidence

Report migration filenames/manifest state, fresh or production rehearsal results, checks actually run or assigned, deployment ordering, rollback bookmark/version, first affected-path result or pending acceptance, and cleanup/restore follow-up.
