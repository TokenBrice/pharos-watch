import incidentReviewsAsset from "../../data/safety-score-v9/incident-reviews-v1.json";
import { describe, expect, it } from "vitest";
import {
  V9ReviewedIncidentRegistrySchema,
  V9ReviewedIncidentSchema,
} from "../safety-score-v9-incidents";

const BASE_INCIDENT = {
  incidentId: "fixture-control-incident",
  assetId: "fixture-asset",
  domain: "control",
  kind: "mint-control-failure",
  occurredAt: "2026-01-01",
  resolvedAt: "2026-01-10",
  status: "resolved",
  scope: { kind: "root-claim" },
  posture: {
    component: "mint",
    controlKinds: ["mint"],
    incidentState: "resolved",
  },
  reviewedAt: "2026-02-01",
  reviewer: "Fixture reviewer",
  primarySources: [
    {
      label: "Fixture primary source",
      url: "https://example.com/incident",
      publishedAt: "2026-01-10",
    },
  ],
  finding: "A reviewed fixture incident affected the mint-control domain.",
  remediation: {
    state: "verified",
    lastVerifiedAt: "2026-01-10",
    summary: "The reviewed fix was deployed and verified.",
    sources: [
      {
        label: "Fixture remediation source",
        url: "https://example.com/remediation",
        publishedAt: "2026-01-10",
      },
    ],
  },
} as const;

describe("Safety Score v9 reviewed incident schema", () => {
  it("validates the reviewed registry and keeps its narrow domain vocabulary", () => {
    const registry = V9ReviewedIncidentRegistrySchema.parse(incidentReviewsAsset);
    expect(registry.incidents.map((incident) => incident.assetId)).toEqual([
      "usdp-parallel",
      "sdola-inverse-finance",
      "zsd-zephyr-protocol",
    ]);
    expect(registry.incidents.every((incident) => incident.primarySources.length > 0)).toBe(true);
  });

  it("requires a resolution on or after occurrence for resolved incidents", () => {
    expect(V9ReviewedIncidentSchema.safeParse(BASE_INCIDENT).success).toBe(true);
    expect(V9ReviewedIncidentSchema.safeParse({ ...BASE_INCIDENT, resolvedAt: BASE_INCIDENT.occurredAt }).success).toBe(true);
    for (const resolvedAt of [undefined, "2025-12-31"]) {
      const result = V9ReviewedIncidentSchema.safeParse({ ...BASE_INCIDENT, resolvedAt });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["resolvedAt"] }));
    }
  });

  it("bounds remediation verification inclusively by occurrence and review", () => {
    for (const lastVerifiedAt of [BASE_INCIDENT.occurredAt, BASE_INCIDENT.reviewedAt]) {
      expect(V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT, remediation: { ...BASE_INCIDENT.remediation, lastVerifiedAt },
      }).success).toBe(true);
    }
    for (const lastVerifiedAt of ["2025-12-31", "2026-02-02"]) {
      const result = V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT, remediation: { ...BASE_INCIDENT.remediation, lastVerifiedAt },
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["remediation", "lastVerifiedAt"] }));
    }
  });

  it("independently rejects primary and remediation sources published after review", () => {
    for (const lane of ["primary", "remediation"] as const) {
      const withSourceDate = (publishedAt: string) => lane === "primary"
        ? { ...BASE_INCIDENT, primarySources: [{ ...BASE_INCIDENT.primarySources[0], publishedAt }] }
        : { ...BASE_INCIDENT, remediation: { ...BASE_INCIDENT.remediation, sources: [{ ...BASE_INCIDENT.remediation.sources[0], publishedAt }] } };
      expect(V9ReviewedIncidentSchema.safeParse(withSourceDate(BASE_INCIDENT.reviewedAt)).success).toBe(true);
      const result = V9ReviewedIncidentSchema.safeParse(withSourceDate("2026-02-02"));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: lane === "primary" ? ["primarySources", 0, "publishedAt"] : ["remediation", "sources", 0, "publishedAt"],
      }));
    }
  });

  it("maps active control incidents to active posture and mitigated or resolved incidents to historical posture", () => {
    for (const status of ["active", "mitigated", "resolved"] as const) {
      const incidentState = status === "active" ? "active" : "resolved";
      const valid = { ...BASE_INCIDENT, status, resolvedAt: status === "active" ? null : BASE_INCIDENT.resolvedAt,
        posture: { ...BASE_INCIDENT.posture, incidentState } };
      expect(V9ReviewedIncidentSchema.safeParse(valid).success).toBe(true);
      const result = V9ReviewedIncidentSchema.safeParse({
        ...valid, posture: { ...valid.posture, incidentState: status === "active" ? "resolved" : "active" },
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["posture", "incidentState"] }));
    }
  });

  it("preserves integration-only wrapper scope and holder-exit peg scope", () => {
    const cases = [
      { ...BASE_INCIDENT, domain: "wrapper-local", kind: "share-accounting-integration-failure",
        scope: { kind: "integration-only", integrationKey: "fixture:integration" },
        posture: { shareAccountingNavOracle: "low", measuredUnwind: "moderate" } },
      { ...BASE_INCIDENT, domain: "peg", kind: "holder-exit-impairment",
        scope: { kind: "holder-exit" }, posture: { treatment: "peg-multiplier-only" } },
    ];
    for (const valid of cases) {
      expect(V9ReviewedIncidentSchema.safeParse(valid).success).toBe(true);
      const result = V9ReviewedIncidentSchema.safeParse({ ...valid, scope: { kind: "root-claim" } });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["scope"] }));
    }
  });

  it("rejects unsupported domain and kind combinations", () => {
    expect(
      V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT,
        domain: "peg",
      }).success,
    ).toBe(false);
    expect(
      V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT,
        kind: "arbitrary-disclosed-event",
      }).success,
    ).toBe(false);
  });

  it("requires measured deployment exposure and coherent incident history", () => {
    expect(
      V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT,
        scope: { kind: "deployment", deploymentKey: "ethereum:fixture" },
      }).success,
    ).toBe(false);
    expect(
      V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT,
        status: "active",
        posture: { ...BASE_INCIDENT.posture, incidentState: "active" },
      }).success,
    ).toBe(false);
    expect(
      V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT,
        remediation: { ...BASE_INCIDENT.remediation, state: "in-progress" },
      }).success,
    ).toBe(false);
  });
});
