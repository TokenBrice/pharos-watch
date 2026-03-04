import type { Metadata } from "next";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
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

const entries = DEPEG_DEWS_METHODOLOGY_CHANGELOG.map((entry) => ({
  version: entry.version,
  title: entry.title,
  date: entry.date,
  summary: entry.summary,
  impact: entry.methodologyImpact,
  commits: entry.commits,
  reconstructed: entry.reconstructed,
}));

export default function DepegChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Depeg Tracker + DEWS Changelog"
      path="/methodology/depeg-changelog/"
      title="Depeg Tracker + DEWS Changelog"
      lead={
        <>
          Full version history of Depeg Tracker and DEWS methodology decisions, from v1.0 to {DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}.
        </>
      }
      accentClass="border-l-amber-500"
      entries={entries}
    />
  );
}
