import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  DocsDirectory,
  type DocsDirectoryCluster,
  type DocsDirectoryEntry,
} from "@/components/docs/docs-directory";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import docsMetadata from "@/generated/docs-metadata.json";

export const metadata: Metadata = buildPageMetadata({
  title: "Docs: Stablecoin Methodology & API Documentation",
  description:
    "Browse Pharos documentation for stablecoin methodology, API contracts, pricing, depeg detection, scoring, and classification rules.",
  canonical: "/docs/",
});

interface DocClusterDefinition {
  id: string;
  title: string;
  description: string;
  slugs: readonly string[];
}

const DOC_CLUSTER_DEFINITIONS: readonly DocClusterDefinition[] = [
  {
    id: "core-pipeline-policy",
    title: "Core Pipeline & Policy",
    description: "Catalog governance, stablecoin taxonomy rules, and multi-source price consensus.",
    slugs: ["classification", "listing-policy", "pricing-pipeline"],
  },
  {
    id: "risk-peg-monitoring",
    title: "Risk & Peg Monitoring",
    description: "Depeg detection, early-warning stress signals, issuer freeze tracking, and market-wide PSI.",
    slugs: ["depeg-detection", "dews", "blacklist-tracker", "stability-index", "shadow-stablecoins"],
  },
  {
    id: "scoring-safety",
    title: "Scoring & Safety",
    description: "Report Card grading, standalone redemption backstop scoring, and network concentration health.",
    slugs: ["report-cards", "redemption-backstops", "chain-health"],
  },
  {
    id: "liquidity-flows-yield",
    title: "Liquidity, Flows & Yield",
    description: "DEX pool discovery and depth scoring, issuance-chain mint/burn flows, and risk-adjusted yield ranking.",
    slugs: ["dex-liquidity", "mint-burn-flows", "yield-intelligence"],
  },
];

const SLUG_TO_CLUSTER_ID = new Map<string, string>(
  DOC_CLUSTER_DEFINITIONS.flatMap((cluster) => cluster.slugs.map((slug) => [slug, cluster.id] as const)),
);

const DOCS_METADATA_BY_SLUG = docsMetadata as Record<string, { dateModified: string; dateCreated: string }>;

function buildDirectoryClusters(): DocsDirectoryCluster[] {
  const entriesByCluster = new Map<string, DocsDirectoryEntry[]>();
  const fallbackEntries: DocsDirectoryEntry[] = [];

  for (const doc of PUBLIC_DOCS) {
    const clusterId = SLUG_TO_CLUSTER_ID.get(doc.slug) ?? "additional";
    const meta = DOCS_METADATA_BY_SLUG[doc.slug];
    const entry: DocsDirectoryEntry = {
      slug: doc.slug,
      title: doc.title,
      summary: doc.summary,
      clusterId,
      updatedDate: meta?.dateModified?.slice(0, 10) ?? null,
      dateModified: meta?.dateModified ?? null,
      relatedRoute: doc.relatedRoute,
    };

    if (clusterId === "additional") {
      fallbackEntries.push(entry);
    } else {
      const bucket = entriesByCluster.get(clusterId) ?? [];
      bucket.push(entry);
      entriesByCluster.set(clusterId, bucket);
    }
  }

  const clusters: DocsDirectoryCluster[] = DOC_CLUSTER_DEFINITIONS.map((cluster) => ({
    id: cluster.id,
    title: cluster.title,
    description: cluster.description,
    docs: entriesByCluster.get(cluster.id) ?? [],
  })).filter((cluster) => cluster.docs.length > 0);

  if (fallbackEntries.length > 0) {
    clusters.push({
      id: "additional",
      title: "Additional Specifications",
      description: "Additional public Pharos technical specifications.",
      docs: fallbackEntries,
    });
  }

  return clusters;
}

const FEATURED_DOCS = [
  {
    slug: "mint-burn-flows",
    label: "Flow analysts",
    description:
      "Mint and burn ingestion, pressure scoring, Bank Run Gauge inputs, reconciliation, and historical backfill policy.",
  },
  {
    slug: "depeg-detection",
    // Peg monitors need the lifecycle, not the engineering spec above it.
    fragment: "event-lifecycle",
    label: "Peg monitors",
    description:
      "Opens at the event lifecycle: threshold onset, 15-minute confirmation, open-event updates, and recovery.",
  },
  {
    slug: "report-cards",
    label: "Risk researchers",
    description:
      "Backing, Exit, and Economic Control scoring rules, dependency caps, and evidence freshness constraints.",
  },
] as const;

export default function DocsIndexPage() {
  const clusters = buildDirectoryClusters();
  const docsCollectionJsonLd = buildCollectionItemListJsonLd({
    url: `${SITE_URL}/docs/`,
    name: "Pharos Documentation",
    description:
      "Technical specifications for Pharos stablecoin methodology, pricing, depeg detection, safety scoring, liquidity, and flows.",
    entries: PUBLIC_DOCS.map((doc) => ({
      item: {
        "@type": "TechArticle",
        "@id": `${SITE_URL}/docs/${doc.slug}/`,
        name: doc.title,
        url: `${SITE_URL}/docs/${doc.slug}/`,
        description: doc.summary,
      },
    })),
  });

  return (
    <FeaturePageShell
      breadcrumbName="Docs"
      path="/docs/"
      title="Documentation"
      variant="longform"
      containerClassName="max-w-5xl"
      leadParagraphs={[
        <span key="lead" className="block max-w-3xl">
          Technical specifications behind Pharos pipelines, scoring models, and data contracts. Every page is also
          served as plain Markdown for agents.
        </span>,
      ]}
    >
      <JsonLdScript json={safeJsonLd(docsCollectionJsonLd)} />

      <div className="space-y-10">
        <section aria-label="Documentation surfaces" className="border-y border-border/60 py-5">
          <div className="grid gap-5 md:grid-cols-3 md:gap-0 md:divide-x md:divide-border/50">
            <Link
              href="/methodology/"
              className="pharos-focus-ring group flex flex-col justify-between gap-2 rounded-md md:pr-6"
            >
              <div className="space-y-1">
                <p className="pharos-label">Guided manual</p>
                <h2 className="text-sm font-semibold text-foreground transition-colors group-hover:text-brand-accent-text">
                  Methodology Manual
                </h2>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Reader/Analyst mode, safety grade scales, worked examples, and versioned scoring changelogs.
                </p>
              </div>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                <span>Open manual</span>
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
              </span>
            </Link>

            <div aria-current="page" className="flex flex-col justify-between gap-2 border-t border-border/50 pt-4 md:border-t-0 md:px-6 md:pt-0">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="pharos-label text-foreground">Technical Specs</p>
                  <span className="rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-2xs font-medium text-foreground">
                    Current
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Engineering specs for every pipeline and rating model, each paired with a machine-readable{" "}
                  <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em] text-foreground">.md</code>{" "}
                  twin.
                </p>
              </div>
              <span className="pharos-numeric text-xs text-muted-foreground">
                {PUBLIC_DOCS.length} published specs
              </span>
            </div>

            <Link
              href="/api/reference/"
              className="pharos-focus-ring group flex flex-col justify-between gap-2 rounded-md border-t border-border/50 pt-4 md:border-t-0 md:pl-6 md:pt-0"
            >
              <div className="space-y-1">
                <p className="pharos-label">Integrations</p>
                <h2 className="text-sm font-semibold text-foreground transition-colors group-hover:text-brand-accent-text">
                  API Reference
                </h2>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  HTTP endpoints, authentication headers, cache policies, OpenAPI spec, and public dataset exports.
                </p>
              </div>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                <span>Open reference</span>
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
              </span>
            </Link>
          </div>
        </section>

        <section aria-labelledby="docs-start-here" className="space-y-4">
          <div className="space-y-1">
            <p className="pharos-label">Start here</p>
            <h2 id="docs-start-here" className="pharos-display text-2xl font-bold tracking-tight text-foreground">
              High-signal entry points
            </h2>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Frequently referenced specifications for peg monitoring, mint/burn flow analysis, and Safety Score audits.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {FEATURED_DOCS.map((featured) => {
              const doc = PUBLIC_DOCS.find((candidate) => candidate.slug === featured.slug);
              if (!doc) return null;
              return (
                <Link
                  key={featured.slug}
                  href={`/docs/${featured.slug}/${"fragment" in featured ? `#${featured.fragment}` : ""}`}
                  className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col justify-between gap-3 p-4"
                >
                  <div>
                    <p className="pharos-label">{featured.label}</p>
                    <h3 className="mt-1 text-sm font-semibold text-foreground transition-colors group-hover:text-brand-accent-text">
                      {doc.title}
                    </h3>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{featured.description}</p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <span>Read spec</span>
                    <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        <section aria-label="Technical specification directory" className="space-y-4">
          <DocsDirectory clusters={clusters} totalCount={PUBLIC_DOCS.length} />
        </section>
      </div>
    </FeaturePageShell>
  );
}
