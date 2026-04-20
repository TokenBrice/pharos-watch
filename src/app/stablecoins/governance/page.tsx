import type { Metadata } from "next";
import { StablecoinTaxonomyHub } from "@/components/stablecoin-taxonomy-hub";
import { buildPageMetadata } from "@/lib/page-metadata";
import { GOVERNANCE_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

const TOTAL = GOVERNANCE_TAXONOMY_PAGES.reduce((sum, page) => sum + page.coins.length, 0);

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Governance Model",
  description: `Browse ${TOTAL} active stablecoins by governance model: CeFi, CeFi-dependent, and DeFi-native designs.`,
  canonical: "/stablecoins/governance/",
});

export default function StablecoinGovernanceHubPage() {
  return (
    <StablecoinTaxonomyHub
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
      itemListName="Governance model stablecoin hubs"
      pages={GOVERNANCE_TAXONOMY_PAGES}
    />
  );
}
