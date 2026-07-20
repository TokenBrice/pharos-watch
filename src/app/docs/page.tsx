import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { DOC_GROUPS, PUBLIC_DOCS } from "@shared/lib/public-docs";

export const metadata: Metadata = buildPageMetadata({
  title: "Docs - Pharos Documentation Archive",
  description:
    "Browse Pharos documentation for stablecoin methodology, API contracts, architecture, data pipelines, design rules, and public dashboard operations.",
  canonical: "/docs/",
});

const GROUP_TITLES: Record<(typeof DOC_GROUPS)[number], string> = {
  system: "System and Data",
  methodology: "Methodology",
  design: "Design",
};

const FEATURED_DOCS = [
  {
    slug: "api-reference",
    label: "API integrators",
    description:
      "Endpoint authentication, response contracts, cache headers, pagination, and public dataset export details.",
  },
  {
    slug: "mint-burn-flows",
    label: "Flow analysts",
    description:
      "Mint and burn ingestion, pressure scoring, Bank Run Gauge inputs, reconciliation, and historical backfill policy.",
  },
  {
    slug: "architecture",
    label: "Maintainers",
    description:
      "Static export ownership, Cloudflare Pages and Worker lanes, crawl metadata, generated artifacts, and route maps.",
  },
] as const;

export default function DocsIndexPage() {
  const byGroup: Record<(typeof DOC_GROUPS)[number], typeof PUBLIC_DOCS> = {
    system: PUBLIC_DOCS.filter((doc) => doc.group === "system"),
    methodology: PUBLIC_DOCS.filter((doc) => doc.group === "methodology"),
    design: PUBLIC_DOCS.filter((doc) => doc.group === "design"),
  };

  return (
    <FeaturePageShell
      breadcrumbName="Docs"
      path="/docs/"
      title="Documentation"
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
      leadParagraphs={[
        "Architecture, methodology, and design references for Pharos. Every page is also served as plain markdown for agents.",
      ]}
    >
      <div className="space-y-10">
        <section aria-labelledby="docs-start-here" className="space-y-4 border-y border-border/60 py-5">
          <div className="space-y-2">
            <p className="pharos-kicker">Start Here</p>
            <h2 id="docs-start-here" className="pharos-display text-2xl font-bold tracking-tight text-foreground">
              High-signal public docs
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Durable reference pages for external integrations, flow methodology, and the static-export architecture.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {FEATURED_DOCS.map((featured) => {
              const doc = PUBLIC_DOCS.find((candidate) => candidate.slug === featured.slug);
              if (!doc) return null;
              return (
                <Link
                  key={featured.slug}
                  href={`/docs/${featured.slug}/`}
                  className="pharos-focus-ring group block border-t border-border/60 pt-4 md:border-t-0 md:pt-0"
                >
                  <p className="pharos-kicker text-muted-foreground/80">{featured.label}</p>
                  <h3 className="mt-1 text-sm font-semibold text-foreground transition-colors group-hover:text-frost-blue">
                    {doc.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{featured.description}</p>
                </Link>
              );
            })}
          </div>
        </section>
        {DOC_GROUPS.map((group) => (
          <section key={group} className="space-y-4">
            <h2 className="pharos-display text-2xl font-bold tracking-tight text-foreground">{GROUP_TITLES[group]}</h2>
            <ul className="space-y-3">
              {byGroup[group].map((doc) => (
                <li key={doc.slug} className="border-b border-border/50 pb-3 last:border-b-0">
                  <Link
                    href={`/docs/${doc.slug}/`}
                    className="pharos-focus-ring rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    {doc.title}
                  </Link>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{doc.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </FeaturePageShell>
  );
}
