import { describe, expect, it } from "vitest";
import { handleResetCronLease } from "../admin-reset-cron-lease";
import { handleResetCircuitBreaker } from "../admin-reset-circuit-breaker";
import { handleKillCronInFlight } from "../admin-kill-cron-in-flight";
import { handleBulkDismissDiscoveryCandidates } from "../admin-bulk-dismiss-discovery-candidates";
import { handleStatusProbeHistory } from "../status-probe-history";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

// Tests intentionally omit Idempotency-Key so the handler bypasses the
// idempotency layer (which requires admin_idempotency_keys rows in the mock).
// Handler behavior — validation, SQL, response shape — is unaffected by that path.
function adminRequest(url: string, method: "GET" | "POST" = "POST"): Request {
  const headers = new Headers();
  if (method === "POST") headers.set("X-Pharos-Admin", "1");
  return new Request(url, { method, headers });
}

function cacheKeysTouched(db: { getHistory: () => Array<{ sql: string; binds: unknown[] }> }): string[] {
  return db
    .getHistory()
    .filter((entry) =>
      (
        entry.sql.includes("FROM cache WHERE key = ?") ||
        entry.sql.includes("INSERT OR REPLACE INTO cache") ||
        entry.sql.includes("DELETE FROM cache WHERE key = ?")
      ) &&
      typeof entry.binds[0] === "string"
    )
    .map((entry) => String(entry.binds[0]));
}

// ---------------------------------------------------------------------------
// reset-cron-lease
// ---------------------------------------------------------------------------

describe("handleResetCronLease", () => {
  it("deletes the lease for a known job", async () => {
    const db = mockD1([
      { match: "DELETE FROM cron_leases", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/reset-cron-lease?job=sync-mint-burn");
    const res = await handleResetCronLease({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; cleared: number };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(1);
  });

  it("rejects missing job param with 400", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/reset-cron-lease");
    const res = await handleResetCronLease({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects unknown job name (whitelist)", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/reset-cron-lease?job=not-a-real-cron");
    const res = await handleResetCronLease({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// reset-circuit-breaker
// ---------------------------------------------------------------------------

describe("handleResetCircuitBreaker", () => {
  it("deletes the cache row for a known circuit", async () => {
    const db = mockD1([
      { match: "DELETE FROM cache", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/reset-circuit-breaker?circuit=binance-prices");
    const res = await handleResetCircuitBreaker({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; cleared: number };
    expect(body.cleared).toBe(1);
    expect(cacheKeysTouched(db)).toEqual(["circuit:binance-prices"]);
  });

  it("rejects unknown circuit (whitelist)", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/reset-circuit-breaker?circuit=bogus-breaker");
    const res = await handleResetCircuitBreaker({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("deletes scoped live-reserve circuit rows when configured", async () => {
    const db = mockD1([
      { match: "DELETE FROM cache", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/reset-circuit-breaker?circuit=live-reserves:usdgo-osl");
    const res = await handleResetCircuitBreaker({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cleared: number };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// kill-cron-in-flight
// ---------------------------------------------------------------------------

describe("handleKillCronInFlight", () => {
  it("returns 200 when the lease DELETE affects 1 row", async () => {
    const db = mockD1([
      { match: "DELETE FROM cron_leases", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM cron_run_progress", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL(
      "https://ops-api.pharos.watch/api/kill-cron-in-flight?job=sync-mint-burn&leaseOwner=worker-a",
    );
    const res = await handleKillCronInFlight({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 409 when no lease row matched (owner mismatch)", async () => {
    const db = mockD1([
      { match: "DELETE FROM cron_leases", rows: [], runMeta: { changes: 0 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL(
      "https://ops-api.pharos.watch/api/kill-cron-in-flight?job=sync-mint-burn&leaseOwner=worker-stale",
    );
    const res = await handleKillCronInFlight({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(409);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects missing leaseOwner with 400", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/kill-cron-in-flight?job=sync-mint-burn");
    const res = await handleKillCronInFlight({ db, url, request: adminRequest(url.toString()), trustedAdmin: true });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// bulk-dismiss-discovery-candidates
// ---------------------------------------------------------------------------

describe("handleBulkDismissDiscoveryCandidates", () => {
  it("dismisses all non-dismissed candidates when all=true", async () => {
    const db = mockD1([
      { match: "UPDATE discovery_candidates", rows: [], runMeta: { changes: 2 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/bulk-dismiss-discovery-candidates?all=true");
    const res = await handleBulkDismissDiscoveryCandidates({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; dismissed: number };
    expect(body.dismissed).toBe(2);
  });

  it("accepts explicit ids list", async () => {
    const db = mockD1([
      { match: "UPDATE discovery_candidates", rows: [], runMeta: { changes: 2 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/bulk-dismiss-discovery-candidates?ids=1,3");
    const res = await handleBulkDismissDiscoveryCandidates({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects when neither ids nor all=true is provided", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/bulk-dismiss-discovery-candidates");
    const res = await handleBulkDismissDiscoveryCandidates({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects malformed ids", async () => {
    const db = mockD1();
    const url = new URL(
      "https://ops-api.pharos.watch/api/bulk-dismiss-discovery-candidates?ids=1%2Cabc",
    );
    const res = await handleBulkDismissDiscoveryCandidates({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// status-probe-history
// ---------------------------------------------------------------------------

describe("handleStatusProbeHistory", () => {
  const healthPath = "/api/health";

  it("returns runs with per-path failure annotations", async () => {
    const db = mockD1([
      {
        match: "FROM status_probe_runs",
        rows: [
          {
            created_at: 1_700_000_000,
            status: "degraded",
            details_json: JSON.stringify({
              failed: [{ path: "/api/health", status: 503, error: "bootstrap", latencyMs: 1200 }],
            }),
          },
          {
            created_at: 1_699_999_940,
            status: "healthy",
            details_json: JSON.stringify({ failed: [] }),
          },
        ],
      },
    ]);
    const url = new URL(
      "https://ops-api.pharos.watch/api/status-probe-history?path=" +
        encodeURIComponent(healthPath) +
        "&days=1",
    );
    const res = await handleStatusProbeHistory({
      db,
      url,
      request: adminRequest(url.toString(), "GET"),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      summary: { sampleCount: number; failCount: number; windowDays: number };
      runs: Array<{ failed: boolean; httpStatus: number | null }>;
    };
    expect(body.path).toBe(healthPath);
    expect(body.runs.length).toBe(2);
    expect(body.summary.failCount).toBe(1);
    expect(body.runs[0].failed).toBe(true);
    expect(body.runs[0].httpStatus).toBe(503);
    expect(body.runs[1].failed).toBe(false);
  });

  it("rejects unknown path with 400", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/status-probe-history?path=/api/bogus");
    const res = await handleStatusProbeHistory({
      db,
      url,
      request: adminRequest(url.toString(), "GET"),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("clamps days to [1, 30]", async () => {
    const db = mockD1([{ match: "FROM status_probe_runs", rows: [] }]);
    const url = new URL(
      "https://ops-api.pharos.watch/api/status-probe-history?path=" +
        encodeURIComponent(healthPath) +
        "&days=999",
    );
    const res = await handleStatusProbeHistory({
      db,
      url,
      request: adminRequest(url.toString(), "GET"),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { windowDays: number } };
    expect(body.summary.windowDays).toBe(30);
  });
});
