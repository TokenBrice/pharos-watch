# Comprehensive Three-Pillar Codebase Audit

Date: 2026-04-28  
Scope: Current working tree of `/home/ahirice/Documents/git/stablecoin-dashboard`  
Audit pillars: redundancy elimination, code quality improvement, long-term sustainability and maintainability

## Audit Method

Assumptions:

- The audit treats the current working tree as the source of truth.
- Generated output, dependency caches, and build artifacts are out of scope unless they are committed source or affect the runtime pipeline.
- This is an analysis deliverable only. No production code was changed.
- Findings are limited to concrete issues with file and line evidence. Potential style preferences without objective risk were omitted.

Inventory and verification commands used:

- `find`/`rg` inventory over `src`, `shared`, `worker`, `functions`, `scripts`, `tests`, `.github`, and root manifests.
- `npm run check:unused-code`
- `npm run check:shared-cycles`
- `npm run check:worker-boundary`
- `npm run check:hotspot-ratchet`
- `npm run check:env-contract`
- `npm run check:cron-connections`
- `npm run check:verified-doc-links`
- `npm run check:doc-source-paths`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run audit:deps`
- `npm audit --json --audit-level=low`
- `npm outdated --json`
- `npx --yes jscpd@4.0.5 ...`

Relevant project docs reviewed:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/deployment-process.md`
- `docs/dependency-map.md`
- `docs/data-flow-map.md`
- `docs/worker-infrastructure.md`
- `docs/doc-ownership.json`

## 1. Executive Summary

### Finding Counts

| Pillar | Total | Critical | High | Medium | Low | Investigation/Policy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Redundancy elimination | 7 | 0 | 0 | 0 | 0 | 7 confirmed redundancy findings |
| Code quality improvement | 9 | 0 | 1 | 5 | 3 | 0 |
| Sustainability and maintainability | 7 | 0 | 3 | 2 | 1 | 1 |
| Cross-cutting concerns | 5 | n/a | n/a | n/a | n/a | n/a |

Total primary findings: 23  
Critical findings: 0  
High-impact/high-severity findings: 4

### Top 5 Findings

1. **Q004 - Production blacklist reconciliation script performs destructive replacement from an external API without enough safety controls.** A failed or malformed `kyc.rip` response can propagate directly into remote D1 state.
2. **S001 - Stablecoin catalog still exists in two canonical source shapes plus a generated aggregate.** This is the largest long-term source-of-truth risk in the codebase.
3. **S002 - Depeg detection cron remains a large multi-responsibility hotspot.** It combines hydration, corroboration, event decisions, duplicate repair, and cleanup in one high-risk module.
4. **S003 - CoinGecko fallback sync path is a large degraded-mode hotspot.** A critical resilience path is hard to reason about and expensive to change safely.
5. **Q002 - `getPriceCache()` falls back on any D1 read error, not only schema drift.** Transient failures can silently strip price metadata and degrade downstream calculations.

### Health Assessment

| Pillar | Rating | Rationale |
| --- | ---: | --- |
| Redundancy elimination | 8/10 | Exact clone rate is low: `jscpd` found 69 duplicated non-test lines, about 0.03% of scanned source. Unused-code and duplicate-export checks pass. Remaining duplication is concentrated in compatibility paths, validation runners, data ownership, and small route wrappers. |
| Code quality improvement | 7/10 | Lint, frontend type-check, worker type-check, and major tests pass. There are no critical findings. The main risks are operational script safety, broad error fallbacks, runtime boundary validation, and several high-complexity modules. |
| Sustainability and maintainability | 6.5/10 | Documentation and guardrails are strong, and architecture boundaries are actively checked. Long-term risk remains in dual catalog formats, large cron hotspots, tight cron connection headroom, and dependency baseline drift. |

### Technical Debt Profile

Directly affected files are a small portion of the repository: roughly 40 files out of the broader source and configuration corpus. The measured clone footprint is below 0.1% of scanned non-test code. However, the blast radius is larger than the file count suggests because several findings sit in core runtime surfaces: stablecoin catalog loading, depeg detection, stablecoin sync fallback, price cache reads, blacklist reconciliation, and cron scheduling. A practical estimate is that about 2% of files contain significant findings directly, while 10-15% of the core runtime and operational behavior depends on those areas.

## 2. Findings by Pillar

## Pillar 1: Redundancy Elimination

### R001 - Stale Mint/Burn Sync-State Legacy Key Compatibility

Locations:

- `worker/src/lib/mint-burn-pipeline/sync-state.ts:9-17`
- `worker/src/lib/mint-burn-pipeline/sync-state.ts:47-52`
- `worker/src/lib/mint-burn-pipeline/sync-state.ts:72-78`
- `worker/migrations/0093_cleanup_legacy_mint_burn_sync_keys.sql:3-5`
- `worker/migrations/0000_baseline.sql:589-591`
- `docs/mint-burn-flows.md:457-459`

What is redundant:

`sync-state.ts` still carries `legacyMintBurnConfigKey()` plus dual-read/max fallback logic for colon-delimited keys. Migration `0093` deletes those legacy keys, the baseline migration seeds only the canonical slash-delimited key, and the docs describe the canonical key as current.

Consolidation strategy:

Remove `legacyMintBurnConfigKey()`, delete the dual-read merge path, and keep only `mintBurnConfigKey()`. Update tests that encode legacy compatibility. This should be done after confirming all deployed D1 databases have migration `0093` applied.

### R002 - Validation Entrypoints Duplicate Command-Runner and CLI Logic

Locations:

- `scripts/run-validate-postbuild.mjs:11-33`
- `scripts/run-validate-postbuild.mjs:57-124`
- `scripts/run-validate-postbuild.mjs:176-202`
- `scripts/run-node-lts-validation.mjs:7-32`
- `scripts/test-merge-gate.mjs:134-191`
- `scripts/test-merge-gate.mjs:247-272`

What is redundant:

The validation scripts each implement their own command runner, argument parsing, status printing, and failure summarization. `jscpd` reported a clone between `scripts/run-validate-postbuild.mjs:86-121` and `scripts/test-merge-gate.mjs:163-198`.

Consolidation strategy:

Extract a small `scripts/lib/command-runner.mjs` that supports `runStep`, env merging, output prefixing, elapsed time, and failure aggregation. Keep script-specific policy in each entrypoint.

### R003 - FX Cadence Rules Have Split Ownership

Locations:

- `worker/src/lib/fx-rate-state.ts:15-37`
- `worker/src/lib/fx-rate-state.ts:189-198`
- `worker/src/lib/fx-source-metadata.ts:4-37`

What is redundant:

Business-day and calendar-day FX peg sets are duplicated across state and metadata modules. Both modules encode cadence knowledge, making future peg additions easy to update in only one place.

Consolidation strategy:

Move cadence ownership to one helper, for example `worker/src/lib/fx-cadence.ts`, exporting the peg sets and `getNaturalFxCadence()`. Let both state and metadata modules import from it.

### R004 - Blacklist Event API Record Restates Shared Blacklist Event Shape

Locations:

- `shared/types/market.ts:473-495`
- `worker/src/lib/blacklist-api.ts:34-56`
- `worker/src/lib/blacklist-api.ts:58-81`
- `worker/src/api/blacklist.ts:111-122`

What is redundant:

`worker/src/lib/blacklist-api.ts` declares a local `BlacklistEventApiRecord` that closely matches the shared `BlacklistEvent` type. The worker then maps D1 rows into the local type and the API handler maps again into the public response shape.

Consolidation strategy:

Use the shared type for the worker API record or introduce a single shared public response type if the response contract intentionally differs. Delete the local duplicate interface once the mapping boundary is explicit.

### R005 - Stablecoin Taxonomy Hub Pages Are Copy-Pasted Route Wrappers

Locations:

- `src/app/stablecoins/backing/page.tsx:1-31`
- `src/app/stablecoins/governance/page.tsx:1-31`
- `src/app/stablecoins/infrastructure/page.tsx:1-31`

What is redundant:

The three route pages have the same module structure and differ only by route constant/function name. This is small but exact page-level repetition.

Consolidation strategy:

Create a tiny route-page factory or shared helper that binds the taxonomy route descriptor. Keep individual page files as one-line exports so Next.js route conventions remain clear.

### R006 - Commented-Out Strict Bridge Validation Block Is Dead Policy Code

Locations:

- `worker/src/lib/mint-burn-contracts.ts:63-90`

What is redundant:

The module validates bridge metadata, logs validation errors, and then contains a commented-out strict throw block. The commented block is stale executable policy documentation inside production code.

Consolidation strategy:

Either remove the commented block and document the current audit-and-report policy, or implement strict behavior behind a tested explicit switch. Avoid leaving disabled logic in the runtime module.

### R007 - KYC Reconciliation Scripts Duplicate Remote D1 and External Fetch Helpers

Locations:

- `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts:27-56`
- `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts:40-80`
- `scripts/lib/remote-d1.ts:9-57`

What is redundant:

The two worker scripts duplicate `wrangler d1` command execution, SQL string escaping, and external row fetching. A general remote D1 helper already exists under `scripts/lib/remote-d1.ts`, but these worker scripts maintain their own variants.

Consolidation strategy:

Move worker-compatible remote D1 helpers into a shared script utility location or adapt the scripts to use the existing helper. Add timeout and schema validation to the shared external fetch helper as part of the consolidation.

## Pillar 2: Code Quality Improvement

### Q004 - High - Destructive KYC Current-Balance Reconciliation Has Weak Safety Controls

Location:

- `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts:42-56`
- `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts:101-129`

Problem:

The script fetches rows from `https://api.kyc.rip/...`, normalizes them, deletes existing rows for selected assets/chains, and inserts the fetched snapshot into remote D1. It has no default dry-run mode, no `--apply` confirmation, no timeout, no runtime response schema, no minimum row-count guard, and no staging-table comparison.

Why it matters:

This is an operational script with destructive production behavior. A malformed external response, partial outage, empty response, or local normalization mistake could remove valid blacklist balance data.

Remediation:

Make dry-run the default and require `--apply` for writes. Validate the external response shape, add a timeout and retry policy, require a minimum expected row count, print a diff summary, and prefer a staging table or transactional replacement pattern. Share D1 execution helpers with `scripts/lib/remote-d1.ts` or a worker-script equivalent.

### Q001 - Medium - Site Data Cache Write Can Fail Healthy Responses

Location:

- `functions/_site-data/[[path]].ts:189-193`

Problem:

The function builds a successful upstream response, enqueues telemetry, then awaits `getDefaultCache().put(cacheKey, response.clone())` on the main response path. If `Cache.put()` fails, the user-facing request can fail even though the upstream data response was healthy.

Why it matters:

Cache writes should be best-effort for this proxy path. Coupling response success to cache persistence reduces availability.

Remediation:

Use `context.waitUntil(getDefaultCache().put(...).catch(...))` or a local `try/catch` that logs cache-write failures and still returns the original response. This should mirror the defensive cache write pattern already used in `worker/src/handlers/http/edge-cache.ts:20`.

### Q002 - Medium - Price Cache Fallback Catches Too Broadly

Location:

- `worker/src/lib/db-cache.ts:105-169`
- Downstream consumers include `worker/src/lib/mint-burn-pipeline/price-heal.ts:67` and `worker/src/cron/sync-stablecoins/post-enrichment.ts:330`

Problem:

`getPriceCache()` first tries to read the full `price_cache` schema. On any exception, it falls back to a core-column query. The fallback is intended for schema drift, but the catch also swallows transient D1 failures, decode bugs, malformed data issues, and other unexpected read errors.

Why it matters:

Unexpected failures can silently downgrade the returned data by setting metadata such as `source`, `confidence`, observed-at fields, and consensus fields to empty values. That makes downstream enrichment and mint/burn healing less reliable while hiding the root cause.

Remediation:

Only use the fallback when the error clearly indicates missing columns or a known schema-compatibility condition. Re-throw or surface other errors as degraded operational failures. Add tests for missing-column fallback and for non-schema D1 errors.

### Q003 - Medium - Cloudflare D1 Status Responses Are Cast Without Runtime Validation

Location:

- `worker/src/lib/status/d1-usage.ts:54-64`
- `worker/src/lib/status/d1-usage.ts:66-87`
- `worker/src/lib/status/d1-usage.ts:89-158`

Problem:

`fetchJson<T>()` returns `await response.json() as T`, and the Cloudflare API/GraphQL response structures are then traversed as if they are known-good. There is no runtime schema validation for malformed success payloads, partial GraphQL errors, or changed response shapes.

Why it matters:

Status pages are operational diagnostics. Incorrectly accepted provider payloads can show misleading D1 usage or hide telemetry failures.

Remediation:

Add lightweight runtime guards or a schema parser for the REST database info response and GraphQL analytics response. Add fixture tests for success, missing fields, malformed payloads, and GraphQL `errors` with partial data.

### Q005 - Medium - DEX Discovery Crawl Function Combines Four Provider Pipelines

Location:

- `worker/src/cron/dex-discovery/crawl-sources.ts:60-505`

Problem:

`crawlCoin()` handles CoinGecko pools, GeckoTerminal fallback, DexScreener fallback, CoinGecko ticker fallback, source-specific filtering, dedupe state, and staged-pool creation in a single 400-plus-line function.

Why it matters:

Each provider has different failure modes and data semantics. A monolithic implementation makes provider-specific fixes risky and makes it harder to test degraded-source behavior in isolation.

Remediation:

Extract provider-specific stage functions such as `crawlCoinGeckoPools`, `crawlGeckoTerminalPools`, `crawlDexScreenerPools`, and `crawlCoinGeckoTickers`, plus a shared `toStagedPool()` builder. Keep the public `crawlCoin()` orchestration thin.

### Q006 - Medium - Contagion Graph Component Is a Large Mixed-Responsibility UI Module

Location:

- `src/components/contagion-graph.tsx:48-553`

Problem:

`ContagionGraph` combines graph data preparation, focus/neighborhood state, keyboard navigation, ripple computation, controls, legend, SVG edge rendering, SVG node rendering, labels, tooltips, and empty-state rendering in a single 506-line component.

Why it matters:

The component is harder to test and modify safely. Interaction changes can accidentally affect layout, graph computation, or accessibility behavior because all responsibilities share one render scope.

Remediation:

Split pure graph derivation into a hook or utility, extract controls/legend into small components, and extract edge/node rendering into focused presentational components. Add tests around selection/focus behavior before refactoring.

### Q007 - Low - LocalStorage Readers Trust Parsed Shapes

Location:

- `src/hooks/use-nav-collapse.ts:13-24`
- `src/hooks/use-command-palette-history.ts:40-69`

Problem:

Both hooks handle invalid JSON, but valid JSON with the wrong shape can still flow into logic that expects `Record<string, boolean>` or `HistoryItem[]`. `use-command-palette-history` can call `.filter()` on a non-array parsed value.

Why it matters:

Malformed local storage should not reset or break client UI logic. Browser extensions, manual edits, and older app versions can leave unexpected values.

Remediation:

Normalize parsed values with `typeof`/`Array.isArray` checks before use. Add tests for valid-but-wrong JSON shapes, not only invalid JSON.

### Q008 - Low - Object URLs Are Revoked Immediately After Programmatic Clicks

Location:

- `src/components/share-button.tsx:70-80`
- `src/lib/csv-export.ts:25-31`

Problem:

Both download helpers call `URL.revokeObjectURL(url)` immediately after triggering `a.click()`.

Why it matters:

Some browsers may start download resolution asynchronously. Immediate revocation can race the download, especially for larger generated files or slower devices.

Remediation:

Append the anchor when needed, trigger the click, and revoke in `setTimeout(..., 0)` or a `requestAnimationFrame` callback. Add a small unit test that verifies delayed revocation.

### Q009 - Low - Git Refs Are Interpolated Into Shell Commands

Location:

- `scripts/classify-deploy-changes.mjs:49-53`
- `scripts/test-merge-gate.mjs:62-78`
- `scripts/check-critical-coverage.mjs:47-57`

Problem:

Repo-local validation scripts interpolate git refs into `execSync()` shell strings.

Why it matters:

The current inputs are mostly CI-controlled or developer-controlled, so practical exploitability is limited. Still, this is an avoidable command injection footgun in scripts that run in CI and pre-push workflows.

Remediation:

Use `execFileSync("git", [...args])` or `spawnSync("git", [...args])` with argument arrays. If string execution must remain, validate refs against a strict git-ref/SHA allowlist before interpolation.

## Pillar 3: Sustainability and Maintainability

### S001 - High - Stablecoin Catalog Has Multiple Source-of-Truth Shapes

Scope:

- `shared/lib/stablecoins/registry.ts:1`
- `scripts/lib/stablecoin-catalog-sources.ts:9`
- `scripts/check-stablecoin-data.ts:187`
- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/usd-minor.json`
- `shared/data/stablecoins/non-usd.json`
- `shared/data/stablecoins/commodity.json`
- `shared/data/stablecoins/pre-launch.json`
- `shared/data/stablecoins/coins.generated.json`
- `shared/data/stablecoins/coins/*.json`

Issue:

The catalog is maintained in category JSON files, per-coin JSON files, and a generated aggregate. The tooling knows about the migration state, but both canonical-looking shapes remain present. One file alone, `shared/data/stablecoins/usd-minor.json`, is over 11,000 lines.

Long-term consequence:

New stablecoin additions and metadata corrections can land in the wrong format or drift between formats. Reviewers must understand migration mechanics before trusting a data change.

Remediation:

Finish the catalog migration to a single source-of-truth format. Make generated artifacts clearly read-only, fail checks if hand-edited, and update docs to state exactly where maintainers should edit data.

### S002 - High - Depeg Detection Cron Is a Multi-Responsibility Hotspot

Scope:

- `worker/src/cron/detect-depegs.ts:322`
- `scripts/lib/hotspot-ratchet-waivers.json:102`

Issue:

The depeg detection job combines data hydration, threshold/corroboration decisions, event persistence, duplicate repair, and orphan cleanup. It is important enough to have a hotspot waiver.

Long-term consequence:

Policy changes to depeg detection carry high regression risk because unrelated operational tasks live in the same module. The job is hard to unit-test at the decision level.

Remediation:

Split the module into input hydration, a pure decision engine, persistence, and repair/cleanup phases. Lock the decision engine with fixture tests before moving persistence behavior.

### S003 - High - Stablecoin Sync CoinGecko Fallback Path Is a Large Degraded-Mode Hotspot

Scope:

- `worker/src/cron/sync-stablecoins/fallback.ts:39`
- `scripts/lib/hotspot-ratchet-waivers.json:30`

Issue:

`syncViaCoingeckoFallback()` handles fallback intake, stale cache recovery, FX behavior, price enrichment, validation, cache publication, tracked additions, and depeg integration in one large path.

Long-term consequence:

Fallback sync is most important when the primary source is unhealthy. Complexity in degraded mode makes outage response and future changes riskier.

Remediation:

Break the fallback into typed phase functions aligned with existing progress stages. Add tests for each phase and keep the top-level fallback function as orchestration.

### S004 - Medium - Environment Contract Module Mixes Registry and Renderers

Scope:

- `shared/lib/env-contract.ts:104`
- `shared/lib/env-contract.ts:618`
- `scripts/lib/hotspot-ratchet-waivers.json:66`

Issue:

The environment contract file is over 700 lines and mixes variable registry data with markdown/example rendering helpers.

Long-term consequence:

Adding or reviewing an environment variable requires navigating unrelated renderer code. This increases merge-conflict and review cost for operational configuration changes.

Remediation:

Keep the contract registry central, but move markdown/example rendering helpers into adjacent modules. Preserve current public exports to minimize churn.

### S005 - Medium - Cron Trigger Connection Headroom Is Nearly Exhausted

Scope:

- `shared/lib/cron-jobs.ts:201`
- `shared/lib/cron-jobs.ts:264`
- `shared/lib/cron-jobs.ts:374`
- `docs/worker-and-api-limits.md:48`

Issue:

`npm run check:cron-connections` passes, but reports three slots at 5 of Cloudflare's 6 connection slots: `fiveMinuteTelegramAlerts`, `fourHourlyYieldSupplemental`, and `daily0805Utc`.

Long-term consequence:

The next fetch-heavy cron addition in those slots can breach Cloudflare's per-trigger connection constraints or require urgent reshuffling.

Remediation:

Treat 5/6 slots as effectively full. Route new fetch-heavy work to different cron triggers, document slot ownership, and consider reducing parallel fetch pressure in the crowded slots.

### S006 - Low - Node Engine Policy Is Ahead of the LTS Validation Lane

Scope:

- `package.json:9`
- `worker/package.json:5`
- `vitest.config.ts:8`
- `scripts/run-node-lts-validation.mjs:5`
- `docs/testing.md:223`

Issue:

The primary package engine requires Node 25, while the repository also maintains a Node 24 LTS validation lane.

Long-term consequence:

Contributors and CI maintainers must understand why the primary engine is ahead of LTS. Without a documented requirement, this can create local setup friction and dependency update confusion.

Remediation:

Either align the primary engine with the supported LTS lane or document the concrete Node 25-only capability that justifies the requirement. Keep `run-node-lts-validation` as a compatibility proof if Node 25 remains primary.

### S007 - Investigation - Next.js Vendored PostCSS Advisory Requires Tracking

Scope:

- `package-lock.json`
- `package.json`
- `npm audit --json --audit-level=low`
- `npm run audit:deps`

Issue:

`npm audit` reports two moderate advisories for `postcss <8.5.10` through `next@16.2.4`, where Next vendors `postcss@8.4.31`. The repository's direct PostCSS users resolve to `8.5.10`, and the automated fix recommendation is not useful because it suggests an unrelated major downgrade path.

Long-term consequence:

Audit noise can hide future dependency issues if not tracked. Conversely, forcing overrides against a framework-vendored dependency can introduce unsupported behavior.

Remediation:

Track the advisory against the Next.js dependency and verify reachability in this static-export pipeline. If reachable, use a supported Next.js update or vendor guidance. If not reachable, document the risk acceptance so future audits are interpretable.

## 3. Cross-Cutting Concerns

### C001 - Operational Data Repair Scripts Combine Redundancy, Safety, and Maintainability Risk

Related findings: R007, Q004

The KYC blacklist reconciliation scripts duplicate remote D1 and fetch helper logic while also performing destructive production writes without dry-run/staging controls. Consolidating helpers should not be treated as a purely cosmetic cleanup; it should happen together with safety controls, schema validation, and operator-facing previews.

Priority: High

### C002 - Degraded and Compatibility Paths Carry Disproportionate Risk

Related findings: R001, Q002, S003

Legacy mint/burn sync-key compatibility, broad price-cache fallback, and the large CoinGecko fallback sync path all exist to keep the system resilient. That makes them important, but their current shape hides failures or keeps stale paths alive. Resilience code should be explicit, bounded, and heavily tested.

Priority: High

### C003 - Data Model Ownership Is Split Across Runtime and Metadata Modules

Related findings: R003, R004, S001

The stablecoin catalog, FX cadence rules, and blacklist event response shape all show versions of the same issue: domain data is represented in multiple places that look canonical. This increases drift risk and creates review ambiguity.

Priority: Medium

### C004 - Hotspot Waivers Are Managing Debt That Should Be Paid Down Incrementally

Related findings: Q005, Q006, S002, S003, S004

The hotspot ratchet is working: it exposes large modules and prevents new unmanaged growth. However, several waived hotspots sit on core runtime paths. The next step is targeted extraction with tests, not merely maintaining waivers.

Priority: Medium

### C005 - Validation Guardrails Are Strong but Their Implementation Is Itself Repetitive

Related findings: R002, Q009, S006

The repo has extensive validation scripts, but those scripts duplicate command-runner patterns and some use shell interpolation for git refs. Consolidating the runner and argument handling will make the guardrails easier to keep secure and consistent across Node 25 and Node 24 lanes.

Priority: Medium

## 4. Prioritized Remediation Roadmap

## Phase 1 - Quick Wins

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| Q001 | Move site-data cache write to `context.waitUntil()` with caught errors. | `functions/_site-data/[[path]].ts` | Small | None |
| Q009 | Replace interpolated git shell commands with `execFileSync`/`spawnSync` argument arrays. | `scripts/classify-deploy-changes.mjs`, `scripts/test-merge-gate.mjs`, `scripts/check-critical-coverage.mjs` | Small | None |
| Q008 | Defer object URL revocation after download click. | `src/components/share-button.tsx`, `src/lib/csv-export.ts` | Small | None |
| Q007 | Add parsed-shape guards for localStorage state. | `src/hooks/use-nav-collapse.ts`, `src/hooks/use-command-palette-history.ts` | Small | None |
| R004 | Replace local blacklist API record with shared/public response type. | `shared/types/market.ts`, `worker/src/lib/blacklist-api.ts`, `worker/src/api/blacklist.ts` | Small | None |
| R005 | Extract taxonomy hub page helper or factory. | `src/app/stablecoins/*/page.tsx` | Small | None |
| R006 | Remove commented strict bridge-validation block or implement a tested explicit policy. | `worker/src/lib/mint-burn-contracts.ts` | Small | Policy decision: audit-only vs strict |
| S007 | Document or ticket the Next/PostCSS advisory with reachability notes. | dependency audit docs or issue tracker | Small | Next.js advisory status |

## Phase 2 - Targeted Refactoring

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| Q002 | Restrict `getPriceCache()` fallback to known schema-drift errors and add tests. | `worker/src/lib/db-cache.ts`, worker tests | Small/Medium | None |
| R001 | Remove mint/burn legacy sync-key compatibility after verifying deployed migrations. | `worker/src/lib/mint-burn-pipeline/sync-state.ts`, migrations/tests | Medium | Confirm migration `0093` everywhere |
| R003 | Centralize FX cadence peg sets and helpers. | `worker/src/lib/fx-rate-state.ts`, `worker/src/lib/fx-source-metadata.ts` | Medium | None |
| R002 | Extract shared validation command runner. | `scripts/run-validate-postbuild.mjs`, `scripts/run-node-lts-validation.mjs`, `scripts/test-merge-gate.mjs`, new `scripts/lib/*` | Medium | Q009 recommended first |
| R007/Q004 | Consolidate remote D1 helpers and harden KYC reconciliation with dry-run, schema validation, and apply confirmation. | `worker/scripts/reconcile-blacklist-*.ts`, `scripts/lib/remote-d1.ts` or worker script helper | Medium | Operator workflow decision |
| Q003 | Add runtime guards and fixtures for Cloudflare D1 usage payloads. | `worker/src/lib/status/d1-usage.ts`, worker tests | Medium | None |
| Q005 | Split DEX discovery provider stages and staged-pool builder. | `worker/src/cron/dex-discovery/crawl-sources.ts` | Medium | Add baseline tests first |
| Q006 | Split ContagionGraph into derivation hook and presentational components. | `src/components/contagion-graph.tsx` | Medium | Add interaction tests first |

## Phase 3 - Structural Improvements

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| S004 | Split environment registry from markdown/example renderers. | `shared/lib/env-contract.ts`, adjacent shared modules, docs scripts | Medium | Preserve public exports during migration |
| S005 | Mark 5/6 cron slots as full and rebalance future fetch-heavy jobs. | `shared/lib/cron-jobs.ts`, `docs/worker-and-api-limits.md` | Medium | None |
| S002 | Extract depeg detection into hydration, pure decision engine, persistence, and repair phases. | `worker/src/cron/detect-depegs.ts`, worker tests | Large | Fixture tests for current decisions |
| S003 | Extract stablecoin fallback sync into typed phases aligned with progress stages. | `worker/src/cron/sync-stablecoins/fallback.ts`, worker tests | Large | Baseline fallback fixtures |

## Phase 4 - Strategic Overhauls

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| S001 | Complete migration to one stablecoin catalog source-of-truth and make generated artifacts read-only. | `shared/data/stablecoins/**`, `shared/lib/stablecoins/registry.ts`, catalog scripts, docs | Large | Migration plan and reviewer workflow |
| C002 | Establish a consistent error/fallback taxonomy for runtime resilience paths. | price cache, stablecoin sync, depeg detection, mint/burn sync state | Large | Phase 2 and Phase 3 extractions |
| S006 | Decide and document Node baseline strategy. | root/worker `package.json`, `vitest.config.ts`, `docs/testing.md`, validation scripts | Small/Medium | Toolchain compatibility review |

## 5. Appendices

## Appendix A - File-by-File Finding Index

| File or scope | Findings |
| --- | --- |
| `functions/_site-data/[[path]].ts` | Q001 |
| `scripts/check-critical-coverage.mjs` | Q009 |
| `scripts/check-stablecoin-data.ts` | S001 |
| `scripts/classify-deploy-changes.mjs` | Q009 |
| `scripts/lib/remote-d1.ts` | R007 |
| `scripts/lib/stablecoin-catalog-sources.ts` | S001 |
| `scripts/run-node-lts-validation.mjs` | R002, S006 |
| `scripts/run-validate-postbuild.mjs` | R002 |
| `scripts/test-merge-gate.mjs` | R002, Q009 |
| `shared/data/stablecoins/*.json` | S001 |
| `shared/data/stablecoins/coins/*.json` | S001 |
| `shared/data/stablecoins/coins.generated.json` | S001 |
| `shared/lib/env-contract.ts` | S004 |
| `shared/lib/stablecoins/registry.ts` | S001 |
| `shared/types/market.ts` | R004 |
| `src/app/stablecoins/backing/page.tsx` | R005 |
| `src/app/stablecoins/governance/page.tsx` | R005 |
| `src/app/stablecoins/infrastructure/page.tsx` | R005 |
| `src/components/contagion-graph.tsx` | Q006 |
| `src/components/share-button.tsx` | Q008 |
| `src/hooks/use-command-palette-history.ts` | Q007 |
| `src/hooks/use-nav-collapse.ts` | Q007 |
| `src/lib/csv-export.ts` | Q008 |
| `worker/migrations/0000_baseline.sql` | R001 |
| `worker/migrations/0093_cleanup_legacy_mint_burn_sync_keys.sql` | R001 |
| `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts` | R007, Q004 |
| `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` | R007 |
| `worker/src/api/blacklist.ts` | R004 |
| `worker/src/cron/detect-depegs.ts` | S002 |
| `worker/src/cron/dex-discovery/crawl-sources.ts` | Q005 |
| `worker/src/cron/sync-stablecoins/fallback.ts` | S003 |
| `worker/src/lib/blacklist-api.ts` | R004 |
| `worker/src/lib/db-cache.ts` | Q002 |
| `worker/src/lib/fx-rate-state.ts` | R003 |
| `worker/src/lib/fx-source-metadata.ts` | R003 |
| `worker/src/lib/mint-burn-contracts.ts` | R006 |
| `worker/src/lib/mint-burn-pipeline/sync-state.ts` | R001 |
| `worker/src/lib/status/d1-usage.ts` | Q003 |
| Root and worker `package.json` | S006 |
| `package-lock.json` | S007 |
| `shared/lib/cron-jobs.ts` | S005 |
| `docs/worker-and-api-limits.md` | S005 |
| `docs/testing.md` | S006 |

## Appendix B - Dependency Audit Summary

| Check | Result | Notes |
| --- | --- | --- |
| `npm run audit:deps` | Passed with advisory output | The repo gates high severity. Current advisory is moderate. |
| `npm audit --json --audit-level=low` | 2 moderate vulnerabilities | Both flow through Next's vendored `postcss@8.4.31`. |
| `npm ls next postcss --all` | Direct PostCSS users resolve to `8.5.10`; Next vendors `8.4.31` | Avoid unsupported overrides unless reachability is confirmed. |
| `npm outdated --json` | Several minor updates and a few majors available | Minor updates include Cloudflare workers types, Tailwind packages, React Query, Lucide, Vitest, Wrangler, Viem. Major updates include TypeScript 6 and ESLint 10. |
| Lockfile integrity | Present | `package-lock.json` exists and was used for audit. |

Notable outdated packages from the audit snapshot:

| Package | Current | Wanted/Latest | Suggested handling |
| --- | --- | --- | --- |
| `@cloudflare/workers-types` | `4.20260416.2` | `4.20260426.1` | Routine minor update with worker type-check. |
| `@tailwindcss/postcss` | `4.2.2` | `4.2.4` | Routine patch/minor update with build and visual smoke checks. |
| `@tanstack/react-query` | `5.99.0` | `5.100.5` | Routine minor update with hook tests. |
| `lucide-react` | `1.8.0` | `1.11.0` | Routine minor update with frontend build. |
| `tailwindcss` | `4.2.2` | `4.2.4` | Pair with Tailwind PostCSS update. |
| `vitest` | `4.1.4` | `4.1.5` | Routine patch update with `npm test`. |
| `wrangler` | `4.83.0` | `4.86.0` | Routine minor update with worker type-check and smoke. |
| `viem` | `2.48.0` | `2.48.4` | Routine patch update with worker tests touching chain reads. |
| `typescript` | `5.9.3` | `6.0.3` | Major. Defer to explicit migration plan. |
| `eslint` | `9.39.4` | `10.2.1` | Major. Defer to explicit migration plan. |

## Appendix C - Guardrail Snapshot

| Guardrail | Result |
| --- | --- |
| `npm run check:unused-code` | Passed. No dead internal modules or unused named exports found. |
| `npm run check:shared-cycles` | Passed. No circular dependencies found across shared/worker/src/src. |
| `npm run check:worker-boundary` | Passed. |
| `npm run check:hotspot-ratchet` | Passed. Existing hotspot waivers remain relevant. |
| `npm run check:env-contract` | Passed. |
| `npm run check:cron-connections` | Passed with three slots at 5/6 connection budget. |
| `npm run lint` | Passed. |
| `npm run typecheck` | Passed. |
| `cd worker && npx tsc --noEmit` | Passed. |
| `npm run check:verified-doc-links` | Passed. |
| `npm run check:doc-source-paths` | Passed. |

## Appendix D - Glossary

| Term | Meaning |
| --- | --- |
| Structural clone | Code with substantially identical logic but superficial naming or formatting differences. |
| Thin wrapper | A function or module that forwards to another abstraction without adding meaningful policy, validation, or clarity. |
| Schema drift fallback | Compatibility behavior that handles older database or API shapes during rolling deployments. |
| Degraded mode | Runtime behavior used when a primary dependency is unavailable or unhealthy. |
| Runtime boundary validation | Validation of external or persisted data at the point it enters trusted application logic. |
| Hotspot waiver | An explicit exception in the hotspot ratchet for a file/function that currently exceeds size or complexity thresholds. |
| Source of truth | The one authoritative place where a domain fact should be edited. |
| Blast radius | The amount of system behavior that can be affected by a change or bug in a module. |
| Idempotent operation | An operation that can be repeated safely without changing the outcome beyond the first application. |
