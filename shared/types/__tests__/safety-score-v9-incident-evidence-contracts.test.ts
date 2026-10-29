import { describe, expect, it } from "vitest";
import {
  V9DeploymentControlFactBaseSchema,
  V9IncidentCoverageSchema,
} from "../safety-score-v9-facts";
import {
  V9AuthoredNegativeIncidentReviewSchema,
  V9IssuerSurfaceIncidentReviewSchema,
  V9NegativeIncidentReviewSchema,
  V9ProviderIncidentReviewSchema,
  V9LaneIncidentCertificateSchema,
  V9LaneIncidentScreeningResultSchema,
} from "../safety-score-v9-incidents";
import { BridgeRouteRiskProfileSchema } from "../stablecoin-meta-control-schemas";

const ROUTE_ETHEREUM = "ethereum:0x1111111111111111111111111111111111111111";
const ROUTE_BASE = "base:0x2222222222222222222222222222222222222222";
const CERTIFICATE_ID = "lane-cert:ethereum:0xabcdef:100-200:0123456789ab";

const REVIEW = {
  reviewId: "fixture-negative-review",
  assetId: "fixture-asset",
  scope: { kind: "control", controlKey: "mint-meta:fixture-asset:controller" },
  reviewedAt: "2026-10-07T14:00:00Z",
  reviewer: "Fixture incident researcher",
  windowStartSec: Date.parse("2026-09-01T00:00:00Z") / 1_000,
  windowEndSec: Date.parse("2026-10-07T13:00:00Z") / 1_000,
  conclusion: "no-known-incident",
  searchedSurfaces: [
    { kind: "issuer-announcements", url: "https://example.com/news", finding: "No control incident is disclosed in the search window." },
    { kind: "explorer-events", url: "https://example.com/events", finding: "Pinned exact-contract log scan shows no emergency events." },
    { kind: "incident-tracker", url: "https://example.com/tracker", finding: "Exact deployment searched in the incident tracker." },
  ],
  sources: [{
    label: "Provider status archive",
    url: "https://example.com/status",
    observedAt: "2026-10-07T13:30:00Z",
    location: "Status archive",
    excerpt: "Operational",
  }],
} as const;

const PROVIDER_REVIEW = {
  ...REVIEW,
  reviewId: "fixture-provider-lane-review",
  scope: {
    kind: "provider",
    providerKey: "layerzero",
    surface: "dvn-set",
    coveredRoutes: [ROUTE_BASE, ROUTE_ETHEREUM],
    coveredControls: ["fixture-dvn-set"],
  },
  laneScreeningRefs: [
    { routeId: ROUTE_ETHEREUM, certificateId: CERTIFICATE_ID },
    { routeId: ROUTE_BASE, certificateId: "lane-cert:base:0xabcdef:100-200:0123456789ab" },
  ],
} as const;

const CERTIFICATE = {
  schemaVersion: 1,
  certificateId: CERTIFICATE_ID,
  evidenceClass: "explorer-events",
  deploymentKey: "ethereum:0xabcdef",
  codeHash: `0x${"a".repeat(64)}`,
  fromBlock: 100,
  toBlock: 200,
  windowStartSec: 1_700_000_000,
  windowEndSec: 1_700_100_000,
  observedAtSec: 1_700_200_000,
  screeningPolicyDigest: "b".repeat(64),
  logDigest: "c".repeat(64),
  screenedTopics: [
    { family: "ExecutorConfigSet", topic0: `0x${"e".repeat(64)}` },
    { family: "UlnConfigSet", topic0: `0x${"d".repeat(64)}` },
  ],
  eventCounts: { UlnConfigSet: 0 },
  finding: "no-material-admin-event",
} as const;

const MATERIAL_CERTIFICATE = {
  ...CERTIFICATE,
  finding: "material-event",
  eventCounts: { UlnConfigSet: 1 },
  materialEvents: [{ family: "UlnConfigSet", transactionHash: `0x${"f".repeat(64)}`, blockNumber: 150, logIndex: 2 }],
} as const;

const CONTROL_FACT = {
  controlKey: "control:fixture",
  deploymentKey: "deployment:ethereum",
  controlKind: "upgrade",
  scope: "global",
  capabilities: ["upgrade"],
  capSemantics: { kind: "raiseable", bound: { amount: 1, unit: "supply-fraction" } },
  claimImpairment: "unbounded",
  economicLossScope: "global-claim",
  authority: { authorityKey: "safe:admin", model: "multisig", threshold: { required: 2, total: 3 } },
  delaySec: 86_400,
  materialSupplyShare: 1,
  incidentState: "unknown",
  failureDomains: [{ kind: "upgrade-control", key: "safe:admin" }],
} as const;

const PROFILE = {
  tier: "external-validated-network",
  summary: "Fixture bridge route risk profile for provider identity admission.",
  reviewedAt: "2026-10-01",
  reviewer: "Fixture reviewer",
  confidence: "verified",
  protocols: [{ source: "docs", name: "LayerZero", slug: "layerzero" }],
} as const;

describe("authored control review identity", () => {
  it("admits authored route/control tuples, mint labels and the lane wildcard", () => {
    for (const scope of [
      { kind: "control", routeId: ROUTE_ETHEREUM, controlId: "fixture-dvn-set" },
      { kind: "control", controlId: "Lido EarnUSD ShareManager" },
      { kind: "control", routeId: ROUTE_ETHEREUM, controlId: "*" },
    ] as const) {
      expect(V9AuthoredNegativeIncidentReviewSchema.safeParse({ ...REVIEW, scope }).success).toBe(true);
    }
    expect(V9AuthoredNegativeIncidentReviewSchema.parse({
      ...REVIEW, scope: { kind: "control", routeId: ROUTE_ETHEREUM, controlIds: ["fixture-z", "fixture-a"] },
    }).scope).toEqual({ kind: "control", routeId: ROUTE_ETHEREUM, controlIds: ["fixture-a", "fixture-z"] });
  });

  it("keeps the admitted legacy review byte-identical", () => {
    expect(V9NegativeIncidentReviewSchema.parse(REVIEW)).toEqual(REVIEW);
  });

  it("rejects missing, mixed and incomplete authored identities", () => {
    for (const scope of [
      { kind: "control" },
      { kind: "control", controlKey: "mint-meta:fixture-asset:controller", routeId: ROUTE_ETHEREUM, controlId: "fixture-dvn-set" },
      { kind: "control", controlId: "*" },
      { kind: "control", controlIds: ["fixture-a"] },
      { kind: "control", routeId: ROUTE_ETHEREUM, controlId: "fixture-a", controlIds: ["fixture-b"] },
      { kind: "control", routeId: ROUTE_ETHEREUM, controlIds: ["*"] },
      { kind: "control", routeId: ROUTE_ETHEREUM, controlIds: ["fixture-a", "fixture-a"] },
    ] as const) {
      expect(V9AuthoredNegativeIncidentReviewSchema.safeParse({ ...REVIEW, scope }).success, JSON.stringify(scope)).toBe(false);
      expect(V9NegativeIncidentReviewSchema.safeParse({ ...REVIEW, scope }).success, JSON.stringify(scope)).toBe(false);
    }
  });

  it("retains retirement provenance but never before the review it retires", () => {
    const retired = { reviewedAt: "2026-10-08", reviewer: "Fixture curator", reason: "Orphaned authored route after metadata re-authoring." };
    expect(V9NegativeIncidentReviewSchema.safeParse({ ...REVIEW, retired }).success).toBe(true);
    expect(V9AuthoredNegativeIncidentReviewSchema.safeParse({
      ...REVIEW, scope: { kind: "control", routeId: ROUTE_ETHEREUM, controlId: "fixture-dvn-set" }, retired,
    }).success).toBe(true);
    expect(V9NegativeIncidentReviewSchema.safeParse({ ...REVIEW, retired: { ...retired, reviewedAt: "2026-10-07T13:00:00Z" } }).success).toBe(false);
    expect(V9NegativeIncidentReviewSchema.safeParse({ ...REVIEW, retired: { ...retired, controlKey: "mint-meta:fixture-asset:x" } }).success).toBe(false);
  });
});

describe("asset-wide issuer-surface review", () => {
  it("admits a dated asset-wide issuer surface naming its lanes", () => {
    const scope = { kind: "issuer-surface", coveredRoutes: [ROUTE_BASE, ROUTE_ETHEREUM], coveredControls: ["fixture-dvn-set"] };
    const parsed = V9IssuerSurfaceIncidentReviewSchema.parse({ ...REVIEW, scope });
    expect(parsed.scope.coveredRoutes).toEqual([ROUTE_BASE, ROUTE_ETHEREUM]);
    for (const malformed of [
      { kind: "issuer-surface", coveredRoutes: [] },
      { kind: "issuer-surface", coveredRoutes: [ROUTE_ETHEREUM], coveredControls: ["Fixture-DVN"] },
      { kind: "issuer-surface", coveredRoutes: [ROUTE_ETHEREUM, ROUTE_ETHEREUM] },
      { kind: "control", routeId: ROUTE_ETHEREUM, controlId: "fixture-dvn-set" },
    ]) {
      expect(V9IssuerSurfaceIncidentReviewSchema.safeParse({ ...REVIEW, scope: malformed }).success).toBe(false);
    }
  });
});

describe("provider-scoped incident review admission", () => {
  it("admits a provider review that binds a certificate to every covered route", () => {
    const parsed = V9ProviderIncidentReviewSchema.parse(PROVIDER_REVIEW);
    expect(parsed.scope.coveredRoutes).toEqual([ROUTE_BASE, ROUTE_ETHEREUM]);
    expect(parsed.laneScreeningRefs).toHaveLength(2);
  });

  it("refuses provider coverage without a lane screening certificate", () => {
    const { laneScreeningRefs: _refs, ...withoutRefs } = PROVIDER_REVIEW;
    expect(V9ProviderIncidentReviewSchema.safeParse(withoutRefs).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({ ...PROVIDER_REVIEW, laneScreeningRefs: [] }).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW, laneScreeningRefs: PROVIDER_REVIEW.laneScreeningRefs.slice(1),
    }).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW,
      laneScreeningRefs: [...PROVIDER_REVIEW.laneScreeningRefs, PROVIDER_REVIEW.laneScreeningRefs[0]],
    }).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW,
      laneScreeningRefs: [{ routeId: "arbitrum:0x3333333333333333333333333333333333333333", certificateId: CERTIFICATE_ID }],
    }).success).toBe(false);
  });

  it("validates provider keys, surfaces and covered identities against the authored vocabularies", () => {
    for (const scope of [
      { ...PROVIDER_REVIEW.scope, providerKey: "across" },
      { ...PROVIDER_REVIEW.scope, surface: "dvn" },
      { ...PROVIDER_REVIEW.scope, coveredRoutes: [] },
      { ...PROVIDER_REVIEW.scope, coveredControls: ["Fixture-DVN"] },
    ]) {
      expect(V9ProviderIncidentReviewSchema.safeParse({ ...PROVIDER_REVIEW, scope }).success).toBe(false);
    }
  });
});

describe("lane incident certificate admission", () => {
  it("admits clean and material pinned-window certificates", () => {
    expect(V9LaneIncidentCertificateSchema.parse(CERTIFICATE)).toEqual(CERTIFICATE);
    expect(V9LaneIncidentCertificateSchema.safeParse(MATERIAL_CERTIFICATE).success).toBe(true);
  });

  it("keeps findings, counts, event references and the pinned window consistent", () => {
    for (const malformed of [
      { ...CERTIFICATE, finding: "material-event" },
      { ...MATERIAL_CERTIFICATE, finding: "no-material-admin-event" },
      { ...MATERIAL_CERTIFICATE, eventCounts: { UlnConfigSet: 0 } },
      { ...MATERIAL_CERTIFICATE, materialEvents: [{ ...MATERIAL_CERTIFICATE.materialEvents[0], blockNumber: 201 }] },
      { ...MATERIAL_CERTIFICATE, materialEvents: [{ ...MATERIAL_CERTIFICATE.materialEvents[0], family: "SetPeer" }] },
      { ...CERTIFICATE, toBlock: 99 },
      { ...CERTIFICATE, observedAtSec: 1_699_999_999 },
      { ...CERTIFICATE, windowEndSec: 1_699_999_999 },
      { ...CERTIFICATE, eventCounts: { SetPeer: 0 } },
      { ...CERTIFICATE, eventCounts: { UnknownEvent: 0 } },
      { ...CERTIFICATE, screenedTopics: [{ family: "UlnConfigSet", topic0: `0X${"d".repeat(64)}` }] },
      { ...CERTIFICATE, logDigest: "C".repeat(64) },
    ]) {
      expect(V9LaneIncidentCertificateSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("reports a failed read as a reasoned result rather than a certificate", () => {
    const failed = { outcome: "failed", deploymentKey: "ethereum:0xabcdef", failureReason: "pruned-range", observedAtSec: 1_700_200_000 };
    expect(V9LaneIncidentScreeningResultSchema.parse(failed)).toEqual(failed);
    expect(V9LaneIncidentScreeningResultSchema.safeParse({ ...failed, failureReason: "explorer-down" }).success).toBe(false);
    expect(V9LaneIncidentScreeningResultSchema.safeParse({ ...failed, certificate: CERTIFICATE }).success).toBe(false);
    expect(V9LaneIncidentScreeningResultSchema.safeParse({ outcome: "admitted", certificate: CERTIFICATE }).success).toBe(true);
  });
});

describe("authored bridge provider identity", () => {
  it("keeps absent provider identity out of the parsed profile", () => {
    const parsed = BridgeRouteRiskProfileSchema.parse(PROFILE);
    expect(parsed).toEqual(PROFILE);
    expect(parsed.protocols?.[0]).not.toHaveProperty("providerKey");
  });

  it("admits the shared provider key and surface vocabularies only", () => {
    expect(BridgeRouteRiskProfileSchema.safeParse({
      ...PROFILE,
      protocols: [{ ...PROFILE.protocols[0], providerKey: "layerzero", providerSurfaces: ["dvn-set", "endpoint"] }],
    }).success).toBe(true);
    for (const protocols of [
      [{ ...PROFILE.protocols[0], providerKey: "across" }],
      [{ ...PROFILE.protocols[0], providerSurfaces: [] }],
      [{ ...PROFILE.protocols[0], providerSurfaces: ["dvn-set", "dvn-set"] }],
      [{ ...PROFILE.protocols[0], providerSurfaces: ["dvn"] }],
    ]) {
      expect(BridgeRouteRiskProfileSchema.safeParse({ ...PROFILE, protocols }).success).toBe(false);
    }
  });
});

describe("incident coverage on the shared control fact", () => {
  it("is omitted when absent so current control facts stay byte-identical", () => {
    const parsed = V9DeploymentControlFactBaseSchema.parse(CONTROL_FACT);
    expect(parsed).not.toHaveProperty("incidentCoverage");
    expect(JSON.stringify(parsed)).not.toContain("incidentCoverage");
  });

  it("requires exact-lane certificates for provider+screening coverage", () => {
    const coverage = {
      source: "provider+screening",
      controlIds: ["fixture-z", "fixture-a"],
      certificateRefs: [CERTIFICATE_ID],
    } as const;
    expect(V9IncidentCoverageSchema.parse(coverage).controlIds).toEqual(["fixture-a", "fixture-z"]);
    expect(V9DeploymentControlFactBaseSchema.safeParse({ ...CONTROL_FACT, incidentCoverage: coverage }).success).toBe(true);
    expect(V9IncidentCoverageSchema.safeParse({ source: "provider+screening" }).success).toBe(false);
    expect(V9IncidentCoverageSchema.safeParse({ source: "provider+screening", certificateRefs: [] }).success).toBe(false);
  });

  it("rejects certificate references on non-provider coverage", () => {
    for (const coverage of [
      { source: "control", certificateRefs: [CERTIFICATE_ID] },
      { source: "control", controlIds: ["fixture-a"] },
      { source: "deployment", certificateRefs: [CERTIFICATE_ID] },
      { source: "provider-review" },
      { source: "provider+screening", certificateRefs: [CERTIFICATE_ID, CERTIFICATE_ID] },
    ]) {
      expect(V9IncidentCoverageSchema.safeParse(coverage).success).toBe(false);
    }
    expect(V9IncidentCoverageSchema.parse({ source: "control" })).toEqual({ source: "control" });
  });
});
