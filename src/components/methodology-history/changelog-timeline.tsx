"use client";

import { useState } from "react";
import { ChangelogEntryCard } from "@/components/methodology-history/changelog-entry-card";
import {
  CHANGELOG_TAG_LABELS,
  CHANGELOG_TAG_ORDER,
  summarizeChangelogEntries,
  type ChangelogTag,
} from "@/lib/changelog-history";
import { cn } from "@/lib/utils";
import type { ChangelogEntry } from "@shared/types/editorial-content";

interface ChangelogTimelineProps {
  entries: readonly ChangelogEntry[];
  highlightLatest?: boolean;
  /** Show the scoped client-side tag filter bar when multiple tags exist in this partition. */
  showTagFilter?: boolean;
}

/** Only the caller's document partition is rendered; closed folds are not a payload boundary. */
export function ChangelogTimeline({
  entries,
  highlightLatest = true,
  showTagFilter = true,
}: ChangelogTimelineProps) {
  const [activeTag, setActiveTag] = useState<ChangelogTag | null>(null);
  const partitionSummary = summarizeChangelogEntries(entries);
  const presentTags = CHANGELOG_TAG_ORDER.filter(
    (tag) => partitionSummary.tagCounts[tag] > 0,
  );
  const effectiveActiveTag =
    activeTag && partitionSummary.tagCounts[activeTag] > 0 ? activeTag : null;

  return (
    <div>
      {showTagFilter && presentTags.length >= 2 && (
        <div
          role="group"
          aria-label="Filter updates by category"
          className="mb-6 flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            aria-pressed={effectiveActiveTag === null}
            onClick={() => setActiveTag(null)}
            className="pharos-control-pill pharos-focus-ring gap-1.5"
          >
            <span>All</span>{" "}
            <span className="pharos-numeric text-muted-foreground">
              {partitionSummary.totalUpdates}
            </span>
          </button>
          {presentTags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={effectiveActiveTag === tag}
              onClick={() =>
                setActiveTag((current) => (current === tag ? null : tag))
              }
              className="pharos-control-pill pharos-focus-ring gap-1.5"
            >
              <span>{CHANGELOG_TAG_LABELS[tag]}</span>{" "}
              <span className="pharos-numeric text-muted-foreground">
                {partitionSummary.tagCounts[tag]}
              </span>
            </button>
          ))}
        </div>
      )}

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
                    ? "top-12 border-brand-accent bg-brand-accent sm:top-14"
                    : "top-7 border-border bg-background",
                )}
                aria-hidden="true"
              />
              <ChangelogEntryCard
                entry={entry}
                isLatest={isLatest}
                activeTag={effectiveActiveTag}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
