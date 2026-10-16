import { ChevronDown } from "lucide-react";
import { ChangelogEntryCard } from "@/components/changelog-entry-card";
import { DisclosureHashReveal } from "@/components/disclosure-hash-reveal";
import type { ChangelogEntry } from "@/data/changelogs/types";

/** Weeks rendered open above the month folds. */
const CHANGELOG_OPEN_WEEKS = 2;

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export interface ChangelogMonthGroup {
  /** `YYYY-MM`. */
  key: string;
  label: string;
  entries: ChangelogEntry[];
  totalCommits: number;
}

/** Splits newest-first entries into the open recent weeks and older weeks grouped by month. */
function groupChangelogEntries(entries: readonly ChangelogEntry[], openWeeks = CHANGELOG_OPEN_WEEKS) {
  const recent = entries.slice(0, openWeeks);
  const months: ChangelogMonthGroup[] = [];
  for (const entry of entries.slice(openWeeks)) {
    const key = entry.dateRange.to.slice(0, 7);
    let group = months.at(-1);
    if (group?.key !== key) {
      group = { key, label: MONTH_FORMAT.format(new Date(`${key}-01T00:00:00Z`)), entries: [], totalCommits: 0 };
      months.push(group);
    }
    group.entries.push(entry);
    group.totalCommits += entry.stats.totalCommits;
  }
  return { recent, months };
}

function TimelineDot({ isLatest }: { isLatest: boolean }) {
  return (
    <div
      className={
        isLatest
          ? "absolute -left-[5px] top-[7px] size-2.5 rounded-full border-2 border-foreground bg-foreground"
          : "absolute -left-[5px] top-[7px] size-2.5 rounded-full border-2 border-border bg-background"
      }
      aria-hidden
    />
  );
}

/**
 * Changelog timeline: the latest weeks open, older weeks folded by month in
 * native `<details>`. Folded entries stay in the static HTML (crawlable,
 * find-in-page), and `#<date>` / `#week-<date>` links open their month first.
 */
export function ChangelogTimeline({ entries }: { entries: readonly ChangelogEntry[] }) {
  const { recent, months } = groupChangelogEntries(entries);

  return (
    <>
      <DisclosureHashReveal />
      <ol className="relative ml-1.5 border-l border-border/50">
        {recent.map((entry, i) => (
          <li key={entry.dateRange.to} id={`week-${entry.dateRange.to}`} className={i > 0 ? "relative mt-14 pl-8" : "relative pl-8"}>
            <TimelineDot isLatest={i === 0} />
            <ChangelogEntryCard entry={entry} isLatest={i === 0} />
          </li>
        ))}
      </ol>
      {months.length > 0 ? (
        <section aria-label="Earlier weeks" className="mt-12 space-y-2">
          <h2 className="pharos-label">Earlier weeks</h2>
          {months.map((month) => (
            // Browsers auto-open a fold that holds the URL fragment before hydration.
            <details
              key={month.key}
              id={`month-${month.key}`}
              className="group rounded-xl border border-border/60 bg-background/40"
              suppressHydrationWarning
            >
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2.5 hover:bg-muted/30 [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium text-foreground">{month.label}</span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    <span className="pharos-numeric">{month.entries.length}</span>{" "}
                    {month.entries.length === 1 ? "week" : "weeks"} ·{" "}
                    <span className="pharos-numeric">{month.totalCommits.toLocaleString("en-US")}</span> commits
                  </span>
                  <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                </span>
              </summary>
              <ol className="relative mb-6 ml-5 mt-4 mr-4 border-l border-border/50">
                {month.entries.map((entry, i) => (
                  <li key={entry.dateRange.to} id={`week-${entry.dateRange.to}`} className={i > 0 ? "relative mt-14 pl-8" : "relative pl-8"}>
                    <TimelineDot isLatest={false} />
                    <ChangelogEntryCard entry={entry} />
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </section>
      ) : null}
    </>
  );
}
