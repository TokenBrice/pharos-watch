import { describe, expect, it } from "vitest";
import { buildFreezePlan } from "../freeze-stablecoin";

describe("buildFreezePlan", () => {
  it("composes a frozen-snapshots entry and a JSON-patch hint", () => {
    const plan = buildFreezePlan({
      coinId: "fixture-frozen",
      peakMcap: 12345678,
      peggedAssetRow: { id: "fixture-frozen", name: "Fixture", symbol: "FXT" } as Record<string, unknown> & { id: string },
      frozenAt: "2026-04-27",
      capturedAt: "2026-04-27T01:02:03Z",
    });
    expect(plan.frozenSnapshotsEntry).toMatchObject({ id: "fixture-frozen", capturedAt: "2026-04-27T01:02:03Z" });
    expect(plan.frozenSnapshotsEntry.peggedAssetRow.id).toBe("fixture-frozen");
    expect(plan.metaPatch).toMatchObject({
      status: "frozen",
      frozenAt: "2026-04-27",
    });
    expect(plan.metaPatch.obituary).toBeDefined();
    expect(plan.metaPatch.obituary?.peakMcap).toBe(12345678);
  });
});
