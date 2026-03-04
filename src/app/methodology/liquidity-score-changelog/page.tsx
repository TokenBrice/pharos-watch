import type { Metadata } from "next";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@/lib/liquidity-score-version";

export const metadata: Metadata = {
  title: "Liquidity Score Changelog - Version History",
  description:
    `Full version history of the Pharos Liquidity Score methodology, from v1.0 through ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}. Every scoring and normalization revision documented.`,
  alternates: { canonical: "/methodology/liquidity-score-changelog/" },
  openGraph: {
    title: "Liquidity Score Changelog - Version History",
    description:
      `Full version history of the Pharos Liquidity Score methodology, from v1.0 through ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}.`,
    url: "/methodology/liquidity-score-changelog/",
  },
};

const entries = LIQUIDITY_METHODOLOGY_CHANGELOG.map((entry) => ({
  version: entry.version,
  title: entry.title,
  date: entry.date,
  summary: entry.summary,
  impact: entry.scoreImpact,
  commits: entry.commits,
  reconstructed: entry.reconstructed,
}));

export default function LiquidityScoreChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Liquidity Score Changelog"
      path="/methodology/liquidity-score-changelog/"
      title="Liquidity Score Changelog"
      lead={
        <>
          Full version history of Liquidity Score methodology decisions, from v1.0 to {LIQUIDITY_METHODOLOGY_VERSION_LABEL}.
        </>
      }
      accentClass="border-l-cyan-500"
      entries={entries}
    />
  );
}
