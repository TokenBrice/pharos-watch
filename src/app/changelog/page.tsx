import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChangelogTimeline } from "@/components/changelog-timeline";
import { EditorialMasthead } from "@/components/editorial-masthead";
import { JsonLdScript } from "@/components/json-ld-script";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { changelogs } from "@/data/changelogs";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { formatLongDate } from "@shared/lib/format";
import { CHANGELOG_MONTH_ARCHIVES, RECENT_CHANGELOGS } from "@/lib/changelog-history";

export const metadata: Metadata = buildPageMetadata({
  title: "Changelog: Weekly Release Notes",
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
        url: `${SITE_URL}/changelog/archive/${entry.dateRange.to.slice(0, 7)}/#week-${entry.dateRange.to}`,
        mainEntityOfPage: `${SITE_URL}/changelog/archive/${entry.dateRange.to.slice(0, 7)}/#week-${entry.dateRange.to}`,
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
      <p className="text-sm text-muted-foreground">Showing the latest {RECENT_CHANGELOGS.length} of {changelogs.length} weeks. All earlier releases remain available in the monthly archives.</p>
      <ChangelogTimeline entries={RECENT_CHANGELOGS} />
      <section aria-label="Changelog archives" className="mt-12 space-y-6">
        <h2 className="pharos-section-title">Monthly archives</h2>
        {CHANGELOG_MONTH_ARCHIVES.map((archive) => (
          <section key={archive.month} id={`month-${archive.month}`} className="scroll-mt-28 space-y-3">
            <h3><Link href={archive.path} prefetch={false} className="pharos-prose-link font-medium">{archive.label} · {archive.entries.length} weeks</Link></h3>
            <ul className="divide-y divide-border/60">
              {archive.entries.filter((entry) => !RECENT_CHANGELOGS.includes(entry)).map((entry) => (
                <li key={entry.dateRange.to} id={`week-${entry.dateRange.to}`} className="scroll-mt-28 py-3">
                  <Link id={entry.dateRange.to} href={`${archive.path}#week-${entry.dateRange.to}`} prefetch={false} className="pharos-prose-link text-sm">
                    {entry.dateRange.to} · {entry.headline ?? "Weekly release notes"}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>
    </FeaturePageShell>
  );
}
