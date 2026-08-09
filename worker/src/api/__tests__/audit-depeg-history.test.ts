import { describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";

const fetchWithRetryMock = vi.fn();
const DAY_SECONDS = 86_400;

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  fetchJsonWithRetry: async (...args: unknown[]) => {
    const response = await fetchWithRetryMock(...args) as Response | null;
    return response ? { response, body: await response.json() } : null;
  },
}));

import { auditEvents, handleAuditDepegHistoryTrusted } from "../audit-depeg-history";

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

function makeContradictoryRecoveryRows() {
  return [
    {
      id: 21,
      stablecoin_id: "brz-brazilian-digital-token",
      symbol: "BRZ",
      peg_type: "peggedBRL",
      direction: "below",
      peak_deviation_bps: -190,
      started_at: 1_800_100_000,
      ended_at: 1_800_101_800,
      start_price: 0.17,
      peak_price: 0.166,
      recovery_price: 0.17,
      peg_reference: 0.2,
      source: "live",
    },
    {
      id: 22,
      stablecoin_id: "usdt-tether",
      symbol: "USDT",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -250,
      started_at: 1_800_200_000,
      ended_at: 1_800_201_800,
      start_price: 0.98,
      peak_price: 0.975,
      recovery_price: 0.9998,
      peg_reference: 1,
      source: "live",
    },
  ];
}

describe("handleAuditDepegHistory method safety", () => {
  it("rejects GET mutations when dry-run is not set", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = makeApiRequest("/api/audit-depeg-history", { adminKey: "secret" });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("dry-run=true");
  });

  it("allows GET dry-run previews", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true", { adminKey: "secret" });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; totalMatching: number; limit: number };
    expect(body.dryRun).toBe(true);
    expect(body.totalMatching).toBe(0);
    expect(body.limit).toBe(25);
  });

  it("rejects limit values above the bounded audit cap", async () => {
    const db = mockD1([]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true&limit=26", { adminKey: "secret" });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  it("rejects malformed direct delete IDs instead of partially parsing them", async () => {
    const db = mockD1([]);
    for (const deleteParam of ["1abc", "abc,1", ",1"]) {
      const req = makeApiRequest(`/api/audit-depeg-history?dry-run=true&delete=${encodeURIComponent(deleteParam)}`, {
        adminKey: "secret",
      });

      const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Invalid delete parameter");
    }
  });

  it("accepts valid direct delete ID lists in dry-run mode", async () => {
    const rows = makeSyntheticSplitRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
    ]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true&delete=1,2", { adminKey: "secret" });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; deletedEvents: Array<{ id: number }> };
    expect(body.dryRun).toBe(true);
    expect(body.deletedEvents.map((event) => event.id)).toEqual([1, 2]);
  });

  it("blocks direct deletes against sealed DDRv2 events", async () => {
    const rows = makeSyntheticSplitRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      {
        match: "FROM depeg_resolver_incident_event_links l",
        rows: [{
          event_id: 1,
          incident_key: "ddr2:1234567890abcdef1234567890ab",
          public_prediction_id: 77,
        }],
      },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history?delete=1", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; operation: string; conflicts: Array<{ eventId: number }> };
    expect(body.error).toBe("DDRv2 sealed repair required");
    expect(body.operation).toBe("audit-depeg-history:direct-delete");
    expect(body.conflicts).toEqual([expect.objectContaining({ eventId: 1 })]);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
  });

  it("returns a clear 500 when direct delete recompute commit fails", async () => {
    const rows = makeSyntheticSplitRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      {
        match: "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events_with_provenance WHERE",
        rows: [],
      },
      {
        match: "FROM supply_history",
        rows: [{ stablecoin_id: "usdt-tether", snapshot_date: 1_799_971_200, circulating_usd: 1_000_000_000 }],
      },
      { match: "INSERT INTO stability_index", rows: [], throwError: new Error("insert failed") },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history?delete=1", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no changes were committed");
    const affectedDay = Math.floor(rows[0].started_at / DAY_SECONDS) * DAY_SECONDS;
    const supplyQuery = db.getHistory().find((entry) => entry.sql.includes("FROM supply_history"));
    expect(supplyQuery?.sql).toContain("WHERE snapshot_date BETWEEN ? AND ?");
    expect(supplyQuery?.binds).toEqual([
      affectedDay - 21 * DAY_SECONDS,
      affectedDay + 14 * DAY_SECONDS,
    ]);
  });

  it("surfaces synthetic split repair candidates in dry-run mode", async () => {
    const rows = makeSyntheticSplitRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "FROM depeg_events ORDER BY stablecoin_id, started_at", rows },
    ]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true&repair=synthetic-splits", { adminKey: "secret" });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
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
      { match: "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events_with_provenance WHERE", rows },
      {
        match: "FROM supply_history",
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

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
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

  it("blocks synthetic split repairs that would mutate sealed DDRv2 events", async () => {
    const rows = makeSyntheticSplitRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "FROM depeg_events ORDER BY stablecoin_id, started_at", rows },
      {
        match: "FROM depeg_resolver_incident_event_links l",
        rows: [{
          event_id: 2,
          incident_key: "ddr2:1234567890abcdef1234567890ab",
          public_prediction_id: 78,
        }],
      },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history?repair=synthetic-splits", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { operation: string; conflicts: Array<{ eventId: number }> };
    expect(body.operation).toBe("audit-depeg-history:synthetic-splits");
    expect(body.conflicts).toEqual([expect.objectContaining({ eventId: 2 })]);
    expect(db.getHistory().some((entry) => entry.sql.includes("UPDATE depeg_events SET started_at"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events WHERE id = ?"))).toBe(false);
  });

  it("surfaces backfill-to-live handoff repair candidates in dry-run mode", async () => {
    const rows = makeBackfillLiveHandoffRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "FROM depeg_events ORDER BY stablecoin_id, started_at", rows },
    ]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true&repair=synthetic-splits&symbol=SUSD", { adminKey: "secret" });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
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
      { match: "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events_with_provenance WHERE", rows },
      {
        match: "FROM supply_history",
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

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
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

  it("surfaces contradictory recovery-price candidates in dry-run mode", async () => {
    const rows = makeContradictoryRecoveryRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
    ]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true&repair=contradictory-recovery-price", {
      adminKey: "secret",
    });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repair: string;
      totalMatching: number;
      candidateEvents: Array<{ id: number; symbol: string; recoveryBps: number; thresholdBps: number }>;
    };
    expect(body.repair).toBe("contradictory-recovery-price");
    expect(body.totalMatching).toBe(1);
    expect(body.candidateEvents).toEqual([
      expect.objectContaining({
        id: 21,
        symbol: "BRZ",
        recoveryBps: 1500,
        thresholdBps: 150,
      }),
    ]);
  });

  it("nulls contradictory recovery prices on POST repair", async () => {
    const rows = makeContradictoryRecoveryRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      { match: "UPDATE depeg_events SET recovery_price = NULL WHERE id = ?", rows: [] },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history?repair=contradictory-recovery-price", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repairedEventCount: number;
      repairedEvents: Array<{ id: number; symbol: string }>;
    };
    expect(body.repairedEventCount).toBe(1);
    expect(body.repairedEvents).toEqual([expect.objectContaining({ id: 21, symbol: "BRZ" })]);
    expect(
      db.getHistory().some((entry) => entry.sql.includes("UPDATE depeg_events SET recovery_price = NULL WHERE id = ?") && entry.binds[0] === 21),
    ).toBe(true);
  });

  it("blocks contradictory recovery-price repairs against sealed DDRv2 events", async () => {
    const rows = makeContradictoryRecoveryRows();
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows },
      {
        match: "FROM depeg_resolver_incident_event_links l",
        rows: [{
          event_id: 21,
          incident_key: "ddr2:1234567890abcdef1234567890ab",
          public_prediction_id: 79,
        }],
      },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history?repair=contradictory-recovery-price", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { operation: string; conflicts: Array<{ eventId: number }> };
    expect(body.operation).toBe("audit-depeg-history:contradictory-recovery-price");
    expect(body.conflicts).toEqual([expect.objectContaining({ eventId: 21 })]);
    expect(db.getHistory().some((entry) => entry.sql.includes("UPDATE depeg_events SET recovery_price = NULL"))).toBe(false);
  });

  it("does NOT delete a depeg event when CG prices fail live-pipeline validation", async () => {
    fetchWithRetryMock.mockReset();
    // Single CG price at $50 — far outside USD bounds [0.01, 1.19] so
    // validatePriceCandidate must reject it. Without validation the raw
    // deviation is enormous and the event would be classified "confirmed";
    // with validation the filtered series is empty and we fall to "no_data".
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ prices: [[1_800_000_000_000, 50.0]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const event = {
      id: 42,
      stablecoin_id: "usdt-tether",
      symbol: "USDT",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -1500,
      started_at: 1_800_000_000,
      ended_at: 1_800_003_600,
      start_price: 0.85,
      peak_price: 0.85,
      recovery_price: 0.999,
      peg_reference: 1,
      source: "live",
      confirmation_sources: null,
      pending_reason: null,
    };
    const db = mockD1([]);

    const result = await auditEvents(db, {
      events: [event],
      minSupply: 0,
      symbolFilter: null,
      offset: 0,
      limit: 10,
      dryRun: true,
    });

    expect(result.deletedEvents).toHaveLength(0);
    expect(result.rejectedByValidationCount ?? 0).toBeGreaterThan(0);
  });

  it("bounds min-supply history lookup to the audited event window", async () => {
    fetchWithRetryMock.mockReset();
    const firstStartedAt = 1_800_000_000;
    const secondStartedAt = firstStartedAt + 2 * DAY_SECONDS;
    const events = [
      {
        id: 101,
        stablecoin_id: "unknown-a",
        symbol: "UNKA",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -150,
        started_at: firstStartedAt,
        ended_at: firstStartedAt + 3600,
        start_price: 0.985,
        peak_price: 0.985,
        recovery_price: 0.999,
        peg_reference: 1,
        source: "live",
        confirmation_sources: null,
        pending_reason: null,
      },
      {
        id: 102,
        stablecoin_id: "unknown-b",
        symbol: "UNKB",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -150,
        started_at: secondStartedAt,
        ended_at: secondStartedAt + 3600,
        start_price: 0.985,
        peak_price: 0.985,
        recovery_price: 0.999,
        peg_reference: 1,
        source: "live",
        confirmation_sources: null,
        pending_reason: null,
      },
    ];
    const db = mockD1([
      {
        match: "FROM supply_history",
        rows: [{ stablecoin_id: "unknown-a", snapshot_date: firstStartedAt, circulating_usd: 250_000_000 }],
      },
    ]) as MockD1Database;

    const result = await auditEvents(db, {
      events,
      minSupply: 100_000_000,
      symbolFilter: null,
      offset: 0,
      limit: 10,
      dryRun: true,
    });

    expect(result.totalMatching).toBe(1);
    expect(result.auditedEvents).toEqual([
      expect.objectContaining({ id: 101, verdict: "skipped" }),
    ]);
    const supplyQuery = db.getHistory().find((entry) => entry.sql.includes("FROM supply_history"));
    expect(supplyQuery?.sql).toContain("WHERE snapshot_date BETWEEN ? AND ?");
    expect(supplyQuery?.binds).toEqual([
      firstStartedAt - 30 * DAY_SECONDS,
      secondStartedAt + 30 * DAY_SECONDS,
    ]);
  });

  it("blocks audit provenance invalidation against sealed DDRv2 events", async () => {
    fetchWithRetryMock.mockReset();
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ prices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const event = {
      id: 45,
      stablecoin_id: "usdt-tether",
      symbol: "USDT",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -150,
      started_at: 1_800_000_000,
      ended_at: 1_800_003_600,
      start_price: 0.985,
      peak_price: 0.985,
      recovery_price: 0.999,
      peg_reference: 1,
      source: "live",
      confirmation_sources: null,
      pending_reason: null,
    };
    const db = mockD1([
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at", rows: [event] },
      {
        match: "FROM depeg_resolver_incident_event_links l",
        rows: [{
          event_id: 45,
          incident_key: "ddr2:1234567890abcdef1234567890ab",
          public_prediction_id: 81,
        }],
      },
    ]) as MockD1Database;
    const req = makeApiRequest("/api/audit-depeg-history", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleAuditDepegHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { operation: string; conflicts: Array<{ eventId: number }> };
    expect(body.operation).toBe("audit-depeg-history:provenance-invalidation");
    expect(body.conflicts).toEqual([expect.objectContaining({ eventId: 45 })]);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO depeg_event_provenance"))).toBe(false);
  });

  it("does not confirm a below-peg event with above-peg CoinGecko movement", async () => {
    fetchWithRetryMock.mockReset();
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ prices: [[1_800_000_000_000, 1.02]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const event = {
      id: 43,
      stablecoin_id: "usdt-tether",
      symbol: "USDT",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -150,
      started_at: 1_800_000_000,
      ended_at: 1_800_003_600,
      start_price: 0.985,
      peak_price: 0.985,
      recovery_price: 0.999,
      peg_reference: 1,
      source: "live",
      confirmation_sources: null,
      pending_reason: null,
    };

    const result = await auditEvents(mockD1(), {
      events: [event],
      minSupply: 0,
      symbolFilter: null,
      offset: 0,
      limit: 10,
      dryRun: true,
    });

    expect(result.auditedEvents[0]).toMatchObject({
      verdict: "disputed",
      cgMaxSameDirectionBps: 0,
      cgMaxOppositeDirectionBps: 200,
    });
    expect(result.deletedEvents).toHaveLength(0);
  });

  it("persists no-data audit verdicts without deleting rows", async () => {
    fetchWithRetryMock.mockReset();
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ prices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const event = {
      id: 44,
      stablecoin_id: "usdt-tether",
      symbol: "USDT",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -150,
      started_at: 1_800_000_000,
      ended_at: 1_800_003_600,
      start_price: 0.985,
      peak_price: 0.985,
      recovery_price: 0.999,
      peg_reference: 1,
      source: "live",
      confirmation_sources: null,
      pending_reason: null,
    };
    const db = mockD1([
      { match: "INSERT INTO depeg_event_provenance", rows: [] },
      { match: "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events_with_provenance WHERE", rows: [event] },
    ]) as MockD1Database;

    const result = await auditEvents(db, {
      events: [event],
      minSupply: 0,
      symbolFilter: null,
      offset: 0,
      limit: 10,
      dryRun: false,
    });

    expect(result.auditedEvents[0]?.verdict).toBe("no_data");
    expect(result.deletedEvents).toHaveLength(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO depeg_event_provenance") && entry.binds.includes("no_data"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
  });

  it("flags upstreamReachable=false and skips provenance when CG is down for the batch", async () => {
    fetchWithRetryMock.mockReset();
    fetchWithRetryMock.mockResolvedValue(
      new Response("upstream unavailable", { status: 503 }),
    );
    const makeEvent = (id: number) => ({
      id,
      stablecoin_id: "usdt-tether",
      symbol: "USDT",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -150,
      started_at: 1_800_000_000,
      ended_at: 1_800_003_600,
      start_price: 0.985,
      peak_price: 0.985,
      recovery_price: 0.999,
      peg_reference: 1,
      source: "live",
      confirmation_sources: null,
      pending_reason: null,
    });
    const db = mockD1([]) as MockD1Database;

    const result = await auditEvents(db, {
      events: [makeEvent(50), makeEvent(51)],
      minSupply: 0,
      symbolFilter: null,
      offset: 0,
      limit: 10,
      dryRun: false,
    });

    expect(result.upstreamErrorCount).toBe(2);
    expect(result.upstreamReachable).toBe(false);
    expect(result.auditedEvents.every((e) => e.verdict === "error")).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO depeg_event_provenance"))).toBe(false);
  });
});
