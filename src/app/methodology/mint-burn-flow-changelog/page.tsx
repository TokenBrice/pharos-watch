import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@/lib/mint-burn-flow-version";

export const metadata: Metadata = {
  title: "Mint/Burn Flow Changelog - Version History",
  description:
    `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}. Every scoring and ingestion-policy revision documented.`,
  alternates: { canonical: "/methodology/mint-burn-flow-changelog/" },
  openGraph: {
    title: "Mint/Burn Flow Changelog - Version History",
    description:
      `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}.`,
    url: "/methodology/mint-burn-flow-changelog/",
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
    <Card className="rounded-xl border-l-[3px] border-l-orange-500">
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

export default function MintBurnFlowChangelogPage() {
  return (
    <div className="space-y-8">
      <BreadcrumbJsonLd
        name="Mint/Burn Flow Changelog"
        path="/methodology/mint-burn-flow-changelog/"
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
          <span className="text-foreground">Mint/Burn Flow Changelog</span>
        </nav>

        <h1 className="text-4xl font-extrabold tracking-tighter">
          Mint/Burn Flow Changelog
        </h1>

        <p className="text-sm text-muted-foreground">
          Full version history of Mint/Burn Flow methodology decisions, from v1.0 to {MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}.
        </p>
      </div>

      <div className="space-y-4">
        {MINT_BURN_FLOW_METHODOLOGY_CHANGELOG.map((entry) => (
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
