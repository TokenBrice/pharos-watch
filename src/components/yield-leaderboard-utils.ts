import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import type { YieldRanking, YieldType } from "@shared/types";

export function getYieldTypeLabel(type: YieldType): string {
  return YIELD_TYPE_LABELS[type] ?? type;
}

export function matchesYieldSearch(ranking: YieldRanking, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.length === 0
    ? true
    : ranking.symbol.toLowerCase().includes(normalized) || ranking.name.toLowerCase().includes(normalized);
}
