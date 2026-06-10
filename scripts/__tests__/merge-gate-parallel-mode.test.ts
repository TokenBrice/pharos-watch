import { describe, expect, it } from "vitest";
import { resolveMergeGateParallelMode } from "../maintenance/test-merge-gate.mjs";

describe("resolveMergeGateParallelMode", () => {
  it("honors the explicit env override in both directions", () => {
    expect(resolveMergeGateParallelMode({ MERGE_GATE_PARALLEL: "1" }, 2)).toBe(true);
    expect(resolveMergeGateParallelMode({ MERGE_GATE_PARALLEL: "0" }, 64)).toBe(false);
  });

  it("auto-enables on machines with enough cores and stays serial below the threshold", () => {
    expect(resolveMergeGateParallelMode({}, 16)).toBe(true);
    expect(resolveMergeGateParallelMode({}, 12)).toBe(true);
    expect(resolveMergeGateParallelMode({}, 11)).toBe(false);
    expect(resolveMergeGateParallelMode({}, 4)).toBe(false);
  });
});
