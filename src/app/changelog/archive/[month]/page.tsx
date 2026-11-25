import Link from "next/link";
import { notFound } from "next/navigation";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { EditorialColophon } from "@/components/digest/editorial-colophon";
import { EditorialMasthead } from "@/components/digest/editorial-masthead";
import { JsonLdScript } from "@/components/json-ld-script";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { ChangelogTimeline } from "@/components/methodology-history/changelog-timeline";
import {
  CHANGELOG_MONTH_ARCHIVES,
  CHANGELOG_TAG_ORDER,
  formatChangelogDateRange,
  formatChangelogTagCountLabel,
  formatShortMonthLabel,
  getAdjacentChangelogMonths,
  summarizeChangelogEntries,
} from "@/lib/changelog-history";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { cn } from "@/lib/utils";
import { formatLongDate } from "@shared/lib/format";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

interface ArchivePageProps {
  params: Promise<{ month: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return CHANGELOG_MONTH_ARCHIVES.map(({ month }) => ({ month }));
}

export async function generateMetadata({ params }: ArchivePageProps) {
  const { month } = await params;
  const archive = CHANGELOG_MONTH_ARCHIVES.find(
    (entry) => entry.month === month,
  );
  if (!archive) return { title: "Archive Not Found" };
  return buildPageMetadata({
    title: `Changelog: ${archive.label} Release Notes`,
    description: `Complete weekly Pharos release notes for ${archive.label}: stablecoin coverage additions, data pipeline improvements and product changes.`,
    canonical: archive.path,
  });
}

function AdjacentMonthNav({
  previous,
  next,
  ariaLabel,
}: {
  previous: (typeof CHANGELOG_MONTH_ARCHIVES)[number] | null;
  next: (typeof CHANGELOG_MONTH_ARCHIVES)[number] | null;
  ariaLabel: string;
}) {
  if (!previous && !next) return null;

  return (
    <nav
      aria-label={ariaLabel}
      className="flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      {previous ? (
        <Link
          href={previous.path}
          prefetch={false}
          className="pharos-focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:text-foreground sm:min-h-8"
        >
          <span aria-hidden="true">{"\u2190"}</span>
          <span>Previous: {previous.label}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.path}
          prefetch={false}
          className="pharos-focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:text-foreground sm:min-h-8"
        >
          <span>Next: {next.label}</span>
          <span aria-hidden="true">{"\u2192"}</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

export default async function ChangelogArchivePage({
  params,
}: ArchivePageProps) {
  const { month } = await params;
  const archive = CHANGELOG_MONTH_ARCHIVES.find(
    (entry) => entry.month === month,
  );
  if (!archive) notFound();

  const stats = summarizeChangelogEntries(archive.entries);
  const activeTags = CHANGELOG_TAG_ORDER.filter(
    (tag) => stats.tagCounts[tag] > 0,
  );
  const { previous, next } = getAdjacentChangelogMonths(archive.month);
  const latestWeek = archive.entries[0];
  const mastheadDate = latestWeek
    ? formatLongDate(new Date(`${latestWeek.dateRange.to}T00:00:00Z`), {
        utc: true,
      })
    : archive.label;
  const archiveYear = archive.month.slice(0, 4);
  const scrollspySections = archive.entries.map((entry) => ({
    id: `week-${entry.dateRange.to}`,
    label: formatChangelogDateRange(entry.dateRange.from, entry.dateRange.to, {
      compact: true,
    }),
  }));

  const archiveJsonLd = safeJsonLd({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Pharos Changelog: ${archive.label}`,
    description: `Weekly Pharos release notes for ${archive.label}.`,
    numberOfItems: archive.entries.length,
    itemListElement: archive.entries.map((entry, i) => ({
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
        url: `${SITE_URL}${archive.path}#week-${entry.dateRange.to}`,
        mainEntityOfPage: `${SITE_URL}${archive.path}#week-${entry.dateRange.to}`,
      },
    })),
  });

  return (
    <FeaturePageShell
      breadcrumbName={archive.label}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Changelog", url: "/changelog/" },
        { name: archive.label, url: archive.path },
      ]}
      backLink={{ href: "/changelog/", label: "All releases" }}
      path={archive.path}
      title={`Changelog: ${archive.label}`}
      variant="longform"
      containerClassName="max-w-4xl"
      preface={
        <>
          <JsonLdScript json={archiveJsonLd} />
          <EditorialMasthead
            issueNumber={`Volume ${archiveYear} · ${archive.label}`}
            date={mastheadDate}
          />
        </>
      }
      leadParagraphs={[
        `Complete weekly release notes for ${archive.label}. Every week published this month stays anchored at this permanent archive URL.`,
      ]}
    >
      <div className="pharos-subtle-band space-y-2.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="pharos-numeric font-medium text-foreground">
              {stats.weeks}
            </span>{" "}
            {stats.weeks === 1 ? "week" : "weeks"}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            <span className="pharos-numeric font-medium text-foreground">
              {stats.totalCommits.toLocaleString("en-US")}
            </span>{" "}
            {stats.totalCommits === 1 ? "commit" : "commits"}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            <span className="pharos-numeric font-medium text-foreground">
              {stats.totalUpdates}
            </span>{" "}
            {stats.totalUpdates === 1 ? "update" : "updates"}
          </span>
          {stats.methodologyBumps > 0 && (
            <>
              <span aria-hidden="true" className="text-muted-foreground/40">
                ·
              </span>
              <span>
                <span className="pharos-numeric font-medium text-foreground">
                  {stats.methodologyBumps}
                </span>{" "}
                {stats.methodologyBumps === 1
                  ? "methodology bump"
                  : "methodology bumps"}
              </span>
            </>
          )}
        </p>

        {activeTags.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/50 pt-2 text-xs text-muted-foreground">
            {activeTags.map((tag, index) => (
              <span key={tag} className="inline-flex items-center gap-x-2">
                {index > 0 && (
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                )}
                <span>
                  <span className="pharos-numeric text-foreground/90">
                    {stats.tagCounts[tag]}
                  </span>{" "}
                  {formatChangelogTagCountLabel(tag, stats.tagCounts[tag])}
                </span>
              </span>
            ))}
          </p>
        )}
      </div>

      <AdjacentMonthNav
        previous={previous}
        next={next}
        ariaLabel="Adjacent monthly archives"
      />

      <LongformScrollspyNav
        sections={scrollspySections}
        navAriaLabel={`${archive.label} weekly releases`}
      />

      <ChangelogTimeline entries={archive.entries} highlightLatest={false} />

      <div className="mt-10 space-y-4 border-t border-border/50 pt-6">
        <AdjacentMonthNav
          previous={previous}
          next={next}
          ariaLabel="More monthly archives"
        />

        <nav
          aria-label="All monthly archives"
          className="flex flex-wrap items-center gap-1.5"
        >
          {CHANGELOG_MONTH_ARCHIVES.map((item) => {
            const isCurrent = item.month === archive.month;
            return (
              <Link
                key={item.month}
                href={item.path}
                prefetch={false}
                aria-current={isCurrent ? "page" : undefined}
                className={cn(
                  "pharos-control-pill pharos-focus-ring gap-1.5",
                  isCurrent && "pharos-control-pill-active",
                )}
              >
                <span>{formatShortMonthLabel(item.month)}</span>{" "}
                <span className="pharos-numeric text-muted-foreground">
                  {item.entries.length}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>

      <EditorialColophon
        productionNote={`Monthly archive for ${archive.label}, compiled from ${stats.weeks} weekly release ${stats.weeks === 1 ? "record" : "records"} and ${stats.totalCommits.toLocaleString("en-US")} noise-filtered commits on main.`}
        citation={{
          title: `Changelog: ${archive.label} Release Notes`,
          canonicalUrl: `${SITE_URL}${archive.path}`,
        }}
      />
    </FeaturePageShell>
  );
}
