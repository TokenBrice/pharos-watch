import { describe, expect, it } from "vitest";
import { computeBandCounts, resolveRadarClick } from "@/components/dews-summary";

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
