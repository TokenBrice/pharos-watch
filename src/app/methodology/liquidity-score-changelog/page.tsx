import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "../changelog-page-utils";

const PAGE_PATH = "/methodology/liquidity-score-changelog/";

export const metadata = buildMethodologyChangelogMetadata({
  title: "Liquidity Score Changelog - Version History",
  description:
    `Full version history of the Pharos Liquidity Score methodology, from v1.0 through ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}. Every scoring and normalization revision documented.`,
  path: PAGE_PATH,
});

const entries = mapMethodologyChangelogEntries(
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  (entry) => entry.scoreImpact,
);

export default function LiquidityScoreChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Liquidity Score Changelog"
      path={PAGE_PATH}
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
