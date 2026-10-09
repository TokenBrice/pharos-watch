import rawRegistry from "@shared/data/safety-score-v9/reserve-bound-facts-v1.json";
import { ReserveBoundedFactSchema, type ReserveBoundedFact, type V9ReserveBoundedFact } from "@shared/types/reserve-bounded-facts";
import type { ReserveSlice } from "@shared/types/reserves";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { createV9EvidenceReference, createV9FactStatus, requiredV9Applicability } from "@shared/lib/safety-score-v9/evidence";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { reserveBoundScopeKey, reserveBoundTermDays } from "@shared/lib/safety-score-v9/reserve-bound-facts";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { maximumBusinessDaySettlement } from "@shared/lib/business-calendars";
import { addEvidence, addGap, type AssetBuildContext } from "./fact-set-context";
import { computeSafetyScoreV9ReserveExposureKey } from "./fact-set-schema";
import type { ReserveLossLineage } from "@shared/types/live-reserves";
import { isCarryEligible } from "@shared/lib/evidence-loss";

export const SAFETY_SCORE_V9_RESERVE_BOUND_FACTS_DIGEST = domainDigest("safety-score-v9.reserve-bound-facts.v1", rawRegistry);
// Validate rows per asset in the baseline builder; one malformed entry never rejects the cohort.
const registry = rawRegistry as { schemaVersion: number; assets: Record<string, unknown[]> };
if (registry.schemaVersion !== 1 || !registry.assets || Array.isArray(registry.assets)) throw new Error("Invalid bounded reserve registry envelope");
interface ReserveBoundAdmissionContext {
  clockSec: number;
  liveProvenance?: AssetBuildContext["fixedInput"]["liveReserveProvenanceMap"][string];
  liveMaxAgeSec?: AssetBuildContext["extension"]["sources"]["liveReserves"]["maxAgeSec"];
  liveLossLineage?: ReserveLossLineage;
}

/** Selection and compilation share the same generation, identity and freshness gates. */
function admitReserveBound(payload: ReserveBoundedFact, rows: readonly ReserveSlice[], context: ReserveBoundAdmissionContext) {
  const clock = context.clockSec;
  const expiry = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry;
  let fact = payload;
  let rejectionReason: string | null = null;
  let maxAge = payload.kind === "currently-liquid-fraction" ? V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.boundedFacts.currentLiquidFractionMaxAgeSec : payload.kind === "observed-portfolio-maturity" ? expiry.reviewedReserveCompositionMaxAgeSec + expiry.reviewedReserveCompositionGraceSec : expiry.reviewedReserveClassificationMaxAgeSec;
  if (payload.provenance.kind === "producer-observation") {
    maxAge = Math.min(maxAge, payload.provenance.maxAgeSec);
    // Null means the source has no additional freshness cap. The fact's policy,
    // producer and matching retained-run budgets still bound admission.
    if (context.liveMaxAgeSec !== null && context.liveMaxAgeSec !== undefined) maxAge = Math.min(maxAge, context.liveMaxAgeSec);
    const run = context.liveProvenance?.boundedFactsGeneration;
    if (!run || run.sourceGenerationId !== payload.provenance.sourceGenerationId || run.observedAtSec !== payload.asOfSec) rejectionReason = "producer-generation-mismatch";
    else maxAge = Math.min(maxAge, run.maxAgeSec);
    const lineage = context.liveLossLineage;
    if (lineage?.invalidations.composition || lineage?.invalidations["bounds"] || lineage?.invalidations[payload.factKey]
      || (lineage?.latest?.scope.key === "composition" && !isCarryEligible(lineage.latest, clock))) {
      rejectionReason = "producer-scope-invalidated";
    }
  }
  if (fact.scope.kind !== "reserve-envelope") {
    const exposureKey = fact.scope.exposureKey;
    const row = rows.find((entry) => entry.sourceKey === exposureKey) ?? rows.find((entry) => computeSafetyScoreV9ReserveExposureKey(entry) === exposureKey);
    if (!row) rejectionReason = "scope-unmatched";
    else fact = { ...fact, scope: { ...fact.scope, exposureKey: computeSafetyScoreV9ReserveExposureKey(row) } };
    if (fact.kind === "currently-liquid-fraction") {
      if (row?.coinId && row.coinId !== fact.assetId) rejectionReason = "native-asset-identity-mismatch";
      if (payload.provenance.kind === "producer-observation" && !payload.provenance.sourceGenerationId.startsWith(`${fact.chain}:`)) rejectionReason = "chain-generation-mismatch";
    }
  }
  if (payload.provenance.confidence === "low") rejectionReason = "confidence-insufficient";
  if (payload.asOfSec > clock) rejectionReason = "snapshot-future";
  if (payload.provenance.kind === "reviewed-research") {
    const reviewSec = Date.parse(`${payload.provenance.reviewedAt}T00:00:00Z`) / 1000 + 86400;
    if (reviewSec > clock) rejectionReason = "review-day-not-elapsed";
    else if (clock - reviewSec > expiry.reviewedReserveClassificationMaxAgeSec) rejectionReason = "review-stale";
  }
  if (clock - payload.asOfSec > maxAge) rejectionReason = "snapshot-stale";
  if (payload.kind === "business-calendar-liquidity" && !payload.businessDayTerms.conditional && payload.businessDayTerms.assurance === "binding-guarantee") {
    const bound = maximumBusinessDaySettlement(payload.businessDayTerms, clock);
    if (bound.state === "unknown") rejectionReason = `business-calendar-${bound.reason}`;
  }
  return { fact, maxAge, rejectionReason };
}

export function buildSafetyScoreV9ReserveBoundFacts(assetId: string, rows: readonly ReserveSlice[], context: ReserveBoundAdmissionContext): ReserveBoundedFact[] {
  const authored = (registry.assets[assetId] ?? []).map((row) => ReserveBoundedFactSchema.parse(row));
  const live = rows.flatMap((row) => (row.boundedFacts ?? []).map((fact) => {
    const parsed = ReserveBoundedFactSchema.parse(fact);
    if (parsed.provenance.kind !== "producer-observation") throw new Error("Live bounds cannot impersonate reviewed research");
    if (!row.sourceKey || parsed.scope.kind === "reserve-envelope" || parsed.scope.exposureKey !== row.sourceKey) throw new Error("Live bound must match its exact source key");
    return parsed;
  }));
  const byKey = new Map<string, { authored?: ReserveBoundedFact; live?: ReserveBoundedFact }>();
  for (const [lane, facts] of [["authored", authored], ["live", live]] as const) {
    for (const fact of facts) {
      const candidates = byKey.get(fact.factKey) ?? {};
      if (candidates[lane]) throw new Error(`Duplicate canonical key: ${fact.factKey}`);
      candidates[lane] = fact;
      byKey.set(fact.factKey, candidates);
    }
  }
  return [...byKey.values()].flatMap(({ authored: research, live: observation }) => {
    const candidates = [observation, research].filter((fact): fact is ReserveBoundedFact => fact !== undefined).map((payload) => ({ payload, ...admitReserveBound(payload, rows, context) })).filter((candidate) => candidate.rejectionReason !== "snapshot-stale" && candidate.rejectionReason !== "review-stale");
    if (candidates.length === 2) {
      const [first, second] = candidates;
      if (first!.fact.kind !== second!.fact.kind || reserveBoundScopeKey(first!.fact.scope) !== reserveBoundScopeKey(second!.fact.scope) ||
        (first!.fact.kind === "currently-liquid-fraction" && second!.fact.kind === "currently-liquid-fraction" && (first!.fact.assetId !== second!.fact.assetId || first!.fact.chain !== second!.fact.chain || first!.fact.unit !== second!.fact.unit))) {
        throw new Error(`Conflicting bounded reserve identity at ${first!.payload.factKey}`);
      }
    }
    // Live takes precedence only after admission. Keep at most one rejected,
    // non-expired candidate for diagnostics when neither source is admissible.
    const selected = candidates.find((candidate) => candidate.rejectionReason === null) ?? candidates[0];
    return selected ? [selected.payload] : [];
  }).sort((a, b) => a.factKey.localeCompare(b.factKey));
}
export function compileSafetyScoreV9ReserveBoundFacts(context: AssetBuildContext): V9ReserveBoundedFact[] {
  const clock = context.fixedInput.clockSec;
  const expiry = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry;
  const rows = context.fixedInput.liveReserveMap[context.asset.assetId]?.length ? context.fixedInput.liveReserveMap[context.asset.assetId]! : context.asset.reviewedStaticReserveRows?.rows ?? [];
  const bySource = new Map(rows.filter((row) => row.sourceKey).map((row) => [row.sourceKey!, computeSafetyScoreV9ReserveExposureKey(row)]));
  return (context.asset.reserveBoundFacts ?? []).map((payload) => {
    const admission = admitReserveBound(payload, rows, { clockSec: clock, liveProvenance: context.fixedInput.liveReserveProvenanceMap[context.asset.assetId],
      liveLossLineage: "reserveLossLineageById" in context.fixedInput ? context.fixedInput.reserveLossLineageById?.[context.asset.assetId] : undefined,
      liveMaxAgeSec: context.extension.sources.liveReserves.maxAgeSec });
    const { fact, maxAge } = admission;
    let rejectionReason = admission.rejectionReason;
    const producer = payload.provenance.kind === "producer-observation";
    const source = producer ? context.extension.sources.liveReserves : context.extension.sources.researchOverlays;
    // The builder selects canonical revisions before extension validation;
    // compilation rechecks admission for authored/custom extension callers.
    const sameScope = (context.asset.reserveBoundFacts ?? []).filter((other) => {
      const scope = other.scope.kind === "reserve-envelope" ? other.scope : { ...other.scope, exposureKey: bySource.get(other.scope.exposureKey) ?? other.scope.exposureKey };
      return reserveBoundScopeKey(scope) === reserveBoundScopeKey(fact.scope);
    });
    const sameGeneration = sameScope.filter((other) => other.kind === payload.kind && other.asOfSec === payload.asOfSec);
    if (new Set(sameGeneration.map((other) => stableJsonStringifyV1({ ...other, factKey: "", provenance: null }))).size > 1) {
      throw new Error(`Conflicting bounded reserve facts at ${payload.factKey}`);
    }
    if (payload.kind === "contractual-maturity-maximum" && payload.legallyBinding && payload.allInScope) {
      const maximum = reserveBoundTermDays(payload.maximumTerm);
      const violated = sameScope.some((other) => {
        if (other.kind !== "observed-portfolio-maturity" || other.asOfSec > clock || other.provenance.confidence === "low") return false;
        let observationBudget = expiry.reviewedReserveCompositionMaxAgeSec + expiry.reviewedReserveCompositionGraceSec;
        if (other.provenance.kind === "reviewed-research") {
          const reviewedAtSec = Date.parse(`${other.provenance.reviewedAt}T00:00:00Z`) / 1000 + 86400;
          if (reviewedAtSec > clock || clock - reviewedAtSec > expiry.reviewedReserveClassificationMaxAgeSec) return false;
        } else {
          const run = context.fixedInput.liveReserveProvenanceMap[context.asset.assetId]?.boundedFactsGeneration;
          if (!run || run.sourceGenerationId !== other.provenance.sourceGenerationId || run.observedAtSec !== other.asOfSec) return false;
          observationBudget = Math.min(observationBudget, other.provenance.maxAgeSec, run.maxAgeSec, context.extension.sources.liveReserves.maxAgeSec ?? observationBudget);
        }
        return clock - other.asOfSec <= observationBudget &&
          ((other.observedMaximumDays !== null && other.observedMaximumDays > maximum) || other.instruments.some((instrument) => instrument.maturityAtSec !== null && Math.ceil((instrument.maturityAtSec - other.asOfSec) / 86400) > maximum));
      });
      if (violated) rejectionReason = "contract-observation-contradiction";
    }
    // Producer source generation identifies the retained capture run; payload retains the exact block/API identity.
    const evidenceId = `${context.asset.assetId}:reserve-bound:${payload.factKey}`;
    addEvidence(context, createV9EvidenceReference({ evidenceId, sourceId: producer && payload.provenance.kind === "producer-observation" ? payload.provenance.sourceId : "reserve-bound-facts-reviewed", sourceGenerationId: source.generationId, disposition: rejectionReason === null ? "observed" : "rejected", observedAtSec: Math.min(payload.asOfSec, clock), publishedAtSec: null, url: payload.sourceUrls[0]!, contentSha256: domainDigest("safety-score-v9.reserve-bound-evidence.v1", payload), maxAgeSec: maxAge, rejection: rejectionReason === null ? null : { code: rejectionReason, reason: rejectionReason, rejectedAtSec: clock } }, clock));
    let gapIds: string[] = [];
    if (rejectionReason !== null) gapIds = [addGap(context, createV9FactGapV3({ gapId: `${evidenceId}:unavailable`, reasonCode: "unreviewed-reserve-envelope", ownerDomain: "backing", policyRuleId: "v9.backing.reserve-bounds", observationState: "unsupported", responsibility: producer ? "producer-failed" : "method-unsupported", path: { kind: "local-component", componentKey: `reserve-bound:${payload.factKey}` }, message: rejectionReason, evidenceRefIds: [evidenceId] }))];
    return { fact, status: createV9FactStatus({ applicability: requiredV9Applicability("v9.backing.reserve-bounds"), observationState: rejectionReason === null ? "known" : "unsupported", evidenceRefIds: [evidenceId], gapIds }), sourceGenerationId: source.generationId, freshnessMaxAgeSec: maxAge, rejectionReason };
  });
}
