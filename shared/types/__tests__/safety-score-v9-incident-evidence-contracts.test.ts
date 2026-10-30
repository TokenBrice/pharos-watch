import { describe, expect, it } from "vitest";
import incidentReviewsAsset from "../../data/safety-score-v9/incident-reviews-v1.json";
import {
  V9DeploymentControlFactBaseSchema,
  V9DeploymentControlFactV2Schema,
  V9IncidentCoverageSchema,
} from "../safety-score-v9-facts";
import {
  V9AuthoredNegativeIncidentReviewSchema,
  V9AuthoredIncidentRegistryEnvelopeSchema,
  V9IssuerSurfaceIncidentReviewSchema,
  V9NegativeIncidentReviewSchema,
  V9ProviderIncidentReviewSchema,
  V9ProviderIncidentDisclosureSchema,
  V9RetirableNegativeIncidentReviewSchema,
  V9LaneIncidentCertificateSchema,
  V9LaneIncidentScreeningResultSchema,
  V9_INCIDENT_REVIEW_SURFACE_KIND_VALUES,
  V9_LANE_ADMIN_EVENT_FAMILY_VALUES,
  V9_LANE_SCREENING_EVIDENCE_CLASS,
} from "../safety-score-v9-incidents";
import { BridgeRouteRiskProfileSchema } from "../stablecoin-meta-control-schemas";

const ASSET = "fixture-asset";
const ROUTE_ETHEREUM = "ethereum:0x1111111111111111111111111111111111111111";
const ROUTE_BASE = "base:0x2222222222222222222222222222222222222222";
const CERTIFICATE_ID = "lane-cert:ethereum:0xabcdef:100-200:0123456789ab";
const CERTIFICATE_ID_BASE = "lane-cert:base:0xabcdef:100-200:0123456789ab";
const EMITTER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_EMITTER_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const REVIEW = {
  reviewId: "fixture-negative-review",
  assetId: ASSET,
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
const { assetId: _reviewAssetId, ...REVIEW_BODY } = REVIEW;

const PROVIDER_REVIEW = {
  ...REVIEW_BODY,
  reviewId: "provider-review:layerzero:2026-10-07",
  scope: {
    kind: "provider",
    providerKey: "layerzero",
    surface: "dvn-set",
    coveredRoutes: [
      { assetId: ASSET, routeId: ROUTE_BASE },
      { assetId: ASSET, routeId: ROUTE_ETHEREUM },
    ],
  },
  providerIncidents: [],
} as const;

const EMITTER = {
  address: EMITTER_ADDRESS,
  expectedRuntimeCodeSha256: "d".repeat(64),
  runtimeCodeSha256: "d".repeat(64),
  families: ["ExecutorConfigSet", "UlnConfigSet"],
} as const;

const CERTIFICATE = {
  schemaVersion: 1,
  certificateId: CERTIFICATE_ID,
  evidenceClass: "explorer-events",
  subjectDeploymentKey: "ethereum:0xabcdef",
  fromBlock: 100,
  toBlock: 200,
  toBlockHash: `0x${"1".repeat(64)}`,
  windowStartSec: 1_700_000_000,
  windowEndSec: 1_700_100_000,
  observedAtSec: 1_700_200_000,
  screeningPolicyDigest: "b".repeat(64),
  logDigest: "c".repeat(64),
  emitters: [EMITTER],
  screenedTopics: [
    { family: "ExecutorConfigSet", topic0: `0x${"e".repeat(64)}`, signature: "ExecutorConfigSet(address,uint32,address)" },
    { family: "UlnConfigSet", topic0: `0x${"f".repeat(64)}`, signature: "UlnConfigSet(address,address,uint32,bytes)" },
  ],
  eventCounts: { ExecutorConfigSet: 0, UlnConfigSet: 0 },
  finding: "no-material-admin-event",
} as const;

const MATERIAL_CERTIFICATE = {
  ...CERTIFICATE,
  finding: "material-event",
  eventCounts: { ExecutorConfigSet: 0, UlnConfigSet: 1 },
  materialEvents: [{
    address: EMITTER_ADDRESS,
    family: "UlnConfigSet",
    transactionHash: `0x${"a".repeat(64)}`,
    blockNumber: 150,
    logIndex: 2,
  }],
} as const;

const STATUS = {
  applicability: { state: "required", policyRuleId: "fixture.required", rationale: null, gapId: null },
  observationState: "missing",
  evidenceRefIds: [],
  gapIds: ["control:fixture:incidentState"],
} as const;

const CONTROL_FACT = {
  controlKey: "control:fixture",
  deploymentKey: "deployment:ethereum",
  controlKind: "bridge",
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
const CONTROL_FACT_V2 = { ...CONTROL_FACT, sourceGenerationId: "fixture-generation", status: STATUS } as const;

const CLOSURE_WITNESSES = {
  source: "provider-screening",
  providerReviewIds: ["provider-review:layerzero:2026-10-07"],
  issuerSurfaceReviewId: "issuer-surface:fixture-asset:2026-10-07",
  screeningSetId: "screening-set:fixture",
  certificateId: CERTIFICATE_ID,
  contributorControlIds: ["fixture-dvn-set"],
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

  it("keeps the admitted legacy review byte-identical and retirement-free", () => {
    const parsed = V9NegativeIncidentReviewSchema.parse(REVIEW);
    expect(parsed).toEqual(REVIEW);
    expect(parsed).not.toHaveProperty("retired");
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
});

describe("retirement admission (M-5)", () => {
  const retired = { reviewedAt: "2026-10-08", reviewer: "Fixture curator", reason: "Orphaned authored route after metadata re-authoring." };

  it("refuses retirement on the T1/T2 admitted legacy schema", () => {
    expect(V9NegativeIncidentReviewSchema.safeParse({ ...REVIEW, retired }).success).toBe(false);
  });

  it("admits retirement only through the retirable and new-kind records", () => {
    expect(V9RetirableNegativeIncidentReviewSchema.safeParse({ ...REVIEW, retired }).success).toBe(true);
    const authored = { ...REVIEW, scope: { kind: "control", routeId: ROUTE_ETHEREUM, controlId: "fixture-dvn-set" } };
    expect(V9AuthoredNegativeIncidentReviewSchema.safeParse({ ...authored, retired }).success).toBe(true);
    expect(V9IssuerSurfaceIncidentReviewSchema.safeParse({
      ...REVIEW, scope: { kind: "issuer-surface", coveredRoutes: [ROUTE_ETHEREUM] }, retired,
    }).success).toBe(true);
    expect(V9ProviderIncidentReviewSchema.safeParse({ ...PROVIDER_REVIEW, retired }).success).toBe(true);
  });

  it("rejects retirement before the review or with extra fields", () => {
    for (const malformed of [
      { ...retired, reviewedAt: "2026-10-07T13:00:00Z" },
      { ...retired, controlKey: "mint-meta:fixture-asset:x" },
    ]) {
      expect(V9RetirableNegativeIncidentReviewSchema.safeParse({ ...REVIEW, retired: malformed }).success).toBe(false);
    }
  });
});

describe("asset-wide issuer-surface review", () => {
  it("admits a dated asset-wide issuer surface naming its lanes", () => {
    const scope = { kind: "issuer-surface", coveredRoutes: [ROUTE_BASE, ROUTE_ETHEREUM] };
    const parsed = V9IssuerSurfaceIncidentReviewSchema.parse({ ...REVIEW, scope });
    expect(parsed.scope.coveredRoutes).toEqual([ROUTE_BASE, ROUTE_ETHEREUM]);
    expect(parsed.scope).not.toHaveProperty("coveredControls");
    for (const malformed of [
      { kind: "issuer-surface", coveredRoutes: [] },
      { kind: "issuer-surface", coveredRoutes: ["asset:fixture-asset"] },
      { kind: "issuer-surface", coveredRoutes: [ROUTE_ETHEREUM], coveredControls: ["fixture-dvn-set"] },
      { kind: "issuer-surface", coveredRoutes: [ROUTE_ETHEREUM, ROUTE_ETHEREUM] },
      { kind: "control", routeId: ROUTE_ETHEREUM, controlId: "fixture-dvn-set" },
    ]) {
      expect(V9IssuerSurfaceIncidentReviewSchema.safeParse({ ...REVIEW, scope: malformed }).success, JSON.stringify(malformed)).toBe(false);
    }
  });
});

describe("provider-wide incident review admission (M-6)", () => {
  it("admits one provider record without an asset id that names its covered lanes", () => {
    const parsed = V9ProviderIncidentReviewSchema.parse(PROVIDER_REVIEW);
    expect(parsed.scope.coveredRoutes).toEqual([
      { assetId: ASSET, routeId: ROUTE_BASE },
      { assetId: ASSET, routeId: ROUTE_ETHEREUM },
    ]);
    expect(parsed.providerIncidents).toEqual([]);
    expect(parsed).not.toHaveProperty("assetId");
    expect(parsed).not.toHaveProperty("laneScreeningRefs");
  });

  it("rejects a per-asset assetId on the provider record", () => {
    expect(V9ProviderIncidentReviewSchema.safeParse({ ...PROVIDER_REVIEW, assetId: ASSET }).success).toBe(false);
  });

  it("requires the provider incident search and rejects the removed coverage shapes", () => {
    const { providerIncidents: _incidents, ...withoutIncidents } = PROVIDER_REVIEW;
    expect(V9ProviderIncidentReviewSchema.safeParse(withoutIncidents).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW,
      laneScreeningRefs: [{ assetId: ASSET, routeId: ROUTE_BASE, certificateId: CERTIFICATE_ID_BASE }],
    }).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW,
      scope: { ...PROVIDER_REVIEW.scope, coveredControls: [{ assetId: ASSET, controlId: "fixture-dvn-set" }] },
    }).success).toBe(false);
  });

  it("validates provider keys, surfaces and covered identities against the authored vocabularies", () => {
    for (const scope of [
      { ...PROVIDER_REVIEW.scope, providerKey: "across" },
      { ...PROVIDER_REVIEW.scope, surface: "dvn" },
      { ...PROVIDER_REVIEW.scope, coveredRoutes: [] },
      { ...PROVIDER_REVIEW.scope, coveredRoutes: [PROVIDER_REVIEW.scope.coveredRoutes[1], PROVIDER_REVIEW.scope.coveredRoutes[1]] },
    ]) {
      expect(V9ProviderIncidentReviewSchema.safeParse({ ...PROVIDER_REVIEW, scope }).success, JSON.stringify(scope)).toBe(false);
    }
  });

  it("blocks an unexempted verifier-compromise and admits a lane-level exemption", () => {
    const disclosure = {
      incidentKey: "kelpdao-dvn-2026-04-18",
      class: "verifier-compromise",
      surface: "dvn-set",
      occurredAt: "2026-04-18",
      exposureStartSec: REVIEW.windowStartSec,
      exposureEndSec: REVIEW.windowStartSec + 86_400,
      affectedRoutes: [],
      sourceUrls: ["https://example.com/status"],
      exemptions: [],
    };
    expect(V9ProviderIncidentReviewSchema.safeParse({ ...PROVIDER_REVIEW, providerIncidents: [disclosure] }).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW,
      providerIncidents: [{
        ...disclosure,
        exemptions: PROVIDER_REVIEW.scope.coveredRoutes.map((route) => ({
          ...route, kind: "deployed-after-exposure",
          creationTxHash: `0x${"1".repeat(64)}`, creationBlock: 300,
          creationTimestampSec: REVIEW.windowStartSec + 2 * 86_400,
        })),
      }],
    }).success).toBe(true);
    // Only a verifier-compromise may carry exemptions, and a disclosed source must be cited.
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW,
      providerIncidents: [{ ...disclosure, class: "route-local-exploit", exposureEndSec: null,
        exemptions: [{ assetId: ASSET, routeId: ROUTE_BASE, kind: "deployed-after-exposure",
          creationTxHash: `0x${"1".repeat(64)}`, creationBlock: 1, creationTimestampSec: 1 }] }],
    }).success).toBe(false);
    expect(V9ProviderIncidentReviewSchema.safeParse({
      ...PROVIDER_REVIEW,
      providerIncidents: [{ ...disclosure, sourceUrls: ["https://example.com/other"] }],
    }).success).toBe(false);
  });

  it("validates exposure-time deployment and threshold proofs", () => {
    const exemption = {
      assetId: ASSET, routeId: ROUTE_ETHEREUM, kind: "threshold-excludes-compromised-verifier",
      chain: "ethereum", blockNumber: 100, blockTimestampSec: 1500,
      receiveLibrary: EMITTER_ADDRESS,
      eids: [{ eid: 1, requiredDVNs: [OTHER_EMITTER_ADDRESS], optionalDVNs: [], optionalThreshold: 0 }],
      configChangeLogSourceUrl: "https://example.com/logs",
    };
    const incident = {
      incidentKey: "fixture-compromise", class: "verifier-compromise", surface: "dvn-set",
      occurredAt: "2026-04-18", exposureStartSec: 1000, exposureEndSec: 2000,
      compromisedVerifiers: [{ chain: "ethereum", address: EMITTER_ADDRESS }],
      affectedRoutes: [], sourceUrls: ["https://example.com/logs"], exemptions: [exemption],
    };
    expect(V9ProviderIncidentDisclosureSchema.safeParse(incident).success).toBe(true);
    const deployed = {
      assetId: ASSET, routeId: ROUTE_ETHEREUM, kind: "deployed-after-exposure",
      creationTxHash: `0x${"1".repeat(64)}`, creationBlock: 300, creationTimestampSec: 2001,
    };
    expect(V9ProviderIncidentDisclosureSchema.safeParse({ ...incident, exemptions: [deployed] }).success).toBe(true);
    for (const invalid of [
      { exemptions: [{ ...deployed, creationTimestampSec: 999 }] },
      { exemptions: [{ ...deployed, creationTimestampSec: 2000 }] },
      { exposureEndSec: null, exemptions: [deployed] },
      { exemptions: [{ ...exemption, blockTimestampSec: 999 }] },
      { exemptions: [{ ...exemption, blockTimestampSec: 2001 }] },
      { exemptions: [{ ...exemption, chain: "base" }] },
      { compromisedVerifiers: undefined },
      { exemptions: [{ ...exemption, eids: [{ eid: 1, requiredDVNs: [EMITTER_ADDRESS], optionalDVNs: [], optionalThreshold: 0 }] }] },
      { exemptions: [{ ...exemption, eids: [{ ...exemption.eids[0], optionalThreshold: 1 }] }] },
    ]) {
      expect(V9ProviderIncidentDisclosureSchema.safeParse({ ...incident, ...invalid }).success, JSON.stringify(invalid)).toBe(false);
    }
  });
});

describe("lane incident certificate admission (M-7, S-11)", () => {
  it("names emitted events, not setter functions, and derives the evidence class", () => {
    expect(V9_INCIDENT_REVIEW_SURFACE_KIND_VALUES).toContain(V9_LANE_SCREENING_EVIDENCE_CLASS);
    expect(V9_LANE_ADMIN_EVENT_FAMILY_VALUES).toEqual(expect.arrayContaining([
      "PeerSet", "DelegateSet", "DynamicConfigSet", "RateLimitConfigured", "RateLimitsChanged",
      "EnforcedOptionSet", "MsgInspectorSet", "PreCrimeSet", "UlnConfigSet", "ExecutorConfigSet",
    ]));
    for (const stale of ["SetPeer", "SetDelegate", "SetConfig", "SetRateLimit", "RateLimitChanged"]) {
      expect(V9_LANE_ADMIN_EVENT_FAMILY_VALUES).not.toContain(stale);
    }
  });

  it("admits clean and material pinned-window certificates", () => {
    expect(V9LaneIncidentCertificateSchema.parse(CERTIFICATE)).toEqual(CERTIFICATE);
    expect(V9LaneIncidentCertificateSchema.safeParse(MATERIAL_CERTIFICATE).success).toBe(true);
  });

  it("keeps findings, counts, emitters, events and the pinned window consistent", () => {
    for (const malformed of [
      { ...CERTIFICATE, finding: "material-event" },
      { ...MATERIAL_CERTIFICATE, finding: "no-material-admin-event" },
      { ...MATERIAL_CERTIFICATE, eventCounts: { ExecutorConfigSet: 0, UlnConfigSet: 0 } },
      { ...MATERIAL_CERTIFICATE, materialEvents: [{ ...MATERIAL_CERTIFICATE.materialEvents[0], blockNumber: 201 }] },
      { ...MATERIAL_CERTIFICATE, materialEvents: [{ ...MATERIAL_CERTIFICATE.materialEvents[0], family: "PeerSet" }] },
      { ...MATERIAL_CERTIFICATE, materialEvents: [{ ...MATERIAL_CERTIFICATE.materialEvents[0], address: OTHER_EMITTER_ADDRESS }] },
      { ...CERTIFICATE, eventCounts: { ExecutorConfigSet: 0 } },
      { ...CERTIFICATE, eventCounts: { ExecutorConfigSet: 0, UlnConfigSet: 0, PeerSet: 0 } },
      { ...CERTIFICATE, emitters: [{ ...EMITTER, families: ["EnforcedOptionSet"] }] },
      { ...CERTIFICATE, emitters: [{ ...EMITTER, runtimeCodeSha256: "e".repeat(64) }] },
      { ...CERTIFICATE, emitters: [EMITTER, EMITTER] },
      { ...CERTIFICATE, screenedTopics: [{ ...CERTIFICATE.screenedTopics[0], signature: "SomethingElse(address)" }] },
      { ...CERTIFICATE, screenedTopics: [{ family: "UlnConfigSet", topic0: `0X${"f".repeat(64)}`, signature: "UlnConfigSet(address)" }] },
      { ...CERTIFICATE, toBlock: 99 },
      { ...CERTIFICATE, observedAtSec: 1_699_999_999 },
      { ...CERTIFICATE, windowEndSec: 1_699_999_999 },
      { ...CERTIFICATE, logDigest: "C".repeat(64) },
    ]) {
      expect(V9LaneIncidentCertificateSchema.safeParse(malformed).success).toBe(false);
    }
    const { toBlockHash: _hash, ...withoutBlockHash } = CERTIFICATE;
    expect(V9LaneIncidentCertificateSchema.safeParse(withoutBlockHash).success).toBe(false);
  });

  it("reports a failed read as a reasoned result rather than a certificate", () => {
    for (const failureReason of ["pruned-range", "malformed-read", "read-budget-exhausted"]) {
      const failed = { outcome: "failed", deploymentKey: "ethereum:0xabcdef", failureReason, observedAtSec: 1_700_200_000 };
      expect(V9LaneIncidentScreeningResultSchema.parse(failed)).toEqual(failed);
    }
    const failed = { outcome: "failed", deploymentKey: "ethereum:0xabcdef", failureReason: "pruned-range", observedAtSec: 1_700_200_000 };
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

  it("rejects issuer-operated routes with third-party authorities", () => {
    const route = {
      id: ROUTE_ETHEREUM, destinationChain: "ethereum", contractAddress: ROUTE_ETHEREUM.split(":")[1],
      protocol: "Fixture issuer", issuanceModel: "native-issuance", routeClass: "native",
      riskTier: "single-chain-or-native", semantics: "native-mint", scope: "canonical",
      reviewDisposition: "reviewed", observedAt: "2026-10-01",
      sources: [{ label: "Issuer", url: "https://example.com/issuer" }], rail: "issuer-operated",
    };
    expect(BridgeRouteRiskProfileSchema.safeParse({ ...PROFILE, routes: [route] }).success).toBe(true);
    for (const conflict of [{ providerKeys: ["layerzero"] }, { routeClass: "third-party" }]) {
      const result = BridgeRouteRiskProfileSchema.safeParse({ ...PROFILE, routes: [{ ...route, ...conflict }] });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ["routes", 0, "rail"] }));
    }
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

describe("incident coverage closure (M-8)", () => {
  it("requires every derived witness and no authored certificate reference", () => {
    expect(V9IncidentCoverageSchema.safeParse(CLOSURE_WITNESSES).success).toBe(true);
    // An issuer-operated rail has no provider review, so the list may be empty.
    expect(V9IncidentCoverageSchema.safeParse({ ...CLOSURE_WITNESSES, providerReviewIds: [] }).success).toBe(true);
    for (const malformed of [
      { ...CLOSURE_WITNESSES, providerReviewIds: undefined },
      { ...CLOSURE_WITNESSES, issuerSurfaceReviewId: undefined },
      { ...CLOSURE_WITNESSES, screeningSetId: undefined },
      { ...CLOSURE_WITNESSES, certificateId: undefined },
      { ...CLOSURE_WITNESSES, contributorControlIds: undefined },
      { ...CLOSURE_WITNESSES, contributorControlIds: [] },
      { ...CLOSURE_WITNESSES, certificateRefs: [{ controlId: "fixture-dvn-set", certificateId: CERTIFICATE_ID }] },
      { ...CLOSURE_WITNESSES, source: "control" },
    ]) {
      expect(V9IncidentCoverageSchema.safeParse(malformed).success, JSON.stringify(malformed)).toBe(false);
    }
  });

  it("keeps coverage omitted when absent so current control facts stay byte-identical", () => {
    const parsed = V9DeploymentControlFactBaseSchema.parse(CONTROL_FACT);
    expect(parsed).not.toHaveProperty("incidentCoverage");
    expect(JSON.stringify(parsed)).not.toContain("incidentCoverage");
  });

  it("binds exactly the fact's authored contributors", () => {
    const valid = (authored: Record<string, unknown>, contributors: readonly string[]) =>
      V9DeploymentControlFactV2Schema.safeParse({
        ...CONTROL_FACT_V2, ...authored, incidentCoverage: { ...CLOSURE_WITNESSES, contributorControlIds: contributors },
      }).success;
    expect(valid({ authoredControlId: "fixture-one" }, ["fixture-one"])).toBe(true);
    expect(valid({ authoredControlId: "fixture-one" }, ["fixture-dvn-set"])).toBe(false);
    expect(valid({ authoredControlId: "*", authoredControlIds: ["fixture-a", "fixture-b"] }, ["fixture-b", "fixture-a"])).toBe(true);
    expect(valid({ authoredControlId: "*", authoredControlIds: ["fixture-a", "fixture-b"] }, ["fixture-a"])).toBe(false);
    expect(valid({}, ["*"])).toBe(true);
    expect(valid({}, ["fixture-dvn-set"])).toBe(false);
  });
});

describe("authored registry envelope attribution (provider-wide rows)", () => {
  const envelope = {
    schemaVersion: 1,
    incidents: [],
    negativeReviews: [],
    sourceObservations: [],
    searchedSurfaceObservations: [],
  } as const;
  const providerRow = {
    reviewId: "provider-review:layerzero:2026-10-07",
    scope: { kind: "provider", providerKey: "layerzero", surface: "dvn-set", coveredRoutes: [{ assetId: ASSET, routeId: ROUTE_ETHEREUM }] },
    reviewedAt: "2026-10-07T14:00:00Z",
  } as const;

  it("admits a provider-wide row without assetId and rejects one that names an asset", () => {
    expect(V9AuthoredIncidentRegistryEnvelopeSchema.safeParse({ ...envelope, negativeReviews: [providerRow] }).success).toBe(true);
    expect(V9AuthoredIncidentRegistryEnvelopeSchema.safeParse({
      ...envelope, negativeReviews: [{ ...providerRow, assetId: ASSET }],
    }).success).toBe(false);
  });

  it("still requires assetId on asset-scoped rows and leaves the authored registry unchanged", () => {
    for (const scope of [{ kind: "control" }, { kind: "deployment" }, { kind: "issuer-surface" }]) {
      expect(V9AuthoredIncidentRegistryEnvelopeSchema.safeParse({
        ...envelope, negativeReviews: [{ reviewId: "fixture-row", scope }],
      }).success).toBe(false);
      expect(V9AuthoredIncidentRegistryEnvelopeSchema.safeParse({
        ...envelope, negativeReviews: [{ reviewId: "fixture-row", assetId: ASSET, scope }],
      }).success).toBe(true);
    }
    expect(V9AuthoredIncidentRegistryEnvelopeSchema.safeParse(incidentReviewsAsset).success).toBe(true);
  });
});
