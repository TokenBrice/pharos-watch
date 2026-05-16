import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CitationBlock } from "@/components/citation-block";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import type { MethodologyChangelogEntry } from "@/components/methodology-version-card";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
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

  const citationFooter = (
    <CitationBlock
      entityClass="methodology"
      id={config.citation.id}
      title={config.title}
      url={`${SITE_URL}${config.path}`}
      version={config.citation.versionLabel}
    />
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
    >
      {config.renderContent?.()}
    </MethodologyChangelogPage>
  );

  return { metadata, entries, Page };
}
