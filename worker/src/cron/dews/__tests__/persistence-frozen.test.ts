import { describe, expect, it } from "vitest";
import { computeStressSignalPruneIds } from "../../../lib/dews/persistence";

describe("DEWS prune set", () => {
  it("preserves frozen coin rows", () => {
    const allDbIds = new Set(["usdt-tether", "usr-resolv", "zombie"]);
    const eligibleIds = new Set(["usdt-tether"]);
    const frozenIds = new Set(["usr-resolv"]);
    expect(computeStressSignalPruneIds(allDbIds, eligibleIds, frozenIds)).toEqual(
      new Set(["zombie"]),
    );
  });
});
