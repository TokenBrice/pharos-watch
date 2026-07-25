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
import {
  joinSolanaMeasuredExecutionEvidence,
  releaseSolanaMeasuredExecutionProofFields,
  stripSolanaMeasuredExecutionInternalFields,
} from "../solana-join";
import { getSolanaMeasuredExecutionAdapterByProfile } from "../solana-registry";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYDgK5KJY8PYdG7yM7pTz1C";
const POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

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
          },
        ],
      ]),
    },
  };
}

describe("Solana measured execution join", () => {
  it("retains a proof-free profile but keeps the reviewed adapters activation-pending", () => {
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

  it("promotes only an explicitly active valid profile into the native P4 path", () => {
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

    expect(diagnostics).toMatchObject({ targetCount: 1, measuredCount: 1, gatedCount: 0 });
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(pool.extra?.nativeMeasuredExecution).toMatchObject({
      adapterProfileId: "orca-whirlpool-jupiter-v1",
      poolId: POOL,
    });
    expect(pool.extra?.nativeMeasuredExecutionPhysicalPoolId).toBe(POOL);

    stripSolanaMeasuredExecutionInternalFields([pool]);
    expect(pool.extra?.nativeMeasuredExecution).toBeUndefined();
    expect(pool.extra?.nativeMeasuredExecutionPhysicalPoolId).toBeUndefined();
    expect(pool.extra?.solanaMeasuredExecution).toBeDefined();
  });
});
