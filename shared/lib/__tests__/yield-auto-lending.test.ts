import { describe, expect, it } from "vitest";


import { hasStaticYieldWorkbench, type StaticYieldWorkbenchCoin } from "@shared/lib/yield-auto-lending";

describe("yield workbench static route policy", () => {
  it("selects only active intrinsic or overridden routes", () => {
    const fixtures: [StaticYieldWorkbenchCoin, boolean][] = [
      [{ id: "intrinsic-fixture", flags: { yieldBearing: true }, status: "active" }, true],
      [{ id: "plain-fixture", flags: { yieldBearing: false }, status: "active" }, false],
      [{ id: "u-united-stables", flags: { yieldBearing: false }, status: "active" }, true],
      [{ id: "intrinsic-fixture", flags: { yieldBearing: true }, status: "pre-launch" }, false],
      [{ id: "u-united-stables", flags: { yieldBearing: false }, status: "pre-launch" }, false],
    ];
    for (const [coin, expected] of fixtures) {
      expect(hasStaticYieldWorkbench(coin), `${coin.id}:${coin.status}`).toBe(expected);
    }
  });
});
