import { describe, it, expect } from "vitest";
import { buildDiscrepancy } from "../status-discrepancy-view";

describe("buildDiscrepancy — discrepancyReason", () => {
  it("returns in-sync when severities match and probe is fresh", () => {
    const d = buildDiscrepancy(
      "healthy",
      { timestamp: 1000, status: "healthy", sampleCount: 50, passCount: 50, failCount: 0, p95LatencyMs: 100 },
      1010,
      0,
    );
    expect(d.discrepancyReason).toBe("in-sync");
  });

  it("returns probe-missing when probe.timestamp is null", () => {
    const d = buildDiscrepancy(
      "healthy",
      { timestamp: null, status: "unknown", sampleCount: 0, passCount: 0, failCount: 0, p95LatencyMs: null },
      1010,
      0,
    );
    expect(d.discrepancyReason).toBe("probe-missing");
  });

  it("returns probe-stale when probe age exceeds STATUS_SYSTEM_FRESHNESS_SEC (1800s)", () => {
    // probe.timestamp = 1000, now = 1000 + 1801 → age = 1801 > 1800
    const d = buildDiscrepancy(
      "healthy",
      { timestamp: 1000, status: "healthy", sampleCount: 50, passCount: 50, failCount: 0, p95LatencyMs: 100 },
      1000 + 1801,
      0,
    );
    expect(d.discrepancyReason).toBe("probe-stale");
  });

  it("returns probe-disagrees when both sides are fresh but severity differs", () => {
    const d = buildDiscrepancy(
      "healthy",
      { timestamp: 1000, status: "degraded", sampleCount: 50, passCount: 40, failCount: 10, p95LatencyMs: 1000 },
      1010,
      1,
    );
    expect(d.discrepancyReason).toBe("probe-disagrees");
  });
});
