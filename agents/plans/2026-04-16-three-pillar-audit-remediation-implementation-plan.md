# Three-Pillar Audit Remediation Implementation Plan - 2026-04-16

Scope: `/home/ahirice/Documents/git/stablecoin-dashboard`

Status: implementation blueprint only. No product code was changed while creating this plan.

Source audit:

- Consolidated audit: `agents/audits/2026-04-16-comprehensive-three-pillar-audit-blueprint.md`
- Redundancy source report: `agents/audits/2026-04-16-agent-1-redundancy-audit.md`
- Code-quality source report: `agents/research/2026-04-16-agent-2-code-quality-audit.md`
- Sustainability source report: `agents/research/2026-04-16-sustainability-maintainability-audit-agent3.md`

Planning sub-research:

- Portfolio/stress/data-integrity sub-plan: `agents/research/2026-04-16-remediation-plan-agent-a-portfolio-stress-data-integrity.md`
- Operational/tooling/contracts sub-plan: `agents/research/2026-04-16-remediation-planning-agent-b.md`
- Redundancy/provider/hotspot sub-plan: `agents/research/2026-04-16-agent-c-remediation-implementation-subplan.md`

## 1. Objectives

This plan translates every audit finding into an implementation sequence that can be executed as small, reviewable PRs.

Primary objectives:

1. Fix real correctness and incident-readiness risks first.
2. Strengthen guardrails before large refactors or dependency churn.
3. Preserve current public behavior unless a finding explicitly requires a behavior change.
4. Add tests before or with behavior changes, not after.
5. Keep each PR small enough that validation failure can be localized.
6. Update docs only for changed behavior, operator workflow, validation, API contract, tooling, or verified methodology text.

Non-goals:

- No broad re-architecture. The audit found the overall architecture coherent.
- No manual/on-chain/CMC/DEX supply override changes.
- No methodology version bump unless implementation changes scoring, data-source policy, or methodology output.
- No deletion of local worktrees or untracked research output without owner confirmation.

## 2. Assumptions And Current Research

Implementation assumptions:

- Existing dirty worktree entries may include unrelated user work. Before editing a file, inspect `git status --short` and `git diff -- <file>`, then work with existing changes rather than reverting them.
- Zero-amount portfolio rows are currently editor drafts because `src/app/portfolio/client.tsx` calls `portfolio.addCoin(coin.id, 0)`. This plan assumes zero amounts remain valid in live state, storage, and share URLs. If product semantics reject that, use the larger alternate draft model described in Stream 2.
- Production repair scripts are documented runbooks. They must not be retired without operator confirmation.
- Route path cleanup must not change endpoint strings, auth metadata, status probes, or site-data allowlists.
- Cloudflare Worker connection-limit language must be updated for the current platform behavior discovered during planning.

Current validation baseline from the audit:

- Passed: `npm run lint`, `npm run typecheck`, `cd worker && npx tsc --noEmit`, `npm test` (475 files, 4,668 tests), `npm run coverage:critical`, dependency audits, unused-code, duplicate-export, cycle, worker-boundary, hotspot, SQL-safety, env/doc/cron/migration/data checks.
- Not run during audit: `npm run build`, UI smoke tests, live API smoke tests, Wrangler deploy/dev.

Package metadata checked during planning:

| Package | Current | Latest observed | Plan |
| --- | ---: | ---: | --- |
| `wrangler` | `4.82.2` | `4.83.0` | Patch in Worker tooling batch |
| `@cloudflare/workers-types` | `4.20260414.1` | `4.20260415.1` | Patch with Wrangler |
| `viem` | `2.47.17` | `2.48.0` | Minor Worker runtime batch |
| `next` | `16.2.3` | `16.2.4` | Root patch batch |
| `eslint-config-next` | `16.2.3` | `16.2.4` | Root patch batch |
| `prettier` | `3.8.2` | `3.8.3` | Root patch batch |
| `typescript` | `5.9.3` | `6.0.2` | Planned migration, not quick patch |
| `eslint` | `9.39.4` | `10.2.0` | Planned migration, not quick patch |
| `@types/node` | `22.19.17` | `25.6.0` | Keep Node 22 type baseline |
| `npm` | local `11.11.0` | `11.12.1` | Pin/enforce after guardrail fix |

External primary sources researched:

- Cloudflare Workers connection-limit changelog, Apr 09, 2026: https://developers.cloudflare.com/changelog/post/2026-04-09-relaxed-connection-limiting/
- npm package.json docs for `engines` and `devEngines`: https://docs.npmjs.com/cli/v11/configuring-npm/package-json/
- Corepack package manager field docs: https://github.com/nodejs/corepack
- Zod current release context: https://github.com/colinhacks/zod

Important research outcome:

- The repo docs currently describe the Worker six-connection constraint as if unread response bodies continue occupying the scarce pool. Cloudflare relaxed this on Apr 09, 2026: the limit now applies to concurrent connections waiting for response headers. The plan updates the cron-budget model accordingly while still requiring response bodies to be consumed or canceled for cleanup, memory, and retry predictability.

## 3. Global Execution Rules

For every PR:

1. Start with `git status --short`.
2. Inspect existing diffs in any file being touched.
3. Keep changes surgical and scoped to the planned task.
4. Add or update tests in the same PR as behavior changes.
5. Run targeted tests first, then the relevant broader gate.
6. Update docs only when behavior, operator workflow, API contract, pipeline, methodology, data source, or validation command changes.
7. Do not update hotspot baselines or waivers before reducing or intentionally re-baselining the related source.
8. If changing deploy-impact classification or CI setup, validate those changes before dependency/tooling churn.
9. If changing route endpoint definitions, run API contract tests and doc sync before claiming completion.
10. If changing frontend layout, run build and local UI smoke or visual verification.

Common validation abbreviations used below:

- Frontend page validation: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run seo:check`, local `npm run test:smoke-ui` when layout changes. For local smoke UI, start the static export server first with `npm run serve:static-export` against the built `out/` artifact, or use the existing CI-style background server wrapper.
- Worker validation: `cd worker && npx tsc --noEmit`, targeted Worker Vitest files, `npm run check:worker-boundary`, `npm run check:sql-safety`.
- Core gate: `npm run lint`, `npm run typecheck`, `npm test`, `npm run coverage:critical`.
- Deploy guardrail gate: `npm run check:worker-boundary`, `npm run check:shared-cycles`, `npm run check:migrations`, `npm run check:cron-sync`, `npm run check:cron-connections`, `npm run check:doc-sync`, `npm run check:env-contract`, `npm run check:duplicate-exports`, `npm run check:unused-code`, `npm run check:hotspot-ratchet`, `npm run check:sql-safety`.

## 4. Phase Overview

### Phase 1 - Guardrails And Small Documentation Fixes

Purpose: make later work safer.

1. P1.1 Expand deploy-impact classification.
2. P1.2 Add Worker script typecheck and fix stale script imports.
3. P1.3 Fix `apiFetch` contract comment.
4. P1.4 Align site-data fallback documentation.
5. P1.5 Serialize GA ID in inline analytics script.

### Phase 2 - Highest-Value Correctness Fixes

Purpose: fix user-facing data integrity risks and provider-boundary brittleness.

1. P2.1 Guard portfolio reserve allocation against zero-sum percentages.
2. P2.2 Normalize portfolio holding amount semantics.
3. P2.3 Add portfolio and stress-test behavioral coverage.
4. P2.4 Harden stablecoin numeric schemas and data validator.
5. P2.5 Harden direct DEX API JSON boundaries.

### Phase 3 - Contract, Budget, Tooling Precision

Purpose: reduce drift in route metadata, cron capacity docs, package management, and dependency state.

1. P3.1 Reduce API path duplication and add consistency tests.
2. P3.2 Update cron connection-budget model for header-wait semantics.
3. P3.3 Pin/enforce npm version policy.
4. P3.4 Apply dependency patch/minor batches.
5. P3.5 Formalize duplication-scan and workspace hygiene.
6. P3.6 Establish supported Worker operational helper surface.

### Phase 4 - Focused Redundancy Cleanup

Purpose: eliminate small source clones before larger refactors.

1. P4.1 Extract price-result application helper.
2. P4.2 Merge duplicate supply-history backfill branches.
3. P4.3 Extract optional yield candidate append helper.
4. P4.4 Consolidate EVM RPC fallback loop.
5. P4.5 Extract blacklist post-fetch counter accumulation.
6. P4.6 Consolidate invariant CSS tokens.
7. P4.7 Remove or document frontend origin wrapper.
8. P4.8 Consolidate depeg repair SQL batching.

### Phase 5 - Test Quality And Presentation Cleanup

Purpose: reduce friction without changing behavior.

1. P5.1 Extract high-value test builders and shared validation fixtures.
2. P5.2 Split oversized critical test suites.
3. P5.3 Data-drive DEWS methodology diagram.

### Phase 6 - Structural Hotspot Decomposition

Purpose: strategic maintainability work, performed only after guardrails are stronger.

1. P6.1 Decompose DEX discovery `crawlCoin`.
2. P6.2 Decompose DEX liquidity metadata analysis.
3. P6.3 Decompose pending-depeg confirmation decision flow.
4. P6.4 Decompose primary price fetch and consensus stages.
5. P6.5 Decompose Telegram alert dispatch.
6. P6.6 Extract frontend view-models for hotspot components.

## 5. Detailed Implementation Tasks

### P1.1 - Expand Deploy-impact Classification

Findings: S2, C4, C6.

Priority: High because it protects all later CI/tooling changes.

Files:

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

Implementation steps:

1. In `scripts/lib/deploy-impact.mjs`, add full-deploy infrastructure prefixes:

   ```js
   const FULL_DEPLOY_INFRA_PREFIXES = [
     ".github/actions/",
     "scripts/lib/",
   ];
   ```

2. Include those prefixes in both `hasWorkerDeployImpact()` and `hasPagesDeployImpact()`.
3. Add an exact-path set for guardrail scripts invoked by `validate-ci.yml` or `scripts/lib/validate-contract.mjs`.
4. Include representative scripts:
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
   - `scripts/smoke-api.mjs`
   - `scripts/smoke-ops.mjs`
   - `scripts/smoke-transport.mjs`
   - `scripts/smoke-ui.mjs`
5. Keep Pages-only build helpers as Pages-impacting:
   - `scripts/sync-digests.ts`
   - `scripts/generate-redirects.ts`
   - `scripts/serve-static-export.mjs`
6. Add tests:
   - `hasDeployImpact(["scripts/lib/deploy-impact.mjs"]) === true`
   - `hasDeployImpact(["scripts/lib/validate-contract.mjs"]) === true`
   - `hasDeployImpact([".github/actions/setup-workspace/action.yml"]) === true`
   - representative guardrail scripts are deploy-impacting
   - docs and agents notes remain non-impacting
7. Add a drift-resistance test that maps known npm scripts in the validate contract to underlying `scripts/*` files and asserts deploy impact for those owned scripts.

Validation:

```bash
vitest run scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts
MERGE_GATE_DRY_RUN=1 npm run test:merge-gate -- --staged
```

Acceptance criteria:

- All probed CI/guardrail infra paths return deploy-impacting.
- Docs-only and `agents/`-only changes remain non-impacting.
- Validate CI parity tests still pass.

Risks:

- CI spend can increase for infrastructure-only pushes. This is intended and safer than skipping production validation for guardrail edits.

### P1.2 - Add Worker Script Typecheck And Fix Stale Imports

Findings: S1, R7, C2.

Priority: High because production repair scripts are incident-time tooling and one already fails under typecheck.

Files:

- Add `worker/tsconfig.scripts.json`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts`
- `worker/src/api/backfill-fx.ts`
- `worker/src/api/backfill-depegs-extraction.ts`
- `worker/src/api/backfill-depegs-preview.ts`
- `scripts/lib/validate-contract.mjs`
- `.github/workflows/validate-ci.yml`
- `scripts/__tests__/validate-ci-parity.test.ts`
- `scripts/__tests__/test-merge-gate.test.ts`
- `docs/testing.md`
- `docs/scripts.md`

Implementation steps:

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

2. Add a validation command:

   ```bash
   cd worker && npx tsc --noEmit -p tsconfig.scripts.json
   ```

3. Wire it into worker deploy validation:
   - Add to `scripts/lib/validate-contract.mjs` worker validate command list.
   - Add corresponding conditional step in `.github/workflows/validate-ci.yml`.
   - Update parity tests.
4. Optionally add package scripts:
   - Root: `"typecheck:worker-scripts": "cd worker && npx tsc --noEmit -p tsconfig.scripts.json"`
   - Worker: `"typecheck:scripts": "tsc --noEmit -p tsconfig.scripts.json"`
5. Fix imports in `worker/scripts/repair-non-usd-fiat-depeg-history.ts`:

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

6. Fix any remaining implicit-any errors surfaced by the new typecheck with explicit types, not weaker compiler settings.
7. Update `docs/testing.md` and `docs/scripts.md` to list Worker script typecheck.

Validation:

```bash
cd worker && npx tsc --noEmit
cd worker && npx tsc --noEmit -p tsconfig.scripts.json
vitest run scripts/__tests__/validate-ci-parity.test.ts scripts/__tests__/test-merge-gate.test.ts
npm run check:worker-boundary
npm run check:sql-safety
```

Optional operator validation:

```bash
cd worker && npx tsx scripts/repair-non-usd-fiat-depeg-history.ts --dry-run --stablecoin=<low-risk-id>
```

Acceptance criteria:

- `worker/scripts/**` are covered by CI/local validation.
- `repair-non-usd-fiat-depeg-history.ts` typechecks without importing stale route-handler surfaces.
- No boundary rule blocks legitimate Worker operational script imports.

Risks:

- New typecheck may uncover more script errors. Fix them in the same PR; do not add exclusions.

### P1.3 - Fix `apiFetch` Contract Comment

Findings: Q9, C4.

Files:

- `src/lib/api.ts`
- `src/lib/__tests__/api-fetch-contracts.test.ts`

Implementation steps:

1. Update the `apiFetch` comment to say strict schema validation is the default and schema mismatch throws.
2. State that `contractMode: "warn"` is the explicit graceful-degradation mode.
3. Do not change runtime behavior.

Validation:

```bash
vitest run src/lib/__tests__/api-fetch-contracts.test.ts
npm run lint
```

Acceptance criteria:

- Comment matches implementation and existing tests.

### P1.4 - Align Site-data Fallback Documentation

Findings: S5, C4.

Files:

- `docs/api-reference.md`
- `docs/deployment-process.md`
- `docs/architecture.md`
- `worker/wrangler.toml`

Implementation steps:

1. Update `docs/api-reference.md` to state:
   - `site-api.pharos.watch` is provisioned and declared in `worker/wrangler.toml`.
   - Production Pages hosts require explicit `SITE_API_ORIGIN`.
   - Production fails closed when `SITE_API_ORIGIN` is missing.
   - Preview/local rehearsal may intentionally fall back to `api.pharos.watch`.
   - `PUBLIC_API_AUTH_MODE` is already `enforce`; remove rollout-era warning about not moving past `off`.
2. Update `docs/deployment-process.md` wording from "when provisioned" to the current production invariant.
3. Add a semantic doc-sync check only if this fallback text has changed often enough to justify it.

Validation:

```bash
npm run check:doc-sync
npm run check:verified-doc-links
rg -n "Until that dedicated host is provisioned|PUBLIC_API_AUTH_MODE past `off`|when provisioned" docs/api-reference.md docs/deployment-process.md
```

Acceptance criteria:

- Docs agree with current `worker/wrangler.toml`.
- No broken doc links.

Risk:

- `docs/api-reference.md` was already dirty during planning. Merge with existing user edits rather than overwriting.

### P1.5 - Serialize GA ID In Inline Script

Finding: Q10.

Files:

- `src/app/layout.tsx`

Implementation steps:

1. Assign GA ID once:

   ```ts
   const gaId = process.env.NEXT_PUBLIC_GA_ID;
   ```

2. Optionally validate before rendering:

   ```ts
   const shouldRenderGa = gaId != null && /^G-[A-Z0-9]+$/.test(gaId);
   ```

3. Use `JSON.stringify(gaId)` in inline script:

   ```tsx
   gtag('config', ${JSON.stringify(gaId)});
   ```

4. Keep external script `src` behavior unchanged.

Validation:

```bash
npm run lint
npm run typecheck
npm run build
npm run serve:static-export
SMOKE_UI_EXPECT_GA_ID=<configured-id> npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
```

Acceptance criteria:

- Inline script cannot be broken by malformed build-time config.
- GA smoke still passes when expected ID is configured.

### P2.1 - Guard Portfolio Reserve Allocation Against Zero-sum Percentages

Findings: Q1, C1.

Priority: Highest correctness fix.

Files:

- `src/lib/portfolio-analysis.ts`
- Add `src/lib/__tests__/portfolio-analysis.test.ts`
- Existing `src/__tests__/portfolio-categorize.test.ts`

Implementation steps:

1. Add one allocation helper inside `computeUpstreamExposure()` or as a private helper:

   ```ts
   function allocateReserveCollateral(
     reserves: readonly ReserveSlice[],
     amountUsd: number,
     backing: string,
     options?: { excludeStablecoinSlices?: boolean },
   ): void {
     const candidates = options?.excludeStablecoinSlices
       ? reserves.filter((reserve) => !isStablecoinSlice(reserve.name))
       : [...reserves];
     const positiveCandidates = candidates.filter((reserve) => reserve.pct > 0);
     const totalPct = positiveCandidates.reduce((sum, reserve) => sum + reserve.pct, 0);

     if (totalPct <= 0) {
       const fallback = backingFallback(backing);
       addCollateral(fallback.name, fallback.symbol, amountUsd);
       return;
     }

     for (const reserve of positiveCandidates) {
       addCollateral(reserve.name, reserve.name, amountUsd * (reserve.pct / totalPct));
     }
   }
   ```

2. Replace the reserve-only loop in `computeUpstreamExposure()` with `allocateReserveCollateral(reserves, holding.amount, backing)`.
3. Replace `applyReservesToRemainder()` with `allocateReserveCollateral(reserves, remainderUsd, backing, { excludeStablecoinSlices: true })`.
4. Keep the existing `$0.01` dust filter in `addCollateral()`.
5. Do not log here; invalid curated data should be blocked by P2.4.

Tests:

1. Add module-mocked synthetic stablecoins for:
   - all-zero reserve percentages
   - mixed zero/nonzero reserves
   - reserves filtered entirely as stablecoin-like
   - unknown metadata fallback
2. Add a helper asserting every returned `usd` and `pct` is finite.
3. Keep existing grouping tests.

Validation:

```bash
npm test -- src/lib/__tests__/portfolio-analysis.test.ts src/__tests__/portfolio-categorize.test.ts
npm run lint
npm run typecheck
```

Acceptance criteria:

- No portfolio exposure path can emit `NaN` or `Infinity` for reserve allocation.
- Existing exposure grouping behavior remains stable for valid data.

### P2.2 - Normalize Portfolio Holding Amount Semantics

Findings: Q2, C1.

Files:

- `src/lib/portfolio-codec.ts`
- `src/hooks/use-portfolio.ts`
- `src/app/portfolio/client.tsx`
- `src/lib/__tests__/portfolio-codec.test.ts`
- Add `src/hooks/__tests__/use-portfolio.test.ts`

Implementation steps:

1. In `src/lib/portfolio-codec.ts`, add:

   ```ts
   export function normalizePortfolioAmount(value: unknown): number | null {
     if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
     return value;
   }
   ```

2. Add a private canonical ID helper:

   ```ts
   function canonicalPortfolioCoinId(coinId: string): string | null {
     return (REGISTRY_BY_ID.get(coinId) ?? REGISTRY_BY_LLAMA_ID.get(coinId))?.id ?? null;
   }
   ```

3. Add `normalizePortfolioHolding(value): PortfolioHolding | null`.
4. Rework `migratePortfolioIds()` to:
   - canonicalize IDs,
   - drop invalid negative/non-finite amounts,
   - merge duplicates,
   - keep zero amounts.
5. Rework `isPortfolioHolding()` to use normalization.
6. Rework `parsePortfolioUrlParam()` to accept finite `>= 0` amounts.
7. Rework `encodePortfolioHoldings()` to normalize before encoding.
8. In `usePortfolio`:
   - Use `normalizePortfolioHolding()` during storage load.
   - Save migrated normalized holdings back when needed.
   - Normalize in `addCoin()` and `setAmount()`.
   - Ignore invalid programmatic amounts; let the UI parser pass `0` for cleared/invalid user input.
9. In `portfolio/client.tsx`, replace the current parser with one that rejects negatives and malformed partial numeric input instead of stripping punctuation into a different positive number.

Alternate if zero rows are rejected:

- Introduce separate editor draft state and keep persisted/share/computed `PortfolioHolding` positive-only. This is cleaner but larger. Do not mix both models in the same PR.

Tests:

- URL parser keeps `:0`.
- URL parser drops `Infinity`, `NaN`, negative, malformed, and unknown IDs.
- Storage normalization rejects non-finite and negative values.
- Legacy ID migration preserves/merges zero rows.
- `addCoin("usdc-circle", 0)` creates a draft.
- `setAmount(..., Infinity)` does not corrupt `totalUsd`.
- URL-sourced state does not persist to storage.
- `shareUrl()` emits stable normalized holdings.

Validation:

```bash
npm test -- src/lib/__tests__/portfolio-codec.test.ts src/hooks/__tests__/use-portfolio.test.ts
npm run lint
npm run typecheck
npm run build
```

Acceptance criteria:

- URL, storage, hook actions, and UI parsing share one amount model.
- Invalid values cannot enter weighted scoring or exposure math.

### P2.3 - Add Portfolio And Stress-test Behavioral Coverage

Findings: Q7, C1.

Files:

- `src/lib/__tests__/portfolio-analysis.test.ts`
- `src/hooks/__tests__/use-portfolio.test.ts`
- `src/hooks/__tests__/use-stress-test.test.ts`
- Add `src/components/__tests__/stress-test-panel.test.tsx`
- `src/components/stress-test-panel.tsx`

Implementation steps:

1. Add pure portfolio analysis tests:
   - dependency exposure aggregates upstream stablecoin dependencies by ID,
   - collateral fallback by backing type,
   - grouped exposure recalculates percentages,
   - representative fixtures always return finite values.
2. Add portfolio hook tests:
   - weighted overall score excludes `overallScore: null`,
   - per-dimension weighted averages exclude null dimension scores,
   - empty/zero portfolio returns `NR` and null dimensions,
   - `clearAll()` persists `[]` when not URL-sourced,
   - `shareUrl()` updates/removes `p`.
3. Extend stress hook tests:
   - `targetableCoins` sorted by dependent count,
   - `gradeOptions` only below current grade,
   - `setTarget()` resets grade,
   - `setGrade()` produces affected IDs and impacts,
   - impacts sorted by absolute delta,
   - headline totals use `mcapMap`,
   - systemic risks sort by dependent supply at risk,
   - no-data state is stable.
4. Add stress panel interaction test:
   - expands panel,
   - target select calls `setTarget`,
   - grade select calls `setGrade`,
   - systemic "Run" action sets target and grade `D`.

Validation:

```bash
npm test -- src/lib/__tests__/portfolio-analysis.test.ts src/hooks/__tests__/use-portfolio.test.ts src/hooks/__tests__/use-stress-test.test.ts src/components/__tests__/stress-test-panel.test.tsx src/__tests__/portfolio-categorize.test.ts
npm run lint
npm run typecheck
npm run build
```

Acceptance criteria:

- Q1/Q2 fixed behavior is locked by tests.
- Stress-test critical outputs are covered without depending on incidental render structure.

### P2.4 - Harden Stablecoin Numeric Schemas And Data Validator

Findings: Q3, C1.

Files:

- `shared/lib/stablecoins/schema.ts`
- `scripts/check-stablecoin-data.ts`
- `shared/lib/__tests__/stablecoins.test.ts`
- Optional `scripts/lib/stablecoin-data-validation.ts`
- Optional `scripts/__tests__/check-stablecoin-data.test.ts`

Implementation steps:

1. Add named numeric schemas:

   ```ts
   const ContractDecimalsSchema = z.number().finite().int().min(0).max(255);
   const DependencyWeightNumberSchema = z.number().finite().positive().max(1);
   const ReservePctSchema = z.number().finite().positive().max(100);
   const CommodityOuncesSchema = z.number().finite().positive();
   ```

2. Apply them to:
   - contract `decimals`,
   - dependency `weight`,
   - reserve `pct`,
   - `commodityOunces`.
3. Add aggregate checks in `scripts/check-stablecoin-data.ts`:
   - reserve total must be `> 0`,
   - reserve total outside `100 +/- 0.5` fails unless allowlisted,
   - dependency total must be `> 0` when dependencies exist.
4. Keep an explicit empty allowlist for intentional reserve-total exceptions.
5. If aggregate checks grow, move pure helpers to `scripts/lib/stablecoin-data-validation.ts` and test them directly.

Tests:

- Reject negative and non-integer decimals.
- Accept `decimals: 0`.
- Reject zero/negative/greater-than-one dependency weights.
- Reject zero/negative reserve percentages.
- Reject zero commodity ounces.
- Existing real registry data still parses.

Validation:

```bash
npm run check:stablecoin-data
npm test -- shared/lib/__tests__/stablecoins.test.ts
npm run lint
npm run typecheck
```

Acceptance criteria:

- Current data passes.
- Future domain-invalid numeric data fails before runtime.

### P2.5 - Harden Direct DEX API JSON Boundaries

Findings: Q4, C3.

Files:

- `worker/src/cron/dex-liquidity/fetch-meteora.ts`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts`
- Add `worker/src/cron/dex-liquidity/direct-api-json.ts` or `worker/src/lib/dex-api-json.ts`
- `worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts`

Implementation steps:

1. Add `readDexApiJson<T>(response, context)` returning:
   - `{ ok: true, data }`, or
   - `{ ok: false, error }`
2. Catch `response.json()` errors.
3. Reject `null` and non-object roots.
4. Add minimal provider-local type guards:
   - Meteora: root `data` array; per-pool token objects and numeric amounts before dereference.
   - Balancer: `data.poolGetPools` array; per-pool `dynamicData` and `poolTokens`.
   - Raydium: `data.data` array; per-pool `mintA`, `mintB`, `day`, numeric `tvl`.
5. On page/root parse failure:
   - push bounded error,
   - break loop,
   - return degraded `DexApiFetchResult`.
6. On malformed individual pools:
   - skip row,
   - add bounded summary error such as `page 1 skipped N malformed pool rows`,
   - keep valid rows from the same page.
7. Keep orchestrator catch as last-resort safety net.

Tests:

- Invalid JSON returns degraded result, no throw.
- `null` root returns degraded result, no throw.
- Missing nested token object skips row.
- Valid row in same page is retained.
- Raydium partial failure across concentrated/standard pool types produces partial degraded aggregate.

Validation:

```bash
npx vitest run worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts
cd worker && npx tsc --noEmit
npm run check:cron-connections
npm run check:worker-boundary
```

Acceptance criteria:

- External provider malformed JSON/shape errors are represented as degraded results.
- Valid rows are preserved where possible.

### P3.1 - Reduce API Path Duplication And Add Consistency Tests

Findings: R8, C4.

Files:

- `shared/lib/api-endpoints/paths.ts`
- `shared/lib/api-endpoints/definitions.ts`
- `src/lib/__tests__/api-endpoints.test.ts`
- `worker/src/api/__tests__/router-contract.test.ts`

Implementation steps:

1. Add base path builders for endpoints where definitions currently duplicate route strings.
2. Prefer explicit `Base` suffix for route bases, for example:
   - `dexLiquidityHistoryBase()`
   - `supplyHistoryBase()`
   - `digestSnapshotBase()`
   - `yieldHistoryBase()`
   - `safetyScoreHistoryBase()`
   - `mintBurnFlowsBase()`
   - `mintBurnEventsBase()`
   - `stressSignalsBase()`
   - `nonUsdShareBase()`
   - `feedbackBase()`
   - `telegramWebhookBase()`
   - `statusBase()`
   - `statusHistoryBase()`
   - `requestSourceStatsBase()`
   - `apiKeysBase()`
   - `auditDepegHistoryBase()`
   - `backfillDewsBase()`
3. Preserve exact probe/action strings. Do not replace an existing literal with a builder that adds default query params unless a test proves the generated output exactly matches the existing literal.
4. For current probes that intentionally omit default query params, add exact-equivalent base/probe helpers rather than using defaulted caller builders. Examples:
   - current `/api/dex-liquidity-history?stablecoin=usdt-tether` must not become `...?stablecoin=usdt-tether&days=90`
   - current `/api/yield-history?stablecoin=usdt-tether` must not become `...?stablecoin=usdt-tether&days=90`
   - current `/api/safety-score-history?stablecoin=usdt-tether` must not become `...?stablecoin=usdt-tether&days=3650`
   - current `/api/status-history?limit=10` must remain exact
   - current `/api/audit-depeg-history?dry-run=true` must remain exact for both `probePath` and `statusPageAction.path`
5. Exact-preserving implementation options:
   - add base builders such as `dexLiquidityHistoryBase()` and use `buildQueryPath(API_PATHS.dexLiquidityHistoryBase(), { stablecoin: "usdt-tether" })` for the probe,
   - add explicit probe builders such as `dexLiquidityHistoryProbe(stablecoinId)` when a probe intentionally differs from public caller defaults,
   - keep a literal only when a disposition test records it as intentionally excluded with rationale.
6. Replace duplicated route base strings in definitions only where an exact-equivalent builder exists.
5. Build an explicit R8 route-string disposition table in `src/lib/__tests__/api-endpoints.test.ts` or a small local constant in the test. Every known duplicated route/probe string must be in exactly one category:
   - eliminated through an `API_PATHS` builder in `definitions.ts`,
   - guarded by a consistency assertion because the route is dynamic or admin-action-specific,
   - intentionally excluded with a comment explaining why centralization would add more risk than value.
6. The disposition table must cover every current `path`, `probePath`, and `statusPageAction.path` literal in `shared/lib/api-endpoints/definitions.ts`. The current known list includes:
   - `/api/dex-liquidity-history`
   - `/api/dex-liquidity-history?stablecoin=usdt-tether`
   - `/api/supply-history`
   - `/api/supply-history?stablecoin=usdt-tether`
   - `/api/digest-snapshot`
   - `/api/yield-history`
   - `/api/yield-history?stablecoin=usdt-tether`
   - `/api/safety-score-history`
   - `/api/safety-score-history?stablecoin=usdt-tether`
   - `/api/mint-burn-flows`
   - `/api/mint-burn-events`
   - `/api/mint-burn-events?stablecoin=usdt-tether`
   - `/api/stress-signals`
   - `/api/non-usd-share`
   - `/api/non-usd-share?days=90`
   - `/api/feedback`
   - `/api/telegram-webhook`
   - `/api/status`
   - `/api/status-history`
   - `/api/status-history?limit=10`
   - `/api/request-source-stats`
   - `/api/api-keys`
   - `/api/api-keys/audit-log`
   - `/api/api-keys/:id/update`
   - `/api/api-keys/:id/deactivate`
   - `/api/api-keys/:id/rotate`
   - `/api/trigger-digest`
   - `/api/reset-blacklist-sync`
   - `/api/debug-sync-state`
   - `/api/remediate-blacklist-amount-gaps`
   - `/api/backfill-blacklist-current-balances`
   - `/api/audit-depeg-history`
   - `/api/audit-depeg-history?dry-run=true`
   - `/api/backfill-dews`
   - `/api/backfill-depegs`
   - `/api/backfill-supply-history`
   - `/api/backfill-cg-prices`
   - `/api/backfill-stability-index`
   - `/api/backfill-mint-burn-prices`
   - `/api/backfill-mint-burn`
   - `/api/reclassify-atomic-roundtrips`
   - `/api/discovery-candidates`
7. Add a test that derives current `path`, `probePath`, and `statusPageAction.path` values from `ENDPOINT_DEFINITIONS` and fails when any value is missing from the disposition table. This generated coverage check is required so a manually maintained list cannot silently omit an existing or future literal.
8. Add tests asserting endpoint definition paths equal the relevant builder base or disposition-table expectation.
9. Preserve exact public path strings, route keys, auth metadata, method metadata, dependencies, status actions, site-data access, and probe paths.

Validation:

```bash
vitest run src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts
npm run test:critical-contracts
npm run check:doc-sync
npm run check:worker-boundary
```

Acceptance criteria:

- Every known R8 duplicate is eliminated through an `API_PATHS` builder, guarded by a consistency test, or intentionally excluded with rationale.
- Endpoint behavior and route strings are unchanged.

### P3.2 - Update Cron Connection-budget Model For Header-wait Semantics

Findings: S4, C3, C6.

Files:

- `shared/lib/cron-jobs.ts`
- `scripts/check-cron-connection-budget.ts`
- Add `scripts/lib/cron-connection-budget.ts`
- Add `scripts/__tests__/cron-connection-budget.test.ts`
- Scheduled handler comments under `worker/src/handlers/scheduled/*`
- `docs/worker-and-api-limits.md`
- `docs/testing.md`

Implementation steps:

1. Update `maxConnections` documentation to mean "peak outbound fetches waiting for response headers."
2. Add a phase model for sequential slots:

   ```ts
   export interface CronConnectionPhase {
     label: string;
     jobs: readonly string[];
     maxConnections: number;
   }
   ```

3. Define explicit phases for dense slots:
   - `quarterHourly`
   - `halfHourlyOffset`
   - `fourHourlyYieldSupplemental`
   - `daily0805Utc`
4. Refactor checker to compute:
   - `declaredTotalConnections`,
   - `peakHeaderWaitConnections`,
   - phase breakdown.
5. Fail when peak header-wait connections exceed 6.
6. Warn when peak is `>= 5`.
7. Optionally warn when declared total exceeds 6 but phases explain a lower peak.
8. Update docs for the Apr 09, 2026 Cloudflare behavior change.
9. Keep guidance to consume/cancel bodies for cleanup, memory, and retry behavior.

Validation:

```bash
vitest run scripts/__tests__/cron-connection-budget.test.ts
npm run check:cron-connections
npm run check:cron-sync
vitest run worker/src/__tests__/index.scheduled.test.ts
npm run check:doc-sync
```

Acceptance criteria:

- Checker reflects current platform semantics.
- Dense slots have explicit phase metadata or documented fallback.
- Docs no longer claim body reads hold the six-connection pool.

### P3.3 - Pin And Enforce npm Version Policy

Findings: S6, C6.

Files:

- `package.json`
- `.npmrc`
- `.github/actions/setup-workspace/action.yml`
- `scripts/__tests__/validate-ci-parity.test.ts`
- `docs/testing.md`
- `docs/deployment-process.md`

Implementation steps:

1. Add root:

   ```json
   "packageManager": "npm@11.12.1"
   ```

2. Decide local strictness:
   - Exact local: `"npm": "11.12.1"`
   - Lower friction: `"npm": ">=11.12 <12"`
3. Add `devEngines` only after verifying it does not disrupt local workflows.
4. In `.github/actions/setup-workspace/action.yml`, install pinned npm after `actions/setup-node` and before `npm ci`:

   ```bash
   npm install -g npm@11.12.1
   npm --version
   ```

5. Update tests and docs.
6. Add `engine-strict=true` only if team accepts stricter local enforcement. Otherwise enforce exact npm in CI and document local recommendation.

Validation:

```bash
npm -v
npm ci --dry-run
npm run lint
npm run typecheck
vitest run scripts/__tests__/validate-ci-parity.test.ts
```

Acceptance criteria:

- CI uses the intended npm version.
- Local policy is explicit and documented.

### P3.4 - Apply Dependency Patch/Minor Batches

Findings: S7, R13, C6.

Batch 1: Worker deploy tooling.

Command:

```bash
npm install --workspace worker --save-dev wrangler@4.83.0 @cloudflare/workers-types@4.20260415.1
```

Validation:

```bash
npm run typecheck
cd worker && npx tsc --noEmit
cd worker && npx tsc --noEmit -p tsconfig.scripts.json
cd worker && npx wrangler --version
npm run check:migrations
npm run check:cron-sync
```

Batch 2: Worker EVM/runtime dependency.

Command:

```bash
npm install --workspace worker viem@2.48.0
```

Validation:

```bash
vitest run worker/src/cron/blacklist/__tests__/evm-source.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts worker/src/cron/reserve-adapters/__tests__/usd1-bundle-oracle.test.ts
vitest run worker/src/lib/__tests__/evm-rpc.test.ts worker/src/lib/__tests__/evm-logs.test.ts
cd worker && npx tsc --noEmit
cd worker && npx tsc --noEmit -p tsconfig.scripts.json
```

Batch 3: Root patch drift.

Command:

```bash
npm install next@16.2.4 eslint-config-next@16.2.4 --save-exact
npm install --save-dev prettier@3.8.3 --save-exact
```

Validation:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
npm run test:critical-contracts
```

All batches:

```bash
npm audit --audit-level=high --omit=dev
npm audit --audit-level=high
npm ls --depth=0
npm ci --dry-run
```

Acceptance criteria:

- No new audit advisories.
- Lockfile is clean.
- Worker and Pages gates pass for affected surfaces.

### P3.5 - Formalize Duplication-scan And Workspace Hygiene

Findings: R12, R13, C6.

Files:

- Optional `.jscpd.json`
- Optional `scripts/run-duplication-scan.mjs`
- Optional `package.json` script
- `docs/scripts.md` if formal command is added
- `scripts/generate-agent-code-map.mjs` if broad scan skip list is expanded

Implementation steps:

1. Add a repeatable duplication scan command or `.jscpd.json` with ignores:
   - `**/node_modules/**`
   - `**/.next/**`
   - `**/out/**`
   - `**/coverage/**`
   - `**/worktrees/**`
   - `**/.worktrees/**`
   - `**/agents/**`
   - `**/public/**`
   - `**/worker/migrations/**`
   - `**/*.json`
   - `**/__tests__/**`
   - `**/*.test.ts`
   - `**/*.test.tsx`
   - `**/test/**`
   - `**/fixtures/**`
2. If useful, add `npm run audit:duplication`.
3. Do not add a blocking CI gate unless the team wants clone thresholds enforced.
4. Document local cleanup separately:

   ```bash
   rm -rf .next out coverage output
   npm ci
   ```

5. Do not delete `worktrees/` or `.worktrees/` without explicit confirmation.

Validation:

```bash
npm ls --depth=0
npm ci --dry-run
npm run audit:duplication
```

Acceptance criteria:

- Future duplication audits are repeatable and exclude generated/cloned source.

### P3.6 - Establish Supported Worker Operational Helper Surface

Findings: S1, R7, C2.

Purpose:

P1.2 fixes the immediate typecheck/import failure. This task addresses the root maintainability mechanism: production operational scripts currently import route/API implementation details that can drift during routine Worker refactors.

Files:

- Candidate new modules under `worker/src/lib/admin-backfill/`
- `worker/src/api/backfill-depegs-extraction.ts`
- `worker/src/api/backfill-depegs-preview.ts`
- `worker/src/api/backfill-depegs-window.ts`
- `worker/src/api/backfill-fx.ts`
- `worker/src/api/backfill-depegs.ts`
- `worker/scripts/repair-non-usd-fiat-depeg-history.ts`
- other `worker/scripts/*.ts`
- `scripts/check-worker-import-boundary.mjs`
- tests under `worker/src/api/__tests__/` and any new `worker/src/lib/admin-backfill/__tests__/`
- `docs/scripts.md`

Implementation steps:

1. Inventory every `worker/scripts/**` import from `../src/api/**`, `../src/cron/**`, and `../src/lib/**`.
2. Classify each imported helper as:
   - route-neutral reusable logic,
   - route handler or HTTP-only implementation detail,
   - cron-only implementation detail,
   - stable Worker lib API already safe to import.
3. Create supported route-neutral helper modules, for example:

   ```text
   worker/src/lib/admin-backfill/depeg-extraction.ts
   worker/src/lib/admin-backfill/depeg-preview.ts
   worker/src/lib/admin-backfill/depeg-window.ts
   worker/src/lib/admin-backfill/fx.ts
   ```

4. Move or re-export route-neutral helper functions from current `worker/src/api/backfill-*` modules into the new lib surface:
   - `parseSupplyData`
   - `extractDepegEvents`
   - `summarizeBackfillReplayDiff`
   - `ExistingDepegEventRow`
   - FX mapping/build helpers that are not HTTP-handler-specific
5. Update route handlers to import from `worker/src/lib/admin-backfill/*` instead of owning those helper contracts locally.
6. Update `worker/scripts/*` to import only from approved Worker lib/admin-backfill modules, shared modules, or explicitly documented operational surfaces.
7. Extend `scripts/check-worker-import-boundary.mjs` or add a companion rule:
   - `worker/scripts/**` may import `../src/lib/**` and `../src/lib/admin-backfill/**`.
   - `worker/scripts/**` may import `../src/cron/**` only through an explicit documented allowlist while the referenced cron helper remains operational-script-owned. Each allowlisted cron import must name the script, imported module, reason, owner, and preferred migration target.
   - Long-term target: route-neutral cron helper functions used by operational scripts should move into approved `worker/src/lib/**` surfaces before the allowlist is removed.
   - `worker/scripts/**` should not import `../src/api/**` route handler modules except for a temporary explicit allowlist with comments and an expiry task.
   - The rule must not block legitimate Worker operational access wholesale.
8. Add tests for the new boundary rule:
   - one documented cron import is accepted,
   - one unsupported private route-handler import is rejected,
   - one approved `../src/lib/admin-backfill/**` import is accepted.
9. Update `docs/scripts.md` to describe supported Worker script import surfaces.

Validation:

```bash
npm run check:worker-boundary
cd worker && npx tsc --noEmit
cd worker && npx tsc --noEmit -p tsconfig.scripts.json
vitest run worker/src/api/__tests__/backfill-depegs-helpers.test.ts worker/src/api/__tests__/backfill-depegs-dry-run.test.ts worker/src/api/__tests__/backfill-depegs.test.ts
npm run check:sql-safety
```

Optional operator-only dry-run after typecheck and tests pass:

```bash
cd worker && npx tsx scripts/repair-non-usd-fiat-depeg-history.ts --dry-run --stablecoin=<low-risk-id>
```

Acceptance criteria:

- Worker operational scripts no longer depend on private route handler modules for reusable backfill logic.
- CI/local checks fail if a new worker script imports unsupported private API surfaces.
- Route handlers and scripts share stable helper contracts without duplicating logic.

Risks:

- Moving helper modules can create broad import churn. Do P1.2 first, then keep this task as its own PR.
- Boundary hardening must be precise; an over-broad rule can break legitimate operational tooling.

### P4.1 - Extract Price-result Application Helper

Findings: R1, C3.

Files:

- `worker/src/cron/sync-stablecoins/pricing.ts`
- Add `worker/src/cron/__tests__/sync-stablecoins-pricing.test.ts`

Implementation steps:

1. Add a private `applyPriceResultsForAssets(input, options)` helper.
2. Preserve options:
   - `rejectionLabel`
   - `requiredCandidateSource`
   - `stampExistingWhenRejected`
   - `stampExistingWhenMissing`
   - optional `afterAssetApplied`
3. Rewrite `applyPrimaryPriceResults()` to pass primary consensus options and default missing `supplySource` to `defillama`.
4. Rewrite `applyGtProbeResults()` to pass GeckoTerminal source requirement.

Tests:

- Primary pass applies accepted result.
- Primary pass stamps existing valid price when missing.
- GT pass ignores non-GeckoTerminal primary result.
- GT pass applies GeckoTerminal-backed result.
- Supply source defaulting remains primary-pass-only.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/sync-stablecoins-pricing.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts
cd worker && npx tsc --noEmit
```

Acceptance criteria:

- Duplicate loop removed.
- Stage-specific behavior preserved.

### P4.2 - Merge Duplicate Supply-history Market-chart Backfill Branches

Findings: R2.

Files:

- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/__tests__/backfill-supply-history.test.ts`

Implementation steps:

1. Add local helper inside `handleBackfillSupplyHistory()`:

   ```ts
   async function runCoinGeckoMarketChartBackfill(meta: StablecoinMeta, failureLabel: string): Promise<void> {
     ...
   }
   ```

2. Keep:
   - gold/silver commodity short-circuit,
   - coingecko/commodity detail-provider skip behavior when missing `geckoId`,
   - existing error label distinction.
3. Do not alter downstream DefiLlama/native FX logic.

Tests:

- Commodity branch still uses market-chart path.
- Coingecko detail-provider branch still uses market-chart path.
- Missing `geckoId` still skips.
- Failure labels preserved.

Validation:

```bash
npx vitest run worker/src/api/__tests__/backfill-supply-history.test.ts
npm run check:sql-safety
```

### P4.3 - Extract Optional Yield Candidate Append Helper

Findings: R4.

Files:

- `worker/src/cron/yield-sync/resolve-helpers.ts`
- `worker/src/cron/__tests__/yield-resolve.test.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`

Implementation steps:

1. Add helper returning:
   - `"appended"`
   - `"duplicate"`
   - `"size-gated"`
   - `"missing-meta"`
2. Preserve direct-ID behavior:
   - missing metadata increments `unresolvedDrops`.
3. Preserve identity-resolution behavior:
   - ambiguous/unresolved counters happen before helper.
   - missing metadata remains silent unless explicitly changing behavior.
4. Keep blocked-source handling before resolution.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/yield-resolve.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts
```

Acceptance criteria:

- Duplicate append/gate logic is centralized.
- Drop counters remain stable.

### P4.4 - Consolidate EVM RPC Fallback Loop

Findings: R5.

Files:

- `worker/src/lib/evm-rpc.ts`
- `worker/src/lib/__tests__/evm-rpc.test.ts`

Implementation steps:

1. Extend private `fetchJsonRpcResult<T>()` with optional policy:

   ```ts
   interface JsonRpcResultPolicy<T> {
     acceptResult?: (value: T) => boolean;
     rejectedReason?: (value: T) => string;
   }
   ```

2. Reuse the shared loop from `fetchEvmCallHexAtBlock()` with:
   - method `eth_call`,
   - params `[callObj, blockTag]`,
   - `acceptResult` requiring `isHexResult(value) && value !== "0x"`.
3. Preserve logging wording for `eth_call`.
4. Preserve `gas`, timeout, retries, signal, and chain RPC fallback order.

Tests:

- First RPC returns `"0x"`, second returns valid hex; second is used.
- `gas` is included.
- All invalid results log failure and return null.

Validation:

```bash
npx vitest run worker/src/lib/__tests__/evm-rpc.test.ts worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts
cd worker && npx tsc --noEmit
```

### P4.5 - Extract Blacklist Post-fetch Counter Accumulation

Findings: R6.

Files:

- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/blacklist/post-fetch.ts`
- `worker/src/cron/__tests__/sync-blacklist.test.ts`

Implementation steps:

1. Add typed accumulator helpers for enrichment counters and current-balance counters.
2. Add a local `processRowsAndAccumulate(chainLabel, rows)` wrapper around `processFetchedBlacklistRows()`.
3. Replace duplicated Tron/EVM accumulation blocks.
4. Keep all chain-specific last-block/state advancement logic outside the helper.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts
npm run check:cron-connections
npm run check:sql-safety
```

### P4.6 - Consolidate Invariant CSS Tokens

Findings: R9, C5.

Files:

- `src/styles/tokens/semantic.css`

Implementation steps:

1. Keep invariant sidebar width, motion, easing, and transition tokens in `:root`.
2. Delete identical `.dark` declarations for those invariant tokens.
3. Keep `.dark` theme-specific surface/sidebar color aliases.

Validation:

```bash
npm run build
npm run serve:static-export
npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
```

Acceptance criteria:

- Visual behavior unchanged in light and dark modes.

### P4.7 - Remove Or Document Frontend Origin Wrapper

Findings: R10.

Files:

- `src/lib/site-config.ts`
- all consumers found by `rg "site-config|SITE_URL|API_URL" src`

Preferred implementation:

1. Replace imports with:

   ```ts
   import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
   ```

   and when needed:

   ```ts
   import { API_ORIGIN as API_URL, SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
   ```

2. Delete `src/lib/site-config.ts`.
3. Keep local aliases to minimize metadata churn.

Alternate:

- If maintainers want frontend semantic names, keep the wrapper and add a comment explaining that it is intentional metadata vocabulary over shared runtime origins.

Validation:

```bash
npm run typecheck
npm run build
npm run seo:check
npm run check:unused-code
```

### P4.8 - Consolidate Depeg Repair SQL Batching

Findings: R7, C2.

Files:

- `scripts/fix-commodity-depeg-median.ts`
- `scripts/fix-non-usd-depeg-fx.ts`
- Add `scripts/lib/depeg-repair-sql.ts`
- Add `scripts/__tests__/depeg-repair-sql.test.ts`

Implementation steps:

1. Add `buildDepegRepairStatements(toDelete, toUpdate, options)`.
2. Validate IDs are safe integers.
3. Validate bps/reference values are finite.
4. Batch deletes at the existing size.
5. Generate updates without changing recalculation logic.
6. Add optional `executeDepegRepairStatements()` if it reduces duplication without hiding behavior.
7. Keep dry-run output and live-mode side effects unchanged.

Tests:

- DELETE batching at 0, 1, 50, 51, and 101 IDs.
- UPDATE generation.
- Rejection of unsafe IDs and non-finite values.
- Dry-run does not execute if execution helper is injectable.

Validation:

```bash
vitest run scripts/__tests__/depeg-repair-sql.test.ts
npm run typecheck
npm run check:sql-safety
npm run check:unused-code
```

Optional operator dry-runs:

```bash
cd worker && npx tsx ../scripts/fix-commodity-depeg-median.ts --dry-run
cd worker && npx tsx ../scripts/fix-non-usd-depeg-fx.ts --dry-run
```

### P5.1 - Extract High-value Test Builders And Shared Validation Fixtures

Findings: R11, C5.

Files:

- `scripts/__tests__/smoke-ops.test.ts`
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts`
- `worker/src/lib/__tests__/depeg-helpers.test.ts`
- `worker/src/lib/__tests__/depeg-trust-policy.test.ts`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
- `scripts/check-redemption-backstops.ts`

Implementation steps:

1. In smoke ops tests:
   - add `transientProxyResponse(status)`,
   - add `healthyProxyResponse(body)`,
   - use `it.each([502, 504])`.
2. In EVM branch balances tests:
   - add `makeEvmBranchBalancesConfig(overrides)`.
3. Merge or rename depeg trust-policy tests so filenames match behavior.
4. Add shared redemption backstop family metadata:
   - candidate `shared/lib/redemption-backstop-family-modules.ts`
   - use it from both test and check script.

Validation:

```bash
npx vitest run scripts/__tests__/smoke-ops.test.ts worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts worker/src/lib/__tests__/depeg-trust-policy.test.ts shared/lib/__tests__/redemption-backstop-consistency.test.ts
npm run check:redemption-backstops
npm run check:worker-boundary
npm run check:unused-code
```

Acceptance criteria:

- Fixture duplication reduced without obscuring scenario intent.

### P5.2 - Split Oversized Critical Test Suites

Findings: Q8.

Files:

- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `worker/src/api/__tests__/status.test.ts`
- `package.json`

Implementation rules:

1. Extract helpers first; do not move tests and helpers in the same large commit unless necessary.
2. Split one suite per PR.
3. Update `package.json` exact test lists in the same PR.
4. Preserve critical coverage command semantics.
5. Use `vi.hoisted` or top-level mocks to preserve mock initialization order.

Split plan:

- `enrich-prices.test.ts`:
  - `price-bounds.test.ts`
  - `enrich-missing-prices.test.ts`
  - `primary-prices.test.ts`
  - `pool-challenge.test.ts`
  - helper `enrich-prices.helpers.ts`
- `sync-stablecoins.test.ts`:
  - `sync-stablecoins-core.test.ts`
  - `sync-stablecoins-pricing-continuity.test.ts`
  - `sync-stablecoins-supply-fallbacks.test.ts`
  - `sync-stablecoins-fallbacks.test.ts`
  - helper `sync-stablecoins.helpers.ts`
- `sync-yield-data.test.ts`:
  - `sync-yield-data-publication.test.ts`
  - `sync-yield-data-supplemental.test.ts`
  - `sync-yield-data-deterministic-rates.test.ts`
  - `sync-yield-data-history.test.ts`
  - `sync-yield-data-coverage-guards.test.ts`
  - helper `sync-yield-data.helpers.ts`
- `status.test.ts`:
  - `status-auth-cache.test.ts`
  - `status-cron-health.test.ts`
  - `status-data-quality.test.ts`
  - `status-availability.test.ts`
  - `status-missing-prices.test.ts`
  - `status-telegram-ops.test.ts`

Validation for each split:

```bash
npm test
npm run coverage:critical
npm run test:invariants
npm run check:unused-code
```

Acceptance criteria:

- Critical coverage and invariant scripts still cover the same behavior.
- Failures localize to smaller test files.

### P5.3 - Data-drive DEWS Methodology Diagram

Findings: R3.

Files:

- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
- Optional section test under methodology tests

Implementation steps:

1. Add local `DEWS_SIGNAL_CARDS` and `DEWS_BAND_CARDS` arrays.
2. Use `mobileLabel` where mobile needs shorter text.
3. Add leaf components:
   - `DewsSignalCard`
   - `DewsBandCard`
   - optional `DewsScoreFormulaCard`
4. Keep separate desktop and mobile layout wrappers.
5. Do not change public methodology copy, weights, or band ranges.

Validation:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
```

For visual check:

```bash
npm run serve:static-export
npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
```

Acceptance criteria:

- Duplicate data removed.
- Desktop/mobile visual structure preserved.

### P6.1 - Decompose DEX Discovery `crawlCoin`

Findings: Q5, S3, C3.

Files:

- `worker/src/cron/dex-discovery/crawl-sources.ts`
- Candidate new files:
  - `worker/src/cron/dex-discovery/crawl-context.ts`
  - `worker/src/cron/dex-discovery/crawl-cg-onchain.ts`
  - `worker/src/cron/dex-discovery/crawl-geckoterminal.ts`
  - `worker/src/cron/dex-discovery/crawl-dexscreener.ts`
  - `worker/src/cron/dex-discovery/crawl-cg-tickers.ts`

Implementation steps:

1. Extract `CrawlCoinContext` with add-pool/add-price observation methods, deadline handling, and signal creation.
2. Extract stage functions in current execution order:
   - CoinGecko onchain,
   - GeckoTerminal,
   - DexScreener,
   - CoinGecko tickers.
3. Keep `crawlCoin()` as orchestration.
4. Preserve provider order, budget checks, and diagnostics.

Validation:

```bash
npx vitest run worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts worker/src/cron/dex-discovery/__tests__/sync-dex-discovery.test.ts
npm run check:cron-connections
```

### P6.2 - Decompose DEX Liquidity Metadata Analysis

Findings: Q5, S3.

Files:

- `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`
- Candidate new files:
  - `metadata-baselines.ts`
  - `metadata-coverage.ts`
  - `metadata-drift.ts`
  - `metadata-protocol-caps.ts`

Implementation steps:

1. Extract previous baseline loading.
2. Extract coverage guard computation.
3. Extract watchlist delta and quality drift flags.
4. Extract source-family and protocol-cap summaries.
5. Keep final metadata assembly stable.

Validation:

```bash
npx vitest run worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts
```

### P6.3 - Decompose Pending Depeg Confirmation

Findings: Q5.

Files:

- `worker/src/cron/confirm-pending-depegs.ts`
- Candidate new files:
  - `worker/src/cron/depegs/confirmation-sources.ts`
  - `worker/src/cron/depegs/confirmation-decision.ts`
  - `worker/src/cron/depegs/confirmation-mutations.ts`

Implementation steps:

1. Extract evidence collection.
2. Extract pure decision table returning `skip`, `delete`, or `promote`.
3. Extract event construction.
4. Keep DB loading and batch mutations in the original orchestration until tests stabilize.
5. Preserve low-confidence/offchain-only confirmation rules.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs-decision.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
```

### P6.4 - Decompose Primary Price Fetch And Consensus

Findings: Q5, S3, C3.

Files:

- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- Candidate new files:
  - `primary-price-provider-fetches.ts`
  - `primary-price-consensus.ts`
  - optionally `primary-price-plan.ts`

Implementation steps:

1. Extract provider quote collection into `fetchPrimaryProviderQuotes()`.
2. Use a typed quote bundle instead of many parallel local variables.
3. Keep consensus assembly in or near existing helper until provider collection is stable.
4. Keep circuit-breaker, source-allowed, timeout, and diagnostic behavior unchanged.
5. Only split tests after P5.2 helper work.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts
npm run audit:pricing-providers
```

### P6.5 - Decompose Telegram Alert Dispatch

Findings: S3.

Files:

- `worker/src/cron/dispatch-telegram-alerts.ts`
- Candidate new files:
  - `worker/src/cron/telegram-alerts/candidates.ts`
  - `worker/src/cron/telegram-alerts/render.ts`
  - `worker/src/cron/telegram-alerts/delivery.ts`
  - `worker/src/cron/telegram-alerts/queue.ts`

Implementation steps:

1. Extract candidate selection first.
2. Extract message rendering as pure functions.
3. Extract delivery/retry/blocked subscriber side effects.
4. Extract queue overflow handling only after delivery tests are stable.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts worker/src/cron/__tests__/telegram-pending-queue.test.ts worker/src/cron/__tests__/telegram-alert-snapshots.test.ts
```

### P6.6 - Extract Frontend View-models For Hotspot Components

Findings: Q6, S3, C5.

Priority order:

1. `src/components/contagion-graph.tsx`
2. `src/components/status/api-keys-panel.tsx`
3. `src/components/stablecoin-detail/hero-card.tsx`
4. `src/components/kpi-bar.tsx`
5. `src/components/command-palette.tsx`
6. `src/app/yield/client.tsx`
7. `src/app/status/client.tsx`
8. Later backlog: `src/lib/coverage.ts`, `src/app/stability-index/client.tsx`

Implementation pattern:

1. Extract pure view-model helpers first.
2. Add pure model tests.
3. Keep React state, pointer/keyboard handlers, and DOM projection in components until model extraction is stable.
4. Split leaf components only after the model extraction leaves obvious rendering clusters.
5. Run UI/build checks for every visual/layout change.

Component-specific first steps:

- `ContagionGraph`: add `contagion-graph-view-model.ts` for visible node/edge/label/summary models.
- `ApiKeysPanel`: add `api-keys-panel-model.ts`, then split form/row/token reveal/error banner.
- `HeroCard`: add `hero-card-model.ts` for badges, peg/depeg copy, metric inclusion, and risk labels.
- `KpiBar`: add `kpi-bar-model.ts` for KPI derivation, loading/empty state, and trend labels.
- `CommandPalette`: add indexing/filtering helper and keyboard navigation hook.
- `YieldClient`: add `yield-view-model.ts` for filtering, sorting, warning summaries, and empty states.
- `StatusClient`: add `status-view-model.ts` for section grouping and public display state.

Validation per tranche:

```bash
npm run lint
npm run typecheck
npm run build
npm run check:hotspot-ratchet
npm run serve:static-export
npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
```

Acceptance criteria:

- Behavior and layout remain stable.
- Hotspot metrics decrease or waiver metadata is intentionally updated.

## 6. Finding Coverage Matrix

| Finding | Plan item |
| --- | --- |
| R1 | P4.1 |
| R2 | P4.2 |
| R3 | P5.3 |
| R4 | P4.3 |
| R5 | P4.4 |
| R6 | P4.5 |
| R7 | P4.8 |
| R8 | P3.1 |
| R9 | P4.6 |
| R10 | P4.7 |
| R11 | P5.1 |
| R12 | P3.5 |
| R13 | P3.4, P3.5 |
| Q1 | P2.1 |
| Q2 | P2.2 |
| Q3 | P2.4 |
| Q4 | P2.5 |
| Q5 | P6.1, P6.2, P6.3, P6.4 |
| Q6 | P6.6 |
| Q7 | P2.3 |
| Q8 | P5.2 |
| Q9 | P1.3 |
| Q10 | P1.5 |
| S1 | P1.2, P3.6 |
| S2 | P1.1 |
| S3 | P6.1-P6.6 |
| S4 | P3.2 |
| S5 | P1.4 |
| S6 | P3.3 |
| S7 | P3.4 |

## 7. Open Decisions Before Implementation

1. Portfolio zero drafts: keep zero rows persisted/shareable, or introduce separate UI draft state?
2. Reserve total policy: enforce `100 +/- 0.5` with allowlist now, or start with `total > 0` only?
3. npm strictness: exact npm version for all contributors, or exact in CI with local major range?
4. Cron field naming: rename `maxConnections` to `maxHeaderWaitConnections`, or keep name and correct comments/docs?
5. Route builders: use `Base` suffix for definition path builders, or allow existing parameterized builders to omit params?
6. Depeg repair scripts: keep as runbooks, move under `worker/scripts`, or retire after operator confirmation?
7. Duplication scan: package script only, or CI warning/non-blocking job?

## 8. Validation Gates By Phase

Phase 1:

```bash
vitest run scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts
cd worker && npx tsc --noEmit -p tsconfig.scripts.json
vitest run src/lib/__tests__/api-fetch-contracts.test.ts
npm run check:doc-sync
npm run check:verified-doc-links
npm run lint
npm run typecheck
npm run build
```

Phase 2:

```bash
npm test -- src/lib/__tests__/portfolio-codec.test.ts src/lib/__tests__/portfolio-analysis.test.ts src/hooks/__tests__/use-portfolio.test.ts src/hooks/__tests__/use-stress-test.test.ts src/components/__tests__/stress-test-panel.test.tsx src/__tests__/portfolio-categorize.test.ts shared/lib/__tests__/stablecoins.test.ts
npm run check:stablecoin-data
npx vitest run worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm run build
```

Phase 3:

```bash
vitest run src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts
npm run test:critical-contracts
vitest run scripts/__tests__/cron-connection-budget.test.ts
npm run check:cron-connections
npm audit --audit-level=high --omit=dev
npm audit --audit-level=high
npm ci --dry-run
npm ls --depth=0
npm run check:worker-boundary
cd worker && npx tsc --noEmit -p tsconfig.scripts.json
vitest run scripts/__tests__/worker-script-boundary.test.ts
```

Phase 4:

```bash
npx vitest run worker/src/cron/__tests__/sync-stablecoins-pricing.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/yield-resolve.test.ts worker/src/lib/__tests__/evm-rpc.test.ts worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/api/__tests__/backfill-supply-history.test.ts
npm run check:sql-safety
cd worker && npx tsc --noEmit
npm run build
```

Phase 5:

```bash
npm test
npm run coverage:critical
npm run test:invariants
npm run check:unused-code
npm run build
npm run seo:check
```

Phase 6:

```bash
npm run check:hotspot-ratchet
npm run check:shared-cycles
npm run check:worker-boundary
npm test
npm run coverage:critical
npm run test:merge-gate
```

## 9. Plan Review Loop

Loop policy:

- A review phase must classify plan issues as `critical`, `major`, `medium`, or `minor`.
- The loop can stop only when a review phase returns:
  - zero `critical`, `major`, and `medium` issues, and
  - fewer than two `minor` issues.
- Every non-accepted issue must be patched into this plan, not only acknowledged.

Review status:

- Draft 0: this file as initially written.
- Review pass 1: rejected with 0 critical, 0 major, 2 medium, and 2 minor issues.
- Fixes after pass 1:
  - Added P3.6 for supported Worker operational helper surfaces and worker-script import boundary hardening.
  - Expanded P3.1 so every known R8 duplicate route/probe path must be eliminated, guarded, or intentionally excluded with rationale.
  - Moved Q10 into Phase 1 as P1.5 and updated the coverage matrix.
  - Added explicit `npm run serve:static-export` prerequisites for local smoke UI validation blocks.
- Review pass 2: rejected with 0 critical, 0 major, 1 medium, and 1 minor issue.
- Fixes after pass 2:
  - Tightened P3.1 to require exact-preserving probe/action builders or disposition tests for every current `path`, `probePath`, and `statusPageAction.path` literal in `definitions.ts`.
  - Added the missing R8 literals called out in review, including `/api/api-keys/audit-log`, `/api/debug-sync-state`, `/api/status-history?limit=10`, and `/api/audit-depeg-history?dry-run=true`.
  - Replaced unsafe defaulted probe-builder examples with instructions to add exact-equivalent base/probe helpers or tests proving output equality.
  - Clarified P3.6 so `worker/scripts/**` cron imports are allowed only through an explicit documented allowlist until route-neutral helpers move to approved Worker lib surfaces.
- Review pass 3: rejected with 0 critical, 0 major, 1 medium, and 1 minor issue.
- Fixes after pass 3:
  - Added missing `/api/mint-burn-events?stablecoin=usdt-tether` to the P3.1 disposition coverage list.
  - Strengthened P3.1 to require a generated test that derives current `path`, `probePath`, and `statusPageAction.path` values from `ENDPOINT_DEFINITIONS` and compares them against the disposition table.
  - Added P3.6 validation commands to the Phase 3 gate, including `npm run check:worker-boundary`, Worker script typecheck, and a named worker-script boundary test.
- Review pass 4: accepted with 0 critical, 0 major, 0 medium, and 1 minor issue.
- Accepted residual minor issue:
  - Some validation snippets use direct `vitest run ...` instead of `npx vitest run ...`. The reviewer classified this as copy-paste reliability only, not a plan blocker. Implementers may normalize those snippets before execution.
