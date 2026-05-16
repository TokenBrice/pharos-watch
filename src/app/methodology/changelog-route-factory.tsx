import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Download } from "lucide-react";
import { CitationBlock } from "@/components/citation-block";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import type { MethodologyChangelogEntry } from "@/components/methodology-version-card";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "./changelog-page-utils";

interface MethodologyChangelogSourceEntry {
  version: string;
  title: string;
  date: string;
  effectiveAt: number;
  summary: string;
  commits: readonly string[];
  reconstructed: boolean;
}

interface MethodologyChangelogRouteConfig<T extends MethodologyChangelogSourceEntry> {
  path: string;
  metadataTitle: string;
  metadataDescription: string;
  breadcrumbName: string;
  title: string;
  lead: ReactNode;
  accentClass: string;
  entries?: readonly T[];
  selectImpact?: (entry: T) => readonly string[];
  sections?: readonly { id: string; label: string }[];
  renderContent?: () => ReactNode;
  /** URN identity for the citation block at page bottom. */
  citation: {
    /** Methodology slug used as the URN id (e.g. "safety-score", "dews"). */
    id: string;
    /** Current version label (e.g. "v7.2"). Surfaced in the citation body. */
    versionLabel: string;
    /**
     * Filename key for the rendered white-paper PDF (e.g. "scoring",
     * "depeg-dews", "stability-index"). Defaults to `id` when the
     * citation id and the PDF key already match. PDFs live under
     * `/methodology/pdf/<pdfKey>-<versionLabel>.pdf`.
     */
    pdfKey?: string;
  };
}

interface MethodologyChangelogRouteDefinition {
  metadata: Metadata;
  entries: MethodologyChangelogEntry[];
  Page: () => ReactNode;
}

export function createMethodologyChangelogRoute<T extends MethodologyChangelogSourceEntry>(
  config: MethodologyChangelogRouteConfig<T>,
): MethodologyChangelogRouteDefinition {
  const metadata = buildMethodologyChangelogMetadata({
    title: config.metadataTitle,
    description: config.metadataDescription,
    path: config.path,
  });
  const entries = config.entries && config.selectImpact
    ? mapMethodologyChangelogEntries(config.entries, config.selectImpact)
    : [];

  const pdfKey = config.citation.pdfKey ?? config.citation.id;
  const pdfHref = `/methodology/pdf/${pdfKey}-${config.citation.versionLabel}.pdf`;

  const citationFooter = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card/60 px-4 py-3 text-sm text-muted-foreground">
        <span className="pharos-kicker text-foreground/80">White paper</span>
        <a
          href={pdfHref}
          className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-sm font-medium text-foreground hover:underline hover:underline-offset-4"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Download {config.title} {config.citation.versionLabel} (PDF)
        </a>
      </div>

      <CitationBlock
        entityClass="methodology"
        id={config.citation.id}
        qualifier={config.citation.versionLabel}
        title={config.title}
        url={`${SITE_URL}${config.path}`}
        version={config.citation.versionLabel}
      />
    </div>
  );

  const Page = () => (
    <MethodologyChangelogPage
      breadcrumbName={config.breadcrumbName}
      path={config.path}
      title={config.title}
      lead={config.lead}
      accentClass={config.accentClass}
      entries={entries}
      sections={config.sections}
      footerContent={citationFooter}
      jsonLdIdentifier={buildPharosUrnJsonLdIdentifier(
        "methodology",
        config.citation.id,
        config.citation.versionLabel,
      )}
    >
      {config.renderContent?.()}
    </MethodologyChangelogPage>
  );

  return { metadata, entries, Page };
}
