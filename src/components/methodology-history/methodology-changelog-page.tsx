import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { JsonLdScript } from "@/components/json-ld-script";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { MethodologyVersionCard } from "@/components/methodology-history/methodology-version-card";
import type { MethodologyChangelogEntry } from "@shared/types/editorial-content";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { getPageSocialPreview } from "@/lib/page-metadata";
import type { PharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import {
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
} from "@shared/lib/methodology-versions/base";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { METHODOLOGY_RECENT_VERSIONS, methodologyDetailAnchors } from "@shared/lib/methodology-versions/archives";

export interface MethodologySiblingArchive {
  archive: string;
  href: string;
  current: boolean;
}

interface MethodologyChangelogPageProps {
  breadcrumbName: string;
  path: string;
  title: string;
  lead: React.ReactNode;
  entries?: readonly MethodologyChangelogEntry[];
  sections?: readonly { id: string; label: string }[];
  navAriaLabel?: string;
  children?: React.ReactNode;
  footerContent?: React.ReactNode;
  jsonLdIdentifier?: PharosUrnJsonLdIdentifier;
  /** A major-version shard: its newest entry is not the changelog's current release. */
  archiveShard?: boolean;
  /** Owning section anchor on `/methodology/#<anchor>`. */
  methodologyAnchor?: string;
  /** Mapped public technical specification under `/docs/<slug>/`. */
  docsPath?: string;
  /** Return link rendered above the page title. */
  backLink?: { href: string; label: string };
  /** Sibling major-version archive shards for quick jumping. */
  siblingArchives?: readonly MethodologySiblingArchive[];
  history?: {
    archivePath: (version: string) => string;
    anchorId: (version: string) => string;
  };
}

export function MethodologyChangelogPage({
  breadcrumbName,
  path,
  title,
  lead,
  entries = [],
  sections,
  navAriaLabel,
  children,
  footerContent,
  jsonLdIdentifier,
  archiveShard = false,
  methodologyAnchor,
  docsPath,
  backLink = { href: "/methodology/", label: "All methodology" },
  siblingArchives,
  history,
}: MethodologyChangelogPageProps) {
  const derivedSections = [
    { id: "overview", label: "Overview" },
    ...(archiveShard ? [] : [{ id: "latest-updates", label: "Latest" }]),
    ...(history
      ? [{ id: "earlier-versions", label: "Earlier versions" }]
      : entries.map((entry) => ({
          id: methodologyChangelogEntryId(entry.version),
          label: toMethodologyVersionLabel(entry.version),
        }))),
  ];

  const navSections = sections ?? derivedSections;
  const latestEntry = entries[0];
  const articleDescription =
    typeof lead === "string" ? lead : `${breadcrumbName} version history for Pharos.`;
  const currentMethodHref = methodologyAnchor ? `/methodology/#${methodologyAnchor}` : "/methodology/";

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
        <JsonLdScript
          json={safeJsonLd(
            buildArticleJsonLd({
              additionalType: "https://schema.org/TechArticle",
              headline: `${title} - Version History`,
              description: articleDescription,
              datePublished: `${entries.at(-1)!.date}T00:00:00Z`,
              dateModified: `${entries[0].date}T00:00:00Z`,
              author: "person",
              image: `${SITE_URL}${getPageSocialPreview(path).url}`,
              mainEntityOfPage: `${SITE_URL}${path}`,
              ...(jsonLdIdentifier ? { identifier: [jsonLdIdentifier] } : {}),
            }),
          )}
        />
      )}

      <div className="space-y-3">
        <Link
          href={backLink.href}
          className="pharos-focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{backLink.label}</span>
        </Link>
        <h1 className="pharos-page-title">{title}</h1>
        <p className="pharos-page-deck max-w-[72ch]">{lead}</p>
      </div>

      <section
        id="overview"
        className="pharos-subtle-band scroll-mt-36 space-y-3 px-4 py-3.5 sm:px-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span className="pharos-label text-foreground">
              {archiveShard ? "Historical archive" : "Version history"}
            </span>
            {latestEntry ? (
              <span className="pharos-numeric">
                {archiveShard
                  ? `${entries.length} release${entries.length === 1 ? "" : "s"}`
                  : `${toMethodologyVersionLabel(latestEntry.version)} · ${entries.length} releases`}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link
              href={currentMethodHref}
              className="pharos-prose-link whitespace-nowrap text-foreground"
            >
              Current methodology{"\u00a0\u2192"}
            </Link>
            <Link
              href={docsPath ?? "/docs/"}
              className="pharos-prose-link whitespace-nowrap text-muted-foreground"
            >
              {docsPath ? "Technical spec" : "Public docs"}
              {"\u00a0\u2192"}
            </Link>
          </div>
        </div>
        {siblingArchives && siblingArchives.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2.5">
            <span className="pharos-label mr-1">Major versions</span>
            {siblingArchives.map((item) =>
              item.current ? (
                <span
                  key={item.archive}
                  aria-current="page"
                  className="pharos-control-pill pharos-control-pill-active pharos-numeric min-h-8 px-2.5 py-1 text-xs"
                >
                  {item.archive}
                </span>
              ) : (
                <Link
                  key={item.archive}
                  href={item.href}
                  prefetch={false}
                  className="pharos-control-pill pharos-focus-ring pharos-numeric min-h-8 px-2.5 py-1 text-xs"
                >
                  {item.archive}
                </Link>
              ),
            )}
          </div>
        ) : null}
      </section>

      <LongformScrollspyNav
        sections={navSections}
        navAriaLabel={navAriaLabel ?? `${title} version navigation`}
      />

      {children ?? (
        <>
          {latestEntry && !archiveShard ? (
            <section id="latest-updates" className="scroll-mt-36 space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="pharos-label text-foreground">Latest version</p>
                {history && entries.length > METHODOLOGY_RECENT_VERSIONS ? (
                  <p className="pharos-meta">
                    Showing{" "}
                    <span className="pharos-numeric text-foreground/85">
                      {Math.min(entries.length, METHODOLOGY_RECENT_VERSIONS)}
                    </span>{" "}
                    of <span className="pharos-numeric text-foreground/85">{entries.length}</span> releases
                  </p>
                ) : null}
              </div>
              {(history ? entries.slice(0, METHODOLOGY_RECENT_VERSIONS) : entries).map((entry, index) => (
                <MethodologyVersionCard
                  key={entry.version}
                  entry={entry}
                  entryId={history?.anchorId(entry.version) ?? methodologyChangelogEntryId(entry.version)}
                  defaultOpen={index === 0}
                  archiveHref={
                    history
                      ? `${history.archivePath(entry.version)}#${history.anchorId(entry.version)}`
                      : undefined
                  }
                />
              ))}
            </section>
          ) : (
            <div className="space-y-4">
              {entries.map((entry, index) => (
                <MethodologyVersionCard
                  key={entry.version}
                  entry={entry}
                  entryId={history?.anchorId(entry.version) ?? methodologyChangelogEntryId(entry.version)}
                  defaultOpen={index === 0}
                  archiveHref={
                    history
                      ? `${history.archivePath(entry.version)}#${history.anchorId(entry.version)}`
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          {history && entries.length > METHODOLOGY_RECENT_VERSIONS && (
            <section id="earlier-versions" className="scroll-mt-36 space-y-3">
              <div className="space-y-1">
                <h2 className="pharos-section-title">Earlier versions</h2>
                <p className="max-w-[72ch] text-sm text-muted-foreground">
                  Compact summaries retain historical citation targets. Open a version archive for its full evidence and commit provenance.
                </p>
              </div>
              <ol className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/30">
                {entries.slice(METHODOLOGY_RECENT_VERSIONS).map((entry) => (
                  <li
                    key={entry.version}
                    id={history.anchorId(entry.version)}
                    className="scroll-mt-36 grid gap-1.5 px-4 py-3 sm:grid-cols-[5.5rem_7.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-4"
                  >
                    <Link
                      href={`${history.archivePath(entry.version)}#${history.anchorId(entry.version)}`}
                      prefetch={false}
                      className="pharos-prose-link pharos-numeric text-xs font-semibold text-foreground"
                    >
                      {toMethodologyVersionLabel(entry.version)}
                    </Link>
                    <span className="pharos-numeric text-xs text-muted-foreground">
                      {formatMethodologyDisplayDate(entry.date)}
                    </span>
                    <div className="min-w-0 space-y-1">
                      <Link
                        href={`${history.archivePath(entry.version)}#${history.anchorId(entry.version)}`}
                        prefetch={false}
                        className="pharos-prose-link text-sm font-medium text-foreground"
                      >
                        {entry.title}
                      </Link>
                      <p className="max-w-[72ch] text-xs leading-relaxed text-muted-foreground">
                        {entry.summary}
                      </p>
                      {methodologyDetailAnchors(entry.detail).length > 0 && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
                          {methodologyDetailAnchors(entry.detail).map((anchor) => (
                            <Link
                              key={anchor.id}
                              id={anchor.id}
                              href={`${history.archivePath(entry.version)}#${anchor.id}`}
                              prefetch={false}
                              className="pharos-prose-link scroll-mt-36 text-xs text-muted-foreground"
                            >
                              {anchor.label}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
      {footerContent}
    </div>
  );
}
