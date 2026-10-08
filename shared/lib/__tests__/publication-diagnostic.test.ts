import { describe, expect, it } from "vitest";
import type { PublicationSurfaceHealth } from "../../types/status";
import { classifyPublicationDiagnostic, STATUS_PUBLICATION_PENDING_MAX_AGE_SEC } from "../status-thresholds";

function surface(): PublicationSurfaceHealth {
  const published = {
    generationId: "accepted", sourceState: "published", state: "published" as const,
    startedAt: 100, validatedAt: 101, publishedAt: 102, failedAt: null,
    candidateRows: 1, publishedRows: 1, expectedRows: 1, failureReason: null,
  };
  return { surface: "yield-rankings", label: "Yield", sourceOfTruth: "ledger", lastPublishedGeneration: published,
    lastAttemptedGeneration: published, lastFailureReason: null, candidateAgeSec: null, dependencyWatermarks: null };
}

describe("publication diagnostic", () => {
  it.each(["failed", "rejected"] as const)("exposes a newer %s attempt without replacing accepted publication", (state) => {
    const value = surface();
    value.lastAttemptedGeneration = { ...value.lastPublishedGeneration!, generationId: "attempt", startedAt: 200, state, failureReason: "held-input" };
    expect(classifyPublicationDiagnostic(value)).toMatchObject({ status: "degraded", reason: "held-input" });
    value.lastAttemptedGeneration.startedAt = 99;
    expect(classifyPublicationDiagnostic(value).status).toBe("healthy");
  });
  it("shares the exact pending budget boundary and keeps absent evidence unknown", () => {
    const value = surface();
    value.candidateAgeSec = STATUS_PUBLICATION_PENDING_MAX_AGE_SEC;
    expect(classifyPublicationDiagnostic(value).status).toBe("healthy");
    value.candidateAgeSec++;
    expect(classifyPublicationDiagnostic(value)).toMatchObject({ status: "degraded", maxAgeSec: STATUS_PUBLICATION_PENDING_MAX_AGE_SEC });
    expect(classifyPublicationDiagnostic(undefined).status).toBe("unknown");
  });
});
