import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleAuditDepegHistory } from "../audit-depeg-history";

stubCryptoForAuth();

function makeSyntheticSplitRows() {
  const first = {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: -700,
    started_at: 1_800_000_000,
    ended_at: 1_800_003_600,
    start_price: 0.93,
    peak_price: 0.93,
    recovery_price: 0.9998,
    peg_reference: 1,
    source: "live",
  };
  const second = {
    ...first,
    id: 2,
    peak_deviation_bps: -820,
    started_at: 1_800_004_500,
    ended_at: 1_800_007_200,
    start_price: 0.918,
    peak_price: 0.918,
    recovery_price: 0.9999,
  };
  return [first, second];
}

function makeBackfillLiveHandoffRows() {
  const first = {
    id: 10,
    stablecoin_id: "susd-synthetix",
    symbol: "SUSD",
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: -4225,
    started_at: 1_762_297_275,
    ended_at: 1_772_825_545,
    start_price: 0.9827170934258186,
    peak_price: 0.5774668885049343,
    recovery_price: null,
    peg_reference: 1,
    source: "backfill",
  };
  const second = {
    ...first,
    id: 11,
    peak_deviation_bps: -2628,
    started_at: 1_772_827_344,
    ended_at: null,
    start_price: 0.8099787891752984,
    peak_price: 0.736943,
    recovery_price: null,
    peg_reference: 0.9992249760570994,
    source: "live",
  };
  return [first, second];
}

describe("handleAuditDepegHistory method safety", () => {
  it("rejects GET mutations when dry-run is not set", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = makeApiRequest("/api/audit-depeg-history", { adminKey: "secret" });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), true, req);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("dry-run=true");
  });

  it("allows GET dry-run previews", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true", { adminKey: "secret" });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), true, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; totalMatching: number };
    expect(body.dryRun).toBe(true);
    expect(body.totalMatching).toBe(0);
  });

  it("surfaces synthetic split repair candidates in dry-run mode", async () => {
    const rows = makeSyntheticSplitRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "FROM depeg_events ORDER BY stablecoin_id, started_at", rows },
    ]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true&repair=synthetic-splits", { adminKey: "secret" });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), true, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repair: string;
      dryRun: boolean;
      totalMatching: number;
      candidateGroups: Array<{ keeperId: number; mergedIds: number[]; eventIds: number[] }>;
    };
    expect(body.repair).toBe("synthetic-splits");
    expect(body.dryRun).toBe(true);
    expect(body.totalMatching).toBe(1);
    expect(body.candidateGroups).toHaveLength(1);
    expect(body.candidateGroups[0]).toMatchObject({
      keeperId: 1,
      mergedIds: [2],
      eventIds: [1, 2],
    });
  });

  it("merges synthetic split groups on POST repair", async () => {
    const rows = makeSyntheticSplitRows();
    const day = 1_799_971_200;
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "FROM depeg_events ORDER BY stablecoin_id, started_at", rows },
      { match: "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at", rows },
      {
        match: "SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date",
        rows: [{ stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 1_000_000_000 }],
      },
      {
        match: "UPDATE depeg_events SET started_at = ?, start_price = ?, peg_reference = ?, peak_deviation_bps = ?, peak_price = ?, ended_at = ?, recovery_price = ? WHERE id = ?",
        rows: [],
      },
      { match: "DELETE FROM depeg_events WHERE id = ?", rows: [] },
      { match: "INSERT INTO stability_index", rows: [] },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history?repair=synthetic-splits", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), true, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      repairedEventCount: number;
      repairedGroups: Array<{ keeperId: number; mergedIds: number[] }>;
      daysRecomputed: number;
    };
    expect(body.dryRun).toBe(false);
    expect(body.repairedEventCount).toBe(1);
    expect(body.repairedGroups).toHaveLength(1);
    expect(body.repairedGroups[0]).toMatchObject({ keeperId: 1, mergedIds: [2] });
    expect(body.daysRecomputed).toBeGreaterThan(0);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("UPDATE depeg_events SET started_at"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM depeg_events WHERE id = ?") && entry.binds[0] === 2)).toBe(true);
  });

  it("surfaces backfill-to-live handoff repair candidates in dry-run mode", async () => {
    const rows = makeBackfillLiveHandoffRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "FROM depeg_events ORDER BY stablecoin_id, started_at", rows },
    ]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true&repair=synthetic-splits&symbol=SUSD", { adminKey: "secret" });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), true, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repair: string;
      totalMatching: number;
      candidateGroups: Array<{ keeperId: number; mergedIds: number[]; eventIds: number[] }>;
    };
    expect(body.repair).toBe("synthetic-splits");
    expect(body.totalMatching).toBe(1);
    expect(body.candidateGroups).toHaveLength(1);
    expect(body.candidateGroups[0]).toMatchObject({
      keeperId: 11,
      mergedIds: [10],
      eventIds: [10, 11],
    });
  });

  it("keeps the live tail when repairing a backfill-to-live handoff", async () => {
    const rows = makeBackfillLiveHandoffRows();
    const day = 1_762_214_400;
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "FROM depeg_events ORDER BY stablecoin_id, started_at", rows },
      { match: "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at", rows },
      {
        match: "SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date",
        rows: [{ stablecoin_id: "susd-synthetix", snapshot_date: day, circulating_usd: 50_000_000 }],
      },
      {
        match: "UPDATE depeg_events SET started_at = ?, start_price = ?, peg_reference = ?, peak_deviation_bps = ?, peak_price = ?, ended_at = ?, recovery_price = ? WHERE id = ?",
        rows: [],
      },
      { match: "DELETE FROM depeg_events WHERE id = ?", rows: [] },
      { match: "INSERT INTO stability_index", rows: [] },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history?repair=synthetic-splits&symbol=SUSD", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), true, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repairedEventCount: number;
      repairedGroups: Array<{ keeperId: number; mergedIds: number[] }>;
    };
    expect(body.repairedEventCount).toBe(1);
    expect(body.repairedGroups[0]).toMatchObject({ keeperId: 11, mergedIds: [10] });

    const updateEntry = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE depeg_events SET started_at = ?, start_price = ?, peg_reference = ?, peak_deviation_bps = ?, peak_price = ?, ended_at = ?, recovery_price = ? WHERE id = ?"),
    );
    expect(updateEntry?.binds).toEqual([
      rows[0].started_at,
      rows[0].start_price,
      rows[0].peg_reference,
      rows[0].peak_deviation_bps,
      rows[0].peak_price,
      rows[1].ended_at,
      rows[1].recovery_price,
      rows[1].id,
    ]);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events WHERE id = ?") && entry.binds[0] === 10)).toBe(true);
  });
});
