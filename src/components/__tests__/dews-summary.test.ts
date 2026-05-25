import { describe, expect, it } from "vitest";
import {
  buildDewsSummaryViewModel,
  computeBandCounts,
  getAggregateFreshnessTimestamp,
  resolveRadarClick,
} from "@/components/dews-summary-model";

describe("computeBandCounts", () => {
  it("counts each known threat band and ignores unknown values", () => {
    expect(computeBandCounts({
      usdc: { score: 8, band: "CALM" },
      usdt: { score: 20, band: "WATCH" },
      frax: { score: 44, band: "ALERT" },
      lusd: { score: 66, band: "WARNING" },
      susde: { score: 81, band: "DANGER" },
      ghost: { score: 0, band: "UNKNOWN" },
    })).toEqual({
      CALM: 1,
      WATCH: 1,
      ALERT: 1,
      WARNING: 1,
      DANGER: 1,
    });
  });
});

describe("resolveRadarClick", () => {
  it("navigates immediately for fine pointers", () => {
    expect(resolveRadarClick(true, null, "usdc")).toEqual({
      shouldNavigate: true,
      nextHoveredId: null,
    });
  });

  it("shows tooltip on first coarse-pointer tap", () => {
    expect(resolveRadarClick(false, null, "usdc")).toEqual({
      shouldNavigate: false,
      nextHoveredId: "usdc",
    });
  });

  it("navigates on second coarse-pointer tap for the same coin", () => {
    expect(resolveRadarClick(false, "usdc", "usdc")).toEqual({
      shouldNavigate: true,
      nextHoveredId: null,
    });
  });

  it("switches tooltip target on coarse-pointer tap to a different coin", () => {
    expect(resolveRadarClick(false, "usdc", "usdt")).toEqual({
      shouldNavigate: false,
      nextHoveredId: "usdt",
    });
  });
});

describe("getAggregateFreshnessTimestamp", () => {
  it("uses the aggregate publication timestamp even when some rows are retained last-valid values", () => {
    expect(getAggregateFreshnessTimestamp({
      updatedAt: 1_775_898_800,
      oldestComputedAt: 1_775_889_800,
    })).toBe(1_775_898_800);
  });

  it("falls back to updatedAt for older API responses", () => {
    expect(getAggregateFreshnessTimestamp({ updatedAt: 1_775_898_800 })).toBe(1_775_898_800);
  });
});

describe("buildDewsSummaryViewModel", () => {
  it("derives radar structures together for a single memoized render path", () => {
    const viewModel = buildDewsSummaryViewModel(
      {
        updatedAt: 1_775_898_800,
        signals: {
          usdc: { score: 8, band: "CALM" },
          usdt: { score: 20, band: "WATCH" },
          frax: { score: 66, band: "WARNING" },
        },
      },
      { usdt: "/logos/usdt.png" },
      new Map([["usdt", 1_000_000_000]]),
    );

    expect(viewModel.totalCount).toBe(3);
    expect(viewModel.bandCounts.WARNING).toBe(1);
    expect(viewModel.highest).toBe("WARNING");
    expect(viewModel.elevated.map((coin) => coin.id)).toEqual(["usdt", "frax"]);
    expect(viewModel.calmDots).toHaveLength(1);
    expect(viewModel.updatedAtLabel.length).toBeGreaterThan(0);
  });
});
