import type { ChangelogEntry } from "@shared/types/editorial-content";

export type ChangelogTag = ChangelogEntry["summary"][number]["tag"];

export const CHANGELOG_TAG_ORDER: readonly ChangelogTag[] = [
  "feature",
  "coverage",
  "security",
  "design",
  "infra",
];

export const CHANGELOG_TAG_LABELS: Record<ChangelogTag, string> = {
  feature: "Feature",
  coverage: "Coverage",
  security: "Security",
  design: "Design",
  infra: "Infra",
};

const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const MONTH_DAY_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export interface ChangelogPartitionSummary {
  weeks: number;
  totalCommits: number;
  totalUpdates: number;
  methodologyLinks: number;
  tagCounts: Record<ChangelogTag, number>;
}

export function isMethodologySummaryHref(href?: string): boolean {
  return Boolean(href && href.startsWith("/methodology/"));
}

export function formatChangelogTagCountLabel(tag: ChangelogTag, count: number): string {
  if (tag === "feature") {
    return count === 1 ? "feature" : "features";
  }
  return tag;
}

/** Format a Monday–Sunday YYYY-MM-DD range in UTC. */
export function formatChangelogDateRange(
  from: string,
  to: string,
  options?: { compact?: boolean },
): string {
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  const sameMonth = fromDate.getUTCMonth() === toDate.getUTCMonth();
  const fromYear = fromDate.getUTCFullYear();
  const toYear = toDate.getUTCFullYear();
  const sameYear = fromYear === toYear;

  if (options?.compact) {
    const fromStr = !sameYear
      ? MONTH_DAY_YEAR_FORMAT.format(fromDate)
      : MONTH_DAY_FORMAT.format(fromDate);
    const toStr =
      sameMonth && sameYear
        ? String(toDate.getUTCDate())
        : MONTH_DAY_FORMAT.format(toDate);
    return `${fromStr} – ${toStr}`;
  }

  const fromStr = !sameYear
    ? MONTH_DAY_YEAR_FORMAT.format(fromDate)
    : MONTH_DAY_FORMAT.format(fromDate);
  const toStr =
    sameMonth && sameYear
      ? `${toDate.getUTCDate()}, ${toYear}`
      : MONTH_DAY_YEAR_FORMAT.format(toDate);

  return `${fromStr} – ${toStr}`;
}

export function summarizeChangelogEntries(
  entries: readonly ChangelogEntry[],
): ChangelogPartitionSummary {
  const tagCounts: Record<ChangelogTag, number> = {
    feature: 0,
    coverage: 0,
    security: 0,
    design: 0,
    infra: 0,
  };
  let totalCommits = 0;
  let totalUpdates = 0;
  let methodologyLinks = 0;

  for (const entry of entries) {
    totalCommits += entry.stats.totalCommits;
    totalUpdates += entry.summary.length;
    for (const item of entry.summary) {
      tagCounts[item.tag] += 1;
      if (isMethodologySummaryHref(item.href)) {
        methodologyLinks += 1;
      }
    }
  }

  return {
    weeks: entries.length,
    totalCommits,
    totalUpdates,
    methodologyLinks,
    tagCounts,
  };
}
