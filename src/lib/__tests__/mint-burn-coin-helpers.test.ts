import { describe, expect, it } from "vitest";
import {
  inferHas24hActivity,
  resolvePressureScore,
  resolvePressureState,
  resolveNetDirection,
} from "../mint-burn-coin-helpers";
import type { MintBurnCoinFlow } from "@shared/types";

function stubCoin(overrides: Partial<MintBurnCoinFlow> = {}): MintBurnCoinFlow {
  return {
    stablecoinId: "test",
    symbol: "TEST",
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    netFlow24hUsd: 0,
    mintCount24h: 0,
    burnCount24h: 0,
    netFlow7dUsd: 0,
    netFlow30dUsd: 0,
    netFlow90dUsd: 0,
    flowIntensity: null,
    ...overrides,
  } as MintBurnCoinFlow;
}

describe("inferHas24hActivity", () => {
  it("returns explicit has24hActivity when present", () => {
    expect(inferHas24hActivity(stubCoin({ has24hActivity: true }))).toBe(true);
    expect(inferHas24hActivity(stubCoin({ has24hActivity: false }))).toBe(false);
  });

  it("derives from volume fields when has24hActivity missing", () => {
    expect(inferHas24hActivity(stubCoin({ mintVolume24hUsd: 100 }))).toBe(true);
    expect(inferHas24hActivity(stubCoin({ burnCount24h: 1 }))).toBe(true);
    expect(inferHas24hActivity(stubCoin())).toBe(false);
  });
});

describe("resolvePressureScore", () => {
  it("prefers pressureShiftScore over flowIntensity", () => {
    expect(resolvePressureScore(stubCoin({ pressureShiftScore: 42, flowIntensity: 10 }))).toBe(42);
  });

  it("falls back to flowIntensity", () => {
    expect(resolvePressureScore(stubCoin({ flowIntensity: 10 }))).toBe(10);
  });

  it("returns null when both absent", () => {
    expect(resolvePressureScore(stubCoin())).toBeNull();
  });
});

describe("resolvePressureState", () => {
  it("returns explicit state when present", () => {
    expect(resolvePressureState(stubCoin({ pressureShiftState: "improving" }))).toBe("improving");
  });

  it("derives from score when state missing", () => {
    expect(resolvePressureState(stubCoin({ pressureShiftScore: 50 }))).toBe("improving");
    expect(resolvePressureState(stubCoin({ pressureShiftScore: -50 }))).toBe("worsening");
  });
});

describe("resolveNetDirection", () => {
  it("returns explicit direction when present", () => {
    expect(resolveNetDirection(stubCoin({ netFlowDirection24h: "minting" }))).toBe("minting");
  });

  it("derives from net flow when direction missing", () => {
    expect(resolveNetDirection(stubCoin({ netFlow24hUsd: 1000, mintVolume24hUsd: 1000 }))).toBe("minting");
  });

  it("derives burning from negative net flow", () => {
    expect(resolveNetDirection(stubCoin({ netFlow24hUsd: -1000, burnVolume24hUsd: 1000 }))).toBe("burning");
  });

  it("returns inactive when all zeros (no activity)", () => {
    expect(resolveNetDirection(stubCoin())).toBe("inactive");
  });

  it("returns flat when net flow is zero but activity exists", () => {
    expect(resolveNetDirection(stubCoin({ netFlow24hUsd: 0, mintVolume24hUsd: 500, burnVolume24hUsd: 500 }))).toBe("flat");
  });
});
