import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createDexPriceSourceLoadTelemetry, loadDexPrices, type DexPriceRow } from "../../lib/depeg-helpers";

const NOW = 1_700_000_000;
const MAX_AGE = 2_100;
const aggregate = (id: string, updatedAt = NOW): DexPriceRow => ({
  stablecoin_id: id,
  dex_price_usd: 0.98,
  deviation_from_primary_bps: -200,
  source_pool_count: 2,
  source_total_tvl: 1_300_000,
  updated_at: updatedAt,
});
const source = (updatedAt?: number) => ({
  protocol: "fluid", sourceFamily: "fluid", chain: "ethereum", price: 0.98, tvl: 500_000,
  ...(updatedAt === undefined ? {} : { updatedAt }),
});
function database(rows: Array<DexPriceRow & { price_sources_json: string | null }>) {
  const all = vi.fn(async () => ({ results: rows }));
  const db = makeNoopD1({ prepare: vi.fn(() => ({ all })) });
  return { db, all };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("loadDexPrices", () => {
  it("loads both existing map shapes from one union SELECT", async () => {
    const row = aggregate("usdc");
    const sources = [source(), { ...source(), protocol: "balancer", sourceFamily: "balancer" }];
    const { db, all } = database([{ ...row, price_sources_json: JSON.stringify(sources) }]);
    const result = await loadDexPrices(db, NOW);
    expect(result.dexPriceRows).toEqual(new Map([["usdc", row]]));
    expect(result.dexPriceSources).toEqual(new Map([["usdc", sources.map((entry) => ({ ...entry, updatedAt: NOW }))]]));
    expect(db.prepare).toHaveBeenCalledOnce();
    expect(db.prepare).toHaveBeenCalledWith("SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at, price_sources_json FROM dex_prices");
    expect(all).toHaveBeenCalledOnce();
  });

  it("returns both empty maps only for a missing table", async () => {
    const all = vi.fn().mockRejectedValue(new Error("no such table: dex_prices"));
    const db = makeNoopD1({ prepare: vi.fn(() => ({ all })) });
    await expect(loadDexPrices(db, NOW)).resolves.toEqual({ dexPriceRows: new Map(), dexPriceSources: new Map() });
    expect(all).toHaveBeenCalledOnce();
  });

  it("logs and rethrows unexpected D1 failures unchanged", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("D1 storage operation unavailable");
    const db = makeNoopD1({ prepare: vi.fn(() => ({ all: vi.fn().mockRejectedValue(failure) })) });
    await expect(loadDexPrices(db, NOW)).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("excludes NULL source JSON before freshness and decode telemetry without dropping aggregate rows", async () => {
    const { db } = database([{ ...aggregate("usdc", NOW - MAX_AGE - 1), price_sources_json: null }]);
    const telemetry = createDexPriceSourceLoadTelemetry();
    const result = await loadDexPrices(db, NOW, MAX_AGE, telemetry);
    expect(result.dexPriceRows.size).toBe(1);
    expect(result.dexPriceSources.size).toBe(0);
    expect(telemetry).toEqual({ staleRows: [], malformedRows: [] });
  });

  it("logs malformed JSON and invalid shapes while preserving aggregate rows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = database([
      { ...aggregate("parse"), price_sources_json: "{bad-json" },
      { ...aggregate("shape"), price_sources_json: "{}" },
      { ...aggregate("empty"), price_sources_json: "[]" },
    ]);
    const telemetry = createDexPriceSourceLoadTelemetry();
    const result = await loadDexPrices(db, NOW, MAX_AGE, telemetry);
    expect(result.dexPriceRows.size).toBe(3);
    expect(result.dexPriceSources.size).toBe(0);
    expect(telemetry.malformedRows).toEqual([
      { stablecoinId: "parse", updatedAt: NOW, reason: "json-parse-failed" },
      { stablecoinId: "shape", updatedAt: NOW, reason: "invalid-shape" },
    ]);
    expect(warnSpy.mock.calls.filter(([message]) => String(message).includes("owner=depeg-helpers")
      && String(message).includes("context=dex_prices.price_sources_json"))).toHaveLength(2);
  });

  it("uses the explicit pre-await clock at the inclusive row and source freshness boundary", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const boundary = NOW - MAX_AGE;
    const rows = [
      { ...aggregate("boundary", boundary), price_sources_json: JSON.stringify([source(boundary), source(), source(0), source(-1), source(NOW - MAX_AGE - 1), source(NOW + 1)]) },
      { ...aggregate("stale", boundary - 1), price_sources_json: "{bad-json" },
      { ...aggregate("future-row", NOW + 1), price_sources_json: JSON.stringify([source(), source(NOW)]) },
    ];
    const { db, all } = database(rows);
    all.mockImplementation(async () => {
      clock.mockReturnValue((NOW + 60) * 1000);
      return { results: rows };
    });
    const telemetry = createDexPriceSourceLoadTelemetry();
    const result = await loadDexPrices(db, NOW, MAX_AGE, telemetry);
    expect(result.dexPriceRows.size).toBe(3);
    expect(result.dexPriceSources.get("boundary")).toEqual(Array.from({ length: 4 }, () => source(boundary)));
    expect(result.dexPriceSources.has("stale")).toBe(false);
    expect(result.dexPriceSources.get("future-row")).toEqual([source(NOW)]);
    expect(telemetry).toEqual({
      staleRows: [{ stablecoinId: "stale", updatedAt: boundary - 1, ageSec: MAX_AGE + 1, maxAgeSec: MAX_AGE }],
      malformedRows: [],
    });
    expect(clock).not.toHaveBeenCalled();
  });
});
