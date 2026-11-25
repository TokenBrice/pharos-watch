import { changelogs } from "@/data/changelogs";
import type { ChangelogEntry } from "@shared/types/editorial-content";

const CHANGELOG_RECENT_WEEKS = 2;
export const RECENT_CHANGELOGS = changelogs.slice(0, CHANGELOG_RECENT_WEEKS);

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

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const SHORT_MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

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

/** Complete month archives also include recent weeks, so their URLs never move. */
export const CHANGELOG_MONTH_ARCHIVES = [
  ...new Set(changelogs.map((entry) => entry.dateRange.to.slice(0, 7))),
].map((month) => ({
  month,
  path: `/changelog/archive/${month}/`,
  label: MONTH_FORMAT.format(new Date(`${month}-01T00:00:00Z`)),
  entries: changelogs.filter((entry) => entry.dateRange.to.startsWith(month)),
}));

export type ChangelogMonthArchive = (typeof CHANGELOG_MONTH_ARCHIVES)[number];

export interface ChangelogPartitionSummary {
  weeks: number;
  totalCommits: number;
  totalUpdates: number;
  methodologyBumps: number;
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

export function formatShortMonthLabel(month: string): string {
  return SHORT_MONTH_FORMAT.format(new Date(`${month}-01T00:00:00Z`));
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
  let methodologyBumps = 0;

  for (const entry of entries) {
    totalCommits += entry.stats.totalCommits;
    totalUpdates += entry.summary.length;
    for (const item of entry.summary) {
      tagCounts[item.tag] += 1;
      if (isMethodologySummaryHref(item.href)) {
        methodologyBumps += 1;
      }
    }
  }

  return {
    weeks: entries.length,
    totalCommits,
    totalUpdates,
    methodologyBumps,
    tagCounts,
  };
}

/**
 * Returns chronologically adjacent monthly archives for a given YYYY-MM key.
 * `CHANGELOG_MONTH_ARCHIVES` is ordered newest-first, so `previous` is the
 * chronologically earlier month (higher index) and `next` is the newer month
 * (lower index).
 */
export function getAdjacentChangelogMonths(month: string): {
  previous: ChangelogMonthArchive | null;
  next: ChangelogMonthArchive | null;
} {
  const index = CHANGELOG_MONTH_ARCHIVES.findIndex((archive) => archive.month === month);
  if (index === -1) {
    return { previous: null, next: null };
  }
  return {
    previous: CHANGELOG_MONTH_ARCHIVES[index + 1] ?? null,
    next: index > 0 ? CHANGELOG_MONTH_ARCHIVES[index - 1] : null,
  };
}
