import type { Metadata } from "next";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@/lib/blacklist-tracker-version";

export const metadata: Metadata = {
  title: "Blacklist Tracker Changelog — Version History",
  description:
    `Full version history of the Pharos Blacklist Tracker methodology, from v1.0 through ${BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}. Every event-coverage, cursor, and enrichment revision documented.`,
  alternates: { canonical: "/methodology/blacklist-tracker-changelog/" },
  openGraph: {
    title: "Blacklist Tracker Changelog — Version History",
    description:
      `Full version history of the Pharos Blacklist Tracker methodology, from v1.0 through ${BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}.`,
    url: "/methodology/blacklist-tracker-changelog/",
  },
};

const entries = BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG.map((entry) => ({
  version: entry.version,
  title: entry.title,
  date: entry.date,
  summary: entry.summary,
  impact: entry.trackingImpact,
  commits: entry.commits,
  reconstructed: entry.reconstructed,
}));

export default function BlacklistTrackerChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Blacklist Tracker Changelog"
      path="/methodology/blacklist-tracker-changelog/"
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
