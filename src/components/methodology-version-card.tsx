export interface MethodologyChangelogEntry {
  version: string;
  title: string;
  date: string;
  summary: string;
  impact: readonly string[];
  commits: readonly string[];
  reconstructed: boolean;
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

export function MethodologyVersionCard({
  entry,
  accentClass,
  entryId,
  defaultOpen = false,
}: {
  entry: MethodologyChangelogEntry;
  accentClass: string;
  entryId?: string;
  defaultOpen?: boolean;
}) {
  const dateLabel = new Date(`${entry.date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <details
      id={entryId}
      open={defaultOpen}
      className={`group rounded-xl border border-border/60 border-l-[3px] bg-card ${accentClass}`}
    >
      <summary className="cursor-pointer list-none px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Pill>{`v${entry.version}`}</Pill>
              <h2 className="text-base font-semibold text-foreground">{entry.title}</h2>
            </div>
            <p className="text-xs text-muted-foreground">{dateLabel}</p>
          </div>
          <span className="text-xs text-muted-foreground group-open:hidden">Expand</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">Collapse</span>
        </div>
        {entry.reconstructed && (
          <p className="mt-2 text-xs text-muted-foreground">
            Reconstructed from git commit history.
          </p>
        )}
      </summary>
      <div className="space-y-4 border-t border-border/60 px-6 pb-5 pt-4 text-sm text-muted-foreground leading-relaxed">
        <p>{entry.summary}</p>
        <ul className="list-disc list-inside space-y-1">
          {entry.impact.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Commits: {entry.commits.map((sha) => `\`${sha}\``).join(", ")}
        </p>
      </div>
    </details>
  );
}
