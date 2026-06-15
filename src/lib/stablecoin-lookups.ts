import type { PegSummaryCoin, ReportCard } from "@shared/types";

export function buildPegSummaryCoinMap(
  coins: readonly PegSummaryCoin[] | null | undefined,
): Map<string, PegSummaryCoin> {
  const map = new Map<string, PegSummaryCoin>();
  if (!coins) return map;
  for (const coin of coins) {
    map.set(coin.id, coin);
  }
  return map;
}

export function buildReportCardLookup(
  cards: readonly ReportCard[] | null | undefined,
): Map<string, ReportCard> {
  const map = new Map<string, ReportCard>();
  if (!cards) return map;
  for (const card of cards) {
    map.set(card.id, card);
  }
  return map;
}

export function buildReportCardMap(
  cards: readonly ReportCard[] | null | undefined,
): Record<string, ReportCard> | undefined {
  if (!cards) return undefined;
  return Object.fromEntries(buildReportCardLookup(cards));
}
