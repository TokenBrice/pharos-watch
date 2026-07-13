import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../../types";
import {
  conservativeImplementationDate,
  fuzzyDateRange,
  resolveEffectiveImplementationLaunchDate,
} from "../resolve-implementation-launch-date";

function meta(overrides: Partial<StablecoinMeta>): StablecoinMeta {
  return {
    id: "asset",
    name: "Asset",
    symbol: "AST",
    flags: {
      backing: "crypto-backed",
      pegCurrency: "USD",
      governance: "decentralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  };
}

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
});
