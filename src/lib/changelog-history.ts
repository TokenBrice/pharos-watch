import { changelogs } from "@/data/changelogs";
export {
  CHANGELOG_TAG_ORDER,
  formatChangelogDateRange,
  formatChangelogTagCountLabel,
  isMethodologySummaryHref,
  summarizeChangelogEntries,
} from "@/lib/changelog-tags";

const CHANGELOG_RECENT_WEEKS = 2;
export const RECENT_CHANGELOGS = changelogs.slice(0, CHANGELOG_RECENT_WEEKS);

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

export function formatShortMonthLabel(month: string): string {
  return SHORT_MONTH_FORMAT.format(new Date(`${month}-01T00:00:00Z`));
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
