import { describe, it, expect, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

vi.stubGlobal("crypto", {
  subtle: {
    digest: async (_algo: string, data: ArrayBuffer) => data,
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => {
      const av = new Uint8Array(a);
      const bv = new Uint8Array(b);
      if (av.length !== bv.length) return false;
      return av.every((byte, i) => byte === bv[i]);
    },
  },
});

const { handleStatusHistory } = await import("../status-history");

describe("handleStatusHistory", () => {
  it("returns 401 when request is unauthorized", async () => {
    const db = mockD1([]);
    const res = await handleStatusHistory(db, "secret-key", undefined);
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

    const request = new Request("https://x/api/status-history?limit=5", {
      headers: { "X-Admin-Key": "secret-key" },
    });
    const res = await handleStatusHistory(db, "secret-key", request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { currentStatus: string } | null;
      probe: { status: string; sampleCount: number };
      discrepancy: { hasDivergence: boolean };
      transitions: Array<{ id: number; transitionType: string }>;
    };

    expect(body.state?.currentStatus).toBe("healthy");
    expect(body.probe.status).toBe("healthy");
    expect(body.probe.sampleCount).toBe(10);
    expect(body.discrepancy.hasDivergence).toBe(false);
    expect(body.transitions[0]?.transitionType).toBe("recover");
  });
});
