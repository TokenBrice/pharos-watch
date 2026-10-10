import { afterEach, describe, expect, it, vi } from "vitest";
import incidentReviews from "@shared/data/safety-score-v9/incident-reviews-v1.json";

const registryPath = "@shared/data/safety-score-v9/incident-reviews-v1.json";
afterEach(() => { vi.doUnmock(registryPath); vi.resetModules(); });

describe("reviewed incident resolution admission", () => {
  it("quarantines a future resolution only for its owning asset", async () => {
    const registry = structuredClone(incidentReviews);
    const incident = registry.incidents.find((row) => row.assetId === "usdp-parallel")!;
    Object.assign(incident, {
      status: "resolved", resolvedAt: "2027-01-01",
      remediation: { ...incident.remediation, state: "verified" },
    });
    vi.resetModules();
    vi.doMock(registryPath, () => ({ default: registry }));
    const { getSafetyScoreV9ReviewedIncidents } = await import("../safety-score-v9/extension-incidents");
    // Load after JSON replacement to exercise the module-load registry boundary.
    const clockSec = Date.parse("2026-10-01T00:00:00Z") / 1000;
    expect(() => getSafetyScoreV9ReviewedIncidents("usdp-parallel", clockSec)).toThrow(
      expect.objectContaining({ name: "ReviewedRegistryEntryError", path: expect.stringMatching(/incidentReviews\.incidents\.\d+\.resolvedAt/) }),
    );
    expect(getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", clockSec)).toHaveLength(1);
  });
});
