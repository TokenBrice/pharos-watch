import { cn } from "@/lib/utils";
import type { ChangelogEntry, SummaryTag } from "@/data/changelogs/types";

/* ── Summary-item category ──────────────────────────────────────── */

const TAG_RULES: [SummaryTag, RegExp][] = [
  ["security", /security|harden|audit|auth/i],
  ["coverage", /coverage|stablecoin|addition|reserve/i],
  ["infra", /pipeline|reliab|status|cron|sync/i],
  ["design", /design|polish|changelog|ux|ui/i],
];

/** Fallback when no explicit tag is set on the entry. */
function inferTag(label: string): SummaryTag {
  for (const [tag, re] of TAG_RULES) if (re.test(label)) return tag;
  return "feature";
}

const TAG_COLOR: Record<SummaryTag, string> = {
  feature: "bg-frost-blue/80",
  security: "bg-amber-500/80",
  coverage: "bg-emerald-500/80",
  infra: "bg-violet-500/80",
  design: "bg-sky-500/80",
};

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
  const { dateRange, headline, summary, stats, commits } = entry;

  return (
    <section
      id={dateRange.to}
      className={cn(
        "scroll-mt-20",
        isLatest &&
          "pharos-card-shell -ml-4 -mr-4 px-4 py-5 sm:-ml-5 sm:-mr-5 sm:px-5 sm:py-6",
      )}
    >
      <h2
        className={cn(
          "group/heading font-semibold tracking-tight",
          isLatest ? "text-2xl" : "text-xl text-muted-foreground",
        )}
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
          <span className="flex items-center gap-2">
            {isLatest && (
              <span className="inline-flex items-center rounded-full bg-frost-blue/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-frost-blue">
                Latest
              </span>
            )}
            <span className="text-xs font-mono font-normal text-muted-foreground">
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

      <ul className="mt-5 space-y-3 mb-6">
        {summary.map((item) => {
          const tag = item.tag ?? inferTag(item.label);
          return (
            <li key={item.label} className="flex gap-3 text-sm leading-relaxed">
              <span
                className={cn(
                  "mt-[7px] size-1.5 shrink-0 rounded-full",
                  TAG_COLOR[tag],
                )}
                aria-hidden
              />
              <span>
                <span className="font-medium">{item.label}</span>
                <span className="mx-1.5 text-border">—</span>
                <span className="text-muted-foreground">{item.description}</span>
              </span>
            </li>
          );
        })}
      </ul>

      <details className="group">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
          Show commits
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
