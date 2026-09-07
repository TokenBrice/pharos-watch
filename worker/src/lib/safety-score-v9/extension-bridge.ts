/**
 * Safety Score v9 bridge-review adapter. Extracted verbatim from
 * `safety-score-v9-extension.ts`; no behaviour change.
 */
import { resolveChainId } from "@shared/lib/chains";
import { normalizeDeploymentId } from "@shared/lib/deployment-id";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC, V9_SCOPED_QUESTION_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import type {
  V9BridgeJoinDiagnosticsV1,
  V9BridgeSupplyRouteJoinV1,
  V9FailureDomainRef,
} from "@shared/types/safety-score-v9-facts";
import type { BridgeRouteControl, BridgeRouteDeployment, BridgeRouteRiskProfile } from "@shared/types/core";
import {
  COMMON_MODE_MATERIAL_SHARE_THRESHOLD,
  DEPLOYMENT_MATERIAL_SHARE_THRESHOLD,
  authorityModelForType,
  confidenceForResearch,
  isoDateStartSec,
  notApplicableStatus,
  requiredStatus,
  researchReviewObservationState,
  reviewedObservationState,
  type ControlOverlay,
  type ExtensionAsset,
  type ReviewEvidenceBuilder,
  type V9ExtensionRegistryMeta,
} from "./extension-shared";
import {
  safetyScoreV9RouteSupplyShare,
  V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX,
  V9_REPRESENTATION_GROUP_ROUTE_PREFIX,
  V9_UNMATCHED_CHAIN_ROUTE_PREFIX,
  V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX,
} from "./extension-supply";

function normalizedBridgeDeploymentId(value: string): string {
  const normalized = normalizeDeploymentId(value);
  if (normalized === "") throw new Error(`Safety Score v9 bridge deployment ID is invalid: ${value}`);
  return normalized;
}

function bridgeAuthority(
  control: BridgeRouteControl,
  routeId: string,
): ControlOverlay["authority"] {
  const authorityKey = control.controllerAddress
    ? `${control.controllerChain ?? "chain-unresolved"}:${control.controllerAddress.toLowerCase()}`
    : (control.failureDomainKeys?.[0] ?? `bridge-control:${control.id}:${routeId}`);
  const model = authorityModelForType(control.authorityType);
  const required = control.threshold ?? control.safe?.threshold;
  const total = control.signerCount ?? control.safe?.owners?.length;
  const threshold = model === "multisig" && required != null && total != null ? { required, total } : null;
  return { authorityKey, model, threshold };
}

function bridgeControlCapabilities(control: BridgeRouteControl): ControlOverlay["capabilities"] {
  const capabilities = new Set<ControlOverlay["capabilities"][number]>();
  if (control.capabilities.includes("bridge-mint")) capabilities.add("bridge-mint");
  if (control.capabilities.includes("bridge-burn")) capabilities.add("burn");
  if (control.capabilities.includes("upgrade")) capabilities.add("upgrade");
  if (control.capabilities.includes("pause")) capabilities.add("freeze");
  if (
    control.capabilities.includes("admin") ||
    control.capabilities.includes("rate-limit") ||
    control.capabilities.includes("validator") ||
    control.capabilities.includes("peer-config")
  ) {
    capabilities.add("parameter-change");
  }
  if (control.capabilities.includes("escrow")) capabilities.add("custody-transfer");
  return [...capabilities].sort(compareText);
}

function bridgeCapSemantics(
  control: BridgeRouteControl,
  capabilities: ControlOverlay["capabilities"],
): ControlOverlay["capSemantics"] {
  if (!capabilities.includes("bridge-mint")) return { kind: "not-applicable", bound: null };
  if (control.canRaiseCap === true) return { kind: "raiseable", bound: null };
  if (control.canRaiseCap === false) {
    return { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } };
  }
  if (control.canRaiseCap === "unknown" || control.capDescription !== undefined) {
    return { kind: "unknown", bound: null };
  }
  return { kind: "unbounded", bound: null };
}

function bridgeClaimImpairment(
  capabilities: ControlOverlay["capabilities"],
  capSemantics: ControlOverlay["capSemantics"],
): ControlOverlay["claimImpairment"] {
  if (capabilities.includes("upgrade")) return "unbounded";
  if (capabilities.includes("bridge-mint")) {
    if (capSemantics.kind === "unknown") return "unknown";
    return capSemantics.kind === "bounded" || capSemantics.kind === "raiseable" ? "bounded" : "unbounded";
  }
  if (capabilities.length === 1 && capabilities[0] === "freeze") return "none";
  return "bounded";
}

function bridgeFailureDomains(
  route: BridgeRouteDeployment,
  control?: BridgeRouteControl,
): ControlOverlay["failureDomains"] {
  const keys = control?.failureDomainKeys?.length
    ? control.failureDomainKeys
    : route.failureDomainKeys?.length
      ? route.failureDomainKeys
      : [normalizedBridgeDeploymentId(route.id)];
  return [...new Set(keys)].sort(compareText).map((key) => ({ kind: "bridge-route" as const, key }));
}

function isBridgeRepresentationRoute(route: BridgeRouteDeployment): boolean {
  return route.routeClass !== "native" && route.issuanceModel !== "native-issuance";
}

export interface StructuredBridgeOverlayEntry {
  sourceControl: BridgeRouteControl;
  overlay: ControlOverlay;
}

/**
 * Exported for direct unit coverage: the merge fails closed when covering controls
 * disagree, a state the current public schema cannot yet express through fixtures.
 */
export function mergedBridgeCapSemantics(
  entries: readonly StructuredBridgeOverlayEntry[],
): ControlOverlay["capSemantics"] {
  const kinds = entries.map((entry) => entry.overlay.capSemantics.kind);
  if (kinds.includes("unknown")) {
    // When a route has both reviewed and unresolved structured controls, the
    // unresolved cap cannot make the joined route safer. Treat that join as
    // unbounded so the route remains scoreable and its missing supply share is
    // reported once. A route whose only structured evidence is unresolved
    // remains unknown and keeps its ordinary unresolved-control gap.
    return kinds.some((kind) => kind !== "unknown")
      ? { kind: "unbounded", bound: null }
      : { kind: "unknown", bound: null };
  }
  if (kinds.includes("unbounded")) return { kind: "unbounded", bound: null };
  if (kinds.includes("raiseable")) return { kind: "raiseable", bound: null };
  const bounded = entries.filter((entry) => entry.overlay.capSemantics.kind === "bounded");
  if (bounded.length === 0) return { kind: "not-applicable", bound: null };
  const firstBound = bounded[0]!.overlay.capSemantics.bound;
  if (
    firstBound === null ||
    bounded.some(
      (entry) =>
        entry.overlay.capSemantics.bound === null ||
        entry.overlay.capSemantics.bound.amount !== firstBound.amount ||
        entry.overlay.capSemantics.bound.unit !== firstBound.unit,
    )
  ) {
    return { kind: "unbounded", bound: null };
  }
  return { kind: "bounded", bound: firstBound };
}

/**
 * Weakness ordering for the merged route authority: higher is weaker, and
 * `mergedBridgeAuthority` keeps the weakest contributor. Only the relative order
 * is meaningful — the numbers carry no other semantics.
 *
 * AUTHORITY-LADDER 9.46: `validator-quorum` sits strictly below `issuer-backend`
 * and strictly above `eoa`. That is the adopted owner ruling: an external
 * validator quorum is known-but-weak — no stronger than a named issuer backend,
 * and never stronger than a named multisig — but a rotating quorum that must
 * collude is still a harder failure than one unattested single key.
 */
function bridgeAuthoritySeverity(model: NonNullable<ControlOverlay["authority"]>["model"]): number {
  return {
    none: 0,
    multisig: 1,
    governance: 1,
    contract: 2,
    "issuer-backend": 3,
    "validator-quorum": 4,
    eoa: 5,
    unknown: 6,
  }[model];
}

function compareBridgeAuthorityWeakness(
  left: NonNullable<ControlOverlay["authority"]>,
  right: NonNullable<ControlOverlay["authority"]>,
): number {
  const severity = bridgeAuthoritySeverity(right.model) - bridgeAuthoritySeverity(left.model);
  if (severity !== 0) return severity;
  if (left.model === "multisig" && right.model !== "multisig") return -1;
  if (right.model === "multisig" && left.model !== "multisig") return 1;
  if (left.model === "multisig" && right.model === "multisig") {
    const leftRatio = left.threshold === null ? 0 : left.threshold.required / left.threshold.total;
    const rightRatio = right.threshold === null ? 0 : right.threshold.required / right.threshold.total;
    return leftRatio - rightRatio ||
      (left.threshold?.required ?? 0) - (right.threshold?.required ?? 0) ||
      (left.threshold?.total ?? 0) - (right.threshold?.total ?? 0);
  }
  return compareText(left.authorityKey, right.authorityKey);
}

/**
 * Exported for direct unit coverage: the unattributed-authority fallback cannot be
 * reached through fixtures while every authored control yields an authority.
 */
export function mergedBridgeAuthority(
  entries: readonly StructuredBridgeOverlayEntry[],
  routeId: string,
): ControlOverlay["authority"] {
  const authorities = entries.map((entry) => entry.overlay.authority).filter(
    (authority): authority is NonNullable<ControlOverlay["authority"]> => authority !== null,
  );
  if (authorities.length === 0) {
    return { authorityKey: `bridge-route:${routeId}`, model: "unknown", threshold: null };
  }
  return [...authorities].sort(compareBridgeAuthorityWeakness)[0]!;
}

function mergedBridgeKeyCustody(
  entries: readonly StructuredBridgeOverlayEntry[],
): ControlOverlay["keyCustody"] {
  const values = entries.map((entry) => entry.overlay.keyCustody);
  return values.every((value) => value === values[0]) ? values[0]! : "unknown";
}

function mergedBridgeModulesOrGuards(
  entries: readonly StructuredBridgeOverlayEntry[],
): ControlOverlay["modulesOrGuards"] {
  const values = entries.map((entry) => entry.overlay.modulesOrGuards);
  if (values.includes("present")) return "present";
  return values.every((value) => value === values[0]) ? values[0]! : "unknown";
}

function mergedBridgeIncidentState(
  entries: readonly StructuredBridgeOverlayEntry[],
): ControlOverlay["incidentState"] {
  const values = entries.map((entry) => entry.overlay.incidentState);
  if (values.includes("active")) return "active";
  if (values.includes("unknown")) return "unknown";
  if (values.includes("resolved")) return "resolved";
  return "none";
}

function mergedBridgeFailureDomains(
  entries: readonly StructuredBridgeOverlayEntry[],
): ControlOverlay["failureDomains"] {
  const domains = new Map<string, ControlOverlay["failureDomains"][number]>();
  for (const entry of entries) {
    for (const domain of entry.overlay.failureDomains) {
      domains.set(`${domain.kind}:${domain.key}`, domain);
    }
  }
  return [...domains.values()].sort((left, right) =>
    compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
}

function structuredBridgeRouteControl(
  assetId: string,
  route: BridgeRouteDeployment,
  entries: readonly StructuredBridgeOverlayEntry[],
  materialSupplyShare: number | null,
): ControlOverlay {
  if (entries.length === 0) throw new Error(`Missing structured bridge overlays for ${route.id}`);
  const capabilities = [...new Set(entries.flatMap((entry) => entry.overlay.capabilities))].sort(compareText);
  const capSemantics = mergedBridgeCapSemantics(entries);
  const claimImpairment = bridgeClaimImpairment(capabilities, capSemantics);
  const delays = entries.map((entry) => entry.overlay.delaySec ?? 0);
  const controlIds = entries.map((entry) => entry.sourceControl.id).sort(compareText);
  const deploymentId = normalizedBridgeDeploymentId(route.id);
  const nativeRoute = !isBridgeRepresentationRoute(route);
  return {
    controlKey: `bridge-meta:${assetId}:${domainDigest(
      "safety-score-v9.structured-bridge-route-control-key.v1",
      { controlIds, routeId: deploymentId },
    ).slice(0, 20)}`,
    deploymentKey: deploymentId,
    controlKind: "bridge",
    // Canonical-side bridge controls are retained as global claim facts. They
    // still contribute their capabilities, authority, custody, incident, and
    // failure-domain evidence, but the native liability is not a separate
    // bridge deployment whose missing share should create a materiality gap.
    scope: nativeRoute ? "global" : "deployment",
    capabilities,
    capSemantics,
    claimImpairment,
    economicLossScope:
      claimImpairment === "none"
        ? "access-only"
        : nativeRoute
          ? "global-claim"
          : "deployment",
    authority: mergedBridgeAuthority(entries, deploymentId),
    delaySec: Math.min(...delays),
    materialSupplyShare,
    keyCustody: mergedBridgeKeyCustody(entries),
    modulesOrGuards: mergedBridgeModulesOrGuards(entries),
    incidentState: mergedBridgeIncidentState(entries),
    failureDomains: mergedBridgeFailureDomains(entries),
  };
}

function bridgeControl(
  assetId: string,
  route: BridgeRouteDeployment,
  materialSupplyShare: number | null,
  reviewEvidenceCurrent = true,
): ControlOverlay | null {
  if (!isBridgeRepresentationRoute(route)) return null;
  const deploymentId = normalizedBridgeDeploymentId(route.id);
  const capabilities: ControlOverlay["capabilities"] =
    route.issuanceModel === "bridge-representation" || route.issuanceModel === "wrapped-representation"
      ? ["bridge-mint"]
      : [];
  const authorityKey = route.controllerAddress
    ? `${route.controllerChain}:${route.controllerAddress.toLowerCase()}`
    : (route.failureDomainKeys?.[0] ?? `bridge-route:${deploymentId}`);
  const mintsRepresentation = capabilities.includes("bridge-mint");
  const reviewed = reviewEvidenceCurrent && route.reviewDisposition === "reviewed";
  return {
    controlKey: `bridge-meta:${assetId}:${domainDigest("safety-score-v9.bridge-control-key.v1", deploymentId).slice(0, 20)}`,
    deploymentKey: deploymentId,
    controlKind: "bridge",
    scope: "deployment",
    capabilities,
    capSemantics: !reviewed
      ? { kind: "unknown", bound: null }
      : mintsRepresentation
        ? { kind: "unbounded", bound: null }
        : { kind: "not-applicable", bound: null },
    claimImpairment: !reviewed ? "unknown" : mintsRepresentation ? "unbounded" : "bounded",
    economicLossScope: "deployment",
    authority: { authorityKey, model: route.controllerAddress ? "contract" : "unknown", threshold: null },
    delaySec: null,
    materialSupplyShare,
    // Bridge-route controls carry no reviewed key-custody or Safe-module facts;
    // the mint-authority review owns both vocabularies.
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: reviewed ? "none" : "unknown",
    failureDomains: (route.failureDomainKeys?.length ? route.failureDomainKeys : [deploymentId])
      .map((key) => ({ kind: "bridge-route" as const, key }))
      .sort((left, right) => compareText(left.key, right.key)),
  };
}

function structuredBridgeControl(
  assetId: string,
  route: BridgeRouteDeployment,
  control: BridgeRouteControl,
  materialSupplyShare: number | null,
  reviewEvidenceCurrent: boolean,
): ControlOverlay {
  const deploymentId = normalizedBridgeDeploymentId(route.id);
  const capabilities = bridgeControlCapabilities(control);
  const capSemantics = bridgeCapSemantics(control, capabilities);
  const claimImpairment = bridgeClaimImpairment(capabilities, capSemantics);
  const incidentState: ControlOverlay["incidentState"] =
    reviewEvidenceCurrent && route.reviewDisposition === "reviewed" ? "none" : "unknown";
  return {
    controlKey: `bridge-meta:${assetId}:${domainDigest(
      "safety-score-v9.structured-bridge-control-key.v1",
      { controlId: control.id, routeId: deploymentId },
    ).slice(0, 20)}`,
    deploymentKey: deploymentId,
    controlKind: "bridge",
    scope: "deployment",
    capabilities,
    capSemantics,
    claimImpairment,
    economicLossScope: claimImpairment === "none" ? "access-only" : "deployment",
    authority: bridgeAuthority(control, deploymentId),
    delaySec: control.timelockDelaySec ?? null,
    materialSupplyShare,
    keyCustody: control.keyCustodyAttestation?.kind ?? "unknown",
    modulesOrGuards: control.modulesOrGuardsStatus ?? "unknown",
    incidentState,
    failureDomains: bridgeFailureDomains(route, control),
  };
}

function unmatchedBridgeControl(
  assetId: string,
  route: NonNullable<ExtensionAsset["supplyReview"]>["selectedBridgeRoutes"][number],
): ControlOverlay {
  return {
    controlKey: `bridge-supply:${assetId}:${domainDigest("safety-score-v9.unmatched-bridge-control-key.v1", route.deploymentRouteKey).slice(0, 20)}`,
    deploymentKey: route.deploymentRouteKey,
    controlKind: "bridge",
    scope: "deployment",
    capabilities: [],
    capSemantics: { kind: "unknown", bound: null },
    claimImpairment: "unknown",
    economicLossScope: "deployment",
    authority: {
      authorityKey: `bridge-route:${route.deploymentRouteKey}`,
      model: "unknown",
      threshold: null,
    },
    delaySec: null,
    materialSupplyShare: route.supplyShare,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: "unknown",
    failureDomains: [{ kind: "bridge-route", key: route.deploymentRouteKey }],
  };
}

function representationGroupId(
  assetId: string,
  deploymentRouteKey: string,
): string | null {
  const prefix = `${V9_REPRESENTATION_GROUP_ROUTE_PREFIX}${assetId}:`;
  return deploymentRouteKey.startsWith(prefix) &&
    deploymentRouteKey.length > prefix.length
    ? deploymentRouteKey.slice(prefix.length)
    : null;
}

function representationGroupBridgeControl(
  assetId: string,
  route: NonNullable<
    ExtensionAsset["supplyReview"]
  >["selectedBridgeRoutes"][number],
  failureDomains: readonly V9FailureDomainRef[],
): ControlOverlay {
  const reviewed = route.reviewState === "selected-reviewed";
  const authorityDomain =
    failureDomains.find(
      (domain) =>
        domain.kind === "bridge-route" &&
        domain.key.startsWith("contract:"),
    ) ?? failureDomains[0];
  return {
    controlKey: `bridge-group:${assetId}:${domainDigest(
      "safety-score-v9.representation-group-bridge-control-key.v1",
      route.deploymentRouteKey,
    ).slice(0, 20)}`,
    deploymentKey: route.deploymentRouteKey,
    controlKind: "bridge",
    scope: "deployment",
    capabilities: ["bridge-mint"],
    capSemantics: reviewed
      ? { kind: "unbounded", bound: null }
      : { kind: "unknown", bound: null },
    claimImpairment: reviewed ? "unbounded" : "unknown",
    economicLossScope: reviewed ? "deployment" : "unknown",
    authority: {
      authorityKey:
        authorityDomain?.key ??
        `bridge-route:${route.deploymentRouteKey}`,
      // The adapter contract is the observed common mechanism, not proof of
      // the heterogeneous destination mint authorities.
      model: "unknown",
      threshold: null,
    },
    delaySec: null,
    materialSupplyShare: route.supplyShare,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: reviewed ? "none" : "unknown",
    failureDomains: [...failureDomains].sort((left, right) =>
      compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
    ),
  };
}

function canonicalRouteChain(routeId: string): string | null {
  const separator = routeId.indexOf(":");
  return separator > 0 ? resolveChainId(routeId.slice(0, separator)) : null;
}

/**
 * Proves that every unresolved exact deployment is independently below the
 * deployment threshold. Shares are intentionally not summed: each row has a
 * distinct deployment-scoped failure domain. Uncanonicalized raw labels are
 * the exception and arrive as one conservative pooled row.
 */
function hasCompleteSubthresholdBridgeInventory(
  profileRoutes: readonly BridgeRouteDeployment[],
  controls: readonly ControlOverlay[],
  supplyReview: ExtensionAsset["supplyReview"],
): boolean {
  if (supplyReview === null || supplyReview.selectedBridgeRoutes.length === 0) return false;
  const rows = supplyReview.selectedBridgeRoutes;
  const totalRowShare = rows.reduce((sum, row) => sum + row.supplyShare, 0);
  const aggregateShare =
    supplyReview.selectedRouteSupplyShare +
    supplyReview.unreviewedRouteSupplyShare +
    supplyReview.unknownRouteSupplyShare;
  if (Math.abs(totalRowShare - 1) > 0.000001 || Math.abs(aggregateShare - 1) > 0.000001) return false;
  if (rows.some((row) => row.deploymentRouteKey.startsWith(V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX))) return false;

  const controlsByDeployment = new Map<string, ControlOverlay[]>();
  for (const control of controls) {
    controlsByDeployment.set(control.deploymentKey, [
      ...(controlsByDeployment.get(control.deploymentKey) ?? []),
      control,
    ]);
  }

  const exactRowsByDeployment = new Map(rows.map((row) => [row.deploymentRouteKey, row]));
  for (const row of rows) {
    if (
      row.deploymentRouteKey.startsWith(
        V9_REPRESENTATION_GROUP_ROUTE_PREFIX,
      )
    ) {
      const joinedControls = controlsByDeployment.get(row.deploymentRouteKey) ?? [];
      const control = joinedControls.length === 1 ? joinedControls[0] : undefined;
      if (
        row.reviewState !== "selected-reviewed" ||
        control === undefined ||
        control.scope !== "deployment" ||
        control.economicLossScope !== "deployment" ||
        control.materialSupplyShare === null ||
        Math.abs(control.materialSupplyShare - row.supplyShare) >
          0.000001 ||
        row.supplyShare >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD ||
        row.supplyShare >= COMMON_MODE_MATERIAL_SHARE_THRESHOLD
      ) {
        return false;
      }
      continue;
    }
    if (row.reviewState === "selected-reviewed") continue;
    // RULED D-J (2026-07-19): an unrecognized-chain-label pool below the
    // common-mode materiality floor is an accepted bounded row; the proof no
    // longer requires its joined subthreshold control. At or above the floor
    // the pool keeps the ordinary fail-closed join below.
    if (
      row.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX) &&
      row.supplyShare < COMMON_MODE_MATERIAL_SHARE_THRESHOLD
    ) {
      continue;
    }
    // Same shape as D-J, applied to a resolved chain that has no reviewed
    // route: each unmatched row has its own deployment failure domain, so a
    // share independently below the deployment floor is accepted supply
    // evidence rather than an unknown-identity control.
    if (
      row.reviewState === "unmatched" &&
      !row.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX) &&
      row.supplyShare < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD
    ) {
      continue;
    }
    const joinedControls = controlsByDeployment.get(row.deploymentRouteKey) ?? [];
    const control = joinedControls.length === 1 ? joinedControls[0] : undefined;
    if (
      control === undefined ||
      control.scope !== "deployment" ||
      control.economicLossScope !== "deployment" ||
      control.materialSupplyShare === null ||
      Math.abs(control.materialSupplyShare - row.supplyShare) > 0.000001 ||
      control.materialSupplyShare >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD
    ) {
      return false;
    }
  }

  const presentCanonicalChains = new Set<string>();
  for (const row of rows) {
    if (row.deploymentRouteKey.startsWith(V9_UNMATCHED_CHAIN_ROUTE_PREFIX)) {
      const scopedKey = row.deploymentRouteKey.slice(V9_UNMATCHED_CHAIN_ROUTE_PREFIX.length);
      const separator = scopedKey.indexOf(":");
      if (separator <= 0) return false;
      presentCanonicalChains.add(scopedKey.slice(separator + 1));
      continue;
    }
    if (row.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX)) continue;
    if (row.deploymentRouteKey.startsWith(V9_REPRESENTATION_GROUP_ROUTE_PREFIX)) continue;
    const chain = canonicalRouteChain(row.deploymentRouteKey);
    if (chain !== null) presentCanonicalChains.add(chain);
  }

  for (const route of profileRoutes) {
    if (route.reviewDisposition === "reviewed") continue;
    if (exactRowsByDeployment.has(route.id)) continue;
    const chain = canonicalRouteChain(route.id);
    const joinedControls = controlsByDeployment.get(normalizedBridgeDeploymentId(route.id)) ?? [];
    const control = joinedControls.length === 1 ? joinedControls[0] : undefined;
    if (
      chain === null ||
      presentCanonicalChains.has(chain) ||
      control === undefined ||
      control.materialSupplyShare !== 0
    ) {
      return false;
    }
  }
  return true;
}

type BridgeJoinChainRows = Readonly<Record<string, { current: number }>>;

function bridgeJoinSharesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000001;
}

/**
 * ODR-D5a: name the selected supply rows this asset cannot show joined to one
 * proven bridge control, so the residue carriers' `BRIDGE_MATERIALITY` work
 * item points at a `deploymentRouteKey` instead of leaving the reader to
 * re-derive the join. This mirrors the row branches of the evaluator's
 * completeness proof (`evaluateV9SubthresholdUnresolvedBridgeJoins`) over the
 * facts the producer can see; the two forgiven sub-threshold branches are
 * skipped so a clean asset records nothing. It is diagnostics only — the
 * evaluator remains the sole authority on the verdict.
 */
function buildUnprovenRouteJoins(
  supplyReview: ExtensionAsset["supplyReview"],
  bridgeControls: readonly ControlOverlay[],
  controlSemanticsResolved: (control: ControlOverlay) => boolean,
): V9BridgeSupplyRouteJoinV1[] {
  const controlsByDeployment = new Map<string, ControlOverlay[]>();
  for (const control of bridgeControls) {
    if (control.controlKind !== "bridge") continue;
    controlsByDeployment.set(control.deploymentKey, [
      ...(controlsByDeployment.get(control.deploymentKey) ?? []),
      control,
    ]);
  }
  const unproven: V9BridgeSupplyRouteJoinV1[] = [];
  for (const row of supplyReview?.selectedBridgeRoutes ?? []) {
    const pooled = row.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX);
    // RULED D-J (2026-07-19) and the sub-material unmatched branch: both are
    // accepted bounded rows, not join failures. Do not report them.
    if (pooled && row.supplyShare < COMMON_MODE_MATERIAL_SHARE_THRESHOLD) continue;
    if (row.reviewState === "unmatched" && !pooled && row.supplyShare < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD) continue;
    const joined = controlsByDeployment.get(row.deploymentRouteKey) ?? [];
    const single = joined.length === 1 ? joined[0]! : null;
    const proven = (() => {
      if (row.reviewState === "selected-reviewed") {
        if (row.reviewedRouteKind === "native") return joined.length === 0;
        if (row.reviewedRouteKind !== "controlled" || single === null) return false;
        return (
          controlSemanticsResolved(single) &&
          single.materialSupplyShare !== null &&
          bridgeJoinSharesReconcile(single.materialSupplyShare, row.supplyShare)
        );
      }
      if (single === null) return false;
      return (
        single.scope === "deployment" &&
        single.economicLossScope === "deployment" &&
        single.materialSupplyShare !== null &&
        bridgeJoinSharesReconcile(single.materialSupplyShare, row.supplyShare) &&
        single.materialSupplyShare < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD
      );
    })();
    if (proven) continue;
    unproven.push({
      deploymentRouteKey: row.deploymentRouteKey,
      reviewState: row.reviewState,
      reviewedRouteKind: row.reviewedRouteKind ?? null,
      supplyShare: row.supplyShare,
      joinedControlKeys: [...new Set(joined.map((control) => control.controlKey))].sort(compareText),
      joinedControlSemanticsResolved: single === null ? null : controlSemanticsResolved(single),
      joinedControlSupplyShare: single === null ? null : single.materialSupplyShare,
    });
  }
  return unproven.sort((left, right) => compareText(left.deploymentRouteKey, right.deploymentRouteKey));
}

function buildBridgeJoinDiagnostics(
  profileRoutes: readonly BridgeRouteDeployment[],
  chainRows: BridgeJoinChainRows | undefined,
  supplyReview: ExtensionAsset["supplyReview"],
  bridgeClaimControls: readonly ControlOverlay[],
  applicabilityBranch: V9BridgeJoinDiagnosticsV1["applicabilityBranch"],
  unprovenRouteJoins: readonly V9BridgeSupplyRouteJoinV1[] = [],
): V9BridgeJoinDiagnosticsV1 {
  const routeCountByChain = new Map<string, number>();
  for (const route of profileRoutes) {
    const chain = canonicalRouteChain(route.id);
    if (chain === null) continue;
    routeCountByChain.set(chain, (routeCountByChain.get(chain) ?? 0) + 1);
  }

  const canonicalSupplyChains = new Set<string>();
  const unmatchedRowIdentities = new Set<string>();
  for (const rawChain of Object.keys(chainRows ?? {}).sort(compareText)) {
    const chain = resolveChainId(rawChain);
    if (chain === null) {
      unmatchedRowIdentities.add(rawChain);
      continue;
    }
    canonicalSupplyChains.add(chain);
    if ((routeCountByChain.get(chain) ?? 0) !== 1) unmatchedRowIdentities.add(rawChain);
  }

  const selectedRows = supplyReview?.selectedBridgeRoutes ?? [];
  const fallbackCanonicalSupplyRows = new Set(
    selectedRows
      .filter((row) => row.reviewState === "selected-reviewed")
      .map((row) => canonicalRouteChain(row.deploymentRouteKey))
      .filter((chain): chain is string => chain !== null),
  );
  const canonicalSupplyRowCount =
    chainRows === undefined ? fallbackCanonicalSupplyRows.size : canonicalSupplyChains.size;
  const reviewedNativeRows = selectedRows.filter(
    (row) => row.reviewState === "selected-reviewed" && row.reviewedRouteKind === "native",
  );
  const reviewedNativeSupplyShare = Math.min(
    1,
    reviewedNativeRows.reduce((sum, row) => sum + row.supplyShare, 0),
  );

  return {
    profileRouteCount: profileRoutes.length,
    canonicalSupplyRowCount,
    unmatchedRowIdentities: [...unmatchedRowIdentities].sort(compareText),
    reviewedNativeCoverage: {
      reviewedRowCount: reviewedNativeRows.length,
      canonicalSupplyRowCount,
      supplyShare: reviewedNativeSupplyShare,
      complete:
        canonicalSupplyRowCount > 0 &&
        unmatchedRowIdentities.size === 0 &&
        reviewedNativeRows.length === canonicalSupplyRowCount &&
        reviewedNativeSupplyShare >= 1 - 0.000001,
    },
    bridgeClaimControls: [...new Set(bridgeClaimControls.map((control) => control.controlKey))].sort(compareText),
    applicabilityBranch,
    unprovenRouteJoins: [...unprovenRouteJoins],
  };
}

export function adaptBridgeReview(
  meta: V9ExtensionRegistryMeta,
  supplyReview: ExtensionAsset["supplyReview"],
  deployedChainCount: number,
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
  chainRows?: BridgeJoinChainRows,
): {
  review: NonNullable<ExtensionAsset["economicControlReview"]>["bridge"];
  controls: ControlOverlay[];
} {
  const profile: BridgeRouteRiskProfile | undefined = meta.bridgeRouteRisk;
  if (!profile) {
    if (deployedChainCount <= 1) {
      return {
        review: {
          status: notApplicableStatus(
            "v9.control.bridge-review",
            "The exact captured supply is confined to one deployment; no bridge route carries the claim.",
            [],
          ),
          routes: [],
        },
        controls: [],
      };
    }
    return {
      review: {
        status: requiredStatus("v9.control.bridge-review", "missing", `bridge:${meta.id}`),
        routes: [],
      },
      controls: [],
    };
  }
  const confidence = confidenceForResearch(profile.confidence);
  const reviewStale = researchReviewObservationState(profile.reviewedAt, clockSec) === "stale";
  const evidenceKeys = evidence.add({
    // A stale review still evidences the bridge fact itself, but it cannot
    // carry known claims in the umbrella deployment-control inventory.
    componentKeys: reviewStale ? ["economic-control:bridge"] : ["economic-control:bridge", "control"],
    sourceId: "stablecoin-meta.bridge-route-risk",
    reviewedAt: profile.reviewedAt,
    publishedBy: "unknown",
    confidence,
    sources: profile.sources,
    payload: profile,
    maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
  });
  const profileRoutes = profile.routes ?? [];
  if (reviewStale && (profile.controls?.length ?? 0) === 0) {
    return {
      review: {
        status: requiredStatus("v9.control.bridge-review", "stale", `bridge:${meta.id}`, evidenceKeys),
        routes: [],
        diagnostics: buildBridgeJoinDiagnostics(
          profileRoutes,
          chainRows,
          supplyReview,
          [],
          "applicable",
        ),
      },
      controls: [],
    };
  }
  const routesById = new Map(
    profileRoutes.map((route) => [normalizedBridgeDeploymentId(route.id), route]),
  );
  const structuredControls = (profile.controls ?? []).filter(
    (control) =>
      !reviewStale &&
      (control.observedAt === undefined || researchReviewObservationState(control.observedAt, clockSec) === "current"),
  );
  const structuredOverlayEntries = structuredControls.flatMap((control) => {
    const routeIds = [...new Set(control.routeRefs.map(normalizedBridgeDeploymentId))];
    return routeIds.map((routeId) => {
      const route = routesById.get(routeId);
      if (!route) {
        throw new Error(
          `Safety Score v9 bridge control ${control.id} for ${meta.id} references unknown route ${routeId}`,
        );
      }
      return {
        sourceControl: control,
        overlay: structuredBridgeControl(
          meta.id,
          route,
          control,
          safetyScoreV9RouteSupplyShare(supplyReview ?? null, routeId),
          !reviewStale,
        ),
      } satisfies StructuredBridgeOverlayEntry;
    });
  });
  const structuredRouteIds = new Set(structuredOverlayEntries.map((entry) => entry.overlay.deploymentKey));
  const structuredOverlaysByDeployment = new Map<string, StructuredBridgeOverlayEntry[]>();
  for (const entry of structuredOverlayEntries) {
    structuredOverlaysByDeployment.set(entry.overlay.deploymentKey, [
      ...(structuredOverlaysByDeployment.get(entry.overlay.deploymentKey) ?? []),
      entry,
    ]);
  }
  const structuredRouteControlsByDeployment = new Map<string, ControlOverlay>();
  for (const [routeId, entries] of structuredOverlaysByDeployment) {
    const route = routesById.get(routeId);
    if (!route) throw new Error(`Missing structured bridge route ${routeId} for ${meta.id}`);
    structuredRouteControlsByDeployment.set(
      routeId,
      structuredBridgeRouteControl(
        meta.id,
        route,
        entries,
        safetyScoreV9RouteSupplyShare(supplyReview ?? null, routeId),
      ),
    );
  }
  // A fresh reviewer-scoped question softens only the structured control it
  // names. The compiled fact is the route-level merge, so the merged overlay
  // inherits the marker only when every unresolved contributor on the route is
  // named; one unnamed unresolved sibling keeps the hard treatment, mirroring
  // the mint-authority whole-inventory rule at route granularity.
  const freshScopedQuestionRefs = new Set(
    (profile.scopedQuestions ?? [])
      .filter(
        (question) =>
          clockSec - isoDateStartSec(question.reviewedAt, clockSec, `${meta.id}:bridge-scoped-question`) <=
          V9_SCOPED_QUESTION_MAX_AGE_SEC,
      )
      .map((question) => question.controlRef.toLowerCase()),
  );
  const controlHasFreshScopedQuestion = (control: BridgeRouteControl): boolean =>
    freshScopedQuestionRefs.has(control.id.toLowerCase()) ||
    freshScopedQuestionRefs.has(control.label.toLowerCase()) ||
    (control.controllerChain != null &&
      control.controllerAddress != null &&
      freshScopedQuestionRefs.has(`${control.controllerChain}:${control.controllerAddress.toLowerCase()}`));
  const overlayFullyResolved = (overlay: ControlOverlay): boolean =>
    overlay.authority !== null &&
    overlay.authority.model !== "unknown" &&
    overlay.failureDomains.length > 0 &&
    overlay.capSemantics.kind !== "unknown" &&
    overlay.claimImpairment !== "unknown" &&
    overlay.economicLossScope !== "unknown" &&
    overlay.incidentState !== "unknown";
  if (freshScopedQuestionRefs.size > 0) {
    for (const [routeId, entries] of structuredOverlaysByDeployment) {
      const merged = structuredRouteControlsByDeployment.get(routeId);
      if (!merged || overlayFullyResolved(merged)) continue;
      const anyNamed = entries.some((entry) => controlHasFreshScopedQuestion(entry.sourceControl));
      const allUnresolvedNamed = entries.every(
        (entry) => controlHasFreshScopedQuestion(entry.sourceControl) || overlayFullyResolved(entry.overlay),
      );
      if (anyNamed && allUnresolvedNamed) {
        structuredRouteControlsByDeployment.set(routeId, { ...merged, scopedQuestionFresh: true });
      }
    }
  }
  // Every referenced structured fact contributes to exactly one route-level
  // overlay. The source control IDs and all failure domains remain in the
  // deterministic aggregate identity/evidence; only the materiality join is
  // collapsed from control scope to deployment scope.
  const structuredOverlays = [...structuredRouteControlsByDeployment.values()];
  const reviewedRoutes = profileRoutes.filter((route) => route.reviewDisposition === "reviewed");
  const representationGroups = (
    supplyReview?.selectedBridgeRoutes ?? []
  ).flatMap((row) => {
    const representationId = representationGroupId(
      meta.id,
      row.deploymentRouteKey,
    );
    if (representationId === null) return [];
    const members = profileRoutes.filter(
      (route) => route.representationId === representationId,
    );
    const tiers = new Set(members.map((route) => route.riskTier));
    if (
      members.length === 0 ||
      tiers.size !== 1 ||
      members.some((route) => structuredRouteIds.has(normalizedBridgeDeploymentId(route.id))) ||
      members.some(
        (route) =>
          route.reviewDisposition !== "reviewed" ||
          route.routeClass === "native" ||
          route.issuanceModel !== "wrapped-representation" ||
          route.semantics !== "lock-mint",
      )
    ) {
      return [];
    }
    return [{
      control: representationGroupBridgeControl(
        meta.id,
        row,
        supplyReview?.failureDomains ?? [],
      ),
      routeIds: members.map((route) => route.id),
      tier: [...tiers][0]!,
    }];
  });
  const groupedRouteIds = new Set(
    representationGroups.flatMap((group) =>
      group.routeIds.map(normalizedBridgeDeploymentId),
    ),
  );
  // Keep every non-native route as a control fact so exact deployment shares
  // remain available even when the route review itself is unresolved.
  const profileControls = profileRoutes
    .filter(
      (route) =>
        !groupedRouteIds.has(normalizedBridgeDeploymentId(route.id)) &&
        !structuredRouteIds.has(normalizedBridgeDeploymentId(route.id)),
    )
    .map((route) =>
      bridgeControl(
        meta.id,
        route,
        safetyScoreV9RouteSupplyShare(supplyReview ?? null, normalizedBridgeDeploymentId(route.id)),
        !reviewStale,
      ),
    )
    .filter((control): control is ControlOverlay => control !== null);
  // RULED D-J: a pooled uncanonicalized row below the common-mode floor is
  // accepted supply evidence, not an unresolved deployment-control identity.
  // At the floor it keeps the ordinary synthetic control and fails closed.
  const unmatchedControls = (supplyReview?.selectedBridgeRoutes ?? [])
    .filter((route) => {
      if (route.reviewState !== "unmatched") return false;
      if (route.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX)) {
        return route.supplyShare >= COMMON_MODE_MATERIAL_SHARE_THRESHOLD;
      }
      return route.supplyShare >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD;
    })
    .map((route) => unmatchedBridgeControl(meta.id, route));
  const controls = [
    ...structuredOverlays,
    ...profileControls,
    ...representationGroups.map((group) => group.control),
    ...unmatchedControls,
  ].sort((left, right) => compareText(left.controlKey, right.controlKey));
  const profileControlsByDeployment = new Map<string, ControlOverlay>();
  for (const control of profileControls) {
    profileControlsByDeployment.set(control.deploymentKey, control);
  }
  // `routes` is intentionally one row per reviewed bridge representation.
  // Native-issuance routes can still retain structured bridge controls above
  // (for canonical-side adapters/lockboxes), but they do not create a second
  // bridge materiality reason for the native liability itself.
  const routes = [
    ...reviewedRoutes
      .filter(
        (route) =>
          !groupedRouteIds.has(normalizedBridgeDeploymentId(route.id)) &&
          isBridgeRepresentationRoute(route),
      )
      .flatMap((route) => {
        const routeId = normalizedBridgeDeploymentId(route.id);
        const control =
          structuredRouteControlsByDeployment.get(routeId) ?? profileControlsByDeployment.get(routeId);
        return control ? [{ controlKey: control.controlKey, tier: route.riskTier }] : [];
      }),
    ...representationGroups.map((group) => ({
      controlKey: group.control.controlKey,
      tier: group.tier,
    })),
  ].sort((left, right) => compareText(left.controlKey, right.controlKey));
  // A structured control whose only reviewed routes are native issuance governs the
  // canonical liability (adapters, lockboxes, portal administration on the canonical
  // chain). It is a real control fact and stays in the umbrella inventory, but it does
  // not make the asset bridge-exposed — the reviewed answer is still "no bridge".
  const nativeRouteIds = new Set(
    profileRoutes
      .filter((route) => !isBridgeRepresentationRoute(route))
      .map((route) => normalizedBridgeDeploymentId(route.id)),
  );
  const bridgeClaimControls = controls.filter(
    (control) => !nativeRouteIds.has(control.deploymentKey),
  );
  // A reviewed representation route is bridge exposure whether or not a control
  // compiled for it. `routes` drops a representation route whose control did not
  // resolve, so control emptiness alone cannot prove the absence of a bridge.
  const hasReviewedRepresentationRoute = reviewedRoutes.some(isBridgeRepresentationRoute);
  const allMaterialRoutesReviewed = hasCompleteSubthresholdBridgeInventory(profileRoutes, controls, supplyReview);
  const hasToleratedUncanonicalizedPool = (supplyReview?.selectedBridgeRoutes ?? []).some(
    (route) =>
      route.reviewState === "unmatched" &&
      route.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX) &&
      route.supplyShare < COMMON_MODE_MATERIAL_SHARE_THRESHOLD,
  );
  const hasToleratedUnmatchedDust = (supplyReview?.selectedBridgeRoutes ?? []).some(
    (route) =>
      route.reviewState === "unmatched" &&
      !route.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX) &&
      route.supplyShare < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD,
  );
  // Deliberately over the whole inventory, not `bridgeClaimControls`: a canonical
  // control carrying real supply must keep blocking this branch, so an unresolved
  // zero-share deployment stays an audit fact rather than proof of no bridge.
  const onlyZeroShareUnroutedControls =
    routes.length === 0 &&
    controls.length > 0 &&
    controls.every((control) => control.materialSupplyShare === 0);
  // An unresolved registry deployment can remain as a zero-share audit fact
  // while every selected supply route is reviewed native issuance. It does not
  // make the asset bridge-exposed or require a synthetic bridge route row.
  if (
    !reviewStale &&
    ((bridgeClaimControls.length === 0 &&
      !hasReviewedRepresentationRoute &&
      !hasToleratedUncanonicalizedPool &&
      !hasToleratedUnmatchedDust) ||
      (allMaterialRoutesReviewed && onlyZeroShareUnroutedControls))
  ) {
    return {
      review: {
        status: notApplicableStatus(
          "v9.control.bridge-review",
          "Every reviewed deployment route is native issuance; no bridge control carries the claim.",
          evidenceKeys,
        ),
        routes: [],
        diagnostics: buildBridgeJoinDiagnostics(
          profileRoutes,
          chainRows,
          supplyReview,
          bridgeClaimControls,
          // The evaluator never runs the sub-threshold join proof on a
          // not-applicable bridge review, so recording unproven rows here would
          // report a failure that no proof ever asks about.
          "native-only-not-applicable",
        ),
      },
      controls,
    };
  }
  const state =
    !reviewStale && allMaterialRoutesReviewed && reviewedObservationState(confidence) === "known"
      ? "known"
      : "bounded-unknown";
  return {
    review: {
      status: requiredStatus("v9.control.bridge-review", state, `bridge:${meta.id}`, evidenceKeys),
      routes,
      diagnostics: buildBridgeJoinDiagnostics(
        profileRoutes,
        chainRows,
        supplyReview,
        bridgeClaimControls,
        "applicable",
        buildUnprovenRouteJoins(supplyReview, controls, overlayFullyResolved),
      ),
    },
    controls,
  };
}
