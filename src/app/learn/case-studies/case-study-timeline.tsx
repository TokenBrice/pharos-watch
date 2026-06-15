import type { CaseStudySeverity, CaseStudyTimelineEntry } from "./content/types";

const SEVERITY_DOT: Record<CaseStudySeverity, string> = {
  high: "bg-rose-500",
  med: "bg-amber-500",
  low: "bg-muted-foreground/60",
};

const SEVERITY_LEGEND: readonly { severity: CaseStudySeverity; label: string }[] = [
  { severity: "high", label: "High" },
  { severity: "med", label: "Medium" },
  { severity: "low", label: "Low" },
];

function TimelineSeverityLegend() {
  return (
    <ul
      aria-label="Severity legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground"
    >
      {SEVERITY_LEGEND.map(({ severity, label }) => (
        <li key={severity} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[severity]}`}
          />
          <span className="font-mono">{label}</span>
        </li>
      ))}
    </ul>
  );
}

function formatTimelineDate(dateISO: string): string {
  // Day-precision ISO ("2023-03-11") rendered without timezone drift.
  const [y, m, d] = dateISO.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return dateISO;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function CaseStudyTimeline({
  entries,
}: {
  entries: readonly CaseStudyTimelineEntry[];
}) {
  return (
    <div className="space-y-5">
      <TimelineSeverityLegend />
      <ol className="space-y-7 border-l border-border/40 pl-6 sm:pl-8">
      {entries.map((entry, i) => (
        <li key={i} className="relative">
          <span
            aria-hidden="true"
            className={`absolute -left-[1.9375rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-background sm:-left-[2.4375rem] ${
              SEVERITY_DOT[entry.severity ?? "low"]
            }`}
          />
          <div className="space-y-1.5">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
              {formatTimelineDate(entry.dateISO)}
            </p>
            <h3 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
              {entry.headline}
            </h3>
            <p className="text-[15px] leading-relaxed text-muted-foreground">
              {entry.body}
            </p>
            {entry.href ? (
              <a
                href={entry.href}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex text-xs font-medium text-frost-blue underline-offset-4 hover:underline"
              >
                Source
              </a>
            ) : null}
          </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
