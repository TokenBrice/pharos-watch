import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import type { MethodologyChangelogEntry } from "@/components/methodology-version-card";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "./changelog-page-utils";

interface MethodologyChangelogSourceEntry {
  version: string;
  title: string;
  date: string;
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
  entries: readonly T[];
  selectImpact: (entry: T) => readonly string[];
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
  const entries = mapMethodologyChangelogEntries(config.entries, config.selectImpact);

  const Page = () => (
    <MethodologyChangelogPage
      breadcrumbName={config.breadcrumbName}
      path={config.path}
      title={config.title}
      lead={config.lead}
      accentClass={config.accentClass}
      entries={entries}
    />
  );

  return { metadata, entries, Page };
}
