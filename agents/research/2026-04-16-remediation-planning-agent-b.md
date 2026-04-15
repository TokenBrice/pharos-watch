# Remediation Planning Agent B - Operational, Contract, Tooling, And Hygiene Plan

Date: 2026-04-16
Scope: `/home/ahirice/Documents/git/stablecoin-dashboard`

## Scope And Assumptions

This sub-plan covers only the Agent B slice requested by the user:

- S1, R7, and C2: worker operational scripts and one-off depeg repair scripts.
- S2 and C4: deploy-impact classification and validation/deploy guardrails.
- S4: cron connection-budget modeling.
- R8, Q9, S5, and C4: endpoint path contracts, API fetch contract comments, and site-data fallback docs.
- S6, S7, R13, and C6: package manager reproducibility, dependency drift, and local install hygiene.
- R12 and C6: local generated artifacts and nested worktree hygiene.

Assumptions:

- No product code should be edited during this planning pass. This file is the only created artifact.
- Implementation should be split into small PR-sized changes. The safest first PR is S1 plus S2 because they harden the validation net before follow-on refactors.
- Current dirty docs (`docs/about-page.md`, `docs/api-reference.md`, `docs/dews.md`, `docs/testing.md`) are treated as pre-existing user work. Any implementation PR must inspect and merge with those changes rather than overwrite them.
- Production repair scripts are documented runbooks. Do not retire them unless an operator confirms the production correction history and rollback/audit requirements.

## Research Performed

Local code and metadata inspected:

- Audit reports:
  - `agents/audits/2026-04-16-agent-1-redundancy-audit.md`
  - `agents/research/2026-04-16-agent-2-code-quality-audit.md`
  - `agents/research/2026-04-16-sustainability-maintainability-audit-agent3.md`
  - `agents/audits/2026-04-16-comprehensive-three-pillar-audit-blueprint.md`
- Required docs:
  - `docs/architecture.md`
  - `docs/api-reference.md`
  - `docs/testing.md`
  - `docs/worker-and-api-limits.md`
  - `docs/deployment-process.md`
  - `docs/scripts.md`
- Code/config surfaces:
  - `worker/scripts/*.ts`
  - `worker/src/api/backfill-depegs*.ts`
  - `worker/src/api/backfill-fx.ts`
  - `scripts/fix-commodity-depeg-median.ts`
  - `scripts/fix-non-usd-depeg-fx.ts`
  - `scripts/lib/deploy-impact.mjs`
  - `scripts/lib/validate-contract.mjs`
  - `scripts/test-merge-gate.mjs`
  - `.github/workflows/validate-ci.yml`
  - `.github/workflows/deploy-cloudflare.yml`
  - `.github/actions/setup-workspace/action.yml`
  - `shared/lib/api-endpoints/*`
  - `src/lib/api.ts`
  - `shared/lib/cron-jobs.ts`
  - `scripts/check-cron-connection-budget.ts`
  - `package.json`
  - `worker/package.json`
  - `.npmrc`
  - `.nvmrc`
  - `.github/dependabot.yml`

Validation/probe commands run for planning evidence:

- Confirmed `worker/scripts` are absent from both typecheck lists:
  - `npx tsc --listFilesOnly -p tsconfig.typecheck.json | rg 'worker/scripts' || true`
  - `cd worker && npx tsc --listFilesOnly -p tsconfig.json | rg 'worker/scripts' || true`
- Created and removed a temporary Worker script tsconfig during one shell command. The check reproduced current S1 failures:
  - missing `enumerateDates` export from `worker/src/api/backfill-fx.ts`
  - missing `extractDepegEvents`, `parseSupplyData`, `summarizeBackfillReplayDiff`, and `ExistingDepegEventRow` exports from `worker/src/api/backfill-depegs.ts`
  - follow-on implicit-any errors in `worker/scripts/repair-non-usd-fiat-depeg-history.ts`
- Confirmed deploy-impact false negatives with a direct Node probe:
  - `scripts/lib/deploy-impact.mjs`: `deploy=false`
  - `scripts/lib/validate-contract.mjs`: `deploy=false`
  - `.github/actions/setup-workspace/action.yml`: `deploy=false`
  - `scripts/check-cron-connection-budget.ts`: `deploy=false`
  - `scripts/check-env-contract.mjs`: `deploy=false`
  - `scripts/check-sql-interpolation-safety.mjs`: `deploy=false`
  - `scripts/test-merge-gate.mjs`: `deploy=false`
  - `.github/workflows/validate-ci.yml`: `deploy=true`
  - `scripts/classify-deploy-changes.mjs`: `deploy=true`
- Dependency/package metadata:
  - `npm audit --json --omit=dev`: 0 vulnerabilities
  - `npm audit --json`: 0 vulnerabilities
  - `npm outdated --json`: current drift listed below
  - `npm ls --depth=0 --json`: four local extraneous packages under root `node_modules`
  - `npm config get engine-strict`: `false`
  - `npm config get save-exact`: `true`
  - local `node -v`: `v25.7.0`
  - local `npm -v`: `11.11.0`
  - current `npm view npm version`: `11.12.1`
  - local `corepack`: not installed on PATH
- Workspace artifact sizes:
  - `.next`: 6.7G
  - `worktrees`: 2.3G
  - `.worktrees`: 8K
  - `node_modules`: 1.1G
  - `worker/node_modules`: 48K
  - `out`: 135M
  - `coverage`: 3.7M
  - `output`: 3.2M
  - `agents/jscpd-2026-04-16`: 552K

External primary sources checked:

- Cloudflare Workers changelog, Apr 09, 2026: the simultaneous open-connection limit has been relaxed. A connection is freed once response headers arrive; the six-connection limit now constrains only concurrent connections waiting for response headers, not response-body reading. Source: https://developers.cloudflare.com/changelog/post/2026-04-09-relaxed-connection-limiting/
- npm package.json docs for `engines`, `engine-strict`, and `devEngines.packageManager`: `engines` is advisory unless `engine-strict` is set; `devEngines` can enforce runtime/package-manager expectations before install/ci/run. Source: https://docs.npmjs.com/cli/v11/configuring-npm/package-json/
- Corepack docs for top-level `packageManager`: `packageManager@x.y.z` is required; permitted package managers include `npm`, `pnpm`, and `yarn`. Local environment currently lacks `corepack`, so relying on this field alone would not enforce npm in this repo. Source: https://github.com/nodejs/corepack

## Current Confirmed Package Drift

As of the planning pass:

| Package | Current | Latest | Scope | Recommended handling |
| --- | ---: | ---: | --- | --- |
| `@cloudflare/workers-types` | `4.20260414.1` | `4.20260415.1` | worker dev | Patch with Worker typecheck and worker-script typecheck |
| `wrangler` | `4.82.2` | `4.83.0` | worker deploy tooling | Patch first; deploy path depends on it |
| `viem` | `2.47.17` | `2.48.0` | worker runtime/ops script | Patch/minor with EVM, blacklist, reserve adapter tests |
| `next` | `16.2.3` | `16.2.4` | root runtime/build | Patch with `npm run build` and UI/SEO smoke |
| `eslint-config-next` | `16.2.3` | `16.2.4` | root lint | Patch with lint |
| `prettier` | `3.8.2` | `3.8.3` | root formatting | Low-risk patch; no formatting churn unless intentionally run |
| `@types/node` | `22.19.17` | `25.6.0` | root types | Keep pinned to Node 22 baseline unless project baseline changes |
| `eslint` | `9.39.4` | `10.2.0` | root lint | Planned migration, not a patch batch |
| `typescript` | `5.9.3` | `6.0.2` | root + worker | Planned migration after Next/Worker compatibility check |

## Implementation Streams

### Stream A - Worker Operational Scripts And Depeg Repair Scripts

Findings covered: S1, R7, C2.

Impact: High for S1, Low/conditional for R7, High compound issue for C2.

#### A1. Add Worker Script Typecheck Coverage

Files/functions:

- Add `worker/tsconfig.scripts.json`.
- Update `scripts/lib/validate-contract.mjs`, `WORKER_VALIDATE_COMMANDS`.
- Update `.github/workflows/validate-ci.yml`, job `validate`, worker conditional steps.
- Update `scripts/__tests__/validate-ci-parity.test.ts`.
- Update `scripts/__tests__/test-merge-gate.test.ts`.
- Optionally add root `package.json` script `typecheck:worker-scripts`.
- Optionally add worker `package.json` script `typecheck:scripts`.
- Update `docs/testing.md` and `docs/scripts.md` command tables.

Code-level steps:

1. Add `worker/tsconfig.scripts.json`:

   ```json
   {
     "extends": "./tsconfig.json",
     "compilerOptions": {
       "tsBuildInfoFile": "./tsconfig.scripts.tsbuildinfo"
     },
     "include": [
       "scripts/**/*.ts",
       "src/**/*.ts",
       "../shared/**/*.ts"
     ],
     "exclude": [
       "node_modules",
       "src/**/*.test.ts",
       "src/**/__tests__/**"
     ]
   }
   ```

   Rationale: include Worker scripts, Worker internals they import, and shared code, while avoiding test-only surfaces. Use a distinct `tsBuildInfoFile` so the script typecheck does not collide with `worker/tsconfig.json` incremental state.

2. Add a validation command. Preferred minimal path:

   - `scripts/lib/validate-contract.mjs`:

     ```js
     export const WORKER_VALIDATE_COMMANDS = [
       "cd worker && npx tsc --noEmit",
       "cd worker && npx tsc --noEmit -p tsconfig.scripts.json",
     ];
     ```

   - `.github/workflows/validate-ci.yml` will need the same conditional worker step sequence, or its existing parity test will fail after `validate-contract.mjs` changes.

3. Add optional convenience scripts:

   - Root `package.json`:

     ```json
     "typecheck:worker-scripts": "cd worker && npx tsc --noEmit -p tsconfig.scripts.json"
     ```

   - Worker `package.json`:

     ```json
     "typecheck": "tsc --noEmit",
     "typecheck:scripts": "tsc --noEmit -p tsconfig.scripts.json"
     ```

   Keep CI commands direct if the repo prefers visible commands in workflows.

4. Update docs:

   - `docs/testing.md`: add worker-script typecheck to validate and merge-gate descriptions.
   - `docs/scripts.md`: note `worker/scripts/**` is typechecked by `worker/tsconfig.scripts.json`.

Tests/validation:

- `cd worker && npx tsc --noEmit`
- `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
- `npm run typecheck`
- `npm run check:worker-boundary`
- `npm run check:sql-safety`
- `vitest run scripts/__tests__/validate-ci-parity.test.ts scripts/__tests__/test-merge-gate.test.ts`
- `npm run test:merge-gate -- --staged` after staging the implementation, or `MERGE_GATE_DRY_RUN=1 npm run test:merge-gate -- --staged` before committing.

Rollout risks:

- This will expose additional Worker script type errors beyond the currently confirmed repair script. Fix all surfaced errors in the same PR; do not allow a broad tsconfig with excluded scripts to land.
- `worker/scripts` intentionally imports Worker internals. Do not add a root boundary rule that blocks those imports wholesale.

Effort: Small/Medium.

Dependencies: None, but do this before R7 refactoring.

#### A2. Fix Current Stale Imports In `repair-non-usd-fiat-depeg-history.ts`

Files/functions:

- `worker/scripts/repair-non-usd-fiat-depeg-history.ts:12-37`
- `worker/src/api/backfill-fx.ts`
- `worker/src/api/backfill-depegs-extraction.ts`
- `worker/src/api/backfill-depegs-preview.ts`

Current reproduced type errors:

- `enumerateDates` is imported from `../src/api/backfill-fx`, but `backfill-fx.ts` imports it from `@shared/lib/rate-series` and does not re-export it.
- `extractDepegEvents` and `parseSupplyData` are imported from `../src/api/backfill-depegs`, but current exports live in `worker/src/api/backfill-depegs-extraction.ts`.
- `summarizeBackfillReplayDiff` and `ExistingDepegEventRow` are imported from `../src/api/backfill-depegs`, but current exports live in `worker/src/api/backfill-depegs-preview.ts`.

Code-level steps:

1. Change imports in `worker/scripts/repair-non-usd-fiat-depeg-history.ts`:

   ```ts
   import { enumerateDates } from "../../shared/lib/rate-series";
   import {
     COMMODITY_PEGS,
     OTHER_COIN_FX,
     PEG_TO_FX,
     SECONDARY_PEG_TO_FX,
     buildFxLookup,
     fetchHistoricalFxRates,
   } from "../src/api/backfill-fx";
   import {
     extractDepegEvents,
     parseSupplyData,
   } from "../src/api/backfill-depegs-extraction";
   import {
     summarizeBackfillReplayDiff,
     type ExistingDepegEventRow,
   } from "../src/api/backfill-depegs-preview";
   ```

2. Re-run the new worker-script typecheck. The implicit-any errors at the `dates.map(...)`, `replay.events.map(...)`, and similar sites should disappear once the missing imports resolve. If any remain, add explicit local types rather than weakening tsconfig.

3. Do not re-export these helpers from `backfill-depegs.ts` just to restore the old private surface. Importing from the extracted modules is a smaller root-cause fix.

Tests/validation:

- `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
- `vitest run worker/src/api/__tests__/backfill-depegs-helpers.test.ts worker/src/api/__tests__/backfill-depegs-dry-run.test.ts worker/src/api/__tests__/backfill-depegs.test.ts`
- Optional operator-only dry run, because it can touch live services and production D1:
  - `cd worker && npx tsx scripts/repair-non-usd-fiat-depeg-history.ts --dry-run --stablecoin=<low-risk-id>`

Rollout risks:

- The script is production-affecting in live mode. Keep validation in `--dry-run` unless an operator explicitly authorizes a repair.
- Do not broaden imports to route-handler files unless there is no extracted helper surface.

Effort: Small.

Dependencies: A1.

#### A3. Establish A Supported Operational Helper Surface

Files/functions:

- New candidate module: `worker/src/lib/admin-backfill/depegs.ts` or `worker/src/lib/depeg-backfill/index.ts`
- Current helper owners:
  - `worker/src/api/backfill-depegs-extraction.ts`
  - `worker/src/api/backfill-depegs-preview.ts`
  - `worker/src/api/backfill-depegs-window.ts`
  - `worker/src/api/backfill-fx.ts`
- Boundary checker:
  - `scripts/check-worker-import-boundary.mjs`

Code-level steps:

1. After A1/A2 are green, decide whether Worker scripts may import `worker/src/api/*` extracted helper modules as supported contracts.

2. Preferred sustainable path: move route-neutral backfill helpers into a Worker lib surface:

   - `worker/src/lib/admin-backfill/depeg-extraction.ts`
   - `worker/src/lib/admin-backfill/depeg-preview.ts`
   - `worker/src/lib/admin-backfill/fx.ts`

   Then update route handlers and worker scripts to import from that lib surface.

3. Add a worker-script boundary rule:

   - `worker/scripts/**` may import `../src/lib/**`, `../src/cron/**` only when documented, and the new supported admin-backfill lib.
   - `worker/scripts/**` should not import route handler modules under `../src/api/**` except for an explicit temporary allowlist.

4. Add tests or fixture checks to `scripts/__tests__/sql-interpolation-safety.test.ts` or a new boundary test if the boundary script becomes more complex.

Tests/validation:

- `npm run check:worker-boundary`
- `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
- Backfill helper tests listed in A2.

Rollout risks:

- Moving helper modules can create broad import churn. Keep the first PR to typecheck + import fixes; move helper surfaces only after the validation net is in place.

Effort: Medium/Large.

Dependencies: A1 and A2.

#### A4. Consolidate Duplicate SQL Mutation Batching In One-off Depeg Repair Scripts

Files/functions:

- `scripts/fix-commodity-depeg-median.ts:145-190`
- `scripts/fix-non-usd-depeg-fx.ts:137-180`
- New candidate: `scripts/lib/depeg-repair-sql.ts`
- New test: `scripts/__tests__/depeg-repair-sql.test.ts`
- Docs: `docs/scripts.md:49-50`

Code-level steps:

1. Extract a helper with strict numeric validation before interpolation:

   ```ts
   export interface DepegRepairUpdate {
     id: number;
     newBps: number;
     newRef: number;
   }

   export function buildDepegRepairStatements(
     toDelete: readonly number[],
     toUpdate: readonly DepegRepairUpdate[],
     options: { deleteBatchSize?: number } = {},
   ): string[] {
     // validate safe integer ids, finite bps/ref values
     // build DELETE batches of 50 by default
     // build one UPDATE per changed row
   }

   export function executeDepegRepairStatements(config: {
     dbName: string;
     statements: readonly string[];
     prefix: string;
     dryRun: boolean;
   }): void {
     // print no-op in dry-run, call d1BatchExec in live mode
   }
   ```

2. Replace each duplicated live block with:

   ```ts
   const statements = buildDepegRepairStatements(toDelete, toUpdate);
   executeDepegRepairStatements({
     dbName: DB_NAME,
     dryRun: DRY_RUN,
     prefix: "depeg-commodity-fix",
     statements,
   });
   ```

   Use `prefix: "depeg-fx-fix"` or existing naming in the non-USD script.

3. Preserve current dry-run output. Do not alter event selection, recalculation, or threshold logic in this refactor.

4. Add tests:

   - DELETE batching at 0, 1, 50, 51, and 101 ids.
   - UPDATE generation for finite values.
   - rejection of non-integer ids, `NaN`, `Infinity`, and unsafe integers.
   - dry-run execution does not call `d1BatchExec` if execution is injectable; otherwise test only statement generation.

5. Update `docs/scripts.md` only if behavior or command names change. If only a helper is extracted, no public docs change is required.

Tests/validation:

- `vitest run scripts/__tests__/depeg-repair-sql.test.ts`
- `npm run typecheck`
- `npm run check:sql-safety`
- `npm run check:unused-code`
- Optional operator-only dry runs:
  - `cd worker && npx tsx ../scripts/fix-commodity-depeg-median.ts --dry-run`
  - `cd worker && npx tsx ../scripts/fix-non-usd-depeg-fx.ts --dry-run`

Rollout risks:

- SQL string generation is intentionally constrained by numeric validation because these scripts use Wrangler D1 command execution rather than parameter binding.
- Do not retire these scripts in the same PR. Retirement needs operator confirmation.

Effort: Medium.

Dependencies: A1 recommended, A2 not strictly required.

Open questions:

- Should the two root `scripts/fix-*` repair scripts eventually move under `worker/scripts/` because they affect production D1 and depend on Wrangler auth?
- Are these scripts still required as runbooks, or can they be archived after production repair history is confirmed?

### Stream B - Deploy-impact Classification And Validation Guardrails

Findings covered: S2, C4, C6.

Impact: Medium, but it gates all later infrastructure/tooling changes.

#### B1. Expand Deploy-impact Coverage For CI/Guardrail Infrastructure

Files/functions:

- `scripts/lib/deploy-impact.mjs`
- `scripts/classify-deploy-changes.mjs`
- `scripts/lib/validate-contract.mjs`
- `scripts/test-merge-gate.mjs`
- `scripts/__tests__/classify-deploy-changes.test.ts`
- `scripts/__tests__/test-merge-gate.test.ts`
- `scripts/__tests__/validate-ci-parity.test.ts`
- `.github/actions/setup-workspace/action.yml`
- `.github/workflows/validate-ci.yml`
- `.github/workflows/deploy-cloudflare.yml`

Code-level steps:

1. Add infrastructure prefixes in `scripts/lib/deploy-impact.mjs`:

   ```js
   const FULL_DEPLOY_INFRA_PREFIXES = [
     ".github/actions/",
     "scripts/lib/",
   ];
   ```

   Then include those prefixes in both `hasWorkerDeployImpact()` and `hasPagesDeployImpact()`.

2. Add exact guardrail script paths that are invoked by the validate contract but are not covered by runtime prefixes:

   - `scripts/audit-pricing-provider-config.ts`
   - `scripts/check-critical-coverage.mjs`
   - `scripts/check-cron-connection-budget.ts`
   - `scripts/check-cron-schedule-sync.ts`
   - `scripts/check-doc-counts.mjs`
   - `scripts/check-doc-sync.ts`
   - `scripts/check-duplicate-exports.mjs`
   - `scripts/check-env-contract.mjs`
   - `scripts/check-hotspot-ratchet.mjs`
   - `scripts/check-redemption-backstops.ts`
   - `scripts/check-seo-static.mjs`
   - `scripts/check-shared-cycles.mjs`
   - `scripts/check-sql-interpolation-safety.mjs`
   - `scripts/check-stablecoin-data.ts`
   - `scripts/check-unused-code.mjs`
   - `scripts/check-verified-doc-links.mjs`
   - `scripts/check-worker-import-boundary.mjs`
   - `scripts/check-worker-migrations.mjs`
   - `scripts/test-merge-gate.mjs`
   - smoke scripts invoked in deploy path: `scripts/smoke-api.mjs`, `scripts/smoke-ops.mjs`, `scripts/smoke-transport.mjs`, `scripts/smoke-ui.mjs`

   Keep `scripts/sync-digests.ts`, `scripts/generate-redirects.ts`, and `scripts/serve-static-export.mjs` in Pages exact paths as they already are.

3. Prefer a named set, for example:

   ```js
   const FULL_DEPLOY_GUARDRAIL_EXACT_PATHS = new Set([...]);
   ```

   Include it in both Pages and Worker impact because these scripts shape the validation workflow itself.

4. Add regression tests:

   - `hasDeployImpact(["scripts/lib/deploy-impact.mjs"]) === true`
   - `hasDeployImpact(["scripts/lib/validate-contract.mjs"]) === true`
   - `hasDeployImpact([".github/actions/setup-workspace/action.yml"]) === true`
   - representative guardrail scripts above are deploy-impacting
   - docs/agents changes remain non-impacting

5. Add drift-resistance test:

   - Read `package.json`.
   - For every command in `COMMON_VALIDATE_PREBUILD_COMMANDS`, `PAGES_VALIDATE_COMMANDS`, `COMMON_VALIDATE_POSTBUILD_COMMANDS`, and `WORKER_VALIDATE_COMMANDS`, map `npm run <script>` to the underlying script when it starts with `node scripts/`, `tsx scripts/`, or `npx --no-install`.
   - Assert the underlying `scripts/...` owner path is deploy-impacting.
   - Exempt pure tool commands such as `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` only with explicit comments.

Tests/validation:

- `vitest run scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts`
- Direct probe:

  ```bash
  node --input-type=module - <<'NODE'
  import { hasDeployImpact } from './scripts/lib/deploy-impact.mjs';
  for (const file of [
    'scripts/lib/deploy-impact.mjs',
    'scripts/lib/validate-contract.mjs',
    '.github/actions/setup-workspace/action.yml',
    'scripts/check-cron-connection-budget.ts',
    'scripts/check-env-contract.mjs',
  ]) {
    console.log(file, hasDeployImpact([file]));
  }
  NODE
  ```

- `MERGE_GATE_DRY_RUN=1 npm run test:merge-gate -- --staged` after staging the change.

Rollout risks:

- This will make more infrastructure-only pushes run production validation/deploy workflow detection. That is desired, but it can increase CI spend.
- If broad `scripts/lib/` is considered too aggressive, the fallback is explicit exact paths plus a drift test. The broad prefix is simpler and safer.

Effort: Small/Medium.

Dependencies: None. Implement before S6/S7 so setup-workspace/package-manager changes do not skip deploy validation.

### Stream C - Cron Connection-budget Modeling

Findings covered: S4 and C3/C6 overlap.

Impact: Medium.

Important updated research:

- The repo's docs and comments currently describe the six-connection constraint as if response bodies continue to occupy the scarce pool.
- Cloudflare changed this on Apr 09, 2026. The limit now applies only while a request is waiting for response headers. Body-reading no longer counts against the six-connection limit.
- The remediation should therefore update the terminology from generic `maxConnections` / response-body lifetime to "peak header-wait concurrency" while still recommending body consumption/cancellation for memory, cleanup, and provider politeness.

#### C1. Convert The Cron Budget Checker Into A Header-wait Budget Model

Files/functions:

- `shared/lib/cron-jobs.ts`
- `scripts/check-cron-connection-budget.ts`
- New candidate: `scripts/lib/cron-connection-budget.ts`
- New test: `scripts/__tests__/cron-connection-budget.test.ts`
- Scheduled handler comments:
  - `worker/src/handlers/scheduled/quarter-hourly.ts`
  - `worker/src/handlers/scheduled/half-hourly.ts`
  - `worker/src/handlers/scheduled/daily-0800.ts`
  - `worker/src/handlers/scheduled/daily-0805.ts`
  - `worker/src/handlers/scheduled/yield-supplemental.ts`
- Docs:
  - `docs/worker-and-api-limits.md`
  - `docs/testing.md`

Code-level steps:

1. Preserve `maxConnections` temporarily for compatibility, but clarify its meaning in `CronJobDefinition`:

   ```ts
   /** Peak outbound fetches that can be simultaneously waiting for response headers. */
   maxConnections?: number;
   ```

   Alternatively rename to `maxHeaderWaitConnections` in a larger PR. Minimal plan keeps the field name and fixes the comment/doc.

2. Add schedule-level phases to model sequential versus parallel handlers:

   ```ts
   export interface CronConnectionPhase {
     label: string;
     jobs: readonly string[];
     maxConnections: number;
   }

   export const CRON_CONNECTION_PHASES = {
     quarterHourly: [
       { label: "sync-fx-rates", jobs: ["sync-fx-rates"], maxConnections: 2 },
       { label: "sync-stablecoins", jobs: ["sync-stablecoins"], maxConnections: 3 },
       { label: "cache snapshots", jobs: ["snapshot-supply", "snapshot-chain-supply", "publish-report-card-cache"], maxConnections: 0 },
     ],
     halfHourlyOffset: [
       { label: "charts", jobs: ["sync-stablecoin-charts"], maxConnections: 1 },
       { label: "dex liquidity", jobs: ["sync-dex-liquidity"], maxConnections: 4 },
       { label: "db-only downstream", jobs: ["compute-dews", "stability-index"], maxConnections: 0 },
     ],
     daily0805Utc: [
       { label: "parallel: bluechip + digest/weekly chain + discovery", jobs: ["sync-bluechip", "daily-digest", "weekly-recap", "discovery-scan"], maxConnections: 3 },
     ],
     fourHourlyYieldSupplemental: [
       { label: "supplemental source families", jobs: ["sync-yield-supplemental"], maxConnections: 5 },
     ],
   } satisfies Partial<Record<CronScheduleKey, readonly CronConnectionPhase[]>>;
   ```

   Notes:

   - For schedules without explicit phases, the checker can use the current sum of job `maxConnections`.
   - `daily0805Utc` should be checked against the actual handler: daily digest and weekly recap are chained, while bluechip and discovery can overlap either one. Peak is therefore 3, not 4, unless a code inspection finds another hidden fetch family.
   - `quarterHourly` current sum is 5, but actual peak is 3 because jobs are sequential in `runQuarterHourlySlot()`.

3. Refactor `scripts/check-cron-connection-budget.ts`:

   - Move pure analysis into `scripts/lib/cron-connection-budget.ts`.
   - Compute per schedule:
     - `declaredTotalConnections`: sum of job metadata.
     - `peakHeaderWaitConnections`: explicit phase peak if available, else declared sum.
     - `phaseBreakdown`: labels and jobs.
   - Fail only when `peakHeaderWaitConnections > 6`.
   - Warn when `peakHeaderWaitConnections >= 5`.
   - Optionally warn when `declaredTotalConnections > 6` but phase metadata explains the lower peak; this catches confusing metadata without blocking a deliberately sequenced slot.

4. Update script output:

   ```text
   OK: "quarterHourly" peak=3/6 header-wait connections, declared-total=5, phases=3
   WARN: "fourHourlyYieldSupplemental" peak=5/6 header-wait connections
   ```

5. Update docs:

   - `docs/worker-and-api-limits.md`: replace response-body lifetime wording with header-wait wording and cite the Apr 09, 2026 Cloudflare change in prose.
   - Keep a note that upstream responses should still be consumed or canceled for resource cleanup and predictable retry behavior, but not because the six-connection pool stays occupied through body reads.
   - Add a provider-change checklist item requiring: trigger slot, peak header-wait concurrency, timeout, throttling, fallback/degraded behavior, and phase placement.

Tests/validation:

- `vitest run scripts/__tests__/cron-connection-budget.test.ts`
- `npm run check:cron-connections`
- `npm run check:cron-sync`
- `vitest run worker/src/__tests__/index.scheduled.test.ts`
- `npm run check:doc-sync`

Rollout risks:

- Changing the model can make old comments look inconsistent. Update scheduled handler comments in the same PR as the checker.
- Do not lower `sync-yield-supplemental` from 5 without inspecting its source-family runner. That lane is isolated and already near the warning threshold.

Effort: Medium.

Dependencies: B1 recommended first, because `scripts/check-cron-connection-budget.ts` is currently not deploy-impacting.

Open questions:

- Should the field be renamed from `maxConnections` to `maxHeaderWaitConnections` now, or should the repo keep the old field name for a smaller diff?
- Should CI fail on warnings in a stricter mode, for example `CRON_CONNECTION_WARNINGS_AS_ERRORS=1` for future provider PRs?

### Stream D - Endpoint Path Contracts, API Fetch Comment, And Site-data Docs

Findings covered: R8, Q9, S5, C4.

Impact: Medium for R8/C4, Low for Q9/S5.

#### D1. Fix The `apiFetch` Contract Comment

Files/functions:

- `src/lib/api.ts:153-180`
- `src/lib/api.ts:196-198`
- `src/lib/__tests__/api-fetch-contracts.test.ts:49-80`

Code-level steps:

1. Replace the stale comment with:

   ```ts
   /** Fetch JSON from the API. Throws on non-OK responses.
    *  When a Zod schema is provided, strict validation is the default and
    *  schema mismatch throws. Pass contractMode="warn" only for explicit
    *  graceful degradation that returns data as-is after logging. */
   ```

2. No behavior change.

Tests/validation:

- `vitest run src/lib/__tests__/api-fetch-contracts.test.ts`
- `npm run lint`

Rollout risks: None.

Effort: Small.

Dependencies: None.

#### D2. Align Site-data Fallback Documentation

Files/functions:

- `docs/api-reference.md:183`
- `docs/deployment-process.md:220-226`
- `docs/architecture.md:682-686`
- `worker/wrangler.toml:15-18`
- `worker/wrangler.toml:57-62`

Code-level steps:

1. Update `docs/api-reference.md:183` to match current production invariant:

   - `site-api.pharos.watch` is provisioned and declared in `worker/wrangler.toml`.
   - Production Pages hosts require explicit `SITE_API_ORIGIN`.
   - Production fails closed when `SITE_API_ORIGIN` is missing.
   - Preview/local rehearsal may fall back to `api.pharos.watch` when intentionally unset.
   - `PUBLIC_API_AUTH_MODE` is already `enforce`; remove rollout-era warning not to move past `off`.

2. Update `docs/deployment-process.md:221`:

   - Replace `site-api.pharos.watch when provisioned, otherwise...` with `site-api.pharos.watch for production; preview/local rehearsal may...`.

3. Leave `docs/architecture.md:682-686` mostly unchanged because it already states the current invariant.

4. Add a semantic doc-sync check only if this policy is likely to change again. Candidate:

   - `scripts/lib/doc-sync/checks.ts`: assert `docs/api-reference.md` does not contain `Until that dedicated host is provisioned` when `worker/wrangler.toml` contains `site-api.pharos.watch` and `PUBLIC_API_AUTH_MODE = "enforce"`.

Tests/validation:

- `npm run check:doc-sync`
- `npm run check:verified-doc-links`
- `rg -n "Until that dedicated host is provisioned|PUBLIC_API_AUTH_MODE past `off`|when provisioned" docs/api-reference.md docs/deployment-process.md`

Rollout risks:

- `docs/api-reference.md` is currently modified in the worktree. Implementation must merge with existing user edits carefully.

Effort: Small.

Dependencies: None.

#### D3. Reduce API Route Path Duplication

Files/functions:

- `shared/lib/api-endpoints/paths.ts:14-76`
- `shared/lib/api-endpoints/definitions.ts`
  - duplicated public route bases around `dex-liquidity-history`, `supply-history`, `digest-snapshot`, `yield-history`, `safety-score-history`, `mint-burn-flows`, `mint-burn-events`, `stress-signals`, `non-usd-share`
  - duplicated admin/status paths around `status`, `status-history`, `request-source-stats`, `api-keys`, `audit-depeg-history`, etc.
- Tests:
  - `src/lib/__tests__/api-endpoints.test.ts`
  - `worker/src/api/__tests__/router-contract.test.ts`

Recommended implementation choice:

- Do not derive all `API_PATHS` from `ENDPOINT_DEFINITIONS` yet. That would require solving parameterized route builders and dynamic admin routes in one PR.
- Use `API_PATHS` consistently for every definition that already has a builder.
- Add a consistency test that prevents future drift between builders and definitions.

Code-level steps:

1. Add missing path builders in `shared/lib/api-endpoints/paths.ts` where definitions currently hard-code route bases:

   ```ts
   digestSnapshotBase: () => "/api/digest-snapshot",
   feedback: () => "/api/feedback",
   telegramWebhook: () => "/api/telegram-webhook",
   status: () => "/api/status",
   statusHistory: (limit?: number) => buildQueryPath("/api/status-history", { limit }),
   requestSourceStatsBase: () => "/api/request-source-stats",
   auditDepegHistory: (params?: { dryRun?: boolean }) =>
     buildQueryPath("/api/audit-depeg-history", params?.dryRun ? { "dry-run": true } : undefined),
   backfillDews: () => "/api/backfill-dews",
   // Add admin static paths only if they are consumed by status actions/tests.
   ```

   Naming can be adjusted to match repo style, but avoid ambiguous builders where required params differ from base paths.

2. Replace duplicated strings in `definitions.ts` with builders:

   - `path: API_PATHS.dexLiquidityHistoryBase?.()` if adding base builders, or keep `path: "/api/dex-liquidity-history"` and change only probePath to `API_PATHS.dexLiquidityHistory("usdt-tether")`. Preferred: add explicit base builders for route definitions and keep parameterized builders for callers.
   - `probePath: API_PATHS.dexLiquidityHistory("usdt-tether")`
   - `probePath: API_PATHS.yieldHistory("usdt-tether")`
   - `probePath: API_PATHS.safetyScoreHistory("usdt-tether")`
   - `probePath: API_PATHS.mintBurnEvents({ stablecoin: "usdt-tether" })`
   - `probePath: API_PATHS.nonUsdShare(90)`
   - `probePath: API_PATHS.statusHistory(10)`
   - `probePath` and `statusPageAction.path` for audit-depeg dry-run from `API_PATHS.auditDepegHistory({ dryRun: true })`

3. Add a registry consistency test in `src/lib/__tests__/api-endpoints.test.ts`:

   - For each endpoint key with a known builder, assert `getEndpointDefinitionByKey(key)?.path === API_PATHS.<builder>()`.
   - For probe builders, assert expected probe path equals builder output.
   - Keep the existing exact `getProbePaths()` arrays; they protect ordering and status dashboard behavior.

4. Avoid changing public endpoint strings or route keys. This is only a source-of-truth cleanup.

Tests/validation:

- `vitest run src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts`
- `npm run test:critical-contracts`
- `npm run check:doc-sync`
- `npm run check:worker-boundary`
- Optional smoke after deploy-impacting route contract changes:
  - `npm run test:smoke-api -- --base-url <preview-url>`

Rollout risks:

- Endpoint definitions drive auth, site-data access, probe groups, status actions, method validation, and router static path registration. A typo can change production behavior even if the handler code is unchanged.
- Keep exact path values stable. The tests above are mandatory.

Effort: Medium.

Dependencies: None, but B1 should land first so changes to contract tooling cannot skip validation.

Open questions:

- Should route base builders be named with `Base` suffix, or should parameterized builders accept omitted params for base paths? `Base` suffix is clearer and avoids accidental missing query params in callers.
- Should dynamic admin routes (`/api/api-keys/:id/update`) eventually live in `API_PATHS` too? That is useful for UI callers but not required to remediate R8.

### Stream E - Package Manager Reproducibility And Dependency Drift

Findings covered: S6, S7, R13, C6.

Impact: Low individually, but useful before dependency-update batches.

#### E1. Pin And Enforce npm Version

Files/functions:

- `package.json`
- `.npmrc`
- `.github/actions/setup-workspace/action.yml`
- `scripts/__tests__/validate-ci-parity.test.ts`
- `docs/testing.md`
- `docs/deployment-process.md`
- Optional: `worker/package.json`

Current facts:

- Root and worker engines: `node >=22.12 <26`.
- `.nvmrc`: `22`.
- `.npmrc`: `save-exact=true`.
- Local `engine-strict=false`.
- Root `package.json` has no `packageManager`.
- Local `corepack` is not on PATH.
- `npm@11.12.1` is current latest and supports Node `^20.17.0 || >=22.9.0`, compatible with repo engines.

Code-level steps:

1. Add root package manager metadata:

   ```json
   "packageManager": "npm@11.12.1"
   ```

2. Add npm engine metadata so npm itself can validate the expected CLI:

   ```json
   "engines": {
     "node": ">=22.12 <26",
     "npm": "11.12.1"
   }
   ```

   If exact npm in `engines` is too strict for local contributors, use `">=11.12 <12"` and let CI pin exact.

3. Add `devEngines` if the repo wants npm v11 to fail early before install/ci/run:

   ```json
   "devEngines": {
     "runtime": {
       "name": "node",
       "version": ">=22.12 <26",
       "onFail": "error"
     },
     "packageManager": {
       "name": "npm",
       "version": "11.12.1",
       "onFail": "error"
     }
   }
   ```

   Note: npm docs support `devEngines.packageManager`; verify exact-version behavior during implementation because this will run before `npm ci`.

4. Add `.npmrc`:

   ```ini
   save-exact=true
   engine-strict=true
   ```

   If `devEngines` exact npm enforcement proves too strict locally, skip `engine-strict=true` and enforce npm only in CI.

5. Enforce the npm version in GitHub Actions because top-level `packageManager` alone is not enough here:

   - Add input to `.github/actions/setup-workspace/action.yml`:

     ```yaml
     npm-version:
       description: npm version to install before npm ci.
       required: false
       default: "11.12.1"
     ```

   - Add a run step after `actions/setup-node` and before `npm ci`:

     ```yaml
     - shell: bash
       run: |
         npm install -g npm@${{ inputs.npm-version }}
         npm --version
     ```

   The action is used by Node 22, 24, and 25 lanes. `npm@11.12.1` supports all repo-supported Node versions.

6. Update `scripts/__tests__/validate-ci-parity.test.ts` because it currently expects setup-workspace run steps to be only `npm ci`.

7. Update docs:

   - `docs/testing.md:201` should mention Node plus pinned npm.
   - `docs/deployment-process.md:212` should mention CI installs the pinned npm before `npm ci`.

Tests/validation:

- `npm -v` should print `11.12.1` in CI after the new setup step.
- Local after installing npm version or using current:
  - `npm ci --dry-run`
  - `npm run lint`
  - `npm run typecheck`
  - `vitest run scripts/__tests__/validate-ci-parity.test.ts`

Rollout risks:

- `engine-strict=true` plus exact npm can block contributors not on the pinned npm version. If that is too disruptive, use CI enforcement plus docs first, then add `devEngines`/`engine-strict` later.
- Installing npm globally in every CI job adds a small amount of workflow time.

Effort: Small/Medium.

Dependencies: B1 recommended first because `.github/actions/setup-workspace/action.yml` currently is not deploy-impacting.

Open questions:

- Should npm be exact (`11.12.1`) or major-range (`^11.12.1`) in `engines`/`devEngines`? Exact maximizes reproducibility; range reduces local friction.
- Should the worker workspace repeat `packageManager`, or should only the root own it? Root ownership is enough for npm workspaces.

#### E2. Apply Patch/Minor Dependency Updates In Small Batches

Files/functions:

- `package.json`
- `package-lock.json`
- `worker/package.json`
- `.github/dependabot.yml`

Batch 1 - Worker deploy tooling:

- Update:
  - `worker` devDependency `wrangler` from `4.82.2` to `4.83.0`
  - `worker` devDependency `@cloudflare/workers-types` from `4.20260414.1` to `4.20260415.1`
- Command:

  ```bash
  npm install --workspace worker --save-dev wrangler@4.83.0 @cloudflare/workers-types@4.20260415.1
  ```

- Validation:
  - `npm run typecheck`
  - `cd worker && npx tsc --noEmit`
  - `cd worker && npx tsc --noEmit -p tsconfig.scripts.json` if E1/A1 landed
  - `cd worker && npx wrangler --version`
  - `npm run check:migrations`
  - `npm run check:cron-sync`
  - `npm run test:smoke-transport` only if live network smoke is intended

Batch 2 - Worker runtime/EVM helper library:

- Update:
  - `worker` dependency `viem` from `2.47.17` to `2.48.0`
- Command:

  ```bash
  npm install --workspace worker viem@2.48.0
  ```

- Affected imports found:
  - `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts`
  - `worker/src/cron/blacklist/evm-source.ts`
  - `worker/src/cron/dex-liquidity/fetch-slipstream.ts`
  - `worker/src/cron/reserve-adapters/usd1-bundle-oracle.ts`
  - `worker/src/cron/reserve-adapters/crvusd.ts`
- Validation:
  - `vitest run worker/src/cron/blacklist/__tests__/evm-source.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts worker/src/cron/reserve-adapters/__tests__/usd1-bundle-oracle.test.ts`
  - `vitest run worker/src/lib/__tests__/evm-rpc.test.ts worker/src/lib/__tests__/evm-logs.test.ts`
  - `cd worker && npx tsc --noEmit`
  - worker-script typecheck if A1 landed

Batch 3 - Root Next/lint/format patch drift:

- Update:
  - `next` from `16.2.3` to `16.2.4`
  - `eslint-config-next` from `16.2.3` to `16.2.4`
  - `prettier` from `3.8.2` to `3.8.3`
- Command:

  ```bash
  npm install next@16.2.4 eslint-config-next@16.2.4 --save-exact
  npm install --save-dev prettier@3.8.3 --save-exact
  ```

  Because `.npmrc` has `save-exact=true`, explicit `--save-exact` is redundant but harmless.

- Validation:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run build`
  - `npm run seo:check`
  - `npm run test:critical-contracts`
  - Optional browser smoke if build output changes meaningfully: `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local` with local static server.

Do not include in these batches:

- `typescript@6.0.2`: planned migration only. It requires Next, Worker, tsx, eslint tooling, and type-surface review.
- `eslint@10.2.0`: planned migration only.
- `@types/node@25.6.0`: only after Node 25 becomes the canonical type baseline. Current root type baseline is Node 22.

Tests/validation for all dependency batches:

- `npm audit --audit-level=high --omit=dev`
- `npm audit --audit-level=high`
- `npm ls --depth=0`
- `npm ci --dry-run`

Rollout risks:

- `wrangler` is deploy tooling. Prefer a separate PR and check release notes if anything touches `versions upload`, `versions deploy`, `deployments status`, `triggers deploy`, or D1 migration commands.
- `viem` is used by operational scripts as well as runtime code. A worker-script typecheck from A1 increases confidence for that batch.

Effort: Small per batch.

Dependencies: E1 preferred before broad lockfile churn.

#### E3. Local Install Hygiene

Files/functions:

- Local `node_modules`
- `package-lock.json`
- No product code required.

Current issue:

- `npm ls --depth=0 --json` reports four extraneous local packages:
  - `@emnapi/core`
  - `@emnapi/runtime`
  - `@emnapi/wasi-threads`
  - `@tybys/wasm-util`

Code-level steps:

1. Do not remove declared dependencies based on depcheck alone. The prior audit already identified depcheck false positives for CSS imports, TS aliases, and Vitest/Vite internals.

2. When a clean tree is needed:

   ```bash
   npm ci
   npm ls --depth=0
   ```

3. If extraneous packages remain after `npm ci`, investigate package-lock consistency rather than manually deleting only those folders.

Tests/validation:

- `npm ls --depth=0`
- `npm ci --dry-run`

Rollout risks:

- `npm ci` removes and recreates `node_modules`. Do not run during another local process relying on the current install tree.

Effort: Small.

Dependencies: None.

### Stream F - Workspace Hygiene And Repeatable Audit Scope

Findings covered: R12, C6.

Impact: Low, but it affects repeatable full-repo analysis.

#### F1. Do Not Treat Local Build Outputs Or Nested Worktrees As Product Findings

Current local artifact state:

- `.next`: 6.7G
- `worktrees`: 2.3G
- `.worktrees`: 8K
- `node_modules`: 1.1G
- `worker/node_modules`: 48K
- `out`: 135M
- `coverage`: 3.7M
- `output`: 3.2M
- `agents/jscpd-2026-04-16`: 552K

Existing safeguards:

- `.gitignore` ignores `.worktrees/`, `worktrees`, `node_modules`, `.next`, `out`, `coverage`, `worker/node_modules`, and `output/playwright/`.
- `vitest.config.ts` excludes `.worktrees/**`, `worktrees/**`, `.next/**`, `out/**`, and `coverage/**` outside nested worktree checkouts.
- The jscpd audit used explicit ignores for `node_modules`, `.next`, `out`, `coverage`, `worktrees`, `.worktrees`, `agents`, `public`, worker migrations, JSON, tests, and fixtures.

Recommended implementation:

1. Do not delete `worktrees/` or `.worktrees/` without owner confirmation.

2. Add a repeatable duplication-scan command instead of relying on ad hoc jscpd invocations:

   - New script candidate: `scripts/run-duplication-scan.mjs`
   - Or a checked-in `.jscpd.json`

   Required ignore set:

   ```text
   **/node_modules/**
   **/.next/**
   **/out/**
   **/coverage/**
   **/worktrees/**
   **/.worktrees/**
   **/agents/**
   **/public/**
   **/worker/migrations/**
   **/*.json
   **/__tests__/**
   **/*.test.ts
   **/*.test.tsx
   **/test/**
   **/fixtures/**
   ```

3. If `scripts/generate-agent-code-map.mjs` is intended for broad future scans, extend `SKIP_PARTS` to include `worktrees`, `.worktrees`, `agents`, and `output`. It currently skips `node_modules`, `.next`, `out`, `coverage`, `.git`, `.wrangler`, and `.cache`.

4. Document audit scope in `docs/scripts.md` only if a formal command is added.

5. Cleanup procedure for local generated outputs, only with owner confirmation:

   ```bash
   rm -rf .next out coverage output
   npm ci
   ```

   Do not include `worktrees` or `.worktrees` in cleanup commands unless explicitly requested.

Tests/validation:

- `git status --short`
- `npm ls --depth=0`
- Run the duplication scan command if added.

Rollout risks:

- Deleting nested worktrees can destroy active research or pending changes. Require explicit confirmation.

Effort: Small.

Dependencies: None.

## Recommended Remediation Order

### Phase 1 - Harden The Guardrails

1. B1 - Expand deploy-impact classification.
   - Effort: Small/Medium.
   - Reason: setup-workspace, validation contract, and guardrail script changes must not skip deploy validation.

2. A1/A2 - Add worker-script typecheck and fix current stale imports.
   - Effort: Small/Medium.
   - Reason: incident-time scripts are currently outside CI and already broken under typecheck.

3. D1/D2 - Fix `apiFetch` comment and site-data fallback docs.
   - Effort: Small.
   - Reason: no behavior risk; removes misleading operator/developer text.

### Phase 2 - Contract And Budget Precision

4. D3 - Reduce endpoint path duplication with builder usage and consistency tests.
   - Effort: Medium.
   - Dependencies: B1 preferred.

5. C1 - Update cron connection-budget model for Cloudflare's header-wait semantics.
   - Effort: Medium.
   - Dependencies: B1 preferred.

6. E1 - Pin and enforce npm version.
   - Effort: Small/Medium.
   - Dependencies: B1 preferred because it touches `.github/actions/setup-workspace/action.yml`.

### Phase 3 - Focused Cleanup

7. A4 - Consolidate depeg repair SQL statement generation.
   - Effort: Medium.
   - Dependencies: A1 recommended.

8. E2 - Apply dependency patch/minor updates in three small batches.
   - Effort: Small per batch.
   - Dependencies: E1 preferred before lockfile churn.

9. E3/F1 - Clean local install state and formalize duplication-scan exclusions.
   - Effort: Small.
   - Dependencies: owner confirmation for deletion of generated outputs; never delete worktrees without explicit confirmation.

### Phase 4 - Longer-term Structural Hardening

10. A3 - Establish supported operational helper surfaces under `worker/src/lib/admin-backfill` and tighten worker-script import boundaries.
    - Effort: Medium/Large.
    - Dependencies: A1/A2.

## Cross-cutting Risk Matrix

| Risk | Connected findings | Mitigation |
| --- | --- | --- |
| Incident script fails when needed | S1, R7, C2 | Typecheck `worker/scripts`, fix imports, add supported helper surface |
| CI/deploy guardrail edits skip production validation | S2, C4, C6 | Expand deploy-impact coverage for `scripts/lib`, `.github/actions`, and guardrail scripts |
| Endpoint path drift breaks auth/probes/site-data | R8, Q9, S5, C4 | Builder consistency tests, router contract tests, doc alignment |
| Cron budget model encodes stale platform semantics | S4 | Update docs/checker to Cloudflare Apr 09 header-wait semantics |
| Dependency lockfile differs by local npm | S6, S7, R13, C6 | Pin npm in metadata and CI setup; run clean `npm ci` |
| Naive scans report generated clones | R12 | Formal ignore list; never scan local worktrees/generated outputs as product source |

## Plan Review Loop

### Review Pass 1

Result: 4 issues found, 3 major and 1 minor.

1. Major: The original S4 remediation from the audit assumed response bodies still occupy the Worker connection limit. External Cloudflare docs changed this on Apr 09, 2026.
   - Fix applied in this plan: Stream C now models peak header-wait concurrency and requires docs to stop saying unread bodies strand the six-connection pool.

2. Major: A top-level `packageManager` field alone would not enforce npm here because local `corepack` is unavailable and GitHub Actions setup currently runs bundled npm.
   - Fix applied in this plan: Stream E requires CI to install the pinned npm version before `npm ci`, and optionally uses `devEngines`/`engine-strict`.

3. Major: Worker-script boundary hardening could accidentally block the very operational imports that make `worker/scripts` useful.
   - Fix applied in this plan: Stream A sequences typecheck/import fixes first, then proposes a supported helper surface and a targeted boundary rule with a temporary allowlist.

4. Minor: The daily 08:05 cron comment says all four jobs may run concurrently even though daily digest and weekly recap are chained.
   - Fix applied in this plan: Stream C calls out the likely peak as 3 and requires implementation to inspect/update scheduled handler comments.

### Review Pass 2

Result: 1 minor issue found.

1. Minor: Exact npm pin choice (`11.12.1`) may be more strict than some contributors want locally.
   - Disposition: Left as an open question with an alternative of exact CI enforcement plus major-range local `engines`/`devEngines`. This is a policy choice, not a plan blocker.

Review loop exit condition met: fewer than 2 minor issues remain.

## Open Questions For The Implementer

1. Should npm be enforced exactly (`11.12.1`) for local contributors, or exactly in CI with a local major range (`>=11.12 <12`)?
2. Should route base builders use a `Base` suffix, or should existing parameterized builders accept omitted params? `Base` is clearer but adds more names.
3. Should `maxConnections` be renamed to `maxHeaderWaitConnections` now, or should the existing field name be retained with corrected docs for a smaller diff?
4. Are `scripts/fix-commodity-depeg-median.ts` and `scripts/fix-non-usd-depeg-fx.ts` still needed as live runbooks, or should they be retired after operator confirmation?
5. Should production-affecting root scripts move under `worker/scripts/` for ownership consistency, or stay in root `scripts/` because they use root `scripts/lib/remote-d1.ts`?
6. Should the duplication-scan command be added to package scripts, or remain an agent/audit-only documented command?
