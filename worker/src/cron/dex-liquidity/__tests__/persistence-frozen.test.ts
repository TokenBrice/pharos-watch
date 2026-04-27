import { describe, expect, it } from "vitest";
import { computeDexPruneSet } from "../persistence";

describe("dex-liquidity prune set", () => {
  it("preserves rows for frozen coin ids and the __global__ aggregate", () => {
    const allDbIds = new Set(["usdt-tether", "usr-resolv", "zombie-coin", "__global__"]);
    const trackedIds = new Set(["usdt-tether", "usr-resolv"]);
    const prune = computeDexPruneSet(allDbIds, trackedIds);
    expect(prune).toEqual(new Set(["zombie-coin"]));
    expect(prune.has("usr-resolv")).toBe(false);
    expect(prune.has("__global__")).toBe(false);
  });
});
