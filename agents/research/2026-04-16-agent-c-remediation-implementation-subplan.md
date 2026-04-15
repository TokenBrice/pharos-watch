# Agent C Remediation Implementation Sub-Plan

Date: 2026-04-16
Scope: `/home/ahirice/Documents/git/stablecoin-dashboard`

Assigned findings only: R1, R2, R3, R4, R5, R6, R9, R10, R11, Q4, Q5, Q6, Q8, S3, plus C3 and C5.

No product code was edited while preparing this plan.

## Assumptions

- This plan is an implementation blueprint, not an implementation branch.
- "Fix" means preserving current externally visible behavior unless a finding explicitly requires a behavior change.
- Refactors should land in small PRs with characterization tests before or in the same PR as the extraction.
- For methodology/frontend visual changes, static markup equivalence is not enough; run a build and at least a local UI smoke/visual pass.
- Existing unrelated dirty worktree state is out of scope and should not be reverted.

## Success Criteria

- Assigned redundancy findings are either eliminated or made intentionally documented where removal has worse churn than benefit.
- Provider boundary hardening returns degraded `DexApiFetchResult` objects instead of uncaught provider-shape exceptions for invalid JSON, `null` roots, and missing nested token objects.
- Worker hotspot work lowers complexity without changing provider ordering, circuit-breaker behavior, cache semantics, cron connection use, or D1 mutation order.
- Frontend hotspot work extracts pure view models or leaf components before broad rendering splits.
- Oversized test suites are split without lowering critical coverage or weakening exact-file gates in `package.json`.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run coverage:critical`, `npm run check:hotspot-ratchet`, `npm run check:unused-code`, `npm run check:shared-cycles`, and relevant worker/API targeted tests pass after each tranche.

## Research Performed

Docs reviewed:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `docs/methodology-page.md`
- `docs/dews.md`

Audit reports reviewed:

- `agents/audits/2026-04-16-agent-1-redundancy-audit.md`
- `agents/research/2026-04-16-agent-2-code-quality-audit.md`
- `agents/research/2026-04-16-sustainability-maintainability-audit-agent3.md`
- `agents/audits/2026-04-16-comprehensive-three-pillar-audit-blueprint.md`

Lightweight validation during planning:

- `npm run check:hotspot-ratchet` passed.
- `npm run check:unused-code` passed.
- `npm run check:shared-cycles` passed for `shared`, `worker/src`, and `src`.

## Source And Test Map

| Finding | Primary source locations | Relevant current tests | Current research result |
| --- | --- | --- | --- |
| R1 | `worker/src/cron/sync-stablecoins/pricing.ts:194-225`, `323-356`, `397-425`; caller `worker/src/cron/sync-stablecoins/stages.ts:176-245` | `worker/src/cron/__tests__/sync-stablecoins.test.ts`, `worker/src/cron/__tests__/sync-stablecoins-stages.test.ts` | Duplication is narrow and safe to remove with a private helper. Direct unit coverage for the two wrappers is weak. |
| R2 | `worker/src/api/backfill-supply-history.ts:245-291` | `worker/src/api/__tests__/backfill-supply-history.test.ts:89-258` | Duplicate branches share the same `backfillCommodity` call/result handling. Tests cover USD and CG fallback paths, but not label preservation for both duplicated branches. |
| R3 | `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:254-388` | No direct section-level test found | The duplicate data matches `docs/dews.md` signal weights and threat bands. Refactor is presentation-only but needs visual verification. |
| R4 | `worker/src/cron/yield-sync/resolve-helpers.ts:121-201` | `worker/src/cron/__tests__/yield-resolve.test.ts`, `worker/src/cron/__tests__/sync-yield-data.test.ts` | Direct-ID and identity-resolution branches duplicate append/gate logic. Counter behavior differs subtly for missing metadata and must be preserved. |
| R5 | `worker/src/lib/evm-rpc.ts:60-115`, `152-207` | `worker/src/lib/__tests__/evm-rpc.test.ts:24-181`, reserve/yield adapter tests that mock EVM RPC | The second fallback loop exists only to reject invalid/empty hex. A result-policy callback on the shared loop should preserve fallback and logging. |
| R6 | `worker/src/cron/sync-blacklist.ts:203-224`, `268-289`; post-fetch helper `worker/src/cron/blacklist/post-fetch.ts:64-140` | `worker/src/cron/__tests__/sync-blacklist.test.ts` | Duplicate accumulation is local. Existing `processFetchedBlacklistRows()` already centralizes enrichment/insert/cache side effects. |
| R9 | `src/styles/tokens/semantic.css:160-175`, `279-294` | Build/UI smoke only | Invariant sidebar and motion tokens are duplicated in `.dark`; root definitions are enough for cascade. |
| R10 | `src/lib/site-config.ts:1`; consumers from `src/app/layout.tsx`, `src/app/sitemap.ts`, `src/app/robots.ts`, metadata routes | Build/SEO/sitemap generation | Wrapper is a one-line alias over `@shared/lib/runtime-origins`. Current architecture docs already call shared runtime origins the source of truth. |
| R11 | `scripts/__tests__/smoke-ops.test.ts:107-184`; `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:26-259`; `worker/src/lib/__tests__/depeg-helpers.test.ts:1-178`; `worker/src/lib/__tests__/depeg-trust-policy.test.ts:1-128`; `shared/lib/__tests__/redemption-backstop-consistency.test.ts:13-40`; `scripts/check-redemption-backstops.ts:20-46` | Same files | Most duplication is test scaffolding. One test file is effectively misnamed trust-policy coverage with partial overlap. |
| Q4 | `worker/src/cron/dex-liquidity/fetch-meteora.ts:37-135`; `fetch-balancer.ts:71-170`; `fetch-raydium.ts:24-142`; orchestration catch `orchestrator-phases.ts:324-352` | `worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts`; `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts:315-720`; `orchestrator-phases.test.ts` | Balancer/Raydium have malformed-shape tests but not invalid JSON or missing nested token objects. Meteora has only a happy path. |
| Q5 | `crawlCoin` in `worker/src/cron/dex-discovery/crawl-sources.ts:58-486`; `analyzeDexLiquidityPostScoring` in `orchestrator-metadata.ts:224-632`; `confirmPendingDepegs` in `confirm-pending-depegs.ts:63-400`; `fetchPrimaryPrices` in `enrich-prices-primary.ts:459-789` | `crawl-sources.test.ts`; `orchestrator-metadata.test.ts`; `confirm-pending-depegs.test.ts`; `enrich-prices.test.ts` | Coverage exists, but functions mix policy, provider fetch, shaping, telemetry, and mutation planning. Extract pure decisions first. |
| Q6 | `src/components/contagion-graph.tsx:44-641`; `hero-card.tsx:271-742`; `kpi-bar.tsx:281-614`; `command-palette.tsx:43-445`; `src/app/yield/client.tsx:83-428`; `src/app/status/client.tsx:55-408`; `api-keys-panel.tsx:147-512` | Contagion helper/component tests, HeroCard tests, ApiKeysPanel tests, StabilityIndex client tests; gaps for KPI/Yield/Public Status/CommandPalette UI | Some pure helpers already exist. Continue with view-model extraction rather than route rewrites. |
| Q8 | `sync-yield-data.test.ts` 3220 lines; `sync-stablecoins.test.ts` 2767 lines; `status.test.ts` 2510 lines; `enrich-prices.test.ts` 2161 lines | These exact files are referenced by `test:invariants` and/or `coverage:critical` in `package.json` | Splitting requires updating exact-file package scripts, otherwise critical gates keep depending on old filenames. |
| S3 | `scripts/lib/hotspot-ratchet-waivers.json:2-89`; `scripts/lib/hotspot-ratchet-baseline.json:242-252`; affected source hotspots listed above plus `worker/src/cron/dispatch-telegram-alerts.ts:1-670`, `src/lib/coverage.ts:1-908`, `src/app/stability-index/client.tsx:1-752` | `npm run check:hotspot-ratchet` | Ratchet passes. Treat waiver/baseline entries as a backlog and update only after measured reductions. |

## Dependency Order

1. Q4 before deeper DEX/provider refactors: harden external JSON boundaries first so later provider-stage splitting does not preserve brittle assumptions.
2. R5 before EVM reserve/yield cleanup: centralize RPC fallback before touching adapters that depend on it.
3. R1 before primary pricing hotspot extraction: remove small duplicated application loop first, then decompose `fetchPrimaryPrices`.
4. R4 before Q8 yield test splitting: small helper extraction gives a concrete behavior seam for later test helper consolidation.
5. R11 before Q8: extract lightweight test builders before splitting large suites.
6. Q8 package-script updates must land in the same PR as any test-file split that renames or deletes `sync-yield-data.test.ts`, `sync-stablecoins.test.ts`, `status.test.ts`, or `enrich-prices.test.ts`.
7. S3 hotspot ratchet baseline/waiver updates should come after actual source reductions, not before.

## Implementation Plan

### A. Provider Boundary Hardening (Q4, C3)

Affected files:

- `worker/src/cron/dex-liquidity/fetch-meteora.ts`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts`
- New helper: `worker/src/cron/dex-liquidity/direct-api-json.ts` or `worker/src/lib/dex-api-json.ts`
- Tests: `worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts`, `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

Proposed code-level changes:

1. Add a shared JSON reader:

   ```ts
   export async function readDexApiJson<T>(
     response: Response,
     context: string,
   ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
     try {
       const data = await response.json() as T;
       if (data == null || typeof data !== "object") {
         return { ok: false, error: `${context} returned non-object JSON body` };
       }
       return { ok: true, data };
     } catch (err) {
       return {
         ok: false,
         error: `${context} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
       };
     }
   }
   ```

2. Add provider-local type guards rather than broad Zod schemas for the first pass. Keep them minimal:

   - Meteora: guard `data` is array; per-pool guard requires `address`, `token_x`, `token_y`, token addresses/symbols, finite `token_x_amount`, finite `token_y_amount`, and finite/non-null `tvl` before constructing a `DexApiPool`.
   - Balancer: guard `data.poolGetPools` is array; per-pool guard requires `id`, `type`, `chain`, `dynamicData` object, and `poolTokens` array. Skip malformed pools and record `malformedPools` count rather than throwing on `pool.dynamicData.totalLiquidity`.
   - Raydium: guard `data.data` is array; per-pool guard requires `id`, `mintA`, `mintB`, token addresses/symbols/decimals, finite `tvl`, and `day` object before constructing a `DexApiPool`.

3. In each fetcher, replace direct `await res.json() as ...` with `readDexApiJson`. On parse/root failure:

   - push the helper error into `errors`
   - break the page loop
   - return `makeDexApiFetchResult(pools, { ok: successfulPages > 0, degraded: true, errors })`

4. For malformed individual pools, skip the row and add a bounded summary error such as `page 1 skipped 3 malformed pool rows`. Do not log one message per row on large pages.

5. Keep `runDirectApiFetchPhase()` catch at `worker/src/cron/dex-liquidity/orchestrator-phases.ts:324-352` as a last-resort safety net. The fetchers should now use it only for aborts or unexpected programming errors.

Tests to add/update:

- Meteora:
  - invalid JSON response returns `ok=false`, `degraded=true`, `pools=[]`, error contains `invalid JSON`.
  - `null` root returns degraded result.
  - row with missing `token_x` is skipped and does not throw; valid row in same page still emits.
- Balancer:
  - text/html invalid JSON returns degraded result.
  - `data: null` returns degraded result.
  - row missing `dynamicData` or `poolTokens` is skipped while a valid row in same response remains.
- Raydium:
  - concentrated invalid JSON plus standard valid JSON returns partial/degraded aggregate, not a rejected promise.
  - pool missing `mintA` or `mintB` is skipped.
  - `data: null` keeps current degraded behavior.

Validation:

- `npx vitest run worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts`
- `npm run check:cron-connections`
- `npm run check:worker-boundary`
- `cd worker && npx tsc --noEmit`

Risks:

- Over-strict guards could drop pools that are usable after downstream metadata hydration. Keep required fields to only fields dereferenced immediately.
- Error strings may affect brittle tests if asserted exactly. Assert substrings in new tests.

Effort: Medium.

### B. Small Redundancy Refactors In Worker Code (R1, R2, R4, R5, R6)

#### R1. Price-result application helper

Affected file: `worker/src/cron/sync-stablecoins/pricing.ts`.

Proposed code-level changes:

1. Add a private helper after `applyPriceResultForAsset()`:

   ```ts
   interface ApplyPriceResultsForAssetsOptions {
     rejectionLabel: string;
     requiredCandidateSource?: string;
     stampExistingWhenRejected?: boolean;
     stampExistingWhenMissing?: boolean;
     afterAssetApplied?: (asset: PeggedAsset) => void;
   }

   function applyPriceResultsForAssets(input: {
     assets: PeggedAsset[];
     primaryPriceResults: Map<string, PrimaryPriceResult>;
     previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
     validationContexts: ValidationContextResolver;
     validationReferences?: PriceValidationReferences;
     syncStartSec: number;
   }, options: ApplyPriceResultsForAssetsOptions): void {
     for (const asset of input.assets) {
       applyPriceResultForAsset({
         asset,
         primaryPriceResult: input.primaryPriceResults.get(asset.id),
         previousTrustedPrice: input.previousTrustedPrices?.get(asset.id) ?? null,
         validationContext: input.validationContexts.get(asset),
         validationReferences: input.validationReferences,
         syncStartSec: input.syncStartSec,
         rejectionLabel: options.rejectionLabel,
         requiredCandidateSource: options.requiredCandidateSource,
         stampExistingWhenRejected: options.stampExistingWhenRejected,
         stampExistingWhenMissing: options.stampExistingWhenMissing,
       });
       options.afterAssetApplied?.(asset);
     }
   }
   ```

2. Rewrite `applyPrimaryPriceResults()` to call this helper with:

   - `rejectionLabel: "primary consensus price"`
   - `stampExistingWhenRejected: true`
   - `stampExistingWhenMissing: true`
   - `afterAssetApplied` that sets `asset.supplySource = "defillama"` only when missing

3. Rewrite `applyGtProbeResults()` to call this helper with:

   - `rejectionLabel: "GT-probed price"`
   - `requiredCandidateSource: "geckoterminal"`

Tests:

- Add `worker/src/cron/__tests__/sync-stablecoins-pricing.test.ts`.
- Cover:
  - primary pass stamps an existing valid price as `single-source` when no primary result exists and preserves `supplySource` defaulting.
  - primary pass applies accepted primary result and stamps consensus/agree sources.
  - GT pass ignores primary results whose `candidateSources` do not include `geckoterminal`.
  - GT pass applies a GeckoTerminal-backed result without changing `supplySource`.

Validation:

- `npx vitest run worker/src/cron/__tests__/sync-stablecoins-pricing.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts`

Effort: Small.

#### R2. CoinGecko/commodity supply-history backfill helper

Affected file: `worker/src/api/backfill-supply-history.ts`.

Proposed code-level changes:

1. Inside `handleBackfillSupplyHistory()`, before the `for (const meta of coins)` loop, define:

   ```ts
   async function runCoinGeckoMarketChartBackfill(meta: StablecoinMeta, failureLabel: string): Promise<void> {
     try {
       const result = await backfillCommodity(db, meta.id, {
         geckoId: meta.geckoId!,
         protocolSlug: meta.protocolSlug ?? undefined,
         cgApiKey,
         contracts: meta.contracts,
         chainRpcs,
       });
       if (result.error) errors.push(`${meta.symbol}: ${result.error}`);
       else totalRows += result.rows;
     } catch (err) {
       errors.push(`${meta.symbol}: ${failureLabel} backfill failed - ${err}`);
     }
   }
   ```

2. Preserve exact branch semantics:

   - Keep the commodity short-circuit for gold/silver with `meta.geckoId`.
   - Keep `detailProvider === "coingecko" || "commodity"` skip behavior when `meta.geckoId` is absent.
   - Only remove the duplicated call/result/catch block.

3. Use ASCII hyphen in new error text unless preserving existing em dash is required by tests. If preserving current output, keep the current dash character in both labels.

Tests:

- Add branch-specific tests in `worker/src/api/__tests__/backfill-supply-history.test.ts`:
  - commodity gold/silver with `geckoId` still calls market-chart path and uses `commodity backfill failed` on thrown fetch.
  - `detailProvider: "coingecko"` path still uses `CoinGecko backfill failed`.
  - coingecko/commodity detail-provider without `geckoId` still appears in `skipped`.

Validation:

- `npx vitest run worker/src/api/__tests__/backfill-supply-history.test.ts`
- `npm run check:sql-safety`

Effort: Small.

#### R4. Optional yield candidate append helper

Affected file: `worker/src/cron/yield-sync/resolve-helpers.ts`.

Proposed code-level changes:

1. Add a private helper:

   ```ts
   type AppendResolvedYieldStatus =
     | "appended"
     | "duplicate"
     | "size-gated"
     | "missing-meta";

   function appendYieldCandidateIfEligible(params: {
     resolved: ResolvedYieldEntry[];
     entry: ResolvedYieldCandidate;
     stablecoinId: string;
     stablecoinSupplyById: Map<string, number>;
   }): AppendResolvedYieldStatus {
     const meta = getActiveStablecoinMeta(params.stablecoinId);
     if (!meta) return "missing-meta";
     if (
       params.entry.yield.yieldType === "lending-opportunity" &&
       !passesLendingOpportunitySizeGate({
         stablecoinId: params.stablecoinId,
         poolChain: params.entry.chain ?? meta.contracts?.[0]?.chain ?? null,
         sourceTvlUsd: params.entry.yield.sourceTvlUsd,
         stablecoinSupplyById: params.stablecoinSupplyById,
       })
     ) {
       return "size-gated";
     }
     if (params.resolved.some((row) => row.id === meta.id && row.yield?.sourceKey === params.entry.yield.sourceKey)) {
       return "duplicate";
     }
     params.resolved.push({ id: meta.id, symbol: meta.symbol, yield: params.entry.yield });
     return "appended";
   }
   ```

2. In the direct `entry.stablecoinId` branch:

   - call helper
   - increment `unresolvedDrops` when status is `"missing-meta"` to preserve current direct-ID behavior
   - increment `sizeGateDrops` on `"size-gated"`
   - continue on all statuses

3. In the identity-resolution branch:

   - keep the existing ambiguous/unresolved resolution counters before helper
   - call helper for matched IDs
   - increment `sizeGateDrops` on `"size-gated"`
   - do not increment `unresolvedDrops` for `"missing-meta"` unless you intentionally decide to change behavior; current code silently continues in that impossible/rare case.

Tests:

- Extend `worker/src/cron/__tests__/yield-resolve.test.ts`:
  - direct optional candidate with `stablecoinId` and small `sourceTvlUsd` increments size-gate path.
  - resolved optional candidate with the same `sourceKey` is deduped.
  - blocked optional source is still counted before identity resolution.

Validation:

- `npx vitest run worker/src/cron/__tests__/yield-resolve.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts`

Effort: Small.

#### R5. Shared EVM JSON-RPC fallback policy

Affected file: `worker/src/lib/evm-rpc.ts`.

Proposed code-level changes:

1. Extend private `fetchJsonRpcResult<T>()` with an optional policy argument, not with public `EvmRpcOptions` unless other callers need it:

   ```ts
   interface JsonRpcResultPolicy<T> {
     acceptResult?: (value: T) => boolean;
     rejectedReason?: (value: T) => string;
   }
   ```

2. After the existing `body.result == null` check, add:

   ```ts
   if (policy?.acceptResult && !policy.acceptResult(body.result)) {
     failures.push(`${rpcUrl}: ${policy.rejectedReason?.(body.result) ?? "rejected result"}`);
     continue;
   }
   ```

3. Rewrite `fetchEvmCallHexAtBlock()` to:

   - build `callObj`
   - build `blockTag`
   - call `fetchJsonRpcResult<string>(urls, "eth_call", [callObj, blockTag], options, { acceptResult: (value) => isHexResult(value) && value !== "0x", rejectedReason: () => "null result" })`
   - return the result cast to `` `0x${string}` `` or `null`

4. Keep `fetchJsonRpcHexAtUrl()` behavior unchanged unless a test expects fallback logging for invalid hex.

Tests:

- Extend `worker/src/lib/__tests__/evm-rpc.test.ts`:
  - first RPC returns `"0x"`, second returns `"0x64"`; `fetchEvmCallHexAtBlock()` returns second value and calls both URLs.
  - `gas` option appears in the JSON-RPC body.
  - all invalid hex results still log `[evm-rpc] eth_call failed across N RPCs`.

Validation:

- `npx vitest run worker/src/lib/__tests__/evm-rpc.test.ts worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts`
- `cd worker && npx tsc --noEmit`

Risks:

- Do not alter `fetchJsonRpcResult()` response-body consumption. Every non-OK/invalid response must still be consumed through `fetchWithRetry` response handling or `res.json()` when OK.

Effort: Medium.

#### R6. Blacklist post-fetch accumulation helper

Affected file: `worker/src/cron/sync-blacklist.ts`.

Proposed code-level changes:

1. Add local accumulator helpers near the top of `syncBlacklist()` or as module-private functions:

   ```ts
   function addBlacklistCounters(target: BlacklistPostFetchCounters, delta: BlacklistPostFetchCounters): void {
     target.attempted += delta.attempted;
     target.succeeded += delta.succeeded;
     target.failed += delta.failed;
   }

   function addCurrentBalanceCounters(target: CurrentBalanceCacheCounters, delta: CurrentBalanceCacheCounters): void {
     target.updated += delta.updated;
     target.deleted += delta.deleted;
     target.failed += delta.failed;
   }
   ```

2. If needed, export `BlacklistPostFetchCounters`, `CurrentBalanceCacheCounters`, and `ProcessFetchedBlacklistRowsOptions` from `worker/src/cron/blacklist/post-fetch.ts` so the helper can be typed without re-declaring shapes.

3. Add a local wrapper:

   ```ts
   async function processRowsAndAccumulate(chainLabel: "tron" | "evm", rows: BlacklistRow[]): Promise<number> {
     const processed = await processFetchedBlacklistRows({ db, config, rows, chainLabel, ...same shared args });
     addBlacklistCounters(enrichCounters, processed.enrichCounters);
     addCurrentBalanceCounters(currentBalanceCacheCounters, processed.currentBalanceCacheCounters);
     return processed.insertedRows;
   }
   ```

4. In both Tron and EVM branches, replace duplicated blocks with:

   ```ts
   totalInsertedRows += await processRowsAndAccumulate("tron", result.rows);
   ```

   or `"evm"` for EVM.

Tests:

- Existing `worker/src/cron/__tests__/sync-blacklist.test.ts` should remain the primary characterization suite.
- Add one focused assertion if current tests do not already verify metadata counters:
  - metadata `currentBalanceCacheUpdated/deleted/failed` and enrichment counters remain identical for one Tron row and one EVM row.

Validation:

- `npx vitest run worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts`
- `npm run check:cron-connections`
- `npm run check:sql-safety`

Effort: Small.

### C. Methodology, CSS, And Frontend Indirection (R3, R9, R10, Q6, C5)

#### R3. DEWS methodology diagram data extraction

Affected file: `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`.

Proposed code-level changes:

1. Add local constants near the top of the file:

   ```ts
   const DEWS_SIGNAL_CARDS = [
     { label: "Supply Velocity", mobileLabel: "Supply Velocity", weight: "0.25" },
     { label: "Pool Balance Drift", mobileLabel: "Pool Balance Drift", weight: "0.20" },
     { label: "Liquidity Erosion", mobileLabel: "Liquidity Erosion", weight: "0.15" },
     { label: "Price Confidence", mobileLabel: "Price Confidence", weight: "0.15" },
     { label: "Cross-Source Divergence", mobileLabel: "Cross-Source Div.", weight: "0.15" },
     { label: "Blacklist Activity", mobileLabel: "Blacklist Activity", weight: "0.10" },
     { label: "Mint/Burn Flow", mobileLabel: "Mint/Burn Flow", weight: "0.10" },
     { label: "Yield Anomaly", mobileLabel: "Yield Anomaly", weight: "0.05" },
   ] as const;

   const DEWS_BAND_CARDS = [
     { label: "CALM", mobileLabel: "CALM", range: "0-15", className: "text-green-700 dark:text-green-400" },
     ...
   ] as const;
   ```

   Use the same displayed dash/range glyph conventions as the existing page if visual parity matters; otherwise prefer ASCII in source and let JSX render text.

2. Add small leaf components:

   - `DewsSignalCard({ signal, compactLabel })`
   - `DewsBandCard({ band, compactLabel, compactPadding })`
   - optional `DewsScoreFormulaCard({ mobile })`

3. Keep two layout wrappers:

   - desktop horizontal wrapper `hidden md:flex`
   - mobile vertical wrapper `md:hidden`

   Only data and leaf markup should be shared; do not force one layout abstraction that makes responsive structure harder to read.

Tests:

- Add a section-level static render test if the repo accepts route-section tests:
  - `src/app/methodology/sections/monitoring/__tests__/pegscore-dews-section.test.tsx`
  - Render to static markup and assert all eight full labels, two mobile-only labels if rendered, and five bands appear.
- If direct test setup is noisy, rely on build plus a local Playwright/UI smoke screenshot.

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run seo:check`
- `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local` after serving `out/`

Effort: Medium.

#### R9. Invariant CSS token consolidation

Affected file: `src/styles/tokens/semantic.css`.

Proposed code-level changes:

1. Leave root invariant tokens at `:root:160-175`.
2. Delete duplicated `.dark` declarations at `279-294`:

   - `--sidebar-width-expanded`
   - `--sidebar-width-collapsed`
   - all `--motion-*`
   - `--theme-transition-duration`

3. Keep `.dark` sidebar color tokens at `274-277` because they are theme-specific aliases.
4. Do not move invariant tokens to `globals.css`; `docs/design-tokens.md` identifies motion as semantic tokens.

Tests/validation:

- `npm run build`
- `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local`
- Manual visual spot checks: sidebar expanded/collapsed width, theme toggle transitions, mobile header/sidebar absence.

Risk:

- Low. CSS custom properties cascade from `:root` into `.dark`. The only practical risk is a future maintainer assuming `.dark` fully enumerates every token.

Effort: Small.

#### R10. Remove frontend origin wrapper

Affected files:

- Delete `src/lib/site-config.ts`
- Update all imports found by `rg "site-config|SITE_URL|API_URL" src`:
  - `src/app/layout.tsx`
  - `src/app/page.tsx`
  - `src/app/sitemap.ts`
  - `src/app/robots.ts`
  - `src/app/stablecoin/[id]/page.tsx`
  - `src/app/digest/[date]/page.tsx`
  - `src/app/methodology/page.tsx`
  - `src/app/compare/page.tsx`
  - `src/app/coverage/page.tsx`
  - `src/app/liquidity/page.tsx`
  - `src/app/yield/page.tsx`
  - `src/app/chains/page.tsx`
  - `src/app/dependency-map/page.tsx`
  - `src/app/portfolio/page.tsx`
  - plus current additional consumers: `start`, `cemetery`, `flows/layout`, `telegram`, `blacklist/layout`, `digest/page`

Proposed code-level changes:

1. Replace:

   ```ts
   import { SITE_URL } from "@/lib/site-config";
   ```

   with:

   ```ts
   import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
   ```

2. Replace:

   ```ts
   import { SITE_URL, API_URL } from "@/lib/site-config";
   ```

   with:

   ```ts
   import { API_ORIGIN as API_URL, SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
   ```

3. Delete `src/lib/site-config.ts`.
4. Keep consumer-local aliases (`SITE_URL`, `API_URL`) to minimize metadata diff churn while removing the wrapper layer.

Tests/validation:

- `npm run typecheck`
- `npm run build`
- `npm run seo:check`
- `npm run check:unused-code`
- Spot-check generated sitemap/robots in build output if the static export exposes them.

Risk:

- Broad but mechanical route metadata churn. Do this alone in a small PR.

Effort: Small/Medium.

#### Q6/S3. Frontend hotspot decomposition

Recommended order:

1. `src/components/contagion-graph.tsx`
2. `src/components/status/api-keys-panel.tsx`
3. `src/components/stablecoin-detail/hero-card.tsx`
4. `src/components/kpi-bar.tsx`
5. `src/components/command-palette.tsx`
6. `src/app/yield/client.tsx`
7. `src/app/status/client.tsx`
8. Later: `src/lib/coverage.ts` and `src/app/stability-index/client.tsx` from S3 backlog

Concrete extraction plans:

- `ContagionGraph`
  - Existing helpers: `src/components/contagion-graph-graph.ts`, `src/lib/contagion-layout.ts`, `src/components/contagion-graph-model.ts`.
  - Add `src/components/contagion-graph-view-model.ts`.
  - Move pure derivations from `contagion-graph.tsx:48-121`, `178-220`, and visible/summary label calculations into `buildContagionGraphViewModel({ nodes, links, supernodeState, focusMode, selectedNeighborhoodId, hoveredId, hoveredEdge })`.
  - Keep DOM projection, pointer capture, and React state in the component.
  - Tests: extend `src/components/__tests__/contagion-graph-graph.test.ts` or add `contagion-graph-view-model.test.ts` for selected-neighborhood fallback, hub ordering, visible node IDs, ripple state, and label model.

- `ApiKeysPanel`
  - Add `src/components/status/api-keys-panel-model.ts` for `buildEditableState`, expiry formatting/status, payload builders, and `parseRateLimitInput` if not already pure.
  - Split JSX into `ApiKeyCreateForm`, `ApiKeyTokenReveal`, `ApiKeyRow`, and `ApiKeyErrorBanner` inside either the same file first or new sibling files.
  - Add `useApiKeyMutations({ refetch })` only if it reduces the current create/update/rotate/deactivate duplication; keep fetch endpoint strings visible in one place.
  - Tests: extend `api-keys-panel.test.tsx` for update payload, rotate token reveal, deactivate disabled state, and create validation error.

- `HeroCard`
  - Add `src/components/stablecoin-detail/hero-card-model.ts` for badge models, active-depeg copy, risk/control labels, performance metric inclusion, and infrastructure badge labels.
  - Split leaf sections: identity/header, peg status strip, metric grid, controls/risk badges.
  - Preserve current server-render/static-markup tests in `hero-card.test.tsx`; add pure tests for model functions before moving markup.

- `KpiBar`
  - Add `src/components/kpi-bar-model.ts` for derived KPI values, trend labels, PSI/mint-burn selection, and loading/empty state model.
  - Then split desktop/mobile layout leaf components if the model extraction leaves >400 lines.
  - Add pure model tests because no obvious KPI-specific tests were found.

- `CommandPalette`
  - Existing helper: `src/hooks/use-command-palette-history.ts`.
  - Add `src/components/command-palette-index.ts` for route/action indexing and filtering.
  - Add `src/components/command-palette-keyboard.ts` or a hook for roving index/keyboard behavior if the current component owns that directly.
  - Tests: add filtering/ranking and keyboard navigation tests; keep jsdom component test focused on open/select behavior.

- `YieldClient`
  - Add `src/app/yield/yield-view-model.ts` for filtering, sorting, risk-adjusted display rows, warning summaries, and empty states.
  - Keep TanStack Query hooks and route rendering in `client.tsx`.
  - Tests: pure sorting/filtering model tests plus one route client smoke with mocked hook data.

- `StatusClient`
  - Add `src/app/status/status-view-model.ts` for section grouping, degraded cause summaries, and public display state.
  - Avoid mixing admin status client patterns; public status route has separate UX.
  - Tests: pure model tests for fresh/degraded/stale statuses and one jsdom render smoke.

Hotspot ratchet handling:

- Do not update `scripts/lib/hotspot-ratchet-waivers.json` until a file is actually below target or intentionally re-baselined.
- After each extraction, run `npm run check:hotspot-ratchet`.
- If a file is no longer a hotspot, remove or change its waiver entry in the same PR.

Validation for each frontend tranche:

- `npm run lint`
- `npm run typecheck`
- Relevant `npx vitest run ...` files
- `npm run build`
- `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local` for visual/layout-affecting changes

Effort: Medium per component, Large for the full Q6/S3 frontend tranche.

### D. Worker Hotspot Decomposition (Q5, S3, C3)

Principles:

- Extract pure decisions before moving side effects.
- Preserve provider ordering and circuit-breaker writes.
- Do not combine extraction with provider additions.
- Keep old function exports while moving internals so callers do not churn.

#### `crawlCoin` in `worker/src/cron/dex-discovery/crawl-sources.ts`

Proposed files:

- `worker/src/cron/dex-discovery/crawl-context.ts`
- `worker/src/cron/dex-discovery/crawl-cg-onchain.ts`
- `worker/src/cron/dex-discovery/crawl-geckoterminal.ts`
- `worker/src/cron/dex-discovery/crawl-dexscreener.ts`
- `worker/src/cron/dex-discovery/crawl-cg-tickers.ts`

Code-level approach:

1. Extract a `CrawlCoinContext`:

   ```ts
   interface CrawlCoinContext {
     stablecoinId: string;
     knownPoolIds: Set<string>;
     nowSec: number;
     signal?: AbortSignal;
     deadlineMs?: number;
     references?: PriceValidationReferences;
     addPool(pool: StagedPool): void;
     addPriceObs(obs: DexPriceObs & { stablecoinId: string }): void;
     timeExceeded(): boolean;
     buildStageSignal(timeoutMs: number): AbortSignal;
   }
   ```

2. Extract stage functions returning only local metadata:

   - `crawlCoinGeckoOnchainStage(ctx, coinTargets, cgApiKey): Promise<{ queriedChains: Set<string>; unresolvedChains: string[] }>`
   - `crawlGeckoTerminalStage(ctx, coinTargets, queriedCgChains): Promise<void>`
   - `crawlDexScreenerStage(ctx, targets): Promise<void>`
   - `crawlCoinGeckoTickersStage(ctx, geckoId, cgApiKey, shouldRun): Promise<void>`

3. Keep `crawlCoin()` as orchestration:

   - initialize arrays and context
   - run stages in current order
   - return `{ pools, priceObs, unresolvedChains }`

Tests:

- Keep `crawl-sources.test.ts` as top-level characterization.
- Add stage-level tests:
  - CG onchain stages current `keeps CoinGecko onchain staging output` case.
  - DexScreener malformed pair and target error cases.
  - CG ticker orderbook fallback case.

Validation:

- `npx vitest run worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts worker/src/cron/dex-discovery/__tests__/sync-dex-discovery.test.ts`

Effort: Medium.

#### `analyzeDexLiquidityPostScoring` in `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`

Proposed files:

- `worker/src/cron/dex-liquidity/metadata-baselines.ts`
- `worker/src/cron/dex-liquidity/metadata-coverage.ts`
- `worker/src/cron/dex-liquidity/metadata-drift.ts`
- `worker/src/cron/dex-liquidity/metadata-protocol-caps.ts`

Code-level approach:

1. Extract previous baseline loading from `224-337` into `loadDexLiquidityPreviousBaselines(db)`.
2. Extract coverage guard computation from `339-384` into `computeDexLiquidityCoverageGuards({ currentCoverage, previousCoverageRow, globalAgg, previousGlobalRow, previousTopCoverageRows })`.
3. Extract watchlist delta and quality drift flag computation from `400-465` into `computeDexLiquidityQualityDrift(...)`.
4. Extract source-family and protocol-cap reductions from `467-556` into:
   - `summarizeRetainedPoolSourceFamilies(...)`
   - `summarizeProtocolCapReductions(...)`
5. Keep `buildDexLiquidityCronMetadata()` unchanged except for type import updates.

Tests:

- Expand `orchestrator-metadata.test.ts`:
  - previous metadata parse failure returns null and no drift flags.
  - measured-balance drop triggers high severity.
  - protocol cap summary returns top protocols and stablecoins sorted by reduction.
  - source-family counts are stable for direct_api/dl/gecko_terminal/cg_tickers.

Validation:

- `npx vitest run worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts`

Effort: Medium.

#### `confirmPendingDepegs` in `worker/src/cron/confirm-pending-depegs.ts`

Proposed files:

- `worker/src/cron/depegs/confirmation-sources.ts`
- `worker/src/cron/depegs/confirmation-decision.ts`
- `worker/src/cron/depegs/confirmation-mutations.ts`

Code-level approach:

1. Extract source collection:

   ```ts
   interface DepegConfirmationEvidence {
     offchainStatus: DirectionalSignalStatus;
     dexStatus: DirectionalSignalStatus;
     cexStatus: DirectionalSignalStatus;
     poolStatus: DirectionalSignalStatus;
     confirmedBy: string[];
   }
   ```

2. Extract pure decision:

   ```ts
   type PendingDepegDecision =
     | { action: "skip"; reason: "too-young" | "mixed-evidence" | "insufficient-secondary" }
     | { action: "delete"; reason: "invalid-peg-reference" | "open-event-exists" | "native-recovered" | "primary-recovered" | "expired" | "false-positive" | "offchain-disagrees-no-dex" }
     | { action: "promote"; event: DepegEvent; confirmedBy: string[] };
   ```

3. Keep DB loading and `batchExecute` in the existing function.
4. Move event construction from `316-357` into a pure helper that accepts `pendingState`, `row`, `asset`, `primaryTrust`, `threshold`, and current signal.
5. Preserve exact low-confidence rule from `304-314`: offchain-only confirmation cannot promote low-confidence pending events.

Tests:

- Add `worker/src/cron/__tests__/confirm-pending-depegs-decision.test.ts` for pure decision table.
- Keep existing `confirm-pending-depegs.test.ts` as integration characterization.
- Ensure existing tests around opposite-direction corroboration, low-confidence circular agreement, thin DEX rows, Binance diagnostics, and pool confirmation still pass.

Validation:

- `npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs-decision.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts`

Effort: Medium/Large.

#### `fetchPrimaryPrices` in `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`

Proposed files:

- `worker/src/cron/sync-stablecoins/primary-price-plan.ts` if `buildPrimaryPricePlan` is not already enough.
- `worker/src/cron/sync-stablecoins/primary-price-provider-fetches.ts`
- `worker/src/cron/sync-stablecoins/primary-price-consensus.ts`

Code-level approach:

1. Keep `buildPrimaryPricePlan()` as the planning boundary if already private in `enrich-prices-primary.ts`.
2. Extract provider collection from `530-733`:

   ```ts
   interface PrimaryProviderQuoteBundle {
     cgPrices: Map<string, number>;
     cgObservedAtByGeckoId: Map<string, number>;
     cgObservedAtModeByGeckoId: Map<string, PriceObservedAtMode>;
     cgObservedAt: number | null;
     cgTickerPrices: Map<string, number>;
     ...
     providerDiagnostics: PricingProviderAttemptDiagnostic[];
     staleCgPriceRows: number;
   }
   ```

3. Provider fetcher function:

   ```ts
   async function fetchPrimaryProviderQuotes(params: {
     db: D1Database;
     signal?: AbortSignal;
     sourceAllowed: SourceAllowed;
     geckoIds: string[];
     ...
   }): Promise<PrimaryProviderQuoteBundle>
   ```

4. Keep consensus assembly in or around `buildPrimaryConsensusResults()`; only pass `quoteBundle` instead of many local variables.
5. After extraction, `fetchPrimaryPrices()` should read as:

   - `throwIfAborted`
   - `resolveDlListQuote`
   - `plan = await buildPrimaryPricePlan`
   - `quoteBundle = await fetchPrimaryProviderQuotes`
   - `buildPrimaryConsensusResults`
   - `applyPrimaryPostConsensusHardening`
   - logging and return

Tests:

- Split from `enrich-prices.test.ts` only after Q8 helper work:
  - provider fetch behavior tests in `primary-price-provider-fetches.test.ts`
  - consensus tests in `primary-price-consensus.test.ts`
  - post-consensus pool challenge tests remain with `applyPoolChallenge`

Validation:

- `npx vitest run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts`
- `npm run audit:pricing-providers`

Effort: Large.

#### `dispatch-telegram-alerts` from S3

Affected file: `worker/src/cron/dispatch-telegram-alerts.ts`.

Proposed split:

- `worker/src/cron/telegram-alerts/candidates.ts` for subscriber and alert candidate selection.
- `worker/src/cron/telegram-alerts/render.ts` for message text rendering.
- `worker/src/cron/telegram-alerts/delivery.ts` for send/retry/blocked subscriber handling.
- `worker/src/cron/telegram-alerts/queue.ts` for overflow/pending queue handling if not already separated.

Tests:

- Preserve `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts` as integration coverage.
- Add pure render/candidate tests as modules are extracted.

Validation:

- `npx vitest run worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts worker/src/cron/__tests__/telegram-pending-queue.test.ts worker/src/cron/__tests__/telegram-alert-snapshots.test.ts`

Effort: Medium/Large.

### E. Test Suite Cleanup (R11, Q8)

#### R11 quick cleanup

1. `scripts/__tests__/smoke-ops.test.ts`
   - Add local helpers:
     - `transientProxyResponse(status: 502 | 504): Response`
     - `healthyProxyResponse(body = { overallStatus: "degraded" }): Response`
     - `expectSingleRetry({ fetchMock, sleepMock, onRetry, status })`
   - Refactor `107-184` tests to parameterized cases:

     ```ts
     it.each([502, 504])("retries transient proxied %i once", async (status) => ...)
     ```

2. `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts`
   - Add:

     ```ts
     function makeEvmBranchBalancesConfig(overrides?: {
       branches?: LiveReservesConfig["params"]["branches"];
       redemptionRateProbe?: ...
     }): LiveReservesConfig
     ```

   - Default branches: wstETH and WBTC, matching current tests.
   - Keep each test's branch differences visible through overrides.

3. Depeg trust-policy tests:
   - Merge unique assertions from `worker/src/lib/__tests__/depeg-helpers.test.ts` into `worker/src/lib/__tests__/depeg-trust-policy.test.ts`.
   - Delete or rename `depeg-helpers.test.ts` because it does not test `depeg-helpers`.
   - Ensure unique cases retained:
     - hard single-source local-fetch requires confirmation
     - soft-only high-confidence agreement requires confirmation
     - hard plus soft with upstream-capable source is authoritative
     - hard local-fetch plus soft requires confirmation
     - two local hard sources are authoritative
     - legacy null freshness mode
     - USD/commodity peg references remain authoritative

4. Redemption backstop family metadata:
   - Add `shared/lib/redemption-backstop-family-modules.ts` with:

     ```ts
     export const REDEMPTION_BACKSTOP_FAMILY_MODULES = [...]
     ```

   - Use direct imports from `shared/lib/redemption-backstop-configs/*`.
   - Update `shared/lib/__tests__/redemption-backstop-consistency.test.ts` and `scripts/check-redemption-backstops.ts` to consume the shared list.

Validation:

- `npx vitest run scripts/__tests__/smoke-ops.test.ts worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts worker/src/lib/__tests__/depeg-trust-policy.test.ts shared/lib/__tests__/redemption-backstop-consistency.test.ts`
- `npm run check:redemption-backstops`
- `npm run check:worker-boundary`
- `npm run check:unused-code`

Effort: Small/Medium.

#### Q8 split plan for oversized suites

Important package-script dependency:

- `test:invariants` currently names:
  - `worker/src/cron/__tests__/sync-stablecoins.test.ts`
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `coverage:critical` currently names:
  - `worker/src/api/__tests__/status.test.ts`
  - `worker/src/cron/__tests__/sync-stablecoins.test.ts`
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`
  - plus other critical files
- Any split/rename must update `package.json` in the same PR.

Recommended staged approach:

1. Extract helpers without moving tests.
2. Split one large suite per PR.
3. Update `package.json` exact test lists in that same PR.
4. Run `npm run coverage:critical` to prove critical coverage survives.

Split targets:

- `worker/src/cron/__tests__/enrich-prices.test.ts`
  - `price-bounds.test.ts`: `PRICE_BOUNDS`, `isReasonablePrice`, `hasMissingPrice`
  - `enrich-missing-prices.test.ts`: `enrichMissingPrices` fallback passes
  - `primary-prices.test.ts`: `fetchPrimaryPrices` behavior
  - `pool-challenge.test.ts`: `applyPoolChallenge`
  - Helper module: `worker/src/cron/__tests__/enrich-prices.helpers.ts`

- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
  - `sync-stablecoins-core.test.ts`: DefiLlama fetch/cache, stage progress, schema validation
  - `sync-stablecoins-pricing-continuity.test.ts`: severe downside, previous trusted prices, price cache replay, GT probe ordering
  - `sync-stablecoins-supply-fallbacks.test.ts`: CG supply fallback, gold assets, on-chain supply fallback
  - `sync-stablecoins-fallbacks.test.ts`: DL HTTP/parse/circuit failure paths
  - Keep existing `sync-stablecoins-stages.test.ts` and `sync-stablecoins-post-enrichment.test.ts`.
  - Helper module: `worker/src/cron/__tests__/sync-stablecoins.helpers.ts`

- `worker/src/cron/__tests__/sync-yield-data.test.ts`
  - `sync-yield-data-publication.test.ts`: normal path, cache publication, cleanup, schema validation, degraded publication
  - `sync-yield-data-supplemental.test.ts`: optional protocol suggestions, TVL gates, blocked sources, small ecosystem gates
  - `sync-yield-data-deterministic-rates.test.ts`: on-chain cooldowns, RPC fallback, Etherscan proxy fallback, explorer failures
  - `sync-yield-data-history.test.ts`: trailing APY, source-specific history, legacy migration reuse
  - `sync-yield-data-coverage-guards.test.ts`: previous rankings, safety snapshot coverage, benchmark staleness
  - Helper module: `worker/src/cron/__tests__/sync-yield-data.helpers.ts`

- `worker/src/api/__tests__/status.test.ts`
  - `status-auth-cache.test.ts`: auth, no-store, sentinel fallback
  - `status-cron-health.test.ts`: cron history, in-flight runs, watch-tier behavior
  - `status-data-quality.test.ts`: stablecoins cache malformed, blacklist gaps, reserve overview
  - `status-availability.test.ts`: FX fallback, mint/burn degraded, circuit groups
  - `status-missing-prices.test.ts`: missing-price thresholds and canonical scoping
  - `status-telegram-ops.test.ts`: Telegram stats and subsection errors
  - Helper module can reuse existing `worker/src/api/__tests__/helpers/mock-d1.ts`, `fixtures.ts`, and `auth.ts`.

Validation for each split PR:

- Targeted `npx vitest run` for old and new files during transition.
- `npm test`
- `npm run coverage:critical`
- `npm run test:invariants`
- `npm run check:unused-code`

Risks:

- Exact file lists in package scripts are the main failure mode.
- Moving shared mocks can change hoisting order. Preserve `vi.mock` hoisting by keeping mocks at top level in each split test or using `vi.hoisted`.
- Do not collapse scenario fixtures so far that individual test intent becomes opaque.

Effort: Large overall; Medium per oversized suite.

## Phase Roadmap

### Phase 1: Quick, Low-Risk Refactors

1. R6 blacklist accumulation helper
   - Effort: Small
   - Dependencies: none
   - Validation: sync-blacklist tests, cron connections, SQL safety

2. R4 optional yield append helper
   - Effort: Small
   - Dependencies: none
   - Validation: yield-resolve and sync-yield-data tests

3. R2 supply-history helper
   - Effort: Small
   - Dependencies: none
   - Validation: backfill-supply-history tests

4. R9 CSS token dedupe
   - Effort: Small
   - Dependencies: none
   - Validation: build and UI smoke

5. R11 small test helper cleanup
   - Effort: Small/Medium
   - Dependencies: none
   - Validation: targeted tests plus unused-code

### Phase 2: Provider Boundary And Shared Runtime Loops

1. Q4 DEX direct API JSON hardening
   - Effort: Medium
   - Dependencies: none, but do before DEX source-stage splits
   - Validation: direct API fetcher tests, orchestrator phases, worker typecheck

2. R5 EVM RPC shared fallback policy
   - Effort: Medium
   - Dependencies: none, but do before live-reserve/yield EVM adapter cleanups
   - Validation: evm-rpc and adapter tests

3. R1 price-result application helper
   - Effort: Small
   - Dependencies: none, but do before `fetchPrimaryPrices` extraction
   - Validation: new pricing unit tests and sync-stablecoins tests

### Phase 3: Frontend And Methodology Presentation Cleanup

1. R3 DEWS diagram array/component extraction
   - Effort: Medium
   - Dependencies: none
   - Validation: build, SEO, visual/UI smoke

2. R10 remove site-config wrapper
   - Effort: Small/Medium
   - Dependencies: none
   - Validation: typecheck, build, SEO, unused-code

3. Q6 first frontend hotspot: ContagionGraph view model
   - Effort: Medium
   - Dependencies: none
   - Validation: contagion helper/component tests, build

4. Q6 second frontend hotspot: ApiKeysPanel split
   - Effort: Medium
   - Dependencies: no API behavior changes
   - Validation: api-keys-panel tests, admin client tests if impacted

### Phase 4: Worker Structural Hotspot Extraction

1. `crawlCoin` stage extraction
   - Effort: Medium
   - Dependencies: Q4 recommended first
   - Validation: crawl-sources and sync-dex-discovery tests

2. `analyzeDexLiquidityPostScoring` extraction
   - Effort: Medium
   - Dependencies: Q4 recommended first
   - Validation: orchestrator-metadata and sync-dex-liquidity tests

3. `confirmPendingDepegs` decision extraction
   - Effort: Medium/Large
   - Dependencies: none
   - Validation: confirm-pending-depegs and sync-stablecoins tests

4. `fetchPrimaryPrices` provider bundle extraction
   - Effort: Large
   - Dependencies: R1 and R5 first
   - Validation: enrich-prices, sync-stablecoins, pricing provider audit

5. `dispatch-telegram-alerts` split
   - Effort: Medium/Large
   - Dependencies: none
   - Validation: Telegram alert and pending queue tests

### Phase 5: Oversized Test Suite Split

1. Extract test helper modules
   - Effort: Medium
   - Dependencies: R11 quick cleanup

2. Split `enrich-prices.test.ts`
   - Effort: Medium
   - Dependencies: helper module

3. Split `sync-stablecoins.test.ts`
   - Effort: Medium/Large
   - Dependencies: R1 tests/helper module

4. Split `sync-yield-data.test.ts`
   - Effort: Large
   - Dependencies: R4 helper and tests

5. Split `status.test.ts`
   - Effort: Large
   - Dependencies: helper module

6. Update `package.json` exact critical/invariant file lists with every split
   - Effort: Small but mandatory
   - Dependencies: each split PR

## Open Questions

1. R10 wrapper removal versus documenting intentional alias:
   - Recommendation: remove wrapper. It is broad but mechanical, and the architecture docs already name `@shared/lib/runtime-origins` as the source of truth.
   - Alternative: keep wrapper with a comment if the team values `SITE_URL` readability in metadata files more than removing one indirection.

2. R3 visual testing:
   - The repo has UI smoke tooling, but this plan cannot verify screenshots until implementation. The implementing agent should run local smoke and inspect `/methodology` desktop/mobile.

3. Q8 split filenames:
   - Names above are proposed. Exact file names can change, but `package.json` critical/invariant scripts must be updated in the same PR as any split.

4. S3 target budgets:
   - Do not lower hotspot budgets preemptively. Only update baseline/waiver metadata after measurable reductions.

## Plan Review Loop

### Review Pass 1

Issues found:

1. Major: The initial Q8 split plan did not account for exact-file references in `package.json` `test:invariants` and `coverage:critical`.
2. Major: The R4 helper plan would have changed the currently silent matched-ID missing-metadata behavior.
3. Medium: The Q4 plan did not specify whether malformed individual provider rows should fail the page or be skipped.
4. Medium: The R10 plan left the wrapper removal/documentation choice unresolved.
5. Minor: The S3 plan did not state when to update hotspot waivers/baseline.

Fixes applied:

- Added package-script dependency and validation requirements to Q8.
- Added `missing-meta` status and branch-specific counter behavior to R4.
- Specified root JSON failure as page degradation and per-row malformed data as bounded skip/error summary for Q4.
- Chose wrapper removal as the recommended R10 path while listing the alternative as an open question.
- Added hotspot ratchet update timing rules.

### Review Pass 2

Issues found:

1. Minor: Visual validation commands for CSS/methodology changes needed explicit local build/static-smoke sequencing.

Fixes applied:

- Added `npm run build`, `npm run seo:check`, and local `test:smoke-ui` validation guidance to R3/R9/Q6.

### Review Pass 3

Result:

- 0 blocking issues.
- 1 minor residual issue: exact Q8 split filenames are recommendations and may be adjusted during implementation, as long as package scripts are updated atomically.

The review loop stops here because the final review returned fewer than 2 minor issues.
