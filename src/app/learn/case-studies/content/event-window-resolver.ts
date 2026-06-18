import { DAY_MS as EVENT_MATCH_DAY_MS } from "@/lib/constants";

export interface CaseStudyEventWindowResolverItem {
  readonly slug: string;
  readonly primaryCoinId: string | null;
  readonly relatedCoinIds: readonly string[];
  readonly startISO: string;
  readonly endISO: string | null;
}

function eventWindowContains(study: CaseStudyEventWindowResolverItem, tsMs: number): boolean {
  const bounds = eventWindowBounds(study);
  if (!bounds) return false;
  return tsMs >= bounds.matchStart && tsMs <= bounds.matchEnd;
}

function eventWindowBounds(study: CaseStudyEventWindowResolverItem) {
  const start = Date.parse(study.startISO);
  if (!Number.isFinite(start)) return false;
  const end = study.endISO
    ? Date.parse(study.endISO) + EVENT_MATCH_DAY_MS
    : start + 2 * EVENT_MATCH_DAY_MS;
  return {
    start,
    matchStart: start - 2 * EVENT_MATCH_DAY_MS,
    matchEnd: end,
    duration: end - start,
  };
}

function findBestWindowMatch(
  windows: readonly CaseStudyEventWindowResolverItem[],
  coinId: string,
  tsMs: number,
  kind: "primary" | "related",
): CaseStudyEventWindowResolverItem | undefined {
  return windows
    .filter((study) => {
      const coinMatches =
        kind === "primary"
          ? study.primaryCoinId === coinId
          : study.relatedCoinIds.includes(coinId);
      return coinMatches && eventWindowContains(study, tsMs);
    })
    .map((study) => {
      const bounds = eventWindowBounds(study);
      return bounds
        ? {
            study,
            distanceFromStart: Math.abs(tsMs - bounds.start),
            duration: bounds.duration,
          }
        : null;
    })
    .filter((entry): entry is { study: CaseStudyEventWindowResolverItem; distanceFromStart: number; duration: number } => Boolean(entry))
    .sort(
      (a, b) =>
        a.distanceFromStart - b.distanceFromStart ||
        a.duration - b.duration ||
        a.study.slug.localeCompare(b.study.slug),
    )[0]?.study;
}

export function resolveCaseStudySlugForEvent(
  windows: readonly CaseStudyEventWindowResolverItem[],
  coinId: string,
  tsMs: number,
): string | undefined {
  const primary = findBestWindowMatch(windows, coinId, tsMs, "primary");
  if (primary) return primary.slug;

  const related = findBestWindowMatch(windows, coinId, tsMs, "related");
  return related?.slug;
}
