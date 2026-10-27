import { describe, expect, it } from "vitest";
import type { CacheStatus, HealthResponse } from "@shared/types/status";
import { getCacheQualityImpact } from "@shared/lib/public-health";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";
import { advancePublicHealthSnapshot } from "../public-health-snapshot";

const NOW = 1_700_000_000;
const ASSESSED_AT = NOW - 60;

function quality(degraded: boolean | null, reason: string | null): Pick<CacheStatus, "degraded" | "degradedReason" | "streakDegradedRuns"> {
  return { degraded, degradedReason: reason, streakDegradedRuns: degraded === null ? null : degraded ? 2 : 0 };
}

function storedLane(degraded: boolean, extra: Partial<CacheStatus> = {}): CacheStatus {
  return {
    ageSeconds: 600, maxAge: 7_200, healthyMaxAge: 7_200, publishedAt: ASSESSED_AT - 600,
    generationId: "old-generation", freshnessSource: "freshness-sentinel", upstreamProvider: "defillama",
    healthy: !degraded, ...quality(degraded, degraded ? "old-quality" : null), ...extra,
  };
}

function currentLane(degraded: boolean | null, extra: Partial<CacheStatus> = {}): CacheStatus {
  return {
    ageSeconds: 30, maxAge: 7_200, healthyMaxAge: 7_200, publishedAt: NOW - 30,
    generationId: "new-generation", freshnessSource: "freshness-sentinel",
    healthy: degraded === false, ...quality(degraded, degraded === null ? "producer-publication-unconfirmed" : degraded ? "new-quality" : null),
    ...extra,
  };
}

function snapshot(lane: CacheStatus, warnings: string[] = []): HealthResponse {
  const health = makeHealthyHealthResponse();
  return {
    ...health, timestamp: ASSESSED_AT, assessedAt: ASSESSED_AT,
    status: lane.degraded ? "degraded" : "healthy",
    warnings: [...(lane.degraded ? ["cache-quality-degraded: yield-data:old-quality"] : []), ...warnings],
    caches: { "yield-data": lane },
  };
}

function advance(health: HealthResponse, current: CacheStatus, floor: Partial<Record<"statusExcludingCacheEvidence" | "statusExcludingCacheFreshness", HealthResponse["status"]>> = { statusExcludingCacheEvidence: "healthy", statusExcludingCacheFreshness: "healthy" }) {
  return advancePublicHealthSnapshot(health, NOW, { ...floor, currentCaches: { "yield-data": current } });
}

describe("advancePublicHealthSnapshot generation-bound adoption", () => {
  it("adopts a newer degraded generation's quality over a clean snapshot", () => {
    const result = advance(snapshot(storedLane(false), ["independent-notice"]), currentLane(true));
    expect(result.caches["yield-data"]).toMatchObject({
      generationId: "new-generation", ageSeconds: 30, healthy: false,
      degraded: true, degradedReason: "new-quality", streakDegradedRuns: 2, upstreamProvider: "defillama",
    });
    expect(result.status).toBe("degraded");
    expect(result.warnings).toEqual(["independent-notice", "cache-quality-degraded: yield-data:new-quality"]);
    expect(result.assessedAt).toBe(ASSESSED_AT);
    expect(result.timestamp).toBe(NOW);
  });

  it("clears obsolete degradation and its warning when a clean generation recovers", () => {
    const result = advance(snapshot(storedLane(true), ["independent-notice"]), currentLane(false));
    expect(result.caches["yield-data"]).toMatchObject({
      generationId: "new-generation", healthy: true, degraded: false, degradedReason: null, streakDegradedRuns: 0,
    });
    expect(result.status).toBe("healthy");
    expect(result.warnings).toEqual(["independent-notice"]);
    expect(result.assessedAt).toBe(ASSESSED_AT);
  });

  it("keeps unknown quality unhealthy and named, never clean", () => {
    const result = advance(snapshot(storedLane(false)), currentLane(null));
    expect(result.caches["yield-data"]).toMatchObject({
      healthy: false, degraded: null, degradedReason: "producer-publication-unconfirmed", streakDegradedRuns: null,
    });
    expect(result.warnings).toEqual(["cache-quality-unknown: yield-data:producer-publication-unconfirmed"]);
  });

  it("retains an independent degraded floor through a clean recovery", () => {
    const result = advance(snapshot(storedLane(true)), currentLane(false), { statusExcludingCacheEvidence: "degraded" });
    expect(result.status).toBe("degraded");
    expect(result.caches["yield-data"].degraded).toBe(false);
  });

  it("keeps the conservative legacy floor without the cache-evidence floor", () => {
    // A legacy snapshot's floor still contains the stored quality verdict.
    expect(advance(snapshot(storedLane(true)), currentLane(false), { statusExcludingCacheFreshness: "degraded" }).status)
      .toBe("degraded");
    // New degradation still escalates a legacy floor.
    expect(advance(snapshot(storedLane(false)), currentLane(true), { statusExcludingCacheFreshness: "healthy" }).status)
      .toBe("degraded");
  });

  it("replaces generation-bound diagnostics and removes absent ones", () => {
    const fallbackWarning = "yield-data: freshness sentinel lookup failed; using table fallback";
    const stored = storedLane(true, { warning: fallbackWarning, sentinelValidationReason: "stale-sentinel" });
    const result = advance(snapshot(stored, [fallbackWarning, "dews: unrelated lane notice"]), currentLane(false));
    expect(result.caches["yield-data"]).not.toHaveProperty("warning");
    expect(result.caches["yield-data"]).not.toHaveProperty("sentinelValidationReason");
    expect(result.warnings).toEqual(["dews: unrelated lane notice"]);
  });

  it("derives quality warnings with the assessment's shared authority", () => {
    const result = advance(snapshot(storedLane(true)), currentLane(true));
    expect(result.warnings).toEqual(getCacheQualityImpact(result.caches).warnings);
  });

  it.each([
    ["unchanged generation", currentLane(false, { generationId: "old-generation" })],
    ["older publication", currentLane(false, { publishedAt: ASSESSED_AT - 900 })],
    ["equal publication", currentLane(false, { publishedAt: ASSESSED_AT - 600 })],
    ["future publication", currentLane(false, { ageSeconds: null, timestampReason: "future-timestamp" })],
    ["missing generation", currentLane(false, { generationId: null })],
    ["fallback evidence", currentLane(false, { freshnessSource: "table-fallback" })],
  ] as const)("keeps the stored generation aging on %s", (_label, current) => {
    const stored = snapshot(storedLane(true));
    const result = advance(stored, current);
    expect(result.caches["yield-data"]).toMatchObject({
      generationId: "old-generation", ageSeconds: 660, degraded: true, degradedReason: "old-quality", healthy: false,
    });
    expect(result.status).toBe("degraded");
    expect(result.warnings).toEqual(stored.warnings);
    expect(result.assessedAt).toBe(ASSESSED_AT);
  });
});
