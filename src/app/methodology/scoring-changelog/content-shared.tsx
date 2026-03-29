import type { ReactNode } from "react";
import {
  SAFETY_SCORE_CHANGELOG,
} from "@shared/lib/safety-score-version";
import type { MethodologyChangelogEntry } from "@shared/lib/methodology-version";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const SCORING_CHANGELOG_BY_VERSION = new Map(
  SAFETY_SCORE_CHANGELOG.map((entry) => [entry.version, entry]),
);

export function scoringAnchorId(version: string) {
  return `scoring-${version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function formatScoringDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function getScoringEntry(version: string): MethodologyChangelogEntry {
  const entry = SCORING_CHANGELOG_BY_VERSION.get(version);
  if (!entry) {
    throw new Error(`Missing Safety Score changelog entry for ${version}`);
  }
  return entry;
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

export function VersionCard({
  entry,
  accent,
  children,
}: {
  entry: MethodologyChangelogEntry;
  accent: string;
  children: ReactNode;
}) {
  const anchorId = scoringAnchorId(`v${entry.version}`);

  return (
    <Card id={anchorId} className={`scroll-mt-28 rounded-xl border-l-[3px] ${accent}`}>
      <CardHeader>
        <CardTitle as="h2">
          <span className="flex flex-wrap items-center gap-2">
            <Pill>{`v${entry.version}`}</Pill>
            {entry.title}
            <span className="text-sm font-normal text-muted-foreground">
              {formatScoringDate(entry.date)}
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground leading-relaxed">
        {children}
      </CardContent>
    </Card>
  );
}

export function WeightRow({
  values,
}: {
  values: [string, string, string, string, string, string];
}) {
  const headers = [
    "Peg",
    "Liquidity",
    "Safety",
    "Resilience",
    "Decentralization",
    "Dep Risk",
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            {headers.map((h) => (
              <th
                key={h}
                className="py-2 pr-4 font-medium text-foreground last:pr-0"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {values.map((v, i) => (
              <td key={i} className="py-2 pr-4 last:pr-0">
                {v}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
