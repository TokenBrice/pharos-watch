import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { resolveChainId } from "@shared/lib/chains";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { diagnoseDependencyGraph, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
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
  MintAuthorityEconomicCapSemantics,
  MintAuthorityProfile,
  OracleRiskBranch,
  OracleRiskProfile,
  StablecoinLink,
  StablecoinMeta,
} from "@shared/types/core";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import {
  RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT,
  validateReserveCompositionTotal,
  type ReserveSlice,
} from "@shared/types/reserves";
import {
  computeSafetyScoreV9ReserveExposureKey,
  type SafetyScoreV9FactSetExtensionV2,
} from "./safety-score-v9-fact-set";
import {
  buildSafetyScoreV9MechanismReview,
  getSafetyScoreV9MechanismOverlayEvidence,
  SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
} from "./safety-score-v9-extension-mechanism";
import { buildSafetyScoreV9ReserveClassifications } from "./safety-score-v9-extension-reserves";
import {
  computeSafetyScoreV9ReviewedTransferFactsDigest,
  resolveSafetyScoreV9ReviewedTransferFact,
  SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS,
  safetyScoreV9TransferDeploymentKey,
  type SafetyScoreV9ReviewedTransferFact,
  type SafetyScoreV9TransferMaterialScope,
} from "./safety-score-v9-extension-transfer";
import { SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY } from "@shared/lib/redemption-backstop-scoring";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "./safety-score-v9-extension-routes";
import {
  buildSafetyScoreV9SupplyReview,
  safetyScoreV9RouteSupplyShare,
  V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX,
  V9_UNMATCHED_CHAIN_ROUTE_PREFIX,
  V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX,
} from "./safety-score-v9-extension-supply";
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
  | "reserveReview"
  | "custodyProfile"
  | "proofOfReserves"
  | "genius"
  | "dependencies"
  | "dependencyReview"
  | "mintAuthority"
  | "oracleRisk"
  | "bridgeRouteRisk"
  | "blacklistabilityReview"
  | "contracts"
> &
  Partial<Pick<StablecoinMeta, "flags">>;

export interface BuildSafetyScoreV9BaselineExtensionOptions {
  metaById?: ReadonlyMap<string, V9ExtensionRegistryMeta>;
  registryFingerprint?: string;
  reviewedTransferFacts?: ReadonlyMap<string, SafetyScoreV9ReviewedTransferFact>;
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
type ReserveClassification = ReturnType<typeof buildSafetyScoreV9ReserveClassifications>[number];

// Identity tolerance for joining a live reserve slice to its reviewed
// classification. Name equality (with the surrounding 1:1 bijection guards)
// carries slice identity; the weight check only rejects gross mismatches.
// Live compositions drift daily (2026-07-18: USDC T-bills moved 2.0pp in two
// days, severing every fiat classification under the prior 0.5), so the
// bound must tolerate normal rebalancing. Weights used for scoring always
// come from the live row, never the reviewed one.
const RESERVE_WEIGHT_MATCH_TOLERANCE_PCT = 5;
const DEPLOYMENT_MATERIAL_SHARE_THRESHOLD =
  V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;

function digest(domain: string, payload: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}

const ISSUER_ENTITY_STOPWORDS = new Set([
  "llc",
  "ltd",
  "limited",
  "ltda",
  "inc",
  "corp",
  "corporation",
  "company",
  "co",
  "trust",
  "bank",
  "n",
  "a",
  "s",
  "de",
  "c",
  "v",
  "cv",
  "sa",
  "sas",
  "gmbh",
  "ag",
  "pte",
  "pty",
  "bv",
  "je",
  "the",
  "of",
  "and",
  "by",
  "dba",
  "dao",
  "llp",
  "plc",
  "se",
  "oy",
  "ab",
  "as",
]);

function normalizedIssuerEntity(value: string): string | null {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 0 && !ISSUER_ENTITY_STOPWORDS.has(token));
  return tokens[0] ?? null;
}

function rawIssuerKey(assetId: string, meta: V9ExtensionRegistryMeta): string | null {
  const geniusEntity = meta.genius?.issuerEntity;
  if (typeof geniusEntity === "string" && geniusEntity.trim().length > 0) {
    const normalized = normalizedIssuerEntity(geniusEntity);
    if (normalized) return normalized;
  }
  const dash = assetId.indexOf("-");
  const slug = dash >= 0 ? assetId.slice(dash + 1) : "";
  return slug.length > 0 ? slug : null;
}

/** Mirrors the accepted D2 matrix issuer join, including its five-hop bound. */
export function resolveSafetyScoreV9AssetIssuerKey(
  assetId: string,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
): string | null {
  const seen = new Set([assetId]);
  let current = assetId;
  for (let hop = 0; hop < 5; hop += 1) {
    const meta = metaById.get(current);
    if (!meta) return null;
    const next = meta.mintAuthority?.inheritedFrom ?? meta.variantOf ?? null;
    if (next === null) return rawIssuerKey(current, meta);
    if (seen.has(next)) return null;
    seen.add(next);
    current = next;
  }
  return null;
}

function normalizedReserveName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function reserveSlicesMatch(left: ReserveSlice, right: ReserveSlice): boolean {
  const normalizedName = normalizedReserveName(left.name);
  return (
    normalizedName.length > 0 &&
    normalizedName === normalizedReserveName(right.name) &&
    Math.abs(left.pct - right.pct) <= RESERVE_WEIGHT_MATCH_TOLERANCE_PCT
  );
}

function overlayReviewedReserveClassification(
  classification: ReserveClassification,
  live: ReserveSlice,
  reviewed: ReserveSlice,
  reviewKey: string,
): ReserveClassification {
  const assetClass = live.assetClass ?? reviewed.assetClass ?? null;
  const issuerOrObligorKey =
    live.issuerOrObligor ?? reviewed.issuerOrObligor ?? (reviewed.coinId ? `asset:${reviewed.coinId}` : null);
  const riskFactors = live.riskFactors?.length ? [...live.riskFactors] : [...(reviewed.riskFactors ?? [])];
  const liquidityHorizon = live.liquidityHorizon ?? reviewed.liquidityHorizon ?? null;
  const maturityDaysMax = live.maturityDaysMax ?? reviewed.maturityDaysMax ?? null;
  const usesReviewedMetadata =
    (live.assetClass == null && reviewed.assetClass != null) ||
    (live.issuerOrObligor == null && (reviewed.issuerOrObligor != null || reviewed.coinId != null)) ||
    (!live.riskFactors?.length && Boolean(reviewed.riskFactors?.length)) ||
    (live.liquidityHorizon == null && reviewed.liquidityHorizon != null) ||
    (live.maturityDaysMax == null && reviewed.maturityDaysMax != null);

  if (!usesReviewedMetadata) return classification;
  return {
    ...classification,
    classificationKey: `registry-reviewed:${classification.exposureKey}:${reviewKey}`,
    assetClass,
    issuerOrObligorKey,
    riskFactors: [...new Set(riskFactors)].sort(compareText),
    liquidityHorizon,
    maturityDaysMax,
    failureDomains: issuerOrObligorKey
      ? [{ kind: "reserve-issuer", key: issuerOrObligorKey }]
      : classification.failureDomains,
  };
}

/**
 * Bridges reviewed registry classifications onto exact live reserve identities.
 * Matching is deliberately one-to-one and ignores rows whose names or rounded
 * weights no longer describe the same exposure.
 */
export function buildReviewedReserveClassifications(
  liveReserves: readonly ReserveSlice[],
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
): ReserveClassification[] {
  const classifications = buildSafetyScoreV9ReserveClassifications(liveReserves);
  const reviewedReserves = meta.reserves ?? [];
  const review = meta.reserveReview;
  const reviewedAtSec = review ? Date.parse(`${review.reviewedAt}T00:00:00.000Z`) / 1_000 : Number.NaN;
  const compositionAsOfSec = review?.compositionAsOf
    ? Date.parse(`${review.compositionAsOf}T00:00:00.000Z`) / 1_000
    : null;
  if (
    reviewedReserves.length === 0 ||
    review?.scope !== "full-composition" ||
    review.confidence === "unknown" ||
    !Number.isFinite(reviewedAtSec) ||
    reviewedAtSec > clockSec ||
    (compositionAsOfSec !== null && (!Number.isFinite(compositionAsOfSec) || compositionAsOfSec > clockSec))
  ) {
    return classifications;
  }

  const reviewedCandidatesByLive = liveReserves.map((live) =>
    reviewedReserves
      .map((reviewed, reviewedIndex) => ({ reviewed, reviewedIndex }))
      .filter(({ reviewed }) => reserveSlicesMatch(live, reviewed)),
  );
  const liveCandidateCountByReviewed = reviewedReserves.map(
    (reviewed) => liveReserves.filter((live) => reserveSlicesMatch(live, reviewed)).length,
  );
  const reviewedByExposureKey = new Map<string, ReserveSlice>();
  const liveByExposureKey = new Map(liveReserves.map((live) => [computeSafetyScoreV9ReserveExposureKey(live), live]));

  for (const [liveIndex, candidates] of reviewedCandidatesByLive.entries()) {
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    if (liveCandidateCountByReviewed[candidate.reviewedIndex] !== 1) continue;
    const exposureKey = computeSafetyScoreV9ReserveExposureKey(liveReserves[liveIndex]!);
    reviewedByExposureKey.set(exposureKey, candidate.reviewed);
  }

  const reviewKey = digest("safety-score-v9.reserve-classification-review.v1", review).slice(0, 16);
  return classifications.map((classification) => {
    const live = liveByExposureKey.get(classification.exposureKey);
    const reviewed = reviewedByExposureKey.get(classification.exposureKey);
    return live && reviewed
      ? overlayReviewedReserveClassification(classification, live, reviewed, reviewKey)
      : classification;
  });
}

type IssuerAttestedReserveRows = NonNullable<ExtensionAsset["issuerAttestedReserveRows"]>;

const INDEPENDENT_ASSURANCE_METHODS = new Set([
  "audit",
  "examination",
  "review",
  "agreed-upon-procedures",
  "attestation",
]);
const ISSUER_ATTESTED_RESERVE_MAX_AGE_SEC = 31_536_000;

function normalizeIssuerAttestedReserveRows(rows: readonly ReserveSlice[]): ReserveSlice[] {
  const sorted = [...rows].sort(
    (left, right) =>
      compareText(computeSafetyScoreV9ReserveExposureKey(left), computeSafetyScoreV9ReserveExposureKey(right)) ||
      compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right)),
  );
  const totalPct = sorted.reduce((sum, row) => sum + row.pct, 0);
  if (totalPct === 100) return sorted;
  if (Math.abs(totalPct - 100) > RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT) {
    throw new Error("Issuer-attested reserve normalization exceeded the approved composition tolerance");
  }
  const scale = 100 / totalPct;
  let normalizedPct = 0;
  return sorted.map((row, index) => {
    const pct = index === sorted.length - 1 ? 100 - normalizedPct : row.pct * scale;
    normalizedPct += pct;
    return { ...row, pct };
  });
}

/** D6: admit reviewed issuer rows only when an independent attestor corroborates a prudential issuer. */
export function buildSafetyScoreV9IssuerAttestedReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
): IssuerAttestedReserveRows | null {
  const rows = meta.reserves ?? [];
  const review = meta.reserveReview;
  const proof = meta.proofOfReserves;
  const report = proof?.latestReport;
  const attestorIndependent =
    proof?.attestorTier === "big4" || proof?.attestorTier === "regional" || proof?.attestorTier === "niche";
  const reviewAtSec = review ? conservativeDateEndSec(review.reviewedAt, clockSec) : null;
  const compositionAtSec = conservativeDateEndSec(review?.compositionAsOf, clockSec);
  const reportAtSec = report ? conservativeDateEndSec(report.publishedAt, clockSec) : null;
  const periodEndSec = report ? conservativeDateEndSec(report.periodEnd, clockSec) : null;
  if (
    rows.length === 0 ||
    review?.scope !== "full-composition" ||
    review.confidence === "unknown" ||
    review.sources.length === 0 ||
    reviewAtSec === null ||
    compositionAtSec === null ||
    !validateReserveCompositionTotal(rows, "full") ||
    meta.mintAuthority?.supervision !== "prudential" ||
    proof?.type !== "independent-audit" ||
    !attestorIndependent ||
    !proof.provider?.trim() ||
    report === undefined ||
    report.confidence === "unknown" ||
    report.sources.length === 0 ||
    reportAtSec === null ||
    periodEndSec === null ||
    compositionAtSec !== periodEndSec ||
    reportAtSec < periodEndSec ||
    clockSec - compositionAtSec > ISSUER_ATTESTED_RESERVE_MAX_AGE_SEC ||
    !INDEPENDENT_ASSURANCE_METHODS.has(report.assuranceMethod)
  ) {
    return null;
  }
  return {
    rows: normalizeIssuerAttestedReserveRows(rows),
    evidenceClass: "issuer-attested",
    confidenceMultiplier: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.issuerAttestedConfidenceMultiplier,
  };
}

function addIssuerAttestedReserveEvidence(
  meta: V9ExtensionRegistryMeta,
  admitted: IssuerAttestedReserveRows | null,
  evidence: ReviewEvidenceBuilder,
): void {
  const review = meta.reserveReview;
  const report = meta.proofOfReserves?.latestReport;
  if (!admitted || !review || !report) return;
  const sources = [...review.sources, ...report.sources].filter(
    (source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index,
  );
  evidence.add({
    componentKeys: [
      "issuer-attested-reserves",
      ...admitted.rows.map((row) => `reserve-classification:${computeSafetyScoreV9ReserveExposureKey(row)}`),
    ],
    sourceId: "stablecoin-meta.issuer-attested-reserves",
    reviewedAt: report.periodEnd,
    confidence: confidenceForResearch(report.confidence),
    sources,
    payload: {
      reserveReview: review,
      reserves: admitted.rows,
      proofOfReserves: meta.proofOfReserves,
      evidenceClass: admitted.evidenceClass,
      confidenceMultiplier: admitted.confidenceMultiplier,
    },
    maxAgeSec: ISSUER_ATTESTED_RESERVE_MAX_AGE_SEC,
  });
}

function addReserveClassificationEvidence(
  meta: V9ExtensionRegistryMeta,
  classifications: readonly ReserveClassification[],
  evidence: ReviewEvidenceBuilder,
): void {
  const review = meta.reserveReview;
  const reviewed = classifications.filter((classification) =>
    classification.classificationKey.startsWith("registry-reviewed:"),
  );
  if (!review || reviewed.length === 0) return;
  evidence.add({
    componentKeys: reviewed.map((classification) => `reserve-classification:${classification.exposureKey}`),
    sourceId: "stablecoin-meta.reserve-review",
    reviewedAt: review.reviewedAt,
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: { reserveReview: review, reserves: meta.reserves ?? [] },
  });
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
  // The fact-set compiler rebinds statuses to research-overlay evidence; a
  // sentinel id only satisfies the known-state evidence invariant until then.
  return {
    applicability: { state: "not-applicable", policyRuleId, rationale, gapId: null },
    observationState: "known",
    evidenceRefIds: evidenceKeys.length > 0 ? [...evidenceKeys] : [`extension-evidence:${policyRuleId}`],
    gapIds: [],
  };
}

function reviewedObservationState(confidence: ResearchEvidence["confidence"]): "known" | "bounded-unknown" | "missing" {
  if (confidence === "verified" || confidence === "probable" || confidence === "manual-review") return "known";
  return confidence === "limited" ? "bounded-unknown" : "missing";
}

function issuerAuthorityKey(assetId: string, control: MintAuthorityControl): string | null {
  if (control.authorityType !== "issuer-backend" && control.authorityType !== "custodian") return null;
  const slug = control.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `issuer-backend:${assetId}:${slug || "unlabeled"}`;
}

function canonicalAuthorityType(assetId: string, control: MintAuthorityControl): ControlOverlay["authority"] {
  const authorityKey = control.address
    ? `${control.chain ?? "chain-unresolved"}:${control.address.toLowerCase()}`
    : (control.failureDomainKeys?.[0] ?? issuerAuthorityKey(assetId, control));
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

function mintCapabilities(control: MintAuthorityControl, upgradeCapable: boolean): ControlOverlay["capabilities"] {
  const capabilities = new Set<ControlOverlay["capabilities"][number]>();
  if (["direct", "cap-limited", "can-authorize"].includes(control.directMintAbility)) capabilities.add("mint");
  if (control.directMintAbility === "upgrade-only" || upgradeCapable) capabilities.add("upgrade");
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
  const issuerKey = issuerAuthorityKey(assetId, control);
  const exactKeys = control.failureDomainKeys?.length
    ? control.failureDomainKeys
    : control.address
      ? [`${control.chain ?? "chain-unresolved"}:${control.address.toLowerCase()}`]
      : issuerKey
        ? [issuerKey]
        : [];
  return [...new Set(exactKeys)].sort(compareText).map((key) => ({ kind, key: key || `asset:${assetId}` }));
}

function adaptMintControl(
  assetId: string,
  control: MintAuthorityControl,
  index: number,
  incidents: MintAuthorityProfile["mintIncidents"],
  reviewComplete: boolean,
  upgradeCapable: boolean,
  hasSeparateCapRaiser: boolean,
  reviewedEconomicCapSemantics: MintAuthorityEconomicCapSemantics | undefined,
): ControlOverlay {
  const controlKind = mintControlKind(control);
  const capabilities = mintCapabilities(control, upgradeCapable);
  const hasMint = capabilities.includes("mint");
  const capped = control.directMintAbility === "cap-limited" || control.canRaiseCap === true;
  // A reviewed economic cap supersedes the contract-encoding cap for a
  // mint-capable control (owner USDC verdict): economic reality overrides the
  // on-chain cap without falsifying directMintAbility. It only applies where the
  // control actually mints and the reviewed value is decided.
  const reviewedCap =
    hasMint && reviewedEconomicCapSemantics && reviewedEconomicCapSemantics !== "unknown"
      ? reviewedEconomicCapSemantics
      : null;
  const capSemantics: ControlOverlay["capSemantics"] = (() => {
    if (!hasMint) return { kind: "not-applicable", bound: null };
    // "bounded" carries no authored numeric ceiling, so it uses the maximal
    // schema-valid supply-fraction marker; scoring keys off the kind, not the
    // bound value.
    if (reviewedCap === "unbounded") return { kind: "unbounded", bound: null };
    if (reviewedCap === "raiseable") return { kind: "raiseable", bound: null };
    if (reviewedCap === "bounded") return { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } };
    if (control.directMintAbility === "direct") return { kind: "unbounded", bound: null };
    if (capped) {
      // Reviewed caps exist but the campaign records raise authority, not the
      // numeric bound, so a raiseable cap is the strongest claimable state.
      return control.canRaiseCap === true || hasSeparateCapRaiser
        ? { kind: "raiseable", bound: null }
        : { kind: "unknown", bound: null };
    }
    return control.directMintAbility === "can-authorize"
      ? { kind: "unbounded", bound: null }
      : { kind: "unknown", bound: null };
  })();
  const claimImpairment: ControlOverlay["claimImpairment"] = (() => {
    if (hasMint) {
      if (reviewedCap === "unbounded") return "unbounded";
      if (reviewedCap === "raiseable" || reviewedCap === "bounded") return "bounded";
      return capped ? "bounded" : "unbounded";
    }
    if (capabilities.includes("upgrade") || capabilities.includes("bridge-mint")) return "unbounded";
    if (capabilities.includes("parameter-change")) return "bounded";
    return "none";
  })();
  const economicLossScope: ControlOverlay["economicLossScope"] =
    claimImpairment === "none" ? "access-only" : "global-claim";
  const incidentState: ControlOverlay["incidentState"] = incidents?.some((incident) => incident.status === "active")
    ? "active"
    : incidents?.some((incident) => incident.status === "resolved")
      ? "resolved"
      : reviewComplete
        ? "none"
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
    authority: canonicalAuthorityType(assetId, control),
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
  reserveSlices: readonly ReserveSlice[] | undefined,
): string[] {
  const mappedWeightByUpstream = new Map<string, number>();
  for (const slice of reserveSlices ?? []) {
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
  const reconciliationSlices =
    derived.source === "curated-reserve" && liveReserveSlices === undefined ? meta.reserves : liveReserveSlices;
  issueCodes.push(...collateralExposureMappingIssues(validEdges, reconciliationSlices));
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
        graphState: dependencyReviewUnresolved ? "unresolved" : issueCodes.length > 0 ? "invalid" : "valid",
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

function accessEvidenceObservationState(reviewedAt: string, clockSec: number): "current" | "stale" {
  const reviewedAtSec = Date.parse(`${reviewedAt}T00:00:00.000Z`) / 1_000;
  if (!Number.isFinite(reviewedAtSec)) throw new Error("Safety Score v9 access review has an invalid review date");
  if (reviewedAtSec > clockSec) throw new Error("Safety Score v9 access review is later than the scoring clock");
  return clockSec - reviewedAtSec <= V9_ACCESS_EVIDENCE_MAX_AGE_SEC ? "current" : "stale";
}

function transferMaterialScope(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  meta: V9ExtensionRegistryMeta,
): SafetyScoreV9TransferMaterialScope {
  const rows = fixedInput.chainCirculatingById[assetId] ?? {};
  const totalSupplyUsd = Object.values(rows).reduce((sum, row) => sum + row.current, 0);
  if (totalSupplyUsd <= 0) {
    return {
      authoritativeDeploymentKeys: [],
      materialDeploymentKeys: [],
      materialDeploymentScopeComplete: false,
    };
  }

  const supplyByChainId = new Map<string, number>();
  let unresolvedSupplyUsd = 0;
  for (const [chain, row] of Object.entries(rows)) {
    const chainId = resolveChainId(chain);
    if (chainId === null) {
      unresolvedSupplyUsd += row.current;
    } else {
      supplyByChainId.set(chainId, (supplyByChainId.get(chainId) ?? 0) + row.current);
    }
  }
  const authoritativeDeployments = (meta.contracts ?? []).flatMap((deployment) => {
    const chainId = resolveChainId(deployment.chain);
    return chainId === null ? [] : [{ chainId, key: safetyScoreV9TransferDeploymentKey(chainId, deployment.address) }];
  });
  const authoritativeDeploymentKeys = [...new Set(authoritativeDeployments.map(({ key }) => key))].sort(compareText);
  const deploymentsByChainId = new Map<string, string[]>();
  for (const deployment of authoritativeDeployments) {
    deploymentsByChainId.set(deployment.chainId, [
      ...(deploymentsByChainId.get(deployment.chainId) ?? []),
      deployment.key,
    ]);
  }
  const materialChainIds = [...supplyByChainId.entries()]
    .filter(([, supplyUsd]) => supplyUsd / totalSupplyUsd >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD)
    .map(([chainId]) => chainId)
    .sort(compareText);
  const materialDeploymentKeys = [
    ...new Set(materialChainIds.flatMap((chainId) => deploymentsByChainId.get(chainId) ?? [])),
  ].sort(compareText);
  return {
    authoritativeDeploymentKeys,
    materialDeploymentKeys,
    materialDeploymentScopeComplete:
      unresolvedSupplyUsd / totalSupplyUsd < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD &&
      materialChainIds.length > 0 &&
      materialChainIds.every((chainId) => (deploymentsByChainId.get(chainId)?.length ?? 0) > 0),
  };
}

function adaptAccessReview(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
  evidence: ReviewEvidenceBuilder,
  transferReview: SafetyScoreV9ReviewedTransferFact | undefined,
  materialScope: SafetyScoreV9TransferMaterialScope,
  clockSec: number,
): ExtensionAsset["accessReview"] {
  const review: BlacklistabilityReview | undefined = meta.blacklistabilityReview;
  if (!review && !transferReview) return null;

  const transferResolution = transferReview
    ? resolveSafetyScoreV9ReviewedTransferFact(transferReview, clockSec, materialScope)
    : null;
  const transferEvidenceKeys = transferReview
    ? evidence.add({
        componentKeys: ["access:transfer"],
        sourceId: "safety-score-v9.reviewed-transfer-overlay",
        reviewedAt: transferReview.reviewedAt,
        confidence: "manual-review",
        sources: transferReview.deployments.flatMap((deployment) => deployment.sources),
        payload: transferReview,
        maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
      })
    : [];

  const blacklistFreshness = review ? accessEvidenceObservationState(review.reviewedAt, clockSec) : null;
  const blacklistEvidenceKeys = review
    ? evidence.add({
        // The blacklist fact owns freeze posture. Its transfer binding remains
        // only as the compatibility fallback when no dedicated fact exists.
        componentKeys: [
          ...(transferReview ? [] : ["access:transfer"]),
          "access:freeze",
          `access:freeze:blacklist:${meta.id}`,
        ],
        sourceId: "stablecoin-meta.blacklistability-review",
        reviewedAt: review.reviewedAt,
        confidence: "manual-review",
        sources: review.sources,
        payload: review,
        maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
      })
    : [];
  const status = review?.reviewedStatus;
  const inheritedFrom = meta.mintAuthority?.inheritedFrom ?? meta.variantOf ?? null;
  const inheritedResolvable = inheritedFrom !== null && metaById.has(inheritedFrom);
  const freezeKnown = status === true || status === false;
  const freezeState =
    blacklistFreshness === "stale" ? "stale" : freezeKnown ? "known" : review ? "bounded-unknown" : "missing";
  const legacyTransferState =
    status === false || review === undefined
      ? "missing"
      : blacklistFreshness === "stale"
        ? "stale"
        : status === true
          ? "known"
          : "bounded-unknown";
  const transferState = transferResolution?.observationState ?? legacyTransferState;
  const transferPosture = transferResolution
    ? transferResolution.posture
    : legacyTransferState === "known"
      ? "restrictable"
      : null;
  const freezeReview =
    review === undefined || (status === "inherited" && !inheritedResolvable)
      ? []
      : [
          {
            reviewKey: `blacklist:${meta.id}`,
            source: status === "inherited" ? ("upstream" as const) : ("blacklist" as const),
            status: requiredStatus(
              "v9.access.freeze-review",
              freezeState,
              `access-freeze:${meta.id}`,
              blacklistEvidenceKeys,
            ),
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
        transferState,
        `access-transfer:${meta.id}`,
        transferReview ? transferEvidenceKeys : legacyTransferState === "missing" ? [] : blacklistEvidenceKeys,
      ),
      posture: transferPosture,
    },
    freeze: {
      status: requiredStatus(
        "v9.access.freeze-review",
        freezeState,
        `access-freeze:${meta.id}`,
        review ? blacklistEvidenceKeys : [],
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

function buildPegReference(meta: V9ExtensionRegistryMeta): ExtensionAsset["pegReference"] {
  // Pure NAV tokens track fund NAV by design: they have no fixed peg to
  // deviate from, so the peg fact is published not-applicable (the v8 pure
  // NAV carve-over) instead of failing on a missing peg reference.
  if (meta.flags?.navToken === true) {
    return { referenceKind: "nav", referenceKey: `nav:${meta.id}`, failureDomains: [] };
  }
  const pegCurrency = meta.flags?.pegCurrency;
  if (pegCurrency === undefined) return null;
  if (pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return { referenceKind: "other", referenceKey: `unreviewed:${pegCurrency.toLowerCase()}`, failureDomains: [] };
  }
  if (pegCurrency === "GOLD" || pegCurrency === "SILVER") {
    return {
      referenceKind: "asset",
      referenceKey: pegCurrency === "GOLD" ? "commodity:xau" : "commodity:xag",
      failureDomains: [],
    };
  }
  return { referenceKind: "fiat", referenceKey: pegCurrency, failureDomains: [] };
}

const ORACLE_FREE_ARCHETYPES = new Set(["fiat-cash", "tbill", "rwa-credit-fund"]);

function adaptOracleReview(
  meta: V9ExtensionRegistryMeta,
  archetype: string,
  evidence: ReviewEvidenceBuilder,
): NonNullable<ExtensionAsset["economicControlReview"]>["oracle"] {
  const profile: OracleRiskProfile | undefined = meta.oracleRisk;
  if (!profile?.reviewedAt || !profile.reviewer || !profile.confidence) {
    if (!profile && ORACLE_FREE_ARCHETYPES.has(archetype)) {
      return {
        status: notApplicableStatus(
          "v9.control.oracle-review",
          `The ${archetype} mechanism archetype has no oracle- or liquidation-dependent stabilization path.`,
          [],
        ),
        tier: null,
        branches: [],
      };
    }
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

function bridgeControl(
  assetId: string,
  route: BridgeRouteDeployment,
  materialSupplyShare: number | null,
): ControlOverlay | null {
  if (route.routeClass === "native" || route.issuanceModel === "native-issuance") return null;
  const capabilities: ControlOverlay["capabilities"] =
    route.issuanceModel === "bridge-representation" || route.issuanceModel === "wrapped-representation"
      ? ["bridge-mint"]
      : [];
  const authorityKey = route.controllerAddress
    ? `${route.controllerChain}:${route.controllerAddress.toLowerCase()}`
    : (route.failureDomainKeys?.[0] ?? `bridge-route:${route.id}`);
  const mintsRepresentation = capabilities.includes("bridge-mint");
  const reviewed = route.reviewDisposition === "reviewed";
  return {
    controlKey: `bridge-meta:${assetId}:${digest("safety-score-v9.bridge-control-key.v1", route.id).slice(0, 20)}`,
    deploymentKey: route.id,
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
    incidentState: reviewed ? "none" : "unknown",
    failureDomains: (route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id])
      .map((key) => ({ kind: "bridge-route" as const, key }))
      .sort((left, right) => compareText(left.key, right.key)),
  };
}

function unmatchedBridgeControl(
  assetId: string,
  route: NonNullable<ExtensionAsset["supplyReview"]>["selectedBridgeRoutes"][number],
): ControlOverlay {
  return {
    controlKey: `bridge-supply:${assetId}:${digest("safety-score-v9.unmatched-bridge-control-key.v1", route.deploymentRouteKey).slice(0, 20)}`,
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
    incidentState: "unknown",
    failureDomains: [{ kind: "bridge-route", key: route.deploymentRouteKey }],
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

  const controlCounts = new Map<string, number>();
  const controlsByDeployment = new Map<string, ControlOverlay>();
  for (const control of controls) {
    controlCounts.set(control.deploymentKey, (controlCounts.get(control.deploymentKey) ?? 0) + 1);
    controlsByDeployment.set(control.deploymentKey, control);
  }
  if ([...controlCounts.values()].some((count) => count !== 1)) return false;

  const exactRowsByDeployment = new Map(rows.map((row) => [row.deploymentRouteKey, row]));
  for (const row of rows) {
    if (row.reviewState === "selected-reviewed") continue;
    const control = controlsByDeployment.get(row.deploymentRouteKey);
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
    const chain = canonicalRouteChain(row.deploymentRouteKey);
    if (chain !== null) presentCanonicalChains.add(chain);
  }

  for (const route of profileRoutes) {
    if (route.reviewDisposition === "reviewed") continue;
    if (exactRowsByDeployment.has(route.id)) continue;
    const chain = canonicalRouteChain(route.id);
    const control = controlsByDeployment.get(route.id);
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

function adaptBridgeReview(
  meta: V9ExtensionRegistryMeta,
  supplyReview: ExtensionAsset["supplyReview"],
  deployedChainCount: number,
  evidence: ReviewEvidenceBuilder,
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
  const evidenceKeys = evidence.add({
    componentKeys: ["economic-control:bridge", "control"],
    sourceId: "stablecoin-meta.bridge-route-risk",
    reviewedAt: profile.reviewedAt,
    confidence,
    sources: profile.sources,
    payload: profile,
  });
  const profileRoutes = profile.routes ?? [];
  const reviewedRoutes = profileRoutes.filter((route) => route.reviewDisposition === "reviewed");
  // Keep every non-native route as a control fact so exact deployment shares
  // remain available even when the route review itself is unresolved.
  const profileControls = profileRoutes
    .map((route) => bridgeControl(meta.id, route, safetyScoreV9RouteSupplyShare(supplyReview ?? null, route.id)))
    .filter((control): control is ControlOverlay => control !== null);
  const unmatchedControls = (supplyReview?.selectedBridgeRoutes ?? [])
    .filter((route) => route.reviewState === "unmatched")
    .map((route) => unmatchedBridgeControl(meta.id, route));
  const controls = [...profileControls, ...unmatchedControls];
  const controlsByDeployment = new Map(controls.map((control) => [control.deploymentKey, control]));
  const routes = reviewedRoutes.flatMap((route) => {
    const control = controlsByDeployment.get(route.id);
    return control ? [{ controlKey: control.controlKey, tier: route.riskTier }] : [];
  });
  if (controls.length === 0) {
    return {
      review: {
        status: notApplicableStatus(
          "v9.control.bridge-review",
          "Every reviewed deployment route is native issuance; no bridge control carries the claim.",
          evidenceKeys,
        ),
        routes: [],
      },
      controls: [],
    };
  }
  const allMaterialRoutesReviewed = hasCompleteSubthresholdBridgeInventory(profileRoutes, controls, supplyReview);
  const state =
    allMaterialRoutesReviewed && reviewedObservationState(confidence) === "known" ? "known" : "bounded-unknown";
  return {
    review: {
      status: requiredStatus("v9.control.bridge-review", state, `bridge:${meta.id}`, evidenceKeys),
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
        supervision: "unknown",
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
  const reviewComplete =
    profile.review.disposition !== "unresolved" &&
    (profile.review.unresolvedQuestions?.length ?? 0) === 0 &&
    reviewedObservationState(confidence) === "known";
  const upgradeability = profile.upgradeability;
  const controls =
    profile.review.disposition === "unresolved"
      ? []
      : (profile.controls ?? []).map((control, index, allControls) =>
          adaptMintControl(
            meta.id,
            control,
            index,
            profile.mintIncidents,
            reviewComplete,
            upgradeability?.canChangeMintLogic === true && upgradeability.controlRef === control.label,
            control.directMintAbility === "cap-limited" &&
              control.canRaiseCap === false &&
              allControls.some(
                (candidate, candidateIndex) =>
                  candidateIndex !== index && candidate.chain === control.chain && candidate.canRaiseCap === true,
              ),
            profile.economicCapSemantics,
          ),
        );
  const mintControl = controls.find((control) => control.capabilities.includes("mint")) ?? null;
  const referencedUpgradeIndex =
    upgradeability?.controlRef == null
      ? -1
      : (profile.controls ?? []).findIndex((control) => control.label === upgradeability.controlRef);
  const referencedUpgrade = referencedUpgradeIndex >= 0 ? (controls[referencedUpgradeIndex] ?? null) : null;
  const reviewedUpgradeControl =
    referencedUpgrade?.capabilities.includes("upgrade") === true
      ? referencedUpgrade
      : (controls.find((control) => control.capabilities.includes("upgrade")) ?? null);
  const upgrade =
    upgradeability?.model === "immutable" && upgradeability.canChangeMintLogic === false
      ? { state: "immutable" as const, controlKey: null }
      : reviewedUpgradeControl !== null
        ? { state: "reviewed" as const, controlKey: reviewedUpgradeControl.controlKey }
        : { state: "unknown" as const, controlKey: null };
  const issuerBackendMint = mintControl?.authority?.model === "issuer-backend";
  const inferredReconciliation: NonNullable<ExtensionAsset["economicControlReview"]>["mint"]["reconciliation"] =
    mintControl === null
      ? upgrade.state === "immutable"
        ? "not-applicable"
        : "unknown"
      : issuerBackendMint
        ? meta.proofOfReserves?.latestReport || meta.proofOfReserves?.cadence
          ? "periodic"
          : "unknown"
        : "not-applicable";
  // A reviewed reconciliation cadence supersedes the inferred one; absent or
  // "unknown" keeps the inference (fail-closed inertness).
  const reconciliation =
    profile.reconciliation && profile.reconciliation !== "unknown" ? profile.reconciliation : inferredReconciliation;
  const immutableWithoutMint = mintControl === null && upgrade.state === "immutable";
  const state = !reviewComplete
    ? profile.review.disposition === "unresolved" || reviewedObservationState(confidence) === "missing"
      ? "missing"
      : "bounded-unknown"
    : reconciliation === "unknown" && (issuerBackendMint || (mintControl === null && !immutableWithoutMint))
      ? "bounded-unknown"
      : "known";
  return {
    review: {
      status: requiredStatus(
        "v9.control.mint-review",
        state,
        `mint:${meta.id}`,
        state === "known" || state === "bounded-unknown" ? evidenceKeys : [],
      ),
      controlKey: mintControl?.controlKey ?? null,
      reconciliation,
      // A reviewed prudential-supervision fact graduates the reconciled mint
      // rung; absent or "unknown" stays fail-closed at "unknown".
      supervision: profile.supervision && profile.supervision !== "unknown" ? profile.supervision : "unknown",
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
  const reviewedTransferFacts = options.reviewedTransferFacts ?? SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS;
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
  const researchOverlaysGenerationDigest = digest("safety-score-v9.research-overlays.v3", {
    registryRevision: fixedInput.registryRevision,
    mechanismReviewOverlaysDigest: SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
    reviewedTransferFactsDigest: computeSafetyScoreV9ReviewedTransferFactsDigest(reviewedTransferFacts.values()),
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
      generationId: `research-overlays:v3:${researchOverlaysGenerationDigest}`,
      observedAtSec: registryObservedAtSec,
      // Curated mechanism/reserve/route overlays re-bound after twelve months,
      // consistent with the D1 overlay standard and the mechanism-overlay
      // expiry gate (VER2-004). Registry-observed overlays stay current well
      // inside this window, so the current cohort is unaffected.
      maxAgeSec: 31_536_000,
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
      documentedTermsMaxAgeSec: SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec,
    },
    assets: fixedInput.activeAssetIds.map((assetId) => {
      const meta = metaById.get(assetId)!;
      const prepared = preparedById.get(assetId)!;
      const cycle = cycleByAsset.get(assetId);
      const archetype = resolveMechanismArchetype(meta, metaById) ?? "unresolved";
      const liveReserves = fixedInput.liveReserveMap[assetId] ?? [];
      const issuerAttestedReserveRows =
        liveReserves.length === 0 ? buildSafetyScoreV9IssuerAttestedReserveRows(meta, clockSec) : null;
      const reserveRows = issuerAttestedReserveRows?.rows ?? liveReserves;
      const reviewEvidence = new ReviewEvidenceBuilder(assetId, clockSec);
      const mechanismRiskReview = buildSafetyScoreV9MechanismReview(fixedInput, meta, archetype);
      const mechanismOverlayEvidence = getSafetyScoreV9MechanismOverlayEvidence(assetId, archetype, clockSec);
      if (mechanismRiskReview && mechanismOverlayEvidence) {
        reviewEvidence.add({
          componentKeys: ["mechanism-risk-review"],
          sourceId: "safety-score-v9.mechanism-review-overlay",
          reviewedAt: mechanismOverlayEvidence.reviewedAt,
          confidence: "manual-review",
          sources: mechanismOverlayEvidence.sources,
          payload: mechanismOverlayEvidence.payload,
          maxAgeSec: mechanismOverlayEvidence.maxAgeSec,
        });
      }
      const reserveClassifications = buildReviewedReserveClassifications(reserveRows, meta, clockSec);
      addReserveClassificationEvidence(meta, reserveClassifications, reviewEvidence);
      addIssuerAttestedReserveEvidence(meta, issuerAttestedReserveRows, reviewEvidence);
      addDependencyEvidence(meta, reviewEvidence);
      const supplyReview = buildSafetyScoreV9SupplyReview(fixedInput, assetId, meta.bridgeRouteRisk);
      const deployedChainCount = Object.keys(fixedInput.chainCirculatingById[assetId] ?? {}).length;
      const assetIssuerKey = resolveSafetyScoreV9AssetIssuerKey(assetId, metaById);
      const mint = adaptMintReview(meta, reviewEvidence);
      const oracle = adaptOracleReview(meta, archetype, reviewEvidence);
      const bridge = adaptBridgeReview(meta, supplyReview, deployedChainCount, reviewEvidence);
      const controls = [...mint.controls, ...bridge.controls].sort((left, right) =>
        compareText(left.controlKey, right.controlKey),
      );
      const accessReview = adaptAccessReview(
        meta,
        metaById,
        reviewEvidence,
        reviewedTransferFacts.get(assetId),
        transferMaterialScope(fixedInput, assetId, meta),
        clockSec,
      );
      const reviewedEvidence = reviewEvidence.finish();
      const controlsFullyResolved =
        controls.length > 0 &&
        controls.every(
          (control) =>
            control.economicLossScope === "access-only" ||
            (control.economicLossScope === "deployment" &&
              control.materialSupplyShare !== null &&
              control.materialSupplyShare < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD) ||
            (control.capSemantics.kind !== "unknown" &&
              control.claimImpairment !== "unknown" &&
              control.economicLossScope !== "unknown" &&
              control.incidentState !== "unknown" &&
              control.authority !== null &&
              control.authority.model !== "unknown"),
        );
      return {
        assetId,
        assetIssuerKey,
        archetype,
        launchedAtSec: conservativeDateEndSec(meta.implementationLaunchDate ?? meta.launchDate, clockSec),
        mechanismRiskReview,
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
        reserveClassifications,
        issuerAttestedReserveRows,
        routeReviews: buildSafetyScoreV9RouteReviews(fixedInput, assetId),
        retainedRoutes: buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput, assetId),
        controlReview:
          controls.length > 0
            ? controlsFullyResolved
              ? { state: "reviewed-controls", controls }
              : {
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
        pegReference: buildPegReference(meta),
        supplyReview,
        ...reviewedEvidence,
      };
    }),
  };
}
