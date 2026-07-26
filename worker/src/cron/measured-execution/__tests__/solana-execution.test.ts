import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import {
  SOLANA_MEASURED_MAX_CONTEXT_SLOT_LAG,
  SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
  buildSolanaMeasuredExecutionTargetId,
  validateSolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import { describe, expect, it } from "vitest";
import type { DexApiPool } from "../../../lib/dex-api-types";
import { buildSolanaMeasuredExecutionTargets, buildSolanaMeasuredPoolDirectionKey } from "../solana-inventory";
import { buildSolanaMeasuredExecutionProfile } from "../solana-profiles";
import {
  buildSolanaMeasuredQuotePoint,
  parseOrcaExactRouteProof,
  parseRaydiumExactRouteProof,
  quoteSolanaMeasuredTarget,
} from "../solana-quotes";
import {
  getSolanaMeasuredExecutionPriorityTarget,
  SOLANA_MEASURED_EXECUTION_ADAPTERS,
  SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS,
} from "../solana-registry";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYDgK5KJY8PYdG7yM7pTz1C";
const SOL = "So11111111111111111111111111111111111111112";
const ORCA_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const RAYDIUM_POOL = "6rgD7Zyyw5hkQ7J1GZ3aHhQzM9wXZXJoKqjAr4VhJf9Q";

function target(
  adapterProfileId: SolanaMeasuredExecutionTarget["adapterProfileId"] = "orca-whirlpool-jupiter-v1",
): SolanaMeasuredExecutionTarget {
  const raydium = adapterProfileId === "raydium-clmm-trade-api-v1";
  const poolId = raydium ? RAYDIUM_POOL : ORCA_POOL;
  const protocol = raydium ? "raydium" : "orca";
  return {
    schemaVersion: SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
    targetId: buildSolanaMeasuredExecutionTargetId({
      stablecoinId: "usdc",
      adapterProfileId,
      protocol,
      poolId,
      tokenInAddress: USDC,
      tokenOutAddress: USDT,
    }),
    stablecoinId: "usdc",
    adapterProfileId,
    protocol,
    chain: "solana",
    poolId,
    poolType: raydium ? "raydium-clmm" : "orca-whirlpool",
    tokenIn: {
      address: USDC,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      referencePriceSource: "tracked",
      trackedAssetId: "usdc",
    },
    tokenOut: {
      address: USDT,
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      referencePriceSource: "tracked",
      trackedAssetId: "usdt",
    },
    retainedTvlUsd: 100_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  };
}

describe("Solana measured execution inventory and registry", () => {
  it("registers Raydium CLMM and Orca Whirlpool as shadow-only", () => {
    expect(SOLANA_MEASURED_EXECUTION_ADAPTERS).toEqual([
      expect.objectContaining({
        protocol: "raydium",
        poolType: "raydium-clmm",
        activation: "shadow",
        scoreEligible: false,
      }),
      expect.objectContaining({
        protocol: "orca",
        poolType: "orca-whirlpool",
        activation: "shadow",
        scoreEligible: false,
      }),
    ]);
  });

  it("pins the priority collector to the exact reviewed HYUSD/USDC direction without activating it", () => {
    const priority = SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS[0]!;
    expect(priority.targetId).toBe(
      buildSolanaMeasuredExecutionTargetId({
        stablecoinId: priority.stablecoinId,
        adapterProfileId: priority.adapterProfileId,
        protocol: priority.protocol,
        poolId: priority.poolId,
        tokenInAddress: priority.tokenInAddress,
        tokenOutAddress: priority.tokenOutAddress,
      }),
    );
    const candidate = {
      ...target(),
      targetId: priority.targetId,
      stablecoinId: priority.stablecoinId,
      adapterProfileId: priority.adapterProfileId,
      protocol: priority.protocol,
      poolType: priority.poolType,
      poolId: priority.poolId,
      tokenIn: {
        ...target().tokenIn,
        address: priority.tokenInAddress,
        decimals: priority.tokenInDecimals,
        trackedAssetId: priority.stablecoinId,
      },
      tokenOut: {
        ...target().tokenOut,
        address: priority.tokenOutAddress,
        decimals: priority.tokenOutDecimals,
        trackedAssetId: priority.tokenOutTrackedAssetId,
      },
    };

    expect(getSolanaMeasuredExecutionPriorityTarget(candidate)).toEqual(priority);
    expect(
      getSolanaMeasuredExecutionPriorityTarget({
        ...candidate,
        tokenOut: { ...candidate.tokenOut, address: SOL },
      }),
    ).toBeNull();
    expect(
      SOLANA_MEASURED_EXECUTION_ADAPTERS.find(
        (adapter) => adapter.adapterProfileId === priority.adapterProfileId,
      ),
    ).toMatchObject({ activation: "shadow", scoreEligible: false });
  });

  it("builds a case-sensitive Orca target with a pool-implied counter-token reference", () => {
    const pool: DexApiPool = {
      source: "orca",
      chain: "solana",
      poolAddress: ORCA_POOL,
      poolType: "orca-whirlpool",
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6 },
        { address: SOL, symbol: "SOL", decimals: 9 },
      ],
      price: 1 / 128,
      tvlUsd: 1_000_000,
      volume24hUsd: 100_000,
      feeRate: 0.0004,
      balances: [500_000, 3_906.25],
    };
    const targets = buildSolanaMeasuredExecutionTargets({
      pools: [pool],
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("solana", USDC), "usdc"]]),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([["usdc", 1]]),
      capturedAt: 2_000,
    });
    const built = targets.get(buildSolanaMeasuredPoolDirectionKey("usdc", ORCA_POOL));
    expect(built).toMatchObject({
      poolId: ORCA_POOL,
      adapterProfileId: "orca-whirlpool-jupiter-v1",
      tokenIn: { address: USDC, referencePriceSource: "tracked" },
      tokenOut: { address: SOL, referencePriceUsd: 128, referencePriceSource: "pool-implied" },
    });
    expect(built?.targetId).toContain(ORCA_POOL);
    expect(targets.get(buildSolanaMeasuredPoolDirectionKey("usdc", `solana:${ORCA_POOL}`))).toBe(built);
  });
});

describe("Solana exact quote parsing", () => {
  it("requests Jupiter's current Whirlpool route label", async () => {
    const current = target();
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("dexes")).toBe("Whirlpool");
      return new Response(JSON.stringify({
        inputMint: USDC,
        inAmount: "1000000000",
        outputMint: USDT,
        outAmount: "995000000",
        otherAmountThreshold: "995000000",
        swapMode: "ExactIn",
        slippageBps: 0,
        contextSlot: 1_005,
        routePlan: [{
          percent: 100,
          swapInfo: {
            ammKey: ORCA_POOL,
            label: "Whirlpool",
            inputMint: USDC,
            outputMint: USDT,
            inAmount: "1000000000",
            outAmount: "995000000",
          },
        }],
      }));
    };
    await expect(quoteSolanaMeasuredTarget({
      target: current,
      inputUsd: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({
      amountInRaw: "1000000000",
      route: { label: "Whirlpool", poolId: ORCA_POOL },
    });
  });

  it("accepts an ordinary Orca Jupiter quote without an updateContextSlot extension", () => {
    const current = target();
    const body = {
      inputMint: USDC,
      inAmount: "1000000000",
      outputMint: USDT,
      outAmount: "995000000",
      otherAmountThreshold: "995000000",
      swapMode: "ExactIn",
      slippageBps: 0,
      contextSlot: 1_005,
      routePlan: [
        {
          percent: 100,
          swapInfo: {
            ammKey: ORCA_POOL,
            label: "Whirlpool",
            inputMint: USDC,
            outputMint: USDT,
            inAmount: "1000000000",
            outAmount: "995000000",
          },
        },
      ],
    };
    expect(parseOrcaExactRouteProof(body, current, "1000000000")).toEqual(
      expect.objectContaining({ poolId: ORCA_POOL, contextSlot: 1_005, outputAmount: "995000000" }),
    );
    body.routePlan[0]!.swapInfo.ammKey = RAYDIUM_POOL;
    expect(parseOrcaExactRouteProof(body, current, "1000000000")).toBeNull();
    body.routePlan[0]!.swapInfo.ammKey = ORCA_POOL;
    body.otherAmountThreshold = "994000000";
    expect(parseOrcaExactRouteProof(body, current, "1000000000")).toBeNull();
  });

  it("requires Raydium's exact CLMM route and returned pool-price state", () => {
    const current = target("raydium-clmm-trade-api-v1");
    const body = {
      id: "quote-1",
      success: true,
      data: {
        swapType: "BaseIn",
        inputMint: USDC,
        inputAmount: "1000000000",
        outputMint: USDT,
        outputAmount: "995000000",
        otherAmountThreshold: "995000000",
        slippageBps: 0,
        routePlan: [
          {
            poolId: RAYDIUM_POOL,
            inputMint: USDC,
            outputMint: USDT,
            lastPoolPriceX64: "18446744073709551616",
          },
        ],
      },
    };
    expect(parseRaydiumExactRouteProof(body, current, "1000000000")).toEqual(
      expect.objectContaining({ poolId: RAYDIUM_POOL, lastPoolPriceX64: "18446744073709551616" }),
    );
    delete (body.data.routePlan[0] as { lastPoolPriceX64?: string }).lastPoolPriceX64;
    expect(parseRaydiumExactRouteProof(body, current, "1000000000")).toBeNull();
  });
});

describe("Solana measured profile replay", () => {
  it("binds output to the exact pool, amount, token identities, and slot window", () => {
    const current = target();
    const marginalRoute = parseOrcaExactRouteProof(
      {
        inputMint: USDC,
        inAmount: "1000000000",
        outputMint: USDT,
        outAmount: "995000000",
        otherAmountThreshold: "995000000",
        swapMode: "ExactIn",
        slippageBps: 0,
        contextSlot: 1_005,
        routePlan: [
          {
            percent: 100,
            swapInfo: {
              ammKey: ORCA_POOL,
              label: "Whirlpool",
              inputMint: USDC,
              outputMint: USDT,
              inAmount: "1000000000",
              outAmount: "995000000",
            },
          },
        ],
      },
      current,
      "1000000000",
    )!;
    const capacityRoute = {
      ...marginalRoute,
      inputAmount: "100000000000",
      outputAmount: "98000000000",
      contextSlot: 1_006,
    };
    const marginal = buildSolanaMeasuredQuotePoint(current, marginalRoute)!;
    const capacity = buildSolanaMeasuredQuotePoint(current, capacityRoute)!;
    const profile = buildSolanaMeasuredExecutionProfile({
      target: current,
      targetGenerationId: "targets-1",
      quoteGenerationId: "quotes-1",
      quotedAt: 1_010,
      slotBefore: 1_000,
      slotAfter: 1_010,
      points: [marginal, capacity],
    });
    const validate = (candidate: unknown) =>
      validateSolanaMeasuredExecutionProfile({
        profile: candidate,
        quotedTarget: current,
        currentTarget: current,
        expectedTargetGenerationId: "targets-1",
        expectedQuoteGenerationId: "quotes-1",
        nowSec: 1_010,
      });
    expect(validate(profile)).toEqual([]);
    expect(
      validate({
        ...profile,
        quoteProof: profile.quoteProof.map((point, index) =>
          index === 0 ? { ...point, route: { ...point.route, poolId: RAYDIUM_POOL } } : point,
        ),
      }),
    ).toContain("invalid-quote-proof");
    expect(validate({ ...profile, slotWindow: { before: 1_000, after: 1_600 } })).toContain("invalid-slot-proof");
    expect(
      validate({
        ...profile,
        slotWindow: { before: 3_000, after: 3_010 },
        quoteProof: profile.quoteProof.map((point) => ({
          ...point,
          route: {
            ...point.route,
            contextSlot: 3_000 - SOLANA_MEASURED_MAX_CONTEXT_SLOT_LAG - 1,
          },
        })),
      }),
    ).toContain("invalid-slot-proof");
  });
});
