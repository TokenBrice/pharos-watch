# Scripts

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · Safety Score Map Refresh · Operator CLI Contract · [Safety Score movement ledger](#safety-score-movement-ledger) · [Safety Score historical capture archive](#safety-score-historical-capture-archive) · [DEX liquidity acceptance capture](#dex-liquidity-acceptance-capture) · Safety Score Capture-Time Replay · D1 Insights Capture · Routing Index · Validation Command Index · Build And Generated Artifacts · PR And Release Gates · Operational Notes · Pre-Commit Hook Mechanics · Release Ownership · Safe Usage Guidelines.

## Overview

CI/operational helpers in `scripts/` and Worker-bound tools importing `worker/src/**` in `worker/scripts/` support build integrity, smoke checks, data sync and targeted maintenance.

Snapshot pulls using `scripts/lib/sync-from-api.ts` retain fixed-backoff retries for 5xx and caller-declared transient statuses. Before retrying they cancel the failed response body. One 30-second `AbortSignal.timeout` deadline (caller-overridable with `timeoutMs`, composed with caller cancellation) covers attempts, waits, and returned-body reads; aborts are not retried.

`scripts/maintenance/audit-seo-render-budget.mjs` measures public-page resource budgets and defaults to the live site. It blocks Google Analytics collection requests before navigation so synthetic audit visits do not enter analytics, but retains GTM/gtag script downloads to measure their JavaScript cost. Each JSON row reports `blockedAnalyticsRequests`; the table labels that count `gaBlocked`. This suppression is specific to the audit and does not change intentional GA acceptance in `smoke-ui.mjs`.

## Safety Score Map Refresh

`npm run build:safety-score-map` fetches one canonical set of report cards, stablecoin supply, and Stability Index data, then renders it. The map does not compare scores, grades, tier populations, leaders, or supply movements with an earlier run; those audits belong to the Safety Score publication pipeline. It retains only input-contract and renderability checks, so a schema-valid held or aged Safety Score publication still produces a poster while malformed data, unusable supply joins, stale PSI context, invalid geometry, missing fonts, or a wrong-size raster fail closed.

Schema rejections use canonical diagnostics (the first failing field path and schema issue), rather than translating errors into historical map-specific wording. Valid payloads still pass the map's score/grade, duplicate-ID, supply-join, and geometry checks.

The renderer in `scripts/maintenance/build-safety-score-map.ts` keeps every graded coin and fixed readable marker floors. It first tries one guide per outer grade band, then deterministically splits dense bands into adaptive rings (candidate maximum populations 120, 90, then 60), shrinking large bubbles only down to the existing floors. Geometry, annotation clearance, and composition checks still apply. Exhausting those layouts throws `SafetyMapCapacityError` with code `layout-capacity-exhausted`; capacity is not repaired by dropping coins, lowering legibility floors, or moving bubbles outside the canvas.

`.github/workflows/safety-map-refresh.yml` runs at 01:20, 03:20, 05:20 UTC and on `workflow_dispatch` (`mode`: `force` renders; `ensure` skips if today's map is live). Schedules start hours late, so the Worker's [producer kick](./safety-score-map.md#pre-digest-producer-kick) dispatches `ensure` from 06:20 to 08:00 UTC; the digest can reuse a recent map.

## Daily Social Posters

`npm run publish:daily-social -- capture --out-dir agents/daily-social/local` captures the day's topic from fresh Pharos API data. `npm run build:daily-social -- --input agents/daily-social/local/snapshot.json --out agents/daily-social/local/poster.png` produces a 1600×1000 PNG with self-contained SVG/HTML and `.alt.txt` siblings. The renderer embeds local fonts and logos and performs no network requests. `capture --topic <topic>` previews another weekday's format without changing the publication calendar.

The [daily social pipeline](./daily-social.md) owns the seven-topic calendar, source eligibility, fallback policy, prepublication validation and immutable image/manifest protocol. Publication is manual: there is no workflow, and operators run `capture` and `build:daily-social` locally, then post the rendered graphic to X by hand. `publish --dry-run` reads and validates the KV target without writes.

## Operator CLI Contract

State-changing/release-control entrypoints use `scripts/lib/cli-args.mjs`, a strict Node `util.parseArgs` wrapper. Before network/filesystem effects they reject unknown options, missing values, duplicate options, unexpected positionals and declared conflicts. Migrated commands support `-h` / `--help`; exits: usage `2`, runtime failure `1`, help `0`.

Every committed source file that reads `process.argv` is enrolled by exact path in `scripts/lib/cli-argv-policy.mjs`. Operator and production-mutating entrypoints must reach a parser that imports and calls the shared strict wrapper; read-only, build/local-artifact, and test/dev entrypoints require an explicit categorized exemption and audit reason. `npm run check:cli-args-policy` rejects unclassified additions, stale or duplicate declarations, strict/exempt overlaps, and strict-parser claims that are not reachable from the entrypoint. Add or remove entries in the source-owned policy with the corresponding script change; there is no count baseline to update.

For these scripts, `--dry-run` means no mutation: a command may read local state or fetch remote data to validate the planned operation, but it does not write files or call a mutating API. `register-telegram.ts --check` remains a compatibility alias for its no-network dry run. `sync-digests.ts --check` remains the narrower no-network wiring check; it conflicts with `--dry-run` so the selected behavior is unambiguous. Existing no-flag workflow invocations retain their prior live behavior.

New scripts parse arguments with `scripts/lib/cli-args.mjs`, or with `node:util.parseArgs` directly when the strict wrapper is not required. Do not hand-roll an `process.argv` loop. The many existing hand-rolled parsers stay as they are; convert one only when that script is already being edited for another reason, so parser migration never becomes a standalone churn commit.

| Verification CLI | Selection contract |
| --- | --- |
| `lint:changed` | Repeatable `--file <path>`, `--staged`, or `--base <ref> [--head <ref>]` are exclusive selection modes. Explicit file/staged modes override PR range environment. Without flags or PR range environment, selects staged, unstaged and untracked working-tree files. Deleted paths are skipped; staged selection still reads working-tree contents. Forward ESLint options after `--`. |
| `check:focused` | Repeatable `--file`, `--staged`, or `--base` selects the authoritative file set forwarded to lint. `--plan-only` performs no checks. Unmapped paths report `routing-incomplete` and exit `1`, even in plan mode; an empty mapped plan reports `intentional-no-check`, not verification. Narrowed related-test plans fail when no tests are selected; cron/scheduler owner suites stay broad unless measured closure justifies narrowing. |
| `check:pr:static` | Retains the explicit base/head range for child lint; rejects `--staged` rather than silently discarding it. Use `check:focused -- --staged` for index-selected checks. |
| `check:generated-artifacts` | Explicit uncheckable IDs, including mixed `--only` requests, fail before execution with lifecycle and generation guidance. Adaptive callers filter via the registry's shared checkability selector; empty plans skip rather than imply freshness. |

### Safety Score movement ledger

`worker/scripts/safety-score-movement-ledger.ts` reports score or grade changes from the [publication journal](./report-cards.md#publication-journal-and-movement-attribution). Run from the repository root; recommended cadence is **weekly**, while the 120-day evidence window and pre-window baselines are still retained:

```bash
npx tsx worker/scripts/safety-score-movement-ledger.ts \
  --from 2026-10-01 --to 2026-10-08 \
  --output agents/safety-score-movements/2026-10-01-2026-10-08
```

`--from` / `--to` are required UTC `YYYY-MM-DD` dates; the window is `[from,to)` and at most 120 days. `--output` is a required local filename prefix; it creates parent directories and writes `<prefix>.md` and `<prefix>.json`. `--database` defaults to `stablecoin-db`. The script performs only remote D1 `SELECT`s through `createRemoteD1Client()` using Wrangler `--remote --command <SQL> --json`, never `--file` or production writes. It keyset-paginates change rows and attempts, loads each changed coin's latest retained pre-window baseline, and includes one attempt before/after the window for hold context. Failed/malformed query envelopes fail instead of becoming empty evidence.

The ledger counts only score/grade changes, not every compact diagnostic change. First sight without a prior retained baseline is reported in `missingBaselineCoinIds`, not counted as movement. Identity changes take precedence as `release` (non-comparable methodology/policy/build, **not causal proof**). Same-identity changes in pipeline-gap or partial-evidence state classify as `operational`. Persistent partial evidence remains context and does not override an included-pillar, peg, or cap movement; unexplained movement adjacent to a hold is operational. Otherwise the largest observed absolute pillar delta or pillar availability change supplies `data:<pillar>`, with all secondary/null deltas retained. Peg-only and cap-only changes have explicit labels; adjacent holds remain linked context. Remaining edges are `data:unattributed`. The JSON retains before/after compact cards, identities, lineage and hold codes; retained change-only observations cannot replace a full frozen-input replay or prove that missing edges did not occur.

### Safety Score historical capture archive

`worker/scripts/export-safety-score-capture-archive.ts` reads the [accepted capture archive](./report-cards.md#accepted-capture-archive-and-historical-replay). Run from the repository root:

```bash
npx tsx worker/scripts/export-safety-score-capture-archive.ts list \
  --from 2026-10-01 --to 2026-10-08 --gaps
npx tsx worker/scripts/export-safety-score-capture-archive.ts boundary \
  --before-time 2026-10-08T12:00:00Z
npx tsx worker/scripts/export-safety-score-capture-archive.ts export \
  --generation '<generation_id>' --output agents/v9-captures/historical.raw.json \
  --cards-output agents/v9-captures/historical.accepted.json
```

- All modes use read-only D1 `SELECT`s through `createWorkerD1Client()`, defaulting to remote `stablecoin-db`; `--local` selects Wrangler's local D1 instead, and `--database` selects another configured database. Failed/malformed envelopes fail closed. No remote writes or `--file` SQL are issued by this CLI.
- `list` requires increasing UTC `YYYY-MM-DD` dates, includes `[from,to)`, and permits at most 180 days. JSON includes each index row's generation, clocks, methodology/policy/build identity, object key/checksum/bytes, and the uniform `180-day-captures-lifecycle` policy label. This names external account state: enabled rule `180d-capture-cleanup` on `pharos-measurements`, prefix `captures/`, 180-day deletion, verified **2026-10-08**. The migration/CLI do not create or continuously verify it. There are no hot/daily/boundary sampling tiers.
- Optional `list --gaps` also reports retained **accepted** publication attempts in `[from,to)` with no archive index row, including unchanged accepted publications that have no change-only card journal entries. Each gap carries attempt/generation/clock and methodology/policy/build identity. It excludes held attempts and keyset-paginates evidence. The attempt journal is best effort and retained for 120 days: absent/pruned attempts, an index-present expired/missing object, and missing history outside that evidence window are not detected by this query. Empty `gaps` is not a complete archive-coverage certificate.
- `boundary --before-time <instant>` returns the maximum archived publication clock strictly before a validated nonnegative integer Unix timestamp or ISO-8601 UTC timestamp ending in `Z` (seconds with optional one-to-three fractional digits). Use the exact deployment instant for intraday releases; `--before YYYY-MM-DD` still selects strictly before UTC midnight. The options are mutually exclusive. `--before methodology:<version>`, `policy:<sha256>` and `build:<sha256>` retrospectively return the predecessor of the most recent **already archived** transition into that identity, not a future release boundary. Missing predecessors fail; missing archive rows cannot establish the exact last production generation or release time. Ordering is `published_at,generation_id`, including deterministic timestamp ties.
- `export` requires `--generation` and `--output`. It reads the indexed R2 object using the existing signed measurement client (`CLOUDFLARE_ACCOUNT_ID`, `R2_MEASUREMENTS_ACCESS_KEY_ID`, `R2_MEASUREMENTS_SECRET_ACCESS_KEY`), verifies exact object SHA-256/byte count, schema, index identity, paired retention clocks and the accepted cards' native codec/identity, then writes the one-successful-result/two-cache-row JSON shape consumed by `report-cards:capture-fixed-input --accepted-cache-export`. The capture CLI still verifies the base/delta envelopes and binding before restoring them; archive export does not substitute for that admission step.
- Optional `--cards-output` writes the decoded accepted publication JSON, not its compressed cache envelope and not a full replay artifact. Optional `--source-dir` reads exact object bytes from `<dir>/<r2_key>` instead of R2; it needs no R2 credentials and works with either D1 target. Both output files must be distinct; parent directories are created.

The [historical release/data separation procedure](./process/safety-score-equivalence-harness.md#historical-release-and-data-separation) includes local D1 fixture loading and the explicit lightweight projections needed to compare accepted cards with replay output. Archive creation is best effort, starts when the writer is deployed, and can leave permanent failed/skipped gaps once mutable accepted rows are overwritten. `--gaps` makes retained journal-observable omissions visible; it does not repair them or discover unindexed R2 orphans. No historical captures are invented or backfilled.


### DEX liquidity acceptance capture

`worker/scripts/dex-liquidity-acceptance-capture.ts` archives short-lived DEX operational evidence for offline acceptance reporting. **Capture daily, report weekly**: `cron_runs` is pruned after seven days, so a weekly-only pull has no safety margin. This is an operator cadence, not a deployed scheduler.

```bash
npx tsx worker/scripts/dex-liquidity-acceptance-capture.ts capture
npx tsx worker/scripts/dex-liquidity-acceptance-capture.ts capture \
  --from 2026-10-01 --to 2026-10-04 --out agents/dex-acceptance/2026-10-04
npx tsx worker/scripts/dex-liquidity-acceptance-capture.ts report \
  --input agents/dex-acceptance --from 2026-10-01 --to 2026-10-08
```

- **`capture`** reads remote D1 with the same read-only `--remote --command <SQL> --json` client (no `--file` or D1 mutation), default database `stablecoin-db`. Its default trailing three-day window gives overlapping opportunities before pruning; explicit increasing past windows may span at most seven days. Dates or timezone-qualified ISO timestamps are accepted. Default output is `agents/dex-acceptance/<UTC capture date>/`, resolved against the repository root; `--out` accepts another directory or an absolute path.
- Each schema-v1 `capture-<timestamp>.json` preserves remote clock, database/window, exact SQL, local query time, raw Wrangler envelopes, row counts, query limits/truncation and failures. It captures daily history/flips, all publication/source-stage/discovery cron rows and prior productive version anchors, registry age/source/identity diagnostics, manifests, retained generation-row projections and current coverage. Registry/current reads are sequential live snapshots, **not an as-of transaction**. A failed/truncated query still writes the partial packet and exits unsuccessfully; an unavailable remote clock is fatal. Capture files use exclusive creation, not overwrite.
- **`report`** is offline: recursively reads `capture-*.json` under `--input` (default `agents/dex-acceptance`), rejects mixed databases, deduplicates overlapping run IDs using the latest capture, and writes `scorecard-<from>-<to>.md` / `.json` into `--out` (default input directory). The default window is the seven complete UTC days ending at midnight on the latest capture date; explicit windows must also span exactly seven complete UTC days. `--database` belongs only to capture and `--input` only to report.

The report separates the **unchanged legacy handover targets** from **prospective evidence**. Legacy daily flips require both day endpoints strictly above $1M and strict `>1.5x` / `<0.5x` steps, bucketed by **day0**; the day1 endpoint is needed beyond the half-open report window. Prospective material moves use inclusive `>=1.25x` / `<=0.80x` **or** an absolute delta `>=$1M`, with separate eligible pair coin-day denominators, below-$1M/hourly return diagnostics, zero/new/missing-observation transitions, method/build cohorts, route funnel/selection/continuity, and active-catalog/observed/rated/score-bearing-route coverage. Retained generation rows are preferred; top-five fallback is explicitly a censored lower bound, never a complete hourly census.

Only the first productive run after a version change **of the same job** is excluded from clean distributions; absent version anchors are unavailable, not assumed unchanged. Median is the ordinary sample median and p95 is nearest-rank. Missing telemetry, baselines, query windows, generation inventories or prior-week captures remain null/`UNMEASURABLE`, never a passing zero. `d1Cost.coverage: "partial"` retains its measured sums/reasons in raw evidence but **never passes the complete-cost gate**. Cost comparison uses actual complete hourly stage + publication D1-read totals (failed/neutral invocations included), not provider `rowsRead`, registry inventory reads or the operator query's own D1 metadata. The legacy authoritative-confirmation baseline remains unmeasurable; captured registry PASS does not certify unseen between-capture maxima.

Preserve ignored `agents/dex-acceptance/` archives externally as required before source rows expire; pruned history cannot be reconstructed. Nonzero flip attribution requires operator root-cause review, not source/protocol names or coincident builds. This reports DEX/Liquidity acceptance evidence, not unchanged-policy Safety score/grade/NR stability. See [DEX liquidity](./dex-liquidity.md) for the producer and methodology contracts.

## Safety Score Capture-Time Replay

`npm run report-cards:capture-fixed-input -- --exact-cache-export <path> --output <path>`
exports a registry-bound wrapper with normalized `fixedInput` and a verified `registrySnapshot`.

`npm run safety-score-v9:replay -- --input <path> --output <path> --published-at <seconds> --registry-ref <git-sha>`
replays against the capture-time registry.

`npm run safety-score-v9:movers` resolves to `worker/scripts/diff-safety-score-v9-movers.ts`. Like replay and diff, this is Worker-bound tooling because full-artifact admission uses the native/legacy capture contracts. Keep its implementation under `worker/scripts/`, outside the root TypeScript program; the npm alias and flags remain unchanged.

Use `jq '(.fixedInput // .).clockSec'` to read either export shape. The [equivalence harness](./process/safety-score-equivalence-harness.md#capture-time-registry-replay) owns snapshot admission, trusted-Git execution, production-digest limitations, and the `--registry-ref`, `--normalized-only`, and `--allow-registry-mismatch` mode contracts.

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
| `scripts/maintenance/report-telegram-adoption.ts` | Build-category reporter: read remote D1 subscriber, lifecycle, usage, and confirmed-delivery adoption telemetry, refresh the local generated block in [`telegram-alerts.md`](./telegram-alerts.md), and print report JSON. No production mutation. Planning-cost/4.1 decision reporting is retired without a measured go/no-go conclusion. |

## Routing Index

Root [`package.json`](../package.json) owns command names, composition and default invocations. Use npm `-- --help` or direct-entrypoint `--help` for current flags/defaults. `scripts/lib/cli-argv-policy.mjs` owns argument-safety classification; do not duplicate its roster.

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
npm run check:pr
npm run check:bootstrap
npm run check:structural
npm run check:release
npm run check:pages-artifact
npm run check:html-fixture-metadata
npm run check:dependency-audit
npm run ci:census -- --since=YYYY-MM-DD --out=agents/ci-census.json
npm run test:a11y
npm run test:a11y:hydrated
```

[Testing: Commands](./testing.md#commands) owns the validation behavior behind this discoverable command roster; use `package.json` for the full live npm-script list.

| Command | Contract / source |
| --- | --- |
| `check:pr` | `scripts/maintenance/run-pr-checks.ts` guards exact `.nvmrc` Node and npm 11.x through `scripts/lib/runtime-guard.mts`, rejects staged selection and a head other than the checkout, resolves base/head identities, and executes every independent selected leaf even after failures. `scripts/lib/pr-check-receipt.mts` writes `.tmp/pr-check-receipts/<HEAD>.json` with runtime, refs, tree state, flags, leaf status/duration/first error and `passed`, `failed`, or `incomplete` outcome. Dirty tracked or untracked state (respecting `.gitignore`) yields `incomplete` with reason `dirty-worktree` unless a leaf fails; JSON execution status matches the receipt outcome. A zero exit from a dirty or weakened run is not a passing readiness receipt. |
| `check:pr -- --plan` | Gate-wide non-executing plan: selected static/docs commands, discovered tests, CI partitions and critical owners. Test discovery may import modules; no assertions, fetch, clean install/bootstrap proof, or readiness proof. The plain runner replaces the receipt with incomplete plan evidence. |
| `check:pr -- --ci-parity` | Opt-in independent clean clone and tested merge checkout, clean install/bootstrap immutability, trusted scans, selected browser prerequisites, serialized explicit CI test/coverage partitions and selected Pages artifact lane. `scripts/maintenance/run-ci-parity.ts` records author base/head separately from tested merge SHA/tree; it does not reproduce hosted-runner OS, GitHub artifact transport or production mutations/health. `--plan` prints this profile without executing or writing a receipt. |
| `check:pages-artifact` | `scripts/ci/run-pages-artifact-lane.ts` replays the newest available successful trusted-main release snapshot via authenticated GitHub GETs, regenerates compile/post-refresh inputs offline, builds with production flags and clean compiler/output state, runs postbuild and every `check:pages-release` artifact gate, then restores input snapshots. Unavailable/expired release data uses committed snapshots plus offline detail bootstrap and reports `degraded-data`; empty detail payloads are weaker size evidence, not realistic release-data proof. Invalid downloaded data fails. No live refresh, production credentials or publishing. |
| `check:release` | `scripts/maintenance/run-release-rehearsal.ts` uses that shared Pages runner without acquiring release data, preserves local build typechecking, then validates migrations and strict dry-run packages for both Workers. Default rehearsal is offline: no migration application or deployment. `--live-continuity` explicitly adds the live previous sitemap check. |
| `check:html-fixture-metadata` | `scripts/ci/check-html-fixture-age.ts --metadata-only` validates canonical capture stamps and refresh-target inventory without calendar age/future-clock enforcement. Weekly `check:html-fixture-age` owns those time-dependent checks. |
| `check:dependency-audit` | `scripts/ci/verify-dependency-audit.ts` audits the full lockfile, including dev dependencies. PR static guards pass `--new-since=<baseSha>` (frozen `PR_BASE_SHA`, otherwise merge-base with `origin/main`), audit base/current lockfiles with `--package-lock-only`, fail on new high/critical advisory/package pairs, and print pre-existing pairs as tracked by weekly audit; missing base evidence fails. No-flag weekly mode retains exact reviewed/unexpired exception policy and a separate package-signature check. The [registry](../scripts/ci/dependency-audit-exceptions.json) remains empty; braces [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) remains a weekly incident, not an accepted exception. `audit:deps` remains production-only. |
| `ci:census` | `scripts/maintenance/ci-failure-census.ts` uses authenticated `gh` GETs for workflow/run/attempt/job evidence. `--since` is required; `--until` defaults to today's inclusive UTC day; optional `--cut` creates descriptive `created_at` cohorts. `--out` writes JSON and `<out>.md`, otherwise both print. Latest run-ID conclusions and retained execution attempts are separate; censored branches and cancellation provenance remain explicit. This reports evidence, not guessed causal categories. |
| `lint:typed` | `package.json` pins an 8192 MiB Node heap and warning-as-error typed ESLint over the maintained production glob set. |

### Build And Generated Artifacts

The stablecoin client projection generator counts the public cemetery as curated dead records plus frozen tracked profiles. Its lightweight generated cemetery count is shared by About copy and root metadata; it is not the curated-only source count.

The Git-history-derived projections publish two different clocks on purpose. A coin profile's sitemap `lastmod` is the newest commit across its base coin file, every `shared/data/stablecoins/domains/**` research sidecar it owns, and the shared detail-page sources, so a reserves, mint-authority, compliance or risk-review edit moves that profile's date without touching its base file. Generated docs metadata uses committer time for `dateModified`, because that is deployment modification time rather than the author clock a rebase or cherry-pick can preserve, and keeps author time for `dateCreated`, which is the authored-inception date of the document. Both projections are selected by the sources declared in `scripts/lib/automation-registry.mjs`, so a new sidecar tree or a new public doc must be added to those declarations to reselect its generator.

Use `package.json` for artifact commands and `scripts/lib/automation-registry.mjs` for dependencies, lifecycle, outputs, checkability, and staging. Lifecycles are `compile-input`, `post-refresh`, and `maintenance-only`; standalone `prebuild` runs the first two, while Pages splits preparation/release for one live snapshot acquisition. Offline bootstrap writes empty detail envelopes before credentials/fetch; snapshots declare catalog prerequisites and an output directory. Setup rejects changed tracked checkable outputs and nonignored registered outputs absent from Git, including after restore; regenerate and commit repairs with their sources. Ignored compile outputs remain allowed. See [release ordering](./deployment-process.md#ci-deploy-sequence).

Registry entries also declare `requiredBrowsers` (default `[]`). `scripts/ci/classify-deploy-changes.ts` derives Firefox setup only from selected artifacts whose registry entry requires it; a generic OG change is not sufficient.

Build and release ordering is documented in [Deployment Process](./deployment-process.md#ci-deploy-sequence); failure diagnosis is documented in the [generated-artifact failure playbook](./testing.md#generated-artifact-failure-playbook); OG asset maintenance is documented in [OG Images](./og-images.md); font generation and licensing are documented in [Font Assets](./process/font-assets.md).

`PHAROS_DETAIL_SNAPSHOT_SOURCE` defaults to `per-coin` (the Pages release sets `bulk`); `verify:detail-snapshot-sources` reports byte/field diffs and pass timings; `--keep-dir` retains evidence: [bulk source](./stablecoin-detail-page.md#build-snapshot-hydration).

`postbuild` runs `inline-homepage-critical-css.ts` in a Beasties worker pool; `PHAROS_CRITICAL_CSS_WORKERS` overrides concurrency: [Pages release](./deployment-process.md#ci-deploy-sequence).

### PR And Release Gates

Before **every** authorized first or replacement push, run full plain `npm run check:pr` on the final committed state, without skip/filter/plan-only flags, after full generated-artifact convergence. Focused checks are authoring feedback, never readiness proof. The passing receipt must describe current HEAD, clean state, and the unweakened run. There is no pre-push hook. [Pre-push readiness](./testing.md#pre-push-readiness) owns runtime activation, refs, receipt requirements and the ordered workflow; [release gates](./deployment-process.md#release-snapshot-state-machine) and [boundary waivers](./process/boundary-waivers.md) own release policy.

Use `--ci-parity` additionally after a remote failure the local gate did not reproduce, and for lockfile/setup/security-policy changes; plain `check:pr` remains the everyday readiness gate. When CI fails, collect every failed leaf, fix all causes in one causal revision, rerun full readiness, then push once. A zero focused plan for unmapped production paths is a routing failure, not a pass.

`scripts/lib/pr-test-plan.mts` owns one-time `test:pr --plan-out` selection and weighted 4/8-shard plans; [CI Pipeline](./testing.md#ci-pipeline) owns plan consumption and static groups.

`node --import tsx scripts/maintenance/refresh-pr-test-timings.ts --runs=5` refreshes committed scheduling weights: [when, provenance, and review](./testing.md#ci-pipeline).

Plain-test and critical-coverage runners supply an explicit timing lane; headings and overflow artifact links use the same lane. Timing rows remain scheduling telemetry, never test or coverage correctness gates.

Critical ownership reads base-revision Git blobs using their declared byte lengths; embedded NULs and multibyte text cannot shift later file records. Frontend-to-Worker import checks cover literal dynamic imports as well as static imports, retaining the documented waiver.

For `check:focused` selection and preview behavior, use the [smallest adequate check matrix](./testing.md#smallest-adequate-check-per-area).

`check:unused-code` credits namespace property reads, literal-key reads and literal `vi.spyOn`/`jest.spyOn` members individually; default imports consume only `default`, and side-effect imports preserve reachability without consuming named exports. Computed or escaping namespace uses retain conservative whole-module consumption and print their source/target in the audit. Dynamic import results and unqualified import types remain conservative, with aggregate audit counts. Newly exposed exports require individual review, not a blanket allowlist. Scanner fixtures must use external temporary workspace roots, never the repository root.

Useful test-only evidence belongs in recognized `*.test-support.ts` files, not production module DEBT or external-consumer blind spots. The matched Safety Score invariant corpus lives beside its importing shared test and remains outside the product evaluation-build manifest. Preserve its evidence when relocating it.

`check:cron-console-usage` reports missing baseline paths separately from extant zero-call files and keeps its blocking growth ratchet. Structured-log conversions must preserve console-only versus durable-event semantics; no date or stored-budget decrease authorizes strict-zero enforcement without a measured current-root zero scan and persistence parity.

`check:script-entrypoints` includes `.mts` files in forward command scanning, reverse candidates and reverse references; declaration files are not runnable candidates. Markdown still receives stale-command checks but cannot retain an otherwise unreferenced script. The reverse check remains a textual-reference audit, not an executable import graph: policy-retained operator tools remain valid, and mutually referring disconnected scripts are not proven reachable.

### Smoke And Operations

Use the `test:smoke-*`, `validate:*-smoke`, `serve:static-export`, and `ops:*` commands in `package.json`. Choose the incident-specific procedure through the [documentation index](./README.md) before taking remedial action. Local smoke harnesses and operator watches are evidence tools; production deployment acceptance is owned by the release workflows and [Deployment Process](./deployment-process.md#operational-acceptance). `night-watch-worker --dry-run` prints its preview to stdout (`--json` selects JSON), preserves report, evidence, and checkpoint files, and performs no remote collection, including with `--fixture`. Ordinary fixture rendering remains a file-writing mode.

`ops:cron-delivery` reads Cloudflare scheduled-invocation ground truth; see [cron delivery stall](./runbooks/cron-delivery-stall.md).

### Curation Audits

Use `package.json`'s `audit:*`, `candidates:*`, and `calibrate:*` commands; reports are advisory unless owner docs or CI enforce them. [Stablecoin Data](./stablecoin-data.md) owns curation; feature docs own interpretation. Keep research/queues in `agents/`, durable changes in owner docs. Refresh contracts: [protocol APIs](./process/protocol-api-mechanism-refresh.md) and [CDP shocks](./process/shock-coverage-refresh.md).

These are permanent human review tools, not latent scoring engines. Dispositions do not admit a provider, route, dependency edge, or yield source. DIA price-provider probing and the mint-authority scanner POC are retired; use primary-source native-control review with `audit:mint-authority-review` and `audit:mint-bridge-ownership` instead of generated unknown scanner output.

The shadow-era replay summary and fixed July B1 historical DEX root-ledger entrypoints are retired (2026-10-08), including direct current-tree support for archived runbooks. Historical reproduction uses the source checkout and exact input/registry/census/clock/output pins of the archived investigation; Git source alone does not guarantee an exact rerun. Permanent replay/diff/movers remain supported, but worklist/expiry tools are not replacements for the retired renderer.

- `audit:price-source-depth` proposes conditional coverage lifts, not measured new sources or independent trust. Retain both report-card and stablecoin input identities/clocks with the next audit; independent snapshots need not share a publication generation.
- `audit:coverage -- --domain=redemption-coverage` always evaluates reviewed-disposition findings. `--check` changes presentation only: a reviewed nonzero backlog can pass either mode, while missing/invalid/stale dispositions fail either mode. `--strict-active-gaps` separately escalates inferred active gaps; a disposition never configures a redemption route.
- `audit:coverage -- --domain=reserve-coverage` is advisory and has no `--check` evaluator (the child rejects that option). `--prod` supplies report-card/stablecoin catalog snapshots, not reserve-sync telemetry; use explicit `--reserve-states <file>` for state evidence. Absent state stays unknown.
- L2BEAT snapshot audits distinguish alias-only validation, saved observed input, and explicit `--live` drift checks; see [Chain Health](./chain-health.md#l2beat-snapshot). None imports live data into the authoritative static snapshot automatically.

`npm run audit:live-reserve-config-changes -- --base <ref>` compares working-tree semantic fingerprints to an explicit deployed/PR base offline, printing changed IDs and both digests as JSON; missing recovery fetchers fail. New/removed bindings and display/scoring edits are excluded. It shares runtime's pure selector; tests are git-independent. Bounds/acceptance: [config recovery](./live-reserves.md#deploy-time-configuration-recovery).

`scripts/maintenance/refresh-independent-assurance-reports.ts` registers MYRC's offline extraction via `scripts/lib/independent-assurance-profiles/myrc.ts`. [MYRC reserve verification](./live-reserves.md#fund-and-issuer-transparency-feeds) owns distinct cash/fund rows, shared reconciliation tolerances, excluded circulation, exact-PDF/extraction provenance and examined-balance clocks.

`npm run audit:mint-burn-conservation-admission -- --ids <csv> --out <dir>` runs the production raw-token conservation audit over a frozen per-chain window (timestamp-driven by default; `--window-blocks` overrides) for every config of the requested stablecoin ids; semantics and the reviewed-identity sidecar are owned by [Mint/Burn Flows: Raw Token Conservation](./mint-burn-flows.md#raw-token-conservation). It journals every JSON-RPC exchange to `<out>/journal.jsonl` with URLs redacted to origin and chain path (never the API key), reproduces records offline with `--replay <journal.jsonl>`, and — given reviewer semantic files via `--semantic-dir` — emits `sidecar-draft.json` entries (`--emit-sidecar-draft`) that `--merge-into-sidecar` merges into the committed sidecar. The command exits 1 when any audited window is not `ok`; journals and drafts stay under `agents/`.

Audit and draft modes do not mutate admission authority. Only explicit `--merge-into-sidecar` changes the reviewed sidecar and regenerates its runtime projection; retain the journal and restore the exact sidecar/projection pair on rollback, never disable the ingestion fence.

V9 typed queue: `safety-score-v9:missing-data-registry`; `safety-score-v9:curation-worklist` renders Markdown; `safety-score-v9:expiry-queue` adds preventive production-admission expiry checks. Direct evidence-gap/mint-posture compatibility tools have no aliases or routing role.

Worklist and pre-expiry supply come from the exact replay's retained nullable supply state, not a fresh market-cap lookup. Missing supply stays unavailable with a reason; observed zero stays zero. Reports disclose known-supply subtotals/unavailable counts and qualify known-only ratios, with deterministic unknown-first ordering rather than assigning unknown assets the smallest weight.

USDe/USDf manual capture and reviewed weekly protocol-API automation are permanent non-publishing evidence tooling. Strict replay reports canonical V2 / original-byte hash-verified normalized-only V1 / unavailable separately; unavailable access or bodies fail. Replay may perform signed R2 GETs and cache verified bytes; network-free use requires local original bytes/cache. fxSAVE's standalone local capture stays incomplete/N/A; its reviewed dossier already attaches parent evidence at a separate immutable clock/block, not new local CDP credit.

The real-A distribution calibration analyzer and aggregation-rescore wrapper are retired (2026-10-08). Historical source/fixture lineage remains in Git; authored reports remain archival evidence, not current approval. Operators lose distribution, uncertainty-ledger, capture-stability, causal-attribution, histogram/pileup and stale-trace-rescore formats; replay/diff/movers are not format-equivalent replacements.

Replay, diff, movers, sensitivity, anchor calibration, live-withheld and DDRR calibration are permanent operator tools for the active model under stable V9 namespaces, never alternate publishers. Replay defaults to captured redemption bytes; `--rederive-current-redemption` is an explicit current-curation scenario. Diff proves normalized score-output equality only, with malformed/duplicate cards rejected and activation identity checked separately. Anchor report schema 2 removes unused pending-ruling fields/option while preserving failed diagnostic exits. Sensitivity perturbations stay research-only; golden baseline invariants remain authoritative tests.

Annotation and AI-summary candidate request deadlines remain active through JSON body consumption. Annotation collection uses fixed 14-day windows and serial cursor pagination, bounded to 25 pages and 30 seconds per source with a 6-second request/body timeout. Partial results retain explicit incomplete coverage. Full queues, digest, and logs are immutable Actions artifacts retained for 90 days; issue excerpts link to those artifacts.

Annotation intake, corpus, reviewer decisions, and deferrals remain after chart-overlay retirement; no candidate publishes automatically. AI-summary QA reads four endpoint families (report cards, stress signals, peg summary, stablecoins), uses heuristic detectors, and skips summaries without a current card. An empty candidate report is not affirmative validation of all prose; exact-text human review and registered claim tokens remain authoritative.

`npm run candidates:annotations -- --replay agents/annotation-history` recursively reads downloaded `annotation-candidates.json` snapshots and merges them with local unresolved rows offline. Reviewer-owned `agents/annotation-review.json` dispositions suppress only explicitly promoted or dropped IDs, preserve deferrals, and admit distinct same-day events. Generation never advances legacy `last_swept_at`, writes review decisions, or edits product annotations. AI-summary liquidity findings assert retirement only with explicit legacy Safety Score context; current or ambiguous DEX claims receive neutral review without an invented comparison. `npm run candidates:ai-summaries` also emits medium-severity `weakest-pillar` findings when prose names a weakest pillar other than the card's published `weakestPillar`, and `retired-methodology-version` findings when a Safety Score sentence cites a major version from v9 up to but excluding the current one (pre-v9 claims stay with the retired-dimension findings; protocol versions such as Aave v3 are ignored outside Safety Score sentences).

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

The pre-commit hook runs `npm run sync:staged-artifacts`, regenerating/staging committed artifacts affected by staged sources, including deletions. Auto-stage is offline: `autoStage` cannot be `network-derived`; regenerate `public-datasets` manually with `npm run generate:public-datasets`. All selected generators and source state are preflighted; outputs stage atomically only after every generator succeeds. The shared prebuild phase planner orders offline prerequisites before dependents (canonical catalog → packed Worker bytes → evaluation manifest). Only `autoStage` outputs enter the index; network-derived prerequisites are refused. The source guard covers unstaged/untracked inputs throughout the dependency closure and rejects dirty outputs before generation. Failure restores clean tracked outputs from the index, removes newly created registered-glob files, and restores existing ignored prerequisites' bytes; pre-existing glob members survive, though empty directories may remain. Manifest and registry share authored fixed hash inputs; recursive capture summaries/their parser trigger regeneration without adding unrelated operational code to score identity. `PHAROS_SKIP_ARTIFACT_HOOK=1` bypasses the hook, not artifact freshness proof.

Exact wrapper bypasses in `.githooks/pre-commit`: `PHAROS_SKIP_ARTIFACT_HOOK=1`, an in-progress merge, cherry-pick or revert (their Git state files under `.git/`), `rebase-merge` or `rebase-apply`, and an empty staged diff. Hook installation itself is skipped when `CI` or `GITHUB_ACTIONS` is `1`/`true`, or `PHAROS_PREPARE_SKIP_GIT_HOOKS` is `1`/`true`; `PHAROS_PREPARE_BOOTSTRAP` forces ordinary bootstrap in CI but does not install hooks or enable history bootstrap there (`scripts/maintenance/prepare-workspace.ts`).

The hook is neither full artifact convergence nor a local test/build gate. After final source/integration history, including bypassed merge/rebase/cherry-pick/revert operations, run full `npm run check:generated-artifacts` before the [pre-push readiness run](./testing.md#pre-push-readiness).

### Release Ownership

The [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns the authoritative gate and production mutation, [Operational Acceptance](./deployment-process.md#operational-acceptance) owns release-marker proof and first-execution observation, and [Failure Policy](./deployment-process.md#failure-policy) owns rollback semantics.

## Safe Usage Guidelines

- Prefer npm aliases from `package.json`; use direct entrypoints only when the routing index or an owning runbook sends you there.
- Read `--help` immediately before running an operator command; flags and defaults belong to the script, not this page.
- During incident debugging, pass explicit URLs and targets instead of relying on environment fallbacks.
- Keep advisory output in `agents/`, and keep registered generated artifacts at their registry-owned destinations.
