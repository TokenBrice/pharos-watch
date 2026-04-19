import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { BACKING_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

const TOTAL = BACKING_TAXONOMY_PAGES.reduce((sum, page) => sum + page.coins.length, 0);

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Backing Type",
  description: `Browse ${TOTAL} active stablecoins by backing model: real-world assets, crypto collateral, and algorithmic designs.`,
  canonical: "/stablecoins/backing/",
});

export default function StablecoinBackingHubPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Backing"
      path="/stablecoins/backing/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: "Backing", url: "/stablecoins/backing/" },
      ]}
      title="Stablecoins by Backing Type"
      leadParagraphs={[
        "Compare stablecoin cohorts by reserve structure, from fiat and Treasury-backed issuers to crypto-collateralized and algorithmic designs.",
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: "Stablecoins by Backing Type",
                url: `${SITE_URL}/stablecoins/backing/`,
                isPartOf: { "@id": `${SITE_URL}#website` },
              },
              {
                "@context": "https://schema.org",
                "@type": "ItemList",
                name: "Backing type stablecoin hubs",
                numberOfItems: BACKING_TAXONOMY_PAGES.length,
                itemListElement: BACKING_TAXONOMY_PAGES.map((page, index) => ({
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
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {BACKING_TAXONOMY_PAGES.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            className="pharos-focus-ring rounded-2xl border border-border/60 bg-card/60 px-4 py-4 transition-colors hover:bg-accent"
          >
            <span className="block text-base font-semibold tracking-tight text-foreground">{page.title}</span>
            <span className="mt-2 block text-sm text-muted-foreground">{page.description}</span>
            <span className="mt-3 block text-xs font-medium text-muted-foreground">{page.coins.length} active</span>
          </Link>
        ))}
      </section>
    </FeaturePageShell>
  );
}
