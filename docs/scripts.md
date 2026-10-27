# Scripts

> **Agent navigation** — Read the matching section, not the whole book: [Overview](#overview) · [Map refresh](#safety-score-map-refresh) · [Daily social](#daily-social-posters) · [Operator CLI contract](#operator-cli-contract) (ledger, archive, DEX acceptance) · [Capture-time replay](#safety-score-capture-time-replay) · [D1 insights](#d1-insights-capture) · [Routing index](#routing-index) (validation, artifacts, release, smoke, curation) · [Operational notes](#operational-notes) (credentials, mutation, destinations, workspace) · [Safe usage](#safe-usage-guidelines).

## Overview

CI/operational helpers in `scripts/` and Worker-bound tools importing `worker/src/**` in `worker/scripts/` support build integrity, smoke checks, data sync and targeted maintenance.

Snapshot pulls using `scripts/lib/sync-from-api.ts` retain fixed-backoff retries for 5xx and caller-declared transient statuses. Before retrying they cancel the failed response body. One 30-second `AbortSignal.timeout` deadline (caller-overridable with `timeoutMs`, composed with caller cancellation) covers attempts, waits, and returned-body reads; aborts are not retried.

`scripts/maintenance/audit-seo-render-budget.mjs` measures public-page resource budgets and defaults to the live site. It blocks Google Analytics collection requests before navigation so synthetic audit visits do not enter analytics, but retains GTM/gtag script downloads to measure their JavaScript cost. Each JSON row reports `blockedAnalyticsRequests`; the table labels that count `gaBlocked`. This suppression is specific to the audit and does not change intentional GA acceptance in `smoke-ui.mjs`.
Browser loading/options reuse `scripts/lib/smoke-runtime.mjs`; only `SEO_AUDIT_BROWSER_EXECUTABLE_PATH` and `SEO_AUDIT_BROWSER_CHANNEL` are mapped in, with executable path taking precedence. The audit stays headless and does not inherit GitHub Actions' Chrome default or system-Chrome retry.

## Safety Score Map Refresh

`npm run build:safety-score-map` fetches one canonical set of report cards, stablecoin supply, and Stability Index data, then renders it. The map does not compare scores, grades, tier populations, leaders, or supply movements with an earlier run; those audits belong to the Safety Score publication pipeline. It retains only input-contract and renderability checks, so a schema-valid held or aged Safety Score publication still produces a poster while malformed data, unusable supply joins, stale PSI context, invalid geometry, missing fonts, or a wrong-size raster fail closed.

Schema rejections use canonical diagnostics (the first failing field path and schema issue), rather than translating errors into historical map-specific wording. Valid payloads still pass the map's score/grade, duplicate-ID, supply-join, and geometry checks.

The renderer in `scripts/maintenance/build-safety-score-map.ts` keeps every graded coin and fixed readable marker floors. It first tries one guide per outer grade band, then deterministically splits dense bands into adaptive rings (candidate maximum populations 120, 90, then 60), shrinking large bubbles only down to the existing floors. Geometry, annotation clearance, and composition checks still apply. Exhausting those layouts throws `SafetyMapCapacityError` with code `layout-capacity-exhausted`; capacity is not repaired by dropping coins, lowering legibility floors, or moving bubbles outside the canvas.

The headline, supply key and provenance use three mandatory fixed panels, validated together against the complete circle/orbit/rectangle/reserved-region scene before rendering and against Firefox glyph bounds before capture. There is no candidate search or optional panel dropping; successful manifests retain `chipsDrawn: 3` and `chipsDropped: 0`.

`.github/workflows/safety-map-refresh.yml` runs daily at 07:20 UTC and on `workflow_dispatch` (`mode`: `force` renders; `ensure` skips if today's map is live). Schedules start hours late, so the Worker's [producer kick](./safety-score-map.md#pre-digest-producer-kick) dispatches `ensure` from 06:20 to 08:00 UTC; the digest can reuse a recent map.

## Daily Social Posters

`npm run publish:daily-social -- capture --out-dir agents/daily-social/local` captures the day's topic from fresh Pharos API data. `npm run build:daily-social -- --input agents/daily-social/local/snapshot.json --out agents/daily-social/local/poster.png` produces a 1600×1000 PNG with self-contained SVG/HTML and `.alt.txt` siblings. The renderer embeds local fonts and logos and performs no network requests. `capture --topic <topic>` previews another weekday's format without changing the publication calendar.

The [daily social pipeline](./daily-social.md) owns the seven-topic calendar, source eligibility, fallback policy, prepublication validation and immutable image/manifest protocol. Publication is manual: there is no workflow, and operators run `capture` and `build:daily-social` locally, then post the rendered graphic to X by hand. `publish --dry-run` reads and validates the KV target without writes.

## Operator CLI Contract

State-changing/release-control entrypoints use `scripts/lib/cli-args.mjs`, a strict Node `util.parseArgs` wrapper. Before network/filesystem effects they reject unknown options, missing values, duplicate options, unexpected positionals and declared conflicts. Migrated commands support `-h` / `--help`; exits: usage `2`, runtime failure `1`, help `0`.

The OpenAPI generator uses the typed `runDirectCli` entrypoint wrapper from `scripts/lib/cli-args.mjs` (declared in `scripts/lib/cli-args.d.mts`). Importing its schema builders does not generate artifacts; direct-run failures use the wrapper's stderr message and runtime-failure exit code.

Coverage-audit commands supply their domain Markdown renderer to `coverage-audit-cli.ts`; shared Markdown cells and tables live in `scripts/lib/markdown-report.ts`. The CLI helper owns argument dispatch and Markdown/JSON output selection, not a second document-rendering API.

[`command-runner.mts`](../scripts/lib/command-runner.mts) reports cancelled nonempty command selections as `status: 130, aborted: true`, even when cancellation prevents any child from starting or leaves queued units after a successful child. A non-aborted command failure takes precedence; result arrays contain only executed units, never placeholder passes. Empty selections remain neutral, and active children settle before the coordinator returns.
`createD1Client` owns D1 queries/batches; envelope admission, static guards and packaged-runtime checks are in the [tool appendix](#tool-implementation-appendix).


Every committed source file that reads `process.argv` is enrolled by exact path in `scripts/lib/cli-argv-policy.mjs`. Operator and production-mutating entrypoints must reach a parser that imports and calls the shared strict wrapper; read-only, build/local-artifact, and test/dev entrypoints require an explicit categorized exemption and audit reason. `npm run check:cli-args-policy` rejects unclassified additions, stale or duplicate declarations, strict/exempt overlaps, and strict-parser claims that are not reachable from the entrypoint. Entry ordering is not a safety requirement. Add or remove entries in the source-owned policy with the corresponding script change; there is no count baseline to update.

For these scripts, `--dry-run` means no mutation: a command may read local state or fetch remote data to validate the planned operation, but it does not write files or call a mutating API. `register-telegram.ts --check` remains a compatibility alias for its no-network dry run. `sync-digests.ts --check` remains the narrower no-network wiring check; it conflicts with `--dry-run` so the selected behavior is unambiguous. Existing no-flag workflow invocations retain their prior live behavior.

Archive sync commands admit incoming API payloads and their final stored projections through the shared schemas before archive checks or writes. Supported legacy optional fields retain their existing defaults/absence, and digest `pre-policy` provenance stays unstored. Malformed JSON, schema/chronology failures and invalid pagination are `SnapshotIntegrityError` failures, not fetch outages: `--allow-existing-on-fetch-failure` cannot suppress them or update capture metadata.

New scripts parse arguments with `scripts/lib/cli-args.mjs`, or with `node:util.parseArgs` directly when the strict wrapper is not required. Do not hand-roll a `process.argv` loop. Worker operator evidence tools (`night-watch-worker.mjs`, `watch-worker-cron.mjs` and `capture-d1-insights.mjs`) use the shared strict parser and are enrolled as strict entrypoints; read-only/local-output classification is not a reason to retain a second option parser. Unrelated build/test-only parsers retain their explicitly categorized policy exemptions.

The sealed-event input-corruption operator (`worker/scripts/record-depeg-input-corruption.ts`) is enrolled as a strict mutating entrypoint. Duplicate singleton options are usage errors before evidence reads or D1 access; `-h` / `--help` requires no evidence file. Its offline preview and explicit `--apply --remote` authorization remain unchanged.

The pricing-provider and price-source-depth audits, live SEO render-budget audit, Mint Authority review audit and DDRR calibration command also use the strict helper, retaining their source/output defaults and declared domain validators. Distinct format switches retain their previous last-specified selection; repeated singleton options are usage errors. Generic local artifact generators and the `audit:coverage` domain/argv dispatcher retain their existing parser/exemption contracts.

`measure:v9-resource`, `calibrate:v9-resource` and `test:v9-resource` are Worker-bound offline tools; [Testing: V9 resource lane](./testing.md#v9-resource-lane) is their sole guard, proposal-only calibration, qualification and failure-evidence contract. Read the supported entrypoint help for options; these tools neither deploy nor mutate remote state.

`npm run ops:worker-memory -- [--from <timezone-qualified ISO> --to <timezone-qualified ISO>] [--out-dir <path>]` is a strict, read-only Cloudflare GraphQL collector for `stablecoin-heavy` and `stablecoin-api`; it mutates only local evidence files. Export `CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN` (Account Analytics: Read) and **`CLOUDFLARE_ACCOUNT_ID` explicitly**, even if the ignored `.env.local` lacks the account ID. There is no account/token flag or OAuth discovery. Bounds are paired, increasing, non-future and ≤48 hours; default is the previous complete UTC day plus today, ending 900 seconds behind now. Help exits `0`, invalid usage `2`; heavy kills or unavailable/stale required evidence exit `1` **after retaining evidence**. Public kills and incomplete public broad samples are report-only initially.

Schema-v1 outputs are `report.json`, `report.md`, `samples.ndjson`, `exceeded-memory.ndjson` and `queries.json`, defaulting to `agents/worker-memory/<UTC-run>/`; the daily main-only Worker Memory Monitor retains them 30 days and reports distinct heavy-kill/collection incidents. Memory is sampled shared-isolate evidence, not a live heap/headroom measurement. [Per-job resource evidence](./worker-and-api-limits.md#per-job-resource-evidence) owns sampling/freshness policy and [OOM triage](./runbooks/cron-slot-abandonment.md#first-checks) owns attribution and limitations. Tests retain sanitized Oct 14/15 Adaptive kills and the Oct 14 Scheduled row from the dated ProdEvidence capture; its missing per-second sample interval/P999 remain unknown, never reconstructed from daily sampling.

`worker/scripts/one-shot-backfill.ts` runs historical rebuilds against Wrangler-authenticated D1 outside the Worker bundle. It defaults to remote `stablecoin-db`, accepts original job parameters through `--query`/`--body-json`, requires `--execute` unless a supported explicit preview is selected, and preserves job response bytes. Ordinary writes use commands; atomic jobs additionally require `--allow-atomic-import` to acknowledge live D1 availability impact. [One-shot backfills](./runbooks/one-shot-backfills.md#transport-safety) owns classification, transport gates and interrupted-run receipt reconciliation/cleanup.

The mint/burn backfill uses `mintBurnConfigKey` directly for config selection, sync-state access, diagnostics and response keys; its key format is shared with the live pipeline.

| Verification CLI | Selection contract |
| --- | --- |
| `lint:changed` | Repeatable `--file <path>`, `--staged`, or `--base <ref> [--head <ref>]` are exclusive selection modes. Explicit file/staged modes override PR range environment. Without flags or PR range environment, selects staged, unstaged and untracked working-tree files. Deleted paths are skipped; staged selection still reads working-tree contents. Forward ESLint options after `--`. |
| `check:focused` | Repeatable `--file`, `--staged`, or a `--base`/`--head` range (`--base-ref`/`--head-ref` aliases) selects the file set forwarded to lint. It synthesizes shared PR baseline checks plus exceptional authored ownership checks. `--plan-only` executes none; unmapped paths fail with `routing-incomplete`, mapped empty plans are not verification and zero related tests fails. |
| `check:pr:static` | Retains the explicit base/head range for child lint; rejects `--staged` rather than silently discarding it. Use `check:focused -- --staged` for index-selected checks. |
| `check:generated-artifacts` | Automatic drift selection excludes `checkable: false` and `ciDriftCheck: false`. Explicit `--only` may check the latter, but any uncheckable ID rejects the entire request before execution. Empty automatic plans skip, not certify freshness. |

### Safety Score movement ledger

[`safety-score-movement-ledger.ts`](../worker/scripts/safety-score-movement-ledger.ts) reads the [publication journal](./report-cards.md#publication-journal-and-movement-attribution) with remote D1 `SELECT`s only, never production writes or file imports. Run its `--help` from the root for UTC half-open window, output and database options. Review weekly while the 120-day window and pre-window baselines remain retained; malformed query envelopes fail, never become empty evidence.
Movement classification and capture-gap limitations are in the [Safety evidence CLI appendix](#safety-evidence-cli-details); retained observations never replace frozen-input replay or certify a complete archive.
Markdown table cells escape backslashes before pipes and flatten newlines; the companion JSON retains the original values.


### Safety Score historical capture archive

[`export-safety-score-capture-archive.ts`](../worker/scripts/export-safety-score-capture-archive.ts) owns `list`, `boundary` and `export` syntax; use its `--help` from the root. All modes read D1 only; export reads signed R2 or supplied local object bytes and writes local artifacts. [Accepted capture archive](./report-cards.md#accepted-capture-archive-and-historical-replay) owns retention and artifact semantics; the [equivalence harness](./process/safety-score-equivalence-harness.md#historical-release-and-data-separation) owns restoration/replay.
Use exact deployment instants for intraday boundaries; [capture details](#safety-evidence-cli-details) own validation, provenance and best-effort gap coverage.



### DEX liquidity acceptance capture

`worker/scripts/dex-liquidity-acceptance-capture.ts` archives short-lived DEX operational evidence for offline acceptance reporting. **Capture daily, report weekly**: `cron_runs` is pruned after seven days, so a weekly-only pull has no safety margin. This is an operator cadence, not a deployed scheduler.

Use [`dex-liquidity-acceptance-capture.ts`](../worker/scripts/dex-liquidity-acceptance-capture.ts) `--help` for `capture`/`report` options and output defaults. Capture reads remote D1 only; overlapping trailing windows protect against source pruning. Report reads saved captures offline, rejects mixed databases, deduplicates run identities and requires seven complete UTC days.

Capture files are exclusive-create evidence packets with raw query envelopes, timing, limits/truncation and failures. Required-query failure/truncation retains partial evidence and exits unsuccessfully; missing remote clock is fatal. Sequential current/registry reads are **not** an as-of transaction.

The report separates the **unchanged legacy handover targets** from **prospective evidence**. Legacy daily flips require both day endpoints strictly above $1M and strict `>1.5x` / `<0.5x` steps, bucketed by **day0**; the day1 endpoint is needed beyond the half-open report window. Prospective material moves use inclusive `>=1.25x` / `<=0.80x` **or** an absolute delta `>=$1M`, with separate eligible pair coin-day denominators, below-$1M/hourly return diagnostics, zero/new/missing-observation transitions, method/build cohorts, route funnel/selection/continuity, and active-catalog/observed/rated/score-bearing-route coverage. Retained generation rows are preferred; top-five fallback is explicitly a censored lower bound, never a complete hourly census.

Only the first productive run after a version change **of the same job** is excluded from clean distributions; absent version anchors are unavailable, not assumed unchanged. Median is the ordinary sample median and p95 is nearest-rank. Missing telemetry, baselines, query windows, generation inventories or prior-week captures remain null/`UNMEASURABLE`, never a passing zero. `d1Cost.coverage: "partial"` retains its measured sums/reasons in raw evidence but **never passes the complete-cost gate**. Cost comparison uses actual complete hourly stage + publication D1-read totals (failed/neutral invocations included), not provider `rowsRead`, registry inventory reads or the operator query's own D1 metadata. The legacy authoritative-confirmation baseline remains unmeasurable; captured registry PASS does not certify unseen between-capture maxima.

Preserve ignored `agents/dex-acceptance/` archives externally as required before source rows expire; pruned history cannot be reconstructed. Nonzero flip attribution requires operator root-cause review, not source/protocol names or coincident builds. This reports DEX/Liquidity acceptance evidence, not unchanged-policy Safety score/grade/NR stability. See [DEX liquidity](./dex-liquidity.md) for the producer and methodology contracts.

## Safety Score Capture-Time Replay

`npm run report-cards:capture-fixed-input -- --exact-cache-export <path> --output <path>`
exports a registry-bound wrapper with normalized `fixedInput` and a verified `registrySnapshot`.

`--require-current` (only with `--exact-cache-export --normalized-only`, used by the scheduled curation sweep) rejects an input whose `clockSec` is older than one `prepare-safety-score-v9-input` cycle or in the future with `capture-stale` / `capture-future` before writing; default and historical modes are unchanged.

`npm run safety-score-v9:replay -- --input <path> --output <path> --published-at <seconds> --registry-ref <git-sha>`
replays against the capture-time registry.

`npm run safety-score-v9:movers` resolves to `worker/scripts/diff-safety-score-v9-movers.ts`. Like replay and diff, this is Worker-bound tooling because full-artifact admission uses the native/legacy capture contracts. Keep its implementation under `worker/scripts/`, outside the root TypeScript program; the npm alias and flags remain unchanged.

Use `jq '(.fixedInput // .).clockSec'` to read either export shape. The [equivalence harness](./process/safety-score-equivalence-harness.md#capture-time-registry-replay) owns snapshot admission, trusted-Git execution, production-digest limitations, and the `--registry-ref`, `--normalized-only`, and `--allow-registry-mismatch` mode contracts.

## HTTP Route Telemetry

`npm run ops:http-telemetry -- [--from <timezone-qualified ISO> --to <timezone-qualified ISO>]`
prints a schema-v1 JSON report to stdout. It reads Cloudflare zone `httpRequestsAdaptiveGroups`
at the fixed `https://api.cloudflare.com/client/v4/graphql` endpoint, rejecting redirects;
it never writes local files, D1, Worker request-path telemetry, or remote state.
Export **`CLOUDFLARE_ZONE_ANALYTICS_READ`** with **Zone → Analytics → Read** permission for
the `pharos.watch` zone. The collector resolves that zone with a read-only, exact-hostname
`GET https://api.cloudflare.com/client/v4/zones?name=pharos.watch&per_page=2` lookup;
empty, ambiguous, or failed lookups remain unavailable. **`CLOUDFLARE_ZONE_ID`** optionally
supplies the zone ID explicitly and bypasses discovery. Both endpoints reject redirects.
The Account Analytics token used by `ops:worker-memory` does not authorize this zone read.
Credentials are not printed.
Use shell redirection into ignored `agents/` if a local evidence artifact is needed.

The default half-open window is 15 minutes ending five minutes behind now. Explicit bounds
must be paired, increasing, timezone-qualified, at most 24 hours, and end at least five
minutes behind now. These bounds allow ingestion lag but do not prove ingestion completeness.
Help exits `0`, invalid usage `2`, fully available evidence `0`, and partial/missing/failed/capped
evidence `1` after printing its machine-readable reason. GraphQL failures retain up to four
512-character messages per failed query in `reasonDetails`, redacting the token and discovered
request paths; HTTP response bodies and headers are never retained. Failed or empty reads never
become zero traffic or zero error rates; only routes observed in discovery are emitted.

The report combines `api.pharos.watch`, `site-api.pharos.watch`, and `ops-api.pharos.watch`
eyeball HTTP traffic. This is an edge HTTP population, including authentication, security,
and platform responses, **not exclusively `stablecoin-api` invocations**. Path discovery
is capped at 1,000 distinct paths (requesting one sentinel row); exceeding the cap fails
closed without publishing partial rates. Static paths come from
`shared/lib/api-endpoints/definitions.ts`, dynamic families from its canonical descriptors.
Unknown paths share one `unmatched` bucket. Raw paths, stablecoin/API-key identifiers,
and query strings are not emitted. Cardinality is bounded by the endpoint registry plus
one unmatched bucket, with at most eight routes per sequential query. HTTP-status and latency
selections are separate queries so a denied latency field cannot discard valid status counts.

Each normalized route reports HTTP status counts, the estimated 5xx response count/rate,
and, **when the zone is entitled to the field**, p95 edge time to first byte in milliseconds. Counts/rates are explicitly adaptive
estimates; the report retains sampling-interval ranges and unknown-interval counts.
The rate denominator is the sum of returned status-group estimates, not an independently
sampled pooled count. A known zero 5xx count is different from missing traffic.
The collector asks Cloudflare to compute one pooled p95 over all discovered paths in
each normalized route; it never averages path/status percentiles. Discovery and metric
queries are separate reads, not an atomic snapshot, so later ingestion may change coverage.
**Full-response/client latency is unavailable from this collector**: TTFB is neither
response completion nor Worker wall time. The production zone currently rejects
`edgeTimeToFirstByteMsP95` with "does not have access to the field"; schema introspection
alone does not establish entitlement. The collector retains counts/rates with `status: partial`,
`reason: ttfb-field-not-entitled`, and null latency, preserving the actual error in `reasonDetails`.
After one failed latency query it skips further latency queries in that run, while continuing
status collection. Obtaining p95 requires that zone-field entitlement or a separately authorized
Workers Observability source; a broader Analytics token alone is not proven to grant the field.
Missing HTTP status evidence also remains partial, never a successful availability claim.
No workflow is scheduled; this is an operator-invoked read-only collector.

## D1 Insights Capture

Use `npm run ops:d1-insights -- --dry-run` to preview the default read-only Wrangler calls. Without `--dry-run`, the helper captures `7d` reads, `30d` reads, and `30d` time for `stablecoin-db`, then writes `agents/d1-insights-<timestamp>.json`.

Supported selection options and the report schema are owned by [`capture-d1-insights.mjs`](../scripts/maintenance/capture-d1-insights.mjs); use its help instead of copying output JSON into this page.

Compare captures before and after an infrastructure change by `period`, `sortBy`, `_pharos.sqlFingerprint`, and `_pharos.sourcePaths`. Keep generated reports under `agents/` unless a durable methodology or source change requires documentation.

## Routing Index

Root [`package.json`](../package.json) owns command names and composition. Use `--help` only where supported; legacy validators such as `check:migrations` reject it, so inspect their entrypoint for flags. `scripts/lib/cli-argv-policy.mjs` owns argument-safety classification, not universal help support.

### Validation Command Index

[`package.json`](../package.json) owns live commands/composition; use supported entrypoint help or inspect source for flags. The authoring hierarchy is [focused selection → owning Vitest → optional broader PR feedback → exact generated-artifact diagnosis](./testing.md#smallest-adequate-check-per-area). Hosted CI is readiness authority, not any interchangeable local static/structural runner. [Testing: Commands](./testing.md#commands) owns lane behavior; the CLI table above owns selection modes.

### Build And Generated Artifacts

Generated clocks intentionally differ: coin sitemap `lastmod` follows the newest owned source commit, floored by the explicit profile content-revision constant in `scripts/lib/sitemap-detail-dates.ts` (bump it only for a material profile-content change) rather than shared-template commits; chain pages use their route edit date, not the daily data snapshot; docs modification uses committer time and creation uses author time. [`sitemap-source-paths.mts`](../scripts/lib/sitemap-source-paths.mts) and the [public-doc manifest](../shared/lib/public-doc-manifest.json) own input families. Cemetery projection semantics come from the client-projection generator, not a copied inventory here.

[`automation-registry.mjs`](../scripts/lib/automation-registry.mjs) owns artifact inputs/outputs, dependencies, lifecycle, bootstrap and drift eligibility. `compile-input` and `post-refresh` run in standalone prebuild; production splits them so live detail acquisition occurs once after the Worker gate. `maintenance-only` is explicit. Offline bootstrap materializes ignored compile/serve inputs and valid empty detail envelopes without network/credentials. Setup transports these outputs and rejects modified tracked/checkable or unexpectedly untracked nonignored outputs; regenerate and commit tracked repairs with their sources. The registry has no automatic-staging contract or Git hook.

Automatic selection matches source/output changes and propagates dependencies, then filters `checkable` and `ciDriftCheck`. Explicit `--only` can still check a `ciDriftCheck: false` projection. Registry `requiredBrowsers` owns browser setup.

The compact catalog generator loads shared TypeScript classifiers through `tsx`: write with `node --import tsx scripts/build-data/build-client-registry.mjs` and check with `node --import tsx scripts/build-data/build-client-registry.mjs --check`. Both modes cover every output of the `stablecoin-client-registry` artifact, including per-coin details, not just the browser list; its registered output paths are the authoritative inventory. Projection, catalog and freshness-stamp writes go through [`atomic-artifact-write.mts`](../scripts/lib/atomic-artifact-write.mts) (exclusive sibling temporary, then rename), so a reader sees complete old or new files, never a truncated one; this guarantees complete individual files, not a transactional multi-file generation.

The editorial policy generator uses the runtime-neutral facade's readonly `EditorialPolicy` contract; raw JSON still passes its existing validation before hashing/rendering. See [Machine-readable policy](./editorial-style.md#machine-readable-policy).

| Artifact family | Read its owner |
| --- | --- |
| Scene atlas/OG composition | [Scene Kit](./data-visualization.md#scene-kit); import generic helpers/types directly from `scripts/lib/scene-atlas.ts` and `scripts/lib/scene-og.ts`, not cemetery entrypoints |
| V9 evaluation-build identity | `scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts`; exact runtime import/input graph, including dynamic imports, not capture-only observers. Reserve writes use cron-free `worker/src/lib/scheduled-checkpoint-primitives.ts`. |
| Incident runtime projection/evidence digest | `shared/lib/safety-score-v9/reviewed-registry.ts`, `review-evidence.ts` and `shared/types/safety-score-v9-research-evidence.ts`; shared admission, not a Worker-import waiver |
| OpenAPI/Postman/reference narrative | `scripts/lib/public-api-artifact-catalog.ts`; full external narrative and generated first-sentence reference preview. Author portable absolute `https://pharos.watch/...` links. Schema generation rejects empty nested array-item contracts. |
| Compact stablecoin/chain logos | `npm run logos:compact` (`scripts/maintenance/generate-compact-logos.ts`); 32px and 100px stablecoin WebPs plus 56px and 100px chain WebPs, with one size-indexed `logo-variants.generated.json` map. Originals and vector logos remain available. `resolveCompactLogoSrc` selects by rendered size (small, 50px header, or 28px chain slot); SVG graph images use the same resolver. The `compact-logos` artifact checks both output trees, source pixels, collisions, orphan files and the map byte-for-byte. Chain WebPs share the PNG/SVG one-week cache policy. |

Build and release ordering is documented in [Deployment Process](./deployment-process.md#ci-deploy-sequence); failure diagnosis is documented in the [generated-artifact failure playbook](./testing.md#generated-artifact-failure-playbook); OG asset maintenance is documented in [OG Images](./og-images.md); font generation and licensing are documented in [Font Assets](./process/font-assets.md).

Public dataset generation writes one coupled bundle: dated files in `public/datasets/`, the generated latest/Sheets alias block in `public/_redirects`, and frontend imports in `src/lib/datasets/public-dataset-current.ts`. The release refresh wrapper snapshots all three before invoking `generate:public-datasets` and restores their pre-refresh state on failure, including retention-pruned files and unrelated authored redirect rules. A failed restore remains release-blocking; successful sibling snapshot producers are not rolled back. Direct generator invocations do not provide this release-wrapper rollback boundary.

The cemetery CSV keeps its own column order, contract-list serialization, whitespace normalization and trailing newline, then delegates scalar escaping to `shared/lib/csv.ts`. Normalized string cells beginning with `=`, `+`, `-` or `@` intentionally gain a leading apostrophe for spreadsheet formula safety; ordinary cells retain their prior bytes. Its JSON projection and provenance envelope are unchanged.

`PHAROS_DETAIL_SNAPSHOT_SOURCE` defaults to `per-coin` (the Pages release sets `bulk`); `verify:detail-snapshot-sources` reports byte/field diffs and pass timings; `--keep-dir` retains evidence: [bulk source](./stablecoin-detail-page.md#build-snapshot-hydration).

`postbuild` generates Markdown exports, then runs `inline-homepage-critical-css.ts` for every exported public HTML page except `out/admin/**`. Beasties temporarily matches a dark HTML root, then restores its original attributes, retaining page-used dark variants, theme tokens and leading `:where()`/`:is()` spacing/divider rules in source order. A bounded shared Header/Sheet allowlist keeps the client-mounted drawer positioned, scrollable and animated before full CSS arrives. The CSP-safe async `critical-css-loader.js` follows the stylesheet links and activates each full sheet on load (or immediately when cached), with a DOMContentLoaded fallback; its URL version bypasses the previous loader's cache. Already-inlined pages are skipped; `PHAROS_CRITICAL_CSS_WORKERS` overrides pool concurrency: [Pages release](./deployment-process.md#ci-deploy-sequence).

### PR And Release Gates

Use [Pre-push readiness](./testing.md#pre-push-readiness) for local feedback and optional receipt diagnostics, and [release policy](./deployment-process.md#release-snapshot-state-machine) for deployment gates. Hosted CI is the readiness authority. [Boundary waivers](./process/boundary-waivers.md) retain their reviewed scope. Focused, filtered and plan-only checks are authoring feedback; unmapped production paths are routing failures.

[Testing: CI Pipeline](./testing.md#ci-pipeline) owns adaptive selection, deterministic round-robin plans and hosted consumption; `npm test` is the canonical full suite. [Testing: V9 resource lane](./testing.md#v9-resource-lane) owns resource guard/calibration evidence. [Boundary waivers](./process/boundary-waivers.md) and the [focused hierarchy](./testing.md#smallest-adequate-check-per-area) own import exceptions and authoring checks.

[`check-unused-code.ts`](../scripts/ci/check-unused-code.ts) owns export-consumption analysis. Property/literal member uses are narrow; escaping/computed namespaces and dynamic imports stay conservative and report uncertainty. Review newly exposed exports individually. Scanner fixtures use external temp roots, never this checkout. Keep useful test-only corpora in `*.test-support.ts`, not production DEBT or external-consumer exemptions; empty debt is not deletion proof. [Testing's commit-scoped deletion policy](./testing.md#ci-pipeline) applies.

[`check-redemption-backstops.ts`](../scripts/ci/check-redemption-backstops.ts) has one asynchronous CLI path: arguments are parsed before importing the registry and shared validator, which receives the authored source files and owning docs as evidence. `--json` writes the report to stdout; `--report <path>` writes the same JSON to a local file, including failed validation reports. Findings retain exit status `1` for errors and `0` otherwise; domain fixtures call `validateRedemptionBackstopRegistry` directly rather than a synthetic CLI runner.

`check:script-entrypoints` covers `.mts` and excludes declarations; textual reverse references are not an executable graph, and Markdown cannot retain a disconnected tool. `check:editorial-content` is a structural guard; [blog/changelog publishing](./process/blog-publishing.md#changelog) and [ADR-3](./architecture.md#adr-3) own editorial/methodology policy. Structured-log refactors preserve console versus durable-event distinctions and terminal failure accounting.

### Web Vitals Analysis

`npm run analyze:web-vitals -- --days 7 --out agents/web-vitals.json` reads the GA4 Data API and prints/appends a Markdown table of per-route-family p75 LCP, INP, CLS, TTFB and `fresh_data_ready` (home hero/detail summary separately). `--days` defaults to seven complete days ending yesterday in the GA property timezone; `--out` writes only aggregate JSON. Like `analyze:gsc-*`, it is an evidence/reporting tool, not a deployment mutation. `--help` is credential-free; unknown/duplicate options fail strict parsing.

Required environment names:

- `GA4_PROPERTY_ID`: numeric property ID, **not** the public `G-` measurement ID.
- `GOOGLE_APPLICATION_CREDENTIALS`: path to a service-account JSON file containing `client_email`/`private_key`; grant the service account Viewer access on that property and enable the Google Analytics Data API. The script obtains an OAuth token with `analytics.readonly` scope.
- Alternatively, `GA4_ACCESS_TOKEN` supplies an already-issued OAuth token with that scope and property access. It takes precedence over the file. No token or credential content is printed.
- Optional `GITHUB_STEP_SUMMARY` receives the same aggregate report. Local execution loads ignored `.env.local` if present without replacing existing environment values.

Before collection, register event-scoped GA4 custom dimensions for `page_path`, `name`, `value`, `id`, `surface` and `navigation_type`. `value` must be available as a **dimension**, not only an averaged custom metric: a percentile cannot be recovered from an average. The analyzer queries `customEvent:*` dimensions plus `eventName`/`eventCount`, paginates every row, deduplicates metric IDs using the maximum cumulative update, then computes nearest-rank p75. GA's high-cardinality/`(other)` loss, sampling and privacy thresholding fail clearly rather than publishing a falsely complete percentile. For high-volume windows use a shorter window or raw BigQuery event export; the tool does not claim GA Data API eliminates cardinality limits. Historical events before custom-dimension registration are not recoverable through this report.

`nightly-validation.yml` runs the analyzer on Monday (or manual dispatch) when repository variable `GA4_PROPERTY_ID` is configured. Supply secret `GA4_SERVICE_ACCOUNT_JSON` for the workflow's temporary credential file, or `GA4_ACCESS_TOKEN` for short-lived manual use; temporary credentials are removed even on failure. Until the property variable exists, the job is explicitly skipped, not a passing RUM result. Missing credentials, inaccessible properties, unregistered dimensions and empty observations fail clearly. RUM budgets remain advisory; collect a stable weekly baseline before adding regression enforcement. See [Performance guardrails](./testing.md#performance-guardrails) for lab/production canaries and ratcheting.

Manual production capture: `node scripts/maintenance/probe-page-performance.mjs --url https://pharos.watch --out agents/page-performance.json`; add `--dwell-seconds 1800` for polling/heap evidence or `--advisory` to report exceeded budgets without a failing exit. It requires installed Playwright Chromium and makes read-only browser requests; captured resource URLs remain in the local diagnostic JSON.

### Smoke And Operations

Use the `test:smoke-*`, `validate:*-smoke`, `serve:static-export`, and `ops:*` commands in `package.json`. Choose the incident-specific procedure through the [documentation index](./README.md) before taking remedial action. Local smoke harnesses and operator watches are evidence tools; production deployment acceptance is owned by the release workflows and [Deployment Process](./deployment-process.md#operational-acceptance). `night-watch-worker --dry-run` prints its preview to stdout (`--json` selects JSON), preserves report, evidence, and checkpoint files, and performs no remote collection, including with `--fixture`. Ordinary fixture rendering remains a file-writing mode.

Pages smoke preserves unrelated `STATIC_EXPORT_*` overrides, but its selected host/port and nonblank API-key/site-secret fallbacks win over blank environment values.

API smoke validates the complete redemption response with `RedemptionBackstopsResponseSchema`, including score/resolution coherence. A small wire adapter retains map-key identity, explicit status/eligibility fields and nonempty provider, methodology and source labels; it does not mirror the schema vocabulary.

`ops:cron-delivery` reads Cloudflare scheduled-invocation analytics and D1 slot start lag (`--source all|analytics|d1`); see [cron delivery stall](./runbooks/cron-delivery-stall.md).

### Worker Incident Evidence And Status Profile

`ops:watch-worker-cron` and `ops:night-watch-worker` preserve literal `ok`, `degraded`, `error`, `skipped_neutral` and `skipped_locked` counts; `synthetic` counts only the orthogonal `stale-slot-reconciled` subset. Unknown stored statuses retain their own bucket. Productive and publication counts use explicit columns, with unknown counts separate; terminal success is never substituted for publication. Synthetic children group by invocation and slot as “1 started + N not-started”, with execution-unknown children separate; grouping never changes their stored error status. Generation-ledger states are a separate table/count, not extra publications inferred from a terminal.

`npm run ops:worker-evidence-report -- --fixture agents/worker-cron-snapshot.json` renders the same literal-status/output table from a saved watcher JSON snapshot; add `--json` for the computed summary. All three standalone tools use strict CLI parsing. The profiler and its test live in `worker/scripts/` because they execute Worker source; generic maintenance reporting and the root test-typing project (`tsconfig.test-typecheck.json`, which excludes `worker/`) never import `worker/src/`. The profiler's typed surface is `worker-status-profile.d.mts`.

Read-only status D1 profiling (run from the root):

```sh
npm run ops:worker-status-profile
```

Export `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID` and `CLOUDFLARE_API_TOKEN` with D1 read permission. This executes the **actual source `/api/status` handler** with explicit trusted operator authorization over a SELECT-only D1 REST transport and the Worker's `d1-cost` seam. It reports statement count, nullable rows read/server SQL duration, local end-to-end duration, HTTP/section completeness and latest persisted `status-self-check` `d1Cost` with its observation clock. It does not execute the mutating self-check. The adapter retains metadata for `first()` reads, while the seam preserves its own partial-coverage reasons. This is not a production HTTP/colo latency measurement: source revision, local REST RTT and omitted optional provider credentials are explicit limitations. Exit `1` means incomplete route cost evidence, not zero cost. No status payload, SQL, credentials or provider error bodies are emitted.

```sh
npm run ops:worker-incidents -- \
  --out-dir agents/worker-incidents --archive-dir agents/previous-worker-incidents
```

The bundle captures the previous complete UTC day and rolls forward at most **21 days**, reading only bounded D1 `SELECT`s, Cloudflare deployment inventories and scheduled invocation Analytics. Use `CLOUDFLARE_API_TOKEN` (D1/Workers read), `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN` (Analytics read). Credentials go only to Cloudflare; allowlisted artifact fields exclude arbitrary cron metadata/error text, query text and tokens. `bundle.json` and `report.md` include source coverage/reasons, missing days, literal statuses, productivity, publication ledgers and deployment → delivered invocation → child → publication correlations. Joins require a singleton physical cron/slot, one invocation and one exact deployment-version match; unresolved chains remain unattributed. Timestamp-correlated publications explicitly do not establish causality. Deployment history is only a bounded recent inventory, not proof of exact activation time or complete 21-day history.

Every candidate child must carry a nonblank invocation identity and Worker version, all agreeing with the singleton invocation and matched deployment. A missing or conflicting child identity leaves the whole delivery `unattributed` with `missing-or-ambiguous-identity`; its raw row and literal terminal count remain archived. Publication matches retain `timestamp-only-not-causal-proof`.

There was no existing daily production-evidence artifact lane, so the **Worker Memory Monitor** pattern owns a daily `01:17 UTC` incident job (also manual), alongside the daily memory collection job. It restores the most recent main-branch incident artifact, drops days outside the rolling window and uploads `worker-incidents-<run>-<attempt>` with **21-day artifact retention** before reporting collection failures. Initial/missing days, row limits (50,000 per D1 source/day), unavailable reads and limited deployment history remain partial; archive bootstrap never fabricates the missing hot-D1 history. No migrations or hot retention changes are made. The [48-job freshness/tolerance matrix](./process/lane-freshness-matrix.md) is draft for owner sign-off, not executable policy.


### Curation Audits

Use `package.json`'s `audit:*`, `candidates:*`, and `calibrate:*` commands; reports are advisory unless owner docs or CI enforce them. [Stablecoin Data](./stablecoin-data.md) owns curation; feature docs own interpretation. Keep research/queues in `agents/`, durable changes in owner docs. Refresh contracts: [protocol APIs](./process/protocol-api-mechanism-refresh.md) and [CDP shocks](./process/shock-coverage-refresh.md).

`analyze:gsc-coverage` keeps an issue's `pages` unknown when any contributing count is missing or malformed; `knownPagesSubtotal` is explicitly partial, not an exact affected-page total. Explicit zero remains observed. Parsed issue rows retain their raw fields and source labels, and usable URL drilldowns remain available independently of count completeness.

For `analyze:gsc-performance`, keep each coherent export in its own directory (or ZIP member directory); standalone CSVs in the same directory belong to that capture. Page-only totals own site/page/family metrics for pages they cover; page/query detail retains query opportunities, query keys and source metadata without adding those page metrics again. Combined-only pages still contribute metrics, and query-only totals retain query authority. Multiple capture directories/archives and duplicate page totals fail as ambiguous instead of being summed. Date labels alone do not prove disjoint windows: analyze each capture separately, including known disjoint periods, rather than mixing periods or discarding their combined-only evidence. Expected CTR comes from the site position curve `min(0.6, 0.132 × position^-1.64)`, fitted to Pharos's own Search Console data; `--target-ctr` replaces it with a flat target. Each aggregate reports `expectedCtr`, `actual/expected` and a signed `clickGap` (expected minus actual clicks); rows without a position leave the expectation unavailable (`n/a`), never zero. `--brand-pattern <regex>` (case-insensitive, default `pharos`) marks brand queries, which are reported as a brand/non-brand split and kept out of query opportunities. `#fragment` sitelink rows fold into a per-page sitelink note instead of failing as duplicate page totals, and are never summed into page metrics. The `stablecoin-detail` family splits by registry status (`:active`, `:pre-launch`, `:frozen`, `:inactive` for quarantined or delisted, `:unlisted` for IDs no longer in the registry). Run it on 28-day exports: three-month windows carry decayed news-spike impressions.

`npm run audit:mint-authority-review` prints Markdown by default; add `-- --json --report agents/mint-authority-review/audit.json` for a saved JSON report or `-- --report agents/mint-authority-review/audit.md` for Markdown. The CLI uses the shared coverage-audit parser/runner (`--json` / `--markdown`, `--report <path>`); the former `--format` / `--out` flags are removed. `--generated-at <iso>` pins the capture timestamp. `--live --live-limit <n>` adds an advisory source-URL probe appendix to Markdown only (default limit 50); JSON never probes sources.

Audits and drafts are human-review evidence, not scoring engines or admission authority. Historical investigations require their recorded source/input/registry/clock pins; Git source alone does not establish reproducibility, and modern replay/queue tools are not format-equivalent substitutes for retired research output.

- `audit:price-source-depth` proposes conditional coverage lifts, not measured new sources or independent trust. Retain both report-card and stablecoin input identities/clocks with the next audit; independent snapshots need not share a publication generation.
- `audit:coverage -- --domain=redemption-coverage` always evaluates reviewed-disposition findings. `--check` changes presentation only: a reviewed nonzero backlog can pass either mode, while missing/invalid/stale dispositions fail either mode. `--strict-active-gaps` separately escalates inferred active gaps; a disposition never configures a redemption route.
- `audit:coverage -- --domain=reserve-coverage` is advisory and has no `--check` evaluator (the child rejects that option). `--prod` supplies report-card/stablecoin catalog snapshots, not reserve-sync telemetry; use explicit `--reserve-states <file>` for state evidence. Absent state stays unknown.
- L2BEAT snapshot audits distinguish alias-only validation, saved observed input, and explicit `--live` drift checks; see [Chain Health](./chain-health.md#l2beat-snapshot). None imports live data into the authoritative static snapshot automatically.
- Oracle coverage counts complete profiles directly among in-scope profile-bearing assets; missing profiles and out-of-scope stale dispositions cannot subtract from that census.

`npm run audit:live-reserve-config-changes -- --base <ref>` compares working-tree semantic fingerprints to an explicit deployed/PR base offline, printing changed IDs and both digests as JSON; missing recovery fetchers fail. New/removed bindings and display/scoring edits are excluded. It shares runtime's pure selector; tests are git-independent. Bounds/acceptance: [config recovery](process/live-reserves-appendix.md#deploy-time-configuration-recovery).

Independent-assurance extraction and publisher provenance are owned by [Live Reserves](./live-reserves.md), with source profiles under `scripts/lib/independent-assurance-profiles/`.

`npm run audit:mint-burn-conservation-admission -- --ids <csv> --out <dir>` runs the production raw-token conservation audit over a frozen per-chain window (timestamp-driven by default; `--window-blocks` overrides) for every config of the requested stablecoin ids; semantics and the reviewed-identity sidecar are owned by [Mint/Burn Flows: Raw Token Conservation](./mint-burn-flows.md#raw-token-conservation). It journals every JSON-RPC exchange to `<out>/journal.jsonl` with URLs redacted to origin and chain path (never the API key), reproduces records offline with `--replay <journal.jsonl>`, and — given reviewer semantic files via `--semantic-dir` — emits `sidecar-draft.json` entries (`--emit-sidecar-draft`) that `--merge-into-sidecar` merges into the committed sidecar. The command exits 1 when any audited window is not `ok`; journals and drafts stay under `agents/`.

Audit and draft modes do not mutate admission authority. Only explicit `--merge-into-sidecar` changes the reviewed sidecar and regenerates its runtime projection; retain the journal and restore the exact sidecar/projection pair on rollback, never disable the ingestion fence.

V9 typed queue: `safety-score-v9:missing-data-registry`; `safety-score-v9:curation-worklist` renders Markdown; `safety-score-v9:expiry-queue` adds preventive production-admission expiry checks. The direct mint-posture compatibility tool has no alias or routing role.

The typed registry's census follows `ratingStatus`: `rateableStablecoinCount` counts only `rated`, `notRatedStablecoinCount` counts economic `not-rated`, and `pipelineGapStablecoinCount` counts technical `pipeline-gap`. These three buckets reconcile with replay completeness and `ratingStatusCounts`; a null-grade pipeline gap is never rateable or economic NR.

Worklist and pre-expiry supply come from the exact replay's retained nullable supply state, not a fresh market-cap lookup. Missing supply stays unavailable with a reason; observed zero stays zero. Reports disclose known-supply subtotals/unavailable counts and qualify known-only ratios, with deterministic unknown-first ordering rather than assigning unknown assets the smallest weight.

USDe/USDf manual capture and reviewed weekly protocol-API automation are permanent non-publishing evidence tooling. Strict replay reports canonical V2 / original-byte hash-verified normalized-only V1 / unavailable separately; unavailable access or bodies fail. Replay may perform signed R2 GETs and cache verified bytes; network-free use requires local original bytes/cache. fxSAVE's standalone local capture stays incomplete/N/A; its reviewed dossier already attaches parent evidence at a separate immutable clock/block, not new local CDP credit.

Replay/diff/movers, sensitivity, anchor and DDRR calibration remain non-publishing model tools; [the equivalence harness](./process/safety-score-equivalence-harness.md) owns admission, identity and equality limitations. Replay uses captured redemption by default; `--rederive-current-redemption` explicitly asks a current-curation scenario. Sensitivity is research-only, and golden invariants remain authoritative. Diff equality is normalized score-output equality, not activation or full-artifact identity proof.

Annotation and AI-summary candidate request deadlines remain active through JSON body consumption. Annotation collection uses fixed 14-day windows and serial cursor pagination, bounded to 25 pages and 30 seconds per source with a 6-second request/body timeout. Partial results retain explicit incomplete coverage. Full queues, digest, and logs are immutable Actions artifacts retained for 90 days; issue excerpts link to those artifacts.

Registry launch dates and pre-launch milestones use an inclusive 30-day lookback through the same captured run clock as tape coverage. Future planned dates remain registry metadata and do not become newly collected annotation events. Retained snapshots and explicit reviewer dispositions are preserved rather than retroactively filtered by this collection window.

Annotation intake, corpus, reviewer decisions, and deferrals remain after chart-overlay retirement; no candidate publishes automatically. AI-summary QA reads four endpoint families (report cards, stress signals, peg summary, stablecoins), uses heuristic detectors, and skips summaries without a current card. An empty candidate report is not affirmative validation of all prose; exact-text human review and registered claim tokens remain authoritative.

AI-summary circulation comparisons use nullable admitted supply: empty or invalid buckets cannot trigger numeric drift, while observed zero can. Static dollar claims still require manual dated-source review when current supply is unavailable. Public top-stablecoin datasets publish `circulatingUsd: null` plus `supplyUnavailableReason` in JSON/NDJSON; CSV leaves an unavailable amount empty and appends `supplyUnavailableReason` as the final column after `chains`. The pre-existing CSV column positions remain unchanged: `id,symbol,name,pegType,pegMechanism,price,circulatingUsd,chainCount,chains,supplyUnavailableReason`. The reason is null in JSON/NDJSON (empty in CSV) when supply is observed. Unavailable amounts sort last; explicit zero remains numeric zero. Price-source-depth audits expose known-supply weighted reach with observed/unavailable counts, not a complete-cohort monetary share.


`npm run candidates:annotations -- --replay agents/annotation-history` recursively reads downloaded `annotation-candidates.json` snapshots and merges them with local unresolved rows offline. Reviewer-owned `agents/annotation-review.json` dispositions suppress only explicitly promoted or dropped IDs, preserve deferrals, and admit distinct same-day events. Generation never advances legacy `last_swept_at`, writes review decisions, or edits product annotations. AI-summary liquidity findings assert retirement only with explicit legacy Safety Score context; current or ambiguous DEX claims receive neutral review without an invented comparison. `npm run candidates:ai-summaries` also emits medium-severity `weakest-pillar` findings when prose names a weakest pillar other than the card's published `weakestPillar`, and `retired-methodology-version` findings when a Safety Score sentence cites a major version from v9 up to but excluding the current one (pre-v9 claims stay with the retired-dimension findings; protocol versions such as Aave v3 are ignored outside Safety Score sentences).

### One-Time And Operator Tools

Direct entrypoints without an npm alias can be intentional hand-run operator or research tools. `scripts/lib/cli-argv-policy.mjs` classifies argument handling; enrollment alone does not establish an active caller or operator contract. Inspect the entrypoint's supported options and the relevant runbook from the [documentation index](./README.md). Worker-bound tools live under `worker/scripts/`; for example, Yield history cleanup follows the [writer-pause runbook](./runbooks/yield-history-cleanup-writer-pause.md), including its export, confirmation, abort, and restore requirements.

`worker/scripts/replay-blacklist-config-history.ts` is a guarded, remote-D1 historical topic recovery tool. Required selectors are `--config-key`, `--from-block` and `--to-block` (inclusive; capped at that deployment's stored cursor). It defaults to read-only dry-run and reads the chain-checked RPC URL from `BLACKLIST_REPLAY_RPC_URL` (`--rpc-env` selects another environment variable). `--chunk-blocks` defaults to 100000; `--database` defaults to `stablecoin-db`. Execution requires `--execute --confirm worker/scripts/replay-blacklist-config-history.ts`, the existing blacklist writer pause, and no active sync lease. Immediately before the atomic import, it captures a Time Travel restore point and records it in stdout, hashed evidence and the durable audit; capture failure aborts without writes. The bookmark is recovery evidence, not a global concurrency token. It never moves cursors or changes existing events. See the [blacklist recovery runbook](./runbooks/blacklist-sync.md#config-scoped-historical-topic-recovery) for exact PAXG/Ethereum and USDT/Avalanche dry-run commands, atomic-import impact, evidence/audit review and pause cleanup.

`scripts/maintenance/audit-dex-pricing-source-gaps.ts` is retained for hand-run pricing research, not scheduled automation. Run it with `--price-depth <path>` (or `--stablecoins <path>`) and `--dex-prices <path>` to join local snapshots into a DEX source-gap report; optional `--dex-liquidity <path>` and `--curve-candidates <path>` add liquidity and Curve-route evidence. It prints Markdown by default, supports `--json` and optional local `--report <path>` output, and does not publish pricing changes.

## Operational Notes

### Credential Handling

Check the ignored root `.env.local` and the command's documented environment source before treating a local credential as absent. Report only the variable name's presence or absence; never print, copy, or log its value. Production Worker secrets remain Cloudflare/Wrangler-managed and must not be copied into local files.

Forward credentials only to the origin the command documents and that you have verified. In particular, API-backed curation commands may use `PHAROS_API_KEY` and an explicit `PHAROS_API_BASE`; do not send the key to an untrusted override URL. Credential names and bindings are checked against the environment contract, while each command's `--help` owns its accepted variables.

`ops:worker-memory` forwards its dedicated Analytics token only to the fixed `https://api.cloudflare.com/client/v4/graphql` origin (redirects rejected), never to Worker/D1/admin endpoints. Provider error payloads and authorization headers are not retained in query manifests. Its explicit local writes are evidence capture, not a production mutation or a dry-run mode.

### Mutation Safety

Treat backfills, remote D1 commands, registrations, uploads, and cleanup scripts as admin operations. Start with `--dry-run` or the command's read-only/check mode, inspect the exact target and planned changes, and use staging or development first when available. A dry run may read local or remote state, but it must not write files or call a mutating API.

Destructive Worker CLIs use `parseDestructiveOperationArgs` from `worker/scripts/lib/destructive-operation-guard.ts`; its `.mode` supplies the guarded dry-run and D1 target alongside parsed arguments.

For live mutation, use the script-specific execute and confirmation guards and follow the relevant runbook. Do not bypass a guard with ad hoc SQL or a raw deploy command. Abort when prerequisites such as a backup/export, writer pause, target identity, or rollback path cannot be proven.

### Artifact Destinations

Scratch reports, evidence captures, calibration output, and operator handoffs belong under the ignored `agents/` tree. Promote only durable policy or reviewed source changes into `docs/` or the owning data source.

Generated-artifact destinations and version-control policy are owned by `scripts/lib/automation-registry.mjs`. Do not redirect or manually normalize registered outputs. Regenerate affected tracked artifacts explicitly and commit them with their sources; `npm run check:generated-artifacts` checks convergence.

D1 Insights captures are the specific exception documented above: they write `agents/d1-insights-<timestamp>.json`. Other commands' `--help`, registry entry, or runbook owns the exact destination.

Night Watch attributes D1 rows only to their explicit matching `schedule_key`; identity-less or unmatched rows remain unattributed and counted literally. Shared jobs cannot gain path confirmation from status-only evidence. Version-2 checkpoints bind database, local/remote, normalized public/admin origins, requested lanes, sampling plan and window, excluding credentials/output paths. Legacy, identity-less or mismatched checkpoints fail before collection, including `--no-resume`: retain them and choose a new checkpoint path. `--fixture` renders saved evidence JSON offline, preserving its window, scope and collection identity; only explicitly supplied rendering/output options override saved options. Collection/window flags with `--fixture` are rejected, not implicit window narrowing.

### Local Workspace Preparation

The npm `prepare` script runs `scripts/maintenance/prepare-workspace.ts`. Local installs materialize bootstrap-safe generated inputs, then the history-derived projections with `npm run bootstrap:generated:history`. GitHub Actions skips implicit preparation and uses `.github/actions/setup-workspace/action.yml`, opting into full-history projections per job with `bootstrap-history`. `PHAROS_PREPARE_BOOTSTRAP=1` forces ordinary bootstrap in CI without enabling history bootstrap.

Heading IDs use `rehype-slug`; keep its transitive `github-slugger` lockfile entry without declaring `github-slugger` as a direct dependency.

There is no repository pre-commit or pre-push hook. Custom hook paths remain user-owned. Generated freshness is enforced by hosted checks, not automatic staging; use explicit generation and `npm run check:generated-artifacts` for local convergence. [Pre-push readiness](./testing.md#pre-push-readiness) defines local feedback and hosted readiness authority.

### Release Ownership

The [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns the authoritative gate and production mutation, [Operational Acceptance](./deployment-process.md#operational-acceptance) owns release-marker proof and first-execution observation, and [Failure Policy](./deployment-process.md#failure-policy) owns rollback semantics.

## Safe Usage Guidelines

- Prefer npm aliases from `package.json`; use direct entrypoints only when the routing index or an owning runbook sends you there.
- Read `--help` immediately before running an operator command; flags and defaults belong to the script, not this page.
- During incident debugging, pass explicit URLs and targets instead of relying on environment fallbacks.
- Keep advisory output in `agents/`, and keep registered generated artifacts at their registry-owned destinations.

## Tool Implementation Appendix

The fetch-body timeout guard follows `fetchWithRetry` Response identity through copied variables and assignment chains, retaining the original fetch line while reporting the alias used for a raw `.json()`/`.text()` read. Reassigning a variable clears only that variable's identity, not existing copies. The provider-resilience guard discovers executable global `fetch` calls and their aliases by syntax and symbol identity; local/imported functions named `fetch`, object methods and inert comment/string text are not global-fetch evidence. Aliased calls retain the same registration and `allowBareFetch` policy as literal calls.

Wrangler-backed operator readers share `decodeD1Envelopes` in `scripts/lib/remote-d1.ts`; `decodeD1Rows` projects rows only after the entire response is admitted. Direct query envelopes and nested `result` object/array wrappers retain all ordered results and metadata. Explicit failure/error evidence, missing/malformed results, and empty envelope containers (including top-level `[]`) throw rather than imply no rows. Any defined non-null `error`, including `""`, fails; `error: null` and `errors: []` remain allowed. A recognized `results: []` is valid empty evidence; query shapes without a success flag remain supported, while backfill, archive and movement-ledger readers additionally require explicit success and their existing statement-count/receipt/schema checks. Wrangler process failures propagate unchanged.

`check:dex-census-provider-drift -- --rows=<dump.json>` uses that same admission for Wrangler dumps and separately supports direct raw row arrays, including `[]`. Every census row must have valid identity, outcome/reason, nullable finite observation time and a JSON string-array provider set; malformed rows cannot silently disappear. Human output reports scanned rows and tracked deployments explicitly, including zero-row coverage; JSON retains those counts. Provider attribution and orphan exclusion are unchanged.

Runtime reachability discovers client entrypoints from TypeScript-parsed directive prologues, including semicolonless directives and leading comments. Forbidden direct-import checks inspect import declarations even when tree-shaken, while ignoring inert strings/comments; source-owned policy scopes and transitive graph checks remain in force. `check:worker-config` requires the exact asset mapping (`Data` → `**/*.ttf`, `CompiledWasm` → `**/*.wasm`, `Text` → `**/coins.worker-full.generated.json`) on both Workers, including fallthrough; `check:worker-package` independently proves strict bundles and enforces each emitted map's gzip budget.

### Safety evidence CLI details

The ledger counts only score/grade changes, not every compact diagnostic change. First sight without a prior retained baseline is reported in `missingBaselineCoinIds`, not counted as movement. Identity changes take precedence as `release` (non-comparable methodology/policy/build, **not causal proof**). Same-identity changes in pipeline-gap or partial-evidence state classify as `operational`. Persistent partial evidence remains context and does not override an included-pillar, peg, or cap movement; unexplained movement adjacent to a hold is operational. Otherwise the largest observed absolute pillar delta or pillar availability change supplies `data:<pillar>`, with all secondary/null deltas retained. Peg-only and cap-only changes have explicit labels; adjacent holds remain linked context. Remaining edges are `data:unattributed`. The JSON retains before/after compact cards, identities, lineage and hold codes; retained change-only observations cannot replace a full frozen-input replay or prove that missing edges did not occur.

For intraday release comparison, use the exact deployment instant with `boundary --before-time`; date-only means UTC midnight. Identity boundaries are retrospective predecessors of already archived transitions, not future release markers, and missing archive rows cannot establish the last production generation. Export checks exact hash/bytes, schema, clocks and identities before emitting cache rows; the capture CLI must still admit the paired native envelopes. Optional decoded cards are not a full replay artifact.

`list --gaps` exposes generations with no index row, including unchanged publications and not just card movements: it unions retained accepted attempts (120-day attempt evidence) with productive `compute-safety-score-v9` runs whose metadata names a `publicationGenerationId`, bounded to the retained `cron_runs` window and deduplicated by generation. Each gap carries `evidence_sources` plus its `journal` and `recent_cron_runs` provenance, and report-level `recentCronEvidence` accounts for excluded missing/malformed run ids and for windows that start before the retention floor. Both evidence sources are best effort and shorter-lived than object retention: absent/pruned attempts, cron rows outside the retained window, missing objects with an index and unindexed orphans are not covered. Empty gaps is never a complete-archive certificate. External R2 lifecycle must be reverified under [release prerequisites](./deployment-process.md#first-heavy-deployment-prerequisites-adr-38); the CLI/migration neither creates nor continuously verifies it.

The [historical release/data separation procedure](./process/safety-score-equivalence-harness.md#historical-release-and-data-separation) includes local D1 fixture loading and the explicit lightweight projections needed to compare accepted cards with replay output. Archive creation is best effort, starts when the writer is deployed, and can leave permanent failed/skipped gaps once mutable accepted rows are overwritten. `--gaps` makes retained journal-observable omissions visible; it does not repair them or discover unindexed R2 orphans. No historical captures are invented or backfilled.
