import {
  SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
  buildSolanaMeasuredExecutionTargetId,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import { describe, expect, it } from "vitest";
import type { PoolEntry } from "../../dex-liquidity/types";
import type { LoadedSolanaMeasuredQuoteEvidence } from "../persistence";
import { buildSolanaMeasuredExecutionProfile } from "../solana-profiles";
import { buildSolanaMeasuredQuotePoint } from "../solana-quotes";
import { quoteRaydiumClmmSingleSegment } from "../solana-clmm-math";
import {
  joinSolanaMeasuredExecutionEvidence,
  releaseSolanaMeasuredExecutionProofFields,
  stripSolanaMeasuredExecutionInternalFields,
} from "../solana-join";
import {
  getSolanaMeasuredExecutionAdapterByProfile,
  SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS,
} from "../solana-registry";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYDgK5KJY8PYdG7yM7pTz1C";
const POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const RAYDIUM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const WM = "mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp";
const RAYDIUM_POOL = "CsMzKUUJNoAoU7N4zh3hAS6qcByU81TcQMPJqCdmmcEF";

function fixtureTarget(): SolanaMeasuredExecutionTarget {
  const adapterProfileId = "orca-whirlpool-jupiter-v1";
  return {
    schemaVersion: SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
    targetId: buildSolanaMeasuredExecutionTargetId({
      stablecoinId: "usdc",
      adapterProfileId,
      protocol: "orca",
      poolId: POOL,
      tokenInAddress: USDC,
      tokenOutAddress: USDT,
    }),
    stablecoinId: "usdc",
    adapterProfileId,
    protocol: "orca",
    chain: "solana",
    poolId: POOL,
    poolType: "orca-whirlpool",
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

function fixtureJoin(): {
  pool: PoolEntry;
  evidence: LoadedSolanaMeasuredQuoteEvidence;
} {
  const target = fixtureTarget();
  const route = {
    provider: "jupiter-swap-api" as const,
    label: "Whirlpool" as const,
    poolId: POOL,
    inputMint: USDC,
    outputMint: USDT,
    inputAmount: "1000000000",
    outputAmount: "995000000",
    contextSlot: 1_005,
  };
  const marginal = buildSolanaMeasuredQuotePoint(target, route)!;
  const capacity = buildSolanaMeasuredQuotePoint(target, {
    ...route,
    inputAmount: "100000000000",
    outputAmount: "98000000000",
    contextSlot: 1_006,
  })!;
  const profile = buildSolanaMeasuredExecutionProfile({
    target,
    targetGenerationId: "solana-targets-1",
    quoteGenerationId: "solana-quotes-1",
    quotedAt: 1_010,
    slotBefore: 1_000,
    slotAfter: 1_010,
    points: [marginal, capacity],
  });
  return {
    pool: {
      poolId: `solana:${POOL}`,
      project: "orca",
      chain: "Solana",
      tvlUsd: 100_000,
      symbol: "USDC / USDT",
      volumeUsd1d: 10_000,
      poolType: "orca-whirlpool",
      source: "direct_api",
      extra: { solanaMeasuredExecutionTarget: target },
    },
    evidence: {
      quoteGenerationId: "solana-quotes-1",
      targetGenerationId: "solana-targets-1",
      publishedAt: 1_010,
      byTargetId: new Map([
        [
          target.targetId,
          {
            quotedTarget: target,
            status: "measured",
            failureReason: null,
            profile,
            quoteGenerationId: "solana-quotes-1",
            targetGenerationId: "solana-targets-1",
            resolution: "latest",
            latestFailureReason: null,
          },
        ],
      ]),
    },
  };
}

function ratifiedRaydiumJoin(resolution: "latest" | "last-known-good" = "latest"): {
  pool: PoolEntry;
  evidence: LoadedSolanaMeasuredQuoteEvidence;
} {
  const priority = SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS.find(
    (entry) => entry.policyId === "wm-usdc-raydium-csmz-v1",
  )!;
  const target: SolanaMeasuredExecutionTarget = {
    schemaVersion: SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
    targetId: priority.targetId,
    stablecoinId: priority.stablecoinId,
    adapterProfileId: priority.adapterProfileId,
    protocol: priority.protocol,
    chain: "solana",
    poolId: priority.poolId,
    poolType: priority.poolType,
    tokenIn: {
      address: priority.tokenInAddress,
      symbol: "wM",
      decimals: 6,
      referencePriceUsd: 1,
      referencePriceSource: "tracked",
      trackedAssetId: priority.stablecoinId,
    },
    tokenOut: {
      address: priority.tokenOutAddress,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      referencePriceSource: "tracked",
      trackedAssetId: priority.tokenOutTrackedAssetId,
    },
    retainedTvlUsd: 100_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  };
  const makePoint = (inputAmount: string, feeAmount: string) => {
    const replay = quoteRaydiumClmmSingleSegment({
      liquidity: "5007419162034456",
      sqrtPriceX64: "18447272087370218185",
      amountIn: inputAmount,
      feeAmount,
      direction: "zero-for-one",
    });
    return buildSolanaMeasuredQuotePoint(target, {
      provider: "raydium-trade-api",
      responseId: `fixture-${inputAmount}`,
      poolId: RAYDIUM_POOL,
      inputMint: WM,
      outputMint: USDC,
      inputAmount,
      outputAmount: replay.amountOut,
      lastPoolPriceX64: replay.postSwapSqrtPriceX64,
      feeAmount,
      stateProof: {
        slot: 435_574_185,
        programId: RAYDIUM_PROGRAM,
        tokenMint0: WM,
        tokenMint1: USDC,
        liquidity: "5007419162034456",
        sqrtPriceX64: "18447272087370218185",
        feeAmount,
        direction: "zero-for-one",
      },
    })!;
  };
  const targetGenerationId = resolution === "last-known-good" ? "solana-targets-lkg" : "solana-targets-active";
  const quoteGenerationId = resolution === "last-known-good" ? "solana-quotes-lkg" : "solana-quotes-active";
  const profile = buildSolanaMeasuredExecutionProfile({
    target,
    targetGenerationId,
    quoteGenerationId,
    quotedAt: 1_010,
    slotBefore: 435_574_180,
    slotAfter: 435_574_190,
    points: [makePoint("1000000000", "100000"), makePoint("100000000000", "10000000")],
  });
  return {
    pool: {
      poolId: `solana:${RAYDIUM_POOL}`,
      project: "raydium",
      chain: "Solana",
      tvlUsd: 100_000,
      symbol: "wM / USDC",
      volumeUsd1d: 10_000,
      poolType: "raydium-clmm",
      source: "direct_api",
      extra: { solanaMeasuredExecutionTarget: target },
    },
    evidence: {
      quoteGenerationId: resolution === "last-known-good" ? "solana-quotes-latest" : quoteGenerationId,
      targetGenerationId: resolution === "last-known-good" ? "solana-targets-latest" : targetGenerationId,
      publishedAt: 1_010,
      byTargetId: new Map([
        [
          target.targetId,
          {
            quotedTarget: target,
            status: "measured",
            failureReason: null,
            profile,
            quoteGenerationId,
            targetGenerationId,
            resolution,
            latestFailureReason: resolution === "last-known-good" ? "budget-deferred" : null,
          },
        ],
      ]),
    },
  };
}

describe("Solana measured execution join", () => {
  it("retains a proof-free profile but keeps an unratified target activation-pending", () => {
    const { pool, evidence } = fixtureJoin();

    const diagnostics = joinSolanaMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdc", [pool]]]),
      evidence,
      nowSec: 1_010,
    });

    expect(diagnostics).toMatchObject({ targetCount: 1, measuredCount: 1, gatedCount: 1 });
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "activation-pending",
    });
    expect(pool.extra?.solanaMeasuredExecution).toBeDefined();
    expect(pool.extra?.solanaMeasuredExecution).not.toHaveProperty("quoteProof");

    releaseSolanaMeasuredExecutionProofFields([pool]);
    expect(pool.extra?.solanaMeasuredExecutionTarget).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecutionProfile).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecution).toBeDefined();
    expect(pool.extra?.solanaMeasuredExecutionPhysicalPoolId).toBe(POOL);

    stripSolanaMeasuredExecutionInternalFields([pool]);
    expect(pool.extra?.solanaMeasuredExecutionTarget).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecutionProfile).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecution).toBeDefined();
  });

  it("does not let a profile-wide adapter override promote an unratified target", () => {
    const { pool, evidence } = fixtureJoin();
    const diagnostics = joinSolanaMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdc", [pool]]]),
      evidence,
      nowSec: 1_010,
      resolveAdapterPolicy: (adapterProfileId) => {
        const adapter = getSolanaMeasuredExecutionAdapterByProfile(adapterProfileId);
        return adapter ? { ...adapter, activation: "active", scoreEligible: true } : null;
      },
    });

    expect(diagnostics).toMatchObject({ targetCount: 1, measuredCount: 1, gatedCount: 1 });
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "activation-pending",
    });
    expect(pool.extra?.nativeMeasuredExecution).toBeUndefined();

    stripSolanaMeasuredExecutionInternalFields([pool]);
    expect(pool.extra?.nativeMeasuredExecution).toBeUndefined();
    expect(pool.extra?.nativeMeasuredExecutionPhysicalPoolId).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecution).toBeDefined();
  });

  it("keeps the reviewed Raydium direction gated while its on-state proof remains available", () => {
    const { pool, evidence } = ratifiedRaydiumJoin();
    const diagnostics = joinSolanaMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["wm-m0", [pool]]]),
      evidence,
      nowSec: 1_010,
    });

    expect(diagnostics).toMatchObject({ targetCount: 1, measuredCount: 1, gatedCount: 1 });
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "activation-pending",
    });
    expect(pool.extra?.nativeMeasuredExecution).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecution).toBeDefined();
  });

  it("validates original generations when operational LKG evidence replaces a deferred latest row", () => {
    const { pool, evidence } = ratifiedRaydiumJoin("last-known-good");
    const diagnostics = joinSolanaMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["wm-m0", [pool]]]),
      evidence,
      nowSec: 1_010,
    });

    expect(diagnostics).toMatchObject({
      measuredCount: 1,
      gatedCount: 1,
      lastKnownGoodCount: 0,
    });
    expect(pool.extra?.nativeMeasuredExecution).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecutionDiagnostic).toMatchObject({
      detail: "shadow-score-ineligible",
    });
  });

  it("separates a rotating admission deferral from a genuine quote failure", () => {
    const target = fixtureTarget();
    const pool: PoolEntry = {
      poolId: `solana:${POOL}`,
      project: "orca",
      chain: "Solana",
      tvlUsd: 100_000,
      symbol: "USDC / USDT",
      volumeUsd1d: 10_000,
      poolType: "orca-whirlpool",
      source: "direct_api",
      extra: { solanaMeasuredExecutionTarget: target },
    };
    const evidenceFor = (failureReason: string): LoadedSolanaMeasuredQuoteEvidence => ({
      quoteGenerationId: "solana-quotes-active",
      targetGenerationId: "solana-targets-active",
      publishedAt: 1_010,
      byTargetId: new Map([
        [
          target.targetId,
          {
            quotedTarget: target,
            status: "failed",
            failureReason,
            profile: null,
            quoteGenerationId: "solana-quotes-active",
            targetGenerationId: "solana-targets-active",
            resolution: "latest",
            latestFailureReason: failureReason,
          },
        ],
      ]),
    });

    joinSolanaMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdc", [pool]]]),
      evidence: evidenceFor("budget-deferred"),
      nowSec: 1_010,
    });
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "budget-deferred",
    });

    joinSolanaMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([["usdc", [pool]]]),
      evidence: evidenceFor("rpc-failure"),
      nowSec: 1_010,
    });
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "quote-failed",
    });
  });
});
