import { describe, expect, it } from "vitest";
import { resolveRadarClick } from "@/components/dews-summary";

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
