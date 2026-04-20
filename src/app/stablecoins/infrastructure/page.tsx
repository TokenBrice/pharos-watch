import type { Metadata } from "next";
import { StablecoinTaxonomyHub } from "@/components/stablecoin-taxonomy-hub";
import { buildPageMetadata } from "@/lib/page-metadata";
import { INFRASTRUCTURE_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

const TOTAL = INFRASTRUCTURE_TAXONOMY_PAGES.reduce((sum, page) => sum + page.coins.length, 0);

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Shared Infrastructure",
  description: `Browse ${TOTAL} active stablecoins grouped by shared infrastructure such as Liquity v1, Liquity v2, and M0.`,
  canonical: "/stablecoins/infrastructure/",
});

export default function StablecoinInfrastructureHubPage() {
  return (
    <StablecoinTaxonomyHub
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
      itemListName="Shared infrastructure stablecoin hubs"
      pages={INFRASTRUCTURE_TAXONOMY_PAGES}
    />
  );
}
