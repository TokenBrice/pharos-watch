import type { Metadata } from "next";
import { StablecoinTaxonomyHub } from "@/components/stablecoin-taxonomy-hub";
import { buildPageMetadata } from "@/lib/page-metadata";
import { BACKING_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

const TOTAL = BACKING_TAXONOMY_PAGES.reduce((sum, page) => sum + page.coins.length, 0);

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Backing Type",
  description: `Browse ${TOTAL} active stablecoins by backing model: real-world assets and crypto collateral.`,
  canonical: "/stablecoins/backing/",
});

export default function StablecoinBackingHubPage() {
  return (
    <StablecoinTaxonomyHub
      breadcrumbName="Backing"
      path="/stablecoins/backing/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: "Backing", url: "/stablecoins/backing/" },
      ]}
      title="Stablecoins by Backing Type"
      leadParagraphs={[
        "Compare stablecoin cohorts by reserve structure, from fiat and Treasury-backed issuers to crypto-collateralized designs.",
      ]}
      itemListName="Backing type stablecoin hubs"
      pages={BACKING_TAXONOMY_PAGES}
    />
  );
}
