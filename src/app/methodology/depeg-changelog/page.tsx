import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@/lib/depeg-dews-version";

export const metadata: Metadata = {
  title: "Depeg Tracker + DEWS Changelog - Version History",
  description:
    `Full version history of the Pharos Depeg Tracker + DEWS methodology, from v1.0 through ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}. Every threshold, formula, and confirmation-policy revision documented.`,
  alternates: { canonical: "/methodology/depeg-changelog/" },
  openGraph: {
    title: "Depeg Tracker + DEWS Changelog - Version History",
    description:
      `Full version history of the Pharos Depeg Tracker + DEWS methodology, from v1.0 through ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}.`,
    url: "/methodology/depeg-changelog/",
  },
};

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

function VersionCard({
  version,
  title,
  date,
  summary,
  impact,
  commits,
  reconstructed,
}: {
  version: string;
  title: string;
  date: string;
  summary: string;
  impact: readonly string[];
  commits: readonly string[];
  reconstructed: boolean;
}) {
  const dateLabel = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <Card className="rounded-xl border-l-[3px] border-l-amber-500">
      <CardHeader className="space-y-2">
        <CardTitle as="h2">
          <span className="flex flex-wrap items-center gap-2">
            <Pill>{`v${version}`}</Pill>
            {title}
            <span className="text-sm font-normal text-muted-foreground">{dateLabel}</span>
          </span>
        </CardTitle>
        {reconstructed && (
          <p className="text-xs text-muted-foreground">
            Reconstructed from git commit history.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground leading-relaxed">
        <p>{summary}</p>
        <ul className="list-disc list-inside space-y-1">
          {impact.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Commits: {commits.map((sha) => `\`${sha}\``).join(", ")}
        </p>
      </CardContent>
    </Card>
  );
}

export default function DepegChangelogPage() {
  return (
    <div className="space-y-8">
      <BreadcrumbJsonLd
        name="Depeg Tracker + DEWS Changelog"
        path="/methodology/depeg-changelog/"
      />

      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link href="/" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <Link href="/methodology" className="hover:text-foreground transition-colors">
            Methodology
          </Link>
          <span>/</span>
          <span className="text-foreground">Depeg Tracker + DEWS Changelog</span>
        </nav>

        <h1 className="text-4xl font-extrabold tracking-tighter">
          Depeg Tracker + DEWS Changelog
        </h1>

        <p className="text-sm text-muted-foreground">
          Full version history of Depeg Tracker and DEWS methodology decisions, from v1.0 to {DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}.
        </p>
      </div>

      <div className="space-y-4">
        {DEPEG_DEWS_METHODOLOGY_CHANGELOG.map((entry) => (
          <VersionCard
            key={entry.version}
            version={entry.version}
            title={entry.title}
            date={entry.date}
            summary={entry.summary}
            impact={entry.methodologyImpact}
            commits={entry.commits}
            reconstructed={entry.reconstructed}
          />
        ))}
      </div>
    </div>
  );
}
