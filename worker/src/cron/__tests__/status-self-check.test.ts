import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

type HealthProbeStatus = "healthy" | "degraded" | "stale";

function buildProbeResponse(
  input: unknown,
  healthStatus: HealthProbeStatus = "healthy",
  init?: RequestInit,
): Response {
  let rawUrl = "https://api.pharos.watch";
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.toString();
  } else if (
    input &&
    typeof input === "object" &&
    "url" in input &&
    typeof (input as { url: unknown }).url === "string"
  ) {
    rawUrl = (input as { url: string }).url;
  }

  const url = rawUrl.startsWith("http") ? new URL(rawUrl) : new URL(rawUrl, "https://api.pharos.watch");
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (url.hostname === "site-api.pharos.watch" && !headers.has("X-Pharos-Site-Proxy-Secret")) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (url.hostname === "ops-api.pharos.watch") {
    return new Response("Forbidden", { status: 403 });
  }
  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({ status: healthStatus }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 200 });
}

const fetchMock = vi.fn();
const routeMock = vi.fn();
const sendAlertMock = vi.fn(async () => true);
const writeStatusProbeRunMock = vi.fn(async () => true);
const writeStatusRawSnapshotMock = vi.fn(async () => true);
const updateDiscrepancyObservationMock = vi.fn(async () => ({
  consecutiveDivergent: 2,
  lastAlertAt: null,
  consecutiveProbeFailures: 0,
  lastProbeAlertAt: null,
  persistenceSucceeded: true,
}));
const markDiscrepancyAlertSentMock = vi.fn(async () => true);
const markProbeFailureAlertSentMock = vi.fn(async () => true);
const evaluateStatusAndPersistMock = vi.fn(async () => ({
  raw: { rawOverallStatus: "healthy", freshnessDiagnostics: [] as Array<Record<string, unknown>> },
  effectiveStatus: "stale",
  persistenceSucceeded: true,
}));
const buildDiscrepancyMock = vi.fn((_status: unknown, _probe: unknown, _now: number, streak: number) => ({
  hasDivergence: true,
  severityDelta: 1,
  statusSeverity: 2,
  probeSeverity: 1,
  details: "forced-divergence",
  probeAgeSeconds: 0,
  consecutiveDivergent: streak,
}));

vi.mock("../../lib/alerts", () => ({ sendAlert: sendAlertMock }));
vi.mock("../../lib/status-evaluation", () => ({
  evaluateStatusAndPersist: evaluateStatusAndPersistMock,
}));
vi.mock("../../lib/status/raw-snapshot", () => ({
  writeStatusRawSnapshot: writeStatusRawSnapshotMock,
}));
vi.mock("../../router", () => ({
  route: routeMock,
}));
vi.mock("../../lib/status-reliability", () => ({
  buildDiscrepancy: buildDiscrepancyMock,
  markDiscrepancyAlertSent: markDiscrepancyAlertSentMock,
  markProbeFailureAlertSent: markProbeFailureAlertSentMock,
  STATUS_DISCREPANCY_ALERT_COOLDOWN_SEC: 1800,
  STATUS_DISCREPANCY_ALERT_STREAK: 2,
  updateDiscrepancyObservation: updateDiscrepancyObservationMock,
  writeStatusProbeRun: writeStatusProbeRunMock,
}));
vi.mock("@shared/lib/api-endpoints", () => ({
  getProbePaths: (group: "public" | "admin" | "manual") => {
    if (group === "public") return ["/api/health"];
    if (group === "admin") return ["/api/status", "/api/status-history?limit=10"];
    return [];
  },
}));

const {
  runStatusSelfCheck,
  isBootstrapCacheMiss,
  classifyProbeStatus,
  selectStatusProbePathsForRun,
  STATUS_DEEP_PROBE_FULL_SWEEP_WINDOW_SEC,
} = await import("../status-self-check");
const { STATUS_PROBE_THRESHOLDS } = await import("@shared/lib/status-thresholds");

describe("runStatusSelfCheck", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => buildProbeResponse(input, "healthy", init));
    routeMock.mockImplementation(async ({ url }: { url: URL }) => buildProbeResponse(url));
    buildDiscrepancyMock.mockImplementation((_status: unknown, _probe: unknown, _now: number, streak: number) => ({
      hasDivergence: true,
      severityDelta: 1,
      statusSeverity: 2,
      probeSeverity: 1,
      details: "forced-divergence",
      probeAgeSeconds: 0,
      consecutiveDivergent: streak,
    }));
    evaluateStatusAndPersistMock.mockResolvedValue({
      raw: { rawOverallStatus: "healthy", freshnessDiagnostics: [] as Array<Record<string, unknown>> },
      effectiveStatus: "stale",
      persistenceSucceeded: true,
    });
    updateDiscrepancyObservationMock.mockResolvedValue({
      consecutiveDivergent: 2,
      lastAlertAt: null,
      consecutiveProbeFailures: 0,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });
  });

  it("does not mark discrepancy alert as sent when webhook delivery fails", async () => {
    sendAlertMock.mockResolvedValueOnce(false);

    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "secret" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(markDiscrepancyAlertSentMock).not.toHaveBeenCalled();
    expect(metadata.alertAttempted).toBe(true);
    expect(metadata.alertSent).toBe(false);
  });

  it("marks discrepancy alert sent only after successful webhook delivery", async () => {
    sendAlertMock.mockResolvedValueOnce(true);

    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "secret" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(markDiscrepancyAlertSentMock).toHaveBeenCalledTimes(1);
    expect(metadata.alertAttempted).toBe(true);
    expect(metadata.alertSent).toBe(true);
  });

  it("suppresses alerts when discrepancy state persistence fails", async () => {
    updateDiscrepancyObservationMock.mockResolvedValueOnce({
      consecutiveDivergent: 2,
      lastAlertAt: null,
      consecutiveProbeFailures: 3,
      lastProbeAlertAt: null,
      persistenceSucceeded: false,
    });

    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "secret" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(markDiscrepancyAlertSentMock).not.toHaveBeenCalled();
    expect(markProbeFailureAlertSentMock).not.toHaveBeenCalled();
    expect(metadata.alertAttempted).toBe(false);
    expect(metadata.probeFailureAlertAttempted).toBe(false);
    expect(metadata.discrepancyPersistenceSucceeded).toBe(false);
  });

  it("records latency summary and slowest probes in cron metadata", async () => {
    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "secret" });
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      p95LatencyMs?: number;
      latencySummary?: { p95Ms?: number; medianMs?: number; maxMs?: number; minMs?: number };
      slowestProbes?: Array<{ path?: string; latencyMs?: number; status?: number }>;
      probeRotation?: { fullSweepWindowSec?: number; selectedDeepProbeCount?: number };
      probePlanes?: {
        internal?: { sampleCount?: number };
        external?: { sampleCount?: number };
      };
      internalExternalDiscrepancy?: { reason?: string };
    };

    expect(metadata.latencySummary?.p95Ms).toBe(metadata.p95LatencyMs);
    expect(metadata.latencySummary?.medianMs).toBeTypeOf("number");
    expect(metadata.latencySummary?.maxMs).toBeTypeOf("number");
    expect(metadata.latencySummary?.minMs).toBeTypeOf("number");
    expect(Array.isArray(metadata.slowestProbes)).toBe(true);
    expect(metadata.slowestProbes).toHaveLength(3);
    expect(metadata.slowestProbes?.every((probe) => typeof probe.path === "string")).toBe(true);
    expect(metadata.slowestProbes?.every((probe) => typeof probe.latencyMs === "number")).toBe(true);
    expect(metadata.probePlanes?.internal?.sampleCount).toBeGreaterThan(0);
    expect(metadata.probePlanes?.external?.sampleCount).toBeGreaterThan(0);
    expect(metadata.internalExternalDiscrepancy?.reason).toBe("in-sync");
    expect(metadata.probeRotation?.fullSweepWindowSec).toBe(900);
    expect(metadata.probeRotation?.selectedDeepProbeCount).toBe(1);
  });

  it("persists a raw status snapshot after status evaluation", async () => {
    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "secret" });
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      rawSnapshotPersistenceSucceeded?: boolean;
    };

    expect(writeStatusRawSnapshotMock).toHaveBeenCalledTimes(1);
    const firstSnapshotWrite = writeStatusRawSnapshotMock.mock.calls[0] as unknown as [
      D1Database,
      number,
      { rawOverallStatus: string },
    ];
    expect(firstSnapshotWrite[2]).toMatchObject({
      rawOverallStatus: "healthy",
    });
    expect(metadata.rawSnapshotPersistenceSucceeded).toBe(true);
  });

  it("keeps health every run and rotates deeper probe buckets", () => {
    const selectedAtStart = selectStatusProbePathsForRun(0, ["/api/health", "/api/a", "/api/b", "/api/c", "/api/d"]);
    const selectedNextBucket = selectStatusProbePathsForRun(900, [
      "/api/health",
      "/api/a",
      "/api/b",
      "/api/c",
      "/api/d",
    ]);
    const selectedThirdBucket = selectStatusProbePathsForRun(1800, [
      "/api/health",
      "/api/a",
      "/api/b",
      "/api/c",
      "/api/d",
    ]);

    expect(selectedAtStart.paths[0]).toBe("/api/health");
    expect(selectedNextBucket.paths[0]).toBe("/api/health");
    expect(selectedThirdBucket.paths[0]).toBe("/api/health");
    expect(selectedAtStart.fullSweepWindowSec).toBe(STATUS_DEEP_PROBE_FULL_SWEEP_WINDOW_SEC);
    expect([...selectedAtStart.paths, ...selectedNextBucket.paths, ...selectedThirdBucket.paths]).toEqual(
      expect.arrayContaining(["/api/a", "/api/b", "/api/c", "/api/d"]),
    );
  });

  it("downgrades the probe aggregate when /api/health reports degraded in a 200 response", async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => buildProbeResponse(input, "degraded", init));
    buildDiscrepancyMock.mockImplementation((_status: unknown, _probe: unknown, _now: number, streak: number) => ({
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 1,
      probeSeverity: 1,
      details: "no-divergence",
      probeAgeSeconds: 0,
      consecutiveDivergent: streak,
    }));
    evaluateStatusAndPersistMock.mockResolvedValueOnce({
      raw: { rawOverallStatus: "degraded", freshnessDiagnostics: [] as Array<Record<string, unknown>> },
      effectiveStatus: "degraded",
      persistenceSucceeded: true,
    });
    updateDiscrepancyObservationMock.mockResolvedValueOnce({
      consecutiveDivergent: 0,
      lastAlertAt: null,
      consecutiveProbeFailures: 1,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });

    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "https://staging.api.pharos.watch" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    const latestProbeWriteCall = writeStatusProbeRunMock.mock.calls[writeStatusProbeRunMock.mock.calls.length - 1] as
      | unknown[]
      | undefined;
    const latestProbeWrite = latestProbeWriteCall?.[2] as {
      status?: string;
      failCount?: number;
      details?: {
        failed?: Array<{ path?: string; status?: number; error?: string | null }>;
      };
    };

    // "reported-degraded" is excluded from connectivity failCount but still flows through semanticProbeStatus
    expect(result.status).toBe("ok"); // probeStatus is "degraded" (not "stale") and consecutiveDivergent < 2
    expect(metadata.probeStatus).toBe("degraded");
    expect(metadata.failCount).toBe(0); // reported-* errors are excluded from connectivity fail counts
    expect(latestProbeWrite.status).toBe("degraded");
    expect(latestProbeWrite.failCount).toBe(0);
  });

  it("includes freshness diagnostics in cron metadata when status evaluation provides them", async () => {
    evaluateStatusAndPersistMock.mockResolvedValueOnce({
      raw: {
        rawOverallStatus: "healthy",
        freshnessDiagnostics: [
          {
            key: "yield-data",
            freshnessSource: "cron-fallback",
            warning: "yield-data: freshness table query failed; using cron fallback",
            failureSource: "table-freshness",
          },
        ],
      },
      effectiveStatus: "healthy",
      persistenceSucceeded: true,
    });
    buildDiscrepancyMock.mockImplementationOnce((_status: unknown, _probe: unknown, _now: number, streak: number) => ({
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 0,
      probeSeverity: 0,
      details: "no-divergence",
      probeAgeSeconds: 0,
      consecutiveDivergent: streak,
    }));
    updateDiscrepancyObservationMock.mockResolvedValueOnce({
      consecutiveDivergent: 0,
      lastAlertAt: null,
      consecutiveProbeFailures: 0,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });

    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "secret" });
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      freshnessDiagnostics?: Array<{ key?: string; freshnessSource?: string; failureSource?: string }>;
    };

    expect(metadata.freshnessDiagnostics).toEqual([
      {
        key: "yield-data",
        freshnessSource: "cron-fallback",
        warning: "yield-data: freshness table query failed; using cron fallback",
        failureSource: "table-freshness",
      },
    ]);
  });

  it("alerts on sustained probe failures even when no status divergence exists", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    buildDiscrepancyMock.mockImplementation((_status: unknown, _probe: unknown, _now: number, streak: number) => ({
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 1,
      probeSeverity: 1,
      details: "no-divergence",
      probeAgeSeconds: 0,
      consecutiveDivergent: streak,
    }));
    updateDiscrepancyObservationMock.mockResolvedValueOnce({
      consecutiveDivergent: 0,
      lastAlertAt: null,
      consecutiveProbeFailures: 3,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });

    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "https://staging.api.pharos.watch" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledWith(
      null,
      "Status probe failures detected",
      expect.stringContaining("streak=3"),
    );
    expect(markDiscrepancyAlertSentMock).not.toHaveBeenCalled();
    expect(markProbeFailureAlertSentMock).toHaveBeenCalledTimes(1);
    expect(metadata.alertAttempted).toBe(false);
    expect(metadata.probeFailureAlertAttempted).toBe(true);
    expect(metadata.probeFailureAlertSent).toBe(true);
    expect(metadata.probeFailureStreak).toBe(3);
    expect(metadata.probeBaseUrl).toBe("https://staging.api.pharos.watch");
  });

  it("uses external health and internal deep probes for the default production origin when execution context is available", async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const result = await runStatusSelfCheck({} as D1Database, {
      selfUrl: "https://api.pharos.watch",
      ctx,
    });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(routeMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("https://api.pharos.watch/api/health", expect.any(Object));
    expect(metadata.probeMode).toBe("internal-router");
    expect(metadata.probeBaseUrl).toBe("https://api.pharos.watch");
  });

  it("probes production public, site-api, and ops-api lanes externally", async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const result = await runStatusSelfCheck({} as D1Database, {
      selfUrl: "https://api.pharos.watch",
      ctx,
      alertWebhookUrl: null,
      siteApiSharedSecret: "site-secret",
    });
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      probePlanes?: { external?: { origins?: string[]; sampleCount?: number } };
    };
    const fetchUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    const siteCall = fetchMock.mock.calls.find((call) => String(call[0]).startsWith("https://site-api.pharos.watch/"));
    const siteInit = siteCall?.[1] as RequestInit | undefined;

    expect(fetchUrls).toEqual(
      expect.arrayContaining([
        "https://api.pharos.watch/api/health",
        "https://site-api.pharos.watch/api/health",
        "https://ops-api.pharos.watch/api/status-history?limit=1",
      ]),
    );
    expect(new Headers(siteInit?.headers).get("X-Pharos-Site-Proxy-Secret")).toBe("site-secret");
    expect(metadata.probePlanes?.external?.sampleCount).toBe(3);
    expect(metadata.probePlanes?.external?.origins).toEqual(
      expect.arrayContaining([
        "https://api.pharos.watch",
        "https://site-api.pharos.watch",
        "https://ops-api.pharos.watch",
      ]),
    );
  });

  it("treats the site-api auth gate as healthy when no shared secret is configured", async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    fetchMock.mockImplementation(async (input: unknown, _init?: RequestInit) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string"
            ? (input as { url: string }).url
            : "https://api.pharos.watch";
      const url = new URL(rawUrl);
      if (url.hostname === "site-api.pharos.watch") {
        return new Response("Unauthorized", { status: 401 });
      }
      return buildProbeResponse(input);
    });

    const result = await runStatusSelfCheck({} as D1Database, {
      selfUrl: "https://api.pharos.watch",
      ctx,
      alertWebhookUrl: null,
      siteApiSharedSecret: null,
    });
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failCount?: number;
      probePlanes?: { external?: { sampleCount?: number; origins?: string[] } };
      slowestProbes?: Array<{ label?: string; status?: number; error?: string | null }>;
    };
    const siteCall = fetchMock.mock.calls.find((call) => String(call[0]).startsWith("https://site-api.pharos.watch/"));
    const siteInit = siteCall?.[1] as RequestInit | undefined;

    expect(new Headers(siteInit?.headers).get("X-Pharos-Site-Proxy-Secret")).toBeNull();
    expect(metadata.failCount).toBe(0);
    expect(metadata.probePlanes?.external?.sampleCount).toBe(3);
    expect(metadata.probePlanes?.external?.origins).toEqual(expect.arrayContaining(["https://site-api.pharos.watch"]));
  });

  it("surfaces internal-vs-external discrepancies in details and alerts", async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    fetchMock.mockImplementation(async (input: unknown) => {
      let rawUrl = "https://api.pharos.watch";
      if (typeof input === "string") {
        rawUrl = input;
      } else if (input instanceof URL) {
        rawUrl = input.toString();
      } else if (
        input &&
        typeof input === "object" &&
        "url" in input &&
        typeof (input as { url: unknown }).url === "string"
      ) {
        rawUrl = (input as { url: string }).url;
      }
      const url = new URL(rawUrl);
      if (
        (url.hostname === "api.pharos.watch" || url.hostname === "site-api.pharos.watch") &&
        url.pathname === "/api/health"
      ) {
        return new Response("{}", { status: 503 });
      }
      return buildProbeResponse(input);
    });
    buildDiscrepancyMock.mockImplementation((_status: unknown, _probe: unknown, _now: number, streak: number) => ({
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 1,
      probeSeverity: 1,
      details: "no-divergence",
      probeAgeSeconds: 0,
      consecutiveDivergent: streak,
    }));
    updateDiscrepancyObservationMock.mockResolvedValueOnce({
      consecutiveDivergent: 0,
      lastAlertAt: null,
      consecutiveProbeFailures: 3,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });

    const result = await runStatusSelfCheck({} as D1Database, {
      selfUrl: "https://api.pharos.watch",
      ctx,
      alertWebhookUrl: null,
      siteApiSharedSecret: "site-secret",
    });
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      internalExternalDiscrepancy?: { reason?: string; hasDivergence?: boolean };
      probeFailureAlertAttempted?: boolean;
    };
    const latestProbeWriteCall = writeStatusProbeRunMock.mock.calls[writeStatusProbeRunMock.mock.calls.length - 1] as
      | unknown[]
      | undefined;
    const latestProbeWrite = latestProbeWriteCall?.[2] as {
      details?: {
        internalExternalDiscrepancy?: { reason?: string; hasDivergence?: boolean };
      };
    };

    expect(metadata.internalExternalDiscrepancy).toMatchObject({
      hasDivergence: true,
      reason: "external-worse",
    });
    expect(latestProbeWrite.details?.internalExternalDiscrepancy).toMatchObject({
      hasDivergence: true,
      reason: "external-worse",
    });
    expect(metadata.probeFailureAlertAttempted).toBe(true);
    expect(sendAlertMock).toHaveBeenCalledWith(
      null,
      "Status probe failures detected",
      expect.stringContaining("comparison=external-worse"),
    );
  });

  it("treats missing cache 503s as bootstrap misses only before the producer cron has ever run", async () => {
    const freshDb = mockD1([{ match: "COUNT(*) AS cnt FROM cron_runs WHERE job =", rows: [], first: { cnt: 0 } }]);
    const establishedDb = mockD1([
      { match: "COUNT(*) AS cnt FROM cron_runs WHERE job =", rows: [], first: { cnt: 2 } },
    ]);

    await expect(isBootstrapCacheMiss(freshDb, "/api/usds-status", 503)).resolves.toBe(true);
    await expect(isBootstrapCacheMiss(establishedDb, "/api/usds-status", 503)).resolves.toBe(false);
    await expect(isBootstrapCacheMiss(freshDb, "/api/peg-summary", 500)).resolves.toBe(false);
  });
});

describe("health probe semantic classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    evaluateStatusAndPersistMock.mockResolvedValue({
      raw: { rawOverallStatus: "healthy", freshnessDiagnostics: [] as Array<Record<string, unknown>> },
      effectiveStatus: "healthy",
      persistenceSucceeded: true,
    });
    updateDiscrepancyObservationMock.mockResolvedValue({
      consecutiveDivergent: 0,
      lastAlertAt: null,
      consecutiveProbeFailures: 0,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });
    buildDiscrepancyMock.mockImplementation((_status: unknown, _probe: unknown, _now: number, streak: number) => ({
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 0,
      probeSeverity: 0,
      details: "no-divergence",
      probeAgeSeconds: 0,
      consecutiveDivergent: streak,
    }));
  });

  function buildHealthResponseWithBody(body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function mockHealthBody(body: unknown): void {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      let rawUrl = "https://api.pharos.watch";
      if (typeof input === "string") {
        rawUrl = input;
      } else if (input instanceof URL) {
        rawUrl = input.toString();
      } else if (
        input &&
        typeof input === "object" &&
        "url" in input &&
        typeof (input as { url: unknown }).url === "string"
      ) {
        rawUrl = (input as { url: string }).url;
      }
      const url = rawUrl.startsWith("http") ? new URL(rawUrl) : new URL(rawUrl, "https://api.pharos.watch");
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (url.hostname === "site-api.pharos.watch" && !headers.has("X-Pharos-Site-Proxy-Secret")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.hostname === "ops-api.pharos.watch") {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname === "/api/health") {
        return buildHealthResponseWithBody(body);
      }
      return new Response("{}", { status: 200 });
    });
  }

  it("classifies invalid-health-payload (unparseable JSON) as stale semantic status", async () => {
    mockHealthBody("not-json");

    await runStatusSelfCheck({} as D1Database, { selfUrl: "https://staging.api.pharos.watch" });

    const latestProbeWriteCall = writeStatusProbeRunMock.mock.calls[writeStatusProbeRunMock.mock.calls.length - 1] as
      | unknown[]
      | undefined;
    const latestProbeWrite = latestProbeWriteCall?.[2] as { status?: string };
    expect(latestProbeWrite.status).toBe("stale");
  });

  it("classifies invalid-health-status (unknown status value) as stale", async () => {
    mockHealthBody({ status: "weird" });

    await runStatusSelfCheck({} as D1Database, { selfUrl: "https://staging.api.pharos.watch" });

    const latestProbeWriteCall = writeStatusProbeRunMock.mock.calls[writeStatusProbeRunMock.mock.calls.length - 1] as
      | unknown[]
      | undefined;
    const latestProbeWrite = latestProbeWriteCall?.[2] as { status?: string };
    expect(latestProbeWrite.status).toBe("stale");
  });

  it("forces overall probeStatus to at least stale when health endpoint semantically broken", async () => {
    mockHealthBody("not-json");

    const result = await runStatusSelfCheck({} as D1Database, { selfUrl: "https://staging.api.pharos.watch" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.probeStatus).not.toBe("healthy");
    expect(metadata.probeStatus).toBe("stale");
  });
});

describe("classifyProbeStatus reflects STATUS_PROBE_THRESHOLDS", () => {
  it("returns stale when sampleCount is 0", () => {
    expect(classifyProbeStatus(0, 0, 0)).toBe("stale");
  });

  it("returns healthy when fails <= healthyMaxFailCount and p95 <= healthyP95MaxMs", () => {
    const { healthyMaxFailCount, healthyP95MaxMs } = STATUS_PROBE_THRESHOLDS;
    expect(classifyProbeStatus(10, healthyMaxFailCount, healthyP95MaxMs)).toBe("healthy");
    expect(classifyProbeStatus(10, 0, healthyP95MaxMs)).toBe("healthy");
  });

  it("downgrades to degraded when p95 crosses healthyP95MaxMs", () => {
    const { healthyP95MaxMs, degradedP95MaxMs } = STATUS_PROBE_THRESHOLDS;
    expect(classifyProbeStatus(10, 0, healthyP95MaxMs + 1)).toBe("degraded");
    expect(classifyProbeStatus(10, 0, degradedP95MaxMs)).toBe("degraded");
  });

  it("returns stale when p95 exceeds degradedP95MaxMs", () => {
    const { degradedP95MaxMs } = STATUS_PROBE_THRESHOLDS;
    expect(classifyProbeStatus(10, 0, degradedP95MaxMs + 1)).toBe("stale");
  });

  it("uses degradedMaxFailRatio to cap degraded classification", () => {
    const { degradedMaxFailRatio, healthyP95MaxMs, degradedP95MaxMs } = STATUS_PROBE_THRESHOLDS;
    const sampleCount = 20;
    const degradedFailCap = Math.floor(sampleCount * degradedMaxFailRatio);
    // At the cap with p95 in degraded band -> degraded
    expect(classifyProbeStatus(sampleCount, degradedFailCap, degradedP95MaxMs)).toBe("degraded");
    // One over the cap -> stale
    expect(classifyProbeStatus(sampleCount, degradedFailCap + 1, healthyP95MaxMs)).toBe("stale");
  });
});
