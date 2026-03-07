import { type MethodologyChangelogEntry } from "@shared/lib/methodology-version";

export type { MethodologyChangelogEntry };

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-border/60 bg-muted/55 px-2.5 py-0.5 text-xs font-medium text-foreground">
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
      className={`group rounded-[1.35rem] border border-border/60 border-l-[3px] bg-card/82 shadow-[0_14px_32px_oklch(0_0_0_/0.12)] ${accentClass}`}
    >
      <summary className="cursor-pointer list-none px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill>{`v${entry.version}`}</Pill>
              <Pill>{dateLabel}</Pill>
              {entry.reconstructed && <Pill>Reconstructed</Pill>}
            </div>
            <div className="space-y-2">
              <h2 className="text-base font-semibold text-foreground sm:text-lg">{entry.title}</h2>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{entry.summary}</p>
            </div>
            {entry.impact.length > 0 && (
              <ul className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                {entry.impact.slice(0, 4).map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <span className="mt-[0.42rem] h-1.5 w-1.5 rounded-full bg-foreground/40" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <span className="text-xs text-muted-foreground group-open:hidden">Details</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">Hide details</span>
        </div>
      </summary>
      <div className="space-y-4 border-t border-border/60 px-5 pb-5 pt-4 text-sm text-muted-foreground leading-relaxed sm:px-6">
        <div className="rounded-2xl border border-border/50 bg-background/45 px-4 py-3">
          <p className="pharos-kicker">Impact Notes</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {entry.impact.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-[0.42rem] h-1.5 w-1.5 rounded-full bg-foreground/40" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {entry.reconstructed ? (
            <span className="rounded-full border border-border/60 bg-background/50 px-3 py-1">
              Reconstructed from git commit history.
            </span>
          ) : null}
          <span className="rounded-full border border-border/60 bg-background/50 px-3 py-1">
            {entry.commits.length} commit{entry.commits.length === 1 ? "" : "s"}
          </span>
        </div>
        <ul className="flex flex-wrap gap-2 text-xs">
          {entry.commits.map((sha) => (
            <li key={sha} className="rounded-full border border-border/50 bg-background/45 px-3 py-1 font-mono">
              {sha}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
