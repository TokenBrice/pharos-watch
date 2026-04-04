import type { Metadata } from "next";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChangelogEntryCard } from "@/components/changelog-entry-card";
import { buildPageMetadata } from "@/lib/page-metadata";
import { changelogs } from "@/data/changelogs";

export const metadata: Metadata = buildPageMetadata({
  title: "Changelog: What's New on Pharos",
  description:
    "Weekly release notes for Pharos — new stablecoin coverage, pipeline improvements, risk tooling updates, and more.",
  canonical: "/changelog/",
});

export default function ChangelogPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Changelog"
      path="/changelog/"
      title="Changelog"
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
      leadParagraphs={[
        "Weekly release notes covering new coverage, pipeline improvements, and feature updates.",
      ]}
    >
      <div className="divide-y divide-border">
        {changelogs.map((entry) => (
          <div key={entry.dateRange.to} className="py-8 first:pt-0">
            <ChangelogEntryCard entry={entry} />
          </div>
        ))}
      </div>
    </FeaturePageShell>
  );
}
