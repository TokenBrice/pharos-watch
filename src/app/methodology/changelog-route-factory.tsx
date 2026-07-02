import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import type { MethodologyChangelogEntry } from "@/components/methodology-version-card";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";

interface MethodologyChangelogRouteConfig {
  path: string;
  metadataTitle: string;
  metadataDescription: string;
  breadcrumbName: string;
  title: string;
  lead: ReactNode;
  entries?: readonly MethodologyChangelogEntry[];
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
  Page: () => ReactNode;
}

export function createMethodologyChangelogRoute(
  config: MethodologyChangelogRouteConfig,
): MethodologyChangelogRouteDefinition {
  const metadata = buildPageMetadata({
    title: config.metadataTitle,
    description: config.metadataDescription,
    canonical: config.path,
    ogImage: "/og-editorial-methodology.png",
  });
  const entries = [...(config.entries ?? [])];

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

  return { metadata, Page };
}

interface StandardMethodologyChangelogRouteConfig extends Omit<MethodologyChangelogRouteConfig, "lead"> {
  leadSubject: string;
  versionLabel: string;
  /** First version in the changelog. Defaults to "v1.0". */
  fromVersion?: string;
}

export function createStandardMethodologyChangelogRoute({
  leadSubject,
  versionLabel,
  fromVersion = "v1.0",
  ...config
}: StandardMethodologyChangelogRouteConfig): MethodologyChangelogRouteDefinition {
  return createMethodologyChangelogRoute({
    ...config,
    lead: (
      <>
        Full version history of {leadSubject} methodology decisions, from {fromVersion} to {versionLabel}.
      </>
    ),
  });
}
