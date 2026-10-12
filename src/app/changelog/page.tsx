import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChangelogTimeline } from "@/components/changelog-timeline";
import { ChangelogWeekNav } from "@/components/changelog-week-nav";
import { EditorialMasthead } from "@/components/editorial-masthead";
import { JsonLdScript } from "@/components/json-ld-script";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { changelogs } from "@/data/changelogs";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { formatLongDate } from "@shared/lib/format";

export const metadata: Metadata = buildPageMetadata({
  title: "Changelog: What's New on Pharos",
  description:
    "Weekly release notes for Pharos: new stablecoin coverage, pipeline improvements, risk tooling updates, and more.",
  canonical: "/changelog/",
  ogImage: `${SITE_URL}/og-changelog.png`,
});

export default function ChangelogPage() {
  const latestEntry = changelogs[0];
  const latestYear = latestEntry
    ? new Date(latestEntry.dateRange.to + "T00:00:00").getFullYear()
    : new Date().getFullYear();
  const mastheadDate = latestEntry
    ? formatLongDate(new Date(latestEntry.dateRange.to + "T00:00:00"))
    : undefined;
  const changelogJsonLd = safeJsonLd({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Pharos Changelog",
    description: "Weekly release notes for Pharos.",
    numberOfItems: changelogs.length,
    itemListElement: changelogs.map((entry, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Article",
        headline: entry.headline ?? `Changelog - Week of ${entry.dateRange.to}`,
        datePublished: `${entry.dateRange.to}T00:00:00Z`,
        description: entry.summary.map((s) => s.label).slice(0, 3).join("; "),
        author: { "@id": `${SITE_URL}#person-tokenbrice` },
        publisher: { "@id": `${SITE_URL}#organization` },
        url: `${SITE_URL}/changelog/#week-${entry.dateRange.to}`,
        mainEntityOfPage: `${SITE_URL}/changelog/#week-${entry.dateRange.to}`,
      },
    })),
  });

  return (
    <FeaturePageShell
      breadcrumbName="Changelog"
      path="/changelog/"
      title="Changelog"
      variant="longform"
      preface={(
        <>
          <JsonLdScript json={changelogJsonLd} />
          <EditorialMasthead
            issueNumber={`Volume ${latestYear}`}
            date={mastheadDate}
          />
        </>
      )}
      leadParagraphs={[
        <>
          Weekly release notes. Follow{" "}
          <Link href="/pharoswatchbot/" className="pharos-prose-link">
            @PharosWatch on Telegram
          </Link>{" "}
          for real-time alerts, or browse the{" "}
          <a
            href="https://github.com/TokenBrice/pharos-watch/commits/main/"
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-prose-link"
          >
            full commit history
          </a>{" "}
          on GitHub.
        </>,
      ]}
    >
      {changelogs.length >= 4 && (
        <ChangelogWeekNav entries={changelogs.map(({ dateRange }) => ({ dateRange }))} />
      )}
      <ChangelogTimeline entries={changelogs} />
    </FeaturePageShell>
  );
}
