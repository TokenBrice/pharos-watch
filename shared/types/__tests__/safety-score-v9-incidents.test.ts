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
