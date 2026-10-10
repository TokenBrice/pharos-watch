import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DAY_SECONDS } from "@shared/lib/time-constants";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { makeApiRequest, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillStabilityIndex } from "../backfill-stability-index";
import { loadPsiEligibleDepegEvents } from "../../lib/psi-replay-inputs";
import { makeAuditEvent } from "./depeg-replay.test-support";
import { seedPsiDews, seedPsiSupply, seedPsiEvent, readPsiDay } from "./psi-replay.test-support";
import { buildRecomputeStabilityStatements } from "../audit-depeg-history/stability-recompute";

const DAY = Math.floor(new Date("2026-03-05T00:00:00Z").getTime() / 1000);
const fixtures = createLatestSchemaFixtureTracker();
stubCryptoForAuth();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

async function backfill(db: D1Database, startDay: number, endDay: number) {
  const request = makeApiRequest(`/api/backfill-stability-index?startDay=${startDay}&endDay=${endDay}`, { method: "POST", adminKey: "secret" });
  const response = await handleBackfillStabilityIndex({ db, request, url: new URL(request.url) });
  expect(response.status).toBe(200);
  return response.json();
}

function seedSupply(sqlite: DatabaseSync, day: number, mcap: number): void {
  for (const [snapshotDate, circulating] of [[day, mcap], [day - 7 * DAY_SECONDS, mcap * 1.1]] as const) {
    sqlite
      .prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)")
      .run("dai-makerdao", snapshotDate, circulating, 1);
  }
  seedPsiDews(sqlite, [{ stablecoin_id: "dai-makerdao", snapshot_date: day, band: "CALM" }]);
}

describe("buildRecomputeStabilityStatements", () => {
  it("produces statements SQLite accepts against the live stability_index schema", async () => {
    const { sqlite, db } = fixtures.open();
    seedSupply(sqlite, DAY, 100_000_000_000);

    const { statements, daysRecomputed } = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);

    expect(daysRecomputed).toBe(1);
    await expect(db.batch(statements)).resolves.toBeDefined();
  });

  it("leaves exactly one stability_index row per day when the recompute batch replays", async () => {
    const { sqlite, db } = fixtures.open();
    seedSupply(sqlite, DAY, 100_000_000_000);

    const first = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);
    await db.batch(first.statements);
    const second = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);
    await db.batch(second.statements);

    const rows = sqlite
      .prepare("SELECT computed_at FROM stability_index WHERE computed_at = ?")
      .all(DAY) as { computed_at: number }[];

    expect(rows).toHaveLength(1);
  });

  it.each(["dews-archive-unavailable", "trend-inputs-unavailable"])("retains an accepted audit-repair day when %s", async (reason) => {
    const { sqlite, db } = fixtures.open();
    seedSupply(sqlite, DAY, 100e9);
    const initial = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);
    await db.batch(initial.statements);
    const accepted = readPsiDay(sqlite, DAY);
    if (reason === "dews-archive-unavailable") sqlite.exec("DELETE FROM stress_signal_history");
    else sqlite.prepare("DELETE FROM supply_history WHERE snapshot_date < ?").run(DAY);
    const held = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);
    expect(held.daysRecomputed).toBe(0);
    expect(held.unavailableDays).toEqual([{ day: DAY, reason, trendUnavailableIds: expect.any(Array) }]);
    expect(held.statements).toEqual([]);
    expect(readPsiDay(sqlite, DAY)).toEqual(accepted);
  });

  it("matches bounded backfill with daily-price, ALERT archive and native-domain evidence", async () => {
    const { sqlite, db } = fixtures.open();
    seedPsiSupply(sqlite, [
      ...[DAY - 7 * DAY_SECONDS, DAY].flatMap((snapshot_date) => [
        { stablecoin_id: "usdt-tether", snapshot_date, circulating_usd: 100e9, price: 1 },
        { stablecoin_id: "usdc-circle", snapshot_date, circulating_usd: 1e9, price: 0.995 },
        { stablecoin_id: "eurc-circle", snapshot_date, circulating_usd: 1e9, price: 1.08 },
      ]),
    ]);
    seedPsiDews(sqlite, [{ stablecoin_id: "usdt-tether", snapshot_date: DAY, band: "ALERT" }]);
    seedPsiEvent(sqlite, makeAuditEvent({
      id: 1, stablecoin_id: "usdc-circle", symbol: "USDC", peak_deviation_bps: -1000,
      started_at: DAY - 2 * DAY_SECONDS, ended_at: DAY + DAY_SECONDS - 1800,
      start_price: 0.9, peak_price: 0.9, source: "backfill",
    }));
    seedPsiEvent(sqlite, makeAuditEvent({
      id: 2, stablecoin_id: "eurc-circle", symbol: "EURC", peg_type: "peggedEUR",
      peg_reference: 1, peak_deviation_bps: -200, source: "backfill",
      started_at: DAY + DAY_SECONDS - 3600, ended_at: DAY + DAY_SECONDS - 1800,
      start_price: 0.98, recovery_price: 0.985,
    }));
    sqlite.prepare(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, quote_mode, audit_verdict, created_at, updated_at)
      VALUES (2, 'backfill', 'native-peg', 'confirmed', ?, ?)`).run(DAY, DAY);
    const events = await loadPsiEligibleDepegEvents(db);
    const recompute = await buildRecomputeStabilityStatements(db, new Set([DAY]), events);
    expect(recompute.daysRecomputed).toBe(1);
    await db.batch(recompute.statements);
    const auditDay = readPsiDay(sqlite, DAY);
    const snapshot = JSON.parse(auditDay.input_snapshot);
    expect(snapshot).toMatchObject({
      depegCount: 2, historicalPriceCoverageCount: 2, peakDeviationFallbackCount: 0,
      dewsStressBreadth: 15, dewsArchiveRowCount: 1, dewsArchiveSnapshotDate: DAY,
      stressBreadthIncluded: true,
    });
    expect(JSON.parse(auditDay.components).stressBreadth).toBe(5);
    await backfill(db, DAY, DAY);
    expect(readPsiDay(sqlite, DAY)).toEqual(auditDay);
  });

  it("keeps sparse 8, 14 and 21-day supply evidence independent of the replay window", async () => {
    const fixture = () => {
      const { sqlite, db } = fixtures.open();
      seedPsiSupply(sqlite, [
        { stablecoin_id: "usdt-tether", snapshot_date: DAY - 8 * DAY_SECONDS, circulating_usd: 100e9, price: 1 },
        { stablecoin_id: "usdc-circle", snapshot_date: DAY - 14 * DAY_SECONDS, circulating_usd: 1e9, price: 0.995 },
        { stablecoin_id: "dai-makerdao", snapshot_date: DAY - 21 * DAY_SECONDS, circulating_usd: 3e9, price: 1 },
        { stablecoin_id: "dai-makerdao", snapshot_date: DAY, circulating_usd: 3e9, price: 1 },
      ]);
      seedPsiDews(sqlite, [DAY - DAY_SECONDS, DAY].map((snapshot_date) => ({
        stablecoin_id: "usdt-tether", snapshot_date, band: "CALM",
      })));
      seedPsiEvent(sqlite, makeAuditEvent({
        id: 1, stablecoin_id: "usdc-circle", started_at: DAY - DAY_SECONDS, ended_at: null,
        peak_deviation_bps: -1000, source: "backfill",
      }));
      return { sqlite, db };
    };
    const narrow = fixture();
    const wide = fixture();
    await backfill(narrow.db, DAY, DAY);
    await backfill(wide.db, DAY - DAY_SECONDS, DAY);
    expect(readPsiDay(narrow.sqlite, DAY)).toEqual(readPsiDay(wide.sqlite, DAY));
    expect(JSON.parse(readPsiDay(narrow.sqlite, DAY).input_snapshot)).toMatchObject({
      totalMcapUsd: 104e9, mcap7dChangePct: 0,
    });
  });
});
