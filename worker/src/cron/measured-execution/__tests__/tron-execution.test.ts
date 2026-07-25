import { describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem/utils";
import {
  TRON_MEASURED_TARGET_SCHEMA_VERSION,
  buildTronMeasuredExecutionTargetId,
  quoteSunSwapV2ConstantProduct,
  validateTronMeasuredExecutionProfile,
  type TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import type { DexApiPool } from "../../../lib/dex-api-types";
import { tronBase58ToHex } from "../../../lib/tron-address";
import { buildTronMeasuredExecutionTargets } from "../tron-inventory";
import { buildTronMeasuredExecutionProfile } from "../tron-profiles";
import { parseSunRouterDirectV2Quote, quoteTronMeasuredTarget } from "../tron-quotes";
import {
  joinTronMeasuredExecutionEvidence,
  releaseTronMeasuredExecutionProofFields,
  stripTronMeasuredExecutionInternalFields,
} from "../tron-join";
import { getTronMeasuredExecutionAdapterByProfile } from "../tron-registry";

const FACTORY = "TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY";
const POOL = "TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ";
const WTRX = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const FACTORY_CODE = "0x6000";
const PAIR_CODE = "0x6001";

function target(): TronMeasuredExecutionTarget {
  const stablecoinId = "usdt-tether";
  return {
    schemaVersion: TRON_MEASURED_TARGET_SCHEMA_VERSION,
    targetId: buildTronMeasuredExecutionTargetId({
      stablecoinId,
      poolId: POOL,
      tokenInAddress: USDT,
      tokenOutAddress: WTRX,
    }),
    stablecoinId,
    adapterProfileId: "sunswap-v2-router-v1",
    protocol: "sunswap",
    chain: "tron",
    poolId: POOL,
    poolType: "sunswap-v2",
    factoryAddress: FACTORY,
    expectedFactoryCodeHash: keccak256(FACTORY_CODE),
    expectedPairCodeHash: keccak256(PAIR_CODE),
    tokenIn: {
      address: USDT,
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      referencePriceSource: "tracked",
      trackedAssetId: stablecoinId,
    },
    tokenOut: {
      address: WTRX,
      symbol: "WTRX",
      decimals: 6,
      referencePriceUsd: 0.3,
      referencePriceSource: "source-token-usd",
    },
    feeRate: 0.003,
    retainedTvlUsd: 92_836_495,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  };
}

function directQuote(amountInRaw = "1000000000", amountOutRaw = "3031844470") {
  return {
    code: 0,
    message: "SUCCESS",
    data: [{
      amountIn: "1000.000000",
      amountInRaw,
      amountOut: "3031.844470",
      amountOutRaw,
      amountOutMinimumRaw: amountOutRaw,
      amountInRawReferral: "0",
      amountInReferralBips: 0,
      amountOutRawReferral: "0",
      amountOutReferralBips: 0,
      containsUnverifiedHook: false,
      tokens: [USDT, WTRX],
      poolVersions: ["v2"],
      poolKeys: [null],
      stepAmountsOut: ["3031.844470"],
    }],
  };
}

function wordAddress(hexAddress: string): string {
  return `0x${hexAddress.slice(2).padStart(64, "0")}`;
}

function wordUint(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

describe("Tron SunSwap measured execution", () => {
  it("builds targets only for exact SunSwap V2 rows with tracked input identity", () => {
    const pool: DexApiPool = {
      source: "sunswap",
      chain: "tron",
      poolAddress: POOL,
      poolType: "sunswap-v2",
      tokens: [
        { address: WTRX, symbol: "WTRX", decimals: 6, priceUsd: 0.328427464917 },
        { address: USDT, symbol: "USDT", decimals: 6, priceUsd: 1 },
      ],
      price: 0.328427464917,
      tvlUsd: 92_836_495,
      volume24hUsd: 738_928,
      feeRate: 0.003,
      balances: [141334853.510414, 46475941.487844],
      balancesNormalized: true,
    };
    const result = buildTronMeasuredExecutionTargets({
      pools: [pool],
      chainAddressToId: new Map([[`tron:${USDT}`, "usdt-tether"]]),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([["usdt-tether", 1]]),
      capturedAt: 1_000,
    });
    expect([...result.values()]).toEqual([expect.objectContaining({
      stablecoinId: "usdt-tether",
      poolId: POOL,
      adapterProfileId: "sunswap-v2-router-v1",
      factoryAddress: FACTORY,
      feeRate: 0.003,
    })]);
    expect(getTronMeasuredExecutionAdapterByProfile("sunswap-v2-router-v1")).toMatchObject({
      activation: "shadow",
      scoreEligible: false,
    });
  });

  it("accepts one direct V2 path and rejects multi-hop or ambiguous paths", () => {
    const exact = parseSunRouterDirectV2Quote(directQuote(), target(), "1000000000");
    expect(exact).toEqual({
      amountOutRaw: "3031844470",
      routeTokens: [USDT, WTRX],
      poolVersions: ["v2"],
    });
    const multiHop = directQuote();
    multiHop.data[0]!.tokens = [USDT, FACTORY, WTRX];
    multiHop.data[0]!.poolVersions = ["v2", "v2"];
    expect(parseSunRouterDirectV2Quote(multiHop, target(), "1000000000")).toBeNull();
    const ambiguous = directQuote();
    ambiguous.data.push({ ...ambiguous.data[0]! });
    expect(parseSunRouterDirectV2Quote(ambiguous, target(), "1000000000")).toBeNull();
    const slipped = directQuote();
    slipped.data[0]!.amountOutMinimumRaw = "3000000000";
    expect(parseSunRouterDirectV2Quote(slipped, target(), "1000000000")).toBeNull();
    const referred = directQuote();
    referred.data[0]!.amountOutRawReferral = "1";
    expect(parseSunRouterDirectV2Quote(referred, target(), "1000000000")).toBeNull();
  });

  it("matches router output to canonical factory-bound pair reserves and validates replay", async () => {
    const [factoryHex, poolHex, wtrxHex, usdtHex] = await Promise.all([
      tronBase58ToHex(FACTORY),
      tronBase58ToHex(POOL),
      tronBase58ToHex(WTRX),
      tronBase58ToHex(USDT),
    ]);
    expect(factoryHex && poolHex && wtrxHex && usdtHex).toBeTruthy();
    let blockReads = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(JSON.stringify(directQuote()));
      const request = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      if (request.method === "eth_blockNumber") {
        blockReads++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: blockReads === 1 ? "0x64" : "0x65" }));
      }
      if (request.method === "eth_getCode") {
        expect(request.params[request.params.length - 1]).toBe("latest");
        const address = request.params[0];
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: address === factoryHex ? FACTORY_CODE : PAIR_CODE,
        }));
      }
      expect(request.method).toBe("eth_call");
      expect(request.params[request.params.length - 1]).toBe("latest");
      const call = request.params[0] as { data: string };
      let result: string;
      if (call.data.startsWith("0xe6a43905")) result = wordAddress(poolHex!);
      else if (call.data === "0x0dfe1681") result = wordAddress(wtrxHex!);
      else if (call.data === "0xd21220a7") result = wordAddress(usdtHex!);
      else result = `0x${wordUint(141_334_853_510_414n)}${wordUint(46_475_941_487_844n)}${wordUint(1n)}`;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as typeof fetch;

    const point = await quoteTronMeasuredTarget({
      target: target(),
      inputUsd: 1_000,
      routerRequestSpacingMs: 0,
      fetchImpl,
    });
    expect(point).toMatchObject({
      amountInRaw: "1000000000",
      amountOutRaw: "3031844470",
      route: {
        poolId: POOL,
        token0: WTRX,
        token1: USDT,
        blockBefore: 100,
        blockAfter: 101,
      },
    });
    expect(blockReads).toBe(2);
    const profile = buildTronMeasuredExecutionProfile({
      target: target(),
      targetGenerationId: "targets-1",
      quoteGenerationId: "quotes-1",
      quotedAt: 1_100,
      points: [point],
    });
    expect(validateTronMeasuredExecutionProfile({
      profile,
      quotedTarget: target(),
      currentTarget: target(),
      expectedTargetGenerationId: "targets-1",
      expectedQuoteGenerationId: "quotes-1",
      nowSec: 1_100,
    })).toEqual([]);
    const tampered = structuredClone(profile);
    tampered.quoteProof[0]!.route.reserve0Raw = "1413348535104140";
    expect(validateTronMeasuredExecutionProfile({
      profile: tampered,
      quotedTarget: target(),
      currentTarget: target(),
      expectedTargetGenerationId: "targets-1",
      expectedQuoteGenerationId: "quotes-1",
      nowSec: 1_100,
    })).toContain("invalid-quote-proof");

    const retainedPool = {
      poolId: POOL,
      project: "sunswap-v2",
      chain: "tron",
      tvlUsd: target().retainedTvlUsd,
      symbol: "USDT-WTRX",
      volumeUsd1d: 1,
      poolType: "sunswap-v2",
      source: "dl" as const,
      extra: { tronMeasuredExecutionTarget: target() },
    };
    const evidence = {
      targetGenerationId: "targets-1",
      quoteGenerationId: "quotes-1",
      publishedAt: 1_100,
      byTargetId: new Map([[target().targetId, {
        quotedTarget: target(),
        status: "measured" as const,
        failureReason: null,
        profile,
      }]]),
    };
    expect(joinTronMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdt-tether", [retainedPool]]]),
      evidence,
      nowSec: 1_100,
    })).toMatchObject({ measuredCount: 1, gatedCount: 1 });
    expect(retainedPool.extra).toMatchObject({
      executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" },
      tronMeasuredExecution: { protocol: "sunswap", poolType: "sunswap-v2" },
    });
    const activePool = {
      ...retainedPool,
      extra: { tronMeasuredExecutionTarget: target() },
    };
    expect(joinTronMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdt-tether", [activePool]]]),
      evidence,
      nowSec: 1_100,
      resolveAdapterPolicy: (adapterProfileId) => {
        const adapter = getTronMeasuredExecutionAdapterByProfile(adapterProfileId);
        return adapter ? { ...adapter, activation: "active", scoreEligible: true } : null;
      },
    })).toMatchObject({ measuredCount: 1, gatedCount: 0 });
    expect(activePool.extra).toMatchObject({
      nativeMeasuredExecution: { adapterProfileId: "sunswap-v2-router-v1", poolId: POOL },
      nativeMeasuredExecutionPhysicalPoolId: POOL,
    });
    expect(activePool.extra).not.toHaveProperty("executionCapabilityGate");
    const failedPool = {
      ...retainedPool,
      extra: { tronMeasuredExecutionTarget: target() },
    };
    expect(joinTronMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdt-tether", [failedPool]]]),
      evidence: {
        ...evidence,
        byTargetId: new Map([[target().targetId, {
          quotedTarget: target(),
          status: "failed",
          failureReason: "exact-route-mismatch",
          profile: null,
        }]]),
      },
      nowSec: 1_100,
    })).toMatchObject({
      measuredCount: 0,
      gatedCount: 1,
      failuresByReason: { "sunswap-v2-router-v1:quote-failed": 1 },
    });
    expect(failedPool.extra).toMatchObject({
      executionCapabilityGate: { family: "measured-execution", reason: "quote-failed" },
      tronMeasuredExecutionDiagnostic: { detail: "exact-route-mismatch" },
    });
    expect(failedPool.extra).not.toHaveProperty("nativeMeasuredExecution");
    releaseTronMeasuredExecutionProofFields([retainedPool]);
    expect(retainedPool.extra).not.toHaveProperty("tronMeasuredExecutionTarget");
    expect(retainedPool.extra).not.toHaveProperty("tronMeasuredExecutionProfile");
    expect(retainedPool.extra).toHaveProperty("tronMeasuredExecution");
    expect(retainedPool.extra).toHaveProperty("tronMeasuredExecutionPhysicalPoolId", POOL);
    stripTronMeasuredExecutionInternalFields([retainedPool]);
    expect(retainedPool.extra).not.toHaveProperty("tronMeasuredExecutionTarget");
    expect(retainedPool.extra).not.toHaveProperty("tronMeasuredExecutionProfile");
    expect(retainedPool.extra).toHaveProperty("tronMeasuredExecution");
  });

  it("uses the reviewed 0.3% constant-product fee", () => {
    expect(quoteSunSwapV2ConstantProduct({
      amountIn: 1_000_000_000n,
      reserveIn: 46_475_941_487_844n,
      reserveOut: 141_334_853_510_414n,
    })).toBe(3_031_844_470n);
  });
});
