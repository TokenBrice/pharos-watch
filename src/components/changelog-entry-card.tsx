import { cn } from "@/lib/utils";
import type { ChangelogEntry } from "@/data/changelogs/types";

export function formatDateRange(from: string, to: string): string {
  const fromDate = new Date(from + "T00:00:00");
  const toDate = new Date(to + "T00:00:00");
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const fromStr = fromDate.toLocaleDateString("en-US", opts);

  const sameMonth = fromDate.getMonth() === toDate.getMonth();
  const toStr = sameMonth
    ? `${toDate.getDate()}, ${toDate.getFullYear()}`
    : toDate.toLocaleDateString("en-US", { ...opts, year: "numeric" });

  return `${fromStr} – ${toStr}`;
}

/** ISO date for the `<time>` element. */
function isoDate(ymd: string): string {
  return ymd; // already YYYY-MM-DD
}

const COMMIT_PREVIEW_COUNT = 20;

interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
  /** Render the first entry with more visual weight. */
  isLatest?: boolean;
}

export function ChangelogEntryCard({
  entry,
  isLatest,
}: ChangelogEntryCardProps) {
  const { dateRange, headline, summary, commits } = entry;

  return (
    <section id={dateRange.to} className="scroll-mt-20">
      <h2
        className={cn(
          "group/heading font-semibold tracking-tight",
          isLatest ? "text-2xl" : "text-xl text-muted-foreground",
        )}
      >
        <a
          href={`#${dateRange.to}`}
          className="pharos-focus-ring rounded-sm no-underline hover:underline underline-offset-4"
        >
          <time dateTime={isoDate(dateRange.from)}>
            {formatDateRange(dateRange.from, dateRange.to)}
          </time>
          <span
            className="ml-2 opacity-0 group-hover/heading:opacity-60 transition-opacity text-muted-foreground select-none"
            aria-hidden
          >
            #
          </span>
        </a>
      </h2>

      {headline && (
        <p className="mt-2 text-sm text-muted-foreground italic">{headline}</p>
      )}

      <ul className="mt-4 space-y-3 mb-6">
        {summary.map((item) => (
          <li key={item.label} className="text-sm leading-relaxed">
            <span className="font-medium block">{item.label}</span>
            <span className="text-muted-foreground">{item.description}</span>
          </li>
        ))}
      </ul>

      <details className="group">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
          {commits.length} commits
        </summary>
        <ul className="mt-3 space-y-1 text-xs font-mono text-muted-foreground">
          {commits.slice(0, COMMIT_PREVIEW_COUNT).map((c) => (
            <li key={c.hash}>
              <span className="text-foreground/60">{c.hash}</span>{" "}
              {c.message}
            </li>
          ))}
        </ul>
        {commits.length > COMMIT_PREVIEW_COUNT && (
          <p className="mt-2 text-xs text-muted-foreground">
            … and {commits.length - COMMIT_PREVIEW_COUNT} more
          </p>
        )}
      </details>
    </section>
  );
}
