import { afterEach, describe, it, expect, vi } from "vitest";
import * as rpc from "../../../lib/evm-rpc";
import { refreshTempoPathUsdPrice } from "../tempo-price";
import { classifyClPoolType } from "../direct-source-helpers";
import { QUALITY_MULTIPLIERS } from "../../../lib/dex-cron-constants";

describe("classifyClPoolType", () => {
  it("classifies PancakeSwap tiers 1/5/25/100 bp into distinct buckets", () => {
    for (const fee of [1, 5, 25, 100]) expect(classifyClPoolType("pancakeswap", fee)).toBe(`pancakeswap-v3-${fee}bp`);
  });
  it("Slipstream variants keep the existing 1/5/30 bp scheme (A6 deferred)", () => {
    for (const fee of [1, 5, 30]) expect(classifyClPoolType("aerodrome-slipstream", fee)).toBe(`aerodrome-slipstream-${fee}bp`);
    expect(classifyClPoolType("velodrome-slipstream", 5)).toBe("velodrome-slipstream-5bp");
  });
  it("classifies observed Slipstream 100 bp fees into their own bucket", () => {
    for (const protocol of ["aerodrome-slipstream", "velodrome-slipstream"] as const)
      expect(classifyClPoolType(protocol, 100)).toBe(`${protocol}-100bp`);
  });

  it("maps every fee-bearing bucket to an explicit quality multiplier", () => {
    const feeBearingBuckets = [
      ...([1, 5, 25, 30, 100] as const).map((fee) => classifyClPoolType("pancakeswap", fee)),
      ...([1, 5, 30, 100] as const).flatMap((fee) => [
        classifyClPoolType("aerodrome-slipstream", fee),
        classifyClPoolType("velodrome-slipstream", fee),
        classifyClPoolType("aero-slipstream", fee),
      ]),
    ];
    for (const bucket of feeBearingBuckets) {
      expect(Number.isFinite(QUALITY_MULTIPLIERS[bucket]), `${bucket} must have an explicit multiplier`).toBe(true);
    }
    expect(QUALITY_MULTIPLIERS["aerodrome-slipstream-100bp"]).toBe(0.4);
    expect(QUALITY_MULTIPLIERS["velodrome-slipstream-100bp"]).toBe(0.4);
    expect(QUALITY_MULTIPLIERS["aero-slipstream-100bp"]).toBe(0.4);
    expect(classifyClPoolType("aero-slipstream", 200)).toBe("aero-slipstream-100bp");
    expect(QUALITY_MULTIPLIERS["aero-stable"]).toBe(0.85);
    expect(QUALITY_MULTIPLIERS["aero-volatile"]).toBe(0.4);
  });

  it("publishes the neutral bucket instead of a fabricated tier for an unknown fee", () => {
    for (const fee of [null, undefined, 0]) expect(classifyClPoolType("pancakeswap", fee)).toBe("pancakeswap-v3-unknown-fee");
    expect(classifyClPoolType("aerodrome-slipstream", null)).toBe("aerodrome-slipstream-unknown-fee");
    expect(classifyClPoolType("velodrome-slipstream", Number.NaN)).toBe("velodrome-slipstream-unknown-fee");
  });
});

const word = (n: string | number) => `0x${BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0")}`;
const path = "0x20c0000000000000000000000000000000000000";
const ousd = "0x20c0000000000000000000006a37da5c996874be";
const usdt = "0x20c00000000000000000000014f22ca97301eb73";
const book = (base: string, quote: string, ask = 20) => word(base) + word(quote).slice(2) + word(-10).slice(2) + word(ask).slice(2);
afterEach(() => vi.restoreAllMocks());
it.each(["observed", "stale-quote", "wrong-book", "malformed", "runtime", "reorg", "quote-failed", "zero", "inverted", "crossed"])("Tempo native capture: %s", async (mode) => {
  const pool = { poolId: "tempo:0x0e97fc372f446f247f99ba27614fb2ec87a502a765dedf7e20890909189eed2f", project: "tempo", chain: "Tempo", symbol: "OUSD / pathUSD", tvlUsd: 60_000, volumeUsd1d: null, poolType: "cg-amm", source: "cg_onchain" as const, priceSource: undefined as "direct_api" | undefined };
  const header = { number: 1, timestamp: 9999, hash: `0x${"a".repeat(64)}` as const };
  vi.spyOn(rpc, "fetchEvmBlockNumber").mockResolvedValue(1);
  vi.spyOn(rpc, "fetchEvmBlockHeader").mockResolvedValueOnce(header).mockResolvedValue({ ...header, timestamp: mode === "reorg" ? 9998 : 9999 });
  vi.spyOn(rpc, "fetchEvmCodeAtBlock").mockResolvedValue(mode === "runtime" ? "0x00" : "0xef");
  vi.spyOn(rpc, "fetchEvmRpcBatch").mockResolvedValueOnce([
    mode === "malformed" ? "0x" : word(6), word(6), word(6), word(path), word(ousd),
    book(mode === "wrong-book" ? usdt : ousd, path, mode === "crossed" ? -20 : 0), book(usdt, ousd),
  ]).mockResolvedValueOnce(mode === "quote-failed" ? null : [word(mode === "zero" ? 0 : 50_010e6), word(mode === "inverted" ? 51_000e6 : 49_985e6)]);
  const result = await refreshTempoPathUsdPrice({ sourcePools: new Map([["pathusd-bridge", { stablecoinId: "pathusd-bridge", symbol: "pathUSD", pools: [pool] }]]), stablecoinPriceById: new Map([["usdt-tether", 1.01]]), stablecoinPriceProvenanceById: new Map([["usdt-tether", { referencePriceSourceId: "kraken+coinbase", referencePriceObservedAt: mode === "stale-quote" ? 1 : 9900 }]]), nowSec: 10000 });
  expect(result.status).toBe(mode === "observed" ? "observed" : "unavailable");
  expect(pool).toMatchObject({ tvlUsd: 60_000, source: "cg_onchain", priceSource: mode === "observed" ? "direct_api" : undefined });
  if (result.status === "observed") expect(result).toMatchObject({ supportUsd: expect.closeTo(50_000), observedAt: 9900, priceUsd: expect.closeTo(0.505 * (49504950496 / 50010000000 + 49504950496 / 49985000000)) });
});
