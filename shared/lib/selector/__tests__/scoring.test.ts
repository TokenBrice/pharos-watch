import { describe, expect, it } from "vitest";
import { scoreRow } from "../scoring";
import { makeInput, makeMergedRowWithIdentity } from "./fixture";

describe("yield confidence history maturity", () => {
  it("does not cap a fully observed 30-day rail", () => {
    const input = makeInput({ profile: "yield" });
    const row = makeMergedRowWithIdentity(
      { id: "usdt-tether", symbol: "USDT", name: "Tether" },
      { yieldObservationDays30d: 30 },
    );

    const result = scoreRow(row, "yield", input);

    expect(result?.confidenceReasons).not.toContain("short-yield-history");
    expect(result?.confidence).toBeGreaterThan(80);
  });

  it("caps rails with fewer than 21 distinct observation days", () => {
    const input = makeInput({ profile: "yield" });
    const row = makeMergedRowWithIdentity(
      { id: "short-history", symbol: "SHORT", name: "Short History" },
      { yieldObservationDays30d: 20 },
    );

    const result = scoreRow(row, "yield", input);

    expect(result?.confidenceReasons).toContain("short-yield-history");
    expect(result?.confidence).toBe(80);
  });
});
