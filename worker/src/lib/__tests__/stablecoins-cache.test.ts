import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { loadStablecoinsCache } from "../stablecoins-cache";

function makeDbWithStablecoinsValue(value: string | null): D1Database {
  if (value == null) {
    return mockD1([{ match: "cache", rows: [], first: null }]);
  }
  return mockD1([
    {
      match: "cache",
      rows: [],
      first: {
        value,
        updated_at: 1_700_000_000,
      },
    },
  ]);
}

describe("loadStablecoinsCache", () => {
  it("returns strict error on malformed JSON", async () => {
    const db = makeDbWithStablecoinsValue("{invalid-json");

    const result = await loadStablecoinsCache(db, { mode: "strict" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("json-parse-failed");
      expect(result.updatedAt).toBe(1_700_000_000);
    }
  });

  it("returns strict error when peggedAssets key is missing", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify({ fxFallbackRates: { EUR: 1.1 } }));

    const result = await loadStablecoinsCache(db, { mode: "strict" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-pegged-assets");
    }
  });

  it("returns lenient empty payload when cache is malformed", async () => {
    const db = makeDbWithStablecoinsValue("{still-bad");

    const result = await loadStablecoinsCache(db, { mode: "lenient" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warningReason).toBe("json-parse-failed");
      expect(result.payload.peggedAssets).toEqual([]);
    }
  });

  it("supports legacy array shape fallback when enabled", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify([{ id: "1", symbol: "USDT" }]));

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      allowLegacyArray: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.peggedAssets).toHaveLength(1);
      expect(result.payload.peggedAssets[0]?.id).toBe("1");
    }
  });

  it("rejects legacy array shape in strict mode when disabled", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify([{ id: "1" }]));

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      allowLegacyArray: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("legacy-array-not-allowed");
    }
  });
});
