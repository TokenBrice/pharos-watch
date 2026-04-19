import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { GOVERNANCE_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

const TOTAL = GOVERNANCE_TAXONOMY_PAGES.reduce((sum, page) => sum + page.coins.length, 0);

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Governance Model",
  description: `Browse ${TOTAL} active stablecoins by governance model: CeFi, CeFi-dependent, and DeFi-native designs.`,
  canonical: "/stablecoins/governance/",
});

export default function StablecoinGovernanceHubPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Governance"
      path="/stablecoins/governance/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: "Governance", url: "/stablecoins/governance/" },
      ]}
      title="Stablecoins by Governance Model"
      leadParagraphs={[
        "Separate centralized issuers, CeFi-dependent designs, and DeFi-native stablecoins before comparing peg stability, liquidity, and control risk.",
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: "Stablecoins by Governance Model",
                url: `${SITE_URL}/stablecoins/governance/`,
                isPartOf: { "@id": `${SITE_URL}#website` },
              },
              {
                "@context": "https://schema.org",
                "@type": "ItemList",
                name: "Governance model stablecoin hubs",
                numberOfItems: GOVERNANCE_TAXONOMY_PAGES.length,
                itemListElement: GOVERNANCE_TAXONOMY_PAGES.map((page, index) => ({
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
        {GOVERNANCE_TAXONOMY_PAGES.map((page) => (
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
