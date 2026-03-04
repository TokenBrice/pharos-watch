import { describe, expect, it } from "vitest";
import {
  formatMintBurnWindowLabel,
  getMintBurnSummaryTimeframe,
  getNetFlowForHours,
} from "../mint-burn-timeframes";

describe("getMintBurnSummaryTimeframe", () => {
  it("uses default 24h/7d windows when there is no override", () => {
    expect(getMintBurnSummaryTimeframe("999")).toEqual({
      shortHours: 24,
      longHours: 168,
      shortLabel: "24h",
      longLabel: "7d",
    });
  });

  it("uses 30d/90d windows for USDT override", () => {
    expect(getMintBurnSummaryTimeframe("1")).toEqual({
      shortHours: 720,
      longHours: 2160,
      shortLabel: "30d",
      longLabel: "90d",
    });
  });
});

describe("formatMintBurnWindowLabel", () => {
  it("formats 24 hours as 24h", () => {
    expect(formatMintBurnWindowLabel(24)).toBe("24h");
  });

  it("formats whole-day windows as days", () => {
    expect(formatMintBurnWindowLabel(168)).toBe("7d");
  });

  it("formats non-day windows as hours", () => {
    expect(formatMintBurnWindowLabel(36)).toBe("36h");
  });
});

describe("getNetFlowForHours", () => {
  const coin = {
    netFlow24hUsd: 10,
    netFlow7dUsd: 20,
    netFlow30dUsd: 30,
    netFlow90dUsd: 40,
  };

  it("returns known precomputed windows", () => {
    expect(getNetFlowForHours(coin, 24)).toBe(10);
    expect(getNetFlowForHours(coin, 168)).toBe(20);
    expect(getNetFlowForHours(coin, 720)).toBe(30);
    expect(getNetFlowForHours(coin, 2160)).toBe(40);
  });

  it("returns null for unsupported windows", () => {
    expect(getNetFlowForHours(coin, 48)).toBeNull();
  });
});
