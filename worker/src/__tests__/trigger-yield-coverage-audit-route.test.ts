import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditCapture = vi.hoisted(() => ({
  inFlight: undefined as Promise<unknown> | undefined,
  run: undefined as
    | ((...args: Parameters<typeof import("../cron/yield-coverage-audit").runYieldCoverageAudit>) =>
        ReturnType<typeof import("../cron/yield-coverage-audit").runYieldCoverageAudit>)
    | undefined,
}));

vi.mock("../cron/yield-coverage-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/yield-coverage-audit")>();
  const run = (...args: Parameters<typeof actual.runYieldCoverageAudit>) => {
    const inFlight = actual.runYieldCoverageAudit(...args);
    auditCapture.inFlight = inFlight;
    return inFlight;
  };
  auditCapture.run = run;
  return { ...actual, runYieldCoverageAudit: vi.fn(run) };
});

vi.mock("../cron/yield-sync/sources-dl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/yield-sync/sources-dl")>();
  return { ...actual, loadDlStablecoinPools: vi.fn() };
});

vi.mock("../lib/safety-scores", () => ({ computeSafetyScoresSnapshot: vi.fn() }));

import { handleTriggerYieldCoverageAudit } from "../handlers/scheduled/yield-coverage-audit-manual";
import { runYieldCoverageAudit } from "../cron/yield-coverage-audit";
import { loadDlStablecoinPools } from "../cron/yield-sync/sources-dl";
import { computeSafetyScoresSnapshot, type PublishedSafetyScoresResultMap } from "../lib/safety-scores";
import { closeOpenLeaseDatabases, makeLeaseDb } from "../lib/__tests__/cron-leases.test-support";
import { makeWorkerReportCardsV9Response } from "../test-helpers/report-cards-v9";
import type { DlPool } from "../cron/yield-sync/types";

const audit = vi.mocked(runYieldCoverageAudit);
const mockLoadDlStablecoinPools = vi.mocked(loadDlStablecoinPools);
const mockComputeSafetyScoresSnapshot = vi.mocked(computeSafetyScoresSnapshot);
const job = "yield-coverage-audit";
const seededAtSec = Math.floor(Date.now() / 1000) - 60;

function request(admin = true, signal?: AbortSignal): Request {
  return new Request("https://ops-api.pharos.watch/api/trigger-yield-coverage-audit", {
    method: "POST",
    headers: admin ? { "X-Pharos-Admin": "1" } : {},
    signal,
  });
}

function auditPool(): DlPool {
  return {
    pool: "new-usdc",
    chain: "Ethereum",
    project: "new-lender",
    symbol: "USDC",
    tvlUsd: 12_000_000,
    apy: 4,
    apyBase: 4,
    apyReward: null,
    apyMean30d: 4,
    stablecoin: true,
    exposure: "single",
    underlyingTokens: null,
  };
}

function successfulSafetySnapshot(): PublishedSafetyScoresResultMap {
  const { safetyScoreIdentity } = makeWorkerReportCardsV9Response();
  return {
    kind: "ok",
    mode: "map",
    coveredCount: 1,
    trackedCount: 1,
    coverageRatio: 1,
    scores: new Map([["dllr-sovryn", { score: 49, grade: "D" }]]),
    source: "safety-score-v9-publication",
    safetyScoreIdentity,
    publicationGenerationId: safetyScoreIdentity.publicationGenerationId,
    methodologyVersion: safetyScoreIdentity.methodologyVersion,
    publishedAt: seededAtSec,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  audit.mockImplementation(auditCapture.run!);
  auditCapture.inFlight = undefined;
  mockLoadDlStablecoinPools.mockResolvedValue({
    pools: [auditPool()],
    meta: { mode: "dex-cache", updatedAt: seededAtSec, ageSeconds: 60, poolCount: 1, fallbackMode: null },
  });
});
afterEach(() => {
  mockLoadDlStablecoinPools.mockReset();
  mockComputeSafetyScoresSnapshot.mockReset();
  closeOpenLeaseDatabases();
});

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
    audit.mockResolvedValue({ status: "ok", itemCount: 44, metadata: JSON.stringify({ missingProtocolCount: 44 }) });
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

  it("does not publish a report when the run's signal aborts mid-recompute", async () => {
    const controller = new AbortController();
    const db = makeLeaseDb({
      cache: [
        {
          key: "defillama-protocols",
          value: JSON.stringify({ protocols: [{ slug: "new-lender", category: "Lending" }] }),
          updated_at: seededAtSec,
        },
        { key: "yield-rankings", value: JSON.stringify({ rankings: [] }), updated_at: seededAtSec },
        { key: "stablecoins", value: "[]", updated_at: seededAtSec },
      ],
    });
    mockComputeSafetyScoresSnapshot.mockImplementation(async () => {
      // The client goes away (or the job's own budget expires) while the
      // audit's largest read/compute stage is in flight. Cancellation is
      // cooperative, so the body must check the signal before publishing.
      controller.abort(new Error("client disconnected"));
      // Outlive both settle graces (1 s inside the lease, 1.25 s in
      // logCronRun) so this run is abandoned, not merely aborted-and-drained.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return successfulSafetySnapshot();
    });

    const response = await handleTriggerYieldCoverageAudit({
      db,
      request: request(true, controller.signal),
      trustedAdmin: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(db.getRuns()).toEqual([
      expect.objectContaining({ job, status: "error", error: expect.stringContaining("abandoned") }),
    ]);
    const auditRun = auditCapture.inFlight;
    expect(auditRun).toBeDefined();
    await auditRun?.catch(() => undefined);

    // A run whose terminal verdict is error/abandoned must not leave a fresh
    // published report behind: that cache row is the operator-visible verdict.
    expect(db.getCache("yield-coverage-audit")?.key).toBeUndefined();
  });
});
