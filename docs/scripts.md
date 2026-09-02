# Scripts

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · Safety Score Map Refresh · Operator CLI Contract · D1 Insights Capture · Routing Index · Operational Notes · Safe Usage Guidelines.

## Overview

Operational and CI helper scripts live in `scripts/`, while worker-bound operational tooling that imports `worker/src/**` lives in `worker/scripts/`. Together they support build integrity, smoke checks, data sync, and targeted maintenance tasks.

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

## Routing Index

The command name, composition, and default invocation are owned by the root [`package.json`](../package.json). Run the selected npm command with `-- --help`, or invoke a direct entrypoint with `--help`, for its current flags and defaults. `scripts/lib/cli-argv-policy.mjs` owns argument-safety classification; do not copy its roster into documentation.

### Build And Generated Artifacts

Use the generated-artifact commands in `package.json` for generation, freshness checks, bootstrap, and staged-artifact synchronization. `scripts/lib/automation-registry.mjs` is the authority for artifact dependencies, lifecycle, output paths, checkability, and automatic staging. Build and release behavior is documented in [Testing](./testing.md#ci-pipeline) and [Deployment Process](./deployment-process.md#ci-deploy-sequence); OG asset maintenance is documented in [OG Images](./og-images.md); font generation and licensing are documented in [Font Assets](./process/font-assets.md).

### PR And Release Gates

Use `npm run check:pr -- --base=<ref>` for the adaptive local PR contract and the focused check commands in `package.json` for diagnosis. [Testing](./testing.md#ci-pipeline) owns lane membership and check selection. The workflows under `.github/workflows/` own the actual protected-PR and production release sequence; [Deployment Process](./deployment-process.md) owns operator procedure, rollback, and acceptance. A local script or green local check does not authorize or perform a production release. Boundary exceptions are documented in [Worker Import Boundary Waivers](./process/boundary-waivers.md).

### Smoke And Operations

Use the `test:smoke-*`, `validate:*-smoke`, `serve:static-export`, and `ops:*` commands in `package.json`. Choose the incident-specific procedure through the [documentation index](./README.md) before taking remedial action. Local smoke harnesses and operator watches are evidence tools; production deployment acceptance is owned by the release workflows and [Deployment Process](./deployment-process.md#operational-acceptance).

### Curation Audits

Use the `audit:*`, `candidates:*`, and `calibrate:*` commands in `package.json`. These reports are advisory unless an owning methodology document or CI command explicitly says otherwise. Stablecoin curation procedures live in [Stablecoin Data](./stablecoin-data.md), while feature-specific interpretation lives in the matching methodology or pipeline doc. Keep review queues and research reports under `agents/` unless a reviewed source or durable methodology change belongs in the verified docs corpus. Protocol evidence refreshes are governed by [Protocol API Mechanism Refresh](./process/protocol-api-mechanism-refresh.md) and [CDP Shock-Coverage Refresh](./process/shock-coverage-refresh.md).

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

Generated-artifact destinations and version-control policy are owned by `scripts/lib/automation-registry.mjs`. Do not redirect or manually normalize registered outputs. The pre-commit hook runs `npm run sync:staged-artifacts` and may regenerate and stage affected committed artifacts. Its auto-stage path is strictly offline: no `autoStage` entry may be `network-derived`, so outputs such as `public-datasets` require manual regeneration with `npm run generate:public-datasets`. Staged selection includes deletions, and the sync preflights all selected generators and source state before running them; it stages outputs in one all-or-nothing operation only after every generator succeeds. The source guard includes untracked paths that match registered source globs. `PHAROS_SKIP_ARTIFACT_HOOK=1` is an explicit bypass, not evidence that generated outputs are current.

D1 Insights captures are the specific exception documented above: they write `agents/d1-insights-<timestamp>.json`. Other commands' `--help`, registry entry, or runbook owns the exact destination.

### Release Ownership

GitHub Actions owns the authoritative release gate. Production Worker deployment, remote D1 migrations, Pages publication, release-marker proof, and post-deploy acceptance run through the protected-main workflows described in [Deployment Process](./deployment-process.md). Operator scripts may prepare, classify, observe, or recover a release; they do not replace that path.

A successful deploy proves activation or publication, not runtime health. For cron, scheduler, memory, migration, or ingestion-risk changes, observe the first relevant production execution before claiming operational success. Rollback is operator-led; follow the deployment procedure and remember that a Worker rollback does not automatically revert D1 or other bound resources.

## Safe Usage Guidelines

- Prefer npm aliases from `package.json`; use direct entrypoints only when the routing index or an owning runbook sends you there.
- Read `--help` immediately before running an operator command; flags and defaults belong to the script, not this page.
- During incident debugging, pass explicit URLs and targets instead of relying on environment fallbacks.
- Keep advisory output in `agents/`, and keep registered generated artifacts at their registry-owned destinations.
