import { describe, expect, it } from "vitest";
import { resolveCompareSelectedIds } from "../compare-config";

describe("resolveCompareSelectedIds", () => {
  it("keeps canonical ids only", () => {
    expect(resolveCompareSelectedIds("usdc-circle,usdt-tether")).toEqual([
      "usdc-circle",
      "usdt-tether",
    ]);
  });

  it("drops non-canonical selections", () => {
    expect(resolveCompareSelectedIds("usdt,1,usdc-circle")).toEqual([
      "usdc-circle",
    ]);
  });
});
