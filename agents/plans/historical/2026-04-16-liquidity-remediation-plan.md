# /liquidity Remediation Plan (2026-04-16, rev. 2)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. Tasks within the same Wave are dispatched in parallel to fresh Opus 4.6 high-reasoning subagents. Waves are sequential: each wave verifies and commits before the next dispatches.

**Goal:** Execute every actionable finding from the four 2026-04-16 liquidity audits: data-accuracy bugs, remaining pool deduplication, frontend/API drift, code-quality structural refactors, and scoring-core tests — while keeping the code clear, qualitative, and maintainable.

**Architecture:**
- Fix bugs surgically, file-by-file, TDD-first. Real-fixture tests use fixtures already captured under `agents/audits/fixtures/`.
- Reuse existing helpers: `buildPoolFingerprint` in `pool-helpers.ts:196` is the canonical token-pair fingerprint. `isTrustworthyExactPoolId` in `pool-identity.ts:41` is the trusted-id predicate (currently unexported — export it in Wave B).
- Preserve existing patterns and style. No speculative abstractions beyond the audit's explicit recommendations.
- Commit in thematic batches, one commit per wave.

**Tech stack:** TypeScript, Cloudflare Workers, D1, Vitest (inline fixtures, no `__tests__/fixtures/` directory convention exists), Next.js 16 (frontend), Wrangler.

**Source artifacts (read before executing):**
- `agents/audits/2026-04-16-liquidity-data-accuracy-audit.md`
- `agents/audits/2026-04-16-liquidity-dedup-audit.md`
- `agents/audits/2026-04-16-liquidity-coverage-and-quality-audit.md`
- `agents/audits/2026-04-16-liquidity-frontend-and-api-audit.md`
- `agents/audits/2026-04-16-liquidity-plan-review-round1.md` — the first-round review that identified fatal errors in the original plan
- `agents/audits/2026-04-16-liquidity-plan-ground-truth.md` — **authoritative reference with real code, real signatures, real API fixtures**
- `agents/audits/fixtures/2026-04-16-meteora-imbalanced-pool.json` — Meteora SOL/USDC reserve-ratio 13.02 vs current_price 84.93
- `agents/audits/fixtures/2026-04-16-fluid-ticker-usdcusdt.json` — Fluid USDC/USDT ticker raw-volume shape
- `agents/audits/fixtures/2026-04-16-balancer-fantom-dei.json` — Balancer Fantom multiUSDC/DEI $337B junk row
- `agents/audits/fixtures/2026-04-16-noble-swaps.md` — Noble Swaps endpoint spike (all failed; G1 deferred)
- `agents/audits/fixtures/2026-04-16-aero-sugar-abi.md` — Sugar ABI spike (deferred)

**User rules (non-negotiable):**
- Simplicity first. Minimum code that fixes the bug. No speculative abstraction.
- Surgical changes. Touch only what the fix requires.
- Real-fixture tests where feasible (inline `const` matching the captured fixture JSON).
- Propagate fetcher failures — never swallow to `[]`.
- Incremental deployment: new fetchers ship one at a time with monitoring. (Honored: new fetchers are deferred to follow-up plans.)
- Verify with `cd worker && npx vitest --run`, `cd worker && npx tsc --noEmit`, `npm run lint` before claiming done.

---

## Deferred out of scope for this plan

These findings are intentionally NOT addressed here. Each is listed with a reason. Follow-up plans will pick them up.

**Deferred — fetcher expansion (incremental deployment rule):**
- **Task G1 — Noble Swaps direct fetcher.** All four candidate endpoints failed (see `agents/audits/fixtures/2026-04-16-noble-swaps.md`). Requires an endpoint-discovery spike before implementation. → Separate plan.
- **All other new fetchers** (Trader Joe, Pharaoh, Sui, Aptos, HyperEVM, Berachain, QuickSwap, Stellar, XRPL, TON, CEX orderbook promotion) — per memory rule, one fetcher per PR with a 24-hour monitoring gate. → Separate plans each.

**Deferred — unverified math/tooling:**
- **Task A6 — Slipstream `sqrt_ratio` + `pool_fee` units.** The Sugar struct ABI is known, but `sqrt_ratio` requires BigInt Q64.96 math and `pool_fee` unit (bps vs 1e6) is unverified against live contracts. Both `cast` and Basescan v2 are unavailable to the execution environment. → Separate spike plan.

**Deferred — structural refactors (audit B section):**
- B.1.1 `DexLiquidityPoolState extends DexLiquidityFallbackPhase` coupling leak.
- B.1.2 `Awaited<ReturnType<typeof ...>>` phase-result aliasing.
- B.1.4 `scoring.ts` rebuild function-chain clarity.
- B.2.2 `fetch-primary.ts` file split.
- B.2.3 `challenger-persistence.ts` file split.
- B.2.4 `orchestrator-phases.ts` file split.
- B.2.5 `score-weights.ts` shim elimination.
- B.3.2 scoring fragmentation.
- B.3.3 magic numbers in coverage classifier.
- B.3.4 stale `M3`/`H2`/`H1` comment tags.
- B.3.5 `as Record<string, number | unknown>` cast in `applyProtocolCaps`.
- B.5 `ScoreResult` vs `FullScoreResult` type split.
- MED-6 base58 case preservation.
- LOW-2 synthetic CG-tickers staged derived key (addressed indirectly by B1.2's exact-key alignment).

**No-fix-needed (audit confirmed clean or intentional):**
- m2 Fluid `parseFloat` precision — non-issue at current scale.
- m3 Orca `parseFloat` precision — non-issue at current scale.
- m5 Curve API per-coin `usdPrice` trust line — intentional trust boundary.
- m6 PancakeSwap subgraph chain set — intentional worker-budget decision.
- m7 Slipstream `volume24hUsd: 0` — documented behavior.
- m8/m9/m10 — audit marked clean.
- Frontend m4/m5/m7/m8 — audit marked clean or cosmetic.
- m1 Balancer chain map "16 vs 14 chains" — the 16-chain `BALANCER_CHAIN_MAP` is correct; docs drift handled in Wave A task A2 doc update.

**Frontend display choices kept as-is (cheap to keep on wire):**
- `avgPoolStress`, `lockedLiquidityPct`, `methodologyVersion`, `coverageConfidence`, `pairCount` — stay on the wire. Future UI decisions are out of scope for this remediation pass.

**Other known gaps to schedule separately:**
- **A7 cleanup side:** `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` (`fetch-primary.ts:465, 503`) have **zero production callers** — only test imports. They are effectively dead code and are handled in Task F3 as deletions, not error-propagation fixes.

---

## Global setup (run ONCE, before Wave A)

- [ ] **Step 1: Verify the baseline is green.**

```bash
cd worker && npx vitest --run && cd ..
cd worker && npx tsc --noEmit && cd ..
npm run lint
```

Expected: all pass. If any fails, stop and report — the plan assumes a green baseline.

- [ ] **Step 2: Record the current HEAD and working-tree state.**

```bash
git rev-parse HEAD
git status --short
```

If there are modified files under `worker/src/cron/dex-liquidity/`, stash or commit them first.

- [ ] **Step 3: Read the ground-truth reference.**

Open `agents/audits/2026-04-16-liquidity-plan-ground-truth.md` and keep it open for quick lookup. All exact code snippets in this plan were derived from it.

---

## Wave A — Critical & major data-accuracy fixes (parallel)

Five tasks; non-overlapping files. Dispatch in parallel. Single commit at the end of the wave.
**Task A2 is the sole editor of `docs/dex-liquidity.md` in this wave** (no conflict with A4).

### Task A1 — Meteora: use `current_price`, never derive from reserves

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-meteora.ts` (lines 118-150 — price assignment)
- Modify: `worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts` (add a new test; keep existing three tests intact)

**Root cause (C1 data-accuracy audit):** `fetch-meteora.ts` computes `derivedPrice = reserve1 / reserve0` at line 120 and at lines 143-145 prefers it over `row.current_price`. Meteora is DLMM (concentrated liquidity) — reserve ratio is NOT spot price. Real fixture (`agents/audits/fixtures/2026-04-16-meteora-imbalanced-pool.json`): SOL/USDC pool `HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR` has `token_x_amount=6885.094`, `token_y_amount=89650.78`, `current_price=84.93` — reserve ratio is `89650.78 / 6885.094 ≈ 13.02`, off by 84%.

- [ ] **Step 1: Add a failing test that matches the existing Meteora test idiom.**

Open `worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts`. The file uses a top-level `mockFetch = vi.fn(); vi.stubGlobal("fetch", mockFetch);`, per-test `mockFetch.mockResolvedValueOnce(jsonResponse({ data: [...] }))` followed by an empty page to terminate pagination, dynamic `await import("../fetch-meteora")`, and calls `await fetchMeteoraPools()` with no arguments.

Append this test inside the existing `describe("fetchMeteoraPools", ...)` block:

```ts
it("uses current_price and ignores imbalanced reserve ratio on DLMM pools", async () => {
  const { fetchMeteoraPools } = await import("../fetch-meteora");
  // Real fixture: SOL/USDC pool with reserve ratio 13.02 vs current_price 84.93
  mockFetch
    .mockResolvedValueOnce(jsonResponse({
      data: [{
        address: "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR",
        token_x: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, price: 85 },
        token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, price: 1 },
        token_x_amount: 6885.094,
        token_y_amount: 89650.78,
        current_price: 84.93,
        tvl: 673863,
        volume: { "24h": 500_000 },
        pool_config: { base_fee_pct: 0.25 },
        dynamic_fee_pct: 0,
        is_blacklisted: false,
      }],
    }))
    .mockResolvedValueOnce(jsonResponse({ data: [] }));

  const result = await fetchMeteoraPools();

  expect(result.ok).toBe(true);
  expect(result.pools).toHaveLength(1);
  expect(result.pools[0].price).toBeCloseTo(84.93, 2);
  // Regression guard: derived reserve ratio would be ~13.02
  expect(result.pools[0].price).not.toBeCloseTo(13.02, 0);
  // balances must still carry raw reserves for downstream consumers
  expect(result.pools[0].balances).toEqual([6885.094, 89650.78]);
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts
```
Expected: the new test **fails** — current code emits ~13.02 as `price`.

- [ ] **Step 2: Apply the fix.**

In `worker/src/cron/dex-liquidity/fetch-meteora.ts`, replace the block at lines 118-150. Current code:

```ts
const reserve0 = row.token_x_amount;
const reserve1 = row.token_y_amount;
const derivedPrice = Number.isFinite(reserve0) && reserve0 > 0 && Number.isFinite(reserve1) && reserve1 > 0
  ? reserve1 / reserve0
  : null;

pools.push({
  source: "meteora",
  // ...
  price: Number.isFinite(derivedPrice) && derivedPrice != null && derivedPrice > 0
    ? derivedPrice
    : (row.current_price != null && Number.isFinite(row.current_price) && row.current_price > 0 ? row.current_price : null),
  // ...
});
```

Replace with:

```ts
const reserve0 = row.token_x_amount;
const reserve1 = row.token_y_amount;
// Meteora DLMM is concentrated liquidity — the bin reserve ratio is NOT the spot price.
// Use current_price exclusively; leave balances[] for downstream balance-ratio consumers.
const spotPrice =
  row.current_price != null && Number.isFinite(row.current_price) && row.current_price > 0
    ? row.current_price
    : null;

pools.push({
  source: "meteora",
  chain: "solana",
  poolAddress: row.address,
  poolType: "meteora-dlmm",
  tokens: [
    { address: row.token_x.address, symbol: row.token_x.symbol, decimals: row.token_x.decimals, priceUsd: row.token_x.price ?? null },
    { address: row.token_y.address, symbol: row.token_y.symbol, decimals: row.token_y.decimals, priceUsd: row.token_y.price ?? null },
  ],
  price: spotPrice,
  tvlUsd,
  volume24hUsd: volume24hUsd != null && Number.isFinite(volume24hUsd) ? volume24hUsd : 0,
  feeRate: feePct > 0 ? feePct / 100 : null,
  balances: Number.isFinite(reserve0) && Number.isFinite(reserve1) ? [reserve0, reserve1] : null,
});
```

Delete the `derivedPrice` local variable — the replacement uses `spotPrice` directly.

- [ ] **Step 3: Re-run the Meteora tests.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts
```

Expected: 4 tests pass (the three existing tests use balanced reserves where `reserve1/reserve0 === current_price === 90`, so `toMatchObject` is unaffected; the new test passes with `spotPrice = 84.93`).

- [ ] **Step 4: Full worker tsc.**

```bash
cd worker && npx tsc --noEmit
```

Expected: clean.

### Task A2 — Classifier: add PancakeSwap 25bp/100bp buckets + matching quality multipliers

**Files:**
- Modify: `worker/src/cron/dex-liquidity/direct-source-helpers.ts:9-18` (`classifyClPoolType`)
- Modify: `worker/src/lib/dex-constants.ts` (add two entries to `QUALITY_MULTIPLIERS`)
- Create: `worker/src/cron/dex-liquidity/__tests__/direct-source-helpers.test.ts`
- Modify: `docs/dex-liquidity.md` (quality multipliers table — add PCS 25bp/100bp rows)

**Scope note:** This task ONLY expands PancakeSwap V3's tier set. It does NOT expand the Slipstream classifier (Slipstream's `pool_fee` unit is unverified — see deferred A6). Slipstream pools continue to use the existing `1bp / 5bp / 30bp` buckets even at higher fees; that's an acceptable degradation until the Sugar-ABI spike lands.

**Root cause (C2 + M7 data-accuracy audit):** PancakeSwap V3 has tiers 1/5/25/100 bp. `classifyClPoolType` currently maps `<=1 → 1bp`, `<=5 → 5bp`, else → `30bp`, so both 25bp and 100bp collapse into the 30bp bucket and inherit the `0.4x` quality multiplier. 25bp pools should score tighter than 100bp memecoin pools.

- [ ] **Step 1: Create the failing classifier test.**

Create `worker/src/cron/dex-liquidity/__tests__/direct-source-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyClPoolType } from "../direct-source-helpers";

describe("classifyClPoolType", () => {
  it("classifies PancakeSwap tiers 1/5/25/100 bp into distinct buckets", () => {
    expect(classifyClPoolType("pancakeswap", 1)).toBe("pancakeswap-v3-1bp");
    expect(classifyClPoolType("pancakeswap", 5)).toBe("pancakeswap-v3-5bp");
    expect(classifyClPoolType("pancakeswap", 25)).toBe("pancakeswap-v3-25bp");
    expect(classifyClPoolType("pancakeswap", 100)).toBe("pancakeswap-v3-100bp");
  });

  it("Slipstream variants keep existing 1/5/30 bp scheme (100bp not yet supported)", () => {
    // Slipstream pool_fee units are unverified; A6 is deferred. Until the Sugar ABI spike
    // confirms units, Slipstream continues to use the legacy three-bucket scheme.
    expect(classifyClPoolType("aerodrome-slipstream", 1)).toBe("aerodrome-slipstream-1bp");
    expect(classifyClPoolType("aerodrome-slipstream", 5)).toBe("aerodrome-slipstream-5bp");
    expect(classifyClPoolType("aerodrome-slipstream", 30)).toBe("aerodrome-slipstream-30bp");
    expect(classifyClPoolType("velodrome-slipstream", 5)).toBe("velodrome-slipstream-5bp");
  });

  it("defaults null/undefined PancakeSwap fees to the widest tier (via the 500 fallback)", () => {
    // classifyClPoolType's internal default is normalizedFeeBps = 500. After the fix,
    // pancakeswap at 500bps flows past the 1/5/25/30 branches into the 100bp bucket.
    // Document this explicitly so an agent-driven change does not accidentally regress it.
    expect(classifyClPoolType("pancakeswap", null)).toBe("pancakeswap-v3-100bp");
    expect(classifyClPoolType("pancakeswap", undefined)).toBe("pancakeswap-v3-100bp");
    // Slipstream still falls through to the legacy 30bp bucket (A6 deferred).
    expect(classifyClPoolType("aerodrome-slipstream", null)).toBe("aerodrome-slipstream-30bp");
  });
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/direct-source-helpers.test.ts
```
Expected: the PancakeSwap 25bp/100bp assertions FAIL (current code returns `*-30bp`).

- [ ] **Step 2: Update `classifyClPoolType`.**

In `worker/src/cron/dex-liquidity/direct-source-helpers.ts`, replace lines 9-18 with:

```ts
export function classifyClPoolType(
  protocol: "pancakeswap" | "aerodrome-slipstream" | "velodrome-slipstream",
  feeBps: number | null | undefined,
): string {
  const normalizedFeeBps = feeBps != null && Number.isFinite(feeBps) ? feeBps : 500;
  const prefix = protocol === "pancakeswap" ? "pancakeswap-v3" : protocol;
  if (normalizedFeeBps <= 1) return `${prefix}-1bp`;
  if (normalizedFeeBps <= 5) return `${prefix}-5bp`;
  // PancakeSwap V3 uses distinct 25bp and 100bp tiers. Slipstream pool_fee units
  // are unverified (A6 deferred), so Slipstream stays on the legacy 30bp bucket.
  if (protocol === "pancakeswap") {
    if (normalizedFeeBps <= 25) return `${prefix}-25bp`;
    if (normalizedFeeBps <= 30) return `${prefix}-30bp`;
    return `${prefix}-100bp`;
  }
  return `${prefix}-30bp`;
}
```

- [ ] **Step 3: Add `QUALITY_MULTIPLIERS` entries.**

In `worker/src/lib/dex-constants.ts`, find the `QUALITY_MULTIPLIERS` map (the full map is pasted in ground-truth §20). Add two new entries next to the existing PancakeSwap keys:

```ts
"pancakeswap-v3-1bp": 1.1,
"pancakeswap-v3-5bp": 0.85,
"pancakeswap-v3-25bp": 0.7,   // NEW: PCS 25bp stable tier — tighter than 30bp, looser than 5bp
"pancakeswap-v3-30bp": 0.4,
"pancakeswap-v3-100bp": 0.25, // NEW: PCS 100bp volatile tier — looser than 30bp
```

Rationale (keep as a one-line comment above the PCS block):
```ts
// PancakeSwap V3 tiers: 1/5/25/30/100 bp. 25bp sits between 5bp stable and 30bp
// generic; 100bp is a wide volatile tier that should score below 30bp.
```

- [ ] **Step 4: Re-run the classifier test.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/direct-source-helpers.test.ts
cd worker && npx tsc --noEmit
```

Expected: all tests pass; typecheck clean.

- [ ] **Step 5: Update `docs/dex-liquidity.md` quality multipliers table.**

In the "Quality Multipliers (v2)" section of `docs/dex-liquidity.md`, add two rows to the PancakeSwap block:

```md
| PancakeSwap V3 25bp        | 0.7x       | protocol contains `pancakeswap` + fee tier <= 25 bp          |
| PancakeSwap V3 100bp       | 0.25x      | protocol contains `pancakeswap` + fee tier > 30 bp           |
```

Update the existing `PancakeSwap V3 30bp+` row to `PancakeSwap V3 30bp` to reflect the new distinct 100bp bucket.

### Task A3 — Fluid: stop writing raw token amounts into `volume24hUsd`

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-fluid.ts:183-189` (per-ticker map block)
- Create: `worker/src/cron/dex-liquidity/__tests__/fetch-fluid.test.ts`

**Root cause (M1 data-accuracy audit):** `fetch-fluid.ts:183-185` sums `baseVol + targetVol` and stamps the result as `volume24hUsd`. `base_volume` and `target_volume` are raw token amounts, not USD — summing them double-counts the one-sided volume for stable pairs and produces nonsense for volatile pairs. The existing `derivePoolVolume24hUsd` downstream path masks the bug in production by reading `tokenVolumes24h` and deriving a proper USD value per side — so the fix is to set `volume24hUsd: 0` and keep `tokenVolumes24h` populated.

**Note on fixtures:** The real Fluid USDC/USDT ticker has `base_volume="0"` and `target_volume="0"` (see `agents/audits/fixtures/2026-04-16-fluid-ticker-usdcusdt.json`). The test below uses non-zero hand-crafted values to prove the bug; the shape matches the real API response.

- [ ] **Step 1: Create the failing test.**

Create `worker/src/cron/dex-liquidity/__tests__/fetch-fluid.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchFluidPools", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it("does not sum raw token volumes into volume24hUsd (downstream derives USD from tokenVolumes24h)", async () => {
    const { fetchFluidPools } = await import("../fetch-fluid");
    // One ticker row matching the real Fluid tickers v3 shape. base_volume and
    // target_volume are string-encoded token amounts in the base/target token units,
    // NOT USD. The raw sum (100 + 200 = 300) was previously stamped as volume24hUsd.
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
      target_currency: "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
      base_volume: "100",
      target_volume: "200",
      liquidity_in_usd: "50000000",
      last_price: "1.0001",
    };
    // fetchFluidPools iterates FLUID_CHAINS; mock one response per chain.
    // Easier: mock the first chain to return this row, others to fail quickly.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/v2/1/dexes/stats/tickers")) {
        return jsonResponse([tickerRow]);
      }
      return new Response("[]", { status: 200 });
    });

    const result = await fetchFluidPools();
    const ethPool = result.pools.find((p) => p.poolAddress.toLowerCase() === "0xabc0000000000000000000000000000000000000");
    expect(ethPool).toBeDefined();
    expect(ethPool!.volume24hUsd).toBe(0);
    expect(ethPool!.tokenVolumes24h).toEqual([100, 200]);
    // The downstream derivePoolVolume24hUsd step owns the USD derivation; the fetcher
    // must not invent USD values from raw token units.
  });
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/fetch-fluid.test.ts
```
Expected: FAIL — current code stamps `volume24hUsd = 300`.

- [ ] **Step 2: Apply the fix.**

In `worker/src/cron/dex-liquidity/fetch-fluid.ts`, replace the per-ticker `.map` return block (currently lines ~175-192 depending on current file state) so the output object no longer sums raw token amounts. Change:

```ts
return {
  source: "fluid",
  chain,
  poolAddress: t.pool_id,
  poolType: "fluid-dex",
  tokens: [
    { address: t.base_currency, symbol: "", decimals: 0 },
    { address: t.target_currency, symbol: "", decimals: 0 },
  ],
  price: Number.isFinite(price) && price > 0 ? price : null,
  tvlUsd,
  volume24hUsd:
    (Number.isFinite(baseVol) ? baseVol : 0) +
    (Number.isFinite(targetVol) ? targetVol : 0),
  feeRate: null,
  balances: null,
  tokenVolumes24h: [Number.isFinite(baseVol) ? baseVol : 0, Number.isFinite(targetVol) ? targetVol : 0],
};
```

to:

```ts
return {
  source: "fluid",
  chain,
  poolAddress: t.pool_id,
  poolType: "fluid-dex",
  tokens: [
    { address: t.base_currency, symbol: "", decimals: 0 },
    { address: t.target_currency, symbol: "", decimals: 0 },
  ],
  price: Number.isFinite(price) && price > 0 ? price : null,
  tvlUsd,
  // base_volume/target_volume are raw token-unit amounts; the downstream
  // derivePoolVolume24hUsd path computes USD volume from tokenVolumes24h. Do not
  // double-count or misinterpret them here as USD.
  volume24hUsd: 0,
  feeRate: null,
  balances: null,
  tokenVolumes24h: [Number.isFinite(baseVol) ? baseVol : 0, Number.isFinite(targetVol) ? targetVol : 0],
};
```

- [ ] **Step 3: Re-run and tsc.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/fetch-fluid.test.ts
cd worker && npx tsc --noEmit
```

Expected: green.

### Task A4 — CoinGecko onchain: stop inferring balance ratio from token prices

**Files:**
- Modify: `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts` (`classifyCgPool` at lines 58-116 — the 6 call sites of `inferCgBalanceRatio`)
- Modify: `worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts` (existing tests at lines ~85-100 assert on `inferCgBalanceRatio` — update or replace)
- Modify: `docs/dex-liquidity.md` — remove the "Balance ratio approximation" bullet from the CG Onchain section's three-signals list

**Root cause (M2 data-accuracy audit):** `inferCgBalanceRatio(baseTokenPriceUsd, quoteTokenPriceUsd)` returns `min(basePrice, quotePrice) / max(basePrice, quotePrice)` and only emits values `> 0.5`. For stable-stable pairs the result is always ~1.0 (effectively marking the pool as "balanced" without any pool-inventory measurement); for volatile pairs the result is rejected. The field is a token-price ratio, not a balance ratio, and it inflates `balance_measured_tvl_usd` for CG rows that have no real inventory data.

**Fix approach:** Delete `inferCgBalanceRatio` and all five call sites inside `classifyCgPool`. Set `balanceRatio: null` on the `CgPoolClassification` result in every branch. The downstream `addSecondaryPoolContribution` at `pool-contribution.ts:31` treats `pool.balanceRatio == null` as "balance unknown", defaults to the neutral `STAGED_POOL_DEFAULTS.balanceRatioFallback`, and leaves `hasMeasuredBalance = false` so `measurement.balanceMeasured` is not set. That's the honest coverage signal.

- [ ] **Step 1: Read the current `classifyCgPool`.**

Read `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`. The function has **five** call sites of `inferCgBalanceRatio` inside `classifyCgPool` (ground-truth §7: lines 72, 82, 92, 101, 114). In addition, `__tests__/fetch-crawlers.test.ts:3` imports the helper and lines ~91-93 test it directly. Plan for five replacements inside `classifyCgPool` + one test-file cleanup.

- [ ] **Step 2: Add a failing test for the desired behavior.**

Create `worker/src/cron/dex-liquidity/__tests__/coingecko-onchain-shared.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyCgPool, parseCgPool } from "../coingecko-onchain-shared";

describe("classifyCgPool balanceRatio", () => {
  it("returns balanceRatio=null for stable-stable pairs (no inferred inventory)", () => {
    // A CG onchain pool row where both tokens are tracked stablecoins.
    const rawAttrs = {
      base_token_price_usd: "1.0001",
      quote_token_price_usd: "0.9998",
      pool_fee_percentage: "0.05",
      locked_liquidity_percentage: null,
    };
    const parsed = parseCgPool({
      id: "x",
      attributes: {
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: "USDC / USDT",
        reserve_in_usd: "1000000",
        volume_usd: { h24: "500000" },
        base_token_price_usd: "1.0001",
        quote_token_price_usd: "0.9998",
        pool_fee_percentage: "0.05",
      },
      relationships: {
        dex: { data: { id: "uniswap-v3" } },
        base_token: { data: { id: "eth_0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
        quote_token: { data: { id: "eth_0xcccccccccccccccccccccccccccccccccccccccc" } },
      },
    } as never);
    expect(parsed).not.toBeNull();
    const classification = classifyCgPool(parsed!, rawAttrs);
    expect(classification.balanceRatio).toBeNull();
  });

  it("returns balanceRatio=null for stable-volatile pairs too", () => {
    const rawAttrs = {
      base_token_price_usd: "1.0001",
      quote_token_price_usd: "3500",
      pool_fee_percentage: "0.3",
      locked_liquidity_percentage: null,
    };
    const parsed = parseCgPool({
      id: "y",
      attributes: {
        address: "0xdddddddddddddddddddddddddddddddddddddddd",
        name: "USDC / WETH",
        reserve_in_usd: "2000000",
        volume_usd: { h24: "1000000" },
        base_token_price_usd: "1.0001",
        quote_token_price_usd: "3500",
        pool_fee_percentage: "0.3",
      },
      relationships: {
        dex: { data: { id: "uniswap-v3" } },
        base_token: { data: { id: "eth_0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } },
        quote_token: { data: { id: "eth_0xffffffffffffffffffffffffffffffffffffffff" } },
      },
    } as never);
    expect(parsed).not.toBeNull();
    const classification = classifyCgPool(parsed!, rawAttrs);
    expect(classification.balanceRatio).toBeNull();
  });
});
```

If `parseCgPool` expects a specific input shape different from the above, match the real shape from the ground-truth doc §7 or from the current file. The assertion is what matters: `classification.balanceRatio` is always `null` after the fix.

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/coingecko-onchain-shared.test.ts
```
Expected: FAIL on the stable-stable case — current code returns ~1.0 for similar-priced pairs.

- [ ] **Step 3: Delete `inferCgBalanceRatio` and set `balanceRatio: null` at all call sites.**

In `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`:

1. Delete the `inferCgBalanceRatio` function (lines 21-33 per ground-truth §7).
2. Inside `classifyCgPool`, every branch that currently builds a `CgPoolClassification` with `balanceRatio: inferCgBalanceRatio(basePrice, quotePrice)` must change to `balanceRatio: null`.

Example of the before/after for one branch (repeat for each of the five call sites):

Before:
```ts
return { poolType: "cg-cl-5bp", qualityMultiplier, balanceRatio: inferCgBalanceRatio(basePrice, quotePrice), feeTierBps: 5, isStable };
```
After:
```ts
return { poolType: "cg-cl-5bp", qualityMultiplier, balanceRatio: null, feeTierBps: 5, isStable };
```

Remove any imports or references to `inferCgBalanceRatio` that become unused.

- [ ] **Step 4: Update the existing test file that asserted on `inferCgBalanceRatio`.**

In `worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts`, the existing tests at lines ~85-100 (ground-truth §7 call site #7) import and assert on `inferCgBalanceRatio`. Those assertions need to be removed or replaced:

- If the tests only cover `inferCgBalanceRatio` itself, delete those test cases.
- If the tests cover downstream behavior (pool classification, `balanceMeasured` flag), update them to assert `balanceRatio: null` and remove the `inferCgBalanceRatio` import.

Grep for the import: `rg -n "inferCgBalanceRatio" worker/src/cron/dex-liquidity/__tests__/`. Remove every match.

- [ ] **Step 5: Verify.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/coingecko-onchain-shared.test.ts
cd worker && npx vitest --run "src/cron/dex-liquidity/__tests__/"
cd worker && npx tsc --noEmit
```

Expected: all green. `inferCgBalanceRatio` is now fully removed from the codebase.

### Task A5 — Balancer: per-pool sanity cap and drop misleading pool.price

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-balancer.ts` (add a constant near the top; add a sanity check in the parse loop; drop the scalar `price` assignment)
- Create: `worker/src/cron/dex-liquidity/__tests__/fetch-balancer.test.ts`

**Root cause (M3 + M4 data-accuracy audit):**
- M3: Balancer V3 still returns legacy Fantom multiUSDC/DEI pools with `totalLiquidity = $337B`. The fetcher only checks `tvlUsd > 0`, so the garbage flows until the global `DIRECT_API_MAX_POOL_TVL_USD = $10B` cap in `dex-api-pool-shaping.ts:24`. Add a conservative per-source cap at `$2B` so obvious junk is rejected at the fetcher.
- M4: The per-pool scalar `price` field is set by walking `poolTokens` and taking the first `balanceUSD / balance` — a per-token USD price that's actually meaningless at pool-scalar granularity. The downstream path reads per-token `priceUsd` from `tokens[i]`, so dropping `pool.price = null` is safe and removes a footgun.

Real fixture: `agents/audits/fixtures/2026-04-16-balancer-fantom-dei.json` (`totalLiquidity = "337677697052.70"`).

- [ ] **Step 1: Write the failing test.**

Create `worker/src/cron/dex-liquidity/__tests__/fetch-balancer.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Minimum shape matching BalancerPool from fetch-balancer.ts isBalancerPool guard.
function balancerRow(overrides: Record<string, unknown>) {
  return {
    id: "0x4e415957aa4fd703ad701e43ee5335d1d7891d8300020000000000000000053b",
    type: "STABLE",
    chain: "FANTOM",
    address: "0x4e415957aa4fd703ad701e43ee5335d1d7891d83",
    dynamicData: { totalLiquidity: "1000000", volume24h: "0", swapFee: "0.0001" },
    poolTokens: [
      { address: "0xaa", symbol: "USDC", decimals: 6, balance: "500000", balanceUSD: "500000", weight: "0.5" },
      { address: "0xbb", symbol: "USDT", decimals: 6, balance: "500000", balanceUSD: "500000", weight: "0.5" },
    ],
    ...overrides,
  };
}

describe("fetchBalancerPools sanity cap and pool.price footgun", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it("rejects pools with totalLiquidity above the per-source sanity cap", async () => {
    const { fetchBalancerPools } = await import("../fetch-balancer");
    // Real captured row: Fantom multiUSDC/DEI with $337B reported liquidity.
    const junk = balancerRow({
      dynamicData: { totalLiquidity: "337677697052.70", volume24h: "0", swapFee: "0.0001" },
      poolTokens: [
        { address: "0xmu", symbol: "multiUSDC", decimals: 6, balance: "0.000001", balanceUSD: "0.00000005684014991798558", weight: "0.5" },
        { address: "0xde", symbol: "DEI", decimals: 18, balance: "1000002064258.7402", balanceUSD: "337677697052.6986", weight: "0.5" },
      ],
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { poolGetPools: [junk, balancerRow({})] } }));

    const result = await fetchBalancerPools();
    expect(result.pools.find((p) => p.tvlUsd > 2_000_000_000)).toBeUndefined();
    expect(result.pools.some((p) => p.poolAddress.toLowerCase() === "0x4e415957aa4fd703ad701e43ee5335d1d7891d83")).toBe(false);
    // Clean row should still survive:
    expect(result.pools.length).toBeGreaterThanOrEqual(1);
  });

  it("sets pool.price to null (per-token priceUsd is authoritative)", async () => {
    const { fetchBalancerPools } = await import("../fetch-balancer");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { poolGetPools: [balancerRow({})] } }));
    const result = await fetchBalancerPools();
    for (const pool of result.pools) {
      expect(pool.price).toBeNull();
    }
  });
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/fetch-balancer.test.ts
```
Expected: FAIL on both assertions.

- [ ] **Step 2: Apply the fix.**

In `worker/src/cron/dex-liquidity/fetch-balancer.ts`, add a constant near the top of the file (next to the existing chain-map constants):

```ts
// Direct Balancer fetcher sanity cap — protects against upstream-corrupt totalLiquidity
// values (e.g. legacy Fantom multiUSDC/DEI pool reports $337B). Set conservatively below
// the global DIRECT_API_MAX_POOL_TVL_USD ($10B) so obvious garbage is rejected at source.
const BALANCER_MAX_POOL_TVL_USD = 2_000_000_000;
```

In the parse loop (ground-truth §4 paste, around line 177 after the `tvlUsd` parse), add the cap check right after the `if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;` line:

```ts
if (tvlUsd > BALANCER_MAX_POOL_TVL_USD) {
  malformedRows++;
  continue;
}
```

(Reusing `malformedRows` so the error counter already wired up via `errors.push(...skipped N malformed...)` captures the sanity-cap skip as well.)

In the same loop, replace the `let price: number | null = null; for (const t of pool.poolTokens) { ... price = balUsd / bal; break; }` block with:

```ts
// Per-token priceUsd is the authoritative price for Balancer rows. The scalar
// pool.price field is meaningless at pool granularity — drop it to remove a footgun.
const price: number | null = null;
```

Delete the `for (const t of pool.poolTokens) { ... }` loop that was setting `price`. The `tokens.map(...)` block that populates `priceUsd` per token remains unchanged.

- [ ] **Step 3: Run the test and the full worker test suite.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/fetch-balancer.test.ts
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

Expected: new test passes, existing tests still pass, typecheck clean.

### Wave A commit

- [ ] **Step 1: Full verification.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
cd .. && npm run lint
```

- [ ] **Step 2: Commit.**

```bash
git add worker/src/cron/dex-liquidity/fetch-meteora.ts \
        worker/src/cron/dex-liquidity/direct-source-helpers.ts \
        worker/src/lib/dex-constants.ts \
        worker/src/cron/dex-liquidity/fetch-fluid.ts \
        worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts \
        worker/src/cron/dex-liquidity/fetch-balancer.ts \
        worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts \
        worker/src/cron/dex-liquidity/__tests__/direct-source-helpers.test.ts \
        worker/src/cron/dex-liquidity/__tests__/fetch-fluid.test.ts \
        worker/src/cron/dex-liquidity/__tests__/coingecko-onchain-shared.test.ts \
        worker/src/cron/dex-liquidity/__tests__/fetch-balancer.test.ts \
        worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts \
        docs/dex-liquidity.md
git commit -m "$(cat <<'EOF'
fix(liquidity): data-accuracy fixes in direct fetchers

- Meteora: use current_price exclusively; reserve ratio is not spot on DLMM
- classifier: add PancakeSwap 25bp and 100bp buckets + QUALITY_MULTIPLIERS
- Fluid: set volume24hUsd=0; let derivePoolVolume24hUsd handle USD derivation
- CG onchain: delete inferCgBalanceRatio; emit balanceRatio=null
- Balancer: per-source $2B sanity cap; drop misleading pool.price scalar

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Wave B — Eliminate remaining pool deduplication

Two sub-waves: **B.1** parallel (three tasks, disjoint files), then **B.2** serial (one task on files B.1 touches). Single commit at end.

### Sub-wave B.1 — three parallel tasks

### Task B1.1 — Canonical poolId at the DL stamping site + higher-TVL tie-breaker

**Files:**
- Modify: `worker/src/cron/dex-liquidity/pool-identity.ts` (add `export` to `isTrustworthyExactPoolId`)
- Modify: `worker/src/cron/dex-liquidity/process-pools.ts:234-236` (stamp canonical poolId)
- Modify: `worker/src/cron/dex-liquidity/scoring-helpers.ts:239-268` (`accumulateGlobalAggregate` — add higher-TVL preference)
- Modify: `worker/src/cron/dex-liquidity/scoring.ts:127-159` (pass a per-poolId TVL Map to the accumulator so cross-coin collisions pick the larger row)
- Create: `worker/src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts`

**Root cause (HIGH-1 + MED-4 dedup audit):**
- **HIGH-1**: `process-pools.ts:234-236` stamps `poolId = chain:pool.pool` where `pool.pool` is DL's opaque UUID for most non-UniV3 pools. `pool-contribution.ts:75` (the secondary path) stamps `chain:pool.address` — the real on-chain address. When the same physical pool has a DL row AND a direct-API row, the two paths emit different `poolId` strings and `accumulateGlobalAggregate`'s `globalSeenPools: Set<string>` sees two distinct keys → double-count in global aggregates. The fix is at `process-pools.ts:234` only: stamp a canonical fingerprint when `pool.pool` is not a trustworthy exact id. **Do not touch `pool-contribution.ts:75`** — the secondary path already uses real on-chain addresses for every source.
- **MED-4**: When a collision IS caught by `globalSeenPools.has(pool.poolId)`, the first-wins semantics means iteration order determines which TVL contributes to `__global__`. Switch to "higher TVL wins" by tracking per-poolId TVL in a Map that is shared across calls and subtracting the older contribution when a larger one arrives.

**Ground-truth references:**
- `pool-identity.ts:41` has `function isTrustworthyExactPoolId(...)` currently unexported (ground-truth §3 & Part 3 Q2).
- `pool-helpers.ts:196-204` has `buildPoolFingerprint(chain, protocol, tokenAddresses)` (ground-truth Part 3 Q1).
- `scoring-helpers.ts:239-268` has `accumulateGlobalAggregate(pools, globalSeenPools, globalProtocolTvl, globalChainTvl, globalProtoChainTvl, globalChains)` returning `{ totalTvl, totalVol24h, totalVol7d, poolCount }` (ground-truth §8).
- `scoring.ts:138-159` invokes the accumulator inside `for (const [id, m] of metrics)` (ground-truth §9).

- [ ] **Step 1: Export `isTrustworthyExactPoolId`.**

In `worker/src/cron/dex-liquidity/pool-identity.ts:41`, change:

```ts
function isTrustworthyExactPoolId(poolId: string | null | undefined, protocol?: string | null): boolean {
```

to:

```ts
export function isTrustworthyExactPoolId(poolId: string | null | undefined, protocol?: string | null): boolean {
```

- [ ] **Step 2: Write failing tests for the dedup scenario and tie-breaker.**

Create `worker/src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accumulateGlobalAggregate } from "../scoring-helpers";
import type { PoolEntry } from "../types";

function makePool(overrides: Partial<PoolEntry>): PoolEntry {
  return {
    poolId: "ethereum:0xabc",
    project: "balancer-v3",
    chain: "Ethereum",
    tvlUsd: 5_000_000,
    symbol: "USDC/USDT",
    volumeUsd1d: 1_000_000,
    volumeUsd7d: 7_000_000,
    poolType: "balancer-stable",
    source: "dl",
    ...overrides,
  };
}

describe("accumulateGlobalAggregate", () => {
  it("dedupes the same physical pool across stablecoins via poolId", () => {
    const seenMap = new Map<string, number>();
    const seen = new Set<string>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const protoChainTvl: Record<string, number> = {};
    const chains = new Set<string>();

    const pool = makePool({ tvlUsd: 5_000_000 });

    const a = accumulateGlobalAggregate([pool], seen, protoTvl, chainTvl, protoChainTvl, chains, seenMap);
    const b = accumulateGlobalAggregate([pool], seen, protoTvl, chainTvl, protoChainTvl, chains, seenMap);

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000); // not 10_000_000
    expect(a.poolCount + b.poolCount).toBe(1);
  });

  it("prefers the higher-TVL row on poolId collision (replaces the smaller one)", () => {
    const seenMap = new Map<string, number>();
    const seen = new Set<string>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const protoChainTvl: Record<string, number> = {};
    const chains = new Set<string>();

    // First caller adds 4.5M. Second caller has the same poolId at 5M.
    const a = accumulateGlobalAggregate(
      [makePool({ tvlUsd: 4_500_000, volumeUsd1d: 900_000, volumeUsd7d: 6_300_000 })],
      seen, protoTvl, chainTvl, protoChainTvl, chains, seenMap,
    );
    const b = accumulateGlobalAggregate(
      [makePool({ tvlUsd: 5_000_000, volumeUsd1d: 1_000_000, volumeUsd7d: 7_000_000 })],
      seen, protoTvl, chainTvl, protoChainTvl, chains, seenMap,
    );

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(protoTvl["balancer"]).toBe(5_000_000);
    expect(chainTvl["ethereum"]).toBe(5_000_000);
  });
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts
```
Expected: both tests FAIL (signature mismatch since `seenMap` is a new parameter, and behavior is first-wins).

- [ ] **Step 3: Add the `seenPoolTvl` parameter + higher-TVL preference to `accumulateGlobalAggregate`.**

In `worker/src/cron/dex-liquidity/scoring-helpers.ts`, change the signature and body at lines 239-268:

```ts
export function accumulateGlobalAggregate(
  pools: LiquidityMetrics["topPools"],
  globalSeenPools: Set<string>,
  globalProtocolTvl: Record<string, number>,
  globalChainTvl: Record<string, number>,
  globalProtoChainTvl: Record<string, number>,
  globalChains: Set<string>,
  seenPoolTvl: Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>,
): { totalTvl: number; totalVol24h: number; totalVol7d: number; poolCount: number } {
  let totalTvl = 0;
  let totalVol24h = 0;
  let totalVol7d = 0;
  let poolCount = 0;

  for (const pool of pools) {
    const proto = normalizeProtocol(pool.project);
    const chainKey = pool.chain.toLowerCase();
    const prev = seenPoolTvl.get(pool.poolId);
    const incomingVol7d = pool.volumeUsd7d ?? 0;

    if (prev) {
      // Duplicate poolId across stablecoins. Keep the higher-TVL contribution.
      // Net effect when prev.proto === proto and prev.chain === chainKey:
      //   globalProtocolTvl[proto] changes by (pool.tvlUsd - prev.tvl)
      //   globalChainTvl[chainKey] changes by (pool.tvlUsd - prev.tvl)
      // The two -= / += ops cancel the shared key, leaving only the delta.
      if (pool.tvlUsd > prev.tvl) {
        const tvlDelta = pool.tvlUsd - prev.tvl;
        const vol24hDelta = pool.volumeUsd1d - prev.vol24h;
        const vol7dDelta = incomingVol7d - prev.vol7d;
        totalTvl += tvlDelta;
        totalVol24h += vol24hDelta;
        totalVol7d += vol7dDelta;
        // Update the per-proto / per-chain / proto-chain aggregates by the same delta,
        // using the PREVIOUS proto/chain keys in case they differ.
        globalProtocolTvl[prev.proto] = (globalProtocolTvl[prev.proto] ?? 0) - prev.tvl;
        globalChainTvl[prev.chain] = (globalChainTvl[prev.chain] ?? 0) - prev.tvl;
        globalProtoChainTvl[`${prev.proto}:${prev.chain}`] =
          (globalProtoChainTvl[`${prev.proto}:${prev.chain}`] ?? 0) - prev.tvl;
        globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + pool.tvlUsd;
        globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + pool.tvlUsd;
        globalProtoChainTvl[`${proto}:${chainKey}`] =
          (globalProtoChainTvl[`${proto}:${chainKey}`] ?? 0) + pool.tvlUsd;
        globalChains.add(chainKey);
        seenPoolTvl.set(pool.poolId, { tvl: pool.tvlUsd, vol24h: pool.volumeUsd1d, vol7d: incomingVol7d, proto, chain: chainKey });
      }
      continue;
    }

    globalSeenPools.add(pool.poolId);
    seenPoolTvl.set(pool.poolId, { tvl: pool.tvlUsd, vol24h: pool.volumeUsd1d, vol7d: incomingVol7d, proto, chain: chainKey });
    totalTvl += pool.tvlUsd;
    totalVol24h += pool.volumeUsd1d;
    totalVol7d += incomingVol7d;
    poolCount++;
    globalChains.add(chainKey);
    globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + pool.tvlUsd;
    globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + pool.tvlUsd;
    globalProtoChainTvl[`${proto}:${chainKey}`] = (globalProtoChainTvl[`${proto}:${chainKey}`] ?? 0) + pool.tvlUsd;
  }

  return { totalTvl, totalVol24h, totalVol7d, poolCount };
}
```

Important invariants this preserves:
- `globalSeenPools: Set<string>` stays as a Set for callers that read it elsewhere, but the tie-breaker logic uses `seenPoolTvl` (a Map). Both are updated.
- The returned `{ totalTvl, totalVol24h, totalVol7d, poolCount }` deltas are signed (can be negative when a replacement shrinks a previous contribution). The caller sums them into the running totals, so signed deltas are correct.
- `poolCount` is NOT incremented on replacement — the pool was already counted in the original call.

- [ ] **Step 4: Update the call site in `scoring.ts`.**

In `worker/src/cron/dex-liquidity/scoring.ts`, find the declaration block at lines 127-136 and add a new local:

```ts
const globalSeenPools = new Set<string>();
const seenPoolTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>();
```

At the call site (line 153), update the invocation to pass `seenPoolTvl` as the new last argument:

```ts
const globalDelta = accumulateGlobalAggregate(
  retainedPools,
  globalSeenPools,
  globalProtocolTvl,
  globalChainTvl,
  globalProtoChainTvl,
  globalChains,
  seenPoolTvl,
);
```

- [ ] **Step 5: Stamp a canonical poolId in `process-pools.ts`.**

Find the topPools push block at `process-pools.ts:234-236`. Current code:

```ts
m.topPools.push({
  poolId: `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`,
  project: protocol,
  ...
});
```

Add at the top of the containing function (or near the other imports in the file):

```ts
import { buildPoolFingerprint } from "./pool-helpers";
import { isTrustworthyExactPoolId } from "./pool-identity";
```

Replace the `poolId:` line with a canonical-id helper inlined:

```ts
m.topPools.push({
  poolId: isTrustworthyExactPoolId(pool.pool, pool.project)
    ? `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`
    : (buildPoolFingerprint(pool.chain, pool.project, pool.underlyingTokens ?? [])
        ?? `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`),
  project: protocol,
  ...
});
```

This stamps the DL UUID only when it's actually a trustworthy on-chain id. For opaque DL UUIDs, it falls back to a token-pair fingerprint (`fp:chain:protocol:sorted-tokens`), which matches the canonical id that the secondary path would emit for the same physical pool. If the fingerprint cannot be built (fewer than 2 token addresses — rare), it falls back to the old behavior so no row is dropped.

- [ ] **Step 6: Run the full suite.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

Expected: new tests pass, existing tests unaffected, typecheck clean.

### Task B1.2 — CG tickers orderbook unification

**Files:**
- Modify: `worker/src/cron/dex-discovery/crawl-sources.ts:444` (drop stablecoinId from staged poolId)
- Modify: `worker/src/cron/dex-liquidity/staging-merge.ts:330` (preserve multi-colon suffix)
- Modify: `worker/src/cron/dex-liquidity/fetch-fallbacks.ts:266-343` (thread `knownPoolIndex`; align fallback `address` to `${exchangeId}`; add dedup check before emission)
- Modify: `worker/src/cron/dex-liquidity/orchestrator-phases.ts:568` (update the single call site to pass `knownPoolIndex`)
- Modify: existing tests if they assert on the old `orderbook-${exchangeId}` format — grep: `rg -n "orderbook-" worker/src/cron/dex-liquidity/__tests__/`

**Root cause (HIGH-3 dedup audit):** Two incompatible orderbook pool-id conventions:
1. Discovery stages `pool_id = orderbook:${exchangeId}:${stablecoinId}` (three segments) at `crawl-sources.ts:444`.
2. `staging-merge.ts:330` extracts `address = stagedPool.poolId.split(":")[1]`, truncating to `"${exchangeId}"` and losing the stablecoin discriminator.
3. Fallback at `fetch-fallbacks.ts:319` emits `address = orderbook-${summary.exchangeId}` with `chain = "orderbook"` → stamped as `orderbook:orderbook-${exchangeId}` by `pool-contribution.ts:75`.
4. `fetchCgTickersFallback` never calls `knownPoolIndex` or runs identity dedup, so staged+fallback rows double-count.

**Fix:** Align both sources to `orderbook:${exchangeId}`, fix the multi-colon split, and thread identity dedup through the fallback.

- [ ] **Step 1: Write a failing test for the HIGH-3 scenario.**

Extend `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` (or create it if absent) with a test asserting that a staged orderbook row for KAU and a fallback orderbook row for the same Kinesis exchange do not double-count. The test may be complex because it spans multiple modules; a simpler regression is asserting that `mergeStagedPools` extracts the full suffix after the first colon (Step 3 below).

```ts
// In whichever test file is appropriate (new or existing)
it("extracts the full suffix after the first colon for multi-segment orderbook pool ids", () => {
  // unit test for the new helper OR for the fixed extraction logic
  const poolId = "orderbook:kinesis";
  const firstColon = poolId.indexOf(":");
  const address = firstColon >= 0 ? poolId.slice(firstColon + 1) : poolId;
  expect(address).toBe("kinesis");
});
```

This sanity test is optional — the main coverage is the integration tests below.

- [ ] **Step 2: Drop the stablecoinId suffix in `crawl-sources.ts:444`.**

In `worker/src/cron/dex-discovery/crawl-sources.ts`, find the `for (const summary of exchangeSummaries)` block (around line 443). Change:

```ts
const poolId = `orderbook:${summary.exchangeId}:${stablecoinId}`.toLowerCase();
```

to:

```ts
// Canonical orderbook pool id — no stablecoin suffix. Multiple tracked stablecoins
// sharing the same exchange map to the same poolId and dedup correctly downstream.
const poolId = `orderbook:${summary.exchangeId}`.toLowerCase();
```

Also update the `if (knownPoolIds.has(poolId)) continue;` check just below — it already uses `poolId` so the behavior stays the same, but the semantics are now "this exchange has already been staged for some stablecoin" rather than "this stablecoin-exchange pair has already been staged". That's the correct behavior.

- [ ] **Step 3: Fix the multi-colon split in `staging-merge.ts:330`.**

In `worker/src/cron/dex-liquidity/staging-merge.ts:330`, find:

```ts
const address = stagedPool.poolId.split(":")[1] ?? stagedPool.poolId;
```

and replace with:

```ts
// Preserve the full suffix after the first colon. Orderbook ids and any colon-bearing
// native ids stay intact. EVM/base58 addresses are colon-free so this is safe.
const firstColonIndex = stagedPool.poolId.indexOf(":");
const address = firstColonIndex >= 0 ? stagedPool.poolId.slice(firstColonIndex + 1) : stagedPool.poolId;
```

- [ ] **Step 4: Align the fallback `address` + thread `knownPoolIndex`.**

In `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`, update `fetchCgTickersFallback`.

First, change the signature at line 266 to accept `knownPoolIndex`:

```ts
export async function fetchCgTickersFallback(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  knownPoolIndex: import("./pool-identity").KnownPoolIdentityIndex,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }>
```

(Use a named import at the top of the file instead of the inline import if preferred — match the surrounding style.)

Inside the function, in the `for (const summary of exchangeSummaries)` block at lines 316-343, change the `address` field to drop the `orderbook-` prefix so the stamped `poolId` at `pool-contribution.ts:75` becomes `orderbook:${exchangeId}` (matching the staged convention):

```ts
pools.push({
  address: summary.exchangeId, // canonical exchange id; stamped as orderbook:${exchangeId}
  chain: "orderbook",
  // ... rest unchanged
});
```

Before pushing, build the pool identity and check `knownPoolIndex`:

```ts
// Add near the top of fetch-fallbacks.ts imports:
import { buildPoolIdentity, getIdentityDedupReason, registerKnownPoolIdentity } from "./pool-identity";
```

Inside the `for (const summary of exchangeSummaries)` loop, before `pools.push({...})`:

```ts
const identity = buildPoolIdentity({
  chain: "orderbook",
  protocol: "cg-tickers",
  poolAddressOrId: `orderbook:${summary.exchangeId}`,
  tokenAddresses: [], // orderbook rows have no on-chain token addresses
  poolType: "orderbook",
  feeTierBps: null,
  isStable: null,
});
// Orderbook identities have NO derived or wildcard keys (tokenAddresses: [] forces
// those to null per pool-identity.ts:136-138). Only the `exact` rail can fire:
// the staged discovery path registers `orderbook:<exchangeId>` in known.exactKeys
// via registerKnownPoolIdentity + isTrustworthyExactPoolId (which accepts the
// "orderbook:" prefix at pool-identity.ts:45). We pass counts of 0 to be explicit.
const dedupReason = getIdentityDedupReason(
  identity,
  knownPoolIndex,
  { derived: 0, wildcard: 0 },
);
if (dedupReason !== null) {
  // The staged discovery cron already seeded this orderbook row; skip the fallback
  // contribution instead of adding a parallel synthetic pool.
  continue;
}
registerKnownPoolIdentity(knownPoolIndex, identity);
```

- [ ] **Step 5: Update the single caller in `orchestrator-phases.ts`.**

In `worker/src/cron/dex-liquidity/orchestrator-phases.ts:568`, find the `fetchCgTickersFallback` call inside `runFallbackCrawlerPhase`. `knownPoolIndex` is already a parameter of `runFallbackCrawlerPhase`. Pass it to the call:

```ts
const cgTickersResult = await fetchCgTickersFallback(
  metrics,
  priceObservations,
  knownPoolIndex,
  signal,
  deadlineMs,
  references,
  coingeckoApiKey,
);
```

Also update the test mock at `worker/src/cron/__tests__/sync-dex-liquidity.test.ts:62` if it stubs `fetchCgTickersFallback` — grep: `rg -n "fetchCgTickersFallback" worker/src/cron/__tests__/`. Add the new parameter to the stub signature.

- [ ] **Step 6: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

Expected: green. If any existing test asserts on the old `orderbook-${exchangeId}` address format, update the assertion.

### Task B1.3 — Curve metapool raw-TVL: use `metapoolAdjustedTvl` for all totals

**Files:**
- Modify: `worker/src/cron/dex-liquidity/process-pools.ts:199, 227-228` (use `effectivePoolTvl` for raw totals when curveAddressMatch)
- Create test case in `worker/src/cron/dex-liquidity/__tests__/process-pools.test.ts` (if absent) — a small regression case

**Root cause (MED-3 dedup audit):** At `process-pools.ts:107-122` the code computes `effectivePoolTvl = curveAddressMatch ? curveData.metapoolAdjustedTvl : pool.tvlUsd` but then at lines 199, 227, 228 uses the un-adjusted `pool.tvlUsd` for `m.totalTvlUsd`, `m.protocolTvl`, and `m.chainTvl`. A USDT+3CRV metapool double-counts the 3pool's underlying TVL across the raw aggregates and the `__global__` row.

**Risk note (from reviewer Major 2):** the historical TVL guards in `scoreDexLiquidityPoolState` (`orchestrator.ts:402-418`) compare `currentGlobalTvl` vs `previousGlobalTvl` and throw if the ratio exceeds the guardrail band. When this fix first deploys, the global TVL will drop by up to the Curve metapool base-pool share (~$1.5B per the audit's protocol table). The guardrail band is tolerant but is not infinite. If the first deploy trips the guard, a one-time manual override may be needed. Plan: commit + wait for the next cron run + watch `cron_logs` for the value guard warning; if it trips, pin the `previousGlobalTvl` baseline manually via an ops note.

- [ ] **Step 1: Write a failing test.**

Create (or extend) `worker/src/cron/dex-liquidity/__tests__/process-pools.test.ts`. The test needs to build a minimal `LlamaPool` list + `curvePoolMap` and call `processPoolMetrics`. Sketch:

```ts
import { describe, it, expect } from "vitest";
import { processPoolMetrics } from "../process-pools";
import type { LlamaPool, CurvePoolEntry } from "../types";

describe("processPoolMetrics Curve metapool raw TVL", () => {
  it("uses metapoolAdjustedTvl for totalTvlUsd / protocolTvl / chainTvl when curveAddressMatch", () => {
    // USDT+3CRV metapool: DL reports pool.tvlUsd = 100 (including 3pool underlying)
    // Curve API reports usdTotalExcludingBasePool = 40 (just the USDT layer)
    // The raw totals should contribute 40, not 100.
    const pool: LlamaPool = {
      pool: "0x1111111111111111111111111111111111111111",
      chain: "Ethereum",
      project: "curve-dex",
      symbol: "USDT-3CRV",
      tvlUsd: 100,
      volumeUsd1d: 5,
      stablecoin: true,
      underlyingTokens: ["0xdAC17F958D2ee523a2206206994597C13D831ec7" /* USDT */],
      apy: 3,
      apyBase: 2,
      ...( {} as Partial<LlamaPool> ),
    } as LlamaPool;
    const curvePoolMap = new Map<string, CurvePoolEntry>([
      ["ethereum:0x1111111111111111111111111111111111111111", {
        chain: "ethereum",
        poolAddress: "0x1111111111111111111111111111111111111111",
        registryId: "main",
        A: 100,
        isMetaPool: true,
        metapoolAdjustedTvl: 40,
        balanceRatio: 0.95,
        balanceDetails: [],
        tokenPrices: { USDT: 1.0 },
      } as unknown as CurvePoolEntry],
    ]);

    const metrics = processPoolMetrics(
      [pool],
      new Set(["curve-dex"]),
      new Map([["USDT", ["usdt-tether"]]]),
      new Map([["USDT", new Map([["ethereum", ["usdt-tether"]]])]]),
      new Map(),
      new Map(),
      curvePoolMap,
      new Map(),
      new Map(),
    );

    const m = metrics.get("usdt-tether");
    expect(m).toBeDefined();
    expect(m!.totalTvlUsd).toBe(40);
    expect(m!.protocolTvl["curve"]).toBe(40);
    expect(m!.chainTvl["Ethereum"]).toBe(40);
  });
});
```

Adjust the test fixture to match the actual `LlamaPool` / `CurvePoolEntry` shapes in `types.ts` — use `as unknown as ...` casts if you have to satisfy the type system with a minimal fixture. The assertion is what matters.

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/process-pools.test.ts
```
Expected: FAIL — current code yields `totalTvlUsd = 100`.

- [ ] **Step 2: Apply the fix.**

In `worker/src/cron/dex-liquidity/process-pools.ts`, at the per-stablecoin push block (around lines 199-228 per ground-truth §10), replace:

```ts
m.totalTvlUsd += pool.tvlUsd;
m.totalVolume24hUsd += vol1d;
m.totalVolume7dUsd += vol7d;
m.poolCount++;
// ...
m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + pool.tvlUsd;
```

with:

```ts
// For Curve metapools matched by address, use the base-pool-adjusted TVL for ALL
// raw aggregates (not only effectiveTvl). This prevents USDT+3CRV style pools from
// double-counting the 3pool's underlying TVL.
const rawContribTvl = curveAddressMatch ? curveData!.metapoolAdjustedTvl : pool.tvlUsd;
m.totalTvlUsd += rawContribTvl;
m.totalVolume24hUsd += vol1d;
m.totalVolume7dUsd += vol7d;
m.poolCount++;
// ...
m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + rawContribTvl;
m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + rawContribTvl;
```

Also update the topPools push at line 234-236 so that `tvlUsd: pool.tvlUsd` becomes `tvlUsd: rawContribTvl`. This keeps `top_pools_json` consistent with the per-stablecoin aggregates.

Preserve the existing `qualityAdjustedTvl` / `effectiveTvl` math — those already use `effectivePoolTvl = curveData?.metapoolAdjustedTvl` via `poolEffTvl = effectivePoolTvl * combinedQuality`. The fix aligns raw totals with the same semantics.

- [ ] **Step 3: Run the test.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/process-pools.test.ts
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

Expected: green.

### Sub-wave B.2 — serial task (depends on B.1)

### Task B2 — Pool identity normalization hardening

**Files:**
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts:25-40` (`classifyPoolType` ordering — LOW-3)
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts:172-193` (`normalizeProtocol` hyphen handling — HIGH-4)
- Modify: `worker/src/cron/dex-liquidity/pool-identity.ts:100-153` (`buildPoolIdentity` — add `isStableHint` param; HIGH-2)
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts:42-111` (`filterPrimaryPoolsPreferDirectApi` — compute `isStableHint` from `chainAddressToId`, thread new parameter)
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts` (pass `chainAddressToId` from `buildDexLiquidityPoolState` at line 286)
- Modify: `worker/src/cron/dex-liquidity/__tests__/pool-identity.test.ts` (extend with the Balancer shape scenario)
- Create: `worker/src/cron/dex-liquidity/__tests__/pool-helpers.test.ts`

**Root cause (three bugs, related files):**
1. **HIGH-4** `normalizeProtocol` does `replace(/_/g, "-")` then checks `p.includes("pancakeswap")` against the concatenated form — `"pancake-swap-v3"` (DexScreener slug) doesn't match. Fix: strip both dashes and underscores before substring checks.
2. **LOW-3** `classifyPoolType` tests `aerodrome` (line 30) before `aerodrome-slipstream` (line 32), so every Aerodrome Slipstream project hits the generic `aerodrome` branch first and returns `"aerodrome-volatile"`. Fix: reorder so specific variants are tested first.
3. **HIGH-2** `resolvePoolShapeFamily` forces `"stable"` only when `isStable === true`; DL V3 Balancer rows set `pool.stablecoin = null`, so they fall into the `"weighted"` branch. Fix: add `isStableHint?: boolean` to `buildPoolIdentity`; in `orchestrator.ts:filterPrimaryPoolsPreferDirectApi`, compute it as "all underlyingTokens resolve to tracked stablecoins" via `chainAddressToId`, then pass it.

- [ ] **Step 1: Write failing tests.**

Create `worker/src/cron/dex-liquidity/__tests__/pool-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyPoolType, normalizeProtocol } from "../pool-helpers";

describe("normalizeProtocol", () => {
  it("collapses hyphenated PancakeSwap variants", () => {
    expect(normalizeProtocol("pancake-swap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancakeswap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancake_swap_v3")).toBe("pancakeswap");
  });
  it("collapses hyphenated Uniswap variants", () => {
    expect(normalizeProtocol("uni-v3")).toBe("uniswap-v3");
    expect(normalizeProtocol("univ3")).toBe("uniswap-v3");
    expect(normalizeProtocol("uniswap-v3")).toBe("uniswap-v3");
  });
});

describe("classifyPoolType ordering", () => {
  it("classifies aerodrome-slipstream before the generic aerodrome branch", () => {
    expect(classifyPoolType("aerodrome-slipstream")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("aerodrome-slipstream-base")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("velodrome-slipstream")).toBe("velodrome-slipstream-5bp");
    // Plain aerodrome still goes to volatile
    expect(classifyPoolType("aerodrome")).toBe("aerodrome-volatile");
  });
});
```

Extend `worker/src/cron/dex-liquidity/__tests__/pool-identity.test.ts` with:

```ts
import { buildPoolIdentity } from "../pool-identity";

describe("buildPoolIdentity isStableHint (HIGH-2 Balancer fallback)", () => {
  it("forces stable shape when isStableHint is true even if isStable is null", () => {
    const identity = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer-v3",
      poolAddressOrId: "6b6de6c7-uuid-not-an-address",
      tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
      poolType: "balancer-weighted",
      isStable: null,
      isStableHint: true,
    });
    expect(identity.derivedMatchKey).toContain("|stable|");
  });
  it("leaves weighted shape when isStableHint is absent/false", () => {
    const identity = buildPoolIdentity({
      chain: "ethereum",
      protocol: "balancer-v3",
      poolAddressOrId: "6b6de6c7-uuid-not-an-address",
      tokenAddresses: ["0xusdc0000000000000000000000000000000000000", "0xusdt0000000000000000000000000000000000000"],
      poolType: "balancer-weighted",
      isStable: null,
    });
    expect(identity.derivedMatchKey).toContain("|weighted|");
  });
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/pool-helpers.test.ts \
                          src/cron/dex-liquidity/__tests__/pool-identity.test.ts
```
Expected: the hyphen test, the slipstream-ordering test, and the Balancer `isStableHint` test all FAIL.

- [ ] **Step 2: Fix `normalizeProtocol` and `classifyPoolType`.**

In `worker/src/cron/dex-liquidity/pool-helpers.ts`, replace lines 172-193 (`normalizeProtocol`) with:

```ts
/** Normalize protocol names for grouping (merge variants, pass through the rest). */
export function normalizeProtocol(project: string): string {
  // Strip dashes and underscores so vendor slugs like "pancake-swap", "uni_v3", "pcs-v3"
  // collapse to their concatenated forms.
  const p = project.toLowerCase().replace(/[-_]/g, "");
  if (p.includes("curve")) return "curve";
  if (p.includes("uniswapv3") || p === "univ3") return "uniswap-v3";
  if (p.includes("uniswapv4")) return "uniswap-v4";
  if (p.includes("uniswap")) return "uniswap-v2";
  if (p.includes("fluid")) return "fluid";
  if (p.includes("meteora")) return "meteora";
  if (p.includes("balancer")) return "balancer";
  if (p.includes("aerodrome")) return "aerodrome";
  if (p.includes("velodrome")) return "velodrome";
  if (p.includes("pancakeswap") || p.includes("pcsv")) return "pancakeswap";
  if (p.includes("sushiswap") || p === "sushi") return "sushiswap";
  if (p.includes("traderjoe")) return "trader-joe";
  if (p.includes("raydium")) return "raydium";
  if (p.includes("orca")) return "orca";
  if (p.includes("quickswap")) return "quickswap";
  if (p.includes("ekubo")) return "ekubo";
  return project;
}
```

Replace `classifyPoolType` at lines 25-40 with:

```ts
/** Classify a DeFiLlama pool into a pool type for quality weighting. */
export function classifyPoolType(project: string): string {
  const proj = project.toLowerCase();
  // Specific variants must be tested BEFORE the generic base protocol.
  if (proj.includes("aerodrome-slipstream")) return "aerodrome-slipstream-5bp";
  if (proj.includes("velodrome-slipstream")) return "velodrome-slipstream-5bp";
  if (proj.includes("curve")) return "curve-stableswap"; // refined later via registryId
  if (proj.includes("fluid")) return "fluid-dex";
  if (proj.includes("meteora")) return "meteora-dlmm";
  if (proj.includes("aerodrome")) return "aerodrome-volatile"; // refined to aerodrome-stable via subgraph isStable flag
  if (proj.includes("balancer") && proj.includes("stable")) return "balancer-stable";
  if (proj.includes("balancer")) return "balancer-weighted";
  if (proj.includes("raydium")) return "raydium-amm";
  if (proj.includes("orca")) return "orca-whirlpool";
  if (proj.includes("pancakeswap")) return "pancakeswap-v3-5bp";
  if (proj.includes("uniswap-v3") || proj === "uniswap-v3") return "uniswap-v3-5bp";
  return "generic";
}
```

- [ ] **Step 3: Add `isStableHint` to `buildPoolIdentity`.**

In `worker/src/cron/dex-liquidity/pool-identity.ts:100-153`, extend the `buildPoolIdentity` signature and body:

```ts
export function buildPoolIdentity(input: {
  chain: string;
  protocol: string;
  poolAddressOrId?: string | null;
  tokenAddresses: string[];
  poolType?: string | null;
  feeTierBps?: number | null;
  isStable?: boolean | null;
  /**
   * Caller-computed hint: true when every tokenAddress resolves to a tracked
   * stablecoin. Used by resolvePoolShapeFamily to treat DL Balancer V3 rows
   * (which often omit the stable subtype) as stable-family for identity purposes.
   */
  isStableHint?: boolean;
}): PoolIdentity {
  const chain = input.chain.toLowerCase();
  const exactPoolId = input.poolAddressOrId?.trim() ?? "";
  const exactPoolKey = isTrustworthyExactPoolId(exactPoolId, input.protocol)
    ? `${chain}:${exactPoolId.toLowerCase()}`
    : null;

  const normalizedTokens = input.tokenAddresses
    .map((token) => normalizeTokenAddress(token))
    .filter(Boolean)
    .sort();
  // Effective stability: explicit true wins; hint promotes null to true; explicit false stays false.
  const effectiveIsStable: boolean | null =
    input.isStable === true || (input.isStable == null && input.isStableHint === true)
      ? true
      : input.isStable ?? null;
  const poolShapeFamily = resolvePoolShapeFamily(input.poolType, input.protocol, effectiveIsStable);
  const feeTierBucket = resolveFeeTierBucket(input.feeTierBps);
  const stabilityBucket = effectiveIsStable == null ? "na" : effectiveIsStable ? "stable" : "volatile";
  const hasMissingOptionalIdentityFields = feeTierBucket === "na" || effectiveIsStable == null;

  // ...rest of function unchanged (derivedMatchKey, optionalWildcardKey, return)
}
```

Note: the fallback at `resolvePoolShapeFamily:63` (`if (normalizeProtocol(protocol ?? "") === "balancer" && isStable === true) return "stable"`) will now fire when `isStableHint` was true, because `effectiveIsStable` is passed as the third argument.

- [ ] **Step 4: Thread `isStableHint` from `filterPrimaryPoolsPreferDirectApi`.**

**Chain-case safety:** `buildChainAddressKey(chain, address)` in `token-resolution.ts:20-22` already lowercases its `chain` argument (`${chain.toLowerCase()}:${normalizeTokenAddress(address)}`). `chainAddressToId` is populated in `pool-helpers.ts:309,323` via the same helper. So passing `pool.chain` (which is the DL-reported string like `"Ethereum"`) to `buildChainAddressKey` produces a lowercase key that round-trips to the stored entries. No case-normalization wrapper is needed, but assert this in a comment so a future refactor doesn't silently regress the hint.

In `worker/src/cron/dex-liquidity/orchestrator.ts:42-111`, update `filterPrimaryPoolsPreferDirectApi` to accept `chainAddressToId` and compute the hint:

```ts
import { buildChainAddressKey } from "./token-resolution";

export function filterPrimaryPoolsPreferDirectApi(
  pools: LlamaPool[],
  directApiPools: DexApiPool[],
  chainAddressToId: Map<string, string>,
): {
  filteredPools: LlamaPool[];
  skippedByExactIdentity: number;
  skippedByUniqueDerivedIdentity: number;
  skippedByOptionalWildcardIdentity: number;
} {
  const eligibleDirectApiPools = directApiPools.filter((pool) => isPreferredDirectApiPool(pool));
  const directApiKnown = createKnownPoolIdentityIndex();
  for (const pool of eligibleDirectApiPools) {
    registerKnownPoolIdentity(directApiKnown, buildDirectApiPoolIdentity(pool));
  }

  const primaryIdentities = pools.map((pool) => {
    const tokenAddrs = pool.underlyingTokens ?? [];
    // buildChainAddressKey lowercases its chain argument, matching the way chainAddressToId
    // is keyed in pool-helpers.ts. Safe to pass pool.chain ("Ethereum" from DL) directly.
    const isStableHint =
      tokenAddrs.length >= 2 &&
      tokenAddrs.every((addr) => chainAddressToId.has(buildChainAddressKey(pool.chain, addr)));
    return buildPoolIdentity({
      chain: pool.chain,
      protocol: pool.project,
      poolAddressOrId: pool.pool,
      tokenAddresses: tokenAddrs,
      poolType: classifyPoolType(pool.project),
      isStable: pool.stablecoin,
      isStableHint,
    });
  });
  // ...rest of the function unchanged
```

Update the call site in `buildDexLiquidityPoolState` (`orchestrator.ts:286`). The function is called as:

```ts
const {
  filteredPools: preferredPrimaryPools,
  skippedByExactIdentity: primarySkippedByDirectApiExactIdentity,
  // ...
} = filterPrimaryPoolsPreferDirectApi(sourceState.dataSources.pools, sourceState.directApiPools);
```

Add `sourceState.lookups.chainAddressToId` as the third argument:

```ts
} = filterPrimaryPoolsPreferDirectApi(
  sourceState.dataSources.pools,
  sourceState.directApiPools,
  sourceState.lookups.chainAddressToId,
);
```

- [ ] **Step 5: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

Expected: green.

### Wave B commit

- [ ] **Step 1: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
cd .. && npm run lint
```

- [ ] **Step 2: Commit.**

```bash
git add worker/src/cron/dex-liquidity/ worker/src/cron/dex-discovery/crawl-sources.ts
git commit -m "$(cat <<'EOF'
fix(liquidity): eliminate remaining pool deduplication gaps

- process-pools: stamp canonical poolId via buildPoolFingerprint when DL returns
  an opaque UUID; restores cross-source dedup in __global__ aggregates (HIGH-1)
- accumulateGlobalAggregate: prefer higher-TVL row on poolId collision (MED-4)
- CG tickers: unify orderbook poolId convention across discovery + fallback,
  thread knownPoolIndex into fetchCgTickersFallback (HIGH-3)
- staging-merge: preserve multi-colon suffix when extracting address
- normalizeProtocol: collapse hyphenated vendor slugs (pancake-swap, uni-v3, pcs-v3) (HIGH-4)
- classifyPoolType: test aerodrome-slipstream before aerodrome-volatile (LOW-3)
- pool-identity: new isStableHint parameter; forces Balancer stable shape for
  DL V3 rows where every underlying token is a tracked stablecoin (HIGH-2)
- process-pools: apply Curve metapoolAdjustedTvl to raw totals (MED-3)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Wave C — Frontend / API hygiene (parallel)

Three tasks; disjoint files except C2 which touches `scoring-helpers.ts` (also touched by B1.1). Wave C runs AFTER Wave B so there's no file overlap in time. Single commit at end.

### Task C1 — `__global__` row coverageClass + strip dead per-pool fields

**Files:**
- Modify: `worker/src/api/dex-liquidity.ts:87` (override `coverageClass` to `null` for `__global__`)
- Modify: `worker/src/api/dex-liquidity-response.ts:84-95` (`normalizeTopPools` — add allowlist for per-pool fields and `extra.*`)
- Modify: `shared/types/market.ts` (`DexLiquidityDataSchema.coverageClass` → `.nullable()`; strip `extra` fields that were removed)
- Modify: any frontend consumers of `row.coverageClass` that need a nullable guard — grep `src/`
- Extend: `worker/src/api/__tests__/dex-liquidity.test.ts`

**Root cause (M1 + M2 frontend audit):**
- M1: `dex-liquidity.ts:87` writes `coverageClass = row.coverage_class ?? "legacy"`. The `__global__` sentinel row has `coverage_class = "unobserved"` persisted even though it carries real ~$7.3B aggregate TVL — internally inconsistent.
- M2: The API ships `poolId`, `volumeUsd7d`, `extra.qualityAdjustedTvl`, `extra.hasMeasuredOrganicFraction` per top pool. Frontend Zod schema strips them; they're ~946 wasted fields (~60-90 KB of dead payload).

**Note on Zod nullable migration:** Making `coverageClass` nullable is safe because the API already has the fallback `?? "legacy"` at `dex-liquidity.ts:87`. The only nullable emission is the `__global__` override below; every active-stablecoin row still emits a string. Frontend consumers fall back to `"unobserved"` for nullable values.

- [ ] **Step 1: Failing tests in `worker/src/api/__tests__/dex-liquidity.test.ts`.**

```ts
it("returns coverageClass = null for the __global__ sentinel row", async () => {
  // Set up D1 mock, invoke handler, expect:
  const body = await response.json();
  const globalRow = body.stablecoins.find((r: { id: string }) => r.id === "__global__");
  expect(globalRow).toBeDefined();
  expect(globalRow.coverageClass).toBeNull();
});

it("does not emit poolId, volumeUsd7d, extra.qualityAdjustedTvl, or extra.hasMeasuredOrganicFraction in topPools", async () => {
  const body = await response.json();
  const someRow = body.stablecoins.find((r: { id: string }) => r.id !== "__global__");
  const pool = someRow?.topPools?.[0];
  if (pool) {
    expect(pool).not.toHaveProperty("poolId");
    expect(pool).not.toHaveProperty("volumeUsd7d");
    if (pool.extra) {
      expect(pool.extra).not.toHaveProperty("qualityAdjustedTvl");
      expect(pool.extra).not.toHaveProperty("hasMeasuredOrganicFraction");
    }
  }
});
```

Use the existing test file's mocking pattern (grep `rg -n "handleDexLiquidityRequest|dex-liquidity" worker/src/api/__tests__/` for the current setup).

Run:
```bash
cd worker && npx vitest --run src/api/__tests__/dex-liquidity.test.ts
```
Expected: both tests FAIL.

- [ ] **Step 2: Override `coverageClass` for `__global__` in the response mapper.**

In `worker/src/api/dex-liquidity.ts:87`, change:

```ts
const coverageClass = row.coverage_class ?? "legacy";
```

to:

```ts
// __global__ carries real aggregate TVL but is tagged coverage_class = "unobserved"
// at the cron write side. Override at the API edge so consumers don't paint the
// row as NR. Every active-stablecoin row continues to emit a string.
const coverageClass = row.id === "__global__" ? null : (row.coverage_class ?? "legacy");
```

- [ ] **Step 2.5: Confirm zero consumers of stripped per-pool fields.**

Grep to prove that no frontend, pages function, or shared module reads `poolId`, `volumeUsd7d`, `qualityAdjustedTvl`, or `hasMeasuredOrganicFraction` off a `topPools[]` response object:

```bash
rg -n "\.poolId\b" src/ shared/ functions/ worker/src/api/
rg -n "volumeUsd7d" src/ shared/ functions/ worker/src/api/
rg -n "qualityAdjustedTvl" src/ shared/ functions/ worker/src/api/
rg -n "hasMeasuredOrganicFraction" src/ shared/ functions/ worker/src/api/
```

Expected: the only hits are (a) the worker cron writer (internal), (b) the worker scoring helpers (internal), and (c) type definitions the frontend Zod schema already strips. If a frontend consumer is found, STOP — the strip is a hostile API break. Either preserve the field or migrate the consumer first.

- [ ] **Step 3: Add a per-pool-field allowlist in `normalizeTopPools`.**

In `worker/src/api/dex-liquidity-response.ts:84-95`, replace the current pass-through:

```ts
export function normalizeTopPools(json: string | null): DexLiquidityPoolResponse[] {
  const parsed = safeJsonParse<DexLiquidityPoolResponse[]>(json, []);
  return parsed.map((pool) => {
    const normalizedSource = normalizePoolSource(pool.source);
    if (normalizedSource != null) {
      return { ...pool, source: normalizedSource };
    }
    console.info("[dex-liquidity] Unknown pool source:", pool.source);
    const { source: _, ...rest } = pool;
    return rest as DexLiquidityPoolResponse;
  });
}
```

with:

```ts
// Allowlist of top-pool fields that are actually read by the frontend. Dead fields
// from top_pools_json are stripped to save bandwidth on the ~893 KB hot endpoint.
const ALLOWED_POOL_KEYS = new Set<string>([
  "project", "chain", "symbol", "poolType", "tvlUsd", "volumeUsd1d", "price", "source",
]);
const ALLOWED_EXTRA_KEYS = new Set<string>([
  "amplificationCoefficient", "balanceRatio", "feeTier", "organicFraction",
  "pairQuality", "stressIndex", "maturityDays", "balanceDetails", "measurement",
  "effectiveTvl", "isMetaPool", "registryId", "lockedLiquidityPct",
  "orderbookDepthUsd", "orderbookDepthUpUsd", "orderbookTvlBasis",
]);

function pickAllowedKeys(obj: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

export function normalizeTopPools(json: string | null): DexLiquidityPoolResponse[] {
  const parsed = safeJsonParse<DexLiquidityPoolResponse[]>(json, []);
  return parsed.map((pool) => {
    const cleaned = pickAllowedKeys(pool as Record<string, unknown>, ALLOWED_POOL_KEYS);
    if (pool.extra && typeof pool.extra === "object") {
      cleaned.extra = pickAllowedKeys(pool.extra as Record<string, unknown>, ALLOWED_EXTRA_KEYS);
    }
    const normalizedSource = normalizePoolSource(pool.source);
    if (normalizedSource != null) {
      cleaned.source = normalizedSource;
    } else {
      console.info("[dex-liquidity] Unknown pool source:", pool.source);
      delete cleaned.source;
    }
    return cleaned as DexLiquidityPoolResponse;
  });
}
```

- [ ] **Step 4: Make `coverageClass` nullable in the schema.**

In `shared/types/market.ts`, find the `DexLiquidityDataSchema` definition at approximately line 269 (the exact line may drift; grep for `coverageClass`). Change:

```ts
coverageClass: LiquidityCoverageClassSchema,
```

to:

```ts
coverageClass: LiquidityCoverageClassSchema.nullable(),
```

- [ ] **Step 5: Handle nullable in frontend consumers.**

Grep for all consumers of `coverageClass`:

```bash
rg -n "coverageClass" src/ shared/
```

For each site that does not already handle `null`, add a `?? "unobserved"` fallback or an explicit `if (!row.coverageClass) return ...` guard. Expected sites (per the frontend audit's data-shape table):

- `src/components/liquidity-table.tsx` — badge rendering for each row (if the badge is used)
- `src/components/dex-liquidity-card.tsx` — detail card badge
- `src/components/stablecoin-detail/liquidity-section.tsx` — detail page
- `src/components/liquidity-stats.tsx` — overview stats (if it branches on `coverageClass`)

For each, change `getLiquidityCoverageBadge(row.coverageClass)` to `getLiquidityCoverageBadge(row.coverageClass ?? "unobserved")`. For history consumers (`src/components/stablecoin-detail/tvl-trend-chart.tsx` or equivalent — check the audit's frontend data-shape table), same fallback.

- [ ] **Step 6: Verify.**

```bash
cd worker && npx vitest --run src/api/__tests__/
cd worker && npx tsc --noEmit
cd .. && npm test
npm run lint
```

Expected: all green.

### Task C2 — USDC.e alias contamination in priceSources (M3)

**Files:**
- Modify: `worker/src/cron/dex-liquidity/scoring.ts:295-426` (`computeDexPrices` — add `references` parameter; filter observations before `aggregateProtocolSources`)
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts:459` (caller of `computeDexPrices` — pass `sourceState.validationReferences`)
- Extend: `worker/src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts` (assertion on `aggregateProtocolSources` filtering behavior)

**Root cause (M3 frontend audit):** `usdc-circle.priceSources` contains 12 Fantom rows at `price ≈ 0.044`. These are USDC.e (bridged) pools where the token alias collapses to `USDC` in the registry, but the observed pool price is off peg. The aggregate `dexPriceUsd` survives because it's a TVL-weighted median, but the "show all" UI exposes the garbage entries.

**Where the builder actually lives:**
- `scoring-helpers.ts:385` exports `aggregateProtocolSources(observations: DexPriceObs[]): Array<...>` — this is the per-protocol aggregate that is persisted into `price_sources_json`.
- `scoring.ts:392` calls it inside `computeDexPrices`: `const protocolSources = aggregateProtocolSources(collapsedObservations);`
- `scoring.ts:295` declares `computeDexPrices(db, retainedPoolsByStablecoin, nowSec)` — no `references` parameter yet.
- `orchestrator.ts:459` calls `computeDexPrices(ctx.db, scoreState.retainedPoolsByStablecoin, ctx.syncStartSec)`. `sourceState.validationReferences` is available in the same scope.
- `isPlausibleDexObservationPrice` signature (ground-truth Part 3 + `price-sanity.ts:20`): `(stablecoinId: string, price: number, references?: PriceValidationReferences): boolean`. Three args, `stablecoinId` first.

**Fix approach:** Pre-filter `collapsedObservations` in `computeDexPrices` with a peg-sanity re-check per observation, BEFORE passing to `aggregateProtocolSources`. This does not remove pools from the retained set (they stay as liquidity contributors) — it only removes them from the per-protocol price aggregate written into `dex_prices.price_sources_json`.

- [ ] **Step 1: Locate the exact edit sites.**

Read:
- `worker/src/cron/dex-liquidity/scoring.ts:295-426` (full `computeDexPrices` function body)
- `worker/src/cron/dex-liquidity/scoring-helpers.ts:385-420` (`aggregateProtocolSources` body — for reference only; no changes here)
- `worker/src/cron/dex-liquidity/orchestrator.ts:455-465` (the `computeDexPrices` call inside `persistDexLiquidityScoreState`)

Confirm `aggregateProtocolSources` is called at `scoring.ts:392` and the loop-local `id` variable is the stablecoin id (the `for` loop at `scoring.ts:~330` iterates `observationsByStablecoin` with `const [id, observations] of ...`).

- [ ] **Step 2: Extend the signature of `computeDexPrices`.**

In `worker/src/cron/dex-liquidity/scoring.ts`, add an import at the top (next to existing imports):

```ts
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { PriceValidationReferences } from "../../lib/price-validation";
```

Change the signature at `scoring.ts:295`:

```ts
export async function computeDexPrices(
  db: D1Database,
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
  nowSec: number,
  references?: PriceValidationReferences,
): Promise<void> {
```

(Optional — if `PriceValidationReferences` is not exported from `../../lib/price-validation`, check the correct module path via `rg -n "export.*PriceValidationReferences" worker/src/lib/`.)

- [ ] **Step 3: Filter observations before aggregation.**

At `scoring.ts:392`, right before the `aggregateProtocolSources` call, add a peg-sanity filter:

```ts
// Guard against retained pools whose prices are off-peg for the tracked stablecoin.
// This protects price_sources_json (the "show all sources" UI) from alias-collapse
// contamination like Fantom USDC.e rows at $0.044 flowing into usdc-circle.priceSources.
// The retained pool set is not modified — only the per-protocol aggregate surface is.
const sanePriceObs = collapsedObservations.filter((obs) =>
  isPlausibleDexObservationPrice(id, obs.price, references),
);
const protocolSources = aggregateProtocolSources(sanePriceObs);
```

Note: the surrounding code still uses `collapsedObservations` for `medianInputObs` / `totalTvl` / `collapsedObservations.length`. **Do not** substitute `sanePriceObs` in those places — the median computation and source-count persistence should continue to see the full collapsed set (keeping the current behavior for `dex_price_usd` stability; this task only fixes the per-protocol `price_sources_json` surface).

- [ ] **Step 4: Pass `references` at the caller.**

In `worker/src/cron/dex-liquidity/orchestrator.ts:459`, update the `computeDexPrices` call inside `persistDexLiquidityScoreState`:

```ts
await computeDexPrices(
  ctx.db,
  scoreState.retainedPoolsByStablecoin,
  ctx.syncStartSec,
  sourceState.validationReferences,
);
```

`sourceState.validationReferences` is already available per the `DexLiquiditySourceState` interface (`orchestrator.ts:155`).

- [ ] **Step 5: Write a regression test.**

Extend `worker/src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts` with a test on `isPlausibleDexObservationPrice` behavior — or, if `computeDexPrices` can be tested in isolation with a real D1 mock, add an integration test there. For a pure unit test:

```ts
import { isPlausibleDexObservationPrice } from "../price-sanity";
import { loadPriceValidationReferences } from "../../../lib/price-validation";

describe("isPlausibleDexObservationPrice guards usdc-circle peg", () => {
  it("rejects Fantom USDC.e style off-peg prices", async () => {
    // References can be undefined for this test — the fallback ranges still reject $0.044 for a USD peg.
    expect(isPlausibleDexObservationPrice("usdc-circle", 0.0443, undefined)).toBe(false);
    expect(isPlausibleDexObservationPrice("usdc-circle", 1.0001, undefined)).toBe(true);
  });
});
```

This test documents the sanity helper's behavior; it does not need to exercise `computeDexPrices` end-to-end.

- [ ] **Step 6: Verify.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/
cd worker && npx tsc --noEmit
```

Expected: green.

### Task C3 — Frontend schema and label hygiene

**Files:**
- Modify: `shared/types/market.ts` — delete the `crossChain: z.number().optional()` field from `scoreComponents`
- Modify: `src/lib/liquidity-coverage.ts:27-33` — add `direct_api: "Direct API"` to `SOURCE_LABELS`

**Root cause:**
- m2 frontend: `crossChain` is declared in the schema but never emitted by the API and never rendered. Dead.
- m3 frontend: API emits `direct_api` as a source family; the badge tooltip renders the raw string because no entry exists in `SOURCE_LABELS`.

- [ ] **Step 1: Delete `crossChain`.**

In `shared/types/market.ts`, find the `scoreComponents` z.object and remove the `crossChain: z.number().optional(),` line. Grep to confirm nothing else references `crossChain`:

```bash
rg -n "crossChain" src/ shared/ worker/
```

If any usage exists, remove those usages too.

- [ ] **Step 2: Add `direct_api` label.**

In `src/lib/liquidity-coverage.ts:27-33`, change:

```ts
const SOURCE_LABELS: Record<string, string> = {
  dl: "DeFiLlama",
  cg_onchain: "CG Onchain",
  gecko_terminal: "GeckoTerminal",
  dexscreener: "DexScreener",
  cg_tickers: "CG Tickers",
};
```

to:

```ts
const SOURCE_LABELS: Record<string, string> = {
  dl: "DeFiLlama",
  direct_api: "Direct API",
  cg_onchain: "CG Onchain",
  gecko_terminal: "GeckoTerminal",
  dexscreener: "DexScreener",
  cg_tickers: "CG Tickers",
};
```

- [ ] **Step 3: Verify.**

```bash
npm test
npm run lint
```

Expected: green.

### Wave C commit

- [ ] **Step 1: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
cd .. && npm test
npm run lint
```

- [ ] **Step 2: Commit.**

```bash
# Add only files that were actually modified. C1 Step 5 may or may not touch
# src/components/* (only if a consumer needs a ?? "unobserved" fallback);
# add those specific files by name if that step made changes.
git add worker/src/api/dex-liquidity.ts \
        worker/src/api/dex-liquidity-response.ts \
        worker/src/cron/dex-liquidity/scoring.ts \
        worker/src/cron/dex-liquidity/orchestrator.ts \
        worker/src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts \
        worker/src/api/__tests__/dex-liquidity.test.ts \
        shared/types/market.ts \
        src/lib/liquidity-coverage.ts
# If C1 Step 5 touched any src/components/**, git add those specific files too.
git commit -m "$(cat <<'EOF'
fix(liquidity): API hygiene and priceSources peg-sanity guard

- __global__ row: override coverageClass to null at the API edge
- normalizeTopPools: allowlist known fields; drop poolId/volumeUsd7d/
  qualityAdjustedTvl/hasMeasuredOrganicFraction from the public payload
- priceSources: re-check each contributor via isPlausibleDexObservationPrice
  to block USDC.e alias leakage into usdc-circle.priceSources
- schema: delete unreachable crossChain; make coverageClass nullable
- liquidity-coverage: add direct_api label to SOURCE_LABELS

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Wave D — Dedup MED/LOW and defensive guards (parallel)

Three tasks. Disjoint files (after Wave B lands). Single commit at end.

### Task D1 — MED-1/MED-2 wildcard widening

**Files:**
- Modify: `worker/src/cron/dex-liquidity/pool-identity.ts` (`getIdentityDedupReason` — add a secondary pass that matches a `na` fee-bucket variant)
- Extend: `worker/src/cron/dex-liquidity/__tests__/pool-identity.test.ts`

**Root cause (MED-1 + MED-2):** DL-side identities for non-UniV3 protocols lack `feeTierBps`, so `derivedMatchKey`'s fee bucket is `"na"`. Direct-API-side identities always carry a concrete fee bucket. Derived keys never match exactly for Balancer/Raydium/Orca/Meteora, and the optional-wildcard rail only fires when both buckets are unique on both sides — a condition that breaks whenever there are 2+ parallel same-pair pools.

Fix: When the incoming derived key has a concrete fee bucket, try a secondary lookup using the same key with `na` in the fee-bucket position. If the known index has exactly one matching entry in the `na` variant AND the incoming is unique by the full key, allow the derived dedup.

**Implementation note (per reviewer Major 3):** do NOT use a regex on `derivedMatchKey`. Split on `|`, mutate `parts[4]` (the fee-bucket slot), rejoin. The format is `chain|protocol|tokens|shape|feeBucket|stability` (ground-truth §12/pool-identity).

- [ ] **Step 1: Failing test.**

```ts
it("dedupes DL (fee=na) vs direct-API (fee=1) Balancer-stable pools via the na variant", () => {
  const known = createKnownPoolIdentityIndex();
  registerKnownPoolIdentity(known, buildPoolIdentity({
    chain: "ethereum",
    protocol: "balancer",
    poolAddressOrId: "0xabc0000000000000000000000000000000000000",
    tokenAddresses: ["0xusdc", "0xusdt"],
    poolType: "balancer-stable",
    feeTierBps: 1,
    isStable: true,
  }));
  const incoming = buildPoolIdentity({
    chain: "ethereum",
    protocol: "balancer-v3",
    poolAddressOrId: "6b6de6c7-uuid-opaque",
    tokenAddresses: ["0xusdc", "0xusdt"],
    poolType: "balancer-weighted",
    feeTierBps: null,
    isStable: null,
    isStableHint: true, // from Wave B2
  });
  const reason = getIdentityDedupReason(
    incoming, known, { derived: 1, wildcard: 1 }, { allowOptionalWildcard: true },
  );
  expect(reason).not.toBeNull();
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/pool-identity.test.ts
```
Expected: FAIL (incoming has `|na|stable|`, known has `|1|stable|`, derived match fails).

- [ ] **Step 2: Apply the fix.**

In `worker/src/cron/dex-liquidity/pool-identity.ts:205-238`, update `getIdentityDedupReason` to perform a secondary match on the `na` variant when the primary derived-unique check fails:

```ts
export function getIdentityDedupReason(
  identity: PoolIdentity,
  known: KnownPoolIdentityIndex,
  incomingCounts: { derived: number; wildcard: number },
  options?: { allowOptionalWildcard?: boolean },
): PoolDedupReason | null {
  if (identity.exactPoolKey && known.exactKeys.has(identity.exactPoolKey)) {
    return "exact";
  }

  if (identity.derivedMatchKey && incomingCounts.derived === 1) {
    // `incomingCounts.derived === 1` asserts that the incoming side's own full
    // derived key is unique across the incoming batch — a precondition for any
    // derived dedup. The secondary na-variant lookup below shares this guard.
    // Primary derived-unique match.
    const knownCount = known.derivedKeyCounts.get(identity.derivedMatchKey) ?? 0;
    if (knownCount === 1) {
      const knownExactCount = known.derivedToExactKeys.get(identity.derivedMatchKey)?.size ?? 0;
      if (!(identity.exactPoolKey && knownExactCount > 0)) {
        return "derived_unique";
      }
    }

    // Secondary: derived key with feeBucket coerced to "na". Fires when the
    // known side has na fees (DL) and the incoming side has a concrete fee
    // (or vice versa), as long as the na-variant is unique on both sides.
    // Format: chain|protocol|tokens|shape|feeBucket|stability
    const parts = identity.derivedMatchKey.split("|");
    if (parts.length === 6 && parts[4] !== "na") {
      const naVariant = [...parts.slice(0, 4), "na", parts[5]].join("|");
      const knownNaCount = known.derivedKeyCounts.get(naVariant) ?? 0;
      if (knownNaCount === 1) {
        const knownExactCount = known.derivedToExactKeys.get(naVariant)?.size ?? 0;
        if (!(identity.exactPoolKey && knownExactCount > 0)) {
          return "derived_unique";
        }
      }
    }
  }

  // Optional-wildcard rail (unchanged).
  if (!options?.allowOptionalWildcard) return null;
  if (!identity.optionalWildcardKey || !identity.hasMissingOptionalIdentityFields || incomingCounts.wildcard !== 1) {
    return null;
  }
  const knownWildcardCount = known.wildcardKeyCounts.get(identity.optionalWildcardKey) ?? 0;
  if (knownWildcardCount !== 1) return null;
  const knownExactCount = known.wildcardToExactKeys.get(identity.optionalWildcardKey)?.size ?? 0;
  if (identity.exactPoolKey && knownExactCount > 0) {
    return null;
  }
  return "derived_optional_wildcard";
}
```

- [ ] **Step 3: Verify.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/pool-identity.test.ts
cd worker && npx tsc --noEmit
```

### Task D2 — MED-5: thread token addresses into known Curve/UniV3/Aerodrome identities

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-primary.ts:369-441` (`buildKnownPoolAddresses`)

**Root cause (MED-5):** Curve/UniV3/Aerodrome registrations call `buildPoolIdentity` with `tokenAddresses: []`, which forces both `derivedMatchKey` and `optionalWildcardKey` to `null` (because the identity builder requires ≥2 token addresses). Staged discovery rows that arrive for the same physical pool but with a different-looking id can't match via the derived rail.

Fix: Pull token addresses from the Curve pool map and from the UniV3/Aerodrome subgraph-enrichment payloads. Pass them to `buildPoolIdentity`.

- [ ] **Step 1: Inspect `buildKnownPoolAddresses`.**

Read the full function at `fetch-primary.ts:369-441`. Identify the three registration blocks: (1) DL pool iteration, (2) Curve pool map iteration, (3) UniV3 pool fees iteration, (4) Aerodrome `isStable` iteration (if present).

- [ ] **Step 2: Pass tokenAddresses where available.**

For each registration block:
- **Curve pool map**: `curvePoolMap` values include `coins[]` (Curve API token list). If the value has a `tokenAddresses: string[]` field, use it; if not, extract from `curveData.coins` or whatever property holds token addresses. Pass to `buildPoolIdentity`.
- **UniV3**: the `uniV3PoolFees: Map<string, number>` map is keyed by `chain:poolAddress`. Token addresses aren't directly in this map. Check whether `subgraphEnrichment.uniV3TokenAddresses` (or similar) exists. If not, leave UniV3 with `tokenAddresses: []` (exact key already covers it via `chain:0x...`).
- **Aerodrome**: similar — `aerodromeIsStable: Map<string, boolean>` keyed by pool address. If subgraph enrichment exposes tokens, pass them; otherwise leave exact-only.

The concrete change is small: for each block, if tokens are available, pass them; otherwise preserve the current `tokenAddresses: []` behavior. No test is strictly required because this only widens dedup coverage without changing semantics for pools that didn't match anyway — but add a one-line integration check in an existing test file asserting that `known.derivedKeyCounts.size > 0` after building the known index on a fixture with Curve pools.

- [ ] **Step 3: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

### Task D3 — LOW-1 + LOW-4: defensive intra-coin dedup

**Files:**
- Modify: `worker/src/cron/dex-liquidity/challenger-persistence.ts:240-279` (`selectDexPriceChallengerRowsFromPools` — dedupe by `poolId`)
- Modify: `worker/src/cron/dex-liquidity/fetch-crawlers.ts` (`mergeSecondaryPools` / `addSecondaryPoolContribution` — defensive guard)
- Extend: `worker/src/cron/dex-liquidity/__tests__/challenger-persistence.test.ts` (create if absent)
- Extend: `worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts`

**Root cause:**
- **LOW-1**: `selectDexPriceChallengerRowsFromPools` doesn't dedupe by `poolId`. If the retained pool list contains two rows with the same `poolId`, both are emitted; the DB `ON CONFLICT` drops the second, but with "last-write-wins" semantics, silently masking the duplicate.
- **LOW-4**: `mergeSecondaryPools` has no inline defensive check against duplicate poolIds already in `m.topPools`. If a caller forgets to dedupe upstream, the pool is double-counted.

- [ ] **Step 1: Failing tests.**

For LOW-1:
```ts
it("dedupes challenger rows by poolId, preferring the higher-TVL row", () => {
  const rows = selectDexPriceChallengerRowsFromPools("usdc-circle", [
    { poolId: "ethereum:0xabc", project: "p", chain: "Ethereum", tvlUsd: 4_000_000, symbol: "USDC", volumeUsd1d: 0, poolType: "t", source: "dl", price: 1.0 } as never,
    { poolId: "ethereum:0xabc", project: "p", chain: "Ethereum", tvlUsd: 5_000_000, symbol: "USDC", volumeUsd1d: 0, poolType: "t", source: "dl", price: 1.0 } as never,
  ], 1_000_000);
  expect(rows.length).toBe(1);
  expect(rows[0].tvlUsd).toBe(5_000_000);
});
```

For LOW-4 (in `fetch-crawlers.test.ts` or `pool-contribution.test.ts`):
```ts
it("addSecondaryPoolContribution is a no-op on poolId re-entry", () => {
  const metrics = new Map();
  const pool = { address: "0xabc", chain: "ethereum", dexId: "curve", name: "p", tvlUsd: 1_000_000, volume24hUsd: 100, qualityMultiplier: 0.85, maturityDays: 30, price: 1, symbol: "USDC/USDT", poolType: "curve-stableswap", sourceFamily: "dexscreener" } as never;
  addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", pool);
  addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", pool);
  expect(metrics.get("usdc-circle")!.topPools.length).toBe(1);
  expect(metrics.get("usdc-circle")!.totalTvlUsd).toBe(1_000_000);
});
```

- [ ] **Step 2: LOW-1 fix.**

In `worker/src/cron/dex-liquidity/challenger-persistence.ts:240-279`, inside `selectDexPriceChallengerRowsFromPools`, after the `qualifying` filter and before the loop that pushes rows, dedupe by `poolId` preferring higher TVL:

```ts
const qualifyingDeduped = new Map<string, (typeof qualifying)[number]>();
for (const pool of qualifying) {
  const prev = qualifyingDeduped.get(pool.poolId);
  if (!prev || pool.tvlUsd > prev.tvlUsd) {
    qualifyingDeduped.set(pool.poolId, pool);
  }
}
const dedupedQualifying = [...qualifyingDeduped.values()].sort(
  (a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId),
);
```

Then replace the `for (const pool of qualifying)` loop with `for (const pool of dedupedQualifying)`.

- [ ] **Step 3: LOW-4 fix.**

In `worker/src/cron/dex-liquidity/pool-contribution.ts:17-104`, at the top of `addSecondaryPoolContribution` (after `let m = metrics.get(stablecoinId)` and the `initMetrics` bootstrap), add:

```ts
const incomingPoolId = `${pool.chain.toLowerCase()}:${pool.address.toLowerCase()}`;
if (m.topPools.some((existing) => existing.poolId === incomingPoolId)) {
  // Defensive no-op: caller forgot to dedupe. Upstream dedup is load-bearing
  // (see HIGH-1/HIGH-3 fixes in Wave B); this guard catches regressions.
  return;
}
```

- [ ] **Step 4: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

### Wave D commit

- [ ] **Step 1: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
cd .. && npm run lint
```

- [ ] **Step 2: Commit.**

```bash
git add worker/src/cron/dex-liquidity/
git commit -m "$(cat <<'EOF'
fix(liquidity): widen wildcard dedup rail and add defensive intra-coin guards

- pool-identity: secondary derived-unique lookup on feeBucket=na variant
  via split-mutate-rejoin (MED-1 / MED-2)
- fetch-primary: thread token addresses into buildKnownPoolAddresses for
  Curve/UniV3/Aerodrome registrations (MED-5)
- challenger-persistence: intra-coin dedupe challenger rows by poolId,
  preferring the higher-TVL row (LOW-1)
- addSecondaryPoolContribution: defensive no-op when poolId already in topPools (LOW-4)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Wave E — Tests for the scoring core (parallel)

Two tasks; test-only changes; fully parallel.

### Task E1 — Unit tests for `computeLiquidityScore` and `computeDurabilityScore`

**Files:**
- Extend: `worker/src/cron/dex-liquidity/__tests__/pool-helpers.test.ts` (created in Wave B2)

Both functions live in `worker/src/cron/dex-liquidity/pool-helpers.ts` (verified: `computeDurabilityScore` at `pool-helpers.ts:62`, `computeLiquidityScore` at `pool-helpers.ts:94`) and are pure (no I/O, no time). Ground-truth §10 pastes their full bodies.

- [ ] **Step 0: Sanity-grep before writing tests.**

```bash
cd worker && rg -n "export function (computeLiquidityScore|computeDurabilityScore)" src/cron/dex-liquidity/
```

Expected: both are in `pool-helpers.ts`. If either has moved since the ground-truth snapshot, update the test file target.

- [ ] **Step 1: Cover `computeLiquidityScore`.**

Write 6-8 cases:
1. Happy path: all five components present, score inside [0, 100].
2. `depthRatio ≈ 0.005` → tvlDepth ~30.
3. `depthRatio ≈ 0.015` → tvlDepth ~47.
4. `depthRatio ≈ 0.06` → tvlDepth ~67.
5. `depthRatio ≈ 0.14` → tvlDepth ~80.
6. `depthRatio ≈ 0.25` → tvlDepth ~90+.
7. Zero volume → volumeActivity = 0.
8. `vtRatio ~ 0.001` → volumeActivity = 0.
9. `vtRatio ~ 0.32` → volumeActivity = 100.
10. NaN input guards → no NaN output (score finite).
11. Capped at 100: extreme inputs.
12. Zero floor: zero inputs.

Each case constructs a minimal `LiquidityMetrics` with `initMetrics("id", "SYM")` plus the fields the function reads (`effectiveTvl`, `totalTvlUsd`, `totalVolume24hUsd`, `qualityAdjustedTvl`, `poolCount`, `organicTvlWeightedSum`, `totalTvlForOrganic`, `oldestPoolDays`).

- [ ] **Step 2: Cover `computeDurabilityScore`.**

Cases:
1. `organicFraction = 0.25` → organic sub-score ~50 (sqrt curve).
2. `organicFraction = 0.50` → ~71.
3. `organicFraction = 1.0` → 100.
4. `tvlStability = null, volumeStability = null` → neutral 50 fallback.
5. `tvlStability = 1.0` → tvlStability sub-score = 100.
6. Full mix: verify the 35/25/25/15 weighted sum to 1 decimal.
7. `oldestPoolDays = 0` → maturity sub-score = 0.
8. `oldestPoolDays = 365` → maturity sub-score = 100.
9. `oldestPoolDays = 1000` → capped at 100.

- [ ] **Step 3: Run.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/pool-helpers.test.ts
```

Expected: all pass (documenting existing behavior).

### Task E2 — Unit tests for `classifyCoverage` and `collapseDuplicateObservations`

**Files:**
- Extend: `worker/src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts` (created in B1.1)

- [ ] **Step 1: Cover `classifyCoverage`.**

First find the function signature: grep `rg -n "export function classifyCoverage" worker/src/cron/dex-liquidity/`. Read its body to determine inputs.

Write cases:
1. All pools from `dl` source → `primary`.
2. All pools from `direct_api` → `primary` (per docs).
3. Mix of `dl` and `direct_api` → `primary`.
4. Mix of primary + `cg_onchain` fallback → `mixed`.
5. Pure `cg_onchain` → `fallback`.
6. Pure `cg_tickers` → `fallback`.
7. Empty pool list → `unobserved`.

- [ ] **Step 2: Cover `collapseDuplicateObservations`.**

Grep for the function: `rg -n "export function collapseDuplicateObservations" worker/src/cron/dex-liquidity/`. Read its body.

Write cases:
1. Same `exactPoolKey` across two observations → collapsed.
2. Same `derivedMatchKey` with unique incoming → collapsed.
3. Stale row dropped in favor of fresher one.
4. Distinct pools preserved.
5. TVL-weighted median computation on the surviving set.

- [ ] **Step 3: Run.**

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/scoring-helpers.test.ts
```

### Wave E commit

```bash
git add worker/src/cron/dex-liquidity/__tests__/
git commit -m "$(cat <<'EOF'
test(liquidity): cover scoring core pure functions

- computeLiquidityScore: threshold table, NaN/zero/cap guards
- computeDurabilityScore: sqrt curve, weights, maturity cap, neutral fallback
- classifyCoverage: primary/mixed/fallback/unobserved ladder
- collapseDuplicateObservations: exact/derived keys, weighted median

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Wave F — Structural refactors (parallel where disjoint)

### Task F1 — Extract `runPaginatedDirectApiFetch` helper for HTTP page-number fetchers

**Scope narrowing (per reviewer Major 4):** This helper applies only to fetchers that use HTTP page-number pagination — **Meteora, Raydium, Orca, and PancakeSwap** (4 fetchers, not 8). Fluid iterates a chain map and is single-page per chain. Slipstream is RPC-based (Sugar `all()`). Balancer uses GraphQL `skip` cursor. Those three do NOT use the helper.

**Files:**
- Create: `worker/src/cron/dex-liquidity/direct-api-paginated.ts`
- Create: `worker/src/cron/dex-liquidity/__tests__/direct-api-paginated.test.ts`
- Modify (migrate): `worker/src/cron/dex-liquidity/fetch-meteora.ts`, `fetch-raydium.ts`, `fetch-orca.ts`, `fetch-pancakeswap.ts`

- [ ] **Step 1: Design the helper.**

```ts
// direct-api-paginated.ts
import type { DexApiPool, DexApiFetchResult } from "../../lib/dex-api-common";
import { makeDexApiFetchResult } from "../../lib/dex-api-common";
import { readDexApiJson } from "./direct-api-json";
import { USER_AGENT } from "../../lib/constants";

export interface PaginatedDirectApiFetchOptions<TRow> {
  source: string;
  buildUrl: (pageNumber: number) => string;
  pageSize: number;
  maxPages?: number;
  timeoutMs?: number;
  parsePage: (body: unknown) => unknown[] | null; // returns the rows array or null on shape error
  mapRow: (raw: unknown, pageIndex: number) => TRow | { error: string } | null;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

export async function runPaginatedDirectApiFetch<TRow>(
  opts: PaginatedDirectApiFetchOptions<TRow>,
): Promise<{ rows: TRow[]; errors: string[]; successfulPages: number }>
```

Behavior:
- Loop: for page 1..maxPages (default 50):
  - `fetch(buildUrl(page))` with `signal: signal ? AbortSignal.any([signal, timeout]) : timeout`
  - If `!res.ok`, push `"page N: HTTP status text"` to errors and **break**.
  - Parse body via `readDexApiJson`. On failure, push error and break.
  - Call `parsePage(body)`. If `null`, push `"page N: invalid root shape"` and break.
  - For each row, call `mapRow`. If it returns `{ error: "msg" }`, push error and continue. If `null`, skip silently. Otherwise push to `rows`.
  - Increment `successfulPages`.
  - If `rows.length < pageSize`, break (end-of-pagination).

The helper does NOT call `makeDexApiFetchResult` — each caller does that with its own `ok` + `degraded` semantics. This preserves the existing `ok: successfulPages > 0` convention without forcing it on the helper.

- [ ] **Step 2: Write unit tests for the helper.**

```ts
// direct-api-paginated.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
function jsonResponse(body: unknown) { return new Response(JSON.stringify(body), { status: 200 }); }

describe("runPaginatedDirectApiFetch", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("paginates until an empty page is returned", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [1, 2, 3] }))
      .mockResolvedValueOnce(jsonResponse({ data: [4, 5] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await runPaginatedDirectApiFetch({
      source: "test",
      buildUrl: (p) => `/p?page=${p}`,
      pageSize: 3,
      parsePage: (body) => (body as { data: unknown[] }).data,
      mapRow: (raw) => raw as number,
    });
    expect(result.rows).toEqual([1, 2, 3, 4, 5]);
    expect(result.successfulPages).toBe(2); // page 3 was empty
    expect(result.errors).toHaveLength(0);
  });

  it("breaks on HTTP error and surfaces it in errors", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [1, 2, 3] }))
      .mockResolvedValueOnce(new Response("", { status: 503, statusText: "Bad Gateway" }));
    const result = await runPaginatedDirectApiFetch({
      source: "test",
      buildUrl: (p) => `/p?page=${p}`,
      pageSize: 3,
      parsePage: (body) => (body as { data: unknown[] }).data,
      mapRow: (raw) => raw as number,
    });
    expect(result.rows).toEqual([1, 2, 3]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("503");
  });

  it("skips malformed rows but preserves the rest of the page", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [1, "bad", 3] }));
    const result = await runPaginatedDirectApiFetch({
      source: "test",
      buildUrl: (p) => `/p?page=${p}`,
      pageSize: 10,
      parsePage: (body) => (body as { data: unknown[] }).data,
      mapRow: (raw) => (typeof raw === "number" ? raw : { error: "not a number" }),
    });
    expect(result.rows).toEqual([1, 3]);
    expect(result.errors).toContain("not a number");
  });
});
```

Run:
```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/direct-api-paginated.test.ts
```

- [ ] **Step 3: Migrate `fetch-raydium.ts` first.**

Replace the existing pagination loop with a call to `runPaginatedDirectApiFetch`. Keep the row-mapper inline. Re-run any existing Raydium tests.

- [ ] **Step 4: Migrate Meteora, Orca, PancakeSwap.**

For each fetcher, replace its pagination loop with the helper. Each migration is independent. Run the matching test file after each migration.

- [ ] **Step 5: Full suite + tsc + lint.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
cd .. && npm run lint
```

### Task F2 — Move `filterPrimaryPoolsPreferDirectApi` to `pool-identity.ts`

**Files:**
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts:42-111` (delete the function)
- Modify: `worker/src/cron/dex-liquidity/pool-identity.ts` (add the function, with imports)
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts` (import from `pool-identity`)

**Ordering note:** B2 already added `chainAddressToId` and `isStableHint` plumbing. This task is a pure move — no behavior change.

- [ ] **Step 1: Cut from `orchestrator.ts`.**

Cut lines 42-111 (the `filterPrimaryPoolsPreferDirectApi` function and its surrounding imports, if any are only used by this function).

- [ ] **Step 2: Paste into `pool-identity.ts`.**

Append the function at the end of `pool-identity.ts`. Add imports at the top:

```ts
import type { LlamaPool } from "./types";
import type { DexApiPool } from "../../lib/dex-api-common";
import { buildDirectApiPoolIdentity } from "./direct-source-helpers";
import { classifyPoolType } from "./pool-helpers";
import { buildChainAddressKey } from "./token-resolution";
import { isPreferredDirectApiPool } from "../../lib/dex-api-pool-shaping";
```

Adjust imports to match the actual module layout.

- [ ] **Step 3: Update `orchestrator.ts` import.**

```ts
import { filterPrimaryPoolsPreferDirectApi } from "./pool-identity";
```

- [ ] **Step 4: Verify.**

```bash
cd worker && npx vitest --run
cd worker && npx tsc --noEmit
```

### Task F3 — Dead code cleanup (knip + targeted deletions)

**Files:**
- Create: `worker/knip.json` (prep config so knip runs cleanly)
- Delete: `worker/src/cron/dex-liquidity/fetch-primary.ts` — `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` (zero production callers per ground-truth §18)
- Delete: test imports of the above — `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts` (remove test cases that cover the dead functions)
- Delete: any other symbols that knip reports as unused AFTER Waves A-E land (re-run knip before deleting)

**Prep (ground-truth Part 4):** The repo has no `knip.json`. Knip's defaults report 305 false positives. Add a minimal config.

- [ ] **Step 1: Create `worker/knip.json`.**

```json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": ["src/index.ts", "src/**/*.test.ts"],
  "project": ["src/**/*.ts"],
  "ignoreDependencies": ["vitest", "wrangler", "zod", "@cloudflare/workers-types"]
}
```

- [ ] **Step 2: Re-run knip.**

```bash
cd worker && npx knip --reporter compact
```

Record the output. Expected findings (from ground-truth Part 4 plus the audit's B.3.1):
- `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` in `fetch-primary.ts` — confirmed dead (tests only).
- Possible additional unused exports in `challenger-persistence.ts`, `fetch-crawlers.ts`, `geckoterminal-shared.ts`, `pool-identity.ts`, `token-resolution.ts`.

- [ ] **Step 3: Delete `fetchGtTokenBatch` + `fetchCgTokenBatchPrices`.**

In `worker/src/cron/dex-liquidity/fetch-primary.ts`, delete the two function bodies (lines ~465-540 per ground-truth) and any imports that become unused.

In `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts`, delete the test cases that reference them. Grep:

```bash
cd worker && rg -n "fetchGtTokenBatch|fetchCgTokenBatchPrices" src/cron/dex-liquidity/__tests__/
```

Remove each matching test case.

- [ ] **Step 4: Delete other confirmed-dead exports.**

For each symbol knip flags after Step 2, grep the whole repo:

```bash
rg -n "<symbol>" src/ worker/ shared/
```

Only delete if the result is the declaration site (or its test). For each deletion:
1. Delete the declaration.
2. Remove its entry from any re-export.
3. Remove related types if they're also unused.

- [ ] **Step 5: Verify.**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest --run
cd .. && npm run lint
```

Expected: green.

### Wave F commit

```bash
git add worker/src/cron/dex-liquidity/ worker/knip.json
git commit -m "$(cat <<'EOF'
refactor(liquidity): paginated direct-API helper, dead code cleanup, hoist identity filter

- runPaginatedDirectApiFetch helper; migrate Raydium/Meteora/Orca/Pancake
- Move filterPrimaryPoolsPreferDirectApi into pool-identity.ts
- knip.json + delete fetchGtTokenBatch / fetchCgTokenBatchPrices (zero callers)
- Remove other unused exports flagged by knip

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-execution verification

- [ ] **Step 1: Full worker test suite.**

```bash
cd worker && npx vitest --run
```

- [ ] **Step 2: Full frontend test suite.**

```bash
npm test
```

- [ ] **Step 3: Merge gate.**

```bash
npm run test:merge-gate
```

- [ ] **Step 4: Worker type-check.**

```bash
cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Lint.**

```bash
npm run lint
```

- [ ] **Step 6: Wave B.1.3 guardrail watch.**

After Wave B lands, watch `cron_logs` for the next 2 `sync-dex-liquidity` runs to confirm the global value guard does not trip from the Curve metapool raw-TVL correction. If the guard triggers, reset `previousGlobalTvl` manually via a D1 ops note.

- [ ] **Step 7: Final report.**

Summarize all changes + passing test counts + any deferred items. Deferred items (A6 Slipstream, G1 Noble Swaps, all new fetchers, structural refactors listed at the top) each become their own follow-up plan.

---

## Parallelization matrix (verified)

| Wave | Task | Touched files | Conflicts |
| --- | --- | --- | --- |
| A | A1 Meteora | `fetch-meteora.ts` + test | none |
| A | A2 classifier + multipliers | `direct-source-helpers.ts`, `dex-constants.ts`, `docs/dex-liquidity.md`, new test | **sole `docs/dex-liquidity.md` editor in Wave A** |
| A | A3 Fluid | `fetch-fluid.ts` + new test | none |
| A | A4 CG onchain | `coingecko-onchain-shared.ts`, `fetch-crawlers.test.ts`, new test | none |
| A | A5 Balancer | `fetch-balancer.ts` + new test | none |
| B.1 | B1.1 poolId + tie-breaker | `pool-identity.ts` (export), `pool-helpers.ts` (import only), `process-pools.ts`, `scoring-helpers.ts`, `scoring.ts`, new test | shares `pool-identity.ts` with B2 (serial B.1→B.2) |
| B.1 | B1.2 CG tickers orderbook | `crawl-sources.ts`, `staging-merge.ts`, `fetch-fallbacks.ts`, `orchestrator-phases.ts`, existing tests | disjoint with B1.1/B1.3 |
| B.1 | B1.3 Curve metapool raw TVL | `process-pools.ts`, new test | **conflict with B1.1** on `process-pools.ts` — serialize B1.1 → B1.3 inside the sub-wave, NOT parallel |
| B.2 | B2 identity normalization | `pool-helpers.ts`, `pool-identity.ts`, `orchestrator.ts`, new + extended tests | serial after B.1 |
| C | C1 API hygiene | `dex-liquidity.ts`, `dex-liquidity-response.ts`, `shared/types/market.ts`, frontend consumers | disjoint |
| C | C2 priceSources guard | `scoring-helpers.ts` + existing test | **conflict with B1.1** on `scoring-helpers.ts` — serialize (B.1 lands first, C runs after Wave B) |
| C | C3 schema + labels | `shared/types/market.ts`, `src/lib/liquidity-coverage.ts` | **conflict with C1** on `shared/types/market.ts` — serialize C1 → C3 inside Wave C |
| D | D1 wildcard widening | `pool-identity.ts` + test | disjoint with D2/D3; shares `pool-identity.ts` with B/F2 (sequential waves) |
| D | D2 known token addrs | `fetch-primary.ts` | disjoint |
| D | D3 defensive dedup | `challenger-persistence.ts`, `pool-contribution.ts`, tests | shares `pool-contribution.ts` with B1.1 — sequential (Wave D after B) |
| E | E1 score tests | `pool-helpers.test.ts` | shares test file with B2 — serial (Wave E after B) |
| E | E2 classify/collapse tests | `scoring-helpers.test.ts` | shares test file with B1.1 / C2 — serial (Wave E after C) |
| F | F1 paginated helper | new `direct-api-paginated.ts`, 4 fetchers, new test | shares fetcher files with Wave A — serial (Wave F after A) |
| F | F2 hoist filter | `orchestrator.ts`, `pool-identity.ts` | shares with B2/D1 — serial (Wave F after D) |
| F | F3 dead code | `knip.json`, `fetch-primary.ts` + test | shares `fetch-primary.ts` with D2 — serial |

**Parallelization safety (dispatch rules for subagents):**
- Wave A: A1, A2, A3, A4, A5 run in parallel. A2 owns the `docs/dex-liquidity.md` edit; A4's docs touch is handled inside A2.
- Wave B.1: **B1.2 runs in parallel with {B1.1, B1.3}. B1.1 and B1.3 are SERIAL** — dispatch B1.1 first, wait, then dispatch B1.3 and B1.2 in parallel. (The reviewer's matrix flagged this.)
- Wave B.2: single task, serial after B.1.
- Wave C: **C1 runs first, then C2 and C3 run in parallel** (C1 touches `shared/types/market.ts` that C3 also touches).
- Wave D: D1, D2, D3 fully parallel.
- Wave E: E1, E2 fully parallel.
- Wave F: F1 first, then F2 and F3 in parallel.

Ordering across waves: **A → B → C → D → E → F.**

---

## End of plan
