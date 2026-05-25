import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: "/methodology/blacklist-tracker-changelog/",
  metadataTitle: "Blacklist Tracker Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos Blacklist Tracker methodology, from v1.0 through ${BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}. Every event-coverage, cursor, and enrichment revision documented.`,
  breadcrumbName: "Blacklist Tracker Changelog",
  title: "Blacklist Tracker Changelog",
  leadSubject: "Blacklist Tracker",
  versionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  entries: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  citation: { id: "blacklist-tracker", versionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
