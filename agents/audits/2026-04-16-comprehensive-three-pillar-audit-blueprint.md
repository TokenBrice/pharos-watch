# Comprehensive Three-Pillar Codebase Audit Blueprint - 2026-04-16

Scope: `/home/ahirice/Documents/git/stablecoin-dashboard`

This report consolidates the three requested parallel audits:

- Agent 1, redundancy: `agents/audits/2026-04-16-agent-1-redundancy-audit.md`
- Agent 2, code quality: `agents/research/2026-04-16-agent-2-code-quality-audit.md`
- Agent 3, sustainability: `agents/research/2026-04-16-sustainability-maintainability-audit-agent3.md`

No product code was changed. Existing unrelated worktree changes were left untouched.

## Methodology And Inventory

Assumptions:

- "Entire application codebase" means tracked source, shared data/schema code, Worker runtime, Pages Functions, operational scripts, migrations, config, CI/CD, and verified documentation.
- Generated/ignored artifacts such as `node_modules/`, `.next/`, `out/`, `coverage/`, and nested local worktrees were excluded from product-code findings unless they affected repository hygiene.
- Redundancy findings use remediation priority rather than defect severity because duplication is not automatically a correctness bug.

Repository inventory:

- Tracked files: 3,187.
- Tracked TS/JS/CSS runtime and script surface under `src/`, `shared/`, `worker/src/`, `functions/`, and `scripts/`: 993 files, 200,714 lines.
- Major tracked areas: `worker/` 867 files, `agents/` 735, `src/` 660, `public/` 557, `shared/` 176, `scripts/` 60, `docs/` 60, `functions/` 16.
- Architecture: static Next.js 16 frontend exported to Cloudflare Pages, Cloudflare Pages Functions for site-data and ops-admin proxying, Cloudflare Worker plus D1 for public/site/ops API lanes, runtime-neutral shared logic in `shared/`.
- Required docs reviewed: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`.

Validation evidence:

- Passed locally: `npm run lint`, `npm run typecheck`, `cd worker && npx tsc --noEmit`, `npm test` (475 files, 4,668 tests), `npm run coverage:critical`, `npm audit --audit-level=high --json`, `npm run audit:deps -- --json`, `npm run check:unused-code`, `npm run check:duplicate-exports`, `npm run check:shared-cycles`, `npm run check:worker-boundary`, `npm run check:hotspot-ratchet`, `npm run check:sql-safety`, `npm run check:env-contract`, `npm run check:doc-sync`, `npm run check:cron-sync`, `npm run check:cron-connections`, `npm run check:migrations`, `npm run check:stablecoin-data`, `npm run check:verified-doc-links`, `npm run audit:pricing-providers`, `npm run check:doc-counts`.
- Agent 2 additionally ran full `npm run test:coverage`: 81.77% line coverage, 68.35% branch coverage.
- Local `npm run coverage:critical` passed the critical gate. Its all-file summary is lower (45.07% line coverage) because it only runs the critical subset, not the full suite.
- Not run: `npm run build`, UI smoke tests, live API smoke tests, Wrangler dev/deploy. This was an audit-only pass and no product code changed.

## 1. Executive Summary

### Findings Count

| Pillar | Critical | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Redundancy elimination | 0 | 0 | 7 | 6 | 13 |
| Code quality improvement | 0 | 1 | 7 | 2 | 10 |
| Sustainability and maintainability | 0 | 1 | 3 | 3 | 7 |
| Total | 0 | 2 | 17 | 11 | 30 |

Note: redundancy "severity" is remediation priority, not defect severity.

### Top 5 Findings

1. Q1 - Portfolio reserve exposure can emit `NaN` for zero-sum reserve percentages.
2. S1 - Worker operational scripts are outside typecheck coverage and one already has stale private imports.
3. Q2 - Portfolio amount validation differs across URL parsing, storage, and live actions.
4. Q4 - Direct DEX API fetchers rely on assertions at external JSON boundaries.
5. S2 - Deploy-impact classification omits supporting CI/guardrail files, allowing some deploy logic changes to skip production validation.

### Health Ratings

| Pillar | Rating | Justification |
| --- | ---: | --- |
| Redundancy elimination | 8.5/10 | Production-source duplication is very low: jscpd weak production scan found 10-11 clones and about 0.08% duplicated lines. Built-in unused-code, duplicate-export, boundary, and cycle checks all pass. Remaining issues are local clusters and some thin indirection. |
| Code quality improvement | 7.5/10 | Lint, typecheck, worker typecheck, tests, SQL safety, and critical coverage pass. The main drag is a small set of real data-integrity gaps, provider-boundary hardening needs, and persistent large functions/components. |
| Sustainability and maintainability | 8.0/10 | Architecture is coherent, CI/CD is strong, docs are guarded, migrations replay, and dependency audit is clean. The biggest maintainability risks are unsupported worker scripts, deploy-impact classifier drift, and deferred hotspot debt. |

Technical debt profile:

- Direct significant findings involve roughly 50-70 source/config files out of the 993 tracked runtime/script files, about 5-7% of the active code surface.
- Blast radius is larger than raw file count because findings cluster in high-change domains: pricing, DEX liquidity, depeg/DEWS, portfolio/stress tools, ops/deploy tooling, and route/API contracts.
- Significant technical debt affects an estimated 15-20% of the codebase areas most likely to be touched by future feature work.

## 2. Findings By Pillar

### Redundancy Elimination

#### R1 - Medium - Price-result application loop is duplicated between primary and GeckoTerminal probe passes

Locations:

- `worker/src/cron/sync-stablecoins/pricing.ts:323-356`
- `worker/src/cron/sync-stablecoins/pricing.ts:397-425`

Problem:

`applyPrimaryPriceResults()` and `applyGtProbeResults()` both destructure the same input shape, iterate over `assets`, and call `applyPriceResultForAsset()` with mostly identical fields. They differ in labels/options and primary-pass supply-source defaulting.

Remediation:

Extract an internal `applyPriceResultsForAssets(input, options)` helper with options for rejection label, required candidate source, stamping behavior, and optional `afterAssetApplied`. Keep the public stage-specific functions for readability.

#### R2 - Medium - CoinGecko/commodity supply-history backfill branches repeat the same call and result handling

Locations:

- `worker/src/api/backfill-supply-history.ts:245-265`
- `worker/src/api/backfill-supply-history.ts:268-291`

Problem:

Adjacent branches call `backfillCommodity(db, meta.id, {...})` with the same options, then update `totalRows` and `errors` the same way.

Remediation:

Extract `runMarketChartBackfill(meta, errorLabel)` or compute a single `usesCoinGeckoMarketChart` predicate while preserving distinct admin error labels.

#### R3 - Medium - DEWS methodology diagram duplicates signal and threat-band markup

Locations:

- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:254-321`
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:324-388`

Problem:

Desktop and mobile DEWS diagrams repeat the same eight signal weights and five threat bands, with only minor label differences.

Remediation:

Move signal and band definitions to local arrays and render through shared leaf card components. Keep separate layout wrappers only where responsive structure requires it.

#### R4 - Medium - Optional yield candidate resolution repeats append/gate logic for direct IDs and resolved IDs

Locations:

- `worker/src/cron/yield-sync/resolve-helpers.ts:141-163`
- `worker/src/cron/yield-sync/resolve-helpers.ts:176-194`

Problem:

Both branches fetch metadata, run lending-opportunity size gates, check duplicates, and push the same `ResolvedYieldEntry` shape.

Remediation:

Extract `appendYieldCandidateIfEligible(entry, stablecoinId, context)` returning a small status enum so counters remain explicit.

#### R5 - Medium - EVM JSON-RPC fallback loop is implemented twice

Locations:

- `worker/src/lib/evm-rpc.ts:60-115`
- `worker/src/lib/evm-rpc.ts:152-207`

Problem:

`fetchJsonRpcResult()` and `fetchEvmCallHexAtBlock()` both implement RPC URL fallback, retry handling, JSON-RPC error parsing, failure collection, and logging. The second loop mainly exists to reject invalid or empty hex.

Remediation:

Extend `fetchJsonRpcResult()` with an optional `acceptResult` or `normalizeResult` callback. Use it from `fetchEvmCallHexAtBlock()` to reject `"0x"` without reimplementing fallback behavior.

#### R6 - Medium - Blacklist sync repeats post-fetch row processing and counter accumulation

Locations:

- `worker/src/cron/sync-blacklist.ts:203-224`
- `worker/src/cron/sync-blacklist.ts:268-289`

Problem:

Tron and EVM branches both call `processFetchedBlacklistRows()` with the same supporting arguments and then perform seven identical counter updates.

Remediation:

Extract `processRowsAndAccumulate({ chainLabel, resultRows, config, ... })` or a typed accumulator helper. Keep chain-specific sync-state advancement outside the helper.

#### R7 - Low - One-off depeg repair scripts duplicate SQL mutation batching

Locations:

- `scripts/fix-commodity-depeg-median.ts:145-190`
- `scripts/fix-non-usd-depeg-fx.ts:137-180`
- `docs/scripts.md:49-50`

Problem:

Both repair scripts split rows into delete/update/unchanged buckets, build batched `DELETE` statements, build per-row updates, and execute through `d1BatchExec()`.

Remediation:

If the scripts remain active, extract shared `buildDepegRepairStatements()` and `executeDepegRepair()` helpers under `scripts/lib/`. If production repair history confirms they are obsolete, retire them and update `docs/scripts.md`.

#### R8 - Medium - API route paths are partially duplicated between path builders and endpoint definitions

Locations:

- `shared/lib/api-endpoints/paths.ts:14-76`
- `shared/lib/api-endpoints/definitions.ts:210-218`
- `shared/lib/api-endpoints/definitions.ts:220-228`
- `shared/lib/api-endpoints/definitions.ts:247-254`
- `shared/lib/api-endpoints/definitions.ts:266-284`
- `shared/lib/api-endpoints/definitions.ts:316-344`
- `shared/lib/api-endpoints/definitions.ts:355-362`
- `shared/lib/api-endpoints/definitions.ts:414-423`
- `shared/lib/api-endpoints/definitions.ts:528-535`
- `shared/lib/api-endpoints/definitions.ts:617-629`

Problem:

The shared API endpoint module has both `API_PATHS` builders and endpoint definitions. Several definitions hard-code route bases/probes that also exist in `API_PATHS`, creating drift risk.

Remediation:

Choose one source per endpoint key. Either use `API_PATHS` consistently inside definitions or derive static builders from `ENDPOINT_DEFINITIONS`. Add a path-consistency check if both surfaces remain.

#### R9 - Low - Invariant CSS tokens are duplicated in light and dark semantic token blocks

Locations:

- `src/styles/tokens/semantic.css:160-175`
- `src/styles/tokens/semantic.css:279-294`

Problem:

Sidebar dimensions, motion timings, easing values, and theme transition duration are duplicated identically in `:root` and `.dark`.

Remediation:

Keep invariant dimension/motion tokens in `:root`; leave `.dark` only for theme-specific overrides. Pair with visual smoke checks.

#### R10 - Low - Thin frontend origin wrapper adds indirection over shared runtime origins

Locations:

- `src/lib/site-config.ts:1`
- Representative consumers: `src/app/layout.tsx:13`, `src/app/page.tsx:9`, `src/app/sitemap.ts:8`, `src/app/robots.ts:2`, `src/app/stablecoin/[id]/page.tsx:11`

Problem:

`src/lib/site-config.ts` only re-exports `SITE_ORIGIN` and `API_ORIGIN` from `@shared/lib/runtime-origins` as `SITE_URL` and `API_URL`.

Remediation:

Either remove the wrapper and import from `@shared/lib/runtime-origins`, or keep it as an intentional frontend semantic alias with a short comment.

#### R11 - Low - Test suite contains concentrated fixture/setup duplication

Locations:

- `scripts/__tests__/smoke-ops.test.ts:107-184`
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:26-259`
- `worker/src/lib/__tests__/depeg-helpers.test.ts:1-135`
- `worker/src/lib/__tests__/depeg-trust-policy.test.ts:1-103`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts:13-40`
- `scripts/check-redemption-backstops.ts:20-46`

Problem:

Full-repo clone detection showed most duplication is in tests and validation scaffolding. This is not currently a product bug, but it raises fixture drift and review-noise cost.

Remediation:

Extract local test builders only where they clarify intent: smoke ops proxy helpers, reserve adapter config factories, and a shared redemption-backstop family metadata helper if script/test boundaries should stay identical.

#### R12 - Low - Local generated artifacts and nested worktrees contaminate naive full-repo scans

Locations:

- `.next/`
- `worktrees/`
- `node_modules/`
- `out/`
- `coverage/`
- `output/`
- `agents/jscpd-2026-04-16/jscpd-report.json`

Problem:

Large untracked generated directories and local worktree clones can make "full repository" scans count cloned/generated source as duplication.

Remediation:

Keep generated artifacts out of audit scope. Move long-lived worktrees outside the repo root or ensure audit scripts exclude `worktrees/**` and `.worktrees/**`. Do not delete user worktrees without confirmation.

#### R13 - Low - Local install tree has extraneous packages, but package metadata has no confirmed redundant dependency

Locations:

- `package.json:70-99`
- `worker/package.json:11-19`
- local `node_modules/@emnapi/*` and `node_modules/@tybys/wasm-util`

Problem:

Declared dependencies appear justified; depcheck false positives are explained by CSS imports, TS aliases, and Vitest internals. The concrete issue is local `node_modules` state with four extraneous packages.

Remediation:

Run `npm ci` when a clean dependency tree is needed. Do not remove declared dependencies from package metadata based on depcheck alone.

### Code Quality Improvement

#### Q1 - High - Portfolio reserve exposure can produce `NaN` for zero-sum reserve percentages

Locations:

- `src/lib/portfolio-analysis.ts:199-223`
- `src/lib/portfolio-analysis.ts:233-241`
- `src/lib/portfolio-analysis.ts:266-270`
- Contrast guard: `shared/lib/report-card-resilience.ts:99-106`

Problem:

`computeUpstreamExposure()` divides by `totalPct` while allocating reserve slices. If all relevant reserve percentages are zero, or stablecoin filtering leaves a zero-sum remainder, user-facing exposure can become `NaN`.

Remediation:

Add a `totalPct <= 0` guard before allocation and fall back to the backing-level collateral bucket. Add tests for zero-sum reserves, mixed zero/nonzero reserves, stablecoin-slice filtering, and unknown metadata.

#### Q2 - Medium - Portfolio amount validation is inconsistent across URL, storage, and live actions

Locations:

- `src/lib/portfolio-codec.ts:21-26`
- `src/lib/portfolio-codec.ts:79-86`
- `src/hooks/use-portfolio.ts:116-130`
- `src/app/portfolio/client.tsx:100-103`
- `src/app/portfolio/client.tsx:440-443`

Problem:

URL holdings require finite positive amounts; storage only checks number and positive, allowing `Infinity`; UI actions can introduce zero-amount rows.

Remediation:

Introduce one validator/coercer such as `normalizePortfolioHolding(value): PortfolioHolding | null` and use it for URL parsing, storage parsing, `addCoin`, and `setAmount`. Decide whether zero rows are UI-only drafts or valid persisted holdings.

#### Q3 - Medium - Stablecoin metadata schemas accept domain-invalid numeric values

Locations:

- `shared/lib/stablecoins/schema.ts:54-58`
- `shared/lib/stablecoins/schema.ts:60-64`
- `shared/lib/stablecoins/schema.ts:66-73`
- `scripts/check-stablecoin-data.ts:86-139`

Problem:

Curated data schemas validate numeric type but not core numeric invariants: integer/sane decimals, dependency weights in `[0, 1]`, and nonnegative reserve percentages.

Remediation:

Tighten Zod schemas with `.int().min().max()` where domain limits are clear. Add aggregate semantic checks in `check-stablecoin-data.ts`, documenting intentional overcollateralized reserve totals.

#### Q4 - Medium - Direct DEX API fetchers rely on assertions at external JSON boundaries

Locations:

- `worker/src/cron/dex-liquidity/fetch-meteora.ts:45-64`
- `worker/src/cron/dex-liquidity/fetch-meteora.ts:90-116`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts:80-107`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts:120-135`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts:37-60`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts:80-90`
- `worker/src/cron/dex-liquidity/orchestrator-phases.ts:324-352`

Problem:

Provider fetchers degrade on HTTP failures and some malformed shapes, but invalid JSON, `null` roots, and missing nested token objects can throw before provider-specific degraded results are produced.

Remediation:

Add `readDexApiJson()` that catches JSON parsing failures. Validate root/nested provider shapes with type guards or small Zod schemas. Add tests for invalid JSON text, `null`, and missing nested token objects for Meteora, Balancer, and Raydium.

#### Q5 - Medium - Cron/provider decision functions remain high-complexity hotspots

Locations:

- `worker/src/cron/dex-discovery/crawl-sources.ts:58-486`
- `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:224-632`
- `worker/src/cron/confirm-pending-depegs.ts:63-400`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:459-789`

Problem:

These branch-heavy functions mix orchestration, provider-specific parsing, policy, observability, and persistence-adjacent behavior.

Remediation:

Do not rewrite wholesale. Extract one pure decision/stage at a time with characterization tests: provider stages for `crawlCoin`, previous-baseline/drift sections for DEX metadata, final promote/delete/keep decision for pending depegs, and provider fan-out versus consensus assembly for primary prices.

#### Q6 - Medium - Large client components combine state, derivation, and rendering

Locations:

- `src/components/contagion-graph.tsx:44-641`
- `src/components/stablecoin-detail/hero-card.tsx:271-742`
- `src/components/kpi-bar.tsx:281-614`
- `src/components/command-palette.tsx:43-445`
- `src/app/yield/client.tsx:83-428`
- `src/app/status/client.tsx:55-408`
- `src/components/status/api-keys-panel.tsx:147-512`

Problem:

These components combine derivation, interaction state, keyboard/pointer handling, filtering/sorting, conditional copy, and JSX rendering.

Remediation:

Extract pure view-model hooks and focused subcomponents opportunistically when behavior is touched. Start with pure transforms because they are easiest to test without rendering the full route.

#### Q7 - Medium - Portfolio and stress-test risk tools have insufficient behavioral coverage

Locations:

- `src/hooks/use-portfolio.ts:101-243`
- `src/lib/portfolio-analysis.ts:180-309`
- `src/hooks/use-stress-test.ts:145-343`
- `src/hooks/__tests__/use-stress-test.test.ts:1-20`
- `src/__tests__/portfolio-categorize.test.ts:83-178`

Problem:

Existing tests cover categorization and URL parsing more than weighted scoring, persistence/share round-trips, upstream exposure, and stress propagation outputs. This gap overlaps with Q1 and Q2.

Remediation:

Add pure tests for `computeUpstreamExposure`, `usePortfolio` normalization/storage/share behavior, and `useStressTest` target derivation, grades, affected IDs, sorting, and no-data states.

#### Q8 - Medium - Oversized test suites make failures expensive to localize

Locations:

- `worker/src/cron/__tests__/sync-yield-data.test.ts:320-3220`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts:341-2728`
- `worker/src/api/__tests__/status.test.ts:1-2511`
- `worker/src/cron/__tests__/enrich-prices.test.ts:1-2162`

Problem:

Several critical suites are multi-thousand-line files with broad shared setup and mutable mocks. Coverage is valuable, but failures are harder to localize.

Remediation:

Split by behavior family without changing assertions: provider failures, cache publication, fallback behavior, persistence pruning, metadata assertions. Move repeated mock builders to named local helpers.

#### Q9 - Low - API fetch documentation comment contradicts strict validation behavior

Locations:

- `src/lib/api.ts:153-180`
- `src/lib/api.ts:196-198`
- `src/lib/__tests__/api-fetch-contracts.test.ts:49-80`

Problem:

The `apiFetch` comment says schema validation warns on mismatch, but the implementation throws by default when a schema is supplied. Warning is explicit opt-in with `contractMode: "warn"`.

Remediation:

Update the comment to state strict is default and warn is opt-in.

#### Q10 - Low - Analytics script interpolates an environment value directly into inline JavaScript

Location:

- `src/app/layout.tsx:85-93`

Problem:

`NEXT_PUBLIC_GA_ID` is build-time config, not user input, but it is interpolated directly into an inline script string.

Remediation:

Serialize with `JSON.stringify(gaId)` and optionally validate the GA ID with `/^G-[A-Z0-9]+$/` before emitting scripts.

### Sustainability And Maintainability

#### S1 - High - Worker operational scripts are outside typecheck coverage and already have stale private imports

Locations:

- `tsconfig.typecheck.json:3-18`
- `worker/tsconfig.json:20-21`
- `docs/scripts.md:5`
- `docs/scripts.md:44-53`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts:18-37`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts:274`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts:406`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts:593`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts:729`

Issue:

Root typecheck excludes all `worker/`, and worker typecheck includes `worker/src/**` but not `worker/scripts/**`. One documented operational repair script already imports stale private helper surfaces.

Remediation:

Add `worker/tsconfig.scripts.json` including `worker/scripts/**/*.ts`, `worker/src/**/*.ts`, and `../shared/**/*.ts`. Add `cd worker && npx tsc --noEmit -p tsconfig.scripts.json` to CI/local validation. Fix stale imports or expose stable admin-backfill helper contracts.

#### S2 - Medium - Deploy-impact classification omits supporting CI/guardrail code

Locations:

- `scripts/lib/deploy-impact.mjs:18-49`
- `scripts/classify-deploy-changes.mjs:49-68`
- `.github/workflows/deploy-cloudflare.yml:17-53`

Issue:

Changes to deploy-impact logic, setup-workspace action, and some validate scripts can be classified as non-deploy-impacting, allowing the production workflow to skip.

Remediation:

Add CI infra prefixes/exact files to deploy-impact classification, including `scripts/lib/`, `.github/actions/`, and validate scripts invoked by `validate-ci.yml`. Add regression tests for those paths.

#### S3 - Medium - Deferred hotspot debt remains large in several change-heavy modules

Locations:

- `scripts/lib/hotspot-ratchet-waivers.json:2-20`
- `scripts/lib/hotspot-ratchet-waivers.json:34-48`
- `scripts/lib/hotspot-ratchet-waivers.json:78-88`
- `scripts/lib/hotspot-ratchet-baseline.json:242-252`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `src/lib/coverage.ts`
- `src/app/stability-index/client.tsx`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `src/components/contagion-graph.tsx`

Issue:

The hotspot ratchet is working, but several deferred/queued modules still mix policy, orchestration, rendering, and side effects.

Remediation:

Treat waivers as a refactor queue. Prioritize Worker-side hotspots first, then UI route clients via view-model extraction and pure transforms.

#### S4 - Medium - Fetch-heavy cron lanes have little declared connection headroom

Locations:

- `docs/worker-and-api-limits.md:48-60`
- `shared/lib/cron-jobs.ts:78-80`
- `scripts/check-cron-connection-budget.ts:3-41`
- `shared/lib/cron-jobs.ts:138-165`
- `shared/lib/cron-jobs.ts:239-264`
- `shared/lib/cron-jobs.ts:359-392`

Issue:

Several trigger slots currently sit at 5/6 or 4/6 declared connection budget. Sequential handlers reduce actual peaks, but the model leaves little room for new providers.

Remediation:

Add a warning threshold above 4/6. Model both declared total and peak concurrent connections for sequential slots. Require new provider PRs to state trigger slot, peak fetch count, timeout, and fallback behavior.

#### S5 - Low - Site-data fallback documentation is semantically inconsistent

Locations:

- `docs/api-reference.md:183`
- `worker/wrangler.toml:15-18`
- `worker/wrangler.toml:57-62`
- `docs/deployment-process.md:220-226`
- `docs/architecture.md:682-686`

Issue:

The API reference still carries rollout-era fallback wording even though production has configured `site-api.pharos.watch` and `PUBLIC_API_AUTH_MODE = "enforce"`.

Remediation:

Update API reference and deployment docs so production requires explicit `SITE_API_ORIGIN`; limit fallback language to preview/local rehearsal.

#### S6 - Low - Package-manager reproducibility is weaker than the rest of CI

Locations:

- `.nvmrc:1`
- `package.json:9-10`
- `worker/package.json:5-6`
- `.npmrc:1`

Issue:

Node ranges and exact saves are configured, but there is no root `packageManager` field and local `engine-strict` is false.

Remediation:

Add `packageManager`, for example `npm@<chosen-ci-version>`, and document the intended npm major. Consider `engine-strict=true` if unsupported local Node versions are common.

#### S7 - Low - Direct dependency drift is low-risk but includes deploy/runtime tooling

Locations:

- `package.json:59-103`
- `worker/package.json:12-25`
- `.github/dependabot.yml:1-28`

Issue:

`npm audit` is clean, but patch/minor drift includes Worker deploy/runtime tooling (`wrangler`, `@cloudflare/workers-types`, `viem`).

Remediation:

Take patch/minor updates in small batches, prioritizing Worker deploy tooling. Treat TypeScript 6, ESLint 10, and Node type major drift as planned migrations.

## 3. Cross-Cutting Concerns

### C1 - Portfolio and stress-test data integrity

Connected findings: Q1, Q2, Q7, Q3.

The portfolio/stress features have a real numeric correctness bug, inconsistent amount validation, and insufficient behavioral tests. Strengthening curated numeric schemas helps reduce upstream invalid input into the same analytics surface.

Priority: High. Fix Q1 and Q2 first, then add Q7 coverage and Q3 schema invariants.

### C2 - Worker operational reliability

Connected findings: S1, R7, Q8, Q5.

Operational repair scripts are documented but not typechecked, while some repair logic duplicates batching helpers and critical Worker tests are large. This creates an incident-time risk: the runtime may be healthy while emergency tools have drifted.

Priority: High. Add worker-script typecheck before refactoring scripts.

### C3 - Pricing, DEX, and provider-boundary complexity

Connected findings: R1, R5, Q4, Q5, S3, S4.

Pricing and DEX systems have duplication, complex provider orchestration, external JSON-boundary hardening needs, and limited cron connection headroom. These are related because new providers currently increase code complexity and capacity pressure at the same time.

Priority: Medium-high. Harden provider boundaries before adding providers; then split provider-family stages.

### C4 - Route/API contract centralization and deploy validation

Connected findings: R8, S2, Q9, S5.

The API route contract is strong but has partial route path duplication and a stale comment/doc inconsistency. Deploy-impact classification also misses files that own validation behavior.

Priority: Medium. Add deploy-impact tests first, then reduce endpoint path duplication.

### C5 - Frontend and docs presentation hotspots

Connected findings: R3, R9, R10, R11, Q6, S3.

Large client components and long methodology sections mostly affect maintainability, not correctness. The common pattern is data/model and markup living together.

Priority: Medium. Do opportunistic view-model extraction rather than broad rewrites.

### C6 - Repository hygiene and reproducibility

Connected findings: R12, R13, S6, S7.

Local generated artifacts, extraneous installs, no package-manager pin, and minor deploy-tooling drift do not block current work, but they reduce audit repeatability and local/CI consistency.

Priority: Low. Clean and pin incrementally.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| Q9 | Fix `apiFetch` comment to reflect strict-by-default validation. | `src/lib/api.ts` | Small | None |
| Q10 | Serialize and optionally validate GA ID before inline script emission. | `src/app/layout.tsx` | Small | None |
| R2 | Merge duplicate supply-history market-chart backfill branches. | `worker/src/api/backfill-supply-history.ts` | Small | Existing tests |
| R4 | Extract optional yield candidate append/gate helper. | `worker/src/cron/yield-sync/resolve-helpers.ts` | Small | Existing yield tests |
| R6 | Extract blacklist post-fetch counter accumulation helper. | `worker/src/cron/sync-blacklist.ts` | Small | Existing blacklist tests |
| R9 | Move invariant motion/sidebar tokens out of `.dark`. | `src/styles/tokens/semantic.css` | Small | Visual smoke recommended |
| S5 | Align site-data fallback wording across docs. | `docs/api-reference.md`, `docs/deployment-process.md` | Small | None |
| S6 | Add root `packageManager` and npm policy note. | `package.json`, docs if desired | Small | Team chooses npm version |
| S7 | Apply patch/minor deploy-tooling updates. | `package.json`, `package-lock.json`, `worker/package.json` | Small | Lint/typecheck/tests/smoke |
| R13 | Clean local dependency tree when needed. | local `node_modules` | Small | None |

### Phase 2 - Targeted Refactoring

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| Q1 | Add zero-sum reserve guard and tests. | `src/lib/portfolio-analysis.ts`, tests | Medium | None |
| Q2 | Add shared portfolio holding normalization. | `src/lib/portfolio-codec.ts`, `src/hooks/use-portfolio.ts`, `src/app/portfolio/client.tsx` | Medium | Q1 test patterns |
| Q7 | Add portfolio/stress behavioral coverage. | `src/hooks/use-portfolio.ts`, `src/hooks/use-stress-test.ts`, `src/lib/portfolio-analysis.ts` | Medium | Q1/Q2 |
| Q3 | Tighten stablecoin numeric schemas and validator aggregate checks. | `shared/lib/stablecoins/schema.ts`, `scripts/check-stablecoin-data.ts` | Medium | Data review |
| Q4 | Add safe JSON helper and malformed provider tests. | DEX direct API fetchers and tests | Medium | None |
| R1 | Extract shared price-result application helper. | `worker/src/cron/sync-stablecoins/pricing.ts` | Medium | Sync-stablecoins tests |
| R5 | Consolidate EVM RPC fallback loops via callback predicate. | `worker/src/lib/evm-rpc.ts` | Medium | EVM/reserve tests |
| R8 | Reduce endpoint path duplication or add consistency check. | `shared/lib/api-endpoints/*` | Medium | API contract tests |
| S1 | Add worker-script typecheck and fix stale imports. | `worker/scripts/*`, `worker/tsconfig.scripts.json`, CI scripts | Medium | None |
| S2 | Expand deploy-impact classification and tests. | `scripts/lib/deploy-impact.mjs`, `scripts/__tests__/classify-deploy-changes.test.ts` | Medium | None |
| S4 | Add cron budget warning threshold and peak connection model. | `scripts/check-cron-connection-budget.ts`, `shared/lib/cron-jobs.ts`, docs | Medium | None |

### Phase 3 - Structural Improvements

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| Q5 | Split one provider/decision stage at a time from cron hotspots. | DEX discovery, DEX metadata, pending depegs, primary pricing | Large | Characterization tests |
| Q6 | Extract view-model hooks and pure transforms from large client components. | `contagion-graph`, `hero-card`, `kpi-bar`, `command-palette`, `yield`, `status`, `api-keys-panel` | Large | Stable component tests |
| Q8 | Split oversized critical test suites by behavior family. | Worker cron/API test suites | Medium/Large | Helper extraction |
| R3 | Data-drive methodology DEWS diagram cards. | `pegscore-dews-section.tsx` | Medium | Visual/test pass |
| R11 | Extract high-value test fixture builders. | smoke ops, reserve adapters, depeg trust, redemption checks | Medium | Preserve scenario clarity |
| S3 | Work through the hotspot waiver queue with explicit module owners. | pricing, alerts, PSI, coverage, graph | Large | Q5/Q6 staging |

### Phase 4 - Strategic Overhauls

No full re-architecture is warranted. The Worker/Page/shared architecture is coherent, boundary and cycle checks pass, CI/CD is mature, docs have guardrails, and migrations are verified.

Strategic work should be limited to long-running decompositions:

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| S3/Q5 | Continue provider-family decomposition for pricing and DEX systems. | Worker pricing/DEX cron surfaces | Large | Phase 2 provider hardening |
| S3/Q6 | Continue frontend route-client decomposition. | PSI, coverage, dependency map, status/admin UI | Large | Phase 3 view-model extraction |
| S1/R7 | Establish supported operational-script API surfaces. | `worker/scripts`, `worker/src/lib/admin-*` | Large | Worker-script typecheck in place |

## 5. Appendices

### Appendix A - File-By-File Finding Index

| File or scope | Findings |
| --- | --- |
| `src/lib/portfolio-analysis.ts` | Q1, Q7 |
| `src/lib/portfolio-codec.ts` | Q2 |
| `src/hooks/use-portfolio.ts` | Q2, Q7 |
| `src/hooks/use-stress-test.ts` | Q7 |
| `src/app/portfolio/client.tsx` | Q2 |
| `shared/lib/stablecoins/schema.ts` | Q3 |
| `scripts/check-stablecoin-data.ts` | Q3 |
| `worker/src/cron/dex-liquidity/fetch-meteora.ts` | Q4 |
| `worker/src/cron/dex-liquidity/fetch-balancer.ts` | Q4 |
| `worker/src/cron/dex-liquidity/fetch-raydium.ts` | Q4 |
| `worker/src/cron/dex-liquidity/orchestrator-phases.ts` | Q4 |
| `worker/src/cron/dex-discovery/crawl-sources.ts` | Q5 |
| `worker/src/cron/dex-liquidity/orchestrator-metadata.ts` | Q5, S3 |
| `worker/src/cron/confirm-pending-depegs.ts` | Q5 |
| `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | Q5, S3 |
| `src/components/contagion-graph.tsx` | Q6, S3 |
| `src/components/stablecoin-detail/hero-card.tsx` | Q6 |
| `src/components/kpi-bar.tsx` | Q6 |
| `src/components/command-palette.tsx` | Q6 |
| `src/app/yield/client.tsx` | Q6 |
| `src/app/status/client.tsx` | Q6 |
| `src/components/status/api-keys-panel.tsx` | Q6 |
| `worker/src/cron/__tests__/sync-yield-data.test.ts` | Q8 |
| `worker/src/cron/__tests__/sync-stablecoins.test.ts` | Q8 |
| `worker/src/api/__tests__/status.test.ts` | Q8 |
| `worker/src/cron/__tests__/enrich-prices.test.ts` | Q8 |
| `src/lib/api.ts` | Q9 |
| `src/app/layout.tsx` | Q10, R10 |
| `worker/src/cron/sync-stablecoins/pricing.ts` | R1 |
| `worker/src/api/backfill-supply-history.ts` | R2 |
| `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx` | R3 |
| `worker/src/cron/yield-sync/resolve-helpers.ts` | R4 |
| `worker/src/lib/evm-rpc.ts` | R5 |
| `worker/src/cron/sync-blacklist.ts` | R6 |
| `scripts/fix-commodity-depeg-median.ts` | R7 |
| `scripts/fix-non-usd-depeg-fx.ts` | R7 |
| `shared/lib/api-endpoints/paths.ts` | R8 |
| `shared/lib/api-endpoints/definitions.ts` | R8 |
| `src/styles/tokens/semantic.css` | R9 |
| `src/lib/site-config.ts` | R10 |
| `scripts/__tests__/smoke-ops.test.ts` | R11 |
| `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts` | R11 |
| `worker/src/lib/__tests__/depeg-helpers.test.ts` | R11 |
| `worker/src/lib/__tests__/depeg-trust-policy.test.ts` | R11 |
| `shared/lib/__tests__/redemption-backstop-consistency.test.ts` | R11 |
| `scripts/check-redemption-backstops.ts` | R11 |
| `.next/`, `worktrees/`, `node_modules/`, `out/`, `coverage/`, `output/` | R12 |
| `package.json` | R13, S6, S7 |
| `worker/package.json` | R13, S6, S7 |
| `tsconfig.typecheck.json` | S1 |
| `worker/tsconfig.json` | S1 |
| `worker/scripts/repair-non-usd-fiat-depeg-history.ts` | S1 |
| `scripts/lib/deploy-impact.mjs` | S2 |
| `scripts/classify-deploy-changes.mjs` | S2 |
| `.github/workflows/deploy-cloudflare.yml` | S2 |
| `scripts/lib/hotspot-ratchet-waivers.json` | S3 |
| `scripts/lib/hotspot-ratchet-baseline.json` | S3 |
| `shared/lib/cron-jobs.ts` | S4 |
| `scripts/check-cron-connection-budget.ts` | S4 |
| `docs/worker-and-api-limits.md` | S4 |
| `docs/api-reference.md` | S5 |
| `docs/deployment-process.md` | S5 |
| `docs/architecture.md` | S5 |
| `.nvmrc`, `.npmrc` | S6 |
| `.github/dependabot.yml` | S7 |

### Appendix B - Dependency Audit Summary

| Package / area | Current | Latest observed | Audit status | Recommendation |
| --- | ---: | ---: | --- | --- |
| Production dependency advisories | n/a | n/a | 0 vulnerabilities via `npm audit --omit=dev` | No action |
| Full dependency advisories | n/a | n/a | 0 vulnerabilities via full `npm audit` | No action |
| `@cloudflare/workers-types` | 4.20260414.1 | 4.20260415.1 | Patch drift | Update with Worker typecheck/smoke |
| `wrangler` | 4.82.2 | 4.83.0 | Patch drift | Prioritize because deploy path depends on it |
| `viem` | 2.47.17 | 2.48.0 | Minor drift | Update with Worker RPC/contract tests |
| `eslint-config-next` | 16.2.3 | 16.2.4 | Patch drift | Update with lint |
| `prettier` | 3.8.2 | 3.8.3 | Patch drift | Low priority |
| `@types/node` | 22.19.17 | 25.6.0 | Major drift | Intentional while Node 22 types remain canonical |
| `eslint` | 9.39.4 | 10.2.0 | Major drift | Planned migration only |
| `typescript` | 5.9.3 | 6.0.2 | Major drift | Planned migration only; check Next/Worker compatibility |
| Local extraneous packages | `@emnapi/*`, `@tybys/wasm-util` | n/a | Local install drift | Run `npm ci` for a clean tree |
| Lockfile | v3 | n/a | `npm ci --dry-run` passed in agent audit | No immediate action |

### Appendix C - Glossary

| Term | Meaning |
| --- | --- |
| Structural clone | Code with the same logic and shape but superficial differences in names, formatting, or constants. |
| Thin wrapper | A module/function that only renames or forwards another API without adding validation, policy, or useful domain semantics. |
| Boundary validation | Runtime validation at a system edge such as JSON from an external provider, environment variables, persisted storage, or user-supplied URLs. |
| Characterization test | A test that captures current behavior before refactoring, so the refactor can be checked against known outputs. |
| Hotspot | A file or function with high line count, branch count, or change frequency that raises maintenance risk. |
| Guardrail | A CI/local check that prevents a known class of regression, such as cycles, unsafe SQL interpolation, doc drift, or cron budget overrun. |
| Deploy-impact classification | The script logic that decides whether a changed file should run the production validation/deploy workflow. |
| Connection budget | The repo's six-connection-per-cron-trigger operating assumption for Cloudflare Worker scheduled tasks. |
| Degraded result model | Returning a structured partial/failure result instead of throwing, allowing the pipeline to preserve partial data and observability. |
| Operational script | A runbook/repair/reconcile script used for production data maintenance outside the normal deployed Worker request/cron path. |
