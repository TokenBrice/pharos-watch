# Scripts

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · Safety Score Map Refresh · Operator CLI Contract · D1 Insights Capture · Routing Index · Validation Command Index · Build And Generated Artifacts · PR And Release Gates · Operational Notes · Pre-Commit Hook Mechanics · Release Ownership · Safe Usage Guidelines.

## Overview

Operational and CI helper scripts live in `scripts/`, while worker-bound operational tooling that imports `worker/src/**` lives in `worker/scripts/`. Together they support build integrity, smoke checks, data sync, and targeted maintenance tasks.

`scripts/maintenance/audit-seo-render-budget.mjs` measures public-page resource budgets and defaults to the live site. It blocks Google Analytics collection requests before navigation so synthetic audit visits do not enter analytics, but retains GTM/gtag script downloads to measure their JavaScript cost. Each JSON row reports `blockedAnalyticsRequests`; the table labels that count `gaBlocked`. This suppression is specific to the audit and does not change intentional GA acceptance in `smoke-ui.mjs`.

## Safety Score Map Refresh

`npm run build:safety-score-map` fetches one canonical set of report cards, stablecoin supply, and Stability Index data, then renders it. The map does not compare scores, grades, tier populations, leaders, or supply movements with an earlier run; those audits belong to the Safety Score publication pipeline. It retains only input-contract and renderability checks, so a schema-valid held or aged Safety Score publication still produces a poster while malformed data, unusable supply joins, stale PSI context, invalid geometry, missing fonts, or a wrong-size raster fail closed.

`.github/workflows/safety-map-refresh.yml` schedules the refresh at 02:20, 04:20, and 06:20 UTC, plus manual dispatch. GitHub scheduled starts are best-effort and can arrive hours late, so the additional slots only improve the odds. The digest is independent of winning this race and can carry forward a recent dated map within its bounded continuity window.

## Operator CLI Contract

State-changing and release-control scripts use `scripts/lib/cli-args.mjs`, a strict wrapper around Node's `util.parseArgs`. These entrypoints reject unknown options, missing values, accidental duplicate options, unexpected positionals, and declared option conflicts before network or filesystem effects. Every migrated command supports `-h` / `--help`; usage errors exit `2`, runtime failures exit `1`, and help exits `0`.

Every committed source file that reads `process.argv` is enrolled by exact path in `scripts/lib/cli-argv-policy.mjs`. Operator and production-mutating entrypoints must reach a parser that imports and calls the shared strict wrapper; read-only, build/local-artifact, and test/dev entrypoints require an explicit categorized exemption and audit reason. `npm run check:cli-args-policy` rejects unclassified additions, stale or duplicate declarations, strict/exempt overlaps, and strict-parser claims that are not reachable from the entrypoint. Add or remove entries in the source-owned policy with the corresponding script change; there is no count baseline to update.

For these scripts, `--dry-run` means no mutation: a command may read local state or fetch remote data to validate the planned operation, but it does not write files or call a mutating API. `register-telegram.ts --check` remains a compatibility alias for its no-network dry run. `sync-digests.ts --check` remains the narrower no-network wiring check; it conflicts with `--dry-run` so the selected behavior is unambiguous. Existing no-flag workflow invocations retain their prior live behavior.

New scripts parse arguments with `scripts/lib/cli-args.mjs`, or with `node:util.parseArgs` directly when the strict wrapper is not required. Do not hand-roll an `process.argv` loop. The many existing hand-rolled parsers stay as they are; convert one only when that script is already being edited for another reason, so parser migration never becomes a standalone churn commit.

## D1 Insights Capture

Use `npm run ops:d1-insights -- --dry-run` to preview the default read-only Wrangler calls. Without `--dry-run`, the helper captures `7d` reads, `30d` reads, and `30d` time for `stablecoin-db`, then writes `agents/d1-insights-<timestamp>.json`.

Report shape:

```json
{
  "generatedAt": "2026-06-04T00:00:00.000Z",
  "database": "stablecoin-db",
  "captures": [
    {
      "period": "30d",
      "sortBy": "reads",
      "rows": [
        {
          "query": "SELECT /* pharos:example */ ...",
          "_pharos": {
            "sqlFingerprint": "0123456789abcdef",
            "sqlComment": "pharos:example",
            "sourcePaths": ["worker/src/api/example.ts"]
          }
        }
      ]
    }
  ]
}
```

Compare captures before and after an infrastructure change by `period`, `sortBy`, `_pharos.sqlFingerprint`, and `_pharos.sourcePaths`. Keep generated reports under `agents/` unless a durable methodology or source change requires documentation.

### Telegram Adoption

| Script | Purpose |
| --- | --- |
| `scripts/maintenance/report-telegram-adoption.ts` | Read remote D1 adoption and 14-day Telegram dispatch planning telemetry, refresh the generated block in [`telegram-alerts.md`](./telegram-alerts.md), and print the report JSON. |

## Routing Index

The command name, composition, and default invocation are owned by the root [`package.json`](../package.json). Run the selected npm command with `-- --help`, or invoke a direct entrypoint with `--help`, for its current flags and defaults. `scripts/lib/cli-argv-policy.mjs` owns argument-safety classification; do not copy its roster into documentation.

### Validation Command Index

```bash
npm test
npm run test:all
npm run test:pr -- --base=origin/main
npm run test:watch
npm run lint
npm run lint:changed -- --base=origin/main
npm run lint:typed
npm run typecheck
npm run typecheck:tests
npm run typecheck:worker
npm run check:pr -- --base=origin/main
npm run check:bootstrap
npm run check:structural
npm run check:release
npm run test:a11y
npm run test:a11y:hydrated
```

[Testing: Commands](./testing.md#commands) owns the validation behavior behind this discoverable command roster; use `package.json` for the full live npm-script list.

### Build And Generated Artifacts

The stablecoin client projection generator counts the public cemetery as curated dead records plus frozen tracked profiles. Its lightweight generated cemetery count is shared by About copy and root metadata; it is not the curated-only source count.

Use the generated-artifact commands in `package.json` for generation, freshness checks, bootstrap, and staged-artifact synchronization. `scripts/lib/automation-registry.mjs` is the authority for artifact dependencies, lifecycle, output paths, checkability, and automatic staging. Every registry entry declares a build lifecycle: `compile-input` for files the static export needs before compilation, `post-refresh` for projections rebuilt after release data refresh, or `maintenance-only` for explicitly maintained outputs. Plain `prebuild` selects only compile inputs.

Build and release ordering is documented in [Deployment Process](./deployment-process.md#ci-deploy-sequence); failure diagnosis is documented in the [generated-artifact failure playbook](./testing.md#generated-artifact-failure-playbook); OG asset maintenance is documented in [OG Images](./og-images.md); font generation and licensing are documented in [Font Assets](./process/font-assets.md).

### PR And Release Gates

Use `npm run check:pr -- --base=<ref>` for the adaptive local PR contract and the focused check commands in `package.json` for diagnosis. In mixed docs/source plans the docs lane owns `check:doc-sync`; `check:pr` and the generated CI matrix pass `--skip-doc-sync` to the static lane in that composition, while standalone `npm run check:pr:static` keeps its own doc-sync selection. [Testing: Commands](./testing.md#commands) owns their behavior and [Testing: CI Pipeline](./testing.md#ci-pipeline) owns lane membership and check selection. The [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns the protected-PR and production release sequence. Boundary exceptions are documented in [Worker Import Boundary Waivers](./process/boundary-waivers.md).

For `check:focused` selection and preview behavior, use the [smallest adequate check matrix](./testing.md#smallest-adequate-check-per-area).

### Smoke And Operations

Use the `test:smoke-*`, `validate:*-smoke`, `serve:static-export`, and `ops:*` commands in `package.json`. Choose the incident-specific procedure through the [documentation index](./README.md) before taking remedial action. Local smoke harnesses and operator watches are evidence tools; production deployment acceptance is owned by the release workflows and [Deployment Process](./deployment-process.md#operational-acceptance).

### Curation Audits

Use the `audit:*`, `candidates:*`, and `calibrate:*` commands in `package.json`. These reports are advisory unless an owning methodology document or CI command explicitly says otherwise. Stablecoin curation procedures live in [Stablecoin Data](./stablecoin-data.md), while feature-specific interpretation lives in the matching methodology or pipeline doc. Keep review queues and research reports under `agents/` unless a reviewed source or durable methodology change belongs in the verified docs corpus. Protocol evidence refreshes are governed by [Protocol API Mechanism Refresh](./process/protocol-api-mechanism-refresh.md) and [CDP Shock-Coverage Refresh](./process/shock-coverage-refresh.md).

Safety Score V9 curation has one typed queue source: `safety-score-v9:missing-data-registry`. `safety-score-v9:curation-worklist` renders its operator-oriented Markdown view, while `safety-score-v9:expiry-queue` adds only the preventive time-window view using production reserve admission. The low-level evidence-gap and mint-posture entrypoints remain directly invocable compatibility reports without npm aliases; they do not own curation routing.

The V9 calibration analyzer consumes normalized replay artifacts, rebuilds them through the shared replay primitive, and reads its pinned distribution and binding expectations from `scripts/__tests__/fixtures/safety-score-v9-calibration-baseline.json`. It does not read measurement capture bodies. The retired replay-summary, B1 root-ledger, and composite-ceiling aliases remain available as direct one-time entrypoints where an archived runbook names them.

### One-Time And Operator Tools

Direct entrypoints without an npm alias are intentional operator tools only when retained by the script-entrypoint policy. Find them through `scripts/lib/cli-argv-policy.mjs`, then use the entrypoint's `--help` and the relevant runbook from the [documentation index](./README.md) rather than an inventory row here. Worker-bound tools live under `worker/scripts/`; for example, Yield history cleanup follows the [writer-pause runbook](./runbooks/yield-history-cleanup-writer-pause.md), including its export, confirmation, abort, and restore requirements.

## Operational Notes

### Credential Handling

Check the ignored root `.env.local` and the command's documented environment source before treating a local credential as absent. Report only the variable name's presence or absence; never print, copy, or log its value. Production Worker secrets remain Cloudflare/Wrangler-managed and must not be copied into local files.

Forward credentials only to the origin the command documents and that you have verified. In particular, API-backed curation commands may use `PHAROS_API_KEY` and an explicit `PHAROS_API_BASE`; do not send the key to an untrusted override URL. Credential names and bindings are checked against the environment contract, while each command's `--help` owns its accepted variables.

### Mutation Safety

Treat backfills, remote D1 commands, registrations, uploads, and cleanup scripts as admin operations. Start with `--dry-run` or the command's read-only/check mode, inspect the exact target and planned changes, and use staging or development first when available. A dry run may read local or remote state, but it must not write files or call a mutating API.

For live mutation, use the script-specific execute and confirmation guards and follow the relevant runbook. Do not bypass a guard with ad hoc SQL or a raw deploy command. Abort when prerequisites such as a backup/export, writer pause, target identity, or rollback path cannot be proven.

### Artifact Destinations

Scratch reports, evidence captures, calibration output, and operator handoffs belong under the ignored `agents/` tree. Promote only durable policy or reviewed source changes into `docs/` or the owning data source.

Generated-artifact destinations and version-control policy are owned by `scripts/lib/automation-registry.mjs`. Do not redirect or manually normalize registered outputs. See [Pre-Commit Hook Mechanics](#pre-commit-hook-mechanics) for staged-artifact synchronization.

D1 Insights captures are the specific exception documented above: they write `agents/d1-insights-<timestamp>.json`. Other commands' `--help`, registry entry, or runbook owns the exact destination.

### Pre-Commit Hook Mechanics

In the standard local npm setup, `package.json` runs `scripts/maintenance/prepare-workspace.ts` via the `prepare` script. Local installs materialize bootstrap-safe generated projections, materialize the history-derived projections with `npm run bootstrap:generated:history`, and run `git config core.hooksPath .githooks`, so the repo pre-commit hook is configured automatically after install. GitHub Actions skips that implicit prepare work and runs `npm run bootstrap:generated` explicitly through `.github/actions/setup-workspace/action.yml`, opting into the history-derived projections per job with its `bootstrap-history` input. If hooks were disabled or overridden locally, re-enable them with:

```bash
git config core.hooksPath .githooks
```

The pre-commit hook runs `npm run sync:staged-artifacts` and regenerates and stages the committed generated artifacts affected by the staged sources, so a source commit and its derived artifacts land together. Its auto-stage path is strictly offline: no `autoStage` entry may be `network-derived`, so outputs such as `public-datasets` require manual regeneration with `npm run generate:public-datasets`. Staged selection includes deletions, and the sync preflights all selected generators and source state before running them; it stages outputs in one all-or-nothing operation only after every generator succeeds. The source guard includes untracked paths that match registered source globs. `PHAROS_SKIP_ARTIFACT_HOOK=1` is an explicit bypass, not evidence that generated outputs are current.

The hook does not run a local test/build gate; [Testing](./testing.md#commands) owns local validation behavior.

### Release Ownership

The [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns the authoritative gate and production mutation, [Operational Acceptance](./deployment-process.md#operational-acceptance) owns release-marker proof and first-execution observation, and [Failure Policy](./deployment-process.md#failure-policy) owns rollback semantics.

## Safe Usage Guidelines

- Prefer npm aliases from `package.json`; use direct entrypoints only when the routing index or an owning runbook sends you there.
- Read `--help` immediately before running an operator command; flags and defaults belong to the script, not this page.
- During incident debugging, pass explicit URLs and targets instead of relying on environment fallbacks.
- Keep advisory output in `agents/`, and keep registered generated artifacts at their registry-owned destinations.
