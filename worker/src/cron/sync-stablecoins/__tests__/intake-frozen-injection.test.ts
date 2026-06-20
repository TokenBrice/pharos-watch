import { describe, expect, it } from "vitest";
import { mergeFrozenSnapshots } from "../intake";

describe("mergeFrozenSnapshots", () => {
  const snapshots = [
    {
      id: "fixture-frozen",
      capturedAt: "2026-04-27T00:00:00Z",
      peggedAssetRow: { id: "fixture-frozen", name: "Fixture", symbol: "FXT" } as Record<string, unknown> & { id: string },
    },
  ];

  it("appends a snapshot row when upstream is missing it", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    const merged = mergeFrozenSnapshots(upstream, snapshots);
    expect(merged).toHaveLength(2);
    expect(merged.find((a) => (a as { id: string }).id === "fixture-frozen")).toMatchObject({ name: "Fixture" });
  });

  it("does not duplicate when upstream already contains the row", () => {
    const upstream = [
      { id: "fixture-frozen", name: "Fixture (live)", symbol: "FXT" } as never,
      { id: "usdt-tether", name: "Tether", symbol: "USDT" } as never,
    ];
    const merged = mergeFrozenSnapshots(upstream, snapshots);
    expect(merged).toHaveLength(2);
    // upstream wins — preserves anything upstream still serves
    expect((merged.find((a) => (a as { id: string }).id === "fixture-frozen") as { name: string }).name).toBe("Fixture (live)");
  });

  it("does not duplicate when an upstream DefiLlama id maps to the snapshot canonical id", () => {
    const upstream = [
      { id: "1", name: "Tether (live)", symbol: "USDT" } as never,
    ];
    const merged = mergeFrozenSnapshots(upstream, [
      {
        id: "usdt-tether",
        capturedAt: "2026-04-27T00:00:00Z",
        peggedAssetRow: { id: "usdt-tether", name: "Tether (snapshot)", symbol: "USDT" },
      },
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { name: string }).name).toBe("Tether (live)");
  });

  it("deduplicates repeated snapshots before the canonical dedupe stage", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    const merged = mergeFrozenSnapshots(upstream, [...snapshots, ...snapshots]);
    expect(merged.filter((a) => (a as { id: string }).id === "fixture-frozen")).toHaveLength(1);
  });

  it("returns input unchanged when no snapshots provided", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    expect(mergeFrozenSnapshots(upstream, [])).toBe(upstream);
  });
});
