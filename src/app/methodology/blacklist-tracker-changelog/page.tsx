import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "../changelog-page-utils";

const PAGE_PATH = "/methodology/blacklist-tracker-changelog/";

export const metadata = buildMethodologyChangelogMetadata({
  title: "Blacklist Tracker Changelog — Version History",
  description:
    `Full version history of the Pharos Blacklist Tracker methodology, from v1.0 through ${BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}. Every event-coverage, cursor, and enrichment revision documented.`,
  path: PAGE_PATH,
});

const entries = mapMethodologyChangelogEntries(
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  (entry) => entry.trackingImpact,
);

export default function BlacklistTrackerChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Blacklist Tracker Changelog"
      path={PAGE_PATH}
      title="Blacklist Tracker Changelog"
      lead={
        <>
          Full version history of Blacklist Tracker methodology decisions, from v1.0 to {BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}.
        </>
      }
      accentClass="border-l-rose-500"
      entries={entries}
    />
  );
}
