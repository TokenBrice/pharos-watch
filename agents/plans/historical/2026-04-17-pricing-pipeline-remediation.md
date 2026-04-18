# Pricing Pipeline Comprehensive Remediation & Enhancement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the pricing pipeline — the single most critical dataset in Pharos, driver of depeg detection — to a lean, production-grade baseline: close correctness gaps, tighten circuit breakers, expose operator-visible diagnostics, expand test coverage for critical paths, and simplify coordination code while preserving the v4.38 behavioral envelope.

**Architecture:** Two-stage pipeline (primary consensus → fallback enrichment) with pool challenge, GeckoTerminal probe, authoritative overrides, native-peg lane, and replay-safe cache. We leave the two-stage shape, consensus algorithm, source registry, and FX/native-peg model intact. We fix consistency bugs in pool-challenge replacement and GT-probe ordering, tighten circuit-breaker discipline across all pricing fetchers, surface the already-captured diagnostics on operator surfaces, close audit/heal code-path drift, and cover untested critical code paths. Simplification passes consolidate duplicated helpers and dead code.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Vitest, Zod. Uses `@shared/lib/*` for runtime-neutral logic, `worker/src/lib/*` for Worker-only, `worker/src/cron/*` for schedulers.

---

## Audit Summary (context for tasks)

### Critical gaps (data integrity / correctness)

1. **Pool-challenge replacement leaves `allPrices` stale** — `applyPoolChallenge` rewrites `price/source/agreeSources/candidateSources/disagreeSources` but never updates `allPrices`. Downstream `hasCorroboratedSevereDownsideCandidate` and `getPrimaryCandidatePricesForCurrentAsset` (used for severe-downside continuity across validation passes) read from this stale map. (`worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:861-874`)

2. **Replay cache TTL ignores per-source max-trusted-age** — 6h composite TTL only; an upstream-stamped CG row already 14 min old at write extends past its 15-min source trust window. (`worker/src/cron/sync-stablecoins/post-enrichment.ts:328`, `worker/src/lib/db-cache.ts:177`)

3. **`curve-oracle` has no staleness guard and no dedicated breaker** — `PriceAggregator.price()` is EMA; a replica RPC can return stale values; weight 3 + `local_fetch` mode means a stale oracle reading can single-source publish for crvUSD. Breaker state shared with per-pool `curve-onchain`. (`worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:712-730`)

4. **`audit-depeg-history` does NOT use live-pipeline validation** — admin audit calls CoinGecko `/market_chart/range` directly and deletes depeg rows on raw prices, bypassing `validatePriceCandidate` / `validatePublishedAssetPrice`. Can delete legitimate depegs. (`worker/src/api/audit-depeg-history.ts:582-588`)

5. **`mint-burn-price-heal` has no defense-in-depth validation** — trusts `price_cache` reads without re-validating against source-level replay-safety or registry flags; a writer-filter regression would propagate immediately. (`worker/src/lib/mint-burn-pipeline/price-heal.ts:67-86`)

6. **Silent empty returns bypass breakers on Kraken/Bitstamp/Coinbase/RedStone/Pyth/Curve** — fetchers catch and return empty Map; caller records `prices.size > 0`. Partial success hides systemic failure patterns; Curve per-pool failure count is invisible. (`worker/src/lib/cex-tickers.ts`, `worker/src/lib/redstone.ts`, `worker/src/lib/pyth.ts`, `worker/src/lib/curve-onchain.ts`)

7. **DexScreener fallback breakers missing in dex-liquidity and dex-discovery paths** — `fetch-fallbacks.ts` and `crawl-sources.ts` neither gate on `shouldAttemptFetch` nor record outcomes. Down DexScreener keeps getting hammered. (`worker/src/cron/dex-liquidity/fetch-fallbacks.ts:124`, `worker/src/cron/dex-discovery/crawl-sources.ts:340`)

8. **DefiLlama `/coins` contract fallback has no breaker** — `CIRCUIT_SOURCE.DL_COINS` is declared but never written by any code path. DL regional outage = continuous retries. (`worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts:47-67`)

### Major concerns

9. DEX overlap guard accepts single-non-DEX-source corroboration (even soft) for a single promoted DEX protocol → same-family self-confirmation risk. (`worker/src/lib/primary-price-collector.ts:228-237`)

10. Pool challenge is applied to NAV tokens; `getDepegThresholdBps` returns a non-sensical value for NAV.

11. Cluster tie-break does not incorporate trust tier at cluster level; a tight soft cluster can beat a loose hard cluster on peg proximity.

12. OXR overlay records breaker outcomes but never calls `shouldAttemptFetch`.

13. Rich `providerDiagnostics` and `gtProbe` telemetry written to `cron_runs.metadata` is never surfaced on `/api/status`.

14. No stale-open breaker detection pattern beyond Jupiter's no-candidate path — Kraken/Bitstamp/Coinbase/RedStone/Curve cannot recover when their tracked candidate set is temporarily empty.

15. Critical code paths without unit tests: `buildPreviousTrustedPriceLookup`, `shouldQuarantineTemporalJump`, `applyProtocolPriceOverrides`, `getPrimaryCandidatePricesForCurrentAsset`, `healNullPrices` defense-in-depth.

16. Binance retry-then-fallback amplifies latency (per-URL retry inside per-URL loop) — up to 30s wall on a persistent 5xx.

17. RedStone batch-retry unbounded (21 sequential solo retries worst-case).

### Minor / dead-code

18. `softOnly` flag on `PrimaryPriceResult` — no consumer found.

19. `CIRCUIT_SOURCE.DRPC` key defined but never recorded.

20. `DIVERGENCE_THRESHOLD_BPS = 50` hardcoded in 3 places.

21. `buildPriceValidationContext` re-built from scratch in 3+ call sites despite `ValidationContextResolver` memoization existing.

22. Hardcoded source name comparisons (`s === "coingecko" || s === "defillama-list"`) in post-consensus hardening that should use registry flags.

23. Inline CG `/simple/price` fetch in `fetchPrimaryPrices` — ~60 lines embedded in orchestrator; non-uniform breaker accounting.

### Healthy patterns (MUST preserve)

- Bron–Kerbosch pairwise clustering with explicit pivot choice.
- Canonical per-source registry with trust tiers, freshness modes, replay flags, and presets (`shared/lib/pricing-source-registry*.ts`).
- Severe-downside corroboration carried through validation (v4.37/v4.38).
- `splitCompositePriceSource` composite label handling.
- Vyper-truncation handling in Curve on-chain (documented quirk + test).
- Pyth staleness guard at fetcher boundary + confidence-weighted admission.
- RedStone multi-venue ≥2 + ≥60% agreement gate with venue-median publication.
- GT probe: 404/422 passthrough (not breaker-opening), 3-min wall budget, CG on-chain → public GT fallback.
- Chainlink transport waterfall: dRPC → shared RPC → Etherscan proxy.
- FX cadence-aware carry-forward with TARGET-holiday evaluation.
- Authoritative-inheritance registry as data (`INHERITED_TRACKED_PRICE_PARENTS`).
- `isReplaySafePriceSource` gating both write-time and read-time replay.
- DexScreener split breakers (`dexscreener-prices` vs `dexscreener-search`).
- Binance dual-URL + `isBinanceProviderBlocked` semantics.
- `filterStaleLiveReserveCircuitStates` hygiene.
- Strict Zod parsing on Pyth / DL responses.

---

## File Structure

No new files for most tasks; modifications only. Tasks that introduce new files:

- `worker/src/lib/fetcher-result.ts` — new, unified `FetcherResult<T>` type helper (Task 6).
- `worker/src/lib/__tests__/previous-trusted-price-lookup.test.ts` — new (Task 24).
- `worker/src/lib/__tests__/temporal-jump-quarantine.test.ts` — new (Task 25).
- `worker/src/lib/__tests__/protocol-override-application.test.ts` — new (Task 26).
- `worker/src/lib/__tests__/primary-candidate-carry-through.test.ts` — new (Task 27).
- `worker/src/lib/__tests__/fixtures/coinbase-ticker.json`, `pyth-hermes.json`, `redstone-batch.json` — new (Task 30).
- `shared/lib/__tests__/pricing-source-registry-policy-contract.test.ts` — new (Task 30).

---

## Execution notes

- **Branch strategy:** One feature branch for the whole plan. Commit per task. Do not squash.
- **Test execution:** Run from `/home/ahirice/Documents/git/stablecoin-dashboard/worker` via `npx vitest run <file>` for targeted runs or `npm test` at repo root for full suite.
- **Type-check:** `cd worker && npx tsc --noEmit` after every task.
- **Pre-push:** `npm run test:merge-gate` before opening PR.
- **Methodology bump:** Grouped into a single v5.0 bump at the end (Task 37). Do NOT bump per-task.

### Task dependencies and order-sensitive pairs

- Task 3 adds `CIRCUIT_SOURCE.CURVE_ORACLE`; Task 8 wires `CIRCUIT_SOURCE.DL_COINS`. Both MUST land before Task 32 (registry↔circuit contract test), since the test asserts the map is complete.
- Tasks 4a → 4b are strictly ordered: the helper extraction precedes the validation-routing fix.
- Tasks 6a → 6b → 6c → 6d → 6e form a strict chain. Each converts a disjoint set of fetchers + their callers. Breaking the chain leaves the build broken.
- Task 4 (audit-depeg-history) is listed in Phase 1 but its only coupling to consensus changes is through the shared `validatePriceCandidate` function, which no task in this plan modifies. Running Task 4 after Phase 3 (consensus tightening) is fine but not required.
- Task 16 expands the 2-source soft-aggregator downgrade scope; verify via the Phase 3 integration test (`sync-stablecoins-pricing.test.ts`) that no production asset unexpectedly moves from `high` → `single-source` beyond the documented CG+DL-list case (the new CG+DL-detail case is documented in the v5.0 changelog).

---

# PHASE 1 — Critical correctness fixes

---

## Task 1: Fix pool-challenge replacement — update `allPrices`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (~lines 860-875)
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts` (`applyPoolChallenge` replacement-coverage block)

**Context:** When pool-challenge replacement fires, `result.allPrices` still reflects pre-replacement sources. `hasCorroboratedSevereDownsideCandidate` uses `result.allPrices` to count severe-downside corroborators, and `getPrimaryCandidatePricesForCurrentAsset` (`worker/src/cron/sync-stablecoins/pricing.ts:189-205`) returns `allPrices` to the downstream post-enrichment prevalidation passes when the asset's current price still matches `primaryPriceResult.price`. A stale `allPrices` can (a) mask new severe-downside evidence carried through validation, and (b) feed later temporal-jump guards a source list that does not include the `pool-tvl-weighted` replacement.

- [ ] **Step 1: Write the failing test** in `worker/src/cron/__tests__/enrich-prices.test.ts` inside the existing pool-challenge `describe`:

```typescript
it("updates allPrices to reflect pool-tvl-weighted replacement source", async () => {
  const assetId = "usr-resolv";
  const results = new Map<string, PrimaryPriceResult>();
  results.set(assetId, {
    price: 1.0, // near peg — will be replaced by depegged pools
    source: "coingecko+defillama-list",
    selectedSource: "coingecko",
    priceEstimator: "selected_source",
    confidence: "high",
    candidateSources: ["coingecko", "defillama-list"],
    agreeSources: ["coingecko", "defillama-list"],
    disagreeSources: [],
    allPrices: { coingecko: 1.0, "defillama-list": 1.0 },
    observedAt: 1_000,
    observedAtMode: "upstream",
    observedAtBySource: { coingecko: 1_000, "defillama-list": 1_000 },
    observedAtModeBySource: { coingecko: "upstream", "defillama-list": "upstream" },
  });

  const poolChallengers = new Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string; observedAt?: number }>>();
  poolChallengers.set(assetId, [
    { price: 0.8, tvlUsd: 2_000_000, protocol: "curve", chain: "ethereum", observedAt: 900 },
    { price: 0.8, tvlUsd: 1_500_000, protocol: "uniswap", chain: "ethereum", observedAt: 950 },
  ]);

  const stats: PriceValidationStats = { total: 1, high: 1, singleSource: 0, low: 0, fallback: 0, rejected: 0, cgOnly: 0 };
  applyPoolChallenge(results, poolChallengers, new Map([[assetId, "peggedUSD"]]), stats);

  const updated = results.get(assetId);
  expect(updated).toBeDefined();
  expect(updated!.price).toBeCloseTo(0.8, 5);
  expect(updated!.source).toBe("pool-tvl-weighted");
  expect(updated!.allPrices).toEqual({ "pool-tvl-weighted": updated!.price });
  expect(updated!.observedAtBySource).toEqual({ "pool-tvl-weighted": 900 });
  expect(updated!.observedAtModeBySource).toEqual({ "pool-tvl-weighted": "local_fetch" });
});
```

- [ ] **Step 2: Run test to confirm failure**

```
cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts -t "updates allPrices to reflect pool-tvl-weighted replacement"
```
Expected: FAIL — `allPrices` still has `coingecko`/`defillama-list`.

- [ ] **Step 3: Fix implementation.** In `applyPoolChallenge` (`worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`), after the existing `result.disagreeSources = ...` line inside the `if (replacementPrice != null)` block, replace `result.allPrices` / per-source maps with the synthetic replacement only:

```typescript
result.allPrices = { "pool-tvl-weighted": replacementPrice };
result.observedAtBySource = {
  "pool-tvl-weighted": poolObservedAts.length > 0 ? Math.min(...poolObservedAts) : result.observedAt ?? null,
};
result.observedAtModeBySource = { "pool-tvl-weighted": "local_fetch" };
```

- [ ] **Step 4: Run focused test to verify pass**

```
cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts -t "updates allPrices to reflect pool-tvl-weighted replacement"
```
Expected: PASS

- [ ] **Step 5: Run the full pool-challenge test block to verify no regressions**

```
cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts -t "applyPoolChallenge"
```
Expected: all passing

- [ ] **Step 6: Commit**

```
git add worker/src/cron/sync-stablecoins/enrich-prices-primary.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "fix(pricing): update allPrices on pool-challenge replacement"
```

---

## Task 2: Per-source replay cache TTL enforcement

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/post-enrichment.ts` (`applyCachedFallback`, `getPriceCache` consumer block)
- Modify: `worker/src/lib/pricing-source-policy.ts` (add helper)
- Test: `worker/src/cron/__tests__/sync-stablecoins.test.ts` (extend replay-cache block)

**Context:** Today `post-enrichment.ts:328` drops a cached replay row only when `now - cached.updatedAt >= PRICE_CACHE_TTL` (6h). `cached.updatedAt` is persisted as the upstream-observed time when available, so a CG row that was already 14 min stale at write can still be served 5h 59m later — effectively up to 6h 13m since upstream. Tighten by bounding each cached row by the per-source `maxTrustedAgeSec × 6` (matching the existing 6-hour cap as the ceiling) so per-source freshness wins when stricter.

- [ ] **Step 1: Write the failing test** in `worker/src/cron/__tests__/sync-stablecoins.test.ts`, near the existing replay TTL tests:

```typescript
it("drops cached-replay price when source's maxTrustedAgeSec window elapsed even if within 6h global TTL", async () => {
  const now = 1_700_000_000;
  vi.setSystemTime(now * 1000);
  const db = createMockD1({
    price_cache: [
      {
        stablecoin_id: "usdz",
        price: 1.0,
        source: "coingecko", // maxTrustedAgeSec = 900
        confidence: "high",
        observed_at: now - 1_800, // 30 min — outside coingecko window, inside 6h cap
        synced_at: now - 1_800,
        observed_at_mode: "upstream",
        source_list: "coingecko",
      },
    ],
  });
  const assets = [makeAsset({ id: "usdz", price: null })];
  await runCachedFallback({ assets, db, syncStartSec: now });
  expect(assets[0].price).toBeNull();
  expect(assets[0].priceSource).toBe("missing");
});
```

- [ ] **Step 2: Run test to confirm failure**

```
cd worker && npx vitest run src/cron/__tests__/sync-stablecoins.test.ts -t "drops cached-replay price when source's maxTrustedAgeSec window"
```
Expected: FAIL — current code accepts the 30-min CG row.

- [ ] **Step 3: Add helper** to `worker/src/lib/pricing-source-policy.ts`:

```typescript
/** Returns the per-source max trusted age (seconds), or the composite 6h cap when the source has no per-source window. */
export function getPriceCacheMaxAgeSec(source: string | null | undefined, compositeCapSec: number): number {
  const entry = getPricingSourceRegistryEntry(source ?? "");
  const sourceWindow = entry?.maxTrustedAgeSec;
  if (typeof sourceWindow !== "number" || !Number.isFinite(sourceWindow) || sourceWindow <= 0) {
    return compositeCapSec;
  }
  return Math.min(sourceWindow, compositeCapSec);
}
```

- [ ] **Step 4: Wire helper into `applyCachedFallback`** in `worker/src/cron/sync-stablecoins/post-enrichment.ts`. Replace the existing `if (now - cached.updatedAt >= PRICE_CACHE_TTL)` gate with:

```typescript
const maxAgeSec = getPriceCacheMaxAgeSec(cached.source, PRICE_CACHE_TTL);
if (now - cached.updatedAt >= maxAgeSec) continue;
```

(Add import `import { getPriceCacheMaxAgeSec } from "../../lib/pricing-source-policy";`.)

- [ ] **Step 5: Re-run the focused test to verify pass**

```
cd worker && npx vitest run src/cron/__tests__/sync-stablecoins.test.ts -t "drops cached-replay price when source's maxTrustedAgeSec"
```
Expected: PASS

- [ ] **Step 6: Re-run the full replay block to confirm no regressions**

```
cd worker && npx vitest run src/cron/__tests__/sync-stablecoins.test.ts -t "replay|cached-fallback|price_cache"
```
Expected: all passing

- [ ] **Step 7: Commit**

```
git add worker/src/lib/pricing-source-policy.ts worker/src/cron/sync-stablecoins/post-enrichment.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
git commit -m "fix(pricing): bound replay-cache per-source max trusted age"
```

---

## Task 3: `curve-oracle` staleness guard + dedicated breaker + sanity bound

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (crvUSD oracle block ~lines 712-730)
- Modify: `worker/src/lib/constants.ts` (add `CURVE_ORACLE` breaker source constant)
- Modify: `worker/src/lib/curve-onchain.ts` (extract helper `fetchCurveOracleEmaWithBlockTimestamp`)
- Test: new `worker/src/lib/__tests__/curve-oracle.test.ts`

**Context:** `PriceAggregator.price()` is an EMA updated on each Curve pool transaction. We currently accept whatever the RPC returns for `latest` block with no freshness stamp, weighted at 3, publishable single-source. Stale-replica RPC could serve minutes-old state. Tighten to: (a) fetch with block number + timestamp so we can stamp `observedAt`, (b) reject reads with block-timestamp older than `CURVE_ORACLE_MAX_STALENESS_SEC = 300`, (c) use its own `CIRCUIT_SOURCE.CURVE_ORACLE` breaker so a failing aggregator doesn't block `curve-onchain` and vice versa.

- [ ] **Step 1: Add new breaker constant.** In `worker/src/lib/constants.ts`, near the other `CIRCUIT_SOURCE` entries:

```typescript
CURVE_ORACLE: "curve-oracle",
```

Also add:
```typescript
export const CURVE_ORACLE_MAX_STALENESS_SEC = 300;
```

- [ ] **Step 2: Add helper to `worker/src/lib/curve-onchain.ts`** (export). **Reuse the existing `evm-rpc.ts` helpers** (`fetchEvmBlockNumber`, `fetchEvmBlockTimestamp`, `fetchEvmCallHexAtBlock`) — these are chainId-keyed, not URL-keyed:

```typescript
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock } from "./evm-rpc";
import type { ChainRpcConfig } from "./chain-registry";

export async function fetchCurveOracleEma(
  chainId: string,
  aggregator: string,
  selector: string,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<{ price: number; blockNumber: number; blockTimestamp: number } | null> {
  const blockNumber = await fetchEvmBlockNumber(chainId, { chainRpcs, signal });
  if (blockNumber == null) return null;
  const [callHex, blockTimestamp] = await Promise.all([
    fetchEvmCallHexAtBlock(chainId, aggregator, selector, blockNumber, { chainRpcs, signal }),
    fetchEvmBlockTimestamp(chainId, blockNumber, { chainRpcs, signal }),
  ]);
  if (!callHex || blockTimestamp == null) return null;
  const word = callHex.startsWith("0x") ? callHex.slice(0, 66) : "0x" + callHex.slice(0, 64);
  const price = Number(BigInt(word)) / 1e18;
  if (!Number.isFinite(price) || price <= 0 || price >= 10) return null;
  return { price, blockNumber, blockTimestamp };
}
```

(No new evm-rpc helpers needed. The three existing exports at `worker/src/lib/evm-rpc.ts:171,273,284` cover `eth_call`, `eth_blockNumber`, `eth_getBlockByNumber`-timestamp extraction.)

- [ ] **Step 3: Replace inline Curve oracle block** at `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:712-730` with a `runPrimaryProviderFetch`-wrapped call keyed on `CIRCUIT_SOURCE.CURVE_ORACLE`:

```typescript
const curveOracleResult = sourceAllowed.curveOracle
  ? await runPrimaryProviderFetch(db, CIRCUIT_SOURCE.CURVE_ORACLE, async () => {
      const quote = await fetchCurveOracleEma(
        "ethereum",
        CRVUSD_PRICE_AGGREGATOR,
        CRVUSD_PRICE_SELECTOR,
        chainRpcs,
        signal,
      );
      if (!quote) return false;
      const now = Math.floor(Date.now() / 1000);
      if (now - quote.blockTimestamp > CURVE_ORACLE_MAX_STALENESS_SEC) return false;
      collected.curveOraclePrice = quote.price;
      collected.curveOracleObservedAt = quote.blockTimestamp;
      return true;
    })
  : false;
```

Add `curveOracle: await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ORACLE)` to the `sourceAllowed` object earlier in the function.

- [ ] **Step 4: Update `primary-price-collector.ts`** so `curve-oracle` observed-at-mode is `upstream` (the block timestamp is a true on-chain observation time). Update the `buildSourcePrice` call for `curve-oracle` to pass `observedAtMode: "upstream"`.

- [ ] **Step 5: Update registry.** In `shared/lib/pricing-source-registry-special.ts`, find the `curve-oracle` entry; change `freshnessKind` from `"local_fetch"` to `"upstream"` and set `supportsUpstreamObservedAt: true`, `maxTrustedAgeSec: 300`.

- [ ] **Step 6: Write unit test** `worker/src/lib/__tests__/curve-oracle.test.ts`. Mock the three evm-rpc helpers directly via `vi.mock("../evm-rpc", ...)` so we test the price-parsing and sanity-bound logic without binding to HTTP shapes:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockTimestamp: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchCurveOracleEma } from "../curve-onchain";
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock } from "../evm-rpc";

describe("fetchCurveOracleEma", () => {
  beforeEach(() => {
    vi.mocked(fetchEvmBlockNumber).mockReset();
    vi.mocked(fetchEvmBlockTimestamp).mockReset();
    vi.mocked(fetchEvmCallHexAtBlock).mockReset();
  });

  it("returns price + block metadata when all calls succeed", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(200);
    vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(1_700_000_000);
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(
      "0x" + (BigInt(1) * BigInt(1e18)).toString(16).padStart(64, "0"),
    );
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toEqual({ price: 1, blockNumber: 200, blockTimestamp: 1_700_000_000 });
  });

  it("returns null when parsed price >= 10 (sanity bound)", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(200);
    vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(1_700_000_000);
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(
      "0x" + (BigInt(10_000) * BigInt(1e18)).toString(16).padStart(64, "0"),
    );
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toBeNull();
  });

  it("returns null when block number unavailable", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(null);
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 7: Run test**

```
cd worker && npx vitest run src/lib/__tests__/curve-oracle.test.ts
```
Expected: PASS

- [ ] **Step 8: Run full pricing test set to verify no regressions**

```
cd worker && npx vitest run src/cron/__tests__/sync-stablecoins-pricing.test.ts src/cron/__tests__/enrich-prices.test.ts
```
Expected: PASS

- [ ] **Step 9: Commit**

```
git add worker/src/lib/constants.ts worker/src/lib/curve-onchain.ts worker/src/cron/sync-stablecoins/enrich-prices-primary.ts worker/src/lib/primary-price-collector.ts shared/lib/pricing-source-registry-special.ts worker/src/lib/__tests__/curve-oracle.test.ts
git commit -m "fix(pricing): curve-oracle staleness guard + dedicated breaker"
```

---

## Task 4a: Extract internal `auditEvents` helper from `handleAuditDepegHistory`

**Files:**
- Modify: `worker/src/api/audit-depeg-history.ts`
- Test: `worker/src/api/__tests__/audit-depeg-history.test.ts` (no behavior change expected)

**Context:** The admin audit path is currently wrapped in a route handler `handleAuditDepegHistory(request, env)` with no internal seam for unit testing. Before wiring `validatePriceCandidate` (Task 4b), extract the core audit loop into an internal helper that takes parsed arguments and returns the `AuditResult` shape — keeping the route handler as a thin parse-and-respond wrapper.

- [ ] **Step 1: Extract** `auditEvents(db, { stablecoinId, startTs, endTs, dryRun, ... })` as a top-level non-exported async function in `audit-depeg-history.ts`. Move the existing CG fetch + iteration + decision logic into it.

- [ ] **Step 2: Update `handleAuditDepegHistory`** to call `auditEvents` after parsing query params.

- [ ] **Step 3: Export `auditEvents`** for tests only (use `@internal` JSDoc if your style guide marks internals).

- [ ] **Step 4: Run existing tests**

```
cd worker && npx vitest run src/api/__tests__/audit-depeg-history.test.ts
```
Expected: PASS (no behavior change).

- [ ] **Step 5: Commit**

```
git add worker/src/api/audit-depeg-history.ts
git commit -m "refactor(api): extract auditEvents helper from handleAuditDepegHistory"
```

---

## Task 4b: Route audit CG prices through live-pricing validation

**Files:**
- Modify: `worker/src/api/audit-depeg-history.ts`
- Test: `worker/src/api/__tests__/audit-depeg-history.test.ts`

**Context:** With `auditEvents` extracted (Task 4a), route each CG price point through `validatePriceCandidate` using the same `PriceValidationContext` the live pipeline would build. Skip points the live pipeline would reject and count them under a new `rejectedByValidation` counter on `AuditResult`.

- [ ] **Step 1: Write a failing unit test** that invokes `auditEvents` directly with a mocked CG fetch:

```typescript
import { auditEvents } from "../audit-depeg-history";
import * as fetchRetry from "../../lib/fetch-retry";

it("does NOT delete a depeg event when CG prices fail live-pipeline validation", async () => {
  const db = mockD1({
    depeg_events: [{ id: 1, stablecoin_id: "brz-transfero", peg_type: "peggedBRL", started_at: 1_717_200_000, ended_at: 1_717_260_000, peak_bps: 1_800 }],
  });
  vi.spyOn(fetchRetry, "fetchWithRetry").mockResolvedValue(
    new Response(JSON.stringify({ prices: [[1_717_200_000_000, 0.22]] })),
  );
  const result = await auditEvents(db, { stablecoinId: "brz-transfero", dryRun: true });
  expect(result.deletedEvents).toHaveLength(0);
  expect(result.rejectedByValidationCount ?? 0).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to confirm failure**

```
cd worker && npx vitest run src/api/__tests__/audit-depeg-history.test.ts -t "does NOT delete a depeg event when CG prices fail live-pipeline validation"
```
Expected: FAIL

- [ ] **Step 3: Implement.** Inside `auditEvents`, after parsing the CG `market_chart/range` response into price points, filter via `validatePriceCandidate`. The admin audit route does not currently carry FX references, so assemble them once per invocation from the cached `fx-rates` key the rest of the worker reads. Wire the loader at the top of `auditEvents`:

```typescript
import { validatePriceCandidate, buildPriceValidationContext, type PriceValidationReferences } from "../lib/price-validation";
import { getTrackedMeta } from "@shared/lib/stablecoins";
import { loadFxRatesForValidation } from "../lib/fx-rate-state"; // existing exported loader used by post-enrichment

const validationReferences: PriceValidationReferences = await loadFxRatesForValidation(db);

// Per-event:
const meta = getTrackedMeta(event.stablecoin_id);
const context = buildPriceValidationContext({
  stablecoinId: event.stablecoin_id,
  pegType: event.peg_type,
  navToken: meta?.navToken,
  commodityOunces: meta?.commodityOunces,
});
const validatedPoints = rawPoints
  .map(([tsMs, price]) => {
    const verdict = validatePriceCandidate(price, context, validationReferences);
    return verdict.ok ? { ts: Math.floor(tsMs / 1000), price } : null;
  })
  .filter((point): point is { ts: number; price: number } => point != null);
rejectedByValidationCount += rawPoints.length - validatedPoints.length;
```

If `loadFxRatesForValidation` does not exist under that exact name, grep `PriceValidationReferences` for the loader actually used by `post-enrichment.ts` and reuse it. Do NOT invent a new loader. Add `rejectedByValidationCount: number` to `AuditResult`. Base verdict decisions on `validatedPoints` rather than the raw series.

- [ ] **Step 4: Run test**

```
cd worker && npx vitest run src/api/__tests__/audit-depeg-history.test.ts -t "does NOT delete a depeg event when CG prices fail live-pipeline validation"
```
Expected: PASS

- [ ] **Step 5: Run full audit-depeg-history test set**

```
cd worker && npx vitest run src/api/__tests__/audit-depeg-history.test.ts
```
Expected: all passing

- [ ] **Step 6: Commit**

```
git add worker/src/api/audit-depeg-history.ts worker/src/api/__tests__/audit-depeg-history.test.ts
git commit -m "fix(pricing): audit-depeg-history routes CG prices through validatePriceCandidate"
```

---

## Task 5: `mint-burn-price-heal` defense-in-depth filter

**Files:**
- Modify: `worker/src/lib/mint-burn-pipeline/price-heal.ts`
- Test: `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`

**Context:** Today `healNullPrices` calls `getPriceCache(db)` which returns `Map<assetId, PriceCacheEntry>` — the current per-asset row, already keyed by `asset_id`. There is no nearest-timestamp lookup; the implementation filters `healable` by `prices.has(event.stablecoin_id)` and uses the single cached row's price. The defense-in-depth fix is a single filter: only accept rows whose `source` satisfies `isReplaySafePriceSource`. The writer filter in `post-enrichment.ts:298` is already correct, but if it ever regresses (e.g., a new source added without the flag), the heal path should still refuse the bad row instead of propagating it.

- [ ] **Step 1: Write the failing test** in `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`:

```typescript
it("skips heal when cached price source is not replay-safe", async () => {
  const db = mockD1({
    tables: {
      mint_burn_events: [{ id: "evt1", stablecoin_id: "usdc", chain_id: "ethereum", amount: 100, timestamp: 1_700_000_100, amount_usd: null }],
      price_cache: [{
        asset_id: "usdc",
        price: 1.01,
        source: "coingecko-native-implied", // isReplaySafe = false
        confidence: "fallback",
        observed_at: 1_700_000_000,
        synced_at: 1_700_000_000,
        source_list: "coingecko-native-implied",
        observed_at_mode: "local_fetch",
      }],
    },
  });
  const result = await healNullPrices(db, 1_700_000_200);
  expect(result.healed).toBe(0);
});
```

(Use whatever D1 mock the existing tests in this file use; match that style.)

- [ ] **Step 2: Run test**
```
cd worker && npx vitest run src/lib/__tests__/mint-burn-price-heal.test.ts -t "skips heal when cached price source is not replay-safe"
```
Expected: FAIL — current code heals using the non-replay-safe cached row.

- [ ] **Step 3: Fix `healNullPrices`.** In `worker/src/lib/mint-burn-pipeline/price-heal.ts`, import `isReplaySafePriceSource` from `../pricing-source-policy`. Modify the `healable` filter (existing line 70) to:

```typescript
const healable = nullEvents.filter((event) => {
  const cached = prices.get(event.stablecoin_id);
  if (!cached) return false;
  return isReplaySafePriceSource(cached.source ?? null);
});
```

(Assumes `PriceCacheEntry` carries `source`. Confirm by reading `db-cache.ts` and, if absent, add the column to the query + row shape.)

- [ ] **Step 4: Run test**
```
cd worker && npx vitest run src/lib/__tests__/mint-burn-price-heal.test.ts -t "skips heal when cached price source is not replay-safe"
```
Expected: PASS

- [ ] **Step 5: Run full file**
```
cd worker && npx vitest run src/lib/__tests__/mint-burn-price-heal.test.ts
```
Expected: all passing

- [ ] **Step 6: Commit**
```
git add worker/src/lib/mint-burn-pipeline/price-heal.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts
git commit -m "fix(pricing): mint-burn heal rejects non-replay-safe cache rows"
```

---

# PHASE 2 — Circuit breaker + diagnostics reliability

---

## Task 6 (series): Unified `FetcherOutcome<T>` adoption

Converting every fetcher + caller in one task would leave the build broken mid-commit (each fetcher signature change requires its caller to be updated simultaneously). Split into 5 sub-tasks; each is independently committable and keeps the build green.

### Task 6a: Introduce `FetcherOutcome<T>` type + helpers

**Files:**
- Create: `worker/src/lib/fetcher-result.ts`
- Create: `worker/src/lib/__tests__/fetcher-result.test.ts`

**Context:** Introduce the type surface before changing any fetcher. Callers are not yet aware of it; no runtime behavior changes.

```typescript
export type FetcherOutcome<T> =
  | { kind: "ok"; value: T; partial?: boolean }
  | { kind: "no-data"; value: T }         // transport ok, zero matches — breaker: success
  | { kind: "blocked"; value: T }          // provider block (403/451 pattern) — breaker: success (no-contribution)
  | { kind: "upstream-error"; value: T; reason: string }; // breaker: failure

export function isSuccessfulOutcome<T>(outcome: FetcherOutcome<T>): boolean {
  return outcome.kind === "ok" || outcome.kind === "no-data" || outcome.kind === "blocked";
}
```

- [ ] **Step 1: Create file and type.**
- [ ] **Step 2: Write unit test** asserting the success discriminator covers `ok`/`no-data`/`blocked` and rejects `upstream-error`.
- [ ] **Step 3: Run test.** Expected: PASS.
- [ ] **Step 4: Commit.**
```
git add worker/src/lib/fetcher-result.ts worker/src/lib/__tests__/fetcher-result.test.ts
git commit -m "feat(pricing): introduce FetcherOutcome type for provider breaker discipline"
```

---

### Task 6b: Convert Binance fetcher + caller to `FetcherOutcome`

**Files:**
- Modify: `worker/src/lib/cex-tickers.ts` (`fetchBinancePricesDetailed`)
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (Binance call site)
- Modify: `worker/src/lib/__tests__/cex-tickers.test.ts` (adjust asserts for the new return shape)

**Context:** Binance already has diagnostics-based provider-block detection (`isBinanceProviderBlocked`). Migrate it to returning `{ kind: "blocked", value: new Map() }` when all hosts 403/451; `{ kind: "upstream-error", ... }` when all hosts throw or return 5xx; `{ kind: "ok" | "no-data", ... }` otherwise. Caller records via `isSuccessfulOutcome`. Remove `isBinanceProviderBlocked` call site in primary.

- [ ] **Step 1: Write a failing test** in `cex-tickers.test.ts` asserting the new return shape for a 403/451 all-host path:
```typescript
it("returns blocked outcome when every Binance host returns 403/451", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("blocked", { status: 451 })));
  const outcome = await fetchBinancePricesDetailed(["USDTUSD"]);
  expect(outcome.kind).toBe("blocked");
});
```
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Change `fetchBinancePricesDetailed` return type** to `FetcherOutcome<{ prices: Map<string, number>; diagnostics: ProviderDiagnostic[] }>`. Map existing `isBinanceProviderBlocked(diagnostics)` → `{ kind: "blocked" }`, keep diagnostics on the `value`.
- [ ] **Step 4: Update caller** in `enrich-prices-primary.ts` to consume `outcome.value.prices` / `outcome.value.diagnostics` and record `recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, isSuccessfulOutcome(outcome))`. Delete the now-dead `isBinanceProviderBlocked(diagnostics)` check at the call site only (do NOT delete the exported function yet — Task 6e does it after the other CEX fetchers migrate).
- [ ] **Step 5: Run test — PASS.**
- [ ] **Step 6: Run cex-tickers + primary**:
```
cd worker && npx vitest run src/lib/__tests__/cex-tickers.test.ts src/cron/__tests__/sync-stablecoins-pricing.test.ts
```
- [ ] **Step 7: Commit.**

---

### Task 6c: Convert Kraken, Bitstamp, Coinbase fetchers + callers

**Files:**
- Modify: `worker/src/lib/cex-tickers.ts` (`fetchKrakenPrices`, `fetchBitstampPrices`, `fetchCoinbasePrices`)
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (three call sites)
- Modify: `worker/src/lib/__tests__/cex-tickers.test.ts`

- [ ] **Step 1: Write failing test** for each — all-batches-throw returns `upstream-error`; no-matches returns `no-data`; mixed returns `ok` with `partial: true`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** For each fetcher, track `transportFailures` vs `transportAttempts`; return the appropriate outcome.
- [ ] **Step 4: Update caller sites** to record via `isSuccessfulOutcome`.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit.**

---

### Task 6d: Convert RedStone + Pyth fetchers + callers

**Files:**
- Modify: `worker/src/lib/redstone.ts`
- Modify: `worker/src/lib/pyth.ts`
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (two call sites)
- Modify: `worker/src/lib/__tests__/redstone.test.ts`, `worker/src/lib/__tests__/pyth.test.ts`

Same shape as 6c: add `FetcherOutcome` return; adjust callers; update tests.

---

### Task 6e: Convert Curve on-chain + Curve oracle + remove unused `isBinanceProviderBlocked`

**Files:**
- Modify: `worker/src/lib/curve-onchain.ts` (`fetchCurveOnchainPrices`)
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- Modify: `worker/src/lib/cex-tickers.ts` (delete `isBinanceProviderBlocked` export once no call sites remain)

- [ ] **Step 1: Failing test** — Curve on-chain reports `upstream-error` only when ALL pools' RPC calls threw; `no-data` when all pools ran but yielded no usable result; `ok` otherwise with `partial` when any pool failed.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** and update caller.
- [ ] **Step 4: Grep `isBinanceProviderBlocked`**; confirm zero call sites outside the definition; delete the function + its tests.
- [ ] **Step 5: Run test + full cex-tickers + primary**:
```
cd worker && npx vitest run src/lib/__tests__/cex-tickers.test.ts src/cron/__tests__/sync-stablecoins-pricing.test.ts src/lib/__tests__/curve-onchain.test.ts
```
- [ ] **Step 6: Commit.**

---

## Task 7: Wire DexScreener breakers in dex-liquidity + dex-discovery paths

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- Modify: `worker/src/cron/dex-discovery/crawl-sources.ts`
- Test: extend existing `worker/src/cron/__tests__/dex-liquidity-*.test.ts` or create minimal coverage

**Context:** Both paths call `fetchDsTokenPools` / `fetchDsSearch` directly without `shouldAttemptFetch` gates or `recordOutcome` writes. Only the pricing enrichment pass writes breaker state. Down DexScreener means both these crons keep hammering with no backoff.

- [ ] **Step 1: Write failing test** for `fetch-fallbacks.ts` — assert that when `CIRCUIT_SOURCE.DEXSCREENER_PRICES` is open, the DexScreener fetcher is not called:

```typescript
it("skips DexScreener when dexscreener-prices breaker is open", async () => {
  const db = mockD1WithOpenBreaker(CIRCUIT_SOURCE.DEXSCREENER_PRICES);
  const fetchSpy = vi.spyOn(dexscreenerModule, "fetchDsTokenPoolsWithStatus");
  await runFetchFallbacks({ db, candidates: [{ chain: "ethereum", address: "0xabc" }] });
  expect(fetchSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test**
```
cd worker && npx vitest run -t "skips DexScreener when dexscreener-prices breaker is open"
```
Expected: FAIL

- [ ] **Step 3: Wrap calls using the existing `fetchDsTokenPoolsWithStatus`** (which returns `{ ok, pairs }`) in both files. In `fetch-fallbacks.ts` around the DexScreener call:

```typescript
if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES))) return [];
const result = await fetchDsTokenPoolsWithStatus(chain, address, signal);
await recordOutcome(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES, result.ok);
if (!result.ok) return [];
const pairs = result.pairs;
// existing consumer code that was reading from fetchDsTokenPools(...) now reads `pairs`
```

Mirror in `crawl-sources.ts`. Replace any existing `fetchDsTokenPools` call with the WithStatus variant at these two breaker-covered sites — the non-WithStatus variant remains for callers that don't need the status signal.

- [ ] **Step 4: Run test — expect pass**

- [ ] **Step 5: Run dex-liquidity tests**
```
cd worker && npx vitest run src/cron/__tests__/dex-liquidity
```
Expected: PASS

- [ ] **Step 6: Commit**
```
git add worker/src/cron/dex-liquidity/fetch-fallbacks.ts worker/src/cron/dex-discovery/crawl-sources.ts worker/src/cron/__tests__/dex-liquidity-*.test.ts
git commit -m "fix(pricing): wire DexScreener breaker in dex-liquidity + dex-discovery paths"
```

---

## Task 8: Wire DL `/coins` contract-price breaker

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts`
- Test: extend `worker/src/cron/__tests__/enrich-prices.test.ts`

**Context:** `CIRCUIT_SOURCE.DL_COINS` is defined but never recorded. `fetchPriceMapByIds` (lines 47-67) returns `null` on non-OK with no breaker effect. Wire the breaker around this fetcher.

- [ ] **Step 1: Write failing test** — assert DL /coins fetch is skipped when breaker open:

```typescript
it("skips DL /coins fetch when dl-coins breaker is open", async () => {
  const db = createMockD1WithOpenBreaker(CIRCUIT_SOURCE.DL_COINS);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await runDlContractPass({ db, missing: [{ stablecoin_id: "usdc", contracts: [{ chain: "ethereum", address: "0xabc" }] }] });
  expect(fetchSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test — expect FAIL**
- [ ] **Step 3: Implement breaker wrap** in `enrich-prices-defillama-pass.ts`:
```typescript
if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_COINS))) return new Map();
const response = await fetch(url, { signal });
await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, response.ok);
if (!response.ok) return new Map();
// existing parse...
```
- [ ] **Step 4: Run test — expect PASS**
- [ ] **Step 5: Run enrich-prices suite**
```
cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts
```
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): wire dl-coins breaker around DefiLlama contract-price fetch"
```

---

## Task 9: OXR `shouldAttemptFetch` gate + accurate outcome

**Files:**
- Modify: `worker/src/cron/sync-fx-rates-helpers.ts` (runOpenExchangeRatesOverlay)
- Test: extend `worker/src/cron/__tests__/sync-fx-rates*.test.ts`

**Context:** `runOpenExchangeRatesOverlay` records outcome but never gates. And `recordOutcome(..., realtimeFetch.completed)` treats transport-success with zero rates as breaker-success. Gate on `shouldAttemptFetch(db, CIRCUIT_SOURCE.FX_REALTIME)` and record based on `realtimeFetch.rates.size > 0`.

- [ ] **Step 1: Write failing test** — breaker open → no OXR fetch, and 200-with-empty response → breaker failure.
- [ ] **Step 2: Run test — expect FAIL**
- [ ] **Step 3: Implement:**
```typescript
if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.FX_REALTIME))) {
  return { applied: false, reason: "breaker-open" };
}
// existing fetch...
await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, realtimeFetch.rates.size > 0);
```
- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run fx-rates suite**
```
cd worker && npx vitest run src/cron/__tests__/sync-fx-rates.test.ts
```
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): OXR overlay gated on and recorded against fx-realtime breaker"
```

---

## Task 10: Generalized no-candidate breaker recovery

**Files:**
- Modify: `worker/src/lib/circuit-breaker.ts` (add `recoverOnNoCandidate` helper)
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (apply to Kraken/Bitstamp/Coinbase/RedStone/Curve)
- Test: extend `worker/src/lib/__tests__/circuit-breaker.test.ts`

**Context:** Today only Jupiter has a no-candidate breaker-recovery path (`enrich-prices-jupiter-pass.ts:54-66`). When the tracked candidate set for Kraken/Bitstamp/Coinbase/RedStone/Curve is temporarily empty (all tracked symbols absent, or all pools excluded), a previously-open breaker stays open forever. Extract the pattern.

- [ ] **Step 1: Add helper** in `worker/src/lib/circuit-breaker.ts`:

```typescript
/** When there are no candidates to probe and the breaker is non-closed, record success to allow recovery. */
export async function recoverBreakerOnNoCandidate(db: D1Database, source: string): Promise<void> {
  const state = await getBreakerState(db, source);
  if (state !== "closed") {
    await recordOutcome(db, source, true);
  }
}
```

- [ ] **Step 2: Write unit test** asserting a half-open breaker closes when invoked with no candidates.
- [ ] **Step 3: Run test — PASS**
- [ ] **Step 4: Apply at 5 call sites** in `enrich-prices-primary.ts`:
```typescript
if (krakenTrackedSymbols.length === 0) {
  await recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.KRAKEN_PRICES);
} else {
  // existing fetch...
}
```
Repeat for Bitstamp / Coinbase / RedStone / Curve pools.

- [ ] **Step 5: Run full test suite**
```
cd worker && npx vitest run src/lib/__tests__/circuit-breaker.test.ts src/cron/__tests__/sync-stablecoins-pricing.test.ts
```
- [ ] **Step 6: Commit**
```
git commit -am "feat(pricing): generalized no-candidate breaker recovery across CEX/oracle"
```

---

## Task 11: Surface `providerDiagnostics` + `gtProbe` on /api/status

**Files:**
- Modify: `worker/src/api/status-supplements.ts`
- Modify: `shared/types/status.ts` (add fields)
- Test: `worker/src/api/__tests__/status.test.ts`

**Context:** Binance/Jupiter/GT-probe diagnostics are persisted to `cron_runs.metadata` but never surfaced on `/api/status`. Add two new sections to the admin status response:
- `priceProviderDiagnostics`: most recent attempts per `(source, endpoint)` with sanitized snippet
- `gtProbe`: most recent run stats

- [ ] **Step 1: Write failing test** — mock `cron_runs` with a row containing `metadata.providerDiagnostics` + `metadata.gtProbe`. Assert specific shape:
```typescript
expect(status.priceProviderDiagnostics).toEqual(expect.arrayContaining([
  expect.objectContaining({ source: "binance", endpoint: expect.any(String), status: 403 }),
]));
expect(status.gtProbe).toEqual(expect.objectContaining({
  updatedCount: expect.any(Number),
  budgetExhausted: expect.any(Boolean),
  transports: expect.any(Object),
}));
```
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Extend status-supplements:**
```typescript
const latestMeta = parseJsonSafely<Record<string, unknown>>(latestRun?.metadata);
response.priceProviderDiagnostics = latestMeta?.providerDiagnostics ?? [];
response.gtProbe = latestMeta?.gtProbe ?? null;
```
Add fields to the TypeScript shape and ensure sanitized-snippet truncation is preserved.

- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run status tests**
```
cd worker && npx vitest run src/api/__tests__/status.test.ts
```
- [ ] **Step 6: Commit**
```
git commit -am "feat(pricing): surface providerDiagnostics + gtProbe on /api/status"
```

---

# PHASE 3 — Consensus tightening

---

## Task 12: Require hard-source corroboration for single promoted DEX protocol

**Files:**
- Modify: `worker/src/lib/primary-price-collector.ts`
- Test: extend `worker/src/lib/__tests__/primary-price-collector.test.ts` (or create if absent)

**Context:** `hasDexCorroboration` at lines 228-237 accepts any non-DEX source that agrees within 50 bps. When the non-DEX corroborator is itself a soft aggregator (CG, DL-list), the confirmation is weak — soft aggregators can indirectly pull from the same pool liquidity as the DEX observation. Tighten to require a hard-source corroborator:

- [ ] **Step 1: Write failing test** — single promoted DEX protocol + only soft-aggregator agreement → DEX source rejected; single promoted DEX + hard CEX agreement → DEX source accepted.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement:**
```typescript
const hardTrustTiers = new Set(["hard_market", "hard_oracle", "hard_protocol"]);
const hasHardCorroborator = sources.some((source) => {
  const tier = getPricingSourceRegistryEntry(source.source)?.trustTier;
  return tier != null && hardTrustTiers.has(tier);
});
const hasDexCorroboration =
  promotedDexProtocolSources.length > 1 ||
  sources.length === 0 ||
  (hasHardCorroborator && promotedDexProtocolSources.some((dexSource) =>
    sources.some((source) => {
      const tier = getPricingSourceRegistryEntry(source.source)?.trustTier;
      return tier != null && hardTrustTiers.has(tier) && pricesAgreeWithinBps(dexSource.price, source.price, divergenceThresholdBps);
    })
  ));
```

- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run full primary-price-collector test**
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): single promoted DEX protocol requires hard-source corroboration"
```

---

## Task 13: Exclude NAV tokens from pool challenge

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (applyPoolChallenge)
- Test: extend `worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 1: Write failing test** — NAV asset (`pegType: undefined`, `navToken: true`) with diverging pool prices is NOT downgraded.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: In `applyPoolChallenge`,** pass the `assets` array (or a `navTokenSet: Set<string>`) into the function and after the `pegType` lookup, use the asset's explicit `navToken` flag (already used by `buildPriceValidationContext`) rather than inferring from the peg name:
```typescript
if (navTokenAssetIds.has(assetId)) continue;
```
Caller at the fetchPrimaryPrices site already has the asset list; build `navTokenAssetIds = new Set(assets.filter(a => a.navToken).map(a => a.id))` before invoking `applyPoolChallenge` and pass it in. If changing the signature is undesirable, accept a `Map<string, boolean>` of nav-token flags and delegate to the same `buildPriceValidationContext(...).navToken` derivation.
- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run enrich-prices tests**
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): exclude NAV tokens from pool challenge"
```

---

## Task 14: Tier-aware cluster tie-break before spread/proximity

**Files:**
- Modify: `worker/src/lib/price-consensus.ts`
- Test: extend `worker/src/lib/__tests__/price-consensus.test.ts`

**Context:** `pickWinningCluster` currently ranks equal-size clusters by: total weight → tighter spread → proximity to peg → alphabetical. A soft 2-pair (CG+DL) can beat a hard 2-pair (Pyth+Kraken) when proximity is tight. Introduce a tier-tier tie-break before spread:

- [ ] **Step 1: Write failing test** that would not trivially pass from alphabetical label formatting:
```typescript
it("prefers hard-tier cluster over equal-size-equal-weight soft cluster", () => {
  // Two clusters of exactly size 2 and total weight 3 each:
  //   soft: coingecko(w=2)+defillama-list(w=1)  at 1.000
  //   hard: pyth(w=2)+binance(w=1)              at 0.992
  // Equal size AND equal weight → tiebreak: hard tier wins.
  const softA = { source: "coingecko", price: 1.000, weight: 2 };
  const softB = { source: "defillama-list", price: 1.000, weight: 1 };
  const hardA = { source: "pyth", price: 0.992, weight: 2 };
  const hardB = { source: "binance", price: 0.992, weight: 1 };
  const consensus = computePriceConsensus([softA, softB, hardA, hardB], 1.0, 50, { mode: "fixed" });
  expect(consensus!.agreeSources.sort()).toEqual(["binance", "pyth"]);
  expect(consensus!.agreeSources).not.toContain("coingecko");
  expect(consensus!.agreeSources).not.toContain("defillama-list");
  expect(consensus!.price).toBeCloseTo(0.992, 5);
});
```
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: In `pickWinningCluster`**, after the total-weight tiebreak, add:
```typescript
const tierRank = (cluster: Cluster) => {
  const tiers = cluster.members.map((m) => getPricingSourceRegistryEntry(m.source)?.trustTier ?? "soft_aggregator");
  const anyHard = tiers.some((t) => t === "hard_market" || t === "hard_oracle" || t === "hard_protocol");
  const allSoft = tiers.every((t) => t === "soft_aggregator" || t === "soft_dex");
  return anyHard ? 2 : allSoft ? 0 : 1;
};
if (tierRank(a) !== tierRank(b)) return tierRank(b) - tierRank(a);
```
- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run full price-consensus tests**
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): cluster tiebreak prefers hard-tier over soft-tier"
```

---

## Task 15: GT-probe rejection fallback — downgrade pre-GT primary when GT consensus rejected

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/pricing.ts` (applyGtProbeResults → applyPrimaryCandidate rejection branch)
- Test: extend `worker/src/cron/__tests__/enrich-prices.test.ts` (GT probe block)

**Context:** When `applyPrimaryCandidate` rejects a GT-enriched consensus (e.g., temporal-jump), the asset keeps the pre-GT single-source soft price, losing the GT divergence evidence. Conservatively: on GT-enriched result rejection, downgrade the pre-GT primary `confidence` to `low`.

- [ ] **Step 1: Write failing test** — pre-GT is `single-source`; GT probe shows 800 bps divergence triggering temporal-jump-quarantine; GT consensus rejected; resulting asset confidence should be `low` (not `single-source`).
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: In `applyGtProbeResults`**, when `applyPrimaryCandidate` rejects, mark the asset's `priceConfidence = "low"`:
```typescript
const applied = applyPrimaryCandidate({ ... });
if (!applied.accepted && primaryResult.confidence === "single-source") {
  asset.priceConfidence = "low";
  primaryResult.confidence = "low";
  stats.singleSource--;
  stats.low++;
  console.warn(`[sync-stablecoins] GT probe evidence rejected; downgrading ${asset.id} to low-confidence (reason=${applied.rejectionReason})`);
}
```
- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run enrich-prices + post-enrichment**
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): downgrade to low-confidence when GT-probe evidence rejected but differs from pre-GT"
```

---

## Task 16: Replace hardcoded source names in post-consensus hardening with registry flags

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (applyPrimaryPostConsensusHardening)
- Modify: `shared/lib/pricing-source-registry-types.ts` (add `isListAggregator` flag)
- Modify: `shared/lib/pricing-source-registry-aggregators.ts` (set flag on `coingecko`, `defillama`, `defillama-list`)
- Test: extend relevant test block

**Context:** Today the hardening rule matches `s === "coingecko" || s === "defillama-list"` literally. The registry's existing `trustTier: "soft_aggregator"` also covers `defillama` (detail endpoint) and `coingecko-mirror`, so a naive switch to `trustTier === "soft_aggregator"` expands the downgrade rule to 2-source clusters that pair any two of {coingecko, defillama, defillama-list, coingecko-mirror, coingecko-native-implied}. That may or may not be desired. Keep the original rule's narrow scope by introducing an explicit `isListAggregator: true` flag on the three *list-style* aggregator sources (`coingecko`, `defillama`, `defillama-list`) and checking the flag in the hardening pass. This is behavior-preserving for the historical CG+DL-list case and adds explicit coverage for CG+DL-detail (which IS the same tautology problem — DL detail also re-exports CG data). `coingecko-mirror` is excluded because it is intentionally the "mirror" of the primary CG feed and is gated elsewhere. `coingecko-native-implied` is not list-aggregator and remains out of scope.

- [ ] **Step 1: Add `isListAggregator?: boolean`** to `PricingSourceRegistryEntry` in `shared/lib/pricing-source-registry-types.ts`.
- [ ] **Step 2: Set `isListAggregator: true`** on the three entries (`coingecko`, `defillama`, `defillama-list`) in `shared/lib/pricing-source-registry-aggregators.ts`.
- [ ] **Step 3: Write a failing test** for the CG + defillama-list scenario that already works AND for the CG + defillama (detail) scenario that newly falls under the rule:
```typescript
it("downgrades 2-source list-aggregator clusters even when detail endpoint is the second voice", () => {
  const sources = [
    { source: "coingecko", price: 1.0, weight: 2 },
    { source: "defillama", price: 1.0, weight: 1 },
  ];
  const consensus = computePriceConsensus(sources, 1.0, 50, { mode: "fixed" });
  expect(consensus!.confidence).toBe("single-source");
});
```
- [ ] **Step 4: Run — FAIL.**
- [ ] **Step 5: Change hardcoded list check to registry-based:**
```typescript
const allListAggregator = cluster.members.every((m) => {
  return getPricingSourceRegistryEntry(m.source)?.isListAggregator === true;
});
if (cluster.members.length === 2 && allListAggregator) {
  result.confidence = "single-source";
  // ...
}
```
- [ ] **Step 6: Run test — PASS.**
- [ ] **Step 7: Run enrich-prices + price-consensus tests.**
- [ ] **Step 8: Commit.**
```
git commit -am "refactor(pricing): post-consensus list-aggregator hardening uses explicit registry flag"
```

---

# PHASE 4 — Source improvements

---

## Task 17: RedStone batch retry budget

**Files:**
- Modify: `worker/src/lib/redstone.ts`
- Test: `worker/src/lib/__tests__/redstone.test.ts`

**Context:** Worst-case 21 sequential solo retries consume 157s wall clock and 21 connections from the 6-connection per-trigger pool. Add a 5-request retry budget + 100ms sleep between retries.

- [ ] **Step 1: Write failing test** — simulate batch that drops 10 symbols; assert max 5 solo retries fire.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement:**
```typescript
const REDSTONE_RETRY_BUDGET = 5;
const REDSTONE_RETRY_SLEEP_MS = 100;
let retries = 0;
for (const symbol of missingSymbols) {
  if (retries >= REDSTONE_RETRY_BUDGET) break;
  retries++;
  await sleepWithSignal(REDSTONE_RETRY_SLEEP_MS, signal);
  const single = await fetchRedstoneBatch([symbol], signal);
  // ...
}
```
- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run redstone tests**
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): bound RedStone solo-retry budget to 5 requests"
```

---

## Task 18: RedStone array-branch safety test (future-proof)

**Files:**
- Modify: `worker/src/lib/redstone.ts`
- Test: `worker/src/lib/__tests__/redstone.test.ts`

**Context:** The live RedStone `/prices` endpoint currently returns a per-symbol object (non-array). The Zod schema accepts `RedstoneEntry | RedstoneEntry[]` because the API *could* ship arrays for some provider modes. Today's `normalizeEntry` picks `entry[0]`; we cannot empirically verify whether `[0]` is newest or oldest because the current API does not ship arrays. This task adds a safety test (not a behavioral fix) that pins the documented intent — "if arrays ever arrive, pick the entry with the largest `timestamp`" — and converts `normalizeEntry` accordingly. If the API ships arrays in the future, this test fails fast and the behavior stays correct.

- [ ] **Step 1: Write a forward-looking test** asserting newest-by-timestamp selection given a synthetic array response:
```typescript
it("selects the newest entry when array responses are returned", () => {
  const arrayResponse = {
    USDT: [
      { value: 0.999, timestamp: 1_700_000_000_000, source: { binance: 0.999 } },
      { value: 1.000, timestamp: 1_700_000_600_000, source: { binance: 1.000 } },
    ],
  };
  const entry = normalizeEntry(arrayResponse.USDT);
  expect(entry?.timestamp).toBe(1_700_000_600_000);
  expect(entry?.value).toBe(1.000);
});
```
- [ ] **Step 2: Run — FAIL** (current code returns `[0]` which is the older entry).
- [ ] **Step 3: Change `normalizeEntry`** to sort by timestamp descending before returning `[0]`:
```typescript
if (Array.isArray(entry)) {
  if (entry.length === 0) return null;
  return [...entry].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
}
```
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.**
```
git commit -am "fix(pricing): RedStone normalizeEntry picks newest entry from array responses"
```

---

## Task 19: Binance retry amplification fix — short-circuit on 5xx to next URL

**Files:**
- Modify: `worker/src/lib/cex-tickers.ts` (`fetchBinanceTickerUrl` + caller)
- Test: `worker/src/lib/__tests__/cex-tickers.test.ts`

**Context:** Today a 5xx on `data-api.binance.vision` sleeps Retry-After then retries the same host before ever trying `api.binance.com`. With `CEX_REQUEST_RETRIES = 1` this becomes 4 fetches per run — up to ~30s. Change policy: on 5xx / 429 treat the host as failed immediately, jump to the next host; retry only within the same host for transient network errors.

- [ ] **Step 1: Write failing test** — first fetch returns 503; expect NO Retry-After sleep; expect second fetch against `api.binance.com` (not `data-api.binance.vision`).
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Restructure** to skip per-host retry on HTTP 5xx/429/403/451 — only retry the same host for a catchable network error (`fetch` throw).
- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run cex-tickers tests**
- [ ] **Step 6: Commit**
```
git commit -am "fix(pricing): Binance skips to next host on 5xx/429 instead of retrying same host"
```

---

## Task 20: Parallelize FX secondary candidate fetches

**Files:**
- Modify: `worker/src/cron/sync-fx-rates-sources.ts`
- Test: extend `worker/src/cron/__tests__/sync-fx-rates.test.ts`

**Context:** `fetchSecondaryCurrencyCandidate("jsdelivr", …)` and `fetchSecondaryCurrencyCandidate("pages.dev", …)` are independent mirrors run sequentially. Parallelize.

- [ ] **Step 1: Write test** asserting both fetches fire concurrently (record call timestamps, assert both started within 20ms).
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Replace sequential awaits with:**
```typescript
const [jsdelivrResult, pagesDevResult] = await Promise.all([
  fetchSecondaryCurrencyCandidate("jsdelivr", ...),
  fetchSecondaryCurrencyCandidate("pages.dev", ...),
]);
```
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit**
```
git commit -am "perf(pricing): parallelize FX secondary-currency candidate fetches"
```

---

## Task 21: Upgrade CEX upstream-timestamp support (Bitstamp/Coinbase/Kraken)

**Files:**
- Modify: `worker/src/lib/cex-tickers.ts` (extract `timestamp`/`time` per-pair)
- Modify: `shared/lib/pricing-source-registry-market-feeds.ts` (flip `supportsUpstreamObservedAt: true` for the three providers)
- Modify: `worker/src/lib/primary-price-collector.ts` (pass upstream timestamp + mode)
- Test: extend `cex-tickers.test.ts` and `primary-price-collector.test.ts`

- [ ] **Step 1: Write failing test** for each: mocked response includes `timestamp`/`time`; parser should return per-pair observed-at; collector should stamp `observedAtMode: "upstream"`.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Extract timestamp:**

Kraken: `result.timestamp` is not standard; use `Date.now()` only when unavailable. Actually Kraken `/0/public/Ticker` does not return per-pair UNIX; **skip Kraken (keep local_fetch)** and only upgrade Bitstamp/Coinbase.

Bitstamp: `timestamp` (UNIX seconds, already per-pair).
Coinbase: `time` (ISO string) — convert to UNIX seconds.

- [ ] **Step 4: Plumb through primary collector** — set `bitstampObservedAt` / `coinbaseObservedAt` per-coin and `observedAtMode: "upstream"` at the registry level.
- [ ] **Step 5: Run tests — PASS**
- [ ] **Step 6: Commit**
```
git commit -am "feat(pricing): Bitstamp + Coinbase publish upstream-observed timestamps"
```

---

## Task 22: Curve on-chain block-timestamp freshness stamp

**Files:**
- Modify: `worker/src/lib/curve-onchain.ts` (accept and surface block timestamp)
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (record block timestamp)
- Modify: `shared/lib/pricing-source-registry-special.ts` (flip `freshnessKind: "upstream"`, `maxTrustedAgeSec: 300`)
- Test: extend `curve-onchain.test.ts`

**Context:** Today Curve on-chain `get_dy` uses `"latest"` block and is stamped `local_fetch`. Like curve-oracle, fetch the block number + timestamp of the call; stamp `observedAt` with block timestamp and mode `upstream`.

- [ ] **Step 1: Write failing test:** RPC returns block timestamp 60s ago; assert curve-onchain outcome carries `observedAt: blockTimestamp`.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement parallel fetch of `eth_blockNumber` → `eth_getBlockByNumber`; stamp price with block timestamp; reject when `now - blockTimestamp > 300`.**
- [ ] **Step 4: Run test — PASS**
- [ ] **Step 5: Run curve tests**
- [ ] **Step 6: Commit**
```
git commit -am "feat(pricing): curve-onchain stamps upstream freshness from block timestamp"
```

---

## Task 23: Chainlink dRPC legacy path + per-feed health tracking

**Files:**
- Modify: `worker/src/lib/chainlink-feeds.ts`
- Modify: `worker/src/cron/sync-fx-rates.ts` (persist per-feed counters)
- Test: extend `chainlink-feeds.test.ts`

- [ ] **Step 1: Remove dRPC legacy entry** (lines 118-122) since public dRPC is healthier; reorder to dRPC-premium → dRPC-public → shared RPC pool → Etherscan.
- [ ] **Step 2: Add per-feed success/fail counter** in the snapshot returned by `fetchChainlinkReferenceFeeds`; log when any one feed has been failing > 3 runs.
- [ ] **Step 3: Write test** for the counter.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit**
```
git commit -am "refactor(pricing): simplify Chainlink dRPC cascade + per-feed health counters"
```

---

# PHASE 5 — Test coverage expansion

---

## Task 24: Unit tests for `buildPreviousTrustedPriceLookup`

**Files:**
- Create: `worker/src/cron/sync-stablecoins/__tests__/previous-trusted-price-lookup.test.ts` (or co-located with other cron tests)

**Context:** Central to severe-depeg continuity. Only tested via end-to-end paths; invariants unspecified.

- [ ] **Step 1: Write 6-case test suite:**
  1. Cache-only carried-forward (no replay row) → cache wins.
  2. Replay-only carried-forward (no previous cache) → replay wins.
  3. Both present: replay has later `observedAt` → replay wins.
  4. Both present: previous cache has later `observedAt` → cache wins.
  5. Cache is `low`-confidence (non-authoritative) → replay wins regardless of observedAt.
  6. Both equal `observedAt` → deterministic (document which wins and why).

Example (first case):
```typescript
it("returns cache row when replay cache has no matching entry", async () => {
  const previousCache = { usdc: { price: 1.0, priceSource: "coingecko", priceConfidence: "high", priceObservedAt: 1000, priceObservedAtMode: "upstream" } };
  const replay = new Map(); // empty
  const lookup = buildPreviousTrustedPriceLookup({ previousCache, replay });
  expect(lookup.get("usdc")).toEqual(expect.objectContaining({ price: 1.0, source: "coingecko" }));
});
```

- [ ] **Step 2: Run — 6 tests, initially expect 1-2 FAIL if semantics differ from docs.**
- [ ] **Step 3: Fix any discrepancies** or document them in the test names.
- [ ] **Step 4: Commit**
```
git commit -am "test(pricing): unit tests for buildPreviousTrustedPriceLookup"
```

---

## Task 25: Unit tests for `shouldQuarantineTemporalJump`

**Files:**
- Create: `worker/src/lib/__tests__/temporal-jump-quarantine.test.ts`

- [ ] **Step 1: Write 6-branch test suite** — each branch of `shouldQuarantineTemporalJump` in `price-publish-policy.ts:109-139`:
  - authoritative-agreement bypass
  - soft-guardrail exempt source bypass
  - corroborated severe-downside bypass
  - mid-price <= 0 (returns false)
  - moveBps below `WEAK_FIXED_PEG_JUMP_QUARANTINE_BPS` boundary
  - moveBps at/above the threshold

- [ ] **Step 2: Run — PASS**
- [ ] **Step 3: Commit**
```
git commit -am "test(pricing): unit tests for temporal-jump quarantine decision"
```

---

## Task 26: Unit tests for `applyProtocolPriceOverrides`

**Files:**
- Create: `worker/src/cron/sync-stablecoins/__tests__/protocol-override-application.test.ts`

- [ ] **Step 1: Write 4-case test suite:**
  1. Override accepted (no divergence) → asset price + source updated; no warn.
  2. Override accepted with >100 bps divergence from primary consensus → warn logged, override still applies.
  3. Override fails `validatePrimaryPriceCandidate` (e.g., out of peg-aware bounds) → asset untouched.
  4. Override missing `observedAt` → stamped with `syncStartSec`.

- [ ] **Step 2: Run — PASS**
- [ ] **Step 3: Commit**
```
git commit -am "test(pricing): unit tests for applyProtocolPriceOverrides"
```

---

## Task 27: Unit tests for `getPrimaryCandidatePricesForCurrentAsset`

**Files:**
- Create: `worker/src/cron/sync-stablecoins/__tests__/primary-candidate-carry-through.test.ts`

- [ ] **Step 1: Write 5-invariant test suite** — each invariant at `pricing.ts:193-204`:
  - same ID
  - same source string
  - same confidence
  - price within 1e-9 tolerance → allPrices returned
  - price outside tolerance → returns undefined
- [ ] **Step 2: Run — PASS**
- [ ] **Step 3: Commit**
```
git commit -am "test(pricing): unit tests for primary-candidate carry-through invariants"
```

---

## Task 28: Defense-in-depth test for `healNullPrices`

**Files:**
- Modify: `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`

- [ ] **Step 1: Write test** ensuring a rogue `price_cache` row with `source = "dexscreener-search"` (non-replay-safe) is NOT used to heal mint/burn events — complement to Task 5.
- [ ] **Step 2: Run — (should PASS after Task 5 implementation)**
- [ ] **Step 3: Commit**
```
git commit -am "test(pricing): defense-in-depth heal rejects non-replay-safe sources"
```

---

## Task 29: Pool challenge boundary tests + observedAt propagation

**Files:**
- Modify: `worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 1: Add 5 boundary tests to the `applyPoolChallenge` describe block:**
  - Exactly at USD threshold (500 bps) → downgrade (inclusive boundary).
  - Exactly below USD threshold (499 bps) → no downgrade.
  - Non-USD peg (JPY) — exactly at 300 bps threshold → downgrade.
  - Exactly 2 protocols at boundary → replacement fires.
  - Replacement `observedAt` = min of pool `observedAt`s.

- [ ] **Step 2: Run — PASS (with Task 1's allPrices fix already in).**
- [ ] **Step 3: Commit**
```
git commit -am "test(pricing): pool challenge boundary + observedAt propagation coverage"
```

---

## Task 30: Real-API fixtures + registry↔policy contract test

**Files:**
- Create: `worker/src/lib/__tests__/fixtures/coinbase-ticker.json`
- Create: `worker/src/lib/__tests__/fixtures/pyth-hermes.json`
- Create: `worker/src/lib/__tests__/fixtures/redstone-batch.json`
- Modify: tests to replace hand-crafted mocks with the fixtures
- Create: `shared/lib/__tests__/pricing-source-registry-policy-contract.test.ts`

- [ ] **Step 1: Capture fixtures** — run `curl` at the project root for:
  - `curl -s 'https://api.exchange.coinbase.com/products/USDT-USD/ticker'`
  - `curl -s 'https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=<USDT_FEED>'`
  - `curl -s 'https://api.redstone.finance/prices?provider=redstone-primary-prod&symbols=USDT'`
  Save responses as JSON fixtures.
- [ ] **Step 2: Rewire existing tests to load fixtures** (`import fixture from "./fixtures/coinbase-ticker.json"`) in place of handcrafted literals.
- [ ] **Step 3: Write contract test** asserting, for every `PRICING_SOURCE_REGISTRY` entry:
```typescript
expect(isReplaySafePriceSource(entry.key)).toBe(entry.isReplaySafe);
expect(isPoolChallengeEligibleConsensus([entry.key])).toBe(!entry.isPoolChallengeExempt);
```
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit**
```
git add worker/src/lib/__tests__/fixtures/*.json worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/pyth.test.ts worker/src/lib/__tests__/redstone.test.ts shared/lib/__tests__/pricing-source-registry-policy-contract.test.ts
git commit -m "test(pricing): real-API fixtures + registry↔policy contract test"
```

---

# PHASE 6 — Simplicity & maintainability

---

## Task 31: Fold `applyGtProbeResults` + `applyPrimaryPriceResults` into `applyConsensusResults`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/pricing.ts`
- Modify: `worker/src/cron/sync-stablecoins/stages.ts`
- Test: run existing tests

**Context:** Both functions are near-identical except for `requiredCandidateSource: "geckoterminal"` and a rejection label. Collapse into one `applyConsensusResults({ ..., reason, requiredCandidateSource })`.

- [ ] **Step 1: Extract shared implementation into `applyConsensusResults`.**
- [ ] **Step 2: Replace call sites** (2 in stages.ts).
- [ ] **Step 3: Run enrich-prices + post-enrichment tests.**
- [ ] **Step 4: Commit**
```
git commit -am "refactor(pricing): fold applyPrimaryPriceResults + applyGtProbeResults into applyConsensusResults"
```

---

## Task 32: `SOURCE_TO_CIRCUIT` canonical map + compile-time drift check

**Files:**
- Modify: `worker/src/lib/constants.ts` (or new `worker/src/lib/pricing-circuit-map.ts`)
- Test: `worker/src/lib/__tests__/pricing-circuit-map.test.ts`

**Context:** `CIRCUIT_SOURCE` keys and `PRICING_SOURCE_REGISTRY` entries currently share no linkage. `CIRCUIT_SOURCE.DL_COINS` was a dead key until Task 8. `CIRCUIT_SOURCE.DRPC` is still dead. Build a single canonical map and a CI test that fails if a registry entry is ever introduced without a corresponding breaker (when one is expected) or vice-versa.

**Context:** The authoritative registry keys are: `coingecko, coingecko-native-implied, defillama, defillama-list, coingecko-mirror, dex-promoted, fluid-dex, balancer-dex, raydium-dex, orca-dex, jupiter, coinmarketcap, dexscreener, cg-ticker, geckoterminal, pyth, binance, kraken, bitstamp, coinbase, redstone, curve-onchain, curve-oracle, defillama-contract, protocol-redeem, pool-tvl-weighted, cached`. The authoritative breaker constants (from `constants.ts`) are: `DL_STABLECOINS, DL_STABLECOIN_DETAIL, DL_COINS, DL_YIELDS, DL_PROTOCOLS, CG_PRICES, CG_DETAIL_PLATFORMS, CG_MCAP, CG_DISCOVERY, DEXSCREENER_PRICES, DEXSCREENER_SEARCH, CMC_PRICES, ..., PYTH_PRICES, BINANCE_PRICES, KRAKEN_PRICES, BITSTAMP_PRICES, COINBASE_PRICES, REDSTONE_PRICES, CURVE_ONCHAIN, CURVE_LIQUIDITY_API, FX_FRANKFURTER, FX_REALTIME, CHAINLINK_FEEDS, JUPITER_PRICES, GECKO_TERMINAL_PROBE, FLUID_DEX_API, BALANCER_API, RAYDIUM_API, ORCA_API, METEORA_API, PANCAKESWAP_API, AERODROME_SLIPSTREAM_API, VELODROME_SLIPSTREAM_API, CG_TICKER`. Note: Meteora/PancakeSwap/Slipstream are DEX-liquidity sources, not primary-consensus sources. `dexscreener-search` exists as a breaker constant but is NOT a registry key (the registry has `dexscreener` only; the search lane is internal to the DexScreener fallback pass). The map below reflects only keys that ARE in the registry.

- [ ] **Step 1: Define map** — one row per registry key, with explicit `null` for synthesized/composite/cached sources that don't have a direct outbound fetcher:
```typescript
export const PRICING_SOURCE_TO_CIRCUIT: Record<string, string | null> = {
  // aggregators
  "coingecko": CIRCUIT_SOURCE.CG_PRICES,
  "coingecko-native-implied": CIRCUIT_SOURCE.CG_PRICES, // shares CG simple-price breaker
  "coingecko-mirror": CIRCUIT_SOURCE.CG_PRICES,
  "defillama": CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL,
  "defillama-list": CIRCUIT_SOURCE.DL_STABLECOINS,
  // dex-search
  "dex-promoted": null, // synthesized aggregate of promoted DEX pool prices
  "fluid-dex": CIRCUIT_SOURCE.FLUID_DEX_API,
  "balancer-dex": CIRCUIT_SOURCE.BALANCER_API,
  "raydium-dex": CIRCUIT_SOURCE.RAYDIUM_API,
  "orca-dex": CIRCUIT_SOURCE.ORCA_API,
  "jupiter": CIRCUIT_SOURCE.JUPITER_PRICES,
  "coinmarketcap": CIRCUIT_SOURCE.CMC_PRICES,
  "dexscreener": CIRCUIT_SOURCE.DEXSCREENER_PRICES,
  // market-feeds
  "cg-ticker": CIRCUIT_SOURCE.CG_TICKER,
  "geckoterminal": CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
  "pyth": CIRCUIT_SOURCE.PYTH_PRICES,
  "binance": CIRCUIT_SOURCE.BINANCE_PRICES,
  "kraken": CIRCUIT_SOURCE.KRAKEN_PRICES,
  "bitstamp": CIRCUIT_SOURCE.BITSTAMP_PRICES,
  "coinbase": CIRCUIT_SOURCE.COINBASE_PRICES,
  "redstone": CIRCUIT_SOURCE.REDSTONE_PRICES,
  "curve-onchain": CIRCUIT_SOURCE.CURVE_ONCHAIN,
  "curve-oracle": CIRCUIT_SOURCE.CURVE_ORACLE,
  // special
  "defillama-contract": CIRCUIT_SOURCE.DL_COINS,
  "protocol-redeem": null, // in-process EVM call via shared chain RPC pool
  "pool-tvl-weighted": null, // synthesized post-challenge replacement
  "cached": null, // read from price_cache; no outbound fetch
} as const;
```

- [ ] **Step 2: Write contract test**:
```typescript
import { PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import { CIRCUIT_SOURCE } from "../constants";
import { PRICING_SOURCE_TO_CIRCUIT } from "../pricing-circuit-map";

it("every registry source has an entry in PRICING_SOURCE_TO_CIRCUIT", () => {
  for (const entry of PRICING_SOURCE_REGISTRY) {
    expect(PRICING_SOURCE_TO_CIRCUIT).toHaveProperty(entry.key);
  }
});
it("every mapped breaker value exists in CIRCUIT_SOURCE", () => {
  const circuitValues = new Set(Object.values(CIRCUIT_SOURCE));
  for (const value of Object.values(PRICING_SOURCE_TO_CIRCUIT)) {
    if (value == null) continue;
    expect(circuitValues).toContain(value);
  }
});
it("PRICING_SOURCE_TO_CIRCUIT has no keys missing from registry", () => {
  const registryKeys = new Set(PRICING_SOURCE_REGISTRY.map((e) => e.key));
  for (const key of Object.keys(PRICING_SOURCE_TO_CIRCUIT)) {
    expect(registryKeys).toContain(key);
  }
});
```

- [ ] **Step 3: Remove dead `CIRCUIT_SOURCE.DRPC`** (constants.ts line 169). Grep confirms no writers; a fresh grep must pass before removal.

- [ ] **Step 4: Run test — PASS.**
- [ ] **Step 5: Commit.**
```
git commit -am "refactor(pricing): canonical SOURCE_TO_CIRCUIT map + contract test"
```

**Dependency note:** This task depends on Task 3 landing `CIRCUIT_SOURCE.CURVE_ORACLE` and Task 8 wiring `CIRCUIT_SOURCE.DL_COINS`. Run this task AFTER both.

---

## Task 33: Dedupe `buildPriceValidationContext` via `ValidationContextResolver`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (3 call sites)
- Test: existing tests remain

**Context:** `pricing.ts` already has a `ValidationContextResolver` that memoizes. The primary-pricing path bypasses it at lines ~401-406, ~888, ~970-975. Route through the resolver.

- [ ] **Step 1: Accept a `validationContexts: Map<string, PriceValidationContext>` parameter** in the relevant primary helpers, or thread the resolver through.
- [ ] **Step 2: Replace the 3 `buildPriceValidationContext({...})` calls** with `validationContexts.get(assetId) ?? buildPriceValidationContext({...})` (with cache insertion on miss).
- [ ] **Step 3: Run enrich-prices tests — PASS**
- [ ] **Step 4: Commit**
```
git commit -am "refactor(pricing): reuse ValidationContextResolver in primary path"
```

---

## Task 34: Extract `fetchCoingeckoSimplePrices()` helper

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` (extract ~60 lines)
- New helper location: `worker/src/lib/coingecko-simple-price.ts` (new file)
- Test: extend or add tests around the helper

**Context:** The inline CG `/simple/price` block in `fetchPrimaryPrices` is ~60 lines embedded in the orchestrator with ad-hoc breaker accounting. Mirror the other providers by extracting into its own helper returning `FetcherOutcome<...>` (from Task 6).

- [ ] **Step 1: Create `worker/src/lib/coingecko-simple-price.ts`** with signature:
```typescript
export async function fetchCoingeckoSimplePrices(
  geckoIds: string[],
  coingeckoApiKey: string | null,
  signal: AbortSignal | undefined,
  nowSec: number,
): Promise<FetcherOutcome<Map<string, { price: number; observedAt: number | null; observedAtMode: PriceObservedAtMode }>>>
```
Move the batching, upstream-timestamp parsing, staleness drop, and request shaping.

- [ ] **Step 2: Replace the inline call** in `fetchPrimaryPrices` with the new helper.
- [ ] **Step 3: Run enrich-prices + primary tests.**
- [ ] **Step 4: Commit**
```
git commit -am "refactor(pricing): extract fetchCoingeckoSimplePrices helper"
```

---

## Task 35: Dead code removal + constant hoist

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- Modify: `worker/src/lib/constants.ts`
- Modify: `worker/src/lib/authoritative-price-sources.ts`
- Modify: `shared/lib/pricing-pipeline-constants.ts` (new file if needed)

- [ ] **Step 1: Remove `softOnly` flag** from `PrimaryPriceResult` interface and all its `softOnly = true` assignments — verified no consumer.
- [ ] **Step 2: Hoist `DIVERGENCE_THRESHOLD_BPS = 50`** to a single named export (e.g., `shared/lib/pricing-pipeline-constants.ts`) and replace the call-site duplicates (primary-price-collector default + `runGtProbePass` inline `50`).
- [ ] **Step 3: Remove exports `CRVUSD_PRICE_AGGREGATOR` / `CRVUSD_PRICE_SELECTOR`** from `authoritative-price-sources.ts` (move to `curve-onchain.ts` or the caller's local constant — they're no longer protocol-redeem overrides).
- [ ] **Step 4: Ensure `CIRCUIT_SOURCE.DRPC`** deletion from Task 32 is complete; grep confirms no remaining uses.
- [ ] **Step 5: Run full suite:**
```
cd worker && npx vitest run
cd worker && npx tsc --noEmit
```
- [ ] **Step 6: Commit**
```
git commit -am "chore(pricing): remove dead code (softOnly, DRPC, stale exports); hoist divergence threshold"
```

---

# PHASE 7 — Documentation + methodology bump

---

## Task 36: Update `docs/pricing-pipeline.md`

**Files:**
- Modify: `docs/pricing-pipeline.md`

**Context:** Keep the canonical documentation in sync with the behavioral changes landed in Tasks 1-35.

- [ ] **Step 1: Update sections as follows:**
  - **Primary Consensus → Consensus Rules**: add tier-aware cluster tiebreak (Task 14).
  - **Pool Challenge**: clarify NAV exclusion (Task 13), update `allPrices` propagation (Task 1), document observedAt propagation (Task 29).
  - **Provider-Specific Normalization**: add per-source upstream-timestamp support changes (Task 21: Bitstamp / Coinbase), curve-onchain block-timestamp (Task 22), curve-oracle staleness (Task 3), Binance host short-circuit (Task 19).
  - **Authoritative Overrides**: no changes.
  - **Fallback Enrichment**: add DL /coins breaker (Task 8), DexScreener breakers in dex-liquidity/dex-discovery (Task 7).
  - **Timestamp Semantics**: no changes.
  - **Confidence Model**: add "GT-probe-rejection downgrade" note (Task 15).
  - **Update Rules**: no structural changes.
  - **File Index**: add `worker/src/lib/fetcher-result.ts`, `worker/src/lib/coingecko-simple-price.ts`, update `curve-onchain.ts` description.

- [ ] **Step 2: Commit**
```
git add docs/pricing-pipeline.md
git commit -m "docs(pricing): update canonical pricing-pipeline.md for v5.0 changes"
```

---

## Task 37: Methodology version bump to v5.0 + changelog + /methodology copy

**Files:**
- Modify: `shared/lib/pricing-pipeline-version.ts` (add v5.0 entry)
- Modify: `docs/pricing-pipeline-timeline.md` (prepend v5.0 section)
- Modify: `src/app/methodology/sections/core-sections-pricing.tsx` (public longform copy)
- Run: `npm run check:doc-counts` (if relevant)

**Context:** Aggregate the externally-visible changes (Tasks 1, 3, 7, 8, 9, 12, 13, 14, 15, 16, 17, 19, 21, 22) into one v5.0 changelog entry. The audit-depeg-history fix (Tasks 4a/4b) is admin-facing and does not require a public changelog entry. Simplicity / test / refactor tasks are internal and skipped.

- [ ] **Step 1: Add v5.0 entry to `shared/lib/pricing-pipeline-version.ts`:**
```typescript
{
  version: "5.0",
  title: "Pricing pipeline comprehensive hardening",
  date: "2026-04-17",
  effectiveAt: Math.floor(Date.now() / 1000),
  summary: "Closed consistency gaps in pool-challenge replacement, tightened breaker discipline across all pricing fetchers, promoted Bitstamp/Coinbase/Curve to upstream-timestamped freshness, and exposed provider diagnostics on the operator status surface.",
  impact: [
    "Pool challenge replacement now updates allPrices so severe-downside corroboration carry-through uses the replacement source",
    "curve-oracle now enforces a 5-minute on-chain staleness guard using block timestamp and has its own circuit breaker",
    "curve-onchain and Bitstamp / Coinbase now publish upstream-observed freshness instead of local-fetch",
    "NAV tokens are no longer subject to pool-challenge downgrade / replacement",
    "Cluster tiebreak now prefers hard-tier clusters over equal-weight soft-tier clusters before spread / peg proximity",
    "Two-source clusters composed only of list-style aggregators (coingecko, defillama, defillama-list) are now downgraded to single-source regardless of which two combine, closing the CG+defillama-detail tautology",
    "Replay cache enforces per-source max trusted age in addition to the composite 6-hour cap",
    "DefiLlama /coins contract-price fallback and DexScreener dex-liquidity / dex-discovery fallbacks now gate on and record against their own circuit breakers",
    "Single promoted DEX protocol now requires hard-source corroboration to enter primary consensus",
    "Binance short-circuits to the secondary host on HTTP 5xx / 429 instead of retrying the first host",
    "RedStone solo-retry is bounded to 5 requests per run and spaced to respect Worker connection budget",
    "GT-probe evidence rejection downgrades the pre-GT primary to low-confidence when divergence was significant",
    "Provider diagnostics and GT-probe statistics are now surfaced on /api/status for operator visibility",
  ],
  commits: [],
  reconstructed: false,
},
```

- [ ] **Step 2: Prepend a matching section** to `docs/pricing-pipeline-timeline.md`.

- [ ] **Step 3: Update `src/app/methodology/sections/core-sections-pricing.tsx`** with user-facing copy reflecting externally-visible changes (pool challenge replacement, curve-oracle staleness guard, NAV exclusion, breaker coverage, native-upstream timestamps for Bitstamp/Coinbase).

- [ ] **Step 4: Validate methodology version format:** per CLAUDE.md, numeric progression: v4.38 → v5.0 is correct.

- [ ] **Step 5: Run final merge gate:**
```
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm run test:merge-gate
```
Expected: PASS

- [ ] **Step 6: Commit**
```
git add shared/lib/pricing-pipeline-version.ts docs/pricing-pipeline-timeline.md src/app/methodology/sections/core-sections-pricing.tsx
git commit -m "feat(pricing): methodology v5.0 — comprehensive hardening"
```

---

# Self-review checklist

- [ ] **Spec coverage:** Every Critical (C1-C8), Major (9-17), and Minor dead-code (18-23) item from the audit summary maps to a task. Enhancement items (breakers impact-tier, Binance bookTicker, Chainlink USD feeds, Pyth weight logging) are intentionally deferred — see "Out of scope" below.
- [ ] **No placeholders:** every step contains actual code or a concrete command.
- [ ] **Type consistency:** `FetcherOutcome<T>` referenced in Tasks 6, 34, and callers; `PRICING_SOURCE_TO_CIRCUIT` referenced in Task 32.
- [ ] **TDD:** every behavioral task has a Step 1 failing test, Step 2 confirm-fail, implementation step(s), and re-run step.
- [ ] **Frequent commits:** one commit per task (37 commits).

---

# Out of scope (explicitly deferred)

The following enhancements surfaced during audit but were deliberately NOT included; they are standalone features rather than remediations and can be planned separately:

- **Chainlink USD stablecoin feeds** (USDT/USDC/DAI/USDP) — would add a new hard-oracle voice; valuable but new capability.
- **Binance `/bookTicker`** migration — upgrades to bid/ask + hasBidAsk=true; capability change.
- **Adding new CEX symbols** (USDG / PYUSD / RLUSD on Kraken/Coinbase/Bitstamp where newly listed) — coverage expansion.
- **Pyth weight-dropped logging** (`confidenceBps ≥ 250`) — observability improvement.
- **Trimmed-mean for commodity peer-median** — robustness polish, not a correctness gap.
- **Impact-tier classification in registry** — superseded by the `SOURCE_TO_CIRCUIT` map + existing `isPublicImpactCircuitKey` already covering the impact concern.
- **Stale-open breaker detection dashboard** — operator surface design; addressed implicitly by Task 11 surfacing diagnostics.

---

# Execution Handoff

Plan complete and saved to `agents/plans/2026-04-17-pricing-pipeline-remediation.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — one fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
