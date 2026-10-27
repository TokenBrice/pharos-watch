import { z } from "zod";
import { SafetyScoreV9ResolvedCurrentCardSchema, type SafetyScoreV9CurrentCard } from "../types/safety-score-v9-public";
import { resolveV9PublicWitnessTexts } from "../types/safety-score-v9-public-witness-texts";
import {
  ReportCardsV9TableResponseSchema, ReportCardsV9DetailResponseSchema,
  ReportCardsV9TableCardSchema, ReportCardsV9NeighborhoodCardSchema,
  V9_SITE_PROJECTION_VERSION, type ReportCardsV9TableCard, type ReportCardsV9ProjectionSource,
  type ReportCardsV9TableResponse, type ReportCardsV9DetailResponse,
} from "../types/report-cards-v9-projections";
import { buildReportCardsV9DependencyGraph, type ReportCardsV9DependencyGraph } from "../types/report-cards-v9";
import { projectV9CompactPartialEvidence, projectV9EvidencePillars } from "../types/safety-score-v9-causes";
import { resolveCommonModeEffects } from "../types/dependency-graph";

function resolvedDependencyGraph(snapshot: ReportCardsV9ProjectionSource): ReportCardsV9DependencyGraph {
  return buildReportCardsV9DependencyGraph(snapshot.cards.map(card => ({
    id: card.id, dependencies: resolveV9PublicWitnessTexts(card).dependencies,
  })));
}

export function projectV9TableCard(card: SafetyScoreV9CurrentCard): ReportCardsV9TableCard {
  const resolved = resolveV9PublicWitnessTexts(card);
  const component = resolved.breakdowns?.control.components.find(row => row.kind === "mint");
  return {
    id: resolved.id, score: resolved.score, grade: resolved.grade, ratingStatus: resolved.ratingStatus,
    partialEvidence: projectV9CompactPartialEvidence(resolved.partialEvidence),
    pillars: projectV9EvidencePillars(resolved.pillars, resolved.scoreTrace.aggregation?.pricedUnknownPillars),
    evidence: { level: resolved.evidence.level },
    weakestPillar: resolved.weakestPillar, bindingCap: resolved.bindingCap,
    accessPosture: { freezeExposure: resolved.accessPosture.freezeExposure },
    nrReasons: resolved.nrReasons, reasonCodes: resolved.reasonCodes,
    mint: component && component.score !== null ? { score: component.score, posture: component.posture } : null,
  };
}
function envelope(snapshot: ReportCardsV9ProjectionSource) {
  return {
    projectionVersion: V9_SITE_PROJECTION_VERSION,
    model: snapshot.model, lifecycle: snapshot.lifecycle, schemaVersion: snapshot.schemaVersion,
    safetyScoreIdentity: snapshot.safetyScoreIdentity, methodology: snapshot.methodology,
    asOfSec: snapshot.asOfSec, updatedAt: snapshot.updatedAt, source: snapshot.source,
    completeness: snapshot.completeness, publicationHealth: snapshot.publicationHealth,
  } as const;
}
export function projectV9Table(snapshot: ReportCardsV9ProjectionSource): ReportCardsV9TableResponse {
  return ReportCardsV9TableResponseSchema.parse({
    ...envelope(snapshot), projection: "table", cards: snapshot.cards.map(projectV9TableCard),
    dependencyGraph: resolvedDependencyGraph(snapshot),
  });
}

export function projectV9DetailNeighborhoodCard(card: SafetyScoreV9CurrentCard): ReportCardsV9DetailResponse["neighborhood"][number] {
  return {
    id: card.id, grade: card.grade, partialEvidence: projectV9CompactPartialEvidence(card.partialEvidence), sharedBookId: card.sharedBookId,
    ratingStatus: card.ratingStatus, pillars: projectV9EvidencePillars(card.pillars, card.scoreTrace.aggregation?.pricedUnknownPillars),
  };
}

/** Admits every per-card public representation (resolved full, table and
 * detail-neighborhood rows) before publication stores the card, so a card one
 * representation rejects is quarantined alone instead of blocking deferred
 * materialization (#1674, R8). Issue paths are prefixed by representation;
 * the validated intermediates are discarded. */
export function assertV9PublicCardProjections(card: SafetyScoreV9CurrentCard): void {
  const issues: z.core.$ZodIssue[] = [];
  const admit = (representation: string, result: { error?: z.ZodError }) => {
    for (const issue of result.error?.issues ?? []) issues.push({ ...issue, path: [representation, ...issue.path] });
  };
  admit("full", SafetyScoreV9ResolvedCurrentCardSchema.safeParse(resolveV9PublicWitnessTexts(card)));
  admit("table", ReportCardsV9TableCardSchema.safeParse(projectV9TableCard(card)));
  admit("neighborhood", ReportCardsV9NeighborhoodCardSchema.safeParse(projectV9DetailNeighborhoodCard(card)));
  if (issues.length > 0) throw new z.ZodError(issues);
}

/** Complete incident-edge closure plus every member of the selected coin's common-mode groups.
 * Other members' evaluator internals are deliberately not repeated. The selected
 * full card retains all evidence and the original global gap-index context. */
export function projectV9Detail(
  snapshot: ReportCardsV9ProjectionSource, coinId: string,
  graph: ReportCardsV9DependencyGraph = resolvedDependencyGraph(snapshot),
  neighborhoodCards?: readonly ReportCardsV9DetailResponse["neighborhood"][number][],
): ReportCardsV9DetailResponse {
  const selected = snapshot.cards.find(card => card.id === coinId);
  if (!selected) throw new Error("v9-detail-card-unavailable");
  const dependents = new Set(graph.edges.filter(edge => edge.from === coinId).map(edge => edge.to));
  // Direct-exposure basket integrity needs every sibling input of each direct
  // dependent, not only the focus asset's own leg of that basket.
  const edges = graph.edges.filter(edge => edge.from === coinId || edge.to === coinId || dependents.has(edge.to));
  const groups = resolveCommonModeEffects({
    cards: snapshot.cards,
    commonModeGroups: snapshot.commonModeGroups?.filter(group => group.memberAssetIds.includes(coinId)),
  });
  const members = new Set([coinId]);
  for (const edge of edges) { members.add(edge.from); members.add(edge.to); }
  for (const group of groups ?? []) for (const id of group.memberAssetIds) members.add(id);
  const neighborhood = neighborhoodCards === undefined
    ? snapshot.cards.filter(card => members.has(card.id)).map(projectV9DetailNeighborhoodCard)
    : neighborhoodCards.filter(card => members.has(card.id));
  return ReportCardsV9DetailResponseSchema.parse({
    ...envelope(snapshot), projection: "detail", coinId,
    cards: [resolveV9PublicWitnessTexts(selected)], neighborhood,
    ...(snapshot.pillarFreshness === undefined ? {} : { pillarFreshness: {
      dexMaxAgeSec: snapshot.pillarFreshness.dexMaxAgeSec,
      dexObservedAtSec: [snapshot.pillarFreshness.dexObservedAtSec[snapshot.cards.indexOf(selected)]!],
    } }),
    dependencyGraph: { edges }, commonModeGroups: groups,
    foreignCauseGaps: Object.fromEntries(selected.foreignCauseGapRefs.map(ref => [String(ref), snapshot.foreignCauseGaps[ref]])),
    scope: { kind: "incident-and-dependent-input-closure", returnedCount: neighborhood.length,
      expectedCount: snapshot.completeness.expectedCount, returnedEdgeCount: edges.length,
      totalEdgeCount: snapshot.dependencyGraph.edges.length, totalForeignGapCount: snapshot.foreignCauseGaps.length, complete: true },
  });
}
