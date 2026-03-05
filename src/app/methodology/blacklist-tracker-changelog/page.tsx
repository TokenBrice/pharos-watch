import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/blacklist-tracker-changelog/",
  metadataTitle: "Blacklist Tracker Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos Blacklist Tracker methodology, from v1.0 through ${BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}. Every event-coverage, cursor, and enrichment revision documented.`,
  breadcrumbName: "Blacklist Tracker Changelog",
  title: "Blacklist Tracker Changelog",
  lead: (
    <>
      Full version history of Blacklist Tracker methodology decisions, from v1.0 to {BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-rose-500",
  entries: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  selectImpact: (entry) => entry.trackingImpact,
});

export const metadata = route.metadata;
export default route.Page;
