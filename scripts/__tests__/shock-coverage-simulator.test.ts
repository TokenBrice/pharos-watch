import { describe, expect, it } from "vitest";
import {
  aggregateShockScenarios,
  simulateLiquityV1Scenario,
  simulateLiquityV2Scenario,
  type LiquityV2SimulationInput,
  type ShockPositionInput,
} from "../lib/mechanism-measurement/shock-simulator";
import { isWithinDeltaPpm } from "../lib/mechanism-measurement/shock-producer";
import { assessShockCoverageApplicability } from "../lib/mechanism-measurement/shock-targets";

const WAD = 10n ** 18n;

function position(id: string, debt: number, collateral: number, liquidationOrder: number): ShockPositionInput {
  return {
    id,
    debt: BigInt(debt) * WAD,
    collateral: BigInt(collateral) * WAD,
    pendingDebt: 0n,
    pendingCollateral: 0n,
    status: "active",
    liquidationOrder,
  };
}

describe("Liquity V1 shock simulator", () => {
  it("returns full coverage when the unlimited run has no liquidation demand", () => {
    const scenario = simulateLiquityV1Scenario(
      {
        price: 2_000n * WAD,
        mcr: (11n * WAD) / 10n,
        ccr: (15n * WAD) / 10n,
        protocolDebt: 4_000n * WAD,
        protocolCollateral: 10n * WAD,
        stabilityPoolDeposits: 500n * WAD,
        positions: [position("low", 2_000, 4, 0), position("high", 2_000, 6, 1)],
      },
      500_000,
    );

    expect(scenario.unlimited.liquidatableDebt).toBe(0n);
    expect(scenario.unlimited.callerBatchPositionIds).toBeNull();
    expect(scenario.actual.poolOffsetDebt).toBe(0n);
    expect(scenario.coverageRatio).toBe(1);
  });

  it("preserves Recovery Mode redistribution and full-position offset requirements", () => {
    const scenario = simulateLiquityV1Scenario(
      {
        price: WAD,
        mcr: (11n * WAD) / 10n,
        ccr: (15n * WAD) / 10n,
        protocolDebt: 400n * WAD,
        protocolCollateral: 495n * WAD,
        stabilityPoolDeposits: 150n * WAD,
        positions: [
          position("underwater", 100, 90, 0),
          position("partial", 100, 105, 1),
          position("full-only", 100, 115, 2),
          position("protected", 0 + 100, 150, 3),
        ],
      },
      0,
    );

    expect(scenario.unlimited.liquidatableDebt).toBe(300n * WAD);
    expect(scenario.unlimited.poolOffsetDebt).toBe(200n * WAD);
    expect(scenario.unlimited.redistributedDebt).toBe(100n * WAD);
    expect(scenario.actual.liquidatableDebt).toBe(200n * WAD);
    expect(scenario.actual.poolOffsetDebt).toBe(100n * WAD);
    expect(scenario.actual.redistributedDebt).toBe(100n * WAD);
    expect(scenario.actual.outcomes.find((outcome) => outcome.positionId === "full-only")?.action).toBe(
      "skipped-insufficient-full-offset",
    );
  });
});

describe("Liquity V2 shock simulator", () => {
  it("leaves one BOLD in each branch and keeps aggregate Q/O order-invariant", () => {
    const branch: LiquityV2SimulationInput = {
      price: WAD,
      mcr: (11n * WAD) / 10n,
      ccr: (15n * WAD) / 10n,
      protocolDebt: 200n * WAD - 1n,
      protocolCollateral: 301n * WAD,
      stabilityPoolDeposits: 101n * WAD,
      positions: [
        position("a", 120, 100, 0),
        position("b", 80, 80, 1),
        { ...position("surviving-zombie", 0, 1, 2), status: "zombie" },
      ],
    };
    const forward = simulateLiquityV2Scenario(branch, 0);
    const reverse = simulateLiquityV2Scenario(
      {
        ...branch,
        positions: [...branch.positions].reverse().map((entry, index) => ({ ...entry, liquidationOrder: index })),
      },
      0,
    );

    expect(forward.unlimited.liquidatableDebt).toBe(200n * WAD);
    expect(forward.unlimited.callerBatchPositionIds).toEqual(["a", "b"]);
    expect(reverse.unlimited.callerBatchPositionIds).toEqual(["b", "a"]);
    expect(forward.unlimited.startingPoolDebt).toBe(200n * WAD);
    expect(forward.actual.startingPoolDebt).toBe(100n * WAD);
    expect(forward.actual.poolOffsetDebt).toBe(100n * WAD);
    expect(forward.coverageRatio).toBe(0.5);
    expect(reverse.unlimited.liquidatableDebt).toBe(forward.unlimited.liquidatableDebt);
    expect(reverse.actual.poolOffsetDebt).toBe(forward.actual.poolOffsetDebt);
  });

  it("protects the last system Trove and preserves caller-supplied order", () => {
    const input = {
      price: WAD,
      mcr: (11n * WAD) / 10n,
      ccr: (15n * WAD) / 10n,
      protocolDebt: 200n * WAD,
      protocolCollateral: 180n * WAD,
      stabilityPoolDeposits: 101n * WAD,
      positions: [position("a", 120, 100, 0), position("b", 80, 80, 1)],
    };
    const forward = simulateLiquityV2Scenario(input, 0);
    const reverse = simulateLiquityV2Scenario(
      {
        ...input,
        positions: [...input.positions].reverse().map((entry, index) => ({ ...entry, liquidationOrder: index })),
      },
      0,
    );

    expect(forward.unlimited.liquidatableDebt).toBe(120n * WAD);
    expect(forward.unlimited.callerBatchPositionIds).toEqual(["a"]);
    expect(forward.unlimited.outcomes[1]?.action).toBe("protected-last-position");
    expect(reverse.unlimited.liquidatableDebt).toBe(80n * WAD);
    expect(reverse.unlimited.callerBatchPositionIds).toEqual(["b"]);
    expect(reverse.unlimited.outcomes[1]?.action).toBe("protected-last-position");
  });

  it("treats a fully redeemed zero-debt zombie as infinitely collateralized", () => {
    const scenario = simulateLiquityV2Scenario(
      {
        price: WAD,
        mcr: (11n * WAD) / 10n,
        ccr: (15n * WAD) / 10n,
        protocolDebt: 100n * WAD,
        protocolCollateral: 101n * WAD,
        stabilityPoolDeposits: 50n * WAD,
        positions: [{ ...position("redeemed-zombie", 0, 1, 0), status: "zombie" }, position("active", 100, 100, 1)],
      },
      0,
    );

    expect(scenario.unlimited.outcomes[0]).toMatchObject({
      positionId: "redeemed-zombie",
      action: "not-liquidatable",
      icrRaw: 2n ** 256n - 1n,
    });
    expect(scenario.unlimited.liquidatableDebt).toBe(100n * WAD);
  });

  it("aggregates branches without cross-subsidizing their Stability Pools", () => {
    const branchA = [
      simulateLiquityV2Scenario(
        {
          price: WAD,
          mcr: (11n * WAD) / 10n,
          ccr: (15n * WAD) / 10n,
          protocolDebt: 100n * WAD,
          protocolCollateral: 101n * WAD,
          stabilityPoolDeposits: 101n * WAD,
          positions: [position("a", 100, 100, 0), { ...position("a-safe", 0, 1, 1), status: "zombie" }],
        },
        0,
      ),
    ];
    const branchB = [
      simulateLiquityV2Scenario(
        {
          price: WAD,
          mcr: (11n * WAD) / 10n,
          ccr: (15n * WAD) / 10n,
          protocolDebt: 100n * WAD,
          protocolCollateral: 101n * WAD,
          stabilityPoolDeposits: WAD,
          positions: [position("b", 100, 100, 0), { ...position("b-safe", 0, 1, 1), status: "zombie" }],
        },
        0,
      ),
    ];

    expect(aggregateShockScenarios([branchA, branchB])).toEqual([
      {
        shockFractionPpm: 0,
        liquidatableDebt: 200n * WAD,
        poolOffsetDebt: 100n * WAD,
        redistributedDebt: 100n * WAD,
        coverageRatio: 0.5,
      },
    ]);
  });
});

describe("shock measurement reconciliation", () => {
  it("enforces the 0.1% tolerance without flooring across the boundary", () => {
    expect(isWithinDeltaPpm(1_001_000n, 1_000_000n, 1_000)).toBe(true);
    expect(isWithinDeltaPpm(1_001_001n, 1_000_000n, 1_000)).toBe(false);
  });
});

describe("shock-path applicability", () => {
  it("forces MIM onto the visible legacy fallback", () => {
    expect(assessShockCoverageApplicability("mim-abracadabra")).toEqual({
      assetId: "mim-abracadabra",
      applicable: false,
      completeSimulator: false,
      reconciledCommittedPool: false,
      selectedPath: "legacyLCR",
      failureReason: "no-reconciled-committed-pool-and-no-complete-family-simulator",
    });
  });
});
