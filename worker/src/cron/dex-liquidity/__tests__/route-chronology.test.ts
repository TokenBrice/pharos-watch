import { describe, expect, it } from "vitest";

import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { createV9EvidenceReference } from "@shared/lib/safety-score-v9/evidence";
import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
  DEX_MEASURED_MAX_COST_BPS,
  type DexMeasuredExecutionPublicProfile,
} from "@shared/types/measured-execution";

const ROUTE_FRESHNESS_MAX_SEC = 3_600;
const PHYSICAL_POOL_ID = "ethereum:0x3333333333333333333333333333333333333333";

function measuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
  const physicalPoolAddress = "0x3333333333333333333333333333333333333333" as const;
  return {
    schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
    kind: "measured-executable-depth",
    targetId: "target-1",
    targetGenerationId: "target-generation",
    quoteGenerationId: `quote-generation-${quotedAt}`,
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    poolId: PHYSICAL_POOL_ID,
    poolTokenAddresses: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ],
    tokenIn: {
      address: "0x1111111111111111111111111111111111111111",
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: "0x2222222222222222222222222222222222222222",
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    feePips: 100,
    retainedTvlUsdAtQuote: 2_000_000,
    retainedPoolPriceUsdAtQuote: 1,
    quotedAt,
    blockNumber: 25_536_894,
    executionEndpoint: {
      address: "0x4444444444444444444444444444444444444444",
      codeHash: `0x${"ab".repeat(32)}`,
    },
    poolProvenance: {
      factoryAddress: "0x5555555555555555555555555555555555555555",
      factoryCodeHash: `0x${"cd".repeat(32)}`,
      resolvedPoolAddress: physicalPoolAddress,
    },
    maxCostBps: DEX_MEASURED_MAX_COST_BPS,
    marginalOutputRatio: 0.999,
    capacityCurve: DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => {
      const executableUsd = Math.min(requestedNotionalUsd, 1_000_000);
      return {
        requestedNotionalUsd,
        maxCostBps: DEX_MEASURED_MAX_COST_BPS,
        executableUsd,
        completionRatio: executableUsd / requestedNotionalUsd,
      };
    }),
  };
}

function routeObservedAt(quotedAt: number, stageStartedAt: number) {
  const result = buildP4DexExitRouteObservations({
    stablecoinId: "usdc-circle",
    observedAt: stageStartedAt,
    retainedPools: [
      {
        poolId: "defillama-yields-uuid",
        project: "uniswap-v3",
        chain: "ethereum",
        tvlUsd: 2_000_000,
        symbol: "USDC-USDT",
        poolType: "uniswap-v3",
        source: "dl",
        extra: {
          measuredExecution: measuredProfile(quotedAt),
          measuredExecutionPhysicalPoolId: PHYSICAL_POOL_ID,
        },
      },
    ],
  });

  expect(result.coverage).toMatchObject({
    status: "populated",
    scoreEligiblePoolCount: 1,
    unsupportedPoolCount: 0,
  });
  expect(result.observations).toHaveLength(1);
  return result.observations[0]!;
}

function v9Freshness(observedAtSec: number, fixedInputClockSec: number) {
  return createV9EvidenceReference(
    {
      evidenceId: `route-${observedAtSec}`,
      sourceId: "report-cards-dex-route-observation",
      sourceGenerationId: "dex-liquidity-4203",
      disposition: "observed",
      observedAtSec,
      maxAgeSec: ROUTE_FRESHNESS_MAX_SEC,
    },
    fixedInputClockSec,
  ).freshness;
}

describe("DEX route chronology across scheduled consumers", () => {
  it("keeps the production schedule phases explicit", () => {
    expect(getCronJobMeta("sync-cl-exit-depth")?.schedule).toBe("0,30 * * * *");
    expect(getCronJobMeta("sync-dex-liquidity-stage")?.schedule).toBe("10,40 * * * *");
    expect(getCronJobMeta("sync-dex-liquidity")?.schedule).toBe("16,46 * * * *");
    expect(getCronJobMeta("publish-report-card-cache")?.schedule).toBe("*/15 * * * *");
    expect(getCronJobMeta("compute-safety-score-v9-shadow")?.schedule).toBe(
      "14,29,44,59 * * * *",
    );
  });

  it("reproduces the synchronized 3,685-second cohort without changing its quote time", () => {
    // The first admission cohort was quoted at :30. The next-hour :10 DEX
    // stage can still consume it, and :16 scoring preserves the staged clock.
    const priorCohortQuotedAt = 30 * 60;
    const stageStartedAt = 60 * 60 + 10 * 60 + 3;
    const scoringScheduledAt = 60 * 60 + 16 * 60;
    const fixedInputClockSec = 60 * 60 + 31 * 60 + 25;
    const v9ConsumerScheduledAt = 60 * 60 + 44 * 60;

    const route = routeObservedAt(priorCohortQuotedAt, stageStartedAt);

    expect(scoringScheduledAt).toBeGreaterThan(stageStartedAt);
    expect(v9ConsumerScheduledAt).toBeGreaterThan(fixedInputClockSec);
    expect(route).toMatchObject({
      observedAt: priorCohortQuotedAt,
      freshnessSeconds: stageStartedAt - priorCohortQuotedAt,
    });
    expect(v9Freshness(route.observedAt, fixedInputClockSec)).toEqual({
      state: "stale",
      ageSec: 3_685,
      maxAgeSec: ROUTE_FRESHNESS_MAX_SEC,
    });
  });

  it("keeps a refreshed cohort current and lets a missed cohort become stale", () => {
    const currentCohortQuotedAt = 60 * 60;
    const stageStartedAt = 60 * 60 + 10 * 60 + 3;
    const healthyFixedInputClockSec = 60 * 60 + 31 * 60 + 25;
    const missedFixedInputClockSec = 2 * 60 * 60 + 1 * 60 + 25;

    const route = routeObservedAt(currentCohortQuotedAt, stageStartedAt);

    expect(route.observedAt).toBe(currentCohortQuotedAt);
    expect(v9Freshness(route.observedAt, healthyFixedInputClockSec)).toEqual({
      state: "current",
      ageSec: 1_885,
      maxAgeSec: ROUTE_FRESHNESS_MAX_SEC,
    });
    expect(v9Freshness(route.observedAt, missedFixedInputClockSec)).toEqual({
      state: "stale",
      ageSec: 3_685,
      maxAgeSec: ROUTE_FRESHNESS_MAX_SEC,
    });
  });
});
