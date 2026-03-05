import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "../changelog-page-utils";

const PAGE_PATH = "/methodology/yield-changelog/";

export const metadata = buildMethodologyChangelogMetadata({
  title: "Yield Intelligence Changelog - Version History",
  description:
    `Full version history of the Pharos Yield Intelligence methodology, from v1.0 through ${YIELD_METHODOLOGY_VERSION_LABEL}. Every source-resolution and scoring revision documented.`,
  path: PAGE_PATH,
});

const entries = mapMethodologyChangelogEntries(
  YIELD_METHODOLOGY_CHANGELOG,
  (entry) => entry.methodologyImpact,
);

export default function YieldChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Yield Intelligence Changelog"
      path={PAGE_PATH}
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
