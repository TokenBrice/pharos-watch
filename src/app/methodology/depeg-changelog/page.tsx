import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@/lib/depeg-dews-version";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "../changelog-page-utils";

const PAGE_PATH = "/methodology/depeg-changelog/";

export const metadata = buildMethodologyChangelogMetadata({
  title: "Depeg Tracker + DEWS Changelog - Version History",
  description:
    `Full version history of the Pharos Depeg Tracker + DEWS methodology, from v1.0 through ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}. Every threshold, formula, and confirmation-policy revision documented.`,
  path: PAGE_PATH,
});

const entries = mapMethodologyChangelogEntries(
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  (entry) => entry.methodologyImpact,
);

export default function DepegChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Depeg Tracker + DEWS Changelog"
      path={PAGE_PATH}
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
