import { describe, expect, it } from "vitest";
import {
  formatMintBurnWindowLabel,
  getMintBurnSummaryTimeframe,
  getNetFlowForHours,
  resolveFlowWindow,
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
    expect(getMintBurnSummaryTimeframe("usdt-tether")).toEqual({
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

describe("resolveFlowWindow", () => {
  const coin = {
    netFlow24hUsd: 10,
    netFlow7dUsd: 20,
    netFlow30dUsd: 30,
    netFlow90dUsd: 40,
  };

  it("uses the coin 24h/7d fields for the default windows", () => {
    expect(
      resolveFlowWindow(coin, { shortHours: 24, longHours: 168 }, undefined, undefined),
    ).toEqual({ shortNetFlow: 10, longNetFlow: 20 });
  });

  it("prefers custom-window hook net flows when present", () => {
    expect(
      resolveFlowWindow(coin, { shortHours: 720, longHours: 2160 }, 111, 222),
    ).toEqual({ shortNetFlow: 111, longNetFlow: 222 });
  });

  it("falls back to the matching coin field when the custom hook value is missing", () => {
    expect(
      resolveFlowWindow(coin, { shortHours: 720, longHours: 2160 }, undefined, undefined),
    ).toEqual({ shortNetFlow: 30, longNetFlow: 40 });
  });

  it("reuses the short candidate for the long window when long equals short", () => {
    expect(
      resolveFlowWindow(coin, { shortHours: 720, longHours: 720 }, 111, undefined),
    ).toEqual({ shortNetFlow: 111, longNetFlow: 111 });
  });

  it("guards against non-finite candidates by reverting to 24h/7d fields", () => {
    expect(
      resolveFlowWindow(coin, { shortHours: 720, longHours: 2160 }, Number.NaN, Number.NaN),
    ).toEqual({ shortNetFlow: 10, longNetFlow: 20 });
  });
});
