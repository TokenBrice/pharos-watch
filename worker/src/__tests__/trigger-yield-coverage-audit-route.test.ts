import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cron/yield-coverage-audit", () => ({ runYieldCoverageAudit: vi.fn() }));

import { handleTriggerYieldCoverageAudit } from "../handlers/scheduled/yield-coverage-audit-manual";
import { runYieldCoverageAudit } from "../cron/yield-coverage-audit";
import { closeOpenLeaseDatabases, makeLeaseDb } from "../lib/__tests__/cron-leases.test-support";

const audit = vi.mocked(runYieldCoverageAudit);
const job = "yield-coverage-audit";
function request(admin = true): Request {
  return new Request("https://ops-api.pharos.watch/api/trigger-yield-coverage-audit", {
    method: "POST",
    headers: admin ? { "X-Pharos-Admin": "1" } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  audit.mockResolvedValue({ status: "ok", itemCount: 44, metadata: JSON.stringify({ missingProtocolCount: 44 }) });
});
afterEach(closeOpenLeaseDatabases);

describe("trigger-yield-coverage-audit", () => {
  it.each([
    { trustedAdmin: false, admin: true, status: 401 },
    { trustedAdmin: true, admin: false, status: 403 },
  ])("rejects unauthorized requests before touching the audit ($status)", async ({ trustedAdmin, admin, status }) => {
    const db = makeLeaseDb();
    const response = await handleTriggerYieldCoverageAudit({ db, request: request(admin), trustedAdmin });
    expect(response.status).toBe(status);
    expect(audit).not.toHaveBeenCalled();
    expect(db.getRuns()).toEqual([]);
  });

  it("completes synchronously and persists a normal cron run while releasing its lease", async () => {
    const db = makeLeaseDb();
    const response = await handleTriggerYieldCoverageAudit({ db, request: request(), trustedAdmin: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(db.getRuns()).toEqual([expect.objectContaining({ job, status: "ok" })]);
    const rows = db.sqlite
      .prepare("SELECT schedule_key, producer_kind, invocation_id, calendar_period, metadata FROM cron_runs WHERE job = ?")
      .all(job) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ schedule_key: "monthlyYieldAudit", producer_kind: "admin-trigger" });
    expect(String(rows[0].calendar_period)).toMatch(/^\d{4}-\d{2}$/);
    expect(String(rows[0].invocation_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(JSON.parse(String(rows[0].metadata))).toMatchObject({ missingProtocolCount: 44, trigger: "manual" });
    expect(db.getLease(job)).toBeUndefined();
  });

  it("cannot run over the monthly job's active lease", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({ leases: [{ job, lease_owner: "monthly-owner", lease_until: now + 300, heartbeat_at: now, updated_at: now }] });
    const response = await handleTriggerYieldCoverageAudit({ db, request: request(), trustedAdmin: true });
    expect(response.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
    expect(db.getLease(job)?.lease_owner).toBe("monthly-owner");
    expect(db.getRuns()).toEqual([expect.objectContaining({ job, status: "skipped_locked" })]);
  });

  it("reports deferred audit inputs without claiming successful recomputation", async () => {
    audit.mockResolvedValue({ status: "degraded", metadata: JSON.stringify({ reason: "yield-rankings-cache-missing" }) });
    const db = makeLeaseDb();
    const response = await handleTriggerYieldCoverageAudit({ db, request: request(), trustedAdmin: true });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, status: "degraded" });
    expect(db.getRuns()).toEqual([expect.objectContaining({ job, status: "degraded" })]);
    expect(db.getLease(job)).toBeUndefined();
  });

  it("logs an audit exception and releases ownership for a later retry", async () => {
    audit.mockRejectedValue(new Error("source unavailable"));
    const db = makeLeaseDb();
    const response = await handleTriggerYieldCoverageAudit({ db, request: request(), trustedAdmin: true });
    expect(response.status).toBe(500);
    expect(db.getRuns()).toEqual([expect.objectContaining({ job, status: "error", error: "source unavailable" })]);
    expect(db.getLease(job)).toBeUndefined();
  });
});
