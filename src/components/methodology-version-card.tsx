import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
}: {
  entry: MethodologyChangelogEntry;
  accentClass: string;
}) {
  const dateLabel = new Date(`${entry.date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <Card className={`rounded-xl border-l-[3px] ${accentClass}`}>
      <CardHeader className="space-y-2">
        <CardTitle as="h2">
          <span className="flex flex-wrap items-center gap-2">
            <Pill>{`v${entry.version}`}</Pill>
            {entry.title}
            <span className="text-sm font-normal text-muted-foreground">{dateLabel}</span>
          </span>
        </CardTitle>
        {entry.reconstructed && (
          <p className="text-xs text-muted-foreground">
            Reconstructed from git commit history.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground leading-relaxed">
        <p>{entry.summary}</p>
        <ul className="list-disc list-inside space-y-1">
          {entry.impact.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Commits: {entry.commits.map((sha) => `\`${sha}\``).join(", ")}
        </p>
      </CardContent>
    </Card>
  );
}
