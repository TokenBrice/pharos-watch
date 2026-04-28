# Audit Remediation Implementation Plan

Date: 2026-04-28  
Source audit: `agents/audits/2026-04-28-comprehensive-three-pillar-codebase-audit.md`  
Scope: Remediate all 23 primary findings and 5 cross-cutting concerns from the three-pillar audit.

## 1. Objectives

This plan converts the audit findings into an implementation sequence that can be executed through small, reviewable changes without weakening the dashboard's current deployment safety.

Primary objectives:

- Remove confirmed duplicate and stale code paths where the behavior is already obsolete or can be safely centralized.
- Improve correctness at runtime boundaries: cache writes, D1 reads, provider payload parsing, local storage parsing, browser download handling, and shell command execution.
- Harden operational scripts before further reuse.
- Reduce long-term maintenance risk in the largest hotspots: depeg detection, stablecoin sync fallback, stablecoin catalog ownership, environment contract rendering, and cron connection scheduling.
- Preserve current user-facing and API behavior unless a finding explicitly requires safer behavior.

Non-goals:

- Do not redesign UI or product workflows.
- Do not introduce new data sources.
- Do not change methodology outputs except where the remediation modifies depeg, fallback sync, pricing/fallback behavior, or other documented methodology surfaces.
- Do not combine high-risk runtime refactors with broad formatting or unrelated dependency churn.
- Do not remove compatibility code that still protects a deployed database until the deployed state is verified.

## 2. Global Assumptions and Constraints

- Work is performed on the current repository state.
- Each implementation package should be independently mergeable.
- Runtime-neutral shared logic remains under `shared/lib` and `shared/types`; worker-only logic stays under `worker/src` or `worker/scripts`.
- Tailwind classes remain static strings.
- Cloudflare D1 migrations must remain backward-compatible with the currently deployed Worker.
- Any change to pricing pipeline, PSI, PegScore/DEWS, LiquidityScore, Report Cards, blacklist tracker, mint/burn flow, yield intelligence, or Chain Health must update `/methodology` and the relevant timeline/changelog documentation.
- Every package that touches deploy-impacting code must pass `npm run test:merge-gate` before push.

## 3. Definition of Done

Every work package is done only when all applicable items are true:

- The finding IDs listed for that package are fully addressed or explicitly marked as intentionally deferred with a reason.
- Existing behavior is covered by characterization tests before risky refactors.
- New or changed behavior has focused tests.
- Relevant docs are updated when behavior, APIs, pipeline, methodology, environment variables, deployment, or operator workflow changes.
- `npm run lint` passes for code changes.
- `npm run typecheck` passes for frontend/shared TypeScript changes.
- `cd worker && npx tsc --noEmit` passes for worker runtime changes.
- `npm run typecheck:worker-scripts` passes for worker script changes.
- Relevant targeted `vitest run ...` commands pass.
- `npm run test:merge-gate` passes before push for deploy-impacting diffs.

## 4. Baseline Validation Before Remediation

Run this before starting the first code package and record the output in the PR or task tracker:

```bash
git status --short
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm run typecheck:worker-scripts
npm run check:unused-code
npm run check:shared-cycles
npm run check:worker-boundary
npm run check:hotspot-ratchet
npm run check:cron-sync
npm run check:cron-connections
npm run check:env-contract
npm run check:doc-sync
npm run check:verified-doc-links
npm run check:doc-source-paths
npm audit --json --audit-level=low
npm run audit:deps
```

For large runtime refactors, also run:

```bash
npm test
npm run build
```

## 5. Implementation Sequence Overview

Execute in this order:

1. **Track B - Operational script hardening.** Addresses Q004 and R007 first because Q004 is the highest-risk finding and affects destructive remote D1 writes.
2. **Track A - Low-risk guardrail and browser/runtime safety fixes.** Addresses Q001, Q007, Q008, Q009, and the low-risk parts of R006/S007.
3. **Track C - Runtime boundary correctness.** Addresses Q002 and Q003 with focused tests.
4. **Track D - Small redundancy removals.** Addresses R004, R005, R003, and R001 after deployed-state verification.
5. **Track E - Validation runner consolidation.** Addresses R002 after Q009 removes the shell-interpolation risk.
6. **Track F - Medium hotspot extractions.** Addresses Q005, Q006, and S004.
7. **Track G - Cron capacity governance.** Addresses S005 and protects future cron work.
8. **Track H - High-risk runtime hotspot refactors.** Addresses S002 and S003 with characterization tests first.
9. **Track I - Stablecoin catalog source-of-truth migration.** Addresses S001 as a dedicated structural project.
10. **Track J - Toolchain and optional dependency follow-up.** Addresses S006. J2 is optional unless a supported Next.js patch directly resolves S007's vendored PostCSS advisory.

## 6. Work Packages

Work packages are documented by track label for lookup. Execute them in the order defined in Sections 5 and 8; B1 is the first implementation package.

### A1 - Make Site Data Cache Writes Best-Effort

Findings: Q001  
Priority: High quick win  
Files:

- `functions/_site-data/[[path]].ts`
- `functions/__tests__/site-data-proxy.test.ts`

Implementation steps:

1. In `onRequest`, keep response construction unchanged.
2. Replace the awaited `getDefaultCache().put(cacheKey, response.clone())` call with a best-effort background write.
3. Prefer `context.waitUntil(getDefaultCache().put(...).catch(...))` if the Pages function context supports it in the existing test harness.
4. If the harness lacks `waitUntil`, add it to the test mock rather than changing production semantics.
5. Log cache-write failures at the same operational level as existing proxy diagnostics.
6. Return the original response regardless of cache-write failure.

Tests:

- Add or update a `site-data-proxy` test where `Cache.put()` rejects and the function still returns the upstream response.
- Verify the failure is passed to `waitUntil` or logged without changing the response status.

Validation:

```bash
npx vitest run functions/__tests__/site-data-proxy.test.ts
npm run typecheck
npm run lint
```

Rollback:

- Revert the one function change and test. No data migration involved.

### A2 - Normalize LocalStorage State Shapes

Findings: Q007  
Priority: Low quick win  
Files:

- `src/hooks/use-nav-collapse.ts`
- `src/hooks/use-command-palette-history.ts`
- `src/hooks/__tests__/use-nav-collapse.test.ts`
- `src/hooks/__tests__/use-command-palette-history.test.ts`

Implementation steps:

1. Add a local helper in `use-nav-collapse.ts` that accepts `unknown` and returns only `Record<string, boolean>` entries.
2. Reject arrays, null, and non-object parsed values.
3. Ignore entries where the key is not a string or the value is not boolean.
4. In `use-command-palette-history.ts`, treat parsed values as `unknown`.
5. Only call `normalizeHistory()` after an `Array.isArray()` check.
6. Keep existing invalid-JSON behavior: corrupted storage should not throw through render.
7. Do not add shared abstractions unless the two helpers become materially identical.

Tests:

- `use-nav-collapse`: valid object, invalid JSON, valid wrong-shape JSON, mixed valid/invalid entries.
- `use-command-palette-history`: array success, object instead of array, null, primitive, malformed item inside a valid array.

Validation:

```bash
npx vitest run src/hooks/__tests__/use-nav-collapse.test.ts src/hooks/__tests__/use-command-palette-history.test.ts
npm run typecheck
npm run lint
```

Rollback:

- Revert hook changes and tests. No persisted data migration needed because invalid stored shapes remain recoverable.

### A3 - Defer Object URL Revocation for Downloads

Findings: Q008  
Priority: Low quick win  
Files:

- `src/components/share-button.tsx`
- `src/lib/csv-export.ts`
- Existing or new tests under `src/components/__tests__` and `src/lib/__tests__`

Implementation steps:

1. Preserve current download filename and MIME behavior.
2. Trigger the programmatic click as today.
3. Defer `URL.revokeObjectURL(url)` with `setTimeout(() => URL.revokeObjectURL(url), 0)` or `requestAnimationFrame`.
4. Prefer a tiny local helper only if both files can share it without adding an awkward dependency direction.
5. If adding a helper, place it in `src/lib/download-object-url.ts` and keep it browser-only.

Tests:

- Verify `URL.createObjectURL` is called with the expected blob.
- Verify `URL.revokeObjectURL` is not called synchronously before the click completes.
- Verify revocation eventually happens after timers advance.

Validation:

```bash
npx vitest run src/components/__tests__/share-button.test.tsx src/lib/__tests__/csv-export.test.ts
npm run typecheck
npm run lint
```

If the exact test files do not exist, create focused tests beside the closest existing test suite and run those files.

Rollback:

- Revert helper and call-site changes. No external state.

### A4 - Remove Shell Interpolation for Git Refs

Findings: Q009, C005  
Priority: Low quick win with security benefit  
Files:

- `scripts/classify-deploy-changes.mjs`
- `scripts/test-merge-gate.mjs`
- `scripts/check-critical-coverage.mjs`
- `scripts/__tests__/classify-deploy-changes.test.ts`
- `scripts/__tests__/test-merge-gate.test.ts`
- Add tests for `check-critical-coverage` if none exist.

Implementation steps:

1. Replace `execSync(\`git ... ${ref} ...\`)` with `execFileSync("git", [...args])`.
2. Preserve current cwd, stdio, encoding, and error behavior.
3. If helper extraction is useful, add `scripts/lib/git-command.mjs` with small wrappers:
   - `gitMergeBase(baseRef, headRef)`
   - `gitDiffNameOnly(rangeArgs)`
4. Keep helper scope narrow. Do not start the full R002 command-runner refactor here.
5. Add tests with malicious-looking branch names to prove they are passed as args, not shell-evaluated.

Tests:

- Existing deploy-change classifier tests.
- Existing merge-gate tests.
- New critical coverage git-diff tests if this script currently lacks coverage.

Validation:

```bash
npx vitest run scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/check-critical-coverage.test.ts
npm run coverage:critical
npm run lint
```

If `scripts/__tests__/check-critical-coverage.test.ts` does not exist yet, create focused tests for `CRITICAL_COVERAGE_COMPARE_REF` handling before counting A4 complete.

`npm run coverage:critical` can be expensive, but it is appropriate here because A4 changes the git-ref handling used by the critical coverage comparison path.

Rollback:

- Revert helper and script changes. No data state.

### A5 - Resolve Commented Bridge Validation Policy

Findings: R006  
Priority: Low quick win, policy cleanup  
Files:

- `worker/src/lib/mint-burn-contracts.ts`
- `worker/src/lib/__tests__/mint-burn-contracts.test.ts`
- Documentation only if the strict/audit policy is not already documented.

Implementation steps:

1. Confirm existing behavior: bridge validation errors are collected and logged, not thrown.
2. If current behavior is intentional, delete the commented-out strict throw block.
3. Add a short comment explaining the audit-and-report policy only if the surrounding code would otherwise be ambiguous.
4. If strict behavior is desired, add an explicit tested switch. Do not silently make strict throwing the default in the same cleanup PR.

Tests:

- Existing mint/burn contracts tests should continue passing.
- If a policy comment is the only code change, no new test is required.
- If behavior changes, add tests for invalid bridge metadata under both audit and strict modes.

Validation:

```bash
npx vitest run worker/src/lib/__tests__/mint-burn-contracts.test.ts
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Revert the comment/block removal or strict-mode change.

### A6 - Record Next/PostCSS Advisory Triage

Findings: S007  
Priority: Low investigation  
Files:

- `agents/tasks/2026-04-28-next-postcss-advisory-triage.md` or an existing dependency-tracking task
- No production code unless a supported patch is identified.

Implementation steps:

1. Re-run:

   ```bash
   npm audit --json --audit-level=low
   npm ls next postcss --all
   npm outdated --json
   ```

2. Document whether the vulnerable PostCSS path is reachable in this static export pipeline.
3. Check whether a newer supported Next.js patch resolves the vendored PostCSS version.
4. Do not force a dependency override unless a local reproduction proves reachability and the override is known to be safe with Next 16.
5. If only risk acceptance is justified, record the advisory ID, dependency path, current Next version, and revisit date.

Validation:

```bash
npm audit --json --audit-level=low
npm run audit:deps
```

Rollback:

- Documentation-only unless a dependency update is chosen.

### B1 - Harden KYC Current-Balance Reconciliation Before Reuse

Findings: Q004, R007, C001  
Priority: Highest implementation priority  
Files:

- `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts`
- `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts`
- `scripts/lib/remote-d1.ts`
- New or existing tests under `worker/scripts/__tests__` or `scripts/__tests__`
- Operator docs if these scripts are documented.

Implementation steps:

1. Inventory how operators currently run both KYC scripts.
2. Add explicit CLI mode parsing:
   - default: dry-run
   - write mode: require `--apply`
   - optional: `--timeout-ms`, `--min-rows`, `--database`, `--remote`
3. For `reconcile-blacklist-current-balances-from-kyc-rip.ts`, prevent destructive SQL from executing unless `--apply` is present.
4. Print a dry-run summary before any write:
   - provider URL
   - fetched row count
   - normalized row count
   - affected assets/chains
   - rows that would be deleted/replaced
   - rows that would be inserted
5. Add runtime guards for the external `kyc.rip` response:
   - top-level payload is the expected array/object shape
   - required asset, chain, address, amount fields are present
   - unsupported chains/assets are skipped with counted warnings
   - malformed rows fail the run if they exceed a small threshold
6. Add fetch timeout with `AbortController`.
7. Add a bounded retry policy for transient network failures and provider 5xx responses. Do not retry schema-validation failures, unsupported payloads, or below-minimum-row responses. Apply destructive-write guards only after the final accepted payload passes validation.
8. Add a minimum row-count guard. Make the default conservative and visible in CLI output.
9. Prefer staging-table or transaction-like replacement:
   - build insert SQL for a temporary/staging table when possible
   - compare counts before deleting current rows
   - only replace the target rows after validation succeeds
10. Consolidate D1 command execution:
   - if `scripts/lib/remote-d1.ts` can be imported cleanly by worker scripts, reuse it
   - otherwise create `worker/scripts/lib/remote-d1.ts` and keep API parity with the root helper
   - remove duplicate `executeWrangler` and `sqlString` implementations from both KYC scripts
11. Make event reconciliation share the same fetch timeout and response validation helpers without changing its write semantics beyond safety improvements.
12. Add operator-facing docs or an inline `--help` output that makes dry-run/apply behavior explicit.
13. If blacklist tracker behavior changes beyond operator safety controls, update `/methodology` and the relevant timeline/changelog doc in the same PR.

Tests:

- CLI parsing: dry-run default, `--apply`, invalid flags.
- External fetch: timeout, transient retry success, retry exhaustion, provider 5xx retry, malformed JSON, wrong payload shape, empty response, below-minimum rows.
- SQL generation: dry-run does not call D1 execution; apply mode calls it once with expected statements.
- Current-balance replacement: delete/insert SQL is only generated after guards pass.
- Shared D1 helper escaping behavior remains unchanged.

Validation:

```bash
npm run typecheck:worker-scripts
npx vitest run worker/scripts/__tests__/reconcile-blacklist-current-balances-from-kyc-rip.test.ts worker/scripts/__tests__/reconcile-blacklist-events-from-kyc-rip.test.ts
npm run lint
```

If tests are created under `scripts/__tests__`, run those files instead or in addition.

If inline `--help` output becomes the operator-facing documentation surface, validate that help output in tests or a non-mutating CLI smoke.

Rollback:

- Revert script/helper changes. No D1 migration involved.
- If a staging table is introduced, ensure the script cleans it up or uses temporary D1 constructs that do not persist.

### C1 - Restrict Price Cache Schema Fallback

Findings: Q002, C002  
Priority: Medium, runtime correctness  
Files:

- `worker/src/lib/db-cache.ts`
- New or existing `worker/src/lib/__tests__/db-cache.test.ts`
- Downstream tests around `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`

Implementation steps:

1. Add a small helper, for example `isMissingColumnError(error: unknown): boolean`.
2. Match only known D1 missing-column/schema-drift signatures. Start with `no such column` and add other observed D1 messages only if tests prove they are needed.
3. In `getPriceCache()`, only run the core-column fallback when the helper returns true.
4. Re-throw unexpected errors or return an explicit degraded failure only if the existing caller contract requires non-throwing behavior.
5. Preserve the existing fallback projection for actual missing-column cases.
6. Ensure logs distinguish schema fallback from unexpected read failure.

Tests:

- Full schema query succeeds and returns metadata fields.
- Full schema query throws `no such column`; core fallback succeeds.
- Full schema query throws a generic D1/network error; fallback is not attempted and the error is visible.
- Existing mint/burn price-heal tests still pass.

Validation:

```bash
npx vitest run worker/src/lib/__tests__/db-cache.test.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Revert `db-cache.ts` helper and tests. No persistent data change.

### C2 - Validate Cloudflare D1 Status Payloads

Findings: Q003  
Priority: Medium, operational correctness  
Files:

- `worker/src/lib/status/d1-usage.ts`
- New `worker/src/lib/status/__tests__/d1-usage.test.ts` or `worker/src/lib/__tests__/d1-usage.test.ts`
- `src/components/status/__tests__/d1-usage-card.test.tsx` if UI assumptions change

Implementation steps:

1. Keep `fetchJson()` as a raw JSON helper returning `unknown`.
2. Add explicit parsers/guards:
   - Cloudflare REST database info envelope
   - Cloudflare GraphQL analytics envelope
   - GraphQL partial error handling
3. Return the existing public status shape for valid payloads.
4. For malformed payloads, return a clear unavailable/degraded status or throw a typed error based on current caller expectations.
5. Do not add a new dependency unless the repo already uses one for runtime parsing. Prefer lightweight local guards.
6. Ensure missing optional fields are handled intentionally, not through implicit `undefined` traversal.

Tests:

- Valid REST and GraphQL fixtures.
- REST success with missing nested fields.
- GraphQL response with `errors`.
- GraphQL response with missing analytics nodes.
- Non-JSON or invalid JSON response if the existing fetch helper can surface it.

Validation:

```bash
npx vitest run worker/src/lib/status/__tests__/d1-usage.test.ts src/components/status/__tests__/d1-usage-card.test.tsx
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Revert parser changes and tests.

### D1 - Replace Local Blacklist Event API Type

Findings: R004, C003  
Priority: Small redundancy cleanup  
Files:

- `shared/types/market.ts`
- `worker/src/lib/blacklist-api.ts`
- `worker/src/api/blacklist.ts`
- `worker/src/api/__tests__/blacklist.test.ts`
- `src/lib/__tests__/blacklist-api.test.ts`

Implementation steps:

1. Confirm the public API response shape matches `BlacklistEvent` exactly.
2. If it matches, delete `BlacklistEventApiRecord`.
3. Type `fetchPaginatedEvents()` or its row mapper with the shared type at the boundary.
4. If the response intentionally differs, create one explicit shared response type and use it in both worker and frontend API code.
5. Avoid changing JSON field names in this package.

Tests:

- Existing worker blacklist API tests.
- Existing frontend blacklist API tests.
- Add a compile-time assertion if useful to ensure response type drift is caught.

Validation:

```bash
npx vitest run worker/src/api/__tests__/blacklist.test.ts src/lib/__tests__/blacklist-api.test.ts
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Reintroduce local type if an unexpected response difference is discovered.

### D2 - Extract Stablecoin Taxonomy Page Factory

Findings: R005  
Priority: Small redundancy cleanup  
Files:

- `src/app/stablecoins/backing/page.tsx`
- `src/app/stablecoins/governance/page.tsx`
- `src/app/stablecoins/infrastructure/page.tsx`
- New helper near the route, for example `src/app/stablecoins/taxonomy-page.tsx`
- `src/app/stablecoins/__tests__/taxonomy-hub-pages.test.tsx`

Implementation steps:

1. Create a helper that accepts a taxonomy route descriptor and returns the page component plus metadata helper if the current files duplicate both.
2. Keep each route file explicit for Next.js routing:
   - import the descriptor
   - export metadata
   - default export the bound page
3. Preserve current titles, descriptions, totals, and props exactly.
4. Do not alter the hub component itself unless the helper requires a narrow prop type improvement.

Tests:

- Existing taxonomy hub page tests should prove metadata and page behavior remain unchanged.

Validation:

```bash
npx vitest run src/app/stablecoins/__tests__/taxonomy-hub-pages.test.tsx
npm run typecheck
npm run lint
```

Rollback:

- Restore the three page files.

### D3 - Centralize FX Cadence Rules

Findings: R003, C003  
Priority: Medium redundancy cleanup  
Files:

- `worker/src/lib/fx-rate-state.ts`
- `worker/src/lib/fx-source-metadata.ts`
- New helper, likely `worker/src/lib/fx-cadence.ts`
- `worker/src/lib/__tests__/fx-rate-state.test.ts`
- `worker/src/cron/__tests__/sync-fx-rates.test.ts`

Implementation steps:

1. Create one canonical module that exports:
   - business-daily peg set
   - calendar-daily peg set
   - cadence classifier
2. Move the duplicated peg allowlists into the canonical module.
3. Update `fx-rate-state.ts` to import the classifier.
4. Update `fx-source-metadata.ts` to import the same classifier or exported sets.
5. Preserve current cadence output for every known peg.
6. Add a test that enumerates all pegs in both previous lists and checks classifier parity.

Tests:

- Existing FX state tests.
- Sync FX rates tests.
- New cadence parity/unit tests.

Validation:

```bash
npx vitest run worker/src/lib/__tests__/fx-rate-state.test.ts worker/src/cron/__tests__/sync-fx-rates.test.ts
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Restore constants in original modules.

### D4 - Remove Mint/Burn Legacy Sync-Key Fallback After Deployed-State Verification

Findings: R001, C002  
Priority: Medium, requires operational verification  
Files:

- `worker/src/lib/mint-burn-pipeline/sync-state.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`
- `worker/migrations/0093_cleanup_legacy_mint_burn_sync_keys.sql`
- `docs/mint-burn-flows.md`

Precondition:

- Verify production and preview D1 databases have applied migration `0093_cleanup_legacy_mint_burn_sync_keys.sql`.
- Verify no rows remain with legacy colon-delimited mint/burn sync keys.

Suggested verification commands:

```bash
cd worker
npx wrangler d1 migrations list <DATABASE_NAME> --remote
npx wrangler d1 execute <DATABASE_NAME> --remote --command "SELECT COUNT(*) AS legacy_count FROM mint_burn_sync_state WHERE config_key LIKE '%:%';"
```

Adjust only the database name for the target environment. The table and column names above must match migration `0093`.

Implementation steps:

1. Record the deployed-state verification in the PR description.
2. Delete `legacyMintBurnConfigKey()`.
3. Delete dual-read/max fallback logic.
4. Keep only the canonical key path.
5. Remove or rewrite tests whose only purpose is legacy fallback compatibility.
6. Keep migration `0093` as historical record. Do not delete applied migrations.
7. Leave docs unchanged unless they currently imply compatibility with legacy keys.
8. If mint/burn behavior changes beyond removing already-cleaned legacy compatibility, update `/methodology` and the relevant timeline/changelog doc in the same PR.

Tests:

- Mint/burn sync tests.
- Mint/burn pipeline tests.
- Any config deferral tests touching sync state.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/lib/__tests__/mint-burn-pipeline.test.ts worker/src/cron/__tests__/mint-burn-config-deferral.test.ts
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Restore fallback logic if a deployed database is found without migration `0093`.

### E1 - Consolidate Validation Command Runner

Findings: R002, C005  
Priority: Medium, after A4  
Files:

- `scripts/run-validate-postbuild.mjs`
- `scripts/run-node-lts-validation.mjs`
- `scripts/test-merge-gate.mjs`
- New `scripts/lib/command-runner.mjs`
- New or updated tests under `scripts/__tests__`

Implementation steps:

1. Wait until A4 has replaced shell-interpolated git commands.
2. Extract shared process supervision:
   - run command
   - capture exit code
   - apply timeout/abort behavior if currently present
   - merge env
   - print labels/timing
   - aggregate failures
3. Extract shared argument parsing only for identical behavior. Keep script-specific flags local.
4. Preserve command order and output format enough that CI logs remain readable.
5. Update existing tests to assert behavior through the script public API, not internal formatting.
6. Run clone detection after the change to confirm the known validation clone is removed.

Tests:

- Existing merge-gate script tests.
- New command-runner tests for success, failure, timeout/abort if supported, and env merge.
- Smoke run each validation entrypoint in a non-destructive mode where available.

Validation:

```bash
npx vitest run scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/command-runner.test.ts
npm run lint
```

For final PR validation:

```bash
npm run test:merge-gate
```

Rollback:

- Restore per-script runner logic. No runtime deployment effect.

### F1 - Split DEX Discovery Provider Stages

Findings: Q005, C004  
Priority: Medium hotspot extraction  
Files:

- `worker/src/cron/dex-discovery/crawl-sources.ts`
- Potential new files:
  - `worker/src/cron/dex-discovery/crawl-coingecko-pools.ts`
  - `worker/src/cron/dex-discovery/crawl-geckoterminal-pools.ts`
  - `worker/src/cron/dex-discovery/crawl-dexscreener-pools.ts`
  - `worker/src/cron/dex-discovery/crawl-coingecko-tickers.ts`
  - `worker/src/cron/dex-discovery/staged-pool.ts`
- `worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`
- `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts`

Implementation steps:

1. Add characterization tests for current provider-order behavior if existing tests do not fully cover it.
2. Extract `toStagedPool()` or equivalent shared builder first, without changing provider control flow.
3. Extract CoinGecko pool stage into a function that accepts all dependencies explicitly.
4. Extract GeckoTerminal fallback stage.
5. Extract DexScreener fallback stage.
6. Extract CoinGecko ticker fallback stage.
7. Keep `crawlCoin()` as orchestration:
   - prepare shared state
   - call stages in current order
   - merge/dedupe stage outputs
   - return current result shape
8. Avoid changing provider thresholds, filters, or fallback policy in the extraction PR.
9. Remove or reduce hotspot waiver only after the new function sizes pass the ratchet.

Tests:

- Existing crawl-source tests.
- Provider-stage unit tests for each stage where fixtures already exist.
- Orchestrator tests proving stage order and dedupe behavior.

Validation:

```bash
npx vitest run worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts
npm run check:hotspot-ratchet
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Revert extracted files and restore original `crawl-sources.ts`.

### F2 - Split Contagion Graph Responsibilities

Findings: Q006, C004  
Priority: Medium frontend hotspot extraction  
Files:

- `src/components/contagion-graph.tsx`
- Potential new files:
  - `src/components/contagion-graph/contagion-graph-controls.tsx`
  - `src/components/contagion-graph/contagion-graph-legend.tsx`
  - `src/components/contagion-graph/contagion-graph-svg.tsx`
  - `src/components/contagion-graph/use-contagion-graph-model.ts`
- `src/components/__tests__/contagion-graph.test.tsx`
- `src/components/__tests__/contagion-graph-graph.test.ts`
- `src/lib/__tests__/contagion-layout.test.ts`

Implementation steps:

1. Add or confirm tests for:
   - selected/focused node behavior
   - keyboard navigation
   - empty state
   - edge/node rendering counts
2. Extract pure graph derivation into a hook or utility without changing JSX.
3. Extract controls.
4. Extract legend.
5. Extract SVG edge/node rendering.
6. Keep accessibility labels and keyboard behavior stable.
7. Do not alter layout, palette, motion, or information hierarchy in this refactor.
8. Update imports using index files only if that matches existing component style.

Tests:

- Existing contagion graph tests.
- Existing layout tests.
- Add targeted tests only for behavior not already covered.

Validation:

```bash
npx vitest run src/components/__tests__/contagion-graph.test.tsx src/components/__tests__/contagion-graph-graph.test.ts src/lib/__tests__/contagion-layout.test.ts
npm run typecheck
npm run lint
npm run check:hotspot-ratchet
```

Rollback:

- Revert extraction files and restore single component.

### F3 - Split Environment Contract Registry From Renderers

Findings: S004, C004  
Priority: Medium shared-module refactor  
Files:

- `shared/lib/env-contract.ts`
- Potential new files:
  - `shared/lib/env-contract/registry.ts`
  - `shared/lib/env-contract/render-markdown.ts`
  - `shared/lib/env-contract/render-env-example.ts`
  - `shared/lib/env-contract/types.ts`
- `shared/lib/__tests__/env-contract.test.ts`
- Scripts that import env-contract exports

Implementation steps:

1. Inventory all imports of `shared/lib/env-contract`.
2. Preserve public exports from `shared/lib/env-contract.ts` during the first refactor.
3. Move type definitions and registry data into dedicated modules.
4. Move markdown/example rendering helpers into dedicated modules.
5. Keep `env-contract.ts` as a compatibility barrel if that minimizes churn.
6. Update tests only where import paths intentionally change.
7. Run env contract checks to ensure generated docs/example output is byte-for-byte equivalent unless a docs correction is intentional.
8. Reduce or remove hotspot waiver after file sizes drop.

Tests:

- Existing env contract tests.
- Doc/env generation checks.

Validation:

```bash
npx vitest run shared/lib/__tests__/env-contract.test.ts
npm run check:env-contract
npm run check:doc-sync
npm run check:hotspot-ratchet
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

Rollback:

- Restore monolithic env-contract file.

### G1 - Establish Cron Connection Headroom Policy

Findings: S005  
Priority: Medium operational sustainability  
Files:

- `shared/lib/cron-jobs.ts`
- `docs/worker-and-api-limits.md`
- Potentially `scripts/check-cron-connection-budget.ts`

Implementation steps:

1. Confirm the current output of `npm run check:cron-connections`.
2. Add documentation that slots at 5/6 are treated as full for new fetch-heavy work.
3. Document slot ownership for the current 5/6 slots: `fiveMinuteTelegramAlerts`, `fourHourlyYieldSupplemental`, and `daily0805Utc`.
4. If the check supports soft thresholds, add or document a warning threshold at 5/6.
5. If the check only supports pass/fail, consider adding a warning summary without failing current state.
6. Do not reshuffle existing cron triggers unless a concrete new job needs the capacity.
7. Add a note to future cron-work guidance: new outbound I/O must include connection-budget review.

Tests:

- Existing cron connection budget check.
- Existing cron sync check.

Validation:

```bash
npm run check:cron-connections
npm run check:cron-sync
npm run check:doc-sync
npm run typecheck
```

Rollback:

- Revert docs/check changes. No runtime behavior change unless cron metadata is changed.

### H1 - Refactor Depeg Detection Cron Into Stages

Findings: S002, C004, C002  
Priority: High structural runtime work  
Files:

- `worker/src/cron/detect-depegs.ts`
- Potential new files:
  - `worker/src/cron/depeg-detection/hydration.ts`
  - `worker/src/cron/depeg-detection/decision-engine.ts`
  - `worker/src/cron/depeg-detection/persistence.ts`
  - `worker/src/cron/depeg-detection/repair.ts`
  - `worker/src/cron/depeg-detection/types.ts`
- `worker/src/cron/__tests__/detect-depegs.test.ts`
- `worker/src/cron/__tests__/detect-depegs-frozen.test.ts`
- Methodology and timeline docs if detection behavior changes.

Implementation steps:

1. Treat the first PR as characterization only:
   - capture current decisions for representative normal, depeg, recovery, duplicate, and orphan cases
   - add fixtures if existing tests do not cover every branch being moved
2. Define internal stage types:
   - hydrated inputs
   - decision candidates
   - persisted event commands
   - repair/cleanup commands
3. Extract pure decision logic first:
   - no D1 access
   - deterministic inputs/outputs
   - no logging side effects except returned diagnostics
4. Extract hydration second:
   - provider reads and cache reads
   - preserve fetch sequencing and connection behavior
5. Extract persistence third:
   - event inserts/updates
   - duplicate repair
   - orphan cleanup
6. Keep the exported cron entrypoint stable.
7. Preserve scheduling and abort behavior.
8. Do not change thresholds or corroboration rules in the extraction PR.
9. Once code is split and tests pass, revisit hotspot waiver.
10. If behavior must change during refactor, split that into a follow-up PR with methodology docs.

Tests:

- Frozen depeg tests.
- Existing depeg tests.
- New pure decision-engine fixture tests.
- Persistence tests using D1 mock or current test utilities.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/detect-depegs.test.ts worker/src/cron/__tests__/detect-depegs-frozen.test.ts
npm run check:cron-connections
npm run check:hotspot-ratchet
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

If behavior changes:

```bash
npm run check:doc-sync
npm run test:merge-gate
```

Rollback:

- Keep each extraction PR small enough to revert independently.
- Do not remove old helper code until the extracted stage is covered and called by the entrypoint.

### H2 - Refactor Stablecoin Sync CoinGecko Fallback Into Typed Phases

Findings: S003, C002, C004  
Priority: High structural runtime work  
Files:

- `worker/src/cron/sync-stablecoins/fallback.ts`
- Potential new files:
  - `worker/src/cron/sync-stablecoins/fallback-intake.ts`
  - `worker/src/cron/sync-stablecoins/fallback-cache.ts`
  - `worker/src/cron/sync-stablecoins/fallback-fx.ts`
  - `worker/src/cron/sync-stablecoins/fallback-enrichment.ts`
  - `worker/src/cron/sync-stablecoins/fallback-publish.ts`
  - `worker/src/cron/sync-stablecoins/fallback-types.ts`
- Existing sync stablecoin tests under `worker/src/cron/__tests__`
- Methodology/docs if fallback behavior changes.

Implementation steps:

1. Add characterization tests for current degraded-mode behavior:
   - primary source unavailable
   - stale cache restoration
   - FX hydration
   - price enrichment
   - staleness gating
   - tracked-additions notification
   - depeg follow-through
2. Define typed phase input/output contracts aligned with existing progress stages.
3. Extract stale-cache restoration without changing branching.
4. Extract FX hydration.
5. Extract price enrichment and validation.
6. Extract cache publication.
7. Extract tracked-additions notification.
8. Keep `syncViaCoingeckoFallback()` as orchestration.
9. Preserve existing fallback semantics until a later behavior-change PR.
10. Update hotspot waiver after extraction.

Tests:

- Existing `sync-stablecoins` tests.
- New fallback phase unit tests.
- Any depeg integration tests affected by fallback output.

Validation:

```bash
npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/detect-depegs.test.ts
npm run check:hotspot-ratchet
cd worker && npx tsc --noEmit
cd ..
npm run lint
```

If behavior changes:

```bash
npm run check:doc-sync
npm run test:merge-gate
```

Rollback:

- Revert extraction PRs one phase at a time.

### I1 - Complete Stablecoin Catalog Source-of-Truth Migration

Findings: S001, C003  
Priority: Strategic structural project  
Files:

- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/usd-minor.json`
- `shared/data/stablecoins/non-usd.json`
- `shared/data/stablecoins/commodity.json`
- `shared/data/stablecoins/pre-launch.json`
- `shared/data/stablecoins/coins.generated.json`
- `shared/data/stablecoins/coins/*.json`
- `shared/lib/stablecoins/registry.ts`
- `scripts/lib/stablecoin-catalog-sources.ts`
- `scripts/check-stablecoin-data.ts`
- Catalog docs and onboarding docs.

Decision required:

- Choose the final editable source of truth.
- Recommended default: per-coin JSON files under `shared/data/stablecoins/coins/*.json`, with generated aggregate/category artifacts clearly marked as generated or removed.

Implementation stages:

1. **Planning PR**
   - Document the chosen editable format.
   - Document generated/read-only artifacts.
   - Add migration checklist under `agents/plans` or `docs` if this is multi-PR.
2. **Guardrail PR**
   - Update `scripts/check-stablecoin-data.ts` to fail if generated files are hand-edited or if both source shapes diverge.
   - Add a clear error telling contributors where to edit.
3. **Reader PR**
   - Update `shared/lib/stablecoins/registry.ts` to read only the chosen source.
   - Keep generated aggregate support only if build tooling requires it.
4. **Generator PR**
   - Ensure generator output is deterministic.
   - Add header/comment or metadata marker if JSON format allows it. If JSON cannot carry comments, document generated status in adjacent README and checks.
5. **Data migration PR**
   - Convert remaining category-only entries into per-coin files or the chosen final format.
   - Verify IDs, symbols, contracts, classifications, reserves, and metadata are preserved byte-for-byte semantically.
6. **Cleanup PR**
   - Remove obsolete category files from runtime imports or mark them generated/legacy if they must remain for historical reasons.
   - Update docs and task templates.
7. **Post-migration PR**
   - Remove migration compatibility code once no callers use the old shape.

Tests:

- `npm run check:stablecoin-data`
- `scripts/__tests__/stablecoin-catalog-sources.test.ts`
- Any registry tests that load stablecoin data.
- Full `npm test` for the data migration PR.

Validation:

```bash
npm run check:stablecoin-data
npx vitest run scripts/__tests__/stablecoin-catalog-sources.test.ts
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm run lint
npm test
npm run build
```

Docs:

- Update data contribution docs.
- Update any README/docs references that tell maintainers to edit category JSON.
- No about-page data-source update is needed unless a new source is added.

Rollback:

- Keep migration PRs separate.
- Do not delete old files until the reader has been stable for one PR.
- If rollback is needed, restore old registry reader and category files.

### J1 - Decide Node Baseline Policy

Findings: S006, C005  
Priority: Low policy/maintenance  
Files:

- `package.json`
- `worker/package.json`
- `vitest.config.ts`
- `scripts/run-node-lts-validation.mjs`
- `docs/testing.md`
- CI workflows if the engine policy changes.

Implementation steps:

1. Identify why the repo currently requires Node 25.
2. If there is no Node 25-only requirement, change root and worker engines to the supported Node 24 LTS baseline.
3. If Node 25 remains required, document the specific feature/toolchain reason in `docs/testing.md`.
4. Keep the Node 24 validation lane only if it proves a meaningful compatibility contract.
5. Remove Node-major-specific conditionals only after the baseline decision makes them unnecessary.

Tests:

- Run the standard local validation on the selected primary Node version.
- Run `npm run validate:lts` if the LTS lane remains.

Validation:

```bash
npm run validate:lts
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm test
```

Rollback:

- Restore previous engine declarations and testing docs.

### J2 - Optional Routine Dependency Update Follow-Up

Findings: Dependency audit summary only. S007 is satisfied by A6 unless a supported Next.js patch directly resolves the vendored PostCSS advisory.  
Priority: Low maintenance  
Files:

- `package.json`
- `package-lock.json`
- Dependency docs/task tracker if maintained.

Implementation steps:

1. Separate routine minor/patch updates from major upgrades.
2. Safe candidates from the audit snapshot:
   - `@cloudflare/workers-types`
   - `@tailwindcss/postcss`
   - `@tanstack/react-query`
   - `lucide-react`
   - `tailwindcss`
   - `vitest`
   - `wrangler`
   - `viem`
3. Keep TypeScript 6 and ESLint 10 as separate major-upgrade plans.
4. Update one cluster at a time:
   - Cloudflare/Wrangler/types
   - Tailwind/PostCSS
   - React Query/Lucide
   - Vitest
   - Viem
5. After each cluster, run the relevant validation.
6. Re-check the Next/PostCSS advisory after any Next patch is available.

Validation:

```bash
npm install
npm audit --json --audit-level=low
npm run audit:deps
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm test
npm run build
```

Rollback:

- Revert package and lockfile changes for the failing cluster only.

## 7. Cross-Cutting Implementation Controls

### C001 Control - Operational Script Safety

Applies to: B1  
Required controls:

- Dry-run default.
- Explicit `--apply` for remote writes.
- Runtime provider payload validation.
- Timeout for external fetches.
- Bounded retry for transient network failures and provider 5xx responses only.
- Minimum-row guard before destructive replacement.
- Operator summary before write.
- Tests proving dry-run cannot mutate D1.

### C002 Control - Fallback and Compatibility Paths

Applies to: C1, D4, H2  
Required controls:

- Compatibility code must have an owner and removal condition.
- Fallbacks should be triggered by explicit classified errors, not `catch (all)`.
- Degraded-mode behavior needs targeted tests.
- Removed compatibility paths require deployed-state verification when D1 data is involved.

### C003 Control - Domain Source-of-Truth

Applies to: D1, D3, I1  
Required controls:

- One public type per API response contract.
- One cadence classifier for FX pegs.
- One editable stablecoin catalog format.
- Checks should fail with instructions when contributors edit the wrong artifact.

### C004 Control - Hotspot Refactoring

Applies to: F1, F2, F3, H1, H2  
Required controls:

- Characterization tests before movement.
- One extraction axis per PR.
- No behavior changes in extraction PRs.
- Hotspot waiver updates only after tests and size checks pass.

### C005 Control - Validation Tooling

Applies to: A4, E1, J1  
Required controls:

- Git commands use argument arrays.
- Shared runner preserves exit codes and CI readability.
- Node baseline policy is documented.

## 8. Suggested PR Breakdown

The safest practical sequence is:

1. PR 1: B1. KYC script hardening and shared helper consolidation. Until this lands, do not run the current-balance reconciliation script against remote D1.
2. PR 2: A1, A2, A3. Browser/runtime quick wins with targeted tests.
3. PR 3: A4. Git command shell-safety cleanup.
4. PR 4: A5 and A6. Policy cleanup and advisory documentation.
5. PR 5: C1. Price cache fallback classification.
6. PR 6: C2. D1 status runtime payload validation.
7. PR 7: D1 and D2. Small shared type/page wrapper redundancy cleanup.
8. PR 8: D3. FX cadence centralization.
9. PR 9: D4. Mint/burn legacy key removal after remote verification.
10. PR 10: E1. Validation runner consolidation.
11. PR 11: F1. DEX discovery provider-stage extraction.
12. PR 12: F2. Contagion graph extraction.
13. PR 13: F3. Environment contract split.
14. PR 14: G1. Cron connection headroom policy/check documentation.
15. PRs 15-17: H1. Depeg detection characterization, decision extraction, persistence extraction.
16. PRs 18-20: H2. Stablecoin fallback characterization and phase extraction.
17. PRs 21-25: I1. Stablecoin catalog migration stages.
18. PR 26: J1. Node baseline policy.
19. Optional follow-up: J2. Routine dependency update batches, split further if validation cost is high.

## 9. Validation Matrix by PR Type

| PR type | Required validation |
| --- | --- |
| Frontend hook/component only | Targeted Vitest files, `npm run typecheck`, `npm run lint` |
| Functions/Pages function | Targeted functions tests, `npm run typecheck`, `npm run lint`, `npm run build` if deploy-impacting |
| Worker runtime | Targeted worker tests, `cd worker && npx tsc --noEmit`, `npm run lint` |
| Worker script | Targeted script tests, `npm run typecheck:worker-scripts`, `npm run lint` |
| Shared runtime/type changes | Targeted shared tests, `npm run typecheck`, `cd worker && npx tsc --noEmit`, `npm run check:shared-cycles` |
| Cron scheduling | Targeted cron tests, `npm run check:cron-sync`, `npm run check:cron-connections`, worker type-check |
| Hotspot refactor | Targeted tests, `npm run check:hotspot-ratchet`, type-checks, lint |
| Stablecoin data/catalog | `npm run check:stablecoin-data`, catalog tests, full `npm test`, `npm run build` |
| Dependency update | `npm install`, audit, type-checks, lint, targeted tests, full test/build for framework/toolchain updates |
| Any deploy-impacting final pre-push | `npm run test:merge-gate` |

## 10. Documentation Update Rules

Update docs in the same PR when:

- Operator script usage changes: add or update script docs/help output.
- Runtime fallback behavior changes: update architecture/pipeline docs and methodology docs if scoring or methodology output changes.
- Depeg detection behavior changes: update `/methodology` and the relevant changelog/timeline doc.
- Stablecoin catalog edit workflow changes: update contributor/data docs and any task templates.
- Cron connection policy changes: update `docs/worker-and-api-limits.md`.
- Node baseline changes: update `docs/testing.md`.
- Environment contract structure changes but generated env docs remain equivalent: no external docs required beyond any import-path notes.

## 11. Risk Register

| Risk | Affected packages | Mitigation |
| --- | --- | --- |
| Remote D1 data loss from script mistakes | B1 | Dry-run default, `--apply`, min-row guard, staging/transaction pattern, tests |
| Hidden behavior change during hotspot extraction | F1, F2, H1, H2 | Characterization tests first, one extraction axis per PR |
| Removing compatibility before deployed state is ready | D4 | Wrangler migration and legacy-row verification before code removal |
| Stablecoin catalog drift during migration | I1 | Guardrail PR before reader/data migration, deterministic generation |
| CI/tooling regression from runner consolidation | E1 | Preserve script contracts, targeted script tests, merge-gate validation |
| Audit advisory workaround breaks Next | S007/J2 | Avoid unsupported overrides; prefer supported upstream patch or documented acceptance |
| Cron budget regressions | G1, H1, H2 | Run cron connection check on every cron-affecting PR |

## 12. Completion Checklist

- [ ] Q001 resolved and tested.
- [ ] Q002 resolved and tested.
- [ ] Q003 resolved and tested.
- [ ] Q004 resolved and tested.
- [ ] Q005 resolved and hotspot waiver updated or justified.
- [ ] Q006 resolved and hotspot waiver updated or justified.
- [ ] Q007 resolved and tested.
- [ ] Q008 resolved and tested.
- [ ] Q009 resolved and tested.
- [ ] R001 resolved after deployed-state verification.
- [ ] R002 resolved and clone reduced.
- [ ] R003 resolved and cadence tests added.
- [ ] R004 resolved and response type unified.
- [ ] R005 resolved with route behavior preserved.
- [ ] R006 resolved by deleting dead policy block or implementing explicit strict mode.
- [ ] R007 resolved through shared script helpers.
- [ ] S001 resolved through catalog source-of-truth migration.
- [ ] S002 resolved through staged depeg cron architecture.
- [ ] S003 resolved through typed fallback phases.
- [ ] S004 resolved through env contract module split.
- [ ] S005 resolved through cron headroom policy/check documentation.
- [ ] S006 resolved through documented Node baseline decision.
- [ ] S007 resolved through advisory triage or supported dependency update.
- [ ] C001-C005 controls satisfied.
- [ ] Final full validation completed:

```bash
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm run typecheck:worker-scripts
npm run check:unused-code
npm run check:shared-cycles
npm run check:worker-boundary
npm run check:hotspot-ratchet
npm run check:cron-sync
npm run check:cron-connections
npm run check:env-contract
npm run check:doc-sync
npm run check:verified-doc-links
npm run check:doc-source-paths
npm run check:stablecoin-data
npm audit --json --audit-level=low
npm run audit:deps
npm test
npm run build
npm run test:merge-gate
```
