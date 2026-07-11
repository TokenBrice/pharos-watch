import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import type { ReportCard } from "@shared/types/report-cards";

export interface ReportCardPublicationCompleteness {
  generationId: string;
  methodologyVersion: string;
  expectedCount: number;
  scoredCount: number;
  notRatedCount: number;
  notRatedIds: string[];
}

export interface ReportCardPublicationPlan {
  activeCards: ReportCard[];
  completeness: ReportCardPublicationCompleteness;
}

export function buildReportCardPublicationPlan(
  cards: readonly ReportCard[],
  methodologyVersion: string,
  updatedAt: number,
  expectedIds: ReadonlySet<string> = ACTIVE_IDS,
): ReportCardPublicationPlan {
  const activeCards: ReportCard[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unexpectedLiveIds: string[] = [];
  const defunctActiveIds: string[] = [];

  for (const card of cards) {
    if (!expectedIds.has(card.id)) {
      if (!card.isDefunct) unexpectedLiveIds.push(card.id);
      continue;
    }
    if (seen.has(card.id)) {
      duplicates.push(card.id);
      continue;
    }
    seen.add(card.id);
    if (card.isDefunct) defunctActiveIds.push(card.id);
    activeCards.push(card);
  }

  const missingIds = [...expectedIds].filter((id) => !seen.has(id));
  if (
    missingIds.length > 0
    || duplicates.length > 0
    || unexpectedLiveIds.length > 0
    || defunctActiveIds.length > 0
  ) {
    throw new Error(JSON.stringify({
      reason: "report-card-active-set-mismatch",
      expectedCount: expectedIds.size,
      actualCount: seen.size,
      missingIds,
      duplicateIds: [...new Set(duplicates)],
      unexpectedLiveIds: [...new Set(unexpectedLiveIds)],
      defunctActiveIds,
    }));
  }

  const notRatedIds = activeCards
    .filter((card) => card.overallScore == null)
    .map((card) => card.id);
  const scoredCount = activeCards.length - notRatedIds.length;
  if (expectedIds.size !== scoredCount + notRatedIds.length) {
    throw new Error(
      `Report-card completeness mismatch: expected=${expectedIds.size} scored=${scoredCount} notRated=${notRatedIds.length}`,
    );
  }

  return {
    activeCards,
    completeness: {
      generationId: `report-cards:${methodologyVersion}:${updatedAt}`,
      methodologyVersion,
      expectedCount: expectedIds.size,
      scoredCount,
      notRatedCount: notRatedIds.length,
      notRatedIds,
    },
  };
}
