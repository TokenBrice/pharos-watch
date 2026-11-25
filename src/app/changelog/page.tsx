import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChangelogTimeline } from "@/components/methodology-history/changelog-timeline";
import { EditorialColophon } from "@/components/digest/editorial-colophon";
import { EditorialMasthead } from "@/components/digest/editorial-masthead";
import { JsonLdScript } from "@/components/json-ld-script";
import { SeeAlsoFooter } from "@/components/see-also-footer";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { changelogs } from "@/data/changelogs";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { formatLongDate } from "@shared/lib/format";
import {
  CHANGELOG_MONTH_ARCHIVES,
  RECENT_CHANGELOGS,
  formatShortMonthLabel,
  isMethodologySummaryHref,
  summarizeChangelogEntries,
} from "@/lib/changelog-history";

export const metadata: Metadata = buildPageMetadata({
  title: "Changelog: Weekly Release Notes",
  description:
    "Weekly release notes for Pharos: new stablecoin coverage, pipeline improvements, risk tooling updates, and more.",
  canonical: "/changelog/",
});

export default function ChangelogPage() {
  const latestEntry = changelogs[0];
  const latestYear = latestEntry
    ? new Date(`${latestEntry.dateRange.to}T00:00:00Z`).getUTCFullYear()
    : new Date().getUTCFullYear();
  const mastheadDate = latestEntry
    ? formatLongDate(new Date(`${latestEntry.dateRange.to}T00:00:00Z`), {
        utc: true,
      })
    : undefined;
  const corpusStats = summarizeChangelogEntries(changelogs);
  const recentSet = new Set(RECENT_CHANGELOGS);

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
        description: entry.summary
          .map((s) => s.label)
          .slice(0, 3)
          .join("; "),
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
      containerClassName="max-w-4xl"
      preface={
        <>
          <JsonLdScript json={changelogJsonLd} />
          <EditorialMasthead
            issueNumber={`Volume ${latestYear}`}
            date={mastheadDate}
          />
        </>
      }
      leadParagraphs={[
        <>
          Weekly product, coverage, and pipeline release notes. For scoring
          formulas and model rule changes, read the{" "}
          <Link href="/methodology/" className="pharos-prose-link">
            Methodology version histories
          </Link>{" "}
          or subscribe to{" "}
          <a href="/feed/methodology.xml" className="pharos-prose-link">
            Methodology RSS
          </a>
          .
        </>,
        <>
          Use{" "}
          <Link href="/pharoswatchbot/" className="pharos-prose-link">
            @PharosWatchBot
          </Link>{" "}
          for real-time alerts, follow{" "}
          <a
            href="https://t.me/pharoswatch"
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-prose-link"
          >
            @pharoswatch
          </a>{" "}
          on Telegram for daily digests, or browse the{" "}
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
      <div className="pharos-subtle-band space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              <span className="pharos-numeric font-medium text-foreground">
                {corpusStats.weeks}
              </span>{" "}
              {corpusStats.weeks === 1 ? "week" : "weeks"}
            </span>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span>
              <span className="pharos-numeric font-medium text-foreground">
                {CHANGELOG_MONTH_ARCHIVES.length}
              </span>{" "}
              {CHANGELOG_MONTH_ARCHIVES.length === 1 ? "month" : "months"}
            </span>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span>
              <span className="pharos-numeric font-medium text-foreground">
                {corpusStats.totalCommits.toLocaleString("en-US")}
              </span>{" "}
              commits
            </span>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span>
              Showing latest{" "}
              <span className="pharos-numeric font-medium text-foreground">
                {RECENT_CHANGELOGS.length}
              </span>{" "}
              in full
            </span>
          </p>
          <a
            href="#monthly-archives"
            className="pharos-prose-link whitespace-nowrap text-xs"
          >
            Jump to monthly archives{"\u00a0\u2193"}
          </a>
        </div>

        <nav
          aria-label="Jump to monthly archive"
          className="flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-3"
        >
          {CHANGELOG_MONTH_ARCHIVES.map((archive) => (
            <a
              key={archive.month}
              href={`#month-${archive.month}`}
              className="pharos-control-pill pharos-focus-ring gap-1.5"
            >
              <span>{formatShortMonthLabel(archive.month)}</span>{" "}
              <span className="pharos-numeric text-muted-foreground">
                {archive.entries.length}
              </span>
            </a>
          ))}
        </nav>
      </div>

      <ChangelogTimeline entries={RECENT_CHANGELOGS} />

      <section
        id="monthly-archives"
        aria-label="Changelog archives"
        className="mt-12 scroll-mt-32 space-y-8"
      >
        <h2 className="pharos-section-title">Monthly archives</h2>
        {CHANGELOG_MONTH_ARCHIVES.map((archive) => {
          const olderEntries = archive.entries.filter(
            (entry) => !recentSet.has(entry),
          );
          const shownAboveCount = archive.entries.length - olderEntries.length;
          const monthStats = summarizeChangelogEntries(archive.entries);

          return (
            <section
              key={archive.month}
              id={`month-${archive.month}`}
              className="scroll-mt-32 space-y-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border/60 pb-2">
                <h3 className="pharos-display text-base font-semibold text-foreground">
                  <Link
                    href={archive.path}
                    prefetch={false}
                    className="pharos-prose-link"
                  >
                    {archive.label}
                  </Link>
                </h3>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>
                    <span className="pharos-numeric">
                      {archive.entries.length}
                    </span>{" "}
                    {archive.entries.length === 1 ? "week" : "weeks"}
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                  <span>
                    <span className="pharos-numeric">
                      {monthStats.totalCommits.toLocaleString("en-US")}
                    </span>{" "}
                    {monthStats.totalCommits === 1 ? "commit" : "commits"}
                  </span>
                  {shownAboveCount > 0 && olderEntries.length > 0 && (
                    <>
                      <span
                        aria-hidden="true"
                        className="text-muted-foreground/40"
                      >
                        ·
                      </span>
                      <span>
                        <span className="pharos-numeric">
                          {shownAboveCount}
                        </span>{" "}
                        shown above,{" "}
                        <span className="pharos-numeric">
                          {olderEntries.length}
                        </span>{" "}
                        archived below
                      </span>
                    </>
                  )}
                </p>
              </div>

              {olderEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {shownAboveCount === 1
                    ? "Latest week shown above."
                    : shownAboveCount === 2
                      ? "Both weeks shown above."
                      : `All ${shownAboveCount} weeks shown above.`}{" "}
                  <Link
                    href={archive.path}
                    prefetch={false}
                    className="pharos-prose-link"
                  >
                    Open complete month archive{"\u00a0\u2192"}
                  </Link>
                </p>
              ) : (
                <ul className="divide-y divide-border/50">
                  {olderEntries.map((entry) => {
                    const methodologyCount = entry.summary.filter((item) =>
                      isMethodologySummaryHref(item.href),
                    ).length;

                    return (
                      <li
                        key={entry.dateRange.to}
                        id={`week-${entry.dateRange.to}`}
                        className="grid scroll-mt-32 grid-cols-1 gap-x-4 gap-y-1 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-baseline"
                      >
                        <time
                          dateTime={entry.dateRange.to}
                          className="pharos-numeric text-xs text-muted-foreground"
                        >
                          {entry.dateRange.to}
                        </time>
                        <Link
                          id={entry.dateRange.to}
                          href={`${archive.path}#week-${entry.dateRange.to}`}
                          prefetch={false}
                          className="pharos-prose-link min-w-0 text-sm font-medium text-foreground"
                        >
                          {entry.headline ?? "Weekly release notes"}
                        </Link>
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground sm:justify-end sm:whitespace-nowrap">
                          <span>
                            <span className="pharos-numeric">
                              {entry.summary.length}
                            </span>{" "}
                            {entry.summary.length === 1 ? "update" : "updates"}
                          </span>
                          <span
                            aria-hidden="true"
                            className="text-muted-foreground/40"
                          >
                            ·
                          </span>
                          <span>
                            <span className="pharos-numeric">
                              {entry.stats.totalCommits}
                            </span>{" "}
                            {entry.stats.totalCommits === 1
                              ? "commit"
                              : "commits"}
                          </span>
                          {methodologyCount > 0 && (
                            <>
                              <span
                                aria-hidden="true"
                                className="text-muted-foreground/40"
                              >
                                ·
                              </span>
                              <span>
                                <span className="pharos-numeric">
                                  {methodologyCount}
                                </span>{" "}
                                {methodologyCount === 1
                                  ? "methodology"
                                  : "methodologies"}
                              </span>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </section>

      <EditorialColophon
        productionNote={`Weekly release log covering ${corpusStats.weeks} published ${corpusStats.weeks === 1 ? "week" : "weeks"} across ${CHANGELOG_MONTH_ARCHIVES.length} monthly ${CHANGELOG_MONTH_ARCHIVES.length === 1 ? "archive" : "archives"}. Commit counts reflect noise-filtered totals on main; each week lists up to 20 recent commits while GitHub retains the full history.`}
        citation={{
          title: "Changelog: Weekly Release Notes",
          canonicalUrl: `${SITE_URL}/changelog/`,
        }}
      />
      <SeeAlsoFooter route="/changelog/" />
    </FeaturePageShell>
  );
}
