import { describe, expect, it } from "vitest";
import { malformedInputDegradesRun } from "../malformed-input";

describe("malformedInputDegradesRun", () => {
  it("degrades the run only for aggregate-scope malformed input", () => {
    expect(malformedInputDegradesRun(true, "aggregate")).toBe(true);
  });

  it("treats a missing stablecoin id as aggregate scope", () => {
    expect(malformedInputDegradesRun(true, "")).toBe(true);
  });

  it("quarantines an asset-scoped malformed input without degrading the run", () => {
    expect(malformedInputDegradesRun(true, "usdc-circle")).toBe(false);
  });

  it("never degrades when the caller did not classify the input as run-degrading", () => {
    expect(malformedInputDegradesRun(false, "aggregate")).toBe(false);
    expect(malformedInputDegradesRun(false, "usdc-circle")).toBe(false);
  });
});
