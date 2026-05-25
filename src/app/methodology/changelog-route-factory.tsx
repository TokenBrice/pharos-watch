import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import type { MethodologyChangelogEntry } from "@/components/methodology-version-card";
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
  entries?: readonly T[];
  selectImpact?: (entry: T) => readonly string[];
  sections?: readonly { id: string; label: string }[];
  renderContent?: () => ReactNode;
  /** URN identity for the changelog route. */
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

  const Page = () => (
    <MethodologyChangelogPage
      breadcrumbName={config.breadcrumbName}
      path={config.path}
      title={config.title}
      lead={config.lead}
      entries={entries}
      sections={config.sections}
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

type StandardMethodologyChangelogSourceEntry = MethodologyChangelogSourceEntry & {
  impact: readonly string[];
};

interface StandardMethodologyChangelogRouteConfig<T extends StandardMethodologyChangelogSourceEntry>
  extends Omit<MethodologyChangelogRouteConfig<T>, "lead" | "selectImpact"> {
  leadSubject: string;
  versionLabel: string;
}

export function createStandardMethodologyChangelogRoute<T extends StandardMethodologyChangelogSourceEntry>({
  leadSubject,
  versionLabel,
  ...config
}: StandardMethodologyChangelogRouteConfig<T>): MethodologyChangelogRouteDefinition {
  return createMethodologyChangelogRoute({
    ...config,
    lead: (
      <>
        Full version history of {leadSubject} methodology decisions, from v1.0 to {versionLabel}.
      </>
    ),
    selectImpact: (entry) => entry.impact,
  });
}
