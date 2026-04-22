import type { ReportCard } from "@shared/types";

export const ALERT_SAFETY_SOURCE_CACHE_KEY = "alert:safety-source-cache";

export type AlertSafetySourceSnapshot = Record<
  string,
  { grade: string; score: number | null; methodologyVersion: string | null }
>;

export function buildAlertSafetySourceSnapshot(
  cards: ReportCard[],
  methodologyVersion: string,
): AlertSafetySourceSnapshot {
  const snapshot: AlertSafetySourceSnapshot = {};

  for (const card of cards) {
    if (card.isDefunct) continue;
    snapshot[card.id] = {
      grade: card.overallGrade,
      score: card.overallScore ?? null,
      methodologyVersion,
    };
  }

  return snapshot;
}
