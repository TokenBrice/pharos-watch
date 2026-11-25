---
name: d1-migration-rollout
description: Author reviewed DML, squash the baseline, run destructive cleanup, and deploy or roll back Pharos D1 migrations. Use for D1 rollout sequencing and recovery. Not for routine read-only D1 queries.
---

# D1 Migration Rollout

## Trigger And Exclusions

Use for reviewed row-mutating DML, baseline squash, destructive cleanup, and production migration deploy or rollback. A routine additive migration needs only `npm run agent:route -- --file worker/migrations/<file>`: the router already returns the authoring rules and checks, so load this skill for one only when it ships with a rollout. Not for database queries or schema reads.

## Classify The Operation

Select additive SQL, reviewed row-mutating DML, baseline squash, destructive cleanup, deployment, or rollback before reading branch context; combine only the applicable branches.

## Mandatory Core

- `worker/migrations/AGENTS.md` and [D1 Migration Authoring](../../../docs/process/d1-migrations.md) own sequence selection, headers, manifest rows and compatibility; `worker/migrations/MANIFEST.md` owns lineage. Do not work from a paraphrase.
- Migrations run before the new Worker is live: the previous Worker must keep reading and writing. Destructive cleanup is a separate coordinated rollout, never an annotation in the normal path.
- Worker rollback does not reverse D1. Unexpected data/schema mutation alone warrants D1 restore, with a verified pre-window Time Travel point; never claim restoration from a Worker rollback.
- Remote D1 work needs authorization, not merely tool access. Remote reads use `wrangler d1 execute stablecoin-db --remote --command`, never `--file`, which locks writes ([Remote D1 Inspection](../../../docs/worker-infrastructure.md#remote-d1-inspection)).

## Branch Reads And Actions

- **Additive SQL:** follow [Additive migrations](../../../docs/process/d1-migrations.md#additive-migrations); inspect the affected schema and [Shared Database Helpers](../../../docs/worker-infrastructure.md#shared-database-helpers).
- **Reviewed DML:** read [Reviewed data migrations](../../../docs/process/d1-migrations.md#reviewed-data-migrations). The detector in `scripts/ci/check-worker-migrations.ts` wins. A new pre-existing target needs a representative seeded fixture in that checker; empty fresh replay is insufficient. Record the pre-deploy bookmark, predicate and row bound before applying.
- **Baseline squash only:** read [Baseline (0000)](../../../worker/migrations/MANIFEST.md#baseline-0000), squash [preconditions](../../../docs/process/d1-baseline-squash-plan.md#preconditions), [procedure](../../../docs/process/d1-baseline-squash-plan.md#procedure), and [failure/recovery](../../../docs/process/d1-baseline-squash-plan.md#failure-and-recovery). Compare two fresh named remote databases; record only approved cleanup differences. Before applying to an existing target, prove the exact `0000_baseline.sql` filename is in its ledger and no baseline is pending; otherwise stop for a reviewed adoption plan. Absorbed filenames do not prove adoption.
- **Destructive cleanup only:** read [Completed D1 Schema Cleanup](../../../docs/worker-infrastructure.md#completed-d1-schema-cleanup). Require backup/Time Travel evidence, fresh zero-use evidence, and a dedicated operated rollout after compatible Worker code has soaked.
- **Deploy/rollback:** read [Rollback and deployment](../../../docs/process/d1-migrations.md#rollback-and-deployment), [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence), [Concurrency and Rollback Scope](../../../docs/deployment-process.md#concurrency-and-rollback-scope), and [Rollback Procedure](../../../worker/migrations/MANIFEST.md#rollback-procedure). The deploy workflow runs `npm run check:remote-d1-baseline-ledger` as a preflight before the remote apply. Preserve pre-window bookmark, deployed Worker version, ledger and schema comparison. After release, follow the D1 branch of [operational acceptance](../pharos-release-runner/references/operational-acceptance.md); retain migration, activation and operational proof separately.

## Checks Owned By The Verifier

The assigned verifier runs checks after writers finish; implementation agents hand off the applicable commands and evidence requirements.

- Schema/SQL: `npm run check:migrations`, `npm run check:sql-safety`, `npm run typecheck:worker`.
- Schema objects changed: `npm run check:migrations -- --write-schema-manifest` regenerates `worker/migrations/EXPECTED_SCHEMA.txt`; commit it with the migration.
- Reviewed DML or a changed checker fixture: `npx vitest run scripts/__tests__/check-worker-migrations.test.ts`.
- Affected database/health paths: `npx vitest run worker/src/lib/__tests__/db-cache.test.ts worker/src/api/__tests__/health.test.ts`.
- Squash, cleanup, and rollout use their branch-specific rehearsal/operational gates.

## Completion Evidence

Report migration filenames/manifest state, fresh or production rehearsal results, checks actually run or assigned, deployment ordering, rollback bookmark/version, first affected-path result or pending acceptance, and cleanup/restore follow-up.
