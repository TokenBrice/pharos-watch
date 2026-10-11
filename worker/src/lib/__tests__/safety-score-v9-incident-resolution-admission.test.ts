import { afterEach, describe, expect, it, vi } from "vitest";
import incidentRuntime from "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";

const registryPath = "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";
afterEach(() => { vi.doUnmock(registryPath); vi.resetModules(); });

describe("reviewed incident resolution admission", () => {
  it("quarantines a future resolution only for its owning asset", async () => {
    const registry = structuredClone(incidentRuntime);
    const incident = registry.incidents.find((row) => row.assetId === "usdp-parallel")!;
    Object.assign(incident, {
      status: "resolved", resolvedAt: "2027-01-01",
      remediation: { ...incident.remediation, state: "verified" },
    });
    vi.resetModules();
    vi.doMock(registryPath, () => ({ default: registry }));
    const { getSafetyScoreV9ReviewedIncidents } = await import("../safety-score-v9/extension-incidents");
    // Replace the generated projection actually consumed at module load.
    const clockSec = Date.parse("2026-10-01T00:00:00Z") / 1000;
    expect(() => getSafetyScoreV9ReviewedIncidents("usdp-parallel", clockSec)).toThrow(
      expect.objectContaining({ name: "ReviewedRegistryEntryError", path: expect.stringMatching(/incidentReviews\.incidents\.\d+\.resolvedAt/) }),
    );
    expect(getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", clockSec)).toEqual(
      incidentRuntime.incidents.filter((row) => row.assetId === "zsd-zephyr-protocol"),
    );
  });

  it("does not admit a chronology-valid future resolution before its own review clock", async () => {
    const registry = structuredClone(incidentRuntime);
    const incident = registry.incidents.find((row) => row.assetId === "usdp-parallel")!;
    Object.assign(incident, {
      status: "resolved", resolvedAt: "2027-01-01", reviewedAt: "2027-01-01",
      remediation: { ...incident.remediation, state: "verified", lastVerifiedAt: "2027-01-01" },
    });
    vi.resetModules();
    vi.doMock(registryPath, () => ({ default: registry }));
    // A static import would bypass this test's module-load projection replacement.
    const { getSafetyScoreV9ReviewedIncidents } = await import("../safety-score-v9/extension-incidents");
    const beforeReview = Date.parse("2026-10-01T00:00:00Z") / 1_000;
    expect(getSafetyScoreV9ReviewedIncidents("usdp-parallel", beforeReview)).toEqual([]);
    expect(getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", beforeReview)).toEqual(
      incidentRuntime.incidents.filter((row) => row.assetId === "zsd-zephyr-protocol"),
    );
    expect(getSafetyScoreV9ReviewedIncidents("usdp-parallel", Date.parse("2027-01-01T00:00:00Z") / 1_000))
      .toMatchObject([{ status: "resolved", resolvedAt: "2027-01-01" }]);
  });
});
