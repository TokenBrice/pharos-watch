import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { makeAsset } from "../../../test-helpers/__shared/fixtures";
import { MAX_OPEN_DEPEG_EVENTS } from "../../../lib/constants";
import { seedDexEvidence, seedOpenEvent } from "../../__tests__/detect-depegs.test-support";
import { hydrateDepegDetection } from "../hydration";
import { resolveDirectRecovery, resolvePeakUpdateCommand } from "../native-quote-policy";
import { persistDepegCommands } from "../persistence";

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_780_358_400;
const asset = makeAsset({ id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", price: 0.18 });
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW * 1000 + 999); });
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function seedEvents(sqlite: DatabaseSync, count = 1) {
  for (let id = 1; id <= count; id++) {
    seedOpenEvent(sqlite, { id, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", started_at: NOW - 3600 - id });
  }
}
function quoteResponse(updatedAt = NOW - 60) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    brz: { brl: 0.98, last_updated_at: updatedAt },
  }), { status: 200 })));
}

describe("hydrateDepegDetection", () => {
  it("returns open events, derived FX fallback and native quotes while persisting the upstream observation clock", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite);
    seedDexEvidence(sqlite, 0.97, [{ protocol: "curve", price: 0.97, tvl: 3_000_000 }]);
    quoteResponse();
    const hydrated = await hydrateDepegDetection(db, [asset], { peggedREAL: 0.19 });
    expect(hydrated).toMatchObject({ now: NOW, syncStart: NOW, openRowsLimitReached: false });
    expect(hydrated.openRows).toHaveLength(1);
    expect(hydrated.openRows[0]).toMatchObject({ id: 1, stablecoin_id: "brz-transfero", ended_at: null });
    expect(hydrated.pegRates.peggedREAL).toBe(0.19);
    expect(hydrated.pegRateSources.peggedREAL).toBe("fx");
    expect(hydrated.dexPriceRows.get("usdt-tether")).toMatchObject({ dex_price_usd: 0.97, source_pool_count: 1, updated_at: NOW - 60 });
    expect(hydrated.dexPriceSources.get("usdt-tether")).toMatchObject([{ protocol: "curve", price: 0.97, tvl: 3_000_000 }]);
    expect(hydrated.nativePegQuotes.get("brz-transfero")).toMatchObject({ price: 0.98, updatedAt: NOW - 60, pegCurrency: "BRL" });
    const cached = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = 'depeg-native-quote:1'").get();
    expect(cached?.updated_at).toBe(NOW - 60);
    expect(JSON.parse(String(cached?.value))).toEqual({ value: 0.98, observedAt: NOW - 60, source: "coingecko" });
  });

  it.each([
    { label: "native backfill provenance", source: "backfill", quoteMode: "native-peg", native: true },
    { label: "USD backfill provenance", source: "backfill", quoteMode: "usd", native: false },
    { label: "legacy live native event", source: "live", quoteMode: null, native: true },
  ])("preserves the hydrated quote domain for $label through peak and recovery persistence", async ({ source, quoteMode, native }) => {
    const { db, sqlite } = fixtures.open();
    seedOpenEvent(sqlite, {
      id: 1, stablecoin_id: asset.id, symbol: "BRZ", peg_type: "peggedREAL",
      source, peg_reference: native ? 1 : 0.193, start_price: native ? 0.98 : 0.18914,
      peak_price: native ? 0.98 : 0.18914, peak_deviation_bps: -200,
    });
    if (quoteMode != null) {
      sqlite.prepare(`INSERT INTO depeg_event_provenance
        (event_id, source_kind, quote_mode, created_at, updated_at) VALUES (1, 'coingecko', ?, ?, ?)`)
        .run(quoteMode, NOW, NOW);
    }
    quoteResponse();
    const hydrated = await hydrateDepegDetection(db, [asset], { peggedREAL: 0.193 });
    const existing = hydrated.openRows[0];
    expect(existing.quote_mode).toBe(quoteMode);
    const peak = resolvePeakUpdateCommand({
      existing, nativeSignal: deriveDepegSignal(0.96, 1), nativePegPrice: 0.96,
      primarySignal: deriveDepegSignal(0.186, 0.193)!, primaryPrice: 0.186,
      primaryTrust: "authoritative", dexSupportsDirection: false,
    });
    expect(peak).not.toBeNull();
    await persistDepegCommands(db, [peak!]);
    expect(sqlite.prepare("SELECT peak_deviation_bps, peak_price FROM depeg_events WHERE id = 1").get())
      .toEqual({ peak_deviation_bps: native ? -400 : -363, peak_price: native ? 0.96 : 0.186 });
    const recovery = resolveDirectRecovery({
      existing, nativeSignal: deriveDepegSignal(0.999, 1), nativePegPrice: 0.999,
      primaryPrice: 0.193, recoveryThreshold: 50, primarySupportsRecovery: true,
      primaryRecoveryContradicted: false,
    });
    expect(recovery).not.toBeNull();
    await persistDepegCommands(db, [{ type: "close-event", id: existing.id, endedAt: NOW, ...recovery! }]);
    expect(sqlite.prepare("SELECT recovery_price, close_reason FROM depeg_events WHERE id = 1").get())
      .toEqual({ recovery_price: native ? 0.999 : 0.193, close_reason: native ? "recovered-native" : "recovered-primary" });
  });

  it.each([MAX_OPEN_DEPEG_EVENTS, MAX_OPEN_DEPEG_EVENTS + 1])("fails closed at %s open events and leaves native cache evidence unchanged", async (count) => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite, count);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('depeg-native-quote:1', ?, ?)")
      .run(JSON.stringify({ value: 0.97, observedAt: NOW - 120, source: "coingecko" }), NOW - 120);
    quoteResponse();
    const saturated = await hydrateDepegDetection(db, [asset]);
    expect(saturated.openRowsLimitReached).toBe(true);
    expect(saturated.openRows).toEqual([]);
    expect(saturated.nativePegQuotes.get("brz-transfero")?.price).toBe(0.98);
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = 'depeg-native-quote:1'").get()).toEqual({ updated_at: NOW - 120 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'depeg-native-quote:%'").get()).toEqual({ count: 1 });
  });

  it("admits one fewer event than the cap and persists its quote", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite, MAX_OPEN_DEPEG_EVENTS - 1);
    quoteResponse();
    const hydrated = await hydrateDepegDetection(db, [asset]);
    expect(hydrated.openRowsLimitReached).toBe(false);
    expect(hydrated.openRows).toHaveLength(MAX_OPEN_DEPEG_EVENTS - 1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'depeg-native-quote:%'").get())
      .toEqual({ count: MAX_OPEN_DEPEG_EVENTS - 1 });
  });

  it("keeps unavailable native quotes absent rather than fabricating recovery evidence", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite);
    quoteResponse(NOW - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 1);
    const hydrated = await hydrateDepegDetection(db, [asset]);
    expect(hydrated.nativePegQuotes.size).toBe(0);
    expect(hydrated.openRows).toHaveLength(1);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'depeg-native-quote:1'").get()).toBeUndefined();
  });

  it("propagates an unavailable required open-event read instead of returning an apparently empty book", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("DROP TABLE depeg_events");
    await expect(hydrateDepegDetection(db, [])).rejects.toThrow("depeg_events");
  });

  it("does not hide unexpected DEX storage failures as missing corroboration", async () => {
    const { sqlite } = fixtures.open();
    const failure = new Error("DEX read unavailable");
    const db = createSqliteD1(sqlite, { onAll(sql) { if (sql.includes("FROM dex_prices")) throw failure; } });
    await expect(hydrateDepegDetection(db, [])).rejects.toBe(failure);
  });

  it("propagates cancellation before producing or persisting a hydrated result", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite);
    const controller = new AbortController();
    const reason = new Error("detection cancelled");
    controller.abort(reason);
    await expect(hydrateDepegDetection(db, [asset], undefined, controller.signal)).rejects.toBe(reason);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  });
});
