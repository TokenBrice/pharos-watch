import { describe, expect, it } from "vitest";
import { makeStablecoinMeta as meta } from "../../../test-utils/stablecoin";
import {
  conservativeImplementationDate,
  fuzzyDateRange,
  resolveEffectiveImplementationLaunchDate,
} from "../resolve-implementation-launch-date";

describe("implementation launch-date policy", () => {
  it("uses the inclusive period end as the conservative fuzzy-date boundary", () => {
    expect(fuzzyDateRange("2024")).toEqual({ start: "2024-01-01", end: "2024-12-31" });
    expect(fuzzyDateRange("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(fuzzyDateRange("2024-Q2")).toEqual({ start: "2024-04-01", end: "2024-06-30" });
    expect(fuzzyDateRange("2024-H2")).toEqual({ start: "2024-07-01", end: "2024-12-31" });
  });

  it("does not claim track-record history beyond the fixed scoring clock", () => {
    expect(conservativeImplementationDate("2026", "2026-07-13")).toBe("2026-07-13");
    expect(conservativeImplementationDate("2025", "2026-07-13")).toBe("2025-12-31");
  });

  it("uses the newest required layer for a variant", () => {
    const parent = meta({ id: "parent", implementationLaunchDate: "2021-04-05" });
    const child = meta({ id: "child", variantOf: "parent", launchDate: "2025-Q1" });
    const result = resolveEffectiveImplementationLaunchDate(
      child,
      new Map([
        [parent.id, parent],
        [child.id, child],
      ]),
      "2026-07-13",
    );

    expect(result.date).toBe("2025-03-31");
    expect(result.sourceAssetId).toBe("child");
    expect(result.layers.map((layer) => layer.assetId)).toEqual(["child", "parent"]);
  });

  it("terminates deterministically when malformed metadata contains a cycle", () => {
    const first = meta({ id: "a", variantOf: "b", launchDate: "2023" });
    const second = meta({ id: "b", variantOf: "a", launchDate: "2024" });
    const result = resolveEffectiveImplementationLaunchDate(
      first,
      new Map([
        [first.id, first],
        [second.id, second],
      ]),
      "2026-07-13",
    );

    expect(result.cycleDetected).toBe(true);
    expect(result.sourceAssetId).toBe("b");
  });

  it("rejects impossible dates and non-day scoring clocks", () => {
    expect(fuzzyDateRange("2023-02-29")).toBeNull();
    expect(fuzzyDateRange("2024-04-31")).toBeNull();
    expect(conservativeImplementationDate("2024-01-01", "2024-02-30")).toBeNull();
    expect(conservativeImplementationDate("2024-01-01", "2024-Q2")).toBeNull();
  });

  it("prefers authored implementation date over the newer launch date", () => {
    const coin = meta({ id: "asset", implementationLaunchDate: "2022-01-01", launchDate: "2025" });
    expect(resolveEffectiveImplementationLaunchDate(coin, new Map(), "2026-07-13")).toMatchObject({
      date: "2022-01-01", sourceAssetId: "asset",
    });
  });

  it("walks beyond the parent to the newest required grandparent", () => {
    const grandparent = meta({ id: "grandparent", launchDate: "2025" });
    const parent = meta({ id: "parent", variantOf: grandparent.id, launchDate: "2024" });
    const child = meta({ id: "child", variantOf: parent.id, launchDate: "2023" });
    const registry = new Map([grandparent, parent, child].map((coin) => [coin.id, coin]));
    expect(resolveEffectiveImplementationLaunchDate(child, registry, "2026-07-13")).toMatchObject({
      date: "2025-12-31", sourceAssetId: "grandparent",
    });
  });

  it("returns no date for missing-parent and entirely undated chains", () => {
    const parent = meta({ id: "parent" });
    const child = meta({ id: "child", variantOf: parent.id });
    for (const registry of [new Map(), new Map([[parent.id, parent]])]) {
      expect(resolveEffectiveImplementationLaunchDate(child, registry, "2026-07-13")).toEqual({
        date: null, sourceAssetId: null, layers: [], cycleDetected: false,
      });
    }
  });

  it("breaks equal-date ties by asset ID rather than traversal order", () => {
    const parent = meta({ id: "a", launchDate: "2024-12-31" });
    const child = meta({ id: "z", variantOf: parent.id, launchDate: "2024" });
    expect(resolveEffectiveImplementationLaunchDate(child, new Map([[parent.id, parent]]), "2026-07-13"))
      .toMatchObject({ date: "2024-12-31", sourceAssetId: "a" });
  });
});
