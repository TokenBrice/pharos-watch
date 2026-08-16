import { describe, it, expect, vi } from "vitest";
import { mockD1 as baseMockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeApiRequest, stubCryptoForAuth } from "../../test-helpers/__shared/auth";

stubCryptoForAuth();

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "FROM reserve_sync_state", rows: [] },
    { match: "FROM reserve_composition", rows: [] },
    { match: "JOIN reserve_sync_state", rows: [] },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  ], options);
}

const { handleStatusHistoryRoute } = await import("../status-history");

describe("handleStatusHistoryRoute", () => {
  it("returns 401 when request is unauthorized", async () => {
    const db = mockD1([]);
    const request = makeApiRequest("/api/status-history");
    const res = await handleStatusHistoryRoute({ db, trustedAdmin: false, request });
    expect(res.status).toBe(401);
  });

  it("returns machine-readable history payload when authorized", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM status_state",
        rows: [],
        first: {
          scope: "global",
          current_status: "healthy",
          raw_status: "healthy",
          last_evaluated_at: now - 10,
          last_changed_at: now - 100,
          consecutive_healthy: 3,
          consecutive_degraded: 0,
          consecutive_stale: 0,
          confidence: 0.99,
          causes_json: "[]",
        },
      },
      {
        match: "FROM status_probe_runs",
        rows: [],
        first: {
          created_at: now - 20,
          status: "healthy",
          sample_count: 10,
          pass_count: 10,
          fail_count: 0,
          p95_latency_ms: 210,
        },
      },
      {
        match: "FROM status_discrepancy_state",
        rows: [],
        first: { consecutive_divergent: 0, last_alert_at: null },
      },
      {
        match: "FROM status_transitions",
        rows: [{
          id: 1,
          scope: "global",
          previous_status: "degraded",
          next_status: "healthy",
          raw_status: "healthy",
          transition_type: "recover",
          reason: "raw-healthy-recovery-threshold",
          confidence: 0.95,
          causes_json: "[]",
          created_at: now - 100,
        }],
      },
    ]);

    const request = makeApiRequest("/api/status-history?limit=5", { adminKey: "secret-key" });
    const res = await handleStatusHistoryRoute({ db, trustedAdmin: true, request });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { currentStatus: string } | null;
      probe: { status: string; sampleCount: number };
      discrepancy: { hasDivergence: boolean };
      transitions: Array<{ id: number; transitionType: string }>;
      hasMore: boolean | null;
      reserveComposition: {
        deferredCoins: number;
        runBudgetTruncated: boolean;
        cursorTailState: string | null;
        historyWriteGaps: unknown[];
      } | null;
    };

    expect(body.state?.currentStatus).toBe("healthy");
    expect(body.probe.status).toBe("healthy");
    expect(body.probe.sampleCount).toBe(10);
    expect(body.discrepancy.hasDivergence).toBe(false);
    expect(body.transitions[0]?.transitionType).toBe("recover");
    expect(body.hasMore).toBe(false);
    expect(body.reserveComposition).toMatchObject({
      deferredCoins: 0,
      runBudgetTruncated: false,
      cursorTailState: null,
      historyWriteGaps: [],
    });
  });

  it("returns one page plus truthful hasMore evidence", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1,
      scope: "global",
      previous_status: "healthy",
      next_status: "healthy",
      raw_status: "healthy",
      transition_type: "hold",
      reason: "fixture",
      confidence: 1,
      causes_json: "[]",
      created_at: now - index,
    }));
    const db = mockD1([
      { match: "FROM status_state", rows: [], first: null },
      { match: "FROM status_probe_runs", rows: [], first: null },
      { match: "FROM status_discrepancy_state", rows: [], first: null },
      { match: "FROM status_transitions", rows },
    ]);

    const request = makeApiRequest("/api/status-history?limit=200", { adminKey: "secret-key" });
    const res = await handleStatusHistoryRoute({ db, trustedAdmin: true, request });
    const body = (await res.json()) as { transitions: unknown[]; hasMore: boolean | null };
    const transitionQuery = db.getHistory().find((entry) => entry.sql.includes("FROM status_transitions"));

    expect(body.transitions).toHaveLength(200);
    expect(body.hasMore).toBe(true);
    expect(transitionQuery?.binds[transitionQuery.binds.length - 1]).toBe(201);
  });

  it("returns indeterminate completeness when the transition query fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = mockD1([
      { match: "FROM status_state", rows: [], first: null },
      { match: "FROM status_probe_runs", rows: [], first: null },
      { match: "FROM status_discrepancy_state", rows: [], first: null },
      { match: "FROM status_transitions", rows: [], throwError: new Error("history unavailable") },
    ]);

    const request = makeApiRequest("/api/status-history?limit=5", { adminKey: "secret-key" });
    const res = await handleStatusHistoryRoute({ db, trustedAdmin: true, request });
    const body = (await res.json()) as { transitions: unknown[]; hasMore: boolean | null };

    expect(res.status).toBe(200);
    expect(body.transitions).toEqual([]);
    expect(body.hasMore).toBeNull();
    errorSpy.mockRestore();
  });

  it("applies from/to transition filters when provided", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "FROM status_state", rows: [], first: null },
      { match: "FROM status_probe_runs", rows: [], first: null },
      { match: "FROM status_discrepancy_state", rows: [], first: null },
      {
        match: "FROM status_transitions",
        rows: [{
          id: 2,
          scope: "global",
          previous_status: "healthy",
          next_status: "degraded",
          raw_status: "degraded",
          transition_type: "degrade",
          reason: "raw-degraded-consecutive-threshold",
          confidence: 0.9,
          causes_json: "[]",
          created_at: now - 60,
        }],
      },
    ]) as D1Database & { prepare: (sql: string) => D1PreparedStatement };

    const seenSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const request = makeApiRequest("/api/status-history?from=2025-01-01T00:00:00Z&to=1735776000", { adminKey: "secret-key" });
    const res = await handleStatusHistoryRoute({ db, trustedAdmin: true, request });
    expect(res.status).toBe(200);

    const transitionsSql = seenSql.find((sql) => sql.includes("FROM status_transitions")) ?? "";
    expect(transitionsSql).toContain("created_at >= ?");
    expect(transitionsSql).toContain("created_at <= ?");
  });
});
