import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
const sendAlertMock = vi.fn(async () => true);
const writeStatusProbeRunMock = vi.fn(async () => {});
const updateDiscrepancyObservationMock = vi.fn(async () => ({
  consecutiveDivergent: 2,
  lastAlertAt: null,
  consecutiveProbeFailures: 0,
  lastProbeAlertAt: null,
}));
const markDiscrepancyAlertSentMock = vi.fn(async () => {});
const markProbeFailureAlertSentMock = vi.fn(async () => {});
const evaluateStatusAndPersistMock = vi.fn(async () => ({
  raw: { rawOverallStatus: "healthy" },
  effectiveStatus: "stale",
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
vi.mock("../../api/status", () => ({
  evaluateStatusAndPersist: evaluateStatusAndPersistMock,
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

const { runStatusSelfCheck } = await import("../status-self-check");

describe("runStatusSelfCheck", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
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
      raw: { rawOverallStatus: "healthy" },
      effectiveStatus: "stale",
    });
    updateDiscrepancyObservationMock.mockResolvedValue({
      consecutiveDivergent: 2,
      lastAlertAt: null,
      consecutiveProbeFailures: 0,
      lastProbeAlertAt: null,
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
    });

    const result = await runStatusSelfCheck({} as D1Database, "secret", "https://staging.api.pharos.watch");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledWith(
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
});
