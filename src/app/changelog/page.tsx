import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChangelogEntryCard } from "@/components/changelog-entry-card";
import { ChangelogWeekNav } from "@/components/changelog-week-nav";
import { EditorialMasthead } from "@/components/editorial-masthead";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { changelogs } from "@/data/changelogs";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const metadata: Metadata = buildPageMetadata({
  title: "Changelog: What's New on Pharos",
  description:
    "Weekly release notes for Pharos — new stablecoin coverage, pipeline improvements, risk tooling updates, and more.",
  canonical: "/changelog/",
  ogImage: `${SITE_URL}/og-changelog.png`,
});

export default function ChangelogPage() {
  const years = new Set(
    changelogs.map((e) => new Date(e.dateRange.to + "T00:00:00").getFullYear()),
  );
  const multiYear = years.size > 1;
  const latestEntry = changelogs[0];
  const latestYear = latestEntry
    ? new Date(latestEntry.dateRange.to + "T00:00:00").getFullYear()
    : new Date().getFullYear();
  const mastheadDate = latestEntry
    ? new Date(latestEntry.dateRange.to + "T00:00:00").toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
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
      containerClassName="mx-auto max-w-3xl"
      preface={(
        <>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: changelogJsonLd }}
          />
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
      <ol className="relative ml-1.5 border-l border-border/50">
        {changelogs.map((entry, i) => {
          const year = new Date(entry.dateRange.to + "T00:00:00").getFullYear();
          const prevYear =
            i > 0
              ? new Date(changelogs[i - 1].dateRange.to + "T00:00:00").getFullYear()
              : year;
          const showYearDivider = multiYear && (i === 0 || year !== prevYear);

          return (
            <Fragment key={entry.dateRange.to}>
              {showYearDivider && (
                <li className={`relative pl-8 ${i > 0 ? "mt-14" : ""}`}>
                  <span className="text-sm pharos-numeric font-medium text-muted-foreground/70">
                    {year}
                  </span>
                </li>
              )}
              <li
                id={`week-${entry.dateRange.to}`}
                className={`relative pl-8 ${showYearDivider ? "mt-4" : i > 0 ? "mt-14" : ""}`}
              >
                <div
                  className={`absolute -left-[5px] top-[7px] size-2.5 rounded-full ${
                    i === 0
                      ? "border-2 border-foreground bg-foreground"
                      : "border-2 border-border bg-background"
                  }`}
                  aria-hidden
                />
                <ChangelogEntryCard entry={entry} isLatest={i === 0} />
              </li>
            </Fragment>
          );
        })}
      </ol>
    </FeaturePageShell>
  );
}
