import { changelogs } from "@/data/changelogs";

const CHANGELOG_RECENT_WEEKS = 2;
export const RECENT_CHANGELOGS = changelogs.slice(0, CHANGELOG_RECENT_WEEKS);

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Complete month archives also include recent weeks, so their URLs never move. */
export const CHANGELOG_MONTH_ARCHIVES = [...new Set(changelogs.map((entry) => entry.dateRange.to.slice(0, 7)))].map((month) => ({
  month,
  path: `/changelog/archive/${month}/`,
  label: MONTH_FORMAT.format(new Date(`${month}-01T00:00:00Z`)),
  entries: changelogs.filter((entry) => entry.dateRange.to.startsWith(month)),
}));
