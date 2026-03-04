import type { Metadata } from "next";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@/lib/yield-methodology-version";

export const metadata: Metadata = {
  title: "Yield Intelligence Changelog - Version History",
  description:
    `Full version history of the Pharos Yield Intelligence methodology, from v1.0 through ${YIELD_METHODOLOGY_VERSION_LABEL}. Every source-resolution and scoring revision documented.`,
  alternates: { canonical: "/methodology/yield-changelog/" },
  openGraph: {
    title: "Yield Intelligence Changelog - Version History",
    description:
      `Full version history of the Pharos Yield Intelligence methodology, from v1.0 through ${YIELD_METHODOLOGY_VERSION_LABEL}.`,
    url: "/methodology/yield-changelog/",
  },
};

const entries = YIELD_METHODOLOGY_CHANGELOG.map((entry) => ({
  version: entry.version,
  title: entry.title,
  date: entry.date,
  summary: entry.summary,
  impact: entry.methodologyImpact,
  commits: entry.commits,
  reconstructed: entry.reconstructed,
}));

export default function YieldChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Yield Intelligence Changelog"
      path="/methodology/yield-changelog/"
      title="Yield Intelligence Changelog"
      lead={
        <>
          Full version history of Yield Intelligence methodology decisions, from v1.0 to {YIELD_METHODOLOGY_VERSION_LABEL}.
        </>
      }
      accentClass="border-l-violet-500"
      entries={entries}
    />
  );
}
