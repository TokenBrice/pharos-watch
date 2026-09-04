import type { Metadata } from "next";
import { DepegEventArchive } from "@/app/depeg/depeg-event-archive";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";

const ARCHIVE_DESCRIPTION =
  "Browse every permanent Pharos depeg event page, grouped by month with dates, peak deviations, and links to the complete incident record.";

export const metadata: Metadata = buildPageMetadata({
  title: "Depeg Event Archive",
  description: ARCHIVE_DESCRIPTION,
  canonical: "/depeg/archive/",
});

export default function DepegArchivePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Depeg Event Archive"
      path="/depeg/archive/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Depeg Tracker", url: "/depeg/" },
        { name: "Event Archive", url: "/depeg/archive/" },
      ]}
      title="Depeg Event Archive"
      leadParagraphs={[
        "The complete permanent record of confirmed depeg events tracked by Pharos, grouped by month and ordered newest first.",
      ]}
    >
      <DepegEventArchive />
    </FeaturePageShell>
  );
}
