import { describe, expect, it } from "vitest";

import {
  MAX_YIELD_WORKBENCH_FALLBACK_ID_LENGTH,
  YIELD_WORKBENCH_FALLBACK_PARAM,
  parseYieldWorkbenchFallbackId,
  setYieldWorkbenchFallbackParam,
} from "../yield-workbench-fallback";

describe("yield workbench fallback query contract", () => {
  it("accepts canonical bounded IDs", () => {
    expect(parseYieldWorkbenchFallbackId("usdc-circle")).toBe("usdc-circle");
    expect(parseYieldWorkbenchFallbackId(" usdt-tether ")).toBe("usdt-tether");
  });

  it("rejects malformed and oversized values", () => {
    expect(parseYieldWorkbenchFallbackId("../admin")).toBeNull();
    expect(parseYieldWorkbenchFallbackId("USDC-circle")).toBeNull();
    expect(parseYieldWorkbenchFallbackId("a".repeat(MAX_YIELD_WORKBENCH_FALLBACK_ID_LENGTH + 1))).toBeNull();
  });

  it("overwrites spoofed or duplicate values with the requested stablecoin", () => {
    const params = new URLSearchParams(
      `${YIELD_WORKBENCH_FALLBACK_PARAM}=not-tracked&days=90&${YIELD_WORKBENCH_FALLBACK_PARAM}=also-not-tracked`,
    );

    expect(setYieldWorkbenchFallbackParam(params, "usdc-circle")).toBe(true);
    expect(params.getAll(YIELD_WORKBENCH_FALLBACK_PARAM)).toEqual(["usdc-circle"]);
    expect(params.get("days")).toBe("90");
  });
});
