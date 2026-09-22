import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadFxRatesForPriceBounds } from "../sync-stablecoins/enrich-prices-progress";

describe("loadFxRatesForPriceBounds", () => {
  it("rejects a cached FX rate map with string values", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: "1.08" }),
          updated_at: Math.floor(Date.now() / 1000),
        },
      },
    ], { assertMatchesUsed: true });

    await expect(loadFxRatesForPriceBounds(db)).resolves.toBeUndefined();
  });

  it("returns a cached FX rate map when every value is positive and finite", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08 }),
          updated_at: Math.floor(Date.now() / 1000),
        },
      },
    ], { assertMatchesUsed: true });

    await expect(loadFxRatesForPriceBounds(db)).resolves.toEqual({ peggedEUR: 1.08 });
  });
});
