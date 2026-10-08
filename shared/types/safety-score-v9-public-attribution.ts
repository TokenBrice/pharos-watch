import type { SafetyScoreV9CurrentCard } from "./safety-score-v9-public";
import { attributedSerialParent } from "./safety-score-v9-public-internal";
import { resolveCauseGapId, type V9PublicCauseGapContext } from "./safety-score-v9-public-cause-gaps";

type AttributionCard = Omit<SafetyScoreV9CurrentCard, "breakdowns">;

export interface SafetyScoreV9ParentAttributionIssue {
  cardId: string;
  message: string;
}

export function findSafetyScoreV9ParentAttributionIssues(
  response: V9PublicCauseGapContext & { cards: readonly AttributionCard[] },
): SafetyScoreV9ParentAttributionIssue[] {
  const cards = response.cards;
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const issues: SafetyScoreV9ParentAttributionIssue[] = [];
  for (const card of cards) {
    for (const dependency of card.dependencies.serial) {
      const upstream = cardsById.get(dependency.upstreamAssetId);
      if (upstream && (dependency.ratingStatus !== upstream.ratingStatus ||
          JSON.stringify(dependency.partialEvidence) !== JSON.stringify(upstream.partialEvidence === null ? null : {
            reasonCode: upstream.partialEvidence.reasonCode, excludedPillars: upstream.partialEvidence.excludedPillars, causes: upstream.partialEvidence.causes,
          }))) {
        issues.push({ cardId: card.id, message: `Parent availability does not reconcile to ${dependency.upstreamAssetId}` });
      }
    }
    for (const dependency of card.dependencies.basket) {
      const upstream = cardsById.get(dependency.upstreamAssetId);
      if (!upstream) continue;
      const backing = upstream.pillars.backing;
      const status = backing.aggregationDisposition === "excluded-a-b" ? "pipeline-gap"
        : backing.score !== null ? "rated" : "not-rated";
      if (dependency.ratingStatus !== status) {
        issues.push({ cardId: card.id, message: `Parent Backing availability does not reconcile to ${dependency.upstreamAssetId}` });
      }
    }
    // Roles carry their selected raw dimension, not unrelated whole-card status.
    for (const item of card.scoreTrace.adverseAttribution.items) {
      if (item.source !== "parent-score") continue;
      const parent = attributedSerialParent(card, item.path, item.message);
      if (parent === null) continue;
      const pathPrefix = `parent:${parent.upstreamAssetId}:`;
      const messagePrefix = `Required parent ${parent.upstreamAssetId}: `;
      const upstream = cardsById.get(parent.upstreamAssetId);
      const matches = upstream?.scoreTrace.adverseAttribution.items.some(
        (candidate) =>
          sameCausePath(response, upstream, candidate.path, card, item.path.slice(pathPrefix.length)) &&
          candidate.message === item.message.slice(messagePrefix.length),
      );
      if (!matches) {
        issues.push({
          cardId: card.id,
          message: `Parent adverse attribution does not reconcile to ${parent.upstreamAssetId}`,
        });
      }
    }
    for (const item of card.scoreTrace.boundedUncertaintyAttribution.items) {
      if (item.source !== "parent-score") continue;
      const parent = attributedSerialParent(card, item.path, item.message);
      if (parent === null) continue;
      const pathPrefix = `parent:${parent.upstreamAssetId}:`;
      const messagePrefix = `Required parent ${parent.upstreamAssetId}: `;
      const upstream = cardsById.get(parent.upstreamAssetId);
      const matches = upstream?.scoreTrace.boundedUncertaintyAttribution.items.some(
        (candidate) =>
          candidate.code === item.code &&
          sameCausePath(response, upstream, candidate.path, card, item.path.slice(pathPrefix.length)) &&
          candidate.message === item.message.slice(messagePrefix.length) &&
          candidate.responsibility === item.responsibility &&
          candidate.cause === item.cause &&
          sameCauseGapRefs(response, upstream, candidate.causeGapRefs, card, item.causeGapRefs),
      );
      if (!matches) {
        issues.push({
          cardId: card.id,
          message: `Parent bounded attribution does not reconcile to ${parent.upstreamAssetId}`,
        });
      }
    }
  }
  return issues;
}

function sameCausePath(response: V9PublicCauseGapContext, a: AttributionCard, pathA: string, b: AttributionCard, pathB: string): boolean {
  const suffixA = /:cause:(\d+)$/u.exec(pathA), suffixB = /:cause:(\d+)$/u.exec(pathB);
  if (!suffixA || !suffixB) return pathA === pathB;
  return pathA.slice(0, suffixA.index) === pathB.slice(0, suffixB.index) &&
    sameCauseGapRef(response, a, Number(suffixA[1]), b, Number(suffixB[1]));
}
function sameCauseGapRefs(response: V9PublicCauseGapContext, a: AttributionCard, refsA: readonly number[], b: AttributionCard, refsB: readonly number[]): boolean {
  if (refsA.length !== refsB.length) return false;
  try {
    for (let i = 0; i < refsA.length; i++) {
      const id = resolveCauseGapId(response, a, refsA[i]!);
      let found = false;
      for (const ref of refsB) if (resolveCauseGapId(response, b, ref) === id) { found = true; break; }
      if (!found) return false;
    }
    return true;
  } catch { return false; } // Invalid refs are reported by the card schema.
}
function sameCauseGapRef(response: V9PublicCauseGapContext, a: AttributionCard, refA: number, b: AttributionCard, refB: number): boolean {
  try { return resolveCauseGapId(response, a, refA) === resolveCauseGapId(response, b, refB); }
  catch { return false; }
}
