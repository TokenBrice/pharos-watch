import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS } from "@shared/lib/methodology-versions/safety-score";
import {
  METHODOLOGY_CHANGELOG_REGISTRY,
  type MethodologyChangelogRegistryEntry,
  type MethodologyChangelogRegistryKey,
} from "@shared/lib/methodology-versions/registry";
import { ScoringChangelogContent, scoringAnchorId } from "../changelog-content/scoring/content";

interface ChangelogDisplayConfig {
  metadataTitle: string;
  metadataDescription: (changelog: MethodologyChangelogRegistryEntry) => string;
  breadcrumbName: string;
  title: string;
  lead: (changelog: MethodologyChangelogRegistryEntry) => ReactNode;
  sections?: (changelog: MethodologyChangelogRegistryEntry) => readonly { id: string; label: string }[];
  renderContent?: () => ReactNode;
}

interface MethodologyChangelogPageProps {
  params: Promise<{ slug: string }>;
}

function standardLead(subject: string) {
  return function StandardChangelogLead(changelog: MethodologyChangelogRegistryEntry) {
    return <>Full version history of {subject} methodology decisions, from v1.0 to {changelog.currentLabel}.</>;
  };
}

const DISPLAY_CONFIG: Record<MethodologyChangelogRegistryKey, ChangelogDisplayConfig> = {
  "safety-score": {
    metadataTitle: "Safety Scores Changelog: Version History",
    metadataDescription: (changelog) =>
      `Safety Score methodology history from V1 through active ${changelog.currentLabel.toUpperCase()}, including the retained historical V8 methodology.`,
    breadcrumbName: "Scoring Changelog",
    title: "Safety Scores Changelog",
    lead: () => (
      <>
        The active V9 identity and the full numeric V8-and-earlier grading history
        &mdash; every weight change, new pillar or dimension, and structural decision.
      </>
    ),
    sections: () => SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS.map((version) => ({
      id: scoringAnchorId(version),
      label: version,
    })),
    renderContent: () => <ScoringChangelogContent />,
  },
  "depeg-dews": {
    metadataTitle: "Depeg Tracker + DEWS Changelog - Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Depeg Tracker + DEWS methodology, from v1.0 through ${changelog.currentLabel}. Every threshold, formula, and confirmation-policy revision documented.`,
    breadcrumbName: "Depeg Tracker + DEWS Changelog",
    title: "Depeg Tracker + DEWS Changelog",
    lead: standardLead("Depeg Tracker and DEWS"),
  },
  "depeg-resolver": {
    metadataTitle: "Depeg Duration Resolver Changelog: Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Depeg Duration Resolver methodology, from v1.0 through ${changelog.currentLabel}. Every resolution-rubric, stratification, and support-gate revision documented.`,
    breadcrumbName: "Depeg Duration Resolver Changelog",
    title: "Depeg Duration Resolver Changelog",
    lead: standardLead("DDR"),
  },
  "liquidity-score": {
    metadataTitle: "Liquidity Score Changelog - Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Liquidity Score methodology, from v1.0 through ${changelog.currentLabel}. Every scoring and normalization revision documented.`,
    breadcrumbName: "Liquidity Score Changelog",
    title: "Liquidity Score Changelog",
    lead: standardLead("Liquidity Score"),
  },
  "redemption-backstop": {
    metadataTitle: "Redemption Backstop Changelog - Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Redemption Backstop route methodology, including its v1.0 through ${changelog.currentLabel} scoring changes.`,
    breadcrumbName: "Redemption Backstop Changelog",
    title: "Redemption Backstop Changelog",
    lead: standardLead("Redemption Backstop"),
  },
  "stability-index": {
    metadataTitle: "Stability Index Changelog: Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Stability Index methodology, from v1.0 through ${changelog.currentLabel}. Every formula, cap, and component revision documented.`,
    breadcrumbName: "Stability Index Changelog",
    title: "Stability Index Changelog",
    lead: standardLead("PSI"),
  },
  "chain-health": {
    metadataTitle: "Chain Health Score Changelog: Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Chain Health Score methodology, from v1.0 through ${changelog.currentLabel}. Every weight, factor, and tier revision documented.`,
    breadcrumbName: "Chain Health Changelog",
    title: "Chain Health Score Changelog",
    lead: standardLead("Chain Health Score"),
  },
  yield: {
    metadataTitle: "Yield Intelligence Changelog - Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Yield Intelligence methodology, from v1.0 through ${changelog.currentLabel}. Every source-resolution and scoring revision documented.`,
    breadcrumbName: "Yield Intelligence Changelog",
    title: "Yield Intelligence Changelog",
    lead: standardLead("Yield Intelligence"),
  },
  "blacklist-tracker": {
    metadataTitle: "Blacklist Tracker Changelog: Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Blacklist Tracker methodology, from v1.0 through ${changelog.currentLabel}. Every event-coverage, cursor, and enrichment revision documented.`,
    breadcrumbName: "Blacklist Tracker Changelog",
    title: "Blacklist Tracker Changelog",
    lead: standardLead("Blacklist Tracker"),
  },
  "mint-burn-flow": {
    metadataTitle: "Mint/Burn Flow Changelog - Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${changelog.currentLabel}. Every scoring and ingestion-policy revision documented.`,
    breadcrumbName: "Mint/Burn Flow Changelog",
    title: "Mint/Burn Flow Changelog",
    lead: standardLead("Mint/Burn Flow"),
  },
  "pricing-pipeline": {
    metadataTitle: "Pricing Pipeline Changelog - Version History",
    metadataDescription: (changelog) =>
      `Full version history of the Pharos Pricing Pipeline methodology, from v1.0 through ${changelog.currentLabel}. Every source addition and consensus algorithm revision documented.`,
    breadcrumbName: "Pricing Pipeline Changelog",
    title: "Pricing Pipeline Changelog",
    lead: standardLead("Pricing Pipeline"),
  },
};

function slugFromPublicPath(publicPath: string): string {
  const match = publicPath.match(/^\/methodology\/([^/]+)\/$/);
  if (!match) throw new Error(`Invalid methodology changelog public path: ${publicPath}`);
  return match[1];
}

const CHANGELOG_BY_SLUG = new Map(
  METHODOLOGY_CHANGELOG_REGISTRY.map((changelog) => [slugFromPublicPath(changelog.publicPath), changelog]),
);

export const dynamicParams = false;

export function generateStaticParams() {
  return METHODOLOGY_CHANGELOG_REGISTRY.map((changelog) => ({
    slug: slugFromPublicPath(changelog.publicPath),
  }));
}

export async function generateMetadata({ params }: MethodologyChangelogPageProps): Promise<Metadata> {
  const { slug } = await params;
  const changelog = CHANGELOG_BY_SLUG.get(slug);
  if (!changelog) return { title: "Changelog Not Found" };

  const display = DISPLAY_CONFIG[changelog.key];
  return buildPageMetadata({
    title: display.metadataTitle,
    description: display.metadataDescription(changelog),
    canonical: changelog.publicPath,
    ogImage: "/og-editorial-methodology.png",
  });
}

export default async function MethodologyChangelogRoute({ params }: MethodologyChangelogPageProps) {
  const { slug } = await params;
  const changelog = CHANGELOG_BY_SLUG.get(slug);
  if (!changelog) notFound();

  const display = DISPLAY_CONFIG[changelog.key];
  return (
    <MethodologyChangelogPage
      breadcrumbName={display.breadcrumbName}
      path={changelog.publicPath}
      title={display.title}
      lead={display.lead(changelog)}
      entries={changelog.entries}
      sections={display.sections?.(changelog)}
      jsonLdIdentifier={buildPharosUrnJsonLdIdentifier(
        "methodology",
        changelog.citationId,
        changelog.currentLabel,
      )}
    >
      {display.renderContent?.()}
    </MethodologyChangelogPage>
  );
}
