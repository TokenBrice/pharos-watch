import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichRaydiumStandardDiscoveryExecutionModels, parseRaydiumStandardDiscoveryPool } from "../raydium-standard-discovery";
import { initMetrics } from "../pool-helpers";
import type { PoolEntry } from "../types";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";

const POOL = "CiRnB72qMDkrdPe1sxc5gmqGALKmnFG5AMncK1UZoogs";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
function nativePool() {
  return {
    id: POOL, type: "Standard", programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    mintA: { address: USDC, symbol: "USDC", decimals: 6, programId: tokenProgram },
    mintB: { address: USDT, symbol: "USDT", decimals: 6, programId: tokenProgram },
    mintAmountA: 2_000_000, mintAmountB: 2_000_000, price: 1, tvl: 4_000_000, feeRate: 0.0025, day: { volume: 100_000 },
  };
}
function harness() {
  const pool: PoolEntry = { poolId: `solana:${POOL}`, project: "raydium", chain: "solana", symbol: "USDC / USDT", poolType: "cg-amm", source: "cg_onchain", tvlUsd: 4_000_000, volumeUsd1d: 100_000 };
  const metric = { ...initMetrics("usdc-circle", "USDC"), topPools: [pool] };
  const metrics = new Map([["usdc-circle", metric]]);
  const chainAddressToId = new Map([[`solana:${USDC}`, "usdc-circle"], [`solana:${USDT}`, "usdt-tether"]]);
  return { pool, metric, metrics, chainAddressToId, run: () => enrichRaydiumStandardDiscoveryExecutionModels({ metrics, chainAddressToId, stablecoinPriceById: new Map([["usdc-circle", 1], ["usdt-tether", 1]]), deadlineMs: Date.now() + 30_000 }) };
}
afterEach(() => vi.unstubAllGlobals());

describe("Raydium standard discovery identity", () => {
  it("retains standard provider diagnostics without changing TVL or making score evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: [nativePool()] }))));
    const h = harness();
    await h.run();
    expect(h.pool.extra?.ammExecutionModel).toMatchObject({ source: "raydium", invariant: "constant-product", trackedTokenIndex: 0, feeRate: 0.0025 });
    expect(h.pool.tvlUsd).toBe(4_000_000);
    expect(h.pool.poolId).toBe(`solana:${POOL}`);
    const observations = buildP4DexExitRouteObservations({ stablecoinId: "usdc-circle", observedAt: 1_791_241_200, retainedPools: [h.pool] });
    expect(observations.observations).toHaveLength(1);
    expect(observations.observations[0]).toMatchObject({ scoreEligible: false, confidence: "low" });
    expect(observations.coverage.scoreEligiblePoolCount).toBe(0);
  });

  it("cannot turn a fabricated counter-mint into exact score proof", async () => {
    const body = nativePool();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true,
      data: [{ ...body, mintB: { ...body.mintB, address: "11111111111111111111111111111111" } }] }))));
    const h = harness();
    await h.run();
    expect(h.pool.extra?.ammExecutionModel).toBeDefined();
    const result = buildP4DexExitRouteObservations({ stablecoinId: "usdc-circle", observedAt: 1_791_241_200, retainedPools: [h.pool] });
    expect(result.observations).toHaveLength(1);
    expect(result.observations.every((observation) => observation.scoreEligible === false && observation.confidence === "low")).toBe(true);
    expect(result.coverage.scoreEligibleObservationCount).toBe(0);
  });

  it.each([
    { type: "Concentrated" },
    { programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" },
    { hasDynamicFee: true },
    { feeRate: null },
    { mintAmountB: null },
    { config: { creatorFeeRate: 500 } },
  ])("does not infer CP equivalence from unsupported native state %j", (overrides) => {
    expect(parseRaydiumStandardDiscoveryPool({ ...nativePool(), ...overrides })).toBeNull();
  });

  it("rejects Token-2022 transfer-fee mints", () => {
    const pool = nativePool();
    expect(parseRaydiumStandardDiscoveryPool({ ...pool, mintB: { ...pool.mintB, programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" } })).toBeNull();
  });

  it("requires explicit zero creator fee and static fee for CPMM identity recovery", () => {
    const pool = { ...nativePool(), programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" };
    expect(parseRaydiumStandardDiscoveryPool(pool)).toBeNull();
    expect(parseRaydiumStandardDiscoveryPool({ ...pool, hasDynamicFee: false, config: { creatorFeeRate: 0 } })).not.toBeNull();
  });

  it.each(["duplicate-response", "different-pool", "different-input-mint", "case-changed-pool", "provider-failure", "concentrated"])("leaves identity unresolved for %s", async (reason) => {
    const body = nativePool();
    const rows = reason === "duplicate-response" ? [body, body] : reason === "different-pool" ? [{ ...body, id: USDT }] :
      reason === "different-input-mint" ? [{ ...body, mintA: { ...body.mintA, address: USDT } }] :
      reason === "case-changed-pool" ? [{ ...body, id: POOL.toLowerCase() }] :
      reason === "concentrated" ? [{ ...body, type: "Concentrated" }] : [body];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: reason !== "provider-failure", data: rows }))));
    const h = harness();
    await h.run();
    expect(h.pool.extra?.ammExecutionModel).toBeUndefined();
  });

  it("does not resolve duplicate retained identities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: [nativePool()] }))));
    const h = harness();
    h.metric.topPools.push({ ...h.pool });
    await h.run();
    expect(h.metric.topPools.every((pool) => pool.extra?.ammExecutionModel === undefined)).toBe(true);
  });
});
