import type { ProofOfReservesLatestReport, StablecoinMeta } from "@shared/types/core";
import type {
  V9FiatCashMechanismRiskReview,
  V9MechanismFactV1,
  V9MechanismQualityLevel,
  V9MechanismRiskReview,
  V9TbillMechanismRiskReview,
} from "@shared/types/safety-score-v9-backing";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";

type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

const MECHANISM_POLICY_RULE_ID = "v9.backing.mechanism-review";

function status(observationState: V9FactStatusV2["observationState"], componentKey: string): V9FactStatusV2 {
  // The fact-set compiler rebinds these statuses to the research-overlay
  // evidence reference; the extension-level ids only carry the fact state.
  const requiresEvidence =
    observationState === "known" || observationState === "stale" || observationState === "bounded-unknown";
  return {
    applicability: { state: "required", policyRuleId: MECHANISM_POLICY_RULE_ID, rationale: null, gapId: null },
    observationState,
    evidenceRefIds: requiresEvidence ? [`extension-evidence:mechanism:${componentKey}`] : [],
    gapIds: observationState === "known" ? [] : [`extension-gap:mechanism:${componentKey}`],
  };
}

function boundedFact(componentKey: string, hasEvidence: boolean): V9MechanismFactV1 {
  return {
    status: status(hasEvidence ? "bounded-unknown" : "missing", componentKey),
    quality: null,
    failureDomains: [],
  };
}

function knownFact(componentKey: string, quality: V9MechanismQualityLevel): V9MechanismFactV1 {
  return { status: status("known", componentKey), quality, failureDomains: [] };
}

/**
 * Quality of the assurance-and-reconciliation component from the reviewed
 * latest proof-of-reserves report. The tiers restate the report's own
 * assurance method; they do not add judgment beyond the recorded review.
 */
function assuranceQuality(report: ProofOfReservesLatestReport): V9MechanismQualityLevel {
  if (report.confidence === "unknown") return "limited";
  if (report.assuranceMethod === "audit" || report.assuranceMethod === "examination") {
    return report.scope === "assets-and-liabilities" ? "strong" : "adequate";
  }
  if (
    report.assuranceMethod === "attestation" ||
    report.assuranceMethod === "review" ||
    report.assuranceMethod === "agreed-upon-procedures"
  ) {
    return report.scope === "assets-and-liabilities" ? "adequate" : "limited";
  }
  if (report.assuranceMethod === "onchain-proof") return "adequate";
  return "weak";
}

function assuranceFact(meta: MechanismMeta): V9MechanismFactV1 {
  const report = meta.proofOfReserves?.latestReport;
  if (report) return knownFact("assurance-and-reconciliation", assuranceQuality(report));
  return boundedFact("assurance-and-reconciliation", meta.proofOfReserves !== undefined);
}

function hasReserveEvidence(fixedInput: Readonly<ReportCardsFixedInput>, meta: MechanismMeta): boolean {
  return (
    (fixedInput.liveReserveMap[meta.id] ?? []).length > 0 ||
    (meta.reserves?.length ?? 0) > 0 ||
    meta.reserveReview !== undefined
  );
}

function buildFiatCashReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  meta: MechanismMeta,
): V9FiatCashMechanismRiskReview | null {
  const reserves = hasReserveEvidence(fixedInput, meta);
  const custody = reserves || meta.custodyProfile !== undefined;
  if (!reserves && !custody && !meta.proofOfReserves) return null;
  return {
    archetype: "fiat-cash",
    claimAndSegregation: boundedFact("claim-and-segregation", reserves || meta.proofOfReserves !== undefined),
    custodyContinuity: boundedFact("custody-continuity", custody),
    assuranceAndReconciliation: assuranceFact(meta),
  };
}

function buildTbillReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  meta: MechanismMeta,
): V9TbillMechanismRiskReview | null {
  const reserves = hasReserveEvidence(fixedInput, meta);
  if (!reserves && !meta.proofOfReserves) return null;
  const maturityEvidence = (fixedInput.liveReserveMap[meta.id] ?? []).some(
    (slice) => slice.maturityDaysMax != null || slice.liquidityHorizon != null,
  );
  return {
    archetype: "tbill",
    fundClaimAndSeniority: boundedFact("fund-claim-and-seniority", reserves || meta.proofOfReserves !== undefined),
    navValuation: boundedFact("nav-valuation", reserves || meta.proofOfReserves !== undefined),
    durationAndLiquidity: boundedFact("duration-and-liquidity", maturityEvidence || reserves),
    lossRecoveryDesign: assuranceFact(meta),
  };
}

/**
 * Builds the conservative mechanism risk review the exact evidence supports.
 * Components with dated reserve/assurance evidence are bounded-unknown at the
 * policy's bounded quality; only the assurance component claims a reviewed
 * quality, restated from the recorded proof-of-reserves report. Archetypes
 * whose review requires measured mechanism ratios (CDP, synthetic,
 * algorithmic, RWA credit) remain absent until a curated review exists.
 */
export function buildSafetyScoreV9MechanismReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  meta: MechanismMeta,
  archetype: string,
): V9MechanismRiskReview | null {
  if (archetype === "fiat-cash") return buildFiatCashReview(fixedInput, meta);
  if (archetype === "tbill") return buildTbillReview(fixedInput, meta);
  return null;
}
