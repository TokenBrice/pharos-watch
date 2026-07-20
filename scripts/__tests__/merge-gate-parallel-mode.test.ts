import { describe, expect, it } from "vitest";
import { resolveMergeGateParallelMode } from "../maintenance/test-merge-gate.mjs";

describe("resolveMergeGateParallelMode", () => {
  it("honors the explicit env override in both directions", () => {
    expect(resolveMergeGateParallelMode({ MERGE_GATE_PARALLEL: "1" }, 2)).toBe(true);
    expect(resolveMergeGateParallelMode({ MERGE_GATE_PARALLEL: "0" }, 64)).toBe(false);
  });

  it("defaults to serial regardless of the machine's logical CPU count", () => {
    expect(resolveMergeGateParallelMode({}, 64)).toBe(false);
    expect(resolveMergeGateParallelMode({}, 16)).toBe(false);
    expect(resolveMergeGateParallelMode({}, 11)).toBe(false);
    expect(resolveMergeGateParallelMode({}, 4)).toBe(false);
  });
});
