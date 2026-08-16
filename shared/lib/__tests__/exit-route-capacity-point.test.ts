import { describe, expect, it } from "vitest";

import { buildExitRouteCapacityPoint } from "../exit-route-capacity-point";

describe("buildExitRouteCapacityPoint", () => {
  it("caps capacity at the request and computes a ratio", () => {
    expect(buildExitRouteCapacityPoint(
      { requestedNotionalUsd: 100, maxCostBps: 100, capacityUsd: 150 },
      { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null },
    )).toEqual({
      requestedNotionalUsd: 100,
      maxCostBps: 100,
      executableUsd: 100,
      completionRatio: 1,
    });
  });

  it("makes clamping and rounding explicit", () => {
    expect(buildExitRouteCapacityPoint(
      { requestedNotionalUsd: 3, maxCostBps: 100, capacityUsd: -0.004 },
      { clampNegativeCapacity: true, usdDecimals: 2, ratioDecimals: 6 },
    )).toMatchObject({ executableUsd: 0, completionRatio: 0 });

    expect(() => buildExitRouteCapacityPoint(
      { requestedNotionalUsd: 3, maxCostBps: 100, capacityUsd: -0.004 },
      { clampNegativeCapacity: false, usdDecimals: null, ratioDecimals: null },
    )).toThrow("capacityUsd must be nonnegative when clamping is disabled");

    expect(buildExitRouteCapacityPoint(
      { requestedNotionalUsd: 3, maxCostBps: 100, capacityUsd: 1.2349 },
      { clampNegativeCapacity: true, usdDecimals: 2, ratioDecimals: 6 },
    )).toMatchObject({ executableUsd: 1.23, completionRatio: 0.41 });
  });

  it("supports an explicit producer admission gate and execution cost", () => {
    expect(buildExitRouteCapacityPoint(
      {
        requestedNotionalUsd: 100,
        maxCostBps: 75,
        capacityUsd: 80,
        admitted: false,
        executionCostBps: 90,
      },
      { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null },
    )).toEqual({
      requestedNotionalUsd: 100,
      maxCostBps: 75,
      executableUsd: 0,
      completionRatio: 0,
    });

    expect(buildExitRouteCapacityPoint(
      {
        requestedNotionalUsd: 100,
        maxCostBps: 75,
        capacityUsd: 80,
        executionCostBps: 60,
      },
      { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null },
    )).toMatchObject({ executableUsd: 80, completionRatio: 0.8, executionCostBps: 60 });
  });

  it("rejects malformed numeric inputs", () => {
    const options = { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null } as const;
    expect(() => buildExitRouteCapacityPoint(
      { requestedNotionalUsd: 0, maxCostBps: 100, capacityUsd: 1 },
      options,
    )).toThrow("requestedNotionalUsd");
    expect(() => buildExitRouteCapacityPoint(
      { requestedNotionalUsd: 1, maxCostBps: 100, capacityUsd: Number.NaN },
      options,
    )).toThrow("capacityUsd");
  });
});
