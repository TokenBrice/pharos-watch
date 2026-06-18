import { DAY_MS as EVENT_MATCH_DAY_MS } from "@/lib/constants";

export interface CaseStudyEventWindowResolverItem {
  readonly slug: string;
  readonly primaryCoinId: string | null;
  readonly relatedCoinIds: readonly string[];
  readonly startISO: string;
  readonly endISO: string | null;
}

function eventWindowContains(study: CaseStudyEventWindowResolverItem, tsMs: number): boolean {
  const start = Date.parse(study.startISO);
  if (!Number.isFinite(start)) return false;
  const end = study.endISO
    ? Date.parse(study.endISO) + EVENT_MATCH_DAY_MS
    : start + 2 * EVENT_MATCH_DAY_MS;
  return tsMs >= start - 2 * EVENT_MATCH_DAY_MS && tsMs <= end;
}

export function resolveCaseStudySlugForEvent(
  windows: readonly CaseStudyEventWindowResolverItem[],
  coinId: string,
  tsMs: number,
): string | undefined {
  const primary = windows.find(
    (study) => study.primaryCoinId === coinId && eventWindowContains(study, tsMs),
  );
  if (primary) return primary.slug;

  const related = windows.find(
    (study) => study.relatedCoinIds.includes(coinId) && eventWindowContains(study, tsMs),
  );
  return related?.slug;
}
