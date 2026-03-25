import { describe, it, expect } from "vitest";
import { topologicalOrder } from "../report-cards-snapshot";
import type { StablecoinMeta } from "@shared/types/core";

function makeMeta(
  id: string,
  reserves?: Array<{ coinId?: string; pct: number; name: string; risk: "low" }>,
): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: { governance: "centralized", backing: "rwa-backed" },
    reserves: reserves ?? [],
  } as unknown as StablecoinMeta;
}

describe("topologicalOrder", () => {
  it("returns isolated nodes in original order", () => {
    const metas = [makeMeta("a"), makeMeta("b"), makeMeta("c")];
    const sorted = topologicalOrder(metas);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("places upstream before downstream", () => {
    const metas = [
      makeMeta("downstream", [{ coinId: "upstream", pct: 50, name: "X", risk: "low" }]),
      makeMeta("upstream"),
    ];
    const sorted = topologicalOrder(metas);
    const ids = sorted.map((m) => m.id);
    expect(ids.indexOf("upstream")).toBeLessThan(ids.indexOf("downstream"));
  });

  it("handles diamond dependencies", () => {
    const metas = [
      makeMeta("d", [
        { coinId: "b", pct: 30, name: "B", risk: "low" },
        { coinId: "c", pct: 30, name: "C", risk: "low" },
      ]),
      makeMeta("b", [{ coinId: "a", pct: 50, name: "A", risk: "low" }]),
      makeMeta("c", [{ coinId: "a", pct: 50, name: "A", risk: "low" }]),
      makeMeta("a"),
    ];
    const sorted = topologicalOrder(metas);
    const ids = sorted.map((m) => m.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
  });

  it("does not hang on circular dependencies", () => {
    const metas = [
      makeMeta("x", [{ coinId: "y", pct: 50, name: "Y", risk: "low" }]),
      makeMeta("y", [{ coinId: "x", pct: 50, name: "X", risk: "low" }]),
    ];
    // Should not hang — visited set prevents infinite recursion
    const sorted = topologicalOrder(metas);
    expect(sorted).toHaveLength(2);
  });
});
