import { afterEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import type { DepegAuditVerdict } from "@shared/types/depeg-audit";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeDepegRow as makeFixtureDepegRow } from "../../test-helpers/__shared/fixtures";
import type { DepegRow } from "../depeg-helpers";
import { seedPsiDews, seedPsiEvent, seedPsiPairedHistory, seedPsiSupply } from "../../api/__tests__/psi-replay.test-support";
import {
  loadHistoricalPsiArchives,
  loadPsiEligibleDepegEvents,
  loadSupplyHistoryRowsForWindow,
} from "../psi-replay-inputs";
import { buildStabilityInputForDay } from "../psi-recompute";
import { replayHistoricalPsiForDay } from "../psi-replay";

const DAY = 1_772_668_800;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.restoreAllMocks();
  fixtures.closeAll();
});

function makeDepegRow(overrides: Partial<DepegRow> = {}): DepegRow {
  return {
    ...makeFixtureDepegRow(),
    confirmation_sources: null,
    pending_reason: null,
    ...overrides,
  };
}

describe("PSI replay input loaders", () => {
  it("reads inclusive supply boundaries in order, preserving observed zero and prices", async () => {
    const { sqlite, db } = fixtures.open();
    seedPsiSupply(sqlite, [
      { stablecoin_id: "usdt-tether", snapshot_date: DAY, circulating_usd: 100e9, price: 0.99 },
      { stablecoin_id: "usdt-tether", snapshot_date: 0, circulating_usd: 0, price: null },
      { stablecoin_id: "usdt-tether", snapshot_date: DAY + DAY_SECONDS, circulating_usd: 101e9, price: 1 },
    ]);

    sqlite.prepare("UPDATE supply_history SET price_observed_at = ? WHERE snapshot_date = ?").run(DAY + 1, DAY);
    expect(await loadSupplyHistoryRowsForWindow(db, -DAY_SECONDS, DAY)).toEqual([
      { stablecoin_id: "usdt-tether", snapshot_date: 0, circulating_usd: 0, price: null, price_observed_at: null },
      { stablecoin_id: "usdt-tether", snapshot_date: DAY, circulating_usd: 100e9, price: 0.99, price_observed_at: DAY + 1 },
    ]);
    expect(await loadSupplyHistoryRowsForWindow(db, DAY + 1, DAY + DAY_SECONDS - 1)).toEqual([]);
  });

  it("includes the full prior-week as-of margin without reading future supply or DEWS", async () => {
    const { sqlite, db } = fixtures.open();
    seedPsiSupply(sqlite, [-22, -21, 0, 1].map((offset) => ({
      stablecoin_id: "usdt-tether", snapshot_date: DAY + offset * DAY_SECONDS,
      circulating_usd: offset === 0 ? 0 : 100e9, price: 0.99,
    })));
    seedPsiDews(sqlite, [-1, 0, 1].map((offset) => ({
      stablecoin_id: "usdt-tether", snapshot_date: DAY + offset * DAY_SECONDS, band: "CALM",
    })));

    const archives = await loadHistoricalPsiArchives(db, DAY, DAY);
    expect(archives.supplyByCoin.get("usdt-tether")).toEqual([
      { date: DAY - 21 * DAY_SECONDS, mcap: 100e9, price: 0.99 },
      { date: DAY, mcap: 0, price: 0.99 },
    ]);
    expect([...archives.dewsByDay]).toEqual([
      [DAY, [{ stablecoin_id: "usdt-tether", snapshot_date: DAY, band: "CALM" }]],
    ]);
  });

  it("keeps missing archives empty rather than manufacturing a calm observation", async () => {
    const { db } = fixtures.open();
    const archives = await loadHistoricalPsiArchives(db, DAY, DAY);
    expect(archives.supplyByCoin.size).toBe(0);
    expect(archives.dewsByDay.size).toBe(0);
  });

  it("pairs proven native quantities independently of dated capitalization in historical replay", async () => {
    const { sqlite, db } = fixtures.open();
    const id = "usdt-tether";
    const prior = DAY - 7 * DAY_SECONDS;
    seedPsiSupply(sqlite, [
      { stablecoin_id: id, snapshot_date: prior, circulating_usd: 100e9 },
      { stablecoin_id: id, snapshot_date: DAY, circulating_usd: 120e9 },
    ]);
    const update = sqlite.prepare("UPDATE supply_history SET circulating_native = ?, supply_provenance = ? WHERE snapshot_date = ?");
    for (const day of [prior, DAY]) {
      update.run(80e9, JSON.stringify({ supplySource: "fixture", supplyObservedAt: day + 60, supplyChainGuard: null }), day);
    }
    const replay = async () => replayHistoricalPsiForDay({
      day: DAY, now: DAY + DAY_SECONDS, methodologyVersion: "2.1", depegEvents: [],
      ...await loadHistoricalPsiArchives(db, DAY, DAY),
    });
    expect((await replay()).input).toMatchObject({ mcap7dChangePct: 20, nativeQuantityMomentum: { [id]: 0 } });
    update.run(80e9, null, prior);
    expect((await replay()).input.nativeQuantityMomentum).toBeUndefined();
  });

  it("omits a weekly pair with partial coverage at either endpoint without native quantity", async () => {
    const { sqlite, db } = fixtures.open();
    const day = Date.UTC(2026, 10, 17) / 1000;
    const prior = day - 7 * DAY_SECONDS;
    const id = "usdc-circle";
    seedPsiPairedHistory(sqlite, day, "dai-makerdao", 100e6);
    seedPsiSupply(sqlite, [
      { stablecoin_id: id, snapshot_date: prior, circulating_usd: 1e9 },
      { stablecoin_id: id, snapshot_date: day, circulating_usd: 400e6 },
    ]);
    const replay = async () => replayHistoricalPsiForDay({
      day, now: day + DAY_SECONDS, methodologyVersion: "3.70", depegEvents: [],
      ...await loadHistoricalPsiArchives(db, day, day),
    });
    expect((await replay()).result?.score).toBe(95);
    const update = sqlite.prepare("UPDATE supply_history SET supply_provenance = ? WHERE stablecoin_id = ? AND snapshot_date = ?");
    for (const endpoint of [day, prior]) {
      if (endpoint === prior) sqlite.exec("ALTER TABLE supply_history DROP COLUMN circulating_native");
      update.run(JSON.stringify({ supplySource: "defillama", supplyObservedAt: endpoint + 60, supplyChainGuard: {
        reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage: true, quarantinedSince: prior - DAY_SECONDS,
        chains: [{ chainId: "ethereum", chainLabel: "Ethereum", listCurrentUsd: 0, baselineUsd: 600e6,
          baselineObservedAt: prior - DAY_SECONDS, baselineSource: "state", resolution: "unavailable" }],
      } }), id, endpoint);
      const { input, result } = await replay();
      expect(input).toMatchObject({ mcap7dChangePct: 0, totalMcapUsd: 500e6 });
      expect(input.trendUnavailableIds).toContain(id);
      expect(result?.score).toBe(100);
      update.run(null, id, endpoint);
    }
  });

  it.each([false, true])("matches wide and narrow gold replay after Sunday reopen (recent mark=%s)", async (recent) => {
    const { sqlite, db } = fixtures.open();
    const day = Date.parse("2026-11-15T00:00:00Z") / 1000;
    const id = "xaut-tether";
    const snapshots = [
      { snapshot_date: day - 37 * DAY_SECONDS, price: 3_600 },
      ...(recent ? [{ snapshot_date: day - 2 * DAY_SECONDS, price: 3_920 }] : []),
      { snapshot_date: day - 7 * DAY_SECONDS }, { snapshot_date: day },
    ];
    seedPsiSupply(sqlite, snapshots.map(({ snapshot_date, price }) => ({
      stablecoin_id: id, snapshot_date, circulating_usd: 1e9, price,
      price_observed_at: price == null ? null : snapshot_date + 20 * 3600,
    })));
    const run = async (startDay: number) => {
      const { supplyByCoin } = await loadHistoricalPsiArchives(db, startDay, day);
      return replayHistoricalPsiForDay({
        day, now: day + DAY_SECONDS, methodologyVersion: "2.1", supplyByCoin, sampleSlots: [day + 22 * 3600, day + 23.5 * 3600],
        depegEvents: [{ stablecoin_id: id, peg_type: "peggedGOLD", quote_mode: "usd", started_at: day - 42 * DAY_SECONDS,
          ended_at: null, peak_deviation_bps: -1_000, peg_reference: 4_000 }],
        references: { referenceAt: (_currency, at) => ({
          usdPerUnit: 4_000, observedAtSec: at - 60, source: "gold-api.com", kind: "fallback",
          observation: { pegKey: "peggedGOLD", usdPerUnit: 4_000, observedAtSec: at - 60, source: "gold-api.com",
            cadence: "intraday", repricing: { source: "gold-api.com", preCloseUsdPerUnit: 4_050,
              sessionOpenedAtSec: getReferenceSessionState("metal", at).sessionOpenedAtSec! } },
        }) },
      });
    };
    const narrow = await run(day);
    expect(await run(day - 42 * DAY_SECONDS)).toEqual(narrow);
    if (recent) {
      expect(narrow.result?.components.breadth).toBeGreaterThan(0);
      expect(narrow.input.depegs[0]?.bps).toBeCloseTo(-200);
    } else {
      expect(narrow.result).toBeNull();
      expect(narrow.unavailableReason).toBe("open-depeg-inputs-unavailable");
    }
  });

  it("filters stored exclusions and uses strict overlap boundaries while retaining native evidence", async () => {
    const { sqlite, db } = fixtures.open();
    const events = [
      makeDepegRow({ id: 1, started_at: DAY - DAY_SECONDS, ended_at: null, source: "backfill", peg_type: "peggedEUR", peg_reference: 1.08, start_price: 0.98 }),
      makeDepegRow({ id: 2, started_at: DAY, ended_at: null }),
      makeDepegRow({ id: 3, started_at: DAY + 1, ended_at: null }),
      makeDepegRow({ id: 4, started_at: DAY + 2, ended_at: null }),
      makeDepegRow({ id: 5, started_at: DAY - DAY_SECONDS, ended_at: DAY }),
      makeDepegRow({ id: 6, started_at: DAY + DAY_SECONDS, ended_at: null }),
      makeDepegRow({ id: 7, started_at: DAY + 3, ended_at: DAY + 4 }),
    ];
    for (const event of events) seedPsiEvent(sqlite, event);
    const provenance = sqlite.prepare(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, quote_mode, audit_verdict, created_at, updated_at)
      VALUES (?, 'backfill', ?, ?, ?, ?)`);
    provenance.run(1, null, "confirmed", DAY, DAY);
    sqlite.prepare("UPDATE depeg_events SET peg_reference = 1 WHERE id = 1").run();
    sqlite.prepare("UPDATE depeg_event_provenance SET peg_reference_source = 'native-peg-history' WHERE event_id = 1").run();
    provenance.run(2, "usd", "false_positive", DAY, DAY);
    provenance.run(3, "usd", "disputed", DAY, DAY);
    provenance.run(7, "usd", "no_data", DAY, DAY);

    const eligible = await loadPsiEligibleDepegEvents(db, { startDay: DAY, endDay: DAY, excludedIds: [4] });
    expect(eligible.map((event) => event.id)).toEqual([1, 7]);
    expect(eligible[0]).toMatchObject({ source: "backfill", peg_type: "peggedEUR", peg_reference: 1, start_price: 0.98, quote_mode: "native-peg", audit_verdict: "confirmed" });
    expect((await loadPsiEligibleDepegEvents(db)).map((event) => event.id).sort()).toEqual([1, 4, 5, 6, 7]);
  });

  it("projects pending restoration and exclusion, notifying only eligibility changes without persisting them", async () => {
    const { sqlite, db } = fixtures.open();
    for (let id = 1; id <= 4; id++) {
      seedPsiEvent(sqlite, makeDepegRow({ id, started_at: DAY + id, ended_at: null }));
    }
    const provenance = sqlite.prepare(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, quote_mode, audit_verdict, created_at, updated_at)
      VALUES (?, 'backfill', 'usd', ?, ?, ?)`);
    provenance.run(1, "false_positive", DAY, DAY);
    provenance.run(2, "confirmed", DAY, DAY);
    provenance.run(3, "disputed", DAY, DAY);
    const onEligibilityChange = vi.fn();
    const auditVerdicts = new Map<number, DepegAuditVerdict>([
      [1, "confirmed"], [2, "false_positive"], [3, "false_positive"], [4, "no_data"],
    ]);

    const eligible = await loadPsiEligibleDepegEvents(db, { auditVerdicts, onEligibilityChange });
    expect(eligible.map((event) => event.id)).toEqual([1, 4]);
    expect(onEligibilityChange.mock.calls.map(([event]) => event.id)).toEqual([1, 2]);
    expect((await loadPsiEligibleDepegEvents(db)).map((event) => event.id)).toEqual([2, 4]);
    expect((await loadPsiEligibleDepegEvents(db, { auditVerdicts, excludedIds: [1] })).map((event) => event.id)).toEqual([4]);
  });

  it("replays the reference-market closure rule over stored events", async () => {
    const { sqlite, db } = fixtures.open();
    // Saturday 2026-11-14 12:00 UTC; FX reopens Sunday 22:00 (1_794_780_000).
    for (const [id, ended_at] of [[1, 1_794_785_400], [2, 1_794_956_400]] as const) {
      seedPsiEvent(sqlite, makeDepegRow({ id, stablecoin_id: `eur-${id}`, started_at: 1_794_657_600, ended_at, peg_type: "peggedEUR", peak_deviation_bps: -300 }));
    }
    expect((await loadPsiEligibleDepegEvents(db)).map(({ id, started_at, counted_from }) => [id, started_at, counted_from]))
      .toEqual([[2, 1_794_657_600, 1_794_780_000]]);

    sqlite.exec(`UPDATE depeg_events SET admitted_coverage_json = '[]' WHERE id = 1;
      UPDATE depeg_events SET admitted_coverage_json = 'invalid' WHERE id = 2;`);
    expect((await loadPsiEligibleDepegEvents(db)).sort((a, b) => a.id - b.id)).toMatchObject([
      { id: 1, admittedCoverage: [] },
      { id: 2, coverageUnavailable: true },
    ]);
  });

  it("scores severe legacy weekend openings in either direction and holds a sub-severe opening", async () => {
    const { sqlite, db } = fixtures.open();
    const day = Date.UTC(2026, 10, 14) / 1000;
    const start = day + 22 * 3600;
    const id = "eurc-circle";
    seedPsiPairedHistory(sqlite, day, id, 1e9);
    seedPsiEvent(sqlite, makeDepegRow({ id: 1, stablecoin_id: id, peg_type: "peggedEUR", peg_reference: 1,
      source: "live", started_at: start, ended_at: start + 3 * 3600 }));
    const update = sqlite.prepare("UPDATE depeg_events SET direction = ?, start_price = ?, peak_deviation_bps = ? WHERE id = 1");
    const archives = await loadHistoricalPsiArchives(db, day, day);
    for (const [bps, score] of [[-3000, 29], [3000, 29], [-1000, 100]]) {
      update.run(bps < 0 ? "below" : "above", 1 + bps / 10000, bps);
      const replay = replayHistoricalPsiForDay({
        ...archives, day, now: day + DAY_SECONDS, methodologyVersion: "3.70",
        depegEvents: await loadPsiEligibleDepegEvents(db), sampleSlots: [start + 1800],
      });
      expect(replay.result?.score).toBe(score);
    }
  });

  it("honors empty reviewed coverage and the admitted peer basis at a Saturday sample", async () => {
    const { sqlite, db } = fixtures.open();
    const day = Date.parse("2026-11-14T00:00:00Z") / 1000;
    const onset = day + 3600;
    const id = "eurc-circle";
    seedPsiSupply(sqlite, [day - 7 * DAY_SECONDS, day].map((snapshot_date) => ({
      stablecoin_id: id, snapshot_date, circulating_usd: 5e9,
    })));
    for (const [eventId, started_at, start_price] of [[1, day - 3 * 3600, 1.045], [2, onset, 1.067]] as const) {
      seedPsiEvent(sqlite, makeDepegRow({ id: eventId, stablecoin_id: id, peg_type: "peggedEUR", direction: "below",
        started_at, ended_at: null, start_price, peg_reference: 1.1, peak_deviation_bps: -500 }));
    }
    sqlite.exec("UPDATE depeg_events SET disposition = 'admitted-coverage' WHERE id = 1");
    const peak = onset + 600;
    const receipt = (at: number, price: number, bps: number) => ({
      basis: "peer-relative", observedAt: at, price, pegReference: 1.1, bps, corroboration: {
        basis: "peer-relative", confidence: "low", quoteObservedAt: at - 30,
        contributors: ["a", "b", "c"].map((peer) => ({ id: peer, provenanceKey: peer, observedAtSec: at - 30 })),
        corroborator: { source: "pool:curve:defillama", observedAtSec: at - 30 },
      },
    });
    const latest = receipt(onset + 300, 1.034, -600);
    sqlite.prepare(`UPDATE depeg_events SET pending_reason = 'peer-relative', peak_price = 0.99, peak_peg_reference = 1.1,
      peak_deviation_bps = -1000, peak_quote_domain = 'usd', peer_basis_json = ? WHERE id = 2`).run(JSON.stringify({
      onset: receipt(onset, 1.067, -300), peak: receipt(peak, 0.99, -1000),
      latest: { ...latest, seenAt: onset + 360, corroboration: {
        ...latest.corroboration, quoteObservedAt: latest.observedAt,
        corroborator: { source: "pool:curve:defillama", observedAtSec: onset + 359 },
      } },
    }));
    const depegEvents = await loadPsiEligibleDepegEvents(db);
    expect(depegEvents[0]).toMatchObject({ id: 1, admittedCoverage: [] });
    const { supplyByCoin } = await loadHistoricalPsiArchives(db, day, day);
    const at = [onset + 60, onset + 359, onset + 360, peak - 1, peak];
    const input = buildStabilityInputForDay(day, peak + 60, depegEvents, supplyByCoin, undefined, undefined, at);
    expect(input.activity[0]?.intervals.map(({ bps }) => Math.round(bps))).toEqual([-300, -300, -600, -600, -1000]);
    const nextWeek = day + 7 * DAY_SECONDS;
    const expires = peak - 30 + 7 * DAY_SECONDS;
    const sample = (at: number) => buildStabilityInputForDay(nextWeek, at, depegEvents, supplyByCoin, undefined, undefined, [at]);
    expect(sample(expires).depegs).toMatchObject([{ bps: expect.closeTo(-1000, 8) }]);
    expect(sample(expires + 1).openDepegsWithoutPrice).toBe(1);
  });

  it("replays silver quotes with their own dated entitlement in both quote domains", async () => {
    const { sqlite, db } = fixtures.open();
    const day = Date.parse("2026-11-17T00:00:00Z") / 1000;
    const at = day + 16 * 3600;
    const id = "xagm-matrixdock";
    const ozPerToken = 0.998380822;
    seedPsiSupply(sqlite, [day - 7 * DAY_SECONDS, day].map((snapshot_date) => ({
      stablecoin_id: id, snapshot_date, circulating_usd: 5e9,
    })));
    const archive = await loadHistoricalPsiArchives(db, day, day);
    for (const quote_mode of ["native-peg", "usd"]) {
      const native = quote_mode === "native-peg";
      const event = { stablecoin_id: id, peg_type: "peggedSILVER", quote_mode, started_at: at, ended_at: null,
        start_price: (native ? 1 : 30) * ozPerToken, peg_reference: native ? 1 : 30, peak_deviation_bps: -500 };
      for (const offset of [0, 1]) {
        const replay = replayHistoricalPsiForDay({
          day, now: at + 60, sampleSlots: [at + 60], methodologyVersion: "2.1", ...archive, depegEvents: [event],
          references: {
            referenceAt: () => ({ usdPerUnit: 30, observedAtSec: at - 60, source: "gold-api.com", kind: "fallback",
              observation: { pegKey: "peggedSILVER", usdPerUnit: 30, observedAtSec: at - 60, source: "gold-api.com",
                cadence: "intraday", repricing: { source: "gold-api.com", preCloseUsdPerUnit: 29,
                  sessionOpenedAtSec: getReferenceSessionState("metal", at).sessionOpenedAtSec! } } }),
            entitlementAt: () => ({ source: "matrixdock-frs", generation: "ethereum:123", ozPerToken,
              observedAtSec: at - 90, quoteObservedAtSec: at + offset }),
          },
        });
        expect(replay.unavailableReason).toBe(offset ? "open-depeg-inputs-unavailable" : null);
        if (!offset) expect(replay.input.depegs).toMatchObject([{ bps: 0 }]);
      }
    }
  });

  it("retains both reviewed restoration identities and uses onset evidence over the lifetime peak", async () => {
    const { sqlite, db } = fixtures.open();
    const sat = Date.parse("2026-11-14T12:00:00Z") / 1000;
    const mon = Date.parse("2026-11-16T12:00:00Z") / 1000;
    for (const [id, stablecoin_id, peg_type] of [
      [24994, "paxg-paxos", "peggedGOLD"], [89640, "eurs-stasis", "peggedEUR"],
      [89170, "brz-transfero", "peggedBRL"], [91048, "audd-novatti", "peggedAUD"],
    ] as const) {
      seedPsiEvent(sqlite, makeDepegRow({
        id, stablecoin_id, peg_type, started_at: sat, ended_at: mon, start_price: 0.98,
        peg_reference: 1, peak_deviation_bps: -5000,
      }));
    }
    sqlite.exec(`UPDATE depeg_events SET disposition = 'restored-evidenced' WHERE id IN (24994, 89640);
      INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, public_json, created_at, updated_at)
        VALUES (91048, 'live', 'confirmed', '{"auditVerdict":"disputed"}', 1, 1)`);
    const rows = await loadPsiEligibleDepegEvents(db);
    expect(rows.map(({ id }) => id).sort((a, b) => a - b)).toEqual([24994, 89170, 89640]);
    expect(rows.find(({ id }) => id === 89170)).toMatchObject({ counted_from: Date.parse("2026-11-15T22:00:00Z") / 1000 });
    expect(rows.filter(({ disposition }) => disposition === "restored-evidenced")
      .every(({ started_at, counted_from }) => started_at === sat && counted_from === undefined)).toBe(true);
  });

  it("propagates archive and event read failures instead of returning empty successful inputs", async () => {
    const { db } = fixtures.open();
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("archive read failed"); });
    await expect(loadHistoricalPsiArchives(db, DAY, DAY)).rejects.toThrow("archive read failed");
    await expect(loadPsiEligibleDepegEvents(db)).rejects.toThrow("archive read failed");
  });
});
