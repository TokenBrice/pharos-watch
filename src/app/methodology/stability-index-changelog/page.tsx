import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/stability-index-version";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "../changelog-page-utils";

const PAGE_PATH = "/methodology/stability-index-changelog/";

export const metadata = buildMethodologyChangelogMetadata({
  title: "Stability Index Changelog — Version History",
  description:
    `Full version history of the Pharos Stability Index methodology, from v1.0 through ${PSI_METHODOLOGY_VERSION_LABEL}. Every formula, cap, and component revision documented.`,
  path: PAGE_PATH,
});

const entries = mapMethodologyChangelogEntries(
  PSI_METHODOLOGY_CHANGELOG,
  (entry) => entry.scoreImpact,
);

export default function StabilityIndexChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Stability Index Changelog"
      path={PAGE_PATH}
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
