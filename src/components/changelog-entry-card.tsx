import type { ChangelogEntry } from "@/data/changelogs/types";

function formatDateRange(from: string, to: string): string {
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

interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
}

export function ChangelogEntryCard({ entry }: ChangelogEntryCardProps) {
  const { dateRange, summary, stats, commits } = entry;

  return (
    <section id={dateRange.to} className="scroll-mt-20">
      <div className="flex items-baseline gap-3 mb-4">
        <h2 className="text-xl font-semibold tracking-tight">
          {formatDateRange(dateRange.from, dateRange.to)}
        </h2>
        <span className="text-xs text-muted-foreground font-mono">
          {stats.totalCommits} commits
        </span>
      </div>

      <ul className="space-y-2 mb-6">
        {summary.map((item) => (
          <li key={item.label} className="text-sm leading-relaxed">
            <span className="font-medium">{item.label}:</span>{" "}
            <span className="text-muted-foreground">{item.description}</span>
          </li>
        ))}
      </ul>

      <details className="group mb-2">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
          View {commits.length} commits
        </summary>
        <ul className="mt-3 space-y-1 text-xs font-mono text-muted-foreground">
          {commits.map((c) => (
            <li key={c.hash}>
              <span className="text-foreground/60">{c.hash}</span>{" "}
              {c.message}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
