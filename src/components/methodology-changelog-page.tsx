import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { MethodologyVersionCard, type MethodologyChangelogEntry } from "@/components/methodology-version-card";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import type { PharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import {
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
} from "@shared/lib/methodology-versions/base";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

interface MethodologyChangelogPageProps {
  breadcrumbName: string;
  path: string;
  title: string;
  lead: React.ReactNode;
  entries?: readonly MethodologyChangelogEntry[];
  sections?: readonly { id: string; label: string }[];
  railLabel?: string;
  navAriaLabel?: string;
  children?: React.ReactNode;
  footerContent?: React.ReactNode;
  jsonLdIdentifier?: PharosUrnJsonLdIdentifier;
}

export function MethodologyChangelogPage({
  breadcrumbName,
  path,
  title,
  lead,
  entries = [],
  sections,
  railLabel = "Jump to Version",
  navAriaLabel,
  children,
  footerContent,
  jsonLdIdentifier,
}: MethodologyChangelogPageProps) {
  const derivedSections = [
    { id: "overview", label: "Overview" },
    { id: "latest-updates", label: "Latest" },
    ...entries.map((entry) => ({
      id: methodologyChangelogEntryId(entry.version),
      label: toMethodologyVersionLabel(entry.version),
    })),
  ];

  const navSections = sections ?? derivedSections;
  const latestEntry = entries[0];
  const articleDescription =
    typeof lead === "string" ? lead : `${breadcrumbName} version history for Pharos.`;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Methodology", url: "/methodology/" },
          { name: breadcrumbName, url: path },
        ]}
      />
      {entries.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(
              buildArticleJsonLd({
                additionalType: "https://schema.org/TechArticle",
                headline: `${title} - Version History`,
                description: articleDescription,
                datePublished: `${entries.at(-1)!.date}T00:00:00Z`,
                dateModified: `${entries[0].date}T00:00:00Z`,
                author: "person",
                image: `${SITE_URL}/og-editorial-methodology.png`,
                mainEntityOfPage: `${SITE_URL}${path}`,
                ...(jsonLdIdentifier ? { identifier: [jsonLdIdentifier] } : {}),
              }),
            ),
          }}
        />
      )}

      <div className="space-y-3">
        <h1 className="pharos-page-title">{title}</h1>

        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{lead}</p>
      </div>

      <section
        id="overview"
        className="pharos-card-shell scroll-mt-28 px-5 py-5 sm:px-6"
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
          <div className="space-y-2">
            <p className="pharos-kicker">What This Controls</p>
            <h2 className="text-xl font-semibold text-foreground">{title} version history</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Use this changelog to trace how Pharos changed the related scoring, data-source, threshold, or
              interpretation rules over time. The latest card below is the current public contract; older entries are
              retained so historical charts and citations can be read against the rules active at the time.
            </p>
          </div>
          <div className="space-y-2 border-border/50 lg:border-l lg:pl-5">
            <p className="pharos-kicker">Primary References</p>
            <div className="flex flex-col gap-2 text-sm">
              <Link
                href="/methodology/"
                className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-frost-blue"
              >
                Read the current methodology
              </Link>
              <Link
                href="/docs/"
                className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-frost-blue"
              >
                Browse the public docs archive
              </Link>
            </div>
          </div>
        </div>
      </section>

      <LongformScrollspyNav
        sections={navSections}
        railLabel={railLabel}
        navAriaLabel={navAriaLabel ?? `${title} version navigation`}
      />
      {children ?? (
        <>
          {latestEntry && (
            <section
              id="latest-updates"
              className="pharos-card-shell scroll-mt-28 px-5 py-5 sm:px-6"
            >
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
                <div className="space-y-3">
                  <p className="pharos-kicker">Latest Version</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-block rounded-full border border-border/60 bg-muted/55 px-2.5 py-0.5 text-xs pharos-numeric font-medium text-foreground">
                      {toMethodologyVersionLabel(latestEntry.version)}
                    </span>
                    <span className="inline-block rounded-full border border-border/60 bg-muted/55 px-2.5 py-0.5 text-xs pharos-numeric font-medium text-foreground">
                      {formatMethodologyDisplayDate(latestEntry.date)}
                    </span>
                    {latestEntry.reconstructed && (
                      <span className="inline-block rounded-full border border-border/60 bg-background/55 px-2.5 py-0.5 text-xs text-muted-foreground">
                        Reconstructed
                      </span>
                    )}
                  </div>
                  <h2 className="text-xl font-semibold tracking-tight">{latestEntry.title}</h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{latestEntry.summary}</p>
                </div>
                <div className="border-border/50 lg:border-l lg:pl-5">
                  <p className="pharos-kicker">Impact Snapshot</p>
                  {latestEntry.impact.length > 0 ? (
                    <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                      {latestEntry.impact.slice(0, 4).map((item) => (
                        <li key={item} className="flex items-start gap-2">
                          <span className="mt-[0.42rem] h-1.5 w-1.5 rounded-full bg-foreground/40" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No impact notes recorded for this version.</p>
                  )}
                </div>
              </div>
            </section>
          )}

          <div className="space-y-4">
            {entries.map((entry, index) => (
              <MethodologyVersionCard
                key={entry.version}
                entry={entry}
                entryId={methodologyChangelogEntryId(entry.version)}
                defaultOpen={index === 0}
              />
            ))}
          </div>
        </>
      )}
      {footerContent}
    </div>
  );
}
