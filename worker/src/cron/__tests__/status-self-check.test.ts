import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

type HealthProbeStatus = "healthy" | "degraded" | "stale";

function buildProbeResponse(input: unknown, healthStatus: HealthProbeStatus = "healthy"): Response {
  let rawUrl = "https://api.pharos.watch";
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.toString();
  } else if (
    input
    && typeof input === "object"
    && "url" in input
    && typeof (input as { url: unknown }).url === "string"
  ) {
    rawUrl = (input as { url: string }).url;
  }

  const url = rawUrl.startsWith("http") ? new URL(rawUrl) : new URL(rawUrl, "https://api.pharos.watch");
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
const buildDiscrepancyMock = vi.fn(
  (_status: unknown, _probe: unknown, _now: number, streak: number) => ({
    hasDivergence: true,
    severityDelta: 1,
    statusSeverity: 2,
    probeSeverity: 1,
    details: "forced-divergence",
    probeAgeSeconds: 0,
    consecutiveDivergent: streak,
  }),
);

vi.mock("../../lib/alerts", () => ({ sendAlert: sendAlertMock }));
vi.mock("../../lib/status-evaluation", () => ({
  evaluateStatusAndPersist: evaluateStatusAndPersistMock,
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

const { runStatusSelfCheck, isBootstrapCacheMiss } = await import("../status-self-check");

describe("runStatusSelfCheck", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (input: unknown) => buildProbeResponse(input));
    routeMock.mockImplementation(async ({ url }: { url: URL }) => buildProbeResponse(url));
    buildDiscrepancyMock.mockImplementation(
      (_status: unknown, _probe: unknown, _now: number, streak: number) => ({
        hasDivergence: true,
        severityDelta: 1,
        statusSeverity: 2,
        probeSeverity: 1,
        details: "forced-divergence",
        probeAgeSeconds: 0,
        consecutiveDivergent: streak,
      }),
    );
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

    const result = await runStatusSelfCheck({} as D1Database, "secret");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(markDiscrepancyAlertSentMock).not.toHaveBeenCalled();
    expect(metadata.alertAttempted).toBe(true);
    expect(metadata.alertSent).toBe(false);
  });

  it("marks discrepancy alert sent only after successful webhook delivery", async () => {
    sendAlertMock.mockResolvedValueOnce(true);

    const result = await runStatusSelfCheck({} as D1Database, "secret");
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

    const result = await runStatusSelfCheck({} as D1Database, "secret");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(markDiscrepancyAlertSentMock).not.toHaveBeenCalled();
    expect(markProbeFailureAlertSentMock).not.toHaveBeenCalled();
    expect(metadata.alertAttempted).toBe(false);
    expect(metadata.probeFailureAlertAttempted).toBe(false);
    expect(metadata.discrepancyPersistenceSucceeded).toBe(false);
  });

  it("records latency summary and slowest probes in cron metadata", async () => {
    const result = await runStatusSelfCheck({} as D1Database, "secret");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      p95LatencyMs?: number;
      latencySummary?: { p95Ms?: number; medianMs?: number; maxMs?: number; minMs?: number };
      slowestProbes?: Array<{ path?: string; latencyMs?: number; status?: number }>;
    };

    expect(metadata.latencySummary?.p95Ms).toBe(metadata.p95LatencyMs);
    expect(metadata.latencySummary?.medianMs).toBeTypeOf("number");
    expect(metadata.latencySummary?.maxMs).toBeTypeOf("number");
    expect(metadata.latencySummary?.minMs).toBeTypeOf("number");
    expect(Array.isArray(metadata.slowestProbes)).toBe(true);
    expect(metadata.slowestProbes).toHaveLength(2);
    expect(metadata.slowestProbes?.every((probe) => typeof probe.path === "string")).toBe(true);
    expect(metadata.slowestProbes?.every((probe) => typeof probe.latencyMs === "number")).toBe(true);
  });

  it("downgrades the probe aggregate when /api/health reports degraded in a 200 response", async () => {
    fetchMock.mockImplementation(async (input: unknown) => buildProbeResponse(input, "degraded"));
    buildDiscrepancyMock.mockImplementation(
      (_status: unknown, _probe: unknown, _now: number, streak: number) => ({
        hasDivergence: false,
        severityDelta: 0,
        statusSeverity: 1,
        probeSeverity: 1,
        details: "no-divergence",
        probeAgeSeconds: 0,
        consecutiveDivergent: streak,
      }),
    );
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

    const result = await runStatusSelfCheck({} as D1Database, "https://staging.api.pharos.watch");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    const latestProbeWriteCall = writeStatusProbeRunMock.mock.calls[
      writeStatusProbeRunMock.mock.calls.length - 1
    ] as unknown[] | undefined;
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
    buildDiscrepancyMock.mockImplementationOnce(
      (_status: unknown, _probe: unknown, _now: number, streak: number) => ({
        hasDivergence: false,
        severityDelta: 0,
        statusSeverity: 0,
        probeSeverity: 0,
        details: "no-divergence",
        probeAgeSeconds: 0,
        consecutiveDivergent: streak,
      }),
    );
    updateDiscrepancyObservationMock.mockResolvedValueOnce({
      consecutiveDivergent: 0,
      lastAlertAt: null,
      consecutiveProbeFailures: 0,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });

    const result = await runStatusSelfCheck({} as D1Database, "secret");
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
    buildDiscrepancyMock.mockImplementation(
      (_status: unknown, _probe: unknown, _now: number, streak: number) => ({
        hasDivergence: false,
        severityDelta: 0,
        statusSeverity: 1,
        probeSeverity: 1,
        details: "no-divergence",
        probeAgeSeconds: 0,
        consecutiveDivergent: streak,
      }),
    );
    updateDiscrepancyObservationMock.mockResolvedValueOnce({
      consecutiveDivergent: 0,
      lastAlertAt: null,
      consecutiveProbeFailures: 3,
      lastProbeAlertAt: null,
      persistenceSucceeded: true,
    });

    const result = await runStatusSelfCheck({} as D1Database, "https://staging.api.pharos.watch");
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

  it("uses internal router probes for the default production origin when execution context is available", async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const result = await runStatusSelfCheck(
      {} as D1Database,
      "https://api.pharos.watch",
      undefined,
      ctx,
    );
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(routeMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadata.probeMode).toBe("internal-router");
    expect(metadata.probeBaseUrl).toBe("https://api.pharos.watch");
  });

  it("treats missing cache 503s as bootstrap misses only before the producer cron has ever run", async () => {
    const freshDb = mockD1([
      { match: "COUNT(*) AS cnt FROM cron_runs WHERE job =", rows: [], first: { cnt: 0 } },
    ]);
    const establishedDb = mockD1([
      { match: "COUNT(*) AS cnt FROM cron_runs WHERE job =", rows: [], first: { cnt: 2 } },
    ]);

    await expect(isBootstrapCacheMiss(freshDb, "/api/usds-status", 503)).resolves.toBe(true);
    await expect(isBootstrapCacheMiss(establishedDb, "/api/usds-status", 503)).resolves.toBe(false);
    await expect(isBootstrapCacheMiss(freshDb, "/api/peg-summary", 500)).resolves.toBe(false);
  });
});
