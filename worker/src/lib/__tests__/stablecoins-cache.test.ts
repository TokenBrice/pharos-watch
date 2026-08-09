import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadStablecoinsCache } from "../stablecoins-cache";

function makePublishedAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    geckoId: "tether",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "defillama",
    priceConfidence: "high",
    priceUpdatedAt: 1_700_000_000,
    priceObservedAt: 1_700_000_000,
    priceObservedAtMode: "upstream",
    priceSyncedAt: 1_700_000_000,
    consensusSources: [],
    agreeSources: [],
    supplySource: "defillama",
    circulating: { peggedUSD: 100_000_000 },
    circulatingPrevDay: { peggedUSD: 99_000_000 },
    circulatingPrevWeek: { peggedUSD: 98_000_000 },
    circulatingPrevMonth: { peggedUSD: 97_000_000 },
    chainCirculating: {
      Ethereum: {
        current: 100_000_000,
        circulatingPrevDay: 99_000_000,
        circulatingPrevWeek: 98_000_000,
        circulatingPrevMonth: 97_000_000,
      },
    },
    chains: ["Ethereum"],
    ...overrides,
  };
}

function makeDbWithStablecoinsValue(value: string | null): D1Database {
  if (value == null) {
    return mockD1([{ match: "cache", rows: [], first: null }], { requireMatch: true });
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
  ], { requireMatch: true });
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

  it("fails closed on legacy array payloads in strict mode", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify([{ id: "usdt-tether", symbol: "USDT" }]));

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      allowLegacyArray: true,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("legacy-array-payload");
    }
  });

  it("marks legacy array payloads as degraded in lenient mode when enabled", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify([{ id: "usdt-tether", symbol: "USDT" }]));

    const result = await loadStablecoinsCache(db, {
      mode: "lenient",
      allowLegacyArray: true,
    });

    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toBe("legacy-array-payload");
      expect(result.filteredCount).toBe(0);
      const payload = result.payload;
      expect(payload).not.toBeNull();
      expect(payload?.peggedAssets).toHaveLength(1);
      expect(payload?.peggedAssets[0]?.id).toBe("usdt-tether");
    }
  });

  it("rejects legacy array shape unless explicitly enabled", async () => {
    const db = makeDbWithStablecoinsValue(JSON.stringify([{ id: "usdt-tether" }]));

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("legacy-array-not-allowed");
    }
  });

  it("validates with the shared published response contract when requested", async () => {
    const db = makeDbWithStablecoinsValue(
      JSON.stringify({
        peggedAssets: [makePublishedAsset()],
        fxFallbackRates: { peggedEUR: 1.08 },
      }),
    );

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      contract: "published",
      allowLegacyArray: false,
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.filteredCount).toBe(0);
      expect(result.payload.peggedAssets).toHaveLength(1);
      expect(result.payload.peggedAssets[0]?.id).toBe("usdt-tether");
      expect(result.payload.fxFallbackRates).toEqual({ peggedEUR: 1.08 });
    }
  });

  it("rejects partially malformed payloads in published-contract mode", async () => {
    const db = makeDbWithStablecoinsValue(
      JSON.stringify({
        peggedAssets: [
          makePublishedAsset(),
          { id: "broken-coin", symbol: "BROKEN" },
        ],
      }),
    );

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      contract: "published",
      allowLegacyArray: false,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("published-contract-invalid");
    }
  });

  it("rejects malformed entries in strict critical-field mode", async () => {
    const db = makeDbWithStablecoinsValue(
      JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", symbol: "USDT" },
          { id: "broken-coin" },
        ],
      }),
    );

    const result = await loadStablecoinsCache(db, {
      mode: "strict",
      contract: "critical-fields",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("filtered-malformed-entries");
    }
  });

  it("returns degraded filtered count in lenient critical-field compatibility mode", async () => {
    const db = makeDbWithStablecoinsValue(
      JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", symbol: "USDT" },
          { id: "broken-coin" },
        ],
      }),
    );

    const result = await loadStablecoinsCache(db, {
      mode: "lenient",
      contract: "critical-fields",
    });

    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toBe("filtered-malformed-entries");
      expect(result.filteredCount).toBe(1);
      expect(result.payload?.peggedAssets).toHaveLength(1);
      expect(result.payload?.peggedAssets[0]?.id).toBe("usdt-tether");
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
