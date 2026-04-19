import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  BACKING_TAXONOMY_PAGES,
  GOVERNANCE_TAXONOMY_PAGES,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";

const TOTAL = ACTIVE_STABLECOINS.length;

interface TaxonomyLinkPage {
  href: string;
  title: string;
  coins: readonly unknown[];
}

const AXES: ReadonlyArray<{
  href: string;
  label: string;
  children: readonly TaxonomyLinkPage[];
}> = [
  { href: "/stablecoins/", label: "By Peg Currency", children: PEG_TAXONOMY_PAGES },
  { href: "/stablecoins/backing/", label: "By Backing Type", children: BACKING_TAXONOMY_PAGES },
  { href: "/stablecoins/governance/", label: "By Governance Model", children: GOVERNANCE_TAXONOMY_PAGES },
  { href: "/stablecoins/infrastructure/", label: "By Shared Infrastructure", children: INFRASTRUCTURE_TAXONOMY_PAGES },
] as const;

const taxonomyItems = AXES.flatMap((axis) => axis.children);

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Peg, Backing, Governance & Infrastructure",
  description: `Browse ${TOTAL} active stablecoins sorted by peg currency, collateral backing, governance model, and shared infrastructure.`,
  canonical: "/stablecoins/",
});

export default function StablecoinsHubPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Stablecoins"
      path="/stablecoins/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
      ]}
      title="Stablecoin Taxonomies"
      leadParagraphs={[
        `Four ways to browse the ${TOTAL} active stablecoins Pharos tracks: peg currency, backing type, governance model, and shared infrastructure.`,
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: "Stablecoin Taxonomies",
                url: `${SITE_URL}/stablecoins/`,
                isPartOf: { "@id": `${SITE_URL}#website` },
              },
              {
                "@context": "https://schema.org",
                "@type": "ItemList",
                name: "Stablecoin taxonomy hubs",
                numberOfItems: taxonomyItems.length,
                itemListElement: taxonomyItems.map((page, index) => ({
                  "@type": "ListItem",
                  position: index + 1,
                  name: page.title,
                  url: `${SITE_URL}${page.href}`,
                })),
              },
            ]),
          }}
        />
      }
    >
      <section className="grid gap-4 sm:grid-cols-2">
        {AXES.map((axis) => (
          <div key={axis.href} className="space-y-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
            <h2 className="text-base font-semibold tracking-tight">
              <Link href={axis.href} className="pharos-focus-ring rounded-sm underline-offset-4 hover:underline">
                {axis.label}
              </Link>
            </h2>
            <div className="flex flex-col gap-2">
              {axis.children.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <span className="block font-medium text-foreground">{page.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{page.coins.length} active</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>
    </FeaturePageShell>
  );
}
