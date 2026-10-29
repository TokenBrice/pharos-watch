import type {
  V9DocumentationPolicy,
  V9DocumentationReason,
  V9DocumentationThresholdKind,
  V9EvidenceLevel,
  V9QualityPillar,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import type {
  V9AssetFactsV3,
  V9DeploymentControlFactV2,
  V9FactGapV3,
} from "../../types/safety-score-v9-facts";
import { provenNullShareDeploymentBound } from "./control-bridge-join";
import { bindingByMateriality } from "./control-primitives";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonTreatment } from "./policy";
import { V9_EMPTY_ARRAY } from "../../types/safety-score-v9-immutable";

/**
 * Documentation class (PLAN §2.3, contract C1/ImplDocControl §3.1).
 *
 * Decision B: this module is derived-only. It reads facts the evaluator already
 * reads and returns a label; it never edits, prices, re-causes, re-binds or
 * re-identifies a gap. Scoring modules must not import it.
 *
 * Fail-closed: an absent `semantic.evidence.documentation` block, a gap that is
 * not an open C/U obligation, an unresolvable owning control/exposure, a null
 * share, a global/reserve claim, a binding control, a zero-route inventory or a
 * datum that alone gates a pillar all return `null`.
 */

/** The fact fields the classifier reads; every compiled V3 asset satisfies it. */
export type V9DocumentationAssetFacts = Pick<
  V9AssetFactsV3,
  | "assetId"
  | "archetype"
  | "controlStatus"
  | "controls"
  | "gaps"
  | "supply"
  | "economicControlReview"
  | "reserveExposures"
  | "exitRoutes"
> & {
  /**
   * Route keys the evaluator already admitted/scored for this asset
   * (`exit.routes[].included === true`). Route-scoped diagnostics on any other
   * route can still change pillar admission, so they are NOT documentation.
   * Omit it and those diagnostics stay required (fail closed).
   */
  readonly admittedExitRouteKeys?: ReadonlySet<string>;
};

export interface V9DocumentationClassification {
  readonly reason: V9DocumentationReason;
  /** Policy location of the authority, e.g. `semantic.evidence.documentation.reasons.reserve-dust`. */
  readonly policyRef: string;
  /**
   * Resolved strict bar, in share units (a percentage key divided by 100).
   * `evidenceKind` distinguishes a directly reviewed share from a reconciled
   * upper bound proven for a null-share deployment.
   */
  readonly threshold: {
    readonly kind: V9DocumentationThresholdKind;
    readonly value: number;
    readonly evidenceKind?: "exact" | "upper-bound";
  } | null;
}

interface V9DocumentationClassifyContext {
  readonly envelope: V9ValidatedPolicyEnvelope;
  readonly documentation: V9DocumentationPolicy;
  readonly asset: V9DocumentationAssetFacts;
  readonly gap: V9FactGapV3;
}

const POLICY_REF_PREFIX = "semantic.evidence.documentation.reasons.";

/**
 * The mint grade already withholds this credit (`control-mint-grade.ts`), so a
 * question about the withheld datum cannot move the published mint score.
 */
function classifyUnknownScoresAsNoCredit(ctx: V9DocumentationClassifyContext): V9DocumentationClassification | null {
  const scope = ctx.gap.causeScope;
  if (scope === undefined || scope.pillar !== "control" || scope.componentKey !== "economic-control:mint") return null;
  if (ctx.gap.observationState !== "missing") return null;
  const mint = ctx.asset.economicControlReview.mint;
  if (scope.factorKey === "reconciliation") {
    const credited = mint.reconciliation === "continuous" || mint.reconciliation === "periodic";
    return credited ? null : classify("unknown-scores-as-no-credit");
  }
  if (scope.factorKey === "supervision") {
    const credited = mint.supervision === "prudential" || mint.supervision === "attestation-only";
    return credited ? null : classify("unknown-scores-as-no-credit");
  }
  return null;
}

/**
 * Custody questions have no reader in the scoring path: `factorKey` `keyCustody`
 * is consumed only when the control fact is built (`fact-set-control.ts`), and
 * no scored component references a custody gap. Scope-independent.
 */
function classifyNoScoringPath(ctx: V9DocumentationClassifyContext): V9DocumentationClassification | null {
  return ctx.gap.causeScope?.factorKey === "keyCustody" ? classify("no-scoring-path") : null;
}

/**
 * A policy-`diagnostic` datum is not a pillar witness, but only where its
 * resolution cannot change pillar admission. Two vetoes apply:
 *
 * 1. `missing-archetype` is NR-treated yet for `usdr-ring` it is the only cause
 *    of a null Backing score (`archetypes/evaluation.ts`), so resolving it can
 *    add a priced pillar.
 * 2. A route-scoped datum is documentation only when the evaluator already
 *    admitted the carrying route; on an unscored route the datum gates admission
 *    (`evaluateV9Exit`), so it stays required. Unknown admission fails closed.
 *
 * Release invariants (DOC-6) assert no other diagnostic datum alone gates a
 * pillar.
 */
function classifyUnscoredDiagnostic(ctx: V9DocumentationClassifyContext): V9DocumentationClassification | null {
  if (ctx.gap.reasonCode === "missing-archetype") return null;
  const treatment = resolveV9ReasonTreatment(ctx.envelope, ctx.gap.reasonCode, ctx.gap.causeProof.cause);
  if (treatment.treatment !== "diagnostic") return null;
  if (ctx.gap.path.kind === "optional-exit") {
    const admitted = ctx.asset.admittedExitRouteKeys;
    if (admitted === undefined || !admitted.has(ctx.gap.path.routeKey)) return null;
  }
  return classify("unscored-diagnostic");
}

/**
 * The portfolio-coverage gap is a disclosure label, never a route witness.
 * Zero-route inventories keep it open because completing coverage there can arm
 * the empty-inventory floor (`evaluateV9Exit`).
 */
function classifyCoverageLabel(ctx: V9DocumentationClassifyContext): V9DocumentationClassification | null {
  if (ctx.gap.reasonCode !== "incomplete-dex-route-coverage") return null;
  if (ctx.gap.path.kind !== "local-component" || ctx.gap.path.componentKey !== "exit-portfolio-coverage") return null;
  return ctx.asset.exitRoutes.length === 0 ? null : classify("coverage-label");
}

/**
 * A deployment whose known or reconciled-upper-bound supply share is strictly
 * below the declared bar cannot move a published score: the scorer's own
 * binding predicate (`bindingByMateriality`) is a conjunct, so documentation can
 * never be binding. Null share, global/reserve claims and share-less controls
 * stay required.
 */
function classifyImmaterialDeployment(ctx: V9DocumentationClassifyContext): V9DocumentationClassification | null {
  const control = resolveV9DocumentationControl(ctx.asset, ctx.gap);
  if (control === null) return null;
  const bound = provenNullShareDeploymentBound(ctx.asset, control);
  const share = control.materialSupplyShare ?? bound;
  if (share === null) return null;
  const bar = thresholdShare(ctx.documentation, "immaterial-deployment");
  if (bar === null || !(share < bar)) return null;
  if (bindingByMateriality(control, ctx.envelope.policy.semantic.materiality.deploymentMaterialSharePct / 100, bound)) {
    return null;
  }
  const threshold = {
    kind: "known-share-pct" as const,
    value: bar,
    evidenceKind: control.materialSupplyShare !== null ? "exact" as const : "upper-bound" as const,
  };
  return classify("immaterial-deployment", threshold);
}

/**
 * A reserve exposure below the dust bar of the book contributes at most its own
 * weight to the exposure blend. Only an unstructured `missing` factor row is a
 * documentation datum; stale/partial-review dust rows stay open.
 */
function classifyReserveDust(ctx: V9DocumentationClassifyContext): V9DocumentationClassification | null {
  if (ctx.gap.path.kind !== "collateral-exposure") return null;
  if (ctx.gap.observationState !== "missing") return null;
  const exposureKey = ctx.gap.path.exposureKey;
  const exposure = ctx.asset.reserveExposures.find((candidate) => candidate.exposureKey === exposureKey);
  if (exposure === undefined) return null;
  const bar = thresholdShare(ctx.documentation, "reserve-dust");
  if (bar === null || !(exposure.weight < bar)) return null;
  return classify("reserve-dust", { kind: "reserve-book-share", value: bar });
}

const CLASSIFIERS: Readonly<Record<V9DocumentationReason, (ctx: V9DocumentationClassifyContext) => V9DocumentationClassification | null>> = {
  "no-scoring-path": classifyNoScoringPath,
  "unknown-scores-as-no-credit": classifyUnknownScoresAsNoCredit,
  "unscored-diagnostic": classifyUnscoredDiagnostic,
  "coverage-label": classifyCoverageLabel,
  "immaterial-deployment": classifyImmaterialDeployment,
  "reserve-dust": classifyReserveDust,
};

function classify(
  reason: V9DocumentationReason,
  threshold: V9DocumentationClassification["threshold"] = null,
): V9DocumentationClassification {
  return { reason, policyRef: `${POLICY_REF_PREFIX}${reason}`, threshold };
}

/** Resolve a threshold reason's strict bar (share units) from its declared policy key. */
function thresholdShare(documentation: V9DocumentationPolicy, reason: V9DocumentationReason): number | null {
  const entry = documentation.reasons.find((candidate) => candidate.reason === reason);
  if (entry === undefined || entry.threshold === null) return null;
  return documentation[entry.threshold.sharePctKey] / 100;
}

/**
 * The owning control of a gap: the exact deployment-control path, else the
 * longest `control:<key>` prefix of the cause scope's component key.
 */
export function resolveV9DocumentationControl(
  asset: Pick<V9DocumentationAssetFacts, "controls">,
  gap: V9FactGapV3,
): V9DeploymentControlFactV2 | null {
  const controls = asset.controls;
  const path = gap.path;
  if (path.kind === "deployment-control") {
    const { controlKey } = path;
    return controls.find((control) => control.controlKey === controlKey) ?? null;
  }
  const componentKey = gap.causeScope?.componentKey;
  if (componentKey === undefined || !componentKey.startsWith("control:")) return null;
  const rest = componentKey.slice("control:".length);
  let matched: V9DeploymentControlFactV2 | null = null;
  for (const control of controls) {
    if (rest !== control.controlKey && !rest.startsWith(`${control.controlKey}:`)) continue;
    if (matched === null || control.controlKey.length > matched.controlKey.length) matched = control;
  }
  return matched;
}

/**
 * Classify one compiled gap. The first matching reason in policy `reasonOrder`
 * wins; `null` means the datum stays a required obligation.
 */
export function classifyV9DocumentationGap(
  envelope: V9ValidatedPolicyEnvelope,
  asset: V9DocumentationAssetFacts,
  gap: V9FactGapV3,
): V9DocumentationClassification | null {
  assertV9ValidatedPolicyEnvelope(envelope);
  const documentation = envelope.policy.semantic.evidence.documentation;
  if (documentation === undefined) return null;
  // Only open C/U obligations can be documentation; A/B (pipeline/uncurated)
  // and D (measured adverse) stay outside the class by definition.
  const cause = gap.causeProof.cause;
  if (cause !== "C" && cause !== "U") return null;
  const ctx: V9DocumentationClassifyContext = { envelope, documentation, asset, gap };
  for (const reason of documentation.reasonOrder) {
    const classification = CLASSIFIERS[reason](ctx);
    if (classification !== null) return classification;
  }
  return null;
}

/** Every documentation-classified gap of one asset, keyed by gap id. */
export function documentationGapIds(
  envelope: V9ValidatedPolicyEnvelope,
  asset: V9DocumentationAssetFacts,
): ReadonlyMap<string, V9DocumentationClassification> {
  assertV9ValidatedPolicyEnvelope(envelope);
  if (envelope.policy.semantic.evidence.documentation === undefined) return new Map();
  const classified = new Map<string, V9DocumentationClassification>();
  for (const gap of asset.gaps) {
    const classification = classifyV9DocumentationGap(envelope, asset, gap);
    if (classification !== null) classified.set(gap.gapId, classification);
  }
  return classified;
}

export function isV9DocumentationDatum(
  envelope: V9ValidatedPolicyEnvelope,
  asset: V9DocumentationAssetFacts,
  gap: V9FactGapV3,
): boolean {
  return classifyV9DocumentationGap(envelope, asset, gap) !== null;
}

/** The witnesses a pillar published; structurally satisfied by `V9PillarEvaluation`. */
export interface V9DocumentationPillarWitness {
  readonly pillar: V9QualityPillar;
  readonly evidenceLevel: V9EvidenceLevel;
  readonly limitingCauseGapIds?: readonly string[];
}

export interface V9DocumentationOnlyPillarsInput {
  readonly envelope: V9ValidatedPolicyEnvelope;
  readonly asset: V9DocumentationAssetFacts;
  readonly pillars: readonly V9DocumentationPillarWitness[];
  /**
   * Inherited (`foreignCauseGaps`) ids already classified at their owner asset,
   * e.g. the publication-wide `documentationCauseGaps` union.
   */
  readonly foreignDocumentationGapIds?: Iterable<string>;
}

/**
 * The fail-closed annotation rule (PLAN §2.3): a pillar is documentation-only
 * limited only when it is `limited`, carries a non-empty `limitingCauseGapIds`,
 * and **every** witness resolves — locally on this asset or through the
 * inherited documentation ids — to a documentation gap. An empty list, a
 * non-limited pillar, one non-documentation witness or a witness that resolves
 * nowhere keeps the pillar unlisted.
 */
export function documentationOnlyLimitedPillars(
  input: V9DocumentationOnlyPillarsInput,
): readonly V9QualityPillar[] {
  assertV9ValidatedPolicyEnvelope(input.envelope);
  const local = documentationGapIds(input.envelope, input.asset);
  const foreign = input.foreignDocumentationGapIds === undefined ? null : new Set(input.foreignDocumentationGapIds);
  const listed: V9QualityPillar[] = [];
  for (const witness of input.pillars) {
    if (witness.evidenceLevel !== "limited") continue;
    const ids = witness.limitingCauseGapIds ?? V9_EMPTY_ARRAY;
    if (ids.length === 0) continue;
    const everyDocumentation = ids.every((id) => local.has(id) || (foreign !== null && foreign.has(id)));
    if (everyDocumentation) listed.push(witness.pillar);
  }
  return listed;
}
