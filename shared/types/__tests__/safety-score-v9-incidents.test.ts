import incidentReviewsAsset from "../../data/safety-score-v9/incident-reviews-v1.json";
import { describe, expect, it } from "vitest";
import {
  V9ReviewedIncidentRegistrySchema,
  V9ReviewedIncidentSchema,
  V9NegativeIncidentReviewSchema,
} from "../safety-score-v9-incidents";
import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  V9WrapperLocalFactsSchema,
} from "../safety-score-v9-wrapper";
import { V9OperationalResilienceIncidentSchema } from "../safety-score-v9-operational-resilience-primitives";

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

const NEGATIVE_REVIEW = {
  reviewId: "fixture-negative-review",
  assetId: "fixture-asset",
  scope: { kind: "control", controlKey: "mint-meta:fixture-asset:controller" },
  reviewedAt: "2026-10-07T14:00:00Z",
  reviewer: "Fixture incident researcher",
  windowStartSec: Date.parse("2026-09-01T00:00:00Z") / 1_000,
  windowEndSec: Date.parse("2026-10-07T13:00:00Z") / 1_000,
  conclusion: "no-known-incident",
  searchedSurfaces: [
    { kind: "issuer-announcements", url: "https://example.com/news", finding: "No control incident disclosed in the specified search window." },
    { kind: "explorer-events", url: "https://example.com/events", finding: "Exact deployment event census completed through the pinned window end." },
    { kind: "incident-tracker", url: "https://example.com/tracker", finding: "Exact issuer/deployment searched in incident tracker." },
  ],
  sources: [{ label: "Primary announcement archive", url: "https://example.com/news", observedAt: "2026-10-07T13:30:00Z", location: "Dated announcements archive", excerpt: "Operational status" }],
} as const;

describe("Safety Score v9 researched-negative incident schema", () => {
  it("admits exact control and deployment scope without inventing an incident", () => {
    expect(V9NegativeIncidentReviewSchema.safeParse(NEGATIVE_REVIEW).success).toBe(true);
    expect(V9NegativeIncidentReviewSchema.safeParse({
      ...NEGATIVE_REVIEW,
      scope: { kind: "deployment", deploymentKey: "ethereum:0x1111111111111111111111111111111111111111", controlKinds: ["mint"] },
    }).success).toBe(true);
    const registry = V9ReviewedIncidentRegistrySchema.parse({ schemaVersion: 1, incidents: [], negativeReviews: [NEGATIVE_REVIEW] });
    expect(registry.incidents).toEqual([]);
    expect(registry.negativeReviews).toHaveLength(1);
  });

  it("compares source and review timestamps without truncating fractional seconds", () => {
    const reviewedAt = "2026-10-07T14:52:14.754Z";
    for (const observedAt of ["2026-10-07T14:50:33.371Z", reviewedAt]) {
      expect(V9NegativeIncidentReviewSchema.safeParse({
        ...NEGATIVE_REVIEW, reviewedAt, sources: [{ ...NEGATIVE_REVIEW.sources[0], observedAt }],
      }).success).toBe(true);
    }
    expect(V9NegativeIncidentReviewSchema.safeParse({
      ...NEGATIVE_REVIEW, reviewedAt, sources: [{ ...NEGATIVE_REVIEW.sources[0], observedAt: "2026-10-07T14:52:14.755Z" }],
    }).success).toBe(false);
  });

  it("requires finite ordered windows, actual observation dates, and all search classes", () => {
    for (const overrides of [
      { windowStartSec: NEGATIVE_REVIEW.windowEndSec + 1 },
      { windowEndSec: Date.parse("2026-10-08T00:00:00Z") / 1_000 },
      { windowEndSec: Infinity },
      { reviewedAt: "not-a-date" },
      { conclusion: "unknown" },
      { searchedSurfaces: NEGATIVE_REVIEW.searchedSurfaces.slice(1) },
      { searchedSurfaces: NEGATIVE_REVIEW.searchedSurfaces.slice(0, 2) },
      { searchedSurfaces: NEGATIVE_REVIEW.searchedSurfaces.filter((surface) => surface.kind !== "explorer-events") },
      { sources: [] },
      { sources: [{ ...NEGATIVE_REVIEW.sources[0], observedAt: "2026-10-07T15:00:00Z" }] },
      { scope: { kind: "control", controlKey: "mint-meta:another-asset:controller" } },
      { scope: { kind: "deployment", deploymentKey: "ethereum:0x1111111111111111111111111111111111111111", controlKinds: [] } },
    ]) {
      expect(V9NegativeIncidentReviewSchema.safeParse({ ...NEGATIVE_REVIEW, ...overrides }).success).toBe(false);
    }
  });

  it("rejects duplicate negative-review IDs and preserves the legacy envelope", () => {
    expect(V9ReviewedIncidentRegistrySchema.safeParse(incidentReviewsAsset).success).toBe(true);
    expect(V9ReviewedIncidentRegistrySchema.safeParse({
      schemaVersion: 1, incidents: [], negativeReviews: [NEGATIVE_REVIEW, NEGATIVE_REVIEW],
    }).success).toBe(false);
  });
});

describe("Safety Score v9 reviewed incident schema", () => {

  it("admits only scoped, verified, non-realized informational vulnerability history", () => {
    const registry = V9ReviewedIncidentRegistrySchema.parse(incidentReviewsAsset);
    const history = registry.incidents.find((incident) => incident.assetId === "xaut-tether")!;
    expect(history).toMatchObject({
      domain: "security-history",
      realization: "no-reported-exploit",
      dateBasis: "public-disclosure",
      resolutionDateBasis: "primary-confirmation",
      posture: { treatment: "informational-only" },
      scope: { kind: "contract-component" },
    });
    for (const overrides of [
      { status: "active", resolvedAt: null },
      { realization: "realized-exploit" },
      { posture: { treatment: "mint-penalty" } },
      { remediation: { ...history.remediation, state: "in-progress" } },
      { scope: { kind: "root-claim" } },
      { resolvedAt: null },
      { occurredAt: "2023-04-05" },
      { resolvedAt: "2023-05-28" },
      { remediation: { ...history.remediation, lastVerifiedAt: "2023-05-26" } },
    ]) {
      expect(V9ReviewedIncidentSchema.safeParse({ ...history, ...overrides }).success).toBe(false);
    }
    expect(V9ReviewedIncidentSchema.safeParse({
      ...BASE_INCIDENT, scope: history.scope,
    }).success).toBe(false);
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

  it("requires resolution no later than review and remediation verification", () => {
    for (const resolvedAt of ["2026-01-11", "2026-02-02", "2027-01-01"]) {
      const result = V9ReviewedIncidentSchema.safeParse({ ...BASE_INCIDENT, resolvedAt });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["resolvedAt"] }));
    }
    expect(V9ReviewedIncidentSchema.safeParse({
      ...BASE_INCIDENT, resolvedAt: BASE_INCIDENT.reviewedAt,
      remediation: { ...BASE_INCIDENT.remediation, lastVerifiedAt: BASE_INCIDENT.reviewedAt },
    }).success).toBe(true);
    expect(V9ReviewedIncidentSchema.safeParse({
      ...BASE_INCIDENT, status: "mitigated", resolvedAt: null,
      remediation: { ...BASE_INCIDENT.remediation, state: "in-progress" },
    }).success).toBe(true);
  });

  it("bounds remediation verification inclusively by occurrence and review", () => {
    for (const lastVerifiedAt of [BASE_INCIDENT.occurredAt, BASE_INCIDENT.reviewedAt]) {
      expect(V9ReviewedIncidentSchema.safeParse({
        ...BASE_INCIDENT, resolvedAt: lastVerifiedAt, remediation: { ...BASE_INCIDENT.remediation, lastVerifiedAt },
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

  it("enforces operational incident state and resolution dates at the shared primitive", () => {
    const resolved = {
      incidentKey: "fixture-outage",
      name: "Fixture outage",
      category: "redemption",
      state: "resolved",
      occurredAt: "2026-01-01",
      resolvedAt: "2026-01-02",
    } as const;
    expect(V9OperationalResilienceIncidentSchema.safeParse(resolved).success).toBe(true);
    expect(V9OperationalResilienceIncidentSchema.safeParse({
      ...resolved,
      state: "active",
    }).success).toBe(false);
    expect(V9OperationalResilienceIncidentSchema.safeParse({
      ...resolved,
      resolvedAt: null,
    }).success).toBe(false);
  });

  it("rejects a wrapper incident overlay with a non-canonical deployment key", () => {
    const facts = Object.fromEntries(
      V9_WRAPPER_LOCAL_FACT_KEYS.map((key) => [
        key,
        {
          disposition: "integration-missing",
          assessment: null,
          signals: [`fixture:${key}`],
          evidenceRefIds: [],
          ...(key === "measuredUnwind"
            ? {
                incidentPostures: [{
                  incidentId: "fixture-wrapper-incident",
                  scope: {
                    kind: "deployment",
                    deploymentKey: "Ethereum:Fixture",
                    exposureShare: 1,
                  },
                  assessment: "high",
                  evidenceRefIds: ["fixture-evidence"],
                }],
              }
            : {}),
        },
      ]),
    );
    expect(V9WrapperLocalFactsSchema.safeParse({
      schemaVersion: 1,
      applicability: "wrapper",
      form: "strategy-vault",
      formDisposition: "integration-missing",
      formSignals: ["fixture-wrapper"],
      formEvidenceRefIds: [],
      facts,
      riskTransfer: {
        disposition: "integration-missing",
        mechanism: "unknown",
        maximumParentLossAbsorptionPoints: 0,
        signals: ["fixture-risk-transfer"],
        evidenceRefIds: [],
      },
    }).success).toBe(false);
  });
});
