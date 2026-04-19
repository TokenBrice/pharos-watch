import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { INFRASTRUCTURE_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

const TOTAL = INFRASTRUCTURE_TAXONOMY_PAGES.reduce((sum, page) => sum + page.coins.length, 0);

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Shared Infrastructure",
  description: `Browse ${TOTAL} active stablecoins grouped by shared infrastructure such as Liquity v1, Liquity v2, and M0.`,
  canonical: "/stablecoins/infrastructure/",
});

export default function StablecoinInfrastructureHubPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Infrastructure"
      path="/stablecoins/infrastructure/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: "Infrastructure", url: "/stablecoins/infrastructure/" },
      ]}
      title="Stablecoins by Shared Infrastructure"
      leadParagraphs={[
        "Group stablecoins that inherit common architecture, contracts, or issuance frameworks so correlated infrastructure risk is easier to spot.",
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: "Stablecoins by Shared Infrastructure",
                url: `${SITE_URL}/stablecoins/infrastructure/`,
                isPartOf: { "@id": `${SITE_URL}#website` },
              },
              {
                "@context": "https://schema.org",
                "@type": "ItemList",
                name: "Shared infrastructure stablecoin hubs",
                numberOfItems: INFRASTRUCTURE_TAXONOMY_PAGES.length,
                itemListElement: INFRASTRUCTURE_TAXONOMY_PAGES.map((page, index) => ({
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
        {INFRASTRUCTURE_TAXONOMY_PAGES.map((page) => (
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
