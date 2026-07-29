import type {
  V9AssetFactsV2,
  V9DeploymentControlFactV2,
  V9FactStatusV2,
  V9ExitRouteFactV2,
} from "../../types/safety-score-v9-facts";
import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import { assertV9ValidatedPolicyEnvelope } from "./policy";
import { compareText, uniqueSorted } from "./primitives";

export type V9TransferPosture = "permissionless" | "restrictable" | "permissioned" | "unknown";
export type V9FreezeExposure = "none-known" | "upstream" | "direct" | "possible" | "unknown";
export type V9PrimaryExitPosture = "permissionless" | "eligibility-gated" | "issuer-discretionary" | "none" | "unknown";
export type V9GovernancePosture = "immutable" | "distributed" | "concentrated" | "single-entity" | "unknown";

/** D11: reviewed access evidence remains current for 365 days. */
export const V9_ACCESS_EVIDENCE_MAX_AGE_SEC = 31_536_000;

export interface V9TransferAccessReview {
  status: V9FactStatusV2;
  posture: Exclude<V9TransferPosture, "unknown"> | null;
}

export interface V9FreezeAccessReview {
  source: "blacklist" | "freeze" | "pause" | "upstream";
  status: V9FactStatusV2;
  reach: "none" | "individual" | "system-wide" | "possible" | "unknown";
}

export interface V9AccessPostureAssetFacts {
  assetId: V9AssetFactsV2["assetId"];
  controlStatus: V9AssetFactsV2["controlStatus"];
  controls: readonly V9DeploymentControlFactV2[];
  exitRoutes: readonly Pick<V9ExitRouteFactV2, "routeKey" | "lane" | "status" | "scoreEligible" | "holderAccess">[];
}

export interface EvaluateV9AccessPostureArgs {
  policy: V9ValidatedPolicyEnvelope;
  facts: V9AccessPostureAssetFacts;
  transfer: V9TransferAccessReview;
  freezeReviews: readonly V9FreezeAccessReview[];
}

export interface V9AccessPostureResult {
  transfer: V9TransferPosture;
  freezeExposure: V9FreezeExposure;
  primaryExit: V9PrimaryExitPosture;
  governance: V9GovernancePosture;
  unknownFields: readonly ("transfer" | "freezeExposure" | "primaryExit" | "governance")[];
  signals: readonly string[];
}

function isKnown(status: V9FactStatusV2): boolean {
  return status.applicability.state !== "unresolved" && status.observationState === "known";
}

function deriveFreezeExposure(
  controls: readonly V9DeploymentControlFactV2[],
  reviews: readonly V9FreezeAccessReview[],
): V9FreezeExposure {
  let direct = false;
  let upstream = false;
  let possible = false;
  let unknown = reviews.length === 0;
  let reviewedNone = false;

  for (const control of controls) {
    if (!control.capabilities.some((capability) => capability === "freeze" || capability === "seize")) continue;
    if (control.status.applicability.state === "not-applicable") continue;
    if (isKnown(control.status)) direct = true;
    else if (control.status.observationState === "stale") possible = true;
    else unknown = true;
  }

  for (const review of reviews) {
    if (review.status.applicability.state === "not-applicable") continue;
    if (!isKnown(review.status)) {
      if (review.status.observationState === "stale" || review.reach === "possible") possible = true;
      else unknown = true;
      continue;
    }
    if (review.reach === "none") reviewedNone = true;
    else if (review.reach === "possible") possible = true;
    else if (review.reach === "unknown") unknown = true;
    else if (review.source === "upstream") upstream = true;
    else direct = true;
  }

  if (direct) return "direct";
  if (upstream) return "upstream";
  if (possible) return "possible";
  if (unknown) return "unknown";
  return reviewedNone ? "none-known" : "unknown";
}

function derivePrimaryExit(routes: V9AccessPostureAssetFacts["exitRoutes"]): V9PrimaryExitPosture {
  const known: V9PrimaryExitPosture[] = [];
  let unresolved = false;

  for (const route of routes) {
    if (!route.scoreEligible || route.status.applicability.state === "not-applicable") continue;
    if (!isKnown(route.status) || route.holderAccess === "unknown") {
      unresolved = true;
      continue;
    }
    if (route.holderAccess === "permissionless" || route.holderAccess === "retail-open") {
      known.push("permissionless");
    } else if (route.holderAccess === "institutional-eligible" || route.holderAccess === "allowlisted") {
      known.push("eligibility-gated");
    } else {
      known.push("issuer-discretionary");
    }
  }

  if (known.includes("permissionless")) return "permissionless";
  if (known.includes("eligibility-gated")) return "eligibility-gated";
  if (known.includes("issuer-discretionary")) return "issuer-discretionary";
  if (unresolved) return "unknown";
  return routes.some((route) => route.scoreEligible) ? "unknown" : "none";
}

type V9AuthorityRole = "issuance" | "governance" | "pause" | "upgrade";

function authorityRoles(control: V9DeploymentControlFactV2): V9AuthorityRole[] {
  const roles: V9AuthorityRole[] = [];
  if (control.controlKind === "mint" || control.capabilities.includes("mint")) roles.push("issuance");
  if (control.controlKind === "upgrade" || control.capabilities.includes("upgrade")) roles.push("upgrade");
  if (
    control.controlKind === "freeze" ||
    control.capabilities.includes("freeze") ||
    control.capabilities.includes("seize")
  ) {
    roles.push("pause");
  }
  if (control.controlKind === "governance" || control.capabilities.includes("parameter-change")) {
    roles.push("governance");
  }
  return uniqueSorted(roles) as V9AuthorityRole[];
}

function isReviewedImmutableProtocolControl(control: V9DeploymentControlFactV2): boolean {
  return (
    control.scope === "global" &&
    control.controlKind === "mint" &&
    isKnown(control.status) &&
    control.capabilities.length === 0 &&
    control.capSemantics.kind === "not-applicable" &&
    control.claimImpairment === "none" &&
    control.economicLossScope === "access-only" &&
    (control.authority?.model === "contract" || control.authority?.model === "none")
  );
}

function deriveGovernance(
  controlStatus: V9FactStatusV2,
  controls: readonly V9DeploymentControlFactV2[],
): { posture: V9GovernancePosture; signals: string[] } {
  const known: Exclude<V9GovernancePosture, "unknown">[] = [];
  const signals: string[] = [];
  let unresolved = controlStatus.applicability.state !== "not-applicable" && !isKnown(controlStatus);

  if (controlStatus.applicability.state === "not-applicable") known.push("immutable");

  for (const control of controls) {
    // Immutable CDP machinery such as Liquity's BorrowerOperations is retained
    // as a reviewed mint-domain fact even though it has no privileged mint,
    // upgrade, pause, or parameter capability. Its contract address identifies
    // protocol machinery, not a concentrated administrator.
    if (isReviewedImmutableProtocolControl(control)) {
      known.push("immutable");
      signals.push("authority:issuance:immutable");
      continue;
    }
    const roles = authorityRoles(control);
    if (roles.length === 0 || control.status.applicability.state === "not-applicable") continue;
    if (!isKnown(control.status) || control.authority === null || control.authority.model === "unknown") {
      unresolved = true;
      signals.push(...roles.map((role) => `authority:${role}:unknown`));
      continue;
    }
    const posture: Exclude<V9GovernancePosture, "unknown"> = (() => {
      if (control.authority.model === "none") return "immutable";
      if (control.authority.model === "governance") return "distributed";
      if (control.authority.model === "eoa" || control.authority.model === "issuer-backend") {
        return "single-entity";
      }
      return "concentrated";
    })();
    known.push(posture);
    signals.push(...roles.map((role) => `authority:${role}:${posture}`));
  }

  const rank: Record<Exclude<V9GovernancePosture, "unknown">, number> = {
    immutable: 0,
    distributed: 1,
    concentrated: 2,
    "single-entity": 3,
  };
  const mostConcentrated = [...known].sort((left, right) => rank[right] - rank[left])[0];
  if (!mostConcentrated) return { posture: "unknown", signals };
  if (unresolved && mostConcentrated !== "single-entity") return { posture: "unknown", signals };
  return { posture: mostConcentrated, signals };
}

/**
 * Projects reviewed permissioning/censorship facts without producing an economic score.
 * Economic treatment of a freeze control requires an explicit system-wide recovery link in control.ts.
 */
export function evaluateV9AccessPosture(args: EvaluateV9AccessPostureArgs): V9AccessPostureResult {
  assertV9ValidatedPolicyEnvelope(args.policy);
  const controls = [...args.facts.controls].sort((left, right) => compareText(left.controlKey, right.controlKey));
  const routes = [...args.facts.exitRoutes].sort((left, right) => compareText(left.routeKey, right.routeKey));
  const transfer: V9TransferPosture =
    isKnown(args.transfer.status) && args.transfer.posture !== null ? args.transfer.posture : "unknown";
  const freezeExposure = deriveFreezeExposure(controls, args.freezeReviews);
  const primaryExit = derivePrimaryExit(routes);
  const governanceResult = deriveGovernance(args.facts.controlStatus, controls);
  const posture = {
    transfer,
    freezeExposure,
    primaryExit,
    governance: governanceResult.posture,
  };
  const vocabulary = args.policy.policy.semantic.accessPostureVocabulary;
  for (const [field, value] of Object.entries(posture) as Array<[keyof typeof posture, string]>) {
    if (!(vocabulary[field] as readonly string[]).includes(value)) {
      throw new Error(`Safety Score v9 access posture ${field}:${value} is outside policy vocabulary`);
    }
  }
  const unknownFields = (Object.entries(posture) as Array<[keyof typeof posture, string]>)
    .filter(([, value]) => value === "unknown")
    .map(([field]) => field)
    .sort(compareText);
  const signals = uniqueSorted([
    `transfer:${transfer}`,
    `freeze:${freezeExposure}`,
    `primary-exit:${primaryExit}`,
    `governance:${governanceResult.posture}`,
    ...governanceResult.signals,
  ]);

  return { ...posture, unknownFields, signals };
}
