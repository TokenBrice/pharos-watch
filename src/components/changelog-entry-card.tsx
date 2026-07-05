import { cn } from "@/lib/utils";
import type { ChangelogEntry } from "@/data/changelogs/types";

function toLocalMidnight(ymd: string): Date {
  return new Date(ymd + "T00:00:00");
}

function toUTCMidnight(ymd: string): Date {
  return new Date(ymd + "T00:00:00Z");
}

function formatDateRange(
  from: string,
  to: string,
  options?: { compact?: boolean },
): string {
  const fromDate = toLocalMidnight(from);
  const toDate = toLocalMidnight(to);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const sameMonth = fromDate.getMonth() === toDate.getMonth();
  const fromYear = fromDate.getFullYear();
  const toYear = toDate.getFullYear();
  const sameYear = fromYear === toYear;

  if (options?.compact) {
    const fromStr = !sameYear
      ? fromDate.toLocaleDateString("en-US", { ...opts, year: "numeric" })
      : fromDate.toLocaleDateString("en-US", opts);
    const toStr = sameMonth && sameYear
      ? String(toDate.getDate())
      : toDate.toLocaleDateString("en-US", opts);
    return `${fromStr} – ${toStr}`;
  }

  const fromStr = !sameYear
    ? fromDate.toLocaleDateString("en-US", { ...opts, year: "numeric" })
    : fromDate.toLocaleDateString("en-US", opts);
  const toStr = sameMonth && sameYear
    ? `${toDate.getDate()}, ${toYear}`
    : toDate.toLocaleDateString("en-US", { ...opts, year: "numeric" });

  return `${fromStr} – ${toStr}`;
}

/** ISO date for the `<time>` element. */
function isoDate(ymd: string): string {
  return ymd; // already YYYY-MM-DD
}

/** ISO 8601 week number derived from the closing date of the changelog window. */
function isoWeekNumber(ymd: string): number {
  const date = toUTCMidnight(ymd);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

const COMMIT_PREVIEW_COUNT = 20;

interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
  /** Render the first entry with more visual weight. */
  isLatest?: boolean;
}

function formatFieldNotesKicker(from: string): string {
  const fromDate = toLocalMidnight(from);
  const month = fromDate.toLocaleDateString("en-US", { month: "long" });
  return `Editor's note · Week of ${month} ${fromDate.getDate()}`;
}

export function ChangelogEntryCard({
  entry,
  isLatest,
}: ChangelogEntryCardProps) {
  const { dateRange, headline, fieldNotes, summary, stats, commits } = entry;
  const weekNumber = isoWeekNumber(dateRange.to);

  return (
    <section
      id={dateRange.to}
      className={cn(
        "scroll-mt-20",
        isLatest &&
          "pharos-card-shell -ml-4 -mr-4 px-4 py-5 sm:-ml-5 sm:-mr-5 sm:px-5 sm:py-6",
      )}
    >
      <p className="pharos-numeric text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
        Week #{weekNumber}
      </p>
      <h2
        className={cn(
          "group/heading mt-1 font-semibold tracking-tight",
          isLatest ? "text-2xl" : "text-xl text-muted-foreground",
        )}
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a
            href={`#${dateRange.to}`}
            className="pharos-focus-ring rounded-sm no-underline hover:underline underline-offset-4"
          >
            <time dateTime={isoDate(dateRange.to)}>
              {formatDateRange(dateRange.from, dateRange.to, { compact: true })}
            </time>
            <span
              className="ml-2 opacity-0 group-hover/heading:opacity-60 transition-opacity text-muted-foreground select-none"
              aria-hidden
            >
              #
            </span>
          </a>
          <span className="flex items-center gap-2">
            {isLatest && (
              <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground">
                Latest
              </span>
            )}
            <span className="pharos-numeric text-xs font-normal text-muted-foreground">
              {stats.totalCommits} commits
            </span>
          </span>
        </span>
      </h2>

      {headline && (
        <p className="mt-2.5 text-base leading-snug text-foreground/80">
          {headline}
        </p>
      )}

      {fieldNotes && (
        <aside className="mt-5 border-l border-border/70 pl-4">
          <p className="pharos-kicker text-muted-foreground">
            {formatFieldNotesKicker(dateRange.from)}
          </p>
          <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-foreground/85">
            {fieldNotes}
          </p>
        </aside>
      )}

      <ul className="mt-5 space-y-4 mb-6">
        {summary.map((item) => {
          const tag = item.tag;
          return (
            <li key={item.label} className="space-y-0.5">
              <div className="flex items-baseline gap-2">
                {item.href ? (
                  <a href={item.href} className="text-sm font-semibold text-foreground/90 underline underline-offset-2 hover:text-foreground transition-colors">{item.label}</a>
                ) : (
                  <span className="text-sm font-semibold text-foreground/90">{item.label}</span>
                )}
                {tag && (
                  <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground/70 shrink-0">
                    {tag}
                  </span>
                )}
              </div>
              <p className="max-w-[72ch] text-sm leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            </li>
          );
        })}
      </ul>

      <details className="group/commits">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors select-none [&::-webkit-details-marker]:hidden">
          <svg
            className="size-3 shrink-0 transition-transform duration-150 group-open/commits:rotate-90"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4.5 2.5L8 6l-3.5 3.5" />
          </svg>
          Show commits
        </summary>
        <ul className="mt-3 space-y-1 text-xs font-mono text-muted-foreground">
          {commits.slice(0, COMMIT_PREVIEW_COUNT).map((c) => (
            <li key={c.hash}>
              <a
                href={`https://github.com/TokenBrice/pharos-watch/commit/${c.hash}`}
                className="text-foreground/60 hover:text-foreground transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                {c.hash.slice(0, 8)}
              </a>{" "}
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
