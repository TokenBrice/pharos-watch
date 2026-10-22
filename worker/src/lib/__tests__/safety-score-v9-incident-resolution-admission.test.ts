import { afterEach, describe, expect, it, vi } from "vitest";
import incidentRuntime from "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";

const registryPath = "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";
afterEach(() => { vi.doUnmock(registryPath); vi.resetModules(); });

function fixtureIncident(assetId = "fixture-vault", incidentId = "fixture-loss") {
  return {
    incidentId,
    assetId,
    domain: "peg",
    kind: "holder-exit-impairment",
    occurredAt: "2026-03-22",
    status: "mitigated",
    scope: { kind: "holder-exit" },
    posture: { treatment: "peg-multiplier-only" },
    reviewedAt: "2026-10-21",
    reviewer: "Fixture reviewer",
    primarySources: [{
      label: "Withdrawal terms",
      url: "https://example.com/withdrawals",
      publishedAt: "2026-03-22",
    }],
    finding: "A mandatory holder withdrawal haircut was imposed.",
    remediation: {
      state: "in-progress",
      lastVerifiedAt: "2026-06-11",
      summary: "Partial recovery, without a complete make-whole.",
      sources: [{
        label: "Recovery distribution",
        url: "https://example.com/recovery",
        publishedAt: "2026-06-11",
      }],
    },
  };
}

async function loadIncidents(incidents: unknown[]) {
  vi.resetModules();
  vi.doMock(registryPath, () => ({
    default: { schemaVersion: 1, digest: incidentRuntime.digest, incidents, negativeReviews: [] },
  }));
  return import("../safety-score-v9/extension-incidents");
}

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

  it("quarantines duplicate event identities for both owners without hiding unrelated evidence", async () => {
    const first = fixtureIncident("fixture-first");
    const second = fixtureIncident("fixture-second");
    const unaffected = fixtureIncident("fixture-unaffected", "fixture-distinct");
    const { getSafetyScoreV9ReviewedIncidents } = await loadIncidents([first, second, unaffected]);
    const clockSec = Date.parse("2026-10-22T00:00:00Z") / 1_000;
    for (const assetId of [first.assetId, second.assetId]) {
      expect(() => getSafetyScoreV9ReviewedIncidents(assetId, clockSec)).toThrow(
        expect.objectContaining({ name: "ReviewedRegistryEntryError" }),
      );
    }
    expect(getSafetyScoreV9ReviewedIncidents(unaffected.assetId, clockSec)).toEqual([unaffected]);
  });

  it("projects only source-admitted quantified events after the original review clock", async () => {
    const loss = { ...fixtureIncident(), realizedHolderLossPct: 2.95 };
    const covered = fixtureIncident(loss.assetId, "fixture-covered-loss");
    const { getSafetyScoreV9ReviewedIncidents, projectSafetyScoreV9RealizedHolderLossEvents } =
      await loadIncidents([loss, covered]);
    const reviewedAtSec = Date.parse(`${loss.reviewedAt}T00:00:00Z`) / 1_000;
    expect(projectSafetyScoreV9RealizedHolderLossEvents(
      getSafetyScoreV9ReviewedIncidents(loss.assetId, reviewedAtSec - 1), reviewedAtSec - 1,
    )).toEqual([]);
    expect(projectSafetyScoreV9RealizedHolderLossEvents(
      getSafetyScoreV9ReviewedIncidents(loss.assetId, reviewedAtSec), reviewedAtSec,
    )).toEqual([{
      incidentId: loss.incidentId,
      assetId: loss.assetId,
      scope: loss.scope,
      occurredAt: loss.occurredAt,
      realizedHolderLossPct: 2.95,
      primarySources: loss.primarySources,
      finding: loss.finding,
    }]);
  });

  it.each(["missing-source", "unverified-remediation", "future-source"] as const)(
    "keeps %s incidents outside the admitted positive path",
    async (defect) => {
      const incident = { ...fixtureIncident(), realizedHolderLossPct: 2.95 };
      const invalid = defect === "missing-source"
        ? { ...incident, primarySources: [] }
        : defect === "future-source"
          ? { ...incident, primarySources: [{ ...incident.primarySources[0], publishedAt: "2027-01-01" }] }
          : { ...incident, status: "resolved", resolvedAt: "2026-06-11" };
      const { getSafetyScoreV9ReviewedIncidents } = await loadIncidents([invalid]);
      expect(() => getSafetyScoreV9ReviewedIncidents(incident.assetId,
        Date.parse("2026-10-22T00:00:00Z") / 1_000)).toThrow(
        expect.objectContaining({ name: "ReviewedRegistryEntryError" }),
      );
    },
  );
});
