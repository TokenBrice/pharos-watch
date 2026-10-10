import { afterEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { DepegAuditVerdict } from "@shared/types/depeg-audit";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeDepegRow as makeFixtureDepegRow } from "../../test-helpers/__shared/fixtures";
import type { DepegRow } from "../depeg-helpers";
import { seedPsiDews, seedPsiEvent, seedPsiSupply } from "../../api/__tests__/psi-replay.test-support";
import {
  loadHistoricalPsiArchives,
  loadPsiEligibleDepegEvents,
  loadSupplyHistoryRowsForWindow,
} from "../psi-replay-inputs";

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

    expect(await loadSupplyHistoryRowsForWindow(db, -DAY_SECONDS, DAY)).toEqual([
      { stablecoin_id: "usdt-tether", snapshot_date: 0, circulating_usd: 0, price: null },
      { stablecoin_id: "usdt-tether", snapshot_date: DAY, circulating_usd: 100e9, price: 0.99 },
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
    provenance.run(1, "native-peg", "confirmed", DAY, DAY);
    provenance.run(2, "usd", "false_positive", DAY, DAY);
    provenance.run(3, "usd", "disputed", DAY, DAY);
    provenance.run(7, "usd", "no_data", DAY, DAY);

    const eligible = await loadPsiEligibleDepegEvents(db, { startDay: DAY, endDay: DAY, excludedIds: [4] });
    expect(eligible.map((event) => event.id)).toEqual([1, 7]);
    expect(eligible[0]).toMatchObject({ source: "backfill", peg_type: "peggedEUR", peg_reference: 1.08, start_price: 0.98, quote_mode: "native-peg", audit_verdict: "confirmed" });
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

  it("propagates archive and event read failures instead of returning empty successful inputs", async () => {
    const { db } = fixtures.open();
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("archive read failed"); });
    await expect(loadHistoricalPsiArchives(db, DAY, DAY)).rejects.toThrow("archive read failed");
    await expect(loadPsiEligibleDepegEvents(db)).rejects.toThrow("archive read failed");
  });
});
