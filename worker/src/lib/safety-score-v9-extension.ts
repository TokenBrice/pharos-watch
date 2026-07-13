import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { diagnoseDependencyGraph, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  BlacklistabilityReview,
  BridgeRouteDeployment,
  BridgeRouteRiskProfile,
  DependencyReview,
  DependencyWeight,
  MintAuthorityControl,
  MintAuthorityProfile,
  OracleRiskBranch,
  OracleRiskProfile,
  StablecoinLink,
  StablecoinMeta,
} from "@shared/types/core";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import type { ReserveSlice } from "@shared/types/reserves";
import type { SafetyScoreV9FactSetExtensionV2 } from "./safety-score-v9-fact-set";
import { buildSafetyScoreV9ReserveClassifications } from "./safety-score-v9-extension-reserves";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";

export type V9ExtensionRegistryMeta = Pick<
  StablecoinMeta,
  | "id"
  | "variantOf"
  | "archetypeOverride"
  | "mechanismArchetype"
  | "implementationLaunchDate"
  | "launchDate"
  | "reserves"
  | "dependencies"
  | "dependencyReview"
  | "mintAuthority"
  | "oracleRisk"
  | "bridgeRouteRisk"
  | "blacklistabilityReview"
>;

export interface BuildSafetyScoreV9BaselineExtensionOptions {
  metaById?: ReadonlyMap<string, V9ExtensionRegistryMeta>;
  registryFingerprint?: string;
}

interface PreparedDependency {
  dependency: NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]>;
  graphEdges: DependencyGraphEdge[];
  issueCodes: string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type ResearchEvidence = ExtensionAsset["researchEvidence"][number];
type ComponentEvidence = ExtensionAsset["componentEvidence"][number];
type ControlOverlay = NonNullable<
  Extract<NonNullable<ExtensionAsset["controlReview"]>, { state: "partially-reviewed-controls" }>
>["controls"][number];

function digest(domain: string, payload: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}

function isoDateStartSec(value: string, clockSec: number, label: string): number {
  const timestampMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestampMs)) throw new Error(`Safety Score v9 ${label} has an invalid review date`);
  const timestampSec = Math.floor(timestampMs / 1_000);
  if (timestampSec > clockSec) throw new Error(`Safety Score v9 ${label} review is later than the scoring clock`);
  return timestampSec;
}

function confidenceForResearch(
  value: "verified" | "probable" | "manual-review" | "limited" | "unknown" | undefined,
): ResearchEvidence["confidence"] {
  return value ?? "manual-review";
}

class ReviewEvidenceBuilder {
  readonly evidence = new Map<string, ResearchEvidence>();
  readonly bindings = new Map<string, Set<string>>();

  constructor(
    private readonly assetId: string,
    private readonly clockSec: number,
  ) {}

  add(args: {
    componentKeys: readonly string[];
    sourceId: string;
    reviewedAt: string;
    confidence?: ResearchEvidence["confidence"];
    sources?: readonly StablecoinLink[];
    payload: unknown;
    maxAgeSec?: number | null;
  }): string[] {
    const observedAtSec = isoDateStartSec(args.reviewedAt, this.clockSec, `${this.assetId}:${args.sourceId}`);
    const sources = args.sources?.length
      ? [...args.sources].sort(
          (left, right) => compareText(left.url, right.url) || compareText(left.label, right.label),
        )
      : [null];
    const evidenceKeys = sources.map((source, index) => {
      const contentSha256 = digest("safety-score-v9.reviewed-metadata-evidence.v1", {
        assetId: this.assetId,
        sourceId: args.sourceId,
        reviewedAt: args.reviewedAt,
        confidence: args.confidence ?? "manual-review",
        source,
        payload: args.payload,
      });
      const evidenceKey = `${args.sourceId}:${index}:${contentSha256.slice(0, 16)}`;
      this.evidence.set(evidenceKey, {
        evidenceKey,
        sourceId: args.sourceId,
        observedAtSec,
        publishedAtSec: null,
        url: source?.url ?? null,
        contentSha256,
        confidence: args.confidence ?? "manual-review",
        maxAgeSec: args.maxAgeSec ?? null,
      });
      return evidenceKey;
    });
    for (const componentKey of args.componentKeys) {
      const binding = this.bindings.get(componentKey) ?? new Set<string>();
      for (const evidenceKey of evidenceKeys) binding.add(evidenceKey);
      this.bindings.set(componentKey, binding);
    }
    return evidenceKeys;
  }

  finish(): { researchEvidence: ResearchEvidence[]; componentEvidence: ComponentEvidence[] } {
    return {
      researchEvidence: [...this.evidence.values()].sort((left, right) =>
        compareText(left.evidenceKey, right.evidenceKey),
      ),
      componentEvidence: [...this.bindings.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([componentKey, evidenceKeys]) => ({
          componentKey,
          evidenceKeys: [...evidenceKeys].sort(compareText),
        })),
    };
  }
}

function requiredStatus(
  policyRuleId: string,
  observationState: V9FactStatusV2["observationState"],
  componentKey: string,
  evidenceKeys: readonly string[] = [],
): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId, rationale: null, gapId: null },
    observationState,
    evidenceRefIds:
      observationState === "known" || observationState === "stale" || observationState === "bounded-unknown"
        ? [...evidenceKeys]
        : [],
    gapIds: observationState === "known" ? [] : [`extension-gap:${componentKey}`],
  };
}

function notApplicableStatus(policyRuleId: string, rationale: string, evidenceKeys: readonly string[]): V9FactStatusV2 {
  return {
    applicability: { state: "not-applicable", policyRuleId, rationale, gapId: null },
    observationState: "known",
    evidenceRefIds: [...evidenceKeys],
    gapIds: [],
  };
}

function reviewedObservationState(confidence: ResearchEvidence["confidence"]): "known" | "bounded-unknown" | "missing" {
  if (confidence === "verified" || confidence === "probable" || confidence === "manual-review") return "known";
  return confidence === "limited" ? "bounded-unknown" : "missing";
}

function canonicalAuthorityType(control: MintAuthorityControl): ControlOverlay["authority"] {
  const authorityKey = control.address
    ? `${control.chain ?? "chain-unresolved"}:${control.address.toLowerCase()}`
    : (control.failureDomainKeys?.[0] ?? null);
  if (authorityKey === null) return null;
  const model: NonNullable<ControlOverlay["authority"]>["model"] = (() => {
    if (control.authorityType === "safe" || control.authorityType === "multisig") return "multisig";
    if (control.authorityType === "eoa") return "eoa";
    if (control.authorityType === "dao-governor") return "governance";
    if (control.authorityType === "issuer-backend") return "issuer-backend";
    if (control.authorityType === "contract" || control.authorityType === "timelock") return "contract";
    if (control.authorityType === "none") return "none";
    return "unknown";
  })();
  const threshold =
    model === "multisig" && control.threshold != null && control.signerCount != null
      ? { required: control.threshold, total: control.signerCount }
      : null;
  return { authorityKey, model, threshold };
}

function mintControlKind(control: MintAuthorityControl): ControlOverlay["controlKind"] {
  if (control.directMintAbility === "upgrade-only" || control.role === "proxy-admin") return "upgrade";
  if (control.role === "bridge-admin" || control.authorityType === "bridge") return "bridge";
  if (control.role === "governor" || control.role === "timelock") return "governance";
  if (control.role === "custodian") return "custody";
  return "mint";
}

function mintCapabilities(control: MintAuthorityControl): ControlOverlay["capabilities"] {
  const capabilities = new Set<ControlOverlay["capabilities"][number]>();
  if (["direct", "cap-limited", "can-authorize"].includes(control.directMintAbility)) capabilities.add("mint");
  if (control.directMintAbility === "upgrade-only") capabilities.add("upgrade");
  if (control.directMintAbility === "parameter-only") capabilities.add("parameter-change");
  if (control.role === "bridge-admin" || control.authorityType === "bridge") capabilities.add("bridge-mint");
  return [...capabilities].sort(compareText);
}

function controlFailureDomains(
  assetId: string,
  control: MintAuthorityControl,
  controlKind: ControlOverlay["controlKind"],
): ControlOverlay["failureDomains"] {
  const kind =
    controlKind === "upgrade" ? "upgrade-control" : controlKind === "bridge" ? "bridge-route" : "mint-control";
  const exactKeys = control.failureDomainKeys?.length
    ? control.failureDomainKeys
    : control.address
      ? [`${control.chain ?? "chain-unresolved"}:${control.address.toLowerCase()}`]
      : [];
  return [...new Set(exactKeys)].sort(compareText).map((key) => ({ kind, key: key || `asset:${assetId}` }));
}

function adaptMintControl(
  assetId: string,
  control: MintAuthorityControl,
  index: number,
  incidents: MintAuthorityProfile["mintIncidents"],
): ControlOverlay {
  const controlKind = mintControlKind(control);
  const capabilities = mintCapabilities(control);
  const hasMint = capabilities.includes("mint");
  const capSemantics: ControlOverlay["capSemantics"] = (() => {
    if (!hasMint) return { kind: "not-applicable", bound: null };
    if (control.canRaiseCap === true) return { kind: "raiseable", bound: null };
    if (control.directMintAbility === "direct" || control.directMintAbility === "can-authorize") {
      return { kind: "unbounded", bound: null };
    }
    return { kind: "unknown", bound: null };
  })();
  const claimImpairment: ControlOverlay["claimImpairment"] = hasMint
    ? control.directMintAbility === "cap-limited"
      ? "bounded"
      : "unbounded"
    : capabilities.length === 0
      ? "none"
      : "unknown";
  const economicLossScope: ControlOverlay["economicLossScope"] = hasMint
    ? "global-claim"
    : capabilities.length === 0
      ? "access-only"
      : "unknown";
  const incidentState: ControlOverlay["incidentState"] = incidents?.some((incident) => incident.status === "active")
    ? "active"
    : incidents?.some((incident) => incident.status === "resolved")
      ? "resolved"
      : "unknown";
  const controlKey = `mint-meta:${assetId}:${index}:${digest("safety-score-v9.mint-control-key.v1", {
    chain: control.chain ?? null,
    address: control.address?.toLowerCase() ?? null,
    label: control.label,
    role: control.role,
  }).slice(0, 20)}`;
  return {
    controlKey,
    deploymentKey: `asset:${assetId}`,
    controlKind,
    scope: "global",
    capabilities,
    capSemantics,
    claimImpairment,
    economicLossScope,
    authority: canonicalAuthorityType(control),
    delaySec: control.timelockDelaySec ?? null,
    materialSupplyShare: null,
    incidentState,
    failureDomains: controlFailureDomains(assetId, control, controlKind),
  };
}

function boundedObservedAt(value: number | null | undefined, clockSec: number): number {
  if (value == null || !Number.isFinite(value)) return clockSec;
  return Math.max(0, Math.min(clockSec, Math.floor(value)));
}

function maximumObservedAt(values: readonly (number | null | undefined)[], fallback: number, clockSec: number): number {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  return boundedObservedAt(finite.length > 0 ? Math.max(...finite) : fallback, clockSec);
}

function conservativeDateEndSec(value: string | undefined, clockSec: number): number | null {
  if (!value) return null;
  let timestampMs: number;
  if (/^\d{4}$/.test(value)) {
    timestampMs = Date.UTC(Number(value), 11, 31, 23, 59, 59);
  } else if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    timestampMs = Date.UTC(year!, month!, 0, 23, 59, 59);
  } else {
    timestampMs = Date.parse(value);
  }
  if (!Number.isFinite(timestampMs)) return null;
  const timestampSec = Math.floor(timestampMs / 1_000);
  return timestampSec <= clockSec ? timestampSec : null;
}

function dependencyFailureDomains(dependency: DependencyWeight) {
  const dependencyType = dependency.type ?? "collateral";
  return [
    dependencyType === "collateral"
      ? { kind: "reserve-issuer" as const, key: `asset:${dependency.id}` }
      : { kind: "mint-control" as const, key: `asset:${dependency.id}` },
  ];
}

function collateralExposureMappingIssues(
  edges: Readonly<NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]>["edges"]>,
  liveReserveSlices: readonly ReserveSlice[] | undefined,
): string[] {
  const mappedWeightByUpstream = new Map<string, number>();
  for (const slice of liveReserveSlices ?? []) {
    if (!slice.coinId || (slice.depType ?? "collateral") !== "collateral") continue;
    mappedWeightByUpstream.set(slice.coinId, (mappedWeightByUpstream.get(slice.coinId) ?? 0) + slice.pct / 100);
  }
  return edges.flatMap((edge) => {
    if (edge.dependencyType !== "collateral") return [];
    const mappedWeight = mappedWeightByUpstream.get(edge.upstreamAssetId);
    if (mappedWeight === undefined) return [`collateral-edge-exposure-unmapped:${edge.upstreamAssetId}`];
    if (Math.abs(mappedWeight - edge.weight) > 0.000001) {
      return [`collateral-edge-exposure-weight-mismatch:${edge.upstreamAssetId}`];
    }
    return [];
  });
}

function prepareDependency(
  meta: V9ExtensionRegistryMeta,
  liveReserveSlices: readonly ReserveSlice[] | undefined,
  activeIds: ReadonlySet<string>,
): PreparedDependency {
  const derived = deriveEffectiveDependencySet(meta, {
    ...(liveReserveSlices ? { liveReserveSlices } : {}),
  });
  const issueCodes: string[] = [];
  const edges = derived.dependencies.flatMap((dependency) => {
    const dependencyType = dependency.type ?? "collateral";
    if (!activeIds.has(dependency.id)) {
      issueCodes.push(`outside-active-set:${dependency.id}`);
      return [];
    }
    if (dependency.id === meta.id) {
      issueCodes.push("self-dependency");
      return [];
    }
    if ((dependencyType === "wrapper" || dependencyType === "mechanism") && dependency.weight !== 1) {
      issueCodes.push(`invalid-serial-weight:${dependency.id}`);
      return [];
    }
    return [
      {
        upstreamAssetId: dependency.id,
        dependencyType,
        weight: dependency.weight,
        failureDomains: dependencyFailureDomains(dependency),
      },
    ];
  });
  const collateralWeight = edges
    .filter((edge) => edge.dependencyType === "collateral")
    .reduce((sum, edge) => sum + edge.weight, 0);
  const validEdges = collateralWeight <= 1.000001 ? edges : [];
  if (collateralWeight > 1.000001) issueCodes.push("collateral-weight-exceeds-one");
  issueCodes.push(...collateralExposureMappingIssues(validEdges, liveReserveSlices));
  if (derived.source === "live-unmapped") issueCodes.push("live-reserve-unmapped");
  if (derived.source === "manual") {
    const review = meta.dependencyReview;
    if (!review) {
      issueCodes.push("dependency-review-missing");
    } else {
      const expected = derived.dependencies
        .map((dependency) => ({
          id: dependency.id,
          type: dependency.type ?? "collateral",
          weight: dependency.weight,
        }))
        .sort((left, right) => compareText(`${left.type}:${left.id}`, `${right.type}:${right.id}`));
      const reviewed = review.relationships
        .map((relationship) => ({
          id: relationship.id,
          type: relationship.type,
          weight: relationship.weight,
        }))
        .sort((left, right) => compareText(`${left.type}:${left.id}`, `${right.type}:${right.id}`));
      if (stableJsonStringifyV1(expected) !== stableJsonStringifyV1(reviewed)) {
        issueCodes.push("dependency-review-mismatch");
      }
      if (review.confidence === "unknown") {
        issueCodes.push(`dependency-review-confidence:${review.confidence}`);
      }
    }
  }
  const dependencyReviewUnresolved = issueCodes.some(
    (code) => code.startsWith("dependency-review-") || code.startsWith("collateral-edge-exposure-"),
  );
  return {
    dependency: {
      source: derived.source,
      baseSource: derived.baseSource,
      dependencyFromLive: derived.dependencyFromLive,
      mappedLiveReserveWeight: derived.mappedLiveReserveWeight,
      fallbackReason: derived.fallbackReason,
      edges: validEdges,
      diagnostics: {
        graphState:
          issueCodes.includes("live-reserve-unmapped") || dependencyReviewUnresolved
            ? "unresolved"
            : issueCodes.length > 0
              ? "invalid"
              : "valid",
        issueCodes: [...new Set(issueCodes)].sort(compareText),
        sccMemberAssetIds: [],
      },
    },
    graphEdges: validEdges.map((edge) => ({
      from: edge.upstreamAssetId,
      to: meta.id,
      weight: edge.weight,
      type: edge.dependencyType,
    })),
    issueCodes,
  };
}

function addDependencyEvidence(meta: V9ExtensionRegistryMeta, evidence: ReviewEvidenceBuilder): void {
  const review: DependencyReview | undefined = meta.dependencyReview;
  if (!review) return;
  evidence.add({
    componentKeys: ["dependencies"],
    sourceId: "stablecoin-meta.dependency-review",
    reviewedAt: review.reviewedAt,
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: review,
  });
}

function adaptAccessReview(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
  evidence: ReviewEvidenceBuilder,
): ExtensionAsset["accessReview"] {
  const review: BlacklistabilityReview | undefined = meta.blacklistabilityReview;
  if (!review) return null;
  const evidenceKeys = evidence.add({
    componentKeys: ["access:transfer", "access:freeze", `access:freeze:blacklist:${meta.id}`],
    sourceId: "stablecoin-meta.blacklistability-review",
    reviewedAt: review.reviewedAt,
    confidence: "manual-review",
    sources: review.sources,
    payload: review,
  });
  const status = review.reviewedStatus;
  const inheritedFrom = meta.mintAuthority?.inheritedFrom ?? meta.variantOf ?? null;
  const inheritedResolvable = inheritedFrom !== null && metaById.has(inheritedFrom);
  const freezeKnown = status === true || status === false;
  const freezeState = freezeKnown ? "known" : "bounded-unknown";
  const transferKnown = status === true;
  const freezeReview =
    status === "inherited" && !inheritedResolvable
      ? []
      : [
          {
            reviewKey: `blacklist:${meta.id}`,
            source: status === "inherited" ? ("upstream" as const) : ("blacklist" as const),
            status: requiredStatus("v9.access.freeze-review", freezeState, `access-freeze:${meta.id}`, evidenceKeys),
            reach:
              status === false ? ("none" as const) : status === true ? ("individual" as const) : ("possible" as const),
            controlKey: null,
            upstreamAssetId: status === "inherited" ? inheritedFrom : null,
            failureDomains:
              status === "inherited" && inheritedFrom
                ? [{ kind: "mint-control" as const, key: `asset:${inheritedFrom}` }]
                : [],
          },
        ];
  return {
    transfer: {
      status: requiredStatus(
        "v9.access.transfer-review",
        transferKnown ? "known" : status === "possible" || status === "inherited" ? "bounded-unknown" : "missing",
        `access-transfer:${meta.id}`,
        transferKnown || status === "possible" || status === "inherited" ? evidenceKeys : [],
      ),
      posture: transferKnown ? "restrictable" : null,
    },
    freeze: {
      status: requiredStatus(
        "v9.access.freeze-review",
        freezeKnown ? "known" : "bounded-unknown",
        `access-freeze:${meta.id}`,
        evidenceKeys,
      ),
      reviews: freezeReview,
    },
  };
}

const ORACLE_BRANCH_ADAPTERS = [
  ["feed", (branch: OracleRiskBranch) => (branch.feeds?.length ?? 0) > 0 || branch.fallbackBehavior != null],
  ["collateral-parameter", (branch: OracleRiskBranch) => (branch.collateralParameters?.length ?? 0) > 0],
  [
    "liquidation",
    (branch: OracleRiskBranch) => branch.liquidationMechanism != null || branch.liquidationDelaySec != null,
  ],
  ["backstop", (branch: OracleRiskBranch) => branch.backstop != null],
  ["shutdown-bad-debt", (branch: OracleRiskBranch) => branch.shutdownOrBadDebtBehavior != null],
] as const;

function adaptOracleReview(
  meta: V9ExtensionRegistryMeta,
  evidence: ReviewEvidenceBuilder,
): NonNullable<ExtensionAsset["economicControlReview"]>["oracle"] {
  const profile: OracleRiskProfile | undefined = meta.oracleRisk;
  if (!profile?.reviewedAt || !profile.reviewer || !profile.confidence) {
    return {
      status: requiredStatus("v9.control.oracle-review", "missing", `oracle:${meta.id}`),
      tier: null,
      branches: [],
    };
  }
  const confidence = confidenceForResearch(profile.confidence);
  const componentKeys = [
    "economic-control:oracle",
    ...ORACLE_BRANCH_ADAPTERS.map(([branch]) => `economic-control:oracle:${branch}`),
  ];
  const evidenceKeys = evidence.add({
    componentKeys,
    sourceId: "stablecoin-meta.oracle-risk",
    reviewedAt: profile.reviewedAt,
    confidence,
    sources: profile.sources,
    payload: profile,
  });
  if (profile.branchApplicability?.disposition === "not-applicable") {
    return {
      status: notApplicableStatus("v9.control.oracle-review", profile.branchApplicability.rationale, evidenceKeys),
      tier: null,
      branches: [],
    };
  }
  const topState =
    profile.branchApplicability?.disposition === "branches-required"
      ? reviewedObservationState(confidence)
      : "bounded-unknown";
  const branches =
    profile.branchApplicability?.disposition === "branches-required" && profile.branches?.length
      ? ORACLE_BRANCH_ADAPTERS.map(([branchKind, predicate]) => {
          const complete = profile.branches!.every(predicate);
          const state = complete ? reviewedObservationState(confidence) : "missing";
          return {
            branch: branchKind,
            status: requiredStatus(
              "v9.control.oracle-review",
              state,
              `oracle:${meta.id}:${branchKind}`,
              state === "known" || state === "bounded-unknown" ? evidenceKeys : [],
            ),
            controlKey: null,
            mechanismKey: complete
              ? `oracle-mechanism:${meta.id}:${branchKind}:${digest("safety-score-v9.oracle-branch.v1", {
                  branchKind,
                  branches: profile.branches,
                }).slice(0, 16)}`
              : null,
            inheritedFromAssetId: null,
          };
        })
      : [];
  return {
    status: requiredStatus(
      "v9.control.oracle-review",
      topState,
      `oracle:${meta.id}`,
      topState === "known" || topState === "bounded-unknown" ? evidenceKeys : [],
    ),
    tier: topState === "missing" ? null : profile.tier,
    branches,
  };
}

function bridgeControl(assetId: string, route: BridgeRouteDeployment): ControlOverlay | null {
  if (route.routeClass === "native" || route.issuanceModel === "native-issuance") return null;
  const capabilities: ControlOverlay["capabilities"] =
    route.issuanceModel === "bridge-representation" || route.issuanceModel === "wrapped-representation"
      ? ["bridge-mint"]
      : [];
  const authorityKey = route.controllerAddress
    ? `${route.controllerChain}:${route.controllerAddress.toLowerCase()}`
    : null;
  return {
    controlKey: `bridge-meta:${assetId}:${digest("safety-score-v9.bridge-control-key.v1", route.id).slice(0, 20)}`,
    deploymentKey: route.id,
    controlKind: "bridge",
    scope: "deployment",
    capabilities,
    capSemantics: { kind: "unknown", bound: null },
    claimImpairment: "unknown",
    economicLossScope: "deployment",
    authority: authorityKey ? { authorityKey, model: "unknown", threshold: null } : null,
    delaySec: null,
    materialSupplyShare: null,
    incidentState: "unknown",
    failureDomains: (route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id])
      .map((key) => ({ kind: "bridge-route" as const, key }))
      .sort((left, right) => compareText(left.key, right.key)),
  };
}

function adaptBridgeReview(
  meta: V9ExtensionRegistryMeta,
  evidence: ReviewEvidenceBuilder,
): {
  review: NonNullable<ExtensionAsset["economicControlReview"]>["bridge"];
  controls: ControlOverlay[];
} {
  const profile: BridgeRouteRiskProfile | undefined = meta.bridgeRouteRisk;
  if (!profile) {
    return {
      review: {
        status: requiredStatus("v9.control.bridge-review", "missing", `bridge:${meta.id}`),
        routes: [],
      },
      controls: [],
    };
  }
  const confidence = confidenceForResearch(profile.confidence);
  const evidenceKeys = evidence.add({
    componentKeys: ["economic-control:bridge", "control"],
    sourceId: "stablecoin-meta.bridge-route-risk",
    reviewedAt: profile.reviewedAt,
    confidence,
    sources: profile.sources,
    payload: profile,
  });
  const controls = (profile.routes ?? [])
    .filter((route) => route.reviewDisposition === "reviewed")
    .map((route) => bridgeControl(meta.id, route))
    .filter((control): control is ControlOverlay => control !== null);
  const controlsByDeployment = new Map(controls.map((control) => [control.deploymentKey, control]));
  const routes = (profile.routes ?? [])
    .filter((route) => route.reviewDisposition === "reviewed")
    .flatMap((route) => {
      const control = controlsByDeployment.get(route.id);
      return control ? [{ controlKey: control.controlKey, tier: route.riskTier }] : [];
    });
  return {
    review: {
      status: requiredStatus("v9.control.bridge-review", "bounded-unknown", `bridge:${meta.id}`, evidenceKeys),
      routes,
    },
    controls,
  };
}

function adaptMintReview(
  meta: V9ExtensionRegistryMeta,
  evidence: ReviewEvidenceBuilder,
): {
  review: NonNullable<ExtensionAsset["economicControlReview"]>["mint"];
  controls: ControlOverlay[];
} {
  const profile: MintAuthorityProfile | undefined = meta.mintAuthority;
  if (!profile) {
    return {
      review: {
        status: requiredStatus("v9.control.mint-review", "missing", `mint:${meta.id}`),
        controlKey: null,
        reconciliation: "unknown",
        upgrade: { state: "unknown", controlKey: null },
      },
      controls: [],
    };
  }
  const confidence = confidenceForResearch(profile.confidence);
  const evidenceKeys = evidence.add({
    componentKeys: ["economic-control:mint", "control"],
    sourceId: "stablecoin-meta.mint-authority",
    reviewedAt: profile.review.reviewedAt,
    confidence,
    sources: profile.review.sources,
    payload: profile,
  });
  const controls =
    profile.review.disposition === "unresolved"
      ? []
      : (profile.controls ?? []).map((control, index) =>
          adaptMintControl(meta.id, control, index, profile.mintIncidents),
        );
  const mintControl = controls.find((control) => control.capabilities.includes("mint")) ?? null;
  const upgradeability = profile.upgradeability;
  const referencedUpgradeIndex =
    upgradeability?.controlRef == null
      ? -1
      : (profile.controls ?? []).findIndex((control) => control.label === upgradeability.controlRef);
  const referencedUpgrade = referencedUpgradeIndex >= 0 ? (controls[referencedUpgradeIndex] ?? null) : null;
  const upgrade =
    upgradeability?.model === "immutable" && upgradeability.canChangeMintLogic === false
      ? { state: "immutable" as const, controlKey: null }
      : upgradeability?.canChangeMintLogic === true && referencedUpgrade?.capabilities.includes("upgrade")
        ? { state: "reviewed" as const, controlKey: referencedUpgrade.controlKey }
        : { state: "unknown" as const, controlKey: null };
  const state =
    profile.review.disposition === "unresolved"
      ? "missing"
      : reviewedObservationState(confidence) === "missing"
        ? "missing"
        : "bounded-unknown";
  return {
    review: {
      status: requiredStatus(
        "v9.control.mint-review",
        state,
        `mint:${meta.id}`,
        state === "bounded-unknown" ? evidenceKeys : [],
      ),
      controlKey: mintControl?.controlKey ?? null,
      reconciliation: "unknown",
      upgrade,
    },
    controls,
  };
}

/**
 * Builds a conservative baseline overlay from structured, reviewed fields in
 * the exact publication capture or registry. Unreviewed mechanism, exit, and
 * other critical semantics remain explicit gaps. These adapters enrich the
 * shadow fact set; they are not expected to make the current cohort rateable.
 */
export function buildSafetyScoreV9BaselineExtension(
  fixedInputValue: unknown,
  options: BuildSafetyScoreV9BaselineExtensionOptions = {},
): SafetyScoreV9FactSetExtensionV2 {
  return buildSafetyScoreV9BaselineExtensionFromNormalizedInput(normalizeFixedInput(fixedInputValue), options);
}

/**
 * Trusted runtime entrypoint for callers that already paid the strict fixed-
 * input parse cost at their storage boundary.
 */
export function buildSafetyScoreV9BaselineExtensionFromNormalizedInput(
  fixedInput: Readonly<ReportCardsFixedInput>,
  options: BuildSafetyScoreV9BaselineExtensionOptions = {},
): SafetyScoreV9FactSetExtensionV2 {
  const metaById = options.metaById ?? ACTIVE_META_BY_ID;
  const registryFingerprint = options.registryFingerprint ?? computeReportCardsRegistryFingerprint();
  if (registryFingerprint !== fixedInput.registryFingerprint) {
    throw new Error(
      `Safety Score v9 registry fingerprint ${registryFingerprint} does not match fixed input ${fixedInput.registryFingerprint}`,
    );
  }
  const activeIds = new Set(fixedInput.activeAssetIds);
  const preparedById = new Map<string, PreparedDependency>();
  for (const assetId of fixedInput.activeAssetIds) {
    const meta = metaById.get(assetId);
    if (!meta) throw new Error(`Safety Score v9 baseline extension has no registry metadata for ${assetId}`);
    preparedById.set(assetId, prepareDependency(meta, fixedInput.liveReserveMap[assetId], activeIds));
  }
  const graph = diagnoseDependencyGraph([...preparedById.values()].flatMap((prepared) => prepared.graphEdges));
  const cycleByAsset = new Map<string, string[]>();
  for (const component of graph.stronglyConnectedComponents) {
    for (const assetId of component) cycleByAsset.set(assetId, component);
  }

  const clockSec = fixedInput.clockSec;
  const reserveObservedAtSec = maximumObservedAt(
    Object.values(fixedInput.liveReserveProvenanceMap).map((provenance) => provenance?.fetchedAt),
    fixedInput.updatedAt,
    clockSec,
  );
  const pegObservedAtSec = maximumObservedAt(
    Object.values(fixedInput.pegDataById).map((peg) => peg.priceObservedAt),
    fixedInput.updatedAt,
    clockSec,
  );
  const registryObservedAtSec = boundedObservedAt(fixedInput.updatedAt, clockSec);
  const liveReservesGenerationDigest = digest("safety-score-v9.live-reserves.v1", {
    reserves: fixedInput.liveReserveMap,
    provenance: fixedInput.liveReserveProvenanceMap,
  });
  const chainSupplyGenerationDigest = digest("safety-score-v9.chain-supply.v1", {
    chainCirculatingById: fixedInput.chainCirculatingById,
    dexDeploymentSupplyCoverageById: fixedInput.dexDeploymentSupplyCoverageById,
  });
  const pegGenerationDigest = digest("safety-score-v9.peg.v1", {
    pegDataById: fixedInput.pegDataById,
    activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
  });
  const sources = {
    registryObservedAtSec,
    unavailableRedemptionObservedAtSec: boundedObservedAt(
      fixedInput.inputFreshness.redemptionBackstops.updatedAt,
      clockSec,
    ),
    liveReserves: {
      generationId: `live-reserves:v1:${liveReservesGenerationDigest}`,
      observedAtSec: reserveObservedAtSec,
      maxAgeSec: CRON_INTERVALS["sync-live-reserves"] * 2,
    },
    chainSupply: {
      generationId: `chain-supply:v1:${chainSupplyGenerationDigest}`,
      observedAtSec: boundedObservedAt(fixedInput.updatedAt, clockSec),
      maxAgeSec: CRON_INTERVALS["sync-stablecoins"] * 2,
    },
    peg: {
      generationId: `peg:v1:${pegGenerationDigest}`,
      observedAtSec: pegObservedAtSec,
      maxAgeSec: CRON_INTERVALS["sync-stablecoins"] * 2,
    },
    researchOverlays: {
      generationId: `registry:${fixedInput.registryRevision}`,
      observedAtSec: registryObservedAtSec,
      maxAgeSec: null,
    },
  } satisfies SafetyScoreV9FactSetExtensionV2["sources"];

  return {
    schemaVersion: 2,
    registryFingerprint,
    compiledAtSec: clockSec,
    sources,
    routeFreshness: {
      dexMaxAgeSec: CRON_INTERVALS["sync-dex-liquidity"] * 2,
      redemptionMaxAgeSec: CRON_INTERVALS["sync-redemption-backstops"] * 2,
    },
    assets: fixedInput.activeAssetIds.map((assetId) => {
      const meta = metaById.get(assetId)!;
      const prepared = preparedById.get(assetId)!;
      const cycle = cycleByAsset.get(assetId);
      const archetype = resolveMechanismArchetype(meta, metaById) ?? "unresolved";
      const liveReserves = fixedInput.liveReserveMap[assetId] ?? [];
      const reviewEvidence = new ReviewEvidenceBuilder(assetId, clockSec);
      addDependencyEvidence(meta, reviewEvidence);
      const mint = adaptMintReview(meta, reviewEvidence);
      const oracle = adaptOracleReview(meta, reviewEvidence);
      const bridge = adaptBridgeReview(meta, reviewEvidence);
      const controls = [...mint.controls, ...bridge.controls].sort((left, right) =>
        compareText(left.controlKey, right.controlKey),
      );
      const accessReview = adaptAccessReview(meta, metaById, reviewEvidence);
      const reviewedEvidence = reviewEvidence.finish();
      return {
        assetId,
        archetype,
        launchedAtSec: conservativeDateEndSec(meta.implementationLaunchDate ?? meta.launchDate, clockSec),
        mechanismRiskReview: null,
        dependencies: {
          ...prepared.dependency,
          diagnostics: cycle
            ? {
                graphState: "cycle",
                issueCodes: [...new Set([...prepared.issueCodes, "dependency-cycle"])].sort(compareText),
                sccMemberAssetIds: [...cycle].sort(compareText),
              }
            : prepared.dependency.diagnostics,
        },
        reserveApplicability: { state: "required" },
        reserveClassifications: buildSafetyScoreV9ReserveClassifications(liveReserves),
        routeReviews: [],
        retainedRoutes: [],
        controlReview:
          controls.length > 0
            ? {
                state: "partially-reviewed-controls",
                controls,
                rationale:
                  "Reviewed metadata identifies controls, but reconciliation, incident, cap, economic-loss, or materiality semantics remain unresolved.",
              }
            : null,
        economicControlReview:
          meta.mintAuthority || meta.oracleRisk || meta.bridgeRouteRisk
            ? {
                mint: mint.review,
                oracle,
                bridge: bridge.review,
              }
            : null,
        accessReview,
        pegReference: null,
        supplyReview: null,
        ...reviewedEvidence,
      };
    }),
  };
}
