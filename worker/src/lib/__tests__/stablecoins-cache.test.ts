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
  it("returns strict error when cache is missing", async () => {
    const db = makeDbWithStablecoinsValue(null);

    const result = await loadStablecoinsCache(db, { mode: "strict" });

    expect(result).toEqual({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });
  });

  it("returns lenient error when cache is missing", async () => {
    const db = makeDbWithStablecoinsValue(null);

    const result = await loadStablecoinsCache(db, { mode: "lenient" });

    expect(result).toEqual({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });
  });

  it("returns strict error on malformed JSON", async () => {
    const db = makeDbWithStablecoinsValue("{invalid-json");

    const result = await loadStablecoinsCache(db, { mode: "strict" });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("json-parse-failed");
      expect(result.updatedAt).toBe(1_700_000_000);
    }
  });

  it("returns strict error when peggedAssets key is missing", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify({ fxFallbackRates: { EUR: 1.1 } }));

    const result = await loadStablecoinsCache(db, { mode: "strict" });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("missing-pegged-assets");
    }
  });

  it("returns lenient error when cache is malformed", async () => {
    const db = makeDbWithStablecoinsValue("{still-bad");

    const result = await loadStablecoinsCache(db, { mode: "lenient" });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("json-parse-failed");
    }
  });

  it("returns invalid-payload-shape for scalar payloads", async () => {
    const db = makeDbWithStablecoinsValue("123");

    const strict = await loadStablecoinsCache(db, { mode: "strict" });
    expect(strict.kind).toBe("error");
    if (strict.kind === "error") {
      expect(strict.reason).toBe("invalid-payload-shape");
    }

    const lenient = await loadStablecoinsCache(db, { mode: "lenient" });
    expect(lenient.kind).toBe("error");
    if (lenient.kind === "error") {
      expect(lenient.reason).toBe("invalid-payload-shape");
    }
  });

  it("marks legacy array payloads as degraded when enabled", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify([{ id: "usdt-tether", symbol: "USDT" }]));

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      allowLegacyArray: true,
    });

    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toBe("legacy-array-payload");
      const payload = result.payload;
      expect(payload).not.toBeNull();
      expect(payload?.peggedAssets).toHaveLength(1);
      expect(payload?.peggedAssets[0]?.id).toBe("usdt-tether");
    }
  });

  it("rejects legacy array shape in strict mode when disabled", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify([{ id: "usdt-tether" }]));

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      allowLegacyArray: false,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("legacy-array-not-allowed");
    }
  });

  it("filters FX fallback rates down to finite numeric values", async () => {
    const db = makeDbWithStablecoinsValue(
      JSON.stringify({
        peggedAssets: [{ id: "usdt-tether", symbol: "USDT" }],
        fxFallbackRates: { EUR: 1.09, JPY: "bad", CHF: Infinity, GBP: 1.27 },
      }),
    );

    const result = await loadStablecoinsCache(db, { mode: "strict" });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.payload.fxFallbackRates).toEqual({ EUR: 1.09, GBP: 1.27 });
    }
  });
});
