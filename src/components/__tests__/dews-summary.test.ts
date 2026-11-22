import { describe, expect, it } from "vitest";
import {
  CX,
  CY,
  buildDewsSummaryViewModel,
  computeBandCounts,
  elevatedVisualRadius,
  mcapDotRadius,
  resolveRadarClick,
} from "@/components/dews/dews-summary-model";
import { scoreToRadius } from "@/lib/dews-radar-utils";

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

  it("keeps unknown supply separate from observed zero when sizing radar marks", () => {
    const viewModel = buildDewsSummaryViewModel({
      updatedAt: 1_775_898_800,
      signals: { unknown: { score: 30, band: "WATCH" }, zero: { score: 30, band: "WATCH" } },
    }, undefined, new Map<string, number | null>([["unknown", null], ["zero", 0]]));
    expect(viewModel.elevated.find((coin) => coin.id === "unknown")?.mcap).toBeNull();
    expect(viewModel.elevated.find((coin) => coin.id === "zero")?.mcap).toBe(0);
    expect(mcapDotRadius(null)).toBeUndefined();
    expect(mcapDotRadius(0)).toBe(5);
  });

  it("deterministically repels overlapping ALERT+ logos while preserving exact score radii", () => {
    const signals = {
      "coin-1": { score: 42, band: "ALERT" },
      "coin-2": { score: 42, band: "ALERT" },
      "coin-3": { score: 42, band: "ALERT" },
      "coin-4": { score: 66, band: "WARNING" },
      "coin-5": { score: 66, band: "WARNING" },
    };
    const logos = Object.fromEntries(Object.keys(signals).map((id) => [id, `/logos/${id}.png`]));
    const caps = new Map<string, number | null>(Object.keys(signals).map((id) => [id, 1_000_000_000]));

    const first = buildDewsSummaryViewModel({ updatedAt: 1_775_898_800, signals }, logos, caps);
    const second = buildDewsSummaryViewModel({ updatedAt: 1_775_898_800, signals }, logos, caps);

    // Strictly deterministic across invocations.
    expect(first.elevated.map((c) => [c.id, c.x, c.y])).toEqual(second.elevated.map((c) => [c.id, c.x, c.y]));

    // Every coin remains on its exact score-derived radial ring.
    for (const coin of first.elevated) {
      const actualR = Math.hypot(coin.x - CX, coin.y - CY);
      expect(actualR).toBeCloseTo(scoreToRadius(coin.score, coin.band), 4);
    }

    // Repelled ALERT+ logos do not pile on top of each other.
    for (let i = 0; i < first.elevated.length; i += 1) {
      for (let j = i + 1; j < first.elevated.length; j += 1) {
        const a = first.elevated[i];
        const b = first.elevated[j];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const minSumR = elevatedVisualRadius(a) + elevatedVisualRadius(b);
        expect(dist).toBeGreaterThanOrEqual(minSumR);
      }
    }
  });
});
