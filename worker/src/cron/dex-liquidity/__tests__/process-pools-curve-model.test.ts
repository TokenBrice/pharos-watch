import { describe, expect, it } from "vitest";
import { DexAmmExecutionModelSchema } from "@shared/types/market";
import {
  buildCurveCryptoSwapMeasuredExecutionTarget,
  buildCurveStableswapExecutionCapability,
  buildCurveStableswapExecutionModel,
} from "../process-pools";
import type { CurvePoolEntry } from "../types";

const USDC = "0x00000000000000000000000000000000000000c1";
const USDT = "0x00000000000000000000000000000000000000c2";
const CRVUSD = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";

function entry(overrides: Partial<CurvePoolEntry> = {}): CurvePoolEntry {
  return {
    A: 200,
    balanceRatio: 1,
    tvl: 10_000_000,
    registryId: "factory-stable-ng",
    isMetaPool: false,
    metapoolAdjustedTvl: 10_000_000,
    creationTs: 0,
    balanceDetails: [],
    tokenPrices: {},
    executionCoins: [
      { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
      { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 0.9995 },
    ],
    ...overrides,
  };
}

const chainAddressToId = new Map([
  [`ethereum:${USDC}`, "usdc-circle"],
  [`ethereum:${USDT}`, "usdt-tether"],
]);

describe("buildCurveStableswapExecutionModel", () => {
  it("builds a schema-valid stableswap model with the tracked input token", () => {
    const model = buildCurveStableswapExecutionModel(entry(), "ethereum", "usdc-circle", chainAddressToId);
    expect(model).not.toBeNull();
    expect(DexAmmExecutionModelSchema.parse(model)).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: 0,
      // Contract A=200 for a 2-coin pool is 200 / 2^(2-1) in the model's plain paper convention.
      amplification: 100,
      tokens: [
        { trackedAssetId: "usdc-circle", balance: 5_000_000 },
        { trackedAssetId: "usdt-tether", referencePriceUsd: 0.9995 },
      ],
    });
    // Fee is the documented conservative bound, never zero and never large.
    expect(model!.feeRate).toBeGreaterThan(0);
    expect(model!.feeRate).toBeLessThanOrEqual(0.001);
  });

  it("converts the contract amplification convention by coin count", () => {
    const DAI = "0x00000000000000000000000000000000000000c3";
    const threeCoin = entry({
      A: 4000,
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 0.9995 },
        { address: DAI, symbol: "DAI", decimals: 18, balance: 5_000_000, usdPrice: 1.0001 },
      ],
    });
    const model = buildCurveStableswapExecutionModel(threeCoin, "ethereum", "usdc-circle", chainAddressToId);
    // 3pool-style: contract A=4000 -> paper A = 4000 / 3^2.
    expect(model?.amplification).toBeCloseTo(4000 / 9, 10);
  });

  it("fails closed on metapools, missing capture, and untracked input", () => {
    expect(
      buildCurveStableswapExecutionModel(entry({ isMetaPool: true }), "ethereum", "usdc-circle", chainAddressToId),
    ).toBeNull();
    expect(
      buildCurveStableswapExecutionModel(
        entry({ executionCoins: undefined }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ),
    ).toBeNull();
    expect(buildCurveStableswapExecutionModel(entry(), "ethereum", "dai-makerdao", chainAddressToId)).toBeNull();
    expect(buildCurveStableswapExecutionModel(undefined, "ethereum", "usdc-circle", chainAddressToId)).toBeNull();
  });

  it("fails closed on CryptoSwap registries despite a published amplification", () => {
    expect(
      buildCurveStableswapExecutionModel(
        entry({ registryId: "factory-twocrypto", A: 20_000_000 }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ),
    ).toBeNull();
    expect(
      buildCurveStableswapExecutionCapability(
        entry({ registryId: "factory-twocrypto", A: 20_000_000 }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ).gate,
    ).toEqual({ family: "curve-cryptoswap", reason: "unsupported-invariant" });
    expect(
      buildCurveStableswapExecutionModel(
        entry({ registryId: "factory-tricrypto" }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ),
    ).toBeNull();
  });

  it("builds an exact measured target for an activated crvUSD TwoCrypto pool", () => {
    const poolAddress = "0x313698667d7fdd6789a9bc70821309ff891e729a";
    const target = buildCurveCryptoSwapMeasuredExecutionTarget({
      curveData: entry({
        poolAddress,
        apiIsBroken: false,
        registryId: "factory-twocrypto",
        executionCoins: [
          { address: CRVUSD, symbol: "crvUSD", decimals: 18, balance: 20_000_000, usdPrice: 1 },
          { address: WBTC, symbol: "WBTC", decimals: 8, balance: 400, usdPrice: 65_000 },
        ],
      }),
      chain: "ethereum",
      stablecoinId: "crvusd-curve",
      chainAddressToId: new Map([[`ethereum:${CRVUSD}`, "crvusd-curve"]]),
      stablecoinPriceById: new Map([["crvusd-curve", 0.9998]]),
      retainedTvlUsd: 45_000_000,
      capturedAt: 1_752_500_000,
    });

    expect(target).toMatchObject({
      adapterProfileId: "curve-cryptoswap-get-dy-v1",
      stablecoinId: "crvusd-curve",
      poolId: `ethereum:${poolAddress}`,
      retainedPoolPriceUsd: 0.9998,
      tokenIn: { address: CRVUSD, trackedAssetId: "crvusd-curve" },
      tokenOut: { address: WBTC, referencePriceUsd: 65_000 },
    });
  });

  it("fails closed on rate-bearing pools via the coin price spread gate", () => {
    // A persistent >1% per-coin USD price spread marks a rate-scaled pool
    // (e.g. DOLA/sUSDe at ~1.24): raw-balance stableswap overstates output.
    const rateBearing = entry({
      executionCoins: [
        { address: USDC, symbol: "DOLA", decimals: 18, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "sUSDe", decimals: 18, balance: 4_000_000, usdPrice: 1.24 },
      ],
    });
    expect(buildCurveStableswapExecutionModel(rateBearing, "ethereum", "usdc-circle", chainAddressToId)).toBeNull();
    expect(
      buildCurveStableswapExecutionCapability(rateBearing, "ethereum", "usdc-circle", chainAddressToId).gate,
    ).toEqual({ family: "curve-stableswap", reason: "rate-bearing-inputs" });
    // A sub-1% spread (normal peg noise) still models.
    const pegNoise = entry({
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 0.9945 },
      ],
    });
    expect(buildCurveStableswapExecutionModel(pegNoise, "ethereum", "usdc-circle", chainAddressToId)).not.toBeNull();
  });

  it("rejects duplicate coin addresses instead of emitting an ambiguous model", () => {
    const duplicated = entry({
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDC, symbol: "USDC2", decimals: 6, balance: 5_000_000, usdPrice: 1 },
      ],
    });
    expect(buildCurveStableswapExecutionModel(duplicated, "ethereum", "usdc-circle", chainAddressToId)).toBeNull();
    expect(
      buildCurveStableswapExecutionCapability(duplicated, "ethereum", "usdc-circle", chainAddressToId).gate,
    ).toEqual({ family: "curve-stableswap", reason: "ambiguous-token-identity" });
  });
});
