# Agent 1 Redundancy Audit - 2026-04-16

Scope: redundancy only for `/home/ahirice/Documents/git/stablecoin-dashboard`.

No product code was edited. This report is based on tracked source files for code findings, plus explicitly noted untracked workspace artifacts where they affect repository hygiene or audit repeatability.

## Inventory

Repository shape:

- Tracked files: 3,187.
- Tracked TypeScript/JavaScript/CSS runtime and script files under `src/`, `shared/`, `worker/src/`, `functions/`, and `scripts/`: 993 files, 200,714 lines by `wc -l`.
- Major tracked areas: `worker/` 867 tracked files, `agents/` 735, `src/` 660, `public/` 557, `shared/` 176, `scripts/` 60, `docs/` 60, `functions/` 16.
- Architecture from docs: static Next.js frontend in `src/`, Cloudflare Worker API in `worker/src/`, Pages Functions in `functions/`, runtime-neutral shared contracts in `shared/`, scripts/CI guards in `scripts/`.
- Relevant docs reviewed: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`.

Package metadata:

- Root package: Next 16, React 19, TanStack Query, Recharts, Radix UI primitives, zod, Tailwind v4, Vitest, ESLint.
- Worker workspace: `@cf-wasm/resvg`, `satori`, `viem`, Wrangler, workers-types.
- Root and worker both declare TypeScript in dev dependencies, but npm dedupes to a single installed version. I do not flag that as a redundant dependency because the workspace package may be used independently.

Guardrail results:

- `npm run check:unused-code`: passed; no dead internal modules or unused named exports found.
- `npm run check:unused-code -- --audit-allowlist`: passed; unused-code allowlist entries point to existing files.
- `npm run check:duplicate-exports`: passed; no duplicate exports found.
- `npm run check:worker-boundary`: passed.
- `npm run check:shared-cycles`: passed for `shared/`, `worker/src/`, and `src/`.
- `npx jscpd`, production-only mild mode: 4 clones, 74 duplicated lines, 0.03 percent duplicated lines.
- `npx jscpd`, production-only weak mode: 10 clones, 172 duplicated lines, 0.08 percent duplicated lines.
- `npx depcheck`: no confirmed redundant package metadata. Reported `tw-animate-css` as unused, but it is imported in `src/app/globals.css:2`. Reported `@shared/lib` because depcheck does not understand the repo TS alias. Reported `vite` from Vitest config internals; not actionable without changing the Vitest toolchain.

## Findings

### R1 - Price-result application loop is duplicated between primary and GeckoTerminal probe passes

Locations:

- `worker/src/cron/sync-stablecoins/pricing.ts:323-356`
- `worker/src/cron/sync-stablecoins/pricing.ts:397-425`

Description:

`applyPrimaryPriceResults()` and `applyGtProbeResults()` both destructure the same input shape, loop over `assets`, call `applyPriceResultForAsset()`, pass the same previous trusted price/context/reference/start-time fields, and differ only in labels/options plus the primary pass's `supplySource` defaulting.

Evidence:

- jscpd production scan flagged a 25-line clone between the two functions.
- The repeated call bodies cover `asset`, `primaryPriceResult`, `previousTrustedPrice`, `validationContext`, `validationReferences`, and `syncStartSec`.

Confidence: High.

Consolidation strategy:

Extract a small internal helper such as `applyPriceResultsForAssets(input, options)` where options include `rejectionLabel`, `requiredCandidateSource`, `stampExistingWhenRejected`, `stampExistingWhenMissing`, and optional `afterAssetApplied`. Keep public function names if callers benefit from semantic stage names.

Quick-win candidate: Yes. Small refactor, covered by existing sync-stablecoins tests.

Caveat:

Run the sync-stablecoins/enrich-prices tests because primary pass stamping behavior differs from the GT-probe pass.

### R2 - CoinGecko/commodity supply-history backfill branch repeats the same call and result handling

Locations:

- `worker/src/api/backfill-supply-history.ts:245-265`
- `worker/src/api/backfill-supply-history.ts:268-291`

Description:

Two adjacent branches call `backfillCommodity(db, meta.id, {...})` with the same options, update `totalRows` the same way, and push errors through the same result/catch structure. The first branch handles gold/silver commodities with `geckoId`; the second handles `detailProvider === "coingecko" || "commodity"`.

Evidence:

- jscpd production scan flagged a 15-line clone.
- The duplicated options are `geckoId`, `protocolSlug`, `cgApiKey`, `contracts`, and `chainRpcs`.

Confidence: High.

Consolidation strategy:

Introduce a local helper like `runMarketChartBackfill(meta, errorLabel)` or compute a single `usesCoinGeckoMarketChart` predicate. Preserve the current skipped behavior for coins without `geckoId`.

Quick-win candidate: Yes.

Caveat:

The commodity and CoinGecko error labels differ. Preserve those labels or make the new helper accept a context label so admin output remains familiar.

### R3 - DEWS methodology diagram duplicates signal and threat-band markup for desktop and mobile

Locations:

- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:254-321`
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:324-388`

Description:

The DEWS diagram renders two separate desktop/mobile blocks. Both repeat the eight signal names and weights plus the five threat bands and ranges. The mobile block shortens two labels (`Cross-Source Div.`, `WARN`), but the source data is the same.

Evidence:

- jscpd production scan flagged two TSX clones across the signal-card and formula/arrow area.
- The duplicated data includes `Supply Velocity 0.25`, `Pool Balance Drift 0.20`, `Liquidity Erosion 0.15`, `Price Confidence 0.15`, `Cross-Source Divergence 0.15`, `Blacklist Activity 0.10`, `Mint/Burn Flow 0.10`, `Yield Anomaly 0.05`, and threat bands `CALM` through `DANGER`.

Confidence: High.

Consolidation strategy:

Move the signal and band definitions to local arrays and render through a shared small card component. Keep separate layout wrappers for desktop and mobile if needed, but share the data and leaf card markup.

Quick-win candidate: Medium. Straightforward, but methodology pages should be visually checked after changing markup.

Caveat:

Run the methodology page tests/build and visually inspect desktop and mobile because this is public documentation UI.

### R4 - Optional yield candidate resolution repeats append/gate logic for direct IDs and resolved IDs

Locations:

- `worker/src/cron/yield-sync/resolve-helpers.ts:141-163`
- `worker/src/cron/yield-sync/resolve-helpers.ts:176-194`

Description:

`appendResolvedOptionalProtocolCandidates()` handles entries that already carry `stablecoinId`, then handles entries resolved through identity lookup. After resolution, both branches fetch metadata, apply the lending-opportunity size gate, check duplicate `sourceKey`, and push the same `ResolvedYieldEntry` shape.

Evidence:

- jscpd weak production scan flagged a structural clone.
- Both branches call `getActiveStablecoinMeta()`, `passesLendingOpportunitySizeGate()`, `resolved.some(...)`, and `resolved.push({ id, symbol, yield })`.

Confidence: High.

Consolidation strategy:

Extract `appendYieldCandidateIfEligible(entry, stablecoinId, context)` returning a small status enum (`appended`, `duplicate`, `size-gated`, `unresolved`) so counters remain explicit.

Quick-win candidate: Yes.

Caveat:

Keep the existing ambiguous/unresolved counter behavior for the identity-resolution branch.

### R5 - EVM JSON-RPC fallback loop is implemented twice

Locations:

- `worker/src/lib/evm-rpc.ts:60-115`
- `worker/src/lib/evm-rpc.ts:152-207`

Description:

`fetchJsonRpcResult()` already implements RPC URL iteration, timeout/retry handling, JSON-RPC error handling, failure collection, logging, and null-result behavior. `fetchEvmCallHexAtBlock()` reimplements the same fetch loop so it can reject empty `0x` results and keep trying fallbacks.

Evidence:

- jscpd weak production scan flagged a structural clone.
- Both loops call `fetchWithRetry()` with POST JSON-RPC payloads, collect `failures`, handle HTTP errors, parse a `JsonRpcEnvelope`, handle `body.error`, and log `[evm-rpc] ... failed across ...`.

Confidence: Medium-high.

Consolidation strategy:

Extend `fetchJsonRpcResult()` with an optional `acceptResult` predicate or `normalizeResult` callback. `fetchEvmCallHexAtBlock()` can then pass a predicate that rejects invalid hex and `"0x"` while reusing the fallback loop.

Quick-win candidate: Medium.

Caveat:

This helper is used by live reserve/on-chain code. Run EVM RPC unit tests and reserve adapter tests after changing it.

### R6 - Blacklist sync repeats post-fetch row processing and counter accumulation for Tron and EVM branches

Locations:

- `worker/src/cron/sync-blacklist.ts:203-224`
- `worker/src/cron/sync-blacklist.ts:268-289`

Description:

After chain-specific fetches, both branches call `processFetchedBlacklistRows()` with the same arguments except `chainLabel`, then add the same `enrichCounters`, `totalInsertedRows`, and `currentBalanceCacheCounters`.

Evidence:

- jscpd weak production scan flagged a 19-line structural clone.
- The repeated accumulation block has seven identical counter updates.

Confidence: High.

Consolidation strategy:

Extract a local helper such as `processRowsAndAccumulate({ chainLabel, resultRows, config, ... })` that returns the inserted/counter deltas or mutates a typed accumulator. Keep the chain-specific sync-state advancement logic outside the helper.

Quick-win candidate: Yes.

Caveat:

This cron is connection-budget sensitive. The helper should not add fetches or change ordering; it should only wrap the existing post-fetch processing block.

### R7 - Two one-off depeg repair scripts duplicate SQL mutation batching

Locations:

- `scripts/fix-commodity-depeg-median.ts:145-190`
- `scripts/fix-non-usd-depeg-fx.ts:137-180`
- Documentation references: `docs/scripts.md:49-50`

Description:

Both scripts recalculate depeg event bps, split rows into delete/update/unchanged buckets, build `DELETE FROM depeg_events WHERE id IN (...)` batches of 50, build one `UPDATE depeg_events SET peak_deviation_bps = ..., peg_reference = ... WHERE id = ...` per row, and execute through `d1BatchExec()`.

Evidence:

- jscpd weak production scan flagged a cross-file clone.
- Both scripts are documented as retroactive correction scripts and are not package scripts.

Confidence: Medium.

Consolidation/removal strategy:

If the scripts still need to remain available, extract shared `buildDepegRepairStatements(toDelete, toUpdate)` and `executeDepegRepair(prefix, statements, dryRun)` helpers under `scripts/lib/`. If production has already been repaired and rollback/audit needs are satisfied, retire the scripts and update `docs/scripts.md`.

Quick-win candidate: Conditional.

Caveat:

Do not remove these without dynamic validation against production operations history. They are documented, potentially intentionally retained runbooks.

### R8 - API route paths are partially duplicated between path builders and endpoint definitions

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

Description:

The shared API endpoint module contains both `API_PATHS` builders and endpoint definitions. Many definitions consume `API_PATHS`, but several route base strings and probe strings are hard-coded a second time. This creates a partial duplicate route registry: consumer-facing builders and metadata definitions can drift even though route metadata is intended to be centralized.

Evidence:

- `API_PATHS.dexLiquidityHistory()` builds `/api/dex-liquidity-history` at `paths.ts:33-34`, while `definitions.ts:210-217` hard-codes the same base path and probe base.
- `API_PATHS.supplyHistory()` builds `/api/supply-history` at `paths.ts:35-36`, while `definitions.ts:220-227` hard-codes the base path.
- Similar duplication exists for `yield-history`, `safety-score-history`, `mint-burn-*`, `stress-signals`, `non-usd-share`, `request-source-stats`, and admin dry-run probe paths.

Confidence: Medium.

Consolidation strategy:

Prefer one route source per endpoint key. Options:

1. Use `API_PATHS` consistently inside `definitions.ts` for all paths/probes that have builders.
2. Or derive `API_PATHS` static builders from `ENDPOINT_DEFINITIONS` and keep only parameterized builders hand-authored.
3. Add a small path-consistency check if keeping both surfaces is intentional.

Quick-win candidate: Medium.

Caveat:

The current validation suite already checks endpoint contracts, so this is drift risk rather than a current bug. Any refactor must run API endpoint contract tests and `npm run check:doc-sync`.

### R9 - Invariant CSS tokens are duplicated in light and dark semantic token blocks

Locations:

- `src/styles/tokens/semantic.css:160-175`
- `src/styles/tokens/semantic.css:279-294`

Description:

Sidebar dimensions and motion/theme-transition tokens are repeated identically in both `:root` and `.dark`. Color-specific tokens differ appropriately, but dimensions and motion values are invariant and can live once.

Evidence:

- jscpd weak production scan flagged a CSS clone.
- Identical values include `--sidebar-width-expanded: 220px`, `--sidebar-width-collapsed: 56px`, `--motion-duration-fast: 160ms`, `--motion-duration-base: 220ms`, `--motion-ease-standard`, `--motion-duration-slow`, `--motion-duration-entrance`, `--motion-ease-spring`, `--motion-ease-decelerate`, and `--theme-transition-duration: 200ms`.

Confidence: High.

Consolidation strategy:

Keep invariant dimension/motion tokens in `:root` only. Leave dark-mode overrides only for tokens that actually differ by theme.

Quick-win candidate: Yes.

Caveat:

Run visual/UI smoke checks because CSS token movement can affect cascade assumptions.

### R10 - Thin frontend origin wrapper adds an indirection layer over shared runtime origins

Locations:

- Wrapper: `src/lib/site-config.ts:1`
- Representative consumers:
  - `src/app/layout.tsx:13`
  - `src/app/page.tsx:9`
  - `src/app/sitemap.ts:8`
  - `src/app/robots.ts:2`
  - `src/app/stablecoin/[id]/page.tsx:11`
  - `src/app/digest/[date]/page.tsx:10`
  - `src/app/methodology/page.tsx:11`
  - `src/app/compare/page.tsx:5`
  - `src/app/coverage/page.tsx:4`
  - `src/app/liquidity/page.tsx:5`
  - `src/app/yield/page.tsx:5`
  - `src/app/chains/page.tsx:6`
  - `src/app/dependency-map/page.tsx:4`
  - `src/app/portfolio/page.tsx:4`

Description:

`src/lib/site-config.ts` only re-exports `SITE_ORIGIN` and `API_ORIGIN` from `@shared/lib/runtime-origins` under aliases `SITE_URL` and `API_URL`. It has no validation or frontend-only behavior. The shared runtime origin module is already documented as the source for frontend API-base inference, Pages Functions, worker probe URLs, and static-export tooling.

Evidence:

- The file is a one-line pass-through wrapper.
- Consumers only need the constants and could import them directly from `@shared/lib/runtime-origins`.

Confidence: Medium.

Consolidation/removal strategy:

Either remove the wrapper and migrate imports to `@shared/lib/runtime-origins`, or keep it deliberately as a frontend semantic alias and document that choice in the file. Removal is mostly mechanical but touches metadata-heavy routes.

Quick-win candidate: Low-medium. Small technically, broader churn.

Caveat:

This wrapper may have been retained for readability in SEO metadata. If keeping it, treat it as intentional and add a short comment; if removing it, run build/SEO checks.

### R11 - Test suite contains concentrated fixture/setup duplication

Locations:

- `scripts/__tests__/smoke-ops.test.ts:107-145`
- `scripts/__tests__/smoke-ops.test.ts:147-184`
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:26-75`
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:128-164`
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:167-205`
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:207-259`
- `worker/src/lib/__tests__/depeg-helpers.test.ts:1-135`
- `worker/src/lib/__tests__/depeg-trust-policy.test.ts:1-103`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts:13-40`
- `scripts/check-redemption-backstops.ts:20-46`

Description:

Most full-repo jscpd findings are in tests. The largest actionable clusters are repeated mock/setup/result assertions in smoke tests, repeated reserve adapter configs in branch-balance tests, overlapping depeg trust-policy assertions across two test files, and duplicated redemption backstop family-module metadata between a test and a CI script.

Evidence:

- Full scan found 53 clones, but production-only mild scan found only 4. This concentration means duplication risk is mainly in test and validation scaffolding.
- The redemption backstop module list appears in both a test and an executable check, so adding a new family can require two updates.

Confidence: Medium-high.

Consolidation strategy:

Prioritize extracting shared test builders only where they reduce review noise without hiding scenario intent:

- Add local `mockTransientOpsProxy(status)` helper in `smoke-ops.test.ts`.
- Add `makeEvmBranchBalancesConfig(branchOverrides?)` in `evm-branch-balances.test.ts`.
- Move redemption backstop `familyModules` metadata to a shared test/check helper if the script and test should enforce the same family boundaries.
- Avoid over-abstracting individual assertion cases where duplication is clearer than indirection.

Quick-win candidate: Partial. Smoke/reserve test helpers are quick; shared test/check helper is medium.

Caveat:

Test duplication is sometimes intentionally explicit. Do not consolidate if it makes individual scenarios harder to read.

### R12 - Local workspace has large untracked generated artifacts and cloned worktrees that can contaminate full-repo analysis

Locations:

- `.next/` - 6.8G
- `worktrees/` - 2.3G
- `node_modules/` - 1.1G
- `out/` - 135M
- `coverage/` - 768K
- `output/` - 3.2M
- `agents/jscpd-2026-04-16/jscpd-report.json` - generated during this audit, 558,041 bytes

Description:

The working tree contains large untracked/generated directories and nested worktree clones. They are excluded from the tracked-source findings, but a naive "full repository" scan will count cloned source copies and generated output as duplication.

Evidence:

- `du -sh` showed the sizes above.
- `find . -maxdepth 3` revealed multiple `worktrees/research-audit-*` and build-verification copies.
- `git status --short` shows these are not tracked product source, except the audit-generated `agents/jscpd-2026-04-16/` report directory is untracked notes output.

Confidence: High.

Consolidation/removal strategy:

Keep generated artifacts out of audit scope and remove local generated build outputs when not needed. If nested worktrees are long-lived, move them outside the repo root or ensure every audit/check script excludes `worktrees/**` and `.worktrees/**`.

Quick-win candidate: Yes for local cleanup, but not a product code change.

Caveat:

Do not delete untracked user worktrees without owner confirmation. These may contain active research or pending changes.

### R13 - Installed dependency tree has local extraneous packages, but package metadata has no confirmed redundant dependency

Locations:

- `package.json:70-99`
- `worker/package.json:11-19`
- Local install artifacts reported by `npm ls --depth=0`:
  - `node_modules/@emnapi/core`
  - `node_modules/@emnapi/runtime`
  - `node_modules/@emnapi/wasi-threads`
  - `node_modules/@tybys/wasm-util`

Description:

The declared dependency metadata does not show a confirmed redundant third-party package. `depcheck` false-positive reports are explained by CSS imports, TS path aliases, and Vitest/Vite internals. The only concrete dependency redundancy is local `node_modules` state: four packages are marked extraneous by npm.

Evidence:

- `tw-animate-css` is declared in `package.json:98` and used in `src/app/globals.css:2`.
- `npm ls --depth=0` reports the four extraneous packages above.
- `npm ls --depth=0` shows worker TypeScript is deduped to the root `typescript@5.9.3`.

Confidence: High for local extraneous artifacts; high for no confirmed package metadata redundancy found by this pass.

Consolidation/removal strategy:

Run `npm ci` when a clean dependency tree is needed. Do not remove declared dependencies from `package.json` based on depcheck alone.

Quick-win candidate: Yes for local cleanup only.

Caveat:

No product change recommended without bundle analysis or a dependency-owner decision.

## Quick-Win Candidates

1. R1 - Extract a price-result application helper in `worker/src/cron/sync-stablecoins/pricing.ts`.
2. R2 - Extract/merge the CoinGecko market-chart backfill branch in `worker/src/api/backfill-supply-history.ts`.
3. R4 - Extract optional yield candidate append/gate helper in `worker/src/cron/yield-sync/resolve-helpers.ts`.
4. R6 - Extract blacklist post-fetch processing/counter accumulation helper in `worker/src/cron/sync-blacklist.ts`.
5. R9 - Move invariant motion/sidebar CSS tokens out of `.dark`.
6. R13 - Clean local dependency install with `npm ci` if needed.

## Caveats Requiring Dynamic Validation

- R7: Do not remove one-off depeg repair scripts until production repair history and rollback needs are confirmed.
- R8: Route path consolidation must run API contract tests, doc-sync, and status/admin route checks because endpoint definitions drive auth, method gates, probes, and site-data access.
- R9: CSS token consolidation should be paired with visual smoke checks.
- R10: Removing `src/lib/site-config.ts` touches SEO metadata and sitemap/robots routes; run build and SEO checks.
- R12: Do not delete untracked worktrees or research output without owner confirmation.
- Dependency cleanup: depcheck output contains known false positives in this repo; do not use it alone for dependency removal.

## Areas With No Confirmed Redundancy Finding

- Dead tracked runtime modules: none found by `npm run check:unused-code`.
- Unused tracked named exports: none found by `npm run check:unused-code`; allowlist audit passed.
- Duplicate named exports: none found by `npm run check:duplicate-exports`.
- Circular/shared-boundary duplication symptoms: none found by `check:shared-cycles` or `check:worker-boundary`.
- Confirmed redundant declared npm dependencies: none found in package metadata.

## Suggested Remediation Order

1. Small source refactors: R1, R2, R4, R6.
2. Low-risk style/data dedupe: R9 after visual check.
3. Route/path registry cleanup: R8 after agreeing on whether `API_PATHS` or endpoint definitions own path strings.
4. Test/support cleanup: R11, then R7 only if those scripts remain active.
5. Workspace hygiene: R12 and R13 as local cleanup, not product commits.

## Commands Run

```bash
git status --short
git ls-files | wc -l
git ls-files 'src/**/*.{ts,tsx}' 'shared/**/*.ts' 'worker/src/**/*.ts' 'functions/**/*.ts' 'scripts/**/*.{ts,js,mjs,cjs}' | xargs wc -l
sed -n '1,220p' docs/architecture.md
sed -n '1,220p' docs/api-reference.md
sed -n '1,220p' docs/testing.md
sed -n '1,220p' docs/worker-and-api-limits.md
npm run check:unused-code
npm run check:unused-code -- --audit-allowlist
npm run check:duplicate-exports
npm run check:worker-boundary
npm run check:shared-cycles
npm ls --depth=0
npm ls --workspaces --depth=0
npx --yes depcheck --json --ignores='@types/*,eslint,typescript,tailwindcss,@tailwindcss/postcss,eslint-config-next,@cloudflare/workers-types'
npx --yes jscpd --min-lines 18 --min-tokens 100 --reporters console --mode mild --ignore "**/node_modules/**,**/.next/**,**/out/**,**/coverage/**,**/worktrees/**,**/.worktrees/**,**/agents/**,**/public/**,**/worker/migrations/**,**/*.json" src shared worker/src functions scripts
npx --yes jscpd --min-lines 14 --min-tokens 90 --reporters console --mode mild --ignore "**/node_modules/**,**/.next/**,**/out/**,**/coverage/**,**/worktrees/**,**/.worktrees/**,**/agents/**,**/public/**,**/worker/migrations/**,**/*.json,**/__tests__/**,**/*.test.ts,**/*.test.tsx,**/test/**,**/fixtures/**" src shared worker/src functions scripts
npx --yes jscpd --min-lines 12 --min-tokens 80 --reporters console --mode weak --ignore "**/node_modules/**,**/.next/**,**/out/**,**/coverage/**,**/worktrees/**,**/.worktrees/**,**/agents/**,**/public/**,**/worker/migrations/**,**/*.json,**/__tests__/**,**/*.test.ts,**/*.test.tsx,**/test/**,**/fixtures/**" src shared worker/src functions scripts
rg -n "tw-animate-css" .
du -sh node_modules worker/node_modules .next out coverage output worktrees .worktrees .wrangler .cache .codex-autorunner
```
