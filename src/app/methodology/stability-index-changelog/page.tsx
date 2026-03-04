import type { Metadata } from "next";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@/lib/stability-index-version";

export const metadata: Metadata = {
  title: "Stability Index Changelog — Version History",
  description:
    `Full version history of the Pharos Stability Index methodology, from v1.0 through ${PSI_METHODOLOGY_VERSION_LABEL}. Every formula, cap, and component revision documented.`,
  alternates: { canonical: "/methodology/stability-index-changelog/" },
  openGraph: {
    title: "Stability Index Changelog — Version History",
    description:
      `Full version history of the Pharos Stability Index methodology, from v1.0 through ${PSI_METHODOLOGY_VERSION_LABEL}.`,
    url: "/methodology/stability-index-changelog/",
  },
};

const entries = PSI_METHODOLOGY_CHANGELOG.map((entry) => ({
  version: entry.version,
  title: entry.title,
  date: entry.date,
  summary: entry.summary,
  impact: entry.scoreImpact,
  commits: entry.commits,
  reconstructed: entry.reconstructed,
}));

export default function StabilityIndexChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Stability Index Changelog"
      path="/methodology/stability-index-changelog/"
      title="Stability Index Changelog"
      lead={
        <>
          Full version history of PSI methodology decisions, from v1.0 to {PSI_METHODOLOGY_VERSION_LABEL}.
        </>
      }
      accentClass="border-l-cyan-500"
      entries={entries}
    />
  );
}
