import { ChangelogEntryCard } from "@/components/methodology-history/changelog-entry-card";
import { ChangelogTagFilter } from "@/components/methodology-history/changelog-tag-filter";
import { CHANGELOG_TAG_ORDER, summarizeChangelogEntries } from "@/lib/changelog-tags";
import { cn } from "@/lib/utils";
import type { ChangelogEntry } from "@shared/types/editorial-content";

interface ChangelogTimelineProps {
  entries: readonly ChangelogEntry[];
  highlightLatest?: boolean;
  /** Show the scoped client-side tag filter bar when multiple tags exist in this partition. */
  showTagFilter?: boolean;
}

/**
 * Server-rendered changelog partition timeline. Only the caller's document
 * partition is rendered, and the optional category filter receives precomputed
 * tag counts only so changelog bodies never enter the browser JS bundle.
 */
export function ChangelogTimeline({
  entries,
  highlightLatest = true,
  showTagFilter = true,
}: ChangelogTimelineProps) {
  const partitionSummary = summarizeChangelogEntries(entries);
  const presentTags = CHANGELOG_TAG_ORDER.filter(
    (tag) => partitionSummary.tagCounts[tag] > 0,
  );

  const list = (
    <ol className="relative ml-1.5 border-l border-border/50">
      {entries.map((entry, i) => {
        const isLatest = highlightLatest && i === 0;
        return (
          <li
            key={entry.dateRange.to}
            id={`week-${entry.dateRange.to}`}
            className={cn(
              "relative scroll-mt-32 pl-5 sm:pl-8",
              i > 0 && "mt-12 sm:mt-14",
            )}
          >
            <div
              className={cn(
                "absolute -left-[5px] size-2.5 rounded-full border-2",
                isLatest
                  ? "top-12 border-foreground bg-foreground sm:top-14"
                  : "top-7 border-border bg-background",
              )}
              aria-hidden="true"
            />
            <ChangelogEntryCard entry={entry} isLatest={isLatest} />
          </li>
        );
      })}
    </ol>
  );

  if (showTagFilter && presentTags.length >= 2) {
    return (
      <ChangelogTagFilter
        presentTags={presentTags}
        tagCounts={partitionSummary.tagCounts}
        totalUpdates={partitionSummary.totalUpdates}
      >
        {list}
      </ChangelogTagFilter>
    );
  }

  return <div>{list}</div>;
}
