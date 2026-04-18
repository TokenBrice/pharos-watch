# Liquidity Pipeline Hardening Plan (2026-04-16)

> **This is a PLAN, not an executed changeset.** None of the code changes below have been applied yet. Reviewers: verify executability (correct file paths, real function signatures, internally consistent steps), not whether the repo already reflects the plan's end state.

> **For agentic workers.** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. Tasks within the same wave may be dispatched in parallel to fresh Opus subagents. Waves are sequential: each wave verifies and commits before the next dispatches.

**Goal.** Remediate findings from the 2026-04-16 fresh liquidity audit. The prior plan (`agents/plans/historical/2026-04-16-liquidity-remediation-plan.md`) was executed and archived; fresh audit confirms the major dedup/direct-API fixes landed. Remaining work: one calibration bug (TVL Depth fallback), one price-derivation issue on Slipstream CL pools, six targeted refactors of files that have grown past maintenance-friendly size, and a dozen hygiene/test items.

**Architecture.**
- Fix bugs surgically, TDD-first. Real-fixture tests where external shape matters.
- Preserve v5.4 methodology semantics except where a correctness fix justifies a bump. TVL Depth fallback calibration alone is a numeric change to a minority path (coins without market cap) — bumps methodology to **v5.5**.
- Refactors are boundary-preserving: no API surface changes, no behavior changes, tests remain green.
- Commit one thematic batch per wave.

**Tech stack.** TypeScript, Cloudflare Workers, D1, Vitest (inline fixtures, no `__tests__/fixtures/` directory convention), Next.js 16 frontend, Wrangler.

**Source artifacts (read before executing).**
- `docs/dex-liquidity.md` — pipeline methodology reference.
- `docs/liquidity-score-timeline.md` — v1.0 → v5.4 timeline; this plan adds v5.5.
- `agents/plans/historical/2026-04-16-liquidity-remediation-plan.md` — **prior plan**, already executed. This plan builds on its baseline.
- `shared/lib/liquidity-score-version.ts` — commit-window version registry for historical methodology reconstruction. Must be updated when v5.5 ships.
- `shared/lib/liquidity-score-weights.ts` — single source of truth for component weights (unchanged here).

**User rules (non-negotiable).**
- Simplicity first. Minimum code that fixes the bug. No speculative abstraction.
- Surgical changes. Touch only what the fix requires.
- Real-fixture tests where external shape matters.
- Fetcher failures must propagate — never swallow to `[]`.
- Incremental deployment: new fetchers are strictly out of scope for this plan.
- Verify with `cd worker && npx vitest --run`, `cd worker && npx tsc --noEmit`, `npm run lint`, `npm run test:merge-gate` before claiming done.
- **Documentation parity.** Every behavioral change updates `docs/dex-liquidity.md` and the matching changelog/timeline doc in the same commit. The code review gate rejects behavioral changes without doc updates.

---

## Current state (fresh audit verdict)

- **Primary + direct-API fetchers:** clean.
  - Meteora uses `current_price` (reserve-ratio bug fixed). Verified at `worker/src/cron/dex-liquidity/fetch-meteora.ts:120-125`.
  - Balancer uses API `address` (not `id`) for dedup identity. Verified at `fetch-balancer.ts:109-120`.
  - PancakeSwap V3 uses bounded trailing-hour `poolHourDatas` volume window.
  - Fluid DexReservesResolver integration live on ETH/Arbitrum/Base/Polygon.
- **Dedup architecture:** sound. HIGH-1 from prior dedup audit (DL UUID vs direct address poolId) is fixed: `process-pools.ts:243-246` uses `isTrustworthyExactPoolId` + `buildPoolFingerprint` fallback. HIGH-2 (Balancer charitable shape) landed. HIGH-3 (orderbook poolId conventions) unified via the `orderbook` chain sentinel.
- **Score math:** all five component formulas match doc v5.4. Weights sum to 100%. Log bases correct, division guards in place.
- **Storage:** schema complete in baseline migration; all new fields (`coverage_class`, `coverage_confidence`, `source_mix_json`, `balance_measured_tvl_usd`, `organic_measured_tvl_usd`, `methodology_version`) present.
- **Test baseline:** 261/261 dex-liquidity tests passing.

## Dismissed findings (transparency)

These were raised by fresh-audit subagents but invalidated on verification. Listing them so future audits don't re-surface them:

- **"Aerodrome price formula dimensionally inconsistent"** — formula is algebraically correct. `subgraph-source-families.ts:219` computes `denom = reserve0 * token1Price + reserve1` where `token1Price` is the token1-per-token0 ratio (pure number, no USD units). The identity `reserveUSD = price1Usd × (reserve0 × token1Price + reserve1)` holds because `price0Usd = token1Price × price1Usd`. No fix needed.
- **"Single-exposure filter missing at `buildKnownPoolAddresses` line 376"** — the filter IS present: `fetch-primary.ts:376` has `if (pool.exposure === "single") continue;`.
- **"Curve metapool TVL undercount through `CurvePoolEntry.tvl`"** — the scoring path uses `metapoolAdjustedTvl` via `process-pools.ts:124,184`. `entry.tvl` is only referenced for sorting/display, not aggregation.
- **"Aerodrome `isStable` not passed to `buildPoolIdentity`"** — it IS passed at `subgraph-source-families.ts:243`.
- **"DeFiLlama volume fields virtually always null"** — live curl shows 791/3375 (≈23%) of stablecoin pools have non-null `volumeUsd1d`. Real observation, exaggerated severity. Absorbed as documentation nit only.

---

## Verified findings (remediation targets)

### P1 — correctness

**F1. Absolute TVL Depth fallback scales ~24 points higher than ratio formula.**
- File: `worker/src/cron/dex-liquidity/pool-helpers.ts:108`
- Code: `tvlDepth = Math.min(100, Math.max(0, 20 * Math.log10(Math.max(tvlInput, 1) / 100_000) + 20));`
- Behavior: ratio formula at 0.5% depth scores ~30; fallback at $5M raw TVL scores ~54. A coin without market-cap data ($5M TVL) is effectively given the TVL Depth of a coin with $7B+ market cap at 0.5% ratio.
- Impact: over-states TVL Depth (a 30% weight) for the subset of tracked coins without a `circulatingUsd` value at cron time. These are typically newer/low-cap assets, precisely the ones we don't want to score leniently.
- Fix direction: recalibrate the fallback to share the ratio formula's anchor (0.07% depth = score 0), using $1B as the reference mcap for coins without live market cap data. Equivalent absolute anchor: `$1B × 0.0007 = $700K`. Formula: `35 * log10(max(tvl, 1) / 700_000)`. Verification:
  - $700K → `35 * log10(1) = 0` (anchor parity)
  - $5M → `35 * log10(7.14) ≈ 30` (matches ratio at 0.5% of $1B)
  - $140M → `35 * log10(200) ≈ 80` (matches ratio at 14% of $1B)
  - ≥$500M → clamps at 100 (formula reaches 100 at `tvl = 700_000 × 10^(100/35) ≈ $504M`)
  The formula is literally the ratio formula with the mcap substituted by the $1B reference. Alternative: reuse one branch via `const mcap = circulatingUsd ?? 1_000_000_000;` and always run the ratio formula — mathematically identical. Either is acceptable; prefer the substitution for readability and so the reference mcap is explicit.
- Methodology impact: **v5.5 bump**. Limited to coins currently falling into the fallback path. Historical reconstruction stays on v5.4 for legacy rows.

**F2. Slipstream CL price derivation uses `reserve1/reserve0`, biased for concentrated liquidity.**
- File: `worker/src/cron/dex-liquidity/fetch-slipstream.ts:199`
- Code:
  ```ts
  price: reserve0 > 0 ? reserve1 / reserve0 : null,
  ```
  AND lines 167–172 use the same ratio to derive missing side prices when only one token is tracked.
- Behavior: for concentrated liquidity, `reserve0` / `reserve1` are total-across-all-ticks and their ratio is NOT the spot price. For tight, balanced stable/stable pools this is a small error; for stable/volatile pools (e.g. WETH/USDC) it can be materially off.
- Impact: direct effect on Slipstream-emitted DEX price observations (bounded by peg-aware sanity gate), and indirect effect on TVL for pools where the other side's USD price was derived from the same ratio. Peg sanity protects observation quality but cannot reject a wrong TVL quietly in-range.
- Fix direction: use Sugar's `sqrt_ratio` (Q64.96) to derive spot price. Pseudocode:
  ```ts
  const Q96 = 1n << 96n;
  const Q192 = 1n << 192n;
  const num = sqrtRatio * sqrtRatio;        // sqrtRatio is bigint from Sugar
  // Price of token1 in token0 native units, decimals-adjusted:
  const price1In0Raw = Number(num) / Number(Q192);
  const price1In0 = price1In0Raw * Math.pow(10, token0.decimals - token1.decimals);
  ```
  Guard: for `sqrtRatio > 2^53`, cast through fixed-point scaling (divide by 2^48 first). Provide a small helper with unit tests against three known fixtures (balanced 1:1 stable, imbalanced stable/stable, stable/ETH).
- Pragmatic fallback (if sqrt_ratio math carries unresolved risk): drop Slipstream pools where one side lacks a `trackedStablecoinPrices` entry; do NOT derive the missing price from reserves. This preserves correctness at the cost of coverage on stable/volatile pools.
- Methodology impact: same **v5.5 bump**; Slipstream now uses spot-price math consistent with the peg-sanity contract.

### P2 — maintainability (targeted refactors)

**F3. `orchestrator-metadata.ts` at 795 lines.**
- File: `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`
- Issue: largest file in the module. Single module handles (a) post-scoring analysis, (b) drift severity detection, (c) cron metadata shaping, (d) degraded-status decision. Each of these is testable independently.
- Fix: split into `orchestrator-analysis.ts`, `orchestrator-drift.ts`, `orchestrator-metadata.ts` (metadata-only), keeping `analyzeDexLiquidityPostScoring`, `buildDexLiquidityCronMetadata`, `isDexLiquidityDegraded` as the export surface of the parent module via a barrel file. Tests follow the same split.

**F4. `challenger-persistence.ts` at 687 lines.**
- File: `worker/src/cron/dex-liquidity/challenger-persistence.ts`
- Issue: mixes publisher (`publishDexPriceChallengerSnapshots`, `publishDexPoolChallengers`), loader (`loadDexPoolChallengers`), legacy loader (`loadLegacyDexPoolChallengers`), and SQL-shape helpers in one file.
- Fix: split into `challenger-publish.ts`, `challenger-load.ts`, `challenger-sql.ts` (or equivalent). Keep behavior identical; no contract changes.

**F5. `orchestrator-phases.ts` at 644 lines.**
- File: `worker/src/cron/dex-liquidity/orchestrator-phases.ts`
- Issue: each phase (subgraph enrichment, direct-API fetch, fallback crawlers, price-observation merge, authoritative-confirmation index, tracked-map loaders) is a self-contained concern.
- Fix: split into per-phase modules under `orchestrator-phases/` directory. Use a barrel export to keep the import surface at the orchestrator unchanged.

**F6. `DexLiquidityPoolState extends DexLiquidityFallbackPhase` coupling leak.**
- File: `worker/src/cron/dex-liquidity/orchestrator.ts:183-193`
- Issue: `DexLiquidityPoolState extends DexLiquidityFallbackPhase` makes pool-state a superset of a phase-return shape. Composition is cleaner and enables independent evolution.
- Fix: replace `extends` with explicit composed fields: `interface DexLiquidityPoolState { fallback: DexLiquidityFallbackPhase; metrics: ...; ... }`. Update ~4 call sites that read from the nested structure.

**F7. Coverage classifier magic numbers.**
- File: `worker/src/cron/dex-liquidity/scoring-helpers.ts` (look for the literal thresholds `0.75`, `0.5`, `0.15`, `0.65`)
- Fix: extract as named constants at the top of the file (`COVERAGE_CONFIDENCE_MIN_FOR_HISTORY = 0.75`, `POOL_QUALITY_FLOOR = 0.15`, `POOL_QUALITY_CEILING = 0.80`, etc.). Add a one-line JSDoc citing the methodology section.

**F8. `as Record<string, number | unknown>` cast in `applyProtocolCaps`.**
- File: `worker/src/cron/dex-liquidity/scoring-helpers.ts` (search for `Record<string, number | unknown>`)
- Fix: introduce a typed helper for the protocol-cap breakdown shape so the cast is unnecessary. If the cast is load-bearing because of a D1 row shape, constrain it to the narrowest possible site (e.g., a small adapter function with an explicit test).

### P3 — hygiene

**F9. `lockedLiquidityPct` schema `.optional()` removal.**
- File: `shared/types/market.ts` (schema `DexLiquidityDataSchema`)
- Fix: change `lockedLiquidityPct: z.number().nullable().optional()` → `lockedLiquidityPct: z.number().nullable()`. Field is always present (may be null) on API response per `worker/src/api/dex-liquidity.ts:132`. Remove redundant `.optional()`.

**F10. `DexPriceChallengerSqlStatement` unused export.**
- File: `worker/src/cron/dex-liquidity/challenger-persistence.ts:79`
- Fix: mark `/** @internal */` or delete. Export is not consumed externally; orchestrator constructs `{ sql, binds }` literals.

**F11. DexScreener malformed-pair summary logging.**
- File: `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` (DexScreener fallback path)
- Fix: accumulate `malformedCount` per coin; emit a single `console.warn` at loop end when count > 0. Avoids operator blind spots when DS API shape drifts.

**F12. `poolId` format validation at discovery intake.**
- File: `worker/src/cron/dex-discovery/persistence.ts` (or the write site)
- Fix: add `validateStagedPoolId(poolId: string)` that enforces `^[a-z0-9-]+:[a-z0-9:.x-]+$` (chain:address or orderbook:exchangeid:coin). Reject malformed rows at write time with a telemetry counter; do not crash the coin crawl.

**F13. `pool_fee` unit assertion for Slipstream.**
- Files:
  - `worker/src/cron/dex-liquidity/fetch-slipstream.ts` (line 179: `const feeBps = Number(pool.pool_fee);`)
  - `worker/src/cron/dex-liquidity/direct-source-helpers.ts` (`normalizeFeeRateFromBps`)
- Issue: Sugar's `pool_fee` unit is not documented in the ABI parse. Current code assumes basis points directly. If it were 1e6 scale, all Slipstream pools would be classified into the wrong quality tier.
- Fix: add a `getSlipstreamPoolFeeBps()` helper with an assertion that the observed range matches bps expectations (e.g., must be 1–10000). Log a diagnostic if a pool falls outside. Verify with a live RPC call against a known Aerodrome 1bp or 5bp pool and document the expected value inline.

**F14. Remove stale `M3`/`H2`/`H1` comment tags.**
- File: sweep `worker/src/cron/dex-liquidity/` for stale audit-tag comments. These referenced the prior audit's numbering and are obsolete now.
- Fix: delete or update the comments. Zero behavior change.

### Tests to add

**F15. Curve metapool TVL dedup regression test.**
- File: `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts` (or a new test in `dex-liquidity/__tests__/`)
- Assertion: for a fixture where DL row has `usdTotal = 100M` and Curve entry has `basePoolAddress` + `usdTotalExcludingBasePool = 60M`, the scoring path uses 60M for `effectivePoolTvl` and `protocolTvl` contribution.

**F16. `computeLiquidityScore` fallback branch calibration test.**
- File: `worker/src/cron/dex-liquidity/__tests__/pool-helpers.test.ts`
- Assertion: at `tvlInput = $5M`, the fallback score matches (within ±2 points) the ratio score at `tvlInput = $5M, circulatingUsd = $1B`. Fails today (expected ~54 vs ~30); passes after F1.

**F17. Slipstream `sqrt_ratio` helper unit tests.**
- File: `worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts`
- Fixtures:
  - Balanced stable/stable (sqrtRatio corresponding to 1:1 price) — helper returns 1.0 ± epsilon
  - 1 ETH ≈ 3500 USDC — helper returns 3500 ± reasonable epsilon
  - Extremely imbalanced (sqrtRatio at edge of range) — helper does NOT crash, returns finite value within peg-sanity bounds
- Only land this test alongside F2.

**F18. `addSecondaryPoolContribution` balance ratio clamp test.**
- File: `worker/src/cron/dex-liquidity/__tests__/pool-contribution.test.ts` (new) or add to existing test file
- Assertion: a pool with `balanceRatio = 1.3` (pathological) produces a balance-health-capped contribution (not 1.3^1.5 inflation).

---

## Deferred out of scope

These are explicitly deferred. Each has a reason.

- **New fetchers** (Noble Swaps, Trader Joe, Pharaoh, Sui, Aptos, HyperEVM, Berachain, QuickSwap, Stellar, XRPL, TON, CEX orderbook promotion) — per memory rule, one fetcher per PR with a 24-hour monitoring gate. Each gets its own plan.
- **A6 from prior plan — complete Slipstream `sqrt_ratio` rewrite** — F2 in this plan addresses it pragmatically. If the BigInt Q64.96 helper is deemed too risky, use the pragmatic fallback (drop stable/volatile pools without tracked side-price). Full helper rewrite with multiple fixtures and live-contract verification may still warrant a spike plan.
- **`score-weights.ts` shim elimination** — file is 11 lines and re-exports from `shared/lib`. Keep as a worker-side facade; eliminating it is a no-op refactor with tsc churn.
- **`ScoreResult` vs `FullScoreResult` type split** — structural refactor not justified by current maintenance pain.
- **Base58 case preservation** (MED-6 from prior dedup audit) — Solana addresses are case-sensitive; current lowercasing is acceptable for Map keys but a future Solana-native protocol integration may require case preservation. Ship when a concrete need arises.
- **Synthetic CG-tickers staged derived key** (LOW-2 from prior dedup audit) — addressed indirectly by unified orderbook poolId.
- **CG Tickers freshness decay at discovery time** (Agent 3 P2) — current 12-min budget means orderbook rows are typically <20min old at merge; synthetic 3× multiplier decay would add logic for marginal gain. Revisit if orderbook volume data widens coverage.
- **Hot-path JSON decoding perf** (Agent 5 "price_sources_json" + "protocol_tvl_json") — negligible at 190 stablecoins; revisit if tracked count exceeds 250.

---

## Global setup (run ONCE, before Wave 1)

- [ ] **Step 1: Verify baseline is green.**

```bash
cd worker && npx vitest --run && cd ..
cd worker && npx tsc --noEmit && cd ..
npm run lint
npm run test:merge-gate
```

Expected: all pass. If any fails, stop and report.

- [ ] **Step 2: Record HEAD and working-tree state.**

```bash
git rev-parse HEAD
git status --short
```

If there are modified files under `worker/src/cron/dex-liquidity/` or `worker/src/cron/dex-discovery/`, stash or commit them first.

- [ ] **Step 3: Confirm prior plan is archived.**

```bash
test -f agents/plans/historical/2026-04-16-liquidity-remediation-plan.md && echo "OK" || echo "MISSING"
```

Expected: `OK`. This plan references it as the baseline.

---

## Wave 1 — Correctness fixes (TDD, sequential within wave)

Two tasks. Order matters: F1 (calibration) lands before F2 (Slipstream math) to isolate methodology-bump commit from adapter changes.

### Task W1.1 — F1: Calibrate absolute TVL Depth fallback

**Files:**
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts:94-110` (`computeLiquidityScore`)
- Modify: `worker/src/cron/dex-liquidity/__tests__/pool-helpers.test.ts` (add F16 test)
- Modify: `shared/lib/liquidity-score-version.ts` (add v5.5 window)
- Modify: `docs/liquidity-score-timeline.md` (add v5.5 entry)
- Modify: `docs/dex-liquidity.md` (update absolute-fallback formula note in the TVL Depth row of the scoring table)

- [ ] **Step 1: Add failing test (TDD).**

In `__tests__/pool-helpers.test.ts`, append to the existing `describe("computeLiquidityScore", ...)` block. Match the file's existing idiom — inspect one test to see the exact shape of `LiquidityMetrics` that `computeLiquidityScore` takes (the existing tests build a `metrics` object with `totalTvlUsd`, `effectiveTvl`, `totalVolume24hUsd`, `qualityAdjustedTvl`, `poolCount`, etc.).

Illustrative test (adjust field names to match the actual `LiquidityMetrics` shape in `types.ts`):

```ts
it("fallback TVL Depth at $5M tracks the ratio formula at 0.5% of $1B", () => {
  const metricsBase = {
    totalTvlUsd: 5_000_000,
    effectiveTvl: 5_000_000,
    qualityAdjustedTvl: 5_000_000,
    totalVolume24hUsd: 0,
    poolCount: 1,
    // ...other LiquidityMetrics fields with neutral defaults, match existing tests
  } as unknown as LiquidityMetrics;

  const ratioBranch = computeLiquidityScore(metricsBase, 50 /* neutral durability */, 1_000_000_000);
  const fallbackBranch = computeLiquidityScore(metricsBase, 50, undefined);

  // Both paths score the same TVL Depth at 0.5% of the $1B reference mcap.
  expect(Math.abs(ratioBranch.components.tvlDepth - fallbackBranch.components.tvlDepth)).toBeLessThan(2);
});
```

Run: `cd worker && npx vitest --run pool-helpers` — expected: FAIL (current delta ≈ 24, assertion < 2).

- [ ] **Step 2: Update fallback formula.**

In `computeLiquidityScore`, replace the else branch:

```ts
} else {
  // Absolute fallback: use $1B reference mcap to reuse the ratio formula's
  // anchor (0.07% depth = score 0). Equivalent to running the ratio branch
  // with depthRatio = tvl / 1_000_000_000. Yields: $700K → 0, $5M → 30,
  // $140M → 80, ~$500M → clamps at 100.
  tvlDepth = Math.min(100, Math.max(0, 35 * Math.log10(Math.max(tvlInput, 1) / 700_000)));
}
```

Verify: test from Step 1 now passes.

- [ ] **Step 3: Update `liquidity-score-version.ts`.**

Add a new version window entry `v5.5` with current date and commit hash placeholder. Keep existing `v5.4` and earlier entries.

- [ ] **Step 4: Update `docs/liquidity-score-timeline.md`.**

Add at the top:

```md
## v5.5 - Absolute TVL Depth fallback recalibration (2026-04-16)

**Commit:** `unreleased`

- Absolute TVL Depth fallback (used when `circulatingUsd` is unavailable) now scales ~24 points lower, matching the ratio formula at the 0.5% reference point
- Eliminates unearned TVL Depth advantage for coins without live market-cap data
- Ratio-formula branch unchanged; methodology v5.4 rows remain valid under their original calibration
```

- [ ] **Step 5: Update `docs/dex-liquidity.md` TVL Depth row.**

Change the absolute-fallback note to reference the new formula (`35 * log10(tvl / 700_000)`, equivalent to the ratio formula with a $1B reference mcap).

- [ ] **Step 6: Run full verification.**

```bash
cd worker && npx vitest --run && cd ..
cd worker && npx tsc --noEmit && cd ..
npm run lint
```

Expected: all pass.

### Task W1.2 — F2: Fix Slipstream CL price derivation

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-slipstream.ts:165-205` (price derivation + sqrt_ratio helper)
- Modify: `worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts` (add F17 fixture tests)
- Modify: `docs/dex-liquidity.md` (update Slipstream row in Direct API Data Sources table to cite `sqrt_ratio` derivation)

**Preconditions:** W1.1 landed and committed.

- [ ] **Step 1: Spike — verify `sqrt_ratio` math against one live fixture.**

Before writing the helper, obtain one known-good Sugar `all()` page from Base and pick one stable/stable pool with known spot price. Run a small Node script that calls `fetchEvmCallHexAtBlock` (existing helper) and decodes the struct. Compare `reserve1/reserve0` vs `sqrtRatioToSpotPrice(sqrt_ratio, dec0, dec1)`. If they match within 0.5% for a balanced stable/stable pool, proceed. If not, confirm endianness / Q96 convention before coding.

Capture the fixture at `agents/audits/fixtures/2026-04-16-slipstream-sugar.json`.

- [ ] **Step 2: Add failing helper tests (TDD).**

In `fetch-slipstream.test.ts`, add a new `describe("sqrtRatioToSpotPrice", ...)` block with three tests for a new exported `sqrtRatioToSpotPrice(sqrtRatio: bigint, token0Decimals: number, token1Decimals: number): number` helper. Concrete input values (verified from Uniswap V3 math):

```ts
describe("sqrtRatioToSpotPrice", () => {
  it("returns 1.0 for a balanced stable/stable sqrt price (Q96 == 2^96)", () => {
    // sqrt(1) * 2^96 = 2^96
    const sqrtRatio = 1n << 96n;
    const price = sqrtRatioToSpotPrice(sqrtRatio, 6, 6);
    expect(price).toBeCloseTo(1, 3);
  });

  it("returns ~3500 for a 1 ETH = 3500 USDC pool (18-dec / 6-dec token ordering, price in token1 per token0)", () => {
    // If token0 = USDC (6 dec) and token1 = WETH (18 dec) and 1 WETH = 3500 USDC:
    //   price_token1_in_token0_raw = 1 / 3500
    //   sqrt = sqrt(1/3500) = 0.01690
    //   sqrtRatio = 0.01690 * 2^96 ≈ 1.339e24
    // After decimal adjust (10^(token0Decimals - token1Decimals) = 10^(6-18) = 10^-12):
    //   price = (1/3500) * 10^-12 — nope, we want USDC per WETH, so pass decimals accordingly.
    //
    // Simpler: pick the ordering where decimals cancel cleanly. Use the captured
    // fixture from Step 1's spike; its sqrtRatio + decimals give the expected ETH price.
    // Assertion tolerates Q96 quantization: expect within 1%.
    const sqrtRatio = FIXTURE_USDC_WETH_SQRT_RATIO; // from 2026-04-16-slipstream-sugar.json
    const price = sqrtRatioToSpotPrice(sqrtRatio, FIXTURE_TOKEN0_DECIMALS, FIXTURE_TOKEN1_DECIMALS);
    expect(price).toBeGreaterThan(FIXTURE_EXPECTED_PRICE * 0.99);
    expect(price).toBeLessThan(FIXTURE_EXPECTED_PRICE * 1.01);
  });

  it("handles large sqrt ratios without overflow (sqrt near upper Q96 bound)", () => {
    // Uniswap V3 sqrtPriceX96 is bounded: ~2^160 max.
    const sqrtRatio = 1n << 140n;
    const price = sqrtRatioToSpotPrice(sqrtRatio, 18, 18);
    expect(Number.isFinite(price)).toBe(true);
    expect(price).toBeGreaterThan(0);
  });
});
```

The second test uses fixture constants captured in Step 1's spike. If the spike cannot obtain a live WETH/USDC Slipstream fixture, replace with a second balanced stable/stable test at decimals `(18, 6)` or `(6, 18)` to prove decimal adjustment works.

Run: `cd worker && npx vitest --run fetch-slipstream` — expected: FAIL (helper does not exist).

- [ ] **Step 3: Implement helper using BigInt math.**

In `fetch-slipstream.ts`, export `sqrtRatioToSpotPrice`. Compute `(sqrtRatio² / 2¹⁹²)` in BigInt space, then cast down safely:

```ts
/**
 * Convert a Uniswap V3–style sqrtPriceX96 (Q64.96) to the spot price of
 * token1 in units of token0, decimal-adjusted for display.
 *
 * sqrtRatio = actual_sqrt_price * 2^96
 * spot_price_raw = (sqrtRatio / 2^96)^2
 * spot_price = spot_price_raw * 10^(token0Decimals - token1Decimals)
 */
export function sqrtRatioToSpotPrice(
  sqrtRatio: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  if (sqrtRatio <= 0n) return 0;
  const squared = sqrtRatio * sqrtRatio;     // up to ~2^320; BigInt is fine
  const Q192 = 1n << 192n;
  const whole = squared / Q192;              // bigint integer part of raw price
  const remainder = squared % Q192;
  // Keep 32 fractional bits — plenty for peg-scale price precision.
  const frac = (remainder << 32n) / Q192;    // bigint 32-bit fraction
  const priceRaw = Number(whole) + Number(frac) / Math.pow(2, 32);
  return priceRaw * Math.pow(10, token0Decimals - token1Decimals);
}
```

Note: `Number(whole)` loses precision only if raw price exceeds `2^53` (≈ 9×10¹⁵). Stablecoin-priced pairs never approach that.

Verify: helper tests from Step 2 pass.

- [ ] **Step 4: Extend the `SugarPool` type to surface `sqrt_ratio`.**

The ABI at lines 11-14 already declares `uint160 sqrt_ratio`, but the local `SugarPool` type at lines 18-26 omits the field. The decoded result on line 83 is cast via `as readonly SugarPool[]`, silently dropping the field.

Add the field to the type:

```ts
type SugarPool = {
  lp: string;
  type: number;
  token0: string;
  reserve0: bigint;
  token1: string;
  reserve1: bigint;
  sqrt_ratio: bigint;   // NEW
  pool_fee: bigint;
};
```

No cast change needed — `viem`'s `decodeFunctionResult` returns the full struct including `sqrt_ratio`; adding the field to the type simply stops losing it at the type boundary.

- [ ] **Step 5: Wire `sqrtRatioToSpotPrice` into `fetchSlipstreamPools`.**

Replace the `price` field in the `pools.push({...})` call (currently line 199: `price: reserve0 > 0 ? reserve1 / reserve0 : null`) with:

```ts
const spotPrice =
  pool.sqrt_ratio > 0n
    ? sqrtRatioToSpotPrice(pool.sqrt_ratio, token0.decimals, token1.decimals)
    : null;
const finalSpotPrice =
  spotPrice != null && Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice : null;
// ...inside pools.push({...})...
price: finalSpotPrice,
```

And replace the missing-side price derivation (currently lines 167-172). Before:

```ts
if ((token0PriceUsd == null || token0PriceUsd <= 0) && token1PriceUsd != null && token1PriceUsd > 0) {
  token0PriceUsd = reserve1 > 0 ? (reserve1 * token1PriceUsd) / reserve0 : null;
}
if ((token1PriceUsd == null || token1PriceUsd <= 0) && token0PriceUsd != null && token0PriceUsd > 0) {
  token1PriceUsd = reserve0 > 0 ? (reserve0 * token0PriceUsd) / reserve1 : null;
}
```

After:

```ts
// spot price of token1 priced in token0 (decimal-adjusted)
if ((token0PriceUsd == null || token0PriceUsd <= 0) && token1PriceUsd != null && token1PriceUsd > 0) {
  // 1 token0 = spotPrice token1 → USD(token0) = spotPrice * USD(token1)
  token0PriceUsd = finalSpotPrice != null ? finalSpotPrice * token1PriceUsd : null;
}
if ((token1PriceUsd == null || token1PriceUsd <= 0) && token0PriceUsd != null && token0PriceUsd > 0) {
  // 1 token1 = 1/spotPrice token0 → USD(token1) = USD(token0) / spotPrice
  token1PriceUsd =
    finalSpotPrice != null && finalSpotPrice > 0 ? token0PriceUsd / finalSpotPrice : null;
}
```

- [ ] **Step 6: Drop pool when sqrt_ratio is unusable and a side has no tracked price.**

After both derivations above, if either `token0PriceUsd` or `token1PriceUsd` is still null, skip the pool entirely (`continue;` inside the for-loop) instead of pushing with `tvlUsd = 0`. This is the pragmatic fallback: no biased reserve-ratio derivations reach downstream consumers.

If both tracked prices exist independently (so no sqrt_ratio derivation is needed), the pool is still included for TVL, and `price: finalSpotPrice` may still be null — that is fine; the scoring path tolerates absent per-pool price when the pair has enough other signal.

- [ ] **Step 7: Update docs.**

In `docs/dex-liquidity.md`, update the Slipstream row under "Direct API Data Sources": change "price (reserve ratio)" to "price (sqrt_ratio derivation, Q64.96 fixed-point)". Add a sentence under the table: "Slipstream uses Sugar's `sqrt_ratio` field for spot-price derivation; reserve ratios are not spot prices for concentrated-liquidity pools."

Add a timeline entry to `docs/liquidity-score-timeline.md` v5.5 bullet list:

```md
- Aerodrome/Velodrome Slipstream price observations now derive from on-chain `sqrt_ratio` instead of total-reserve ratios; CL pools no longer emit biased spot prices when one side lacks a tracked USD price
```

- [ ] **Step 8: Run full verification.**

```bash
cd worker && npx vitest --run && cd ..
cd worker && npx tsc --noEmit && cd ..
npm run lint
```

Expected: all pass.

### Wave 1 commit

- [ ] **Single commit at end of Wave 1:**

```bash
git add worker/src/cron/dex-liquidity/pool-helpers.ts \
        worker/src/cron/dex-liquidity/fetch-slipstream.ts \
        worker/src/cron/dex-liquidity/__tests__/pool-helpers.test.ts \
        worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts \
        shared/lib/liquidity-score-version.ts \
        docs/liquidity-score-timeline.md \
        docs/dex-liquidity.md \
        agents/audits/fixtures/2026-04-16-slipstream-sugar.json

git commit -m "fix(liquidity): calibrate TVL Depth fallback, use sqrt_ratio for Slipstream price

- Absolute TVL Depth fallback: 20*log10(tvl/100k)+20 -> 35*log10(tvl/700k)
  Parity with ratio formula at 0.5% reference ($1B implied mcap);
  coins without market cap no longer gain ~24-point advantage.
- Slipstream price derivation: Q64.96 sqrt_ratio helper replaces
  reserve1/reserve0. CL pools now emit accurate spot prices;
  missing-side price no longer derived from total-reserve ratios.
- Methodology bumps v5.4 -> v5.5 (calibration change).
- Timeline + dex-liquidity doc updated.
"
```

---

## Wave 2 — Schema & API hygiene (parallel, disjoint files)

Three small, independent tasks. Dispatch in parallel.

### Task W2.1 — F9: Remove redundant `lockedLiquidityPct` `.optional()`

**Files:**
- Modify: `shared/types/market.ts` (line in `DexLiquidityDataSchema`)
- Modify: schema tests if any (`shared/types/__tests__/` if present)

- [ ] **Step 1: Grep to confirm the field is always present on writes.**

```bash
rg -n "lockedLiquidityPct" src/ shared/ worker/src/ functions/
```

Expected to find, among others, these write sites — all of which either pass a `number | null` explicitly or use `?? null`:
- `worker/src/api/dex-liquidity.ts:132`: `lockedLiquidityPct: row.locked_liquidity_pct ?? null`
- `worker/src/api/dex-liquidity-response.ts:98` (field appears in the allowed-key list of `normalizeTopPools`)
- `worker/src/cron/dex-liquidity/pool-contribution.ts:51` uses `"lockedLiquidityPct" in pool` — TypeScript union-narrowing inside `SecondaryPool`, unrelated to the Zod schema.

If the grep reveals any caller that writes `undefined` or omits the field from a response row, stop and report. If not, proceed.

- [ ] **Step 2: Change the schema.**

In `shared/types/market.ts`, edit `DexLiquidityDataSchema`:

```ts
// before
lockedLiquidityPct: z.number().nullable().optional(),
// after
lockedLiquidityPct: z.number().nullable(),
```

- [ ] **Step 3: Type-check.**

```bash
cd worker && npx tsc --noEmit && cd ..
```

Expected: clean. Removing `.optional()` tightens the contract on parse; writes already provide `null` or a number.

- [ ] **Step 4: Run UI + schema tests that touch this field.**

```bash
npx vitest --run -- liquidity
```

Expected: all pass.

### Task W2.2 — F10: `DexPriceChallengerSqlStatement` cleanup

**Files:**
- Modify: `worker/src/cron/dex-liquidity/challenger-persistence.ts:79-82`

- [ ] **Step 1: Confirm the interface is not consumed outside `challenger-persistence.ts`.**

```bash
rg -n "DexPriceChallengerSqlStatement" worker/ src/ shared/
```

Expected: all hits are inside `worker/src/cron/dex-liquidity/challenger-persistence.ts` (declared at line 79, referenced at lines 43–45, 132, 199, 223).

- [ ] **Step 2: Drop the `export` keyword (do not delete the interface).**

The interface is used in six places within the file. Deleting it would require repeating the type inline. Simply remove `export`:

```ts
// before
export interface DexPriceChallengerSqlStatement {
  sql: string;
  binds: unknown[];
}
// after
interface DexPriceChallengerSqlStatement {
  sql: string;
  binds: unknown[];
}
```

- [ ] **Step 3: Type-check.**

```bash
cd worker && npx tsc --noEmit
```

### Task W2.3 — F14: Remove stale `M3`/`H2`/`H1` comment tags

**Files:** sweep `worker/src/cron/dex-liquidity/`.

- [ ] **Step 1:**

```bash
rg -n "(// |\* |-- )\b(M[0-9]+|H[0-9]+|MED-[0-9]+|HIGH-[0-9]+|LOW-[0-9]+)\b" worker/src/cron/dex-liquidity/
```

- [ ] **Step 2:** For each hit, delete or rewrite the comment to describe WHY the code exists (not which prior audit tagged it). Zero behavior change. Use the Edit tool per occurrence rather than sed.

- [ ] **Step 3:** Type-check and test:

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
npm run lint
```

### Wave 2 commit

- [ ] Single commit at end of wave:

```bash
git commit -m "chore(liquidity): schema + code hygiene

- Remove redundant .optional() on lockedLiquidityPct (field is always present, may be null)
- Internalize DexPriceChallengerSqlStatement (unused export)
- Clean stale audit-tag comments (M3/H2/H1)
"
```

---

## Wave 3 — Observability (parallel, disjoint files)

Three small tasks. Dispatch in parallel.

### Task W3.1 — F11: DexScreener malformed-pair logging

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` (DexScreener fallback loop)
- Modify: `worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts`

- [ ] **Step 1: Locate the DexScreener parse loop.**

Search `fetch-fallbacks.ts` for `!pair?.baseToken?.address || !pair?.quoteToken?.address || !pair?.pairAddress` (the full guard that currently `continue`s on malformed rows, documented around line 131). Before the `continue`, increment a local `malformedCount` counter initialized to 0 at the start of the per-coin loop.

Do NOT count downstream quality-gate skips (low TVL, blocked DEX id, etc.) — `malformedCount` is strictly for **structural** pair malformedness (missing required fields), not business-logic rejections.

- [ ] **Step 2: Emit a summary log per coin after the loop.**

```ts
if (malformedCount > 0) {
  console.warn(`[fetch-fallbacks] DexScreener: ${malformedCount} malformed pairs for ${stablecoinId}`);
}
```

- [ ] **Step 3: Add a test.**

Feed a fixture with three pairs: one valid, one missing `baseToken.address`, one missing `pairAddress`. Assert (a) only the valid pair reaches the pool list, (b) a single `console.warn` is emitted containing the string `"2 malformed pairs"` (via `vi.spyOn(console, "warn")`).

### Task W3.2 — F12: `poolId` format validation at discovery intake

**Files:**
- Modify: `worker/src/cron/dex-discovery/persistence.ts` (or the upsert site)
- Modify: `worker/src/cron/dex-discovery/__tests__/`

- [ ] **Step 1: Inspect existing staged poolId shapes before writing the regex.**

Run:

```bash
cd worker && npx wrangler d1 execute pharos-dashboard --command "SELECT DISTINCT pool_id FROM dex_pool_staging LIMIT 40" --remote
```

Observe the real shapes (`chain:0xhex`, `orderbook:exchange:coin`, `solana:base58`). Solana addresses use mixed case; the canonical `poolId` in Pharos is lowercased for EVM but base58 is case-sensitive — verify that the staged write path lowercases EVM hex but preserves base58 case.

- [ ] **Step 2: Add a permissive regex.**

At the top of `worker/src/cron/dex-discovery/persistence.ts` (or equivalent staging writer):

```ts
// Two canonical forms observed in dex_pool_staging:
//   "chain:address"               (EVM hex lowercased, Solana base58 mixed-case)
//   "orderbook:exchangeId:coin"   (synthetic orderbook rows)
const POOL_ID_REGEX = /^[a-z0-9-]+:[A-Za-z0-9][A-Za-z0-9:_.\-]*$/;
function isValidStagedPoolId(poolId: string): boolean {
  return POOL_ID_REGEX.test(poolId);
}
```

The left side (chain slug) is lowercase-only. The right side allows mixed case for Solana-style base58 addresses and the extra `:coin` segment of the orderbook form. `0x40`-hex EVM, 32-44 char base58, and `orderbook:kinesis:usdc-circle` all match.

- [ ] **Step 3: Enforce at the upsert site.**

In the upsert path, skip rows where `isValidStagedPoolId(stagedPool.poolId) === false` with a `console.warn` emitting the rejected value and a per-run counter in cron metadata. Do NOT throw — one malformed row must not fail the coin crawl.

- [ ] **Step 4: Add a test.**

Include three cases: valid EVM `ethereum:0xabc...`, valid orderbook `orderbook:kinesis:usdc-circle`, invalid `eth0x1234` (no colon). Assert the invalid row is rejected and a warning is logged.

### Task W3.3 — F13: Slipstream `pool_fee` unit assertion

**Preconditions:** Wave 1 (W1.2) landed.

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-slipstream.ts` (line 179 area)
- Modify: `worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts`

- [ ] **Step 1: Extract the helper.**

Observed Aerodrome/Velodrome Slipstream fee tiers on production pools: 1, 5, 30, 100 bps (covers 0.01% to 1.00%). The Sugar contract reports `pool_fee` as a raw bps integer (verified against live pool in W1.2 Step 1 spike; document the observed value inline in a comment).

In `fetch-slipstream.ts`, above `fetchSlipstreamPools`:

```ts
/**
 * Sugar's pool_fee is a raw basis-point integer (verified against live
 * Aerodrome/Velodrome pools: 1 / 5 / 30 / 100 bps).
 * Anything outside [1, 10000] bps indicates either a pool misconfiguration or
 * a Sugar ABI change; log and drop to generic fallback bucket.
 */
function getSlipstreamPoolFeeBps(poolFee: bigint): number | null {
  const asNumber = Number(poolFee);
  if (!Number.isFinite(asNumber) || asNumber < 1 || asNumber > 10_000) {
    return null;
  }
  return asNumber;
}
```

Replace the existing `const feeBps = Number(pool.pool_fee);` at line 179 with:

```ts
const feeBps = getSlipstreamPoolFeeBps(pool.pool_fee);
const effectiveFeeBps = feeBps ?? 30; // conservative fallback: 30bp generic tier
if (feeBps == null) {
  console.warn(`[fetch-slipstream] ${protocol} pool ${pool.lp}: unexpected pool_fee ${pool.pool_fee}`);
}
// continue using effectiveFeeBps for classifyClPoolType + normalizeFeeRateFromBps
```

- [ ] **Step 2: Add tests.**

Three unit tests for the helper:
- `getSlipstreamPoolFeeBps(0n)` → `null`
- `getSlipstreamPoolFeeBps(20_000n)` → `null`
- `getSlipstreamPoolFeeBps(1n)` → `1`
- `getSlipstreamPoolFeeBps(30n)` → `30`

### Wave 3 commit

- [ ] Single commit at end of wave:

```bash
git commit -m "feat(liquidity): observability hardening

- DexScreener malformed-pair summary log per coin
- poolId format validation at discovery intake
- Slipstream pool_fee bps range assertion
"
```

---

## Wave 4 — Structural refactors

Five refactor tasks. **Parallel subset:** W4.2 (challenger-persistence split) and W4.5 (coverage constants) are file-disjoint from everything else and may dispatch in parallel.

**Sequential subset:** W4.1 (orchestrator-metadata split), W4.3 (orchestrator-phases split), and W4.4 (DexLiquidityPoolState composition) ALL modify `orchestrator.ts` (imports and/or the state interface). Run these **strictly sequentially** in this order: W4.1 → W4.3 → W4.4. Each commits before the next dispatches.

Each task is boundary-preserving: no exported symbols change signature, no behavior changes, tests remain green.

### Task W4.1 — F3: Split `orchestrator-metadata.ts`

**Files:**
- Split: `worker/src/cron/dex-liquidity/orchestrator-metadata.ts` (795 lines) into:
  - `orchestrator-analysis.ts` (`analyzeDexLiquidityPostScoring` + its helpers)
  - `orchestrator-drift.ts` (drift detection + severity helpers)
  - `orchestrator-metadata.ts` (metadata shaping + `isDexLiquidityDegraded` only)
- Update imports in `orchestrator.ts`.

- [ ] **Step 1:** Catalog exports used externally by `orchestrator.ts`. Confirm: `analyzeDexLiquidityPostScoring`, `buildDexLiquidityCronMetadata`, `isDexLiquidityDegraded`. These must remain importable from the old path (re-export barrel).

- [ ] **Step 2:** Create the three new files, moving functions along with their imports and type definitions.

- [ ] **Step 3:** Keep `orchestrator-metadata.ts` as a barrel if any old path imports persist, or update all imports. Prefer direct imports after the split.

- [ ] **Step 4: Split the tests alongside the modules.**

The existing `worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts` (278 lines) houses tests for all three concerns. Split into:
- `__tests__/orchestrator-analysis.test.ts` — `analyzeDexLiquidityPostScoring` cases
- `__tests__/orchestrator-drift.test.ts` — drift-severity cases
- `__tests__/orchestrator-metadata.test.ts` — `buildDexLiquidityCronMetadata`, `isDexLiquidityDegraded` cases (file keeps its name, reduced)

If a test exercises multiple concerns, place it with the dominant subject. Do NOT create a barrel test file — Vitest auto-discovers `*.test.ts` in `__tests__/`.

- [ ] **Step 5: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

### Task W4.2 — F4: Split `challenger-persistence.ts`

**Files:**
- Split: `worker/src/cron/dex-liquidity/challenger-persistence.ts` (687 lines) into:
  - `challenger-publish.ts` (`publishDexPriceChallengerSnapshots`, `publishDexPoolChallengers`, SQL helpers)
  - `challenger-load.ts` (`loadDexPoolChallengers`, `selectDexPriceChallengerRowsFromPools`)
  - `challenger-legacy.ts` (`loadLegacyDexPoolChallengers` + related)
- Update imports in `orchestrator.ts` and any other consumer (grep first).

- [ ] **Step 1:** Enumerate external consumers:

```bash
rg -n "from .*/challenger-persistence" worker/ src/
```

- [ ] **Step 2:** Split functions; preserve exports under a barrel at `challenger-persistence.ts` if backwards compatibility matters, or update imports. Prefer direct imports.

- [ ] **Step 3:** Move tests alongside their subjects. Create `__tests__/challenger-publish.test.ts`, `__tests__/challenger-load.test.ts`, `__tests__/challenger-legacy.test.ts` as needed. No barrel.

- [ ] **Step 4:** Verify:

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

### Task W4.3 — F5: Split `orchestrator-phases.ts`

**Files:**
- Split: `worker/src/cron/dex-liquidity/orchestrator-phases.ts` (644 lines) into:
  - `orchestrator-phases/subgraph-enrichment.ts` (`fetchSubgraphEnrichmentPhase`, univ3/aerodrome helpers)
  - `orchestrator-phases/direct-api.ts` (`buildDexDirectApiFetchers`, `runDirectApiFetchPhase`, `integrateDirectApiLiquidityPhase`)
  - `orchestrator-phases/fallback.ts` (`runFallbackCrawlerPhase`)
  - `orchestrator-phases/lookups.ts` (`loadTrackedStablecoinPriceMap`, `loadTrackedStablecoinMcapMap`)
  - `orchestrator-phases/authoritative.ts` (`buildAuthoritativeStagedPoolConfirmationIndex`)
  - `orchestrator-phases/price-obs.ts` (`mergeDexPriceObservationMap`)
  - `orchestrator-phases/index.ts` as barrel for orchestrator consumption

- [ ] **Step 1:** Create the directory `worker/src/cron/dex-liquidity/orchestrator-phases/`; move functions; update imports.

- [ ] **Step 2:** Keep `orchestrator-phases.ts` (the existing file) as a barrel that re-exports from the directory, ONLY if removing the old path would require >3 import edits elsewhere. Otherwise delete it and update callers to import from `./orchestrator-phases/<subfile>` directly.

- [ ] **Step 3:** Move matching tests into the directory (e.g., `orchestrator-phases/__tests__/subgraph-enrichment.test.ts`) OR keep flat under the existing `__tests__/` with renamed files. Match whatever the rest of the module already uses — do not introduce a new convention in this plan.

- [ ] **Step 4:** Verify:

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

### Task W4.4 — F6: Replace `extends DexLiquidityFallbackPhase` with composition

**Files:**
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts:183-193` (interface) + call sites.

- [ ] **Step 1:** Change:

```ts
interface DexLiquidityPoolState extends DexLiquidityFallbackPhase {
  metrics: Map<string, LiquidityMetrics>;
  knownPoolIndex: ReturnType<typeof buildKnownPoolAddresses>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  ...
}
```

to:

```ts
interface DexLiquidityPoolState {
  fallback: DexLiquidityFallbackPhase;
  metrics: Map<string, LiquidityMetrics>;
  knownPoolIndex: ReturnType<typeof buildKnownPoolAddresses>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  ...
}
```

- [ ] **Step 2:** Update `buildDexLiquidityPoolState` return site to nest fallback fields under `fallback`.

- [ ] **Step 3:** Update consumers (`scoreDexLiquidityPoolState`, `buildDexLiquidityCronMetadata` in `orchestrator-metadata.ts`) to read from `poolState.fallback.weakCoverageCoinsBeforeFallback` etc.

- [ ] **Step 4:** Verify.

### Task W4.5 — F7 + F8: Coverage classifier constants + cast cleanup

**Files:**
- Modify: `worker/src/cron/dex-liquidity/scoring-helpers.ts`

- [ ] **Step 1:** Identify magic numbers (search for `0.75`, `0.5`, `0.15`, `0.65`, `0.25` in coverage-related functions). Extract as named constants:

```ts
const COVERAGE_CONFIDENCE_FOR_HISTORY = 0.75;
const POOL_QUALITY_FLOOR_RATIO = 0.15;
const POOL_QUALITY_CEILING_RATIO = 0.80;
const BALANCE_RATIO_MIN_FOR_PRICE_OBS = 0.3;
// add JSDoc citing docs/dex-liquidity.md section
```

- [ ] **Step 2:** Replace inline literals with the named constants where they appear in coverage and quality classification.

- [ ] **Step 3:** For `applyProtocolCaps`, search for `as Record<string, number | unknown>`. Introduce a typed helper returning a proper shape:

```ts
interface ProtocolCapBreakdown {
  [protocol: string]: {
    cappedAtTvl: number;
    affectedCoins: string[];
  };
}
```

Remove the cast.

- [ ] **Step 4:** Verify.

### Wave 4 commits

Because W4.1, W4.3, and W4.4 are serial and each touches `orchestrator.ts`, commit each one on its own so a revert is surgical:

- [ ] After W4.1:

```bash
git commit -m "refactor(liquidity): split orchestrator-metadata into analysis/drift/metadata"
```

- [ ] After W4.3:

```bash
git commit -m "refactor(liquidity): split orchestrator-phases into per-phase modules"
```

- [ ] After W4.4:

```bash
git commit -m "refactor(liquidity): replace DexLiquidityPoolState extends with composition"
```

- [ ] One combined commit for W4.2 + W4.5 (dispatched in parallel):

```bash
git commit -m "refactor(liquidity): split challenger-persistence, extract coverage constants

- challenger-persistence.ts (687 lines) -> publish / load / legacy
- Coverage classifier magic numbers -> named constants
- applyProtocolCaps: typed breakdown replaces as-cast
"
```

---

## Wave 5 — Documentation polish

### Task W5.1 — Inline calibration note for TVL Depth fallback

**Files:**
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts:94-110`

- [ ] Add inline JSDoc comment on `computeLiquidityScore` citing the v5.5 calibration rationale and the reference point (0.5% depth at $1B market cap → ~30 score). Keep it short — one paragraph.

### Task W5.2 — Final doc parity sweep

- [ ] Read current `docs/dex-liquidity.md` top-to-bottom. Confirm:
  - TVL Depth row cites new fallback formula
  - Slipstream row cites `sqrt_ratio` derivation
  - Methodology-version references say v5.5

- [ ] Read `docs/liquidity-score-timeline.md`. Confirm v5.5 entry has both Wave 1 items.

- [ ] Check README / landing methodology version strings. Update if any drift.

### Wave 5 commit

- [ ] Single commit:

```bash
git commit -m "docs(liquidity): v5.5 doc parity sweep"
```

---

## Acceptance criteria

All of these must hold before declaring the plan complete:

- [ ] `cd worker && npx vitest --run` — baseline at plan authoring: **300 test files / 3197 tests passing**. Post-plan: ≥300 test files / ≥3204 tests (adding at least F15/F16/F17/F18 cases; concretely: one for curve metapool dedup, one for fallback calibration parity, three for `sqrtRatioToSpotPrice`, one for balance-clamp, one each for F11/F12/F13). Re-measure baseline at the start of execution — if it drifted, adjust the target.
- [ ] `cd worker && npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run test:merge-gate` — clean.
- [ ] `npx vitest --run -- liquidity` at repo root — all frontend liquidity tests pass.
- [ ] `shared/lib/liquidity-score-version.ts` includes v5.5 window.
- [ ] `docs/liquidity-score-timeline.md` includes v5.5 entry.
- [ ] `docs/dex-liquidity.md` reflects F1 (fallback formula) and F2 (Slipstream sqrt_ratio).
- [ ] No file in `worker/src/cron/dex-liquidity/` exceeds 500 lines (Wave 4 post-split guarantee).
- [ ] `rg -n "(// |\* |-- )\b(M[0-9]+|H[0-9]+|MED-[0-9]+|HIGH-[0-9]+|LOW-[0-9]+)\b" worker/src/cron/dex-liquidity/` returns zero hits.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| F2 Slipstream `sqrt_ratio` math introduces precision error | Medium | Bounded by peg-sanity + tests | Spike step in W1.2 Step 1; pragmatic fallback if helper is risky |
| F1 calibration under-scores a previously-high-scoring no-mcap coin | Low | Score drops by up to 24 points for coins in fallback path | These coins were previously over-scored; the drop is a correction. Document the shift in v5.5 changelog |
| Wave 4 refactors cause import cycles | Low-Medium | Build breaks | Barrel files + tsc gate between tasks. Keep the split shallow |
| Methodology v5.5 breaks historical row reconstruction | Low | History chart misalignment | `liquidity-score-version.ts` registry means legacy rows stay under v5.4. Test the history API endpoint before merging |
| `DexPriceChallengerSqlStatement` deletion breaks an external consumer we missed | Very low | Build breaks | `rg` the whole repo before deletion (W2.2 Step 1) |

---

## Parallelization matrix

| Wave | Tasks | Parallel? | Rationale |
|---|---|---|---|
| 1 | W1.1, W1.2 | No (sequential) | W1.1 lands methodology-version bump and docs; W1.2 consumes those and adds Slipstream changes |
| 2 | W2.1, W2.2, W2.3 | Yes | Fully disjoint files |
| 3 | W3.1, W3.2, W3.3 | Yes | Disjoint files; W3.3 requires Wave 1 landed (preconditions explicit) |
| 4 | W4.1 → W4.3 → W4.4 | No (sequential) | All three modify `orchestrator.ts` — serial to avoid merge conflicts |
| 4 | W4.2, W4.5 | Yes | File-disjoint from each other and from W4.1/W4.3/W4.4 |
| 5 | W5.1, W5.2 | Yes | Doc edits in different files |

---

## Execution note

When dispatching subagents in parallel (Waves 2, 3, 4), send a single message with multiple Agent tool calls. Each task prompt must be self-contained: include the file path(s), the exact change, and the verification commands. Do NOT let a subagent read the whole plan file — paste the relevant wave's tasks into its prompt.
