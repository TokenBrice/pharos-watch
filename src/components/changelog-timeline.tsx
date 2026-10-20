import { ChangelogEntryCard } from "@/components/changelog-entry-card";
import type { ChangelogEntry } from "@shared/types/editorial-content";

/** Only the caller's document partition is rendered; closed folds are not a payload boundary. */
export function ChangelogTimeline({ entries, highlightLatest = true }: {
  entries: readonly ChangelogEntry[];
  highlightLatest?: boolean;
}) {
  return (
    <ol className="relative ml-1.5 border-l border-border/50">
      {entries.map((entry, i) => (
        <li key={entry.dateRange.to} id={`week-${entry.dateRange.to}`} className={i > 0 ? "relative mt-14 pl-8" : "relative pl-8"}>
          <div
            className={highlightLatest && i === 0
              ? "absolute -left-[5px] top-[7px] size-2.5 rounded-full border-2 border-foreground bg-foreground"
              : "absolute -left-[5px] top-[7px] size-2.5 rounded-full border-2 border-border bg-background"}
            aria-hidden
          />
          <ChangelogEntryCard entry={entry} isLatest={highlightLatest && i === 0} />
        </li>
      ))}
    </ol>
  );
}
