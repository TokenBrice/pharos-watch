import type { SafetyScoreV9CurrentCard } from "./safety-score-v9-public";
import { attributedSerialParent } from "./safety-score-v9-public-internal";

export interface SafetyScoreV9ParentAttributionIssue {
  cardId: string;
  message: string;
}

export function findSafetyScoreV9ParentAttributionIssues(
  cards: readonly SafetyScoreV9CurrentCard[],
): SafetyScoreV9ParentAttributionIssue[] {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const issues: SafetyScoreV9ParentAttributionIssue[] = [];
  for (const card of cards) {
    for (const item of card.scoreTrace.adverseAttribution.items) {
      if (item.source !== "parent-score") continue;
      const parent = attributedSerialParent(card, item.path, item.message);
      if (parent === null) continue;
      const pathPrefix = `parent:${parent.upstreamAssetId}:`;
      const messagePrefix = `Required parent ${parent.upstreamAssetId}: `;
      const upstream = cardsById.get(parent.upstreamAssetId);
      const matches = upstream?.scoreTrace.adverseAttribution.items.some(
        (candidate) =>
          candidate.path === item.path.slice(pathPrefix.length) &&
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
          candidate.path === item.path.slice(pathPrefix.length) &&
          candidate.message === item.message.slice(messagePrefix.length) &&
          candidate.responsibility === item.responsibility,
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
