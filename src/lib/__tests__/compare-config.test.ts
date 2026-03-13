import { describe, expect, it } from "vitest";
import { resolveCompareSelectedIds } from "../compare-config";

describe("resolveCompareSelectedIds", () => {
  it("prefers canonical ids and unique legacy symbols", () => {
    expect(resolveCompareSelectedIds("usdc-circle,usdt")).toEqual([
      "usdc-circle",
      "usdt-tether",
    ]);
  });

  it("drops ambiguous legacy symbols", () => {
    expect(resolveCompareSelectedIds("usdf,usdc-circle")).toEqual([
      "usdc-circle",
    ]);
  });
});
